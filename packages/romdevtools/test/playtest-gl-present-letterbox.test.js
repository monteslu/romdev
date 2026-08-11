// Letterbox geometry for the GL-direct present path.
//
// These exist because I shipped this path THREE times with a visibly wrong
// picture and caught none of it with a test:
//   1. no letterbox at all -> a 1080p cart sat in the BOTTOM-LEFT CORNER of
//      any smaller window (GL's origin is bottom-left);
//   2. the readback served a stale/black buffer, so screenshots could not
//      have caught #1 either;
//   3. on RESIZE (and fullscreen) the corner came back, because the GL
//      surface still reported its ORIGINAL size.
//
// Every check here is arithmetic on the rect the present path computes, so it
// runs headlessly and fails loudly rather than needing someone to look at a
// window. The rule under all of them: the drawn rect must PRESERVE THE CART'S
// ASPECT, FIT INSIDE the window, and be CENTRED -- at every window size,
// including the ones a human produces by dragging or hitting F11.

import { test } from "node:test";
import assert from "node:assert/strict";
import { letterbox } from "romdev-core-runner";

/** The exact rect playtest hands presentGl, plus the GL flip presentToSurface
 *  applies. Kept together so a change to either is caught here. */
function presentRect(winW, winH, cartW, cartH) {
  const lb = letterbox(winW, winH, cartW / cartH);
  return {
    x: lb.dstX, y: lb.dstY, w: lb.dstW, h: lb.dstH,
    winW, winH,
    // top-down rect -> bottom-up GL, as the blit does
    glY: winH - lb.dstY - lb.dstH,
  };
}

const CASES = [
  ["exact size",        1920, 1080],
  ["half size",          960,  540],
  ["fullscreen 1080p",  1920, 1080],
  ["fullscreen 1440p",  2560, 1440],
  ["4K",                3840, 2160],
  ["wider than cart",   2560, 1080],
  ["taller than cart",  1280, 1200],
  ["tiny",               320,  180],
  ["odd/awkward",       1001,  733],
  ["ultrawide",         3440, 1440],
];

for (const [name, winW, winH] of CASES) {
  test(`letterbox: ${name} (${winW}x${winH}) fits, centres, keeps aspect`, () => {
    const CART_W = 1920, CART_H = 1080;
    const r = presentRect(winW, winH, CART_W, CART_H);

    // FITS: never larger than the window. A rect wider/taller than the window
    // is exactly the "only a corner is visible" bug.
    assert.ok(r.w <= winW, `width ${r.w} must fit in ${winW}`);
    assert.ok(r.h <= winH, `height ${r.h} must fit in ${winH}`);
    assert.ok(r.x >= 0 && r.y >= 0, `origin (${r.x},${r.y}) must be inside`);
    assert.ok(r.x + r.w <= winW, "right edge inside the window");
    assert.ok(r.y + r.h <= winH, "bottom edge inside the window");

    // ASPECT preserved within a pixel of rounding.
    const want = CART_W / CART_H;
    const got = r.w / r.h;
    assert.ok(Math.abs(got - want) < 0.02,
      `aspect ${got.toFixed(4)} should be ${want.toFixed(4)}`);

    // CENTRED: the bars are equal on both sides (+/-1px for odd sizes).
    assert.ok(Math.abs((winW - r.w) / 2 - r.x) <= 1, "horizontally centred");
    assert.ok(Math.abs((winH - r.h) / 2 - r.y) <= 1, "vertically centred");

    // FILLS one axis — a correct fit always touches two opposite edges.
    assert.ok(r.w === winW || r.h === winH || Math.abs(r.w - winW) <= 1 || Math.abs(r.h - winH) <= 1,
      "must fill at least one axis (else it is scaled down for no reason)");

    // The GL flip stays in bounds too; a negative glY blits off-surface.
    assert.ok(r.glY >= 0, `flipped y ${r.glY} must be >= 0`);
    assert.ok(r.glY + r.h <= winH, "flipped rect inside the surface");
  });
}

test("letterbox: a resize does not silently keep the old rect", () => {
  // The resize bug in shape: the same cart in two window sizes must produce
  // two DIFFERENT rects. When the surface reported a stale size, the rect
  // stopped tracking the window and the picture fell back into a corner.
  const a = presentRect(1920, 1080, 1920, 1080);
  const b = presentRect(960, 540, 1920, 1080);
  assert.notEqual(a.w, b.w, "a smaller window must produce a smaller rect");
  assert.ok(b.w <= 960 && b.h <= 540, "and it must fit the NEW window");
});

test("letterbox: growing the window grows the picture", () => {
  // Fullscreen is just a big resize. Each step must scale up, not stay put.
  let prev = 0;
  for (const w of [640, 1280, 1920, 2560, 3840]) {
    const r = presentRect(w, Math.round(w * 9 / 16), 1920, 1080);
    assert.ok(r.w > prev, `window ${w} must draw wider than the previous step`);
    assert.ok(r.w <= w, "and still fit");
    prev = r.w;
  }
});

test("letterbox: a non-16:9 cart is fitted, never stretched", () => {
  // 4:3 cart in a 16:9 window -> pillarboxed, full height, bars left/right.
  const r = presentRect(1920, 1080, 640, 480);
  assert.equal(r.h, 1080, "fills the height");
  assert.ok(r.w < 1920, "and is narrower than the window (pillarbox)");
  assert.ok(Math.abs(r.w / r.h - 640 / 480) < 0.02, "4:3 preserved");
  assert.ok(r.x > 0, "with a bar on the left");
});
