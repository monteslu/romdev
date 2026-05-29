// Smoke test: assemble a tiny Atari 2600 program with bundled dasm.wasm
// and verify the binary is the right size and content.

import { test } from "node:test";
import assert from "node:assert/strict";
import { runDasm } from "./dasm.js";

// Minimal Atari 2600 ROM: 4KB. Sets background blue, infinite loop.
// dasm syntax. F8 mapper (4KB starting at $F000).
const ATARI_HELLO = `
  processor 6502

  org $F000
START:
  SEI
  CLD
  LDX #$FF
  TXS
  LDA #0
CLEAR:
  STA $00,X
  DEX
  BNE CLEAR

  LDA #$80          ; blue
  STA $09           ; COLUBK

LOOP:
  JMP LOOP

  org $FFFC
  .word START
  .word START
`;

test("dasm.wasm assembles a minimal 2600 program (raw 4KB)", async () => {
  const result = await runDasm({ source: ATARI_HELLO, outputFormat: "f3" });
  assert.equal(result.exitCode, 0, "expected exit 0, log:\n" + result.log);
  assert.ok(result.binary, "expected a binary, log:\n" + result.log);
  // f3 is true raw output, no address header.
  assert.equal(result.binary.length, 4096, "expected 4096 bytes for ORG $F000–$FFFF");
  // Last 4 bytes are the reset vector → points to $F000 (little-endian).
  const lastFour = result.binary.slice(-4);
  assert.equal(lastFour[0], 0x00);
  assert.equal(lastFour[1], 0xf0);
  assert.equal(lastFour[2], 0x00);
  assert.equal(lastFour[3], 0xf0);
});

test("dasm.wasm f1 output includes 2-byte load address header", async () => {
  const result = await runDasm({ source: ATARI_HELLO, outputFormat: "f1" });
  assert.equal(result.exitCode, 0, "log:\n" + result.log);
  assert.ok(result.binary);
  assert.equal(result.binary.length, 4098, "f1 = 4096 + 2-byte header");
  // Header is the load address $F000 in little-endian.
  assert.equal(result.binary[0], 0x00);
  assert.equal(result.binary[1], 0xf0);
});

test("dasm.wasm reports errors with nonzero exit", async () => {
  const result = await runDasm({ source: "this is not assembly\n" });
  assert.notEqual(result.exitCode, 0, "log:\n" + result.log);
  assert.ok(result.log.length > 0, "expected error log");
});
