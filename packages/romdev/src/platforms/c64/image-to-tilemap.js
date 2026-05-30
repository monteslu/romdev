// C64 image → charset/screen/color conversion.
//
// The C64 has no "tilemap" in the NES sense, but its standard hi-res
// character mode is the direct analog: a 40×25 grid of 8×8 cells, each
// cell a char code into a 2 KB charset (256 chars × 8 bytes, 1bpp). Per
// cell you get ONE foreground color (from Color RAM, $D800) over a SINGLE
// shared background color ($D021). So each 8×8 cell is 2-color.
//
// This maps onto the generic imageToTilemap contract:
//   chr        → charset bytes (deduped 8×8 1bpp chars, ≤256 × 8 = ≤2048 B)
//   nametable  → screen RAM (1000 bytes, char code per cell)
//   attr       → color RAM (1000 bytes, low nibble = fg color 0..15 per cell)
//   palette    → 1 byte: the shared background color index
//
// Input must be 320×200, already quantized to the 16-color C64 palette
// (use getPlatformPalettePng({platform:"c64"}) as the ImageMagick -remap
// target). Each 8×8 cell may use at most 2 of those colors (one is the
// global background, the other is that cell's foreground) — hi-res char
// mode's hard constraint. Cells that violate it are reported.

import { PNG } from "pngjs";
import { C64_PALETTE } from "./vic.js";

const W = 320;
const H = 200;
const COLS = 40;
const ROWS = 25;

/** nearest C64 palette index for an (r,g,b) — exact match preferred. */
function nearestC64Index(r, g, b) {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < 16; i++) {
    const [pr, pg, pb] = C64_PALETTE[i];
    const d = (pr - r) ** 2 + (pg - g) ** 2 + (pb - b) ** 2;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

/**
 * Convert a 320×200 PNG into C64 hi-res character-mode assets.
 *
 * @param {{ pngBytes: Buffer|Uint8Array, backdrop?: number }} args
 *   backdrop: force a specific palette index (0..15) as the shared
 *   background color. If omitted, the most-common color is chosen.
 * @returns {{
 *   chr: Uint8Array, nametable: Uint8Array, attr: Uint8Array,
 *   palette: Uint8Array, uniqueTilesBeforeMerge: number, uniqueTiles: number,
 *   imageColors: number, backgroundColor: number, previewPng: Buffer,
 *   warnings: string[]
 * }}
 */
export function c64ImageToTilemap(args) {
  const png = PNG.sync.read(Buffer.from(args.pngBytes));
  if (png.width !== W || png.height !== H) {
    throw new Error(`C64 hi-res image must be ${W}×${H}, got ${png.width}×${png.height}`);
  }

  // Quantize every pixel to a C64 palette index.
  const pxIdx = new Uint8Array(W * H);
  const colorHist = new Array(16).fill(0);
  for (let i = 0; i < W * H; i++) {
    const k = i * 4;
    const ci = nearestC64Index(png.data[k], png.data[k + 1], png.data[k + 2]);
    pxIdx[i] = ci;
    colorHist[ci]++;
  }

  // Choose the shared background color: caller override, else most common.
  let bg = args.backdrop;
  if (bg == null) {
    bg = 0;
    for (let i = 1; i < 16; i++) if (colorHist[i] > colorHist[bg]) bg = i;
  }

  const warnings = [];
  const charByKey = new Map();
  const chars = []; // each: Uint8Array(8)
  const screen = new Uint8Array(COLS * ROWS);
  const color = new Uint8Array(COLS * ROWS);
  let uniqueBefore = 0;
  let overflowReported = false;
  let multiColorCells = 0;

  for (let cy = 0; cy < ROWS; cy++) {
    for (let cx = 0; cx < COLS; cx++) {
      uniqueBefore++;
      // Determine this cell's foreground color: the most-common non-bg
      // color in the cell. Any pixel that's neither bg nor fg is forced
      // to fg (and counted as a constraint violation).
      const cellHist = new Array(16).fill(0);
      for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 8; x++) {
          cellHist[pxIdx[(cy * 8 + y) * W + (cx * 8 + x)]]++;
        }
      }
      let fg = -1;
      for (let i = 0; i < 16; i++) {
        if (i === bg) continue;
        if (fg === -1 || cellHist[i] > cellHist[fg]) fg = i;
      }
      if (fg === -1) fg = bg; // solid-background cell
      const distinctNonBg = cellHist.filter((c, i) => c > 0 && i !== bg).length;
      if (distinctNonBg > 1) multiColorCells++;

      // Encode the 8×8 char: bit set = foreground pixel.
      const ch = new Uint8Array(8);
      for (let y = 0; y < 8; y++) {
        let byte = 0;
        for (let x = 0; x < 8; x++) {
          const p = pxIdx[(cy * 8 + y) * W + (cx * 8 + x)];
          // A pixel is "foreground" if it's not the bg color.
          if (p !== bg) byte |= 1 << (7 - x);
        }
        ch[y] = byte;
      }

      let key = "";
      for (const b of ch) key += b.toString(16).padStart(2, "0");
      let idx = charByKey.get(key);
      if (idx === undefined) {
        if (chars.length >= 256) {
          if (!overflowReported) {
            warnings.push(
              `Image needs more than 256 unique chars after dedup — extra cells reuse char 0. ` +
              `Reduce detail or split across multiple charsets/screens.`
            );
            overflowReported = true;
          }
          idx = 0;
        } else {
          idx = chars.length;
          charByKey.set(key, idx);
          chars.push(ch);
        }
      }
      screen[cy * COLS + cx] = idx;
      color[cy * COLS + cx] = fg & 0x0F;
    }
  }

  if (multiColorCells > 0) {
    warnings.push(
      `${multiColorCells} of ${COLS * ROWS} cells contain >2 colors (bg + >1 fg). ` +
      `Hi-res char mode is 2 colors per 8×8 cell — those cells collapsed all non-background ` +
      `pixels to a single foreground color. For 3-4 colors per cell use multicolor mode ` +
      `(half horizontal resolution) — not yet implemented; pre-author the image to 2 colors/cell.`
    );
  }

  const chrFlat = new Uint8Array(chars.length * 8);
  for (let i = 0; i < chars.length; i++) chrFlat.set(chars[i], i * 8);

  // Preview: re-render from encoded charset + screen + color.
  const preview = new PNG({ width: W, height: H });
  const [bgr, bgg, bgb] = C64_PALETTE[bg];
  for (let cy = 0; cy < ROWS; cy++) {
    for (let cx = 0; cx < COLS; cx++) {
      const charCode = screen[cy * COLS + cx];
      const fg = color[cy * COLS + cx];
      const [fr, fgg, fb] = C64_PALETTE[fg];
      const base = charCode * 8;
      for (let y = 0; y < 8; y++) {
        const byte = chrFlat[base + y];
        for (let x = 0; x < 8; x++) {
          const on = (byte >> (7 - x)) & 1;
          const o = ((cy * 8 + y) * W + (cx * 8 + x)) * 4;
          preview.data[o + 0] = on ? fr : bgr;
          preview.data[o + 1] = on ? fgg : bgg;
          preview.data[o + 2] = on ? fb : bgb;
          preview.data[o + 3] = 0xFF;
        }
      }
    }
  }

  return {
    chr: chrFlat,
    nametable: screen,
    attr: color,
    palette: new Uint8Array([bg]),
    uniqueTilesBeforeMerge: uniqueBefore,
    uniqueTiles: chars.length,
    imageColors: colorHist.filter((c) => c > 0).length,
    backgroundColor: bg,
    previewPng: PNG.sync.write(preview),
    warnings,
  };
}
