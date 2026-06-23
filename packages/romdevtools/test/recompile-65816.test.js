// NES (6502) → SNES (65816) recompile emit backend — translator unit tests.
// Pure functions over da65 text → 65816 asm; no rizin/asar needed (fast, always
// green). The end-to-end translate→assemble→boot path is exercised by
// recompile-nes-snes-e2e.test.js (gated on the rizin/asar toolchains).

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parseDa65Line, seamRegister, translateInstr, translateBody,
  findUndefinedLabels, emitStubs, emitMainAsm, emitSeam, DOCUMENTED_6502,
} from "../src/analysis/recompile-65816.js";

test("parseDa65Line classifies every da65 line form", () => {
  assert.equal(parseDa65Line("").kind, "blank");
  assert.equal(parseDa65Line("        .setcpu \"6502\"").kind, "directive");
  assert.equal(parseDa65Line(".org $8000").kind, "directive");
  assert.equal(parseDa65Line("        .byte   $FF").kind, "data");

  const equ = parseDa65Line("L90AA           := $90AA");
  assert.equal(equ.kind, "equ");
  assert.equal(equ.label, "L90AA");
  assert.equal(equ.operand, "$90AA");

  const labeled = parseDa65Line("reset:  sei");
  assert.equal(labeled.kind, "instr");
  assert.equal(labeled.label, "reset");
  assert.equal(labeled.mnemonic, "sei");
  assert.equal(labeled.operand, undefined);

  const op = parseDa65Line("        lda     #$00");
  assert.equal(op.mnemonic, "lda");
  assert.equal(op.operand, "#$00");

  const idx = parseDa65Line("        sta     $0200,x");
  assert.equal(idx.operand, "$0200,x");

  const labelOnly = parseDa65Line("L8016:");
  assert.equal(labelOnly.kind, "label");
  assert.equal(labelOnly.label, "L8016");
});

test("seamRegister detects PPU/APU MMIO, ignores zp/immediate/RAM", () => {
  assert.equal(seamRegister("$2000"), 0x2000); // PPUCTRL
  assert.equal(seamRegister("$2002"), 0x2002); // PPUSTATUS
  assert.equal(seamRegister("$2007"), 0x2007); // PPUDATA
  assert.equal(seamRegister("$4014"), 0x4014); // OAMDMA
  assert.equal(seamRegister("$4015"), 0x4015); // SND_CHN
  assert.equal(seamRegister("$2000,x"), 0x2000); // indexed MMIO still the seam
  // NOT the seam:
  assert.equal(seamRegister("$02"), null);     // zero page RAM
  assert.equal(seamRegister("#$00"), null);    // immediate
  assert.equal(seamRegister("$0200,x"), null); // OAM shadow in RAM, not MMIO
  assert.equal(seamRegister("$8000"), null);   // ROM
  assert.equal(seamRegister(undefined), null);
});

test("translateInstr: 1:1 pass-through for documented E-mode-identical opcodes", () => {
  const r = translateInstr(parseDa65Line("        lda     #$00"));
  assert.equal(r.ok, true);
  assert.ok(r.out.some((l) => /^\s+lda\s+#\$00$/.test(l)), "lda emitted verbatim");

  const branch = translateInstr(parseDa65Line("        bpl     L8016"));
  assert.equal(branch.ok, true);
  assert.ok(branch.out.some((l) => /bpl\s+L8016/.test(l)));

  const labeled = translateInstr(parseDa65Line("L8024:  sta     $0200,x"));
  assert.equal(labeled.ok, true);
  assert.equal(labeled.out[0], "L8024:", "label emitted as its own line");
  assert.ok(labeled.out.some((l) => /sta\s+\$0200,x/.test(l)), "RAM store passes through (not seam)");
});

test("translateInstr: PPU/APU access becomes a seam call", () => {
  const w = translateInstr(parseDa65Line("        sta     $2001"));
  assert.equal(w.ok, true);
  assert.ok(w.out.some((l) => l.includes("ldx     #$01")), "register low byte in X");
  assert.ok(w.out.some((l) => l.includes("jsr     NES_PPU_WRITE")), "routed to seam write");

  const rd = translateInstr(parseDa65Line("        bit     $2002"));
  assert.equal(rd.ok, true);
  assert.ok(rd.out.some((l) => l.includes("jsr     NES_PPU_READ")), "$2002 read → seam read");
});

test("translateInstr: refuses the non-mechanical constructs (residue)", () => {
  const sed = translateInstr(parseDa65Line("        sed"));
  assert.equal(sed.ok, false);
  assert.match(sed.reason, /decimal/i);

  const ind = translateInstr(parseDa65Line("        jmp     (L0C7E)"));
  assert.equal(ind.ok, false);
  assert.match(ind.reason, /indirect|jumptable/i);
});

test("PASSTHROUGH covers documented set minus the handled few", () => {
  // every documented opcode is either pass-through OR explicitly handled
  for (const m of DOCUMENTED_6502) {
    const r = translateInstr({ kind: "instr", raw: m, mnemonic: m, operand: m === "jmp" ? "L1234" : undefined });
    // jmp absolute is fine; sed/brk/rti are the only refusals with no operand
    if (["sed", "brk", "rti"].includes(m)) assert.equal(r.ok, false, `${m} refused`);
    else assert.equal(r.ok, true, `${m} translates`);
  }
});

test("translateBody collects equs, residue, and instruction/seam counts", () => {
  const da65 = [
    '        .setcpu "6502"',
    ".org $8000",
    "L90AA           := $90AA",
    "reset:  sei",
    "        lda     #$00",
    "        sta     $2000",     // seam
    "        sta     $0300",     // RAM, pass-through
    "L8016:  bit     $2002",     // seam
    "        bpl     L8016",
    "        sed",               // residue
    "        jmp     L90AA",
  ].join("\n");
  const r = translateBody(da65);
  assert.deepEqual(r.equs, ["L90AA = $90AA"]);
  assert.ok(r.instrCount >= 6, `counted instrs: ${r.instrCount}`);
  assert.ok(r.seamCount >= 2, `counted seam: ${r.seamCount}`);
  assert.equal(r.residue.length, 1, "one residue (sed)");
  assert.match(r.residue[0].reason, /decimal/i);
  // body keeps the labels so branches resolve
  assert.match(r.body, /^reset:/m);
  assert.match(r.body, /^L8016:/m);
});

test("findUndefinedLabels + emitStubs isolate a single-function slice", () => {
  const body = [
    "reset:  sei",
    "        jsr     L936A",   // undefined callee
    "        jsr     NES_PPU_WRITE", // seam — must NOT be stubbed
    "        jmp     reset",   // defined here
  ].join("\n");
  const undef = findUndefinedLabels(body, ["L030E = $030E"]);
  assert.deepEqual(undef, ["L936A"], "only the real undefined callee");
  const stubs = emitStubs(undef);
  assert.match(stubs, /^L936A:\n\s+rts/m);
});

test("emitMainAsm wraps body with LoROM + emulation-mode preamble + vectors", () => {
  const asm = emitMainAsm({ body: "reset:\n        sei", resetLabel: "reset" });
  assert.match(asm, /^lorom/m);
  assert.match(asm, /xce/, "switches CPU mode");
  assert.match(asm, /jmp     reset/, "jumps to the recompiled reset");
  assert.match(asm, /org \$00FFFC/, "emulation reset vector");
  assert.match(asm, /incsrc "nes_seam.asm"/, "includes the seam");
});

test("emitSeam: $2002 read returns $80 so vblank-wait loops terminate", () => {
  const seam = emitSeam();
  assert.match(seam, /NES_PPU_READ:/);
  assert.match(seam, /lda     #\$80/, "the boot-loop-escape detail");
  assert.match(seam, /NES_PPU_WRITE:\n\s+rts/, "writes trap to rts");
});
