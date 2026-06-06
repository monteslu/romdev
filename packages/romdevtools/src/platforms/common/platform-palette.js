// platform-palette.js — single accessor for every platform's master RGB palette.
//
// The per-platform palette PNG generators (nesPalettePng, snesPalettePng, ...)
// each hardcoded their RGB list inline. Lospec / hex / indexed-PNG validation
// all need that same list. Extracted here once.
//
// Returns an array of [r, g, b] (0..255 each). One entry per color the platform
// can actually display from its master palette.

import { NES_PALETTE, nesIndexToRgb } from "../nes/palette.js";
import { DMG_PALETTE } from "../gb/ppu.js";
import { C64_PALETTE } from "../c64/vic.js";
import { A78_PALETTE } from "../atari7800/maria.js";
import { NTSC_PALETTE } from "../atari2600/tia.js";

/* ── SNES master swatch — 16 well-spaced colors (matches snesPalettePng) ── */
const SNES_SWATCH = [
  [0, 0, 0], [128, 128, 128], [255, 255, 255], [128, 0, 0],
  [255, 0, 0], [255, 128, 0], [255, 255, 0], [0, 128, 0],
  [0, 255, 0], [0, 128, 128], [0, 255, 255], [0, 0, 128],
  [0, 0, 255], [128, 0, 128], [255, 0, 255], [128, 64, 0],
];

/* ── Genesis: full 9-bit VDP gamut (512 colors), 3 bits each channel ── */
function genesisRgb() {
  const expand = (n3) => (n3 << 5) | (n3 << 2) | (n3 >> 1);
  const out = [];
  for (let i = 0; i < 512; i++) {
    const r = expand(i & 0x7);
    const g = expand((i >> 3) & 0x7);
    const b = expand((i >> 6) & 0x7);
    out.push([r, g, b]);
  }
  return out;
}

/* ── SMS: full 6-bit gamut (64 colors), 2 bits per channel ── */
function smsRgb() {
  const out = [];
  for (let i = 0; i < 64; i++) {
    const r2 = i & 0x3;
    const g2 = (i >> 2) & 0x3;
    const b2 = (i >> 4) & 0x3;
    // expand 2 bits → 8 bits: 0,85,170,255
    const expand = (n2) => (n2 * 85);
    out.push([expand(r2), expand(g2), expand(b2)]);
  }
  return out;
}

/* ── GG: full 12-bit gamut (4096 colors), 4 bits per channel ── */
function ggRgb() {
  const out = [];
  for (let i = 0; i < 4096; i++) {
    const r4 = i & 0xF;
    const g4 = (i >> 4) & 0xF;
    const b4 = (i >> 8) & 0xF;
    const expand = (n4) => (n4 << 4) | n4;
    out.push([expand(r4), expand(g4), expand(b4)]);
  }
  return out;
}

/* ── NES: 53 usable colors (skipping the 11 "black duplicates") ── */
function nesRgb() {
  const SKIP = new Set([0x0d, 0x0e, 0x1d, 0x1e, 0x1f, 0x2d, 0x2e, 0x2f, 0x3d, 0x3e, 0x3f]);
  const out = [];
  // Put canonical black ($0F) first to match nesPalettePng().
  out.push(nesIndexToRgb(0x0f));
  for (let i = 0; i < 64; i++) {
    if (i === 0x0f || SKIP.has(i)) continue;
    out.push(NES_PALETTE[i]);
  }
  return out;
}

/**
 * Return the platform's master RGB palette as an array of [r,g,b].
 * The list is the same set of colors the platform's `*PalettePng()`
 * generator produces (in the same order, so PLTE indices line up).
 *
 * @param {string} platform
 * @returns {[number, number, number][]}
 */
export function getPlatformPaletteRgb(platform) {
  switch (platform) {
    case "nes":        return nesRgb();
    case "gb":
    case "gbc":        return [...DMG_PALETTE];     // 4 shades
    case "snes":       return SNES_SWATCH;
    case "genesis":    return genesisRgb();
    case "sms":        return smsRgb();
    case "gg":         return ggRgb();
    case "c64":        return [...C64_PALETTE];     // 16 colors
    case "atari2600":  return [...NTSC_PALETTE];    // 128 NTSC entries
    case "atari7800":  return [...A78_PALETTE];     // 256 entries
    default:
      throw new Error(`getPlatformPaletteRgb: no master palette defined for platform '${platform}'`);
  }
}

/**
 * Check if a color is within tolerance of any palette entry.
 * Used by indexed-PNG validation — sRGB gamma drift can shift exported
 * pixels by 1-2 per channel even when the artist used the right swatch.
 *
 * @param {[number,number,number][]} palette
 * @param {number} r @param {number} g @param {number} b
 * @param {number} [tolerance=0]  max per-channel delta
 * @returns {boolean}
 */
export function paletteContains(palette, r, g, b, tolerance = 0) {
  for (const [pr, pg, pb] of palette) {
    if (Math.abs(pr - r) <= tolerance &&
        Math.abs(pg - g) <= tolerance &&
        Math.abs(pb - b) <= tolerance) {
      return true;
    }
  }
  return false;
}

/**
 * Format an RGB triple as "#RRGGBB" (uppercase hex with leading hash).
 */
export function rgbHex(r, g, b) {
  const h = (n) => n.toString(16).toUpperCase().padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

/**
 * Format an RGB triple as "rrggbb" (lowercase hex, no hash) — Lospec style.
 */
export function rgbHexLospec(r, g, b) {
  const h = (n) => n.toString(16).padStart(2, "0");
  return `${h(r)}${h(g)}${h(b)}`;
}
