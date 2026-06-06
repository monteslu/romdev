// PC Engine image-to-tilemap converter (HuC6270 BG, 4bpp).
//
// The PCE background is a tilemap ("BAT" = Background Attribute Table) of 16-bit
// entries in VRAM, each: bits 0-10 = tile index, bits 12-15 = sub-palette (0-15).
// Tiles are 8×8, 4bpp, in the "planar-pairs" layout (see pce/tiles.js — identical
// to SNES: 16 B plane 0+1, then 16 B plane 2+3). This converter:
//   1. quantizes the image to ≤16 colors (one BG sub-palette),
//   2. cuts 8×8 tiles, dedups them (h/v-flip NOT supported by the PCE BAT, so
//      dedup is exact-match only),
//   3. emits the tile bytes + the BAT + a suggested 16-color VCE palette.
//
// Image dimensions must be multiples of 8. The default virtual screen is 32×28
// cells (256×224) but any multiple-of-8 image works; the caller DMAs the BAT to
// VRAM and sets the VDC MWR for the matching virtual-screen size.

import { PNG } from "pngjs";
import { encodePceTile } from "./tiles.js";

/** Pack 8-bit RGB → a 9-bit VCE GRB word (0bGGG_RRR_BBB), 3 bits per channel. */
function rgbToVce(r, g, b) {
  const r3 = (r * 7 / 255) | 0;
  const g3 = (g * 7 / 255) | 0;
  const b3 = (b * 7 / 255) | 0;
  return (g3 << 6) | (r3 << 3) | b3;
}

/**
 * @param {{ pngBytes: Uint8Array|Buffer, baseTile?: number, subPalette?: number }} args
 * @returns {{ tiles: Uint8Array, nametable: Uint8Array, attr: Uint8Array,
 *   palette: Uint8Array, uniqueTiles: number, tilesAcross: number, tilesDown: number }}
 */
export function pceImageToTilemap(args) {
  const png = PNG.sync.read(Buffer.from(args.pngBytes));
  const { width: W, height: H } = png;
  if (W % 8 || H % 8) {
    throw new Error(`PCE image must be a multiple of 8 in both dimensions, got ${W}×${H}.`);
  }
  const baseTile = args.baseTile ?? 0;
  const subPalette = (args.subPalette ?? 0) & 0x0f;

  // 1) Quantize to ≤16 colors (color 0 = backdrop/transparent).
  const colorIndex = new Map();
  const pxIdx = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    const k = i * 4;
    const c = rgbToVce(png.data[k], png.data[k + 1], png.data[k + 2]);
    let idx = colorIndex.get(c);
    if (idx === undefined) {
      idx = colorIndex.size;
      if (idx >= 16) {
        throw new Error("PCE BG tiles take ≤16 colors per sub-palette; image quantizes to more. Reduce to 16 colors first (e.g. `magick … -colors 16 -dither FloydSteinberg`).");
      }
      colorIndex.set(c, idx);
    }
    pxIdx[i] = idx;
  }

  // 2) Build the VCE palette (16 × u16, little-endian).
  const palette = new Uint8Array(16 * 2);
  for (const [grb, idx] of colorIndex) {
    palette[idx * 2] = grb & 0xff;
    palette[idx * 2 + 1] = (grb >> 8) & 0x01;
  }

  // 3) Cut + dedup tiles (exact match; the BAT has no flip bits).
  const tilesAcross = W >> 3;
  const tilesDown = H >> 3;
  const tileMap = new Map();        // tile-hash → index
  const tileBytes = [];
  const nametable = new Uint8Array(tilesAcross * tilesDown * 2);
  const cell = new Uint8Array(64);

  for (let ty = 0; ty < tilesDown; ty++) {
    for (let tx = 0; tx < tilesAcross; tx++) {
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
        cell[y * 8 + x] = pxIdx[(ty * 8 + y) * W + (tx * 8 + x)];
      }
      const enc = encodePceTile(cell);
      const hash = Array.from(enc).join(",");
      let idx = tileMap.get(hash);
      if (idx === undefined) {
        idx = tileMap.size;
        tileMap.set(hash, idx);
        tileBytes.push(enc);
      }
      const tileIndex = (baseTile + idx) & 0x07ff;
      const batEntry = tileIndex | (subPalette << 12);
      const off = (ty * tilesAcross + tx) * 2;
      nametable[off] = batEntry & 0xff;
      nametable[off + 1] = (batEntry >> 8) & 0xff;
    }
  }

  const tiles = new Uint8Array(tileBytes.length * 32);
  tileBytes.forEach((t, i) => tiles.set(t, i * 32));

  return {
    tiles,
    nametable,                 // the BAT (16-bit entries, LE)
    attr: new Uint8Array(0),   // PCE attributes are packed into the BAT entry
    palette,
    uniqueTiles: tileBytes.length,
    tilesAcross,
    tilesDown,
  };
}

/** Render a 16-color VCE palette as a small PNG swatch (for the tool preview). */
export function pcePalettePng(palette) {
  const cols = 16, sw = 12;
  const png = new PNG({ width: cols * sw, height: sw });
  for (let i = 0; i < 16; i++) {
    const v = (palette[i * 2] | (palette[i * 2 + 1] << 8)) & 0x1ff;
    const r = Math.round(((v >> 3) & 7) * 255 / 7);
    const g = Math.round(((v >> 6) & 7) * 255 / 7);
    const b = Math.round((v & 7) * 255 / 7);
    for (let y = 0; y < sw; y++) for (let x = 0; x < sw; x++) {
      const o = (y * cols * sw + i * sw + x) * 4;
      png.data[o] = r; png.data[o + 1] = g; png.data[o + 2] = b; png.data[o + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}
