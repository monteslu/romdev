// SNES PPU helpers — decode OAM, CGRAM, VRAM tiles, and BG tilemaps from
// snes9x's exposed memory regions (rom-dev-mcp/snes9x patch: snes_oam,
// snes_cgram, plus the standard video_ram → Memory.VRAM 64 KB region).
//
// OAM is 544 bytes: a 512-byte "low" table (128 sprites × 4 bytes) plus
// a 32-byte "high" table that holds the X-high bit and size bit for
// each sprite (2 bits × 128 sprites = 32 bytes).
//
// Low table layout per sprite (4 bytes):
//   byte 0: X position (low 8 bits)
//   byte 1: Y position
//   byte 2: tile number (low 8 bits)
//   byte 3: vhoopppN (V flip, H flip, priority 2 bits, palette 3 bits, name table bit)
//
// High table layout (32 bytes = 128 sprites × 2 bits):
//   sprite N:
//     bit 0: X high bit
//     bit 1: size (0 = small per OBSEL.size, 1 = large)
//
// CGDATA: 256 colors × uint16. Each color is BGR555:
//   bits 0-4   : red
//   bits 5-9   : green
//   bits 10-14 : blue
//   bit 15     : unused
//
// All values are derived from snes9x's own structures (see ppu.h SPPU.
// OAMData / SPPU.CGDATA), which are stable across snes9x versions.

/**
 * Decode the SNES OAM into the generic sprite shape used by inspectSprites.
 * @param {Uint8Array} oam 544 bytes (low table + high table)
 * @param {{ smallSize?: [number, number], largeSize?: [number, number] }} [opts]
 *   OBSEL.size selects the small/large pair per object. We don't have
 *   OBSEL here without ppu_regs decoded, so default to the most common
 *   {8×8, 16×16} pair. Caller can override.
 * @returns {Array<{
 *   slot: number, x: number, y: number, tile: number, palette: number,
 *   priority: number, flipH: boolean, flipV: boolean,
 *   size: { w: number, h: number }, visible: boolean,
 *   nameTable: 0 | 1, raw: { byte0: number, byte1: number, byte2: number, byte3: number, hiBits: number }
 * }>}
 */
export function decodeOAM(oam, opts = {}) {
  const smallSize = opts.smallSize ?? [8, 8];
  const largeSize = opts.largeSize ?? [16, 16];
  const sprites = [];
  for (let i = 0; i < 128; i++) {
    const lo = i * 4;
    const x = oam[lo + 0];
    const y = oam[lo + 1];
    const tile = oam[lo + 2];
    const attr = oam[lo + 3];
    // High table: 2 bits per sprite, packed 4 sprites per byte.
    const hi = oam[512 + (i >> 2)];
    const hiShift = (i & 3) * 2;
    const hiBits = (hi >> hiShift) & 0x3;
    const xHigh = hiBits & 0x1;
    const sizeBit = (hiBits >> 1) & 0x1;
    const fullX = (xHigh ? 0x100 : 0) | x;
    const [w, h] = sizeBit ? largeSize : smallSize;
    sprites.push({
      slot: i,
      x: fullX > 0x100 ? fullX - 0x200 : fullX, // sign-extend 9-bit X to signed
      y, // SNES Y is 0..239; Y=$E0+ is "off-screen-top" convention
      tile: tile | ((attr & 0x01) << 8), // attr bit 0 is name-table select; combined gives 9-bit tile
      palette: (attr >> 1) & 0x7,
      priority: (attr >> 4) & 0x3,
      flipH: !!((attr >> 6) & 0x1),
      flipV: !!((attr >> 7) & 0x1),
      size: { w, h },
      visible: y < 0xF0 && fullX < 256 + w,
      nameTable: /** @type {0 | 1} */ (attr & 0x01),
      raw: { byte0: x, byte1: y, byte2: tile, byte3: attr, hiBits },
    });
  }
  return sprites;
}

/**
 * Decode SNES CGRAM (palette) into normalized {index, r, g, b, rawWord}.
 * @param {Uint8Array} cgram 512 bytes (256 colors × uint16 little-endian)
 * @returns {Array<{ index: number, r: number, g: number, b: number, rawWord: number }>}
 */
export function decodeCGRAM(cgram) {
  const colors = [];
  for (let i = 0; i < 256; i++) {
    const off = i * 2;
    const word = cgram[off] | (cgram[off + 1] << 8);
    // BGR555 → 0..31 per channel. Expand to 0..255 with the common
    // (c << 3) | (c >> 2) approximation so the values are PNG-ready.
    const r5 = word & 0x1F;
    const g5 = (word >> 5) & 0x1F;
    const b5 = (word >> 10) & 0x1F;
    colors.push({
      index: i,
      r: (r5 << 3) | (r5 >> 2),
      g: (g5 << 3) | (g5 >> 2),
      b: (b5 << 3) | (b5 >> 2),
      rawWord: word,
    });
  }
  return colors;
}

import { PNG } from "pngjs";

// --- VRAM tile + tilemap decode --------------------------------------------
//
// snes9x doesn't expose the PPU registers ($2100-$213F) in a readable
// region (they're write-only and not mirrored anywhere we can reach), so
// the BG mode / tilemap base / tile base can't be auto-detected. Instead
// these helpers take those as parameters with the PVSnesLib / SNES-common
// defaults (Mode 1: 4bpp BG1/BG2, 2bpp BG3). The agent overrides them when
// their game differs.
//
// SNES tile bitplane layout:
//   2bpp tile = 16 bytes: 8 rows × {plane0, plane1} interleaved.
//     row r: byte[r*2] = plane0 bits, byte[r*2+1] = plane1 bits.
//   4bpp tile = 32 bytes: first 16 bytes are planes 0&1 (as 2bpp),
//     next 16 bytes are planes 2&3 (same row interleave).
//   8bpp tile = 64 bytes: four 16-byte plane-pair groups.
//   In every plane, bit 7 = leftmost pixel.

const BPP_TILE_BYTES = { 2: 16, 4: 32, 8: 64 };

/**
 * Decode one SNES tile (2/4/8 bpp) into an 8×8 array of palette indices.
 * @param {Uint8Array} bytes tile bytes (16/32/64 depending on bpp)
 * @param {2|4|8} bpp
 * @returns {number[][]} 8 rows × 8 cols of palette indices
 */
export function decodeSnesTile(bytes, bpp = 4) {
  const planes = bpp; // number of bitplanes == bpp
  const rows = [];
  for (let y = 0; y < 8; y++) {
    const row = [];
    for (let x = 0; x < 8; x++) {
      let idx = 0;
      for (let p = 0; p < planes; p++) {
        // Plane pair group: planes 0&1 in bytes 0-15, 2&3 in 16-31, ...
        const pairGroup = p >> 1;            // 0,0,1,1,2,2,3,3 → group index
        const inPair = p & 1;                 // which plane of the pair
        const base = pairGroup * 16;
        const b = bytes[base + y * 2 + inPair];
        const bit = (b >> (7 - x)) & 1;
        idx |= bit << p;
      }
      row.push(idx);
    }
    rows.push(row);
  }
  return rows;
}

/**
 * Render a sheet of SNES VRAM tiles to a PNG. Lays tiles out 16 across.
 *
 * @param {Uint8Array} vram 64 KB
 * @param {Array<{r:number,g:number,b:number}>} cgramColors decodeCGRAM() output (256 entries)
 * @param {object} opts
 * @param {2|4|8} [opts.bpp=4]
 * @param {number} [opts.tileBaseByte=0]   byte offset into VRAM of tile 0
 * @param {number} [opts.tileCount]        how many tiles to render (default fills VRAM)
 * @param {number} [opts.paletteBase=0]    CGRAM index of color 0 of the sub-palette to use
 * @param {number} [opts.cols=16]
 * @returns {{ width:number, height:number, png:Buffer, tileCount:number, bpp:number, note:string }}
 */
export function renderSnesTilesheet(vram, cgramColors, opts = {}) {
  const bpp = opts.bpp ?? 4;
  const tileBytes = BPP_TILE_BYTES[bpp];
  if (!tileBytes) throw new Error(`SNES bpp must be 2, 4, or 8 — got ${bpp}`);
  const tileBase = opts.tileBaseByte ?? 0;
  const cols = opts.cols ?? 16;
  const paletteBase = opts.paletteBase ?? 0;
  const maxTiles = Math.floor((vram.length - tileBase) / tileBytes);
  const tileCount = Math.min(opts.tileCount ?? maxTiles, maxTiles);
  const rowsOfTiles = Math.ceil(tileCount / cols);
  const W = cols * 8;
  const H = rowsOfTiles * 8;
  const png = new PNG({ width: W, height: H });

  for (let t = 0; t < tileCount; t++) {
    const off = tileBase + t * tileBytes;
    const tile = decodeSnesTile(vram.subarray(off, off + tileBytes), bpp);
    const tx = (t % cols) * 8;
    const ty = Math.floor(t / cols) * 8;
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        const ci = tile[y][x];
        const c = cgramColors[paletteBase + ci] || { r: 0, g: 0, b: 0 };
        const o = ((ty + y) * W + (tx + x)) * 4;
        png.data[o + 0] = c.r;
        png.data[o + 1] = c.g;
        png.data[o + 2] = c.b;
        png.data[o + 3] = 0xFF;
      }
    }
  }
  return {
    width: W,
    height: H,
    png: PNG.sync.write(png),
    tileCount,
    bpp,
    note: `${tileCount} ${bpp}bpp tiles from VRAM byte offset 0x${tileBase.toString(16)} ` +
      `(palette base CGRAM index ${paletteBase}). SNES PPU regs aren't readable from snes9x, so ` +
      `bpp/tileBase/paletteBase are assumptions (Mode 1 defaults) — override if your game differs.`,
  };
}

/**
 * Render a SNES BG tilemap to a PNG composite.
 *
 * A SNES tilemap is a grid of 16-bit little-endian entries:
 *   bits 0-9   : tile index (into the BG's tile data, ×tileBytes)
 *   bits 10-12 : palette (sub-palette number; CGRAM base = palette × paletteSize)
 *   bit 13     : priority
 *   bit 14     : horizontal flip
 *   bit 15     : vertical flip
 *
 * Map size is selected per-BG (32×32, 64×32, 32×64, 64×64 tiles), laid out
 * as up to four 32×32 "screens" in VRAM. We default to 32×32 (one screen);
 * the agent passes mapWidth/mapHeight (in tiles) for larger maps.
 *
 * @param {Uint8Array} vram 64 KB
 * @param {Array<{r:number,g:number,b:number}>} cgramColors decodeCGRAM() output
 * @param {object} opts
 * @param {number} [opts.tilemapBaseByte=0]  byte offset into VRAM of the tilemap
 * @param {number} [opts.tileBaseByte=0]     byte offset into VRAM of tile 0
 * @param {2|4|8} [opts.bpp=4]
 * @param {number} [opts.mapWidth=32]        tiles across (32 or 64)
 * @param {number} [opts.mapHeight=32]       tiles down (32 or 64)
 * @returns {{ width:number, height:number, png:Buffer, mapWidth:number, mapHeight:number, bpp:number, note:string }}
 */
export function renderSnesTilemap(vram, cgramColors, opts = {}) {
  const bpp = opts.bpp ?? 4;
  const tileBytes = BPP_TILE_BYTES[bpp];
  if (!tileBytes) throw new Error(`SNES bpp must be 2, 4, or 8 — got ${bpp}`);
  const tilemapBase = opts.tilemapBaseByte ?? 0;
  const tileBase = opts.tileBaseByte ?? 0;
  const mapW = opts.mapWidth ?? 32;
  const mapH = opts.mapHeight ?? 32;
  // Colors per sub-palette: 2bpp=4, 4bpp=16, 8bpp=256.
  const paletteSize = 1 << bpp;
  const W = mapW * 8;
  const H = mapH * 8;
  const png = new PNG({ width: W, height: H });

  // SNES tilemaps over 32 wide/tall are split into 32×32 screens arranged
  // left-to-right then top-to-bottom. Compute the VRAM entry offset for a
  // given (col,row) accounting for that screen layout.
  const screensX = mapW > 32 ? 2 : 1;
  const screenEntries = 32 * 32; // entries per 32×32 screen

  for (let row = 0; row < mapH; row++) {
    for (let col = 0; col < mapW; col++) {
      const scrX = col >> 5;       // which 32-col screen
      const scrY = row >> 5;       // which 32-row screen
      const screenIndex = scrY * screensX + scrX;
      const inX = col & 31;
      const inY = row & 31;
      const entryIndex = screenIndex * screenEntries + inY * 32 + inX;
      const eo = tilemapBase + entryIndex * 2;
      const word = vram[eo] | (vram[eo + 1] << 8);
      const tileIdx = word & 0x3FF;
      const palNum = (word >> 10) & 0x7;
      const hFlip = !!(word & 0x4000);
      const vFlip = !!(word & 0x8000);
      const tileOff = tileBase + tileIdx * tileBytes;
      const tile = decodeSnesTile(vram.subarray(tileOff, tileOff + tileBytes), bpp);
      const palBase = palNum * paletteSize;
      for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 8; x++) {
          const sy = vFlip ? 7 - y : y;
          const sx = hFlip ? 7 - x : x;
          const ci = tile[sy][sx];
          const c = cgramColors[palBase + ci] || { r: 0, g: 0, b: 0 };
          const px = col * 8 + x;
          const py = row * 8 + y;
          const o = (py * W + px) * 4;
          png.data[o + 0] = c.r;
          png.data[o + 1] = c.g;
          png.data[o + 2] = c.b;
          png.data[o + 3] = 0xFF;
        }
      }
    }
  }
  return {
    width: W,
    height: H,
    png: PNG.sync.write(png),
    mapWidth: mapW,
    mapHeight: mapH,
    bpp,
    note: `${mapW}×${mapH}-tile BG map from VRAM byte offset 0x${tilemapBase.toString(16)} ` +
      `(${bpp}bpp tiles at 0x${tileBase.toString(16)}). SNES PPU regs aren't readable from snes9x, ` +
      `so tilemapBase/tileBase/bpp/mapSize are assumptions (Mode 1 BG1 defaults) — override per your game. ` +
      `Scroll is NOT applied; the visible window is a 256×224 sub-region.`,
  };
}

/**
 * Enumerate the distinct tile indices referenced by a SNES BG tilemap.
 * @param {Uint8Array} vram 64 KB
 * @param {object} opts { tilemapBaseByte=0, mapWidth=32, mapHeight=32 }
 * @returns {{ used:number[], count:number, mapWidth:number, mapHeight:number }}
 */
export function snesTilemapUsage(vram, opts = {}) {
  const tilemapBase = opts.tilemapBaseByte ?? 0;
  const mapW = opts.mapWidth ?? 32;
  const mapH = opts.mapHeight ?? 32;
  const screensX = mapW > 32 ? 2 : 1;
  const screenEntries = 32 * 32;
  const used = new Set();
  for (let row = 0; row < mapH; row++) {
    for (let col = 0; col < mapW; col++) {
      const scrX = col >> 5, scrY = row >> 5;
      const screenIndex = scrY * screensX + scrX;
      const entryIndex = screenIndex * screenEntries + (row & 31) * 32 + (col & 31);
      const eo = tilemapBase + entryIndex * 2;
      used.add((vram[eo] | (vram[eo + 1] << 8)) & 0x3FF);
    }
  }
  const arr = [...used].sort((a, b) => a - b);
  return { used: arr, count: arr.length, mapWidth: mapW, mapHeight: mapH };
}
