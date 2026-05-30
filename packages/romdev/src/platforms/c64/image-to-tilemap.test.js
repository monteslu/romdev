import { test } from "node:test";
import assert from "node:assert/strict";
import { PNG } from "pngjs";
import { c64ImageToTilemap } from "./image-to-tilemap.js";
import { C64_PALETTE } from "./vic.js";

function makePng(fill) {
  const png = new PNG({ width: 320, height: 200 });
  for (let i = 0; i < 320 * 200; i++) {
    const [r, g, b] = C64_PALETTE[fill(i % 320, Math.floor(i / 320))];
    const o = i * 4;
    png.data[o] = r; png.data[o + 1] = g; png.data[o + 2] = b; png.data[o + 3] = 255;
  }
  return PNG.sync.write(png);
}

test("c64ImageToTilemap rejects wrong-size images", () => {
  const png = PNG.sync.write(new PNG({ width: 100, height: 100 }));
  assert.throws(() => c64ImageToTilemap({ pngBytes: png }), /320×200/);
});

test("solid background → 1 unique char, correct bg color", () => {
  // All blue (index 6).
  const png = makePng(() => 6);
  const r = c64ImageToTilemap({ pngBytes: png });
  assert.equal(r.backgroundColor, 6, "most-common color becomes bg");
  assert.equal(r.uniqueTiles, 1, "a flat image is one repeated blank char");
  assert.equal(r.nametable.length, 1000, "screen RAM = 40×25");
  assert.equal(r.attr.length, 1000, "color RAM = 40×25");
  assert.equal(r.palette.length, 1, "palette = 1 bg byte");
  assert.equal(r.warnings.length, 0, "no constraint violations on a flat image");
});

test("2-color cells encode without warnings; chr bit set on fg pixel", () => {
  // bg = black(0); set the very top-left pixel of every cell to white(1).
  const png = makePng((x, y) => ((x % 8 === 0 && y % 8 === 0) ? 1 : 0));
  const r = c64ImageToTilemap({ pngBytes: png });
  assert.equal(r.backgroundColor, 0);
  assert.equal(r.warnings.length, 0, "2 colors per cell is legal");
  // The char used by cell (0,0) should have bit 7 of row 0 set.
  const charCode = r.nametable[0];
  assert.equal((r.chr[charCode * 8 + 0] >> 7) & 1, 1, "fg pixel → bit set");
  // That cell's color RAM holds the fg color (white = 1).
  assert.equal(r.attr[0] & 0x0F, 1);
});

test("backdrop override forces the chosen background color", () => {
  const png = makePng(() => 6); // all blue
  const r = c64ImageToTilemap({ pngBytes: png, backdrop: 2 }); // force red
  assert.equal(r.backgroundColor, 2);
});

test(">2 colors in one cell is flagged", () => {
  // A cell with black bg + white + red → constraint violation.
  const png = makePng((x, y) => {
    if (x >= 8) return 0; // only first column of cells has extra colors
    if (y % 8 === 0) return 1; // white
    if (y % 8 === 1) return 2; // red
    return 0;
  });
  const r = c64ImageToTilemap({ pngBytes: png });
  assert.ok(r.warnings.some((w) => /colors/.test(w)), "multi-color cells warned");
});
