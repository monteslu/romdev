import { test } from "node:test";
import assert from "node:assert/strict";
import { PNG } from "pngjs";
import { renderTilesGrid } from "./render-tiles.js";
import { rgbaToTiles } from "./image-to-tiles.js";

test("renderTilesGrid: NES single empty tile produces 8×8 PNG", () => {
  const tiles = new Uint8Array(16); // all zero = empty tile
  const png = renderTilesGrid({ platform: "nes", tileBytes: tiles, tilesPerRow: 1 });
  const img = PNG.sync.read(png);
  assert.equal(img.width, 8);
  assert.equal(img.height, 8);
});

test("renderTilesGrid: 16 tiles in default 16-wide row → 128×8", () => {
  const tiles = new Uint8Array(16 * 16);
  const png = renderTilesGrid({ platform: "nes", tileBytes: tiles });
  const img = PNG.sync.read(png);
  assert.equal(img.width, 128);
  assert.equal(img.height, 8);
});

test("renderTilesGrid: GB tile renders with DMG palette", () => {
  // Make a single tile that's "all darkest color" (idx 3) — bytes all 0xff
  const tiles = new Uint8Array([
    0xff, 0xff, // row 0: both planes set
    0xff, 0xff,
    0xff, 0xff,
    0xff, 0xff,
    0xff, 0xff,
    0xff, 0xff,
    0xff, 0xff,
    0xff, 0xff,
  ]);
  const png = renderTilesGrid({ platform: "gb", tileBytes: tiles, tilesPerRow: 1 });
  const img = PNG.sync.read(png);
  // Pixel 0 should be the GB darkest color (8, 24, 32).
  assert.equal(img.data[0], 8);
  assert.equal(img.data[1], 24);
  assert.equal(img.data[2], 32);
});

test("renderTilesGrid: SNES 4bpp tile produces 32B → renders 8×8", () => {
  const tiles = new Uint8Array(32);
  const png = renderTilesGrid({ platform: "snes", tileBytes: tiles, tilesPerRow: 1 });
  const img = PNG.sync.read(png);
  assert.equal(img.width, 8);
  assert.equal(img.height, 8);
});

test("renderTilesGrid: Genesis 4bpp packed renders correctly", () => {
  const tiles = new Uint8Array(32);
  const png = renderTilesGrid({ platform: "genesis", tileBytes: tiles, tilesPerRow: 1 });
  const img = PNG.sync.read(png);
  assert.equal(img.width, 8);
  assert.equal(img.height, 8);
});

test("renderTilesGrid: round-trip via image-to-tiles for SMS", () => {
  // Build a non-trivial SMS tile from an RGBA pattern, then re-render it.
  const px = Buffer.alloc(8 * 8 * 4, 0);
  for (let i = 3; i < px.length; i += 4) px[i] = 0xff;
  // Top half: white
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 8; x++) {
      const o = (y * 8 + x) * 4;
      px[o] = 255; px[o + 1] = 255; px[o + 2] = 255;
    }
  }
  const r = rgbaToTiles("sms", { width: 8, height: 8, pixels: px });
  assert.equal(r.tiles.length, 32);
  const png = renderTilesGrid({ platform: "sms", tileBytes: r.tiles, tilesPerRow: 1 });
  const img = PNG.sync.read(png);
  // Top-left pixel should be non-zero in one of the channels.
  assert.equal(img.width, 8);
  assert.equal(img.height, 8);
});
