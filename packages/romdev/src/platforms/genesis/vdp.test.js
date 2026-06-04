// Genesis VDP decoder tests. Covers CRAM, SAT, tile, sub-palette,
// and the rgb↔genesis colour round-trip.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  decodeSAT,
  decodeCRAM,
  decode4bppTile,
  decodeGenesisSubpalette,
  rgbToGenesisColor,
  decodeVDPRegs,
} from "./vdp.js";

test("rgbToGenesisColor: red/green/blue/black round-trip", () => {
  assert.equal(rgbToGenesisColor(255, 0, 0), 0x000E);
  assert.equal(rgbToGenesisColor(0, 255, 0), 0x00E0);
  assert.equal(rgbToGenesisColor(0, 0, 255), 0x0E00);
  assert.equal(rgbToGenesisColor(0, 0, 0), 0x0000);
});

test("decodeCRAM: packed 9-bit (BBBGGGRRR) LE words → RGB triples", () => {
  // The gpgx genesis_cram region stores PACKED 9-bit colours (0bBBBGGGRRR),
  // little-endian — NOT the raw 16-bit bus word. Full-red is packed 0x007
  // (bytes 07 00), green 0x038 (38 00), blue 0x1C0 (c0 01). Verified live:
  // bus $00EE (yellow) → bytes 3f 00 → 0x003F → R7 G7 B0 → (255,255,0).
  const cram = new Uint8Array(128);
  cram[0] = 0x00; cram[1] = 0x00; // black at color 0
  cram[2] = 0x07; cram[3] = 0x00; // bright red   (0x007) at color 1
  cram[4] = 0x38; cram[5] = 0x00; // bright green (0x038) at color 2
  cram[6] = 0xc0; cram[7] = 0x01; // bright blue  (0x1C0) at color 3
  const colors = decodeCRAM(cram);
  assert.deepEqual(colors[0], [0, 0, 0]);
  assert.deepEqual(colors[1], [255, 0, 0]);
  assert.deepEqual(colors[2], [0, 255, 0]);
  assert.deepEqual(colors[3], [0, 0, 255]);
});

test("decodeCRAM: yellow regression (the bug the feedback found)", () => {
  // Pre-fix every Genesis colour decoded to blue-on-black. Bus $00EE = yellow,
  // packed to 0x003F (bytes 3f 00). Must decode to (255,255,0), not blue.
  assert.deepEqual(decodeCRAM(new Uint8Array([0x3f, 0x00]))[0], [255, 255, 0]);
});

test("decodeSAT: sprite position/tile/palette decode", () => {
  const sat = new Uint8Array(640);
  // Sprite 0: x=160, y=100, tile=16, palette=1, 1×1
  sat[0] = 0x00; sat[1] = 0xE4; // y = 0xE4 = 228, screen y = 228 - 128 = 100
  sat[2] = 0x00;                // size = 1×1
  sat[3] = 0x01;                // link
  sat[4] = 0x20; sat[5] = 0x10; // attr = 0x2010: palette 1, tile 16
  sat[6] = 0x01; sat[7] = 0x20; // x = 0x120 = 288, screen x = 288 - 128 = 160
  const sprites = decodeSAT(sat);
  assert.equal(sprites[0].x, 160);
  assert.equal(sprites[0].y, 100);
  assert.equal(sprites[0].tile, 16);
  assert.equal(sprites[0].palette, 1);
  assert.equal(sprites[0].size.w, 8);
  assert.equal(sprites[0].size.h, 8);
  assert.equal(sprites[0].link, 1);
  assert.equal(sprites[0].priority, 0);
  assert.equal(sprites[0].visible, true);
});

test("decodeSAT: SAT is 80 entries", () => {
  const sat = new Uint8Array(640);
  const sprites = decodeSAT(sat);
  assert.equal(sprites.length, 80);
});

test("decode4bppTile: nibble unpacking", () => {
  const tile = new Uint8Array(32);
  tile[0] = 0x12; tile[1] = 0x34; tile[2] = 0x56; tile[3] = 0x78;
  const rows = decode4bppTile(tile);
  assert.deepEqual(rows[0], [1, 2, 3, 4, 5, 6, 7, 8]);
  // Other rows should be all-zero
  for (let i = 0; i < 8; i++) assert.equal(rows[1][i], 0);
});

test("decode4bppTile: wrong size throws", () => {
  assert.throws(() => decode4bppTile(new Uint8Array(31)));
  assert.throws(() => decode4bppTile(new Uint8Array(33)));
});

test("decodeGenesisSubpalette: extract a 16-color sub-palette", () => {
  const cram = new Uint8Array(128);
  // Palette 1 starts at byte 32. Put a red (packed 0x007, bytes 07 00) at color 1.
  cram[32 + 2] = 0x07;
  cram[32 + 3] = 0x00;
  const sub = decodeGenesisSubpalette(cram, 1);
  assert.equal(sub.length, 16);
  assert.deepEqual(sub[1], [255, 0, 0]);
});

test("decodeGenesisSubpalette: invalid index throws", () => {
  const cram = new Uint8Array(128);
  assert.throws(() => decodeGenesisSubpalette(cram, -1));
  assert.throws(() => decodeGenesisSubpalette(cram, 4));
});

test("decodeVDPRegs: extract display state + plane addresses", () => {
  const regs = new Uint8Array(32);
  regs[0x01] = 0x40 | 0x20 | 0x04; // displayEnabled + vblankInt + mode5
  regs[0x02] = 0x38;               // nameTableA base = 0x38 << 10 = 0xE000
  regs[0x04] = 0x07;               // nameTableB base = 0x7 << 13 = 0xE000
  regs[0x05] = 0x6C;               // SAT base = 0x6C << 9 = 0xD800
  regs[0x07] = 0x10;               // backdrop palette 1, color 0
  regs[0x0C] = 0x81;               // H40

  const d = decodeVDPRegs(regs);
  assert.equal(d.displayEnabled, true);
  assert.equal(d.vblankInt, true);
  assert.equal(d.mode5, true);
  assert.equal(d.nameTableA, 0xE000);
  assert.equal(d.nameTableB, 0xE000);
  assert.equal(d.spriteTable, 0xD800);
  assert.equal(d.bgColor.palette, 1);
  assert.equal(d.bgColor.index, 0);
  assert.equal(d.hMode, 'H40');
});
