// Z80 source lifter + the z80→65816 emitter.
//
// One lifter serves FOUR platforms (Master System, Game Gear, MSX, the Genesis
// sound CPU), so a bug here is a bug on all four.
//
// The register/hex ambiguity has its own block below because it is this
// lifter's defining hazard and it produced TWO separate silent miscompiles
// before it was tested: every Z80 register name (a b c d e h l, and the pairs
// bc/de/hl/af) is also a valid hexadecimal number. A bare-hex regex therefore
// matches a REGISTER, and the result is not a crash or a refusal - it is
// plausible assembly that computes the wrong thing, which is the exact failure
// class this engine exists to avoid.

import { test } from "node:test";
import assert from "node:assert/strict";

import { liftZ80, splitCondition, seamPort, DOCUMENTED_Z80 } from "../src/analysis/recompile/lift-z80.js";
import { emit65816FromZ80Body } from "../src/analysis/recompile/emit-65816-from-z80.js";
import { recompile, supportedPairs } from "../src/analysis/recompile/index.js";
import { IR } from "../src/analysis/recompile/ir.js";
import { runAsar } from "../src/toolchains/asar/asar.js";

/** Lift one instruction and emit it; returns the asm lines (comments kept). */
function emitOne(instr) {
  const { ir } = liftZ80("\t" + instr);
  return emit65816FromZ80Body(ir).split("\n");
}
const joined = (instr) => emitOne(instr).join("\n");

// ── the register/hex ambiguity ──────────────────────────────────────────────

test("seamPort: `(c)` is the C REGISTER, not port 0x0c", () => {
  // in/out (c) take the port from register C at RUNTIME. Reporting a literal
  // port here is a silent miscompile: on SMS it is the difference between
  // "VDP control at $BF" and "port 12", and it made the dynamic-port branch in
  // the lifter unreachable for every (c) form in the ISA.
  assert.equal(seamPort("(c),a"), null);
  assert.equal(seamPort("a,(c)"), null);
  // Other register-indirect forms are not ports either.
  for (const t of ["(hl)", "(de)", "(bc)", "(ix+5)", "(iy-3)"]) {
    assert.equal(seamPort(t), null, `${t} must not parse as a port`);
  }
});

test("seamPort: real literal ports still resolve, in both spellings", () => {
  assert.equal(seamPort("($bf)"), 0xbf);   // SMS VDP control
  assert.equal(seamPort("($be)"), 0xbe);   // SMS VDP data
  assert.equal(seamPort("(0bfh)"), 0xbf);  // h-suffix spelling
  assert.equal(seamPort("a,($7e)"), 0x7e); // V counter
  assert.equal(seamPort("($0)"), 0);
  assert.equal(seamPort("(7)"), 7);
});

test("lifter: every in/out (c) form is a DYNAMIC seam (via:'c'), never a literal", () => {
  const asm = ["out (c),a", "in a,(c)", "in b,(c)", "out (c),b", "ini", "outd"]
    .map((s) => "\t" + s).join("\n");
  const seams = liftZ80(asm).ir.filter((n) => n.op === IR.HWREG);
  assert.equal(seams.length, 6);
  for (const s of seams) {
    assert.equal(s.via, "c", `${(s.raw || "").trim()} must be a dynamic port`);
    assert.equal(s.reg, null, `${(s.raw || "").trim()} must not claim a literal port`);
  }
});

test("emitter: `ld hl,de` is a pair MOVE, not an immediate load of $00de", () => {
  const out = joined("ld hl,de");
  assert.match(out, /pair-to-pair move/);
  // DE's low byte (E) is dp $04; HL's low byte (L) is dp $06.
  assert.match(out, /lda\s+\$04/);
  assert.match(out, /sta\s+\$06/);
  // The bug: `de` read as hex 0x00DE.
  assert.doesNotMatch(out, /#\$00de/i, "must not load the register name as a literal");
});

test("emitter: every all-letter pair source moves rather than loading a literal", () => {
  for (const [instr, badLiteral] of [
    ["ld hl,de", /#\$00de/i],
    ["ld de,bc", /#\$00bc/i],
    ["ld bc,de", /#\$00de/i],
    ["ld hl,bc", /#\$00bc/i],
  ]) {
    const out = joined(instr);
    assert.match(out, /pair-to-pair move/, `${instr} should be a move`);
    assert.doesNotMatch(out, badLiteral, `${instr} must not become an immediate`);
  }
});

test("emitter: genuine 16-bit literals still load, in $-prefix and h-suffix forms", () => {
  assert.match(joined("ld hl,$1234"), /lda\s+#\$1234/);
  assert.match(joined("ld sp,$dff0"), /lda\s+#\$dff0/);
  // A leading 0 is how h-suffix assemblers keep a hex value that begins with a
  // letter from looking like an identifier.
  assert.match(joined("ld de,0beefh"), /lda\s+#\$beef/);
  assert.match(joined("ld bc,0100h"), /lda\s+#\$0100/);
});

test("emitter: 8-bit register names are registers, not hex digits", () => {
  // `ld (hl),a` -- `a` is the accumulator, not 0x0A.
  assert.doesNotMatch(joined("ld (hl),a"), /#\$0a/i);
  // `xor a` is the idiomatic Z80 "zero A"; as an immediate it would be xor #$0a.
  assert.doesNotMatch(joined("xor a"), /#\$0a/i);
  // `ld a,b` copies B (dp $01) into A (dp $00).
  const ldab = joined("ld a,b");
  assert.match(ldab, /lda\s+\$01/);
  assert.match(ldab, /sta\s+\$00/);
});

// ── conditions: Z80 spells them as an operand, not in the mnemonic ──────────

test("splitCondition: a leading condition token is only a condition on jp/jr/call/ret", () => {
  assert.deepEqual(splitCondition("jr", "c,$1234"), { cond: "cs", rest: "$1234" });
  assert.deepEqual(splitCondition("call", "z,L1"), { cond: "eq", rest: "L1" });
  assert.deepEqual(splitCondition("ret", "nz"), { cond: "ne", rest: "" });
  // The `c` trap: a REGISTER on any non-branching instruction.
  assert.deepEqual(splitCondition("ld", "a,c"), { cond: null, rest: "a,c" });
  assert.deepEqual(splitCondition("out", "(c),a"), { cond: null, rest: "(c),a" });
  // A bare `ret` is unconditional; `jp (hl)` is computed, not conditional.
  assert.deepEqual(splitCondition("ret", ""), { cond: null, rest: "" });
  assert.deepEqual(splitCondition("jp", "(hl)"), { cond: null, rest: "(hl)" });
});

test("lifter: a conditional return expands to branch-over-ret with the INVERTED condition", () => {
  // `ret nz` returns WHEN non-zero, so the branch must skip the return when
  // the condition holds -- i.e. branch on EQ. Getting this backwards inverts
  // the control flow of a large share of real routines.
  const ir = liftZ80("\tret nz").ir;
  const br = ir.find((n) => n.op === IR.BRANCH);
  const ret = ir.find((n) => n.op === IR.RET);
  const lbl = ir.find((n) => n.op === IR.LABEL && /skip/.test(n.name ?? ""));
  assert.ok(br && ret && lbl, "expansion must emit branch + ret + skip label");
  assert.equal(br.cond, "eq", "ret nz must branch on the INVERSE (eq)");
  assert.equal(br.target, lbl.name);
  assert.equal(ret.kind, "sub");
});

test("lifter: reti/retn are INTERRUPT returns; ret is a subroutine return", () => {
  const kinds = liftZ80("\tret\n\treti\n\tretn").ir
    .filter((n) => n.op === IR.RET).map((n) => n.kind);
  assert.deepEqual(kinds, ["sub", "interrupt", "interrupt"]);
  // and they must emit rti, not rts.
  assert.match(joined("reti"), /\brti\b/);
  assert.match(joined("ret"), /\brts\b/);
});

// ── refusals: the engine must refuse rather than guess ──────────────────────

test("lifter: a computed jump is REFUSED and names the tool that resolves it", () => {
  for (const j of ["jp (hl)", "jp (ix)", "jp (iy)"]) {
    const ref = liftZ80("\t" + j).ir.find((n) => n.op === IR.REFUSE);
    assert.ok(ref, `${j} must be refused, never guessed`);
    assert.match(ref.reason, /jumptable/, "the refusal should point at breakpoint({on:'jumptable'})");
  }
});

test("lifter: an undocumented mnemonic is refused, not mapped to something plausible", () => {
  const ref = liftZ80("\tfrobnicate a,b").ir.find((n) => n.op === IR.REFUSE);
  assert.ok(ref);
  assert.match(ref.reason, /unrecognized|undocumented/);
  assert.ok(!DOCUMENTED_Z80.has("frobnicate"));
});

test("lifter: `rst` is normalized to a call, whether the operand is a label or hex", () => {
  // The disassembler labels the low vectors, so real output says `rst L000038`.
  // Accepting only hex refused every rst in the ROM.
  const a = liftZ80("\trst L000038").ir.find((n) => n.op === IR.CALL);
  assert.equal(a?.target, "L000038");
  const b = liftZ80("\trst $38").ir.find((n) => n.op === IR.CALL);
  assert.equal(b?.target, "$38");
});

// ── engine wiring ───────────────────────────────────────────────────────────

test("recompile: z80 sources are accepted for all four Z80 platforms", () => {
  for (const source of ["sms", "gg", "msx", "z80"]) {
    const res = recompile("\tld a,$01\n\tld ($c000),a\n\tout ($be),a\n\tret", { source, target: "snes" });
    assert.equal(res.targetIsa, "65816");
    assert.equal(res.source, source);
    assert.equal(res.instrCount, 4, `${source}: all four instructions lift`);
    assert.equal(res.seamCount, 1, `${source}: the out is the only seam`);
    assert.deepEqual(res.residue, [], `${source}: nothing refused in this sample`);
    // Real 65816, not re-emitted Z80: the source mnemonics must be GONE.
    assert.match(res.mainAsm, /\blda\b/, `${source}: emits 65816`);
    assert.doesNotMatch(res.mainAsm, /^\s*ld\s+a,/m, `${source}: no raw Z80 left in the output`);
    assert.ok(res.seamAsm, `${source}: the I/O seam is emitted as its own file`);
  }
});

test("recompile: a target whose emitter cannot translate z80 fails LOUDLY", () => {
  // The m68k emitter re-emits source mnemonics, which is correct for 6502 and
  // nonsense for Z80. An unsupported pair must be an error, never a file that
  // looks like assembly and cannot build.
  assert.throws(
    () => recompile("\tld a,$01\n\tret", { source: "sms", target: "genesis" }),
    /cannot translate z80|no emitter|Supported pairs/i,
  );
});

test("supportedPairs advertises only pairs that really translate", () => {
  const pairs = supportedPairs();
  assert.ok(pairs.includes("sms→snes"), "sms→snes is implemented");
  assert.ok(!pairs.includes("sms→genesis"), "sms→genesis must not be advertised");
});

// ── the hardware seam ───────────────────────────────────────────────────────

test("lifter: the Z80 seam is I/O space - exact, not heuristic", () => {
  // Unlike the 6502 (memory-mapped hardware, so the seam is an address range
  // and a judgement call), every in/out is hardware and nothing else is.
  const { ir, seamCount } = liftZ80("\tin a,($bf)\n\tld a,($c000)\n\tout ($be),a");
  assert.equal(seamCount, 2, "only the in/out are seams; the RAM load is not");
  const seams = ir.filter((n) => n.op === IR.HWREG);
  assert.deepEqual(seams.map((s) => [s.access, s.reg]), [["read", 0xbf], ["write", 0xbe]]);
});

test("lifter: counts instructions and anchors an entry label on unlabelled code", () => {
  const r = liftZ80("\tdi\n\tld sp,$dff0\n\tret");
  assert.equal(r.instrCount, 3);
  assert.ok(r.entry, "an entry anchor is required - the reset vector must land somewhere");
  assert.ok(r.ir.some((n) => n.op === IR.LABEL && n.name === r.entry));
});

// ── the real gate: does the emitted 65816 ASSEMBLE? ─────────────────────────
//
// Text assertions prove the shape of the output; only the assembler proves it
// is assembly. This is the check that catches the whole class of "looks
// plausible, cannot build" -- and it caught a live one: the callee-stub pass
// emitted `Z80_IO_WRITE: rts` for a label the seam include already defined, so
// every Z80 program containing an in/out failed with Elabel_redefined.

test("e2e: a Z80 routine recompiles to 65816 that asar BUILDS", async () => {
  const src = [
    "\tdi", "\tim 1",
    "\tld sp,$dff0",
    "\tld hl,$c000", "\tld de,$c100",
    "\tld hl,de",              // pair move (not an immediate)
    "\tld a,$01",
    "\tout ($be),a",           // seam: write, literal port
    "\tin a,($bf)",            // seam: read, literal port
    "\tld ($c000),a",
    "\tinc hl", "\tdec b", "\tcp $ff", "\tld b,$10",
    "\tret",
  ].join("\n");
  const r = recompile(src, { source: "sms", target: "snes" });

  assert.equal(r.residue.length, 0, `nothing should be refused here: ${JSON.stringify(r.residue)}`);
  assert.deepEqual(r.stubbed, [], "seam routines are runtime-provided, never stubbed callees");

  const asar = await runAsar({ source: r.mainAsm, includes: { [r.seamFile]: r.seamAsm } });
  assert.equal(asar.exitCode, 0, `asar failed: ${(asar.log || "").slice(0, 800)}`);
  assert.ok(asar.binary?.length > 0, "asar produced a LoROM image");
});

test("e2e: a seam-only routine builds - the seam include must not be double-defined", async () => {
  // The minimal reproduction of the Elabel_redefined bug: one `out` is enough.
  const r = recompile("\tout ($be),a\n\tin a,($bf)\n\tret", { source: "sms", target: "snes" });
  assert.ok(!r.stubbed.includes("Z80_IO_WRITE"), "Z80_IO_WRITE comes from the seam include");
  assert.ok(!r.stubbed.includes("Z80_IO_READ"), "Z80_IO_READ comes from the seam include");
  const asar = await runAsar({ source: r.mainAsm, includes: { [r.seamFile]: r.seamAsm } });
  assert.equal(asar.exitCode, 0, `asar failed: ${(asar.log || "").slice(0, 800)}`);
});

test("e2e: a genuinely unresolved callee IS still stubbed, so the image links", async () => {
  // The seam exemption must not turn into "never stub anything": a call to a
  // routine outside the translated slice still needs a stub to assemble.
  const r = recompile("\tcall L009999\n\tret", { source: "sms", target: "snes" });
  assert.deepEqual(r.stubbed, ["L009999"], "an out-of-slice callee is stubbed");
  const asar = await runAsar({ source: r.mainAsm, includes: { [r.seamFile]: r.seamAsm } });
  assert.equal(asar.exitCode, 0, `asar failed: ${(asar.log || "").slice(0, 800)}`);
});

// ── (ix+d) / (iy+d): the indexed forms, and the SIGN trap ───────────────────
//
// Coverage was weakest here, and that is exactly where the bug was: the Z80
// displacement is a SIGNED byte (-128..+127), while the 65816's `[dp],y` index
// is UNSIGNED. Narrowing with `d & 0xff` turned `(iy-3)` into `ldy #$fd`, which
// indexes +253 -- a read 256 bytes from the intended byte, silently.
//
// The second trap in the same operand: objdump prints these displacements in
// DECIMAL, so `(ix+10)` is ten, not sixteen.

test("(ix+d): a positive displacement uses the cheap 8-bit index", () => {
  const out = joined("ld a,(ix+5)");
  assert.match(out, /ldy\s+#\$05/);
  assert.match(out, /lda\s+\[\$08\],y/, "IX lives at dp $08");
  assert.doesNotMatch(out, /rep\s+#\$10/, "no width change needed for a positive displacement");
});

test("(iy-d): a NEGATIVE displacement must not wrap to a large positive index", () => {
  const out = joined("ld (iy-3),a");
  // The bug: ldy #$fd (=253) instead of -3.
  assert.doesNotMatch(out, /ldy\s+#\$fd\b/i, "-3 must not narrow to the byte 0xFD");
  assert.match(out, /ldy\s+#\$fffd/i, "-3 must be the 16-bit two's complement $FFFD");
  assert.match(out, /rep\s+#\$10/, "a negative index needs 16-bit Y");
  assert.match(out, /sep\s+#\$10/, "and must restore 8-bit index width afterwards");
  assert.match(out, /sta\s+\[\$0a\],y/, "IY lives at dp $0A");
});

test("(ix+d) displacements are DECIMAL, as objdump prints them", () => {
  // `dd 7e 0a` disassembles to `ld a,(ix+10)`, and that 10 is decimal.
  assert.match(joined("ld a,(ix+10)"), /ldy\s+#\$0a/i, "(ix+10) is ten, not sixteen");
  assert.match(joined("ld a,(ix+16)"), /ldy\s+#\$10/i);
});

test("(ix+d) covers the full signed byte range at both extremes", () => {
  assert.match(joined("ld a,(ix+127)"), /ldy\s+#\$7f/i, "+127 is the largest positive displacement");
  assert.match(joined("ld a,(ix-128)"), /ldy\s+#\$ff80/i, "-128 is the most negative");
});

test("a store through (ix-d) with an immediate handles BOTH the value and the sign", () => {
  // `ld (ix-5),$42` - real objdump output (dd 36 fb 42).
  const out = joined("ld (ix-5),$42");
  assert.match(out, /lda\s+#\$42/, "the immediate is loaded");
  assert.match(out, /ldy\s+#\$fffb/i, "-5 is $FFFB, not $FB");
  assert.match(out, /sta\s+\[\$08\],y/);
});

test("e2e: indexed addressing with negative displacements ASSEMBLES", async () => {
  const src = [
    "\tld a,(ix+5)",
    "\tld (iy-3),a",
    "\tld a,(ix+10)",
    "\tld (ix-5),$42",
    "\tld a,(ix-128)",
    "\tld (ix+127),a",
    "\tret",
  ].join("\n");
  const r = recompile(src, { source: "sms", target: "snes" });
  assert.equal(r.residue.length, 0, `nothing should be refused: ${JSON.stringify(r.residue)}`);
  const asar = await runAsar({ source: r.mainAsm, includes: { [r.seamFile]: r.seamAsm } });
  assert.equal(asar.exitCode, 0, `asar failed: ${(asar.log || "").slice(0, 800)}`);
  assert.ok(asar.binary?.length > 0);
});

// ── branch range, and the three other bugs only real code exposes ───────────
//
// The assembly gate above passes on short routines and MISSED all four of
// these, because each needs something a small synthetic sample does not have:
// ~130 bytes of expansion between a branch and its target, a register-indirect
// ALU source, a Z80-only register, or a slice big enough to include the vector
// table. A gate whose coverage does not reach the failure is not a gate.

/** The reporter's synthetic fixture: one djnz over 40 pair-ops. No ROM needed. */
function branchRangeFixture() {
  const ORG = 0x0100;
  const body = Buffer.concat(Array.from({ length: 40 }, () => Buffer.from([0x23, 0x1b]))); // inc hl ; dec de
  const code = Buffer.concat([
    Buffer.from([0x06, 0x10]),                       // ld b,$10
    body,
    Buffer.from([0x10, (-(body.length + 2)) & 0xff]), // djnz back
    Buffer.from([0xc9]),                              // ret
  ]);
  const rom = Buffer.alloc(0x8000, 0xc9);
  code.copy(rom, ORG);
  Buffer.from("TMR SEGA", "ascii").copy(rom, 0x7ff0);
  return { rom, org: ORG };
}

test("a branch whose target is out of short range still assembles", async () => {
  // A Z80 jr/djnz and a 65816 beq/bne share a +/-128 range, so a 1:1 emission
  // looks safe - but this emitter expands ONE Z80 instruction into MANY (every
  // 16-bit pair op is a rep/op/sep sandwich), so a loop that fit in Z80 no
  // longer fits. Measured on real ROMs at -139, -482 and +252: BOTH directions,
  // so it is not an off-by-one on one edge.
  const { writeFile, mkdtemp } = await import("node:fs/promises");
  const os = await import("node:os"), path = await import("node:path");
  const { rom } = branchRangeFixture();
  const dir = await mkdtemp(path.join(os.tmpdir(), "z80-branch-"));
  const romPath = path.join(dir, "branchtest.sms");
  await writeFile(romPath, rom);

  // Drive the same path the tool uses: lift the fixture's own instructions.
  const asm = [
    "        ld b,$10",
    ...Array.from({ length: 40 }, () => ["        inc hl", "        dec de"]).flat(),
    "L000102:",
    "        djnz L000102",
    "        ret",
  ].join("\n");
  const r = recompile(asm, { source: "sms", target: "snes" });
  const asar = await runAsar({ source: r.mainAsm, includes: { [r.seamFile]: r.seamAsm } });
  assert.equal(asar.exitCode, 0, `asar failed: ${(asar.log || "").slice(0, 400)}`);
  assert.doesNotMatch(asar.log ?? "", /relative_branch_out_of_bounds/i);
});

test("every conditional branch is emitted as branch-over-long-jump", () => {
  // brl is +/-32767 and stays RELATIVE, so the output remains
  // position-independent - a jmp to an absolute label would not be.
  const { ir } = liftZ80("\tjr z,L001234\n\tjr nz,L005678\n\tdjnz L009999");
  const out = emit65816FromZ80Body(ir);
  assert.match(out, /\bbrl\s+L001234/, "the long jump carries the distance");
  assert.match(out, /\bbne\s+Lz80_br_/, "jr z inverts to bne over the jump");
  assert.match(out, /\bbeq\s+Lz80_br_/, "jr nz inverts to beq over the jump");
  // and the skip labels must be unique, or the second one redefines the first.
  const labels = [...out.matchAll(/^(Lz80_br_\d+):/gm)].map((m) => m[1]);
  assert.equal(labels.length, new Set(labels).size, "branch-over labels must be unique");
});

test("a register-indirect ALU source is not read as a LABEL", () => {
  // `absolute()` also accepts the `(LABEL)` spelling, so it matched `(hl)` and
  // returned the bare text `hl` - emitting `eor hl`, an ALU op against a label
  // named hl that does not exist. asar: Elabel_not_found.
  for (const [src, want] of [["xor (hl)", /eor\s+\[\$06\]/], ["and (hl)", /and\s+\[\$06\]/],
                             ["or (hl)", /ora\s+\[\$06\]/], ["cp (hl)", /cmp\s+\[\$06\]/]]) {
    const out = joined(src);
    assert.match(out, want, `${src} must use [dp] indirect`);
    assert.doesNotMatch(out, /\b(eor|and|ora|cmp)\s+hl\b/, `${src} must not emit a bare 'hl' operand`);
  }
  // A genuine label operand still works.
  assert.match(joined("or (L001234)"), /ora\s+L001234/);
  // and (ix+d) as an ALU source indexes rather than refusing.
  assert.match(joined("cp (ix+5)"), /cmp\s+\[\$08\],y/);
});

test("the Z80-only I and R registers are REFUSED, not emitted as labels", () => {
  // I is the interrupt-vector register and R the refresh counter; neither
  // exists on a 65816, and both are plain identifiers, so `ld a,r` passed
  // through as `lda r`. `ld a,r` is a cheap pseudo-random source in real games.
  for (const src of ["ld a,r", "ld a,i", "ld r,a", "ld i,a"]) {
    const out = joined(src);
    assert.match(out, /UNTRANSLATED/, `${src} must be refused`);
    assert.doesNotMatch(out, /^\s*(lda|sta)\s+[ir]\s*$/m, `${src} must not emit a bare i/r operand`);
  }
  // Ordinary registers are unaffected.
  assert.match(joined("ld a,b"), /lda\s+\$01/);
});

test("a label is DEFINED once even when it arrives twice", async () => {
  // A label can come as its own LABEL node AND attached to the next
  // instruction. Emitting both produced `reset:` twice -> Elabel_redefined,
  // visible only on a slice big enough to include the vector table.
  const asm = ["reset:", "        di", "        ret"].join("\n");
  const r = recompile(asm, { source: "sms", target: "snes" });
  const defs = [...r.mainAsm.matchAll(/^reset:/gm)];
  assert.equal(defs.length, 1, "a duplicate definition is dropped, never renamed");
  const asar = await runAsar({ source: r.mainAsm, includes: { [r.seamFile]: r.seamAsm } });
  assert.equal(asar.exitCode, 0, `asar failed: ${(asar.log || "").slice(0, 300)}`);
});

test("the bank budget warns BEFORE the assembler does", () => {
  // Cross-ISA translation expands ~5x, so a slice that looks small in source
  // bytes overflows a 32KB 65816 bank. asar's own Ebank_border_crossed says
  // nothing about why.
  const small = recompile("\tld a,$01\n\tret", { source: "sms", target: "snes" });
  assert.equal(small.bankBudget.fitsOneBank, true);
  assert.equal(small.bankBudget.warning, undefined);

  // Enough pair-ops to blow a bank.
  const big = recompile(Array.from({ length: 6000 }, () => "\tinc hl").join("\n"), { source: "sms", target: "snes" });
  assert.equal(big.bankBudget.fitsOneBank, false);
  assert.match(big.bankBudget.warning, /bank/i);
  assert.match(big.bankBudget.warning, /smaller region|split/i, "the warning must say what to do about it");
});
