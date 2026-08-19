// The playtest window forwards the scroll wheel to the cart.
//
// 0.118.0 taught `input({op:'wheel'})` to reach a cart, which fixed the
// HEADLESS path — but it never touched playtest.js, so the window itself
// still dropped every platform wheel event on the floor. A cart whose only
// mouse zoom is the wheel was therefore driveable by an agent and NOT by the
// human holding the mouse, which reads as a broken game rather than a
// missing handler. (Found on a cart where the pad shoulders stepped the zoom
// correctly and the wheel did nothing at all.)
//
// Two-finger trackpad scroll and macOS pinch both arrive as wheel events
// (pinch is ctrl+wheel), so this one handler is also the only route those
// gestures have into a cart.
//
// The window cannot be opened headlessly, so what is tested here is the pure
// unit/sign conversion the handler delegates to. The handler itself is three
// lines around this call: guard, convert, forward.

import { test } from "node:test";
import assert from "node:assert/strict";

import { wheelEventToCartDelta } from "../src/playtest/playtest.js";

test("one detented notch becomes one WHEEL_DELTA unit", () => {
  // node-sdl reports notches; wasmcart wants 1/120 of one. Positive is UP.
  assert.deepEqual(wheelEventToCartDelta({ dx: 0, dy: 1 }), { dx: 0, dy: 120 });
  assert.deepEqual(wheelEventToCartDelta({ dx: 0, dy: -1 }), { dx: 0, dy: -120 });
});

test("several notches scale linearly", () => {
  assert.equal(wheelEventToCartDelta({ dy: 3 }).dy, 360);
  assert.equal(wheelEventToCartDelta({ dy: -5 }).dy, -600);
});

test("a trackpad fraction survives instead of truncating to nothing", () => {
  // THE control for the rounding rule: a slow two-finger drag is a run of
  // small fractions. Truncated, the smallest of them are zero and the
  // gesture silently does nothing — indistinguishable from no handler.
  //
  // The values here are chosen to DISCRIMINATE. 0.25 and 0.1 do not: they
  // land on 30 and 12 exactly, so trunc and round agree and a sabotaged
  // build passes (verified — the first version of this test did exactly
  // that). A delta whose *120 has a fractional part is the only thing that
  // tells the two apart.
  // 0.006 * 120 = 0.72 -> rounds to 1, truncates to 0.
  assert.equal(wheelEventToCartDelta({ dy: 0.006 }).dy, 1,
    "a nudge smaller than one unit must round UP, not vanish");
  // 0.0125 * 120 = 1.5 -> rounds to 2, truncates to 1.
  assert.equal(wheelEventToCartDelta({ dy: 0.0125 }).dy, 2);
  // ...and the ordinary fractions still convert cleanly.
  assert.equal(wheelEventToCartDelta({ dy: 0.25 }).dy, 30);
  assert.equal(wheelEventToCartDelta({ dy: 0.1 }).dy, 12);
});

test("natural scrolling (SDL_MOUSEWHEEL_FLIPPED) inverts BOTH axes", () => {
  // The sign convention is the part most likely to ship backwards, and it is
  // invisible to anyone whose box does not have natural scrolling on.
  assert.deepEqual(wheelEventToCartDelta({ dx: 2, dy: 3, flipped: true }),
                   { dx: -240, dy: -360 });
  assert.deepEqual(wheelEventToCartDelta({ dx: 2, dy: 3, flipped: false }),
                   { dx: 240, dy: 360 });
});

test("horizontal tilt wheels are carried through", () => {
  assert.equal(wheelEventToCartDelta({ dx: 2, dy: 0 }).dx, 240);
});

test("a zero event converts to zero, so the handler can skip it", () => {
  // The handler returns early on {0,0}: a cart must not be handed a wheel
  // write for a frame in which nothing scrolled.
  assert.deepEqual(wheelEventToCartDelta({ dx: 0, dy: 0 }), { dx: 0, dy: 0 });
  assert.deepEqual(wheelEventToCartDelta({}), { dx: 0, dy: 0 });
});
