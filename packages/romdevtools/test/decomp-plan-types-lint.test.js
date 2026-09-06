// decomp-plan-types-lint.test.js — the parts of the decomp domain that need
// no compiler: candidate lint (what never counts as recovered C), type
// evidence from asm access widths, and the m2c macro injection.
import { test } from "node:test";
import assert from "node:assert/strict";
import { lintCandidate, m2cMacroDefinitions } from "../src/decomp/compile.js";
import { accessEvidence } from "../src/decomp/types.js";

test("lint: inline asm, GLOBAL_ASM, incbin and copied word arrays are REJECTED", () => {
  assert.equal(lintCandidate("void f(void) { __asm__ volatile(\"nop\"); }").rejected, true);
  assert.equal(lintCandidate("void f(void) { asm(\"nop\"); }").rejected, true);
  assert.equal(lintCandidate("#pragma GLOBAL_ASM(\"x.s\")\n").rejected, true);
  const words = "static const u32 blob[] = { " + Array.from({ length: 12 }, (_, i) => "0x27BDFF" + (i + 16).toString(16).padStart(2, "0")).join(", ") + " };";
  assert.equal(lintCandidate(words).rejected, true);
  const r = lintCandidate("void f(s32* p) { *p = 1; }");
  assert.equal(r.rejected, false); assert.equal(r.countsAsRecoveredC, true); assert.deepEqual(r.flags, []);
});

test("lint: type punning and unsequenced access are FLAGGED, not rejected", () => {
  const r = lintCandidate("f32 g(u32 x) { return *(f32*)&x; }");
  assert.equal(r.rejected, false); assert.ok(r.flags.some((f) => /punning/.test(f)));
  const u = lintCandidate("void h(s32 i) { i = i++; }");
  assert.ok(u.flags.some((f) => /unsequenced/.test(f)));
  const e = lintCandidate("void h(void) { M2C_ERROR(unknown); }");
  assert.ok(e.flags.some((f) => /M2C_ERROR/.test(f)));
});

test("m2c macro injection: only the referenced macros, plus a memcpy prototype for the copy macros", () => {
  const r = m2cMacroDefinitions("void f(void* a, void* b) { M2C_MEMCPY_ALIGNED(a, b, 0x54); M2C_FIELD(a, s32*, 4) = 1; }");
  assert.deepEqual(r.names.sort(), ["M2C_FIELD", "M2C_MEMCPY_ALIGNED"]);
  assert.ok(/#define M2C_FIELD/.test(r.text)); assert.ok(/memcpy\(/.test(r.text));
  assert.equal(m2cMacroDefinitions("void f(void) {}").text, "");
});

test("type evidence: access widths and register bases come from the asm, per offset", () => {
  const asm = `glabel func_X
    /* 100 80000400 8CA20004 */  lw         $v0, 0x4($a1)
    /* 104 80000404 84A30008 */  lh         $v1, 0x8($a1)
    /* 108 80000408 C4C00010 */  lwc1       $ft0, 0x10($a2)
    /* 10C 8000040C A0A2000C */  sb         $v0, 0xC($a1)
`;
  const ev = accessEvidence(asm);
  assert.equal(ev.length, 4);
  assert.deepEqual(ev.map((e) => [e.base, e.offset, e.width, e.kind]), [["a1", 4, 4, "load"], ["a1", 8, 2, "load"], ["a2", 16, 4, "load"], ["a1", 12, 1, "store"]]);
  assert.equal(ev[2].type, "f32");
});
