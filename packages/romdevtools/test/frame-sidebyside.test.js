// frame({op:'sideBySide'}) — capture both hosts (slot A + the slot-B comparison
// host) into one composited PNG. Two layers of test:
//   1. PURE: compositeSideBySide / pixelSummary on synthetic framebuffers —
//      deterministic geometry + content checks, no core build needed.
//   2. WIRING: the secondary host slot (loadMedia slot:'b' equivalent) +
//      _liveHostCount across both slots + per-session teardown clears both.

import { test } from "node:test";
import assert from "node:assert/strict";
import { PNG } from "pngjs";

import { compositeSideBySide, pixelSummary } from "../src/mcp/tools/frame.js";
import {
  _setHostForTest, _setHostBForTest, getHostB, getHostBOrNull,
  resetHostB, clearHost, clearHostB, _liveHostCount,
} from "../src/mcp/state.js";

// Build a flat single-color RGBA framebuffer.
function solid(w, h, [r, g, b]) {
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = 0xFF;
  }
  return { width: w, height: h, rgba };
}

test("pixelSummary reports distinct/dominant for a flat frame", () => {
  const s = pixelSummary(10, 10, solid(10, 10, [0xFF, 0, 0]).rgba);
  assert.equal(s.distinctColors, 1);
  assert.equal(s.dominantColor, "#ff0000");
  assert.equal(s.dominantPct, 100);
});

test("compositeSideBySide places A left, B right, with a divider gap", () => {
  const a = solid(8, 8, [0xFF, 0, 0]);   // red, small
  const b = solid(16, 16, [0, 0, 0xFF]); // blue, twice the height
  const gap = 4;
  const { buffer, outW, outH, aScale, bScale } = compositeSideBySide(a, b, gap);

  // A (h=8) upscales x2 to reach B's height (16); B stays x1.
  assert.equal(aScale, 2);
  assert.equal(bScale, 1);
  const aW = 8 * 2, bW = 16 * 1;
  assert.equal(outW, aW + gap + bW);
  assert.equal(outH, 16);

  const img = PNG.sync.read(buffer);
  assert.equal(img.width, outW);
  assert.equal(img.height, outH);

  const px = (x, y) => {
    const o = (y * img.width + x) * 4;
    return [img.data[o], img.data[o + 1], img.data[o + 2]];
  };
  // Left pane center → red.
  assert.deepEqual(px(Math.floor(aW / 2), 8), [0xFF, 0, 0], "left pane is A (red)");
  // Right pane center → blue.
  assert.deepEqual(px(aW + gap + Math.floor(bW / 2), 8), [0, 0, 0xFF], "right pane is B (blue)");
  // Divider gap → the neutral 0x20 backdrop, neither pane's color.
  assert.deepEqual(px(aW + Math.floor(gap / 2), 8), [0x20, 0x20, 0x20], "divider is backdrop");
});

test("compositeSideBySide centers a shorter pane vertically (letterbox = backdrop)", () => {
  // A is shorter even after integer scaling (h=10 → x1 since 16/10 floors to 1),
  // so it should be vertically centered with backdrop above and below.
  const a = solid(8, 10, [0x00, 0xFF, 0x00]); // green, h=10, scales x1
  const b = solid(8, 16, [0xFF, 0xFF, 0xFF]); // white, h=16
  const { buffer, outH } = compositeSideBySide(a, b, 0);
  assert.equal(outH, 16);
  const img = PNG.sync.read(buffer);
  const at = (x, y) => { const o = (y * img.width + x) * 4; return [img.data[o], img.data[o + 1], img.data[o + 2]]; };
  // top row of the A column is backdrop (the 3px letterbox), middle is green.
  assert.deepEqual(at(4, 0), [0x20, 0x20, 0x20], "A column top is letterbox backdrop");
  assert.deepEqual(at(4, 8), [0x00, 0xFF, 0x00], "A column middle is green");
});

test("secondary host slot B: set/get/reset/clear + count both slots", () => {
  const KEY = "sbs-wiring";
  // Clean slate for this key.
  clearHost(KEY); clearHostB(KEY);
  const before = _liveHostCount();

  // Slot B empty → getHostBOrNull null, getHostB throws with guidance.
  assert.equal(getHostBOrNull(KEY), null);
  assert.throws(() => getHostB(KEY), /slot B/i);

  // Inject a fake into each slot; count rises by 2 (both maps counted).
  _setHostForTest(KEY, { status: { loaded: false } });
  _setHostBForTest(KEY, { status: { loaded: false } });
  assert.equal(_liveHostCount(), before + 2, "both slots counted");
  assert.ok(getHostBOrNull(KEY), "slot B now present");

  // resetHostB swaps in a fresh real host (still 1 in slot B).
  const fresh = resetHostB(KEY);
  assert.ok(fresh && fresh.status, "resetHostB returns a host");

  // clearHost tears down BOTH slots for the session.
  clearHost(KEY);
  assert.equal(getHostBOrNull(KEY), null, "clearHost also cleared slot B");
  assert.equal(_liveHostCount(), before, "back to baseline after teardown");
});
