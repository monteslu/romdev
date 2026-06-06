// SMS / Game Gear image-to-tilemap converter (4bpp mode 4).
//
// SMS resolution: 256×192 (32 × 24 cells). 4bpp interleaved tile layout:
//   tile = 32 bytes = 8 rows × 4 bytes/row
//   each row = p0, p1, p2, p3 in that order (one byte per plane)
//
// SMS palette: 32 entries × 6-bit BGR (1 byte each).
//   Entries 0..15 = BG palette
//   Entries 16..31 = sprite palette
//
// Name table format: each cell is 2 bytes little-endian:
//   bit 0-8: tile index (0..511)
//   bit 9:   horizontal flip
//   bit 10:  vertical flip
//   bit 11:  palette (0 = BG, 1 = sprite)
//   bit 12:  priority (1 = above sprites)

import { PNG } from "pngjs";

const W = 256;
const H = 192;

/** RGB → SMS 6-bit BGR byte (2 bits per channel). */
function rgbToSmsByte(r, g, b) {
  const r2 = (r >> 6) & 0x03;
  const g2 = (g >> 6) & 0x03;
  const b2 = (b >> 6) & 0x03;
  return r2 | (g2 << 2) | (b2 << 4);
}

/** SMS 6-bit byte → RGB triple. */
function smsByteToRgb(byte) {
  const r2 = byte & 0x03;
  const g2 = (byte >> 2) & 0x03;
  const b2 = (byte >> 4) & 0x03;
  const expand = (v) => (v << 6) | (v << 4) | (v << 2) | v;
  return [expand(r2), expand(g2), expand(b2)];
}

/**
 * @param {Object} args
 * @param {Buffer | Uint8Array} args.pngBytes  256×192 PNG, ideally pre-dithered to ≤16 colors.
 * @returns {{
 *   chr: Uint8Array,
 *   nametable: Uint8Array,
 *   attr: Uint8Array,
 *   palette: Uint8Array,
 *   uniqueTilesBeforeMerge: number,
 *   uniqueTiles: number,
 *   imageColors: number,
 *   previewPng: Buffer,
 * }}
 */
export function smsImageToTilemap(args) {
  const png = PNG.sync.read(Buffer.from(args.pngBytes));
  if (png.width !== W || png.height !== H) {
    throw new Error(`SMS image must be ${W}×${H}, got ${png.width}×${png.height}`);
  }

  // 1) Quantize to ≤16 distinct colors.
  /** @type {Map<number, number>} */
  const colorIndex = new Map();
  const pxIdx = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    const k = i * 4;
    const c = rgbToSmsByte(png.data[k], png.data[k + 1], png.data[k + 2]);
    let idx = colorIndex.get(c);
    if (idx === undefined) {
      idx = colorIndex.size;
      if (idx >= 16) {
        throw new Error(
          `SMS 4bpp BG layer takes ≤16 colors; image quantizes to more. ` +
          `Use \`magick … -colors 16 -dither FloydSteinberg\` first, or ` +
          `pre-remap against getPlatformPalettePng({platform:"sms"}).`
        );
      }
      colorIndex.set(c, idx);
    }
    pxIdx[i] = idx;
  }

  // 2) Build 32-byte palette (BG only — sprites stay zero).
  const palette = new Uint8Array(32);
  for (const [c, idx] of colorIndex) palette[idx] = c;

  // 3) Encode each 8×8 tile. Dedupe + detect h/v flips.
  const tilesAcross = W / 8;   // 32
  const tilesDown = H / 8;     // 24

  const makeTile = (tx, ty) => {
    const t = new Uint8Array(32);
    for (let row = 0; row < 8; row++) {
      let p0 = 0, p1 = 0, p2 = 0, p3 = 0;
      for (let col = 0; col < 8; col++) {
        const c = pxIdx[(ty * 8 + row) * W + (tx * 8 + col)];
        if (c & 1) p0 |= 1 << (7 - col);
        if (c & 2) p1 |= 1 << (7 - col);
        if (c & 4) p2 |= 1 << (7 - col);
        if (c & 8) p3 |= 1 << (7 - col);
      }
      t[row * 4 + 0] = p0;
      t[row * 4 + 1] = p1;
      t[row * 4 + 2] = p2;
      t[row * 4 + 3] = p3;
    }
    return t;
  };

  const flipH = (tile) => {
    const out = new Uint8Array(32);
    for (let i = 0; i < 32; i++) {
      let b = tile[i];
      // Reverse bits in this byte (this row's plane).
      b = ((b >> 1) & 0x55) | ((b & 0x55) << 1);
      b = ((b >> 2) & 0x33) | ((b & 0x33) << 2);
      b = ((b >> 4) & 0x0F) | ((b & 0x0F) << 4);
      out[i] = b & 0xFF;
    }
    return out;
  };
  const flipV = (tile) => {
    const out = new Uint8Array(32);
    for (let row = 0; row < 8; row++) {
      const srcRow = 7 - row;
      out[row * 4 + 0] = tile[srcRow * 4 + 0];
      out[row * 4 + 1] = tile[srcRow * 4 + 1];
      out[row * 4 + 2] = tile[srcRow * 4 + 2];
      out[row * 4 + 3] = tile[srcRow * 4 + 3];
    }
    return out;
  };

  const tileBytesByKey = new Map();   // raw-tile-key → tile-index in chr
  const chr = [];
  const nametable = new Uint8Array(tilesAcross * tilesDown * 2);

  const toKey = (t) => {
    // Hex string of 32 bytes — small enough for Map keys.
    let s = "";
    for (let i = 0; i < 32; i++) s += t[i].toString(16).padStart(2, "0");
    return s;
  };

  let uniqueBeforeMerge = 0;
  for (let ty = 0; ty < tilesDown; ty++) {
    for (let tx = 0; tx < tilesAcross; tx++) {
      const base = makeTile(tx, ty);
      uniqueBeforeMerge++;
      const baseKey = toKey(base);
      let flipBits = 0;
      let chosenKey = null;
      if (tileBytesByKey.has(baseKey)) {
        chosenKey = baseKey;
      } else {
        const h = flipH(base);
        const v = flipV(base);
        const hv = flipV(h);
        const hKey = toKey(h);
        const vKey = toKey(v);
        const hvKey = toKey(hv);
        if (tileBytesByKey.has(hKey))  { chosenKey = hKey; flipBits = 0x02; }      // hflip bit 9
        else if (tileBytesByKey.has(vKey))  { chosenKey = vKey; flipBits = 0x04; } // vflip bit 10
        else if (tileBytesByKey.has(hvKey)) { chosenKey = hvKey; flipBits = 0x06; }
        else {
          chosenKey = baseKey;
          tileBytesByKey.set(baseKey, chr.length);
          chr.push(base);
        }
      }
      const tileIdx = tileBytesByKey.get(chosenKey);
      // Name table entry (little-endian):
      //   bit 0-8: tile index (0..511)
      //   bit 9:   hflip
      //   bit 10:  vflip
      //   bit 11:  palette (0 = BG)
      //   bit 12:  priority
      const cellOff = (ty * tilesAcross + tx) * 2;
      nametable[cellOff + 0] = tileIdx & 0xFF;
      nametable[cellOff + 1] = ((tileIdx >> 8) & 0x01) | flipBits;
    }
  }

  // 4) Flatten chr.
  const chrFlat = new Uint8Array(chr.length * 32);
  for (let i = 0; i < chr.length; i++) chrFlat.set(chr[i], i * 32);

  // 5) Preview PNG — re-render from the encoded data so the agent can
  // sanity-check what the SMS will actually display.
  const preview = new PNG({ width: W, height: H });
  for (let ty = 0; ty < tilesDown; ty++) {
    for (let tx = 0; tx < tilesAcross; tx++) {
      const cellOff = (ty * tilesAcross + tx) * 2;
      const lo = nametable[cellOff];
      const hi = nametable[cellOff + 1];
      const tileIdx = lo | ((hi & 0x01) << 8);
      const hflip = !!(hi & 0x02);
      const vflip = !!(hi & 0x04);
      const tileBase = tileIdx * 32;
      for (let row = 0; row < 8; row++) {
        const srcRow = vflip ? 7 - row : row;
        const p0 = chrFlat[tileBase + srcRow * 4 + 0];
        const p1 = chrFlat[tileBase + srcRow * 4 + 1];
        const p2 = chrFlat[tileBase + srcRow * 4 + 2];
        const p3 = chrFlat[tileBase + srcRow * 4 + 3];
        for (let col = 0; col < 8; col++) {
          const srcBit = hflip ? col : 7 - col;
          const pi = ((p0 >> srcBit) & 1)
                  | (((p1 >> srcBit) & 1) << 1)
                  | (((p2 >> srcBit) & 1) << 2)
                  | (((p3 >> srcBit) & 1) << 3);
          const [r, g, b] = smsByteToRgb(palette[pi] ?? 0);
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
    attr: new Uint8Array(0),  // SMS attributes are per-cell in the nametable
    palette,
    uniqueTilesBeforeMerge: uniqueBeforeMerge,
    uniqueTiles: chr.length,
    imageColors: colorIndex.size,
    previewPng: PNG.sync.write(preview),
  };
}

/**
 * Generate a PNG containing every distinct SMS color (64 swatches).
 * Used as the -remap target for imagemagick dithering.
 */
export function smsPalettePng() {
  const cell = 16;
  const cols = 8;
  const rows = 8;
  const w = cols * cell;
  const h = rows * cell;
  const png = new PNG({ width: w, height: h });
  for (let i = 0; i < 64; i++) {
    const cx = (i % 8) * cell;
    const cy = Math.floor(i / 8) * cell;
    const [r, g, b] = smsByteToRgb(i);
    for (let y = 0; y < cell; y++) {
      for (let x = 0; x < cell; x++) {
        const o = ((cy + y) * w + (cx + x)) * 4;
        png.data[o + 0] = r;
        png.data[o + 1] = g;
        png.data[o + 2] = b;
        png.data[o + 3] = 0xff;
      }
    }
  }
  return PNG.sync.write(png);
}
