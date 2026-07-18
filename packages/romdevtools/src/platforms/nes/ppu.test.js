// PPU decoder unit tests — exercise the tile-bitplane math with a tiny
// synthetic tile, plus verify the pattern-table renderer against a real
// fceumm load.

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { PNG } from "pngjs";

import { decodeTile, renderPatternTablePng, decodeNametable } from "./ppu.js";
import { resolveCore } from "../../cores/registry.js";
import { LibretroHost } from "romdev-core-host/index.js";
import { buildC } from "../../toolchains/cc65/cc65.js";
import { writeFile, mkdtemp } from "node:fs/promises";
import os from "node:os";

test("decodeTile: solid-color tile decodes to all 3s", () => {
  const tile = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    tile[i] = 0xff;
    tile[i + 8] = 0xff;
  }
  const out = decodeTile(tile);
  for (let i = 0; i < 64; i++) assert.equal(out[i], 3);
});

test("decodeTile: diagonal pattern", () => {
  const tile = new Uint8Array(16);
  for (let y = 0; y < 8; y++) tile[y] = 1 << (7 - y);
  const out = decodeTile(tile);
  for (let y = 0; y < 8; y++) {
    assert.equal(out[y * 8 + y], 1, `expected diagonal at (${y},${y})`);
  }
});

test("decodeNametable: tile grid + per-tile sub-palette from attribute table", () => {
  const ciram = new Uint8Array(2048);
  // Lay a recognizable tile pattern: tile (col,row) = (col + row) & 0xFF.
  for (let row = 0; row < 30; row++)
    for (let col = 0; col < 32; col++)
      ciram[row * 32 + col] = (col + row) & 0xFF;
  // Attribute table at +960. Byte 0 covers tiles cols 0-3, rows 0-3, split into
  // four 16×16 (2×2-tile) quadrants: TL=bits0-1, TR=2-3, BL=4-5, BR=6-7.
  // Set TL=3, TR=2, BL=1, BR=0  → 0b00_01_10_11 = 0x1B.
  ciram[960] = 0x1B;

  const dec = decodeNametable(ciram, { which: 0 });
  assert.equal(dec.width, 32);
  assert.equal(dec.height, 30);
  // Tile values round-trip.
  assert.equal(dec.tiles[0][0], 0);
  assert.equal(dec.tiles[1][2], (2 + 1) & 0xFF);
  // Sub-palette quadrants of attr byte 0:
  assert.equal(dec.subPaletteGrid[0][0], 3); // TL  (cols 0-1, rows 0-1)
  assert.equal(dec.subPaletteGrid[0][2], 2); // TR  (cols 2-3, rows 0-1)
  assert.equal(dec.subPaletteGrid[2][0], 1); // BL  (cols 0-1, rows 2-3)
  assert.equal(dec.subPaletteGrid[2][2], 0); // BR  (cols 2-3, rows 2-3)
  assert.ok(dec.attrTableHex.startsWith("1b"));
});

test("decodeNametable: region clips to a sub-rectangle", () => {
  const ciram = new Uint8Array(2048);
  for (let i = 0; i < 960; i++) ciram[i] = i & 0xFF;
  const dec = decodeNametable(ciram, { region: { x: 5, y: 6, w: 4, h: 3 } });
  assert.deepEqual(dec.region, { x: 5, y: 6, w: 4, h: 3 });
  assert.equal(dec.tiles.length, 3);
  assert.equal(dec.tiles[0].length, 4);
  assert.equal(dec.tiles[0][0], (6 * 32 + 5) & 0xFF); // top-left of the region
  // distinctTiles is the unique set within the region only.
  assert.ok(dec.distinctTiles.length <= 12);
});

test("decodeNametable: region clamps to the 32×30 grid", () => {
  const ciram = new Uint8Array(2048);
  const dec = decodeNametable(ciram, { region: { x: 30, y: 28, w: 10, h: 10 } });
  assert.equal(dec.region.w, 2); // 32 - 30
  assert.equal(dec.region.h, 2); // 30 - 28
});

test("renderPatternTablePng: produces a valid 128x128 PNG", () => {
  const chr4k = new Uint8Array(4096);
  for (let i = 0; i < 16; i++) chr4k[i] = 0xff;
  const buf = renderPatternTablePng(chr4k);
  const img = PNG.sync.read(buf);
  assert.equal(img.width, 128);
  assert.equal(img.height, 128);
  const o0 = 0;
  assert.equal(img.data[o0 + 0], 240);
  assert.equal(img.data[o0 + 1], 240);
  assert.equal(img.data[o0 + 2], 240);
});

test("snapshotPatternTables: works against a real fceumm + cc65 nes ROM", async () => {
  const r = await buildC({ source: "void main(void){while(1){}}\n", target: "nes" });
  assert.equal(r.exitCode, 0, "build failed:\n" + r.log);
  const tmp = await mkdtemp(path.join(os.tmpdir(), "ppu-test-"));
  const romPath = path.join(tmp, "test.nes");
  await writeFile(romPath, r.binary);

  const resolved = resolveCore("nes");
  const host = new LibretroHost();
  await host.loadCore(resolved.jsPath, resolved.wasmPath);
  await host.loadMedia({ platform: "nes", path: romPath });
  host.stepFrames(10);

  const { snapshotPatternTables } = await import("./ppu.js");
  const { width, height, png } = await snapshotPatternTables(host);
  assert.equal(width, 256);
  assert.equal(height, 128);
  assert.equal(png[0], 0x89);
  assert.equal(png[1], 0x50);
  await writeFile("/tmp/nes-pattern-tables.png", png);
}, { timeout: 30000 });
