// Atari 2600 TIA helpers.
//
// The 2600 is unlike everything else this MCP supports: no tile-based BG,
// no separate framebuffer. The CPU + TIA cooperate at *scanline* scope:
//   - TIA has 5 graphics objects: 2 players (8px each), 2 missiles, 1 ball.
//   - Background is the 20-bit "playfield" (PF0/PF1/PF2 registers) drawn
//     as a 20-column 1-bit pattern repeated or reflected across each line.
//   - Color is set via 4 8-bit COLU* registers (P0/P1/PF/BK).
//   - Each frame is composed by the CPU re-writing TIA regs every scanline
//     (the "racing the beam" model).
//
// So "inspectSprites" for the 2600 means decoding the CURRENT TIA register
// snapshot, not a list of OAM entries. The kernel determines what actually
// renders — we report what state the TIA is in at the moment of the snapshot.

import { PNG } from "pngjs";

// ─── NTSC palette ─────────────────────────────────────────────────
// 128 colors arranged as 16 hues × 8 luminances. The TIA color register
// stores (hue << 4) | (lum << 1) — bit 0 is unused.
// Source: standard NTSC palette derivation (Stella's defaults).

/** Convert a TIA color register byte to an RGB triple. */
export function tiaColorToRgb(byte) {
  const hue = (byte >> 4) & 0x0F;
  const lum = (byte >> 1) & 0x07;
  return NTSC_PALETTE[hue * 8 + lum];
}

// NTSC palette — 16 × 8 = 128 entries. Derived from the canonical
// "stella default" / "Atari Age" 2600 NTSC chart.
export const NTSC_PALETTE = (() => {
  // Each hue's brightness sweeps from dark→light. We approximate Stella's
  // values; the exact RGB doesn't matter as long as agents see consistent
  // color identity.
  const hues = [
    { r: 0x00, g: 0x00, b: 0x00 },   // 0: grayscale
    { r: 0x44, g: 0x44, b: 0x00 },   // 1: gold/khaki
    { r: 0x70, g: 0x28, b: 0x00 },   // 2: orange
    { r: 0x84, g: 0x18, b: 0x00 },   // 3: brick red
    { r: 0x88, g: 0x00, b: 0x14 },   // 4: pink/red
    { r: 0x78, g: 0x00, b: 0x5C },   // 5: purple
    { r: 0x48, g: 0x00, b: 0x78 },   // 6: violet
    { r: 0x14, g: 0x00, b: 0x84 },   // 7: blue
    { r: 0x00, g: 0x18, b: 0x88 },   // 8: blue-cyan
    { r: 0x00, g: 0x2C, b: 0x78 },   // 9: cyan
    { r: 0x00, g: 0x44, b: 0x54 },   // A: cyan-green
    { r: 0x00, g: 0x54, b: 0x14 },   // B: green
    { r: 0x14, g: 0x60, b: 0x00 },   // C: yellow-green
    { r: 0x40, g: 0x58, b: 0x00 },   // D: olive
    { r: 0x70, g: 0x48, b: 0x00 },   // E: olive-orange
    { r: 0x70, g: 0x30, b: 0x00 },   // F: brown/orange
  ];
  const out = [];
  for (let h = 0; h < 16; h++) {
    for (let l = 0; l < 8; l++) {
      // Lum 0 = darkest, 7 = brightest. Mix toward black or white at
      // the extremes. The base hue is at lum 4.
      const base = hues[h];
      const t = l / 7;  // 0..1
      // Linear toward white as t→1; toward black as t→0; base color at midpoint.
      const r = Math.round(base.r * 0.5 + 255 * t * 0.5);
      const g = Math.round(base.g * 0.5 + 255 * t * 0.5);
      const b = Math.round(base.b * 0.5 + 255 * t * 0.5);
      out.push([r, g, b]);
    }
  }
  return out;
})();

/**
 * Render the full 128-color NTSC palette as a 16×8 swatch PNG.
 * Use as the -remap target for dithering input images to the TIA's palette.
 */
export function renderNtscPalettePng() {
  const cell = 16;
  const w = 8 * cell;
  const h = 16 * cell;
  const png = new PNG({ width: w, height: h });
  for (let i = 0; i < 128; i++) {
    const hue = i >> 3;
    const lum = i & 7;
    const cx = lum * cell;
    const cy = hue * cell;
    const [r, g, b] = NTSC_PALETTE[i];
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

// ─── TIA snapshot decoder ─────────────────────────────────────────

/**
 * Decode the 32-byte TIA snapshot from a2600_tia_regs (see stella2014
 * patch — TIA::snapshot lays it out). Returns structured fields.
 */
export function decodeTiaSnapshot(b) {
  return {
    vsync: !!(b[0] & 0x02),
    vblank: {
      hex: "0x" + b[1].toString(16).toUpperCase().padStart(2, "0"),
      disable: !!(b[1] & 0x02),
      latch: !!(b[1] & 0x40),
      dump: !!(b[1] & 0x80),
    },
    nusiz0: {
      hex: "0x" + b[2].toString(16).toUpperCase().padStart(2, "0"),
      missileSize: 1 << ((b[2] >> 4) & 0x03),
      playerCopies: nusizCopiesText(b[2] & 0x07),
    },
    nusiz1: {
      hex: "0x" + b[3].toString(16).toUpperCase().padStart(2, "0"),
      missileSize: 1 << ((b[3] >> 4) & 0x03),
      playerCopies: nusizCopiesText(b[3] & 0x07),
    },
    colors: {
      p0:  { byte: b[4], hex: "0x" + b[4].toString(16).toUpperCase().padStart(2, "0"), rgb: tiaColorToRgb(b[4]) },
      p1:  { byte: b[5], hex: "0x" + b[5].toString(16).toUpperCase().padStart(2, "0"), rgb: tiaColorToRgb(b[5]) },
      pf:  { byte: b[6], hex: "0x" + b[6].toString(16).toUpperCase().padStart(2, "0"), rgb: tiaColorToRgb(b[6]) },
      bk:  { byte: b[7], hex: "0x" + b[7].toString(16).toUpperCase().padStart(2, "0"), rgb: tiaColorToRgb(b[7]) },
    },
    ctrlpf: {
      hex: "0x" + b[8].toString(16).toUpperCase().padStart(2, "0"),
      reflect: !!(b[8] & 0x01),
      score: !!(b[8] & 0x02),
      priority: !!(b[8] & 0x04),
      ballSize: 1 << ((b[8] >> 4) & 0x03),
    },
    sprites: {
      p0: {
        graphics: b[14],
        graphicsBin: b[14].toString(2).padStart(8, "0"),
        reflected: !!b[9],
        delayedDraw: !!b[24],
        horizMotion: signedNibble(b[19]),
      },
      p1: {
        graphics: b[15],
        graphicsBin: b[15].toString(2).padStart(8, "0"),
        reflected: !!b[10],
        delayedDraw: !!b[25],
        horizMotion: signedNibble(b[20]),
      },
      missile0: { enabled: !!b[16], horizMotion: signedNibble(b[21]) },
      missile1: { enabled: !!b[17], horizMotion: signedNibble(b[22]) },
      ball:     { enabled: !!b[18], horizMotion: signedNibble(b[23]), delayed: !!b[26] },
    },
    playfield: {
      // PF0 is high-nibble-of-4-bits (only bits 4-7 displayed); PF1 + PF2 are full 8-bit.
      // Width on screen: 20 columns. Bit order: PF0[7..4] left-to-right, PF1[0..7] (reversed!),
      // PF2[7..0] (forward).
      pf0: b[11] & 0x0F,                            // 4-bit
      pf1: b[12],
      pf2: b[13],
      pattern20bit: ((b[11] & 0xF0) >> 4)           // PF0 high nybble
                  | (reverseBits(b[12]) << 4)        // PF1 reversed
                  | (b[13] << 12),                   // PF2 forward
    },
    audio: {
      ch0: { control: b[27], frequency: b[29], volume: (b[31] >> 4) & 0x0F },
      ch1: { control: b[28], frequency: b[30], volume: b[31] & 0x0F },
    },
  };
}

function nusizCopiesText(n) {
  return ({
    0: "1 copy",
    1: "2 copies, close",
    2: "2 copies, medium",
    3: "3 copies, close",
    4: "2 copies, wide",
    5: "double size",
    6: "3 copies, medium",
    7: "quad size",
  })[n] ?? "unknown";
}

function signedNibble(b) {
  // HMP/HMM/HMBL high nibble = signed 4-bit motion (-8..+7).
  const v = (b >> 4) & 0x0F;
  return v >= 8 ? v - 16 : v;
}

function reverseBits(b) {
  b = ((b >> 1) & 0x55) | ((b & 0x55) << 1);
  b = ((b >> 2) & 0x33) | ((b & 0x33) << 2);
  b = ((b >> 4) & 0x0F) | ((b & 0x0F) << 4);
  return b & 0xFF;
}

// ─── Live snapshots ───────────────────────────────────────────────

/**
 * Read the live TIA snapshot from the running emulator + return generic
 * "rendering context"-style output.
 */
export function snapshotTia(host) {
  const bytes = host.readMemory("a26_tia_regs", 0, 32);
  return decodeTiaSnapshot(bytes);
}

/**
 * Render a palette PNG showing the 4 currently-active colors (P0/P1/PF/BK)
 * + their numeric register values. Used by inspectPalette.
 */
export function snapshotPaletteSwatch(host) {
  const tia = snapshotTia(host);
  const colors = [
    { name: "P0",  reg: tia.colors.p0 },
    { name: "P1",  reg: tia.colors.p1 },
    { name: "PF",  reg: tia.colors.pf },
    { name: "BK",  reg: tia.colors.bk },
  ];
  const cell = 32;
  const png = new PNG({ width: 4 * cell, height: cell });
  for (let i = 0; i < 4; i++) {
    const [r, g, b] = colors[i].reg.rgb;
    for (let y = 0; y < cell; y++) {
      for (let x = 0; x < cell; x++) {
        const o = (y * 4 * cell + i * cell + x) * 4;
        png.data[o + 0] = r;
        png.data[o + 1] = g;
        png.data[o + 2] = b;
        png.data[o + 3] = 0xff;
      }
    }
  }
  return {
    png: PNG.sync.write(png),
    colors: colors.map((c, i) => ({
      index: i,
      name: c.name,
      r: c.reg.rgb[0],
      g: c.reg.rgb[1],
      b: c.reg.rgb[2],
      rawWord: c.reg.byte,
    })),
  };
}

/**
 * Render the current sprite/playfield state as a single 160×1px PNG row
 * showing what the kernel would draw for one scanline of the current TIA
 * state. (More useful than a tile sheet for the 2600.)
 *
 * Note: this is a STATIC slice — the kernel re-writes TIA every scanline,
 * so the actual frame composition can vary line-by-line. Pause + sample
 * mid-frame to inspect a specific moment.
 */
export function snapshotScanline(host) {
  const tia = snapshotTia(host);
  const W = 160;
  const png = new PNG({ width: W, height: 8 });
  // Fill with BK color.
  const [bkR, bkG, bkB] = tia.colors.bk.rgb;
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i + 0] = bkR;
    png.data[i + 1] = bkG;
    png.data[i + 2] = bkB;
    png.data[i + 3] = 0xff;
  }
  // Draw playfield: 20 columns × 4 px each = 80 px (left half), then either
  // reflected or repeated on right half depending on CTRLPF bit 0.
  const pfBits = tia.playfield.pattern20bit;
  const drawPf = (startX, columnWidth, mirror) => {
    for (let col = 0; col < 20; col++) {
      const bitIdx = mirror ? 19 - col : col;
      if (pfBits & (1 << bitIdx)) {
        const x0 = startX + col * columnWidth;
        for (let y = 0; y < 8; y++) {
          for (let dx = 0; dx < columnWidth; dx++) {
            const x = x0 + dx;
            if (x < 0 || x >= W) continue;
            const o = (y * W + x) * 4;
            png.data[o + 0] = tia.colors.pf.rgb[0];
            png.data[o + 1] = tia.colors.pf.rgb[1];
            png.data[o + 2] = tia.colors.pf.rgb[2];
            png.data[o + 3] = 0xff;
          }
        }
      }
    }
  };
  drawPf(0, 4, false);
  drawPf(80, 4, tia.ctrlpf.reflect);

  // Draw player 0/1 graphics as 8-px sprites — position is whatever
  // the kernel set via RESP0/RESP1 (not exposed in our snapshot — the
  // CPU has to issue these strobes). We render at default x=50/100 just
  // to show shape.
  const drawSprite = (gfx, reflected, x, color) => {
    if (gfx === 0) return;
    for (let bit = 0; bit < 8; bit++) {
      const srcBit = reflected ? bit : 7 - bit;
      if (gfx & (1 << srcBit)) {
        const sx = x + bit;
        if (sx < 0 || sx >= W) continue;
        for (let y = 0; y < 8; y++) {
          const o = (y * W + sx) * 4;
          png.data[o + 0] = color[0];
          png.data[o + 1] = color[1];
          png.data[o + 2] = color[2];
          png.data[o + 3] = 0xff;
        }
      }
    }
  };
  drawSprite(tia.sprites.p0.graphics, tia.sprites.p0.reflected, 40, tia.colors.p0.rgb);
  drawSprite(tia.sprites.p1.graphics, tia.sprites.p1.reflected, 100, tia.colors.p1.rgb);

  return {
    png: PNG.sync.write(png),
    width: W,
    height: 8,
    note: "One-scanline TIA composition snapshot. Real 2600 games re-write " +
      "TIA every scanline — this shows the state at the moment of capture. " +
      "Player positions are drawn at default x=40/100 since RESP0/RESP1 " +
      "are strobes (no register holds the result).",
  };
}

// ─── CPU state decode (6502 / 6507) ────────────────────────────────

/**
 * Decode the 7-byte CPU snapshot from a26_cpu_regs.
 * Layout: pc_lo, pc_hi, a, x, y, p, sp.
 */
export function decodeA26CpuState(b) {
  const pc = b[0] | (b[1] << 8);
  const p = b[5];
  return {
    pc,
    sp: 0x100 | b[6],   // 6502 SP is the low byte of $0100+SP
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
