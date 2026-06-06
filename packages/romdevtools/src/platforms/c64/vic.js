// Commodore 64 VIC-II helpers.
//
// VIC-II is the C64 video chip. Hardware:
//   - Fixed 16-color palette (no programmable colors).
//   - 40×25 text mode by default (320×200 visible).
//   - 8 hardware sprites (MOBs): 24×21 pixels each, multicolor optional.
//   - Char ROM at $D000/$D800 mirror (kernel), or user charset in RAM.
//   - Screen RAM at $0400-$07E7 by default (40×25 = 1000 bytes).
//   - Color RAM at $D800-$DBE7 (lower nibble per char).
//
// Register layout ($D000-$D02E, 47 bytes):
//   $D000-$D00F  sprite 0-7 X/Y pairs (16 bytes)
//   $D010        sprite X high bits   (1 byte)
//   $D011        control register 1   (Y-scroll, 24/25-row, screen on, raster MSB, etc.)
//   $D012        raster line (read = current, write = compare value)
//   $D013-$D014  light pen X/Y
//   $D015        sprite enable
//   $D016        control register 2 (X-scroll, 38/40-col, multicolor)
//   $D017        sprite Y expand
//   $D018        memory pointers (screen-RAM base + char-ROM base)
//   $D019        IRQ status
//   $D01A        IRQ enable
//   $D01B        sprite-BG priority
//   $D01C        sprite multicolor enable
//   $D01D        sprite X expand
//   $D01E        sprite-sprite collision
//   $D01F        sprite-data collision
//   $D020        border color
//   $D021        background color 0
//   $D022-$D024  background colors 1-3
//   $D025-$D026  sprite multicolor 0/1
//   $D027-$D02E  sprite 0-7 colors

import { PNG } from "pngjs";

/**
 * Canonical C64 16-color palette (Pepto-derived sRGB approximations).
 * Index = standard C64 color code (0=black, 1=white, 2=red, ...).
 */
export const C64_PALETTE = [
  [0x00, 0x00, 0x00],  // 0  black
  [0xFF, 0xFF, 0xFF],  // 1  white
  [0x88, 0x39, 0x32],  // 2  red
  [0x67, 0xB6, 0xBD],  // 3  cyan
  [0x8B, 0x3F, 0x96],  // 4  purple
  [0x55, 0xA0, 0x49],  // 5  green
  [0x40, 0x31, 0x8D],  // 6  blue
  [0xBF, 0xCE, 0x72],  // 7  yellow
  [0x8B, 0x54, 0x29],  // 8  orange
  [0x57, 0x42, 0x00],  // 9  brown
  [0xB8, 0x69, 0x62],  // 10 light red
  [0x50, 0x50, 0x50],  // 11 dark gray
  [0x78, 0x78, 0x78],  // 12 medium gray
  [0x94, 0xE0, 0x89],  // 13 light green
  [0x78, 0x69, 0xC4],  // 14 light blue
  [0x9F, 0x9F, 0x9F],  // 15 light gray
];

export const C64_COLOR_NAMES = [
  "black", "white", "red", "cyan", "purple", "green", "blue", "yellow",
  "orange", "brown", "light red", "dark gray", "medium gray", "light green",
  "light blue", "light gray",
];

/** Color code (0-15) → RGB triple. */
export function c64ColorToRgb(idx) {
  return C64_PALETTE[idx & 0x0F];
}

/** Render the 16-color palette as a 16×1-cell PNG (good for getPlatformPalettePng). */
export function renderC64PalettePng() {
  const cell = 24;
  const w = 16 * cell;
  const h = cell;
  const png = new PNG({ width: w, height: h });
  for (let i = 0; i < 16; i++) {
    const [r, g, b] = C64_PALETTE[i];
    for (let y = 0; y < cell; y++) {
      for (let x = 0; x < cell; x++) {
        const o = (y * w + (i * cell + x)) * 4;
        png.data[o + 0] = r;
        png.data[o + 1] = g;
        png.data[o + 2] = b;
        png.data[o + 3] = 0xFF;
      }
    }
  }
  return PNG.sync.write(png);
}

// ─── VIC-II register decode ────────────────────────────────────────

/**
 * Decode VIC-II registers from the 47-byte snapshot at $D000-$D02E.
 * Returns the high-level interpretation an agent needs to reason about
 * what the display is doing right now.
 */
export function decodeViciiRegs(regs) {
  const ctrl1 = regs[0x11];
  const ctrl2 = regs[0x16];
  const memPtr = regs[0x18];
  const rasterHi = (ctrl1 & 0x80) ? 0x100 : 0;
  const rasterLine = rasterHi | regs[0x12];
  // $D018 layout: bits 4-7 = screen-RAM base (×0x400), bits 1-3 = char-base (×0x800).
  // These are RELATIVE to the VIC bank ($DD00 CIA2 selects which 16 KB of
  // RAM VIC sees). For most defaults bank=0 → screen=$0400, char-base=$1000.
  const screenRamBase = ((memPtr >> 4) & 0x0F) * 0x400;
  const charBase      = ((memPtr >> 1) & 0x07) * 0x800;
  return {
    rasterLine,
    rasterIrqLine: (ctrl1 & 0x80 ? 0x100 : 0) | (regs[0x12]), // when written, same byte = compare
    ctrl1: {
      hex: hex2(ctrl1),
      yScroll: ctrl1 & 0x07,
      rows25:  !!(ctrl1 & 0x08),       // 0 = 24 rows, 1 = 25 rows
      screenOn: !!(ctrl1 & 0x10),
      bitmapMode: !!(ctrl1 & 0x20),
      extendedColorMode: !!(ctrl1 & 0x40),
      rasterMsb: !!(ctrl1 & 0x80),
    },
    ctrl2: {
      hex: hex2(ctrl2),
      xScroll: ctrl2 & 0x07,
      cols40:  !!(ctrl2 & 0x08),       // 0 = 38 cols, 1 = 40 cols
      multicolorMode: !!(ctrl2 & 0x10),
    },
    memPointers: {
      hex: hex2(memPtr),
      screenRamBaseInVicBank: "$" + screenRamBase.toString(16).toUpperCase().padStart(4, "0"),
      charBaseInVicBank:      "$" + charBase.toString(16).toUpperCase().padStart(4, "0"),
    },
    borderColor:     { byte: regs[0x20] & 0x0F, name: C64_COLOR_NAMES[regs[0x20] & 0x0F], rgb: c64ColorToRgb(regs[0x20]) },
    backgroundColor: { byte: regs[0x21] & 0x0F, name: C64_COLOR_NAMES[regs[0x21] & 0x0F], rgb: c64ColorToRgb(regs[0x21]) },
    extraBg1: regs[0x22] & 0x0F,
    extraBg2: regs[0x23] & 0x0F,
    extraBg3: regs[0x24] & 0x0F,
    spriteMulticolor0: regs[0x25] & 0x0F,
    spriteMulticolor1: regs[0x26] & 0x0F,
    spriteEnable:      regs[0x15],
    spriteYExpand:     regs[0x17],
    spriteXExpand:     regs[0x1D],
    spriteMulticolor:  regs[0x1C],
    spritePriority:    regs[0x1B],
    irqStatus:         hex2(regs[0x19]),
    irqEnable:         hex2(regs[0x1A]),
    spriteSpriteCol:   hex2(regs[0x1E]),
    spriteDataCol:     hex2(regs[0x1F]),
  };
}

/**
 * Decode the 8 hardware sprites (MOBs) from VIC-II regs in a generic
 * {slot, x, y, ...} shape that matches inspectSprites on other platforms.
 *
 *   X = $D000 + 2N | (($D010 >> N) & 1) << 8     (9-bit X)
 *   Y = $D001 + 2N
 *   color = $D027 + N                            (low nibble)
 *   enabled = ($D015 >> N) & 1
 */
export function decodeSprites(regs) {
  const xMsb = regs[0x10];
  const enable = regs[0x15];
  const yExp = regs[0x17];
  const xExp = regs[0x1D];
  const multi = regs[0x1C];
  const priority = regs[0x1B];
  const out = [];
  for (let i = 0; i < 8; i++) {
    const xLo = regs[i * 2];
    const yLo = regs[i * 2 + 1];
    const x = xLo | (((xMsb >> i) & 1) << 8);
    out.push({
      slot: i,
      x,
      y: yLo,
      tile: null,        // VIC-II sprites don't have a "tile index" — their
                         // pixel data lives at screen[0x3F8 + i] × 64 in RAM.
                         // Agents read screen RAM directly via getPointer().
      palette: null,
      colorByte: regs[0x27 + i] & 0x0F,
      color: { byte: regs[0x27 + i] & 0x0F, name: C64_COLOR_NAMES[regs[0x27 + i] & 0x0F], rgb: c64ColorToRgb(regs[0x27 + i]) },
      multicolor: !!((multi >> i) & 1),
      priority:   ((priority >> i) & 1) ? "behind-bg" : "front",
      xExpand:    !!((xExp >> i) & 1),
      yExpand:    !!((yExp >> i) & 1),
      size: {
        w: ((xExp >> i) & 1) ? 48 : 24,
        h: ((yExp >> i) & 1) ? 42 : 21,
      },
      visible: !!((enable >> i) & 1),
      raw: { byte0: xLo, byte1: yLo, color: regs[0x27 + i] },
    });
  }
  return out;
}

/**
 * Decode a 7-byte 6510 CPU snapshot from c64_cpu_regs.
 *   bytes[0..1] = PC (little-endian)
 *   bytes[2]    = A
 *   bytes[3]    = X
 *   bytes[4]    = Y
 *   bytes[5]    = P (flags)
 *   bytes[6]    = SP
 *
 * Plus the IO port at $0001 (mem_ram[1]) which controls KERNAL/BASIC/CHAR-ROM
 * banking — included by the caller (cpu-state.js) since it lives in main RAM
 * not in the CPU regs themselves.
 */
export function decodeC64CpuState(bytes) {
  const pc = bytes[0] | (bytes[1] << 8);
  const p  = bytes[5];
  return {
    pc,
    sp: 0x0100 | bytes[6],
    registers: { A: bytes[2], X: bytes[3], Y: bytes[4], P: p, SP: bytes[6] },
    flags: {
      N: !!(p & 0x80),
      V: !!(p & 0x40),
      B: !!(p & 0x10),
      D: !!(p & 0x08),
      I: !!(p & 0x04),
      Z: !!(p & 0x02),
      C: !!(p & 0x01),
      raw: hex2(p),
    },
  };
}

function hex2(n) {
  return "0x" + (n & 0xFF).toString(16).toUpperCase().padStart(2, "0");
}

// ─── inspectPalette glue ───────────────────────────────────────────

/**
 * snapshotPalette(host) — pull current VIC-II palette state + render the
 * fixed 16-color palette as a swatch PNG. (Note: C64 palette is hardware-
 * fixed — programs only choose which 16 indices to use, not their RGB.)
 */
export function snapshotPalette(host) {
  const regs = host.readMemory("c64_vic_regs", 0, 0x2F);
  const decoded = decodeViciiRegs(regs);
  const colors = C64_PALETTE.map((rgb, i) => ({
    index: i,
    name: C64_COLOR_NAMES[i],
    r: rgb[0], g: rgb[1], b: rgb[2],
    rawWord: i,
  }));
  return {
    colors,
    png: renderC64PalettePng(),
    current: {
      border: decoded.borderColor,
      background: decoded.backgroundColor,
      extraBg1: { byte: decoded.extraBg1, rgb: c64ColorToRgb(decoded.extraBg1), name: C64_COLOR_NAMES[decoded.extraBg1] },
      extraBg2: { byte: decoded.extraBg2, rgb: c64ColorToRgb(decoded.extraBg2), name: C64_COLOR_NAMES[decoded.extraBg2] },
      extraBg3: { byte: decoded.extraBg3, rgb: c64ColorToRgb(decoded.extraBg3), name: C64_COLOR_NAMES[decoded.extraBg3] },
    },
  };
}

/**
 * snapshotSprites(host) — read VIC-II regs + return the 8 sprites in the
 * generic shape inspectSprites uses across platforms.
 */
export function snapshotSprites(host) {
  const regs = host.readMemory("c64_vic_regs", 0, 0x2F);
  return {
    sprites: decodeSprites(regs),
    vic: decodeViciiRegs(regs),
  };
}
