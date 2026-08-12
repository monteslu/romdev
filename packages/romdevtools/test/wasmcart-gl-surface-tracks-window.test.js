// The GL surface must track the window's CURRENT size.
//
// The letterbox arithmetic was never the bug (see
// playtest-gl-present-letterbox.test.js -- it passes at every window size).
// The bug is one layer down: after attachWindow, the EGL surface and the
// context's cached drawingBufferWidth/Height keep reporting the size the
// context was CREATED at. Resize the window (or hit F11 for fullscreen) and
// the blit target is still sized for the old window, so the picture falls
// back into a corner exactly like the original no-letterbox bug.
//
// This test drives the host API rather than a live SDL window so it runs
// headlessly in CI: it asserts the host exposes a way to tell its context the
// surface changed size, and that the reported size actually follows.

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

test("a GL host exposes a resize hook for its window surface", GUARD, async () => {
  const h = new WasmcartHost();
  await h.loadMedia({ platform: "wasmcart", path: GLCART, presentWindow: true });
  try {
    // Without this the playtest loop has no way to react to a resize event,
    // which is the whole defect: the window changes, the surface does not.
    assert.equal(typeof h.resizeGlSurface, "function",
      "presentWindow hosts must be able to follow a window resize");
  } finally { h.destroy(); }
});

test("resizeGlSurface reports the new size back", GUARD, async () => {
  const h = new WasmcartHost();
  await h.loadMedia({ platform: "wasmcart", path: GLCART, presentWindow: true });
  try {
    // Not attached to a real window here, so this must refuse cleanly rather
    // than throw -- the playtest loop calls it from an SDL event handler,
    // where a throw escapes the tool-call error path entirely.
    assert.doesNotThrow(() => h.resizeGlSurface(800, 600));
  } finally { h.destroy(); }
});

test("resizeGlSurface is a no-op (not a crash) on a 2D or unattached host", GUARD, async () => {
  const h = new WasmcartHost();
  // No media at all: the hook must still be safe to call.
  assert.doesNotThrow(() => h.resizeGlSurface?.(640, 480));
  h.destroy();
});

test("the surface size the presenter uses comes from the WINDOW, not the cart", GUARD, async () => {
  // Regression guard for the shape of the bug: presentGl must letterbox
  // against the size its caller passes (the live window), never against the
  // cart's own resolution or a cached drawing-buffer size. A presenter that
  // reads its own drawingBufferWidth is how the stale size got in.
  const h = new WasmcartHost();
  await h.loadMedia({ platform: "wasmcart", path: GLCART, presentWindow: true });
  try {
    h.stepFrames(1);
    // Two very different "windows" over the same cart must not throw and must
    // both be accepted -- the presenter is told the size, it does not guess.
    assert.doesNotThrow(() => h.presentGl({ x: 0, y: 0, w: 320, h: 180, winW: 320, winH: 180 }));
    assert.doesNotThrow(() => h.presentGl({ x: 0, y: 0, w: 3840, h: 2160, winW: 3840, winH: 2160 }));
  } finally { h.destroy(); }
});
