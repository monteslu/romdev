// Native binutils z80 objdump replaces the hand-rolled z80dasm (SMS/GG/MSX) and
// sm83dasm (GB/GBC). ONE binary covers both: -m z80 for the Z80, -m gbz80 for the
// Game Boy CPU (binutils z80-dis.c has full INSS_GBZ80 support). Ships in
// romdev-toolchain-sdcc.

import { test } from "node:test";
import assert from "node:assert/strict";
import { runObjdump, objdumpAvailable } from "../src/toolchains/objdump.js";

test("z80 + gbz80 objdump are available (ship in romdev-toolchain-sdcc)", () => {
  assert.equal(objdumpAvailable("z80"), true);
  assert.equal(objdumpAvailable("gbz80"), true);
});

test("z80 objdump decodes prefix opcodes WITH the (ix+d)/(iy+d) displacement", async () => {
  // ed b0 ldir | dd cb 05 46 bit 0,(ix+5) | fd 7e 05 ld a,(iy+5)
  // The hand-rolled z80dasm dropped the +d on the FD form — objdump keeps it.
  const bytes = Uint8Array.from([0xED, 0xB0, 0xDD, 0xCB, 0x05, 0x46, 0xFD, 0x7E, 0x05]);
  const r = await runObjdump({ bytes, arch: "z80", startAddress: 0x100 });
  assert.equal(r.available, true);
  assert.match(r.asm, /ldir/i);
  assert.match(r.asm, /bit\s+0,\(ix\+(\$|0x)?0?5\)/i, "(ix+5) displacement shown");
  assert.match(r.asm, /ld\s+a,\(iy\+(\$|0x)?0?5\)/i, "(iy+5) displacement shown (the z80dasm bug)");
});

test("gbz80 objdump decodes GB-specific SM83 ops", async () => {
  // e0 40 ldh (40),a | 22 ld (hl+),a | 08 00 c0 ld (c000),sp | f8 05 ldhl sp,5
  const bytes = Uint8Array.from([0xE0, 0x40, 0x22, 0x08, 0x00, 0xC0, 0xF8, 0x05]);
  const r = await runObjdump({ bytes, arch: "gbz80", startAddress: 0x150 });
  assert.equal(r.available, true);
  assert.match(r.asm, /ldh/i, "ldh decoded");
  assert.match(r.asm, /ld\s+\(hl\+\),a/i, "ld (hl+),a decoded");
  assert.match(r.asm, /sp/i, "sp-relative op decoded");
  assert.doesNotMatch(r.asm, /\.dc\.w|\.db\b/i);
});

test("z80 and gbz80 disagree on the same bytes (machine selection works)", async () => {
  // 0x08: Z80 = "ex af,af'"; GB = "ld (nn),sp". Same byte, different ISA.
  const bytes = Uint8Array.from([0x08, 0x00, 0xC0]);
  const z = await runObjdump({ bytes, arch: "z80", startAddress: 0 });
  const g = await runObjdump({ bytes, arch: "gbz80", startAddress: 0 });
  assert.match(z.asm, /ex\s+af/i, "Z80 reads 0x08 as ex af,af'");
  assert.match(g.asm, /ld\s+\(.*\),sp/i, "GB reads 0x08 as ld (nn),sp");
});
