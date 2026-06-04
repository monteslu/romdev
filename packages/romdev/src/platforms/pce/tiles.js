// PC Engine HuC6270 tile (background + sprite) codec.
//
// A PCE 8×8 background tile is 16 VRAM words (32 bytes), 4 bitplanes packed as
// two word-pairs per row (geargrafx huc6270.cpp:721-733 is canonical):
//   word at (tile<<4)+row     : low byte = plane 0, high byte = plane 1
//   word at (tile<<4)+row + 8  : low byte = plane 2, high byte = plane 3
// Pixel = plane0 | plane1<<1 | plane2<<2 | plane3<<3, MSB-first (leftmost pixel
// is bit 7). So a tile in raw bytes (little-endian words) is:
//   [p0_row0, p1_row0, p0_row1, p1_row1, ... p0_row7, p1_row7,   (16 bytes)
//    p2_row0, p3_row0, p2_row1, p3_row1, ... p2_row7, p3_row7]   (16 bytes)
//
// Sprites use the same 4-plane scheme but a 16×16 cell (64 words); the 8×8
// encoder below is the building block (an agent tiles 16×16 sprites as 4 cells).

/**
 * Encode an 8×8 indexed tile (64 entries, 0-15) into the 32-byte PCE format.
 * @param {Uint8Array|number[]} indices length 64, row-major, values 0-15
 * @returns {Uint8Array} 32 bytes
 */
export function encodePceTile(indices) {
  const out = new Uint8Array(32);
  for (let row = 0; row < 8; row++) {
    let p0 = 0, p1 = 0, p2 = 0, p3 = 0;
    for (let x = 0; x < 8; x++) {
      const v = indices[row * 8 + x] & 0x0f;
      const bit = 7 - x; // MSB-first
      if (v & 0x01) p0 |= 1 << bit;
      if (v & 0x02) p1 |= 1 << bit;
      if (v & 0x04) p2 |= 1 << bit;
      if (v & 0x08) p3 |= 1 << bit;
    }
    // word (p0,p1) at byte row*2; word (p2,p3) at byte 16 + row*2 (little-endian).
    out[row * 2] = p0;
    out[row * 2 + 1] = p1;
    out[16 + row * 2] = p2;
    out[16 + row * 2 + 1] = p3;
  }
  return out;
}

/**
 * Decode a 32-byte PCE tile back to 64 palette indices (0-15), row-major.
 * @param {Uint8Array} bytes 32 bytes
 * @param {number} [offset]
 * @returns {Uint8Array} length 64
 */
export function decodePceTile(bytes, offset = 0) {
  const out = new Uint8Array(64);
  for (let row = 0; row < 8; row++) {
    const p0 = bytes[offset + row * 2];
    const p1 = bytes[offset + row * 2 + 1];
    const p2 = bytes[offset + 16 + row * 2];
    const p3 = bytes[offset + 16 + row * 2 + 1];
    for (let x = 0; x < 8; x++) {
      const bit = 7 - x;
      out[row * 8 + x] =
        ((p0 >> bit) & 1) |
        (((p1 >> bit) & 1) << 1) |
        (((p2 >> bit) & 1) << 2) |
        (((p3 >> bit) & 1) << 3);
    }
  }
  return out;
}

/**
 * Encode a full image's worth of 8×8 tiles. The image must be a multiple of 8
 * in both dimensions; tiles are emitted left-to-right, top-to-bottom.
 * @param {Uint8Array} indexed width*height palette indices (0-15)
 * @param {number} width
 * @param {number} height
 * @returns {Uint8Array} (width/8)*(height/8)*32 bytes
 */
export function encodePceTiles(indexed, width, height) {
  const cols = width >> 3;
  const rows = height >> 3;
  const out = new Uint8Array(cols * rows * 32);
  const tile = new Uint8Array(64);
  let o = 0;
  for (let ty = 0; ty < rows; ty++) {
    for (let tx = 0; tx < cols; tx++) {
      for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 8; x++) {
          tile[y * 8 + x] = indexed[(ty * 8 + y) * width + (tx * 8 + x)];
        }
      }
      out.set(encodePceTile(tile), o);
      o += 32;
    }
  }
  return out;
}
