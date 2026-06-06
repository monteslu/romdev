// MSX screen-2 (GRAPHIC II) image-to-tilemap converter.
//
// screen-2 is the MSX1 workhorse "bitmap-ish" mode: the 256×192 screen is 32×24
// cells, each cell a unique 8×8 tile (the name table usually just counts
// 0,1,2,... per third of the screen). Each tile is:
//   - PATTERN: 8 bytes, 1bpp (bit 7 = leftmost pixel; 1 = foreground)
//   - COLOR:   8 bytes, one per row: high nibble = fg color (0-15), low = bg.
// The 16 colors are the fixed TMS9918 palette. Each ROW of a tile is limited to
// 2 colors — that's the classic MSX constraint this converter honors.
//
// A full 256×192 screen-2 picture is 768 unique tiles (3 banks of 256). This
// converter emits the name table (768 bytes: 0..255 ×3), the pattern table
// (768×8 = 6144 B) and the color table (6144 B), all DMA-ready.

import { PNG } from "pngjs";
import { TMS9918_PALETTE } from "./vdp.js";

/** Nearest TMS9918 palette index for an RGB triple. */
function nearestTms(r, g, b) {
  let best = 0, bestD = Infinity;
  for (let c = 0; c < 16; c++) {
    const [pr, pg, pb] = TMS9918_PALETTE[c];
    const dd = (pr - r) ** 2 + (pg - g) ** 2 + (pb - b) ** 2;
    if (dd < bestD) { bestD = dd; best = c; }
  }
  return best;
}

/**
 * @param {{ pngBytes: Uint8Array|Buffer }} args  PNG must be 256×192.
 * @returns {{ tiles: Uint8Array, color: Uint8Array, nametable: Uint8Array,
 *   uniqueTiles: number, tilesAcross: number, tilesDown: number }}
 */
export function msxImageToTilemap(args) {
  const png = PNG.sync.read(Buffer.from(args.pngBytes));
  const { width: W, height: H } = png;
  if (W !== 256 || H !== 192) {
    throw new Error(`MSX screen-2 image must be 256×192, got ${W}×${H}.`);
  }
  // Index every pixel to the fixed 16-color palette.
  const idx = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    const k = i * 4;
    idx[i] = nearestTms(png.data[k], png.data[k + 1], png.data[k + 2]);
  }

  const tilesAcross = 32, tilesDown = 24;
  const total = tilesAcross * tilesDown; // 768
  const pattern = new Uint8Array(total * 8);
  const color = new Uint8Array(total * 8);
  const nametable = new Uint8Array(total);

  let t = 0;
  for (let ty = 0; ty < tilesDown; ty++) {
    for (let tx = 0; tx < tilesAcross; tx++) {
      // Per-row: pick the row's 2 most-frequent colors (fg = 2nd, bg = 1st).
      for (let row = 0; row < 8; row++) {
        const counts = new Map();
        for (let x = 0; x < 8; x++) {
          const v = idx[(ty * 8 + row) * W + (tx * 8 + x)];
          counts.set(v, (counts.get(v) || 0) + 1);
        }
        const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]).map((e) => e[0]);
        const bg = sorted[0] ?? 0;
        const fg = sorted.find((c) => c !== bg) ?? bg;
        let bits = 0;
        for (let x = 0; x < 8; x++) {
          const v = idx[(ty * 8 + row) * W + (tx * 8 + x)];
          const isFg = v === fg || (v !== bg && Math.abs(v - fg) < Math.abs(v - bg));
          if (isFg) bits |= 1 << (7 - x);
        }
        pattern[t * 8 + row] = bits;
        color[t * 8 + row] = ((fg & 0x0f) << 4) | (bg & 0x0f);
      }
      // screen-2 name table: tiles are addressed 0..255 within each screen third.
      nametable[t] = t & 0xff;
      t++;
    }
  }

  return {
    tiles: pattern,            // the pattern-generator table (1bpp)
    color,                     // the color table (per-row fg/bg)
    nametable,                 // 768 bytes: 0..255 × 3 thirds
    uniqueTiles: total,
    tilesAcross,
    tilesDown,
  };
}

/** Render the fixed TMS9918 palette as a swatch PNG (for the tool preview). */
export function msxPalettePng() {
  const cols = 16, sw = 12;
  const png = new PNG({ width: cols * sw, height: sw });
  for (let i = 0; i < 16; i++) {
    const [r, g, b] = TMS9918_PALETTE[i];
    for (let y = 0; y < sw; y++) for (let x = 0; x < sw; x++) {
      const o = (y * cols * sw + i * sw + x) * 4;
      png.data[o] = r; png.data[o + 1] = g; png.data[o + 2] = b; png.data[o + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}
