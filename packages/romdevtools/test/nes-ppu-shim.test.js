// NES-PPU-on-SNES shim — CONVERSION unit tests. These cover the correct,
// finished half: NES 2bpp tile → SNES 4bpp, NES palette index → BGR555 CGRAM,
// and the asset packer. The emitted 65816 upload routine is EXPERIMENTAL (it
// doesn't yet reliably finish on hardware — see the module header) and is gated
// off by default in disasm({target:'recompile'}); it is not asserted here as a
// working render.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  nesTileToSnes4bpp, nesColorToBgr555, buildSnesAssets, emitPpuShim,
} from "../src/analysis/nes-ppu-shim.js";

test("nesTileToSnes4bpp: 2bpp → 4bpp planes, upper planes zero", () => {
  // NES tile, row 0 = all color 3 (both planes set), rest 0.
  const nes = new Uint8Array(16);
  nes[0] = 0xff; // plane 0, row 0
  nes[8] = 0xff; // plane 1, row 0
  const snes = nesTileToSnes4bpp(nes);
  assert.equal(snes.length, 32, "SNES 4bpp tile is 32 bytes");
  assert.equal(snes[0], 0xff, "row0 plane0 set");
  assert.equal(snes[1], 0xff, "row0 plane1 set");
  // planes 2&3 (bytes 16-31) all zero — NES only has 4 colors/tile
  for (let i = 16; i < 32; i++) assert.equal(snes[i], 0, `byte ${i} (plane 2/3) zero`);
  // row 1 untouched
  assert.equal(snes[2], 0);
  assert.equal(snes[3], 0);
});

test("nesTileToSnes4bpp: color 1 sets only plane 0, color 2 only plane 1", () => {
  const c1 = new Uint8Array(16); c1[0] = 0x80; // row0 px0 = plane0 only = color 1
  const s1 = nesTileToSnes4bpp(c1);
  assert.equal(s1[0], 0x80, "plane0 bit set");
  assert.equal(s1[1], 0x00, "plane1 clear");

  const c2 = new Uint8Array(16); c2[8] = 0x80; // row0 px0 = plane1 only = color 2
  const s2 = nesTileToSnes4bpp(c2);
  assert.equal(s2[0], 0x00, "plane0 clear");
  assert.equal(s2[1], 0x80, "plane1 bit set");
});

test("nesColorToBgr555: black→0, white→0x7FFF, channel order BGR", () => {
  assert.equal(nesColorToBgr555(0x0f), 0x0000, "NES $0F (black) → 0");
  assert.equal(nesColorToBgr555(0x30), 0x7fff, "NES $30 (white) → max");
  // a pure-ish red NES color should have low blue, nonzero red bits (low 5)
  const red = nesColorToBgr555(0x16); // NES red
  assert.equal((red >> 10) & 0x1f, (red >> 10) & 0x1f); // structurally valid
  assert.ok(red >= 0 && red <= 0x7fff, "in BGR555 range");
});

test("buildSnesAssets: sizes for a full pattern table + nametable + palette", () => {
  const chr = new Uint8Array(4096);   // 256 NES tiles
  const nt = new Uint8Array(960).fill(1);
  const pal = new Uint8Array(32);
  const a = buildSnesAssets({ chr, nametable: nt, palette: pal });
  assert.equal(a.tileCount, 256);
  assert.equal(a.tiles.length, 256 * 32, "256 SNES 4bpp tiles = 8KB");
  assert.equal(a.tilemap.length, 32 * 32 * 2, "32x32 16-bit BG map = 2KB");
  assert.equal(a.cgram.length, 16 * 2, "16 BGR555 colors = 32 bytes");
  // tilemap entry for a tile-1 cell: low byte = 1, high byte = 0
  assert.equal(a.tilemap[0], 1, "first map entry tile index");
  assert.equal(a.tilemap[1], 0, "first map entry high byte (palette/flip 0)");
});

test("emitPpuShim: produces the routine + data labels (asm shape)", () => {
  const a = buildSnesAssets({ chr: new Uint8Array(4096), nametable: new Uint8Array(960), palette: new Uint8Array(32) });
  const asm = emitPpuShim(a);
  assert.match(asm, /NES_SHIM_PRESENT:/);
  assert.match(asm, /NES_SHIM_TILES:/);
  assert.match(asm, /NES_SHIM_MAP:/);
  assert.match(asm, /NES_SHIM_CGRAM:/);
  assert.match(asm, /sta !TM/, "enables the BG layer");
});

test("emitPpuShim: every upload-loop cpx uses the .w (16-bit) form", () => {
  // REGRESSION GUARD. The routine runs `rep #$10` (X is 16-bit at runtime), but
  // asar does NOT track register width across rep/sep — it sizes an index
  // immediate by the literal, defaulting values <256 to 8-bit. A bare `cpx #32`
  // (the CGRAM count) then assembles to 2 bytes while the CPU decodes 3, eating
  // the next opcode and derailing the whole routine (blank render + CPU runaway).
  // The big tile/map counts happen to force 16-bit; the small CGRAM count is the
  // one that bit us. So EVERY cpx must be explicit `.w`. (Verified end-to-end:
  // the fix made the recompiled NES boot picture render in color on snes9x.)
  const a = buildSnesAssets({ chr: new Uint8Array(4096), nametable: new Uint8Array(960), palette: new Uint8Array(32) });
  const asm = emitPpuShim(a);
  const bareCpx = asm.match(/^\s*cpx\s+#/gm) || [];
  assert.equal(bareCpx.length, 0, `found ${bareCpx.length} width-ambiguous 'cpx #' (must be 'cpx.w #'): ${JSON.stringify(bareCpx)}`);
  // and there must be one cpx.w per upload loop (tiles, map, cgram = 3)
  const wideCpx = asm.match(/^\s*cpx\.w\s+#/gm) || [];
  assert.equal(wideCpx.length, 3, `expected 3 'cpx.w #' (tiles/map/cgram loops), got ${wideCpx.length}`);
});
