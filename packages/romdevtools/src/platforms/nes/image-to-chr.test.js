import { test } from "node:test";
import assert from "node:assert/strict";
import { PNG } from "pngjs";
import { imageToChr, rgbaToChr } from "./image-to-chr.js";

test("rgbaToChr: solid-color 8x8 produces 16 zero bytes", () => {
  const px = Buffer.alloc(8 * 8 * 4);
  // All black
  for (let i = 0; i < px.length; i += 4) {
    px[i] = 0; px[i + 1] = 0; px[i + 2] = 0; px[i + 3] = 0xff;
  }
  const r = rgbaToChr({ width: 8, height: 8, pixels: px });
  assert.equal(r.totalTiles, 1);
  assert.equal(r.chr.length, 16);
  // Solid → all pixels palette index 0 → both bitplanes zero
  for (let i = 0; i < 16; i++) assert.equal(r.chr[i], 0);
});

test("rgbaToChr: two-color tile uses bitplane 0 only", () => {
  const px = Buffer.alloc(8 * 8 * 4);
  // Diagonal: black/white
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const o = (y * 8 + x) * 4;
      const lit = x === y;
      px[o] = lit ? 0xff : 0x00;
      px[o + 1] = lit ? 0xff : 0x00;
      px[o + 2] = lit ? 0xff : 0x00;
      px[o + 3] = 0xff;
    }
  }
  const r = rgbaToChr({ width: 8, height: 8, pixels: px });
  // Diagonal pattern: row Y has bit (7-Y) set.
  for (let y = 0; y < 8; y++) {
    assert.equal(r.chr[y], 1 << (7 - y), `lo plane row ${y}`);
  }
});

test("imageToChr round-trip via pngjs", () => {
  const png = new PNG({ width: 16, height: 8 });
  png.data.fill(0); // black
  for (let i = 3; i < png.data.length; i += 4) png.data[i] = 0xff;
  const buf = PNG.sync.write(png);
  const r = imageToChr(buf);
  assert.equal(r.totalTiles, 2);
  assert.equal(r.chr.length, 32);
});
