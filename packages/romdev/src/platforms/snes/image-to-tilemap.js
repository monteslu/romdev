// SNES image-to-tilemap converter (4bpp / mode 1 BG1).
//
// Way simpler than the 2bpp version because we don't need per-cell palette
// clustering: 16 colors per tile is enough that the WHOLE image fits in a
// single 16-color global palette. Caller is expected to dither the source
// to exactly 16 colors via imagemagick first; we just chop into tiles.
//
// Outputs:
//   - chr      4bpp tile data, 32 bytes per 8x8 tile.
//              Byte layout: first 16 bytes = planes 0+1 row-interleaved
//              (row0p0, row0p1, row1p0, row1p1, ..., row7p1), then next
//              16 bytes = planes 2+3 in the same order.
//   - tilemap  2 bytes per cell × 32×32 cells = 2048 bytes. All entries
//              use palette 0 (the only palette we populate).
//   - palette  32 bytes (16 BGR555 colors, little-endian). Goes to CGRAM
//              starting at index 0.

import { PNG } from "pngjs";

const W = 256;
const H = 224;

function rgbToBgr555(r, g, b) {
  const r5 = (r >> 3) & 0x1F;
  const g5 = (g >> 3) & 0x1F;
  const b5 = (b >> 3) & 0x1F;
  return (b5 << 10) | (g5 << 5) | r5;
}

/**
 * @param {Object} args
 * @param {Buffer | Uint8Array} args.pngBytes  256×224 PNG, ideally already
 *   dithered to ≤16 colors via imagemagick.
 * @returns {{
 *   chr: Uint8Array,
 *   tilemap: Uint8Array,
 *   palette: Uint8Array,
 *   uniqueTiles: number,
 *   imageColors: number,
 *   previewPng: Buffer,
 * }}
 */
export function snesImageToTilemap(args) {
  const png = PNG.sync.read(Buffer.from(args.pngBytes));
  if (png.width !== W || png.height !== H) {
    throw new Error(`SNES image must be ${W}×${H}, got ${png.width}×${png.height}`);
  }

  // 1) Convert every pixel to BGR555. Collect the up-to-16 distinct colors.
  // Color 0 = whichever appears as the FIRST pixel (top-left), which makes
  // the universal backdrop deterministic — imagemagick's quantizer puts the
  // most-common color at index 0 in its output palette anyway.
  /** @type {Map<number, number>} BGR555 → palette index 0..15 */
  const colorIndex = new Map();
  const pxIdx = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    const k = i * 4;
    const c = rgbToBgr555(png.data[k], png.data[k + 1], png.data[k + 2]);
    let idx = colorIndex.get(c);
    if (idx === undefined) {
      idx = colorIndex.size;
      if (idx >= 16) {
        throw new Error(
          `SNES 4bpp requires ≤16 distinct colors; image has more. Use \`magick … -colors 16 -dither FloydSteinberg\` first.`
        );
      }
      colorIndex.set(c, idx);
    }
    pxIdx[i] = idx;
  }

  // 2) Build 32-byte palette: 16 colors × 2 bytes (BGR555 little-endian).
  // Slot 0 (backdrop) is the first color we saw.
  const palette = new Uint8Array(32);
  for (const [c, idx] of colorIndex) {
    palette[idx * 2 + 0] = c & 0xFF;
    palette[idx * 2 + 1] = (c >> 8) & 0xFF;
  }

  // 3) Encode each 8×8 tile in 4bpp format and dedupe identical bitmaps.
  const tilesAcross = W / 8;   // 32
  const tilesDown = H / 8;     // 28

  const makeTile = (tx, ty) => {
    const t = new Uint8Array(32);
    for (let yy = 0; yy < 8; yy++) {
      let p0 = 0, p1 = 0, p2 = 0, p3 = 0;
      for (let xx = 0; xx < 8; xx++) {
        const c = pxIdx[(ty * 8 + yy) * W + (tx * 8 + xx)];
        if (c & 1) p0 |= 1 << (7 - xx);
        if (c & 2) p1 |= 1 << (7 - xx);
        if (c & 4) p2 |= 1 << (7 - xx);
        if (c & 8) p3 |= 1 << (7 - xx);
      }
      // SNES 4bpp tile layout — confirmed by trial:
      // Row Y uses 4 bytes: planes 0+1+2+3 interleaved at offsets:
      //   yy*2+0     plane 0 (LSB)
      //   yy*2+1     plane 1
      //   16+yy*2+0  plane 2
      //   16+yy*2+1  plane 3 (MSB)
      t[yy * 2 + 0] = p0;
      t[yy * 2 + 1] = p1;
      t[16 + yy * 2 + 0] = p2;
      t[16 + yy * 2 + 1] = p3;
    }
    return t;
  };

  /** @type {Uint8Array[]} */
  const tileList = [];
  const tileMap = new Map();
  // Tilemap is 32×32 entries (2 bytes each) = 2048 bytes. Visible area is
  // 32×28; bottom 4 rows stay as tile 0 (no-op).
  const tilemap = new Uint8Array(32 * 32 * 2);
  for (let ty = 0; ty < tilesDown; ty++) {
    for (let tx = 0; tx < tilesAcross; tx++) {
      const t = makeTile(tx, ty);
      const key = Buffer.from(t).toString("hex");
      let idx = tileMap.get(key);
      if (idx === undefined) {
        idx = tileList.length;
        tileList.push(t);
        tileMap.set(key, idx);
      }
      // Tilemap word: bits 0-9 tile index, bits 11-13 palette (we use 0).
      const entry = idx & 0x3FF;
      const off = (ty * 32 + tx) * 2;
      tilemap[off + 0] = entry & 0xFF;
      tilemap[off + 1] = (entry >> 8) & 0xFF;
    }
  }

  // Hard fail past 1024 tiles (max BG1 can address).
  if (tileList.length > 1024) {
    throw new Error(`SNES 4bpp BG1 can address 1024 tiles; image needs ${tileList.length}.`);
  }

  const chr = Buffer.concat(tileList.map((t) => Buffer.from(t)));

  // 4) Preview PNG (render from CHR + tilemap + palette).
  const preview = new PNG({ width: W, height: H });
  const palRgb = new Array(16);
  for (const [c, idx] of colorIndex) {
    const r = ((c >> 0) & 0x1F) << 3;
    const g = ((c >> 5) & 0x1F) << 3;
    const b = ((c >> 10) & 0x1F) << 3;
    palRgb[idx] = [r, g, b];
  }
  for (let ty = 0; ty < tilesDown; ty++) {
    for (let tx = 0; tx < tilesAcross; tx++) {
      const off = (ty * 32 + tx) * 2;
      const entry = tilemap[off] | (tilemap[off + 1] << 8);
      const tileIdx = entry & 0x3FF;
      const tile = tileList[tileIdx];
      for (let yy = 0; yy < 8; yy++) {
        const p0 = tile[yy * 2 + 0];
        const p1 = tile[yy * 2 + 1];
        const p2 = tile[16 + yy * 2 + 0];
        const p3 = tile[16 + yy * 2 + 1];
        for (let xx = 0; xx < 8; xx++) {
          const ci =
            ((p0 >> (7 - xx)) & 1) |
            (((p1 >> (7 - xx)) & 1) << 1) |
            (((p2 >> (7 - xx)) & 1) << 2) |
            (((p3 >> (7 - xx)) & 1) << 3);
          const [r, g, b] = palRgb[ci];
          const i = ((ty * 8 + yy) * W + (tx * 8 + xx)) * 4;
          preview.data[i] = r;
          preview.data[i + 1] = g;
          preview.data[i + 2] = b;
          preview.data[i + 3] = 255;
        }
      }
    }
  }
  const previewPng = PNG.sync.write(preview);

  return {
    chr,
    tilemap,
    palette,
    uniqueTiles: tileList.length,
    imageColors: colorIndex.size,
    previewPng,
  };
}

/**
 * Emit a 16-color sample SNES palette PNG (useful as imagemagick -remap
 * target). For SNES we generally want imagemagick to PICK its own 16
 * colors via `-colors 16`, then quantize within those — there's no
 * "canonical 16 SNES greys" the way the NES has a fixed master palette.
 *
 * We provide a generic vibrant 16-color palette as a default. Caller can
 * override by using their own remap PNG.
 */
export function snesPalettePng() {
  // 16 well-spaced colors covering the BGR555 gamut.
  const cs = [
    [0, 0, 0],
    [128, 128, 128],
    [255, 255, 255],
    [128, 0, 0],
    [255, 0, 0],
    [255, 128, 0],
    [255, 255, 0],
    [0, 128, 0],
    [0, 255, 0],
    [0, 128, 128],
    [0, 255, 255],
    [0, 0, 128],
    [0, 0, 255],
    [128, 0, 128],
    [255, 0, 255],
    [128, 64, 0],
  ];
  const png = new PNG({ width: 16, height: 1 });
  for (let i = 0; i < 16; i++) {
    const [r, g, b] = cs[i];
    const k = i * 4;
    png.data[k] = r;
    png.data[k + 1] = g;
    png.data[k + 2] = b;
    png.data[k + 3] = 255;
  }
  return PNG.sync.write(png);
}
