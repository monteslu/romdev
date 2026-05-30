// Atari 7800 MARIA helpers.
//
// MARIA is the 7800's display chip — fundamentally different from the 2600's
// TIA. It reads a "display list" from RAM each scanline, where each entry
// points at a chunk of pixel data + says how to draw it. No tile maps in
// the conventional sense — just lists of (sprite/character) draws per zone.
//
// Memory layout (6502 sees it):
//   $0000-$001F  MARIA + TIA register file (writes only; some MARIA regs)
//   $0020-$003F  MARIA palette + control + scrolling regs
//   $0040-$00FF  zero-page RAM
//   $0100-$01FF  stack
//   $0140-$017F  shadow MARIA regs (writes only)
//   $0180-$01BF  shadow registers (P1C1 etc)
//   $01C0-$01FF  more shadow regs
//   $1800-$27FF  4 KB main RAM
//   $4000-$FFFF  cart ROM
//
// MARIA palette: 8 software palettes × 4 colors. Each color is one byte
// from the 256-color master palette (4 hues × 16 luma sweeps × 4 levels —
// see NTSC master).
//
// memory_ram[65536] (returned via "system_ram") is the full 6502 address
// space — agents read $20-$3F to get MARIA regs, $1800-$27FF for RAM.

import { PNG } from "pngjs";

/**
 * Atari 7800 NTSC master palette — 256 colors arranged as 16 hues × 16
 * luminance levels. The 16 luma levels make sweeps smoother than the
 * 2600's 8. Color byte format: (hue << 4) | lum.
 *
 * This is an approximation of the canonical 7800 palette used by
 * homebrew (matches what prosystem renders).
 */
export const A78_PALETTE = (() => {
  // Approximate NTSC 7800 chart — same hue arrangement as 2600 but with
  // 16 luma levels instead of 8.
  const hues = [
    { r: 0x00, g: 0x00, b: 0x00 },   // 0: grayscale
    { r: 0x40, g: 0x40, b: 0x00 },
    { r: 0x68, g: 0x28, b: 0x00 },
    { r: 0x80, g: 0x18, b: 0x00 },
    { r: 0x84, g: 0x00, b: 0x18 },
    { r: 0x78, g: 0x00, b: 0x58 },
    { r: 0x48, g: 0x00, b: 0x78 },
    { r: 0x14, g: 0x00, b: 0x84 },
    { r: 0x00, g: 0x18, b: 0x88 },
    { r: 0x00, g: 0x2C, b: 0x78 },
    { r: 0x00, g: 0x44, b: 0x54 },
    { r: 0x00, g: 0x54, b: 0x14 },
    { r: 0x14, g: 0x60, b: 0x00 },
    { r: 0x40, g: 0x58, b: 0x00 },
    { r: 0x68, g: 0x48, b: 0x00 },
    { r: 0x70, g: 0x30, b: 0x00 },
  ];
  const out = [];
  for (let h = 0; h < 16; h++) {
    for (let l = 0; l < 16; l++) {
      const base = hues[h];
      const t = l / 15;
      const r = Math.round(base.r * 0.5 + 255 * t * 0.5);
      const g = Math.round(base.g * 0.5 + 255 * t * 0.5);
      const b = Math.round(base.b * 0.5 + 255 * t * 0.5);
      out.push([r, g, b]);
    }
  }
  return out;
})();

/** Atari 7800 color byte → RGB triple. */
export function a78ColorToRgb(byte) {
  return A78_PALETTE[byte & 0xFF];
}

/** Render the 7800 master palette as a 16×16 PNG. */
export function renderA78MasterPalettePng() {
  const cell = 16;
  const w = 16 * cell;
  const h = 16 * cell;
  const png = new PNG({ width: w, height: h });
  for (let i = 0; i < 256; i++) {
    const hue = i >> 4;
    const lum = i & 0x0F;
    const cx = lum * cell;
    const cy = hue * cell;
    const [r, g, b] = A78_PALETTE[i];
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

// ─── MARIA register decode ────────────────────────────────────────

/**
 * Decode MARIA registers from a slice of the 6502 address space (regs
 * live at $0020-$003F). Input: 32-byte buffer starting at $20.
 */
export function decodeMariaRegs(bytes20) {
  const b = bytes20;
  return {
    background: { byte: b[0x00], rgb: a78ColorToRgb(b[0x00]) },
    palette0:   colorTriplet(b, 0x01),   // P0C1, P0C2, P0C3 at $21/22/23
    palette1:   colorTriplet(b, 0x06),   // $26/27/28
    palette2:   colorTriplet(b, 0x0A),   // $2A/2B/2C
    palette3:   colorTriplet(b, 0x0E),   // $2E/2F/30
    palette4:   colorTriplet(b, 0x12),   // $32/33/34
    palette5:   colorTriplet(b, 0x16),   // $36/37/38
    palette6:   colorTriplet(b, 0x1A),   // $3A/3B/3C
    palette7:   colorTriplet(b, 0x1E),   // $3E/3F/00 (P7C3 lives at $40 — caveat)
    ctrl: {
      hex: "0x" + b[0x1C].toString(16).toUpperCase().padStart(2, "0"),
      // CTRL bits: 0=color kill, 1=DMA enable, 2=character control width,
      // 3=border control, 4=kangaroo mode, 5-6=read mode, 7=color burst
      colorKill:       !!(b[0x1C] & 0x80),
      dmaDisable:      !!(b[0x1C] & 0x40),
      characterWidth:  (b[0x1C] & 0x10) ? "2-byte" : "1-byte",
      borderControl:   (b[0x1C] & 0x08) ? "border" : "none",
      kangarooMode:    !!(b[0x1C] & 0x04),
      readMode:        (b[0x1C] >> 1) & 0x01,
      colorBurst:      !!(b[0x1C] & 0x01),
    },
  };
}

function colorTriplet(b, baseOffset) {
  const c1 = b[baseOffset];
  const c2 = b[baseOffset + 1];
  const c3 = b[baseOffset + 2];
  return [
    { byte: c1, rgb: a78ColorToRgb(c1) },
    { byte: c2, rgb: a78ColorToRgb(c2) },
    { byte: c3, rgb: a78ColorToRgb(c3) },
  ];
}

/**
 * Decode the MARIA palette + render a swatch PNG.
 *   8 palettes × 4 colors (color 0 = backgroundColor shared, then P[n]C1/C2/C3).
 */
export function snapshotPalette(host) {
  const ram = host.readMemory("system_ram", 0x0020, 0x20);
  const decoded = decodeMariaRegs(ram);
  const bg = decoded.background;
  const palettes = [
    [bg, ...decoded.palette0],
    [bg, ...decoded.palette1],
    [bg, ...decoded.palette2],
    [bg, ...decoded.palette3],
    [bg, ...decoded.palette4],
    [bg, ...decoded.palette5],
    [bg, ...decoded.palette6],
    [bg, ...decoded.palette7],
  ];
  // Render 8×4 grid.
  const cell = 24;
  const w = 4 * cell;
  const h = 8 * cell;
  const png = new PNG({ width: w, height: h });
  for (let p = 0; p < 8; p++) {
    for (let c = 0; c < 4; c++) {
      const [r, g, b] = palettes[p][c].rgb;
      for (let y = 0; y < cell; y++) {
        for (let x = 0; x < cell; x++) {
          const o = ((p * cell + y) * w + (c * cell + x)) * 4;
          png.data[o + 0] = r;
          png.data[o + 1] = g;
          png.data[o + 2] = b;
          png.data[o + 3] = 0xff;
        }
      }
    }
  }
  // Flatten to generic {index, r, g, b, rawWord}[] (32 entries).
  const colors = [];
  for (let p = 0; p < 8; p++) {
    for (let c = 0; c < 4; c++) {
      const entry = palettes[p][c];
      colors.push({
        index: p * 4 + c,
        r: entry.rgb[0],
        g: entry.rgb[1],
        b: entry.rgb[2],
        rawWord: entry.byte,
        paletteEntry: { palette: p, colorIndex: c },
      });
    }
  }
  return { colors, png: PNG.sync.write(png), regs: decoded };
}

// ─── 6502 CPU state decode (shares format with 2600) ──────────────

export function decodeA78CpuState(b) {
  const pc = b[0] | (b[1] << 8);
  const p = b[5];
  return {
    pc,
    sp: 0x100 | b[6],
    registers: { A: b[2], X: b[3], Y: b[4], P: p, SP: b[6] },
    flags: {
      N: !!(p & 0x80),
      V: !!(p & 0x40),
      B: !!(p & 0x10),
      D: !!(p & 0x08),
      I: !!(p & 0x04),
      Z: !!(p & 0x02),
      C: !!(p & 0x01),
      raw: "0x" + p.toString(16).toUpperCase().padStart(2, "0"),
    },
  };
}
