// re-bank-aware.test.js — A1 bank-aware NES decompile image construction.
//
// Rizin maps an iNES PRG as one flat $8000-based segment, so a function in bank
// 3 reports a flat VA like $1Cxxx. Decompiling that flat image is bank-blind —
// a cross-bank JSR lands on the wrong bytes (empirically 11/12 top functions on
// a banked cart decompiled to halt_baddata before this fix). buildNesBankImage
// recovers the bank from the flat VA and lays out a real 32KB CPU window (that
// bank @ $8000 + the fixed top bank @ $C000) so calls resolve.
//
// Deterministic unit test of the image construction (no ROM toolchain needed).

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildNesBankImage } from "../src/analysis/analyze.js";

/** Build a synthetic iNES with `banks16k` PRG banks, each filled with a
 * distinguishable marker byte (bank N → 0x10+N). */
function synthINes(banks16k) {
  const prgSize = banks16k * 0x4000;
  const rom = new Uint8Array(16 + prgSize);
  rom.set([0x4e, 0x45, 0x53, 0x1a]); // "NES\x1a"
  rom[4] = banks16k;                 // PRG bank count
  rom[6] = 0x10;                     // flags6: mapper-lo nibble 1 (mapper 1)
  for (let b = 0; b < banks16k; b++) {
    rom.fill(0x10 + b, 16 + b * 0x4000, 16 + (b + 1) * 0x4000);
  }
  return rom;
}

test("A1: NROM (≤32KB) returns null (flat path is correct)", () => {
  assert.equal(buildNesBankImage(synthINes(1), 0x8000), null, "NROM-128 → flat");
  assert.equal(buildNesBankImage(synthINes(2), 0x8000), null, "NROM-256 → flat");
});

test("A1: banked cart lays the right bank @ $8000 + fixed top bank @ $C000", () => {
  // 4 banks (64KB): bank 0=0x10, 1=0x11, 2=0x12, 3=0x13 (3 = fixed top).
  const rom = synthINes(4);

  // A function whose flat VA is in bank 0 ($8000 + 0x100 = $8100).
  const b0 = buildNesBankImage(rom, 0x8100);
  assert.ok(b0, "banked → non-null");
  assert.equal(b0.bank, 0, "flat $8100 is bank 0");
  assert.equal(b0.cpuAddr, 0x8100, "bank-0 CPU address is $8100 (switchable slot)");
  assert.equal(b0.image.length, 0x10000, "32KB CPU window in a 64KB image");
  assert.equal(b0.image[0x8100], 0x10, "$8000 slot holds bank 0 (0x10)");
  assert.equal(b0.image[0xC100], 0x13, "$C000 holds the FIXED TOP bank (bank 3 = 0x13)");

  // A function in bank 2 (flat $8000 + 2*0x4000 + 0x50 = $10050).
  const b2 = buildNesBankImage(rom, 0x10050);
  assert.equal(b2.bank, 2, "flat $10050 is bank 2");
  assert.equal(b2.cpuAddr, 0x8050, "a switchable bank maps to $8000+inBank");
  assert.equal(b2.image[0x8050], 0x12, "$8000 slot now holds bank 2 (0x12)");
  assert.equal(b2.image[0xC050], 0x13, "$C000 still the fixed top bank");

  // A function in the fixed top bank itself (flat $8000 + 3*0x4000 + 0x80).
  const bTop = buildNesBankImage(rom, 0x8000 + 3 * 0x4000 + 0x80);
  assert.equal(bTop.bank, 3, "flat in bank 3");
  assert.equal(bTop.cpuAddr, 0xC080, "fixed top bank maps to $C000+inBank");
  assert.equal(bTop.image[0xC080], 0x13, "$C000 holds bank 3");
});

test("A1: out-of-range flat VA returns null (caller falls back)", () => {
  const rom = synthINes(4); // 64KB PRG → flat $8000-$17FFF
  assert.equal(buildNesBankImage(rom, 0x7FFF), null, "below $8000");
  assert.equal(buildNesBankImage(rom, 0x18000), null, "past the PRG");
});

test("A1: non-iNES returns null", () => {
  assert.equal(buildNesBankImage(new Uint8Array([1, 2, 3, 4, 5]), 0x8000), null);
});
