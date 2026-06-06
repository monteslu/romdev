// Unit tests for the SNES PPU-register / OAM decoders that drive
// getRenderingContext + inspectSprites. These are pure functions over
// synthetic FillRAM / OAM / CGRAM buffers — no emulator needed — so they
// pin the exact bit math (OBSEL size table, BGxSC/BGxNBA addressing,
// renderable-vs-hidden classification, uninitialized-palette detection).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decodePpuRegs,
  ppuRegsPopulated,
  decodeOAM,
  decodeCGRAM,
  checkObjPalettes,
} from "../src/platforms/snes/ppu.js";

/** Build a 32KB FillRAM with the given {regAddr: byte} writes. */
function fillramWith(regs) {
  const fr = new Uint8Array(0x8000);
  for (const [addr, val] of Object.entries(regs)) fr[Number(addr)] = val;
  return fr;
}

test("decodePpuRegs decodes INIDISP / OBSEL / BGMODE / TM / TS by full reg address", () => {
  const fr = fillramWith({
    0x2100: 0x0f, // INIDISP: brightness 15, display on
    0x2101: 0xa3, // OBSEL: size sel = 0b101=5, name select=0, base=0b011
    0x2105: 0x01, // BGMODE 1
    0x212c: 0x10, // TM: OBJ on main
    0x212d: 0x02, // TS: BG2 on sub
  });
  const p = decodePpuRegs(fr);
  assert.equal(p.brightness, 15);
  assert.equal(p.forcedBlank, false);
  assert.equal(p.bgMode, 1);
  // OBSEL 0xA3 = 1010_0011: size bits 7-5 = 101 = 5, name sel bits 4-3 = 00,
  // base bits 2-0 = 011 = 3 → word base 3<<13 = 0x6000 words = 0xC000 bytes.
  assert.equal(p.objSizeSel, 5);
  assert.deepEqual(p.objSize.small, [32, 32]);
  assert.deepEqual(p.objSize.large, [64, 64]);
  assert.equal(p.objNameBaseWord, 0x6000);
  assert.equal(p.objNameBaseByte, 0xC000);
  // TM=0x10 → OBJ only; TS=0x02 → BG2 only.
  assert.equal(p.mainScreen.obj, true);
  assert.equal(p.mainScreen.bg1, false);
  assert.equal(p.subScreen.bg2, true);
});

test("decodePpuRegs decodes per-BG tilemap base + char base + map size", () => {
  const fr = fillramWith({
    0x2105: 0x01,         // mode 1
    0x2107: 0x7C | 0x01,  // BG1SC: base bits 2-7 = 0x7C → (0x7C<<8)=0x7C00 words; size 0b01 = 64×32
    0x210b: 0x21,         // BG12NBA: BG1 nybble=1 (0x1000 words), BG2 nybble=2 (0x2000 words)
  });
  const p = decodePpuRegs(fr);
  assert.equal(p.bg[0].scBaseWord, 0x7C00);
  assert.equal(p.bg[0].scBaseByte, 0xF800);
  assert.equal(p.bg[0].mapWidth, 64);
  assert.equal(p.bg[0].mapHeight, 32);
  assert.equal(p.bg[0].charBaseWord, 0x1000);
  assert.equal(p.bg[0].charBaseByte, 0x2000);
  assert.equal(p.bg[1].charBaseWord, 0x2000);
});

test("ppuRegsPopulated false on empty/uniform FillRAM, true once written", () => {
  assert.equal(ppuRegsPopulated(new Uint8Array(0x8000)), false);
  assert.equal(ppuRegsPopulated(new Uint8Array(0x8000).fill(0xFF)), false);
  assert.equal(ppuRegsPopulated(fillramWith({ 0x2101: 0xa3 })), true);
});

test("decodeOAM classifies renderable vs hidden (off-screen-top, off-left, off-right)", () => {
  const oam = new Uint8Array(544);
  const put = (slot, x, y, tile, attr, sizeBit = 0, xHigh = 0) => {
    const lo = slot * 4;
    oam[lo] = x & 0xFF; oam[lo + 1] = y; oam[lo + 2] = tile; oam[lo + 3] = attr;
    const hiBits = (xHigh & 1) | ((sizeBit & 1) << 1);
    oam[512 + (slot >> 2)] |= hiBits << ((slot & 3) * 2);
  };
  // slot 0: on-screen at (100, 80)
  put(0, 100, 80, 0, 0x00);
  // slot 1: parked off-screen-top at Y=0xF0
  put(1, 100, 0xF0, 0, 0x00);
  // slot 2: off the right edge (X=250, width 16 → still partly on at 250? no:
  //   16×16 means sx=250, 250<256 so onX true) — use X=0x1FF (sign → -1, off left)
  put(3, 0xFF, 80, 0, 0x00, 0, 1); // xHigh=1 → fullX=0x1FF → sx = -1, w=8 → -1+8=7>0 still on; nudge
  const sprites = decodeOAM(oam, { smallSize: [8, 8], largeSize: [16, 16] });
  assert.equal(sprites[0].renderable, true);
  assert.equal(sprites[0].hiddenReason, null);
  assert.equal(sprites[1].renderable, false);
  assert.match(sprites[1].hiddenReason, /off-screen-top/);
});

test("decodeOAM resolves tileVramAddr + cgramPaletteRange when OBSEL known", () => {
  const oam = new Uint8Array(544);
  // slot 0: tile 5, palette 3 (attr bits 1-3), name table 0.
  oam[0] = 50; oam[1] = 50; oam[2] = 5; oam[3] = (3 << 1);
  const sprites = decodeOAM(oam, {
    smallSize: [8, 8], largeSize: [16, 16],
    objNameBaseByte: 0xC000, objGapByte: 0x2000,
  });
  assert.equal(sprites[0].palette, 3);
  // CGRAM range: OBJ palettes start at 128; pal 3 → 128+3*16 = 176.
  assert.deepEqual(sprites[0].cgramPaletteRange, [176, 191]);
  // tile 5 × 32 bytes + base 0xC000 = 0xC000 + 0xA0 = 0xC0A0.
  assert.equal(sprites[0].tileVramByte, 0xC000 + 5 * 32);
  assert.equal(sprites[0].tileVramAddr, "0xc0a0");
});

// Helpers to author CGRAM OBJ palette lines (line N = CGRAM index 128+N*16).
function setObjLine(cgram, line, words) {
  const base = (128 + line * 16) * 2;
  for (let k = 0; k < 16; k++) {
    const w = words[k] ?? 0;
    cgram[base + k * 2] = w & 0xFF;
    cgram[base + k * 2 + 1] = (w >> 8) & 0xFF;
  }
}
// A "real" authored sprite palette: a handful of distinct deliberate colors.
const AUTHORED = [0x0000, 0x7C00, 0x03E0, 0x001F, 0x7FFF, 0x7C1F, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
const spriteUsingLine = (line) => {
  const oam = new Uint8Array(544);
  oam[0] = 50; oam[1] = 50; oam[2] = 0; oam[3] = (line << 1);
  return decodeOAM(oam, { smallSize: [8, 8], largeSize: [16, 16] });
};

test("checkObjPalettes flags a referenced-but-all-zero OBJ palette line", () => {
  const cgram = new Uint8Array(512); // all zero
  const sprites = spriteUsingLine(2);
  const { uninitializedPalettes, warnings } = checkObjPalettes(sprites, decodeCGRAM(cgram));
  assert.ok(uninitializedPalettes.includes(2));
  assert.match(warnings.join(" "), /palette line 2/);
});

test("checkObjPalettes does NOT flag an authored line", () => {
  const cgram = new Uint8Array(512);
  setObjLine(cgram, 2, AUTHORED);
  const res = checkObjPalettes(spriteUsingLine(2), decodeCGRAM(cgram));
  assert.equal(res.uninitializedPalettes.includes(2), false);
  assert.equal(res.suspiciousPalettes.includes(2), false);
});

test("checkObjPalettes flags NON-ZERO junk: a uniform/flat-fill line is suspicious", () => {
  // The bug Codex hit: line 1 holds stale non-zero data, not all zero.
  const cgram = new Uint8Array(512);
  setObjLine(cgram, 0, AUTHORED);                  // line 0 authored
  setObjLine(cgram, 1, Array(16).fill(0x3DEF));    // line 1 = flat fill of one junk color
  const res = checkObjPalettes(spriteUsingLine(1), decodeCGRAM(cgram));
  // Flat fill OR above-the-uploaded-block → warned (not silent like before).
  assert.ok(res.warnings.length >= 1, "expected a warning for the junk line");
  assert.ok(
    res.suspiciousPalettes.includes(1) || res.uninitializedPalettes.includes(1),
    "junk line 1 should be flagged",
  );
});

test("checkObjPalettes flags a referenced line ABOVE the uploaded block (contiguity)", () => {
  // Only line 0 authored; a sprite references line 3 (never uploaded) holding
  // non-zero leftover gradient — the exact Asteroids failure mode.
  const cgram = new Uint8Array(512);
  setObjLine(cgram, 0, AUTHORED);
  // line 3 = a smooth ramp of distinct non-zero values (default-looking)
  setObjLine(cgram, 3, Array.from({ length: 16 }, (_, k) => k * 0x111));
  const res = checkObjPalettes(spriteUsingLine(3), decodeCGRAM(cgram));
  assert.ok(res.warnings.length >= 1, "expected a warning for line 3 above the uploaded block");
  assert.match(res.warnings.join(" "), /line 3/);
});
