// Dreamcast SH-4 analysis slice: rizin `sh` arch + Ghidra SuperH4 SLEIGH decompile.
// Pins the wiring + proves the decompiler actually produces C from SH-4 bytes.
import { test } from "node:test";
import assert from "node:assert/strict";

import { RIZIN_ARCH, RIZIN_ENDIAN, runRizin } from "../src/analysis/rizin.js";
import { SLEIGH_LANGID, decompileFunction } from "../src/analysis/decompile.js";
import { CAPABILITIES, NEXTGEN_TIER_PLATFORMS, CONTRACT_PLATFORMS, naReason } from "../src/cores/capabilities.js";

test("dreamcast: SH-4 arch + endian + SLEIGH langid are wired", () => {
  assert.equal(RIZIN_ARCH.dreamcast, "sh");
  assert.equal(RIZIN_ENDIAN.dreamcast, "little");
  assert.equal(SLEIGH_LANGID.dreamcast, "SuperH4:LE:32:default");
});

test("dreamcast: manifest is the sh tier (analysis-first), excluded from the 14-contract", () => {
  const c = CAPABILITIES.dreamcast;
  assert.equal(c.cpuFamily, "sh");
  assert.equal(c.tier, "sh");
  assert.equal(c.renderingKind, "3d");
  assert.equal(c.ops.disasm, true, "disasm wired (rizin sh plugin)");
  assert.equal(c.ops.decompile, true, "decompile wired (SuperH4 SLEIGH)");
  assert.ok(NEXTGEN_TIER_PLATFORMS.includes("dreamcast"), "in the next-gen tier");
  assert.ok(!CONTRACT_PLATFORMS.includes("dreamcast"), "not held to the all-14 contract yet");
  // 3D renderer → tile/sprite inspectors are N/A by hardware, with a stated reason
  for (const op of ["inspectSprites", "inspectPalette", "renderingContext"]) {
    assert.equal(c.ops[op], false);
    assert.ok(/3D|polygon|no tile|no .*table/i.test(naReason("dreamcast", op) || ""), `${op} carries a hw N/A reason`);
  }
});

test("dreamcast: SH-4 disassembles + decompiles to C (SuperH4 SLEIGH)", async () => {
  // SH-4 LE: mov r4,r0 (43 60), rts (0b 00), nop (09 00 delay slot)
  const code = new Uint8Array([0x43, 0x60, 0x0b, 0x00, 0x09, 0x00]);
  const r = await runRizin({ romBytes: code, arch: "sh", bits: 32, endian: "little", commands: "e asm.arch=sh; pd 3 @ 0" });
  const dis = r.outputs?.["/work/out.txt"] || r.output || "";
  assert.match(dis, /mov\s+r4,\s*r0/, "SH-4 disasm decodes mov r4,r0");
  assert.match(dis, /rts/, "SH-4 disasm decodes rts");
  const dc = await decompileFunction({ platform: "dreamcast", romBytes: code, fileOffset: 0 });
  assert.equal(dc.langid, "SuperH4:LE:32:default");
  assert.ok(dc.code && /return/.test(dc.code), "decompile produced C with a return");
});
