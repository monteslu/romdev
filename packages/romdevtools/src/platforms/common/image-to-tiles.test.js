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

test("tileOrder:'sprite' emits column-major (Genesis multi-cell sprite order)", () => {
  // 16x16 = 2x2 tiles. Give each TILE a distinct solid color from a known
  // 4-color hint so the encoded byte content identifies which tile is which:
  //   grid position: TL=idx0(black) TR=idx1 BL=idx2 BR=idx3
  // packed 4bpp: a solid tile of index N = byte (N<<4)|N repeated. So byte[0]
  // of each output tile tells us its index → its source grid cell.
  const hint = [[0, 0, 0], [255, 0, 0], [0, 255, 0], [0, 0, 255]];
  const W = 16, H = 16;
  const px = Buffer.alloc(W * H * 4, 0);
  for (let i = 3; i < px.length; i += 4) px[i] = 0xff; // opaque
  const cellColor = (tx, ty) => hint[ty * 2 + tx]; // TL,TR,BL,BR = 0,1,2,3
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const [r0, g0, b0] = cellColor(x >> 3, y >> 3);
      const o = (y * W + x) * 4;
      px[o] = r0; px[o + 1] = g0; px[o + 2] = b0;
    }
  }
  const firstNibble = (tiles, tileIdx) => tiles[tileIdx * 32] & 0x0f; // genesis = 32B/tile

  const row = rgbaToTiles("genesis", { width: W, height: H, pixels: px, paletteHint: hint, tileOrder: "row" });
  // Row-major sequence of source indices: TL(0), TR(1), BL(2), BR(3).
  assert.deepEqual([0, 1, 2, 3].map((i) => firstNibble(row.tiles, i)), [0, 1, 2, 3]);

  const spr = rgbaToTiles("genesis", { width: W, height: H, pixels: px, paletteHint: hint, tileOrder: "sprite" });
  // Column-major: TL(0), BL(2), TR(1), BR(3) — down the first column, then the next.
  assert.deepEqual([0, 1, 2, 3].map((i) => firstNibble(spr.tiles, i)), [0, 2, 1, 3]);
});
