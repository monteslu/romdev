// wla-65816 + wlalink end-to-end smoke test.
//
// Assembles a minimal LoROM SNES program with wla-65816, links it with
// wlalink, and asserts the resulting 32 KB ROM has the expected header.

import { test } from "node:test";
import assert from "node:assert/strict";
import { runWla65816, runWlalink } from "./wladx.js";

const HELLO_ASM = `
.MEMORYMAP
DEFAULTSLOT 0
SLOTSIZE $8000
SLOT 0 $8000
.ENDME

.ROMBANKMAP
BANKSTOTAL 1
BANKSIZE $8000
BANKS 1
.ENDRO

.SNESHEADER
ID "HHHH"
NAME "HELLO   "
LOROM
CARTRIDGETYPE $00
ROMSIZE $08
SRAMSIZE $00
COUNTRY $01
LICENSEECODE $00
VERSION $00
.ENDSNES

.SNESNATIVEVECTOR
COP EmptyHandler
BRK EmptyHandler
ABORT EmptyHandler
NMI EmptyHandler
IRQ EmptyHandler
.ENDNATIVEVECTOR

.SNESEMUVECTOR
COP EmptyHandler
ABORT EmptyHandler
NMI EmptyHandler
RESET Start
IRQBRK EmptyHandler
.ENDEMUVECTOR

.BANK 0 SLOT 0
.ORG 0
.SECTION "Hello"
Start:
  sei
  clc
  xce
-:
  jmp -
EmptyHandler:
  rti
.ENDS
`;

const LINKFILE = `
[objects]
/work/main.o
`;

test("wla-65816: assemble a minimal SNES LoROM .asm to a .o", async () => {
  const r = await runWla65816({ source: HELLO_ASM });
  assert.equal(r.exitCode, 0, "wla-65816 exit: " + r.exitCode + " log:\n" + r.log);
  assert.ok(r.object, "no .o output");
  assert.ok(r.object.length > 0, "empty .o");
});

test("wlalink: link the assembled .o into a 32 KB LoROM SNES ROM", async () => {
  const asmR = await runWla65816({ source: HELLO_ASM });
  assert.equal(asmR.exitCode, 0, "wla-65816 prereq failed");
  const r = await runWlalink({
    objects: { "main.o": asmR.object },
    linkfile: LINKFILE,
  });
  assert.equal(r.exitCode, 0, "wlalink exit: " + r.exitCode + " log:\n" + r.log);
  assert.ok(r.binary, "no SNES ROM produced");
  assert.equal(r.binary.length, 32 * 1024, "expected 32KB LoROM, got " + r.binary.length);
  // Header at $7FC0..$7FD4 should hold our "HELLO   " name.
  const name = Buffer.from(r.binary.subarray(0x7FC0, 0x7FC0 + 8)).toString("ascii");
  assert.equal(name, "HELLO   ", "ROM header NAME field: " + JSON.stringify(name));
});
