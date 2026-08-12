// A human resizing the window must NEVER change the cart's declared frame size.
//
// This is the bug that took the longest to find, because every isolated
// reproduction of it passed. stepFrames clamped status.fbWidth/fbHeight to
// gl.drawingBufferWidth/Height every frame. Once resizeGlSurface made those
// follow the window, dragging a 1920x1080 cart into a 492-wide window rewrote
// the CART's declared size to 492 -- permanently, since Math.min only ever
// shrinks.
//
// The visible result was not an obviously broken frame: displayAspect became
// 0.455, so the letterbox TARGET was portrait, and the letterbox then did its
// job perfectly against a corrupted target. The game rendered stretched while
// every geometry assertion still passed. That is why the checks that existed
// (extent, parity, letterbox arithmetic) all stayed green.
//
// The sequence that exposes it is RESIZE **THEN STEP**. A test that resizes
// and measures, or steps and measures, sees nothing.
//
// !! FIXTURE LIMITATION -- READ BEFORE TRUSTING THESE !!
// These tests PASS against the broken build too, so today they are guards,
// not proof. The old code was `Math.min(cartSize, contextSize)`, and
// glcart.wasc is 64x64: min(64, anything) is 64, so the clamp can never bite.
// Only a cart LARGER than the window reproduces it -- verified by hand:
//     fixture   cart   64x64  ctx 492x1397 -> old clamp gives   64x64  (no change)
//     eightball cart 1920x1080 ctx 492x1397 -> old clamp gives 492x1080 (CORRUPTS)
// A fixture that renders ABOVE the window size would make these real. Until
// then the 1080p cart in ~/code/cliemu/games-for-dad/eightball is the only
// thing that actually exercises this.

import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { WasmcartHost } from "../src/host/WasmcartHost.js";

// SKIP-GUARDED like wasmcart-gl.test.js: these need a real GL context, and CI
// runners have no GPU. A missing GL stack is a by-design degradation (the host
// throws a clear "requires headless GL" error), not a regression these tests
// are meant to catch -- so skip rather than fail there.
import { glStackAvailable } from "romdev-core-host/glOptionalDep.js";
let _glReady = true;
try { await import("webgl-node"); } catch { _glReady = false; }
if (_glReady) _glReady = await glStackAvailable();
const GUARD = _glReady ? {} : { skip: "no usable GL stack here (headless CI) — GL carts cannot load" };


const HERE = path.dirname(fileURLToPath(import.meta.url));
const GLCART = path.join(HERE, "fixtures", "glcart.wasc");

test("resizing the surface then stepping does not change the cart's size", GUARD, async () => {
  const h = new WasmcartHost();
  await h.loadMedia({ platform: "wasmcart", path: GLCART, presentWindow: true });
  try {
    h.stepFrames(2);
    const w0 = h.status.fbWidth, h0 = h.status.fbHeight, a0 = h.status.displayAspect;
    assert.ok(w0 > 0 && h0 > 0, "sanity: cart reports a size");

    // The exact live sequence: the window shrinks, then the loop keeps
    // stepping. THIS ordering is what corrupted the declared size.
    h.resizeGlSurface(492, 1397);
    h.stepFrames(5);

    assert.equal(h.status.fbWidth, w0,
      `fbWidth must not follow the window (was ${w0}, now ${h.status.fbWidth})`);
    assert.equal(h.status.fbHeight, h0, "fbHeight must not follow the window");
    assert.equal(h.status.displayAspect, a0,
      `displayAspect must not follow the window (was ${a0}, now ${h.status.displayAspect})`);
  } finally { h.destroy(); }
});

test("repeated resizes never erode the cart's size", GUARD, async () => {
  // Math.min only shrinks, so the original bug was cumulative and
  // unrecoverable: every narrower window ratcheted the declared size down and
  // nothing ever restored it. Drag through a range and back.
  const h = new WasmcartHost();
  await h.loadMedia({ platform: "wasmcart", path: GLCART, presentWindow: true });
  try {
    h.stepFrames(2);
    const w0 = h.status.fbWidth, h0 = h.status.fbHeight;

    for (const [w, ht] of [[960, 540], [492, 1397], [3840, 2160], [320, 200], [1920, 1080]]) {
      h.resizeGlSurface(w, ht);
      h.stepFrames(3);
      assert.equal(h.status.fbWidth, w0, `fbWidth eroded after resizing to ${w}x${ht}`);
      assert.equal(h.status.fbHeight, h0, `fbHeight eroded after resizing to ${w}x${ht}`);
    }
  } finally { h.destroy(); }
});

test("displayAspect stays the CART's aspect, which is what letterboxing targets", GUARD, async () => {
  // The corrupted value fed the letterbox target, so the picture was fitted
  // to a portrait aspect and looked stretched while all the geometry checks
  // still passed. Pin the aspect specifically, not just the dimensions.
  const h = new WasmcartHost();
  await h.loadMedia({ platform: "wasmcart", path: GLCART, presentWindow: true });
  try {
    h.stepFrames(2);
    const want = h.status.fbWidth / h.status.fbHeight;
    h.resizeGlSurface(400, 1200);   // extreme portrait
    h.stepFrames(5);
    assert.ok(Math.abs(h.status.displayAspect - want) < 0.001,
      `displayAspect ${h.status.displayAspect} must stay the cart's ${want}`);
  } finally { h.destroy(); }
});
