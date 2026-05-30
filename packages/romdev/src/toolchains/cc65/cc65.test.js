// cc65 toolchain smoke test: build a minimal NES program.
//
// Output should be a valid .nes file (iNES header + 16KB PRG + 8KB CHR for
// the default mapper 0 layout that cc65's nes.cfg produces).

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildC, buildAsm } from "./cc65.js";

const HELLO_NES_C = `
#include <nes.h>

void main(void) {
  while (1) { }
}
`;

const HELLO_NES_ASM = `
.segment "HEADER"
  .byte "NES", $1A
  .byte 2     ; 2 x 16KB PRG
  .byte 1     ; 1 x 8KB CHR
  .byte 0
  .byte 0
  .byte 0, 0, 0, 0, 0, 0, 0, 0

.segment "STARTUP"
.segment "CODE"
RESET:
loop:
  jmp loop

NMI:
  rti

IRQ:
  rti

.segment "VECTORS"
  .word NMI
  .word RESET
  .word IRQ

.segment "CHARS"
  .res 8192, $00
`;

test("cc65: build a minimal NES C program to a .nes binary", async () => {
  const r = await buildC({ source: HELLO_NES_C, target: "nes" });
  assert.equal(r.exitCode, 0, "build failed at " + r.stage + "\n" + r.log);
  assert.ok(r.binary, "no binary produced\n" + r.log);
  // NES files start with "NES\x1A".
  assert.equal(r.binary[0], 0x4e);
  assert.equal(r.binary[1], 0x45);
  assert.equal(r.binary[2], 0x53);
  assert.equal(r.binary[3], 0x1a);
}, { timeout: 30000 });

test("cc65: build a minimal NES asm program to a .nes binary (no-library link)", async () => {
  // Direct asm -> ld65 needs a -C config; the default target uses nes.lib
  // which assumes the cc65 C runtime. For this test we just confirm the
  // raw asm path runs through ca65 successfully — we don't link.
  const { runCa65 } = await import("./cc65.js");
  const ca = await runCa65({ source: HELLO_NES_ASM, target: "nes" });
  assert.equal(ca.exitCode, 0, "ca65 failed\n" + ca.log);
  assert.ok(ca.object, "no object produced\n" + ca.log);
  assert.ok(ca.object.length > 0);
}, { timeout: 15000 });
