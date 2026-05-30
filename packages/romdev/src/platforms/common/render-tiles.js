// Render a contiguous slice of tile bytes as a PNG grid.
//
// Works for any platform supported by the tile decoder. Picks a visualization
// palette based on the platform: NES uses a sample of the NES master palette,
// GB uses the DMG grays, others fall back to a generic ramp.

import { PNG } from "pngjs";
import { decodeTile } from "./tile-decode.js";
import { TILE_SPECS } from "./image-to-tiles.js";
import { NES_PALETTE } from "../nes/palette.js";

/** Visualization palette per platform. */
function vizPalette(platform, colors) {
  if (platform === "nes") {
    // Use a familiar mid-tone NES BG palette: dark blue/gray + 3 tones.
    return [
      NES_PALETTE[0x0f], // black
      NES_PALETTE[0x00], // dark gray
      NES_PALETTE[0x10], // light gray
      NES_PALETTE[0x30], // white
    ];
  }
  if (platform === "gb" || platform === "gbc") {
    return [
      [224, 248, 208],
      [136, 192, 112],
      [ 52, 104,  86],
      [  8,  24,  32],
    ];
  }
  // Generic: linear grayscale ramp scaled to `colors` entries.
  const out = [];
  for (let i = 0; i < colors; i++) {
    const v = Math.round((i / Math.max(1, colors - 1)) * 255);
    out.push([v, v, v]);
  }
  return out;
}

/**
 * @param {Object} args
 * @param {string} args.platform
 * @param {Uint8Array} args.tileBytes  contiguous tile data in platform format
 * @param {number} [args.tilesPerRow]
 * @param {Array<[number,number,number]>} [args.paletteOverride]
 *   Explicit RGB palette to use. Length must be >= spec.maxColors.
 *   When provided, replaces the default grayscale visualization palette.
 * @returns {Buffer} PNG bytes
 */
export function renderTilesGrid(args) {
  const { platform, tileBytes, paletteOverride } = args;
  const tilesPerRow = args.tilesPerRow ?? 16;
  const spec = TILE_SPECS[platform];
  if (!spec) throw new Error(`unknown platform '${platform}'`);
  const bytesPerTile = (8 * 8 * spec.bpp) / 8;
  const totalTiles = Math.floor(tileBytes.length / bytesPerTile);
  const rows = Math.ceil(totalTiles / tilesPerRow);
  const width = tilesPerRow * 8;
  const height = rows * 8;

  const png = new PNG({ width, height });
  const dst = png.data;
  const palette = paletteOverride && paletteOverride.length >= spec.maxColors
    ? paletteOverride
    : vizPalette(platform, spec.maxColors);

  for (let t = 0; t < totalTiles; t++) {
    const pixels = decodeTile(platform, tileBytes, t);
    const tx = t % tilesPerRow;
    const ty = Math.floor(t / tilesPerRow);
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        const idx = pixels[y * 8 + x];
        const col = palette[idx] ?? palette[palette.length - 1];
        const dx = tx * 8 + x;
        const dy = ty * 8 + y;
        const o = (dy * width + dx) * 4;
        dst[o + 0] = col[0];
        dst[o + 1] = col[1];
        dst[o + 2] = col[2];
        dst[o + 3] = 0xff;
      }
    }
  }
  return PNG.sync.write(png);
}
