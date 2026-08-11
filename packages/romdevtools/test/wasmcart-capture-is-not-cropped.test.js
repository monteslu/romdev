// A capture must be the WHOLE cart frame, at the cart's own resolution,
// whether or not the host is on the GL-direct present path.
//
// The bug this pins: _readbackGl clamped its read region to
// gl.drawingBufferWidth/Height -- the CONTEXT's size, i.e. the window's. Once
// the cart started rendering into a cart-sized redirect FBO, clamping to a
// smaller window read a window-sized SUB-RECT of it, so captures came back
// cropped on the left and scaled up, and the crop MOVED when the window
// resized (measured by the MCP client agent: content starting at x=635 with a
// window open, x=383 with it closed, x=0 on a plain load).
//
// Note how it evaded the checks already in place: the frame was not black, it
// had thousands of green pixels, and status still reported the right
// fbWidth/fbHeight. A "non-black" or "has some green" assertion passes on ALL
// of the broken cases. So these tests assert on EXTENT -- content must reach
// both edges -- and on pixel-for-pixel parity between the two paths.

import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { WasmcartHost } from "../src/host/WasmcartHost.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GLCART = path.join(HERE, "fixtures", "glcart.wasc");

/** Leftmost / rightmost / topmost / bottommost non-black column+row. */
function extent(fb) {
  const { width: w, height: h, pixels: p } = fb;
  let minX = w, maxX = -1, minY = h, maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (p[i] || p[i + 1] || p[i + 2]) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return { minX, maxX, minY, maxY };
}

test("a GL cart's capture spans the FULL frame, not a window-sized sub-rect", async () => {
  const h = new WasmcartHost();
  await h.loadMedia({ platform: "wasmcart", path: GLCART, presentWindow: true });
  try {
    h.stepFrames(3);
    const fb = h.getFramebuffer();
    const e = extent(fb);
    // The fixture fills its whole frame, so content must touch every edge.
    // A cropped read shows up as minX > 0 (content pushed right) — exactly
    // the x=383 / x=635 the client measured.
    assert.equal(e.minX, 0, `content must reach the left edge (got x=${e.minX})`);
    assert.equal(e.maxX, fb.width - 1, `content must reach the right edge (got x=${e.maxX})`);
    assert.equal(e.minY, 0, `content must reach the top edge (got y=${e.minY})`);
    assert.equal(e.maxY, fb.height - 1, `content must reach the bottom edge (got y=${e.maxY})`);
  } finally { h.destroy(); }
});

test("presentWindow and plain loads capture pixel-for-pixel the same frame", async () => {
  // The strongest form: the fast path must not change what a capture returns.
  // Run it on the SAME cart at the same frame count and compare bytes.
  const plain = new WasmcartHost();
  const direct = new WasmcartHost();
  try {
    await plain.loadMedia({ platform: "wasmcart", path: GLCART });
    await direct.loadMedia({ platform: "wasmcart", path: GLCART, presentWindow: true });

    plain.stepFrames(3);
    direct.stepFrames(3);

    const a = plain.getFramebuffer();
    const b = direct.getFramebuffer();

    assert.equal(b.width, a.width, "same width on both paths");
    assert.equal(b.height, a.height, "same height on both paths");

    let diff = 0;
    for (let i = 0; i < a.pixels.length; i++) if (a.pixels[i] !== b.pixels[i]) diff++;
    assert.equal(diff, 0, `${diff} bytes differ between the readback and GL-direct paths`);
  } finally { plain.destroy(); direct.destroy(); }
});

test("the capture keeps the CART's size, not the context's", async () => {
  const h = new WasmcartHost();
  await h.loadMedia({ platform: "wasmcart", path: GLCART, presentWindow: true });
  try {
    h.stepFrames(2);
    const fb = h.getFramebuffer();
    // status is the contract every consumer reads; the pixels must agree with
    // it. (During the bug status was RIGHT while the pixels were wrong, which
    // is what made it silent.)
    assert.equal(fb.width, h.status.fbWidth, "capture width matches reported fbWidth");
    assert.equal(fb.height, h.status.fbHeight, "capture height matches reported fbHeight");
    assert.equal(fb.pixels.length, fb.width * fb.height * 4, "buffer is exactly one full frame");
  } finally { h.destroy(); }
});

test("repeated captures are stable (no drift as the surface changes)", async () => {
  const h = new WasmcartHost();
  await h.loadMedia({ platform: "wasmcart", path: GLCART, presentWindow: true });
  try {
    h.stepFrames(2);
    const first = extent(h.getFramebuffer());
    // Tell the context the surface resized, as a window drag/F11 would.
    h.resizeGlSurface?.(640, 360);
    h.stepFrames(2);
    const after = extent(h.getFramebuffer());
    assert.deepEqual(after, first,
      "a surface resize must not move or crop what a capture returns");
  } finally { h.destroy(); }
});
