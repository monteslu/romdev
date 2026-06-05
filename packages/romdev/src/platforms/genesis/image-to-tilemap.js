// Genesis (VDP) — palette PNG generator for the -remap workflow.
//
// The Genesis VDP supports 512 distinct colors total: 8 levels per channel
// (R, G, B), 3 bits each, 9-bit overall. Hardware spec is "non-linear" —
// the ladder isn't perfectly evenly spaced — but for input-image
// quantization the linear approximation is what most tools use and
// matches what gpgx renders.
//
// Workflow: agent calls getPlatformPalettePng({platform:"genesis"}),
// saves to disk, runs `magick in.png -dither FloydSteinberg -remap
// genesis_palette.png out.png` to constrain colors to what the VDP can
// display, then passes out.png to imageToTilemap.

import { PNG } from "pngjs";
import { rgbToGenesisColor, decodeCRAM } from "./vdp.js";

const W = 320;
const H = 224;

/**
 * Convert a 320×224 PNG into Genesis VDP tilemap assets.
 *
 * Output shape matches the other platforms' imageToTilemap so the generic
 * dispatcher + the imageToTilemap MCP tool consume it directly:
 *   chr        → 4bpp packed tile data (32 B/tile, high nibble = left pixel)
 *   nametable  → 16-bit big-endian name-table entries
 *                (bit15 priority, 14-13 palette line, 12 vflip, 11 hflip, 10-0 tile)
 *   attr       → empty (Genesis packs palette/flip into the nametable entry)
 *   palette    → up to 4 lines × 16 colors × uint16 BE CRAM words (128 B)
 *
 * The Genesis can show 4 palette LINES of 16 colors each, and every 8×8
 * cell selects ONE line. We quantize the image to ≤64 distinct Genesis
 * colors, pack them into up to 4 lines, then per tile pick the line that
 * contains all of that tile's colors. Tiles whose colors span more than
 * one line are reported (the image needs authoring to ≤16 colors per 8×8
 * cell — the VDP's hard constraint, same as SNES/SMS).
 *
 * @param {Object} args
 * @param {Buffer|Uint8Array} args.pngBytes  320×224 PNG, pre-dithered to the Genesis palette.
 * @returns {{ chr:Uint8Array, nametable:Uint8Array, attr:Uint8Array, palette:Uint8Array,
 *   uniqueTilesBeforeMerge:number, uniqueTiles:number, imageColors:number,
 *   paletteLines:number, previewPng:Buffer, warnings:string[] }}
 */
export function genesisImageToTilemap(args) {
  const png = PNG.sync.read(Buffer.from(args.pngBytes));
  if (png.width !== W || png.height !== H) {
    throw new Error(`Genesis image must be ${W}×${H}, got ${png.width}×${png.height}`);
  }
  const warnings = [];

  // 1) Quantize every pixel to a Genesis 9-bit color WORD (the value the
  //    VDP actually stores). This collapses near-identical RGB to the same
  //    hardware color so the ≤64 budget is measured in real CRAM entries.
  const wordOf = new Uint16Array(W * H);
  const distinct = new Map(); // genesisWord → count
  for (let i = 0; i < W * H; i++) {
    const k = i * 4;
    const w = rgbToGenesisColor(png.data[k], png.data[k + 1], png.data[k + 2]);
    wordOf[i] = w;
    distinct.set(w, (distinct.get(w) || 0) + 1);
  }
  const imageColors = distinct.size;

  // 2) Per-tile color sets (sets of genesis words used by each 8×8 cell).
  const tilesAcross = W / 8; // 40
  const tilesDown = H / 8;   // 28
  const tileColorSets = [];
  for (let ty = 0; ty < tilesDown; ty++) {
    for (let tx = 0; tx < tilesAcross; tx++) {
      const set = new Set();
      for (let row = 0; row < 8; row++) {
        for (let col = 0; col < 8; col++) {
          set.add(wordOf[(ty * 8 + row) * W + (tx * 8 + col)]);
        }
      }
      tileColorSets.push(set);
    }
  }

  // 3) Build up to 4 palette lines (16 colors each). Greedy bin-packing:
  //    walk tiles, try to fit each tile's color set into an existing line;
  //    if it fits (line ∪ tileColors ≤ 16), merge; else open a new line.
  //    Color index 0 within a line is reserved as transparent/background.
  const lines = []; // each: Set<genesisWord>, with the backdrop word forced at idx 0
  const backdropEntry = [...distinct.entries()].sort((a, b) => b[1] - a[1])[0];
  const backdrop = backdropEntry[0]; // most common
  const tilePalLine = new Int8Array(tilesAcross * tilesDown).fill(-1);

  // FOOTGUN GUARD: the most-common color is forced to palette index 0, which is
  // TRANSPARENT on a scroll plane (it shows the hardware backdrop, not the
  // color). For a full-screen BG whose dominant color is a visible fill (e.g. a
  // white/blue sky), this silently renders that area as the backdrop color
  // (usually black) in-game. Warn — and the fix is one call: set that color as
  // the hardware backdrop so index 0 actually shows it.
  {
    const r0 = backdrop & 7, g0 = (backdrop >> 3) & 7, b0 = (backdrop >> 6) & 7;
    const dominantFrac = backdropEntry[1] / (png.width * png.height);
    if ((r0 || g0 || b0) && dominantFrac >= 0.15) {
      const hex = "#" + [r0, g0, b0].map((c) => Math.round((c / 7) * 255).toString(16).padStart(2, "0")).join("");
      warnings.push(
        `palette index 0 = a VISIBLE color (~${hex}, ${Math.round(dominantFrac * 100)}% of the image) — on a scroll PLANE index 0 is TRANSPARENT and shows the hardware backdrop (usually black), so this area will render wrong in-game. Fix: call VDP_setBackgroundColor() with this color's CRAM slot (palette-line*16 + 0) so the backdrop matches, OR recolor so index 0 is an intentional transparent/background color.`
      );
    }
  }

  // Sort tiles by descending color count so the hard ones grab lines first.
  const order = [...tileColorSets.keys()].sort((a, b) => tileColorSets[b].size - tileColorSets[a].size);
  for (const t of order) {
    const cols = tileColorSets[t];
    if (cols.size > 16) {
      warnings.push(`tile at cell ${t % tilesAcross},${Math.floor(t / tilesAcross)} uses ${cols.size} colors (>16); extra colors will be clamped.`);
    }
    let placed = -1;
    for (let li = 0; li < lines.length; li++) {
      // Would the union fit in 16 (counting backdrop at slot 0)?
      const union = new Set(lines[li]);
      for (const c of cols) union.add(c);
      union.add(backdrop);
      if (union.size <= 16) {
        lines[li] = union;
        placed = li;
        break;
      }
    }
    if (placed === -1) {
      if (lines.length < 4) {
        const nl = new Set([backdrop, ...cols]);
        lines.push(nl);
        placed = lines.length - 1;
      } else {
        // No room — assign to the line that already covers the most of this
        // tile's colors (best-effort; off-palette pixels map to nearest).
        let best = 0, bestHit = -1;
        for (let li = 0; li < 4; li++) {
          let hit = 0;
          for (const c of cols) if (lines[li].has(c)) hit++;
          if (hit > bestHit) { bestHit = hit; best = li; }
        }
        placed = best;
        warnings.push(`out of palette lines (max 4) — cell ${t % tilesAcross},${Math.floor(t / tilesAcross)} forced onto line ${best}; some colors approximated.`);
      }
    }
    tilePalLine[t] = placed;
  }
  if (lines.length === 0) lines.push(new Set([backdrop]));

  // 4) Materialize each line as an ordered 16-entry color array (index→word),
  //    backdrop at 0. Build a word→index lookup per line.
  const lineWords = lines.map((set) => {
    const arr = [backdrop, ...[...set].filter((w) => w !== backdrop)].slice(0, 16);
    while (arr.length < 16) arr.push(0);
    return arr;
  });
  const lineLookup = lineWords.map((arr) => {
    const m = new Map();
    arr.forEach((w, i) => { if (!m.has(w)) m.set(w, i); });
    return m;
  });

  // Nearest-index fallback for a word not in a line (decode the line to RGB
  // and pick the closest).
  const lineRgb = lineWords.map((arr) => {
    const bytes = new Uint8Array(arr.length * 2);
    arr.forEach((w, i) => { bytes[i * 2] = (w >> 8) & 0xFF; bytes[i * 2 + 1] = w & 0xFF; });
    return decodeCRAM(bytes);
  });
  const wordRgbCache = new Map();
  const decodeWord = (w) => {
    if (!wordRgbCache.has(w)) {
      const b = new Uint8Array([(w >> 8) & 0xFF, w & 0xFF]);
      wordRgbCache.set(w, decodeCRAM(b)[0]);
    }
    return wordRgbCache.get(w);
  };
  const indexInLine = (w, li) => {
    const hit = lineLookup[li].get(w);
    if (hit !== undefined) return hit;
    const [r, g, b] = decodeWord(w);
    let best = 0, bestD = Infinity;
    lineRgb[li].forEach((c, i) => {
      const d = (c[0] - r) ** 2 + (c[1] - g) ** 2 + (c[2] - b) ** 2;
      if (d < bestD) { bestD = d; best = i; }
    });
    return best;
  };

  // 5) Encode tiles to 4bpp packed bytes (high nibble = left pixel), dedup
  //    with h/v flip detection. A tile's bytes depend on its palette line,
  //    so dedup keys include the line index implicitly (same pixels + same
  //    line → same bytes).
  const makeTile = (tx, ty, line) => {
    const t = new Uint8Array(32);
    for (let row = 0; row < 8; row++) {
      for (let half = 0; half < 4; half++) {
        const x0 = tx * 8 + half * 2;
        const hi = indexInLine(wordOf[(ty * 8 + row) * W + x0], line);
        const lo = indexInLine(wordOf[(ty * 8 + row) * W + x0 + 1], line);
        t[row * 4 + half] = ((hi & 0xF) << 4) | (lo & 0xF);
      }
    }
    return t;
  };
  const flipH = (tile) => {
    const out = new Uint8Array(32);
    for (let row = 0; row < 8; row++) {
      for (let half = 0; half < 4; half++) {
        const b = tile[row * 4 + (3 - half)];
        // swap nibbles (left/right pixel) too
        out[row * 4 + half] = ((b & 0x0F) << 4) | ((b >> 4) & 0x0F);
      }
    }
    return out;
  };
  const flipV = (tile) => {
    const out = new Uint8Array(32);
    for (let row = 0; row < 8; row++) {
      const src = 7 - row;
      for (let half = 0; half < 4; half++) out[row * 4 + half] = tile[src * 4 + half];
    }
    return out;
  };
  const toKey = (t) => { let s = ""; for (let i = 0; i < 32; i++) s += t[i].toString(16).padStart(2, "0"); return s; };

  const tileByKey = new Map();
  const chr = [];
  const nametable = new Uint8Array(tilesAcross * tilesDown * 2);
  let uniqueBeforeMerge = 0;

  for (let ty = 0; ty < tilesDown; ty++) {
    for (let tx = 0; tx < tilesAcross; tx++) {
      const cellIdx = ty * tilesAcross + tx;
      const line = Math.max(0, tilePalLine[cellIdx]);
      const base = makeTile(tx, ty, line);
      uniqueBeforeMerge++;
      let flipBits = 0; // bit11 hflip (0x0800), bit12 vflip (0x1000)
      let chosenKey = toKey(base);
      if (!tileByKey.has(chosenKey)) {
        const h = flipH(base), v = flipV(base), hv = flipV(flipH(base));
        const hK = toKey(h), vK = toKey(v), hvK = toKey(hv);
        if (tileByKey.has(hK)) { chosenKey = hK; flipBits = 0x0800; }
        else if (tileByKey.has(vK)) { chosenKey = vK; flipBits = 0x1000; }
        else if (tileByKey.has(hvK)) { chosenKey = hvK; flipBits = 0x1800; }
        else { tileByKey.set(chosenKey, chr.length); chr.push(base); }
      }
      const tileIdx = tileByKey.get(chosenKey);
      // Big-endian 16-bit: pcc v h ttttttttttt
      const entry = (tileIdx & 0x07FF) | flipBits | ((line & 0x3) << 13);
      const off = cellIdx * 2;
      nametable[off] = (entry >> 8) & 0xFF;
      nametable[off + 1] = entry & 0xFF;
    }
  }

  // 6) Flatten chr + build the 128-byte palette (4 lines × 16 words BE).
  const chrFlat = new Uint8Array(chr.length * 32);
  for (let i = 0; i < chr.length; i++) chrFlat.set(chr[i], i * 32);
  const palette = new Uint8Array(128);
  for (let li = 0; li < 4; li++) {
    const arr = lineWords[li] || new Array(16).fill(0);
    for (let i = 0; i < 16; i++) {
      const w = arr[i] || 0;
      palette[(li * 16 + i) * 2] = (w >> 8) & 0xFF;
      palette[(li * 16 + i) * 2 + 1] = w & 0xFF;
    }
  }

  // 7) Preview re-render from the encoded data.
  const preview = new PNG({ width: W, height: H });
  for (let ty = 0; ty < tilesDown; ty++) {
    for (let tx = 0; tx < tilesAcross; tx++) {
      const off = (ty * tilesAcross + tx) * 2;
      const entry = (nametable[off] << 8) | nametable[off + 1];
      const tileIdx = entry & 0x07FF;
      const hflip = !!(entry & 0x0800);
      const vflip = !!(entry & 0x1000);
      const line = (entry >> 13) & 0x3;
      const tb = tileIdx * 32;
      for (let row = 0; row < 8; row++) {
        const srcRow = vflip ? 7 - row : row;
        for (let col = 0; col < 8; col++) {
          const srcCol = hflip ? 7 - col : col;
          const byte = chrFlat[tb + srcRow * 4 + (srcCol >> 1)];
          const ci = (srcCol & 1) ? (byte & 0x0F) : ((byte >> 4) & 0x0F);
          const [r, g, b] = lineRgb[line] ? lineRgb[line][ci] : [0, 0, 0];
          const o = ((ty * 8 + row) * W + (tx * 8 + col)) * 4;
          preview.data[o] = r; preview.data[o + 1] = g; preview.data[o + 2] = b; preview.data[o + 3] = 0xFF;
        }
      }
    }
  }

  return {
    chr: chrFlat,
    nametable,
    attr: new Uint8Array(0),
    palette,
    uniqueTilesBeforeMerge: uniqueBeforeMerge,
    uniqueTiles: chr.length,
    imageColors,
    paletteLines: lineWords.length,
    previewPng: PNG.sync.write(preview),
    warnings,
  };
}

/**
 * Generate a PNG containing all 512 Genesis-displayable colors arranged
 * in a 32×16 grid. Each cell is 16×16 px for visibility (final image:
 * 512×256). Useful as the -remap target for ImageMagick.
 *
 * The Genesis VDP word format (per CRAM):
 *   bits 0:    unused
 *   bits 1-3:  R (3 bits)
 *   bit 4:     unused
 *   bits 5-7:  G (3 bits)
 *   bit 8:     unused
 *   bits 9-11: B (3 bits)
 *
 * 3-bit → 8-bit expansion uses (n << 5) | (n << 2) | (n >> 1), the same
 * formula used in decodeGenesisCRAM (see host/gpgx-state.js).
 *
 * @returns {Buffer} PNG bytes
 */
export function genesisPalettePng() {
  const COLS = 32, ROWS = 16; // 32 × 16 = 512 colors
  const CELL = 16;
  const png = new PNG({ width: COLS * CELL, height: ROWS * CELL });
  const expand = (n3) => (n3 << 5) | (n3 << 2) | (n3 >> 1);
  for (let i = 0; i < 512; i++) {
    const r3 = i & 0x7;
    const g3 = (i >> 3) & 0x7;
    const b3 = (i >> 6) & 0x7;
    const r = expand(r3);
    const g = expand(g3);
    const b = expand(b3);
    const cx = i % COLS;
    const cy = Math.floor(i / COLS);
    for (let py = 0; py < CELL; py++) {
      for (let px = 0; px < CELL; px++) {
        const x = cx * CELL + px;
        const y = cy * CELL + py;
        const o = (y * png.width + x) * 4;
        png.data[o] = r;
        png.data[o + 1] = g;
        png.data[o + 2] = b;
        png.data[o + 3] = 0xFF;
      }
    }
  }
  return PNG.sync.write(png);
}
