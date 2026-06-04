// The playtest window must ALWAYS preserve the chosen aspect ratio — resizing
// the window grows the letterbox/pillarbox bars, never stretches the image
// off-aspect. These test the pure letterbox() math (the render loop reads the
// window's live pixel size each frame and feeds it here).

import { test } from "node:test";
import assert from "node:assert/strict";
import { letterbox } from "../src/playtest/playtest.js";

const TV = 4 / 3;

test("letterbox keeps target aspect when the window is too WIDE (pillarbox)", () => {
  // 1600x600 window, want 4:3 → full height, narrower width, centered.
  const { dstX, dstY, dstW, dstH } = letterbox(1600, 600, TV);
  assert.equal(dstH, 600, "should use full height");
  assert.equal(dstW, 800, "width = height * 4/3");
  assert.equal(dstW / dstH, TV, "drawn rect must be exactly 4:3");
  assert.equal(dstX, 400, "centered horizontally");
  assert.equal(dstY, 0);
});

test("letterbox keeps target aspect when the window is too TALL (letterbox)", () => {
  const { dstX, dstY, dstW, dstH } = letterbox(800, 900, TV);
  assert.equal(dstW, 800, "should use full width");
  assert.equal(dstH, 600, "height = width / (4/3)");
  assert.equal(Math.round((dstW / dstH) * 1000) / 1000, Math.round(TV * 1000) / 1000);
  assert.equal(dstY, 150, "centered vertically");
  assert.equal(dstX, 0);
});

test("aspect holds across a stretch — drawn ratio is identical at two window sizes", () => {
  const a = letterbox(640, 480, TV);
  const b = letterbox(1920, 700, TV); // user dragged the window much wider
  const ratioA = a.dstW / a.dstH;
  const ratioB = b.dstW / b.dstH;
  assert.ok(Math.abs(ratioA - ratioB) < 0.005,
    `drawn aspect must stay constant on resize (got ${ratioA} vs ${ratioB})`);
});

test("exact-fit window draws edge to edge (no bars)", () => {
  const { dstX, dstY, dstW, dstH } = letterbox(800, 600, TV);
  assert.deepEqual({ dstX, dstY, dstW, dstH }, { dstX: 0, dstY: 0, dstW: 800, dstH: 600 });
});

test("non-4:3 targets (handheld native aspects) are honored too", () => {
  const gba = 3 / 2;
  const r = letterbox(1000, 1000, gba);
  // Integer-pixel rounding means the ratio is within ~1px, not bit-exact.
  assert.ok(Math.abs(r.dstW / r.dstH - gba) < 0.01, `GBA 3:2 preserved (got ${r.dstW / r.dstH})`);
});
