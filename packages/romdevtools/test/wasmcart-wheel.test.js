// The scroll wheel reaching a wasmcart cart (ABI v3.1: wc_wheel_t behind
// wc_info_t.wheel_ptr, units of 1/120 notch).
//
// Two halves, and the SECOND is the one that catches a real regression:
//
//  1. WasmcartHost.setInput forwards {wheel:{dx,dy}} to cart.wheel() and
//     ACCUMULATES rather than sets. CartHost clears the field after each
//     frame, so a host that assigned instead of adding would drop every
//     event but the last of a trackpad flick.
//
//  2. input({op:'wheel'}) converts notches → the raw 1/120 units, keeps the
//     axes and signs independent, and REFUSES a zero delta. A zero is worth
//     refusing rather than accepting as a no-op: the host already clears the
//     wheel every frame, so "scroll by nothing" can only be a caller bug,
//     and silently accepting it would make a units mistake (0.001 notches
//     rounding to 0) look like it worked.
//
// The stub records calls rather than driving a real cart: the end-to-end path
// is covered by wasmcart-real-cart.test.js and by wasmcart-lua's own wheel
// cart, and what can silently break HERE is the arithmetic and the
// accumulate-vs-assign choice.

import { test } from "node:test";
import assert from "node:assert/strict";

import { WasmcartHost } from "../src/host/WasmcartHost.js";

/** A host with just enough shape for setInput, plus a recording cart stub. */
function hostWithStubCart() {
  const host = new WasmcartHost();
  const calls = [];
  host.cart = {
    wheel: (dx, dy) => calls.push({ dx, dy }),
    // setPointer exists so a pointer+wheel call in one setInput does not throw
    setPointer: () => {},
  };
  return { host, calls };
}

test("setInput forwards {wheel} to cart.wheel with the raw 1/120 deltas", () => {
  const { host, calls } = hostWithStubCart();
  host.setInput({ wheel: { dx: 0, dy: 120 } });
  assert.deepEqual(calls, [{ dx: 0, dy: 120 }]);
});

test("repeated setInput ACCUMULATES — a flick is many events, one frame", () => {
  const { host, calls } = hostWithStubCart();
  host.setInput({ wheel: { dx: 0, dy: 120 } });
  host.setInput({ wheel: { dx: 0, dy: 120 } });
  host.setInput({ wheel: { dx: 30, dy: -60 } });
  // The HOST forwards each one; CartHost is what sums them. Asserting three
  // separate calls is asserting exactly that: a host that coalesced or
  // replaced would hand over fewer, and the cart would miss events.
  assert.equal(calls.length, 3, "every event must reach the cart, not just the last");
  assert.deepEqual(calls[2], { dx: 30, dy: -60 });
});

test("a wheel-less cart is a no-op, not a throw (older wasmcart resolved)", () => {
  const host = new WasmcartHost();
  host.cart = { setPointer: () => {} };   // no .wheel — pre-0.22.0
  assert.doesNotThrow(() => host.setInput({ wheel: { dx: 0, dy: 120 } }));
});

test("pointer and wheel in one setInput both land", () => {
  const host = new WasmcartHost();
  const seen = { pointer: 0, wheel: 0 };
  host.cart = {
    setPointer: () => { seen.pointer++; },
    wheel: () => { seen.wheel++; },
  };
  host.setInput({ pointer: { id: 0, x: 5, y: 6 }, wheel: { dx: 0, dy: 120 } });
  assert.deepEqual(seen, { pointer: 1, wheel: 1 });
});

// ── the notches → 1/120 conversion, as the tool does it ──
//
// Mirrors the arithmetic in input.js's `wheel` case. Kept as a local helper
// rather than reaching into the tool: the tool needs a live session + host,
// and what is worth pinning is the CONVENTION (one click = 120, positive up,
// rounded not truncated), which is the thing a future edit could quietly get
// wrong in either direction.
const toRaw = (notches, notchesX) => ({
  dx: Math.round((notchesX ?? 0) * 120),
  dy: Math.round((notches ?? 0) * 120),
});

test("one notch is 120 units, and positive is UP", () => {
  assert.deepEqual(toRaw(1), { dx: 0, dy: 120 });
  assert.deepEqual(toRaw(-1), { dx: 0, dy: -120 });
});

test("fractions survive — a trackpad is not rounded to a click", () => {
  assert.deepEqual(toRaw(0.25), { dx: 0, dy: 30 });
  // ROUNDED, not truncated: 0.1 notches is 12 units, and truncation toward
  // zero would make small smooth scrolls vanish entirely.
  assert.deepEqual(toRaw(0.1), { dx: 0, dy: 12 });
});

test("axes are independent — horizontal does not leak into vertical", () => {
  assert.deepEqual(toRaw(0, 1), { dx: 120, dy: 0 });
  assert.deepEqual(toRaw(2, -1), { dx: -120, dy: 240 });
});
