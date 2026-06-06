import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeSnesTile, snesTilemapUsage } from "./ppu.js";

// 4bpp SNES tile bitplane layout sanity check.
//
// A 4bpp tile is 32 bytes: bytes 0-15 = planes 0&1 (row-interleaved),
// bytes 16-31 = planes 2&3. For each row r:
//   byte[r*2]   = plane0, byte[r*2+1] = plane1   (in the 0-15 group)
//   byte[16+r*2]= plane2, byte[16+r*2+1]=plane3  (in the 16-31 group)
// bit 7 = leftmost pixel.

test("decodeSnesTile 4bpp: a single plane sets the right bit", () => {
  const t = new Uint8Array(32);
  // Row 0, plane 0 = 0x80 → leftmost pixel gets bit 0 set → index 1.
  t[0] = 0x80;
  const rows = decodeSnesTile(t, 4);
  assert.equal(rows[0][0], 1, "top-left pixel should be color index 1");
  assert.equal(rows[0][1], 0, "next pixel untouched");
});

test("decodeSnesTile 4bpp: all four planes combine into index 15", () => {
  const t = new Uint8Array(32);
  // Set the leftmost pixel of row 0 in every plane.
  t[0] = 0x80;   // plane 0
  t[1] = 0x80;   // plane 1
  t[16] = 0x80;  // plane 2
  t[17] = 0x80;  // plane 3
  const rows = decodeSnesTile(t, 4);
  assert.equal(rows[0][0], 0b1111, "4 planes set → index 15");
});

test("decodeSnesTile 2bpp: 16-byte tile, plane1 sets bit 1", () => {
  const t = new Uint8Array(16);
  t[1] = 0x80; // row 0 plane 1
  const rows = decodeSnesTile(t, 2);
  assert.equal(rows[0][0], 0b10, "plane1 only → index 2");
});

test("decodeSnesTile: bit 7 is the leftmost pixel", () => {
  const t = new Uint8Array(32);
  t[0] = 0x01; // plane 0, rightmost pixel
  const rows = decodeSnesTile(t, 4);
  assert.equal(rows[0][7], 1, "bit 0 → pixel x=7 (rightmost)");
  assert.equal(rows[0][0], 0, "leftmost untouched");
});

test("snesTilemapUsage collects distinct tile indices from a 32x32 map", () => {
  // Build a tiny VRAM with a tilemap at offset 0: 16-bit LE entries,
  // tile index in low 10 bits.
  const vram = new Uint8Array(0x10000);
  // entry 0 → tile 5, entry 1 → tile 5 (dup), entry 2 → tile 300.
  vram[0] = 5;  vram[1] = 0;
  vram[2] = 5;  vram[3] = 0;
  vram[4] = 300 & 0xFF; vram[5] = (300 >> 8) & 0x03;
  const usage = snesTilemapUsage(vram, { tilemapBaseByte: 0, mapWidth: 32, mapHeight: 32 });
  assert.ok(usage.used.includes(5), "tile 5 present");
  assert.ok(usage.used.includes(300), "tile 300 present");
  // The rest of the map is tile 0.
  assert.ok(usage.used.includes(0), "tile 0 (rest of map) present");
  // 5 appears twice but counted once.
  assert.equal(usage.used.filter((t) => t === 5).length, 1, "deduped");
});
