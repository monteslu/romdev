// Convert a PNG (or raw RGBA image) into NES CHR bytes.
//
// NES tiles are 8×8 pixels, 2 bits per pixel (4 colors per tile, from a
// 4-entry palette). CHR ROM packs each tile into 16 bytes: 8 bytes of bit
// plane 0 followed by 8 bytes of bit plane 1.
//
// To convert arbitrary art:
//   1. For each 8×8 tile in the input image:
//      a. Pick the 4 most common colors in that tile.
//      b. Map each pixel to the index of its nearest color in that
//         per-tile palette.
//   2. Encode the indices as bitplanes.
//
// Returns the CHR bytes plus a recommended NES master palette that's the
// closest match to the colors actually used across all tiles. The agent
// can then write both into a ROM via patchRom.

import { PNG } from "pngjs";
import { NES_PALETTE } from "./palette.js";

/**
 * @typedef {Object} ConvertResult
 * @property {Uint8Array} chr           CHR bytes (16 × number-of-tiles)
 * @property {Uint8Array} palette       suggested 32-byte NES palette (16 BG + 16 sprite mirrored)
 * @property {number} tilesAcross
 * @property {number} tilesDown
 * @property {number} totalTiles
 * @property {Object[]} tilePalettes    one per tile: {indices: [4 NES master indices]}
 */

/**
 * Convert a PNG buffer to CHR bytes.
 *
 * @param {Buffer | Uint8Array} pngBytes      PNG-encoded image (any source — agent-generated, ripped from another ROM)
 * @param {Object} [opts]
 * @param {number} [opts.maxTiles] hard cap on tile count (e.g. 256 = one pattern table)
 * @returns {ConvertResult}
 */
export function imageToChr(pngBytes, opts = {}) {
  const png = PNG.sync.read(Buffer.from(pngBytes));
  return rgbaToChr({
    width: png.width,
    height: png.height,
    pixels: png.data,
    ...opts,
  });
}

/**
 * Convert a raw RGBA image to CHR. Same logic as imageToChr but works on
 * an already-decoded buffer.
 *
 * @param {Object} args
 * @param {number} args.width
 * @param {number} args.height
 * @param {Uint8Array | Buffer} args.pixels   RGBA, length = width*height*4
 * @param {number} [args.maxTiles]
 * @returns {ConvertResult}
 */
export function rgbaToChr(args) {
  const { width, height, pixels } = args;
  if (width % 8 !== 0) {
    throw new Error(`width must be a multiple of 8, got ${width}`);
  }
  if (height % 8 !== 0) {
    throw new Error(`height must be a multiple of 8, got ${height}`);
  }

  const tilesAcross = width / 8;
  const tilesDown = height / 8;
  let totalTiles = tilesAcross * tilesDown;
  if (args.maxTiles && totalTiles > args.maxTiles) {
    // Truncate to fit. We render row-major, so this drops bottom tiles.
    totalTiles = args.maxTiles;
  }

  const chr = new Uint8Array(totalTiles * 16);
  /** @type {{indices: number[]}[]} */
  const tilePalettes = [];

  // Track NES color usage frequency across all tiles, so we can suggest a
  // single 32-byte palette that covers the art.
  const nesUsage = new Int32Array(64);

  for (let t = 0; t < totalTiles; t++) {
    const tx = t % tilesAcross;
    const ty = Math.floor(t / tilesAcross);

    // Sample the 64 pixels of this tile.
    /** @type {[number,number,number][]} */
    const tilePixels = [];
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        const px = tx * 8 + x;
        const py = ty * 8 + y;
        const o = (py * width + px) * 4;
        tilePixels.push([pixels[o], pixels[o + 1], pixels[o + 2]]);
      }
    }

    // Quantize the tile to a 4-color palette by finding the 4 most-distinct
    // representative colors. Simple approach: pick the 4 most-common colors,
    // or if fewer unique colors exist, pad.
    const palette = chooseTilePalette(tilePixels);
    // Map each NES master index used to the global usage table.
    for (const nesIdx of palette) {
      if (nesIdx >= 0 && nesIdx < 64) nesUsage[nesIdx]++;
    }

    tilePalettes.push({ indices: palette });

    // Encode the tile as bitplanes.
    for (let y = 0; y < 8; y++) {
      let lo = 0;
      let hi = 0;
      for (let x = 0; x < 8; x++) {
        const rgb = tilePixels[y * 8 + x];
        const palIdx = nearestPalIdx(rgb, palette);
        if (palIdx & 1) lo |= 1 << (7 - x);
        if (palIdx & 2) hi |= 1 << (7 - x);
      }
      chr[t * 16 + y] = lo;
      chr[t * 16 + y + 8] = hi;
    }
  }

  // Build a recommended 32-byte palette: pick the most-used NES master indices.
  const sortedNes = [];
  for (let i = 0; i < 64; i++) sortedNes.push({ idx: i, count: nesUsage[i] });
  sortedNes.sort((a, b) => b.count - a.count);
  const palette = new Uint8Array(32);
  // The universal BG entry is the most-used color overall, ideally background.
  palette[0] = sortedNes[0]?.idx ?? 0x0f;
  // Fill in 3 BG palettes + 4 sprite palettes with the next most-used colors.
  for (let p = 0; p < 4; p++) {
    for (let i = 1; i < 4; i++) {
      const top = sortedNes[(p * 3 + i) % sortedNes.length];
      palette[p * 4 + i] = top ? top.idx : 0x0f;
    }
    // Mirror universal BG into sprite half too.
    palette[16 + p * 4] = palette[0];
    for (let i = 1; i < 4; i++) {
      palette[16 + p * 4 + i] = palette[p * 4 + i];
    }
  }

  return { chr, palette, tilesAcross, tilesDown, totalTiles, tilePalettes };
}

/** Choose 4 NES master-palette indices that best represent the tile's colors. */
function chooseTilePalette(tilePixels) {
  // Quantize each pixel to its nearest NES master index, then take the 4 most-common.
  const counts = new Map();
  for (const rgb of tilePixels) {
    const idx = nearestNesIndex(rgb);
    counts.set(idx, (counts.get(idx) ?? 0) + 1);
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const palette = sorted.slice(0, 4).map((e) => e[0]);
  while (palette.length < 4) palette.push(0x0f); // pad with NES black
  return palette;
}

/** Map an RGB to the nearest entry in the NES 64-color master palette. */
function nearestNesIndex(rgb) {
  const [r, g, b] = rgb;
  let bestIdx = 0;
  let bestDist = Infinity;
  for (let i = 0; i < 64; i++) {
    const [pr, pg, pb] = NES_PALETTE[i];
    const dr = r - pr, dg = g - pg, db = b - pb;
    const d = dr * dr + dg * dg + db * db;
    if (d < bestDist) {
      bestDist = d;
      bestIdx = i;
    }
  }
  return bestIdx;
}

/** Pick the 0..3 palette slot whose NES color is closest to the pixel. */
function nearestPalIdx(rgb, palette) {
  let bestIdx = 0;
  let bestDist = Infinity;
  for (let i = 0; i < palette.length; i++) {
    const [pr, pg, pb] = NES_PALETTE[palette[i] & 0x3f];
    const dr = rgb[0] - pr, dg = rgb[1] - pg, db = rgb[2] - pb;
    const d = dr * dr + dg * dg + db * db;
    if (d < bestDist) {
      bestDist = d;
      bestIdx = i;
    }
  }
  return bestIdx;
}
