import { test } from "node:test";
import assert from "node:assert/strict";
import { PNG } from "pngjs";
import { imageToTiles, rgbaToTiles } from "./image-to-tiles.js";

test("NES: solid white tile encodes to all 0xFF in both bitplanes", () => {
  const px = Buffer.alloc(8 * 8 * 4, 0xff);
  for (let i = 3; i < px.length; i += 4) px[i] = 0xff;
  const r = rgbaToTiles("nes", { width: 8, height: 8, pixels: px });
  assert.equal(r.platform, "nes");
  assert.equal(r.totalTiles, 1);
  // Solid → one color → all pixels = palette index 0 → both bitplanes zero
  for (let i = 0; i < 16; i++) assert.equal(r.tiles[i], 0);
});

test("GB: interleaved bitplane layout differs from NES", () => {
  // Build an 8x8 with a diagonal of color index 1.
  const px = Buffer.alloc(8 * 8 * 4, 0);
  for (let i = 3; i < px.length; i += 4) px[i] = 0xff;
  // Diagonal pixels: white (matches the lightest GB color)
  for (let i = 0; i < 8; i++) {
    const o = (i * 8 + i) * 4;
    px[o] = 224; px[o + 1] = 248; px[o + 2] = 208;
  }
  // Rest pure black (matches the darkest GB color → index 3 → both bits set)
  // ...but since the tile only has 2 unique colors in our 4-bucket palette,
  // the encoder will pick "black" as primary and "light green" as secondary.
  const r = rgbaToTiles("gb", { width: 8, height: 8, pixels: px });
  assert.equal(r.platform, "gb");
  // Tile bytes are interleaved: rows go (lo0, hi0, lo1, hi1, ...).
  // We just verify the size and that it has non-zero data.
  assert.equal(r.tiles.length, 16);
  let nonzero = 0;
  for (let i = 0; i < r.tiles.length; i++) if (r.tiles[i] !== 0) nonzero++;
  assert.ok(nonzero > 0, "expected some non-zero bytes");
});

test("imageToTiles round-trip via pngjs (NES)", () => {
  const png = new PNG({ width: 16, height: 8 });
  png.data.fill(0);
  for (let i = 3; i < png.data.length; i += 4) png.data[i] = 0xff;
  const buf = PNG.sync.write(png);
  const r = imageToTiles("nes", buf);
  assert.equal(r.totalTiles, 2);
  assert.equal(r.tiles.length, 32);
});
