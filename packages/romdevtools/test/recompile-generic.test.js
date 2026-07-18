// Generic recompile engine (analysis/recompile/) — the source/target-agnostic
// port engine. Proves the IR pipeline targets BOTH 65816 (SNES, 1:1 emulation
// mode) and m68k (Genesis, real 6502→68000 logic translation) through the SAME
// lift→IR→emit path, and that the NES→Genesis logic port BUILDS (vasm68k) and
// BOOTS (gpgx) with the translated logic actually executing.

import { test } from "node:test";
import assert from "node:assert/strict";

import { recompile, supportedPairs } from "../src/analysis/recompile/index.js";
import { lift6502 } from "../src/analysis/recompile/lift-6502.js";
import { IR } from "../src/analysis/recompile/ir.js";
import { runAsar } from "../src/toolchains/asar/asar.js";
import { runVasm68k } from "../src/toolchains/vasm68k/vasm68k.js";
import { resolveCore } from "../src/cores/registry.js";
import { LibretroHost } from "romdev-core-host/index.js";

const SAMPLE = [
  "        .setcpu \"6502\"",
  "        sei", "        cld",
  "        lda     #$42", "        sta     $0010", // RAM[$10] = $42
  "        lda     #$99", "        sta     $0011", // RAM[$11] = $99
  "        sta     $2000",                          // a hardware-seam write
  "L8016:  bit     $2002",                          // a hardware-seam read
  "        bpl     L8016",
  "        inx",
  "        jmp     L8016",
].join("\n");

test("lift6502 → IR: classifies loads/stores/seam/branch/jump + abstract tags", () => {
  const { ir, instrCount, seamCount, entry } = lift6502(SAMPLE);
  assert.ok(entry, "anchored an entry");
  assert.ok(instrCount >= 8);
  assert.equal(seamCount, 2, "two hwreg (seam) accesses: sta $2000 + bit $2002");
  const kinds = ir.map((n) => n.op);
  assert.ok(kinds.includes(IR.HWREG), "seam → hwreg node");
  assert.ok(kinds.includes(IR.BRANCH), "bpl → branch node");
  assert.ok(kinds.includes(IR.JUMP), "jmp → jump node");
  assert.ok(kinds.includes(IR.REG), "lda/sta/inx → reg nodes");
});

test("supportedPairs lists nes→snes and nes→genesis", () => {
  const pairs = supportedPairs();
  assert.ok(pairs.includes("nes→snes"));
  assert.ok(pairs.includes("nes→genesis"));
});

test("recompile targets SNES (65816) through the generic engine", () => {
  const r = recompile(SAMPLE, { source: "nes", target: "snes" });
  assert.equal(r.targetIsa, "65816");
  assert.equal(r.residue.length, 0, "the sample is fully mechanical");
  assert.match(r.mainAsm, /lorom/, "SNES LoROM image");
  assert.match(r.mainAsm, /sta\s+\$2000/, "seam access present");
});

test("recompile targets Genesis (m68k) through the SAME engine — real ISA translation", () => {
  const r = recompile(SAMPLE, { source: "nes", target: "genesis" });
  assert.equal(r.targetIsa, "m68k");
  assert.equal(r.residue.length, 0);
  // 6502 → 68000 translation evidence: lda#→move.b#, sta$10→move.b d0,($FF0010).l
  assert.match(r.mainAsm, /move\.b\s+#\$42,d0/, "lda #$42 → move.b #$42,d0");
  assert.match(r.mainAsm, /move\.b\s+d0,\(\$FF0010\)\.l/, "sta $0010 → move.b d0,(NES_RAM+$10)");
  assert.match(r.mainAsm, /SEGA MEGA DRIVE/, "Genesis ROM header");
  assert.match(r.mainAsm, /jsr\s+NES_PPU_WRITE/, "seam → runtime call");
});

test("unsupported target fails with the supported set", () => {
  assert.throws(() => recompile(SAMPLE, { source: "nes", target: "gb" }), /no emitter for target 'gb'.*snes, genesis/s);
});

test("e2e: NES→SNES builds with asar", { timeout: 120000 }, async () => {
  const r = recompile(SAMPLE, { source: "nes", target: "snes" });
  const asar = await runAsar({ source: r.mainAsm, includes: { [r.seamFile]: r.seamAsm } });
  assert.equal(asar.exitCode, 0, `asar: ${(asar.log || "").slice(0, 400)}`);
  assert.ok(asar.binary && asar.binary.length > 0);
});

test("e2e: NES→Genesis builds (vasm68k) AND boots (gpgx) with the logic executing", { timeout: 180000 }, async () => {
  const r = recompile(SAMPLE, { source: "nes", target: "genesis" });
  const vasm = await runVasm68k({ source: r.mainAsm, includes: { [r.seamFile]: r.seamAsm } });
  assert.equal(vasm.exitCode, 0, `vasm68k failed: exit ${vasm.exitCode}`);
  assert.ok(vasm.binary && vasm.binary.length > 0, "produced a Genesis ROM image");

  // Boot it and prove the TRANSLATED logic ran: the 6502 `sta $0010`/`sta $0011`
  // (now `move.b d0,($FF0010/$FF0011).l`) must have written $42/$99 into the
  // mapped work-RAM block ($FF0000 → genesis system_ram).
  const core = resolveCore("genesis");
  const host = new LibretroHost();
  await host.loadCore(core.jsPath, core.wasmPath);
  await host.loadMedia({ platform: "genesis", bytes: new Uint8Array(vasm.binary), virtualName: "/rom.bin" });
  host.stepFrames(10);
  const ram = host.readMemory("system_ram", 0x10, 2);
  assert.equal(ram[0], 0x42, "translated `sta $0010` wrote $42 to Genesis work RAM");
  assert.equal(ram[1], 0x99, "translated `sta $0011` wrote $99");
  host.unloadMedia();
});
