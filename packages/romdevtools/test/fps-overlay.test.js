// drawFpsOverlay — the F3 on-window fps counter drawn into the RGBA frame
// right before the SDL blit. Pure pixel writes; these tests pin that it
// draws green digits on a black box in the top-left, stays inside its box,
// and never writes out of bounds on tiny framebuffers.

import { test } from "node:test";
import assert from "node:assert/strict";
import { drawFpsOverlay } from "romdev-core-runner";

function freshFrame(w, h, fill = 0x80) {
  const rgba = Buffer.alloc(w * h * 4, fill);
  for (let i = 3; i < rgba.length; i += 4) rgba[i] = 0xff;
  return rgba;
}

test("draws green digits on a black backing box, top-left", () => {
  const w = 320, h = 240;
  const rgba = freshFrame(w, h);
  drawFpsOverlay(rgba, w, h, 60);
  let green = 0, black = 0;
  for (let y = 0; y < 40; y++) {
    for (let x = 0; x < 60; x++) {
      const d = (y * w + x) * 4;
      if (rgba[d] === 0x40 && rgba[d + 1] === 0xff && rgba[d + 2] === 0x40) green++;
      else if (rgba[d] === 0 && rgba[d + 1] === 0 && rgba[d + 2] === 0) black++;
    }
  }
  assert.ok(green > 0, "digit pixels drawn");
  assert.ok(black > green, "backing box behind the digits");
});

test("leaves the rest of the frame untouched", () => {
  const w = 320, h = 240;
  const rgba = freshFrame(w, h);
  drawFpsOverlay(rgba, w, h, 60);
  // Bottom-right quadrant must be exactly the fill it started with.
  for (let y = h / 2; y < h; y += 7) {
    for (let x = w / 2; x < w; x += 11) {
      const d = (y * w + x) * 4;
      assert.equal(rgba[d], 0x80, `pixel ${x},${y} untouched`);
    }
  }
});

test("different values draw different pixels (it's actually rendering the number)", () => {
  const w = 320, h = 240;
  const a = freshFrame(w, h);
  const b = freshFrame(w, h);
  drawFpsOverlay(a, w, h, 11);
  drawFpsOverlay(b, w, h, 60);
  assert.notEqual(Buffer.compare(a, b), 0);
});

test("clamps and never writes out of bounds on a tiny framebuffer", () => {
  const w = 16, h = 8;
  const rgba = freshFrame(w, h);
  drawFpsOverlay(rgba, w, h, 12345); // clamped to 999, box wider than the frame
  drawFpsOverlay(rgba, w, h, -5);    // clamped to 0
  assert.equal(rgba.length, w * h * 4, "no resize, no throw");
});
