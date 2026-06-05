// GBA (ARM7TDMI) disassembly via native binutils ARM objdump — the 14th
// platform, previously rejected ("no bundled ARM disassembler"). objdump ships
// in romdev-platform-gba alongside as/ld/objcopy.

import { test } from "node:test";
import assert from "node:assert/strict";

import { runObjdump, objdumpAvailable } from "../src/toolchains/objdump.js";
import { buildForPlatform } from "../src/toolchains/index.js";

test("ARM + Thumb objdump are available (ship in romdev-platform-gba)", () => {
  assert.equal(objdumpAvailable("arm"), true);
  assert.equal(objdumpAvailable("thumb"), true);
});

test("ARM objdump decodes ARM instructions", async () => {
  // e3a00000 mov r0,#0 | e12fff1e bx lr  (little-endian words)
  const bytes = Uint8Array.from([0x00, 0x00, 0xA0, 0xE3, 0x1E, 0xFF, 0x2F, 0xE1]);
  const r = await runObjdump({ bytes, arch: "arm", startAddress: 0x08000000 });
  assert.equal(r.available, true);
  assert.match(r.asm, /\bmov\b/i, "mov decoded");
  assert.match(r.asm, /\bbx\b/i, "bx decoded");
  assert.doesNotMatch(r.asm, /\.dc\.w|undefined instruction/i);
});

test("Thumb objdump decodes Thumb instructions (force-thumb)", async () => {
  // 2000 movs r0,#0 | 4770 bx lr
  const bytes = Uint8Array.from([0x00, 0x20, 0x70, 0x47]);
  const r = await runObjdump({ bytes, arch: "thumb", startAddress: 0x08000000 });
  assert.match(r.asm, /\bmovs?\b/i, "movs decoded");
  assert.match(r.asm, /\bbx\b/i, "bx decoded");
});

test("a built GBA ROM disassembles to real ARM7 code (the once-rejected platform)", async () => {
  const src = `#include <tonc.h>
int main(){ REG_DISPCNT = DCNT_MODE3 | DCNT_BG2; while(1){ vid_vsync(); } }`;
  const b = await buildForPlatform({ platform: "gba", source: src, sourceName: "main.c", language: "c" });
  assert.ok(b.binary, `gba build failed: ${(b.log || "").slice(-300)}`);
  const r = await runObjdump({ bytes: b.binary.slice(0, 0x400), arch: "arm", startAddress: 0x08000000 });
  assert.equal(r.available, true);
  // The cart entry is a branch over the header; the I/O base 0x4000000 appears
  // in the boot code. Just assert we got real, varied ARM mnemonics — not junk.
  assert.match(r.asm, /\b(b|bl|mov|ldr|str|msr|add|sub)\b/i, "real ARM mnemonics present");
  const instrLines = r.asm.split("\n").filter((l) => l.startsWith("        ") && !l.includes(".setcpu"));
  assert.ok(instrLines.length > 20, "substantial disassembly");
}, { timeout: 60000 });
