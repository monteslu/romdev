// MSX TMS9918 / V9938 tile codec.
//
// MSX1 "screen 2" (GRAPHIC II) is the workhorse BG mode for homebrew. Each 8×8
// tile is two parallel 8-byte tables in VRAM:
//   - PATTERN table: 8 bytes, 1 bit per pixel (bit 7 = leftmost). 1 = foreground.
//   - COLOR table:   8 bytes, one per row; high nibble = foreground color index
//                    (0-15), low nibble = background color index. So each ROW of
//                    a tile can use a different fg/bg pair (the classic MSX
//                    "2 colors per 8-pixel line" constraint).
// The 16 colors are the fixed TMS9918 palette (see vdp.js TMS9918_PALETTE).
//
// This codec targets screen 2. MSX2 bitmap modes (screen 4+, 4bpp) are a
// different, larger format; this module covers the common homebrew case and
// `encodeMsxScreen2Tile` is explicit about the per-row 2-color limit.

/**
 * Encode one 8×8 tile to MSX screen-2 pattern + color bytes. Each row may use at
 * most 2 distinct colors (a foreground and a background); if a row has more, the
 * two most-common are kept and the rest snap to the nearer of those two by index.
 * @param {Uint8Array|number[]} indices 64 palette indices (0-15), row-major
 * @returns {{ pattern: Uint8Array, color: Uint8Array }} 8 bytes each
 */
export function encodeMsxScreen2Tile(indices) {
  const pattern = new Uint8Array(8);
  const color = new Uint8Array(8);
  for (let row = 0; row < 8; row++) {
    // Pick the row's two colors: most-frequent = background, next = foreground.
    const counts = new Map();
    for (let x = 0; x < 8; x++) {
      const v = indices[row * 8 + x] & 0x0f;
      counts.set(v, (counts.get(v) || 0) + 1);
    }
    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]).map((e) => e[0]);
    const bg = sorted[0] ?? 0;
    const fg = sorted.find((c) => c !== bg) ?? bg;
    let bits = 0;
    for (let x = 0; x < 8; x++) {
      const v = indices[row * 8 + x] & 0x0f;
      // Foreground bit set when the pixel is closer to fg than bg.
      const isFg = v === fg || (v !== bg && Math.abs(v - fg) < Math.abs(v - bg));
      if (isFg) bits |= 1 << (7 - x); // MSB-first
    }
    pattern[row] = bits;
    color[row] = ((fg & 0x0f) << 4) | (bg & 0x0f);
  }
  return { pattern, color };
}

/**
 * Decode an MSX screen-2 tile (8 pattern + 8 color bytes) back to 64 indices.
 * @param {Uint8Array} pattern 8 bytes
 * @param {Uint8Array} color 8 bytes
 * @returns {Uint8Array} 64 palette indices (0-15)
 */
export function decodeMsxScreen2Tile(pattern, color) {
  const out = new Uint8Array(64);
  for (let row = 0; row < 8; row++) {
    const bits = pattern[row];
    const fg = (color[row] >> 4) & 0x0f;
    const bg = color[row] & 0x0f;
    for (let x = 0; x < 8; x++) {
      out[row * 8 + x] = (bits >> (7 - x)) & 1 ? fg : bg;
    }
  }
  return out;
}

/**
 * Encode a full image to MSX screen-2 pattern + color streams. Image dims must
 * be multiples of 8. Returns the two tables (pattern then color) so the caller
 * can DMA each to its VRAM base.
 * @param {Uint8Array} indexed width*height palette indices (0-15)
 * @param {number} width
 * @param {number} height
 * @returns {{ pattern: Uint8Array, color: Uint8Array }}
 */
export function encodeMsxScreen2Tiles(indexed, width, height) {
  const cols = width >> 3;
  const rows = height >> 3;
  const n = cols * rows;
  const pattern = new Uint8Array(n * 8);
  const color = new Uint8Array(n * 8);
  const tile = new Uint8Array(64);
  let o = 0;
  for (let ty = 0; ty < rows; ty++) {
    for (let tx = 0; tx < cols; tx++) {
      for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 8; x++) {
          tile[y * 8 + x] = indexed[(ty * 8 + y) * width + (tx * 8 + x)];
        }
      }
      const enc = encodeMsxScreen2Tile(tile);
      pattern.set(enc.pattern, o * 8);
      color.set(enc.color, o * 8);
      o++;
    }
  }
  return { pattern, color };
}
