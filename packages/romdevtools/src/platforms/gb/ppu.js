// Game Boy / Game Boy Color PPU helpers. Mirrors the shape of
// src/platforms/nes/ppu.js + src/platforms/sms/vdp.js.
//
// Tile layout:
//   GB tiles are 2bpp interleaved: 16 bytes per 8x8 tile, organized as
//   8 rows × 2 bytes/row. The two bytes per row form the two bitplanes.
//   Tile pixel value 0..3 indexes a 4-entry palette.
//
// VRAM layout (DMG = 8 KB at $8000-$9FFF; CGB = 16 KB with bank-switch):
//   $8000-$8FFF: 256 tiles (unsigned indexing — used by sprites + optionally BG)
//   $8800-$97FF: 256 tiles (signed indexing — overlaps $8800-$8FFF; the
//                "lower half" of unsigned set + 128 tiles above it)
//   $9800-$9BFF: BG tile map 0 (32×32 = 1024 bytes of tile indices)
//   $9C00-$9FFF: BG tile map 1 (32×32 = 1024 bytes)
//
// Palette:
//   DMG: BGP/OBP0/OBP1 each pack 4 × 2-bit shade indices in one byte.
//   GBC: 64 bytes of BGR555 palette RAM each for BG + OBJ (8 palettes × 4 colors).

import { PNG } from "pngjs";

// ─── DMG palette decoders ──────────────────────────────────────────

/** 4-shade greenish-tinted DMG palette (close to original LCD colors). */
export const DMG_PALETTE = [
  [0x9B, 0xBC, 0x0F], // lightest
  [0x8B, 0xAC, 0x0F],
  [0x30, 0x62, 0x30],
  [0x0F, 0x38, 0x0F], // darkest
];

/** Plain grayscale alternative (Pocket / Super Game Boy-ish). */
export const DMG_PALETTE_GRAYSCALE = [
  [0xFF, 0xFF, 0xFF],
  [0xAA, 0xAA, 0xAA],
  [0x55, 0x55, 0x55],
  [0x00, 0x00, 0x00],
];

/**
 * Decode a DMG palette byte into 4 RGB triples.
 * Format: bits 0-1 = color 0 (lowest plane bits), bits 2-3 = color 1, etc.
 *
 * @param {number} bgp DMG palette register byte
 * @param {[number, number, number][]} [shades] master 4-shade palette (default DMG green)
 * @returns {[number, number, number][]} 4 RGB triples in tile-pixel-value order
 */
export function decodeDmgPaletteByte(bgp, shades = DMG_PALETTE) {
  return [
    shades[bgp & 0x03],
    shades[(bgp >> 2) & 0x03],
    shades[(bgp >> 4) & 0x03],
    shades[(bgp >> 6) & 0x03],
  ];
}

// ─── GBC palette decoders ──────────────────────────────────────────

/**
 * Decode one GBC palette word (2 bytes LE) into an RGB triple.
 * Format: bbbbbggg ggrrrrrr (15-bit BGR555).
 */
export function gbcCramWordToRgb(lo, hi) {
  const word = lo | (hi << 8);
  const r5 = word & 0x1F;
  const g5 = (word >> 5) & 0x1F;
  const b5 = (word >> 10) & 0x1F;
  const expand = (v) => (v << 3) | (v >> 2);
  return [expand(r5), expand(g5), expand(b5)];
}

/**
 * Decode 64 bytes of GBC palette RAM into 8 palettes × 4 colors.
 * Returns a flat array of 32 {index, r, g, b, rawWord} entries
 * (matching the inspectPalette generic shape).
 */
export function decodeGbcPalette(palData) {
  const out = [];
  for (let i = 0; i < 32; i++) {
    const lo = palData[i * 2];
    const hi = palData[i * 2 + 1];
    const [r, g, b] = gbcCramWordToRgb(lo, hi);
    out.push({ index: i, r, g, b, rawWord: lo | (hi << 8) });
  }
  return out;
}

/**
 * Render a GBC palette swatch PNG (8 rows × 4 cols × N px cell).
 */
export function renderGbcPaletteSwatch(palData) {
  const colors = decodeGbcPalette(palData);
  const cell = 16;
  const cols = 4;
  const rows = 8;
  const w = cols * cell;
  const h = rows * cell;
  const png = new PNG({ width: w, height: h });
  for (let i = 0; i < 32; i++) {
    const cx = (i % 4) * cell;
    const cy = Math.floor(i / 4) * cell;
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

/**
 * Render a DMG palette swatch — 3 rows × 4 cols (BGP, OBP0, OBP1).
 */
export function renderDmgPaletteSwatch(bgp, obp0, obp1, shades = DMG_PALETTE) {
  const cell = 24;
  const w = 4 * cell;
  const h = 3 * cell;
  const png = new PNG({ width: w, height: h });
  const rows = [
    decodeDmgPaletteByte(bgp, shades),
    decodeDmgPaletteByte(obp0, shades),
    decodeDmgPaletteByte(obp1, shades),
  ];
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 4; col++) {
      const [r, g, b] = rows[row][col];
      for (let y = 0; y < cell; y++) {
        for (let x = 0; x < cell; x++) {
          const o = ((row * cell + y) * w + (col * cell + x)) * 4;
          png.data[o + 0] = r;
          png.data[o + 1] = g;
          png.data[o + 2] = b;
          png.data[o + 3] = 0xff;
        }
      }
    }
  }
  return PNG.sync.write(png);
}

// ─── Tile decoder + tilesheet renderer ─────────────────────────────

/**
 * Decode one GB 2bpp-interleaved tile (16 bytes) into 64 pixel indices.
 *
 *   row N: lo = vram[off + N*2 + 0], hi = vram[off + N*2 + 1]
 *   pixel x in row N: ((lo >> (7-x)) & 1) | (((hi >> (7-x)) & 1) << 1)
 */
export function decodeGbTile(buf, offset) {
  const out = new Uint8Array(64);
  for (let y = 0; y < 8; y++) {
    const lo = buf[offset + y * 2];
    const hi = buf[offset + y * 2 + 1];
    for (let x = 0; x < 8; x++) {
      const bit = 7 - x;
      out[y * 8 + x] = ((lo >> bit) & 1) | (((hi >> bit) & 1) << 1);
    }
  }
  return out;
}

/**
 * Render a tile region as a 16×N tilesheet PNG.
 *
 * @param {Uint8Array} vram   tile bytes (typically full $8000-$97FF or a slice)
 * @param {[number,number,number][]} [palette] 4 RGB triples (default DMG green)
 * @param {number} [tileCount] how many tiles to render (default: floor(vram.length / 16))
 */
export function renderGbTilesheet(vram, palette, tileCount) {
  const pal = palette ?? DMG_PALETTE;
  const total = tileCount ?? Math.floor(vram.length / 16);
  const cols = 16;
  const rows = Math.max(1, Math.ceil(total / cols));
  const w = cols * 8;
  const h = rows * 8;
  const png = new PNG({ width: w, height: h });
  const [br, bg, bb] = pal[0];
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i + 0] = br;
    png.data[i + 1] = bg;
    png.data[i + 2] = bb;
    png.data[i + 3] = 0xff;
  }
  for (let t = 0; t < total; t++) {
    const pixels = decodeGbTile(vram, t * 16);
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
  return { width: w, height: h, png: PNG.sync.write(png), tileCount: total };
}

// ─── OAM decoder ───────────────────────────────────────────────────

/**
 * Decode OAM (160 bytes = 40 sprites × 4). Layout per sprite:
 *   byte 0: Y position (actual screen Y = byte - 16)
 *   byte 1: X position (actual screen X = byte - 8)
 *   byte 2: tile index (always unsigned; for 8x16 mode, low bit forced to 0)
 *   byte 3: attributes
 *     bit 0-2: GBC palette index
 *     bit 3: GBC VRAM bank
 *     bit 4: DMG palette (0 = OBP0, 1 = OBP1)
 *     bit 5: X flip
 *     bit 6: Y flip
 *     bit 7: priority (0 = above BG, 1 = behind BG colors 1-3)
 *
 * Returns array of {slot, x, y, tile, attr, ...flags, visible}.
 */
export function decodeGbOam(oam) {
  const sprites = [];
  for (let i = 0; i < 40; i++) {
    const o = i * 4;
    const rawY = oam[o + 0];
    const rawX = oam[o + 1];
    const tile = oam[o + 2];
    const attr = oam[o + 3];
    const x = (rawX - 8) & 0xFF;
    const y = (rawY - 16) & 0xFF;
    sprites.push({
      slot: i,
      x, y, tile,
      // DMG fields
      dmgPalette: (attr >> 4) & 0x01,         // 0 = OBP0, 1 = OBP1
      // GBC fields
      gbcPalette: attr & 0x07,
      gbcVramBank: (attr >> 3) & 0x01,
      flipX: !!((attr >> 5) & 0x01),
      flipY: !!((attr >> 6) & 0x01),
      priority: (attr >> 7) & 0x01,
      // Visible if either fully on-screen or partially overlapping screen.
      // The hardware threshold: rawY=0 or rawY>=160 = fully hidden.
      visible: rawY !== 0 && rawY < 160,
      raw: { byte0: rawY, byte1: rawX, byte2: tile, byte3: attr },
    });
  }
  return sprites;
}

// ─── LCDC decode ───────────────────────────────────────────────────

/**
 * Decode the LCDC ($FF40) register byte.
 *
 *   bit 0: BG/Window display on
 *   bit 1: Sprite display on
 *   bit 2: Sprite size (0 = 8x8, 1 = 8x16)
 *   bit 3: BG tile map area (0 = $9800, 1 = $9C00)
 *   bit 4: BG/Window tile data area (0 = $8800 signed, 1 = $8000 unsigned)
 *   bit 5: Window display on
 *   bit 6: Window tile map area (0 = $9800, 1 = $9C00)
 *   bit 7: LCD enable
 */
export function decodeLcdc(lcdc) {
  return {
    hex: "0x" + lcdc.toString(16).toUpperCase().padStart(2, "0"),
    bgEnable: !!(lcdc & 0x01),
    spritesEnable: !!(lcdc & 0x02),
    spriteSize8x16: !!(lcdc & 0x04),
    bgTileMapBase: (lcdc & 0x08) ? "$9C00" : "$9800",
    bgTileMapBaseDec: (lcdc & 0x08) ? 0x9C00 : 0x9800,
    bgTileDataMode: (lcdc & 0x10) ? "8000_unsigned" : "8800_signed",
    bgTileDataBase: (lcdc & 0x10) ? "$8000" : "$8800",
    bgTileDataBaseDec: (lcdc & 0x10) ? 0x8000 : 0x8800,
    windowEnable: !!(lcdc & 0x20),
    windowTileMapBase: (lcdc & 0x40) ? "$9C00" : "$9800",
    lcdEnable: !!(lcdc & 0x80),
  };
}

// ─── Live snapshots ────────────────────────────────────────────────

/**
 * Read live palette state from the running emulator + return the
 * generic {colors, png} shape used by inspectPalette.
 */
export function snapshotPalette(host, platform /* "gb" | "gbc" */) {
  if (platform === "gbc") {
    // Check via the gb_io region — BGPI ($FF68) / OBPI ($FF6A) presence is
    // implicit; we just read both palette RAM tables.
    const bgpData = host.readMemory("gb_bgpdata", 0, 64);
    const objpData = host.readMemory("gb_objpdata", 0, 64);
    const bgColors = decodeGbcPalette(bgpData).map((c) => ({ ...c, kind: "bg" }));
    const objColors = decodeGbcPalette(objpData).map((c, i) => ({ ...c, index: 32 + i, kind: "obj" }));
    const png = renderGbcPaletteSwatch(bgpData); // BG palette only for now; sprite palette via separate render
    return { colors: [...bgColors, ...objColors], png };
  }
  // DMG mode: read BGP/OBP0/OBP1 from gb_io ($FF47/48/49).
  const io = host.readMemory("gb_io", 0, 0x80);
  const bgp = io[0x47];
  const obp0 = io[0x48];
  const obp1 = io[0x49];
  const decode = (byte, palName, kindOffset) => decodeDmgPaletteByte(byte).map(([r, g, b], i) => ({
    index: kindOffset + i,
    r, g, b,
    rawWord: byte,
    paletteName: palName,
    paletteEntryIndex: i,
  }));
  return {
    colors: [
      ...decode(bgp,  "BGP",  0),
      ...decode(obp0, "OBP0", 4),
      ...decode(obp1, "OBP1", 8),
    ],
    png: renderDmgPaletteSwatch(bgp, obp0, obp1),
    raw: { bgp, obp0, obp1 },
  };
}

/**
 * Snapshot live tile data as a tilesheet PNG. Renders the full $8000-$97FF
 * tile region (384 tiles).
 */
export function snapshotPatternTiles(host, platform) {
  const vram = host.readMemory("gb_vram", 0, 0x1800);  // $8000-$97FF = 6 KB = 384 tiles
  // Use a sensible palette: for DMG, decode live BGP; for GBC, use a neutral ramp.
  let palette;
  if (platform === "gbc") {
    palette = [[0xFF,0xFF,0xFF],[0xAA,0xAA,0xAA],[0x55,0x55,0x55],[0x00,0x00,0x00]];
  } else {
    const io = host.readMemory("gb_io", 0, 0x80);
    palette = decodeDmgPaletteByte(io[0x47]);
  }
  return { ...renderGbTilesheet(vram, palette, 384), source: "emulator" };
}

/**
 * Composite live sprites onto a transparent background as a sprite-sheet PNG.
 */
export function snapshotSprites(host, platform) {
  const oam = host.readMemory("gb_oam", 0, 0xA0);
  const io = host.readMemory("gb_io", 0, 0x80);
  const lcdc = decodeLcdc(io[0x40]);
  const sprites = decodeGbOam(oam);
  const vram = host.readMemory("gb_vram", 0, 0x1800);
  // Sprite palette — DMG: OBP0/OBP1. GBC: from gb_objpdata.
  const obp0 = io[0x48];
  const obp1 = io[0x49];
  let getObjPalette;
  if (platform === "gbc") {
    const objpData = host.readMemory("gb_objpdata", 0, 64);
    const cgbColors = decodeGbcPalette(objpData);
    getObjPalette = (s) => {
      const base = s.gbcPalette * 4;
      return [
        [cgbColors[base + 0].r, cgbColors[base + 0].g, cgbColors[base + 0].b],
        [cgbColors[base + 1].r, cgbColors[base + 1].g, cgbColors[base + 1].b],
        [cgbColors[base + 2].r, cgbColors[base + 2].g, cgbColors[base + 2].b],
        [cgbColors[base + 3].r, cgbColors[base + 3].g, cgbColors[base + 3].b],
      ];
    };
  } else {
    getObjPalette = (s) => decodeDmgPaletteByte(s.dmgPalette ? obp1 : obp0);
  }

  const width = 256;
  const height = 256;
  const png = new PNG({ width, height });
  // Background: dark gray so transparent (color 0) sprites are visible
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i + 0] = 0x22;
    png.data[i + 1] = 0x22;
    png.data[i + 2] = 0x22;
    png.data[i + 3] = 0xff;
  }

  const spriteHeight = lcdc.spriteSize8x16 ? 16 : 8;
  for (const s of sprites) {
    if (!s.visible) continue;
    const pal = getObjPalette(s);
    let tileIdx = lcdc.spriteSize8x16 ? (s.tile & 0xFE) : s.tile;
    for (let row = 0; row < (lcdc.spriteSize8x16 ? 2 : 1); row++) {
      const tileOff = (tileIdx + row) * 16;
      if (tileOff + 16 > vram.length) continue;
      const pixels = decodeGbTile(vram, tileOff);
      for (let py = 0; py < 8; py++) {
        for (let px = 0; px < 8; px++) {
          const srcPx = s.flipX ? 7 - px : px;
          const srcPy = s.flipY ? (7 - py) + (row && lcdc.spriteSize8x16 ? -8 : 0) : py;
          const pi = pixels[srcPy * 8 + srcPx];
          if (pi === 0) continue; // sprite color 0 = transparent
          const dy = s.y + row * 8 + py;
          const dx = s.x + px;
          if (dx < 0 || dx >= width || dy < 0 || dy >= height) continue;
          const [r, g, b] = pal[pi];
          const o = (dy * width + dx) * 4;
          png.data[o + 0] = r;
          png.data[o + 1] = g;
          png.data[o + 2] = b;
          png.data[o + 3] = 0xff;
        }
      }
    }
  }

  return {
    sprites,
    lcdc,
    spriteHeight,
    png: PNG.sync.write(png),
    width,
    height,
  };
}

/**
 * Composite the live BG tile map into a 256×256 PNG — the canonical
 * "what would the BG layer render right now if you took SCY/SCX out
 * of the equation" snapshot. Same shape as NES snapshotNametable.
 *
 * BG tile map is 32×32 tile cells. Base depends on LCDC bit 3:
 *   LCDC.3 = 0 → map at $9800 (VRAM offset $1800)
 *   LCDC.3 = 1 → map at $9C00 (VRAM offset $1C00)
 *
 * BG tile data base depends on LCDC bit 4:
 *   LCDC.4 = 0 → "8800 method": signed index from $9000 base. Tile -128..-1
 *                live at $8800..$8FFF; tile 0..127 at $9000..$97FF.
 *   LCDC.4 = 1 → "8000 method": unsigned index 0..255 from $8000 base.
 *
 * Window vs BG: this renders the BG map only. The Window has its own
 * map base (LCDC.6) but is positioned by WX/WY and overlays the BG.
 * For agent debugging "did my BG write land?" the BG map is what
 * matters; opts.window=true overrides to render the Window map base
 * instead.
 *
 * Palette: DMG = decode BGP. GBC = use a neutral 4-shade ramp (real
 * CGB BG attribute support would require reading VBK=1 attribute map
 * and the BCPS palettes per cell; deferred until someone asks).
 *
 * @param {object} host
 * @param {{which?: 0|1, window?: boolean, platform?: "gb"|"gbc"}} [opts]
 *        which: 0 = $9800 (default), 1 = $9C00. window=true overrides
 *        which to follow LCDC.6 (the Window map base).
 */
export function snapshotBackgroundMap(host, opts = {}) {
  const platform = opts.platform || "gb";
  const vram = host.readMemory("gb_vram", 0, 0x2000);  // full $8000-$9FFF
  const io = host.readMemory("gb_io", 0, 0x80);
  const lcdc = io[0x40];
  const lcdcDecoded = decodeLcdc(lcdc);

  // Pick map base. `which` is an explicit override; `window` follows
  // LCDC.6; neither set → follow LCDC.3 (the BG default).
  let mapBaseAbs;
  if (opts.window) {
    mapBaseAbs = (lcdc & 0x40) ? 0x9C00 : 0x9800;
  } else if (typeof opts.which === "number") {
    mapBaseAbs = opts.which === 1 ? 0x9C00 : 0x9800;
  } else {
    mapBaseAbs = (lcdc & 0x08) ? 0x9C00 : 0x9800;
  }
  const mapBaseVramOff = mapBaseAbs - 0x8000;

  // Pick tile-data addressing mode.
  const unsignedMode = !!(lcdc & 0x10);

  // Palette: DMG uses BGP; GBC fall back to neutral ramp.
  const palette = platform === "gbc"
    ? [[0xFF,0xFF,0xFF],[0xAA,0xAA,0xAA],[0x55,0x55,0x55],[0x00,0x00,0x00]]
    : decodeDmgPaletteByte(io[0x47]);

  const W = 256, H = 256;
  const png = new PNG({ width: W, height: H });
  // Background fill — palette colour 0.
  const [br, bg, bb] = palette[0];
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i + 0] = br;
    png.data[i + 1] = bg;
    png.data[i + 2] = bb;
    png.data[i + 3] = 0xFF;
  }

  for (let row = 0; row < 32; row++) {
    for (let col = 0; col < 32; col++) {
      const rawIndex = vram[mapBaseVramOff + row * 32 + col];
      // Resolve to a VRAM offset where the tile's 16 bytes live.
      let tileVramOff;
      if (unsignedMode) {
        // base $8000 (offset 0), unsigned 0..255
        tileVramOff = rawIndex * 16;
      } else {
        // base $9000 (offset $1000), signed -128..+127
        const signed = (rawIndex < 0x80) ? rawIndex : (rawIndex - 0x100);
        tileVramOff = 0x1000 + signed * 16;
      }
      const pixels = decodeGbTile(vram, tileVramOff);
      const tx = col * 8;
      const ty = row * 8;
      for (let py = 0; py < 8; py++) {
        for (let px = 0; px < 8; px++) {
          const pi = pixels[py * 8 + px];
          const [r, g, b] = palette[pi] ?? [0, 0, 0];
          const o = ((ty + py) * W + (tx + px)) * 4;
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
    mapBase: "0x" + mapBaseAbs.toString(16).toUpperCase(),
    mode: unsignedMode ? "8000_unsigned" : "8800_signed",
    lcdc: lcdcDecoded,
    scy: io[0x42],
    scx: io[0x43],
    note: "BG map only (no Window overlay). Scroll registers SCY/SCX shown but NOT applied to the composite — the PNG is the full 256×256 BG plane; only the 160×144 region at (SCX, SCY) is what the LCD shows.",
  };
}

// ─── SM83 CPU state decoder ────────────────────────────────────────

/**
 * Decode the 18-byte gb_cpu_regs snapshot (see cpu.h's cpu_snapshot()
 * implementation for the layout).
 */
export function decodeSm83State(bytes) {
  const u16 = (off) => bytes[off] | (bytes[off + 1] << 8);
  const pc = u16(0);
  const sp = u16(2);
  const a = bytes[4];
  const f = bytes[5];
  const b = bytes[6], c = bytes[7];
  const d = bytes[8], e = bytes[9];
  const h = bytes[10], l = bytes[11];
  const ime = bytes[12];
  const halt = bytes[13];
  return {
    pc,
    sp,
    registers: {
      A: a, F: f,
      B: b, C: c,
      D: d, E: e,
      H: h, L: l,
      AF: (a << 8) | f,
      BC: (b << 8) | c,
      DE: (d << 8) | e,
      HL: (h << 8) | l,
    },
    flags: {
      Z: !!(f & 0x80),
      N: !!(f & 0x40),
      H: !!(f & 0x20),
      C: !!(f & 0x10),
      raw: "0x" + f.toString(16).toUpperCase().padStart(2, "0"),
    },
    interrupts: {
      ime: !!ime,
      halted: !!halt,
    },
  };
}
