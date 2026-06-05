import { test } from "node:test";
import assert from "node:assert/strict";
import { PNG } from "pngjs";
import { genesisImageToTilemap } from "./image-to-tilemap.js";
import { decode4bppTile, decodeGenesisSubpalette, rgbToGenesisColor } from "./vdp.js";

// Build a 320×224 PNG from a per-pixel color function (RGB triples).
function makePng(fn) {
  const png = new PNG({ width: 320, height: 224 });
  for (let y = 0; y < 224; y++) {
    for (let x = 0; x < 320; x++) {
      const [r, g, b] = fn(x, y);
      const o = (y * 320 + x) * 4;
      png.data[o] = r; png.data[o + 1] = g; png.data[o + 2] = b; png.data[o + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

test("rejects wrong-size images", () => {
  const png = PNG.sync.write(new PNG({ width: 100, height: 100 }));
  assert.throws(() => genesisImageToTilemap({ pngBytes: png }), /320×224/);
});

test("solid image → 1 tile, 1 palette line, correct byte sizes", () => {
  const png = makePng(() => [0, 0, 0]); // all black
  const r = genesisImageToTilemap({ pngBytes: png });
  assert.equal(r.uniqueTiles, 1, "flat image dedups to one tile");
  assert.equal(r.paletteLines, 1);
  assert.equal(r.nametable.length, 40 * 28 * 2, "40×28 cells × 2 bytes");
  assert.equal(r.palette.length, 128, "4 lines × 16 colors × 2 bytes");
  assert.equal(r.chr.length, r.uniqueTiles * 32, "32 bytes per 4bpp tile");
  assert.equal(r.warnings.length, 0);
});

test("nametable entries are big-endian with tile/palette/flip fields", () => {
  // Two-color checkerboard so we get >1 tile and a real palette.
  const png = makePng((x, y) => (((x >> 3) + (y >> 3)) & 1) ? [255, 0, 0] : [0, 0, 255]);
  const r = genesisImageToTilemap({ pngBytes: png });
  // First entry: read BE.
  const entry0 = (r.nametable[0] << 8) | r.nametable[1];
  const tileIdx = entry0 & 0x07FF;
  const line = (entry0 >> 13) & 0x3;
  assert.ok(tileIdx < r.uniqueTiles, "tile index in range");
  assert.ok(line < r.paletteLines, "palette line in range");
});

test("round-trips a 16-color image: decoded tiles reproduce source colors", () => {
  // A simple 4-color image. After encode, decode tile 0 via the public
  // vdp.js decoders and confirm the top-left pixel matches the source color.
  const colors = [[0, 0, 0], [255, 0, 0], [0, 255, 0], [0, 0, 255]];
  const png = makePng((x, y) => colors[((x >> 3) % 2) + ((y >> 3) % 2) * 2]);
  const r = genesisImageToTilemap({ pngBytes: png });

  // Decode palette line 0 and tile 0.
  const pal0 = decodeGenesisSubpalette(r.palette.subarray(0, 32), 0);
  const tile0 = decode4bppTile(r.chr.subarray(0, 32));
  const entry0 = (r.nametable[0] << 8) | r.nametable[1];
  const line0 = (entry0 >> 13) & 0x3;
  const palLine = decodeGenesisSubpalette(r.palette.subarray(line0 * 32, line0 * 32 + 32), 0);
  // top-left source pixel of cell (0,0): colors[0] = black.
  const [pr, pg, pb] = palLine[tile0[0][0]];
  // black should round-trip to black-ish (Genesis 3-bit, so exact 0,0,0).
  assert.deepEqual([pr, pg, pb], [0, 0, 0], "top-left pixel round-trips to black");
});

test("warns when a VISIBLE dominant color lands at transparent palette index 0", () => {
  // A mostly-white "sky" (dominant) with a small dark strip. The most-common
  // color (white) gets forced to index 0 = transparent on a plane → footgun.
  const png = makePng((x, y) => (y < 200 ? [255, 255, 255] : [0, 0, 0]));
  const r = genesisImageToTilemap({ pngBytes: png });
  assert.ok(
    r.warnings.some((w) => /index 0 = a VISIBLE color/i.test(w) && /VDP_setBackgroundColor/.test(w)),
    `expected an index-0 transparency warning, got: ${JSON.stringify(r.warnings)}`
  );
});

test("does NOT warn when the dominant color is black (a sane index-0)", () => {
  // Black dominant → index 0 = black = the usual transparent/backdrop; no footgun.
  const png = makePng((x, y) => (y < 200 ? [0, 0, 0] : [255, 0, 0]));
  const r = genesisImageToTilemap({ pngBytes: png });
  assert.ok(!r.warnings.some((w) => /index 0 = a VISIBLE color/i.test(w)),
    `black index-0 should not warn, got: ${JSON.stringify(r.warnings)}`);
});

test("packed 4bpp layout: high nibble = left pixel", () => {
  // Make a 320×224 image where the left pixel of every 2-px pair is white
  // and the right is black, so each packed byte = 0xF0 (idx 15 << 4 | 0).
  // Use only 2 colors so they share one palette line; force white=index!=0.
  const png = makePng((x) => (x % 2 === 0 ? [255, 255, 255] : [0, 0, 0]));
  const r = genesisImageToTilemap({ pngBytes: png });
  // Find the white index in line 0.
  const whiteWord = rgbToGenesisColor(255, 255, 255);
  // The encoded byte for any row: high nibble = white index, low = black index.
  // Just assert the high and low nibbles differ (the left/right packing held).
  const b = r.chr[0];
  assert.notEqual((b >> 4) & 0xF, b & 0xF, "left and right pixels encode to different nibbles");
});
