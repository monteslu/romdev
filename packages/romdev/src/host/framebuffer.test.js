// Unit test for framebuffer.js — XRGB8888 / RGB565 / 0RGB1555 → PNG.
//
// Run: npm test  (or: node --test src/host/framebuffer.test.js)

import { test } from "node:test";
import assert from "node:assert/strict";
import { PNG } from "pngjs";
import { framebufferToPng } from "./framebuffer.js";
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
