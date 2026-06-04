// Platform-agnostic image → tile-bytes converter.
//
// Each retro platform stores tiles in its own bit-depth + layout.
// This module: (1) defines the per-platform spec, (2) quantizes the image
// to that platform's palette + bit depth, (3) encodes tiles in the
// platform's bit layout.
//
// Supported platforms:
//   nes      — 2bpp planar (8 bytes plane 0, 8 bytes plane 1)
//   gb / gbc — 2bpp interleaved (row-by-row pairs)
//   sms / gg — 4bpp interleaved (4 bytes per row)
//   snes     — 4bpp planar pairs (2bpp plane 0+1 first 16B, plane 2+3 next 16B)
//   genesis  — 4bpp packed (4 bits per pixel, 2 pixels per byte, row-major)
//   gba      — 4bpp linear (gba "obj 4bpp") — 2 pixels per byte
//   atari2600— 1bpp playfield/sprite — 1 byte per row, MSB = leftmost
//   atari7800— 4bpp (160B mode) packed — 2 pixels per byte
//   lynx     — 4bpp packed (lynx sprites are RLE; we emit raw 4bpp for the caller to compress)
//
// All take an RGBA input where width and height are multiples of the tile
// width (8 for everything except Atari 2600, which uses 8-wide too).
//
// For platforms with a hardware-fixed palette (GB/2600), the converter just
// quantizes to that palette. For platforms with a programmable palette
// (NES/SNES/Genesis/etc.), the converter also suggests a recommended
// palette — the most common colors used across all tiles.

import { PNG } from "pngjs";
import { NES_PALETTE } from "../nes/palette.js";
import { C64_PALETTE } from "../c64/vic.js";

// ---------- Master palettes ----------

const GB_PALETTE = [
  [224, 248, 208],
  [136, 192, 112],
  [ 52, 104,  86],
  [  8,  24,  32],
];

const ATARI2600_NTSC_PALETTE = (function () {
  // 128-color TIA palette (16 hues × 8 luminances). This is an
  // approximation; agents can use it as a target for quantization.
  const out = [];
  for (let hue = 0; hue < 16; hue++) {
    for (let lum = 0; lum < 8; lum++) {
      // Crude approximation: linear ramp through HSV.
      const v = Math.round((lum + 1) * (255 / 8));
      const angle = (hue / 16) * 2 * Math.PI;
      const r = Math.max(0, Math.min(255, Math.round(v * (0.5 + 0.5 * Math.cos(angle)))));
      const g = Math.max(0, Math.min(255, Math.round(v * (0.5 + 0.5 * Math.cos(angle - 2.094)))));
      const b = Math.max(0, Math.min(255, Math.round(v * (0.5 + 0.5 * Math.cos(angle + 2.094)))));
      out.push([r, g, b]);
    }
  }
  return out;
})();

// SNES, Genesis, GBA all have huge programmable palettes. For quantization
// we pick a 256-entry "generic" RGB cube — agents using these platforms
// supply their own palette at use time. (We still pick 4/16 representative
// indices per tile from the input image's colors.)
const RGB_CUBE_256 = (function () {
  const out = [];
  for (let r = 0; r < 6; r++) {
    for (let g = 0; g < 6; g++) {
      for (let b = 0; b < 6; b++) {
        out.push([Math.round((r / 5) * 255), Math.round((g / 5) * 255), Math.round((b / 5) * 255)]);
      }
    }
  }
  // Pad to 256 with grays.
  while (out.length < 256) {
    const i = out.length;
    const v = Math.round((i / 255) * 255);
    out.push([v, v, v]);
  }
  return out;
})();

// ---------- Per-platform spec ----------

/**
 * @typedef {Object} TileSpec
 * @property {number} bpp         bits per pixel (1, 2, 4)
 * @property {string} layout      one of "planar", "interleaved", "packed", "planar-pairs"
 * @property {[number,number,number][]} master  master palette to quantize against
 * @property {boolean} hasProgrammablePalette  if true, suggest one in the output
 * @property {number} maxColors   palette entries per tile (2^bpp)
 */

/** @type {Record<string, TileSpec>} */
const SPECS = {
  nes: { bpp: 2, layout: "planar", master: NES_PALETTE, hasProgrammablePalette: true, maxColors: 4 },
  gb: { bpp: 2, layout: "interleaved", master: GB_PALETTE, hasProgrammablePalette: false, maxColors: 4 },
  gbc: { bpp: 2, layout: "interleaved", master: GB_PALETTE, hasProgrammablePalette: true, maxColors: 4 },
  sms: { bpp: 4, layout: "interleaved", master: RGB_CUBE_256, hasProgrammablePalette: true, maxColors: 16 },
  gg: { bpp: 4, layout: "interleaved", master: RGB_CUBE_256, hasProgrammablePalette: true, maxColors: 16 },
  snes: { bpp: 4, layout: "planar-pairs", master: RGB_CUBE_256, hasProgrammablePalette: true, maxColors: 16 },
  genesis: { bpp: 4, layout: "packed", master: RGB_CUBE_256, hasProgrammablePalette: true, maxColors: 16 },
  gba: { bpp: 4, layout: "packed", master: RGB_CUBE_256, hasProgrammablePalette: true, maxColors: 16 },
  atari2600: { bpp: 1, layout: "planar", master: ATARI2600_NTSC_PALETTE, hasProgrammablePalette: true, maxColors: 2 },
  // C64 hi-res charset: each 8×8 char is 8 bytes, 1bpp (bit set = foreground
  // pixel, drawn in the cell's Color-RAM color; clear = shared background).
  // Same byte layout as a single 1bpp planar plane.
  c64: { bpp: 1, layout: "planar", master: C64_PALETTE, hasProgrammablePalette: true, maxColors: 2 },
  atari7800: { bpp: 4, layout: "packed", master: ATARI2600_NTSC_PALETTE, hasProgrammablePalette: true, maxColors: 16 },
  lynx: { bpp: 4, layout: "packed", master: RGB_CUBE_256, hasProgrammablePalette: true, maxColors: 16 },
  // PC Engine HuC6270 BG/sprite tile: 4bpp, identical byte layout to the SNES
  // "planar-pairs" (16 bytes plane 0+1, then 16 bytes plane 2+3, MSB-first) —
  // verified byte-for-byte against geargrafx's renderer. The VCE palette is
  // 9-bit GRB; a suggested 16-color palette is returned (quantize against the
  // RGB cube, then pack to GRB at use time via inspectPalette's decode).
  pce: { bpp: 4, layout: "planar-pairs", master: RGB_CUBE_256, hasProgrammablePalette: true, maxColors: 16 },
};

/**
 * @typedef {Object} ConvertResult
 * @property {string} platform
 * @property {Uint8Array} tiles
 * @property {Uint8Array | number[]} [palette]
 * @property {number} bpp
 * @property {string} layout
 * @property {number} tilesAcross
 * @property {number} tilesDown
 * @property {number} totalTiles
 */

/**
 * Convert a PNG to tile bytes for the given platform.
 * @param {string} platform
 * @param {Buffer | Uint8Array} pngBytes
 * @param {Object} [opts]
 * @param {number} [opts.maxTiles]
 * @returns {ConvertResult}
 */
export function imageToTiles(platform, pngBytes, opts = {}) {
  const png = PNG.sync.read(Buffer.from(pngBytes));
  return rgbaToTiles(platform, {
    width: png.width,
    height: png.height,
    pixels: png.data,
    paletteHint: opts.paletteHint,
    ...opts,
  });
}

/**
 * @param {string} platform
 * @param {Object} args
 * @param {number} args.width
 * @param {number} args.height
 * @param {Uint8Array | Buffer} args.pixels
 * @param {number} [args.maxTiles]
 * @param {Array<[number, number, number]>} [args.paletteHint]
 *   Explicit RGB → palette index map. Pixel RGB is matched against the
 *   hint by nearest-neighbour in RGB space; the matched index goes
 *   directly into the encoded tile byte. Replaces the per-tile
 *   master-palette quantization with a deterministic mapping — the
 *   right thing when the caller already knows what their palette is.
 */
export function rgbaToTiles(platform, args) {
  const spec = SPECS[platform];
  if (!spec) {
    throw new Error(`unknown platform '${platform}' — supported: ${Object.keys(SPECS).join(", ")}`);
  }
  const { width, height, pixels, paletteHint } = args;
  if (width % 8 !== 0) throw new Error(`width must be multiple of 8, got ${width}`);
  if (height % 8 !== 0) throw new Error(`height must be multiple of 8, got ${height}`);

  const tilesAcross = width / 8;
  const tilesDown = height / 8;
  let totalTiles = tilesAcross * tilesDown;
  if (args.maxTiles && totalTiles > args.maxTiles) totalTiles = args.maxTiles;

  const bytesPerTile = (8 * 8 * spec.bpp) / 8; // 8 (1bpp), 16 (2bpp), 32 (4bpp)
  const tiles = new Uint8Array(totalTiles * bytesPerTile);
  const masterUsage = new Int32Array(spec.master.length);

  if (paletteHint && paletteHint.length > spec.maxColors) {
    throw new Error(`paletteHint has ${paletteHint.length} entries; platform '${platform}' only supports ${spec.maxColors} colors per tile.`);
  }

  for (let t = 0; t < totalTiles; t++) {
    const tx = t % tilesAcross;
    const ty = Math.floor(t / tilesAcross);

    /** @type {[number,number,number][]} */
    const tilePixels = new Array(64);
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        const px = tx * 8 + x;
        const py = ty * 8 + y;
        const o = (py * width + px) * 4;
        tilePixels[y * 8 + x] = [pixels[o], pixels[o + 1], pixels[o + 2]];
      }
    }

    const indices = new Uint8Array(64);
    if (paletteHint) {
      // Each pixel goes to the nearest hint color → that color's index.
      for (let i = 0; i < 64; i++) {
        indices[i] = nearestHintIdx(tilePixels[i], paletteHint);
      }
    } else {
      const tilePalette = chooseTilePalette(tilePixels, spec.master, spec.maxColors);
      for (const idx of tilePalette) {
        if (idx >= 0 && idx < spec.master.length) masterUsage[idx]++;
      }
      for (let i = 0; i < 64; i++) {
        indices[i] = nearestPalIdx(tilePixels[i], tilePalette, spec.master);
      }
    }

    encodeTile(spec, indices, tiles, t * bytesPerTile);
  }

  /** @type {ConvertResult} */
  const result = {
    platform,
    tiles,
    bpp: spec.bpp,
    layout: spec.layout,
    tilesAcross,
    tilesDown,
    totalTiles,
  };

  if (spec.hasProgrammablePalette) {
    result.palette = suggestPalette(spec, masterUsage);
  }

  return result;
}

// ---------- Tile encoders ----------

function encodeTile(spec, indices, dst, offset) {
  switch (spec.layout) {
    case "planar": {
      // NES (2bpp): 8 bytes plane 0, then 8 bytes plane 1.
      // Atari 2600 (1bpp): 8 bytes plane 0 only.
      const planes = spec.bpp;
      for (let p = 0; p < planes; p++) {
        for (let y = 0; y < 8; y++) {
          let byte = 0;
          for (let x = 0; x < 8; x++) {
            const idx = indices[y * 8 + x];
            if ((idx >> p) & 1) byte |= 1 << (7 - x);
          }
          dst[offset + p * 8 + y] = byte;
        }
      }
      return;
    }
    case "interleaved": {
      // GB (2bpp): per row [lo, hi], for 8 rows.
      // SMS/GG (4bpp): per row [p0, p1, p2, p3], for 8 rows.
      const planes = spec.bpp;
      for (let y = 0; y < 8; y++) {
        for (let p = 0; p < planes; p++) {
          let byte = 0;
          for (let x = 0; x < 8; x++) {
            const idx = indices[y * 8 + x];
            if ((idx >> p) & 1) byte |= 1 << (7 - x);
          }
          dst[offset + y * planes + p] = byte;
        }
      }
      return;
    }
    case "planar-pairs": {
      // SNES (4bpp): 16 bytes of plane 0+1 (2bpp planar), then 16 bytes of plane 2+3 (2bpp planar).
      // Plane 0+1 chunk
      for (let y = 0; y < 8; y++) {
        let lo = 0, hi = 0;
        for (let x = 0; x < 8; x++) {
          const idx = indices[y * 8 + x];
          if (idx & 1) lo |= 1 << (7 - x);
          if ((idx >> 1) & 1) hi |= 1 << (7 - x);
        }
        dst[offset + y * 2] = lo;
        dst[offset + y * 2 + 1] = hi;
      }
      // Plane 2+3 chunk
      for (let y = 0; y < 8; y++) {
        let p2 = 0, p3 = 0;
        for (let x = 0; x < 8; x++) {
          const idx = indices[y * 8 + x];
          if ((idx >> 2) & 1) p2 |= 1 << (7 - x);
          if ((idx >> 3) & 1) p3 |= 1 << (7 - x);
        }
        dst[offset + 16 + y * 2] = p2;
        dst[offset + 16 + y * 2 + 1] = p3;
      }
      return;
    }
    case "packed": {
      // Genesis/GBA/Atari 7800 (4bpp): two 4-bit pixels per byte, MSB pixel first.
      // (Genesis VDP and GBA OBJ-4bpp share this layout.)
      // Atari 2600 1bpp doesn't use this path.
      const ppb = 8 / spec.bpp; // pixels per byte
      const mask = (1 << spec.bpp) - 1;
      for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 8; x += ppb) {
          let byte = 0;
          for (let p = 0; p < ppb; p++) {
            const idx = indices[y * 8 + x + p] & mask;
            byte |= idx << ((ppb - 1 - p) * spec.bpp);
          }
          dst[offset + y * (8 / ppb) + (x / ppb)] = byte;
        }
      }
      return;
    }
    default:
      throw new Error(`unknown tile layout '${spec.layout}'`);
  }
}

// ---------- Palette helpers ----------

function chooseTilePalette(tilePixels, master, maxColors) {
  const counts = new Map();
  for (const rgb of tilePixels) {
    const idx = nearestMasterIndex(rgb, master);
    counts.set(idx, (counts.get(idx) ?? 0) + 1);
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const palette = sorted.slice(0, maxColors).map((e) => e[0]);
  while (palette.length < maxColors) palette.push(0);
  return palette;
}

function nearestMasterIndex(rgb, master) {
  const [r, g, b] = rgb;
  let bestIdx = 0;
  let bestDist = Infinity;
  for (let i = 0; i < master.length; i++) {
    const [pr, pg, pb] = master[i];
    const dr = r - pr, dg = g - pg, db = b - pb;
    const d = dr * dr + dg * dg + db * db;
    if (d < bestDist) {
      bestDist = d;
      bestIdx = i;
    }
  }
  return bestIdx;
}

function nearestHintIdx(rgb, hint) {
  let bestIdx = 0;
  let bestDist = Infinity;
  for (let i = 0; i < hint.length; i++) {
    const [pr, pg, pb] = hint[i];
    const dr = rgb[0] - pr, dg = rgb[1] - pg, db = rgb[2] - pb;
    const d = dr * dr + dg * dg + db * db;
    if (d < bestDist) {
      bestDist = d;
      bestIdx = i;
    }
  }
  return bestIdx;
}

function nearestPalIdx(rgb, palette, master) {
  let bestIdx = 0;
  let bestDist = Infinity;
  for (let i = 0; i < palette.length; i++) {
    const m = master[palette[i]] ?? [0, 0, 0];
    const dr = rgb[0] - m[0], dg = rgb[1] - m[1], db = rgb[2] - m[2];
    const d = dr * dr + dg * dg + db * db;
    if (d < bestDist) {
      bestDist = d;
      bestIdx = i;
    }
  }
  return bestIdx;
}

/**
 * For platforms with programmable palettes, suggest a palette using the
 * most-used master indices. Returned as Uint8Array of indices (length depends
 * on platform — NES = 32, others = maxColors of one subpalette).
 */
function suggestPalette(spec, masterUsage) {
  const sorted = [];
  for (let i = 0; i < spec.master.length; i++) sorted.push({ idx: i, count: masterUsage[i] });
  sorted.sort((a, b) => b.count - a.count);
  // For NES specifically we emit a 32-byte BG+sprite palette;
  // for other platforms emit one subpalette of maxColors entries.
  if (spec.bpp === 2 && spec.master === NES_PALETTE) {
    const palette = new Uint8Array(32);
    palette[0] = sorted[0]?.idx ?? 0x0f;
    for (let p = 0; p < 4; p++) {
      for (let i = 1; i < 4; i++) {
        palette[p * 4 + i] = sorted[(p * 3 + i) % sorted.length]?.idx ?? 0x0f;
      }
      palette[16 + p * 4] = palette[0];
      for (let i = 1; i < 4; i++) {
        palette[16 + p * 4 + i] = palette[p * 4 + i];
      }
    }
    return palette;
  }
  // Default: one subpalette.
  const palette = new Uint8Array(spec.maxColors);
  for (let i = 0; i < spec.maxColors; i++) {
    palette[i] = sorted[i]?.idx ?? 0;
  }
  return palette;
}

export { SPECS as TILE_SPECS };
