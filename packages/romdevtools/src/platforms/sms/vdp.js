// SMS / Game Gear VDP helpers. Mirrors the shape of src/platforms/nes/ppu.js.
//
// VDP layout (SMS Mode 4, the only mode any real cartridge uses):
//   VRAM 16 KB
//     $0000-$3FFF — entire address space. Conventional layout:
//       Tiles      $0000-$3FFF (448 tiles × 32 bytes; tile 0..) — but the
//                  BG tile-data table base is set via VDP reg 4 (bits 2-1),
//                  and the SPRITE tile-data table base is set via VDP reg 6
//                  (bit 2).
//     Name table   — typically $3800-$3EFF (set via VDP reg 2)
//     Sprite attribute table (SAT) — typically $3F00-$3FFF (set via VDP reg 5)
//
//   CRAM 32 B (SMS) — 32 entries × 6-bit BGR (0BGRG R, two bits per channel)
//   CRAM 64 B (GG)  — 32 entries × 12-bit BGR (low byte = ----RRRR, high = ----BBBBGGGG... well actually 0000BBBB GGGGRRRR)
//   VDP regs    — 11 registers used in mode 4
//   SAT format  — y[64], then x/tile pairs ([0x80..]: x0,n0, x1,n1, ...)

import { PNG } from "pngjs";

// ─── Palette decoders ──────────────────────────────────────────────

/**
 * Decode a single SMS CRAM byte to an RGB triple. SMS uses 6-bit color:
 *   bits 0-1: R (2 bits)
 *   bits 2-3: G
 *   bits 4-5: B
 *   bits 6-7: unused
 *
 * Each 2-bit channel expands to 8 bits by replicating the pattern
 * (0=0x00, 1=0x55, 2=0xAA, 3=0xFF — a clean 2→8 expansion).
 *
 * @param {number} byte
 * @returns {[number, number, number]}
 */
export function smsCramByteToRgb(byte) {
  const r2 = byte & 0x03;
  const g2 = (byte >> 2) & 0x03;
  const b2 = (byte >> 4) & 0x03;
  const expand = (v) => (v << 6) | (v << 4) | (v << 2) | v;
  return [expand(r2), expand(g2), expand(b2)];
}

/**
 * Decode a Game Gear CRAM word (2 bytes, little-endian) to RGB.
 * Format:
 *   byte 0: GGGGRRRR
 *   byte 1: ----BBBB
 * Each 4-bit channel → 8-bit by replicating.
 *
 * @param {number} lo
 * @param {number} hi
 * @returns {[number, number, number]}
 */
export function ggCramWordToRgb(lo, hi) {
  const r4 = lo & 0x0F;
  const g4 = (lo >> 4) & 0x0F;
  const b4 = hi & 0x0F;
  const expand = (v) => (v << 4) | v;
  return [expand(r4), expand(g4), expand(b4)];
}

/**
 * Decode the full 32-byte SMS CRAM into 32 RGB entries.
 * Entry 0..15 = BG palette; 16..31 = sprite palette (entry 0 = transparent).
 *
 * @param {Uint8Array} cram  32 bytes
 * @returns {{ index: number, r: number, g: number, b: number, rawWord: number }[]}
 */
export function decodeSmsCram(cram) {
  const out = [];
  for (let i = 0; i < 32; i++) {
    const [r, g, b] = smsCramByteToRgb(cram[i]);
    out.push({ index: i, r, g, b, rawWord: cram[i] });
  }
  return out;
}

/**
 * Decode the full 64-byte GG CRAM into 32 RGB entries.
 *
 * @param {Uint8Array} cram  64 bytes
 */
export function decodeGgCram(cram) {
  const out = [];
  for (let i = 0; i < 32; i++) {
    const lo = cram[i * 2];
    const hi = cram[i * 2 + 1];
    const [r, g, b] = ggCramWordToRgb(lo, hi);
    out.push({ index: i, r, g, b, rawWord: lo | (hi << 8) });
  }
  return out;
}

/**
 * Render a CRAM swatch as a 16×2 grid PNG (BG row + sprite row), 16 px per cell.
 *
 * @param {Uint8Array} cram
 * @param {"sms" | "gg"} platform
 * @returns {Buffer} PNG bytes
 */
export function renderCramSwatchPng(cram, platform) {
  const colors = platform === "gg" ? decodeGgCram(cram) : decodeSmsCram(cram);
  const cell = 16;
  const cols = 16;
  const rows = 2;
  const w = cols * cell;
  const h = rows * cell;
  const png = new PNG({ width: w, height: h });
  for (let i = 0; i < colors.length; i++) {
    const cx = (i % 16) * cell;
    const cy = Math.floor(i / 16) * cell;
    const { r, g, b } = colors[i];
    for (let y = 0; y < cell; y++) {
      for (let x = 0; x < cell; x++) {
        const o = ((cy + y) * w + (cx + x)) * 4;
        png.data[o + 0] = r;
        png.data[o + 1] = g;
        png.data[o + 2] = b;
        png.data[o + 3] = 0xff;
      }
    }
  }
  return PNG.sync.write(png);
}

// ─── Tile decoder + pattern-table render ───────────────────────────

/**
 * Decode a single SMS 4bpp interleaved tile (32 bytes) into 64 pixel
 * indices (0..15).
 *
 * SMS tile encoding: 32 bytes per 8×8 tile, organized as 8 rows × 4 bytes,
 * with each byte being one plane of that row. Plane order is plane0, plane1,
 * plane2, plane3 within each row (interleaved).
 *
 * @param {Uint8Array} buf
 * @param {number} offset
 * @returns {Uint8Array} 64 bytes
 */
export function decodeSmsTile(buf, offset) {
  const out = new Uint8Array(64);
  for (let y = 0; y < 8; y++) {
    const p0 = buf[offset + y * 4 + 0];
    const p1 = buf[offset + y * 4 + 1];
    const p2 = buf[offset + y * 4 + 2];
    const p3 = buf[offset + y * 4 + 3];
    for (let x = 0; x < 8; x++) {
      const b = 7 - x;
      const pix = ((p0 >> b) & 1)
                | (((p1 >> b) & 1) << 1)
                | (((p2 >> b) & 1) << 2)
                | (((p3 >> b) & 1) << 3);
      out[y * 8 + x] = pix;
    }
  }
  return out;
}

/**
 * Render a chunk of SMS tile data as a PNG sheet, 16 tiles per row.
 *
 * @param {Uint8Array} vram      VRAM bytes (the tile region of)
 * @param {Uint8Array} [paletteRgb]  16 RGB triples; default = monotone ramp
 * @param {number} [tileCount]   how many tiles to render (default: floor(vram.length/32))
 * @returns {{ width: number, height: number, png: Buffer, tileCount: number }}
 */
export function renderSmsTilesheet(vram, paletteRgb, tileCount) {
  const totalTiles = tileCount ?? Math.floor(vram.length / 32);
  const cols = 16;
  const rows = Math.max(1, Math.ceil(totalTiles / cols));
  const w = cols * 8;
  const h = rows * 8;
  const pal = paletteRgb ?? Array.from({ length: 16 }, (_, i) => {
    const v = Math.round((i * 255) / 15);
    return [v, v, v];
  });
  const png = new PNG({ width: w, height: h });
  // Clear with palette[0].
  const [br, bg, bb] = pal[0];
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i + 0] = br;
    png.data[i + 1] = bg;
    png.data[i + 2] = bb;
    png.data[i + 3] = 0xff;
  }
  for (let t = 0; t < totalTiles; t++) {
    const pixels = decodeSmsTile(vram, t * 32);
    const tx = (t % cols) * 8;
    const ty = Math.floor(t / cols) * 8;
    for (let py = 0; py < 8; py++) {
      for (let px = 0; px < 8; px++) {
        const pi = pixels[py * 8 + px];
        const [r, g, b] = pal[pi] ?? [0, 0, 0];
        const o = ((ty + py) * w + (tx + px)) * 4;
        png.data[o + 0] = r;
        png.data[o + 1] = g;
        png.data[o + 2] = b;
        png.data[o + 3] = 0xff;
      }
    }
  }
  return { width: w, height: h, png: PNG.sync.write(png), tileCount: totalTiles };
}

// ─── VDP register decode ───────────────────────────────────────────

/**
 * Decode the SMS VDP register file (lower 11 bytes of the 16 returned).
 * Returns the active table addresses so callers don't have to redo the
 * shift+mask arithmetic.
 *
 * VDP reg layout (Mode 4):
 *   reg 0  — Mode Control 1
 *   reg 1  — Mode Control 2
 *   reg 2  — Name table base (bits 1-3 → addr bits 11-13; addr = (reg2 & 0x0E) << 10)
 *   reg 3  — Color table base (TMS9918 modes; M4 ignores)
 *   reg 4  — Background tile data base (bit 2 → addr bit 13; addr = (reg4 & 0x04) << 11)
 *   reg 5  — Sprite attribute table base (bits 1-6 → addr bits 7-13; addr = (reg5 & 0x7E) << 7)
 *   reg 6  — Sprite pattern (tile) data base (bit 2 → addr bit 13; addr = (reg6 & 0x04) << 11)
 *   reg 7  — Border color (lower nibble = sprite-palette entry)
 *   reg 8  — Background X scroll
 *   reg 9  — Background Y scroll
 *   reg 10 — Line interrupt counter
 *
 * @param {Uint8Array} regs
 * @returns {object}
 */
export function decodeSmsVdpRegs(regs) {
  const r0 = regs[0], r1 = regs[1], r2 = regs[2], r4 = regs[4];
  const r5 = regs[5], r6 = regs[6], r7 = regs[7], r8 = regs[8], r9 = regs[9];
  return {
    mode1: {
      hex: "0x" + r0.toString(16).toUpperCase().padStart(2, "0"),
      // Common Mode 1 bits:
      bgVerticalScrollLock:   !!(r0 & 0x80), // rows 16-23
      bgHorizontalScrollLock: !!(r0 & 0x40), // cols 24-31
      maskColumn0:            !!(r0 & 0x20),
      lineInterruptEnable:    !!(r0 & 0x10),
      spriteShift:            !!(r0 & 0x08),
      mode4:                  !!(r0 & 0x04),
    },
    mode2: {
      hex: "0x" + r1.toString(16).toUpperCase().padStart(2, "0"),
      displayEnabled:         !!(r1 & 0x40),
      vblankInterruptEnable:  !!(r1 & 0x20),
      mode1Bit:               !!(r1 & 0x10),  // mode select bits across r0/r1
      mode3Bit:               !!(r1 & 0x08),
      spriteSize8x16:         !!(r1 & 0x02),
      spriteMag2x:            !!(r1 & 0x01),
    },
    nameTableBase:     "$" + (((r2 & 0x0E) << 10) >>> 0).toString(16).toUpperCase().padStart(4, "0"),
    nameTableBaseDec:        ((r2 & 0x0E) << 10) >>> 0,
    bgTileDataBase:    "$" + (((r4 & 0x04) << 11) >>> 0).toString(16).toUpperCase().padStart(4, "0"),
    bgTileDataBaseDec:       ((r4 & 0x04) << 11) >>> 0,
    spriteAttrTableBase: "$" + (((r5 & 0x7E) << 7) >>> 0).toString(16).toUpperCase().padStart(4, "0"),
    spriteAttrTableBaseDec:  ((r5 & 0x7E) << 7) >>> 0,
    spriteTileDataBase:  "$" + (((r6 & 0x04) << 11) >>> 0).toString(16).toUpperCase().padStart(4, "0"),
    spriteTileDataBaseDec:   ((r6 & 0x04) << 11) >>> 0,
    borderPaletteEntry: r7 & 0x0F,
    bgScrollX: r8,
    bgScrollY: r9,
  };
}

// ─── Sprite attribute table decode ────────────────────────────────

/**
 * Decode the SMS sprite attribute table (SAT). SAT layout:
 *   $00-$3F: 64 Y bytes (sprite Y position; $D0 = terminator)
 *   $80-$FF: 64 (X, tile-number) pairs
 *
 * Returns visible sprites only (those whose Y entry is not the
 * terminator). Each result: { idx, x, y, tile }.
 *
 * @param {Uint8Array} sat  256 bytes (the $3F00-$3FFF region typically)
 * @returns {{idx:number, x:number, y:number, tile:number}[]}
 */
export function decodeSmsSat(sat) {
  const sprites = [];
  for (let i = 0; i < 64; i++) {
    const y = sat[i];
    if (y === 0xD0) break;  // SAT terminator
    const x = sat[0x80 + i * 2];
    const tile = sat[0x80 + i * 2 + 1];
    sprites.push({ idx: i, x, y: (y + 1) & 0xFF, tile });
  }
  return sprites;
}

/**
 * Render the sprite table as a small JSON-friendly summary + a sprite-
 * sheet PNG (each sprite rendered at its (x,y) position).
 *
 * @param {Uint8Array} vram
 * @param {Uint8Array} sat  the 256-byte SAT
 * @param {[number, number, number][]} spritePalette  16 RGB entries (palette index 16..31 of CRAM)
 * @param {number} spriteTileDataBase  VDP reg 6 derived
 * @param {boolean} spriteSize8x16
 * @returns {{ sprites: ReturnType<typeof decodeSmsSat>, png: Buffer, width: number, height: number }}
 */
export function renderSmsSprites(vram, sat, spritePalette, spriteTileDataBase, spriteSize8x16) {
  const sprites = decodeSmsSat(sat);
  const width = 256;
  const height = 192;
  const png = new PNG({ width, height });
  // Clear transparent (palette index 0 = transparent for sprites).
  // We render a magenta-ish bg so transparency is visible.
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i + 0] = 0x33;
    png.data[i + 1] = 0x00;
    png.data[i + 2] = 0x33;
    png.data[i + 3] = 0xff;
  }
  const spriteHeight = spriteSize8x16 ? 16 : 8;
  for (const s of sprites) {
    const tileIdx = spriteSize8x16 ? (s.tile & 0xFE) : s.tile;
    for (let row = 0; row < (spriteSize8x16 ? 2 : 1); row++) {
      const tileOff = spriteTileDataBase + (tileIdx + row) * 32;
      const pixels = decodeSmsTile(vram, tileOff);
      for (let py = 0; py < 8; py++) {
        for (let px = 0; px < 8; px++) {
          const pi = pixels[py * 8 + px];
          if (pi === 0) continue;  // sprite transparent
          const [r, g, b] = spritePalette[pi] ?? [0, 0, 0];
          const dy = s.y + row * 8 + py;
          const dx = s.x + px;
          if (dx < 0 || dx >= width || dy < 0 || dy >= height) continue;
          const o = (dy * width + dx) * 4;
          png.data[o + 0] = r;
          png.data[o + 1] = g;
          png.data[o + 2] = b;
          png.data[o + 3] = 0xff;
        }
      }
    }
  }
  return { sprites, png: PNG.sync.write(png), width, height, spriteHeight };
}

// ─── Master palette PNG ────────────────────────────────────────────

/**
 * Render the SMS master palette (64 colors — 4×4×4 BGR) as a PNG swatch.
 * Used by getPlatformPalettePng for the dithering pipeline.
 *
 * @returns {Buffer} 8×8 swatch grid PNG, 16 px per cell
 */
export function renderSmsMasterPalettePng() {
  const cell = 16;
  const cols = 8;
  const rows = 8;
  const w = cols * cell;
  const h = rows * cell;
  const png = new PNG({ width: w, height: h });
  for (let i = 0; i < 64; i++) {
    const cx = (i % 8) * cell;
    const cy = Math.floor(i / 8) * cell;
    const [r, g, b] = smsCramByteToRgb(i);
    for (let y = 0; y < cell; y++) {
      for (let x = 0; x < cell; x++) {
        const o = ((cy + y) * w + (cx + x)) * 4;
        png.data[o + 0] = r;
        png.data[o + 1] = g;
        png.data[o + 2] = b;
        png.data[o + 3] = 0xff;
      }
    }
  }
  return PNG.sync.write(png);
}

/**
 * Render the Game Gear master palette as a swatch PNG. GG has 4096 colors
 * (12-bit BGR); we render a 64×64 grid showing every entry.
 */
export function renderGgMasterPalettePng() {
  const cell = 8;
  const cols = 64;
  const rows = 64;
  const w = cols * cell;
  const h = rows * cell;
  const png = new PNG({ width: w, height: h });
  for (let i = 0; i < 4096; i++) {
    const cx = (i % 64) * cell;
    const cy = Math.floor(i / 64) * cell;
    const lo = i & 0xFF;
    const hi = (i >> 8) & 0x0F;
    const [r, g, b] = ggCramWordToRgb(lo, hi);
    for (let y = 0; y < cell; y++) {
      for (let x = 0; x < cell; x++) {
        const o = ((cy + y) * w + (cx + x)) * 4;
        png.data[o + 0] = r;
        png.data[o + 1] = g;
        png.data[o + 2] = b;
        png.data[o + 3] = 0xff;
      }
    }
  }
  return PNG.sync.write(png);
}

/**
 * Read the live SMS palette + return as a generic {index,r,g,b,rawWord}[]
 * shape (matching inspectPalette's NES/SNES/Genesis output).
 *
 * @param {{readMemory(region:string, off:number, len:number): Uint8Array}} host
 * @param {"sms" | "gg"} platform
 */
export function snapshotPalette(host, platform) {
  if (platform === "gg") {
    const cram = host.readMemory("gg_cram", 0, 64);
    return { colors: decodeGgCram(cram), png: renderCramSwatchPng(cram, "gg") };
  }
  const cram = host.readMemory("sms_cram", 0, 32);
  return { colors: decodeSmsCram(cram), png: renderCramSwatchPng(cram, "sms") };
}

/**
 * Snapshot the pattern-tables (all 16 KB of VRAM as 448 tiles).
 *
 * @param {{readMemory: any}} host
 * @returns {{ width, height, png, source: "emulator" }}
 */
export function snapshotPatternTiles(host, platform) {
  const vramRegion = platform === "gg" ? "gg_vram" : "sms_vram";
  const vram = host.readMemory(vramRegion, 0, 0x4000);
  // 448 tiles = 14336 bytes / 32. The remaining ~3KB is typically SAT +
  // name table; we render all 448 (some will be SAT/name-table noise).
  const tileCount = Math.floor(vram.length / 32);
  // Use a neutral palette so noise is visible.
  const pal = Array.from({ length: 16 }, (_, i) => {
    const v = Math.round((i * 255) / 15);
    return [v, v, v];
  });
  return { ...renderSmsTilesheet(vram, pal, tileCount), source: "emulator" };
}

/**
 * Snapshot live sprites — reads VDP regs, CRAM, SAT, VRAM and composites.
 */
export function snapshotSprites(host, platform) {
  const regs = host.readMemory("sms_vdp_regs", 0, 16);
  const decoded = decodeSmsVdpRegs(regs);
  const vramRegion = platform === "gg" ? "gg_vram" : "sms_vram";
  const vram = host.readMemory(vramRegion, 0, 0x4000);
  // SAT lives at spriteAttrTableBase relative to VRAM.
  const satBase = decoded.spriteAttrTableBaseDec;
  const sat = vram.slice(satBase, satBase + 256);
  const { colors } = snapshotPalette(host, platform);
  // Sprite palette = entries 16..31.
  const spritePalette = colors.slice(16).map((c) => [c.r, c.g, c.b]);
  const r = renderSmsSprites(
    vram, sat, spritePalette, decoded.spriteTileDataBaseDec, decoded.mode2.spriteSize8x16,
  );
  return { ...r, vdp: decoded };
}

/**
 * Snapshot the SMS/GG background as a PNG composite of the name table.
 *
 * Mode-4 name table is 32×28 entries of 2 bytes each at nameTableBase:
 *   byte 0: tile index low 8 bits
 *   byte 1: ---pcvhT
 *     bit 0 (T): tile index bit 8 (9-bit tile number, 0..511)
 *     bit 1 (h): horizontal flip
 *     bit 2 (v): vertical flip
 *     bit 3 (c): palette select (0 = BG palette 0..15, 1 = sprite palette 16..31)
 *     bit 4 (p): priority (BG-over-sprite)
 *
 * Tiles are 4bpp planar (decodeSmsTile). The full plane is 256×224 (SMS) —
 * the visible window is 256×192 and horizontal/vertical scroll (regs 8/9)
 * is reported but NOT applied (matches the GB/Genesis BG-map convention).
 *
 * @param {{readMemory: any}} host
 * @param {"sms"|"gg"} platform
 * @returns {{ width:number, height:number, png:Buffer, mapBase:string, rows:number, scrollX:number, scrollY:number, note:string }}
 */
export function snapshotBackgroundMap(host, platform) {
  const regs = host.readMemory("sms_vdp_regs", 0, 16);
  const decoded = decodeSmsVdpRegs(regs);
  const vramRegion = platform === "gg" ? "gg_vram" : "sms_vram";
  const vram = host.readMemory(vramRegion, 0, 0x4000);
  const { colors } = snapshotPalette(host, platform);
  const pal = colors.map((c) => [c.r, c.g, c.b]); // 32 entries (BG 0-15, sprite 16-31)

  const COLS = 32;
  const ROWS = 28; // SMS name table is 32×28 (last 4 rows usually off-screen)
  const W = COLS * 8;
  const H = ROWS * 8;
  const nameBase = decoded.nameTableBaseDec;
  const png = new PNG({ width: W, height: H });

  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      const eo = nameBase + (row * COLS + col) * 2;
      const lo = vram[eo];
      const hi = vram[eo + 1];
      const tile = lo | ((hi & 0x01) << 8);
      const hFlip = !!(hi & 0x02);
      const vFlip = !!(hi & 0x04);
      const palSelect = (hi & 0x08) ? 16 : 0; // sprite vs BG palette bank
      const pixels = decodeSmsTile(vram, tile * 32);
      for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 8; x++) {
          const sy = vFlip ? 7 - y : y;
          const sx = hFlip ? 7 - x : x;
          const ci = pixels[sy * 8 + sx];
          const [r, g, b] = pal[palSelect + ci] ?? [0, 0, 0];
          const o = ((row * 8 + y) * W + (col * 8 + x)) * 4;
          png.data[o + 0] = r;
          png.data[o + 1] = g;
          png.data[o + 2] = b;
          png.data[o + 3] = 0xFF;
        }
      }
    }
  }

  return {
    width: W,
    height: H,
    png: PNG.sync.write(png),
    mapBase: decoded.nameTableBase,
    rows: ROWS,
    scrollX: decoded.bgScrollX,
    scrollY: decoded.bgScrollY,
    note: `${COLS}×${ROWS} name table at ${decoded.nameTableBase} (BG tiles from ${decoded.bgTileDataBase}). ` +
      `Scroll (${decoded.bgScrollX},${decoded.bgScrollY}) is NOT applied — visible window is 256×192.`,
  };
}
