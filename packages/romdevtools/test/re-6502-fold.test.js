// re-6502-fold.test.js — B1: 6502 idiom-folding post-pass (deterministic half).
// The 6502's 8-bit ALU lowers to SLEIGH clutter — awkward width types (uint1,
// xunknown1), redundant nested width casts ((uint2)(uint1)x), and raw zero-page
// byte refs (cRAM00fd). The fold rewrites the SAFE, mechanical ones into readable
// C99 without changing semantics.

import { test } from "node:test";
import assert from "node:assert/strict";

import { foldSixtyFiveOhTwoIdioms } from "../src/analysis/analyze.js";

test("B1: SLEIGH width types become C99 stdint", () => {
  const c =
    "void fn(uint1 a, xunknown1 b) {\n" +
    "  uint2 w;\n" +
    "  undefined1 d;\n" +
    "  w = (uint2)a;\n" +
    "}\n";
  const out = foldSixtyFiveOhTwoIdioms(c, "nes");
  assert.match(out, /\buint8_t a\b/, "uint1 → uint8_t");
  assert.match(out, /\buint8_t b\b/, "xunknown1 → uint8_t");
  assert.match(out, /\buint16_t w\b/, "uint2 → uint16_t");
  assert.match(out, /\buint8_t d\b/, "undefined1 → uint8_t");
  assert.doesNotMatch(out, /\b(uint1|uint2|xunknown1|undefined1)\b/, "no raw SLEIGH width types remain");
  assert.match(out, /^\/\* 6502 fold:.*stdint/, "legend notes the type fold");
});

test("B1: redundant nested width casts collapse", () => {
  // (uint16_t)(uint8_t)x — the outer widen is noise; keep the inner narrowing.
  const c = "x = *(uint1 *)(uint2)(uint1)(p - 0xb);\n";
  const out = foldSixtyFiveOhTwoIdioms(c, "nes");
  assert.doesNotMatch(out, /\(uint16_t\)\(uint8_t\)/, "the (uint16_t)(uint8_t) pair is gone");
  assert.match(out, /\(uint8_t\)\(p - 0xb\)/, "the inner narrowing cast governs");
});

test("B1: zero-page byte refs are named zp_XX", () => {
  const c = "cRAM00fd = 1; uRAM0012 = cRAM00fe;\n";
  const out = foldSixtyFiveOhTwoIdioms(c, "nes");
  assert.match(out, /\bzp_FD = 1;/, "$00FD → zp_FD");
  assert.match(out, /\bzp_12 = zp_FE;/, "$0012 → zp_12, $00FE → zp_FE");
  assert.doesNotMatch(out, /RAM00/, "no raw $00xx RAM refs remain");
});

test("B1: a non-$00 page RAM ref is NOT treated as zero-page", () => {
  // $0312 is RAM but not the zero page — leave it alone (the zp labeler only
  // matches the RAM00xx form).
  const c = "xRAM0312 = 5;\n";
  const out = foldSixtyFiveOhTwoIdioms(c, "nes");
  assert.match(out, /xRAM0312 = 5;/, "$0312 left as-is (not zero page)");
});

test("B1: off-target platforms are a no-op", () => {
  // GBA (ARM) / Genesis (m68k) don't get the 6502 fold — their decompile is
  // already clean C and the SLEIGH width types mean different things.
  const c = "uint1 a; cRAM00fd = a;\n";
  assert.equal(foldSixtyFiveOhTwoIdioms(c, "gba"), c, "gba: untouched");
  assert.equal(foldSixtyFiveOhTwoIdioms(c, "genesis"), c, "genesis: untouched");
  // But every 6502-family platform DOES fold.
  for (const p of ["nes", "atari2600", "atari7800", "c64", "lynx", "pce"]) {
    assert.notEqual(foldSixtyFiveOhTwoIdioms(c, p), c, `${p}: folds`);
  }
});

test("B1: nothing-to-fold input is returned verbatim (no empty legend)", () => {
  const c = "void fn(void) { return; }\n";
  assert.equal(foldSixtyFiveOhTwoIdioms(c, "nes"), c, "clean C → unchanged, no legend prepended");
});
