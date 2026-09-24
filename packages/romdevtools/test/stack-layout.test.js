// Report 2026-09-15 §8. The ceremony case: original frame 472, refreshed draft
// 480 with the same instruction count. Mtx -> Mtx_t restored the size but left
// two matrix homes four bytes high (188/124 instead of 184/120), and moving a
// real declaration between two others reproduced every original offset.
//
// Acceptance: "reproduce the ceremony frame/offset transition using real
// locals ... Never recommend invented padding or arbitrary global writes
// merely to manipulate register allocation."
import { test } from "node:test";
import assert from "node:assert/strict";
import { frameSizeOf, stackSlots, resolveAddress, layoutReport } from "../src/decomp/layout.js";

const ins = (mnemonic, operands) => ({ mnemonic, operands });

test("the frame size comes from the prologue adjustment", () => {
  assert.equal(frameSizeOf([ins("addiu", "sp,sp,-472"), ins("sw", "ra,0x1c(sp)")]), 472);
  assert.equal(frameSizeOf([ins("or", "v0,zero,zero")]), null);
});

test("an ADDRESS-TAKEN local is a slot, though it is never loaded or stored", () => {
  // The two homes that mattered in the report are reached only by
  // `addiu s0,sp,184` -- they are passed to a helper by address. A scanner
  // that looked only at lw/sw reported the frames as identical.
  const m = stackSlots([ins("addiu", "s0,sp,184"), ins("addiu", "a0,sp,120")], { frameSize: 472 });
  const offsets = m.slots.map((s) => s.offset);
  assert.deepEqual(offsets, [120, 184]);
  for (const s of m.slots) {
    assert.equal(s.addressTaken, 1);
    assert.match(s.inferredRole, /address-taken/);
    assert.match(s.inferredRole, /SIZE is not observable/,
      "taking an address says where an object lives, not how big it is");
  }
});

test("the ceremony transition is reported as a uniform shift, not N problems", () => {
  const target = [ins("addiu", "sp,sp,-472"), ins("addiu", "a0,sp,120"), ins("addiu", "s0,sp,184")];
  const candidate = [ins("addiu", "sp,sp,-472"), ins("addiu", "a0,sp,124"), ins("addiu", "s0,sp,188")];
  const r = layoutReport({ targetStream: target, candidateStream: candidate });
  assert.equal(r.comparison.shape, "uniform-shift");
  assert.equal(r.comparison.moved.length, 2);
  assert.ok(r.comparison.moved.every((m) => m.delta === 4));
  assert.match(r.comparison.why, /object type\/alignment/);
  assert.match(r.comparison.why, /Offsets alone do not identify the cause/);
});

test("one misplaced home among correct neighbours is NOT called a uniform shift", () => {
  const target = [ins("addiu", "sp,sp,-472"), ins("sw", "t0,0x20(sp)"), ins("sw", "t1,0x30(sp)"), ins("sw", "t2,0x40(sp)")];
  const candidate = [ins("addiu", "sp,sp,-472"), ins("sw", "t0,0x20(sp)"), ins("sw", "t1,0x34(sp)"), ins("sw", "t2,0x40(sp)")];
  const r = layoutReport({ targetStream: target, candidateStream: candidate });
  assert.equal(r.comparison.shape, "isolated-misplacement");
  assert.match(r.comparison.why, /declaration ORDER or alignment/);
});

test("a frame that differs with every home in place is named as such", () => {
  const target = [ins("addiu", "sp,sp,-472"), ins("sw", "t0,0x20(sp)")];
  const candidate = [ins("addiu", "sp,sp,-480"), ins("sw", "t0,0x20(sp)")];
  const r = layoutReport({ targetStream: target, candidateStream: candidate });
  assert.equal(r.comparison.shape, "frame-size-only");
  assert.equal(r.comparison.frame.delta, 8);
  assert.match(r.comparison.why, /nothing loads or stores/);
});

test("the guidance refuses padding as a fix", () => {
  const r = layoutReport({ targetStream: [ins("addiu", "sp,sp,-8")], candidateStream: [ins("addiu", "sp,sp,-16")] });
  assert.match(r.comparison.guidance, /Never add padding or a dummy local/i);
  assert.match(r.policy, /never presented as a proven home/i,
    "an inferred slot must not be presented as a proven variable home");
});

test("an address inside a known symbol resolves to that symbol plus an offset", () => {
  const syms = new Map([["D_801C2C70", { va: 0x801C2C70, size: 2728 }]]);
  const r = resolveAddress(syms, 0x801C2CB4);
  assert.equal(r.resolved, true);
  assert.equal(r.expression, "D_801C2C70 + 0x44");
  assert.match(r.guidance, /Prefer an existing member/i,
    "proposing a new symbol for bytes that already have one is how one object becomes two types");
});

test("an alias spelling never wins over a name that compiles", () => {
  // A linker map carries `D_X.NON_MATCHING` beside the real `D_X` at the same
  // address. Handing back the alias yields an expression that does not compile.
  const syms = new Map([
    ["D_801C2C70.NON_MATCHING", { va: 0x801C2C70, size: 2728 }],
    ["D_801C2C70", { va: 0x801C2C70, size: 2728 }],
  ]);
  assert.equal(resolveAddress(syms, 0x801C2C70).symbol, "D_801C2C70");
});

test("an address in no known symbol is unresolved, not guessed", () => {
  const r = resolveAddress(new Map([["D_A", { va: 0x80000000, size: 4 }]]), 0x90000000);
  assert.equal(r.resolved, false);
  assert.match(r.why, /no known symbol/);
});
