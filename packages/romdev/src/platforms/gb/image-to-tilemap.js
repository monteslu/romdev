// Game Boy / Game Boy Color image-to-tilemap converter.
//
// DMG mode: 160×144 screen (20×18 tiles), 2bpp interleaved tile format,
// 4-shade palette. BG map is 32×32 bytes (we fill the visible 20×18 cells).
//
// CGB extends DMG with: 16 BG palettes × 4 colors (BGR555), per-tile
// palette attribute (bits 0-2 of BG map's bank 1 attribute byte), VRAM
// bank 1 for tile attributes + bank 0/1 for tile data. This module
// handles DMG only — agents who need CGB-specific behavior pass GBC
// palette + use the cgbAttr output field if extended later.

import { PNG } from "pngjs";
import { DMG_PALETTE } from "./ppu.js";

const W = 160;
const H = 144;

/** Encode one 8×8 region of the source PNG as a 16-byte GB tile (2bpp interleaved). */
function encodeTile(pxIdx, tx, ty, w) {
  const out = new Uint8Array(16);
  for (let row = 0; row < 8; row++) {
    let lo = 0, hi = 0;
    for (let col = 0; col < 8; col++) {
      const c = pxIdx[(ty * 8 + row) * w + (tx * 8 + col)];
      if (c & 1) lo |= 1 << (7 - col);
      if (c & 2) hi |= 1 << (7 - col);
    }
    out[row * 2 + 0] = lo;
    out[row * 2 + 1] = hi;
  }
  return out;
}

/**
 * @param {Object} args
 * @param {Buffer | Uint8Array} args.pngBytes  160×144 PNG, pre-quantized to ≤4 colors.
 * @param {[number,number,number][]} [args.shadePalette] target 4 RGB shades
 *   (default DMG green). Used only for the preview render — the encoded
 *   bytes are palette-index 0..3, the hardware BGP register selects shades.
 * @returns {{
 *   chr: Uint8Array,        // tile data (2bpp interleaved, 16B/tile)
 *   nametable: Uint8Array,  // 32×32 map (we fill 20×18 + zeros)
 *   attr: Uint8Array,       // empty (DMG has no per-cell attr)
 *   palette: Uint8Array,    // empty (DMG palette is in BGP/OBP regs, not RAM)
 *   uniqueTilesBeforeMerge: number,
 *   uniqueTiles: number,
 *   imageColors: number,
 *   previewPng: Buffer,
 * }}
 */
export function gbImageToTilemap(args) {
  const png = PNG.sync.read(Buffer.from(args.pngBytes));
  if (png.width !== W || png.height !== H) {
    throw new Error(`GB image must be ${W}×${H}, got ${png.width}×${png.height}`);
  }
  const shadePalette = args.shadePalette ?? DMG_PALETTE;

  // 1) Quantize to ≤4 distinct colors. Map by tuple identity.
  /** @type {Map<number, number>} */
  const colorIndex = new Map();
  const pxIdx = new Uint8Array(W * H);
  const colorKey = (r, g, b) => (r << 16) | (g << 8) | b;
  for (let i = 0; i < W * H; i++) {
    const k = i * 4;
    const ck = colorKey(png.data[k], png.data[k + 1], png.data[k + 2]);
    let idx = colorIndex.get(ck);
    if (idx === undefined) {
      idx = colorIndex.size;
      if (idx >= 4) {
        throw new Error(
          `GB DMG mode takes ≤4 colors; image quantizes to more. ` +
          `Pre-dither with \`magick … -colors 4 -dither FloydSteinberg\` or ` +
          `pass a palette via getPlatformPalettePng({platform:"gb"}).`
        );
      }
      colorIndex.set(ck, idx);
    }
    pxIdx[i] = idx;
  }

  // 2) Encode tiles + dedupe (no h/v flip dedup for v1 — GB tile-map cells
  // don't have flip flags in DMG mode).
  const tilesAcross = W / 8;  // 20
  const tilesDown = H / 8;    // 18
  const tileByKey = new Map();
  const chr = [];
  let uniqueBefore = 0;

  // GB BG map is 32 cols × 32 rows; we write the visible 20×18 area and
  // leave the rest as tile 0.
  const nametable = new Uint8Array(32 * 32);

  for (let ty = 0; ty < tilesDown; ty++) {
    for (let tx = 0; tx < tilesAcross; tx++) {
      uniqueBefore++;
      const tile = encodeTile(pxIdx, tx, ty, W);
      let key = "";
      for (const b of tile) key += b.toString(16).padStart(2, "0");
      let idx = tileByKey.get(key);
      if (idx === undefined) {
        if (chr.length >= 256) {
          throw new Error(
            `GB DMG tilemap exceeded 256 unique tiles after dedup. ` +
            `Reduce image detail or use bank-switched tile data (CGB only).`
          );
        }
        idx = chr.length;
        tileByKey.set(key, idx);
        chr.push(tile);
      }
      nametable[ty * 32 + tx] = idx;
    }
  }

  const chrFlat = new Uint8Array(chr.length * 16);
  for (let i = 0; i < chr.length; i++) chrFlat.set(chr[i], i * 16);

  // 3) Preview re-render from encoded data.
  const preview = new PNG({ width: W, height: H });
  for (let ty = 0; ty < tilesDown; ty++) {
    for (let tx = 0; tx < tilesAcross; tx++) {
      const tileIdx = nametable[ty * 32 + tx];
      const tileBase = tileIdx * 16;
      for (let row = 0; row < 8; row++) {
        const lo = chrFlat[tileBase + row * 2 + 0];
        const hi = chrFlat[tileBase + row * 2 + 1];
        for (let col = 0; col < 8; col++) {
          const bit = 7 - col;
          const pi = ((lo >> bit) & 1) | (((hi >> bit) & 1) << 1);
          const [r, g, b] = shadePalette[pi];
          const o = ((ty * 8 + row) * W + (tx * 8 + col)) * 4;
          preview.data[o + 0] = r;
          preview.data[o + 1] = g;
          preview.data[o + 2] = b;
          preview.data[o + 3] = 0xff;
        }
      }
    }
  }

  return {
    chr: chrFlat,
    nametable,
    attr: new Uint8Array(0),
    palette: new Uint8Array(0),
    uniqueTilesBeforeMerge: uniqueBefore,
    uniqueTiles: chr.length,
    imageColors: colorIndex.size,
    previewPng: PNG.sync.write(preview),
  };
}

/**
 * Generate a PNG containing the 4 DMG shades. Use as -remap target for
 * pre-dithering input art.
 */
export function gbPalettePng() {
  const cell = 32;
  const png = new PNG({ width: 4 * cell, height: cell });
  for (let i = 0; i < 4; i++) {
    const [r, g, b] = DMG_PALETTE[i];
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
  return PNG.sync.write(png);
}
