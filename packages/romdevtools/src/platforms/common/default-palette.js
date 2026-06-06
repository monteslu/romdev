// default-palette.js — per-platform default RGB palettes.
//
// Used by the asset-pipeline tools under intent:"homebrew" when no
// emulator is loaded (so paletteFromEmulator can't fire). Gives the
// homebrew workflow a sensible color basis without forcing the agent
// to pass an explicit palette.
//
// Each entry is an array of [r, g, b] tuples in sRGB. Sizes match the
// platform's per-subpalette index limit (see PLATFORM_LIMITS in
// sprite-pipeline.js): 4 for NES/GB/GBC/Atari7800; 16 for the rest.

/** @type {Record<string, number[][]>} */
export const DEFAULT_PALETTES = {
  // ── NES — PPU reset values: backdrop dark, brand-typical primaries ──
  // The PPU doesn't have a "reset palette" per se, but most NES games
  // settle into a palette like this on the first frame. Approximates
  // what NEXXT shows by default.
  nes: [
    [0x0F, 0x0F, 0x0F],  // index 0 — backdrop (near-black per the 2C02 master)
    [0xFC, 0xFC, 0xFC],  // index 1 — white
    [0xD8, 0x28, 0x00],  // index 2 — red
    [0x00, 0x00, 0xFC],  // index 3 — blue
  ],

  // ── DMG Game Boy — 4-shade green ramp (the iconic look) ──
  gb: [
    [0xE0, 0xF8, 0xD0],  // index 0 — lightest green (background)
    [0x88, 0xC0, 0x70],  // index 1
    [0x34, 0x68, 0x56],  // index 2
    [0x08, 0x18, 0x20],  // index 3 — darkest
  ],

  // ── GBC — default BG palette index 0 (close to DMG green for
  // back-compat) but with a brighter range so newly-authored color
  // art stands out.
  gbc: [
    [0xFF, 0xFF, 0xFF],
    [0xA8, 0xA8, 0xA8],
    [0x54, 0x54, 0x54],
    [0x00, 0x00, 0x00],
  ],

  // ── SMS — VDP default (when no CRAM written): backdrop + 3 BG colors ──
  // 16-color palette; first 4 entries are the common-case "ASCII text on
  // black" defaults that most homebrew settles into on boot.
  sms: [
    [0x00, 0x00, 0x00],
    [0xFF, 0xFF, 0xFF],
    [0xFF, 0x00, 0x00],
    [0x00, 0xFF, 0x00],
    [0x00, 0x00, 0xFF],
    [0xFF, 0xFF, 0x00],
    [0xFF, 0x00, 0xFF],
    [0x00, 0xFF, 0xFF],
    [0x55, 0x55, 0x55],
    [0xAA, 0xAA, 0xAA],
    [0xFF, 0x55, 0x55],
    [0x55, 0xFF, 0x55],
    [0x55, 0x55, 0xFF],
    [0xFF, 0xFF, 0x55],
    [0xFF, 0x55, 0xFF],
    [0x55, 0xFF, 0xFF],
  ],
  // Game Gear shares the SMS VDP — same palette default.
  gg: undefined,  // populated below

  // ── SNES — default CGRAM after retro_init: 16 entries of the most
  // common boot-time palette (mostly black with a few primaries). Real
  // SNES homebrew always uploads its own CGRAM, so this is rarely seen
  // — but we need something for "PNG → tile" workflows without a ROM.
  snes: [
    [0x00, 0x00, 0x00],
    [0xFF, 0xFF, 0xFF],
    [0xC0, 0xC0, 0xC0],
    [0x80, 0x80, 0x80],
    [0xFF, 0x00, 0x00],
    [0x00, 0xFF, 0x00],
    [0x00, 0x00, 0xFF],
    [0xFF, 0xFF, 0x00],
    [0xFF, 0x00, 0xFF],
    [0x00, 0xFF, 0xFF],
    [0xFF, 0x80, 0x00],
    [0x80, 0x00, 0xFF],
    [0x00, 0x80, 0xFF],
    [0xFF, 0x80, 0x80],
    [0x80, 0xFF, 0x80],
    [0x80, 0x80, 0xFF],
  ],

  // ── Genesis — VDP default: 16-color palette line 0, mostly black ──
  genesis: [
    [0x00, 0x00, 0x00],
    [0xFF, 0xFF, 0xFF],
    [0xE0, 0x00, 0x00],
    [0x00, 0xE0, 0x00],
    [0x00, 0x00, 0xE0],
    [0xE0, 0xE0, 0x00],
    [0xE0, 0x00, 0xE0],
    [0x00, 0xE0, 0xE0],
    [0xA0, 0xA0, 0xA0],
    [0xE0, 0x80, 0x00],
    [0x80, 0x00, 0xE0],
    [0x00, 0x80, 0xE0],
    [0xE0, 0x80, 0x80],
    [0x80, 0xE0, 0x80],
    [0x80, 0x80, 0xE0],
    [0x40, 0x40, 0x40],
  ],

  // ── Atari 7800 — MARIA backdrop + 3 colors, common boot palette ──
  atari7800: [
    [0x00, 0x00, 0x00],
    [0xFC, 0xFC, 0xFC],
    [0xD8, 0x28, 0x00],
    [0x00, 0x00, 0xFC],
  ],
};

// Aliases — same hardware, same palette.
DEFAULT_PALETTES.gg = DEFAULT_PALETTES.sms;

/**
 * Return the per-platform default palette as an array of [r, g, b].
 * Throws for unsupported platforms (the asset pipeline should refuse
 * before hitting this if the platform doesn't have a tile spec).
 *
 * @param {string} platform
 * @returns {number[][]}
 */
export function getDefaultPalette(platform) {
  const p = DEFAULT_PALETTES[platform];
  if (!p) {
    throw new Error(
      `getDefaultPalette: no default palette for platform '${platform}'. ` +
      `Supported: ${Object.keys(DEFAULT_PALETTES).join(", ")}.`
    );
  }
  return p;
}
