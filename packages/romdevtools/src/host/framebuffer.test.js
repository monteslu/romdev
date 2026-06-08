// Unit test for framebuffer.js — XRGB8888 / RGB565 / 0RGB1555 → PNG.
//
// Run: npm test  (or: node --test src/host/framebuffer.test.js)

import { test } from "node:test";
import assert from "node:assert/strict";
import { PNG } from "pngjs";
import { framebufferToPng, resamplePng } from "./framebuffer.js";
import {
  RETRO_PIXEL_FORMAT_0RGB1555,
  RETRO_PIXEL_FORMAT_RGB565,
  RETRO_PIXEL_FORMAT_XRGB8888,
} from "./retroConstants.js";

function decode(buf) {
  return PNG.sync.read(buf);
}

test("XRGB8888: 2x1 framebuffer encodes red then green", () => {
  // bytes: [B, G, R, X] per pixel
  const src = new Uint8Array([
    0x00, 0x00, 0xff, 0x00, //  red
    0x00, 0xff, 0x00, 0x00, // green
  ]);
  const png = framebufferToPng(2, 1, src, 8, RETRO_PIXEL_FORMAT_XRGB8888);
  const img = decode(png);
  assert.equal(img.width, 2);
  assert.equal(img.height, 1);
  assert.equal(img.data[0], 0xff); // R
  assert.equal(img.data[1], 0x00); // G
  assert.equal(img.data[2], 0x00); // B
  assert.equal(img.data[3], 0xff); // A
  assert.equal(img.data[4], 0x00);
  assert.equal(img.data[5], 0xff);
  assert.equal(img.data[6], 0x00);
  assert.equal(img.data[7], 0xff);
});

test("RGB565: 1x1 pure red expands correctly", () => {
  // 5 bits R = 0x1f, 6 bits G = 0, 5 bits B = 0 → 0xF800
  const src = new Uint8Array([0x00, 0xf8]); // little-endian
  const png = framebufferToPng(1, 1, src, 2, RETRO_PIXEL_FORMAT_RGB565);
  const img = decode(png);
  assert.equal(img.data[0], 0xff);
  assert.equal(img.data[1], 0x00);
  assert.equal(img.data[2], 0x00);
  assert.equal(img.data[3], 0xff);
});

test("0RGB1555: 1x1 pure blue expands correctly", () => {
  // 5 R, 5 G, 5 B → blue = 0x001F
  const src = new Uint8Array([0x1f, 0x00]);
  const png = framebufferToPng(1, 1, src, 2, RETRO_PIXEL_FORMAT_0RGB1555);
  const img = decode(png);
  assert.equal(img.data[0], 0x00);
  assert.equal(img.data[1], 0x00);
  assert.equal(img.data[2], 0xff);
  assert.equal(img.data[3], 0xff);
});

test("XRGB8888 with pitch padding skips correctly", () => {
  // 1x2, but pitch=8 (4 bytes content + 4 bytes pad)
  // row 0: red, then 4 bytes garbage
  // row 1: green, then 4 bytes garbage
  const src = new Uint8Array([
    0x00, 0x00, 0xff, 0x00, 0xaa, 0xaa, 0xaa, 0xaa,
    0x00, 0xff, 0x00, 0x00, 0xbb, 0xbb, 0xbb, 0xbb,
  ]);
  const png = framebufferToPng(1, 2, src, 8, RETRO_PIXEL_FORMAT_XRGB8888);
  const img = decode(png);
  // pixel 0: red
  assert.equal(img.data[0], 0xff);
  assert.equal(img.data[1], 0x00);
  assert.equal(img.data[2], 0x00);
  // pixel 1: green
  assert.equal(img.data[4], 0x00);
  assert.equal(img.data[5], 0xff);
  assert.equal(img.data[6], 0x00);
});

// ── resamplePng: nearest-neighbor scaling, both directions ──────────────────

// A 2x2 PNG with four distinct corner colors, as base64 — the fixture for the
// resample tests. Top-left red, top-right green, bottom-left blue, bottom-right
// white. Returns { base64, png } so tests can assert against the source.
function checker2x2() {
  const png = new PNG({ width: 2, height: 2 });
  const px = [
    [0xff, 0x00, 0x00, 0xff], // (0,0) red
    [0x00, 0xff, 0x00, 0xff], // (1,0) green
    [0x00, 0x00, 0xff, 0xff], // (0,1) blue
    [0xff, 0xff, 0xff, 0xff], // (1,1) white
  ];
  for (let i = 0; i < 4; i++) {
    png.data[i * 4 + 0] = px[i][0];
    png.data[i * 4 + 1] = px[i][1];
    png.data[i * 4 + 2] = px[i][2];
    png.data[i * 4 + 3] = px[i][3];
  }
  return PNG.sync.write(png).toString("base64");
}

function pixelAt(img, x, y) {
  const i = (y * img.width + x) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]];
}

test("resamplePng: integer UP-scale (4x) multiplies dims and replicates pixels exactly", () => {
  const { base64, width, height } = resamplePng(checker2x2(), 4);
  assert.equal(width, 8);
  assert.equal(height, 8);
  const img = decode(Buffer.from(base64, "base64"));
  assert.equal(img.width, 8);
  assert.equal(img.height, 8);
  // Each source pixel becomes a solid 4x4 block (nearest-neighbor, no blending).
  // Sample the center of each block; colors must be byte-exact (crisp pixel art).
  assert.deepEqual(pixelAt(img, 1, 1), [0xff, 0x00, 0x00, 0xff], "TL block red");
  assert.deepEqual(pixelAt(img, 6, 1), [0x00, 0xff, 0x00, 0xff], "TR block green");
  assert.deepEqual(pixelAt(img, 1, 6), [0x00, 0x00, 0xff, 0xff], "BL block blue");
  assert.deepEqual(pixelAt(img, 6, 6), [0xff, 0xff, 0xff, 0xff], "BR block white");
  // The boundary between blocks is sharp: x=3 is still red, x=4 is green.
  assert.deepEqual(pixelAt(img, 3, 0), [0xff, 0x00, 0x00, 0xff]);
  assert.deepEqual(pixelAt(img, 4, 0), [0x00, 0xff, 0x00, 0xff]);
});

test("resamplePng: GB-size (160x144) up-scaled 4x gives 640x576", () => {
  const png = new PNG({ width: 160, height: 144 });
  png.data.fill(0x40); // arbitrary solid fill, alpha included
  const src = PNG.sync.write(png).toString("base64");
  const { width, height } = resamplePng(src, 4);
  assert.equal(width, 640);
  assert.equal(height, 576);
});

test("resamplePng: down-scale (0.5) halves dims and keeps nearest pixels", () => {
  // 4x4 of two horizontal bands: top two rows red, bottom two blue.
  const png = new PNG({ width: 4, height: 4 });
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 4; x++) {
      const i = (y * 4 + x) * 4;
      const red = y < 2;
      png.data[i + 0] = red ? 0xff : 0x00;
      png.data[i + 1] = 0x00;
      png.data[i + 2] = red ? 0x00 : 0xff;
      png.data[i + 3] = 0xff;
    }
  }
  const { base64, width, height } = resamplePng(PNG.sync.write(png).toString("base64"), 0.5);
  assert.equal(width, 2);
  assert.equal(height, 2);
  const img = decode(Buffer.from(base64, "base64"));
  // Nearest-neighbor (not averaged): top row sampled from a red source row,
  // bottom row from a blue source row — no purple blend.
  assert.deepEqual(pixelAt(img, 0, 0), [0xff, 0x00, 0x00, 0xff]);
  assert.deepEqual(pixelAt(img, 0, 1), [0x00, 0x00, 0xff, 0xff]);
});

test("resamplePng: never collapses to 0 dimensions on aggressive downscale", () => {
  const png = new PNG({ width: 2, height: 2 });
  png.data.fill(0xff);
  const { width, height } = resamplePng(PNG.sync.write(png).toString("base64"), 0.1);
  assert.ok(width >= 1 && height >= 1, "dims clamped to >= 1");
});
