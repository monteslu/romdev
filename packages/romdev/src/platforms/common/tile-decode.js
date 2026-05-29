// Decode tile bytes back to 2D pixel index arrays.
// Inverse of image-to-tiles encoders.
//
// All decoders return a Uint8Array of length 64 (one byte per pixel,
// values 0..maxColors-1 according to the platform's bit depth).

import { TILE_SPECS } from "./image-to-tiles.js";

/**
 * Decode a single tile from a buffer.
 * @param {string} platform
 * @param {Uint8Array} buf  source buffer (CHR / VRAM / wherever tiles live)
 * @param {number} tileIndex
 * @returns {Uint8Array} 64 bytes, row-major, top-left first
 */
export function decodeTile(platform, buf, tileIndex) {
  const spec = TILE_SPECS[platform];
  if (!spec) throw new Error(`unknown platform '${platform}'`);
  const bytesPerTile = (8 * 8 * spec.bpp) / 8;
  const off = tileIndex * bytesPerTile;
  if (off + bytesPerTile > buf.length) {
    throw new RangeError(`tile ${tileIndex} out of range (buf=${buf.length}, want ${off + bytesPerTile})`);
  }
  const pixels = new Uint8Array(64);

  switch (spec.layout) {
    case "planar": {
      const planes = spec.bpp;
      for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 8; x++) {
          let v = 0;
          for (let p = 0; p < planes; p++) {
            const byte = buf[off + p * 8 + y];
            v |= ((byte >> (7 - x)) & 1) << p;
          }
          pixels[y * 8 + x] = v;
        }
      }
      return pixels;
    }
    case "interleaved": {
      const planes = spec.bpp;
      for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 8; x++) {
          let v = 0;
          for (let p = 0; p < planes; p++) {
            const byte = buf[off + y * planes + p];
            v |= ((byte >> (7 - x)) & 1) << p;
          }
          pixels[y * 8 + x] = v;
        }
      }
      return pixels;
    }
    case "planar-pairs": {
      // SNES: low 2 planes first 16 bytes, high 2 planes next 16.
      for (let y = 0; y < 8; y++) {
        const lo = buf[off + y * 2];
        const hi = buf[off + y * 2 + 1];
        const p2 = buf[off + 16 + y * 2];
        const p3 = buf[off + 16 + y * 2 + 1];
        for (let x = 0; x < 8; x++) {
          const b = 7 - x;
          let v = ((lo >> b) & 1) | (((hi >> b) & 1) << 1);
          v |= ((p2 >> b) & 1) << 2;
          v |= ((p3 >> b) & 1) << 3;
          pixels[y * 8 + x] = v;
        }
      }
      return pixels;
    }
    case "packed": {
      const ppb = 8 / spec.bpp;
      const mask = (1 << spec.bpp) - 1;
      const bytesPerRow = 8 / ppb;
      for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 8; x += ppb) {
          const byte = buf[off + y * bytesPerRow + (x / ppb)];
          for (let p = 0; p < ppb; p++) {
            const shift = (ppb - 1 - p) * spec.bpp;
            pixels[y * 8 + x + p] = (byte >> shift) & mask;
          }
        }
      }
      return pixels;
    }
    default:
      throw new Error(`unknown layout '${spec.layout}'`);
  }
}

/**
 * Render a single tile as ASCII art. Each pixel becomes one character.
 * Default mapping: " .+#" (0=empty, 3=solid) — works for 2bpp.
 * For higher bit depths uses " .:-=+*#%@" (10 levels).
 *
 * @param {Uint8Array} pixels  64 bytes from decodeTile
 * @param {number} [maxColors] for choosing character set
 * @returns {string} 8-row ASCII art, newlines between rows
 */
export function tileToAscii(pixels, maxColors = 4) {
  const chars = maxColors === 2 ? " #"
    : maxColors === 4 ? " .+#"
    : maxColors === 16 ? " .:-=+*#%@0123456789".slice(0, 16)
    : " .,:;+*#%@".slice(0, maxColors);
  let out = "";
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const i = pixels[y * 8 + x];
      out += chars[i] ?? "?";
    }
    if (y < 7) out += "\n";
  }
  return out;
}

/**
 * Compute a short hash of a tile's pixels (for fast equality / change checks).
 * FNV-1a over the pixel bytes.
 */
export function tileHash(pixels) {
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < pixels.length; i++) {
    h ^= pixels[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * Quick statistical summary of a tile.
 * @param {Uint8Array} pixels
 */
export function tileStats(pixels) {
  const counts = new Map();
  let nonzero = 0;
  for (const v of pixels) {
    counts.set(v, (counts.get(v) ?? 0) + 1);
    if (v !== 0) nonzero++;
  }
  const histogram = {};
  for (const [k, v] of counts) histogram[k] = v;
  return {
    nonzero,
    uniqueColors: counts.size,
    histogram,
    hash: tileHash(pixels),
  };
}
