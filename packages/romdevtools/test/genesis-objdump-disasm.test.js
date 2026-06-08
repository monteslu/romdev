// Native binutils m68k objdump replaces the hand-rolled m68kdasm for Genesis.
// The pure-JS decoder dropped move-sr / muls / divu to `.dc.w` and desynced the
// stream (the "useless binary" feedback). These tests assert the native tool is
// available, decodes those exact instructions, and that disassembleRom on a real
// Genesis ROM yields real mnemonics (not a wall of .dc.w).

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runObjdump, objdumpAvailable, normalizeObjdump } from "../src/toolchains/objdump.js";
import { buildForPlatform } from "../src/toolchains/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test("m68k objdump is available (ships in romdev-toolchain-m68k-gcc)", () => {
  assert.equal(objdumpAvailable("m68k"), true);
});

test("m68k objdump decodes move-sr / muls / divu (the m68kdasm gaps)", async () => {
  // 40c0 move sr,d0 | c1c2 muls d2,d0 | 80c1 divu d1,d0 | 4e75 rts
  const bytes = Uint8Array.from([0x40, 0xC0, 0xC1, 0xC2, 0x80, 0xC1, 0x4E, 0x75]);
  const r = await runObjdump({ bytes, arch: "m68k", startAddress: 0x200 });
  assert.equal(r.available, true);
  assert.equal(r.exitCode, 0);
  // No .dc.w fallbacks — every one is a real instruction.
  assert.doesNotMatch(r.asm, /\.dc\.w/, "native objdump must not emit .dc.w for valid opcodes");
  assert.match(r.asm, /move\w*\s+%sr/i, "move sr decoded");
  assert.match(r.asm, /muls/i, "muls decoded");
  assert.match(r.asm, /divu/i, "divu decoded");
  assert.match(r.asm, /\brts\b/i, "rts decoded");
});

test("multi-word opcodes keep the stream aligned (no desync cascade)", async () => {
  // 4eb9 0000 0212 = jsr 0x212 (6 bytes). A wrong length here desyncs everything
  // after it; the next bytes are a clean rts.
  const bytes = Uint8Array.from([0x4E, 0xB9, 0x00, 0x00, 0x02, 0x12, 0x4E, 0x75]);
  const r = await runObjdump({ bytes, arch: "m68k", startAddress: 0x200 });
  assert.match(r.asm, /jsr/i, "jsr decoded");
  assert.match(r.asm, /\brts\b/i, "rts after the 6-byte jsr decoded — stream stayed aligned");
});

test("normalizeObjdump shapes objdump output to romdev's asm (labels + $/offset)", () => {
  const raw = [
    "/in.bin:     file format binary",
    "",
    "Disassembly of section .data:",
    "",
    "00000200 <.data>:",
    "     200:\t60fe           \tbras 0x200",
    "     202:\t4e75           \trts",
  ].join("\n");
  const asm = normalizeObjdump(raw, 0x200);
  assert.match(asm, /L000200:/, "in-range branch target gets an L label");
  assert.match(asm, /bras\s+L000200/, "operand rewritten to the label");
  assert.match(asm, /; 000200 60 fe/, "address + raw bytes (per-byte) preserved as a comment");
});

test("disassembleRom on a built Genesis ROM yields real mnemonics, not .dc.w spam", async () => {
  // A C ROM via SGDK pulls in real m68k (mul/div, movem, link/unlk, …).
  const src = `#include <genesis.h>
int mul(int a,int b){return a*b;}
int main(){ VDP_init(); volatile int x=3; for(;;){ x=mul(x,7); VDP_waitVSync(); } return 0; }`;
  const b = await buildForPlatform({ platform: "genesis", source: src, sourceName: "main.c", language: "c" });
  assert.ok(b.binary, `genesis build failed: ${(b.log || "").slice(-300)}`);
  const resetPc = (b.binary[4] << 24 | b.binary[5] << 16 | b.binary[6] << 8 | b.binary[7]) >>> 0;
  const start = resetPc < b.binary.length ? resetPc : 0x200;
  const bytes = b.binary.slice(start, Math.min(b.binary.length, start + 0x4000));
  const r = await runObjdump({ bytes, arch: "m68k", startAddress: start });
  const lines = r.asm.split("\n").filter((l) => l.startsWith("        ") && !l.includes(".setcpu"));
  const dcw = lines.filter((l) => /\.dc\.w/.test(l)).length;
  assert.ok(lines.length > 100, "should produce a substantial disassembly");
  // Native objdump should have essentially zero undecodable words in real code.
  assert.ok(dcw / lines.length < 0.02, `.dc.w ratio ${(dcw / lines.length * 100).toFixed(1)}% should be ~0`);
  assert.match(r.asm, /\b(muls|mulu|divu|divs|movem|jsr|lea|move)\b/i, "real m68k mnemonics present");
}, { timeout: 60000 });
