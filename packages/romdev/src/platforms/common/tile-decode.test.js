import { test } from "node:test";
import assert from "node:assert/strict";
import { rgbaToTiles } from "./image-to-tiles.js";
import { decodeTile, tileToAscii, tileStats } from "./tile-decode.js";

test("NES round-trip: encode then decode recovers pixel indices", () => {
  // 8x8 with a diagonal stripe of index 1 (light), rest 0.
  const px = Buffer.alloc(8 * 8 * 4, 0);
  for (let i = 3; i < px.length; i += 4) px[i] = 0xff;
  // Diagonal pixels: bright color picked from NES palette
  for (let y = 0; y < 8; y++) {
    const o = (y * 8 + y) * 4;
    px[o] = 248; px[o + 1] = 248; px[o + 2] = 248;
  }
  const r = rgbaToTiles("nes", { width: 8, height: 8, pixels: px });
  const decoded = decodeTile("nes", r.tiles, 0);
  // Diagonal should be the "non-zero" color (the brightest tile-palette index).
  for (let y = 0; y < 8; y++) {
    assert.notEqual(decoded[y * 8 + y], 0, `diagonal pixel at (${y},${y}) should be set`);
  }
});

test("GB encode/decode round-trip works", () => {
  const px = Buffer.alloc(8 * 8 * 4, 0);
  for (let i = 3; i < px.length; i += 4) px[i] = 0xff;
  // Top half: lightest GB color
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 8; x++) {
      const o = (y * 8 + x) * 4;
      px[o] = 224; px[o + 1] = 248; px[o + 2] = 208;
    }
  }
  const r = rgbaToTiles("gb", { width: 8, height: 8, pixels: px });
  const decoded = decodeTile("gb", r.tiles, 0);
  // First 4 rows should all be the same non-default value; bottom 4 rows another.
  const topVal = decoded[0];
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 8; x++) {
      assert.equal(decoded[y * 8 + x], topVal, `top half row ${y} col ${x}`);
    }
  }
});

test("SNES 4bpp encode/decode", () => {
  // 8x8 single-color tile using a value in the 4bpp range.
  const px = Buffer.alloc(8 * 8 * 4, 100);
  for (let i = 3; i < px.length; i += 4) px[i] = 0xff;
  const r = rgbaToTiles("snes", { width: 8, height: 8, pixels: px });
  assert.equal(r.tiles.length, 32); // 4bpp × 64 pixels / 8 = 32
  const decoded = decodeTile("snes", r.tiles, 0);
  // Solid color → all same palette index → all zeros (palette index 0).
  for (const v of decoded) assert.equal(v, 0);
});

test("Genesis 4bpp packed encode/decode", () => {
  const px = Buffer.alloc(8 * 8 * 4, 0);
  for (let i = 3; i < px.length; i += 4) px[i] = 0xff;
  // Pixel (3,4) bright red
  const o = (4 * 8 + 3) * 4;
  px[o] = 255; px[o + 1] = 0; px[o + 2] = 0;
  const r = rgbaToTiles("genesis", { width: 8, height: 8, pixels: px });
  const decoded = decodeTile("genesis", r.tiles, 0);
  // The hot pixel should be non-zero, others zero.
  assert.notEqual(decoded[4 * 8 + 3], 0);
});

test("tileToAscii produces 8 lines of 8 chars", () => {
  const pixels = new Uint8Array(64);
  for (let i = 0; i < 64; i++) pixels[i] = i % 4;
  const ascii = tileToAscii(pixels, 4);
  const lines = ascii.split("\n");
  assert.equal(lines.length, 8);
  for (const l of lines) assert.equal(l.length, 8);
});

test("tileStats reports color histogram and hash", () => {
  const pixels = new Uint8Array(64);
  for (let i = 0; i < 64; i++) pixels[i] = i % 4;
  const stats = tileStats(pixels);
  assert.equal(stats.uniqueColors, 4);
  assert.equal(stats.histogram[0], 16);
  assert.match(stats.hash, /^[0-9a-f]{8}$/);
});
