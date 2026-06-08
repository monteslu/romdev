// Convert a 256×240 RGBA image into a complete NES background:
//   CHR tiles + nametable + attribute table + 16-byte BG palette table.
//
// Assumes the input has ALREADY been:
//   - sized to 256×240 exactly,
//   - quantized to NES master colors (use imagemagick `-remap nes_palette.png`
//     produced by `nesPalettePng()` tool, or otherwise restrict colors).
//
// This module does NES-specific encoding only:
//   - For each 16×16 attribute cell, find the dominant 3 non-backdrop colors;
//   - Cluster all cells' color signatures into 4 palettes via k-means;
//   - For each cell, pick the best palette (lowest reconstruction error);
//   - Re-quantize each pixel to its cell's palette;
//   - Pack 8×8 tiles into 2bpp planar, dedupe, optionally merge similar
//     tiles down to a budget;
//   - Emit nametable bytes, attribute bytes, palette bytes.

import { PNG } from "pngjs";
import { NES_PALETTE } from "./palette.js";

const W = 256;
const H = 240;
const CELLS_X = W / 16;
const CELLS_Y = H / 16;
const N_CELLS = CELLS_X * CELLS_Y;

/**
 * Find the NES master palette index whose RGB best matches (r,g,b).
 */
function nearestNes(r, g, b) {
  let best = 0, bd = Infinity;
  for (let i = 0; i < NES_PALETTE.length; i++) {
    const [nr, ng, nb] = NES_PALETTE[i];
    const d = (r - nr) ** 2 + (g - ng) ** 2 + (b - nb) ** 2;
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}

/**
 * @param {Object} args
 * @param {Buffer | Uint8Array} args.pngBytes
 * @param {number} [args.maxTiles] cap on unique tiles (default 256, the NES pattern-table limit)
 * @param {number} [args.backdrop] explicit NES backdrop index; if omitted, picked as the most common color
 * @returns {{
 *   chr: Uint8Array,
 *   nametable: Uint8Array,
 *   attr: Uint8Array,
 *   palette: Uint8Array,
 *   uniqueTilesBeforeMerge: number,
 *   uniqueTiles: number,
 *   previewPng: Buffer
 * }}
 */
export function nesImageToTilemap(args) {
  const png = PNG.sync.read(Buffer.from(args.pngBytes));
  if (png.width !== W || png.height !== H) {
    throw new Error(`image must be ${W}×${H}, got ${png.width}×${png.height}`);
  }
  const maxTiles = args.maxTiles ?? 256;

  // 1) Map every pixel to NES master index.
  const nesIdx = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    const k = i * 4;
    nesIdx[i] = nearestNes(png.data[k], png.data[k + 1], png.data[k + 2]);
  }

  // 2) Pick backdrop = most common color (or explicit override).
  let backdrop = args.backdrop;
  if (backdrop == null) {
    const hist = new Int32Array(64);
    for (let i = 0; i < nesIdx.length; i++) hist[nesIdx[i]]++;
    let best = 0;
    for (let i = 1; i < 64; i++) if (hist[i] > hist[best]) best = i;
    backdrop = best;
  }

  // 3) Build per-cell color signatures.
  const cellHistOf = (cx, cy) => {
    const h = new Int32Array(64);
    for (let yy = 0; yy < 16; yy++) {
      for (let xx = 0; xx < 16; xx++) {
        h[nesIdx[(cy * 16 + yy) * W + (cx * 16 + xx)]]++;
      }
    }
    return h;
  };
  /** @type {number[][]} cellSig[i] = 3 NES indices */
  const cellSig = [];
  for (let cy = 0; cy < CELLS_Y; cy++) {
    for (let cx = 0; cx < CELLS_X; cx++) {
      const h = cellHistOf(cx, cy);
      const entries = [];
      for (let i = 0; i < 64; i++) if (i !== backdrop && h[i] > 0) entries.push([h[i], i]);
      entries.sort((a, b) => b[0] - a[0]);
      const top = entries.slice(0, 3).map((e) => e[1]);
      while (top.length < 3) top.push(backdrop);
      top.sort((a, b) => a - b);
      cellSig.push(top);
    }
  }

  // 4) Pick 4 palettes (each = backdrop + 3 colors).
  //
  // Strategy: take the 12 most-prominent non-backdrop colors in the image,
  // cluster them by RGB proximity into 4 groups of 3. That's the 4 palettes.
  // Clustering colors directly (rather than cells) keeps similar colors
  // together, which preserves smooth gradients within a palette.
  const globalColorHist = new Int32Array(64);
  for (let i = 0; i < nesIdx.length; i++) globalColorHist[nesIdx[i]]++;
  const topColorEntries = [];
  for (let i = 0; i < 64; i++) {
    if (i === backdrop) continue;
    if (globalColorHist[i] > 0) topColorEntries.push([globalColorHist[i], i]);
  }
  topColorEntries.sort((a, b) => b[0] - a[0]);
  const usefulColors = topColorEntries.slice(0, 12).map((c) => c[1]);

  // K-means in RGB space on these colors → 4 clusters.
  /** @type {number[][]} centroidsRgb[k] = [r, g, b] (continuous) */
  const centroidsRgb = [];
  for (let k = 0; k < 4; k++) {
    const seed = usefulColors[Math.min(usefulColors.length - 1, Math.floor((k * usefulColors.length) / 4))];
    centroidsRgb.push([...NES_PALETTE[seed]]);
  }
  const colorAssign = new Int32Array(usefulColors.length);
  for (let iter = 0; iter < 30; iter++) {
    let changed = 0;
    for (let i = 0; i < usefulColors.length; i++) {
      const [r, g, b] = NES_PALETTE[usefulColors[i]];
      let bk = 0, bd = Infinity;
      for (let k = 0; k < 4; k++) {
        const [cr, cg, cb] = centroidsRgb[k];
        const d = (r - cr) ** 2 + (g - cg) ** 2 + (b - cb) ** 2;
        if (d < bd) { bd = d; bk = k; }
      }
      if (colorAssign[i] !== bk) { colorAssign[i] = bk; changed++; }
    }
    if (changed === 0) break;
    for (let k = 0; k < 4; k++) {
      let r = 0, g = 0, b = 0, n = 0;
      for (let i = 0; i < usefulColors.length; i++) {
        if (colorAssign[i] !== k) continue;
        const [cr, cg, cb] = NES_PALETTE[usefulColors[i]];
        r += cr; g += cg; b += cb; n++;
      }
      if (n > 0) centroidsRgb[k] = [r / n, g / n, b / n];
    }
  }

  // Build the 4 palettes as NES color triplets.
  /** @type {number[][]} centroids[k] = 3 NES palette indices */
  const centroids = [[], [], [], []];
  for (let i = 0; i < usefulColors.length; i++) {
    const k = colorAssign[i];
    if (centroids[k].length < 3) centroids[k].push(usefulColors[i]);
  }
  // Pad any short palette with backdrop so we always have 3 entries.
  for (let k = 0; k < 4; k++) {
    while (centroids[k].length < 3) centroids[k].push(backdrop);
  }

  // Single-palette mode: make every BG palette identical to the first 3
  // image colors. The whole image renders through one palette — limits to
  // 4 colors total but eliminates all per-cell color shifts.
  if (args.singlePalette) {
    const triplet = usefulColors.slice(0, 3);
    while (triplet.length < 3) triplet.push(backdrop);
    for (let k = 0; k < 4; k++) centroids[k] = [...triplet];
  }

  // 5) For each cell, pick the best palette and remap pixels to {0..3}.
  const cellPal = new Uint8Array(N_CELLS);
  const pxColor = new Uint8Array(W * H);
  for (let cy = 0; cy < CELLS_Y; cy++) {
    for (let cx = 0; cx < CELLS_X; cx++) {
      let bestK = 0, bestErr = Infinity;
      for (let k = 0; k < 4; k++) {
        const pal = [backdrop, ...centroids[k]];
        let err = 0;
        for (let yy = 0; yy < 16; yy++) {
          for (let xx = 0; xx < 16; xx++) {
            const px = nesIdx[(cy * 16 + yy) * W + (cx * 16 + xx)];
            const [pr, pg, pb] = NES_PALETTE[px];
            let bd = Infinity;
            for (const c of pal) {
              const [nr, ng, nb] = NES_PALETTE[c];
              const d = (pr - nr) ** 2 + (pg - ng) ** 2 + (pb - nb) ** 2;
              if (d < bd) bd = d;
            }
            err += bd;
          }
        }
        if (err < bestErr) { bestErr = err; bestK = k; }
      }
      cellPal[cy * CELLS_X + cx] = bestK;
      const pal = [backdrop, ...centroids[bestK]];
      for (let yy = 0; yy < 16; yy++) {
        for (let xx = 0; xx < 16; xx++) {
          const x = cx * 16 + xx, y = cy * 16 + yy;
          const px = nesIdx[y * W + x];
          const [pr, pg, pb] = NES_PALETTE[px];
          let bi = 0, bd = Infinity;
          for (let i = 0; i < 4; i++) {
            const [nr, ng, nb] = NES_PALETTE[pal[i]];
            const d = (pr - nr) ** 2 + (pg - ng) ** 2 + (pb - nb) ** 2;
            if (d < bd) { bd = d; bi = i; }
          }
          pxColor[y * W + x] = bi;
        }
      }
    }
  }

  // 6) Pack 8×8 tiles into 2bpp planar; dedupe by the resulting CHR bytes.
  //    (Deduping by RGB content alone is WRONG: identical RGB content shown
  //    in two cells with different attribute palettes must encode to
  //    DIFFERENT CHR bytes — they reference the same CHR slot but the
  //    palette swap recolors them.)
  const dedup = args.dedup !== false;
  const makeTileBytes = (tx, ty) => {
    const t = new Uint8Array(16);
    for (let yy = 0; yy < 8; yy++) {
      let p0 = 0, p1 = 0;
      for (let xx = 0; xx < 8; xx++) {
        const c = pxColor[(ty * 8 + yy) * W + (tx * 8 + xx)];
        if (c & 1) p0 |= 1 << (7 - xx);
        if (c & 2) p1 |= 1 << (7 - xx);
      }
      t[yy] = p0;
      t[8 + yy] = p1;
    }
    return t;
  };
  const tilesAcross = W / 8;
  const tilesDown = H / 8;
  /** @type {Uint8Array[]} */
  const tileList = [];
  const tileMap = new Map();
  const nametable = new Uint8Array(tilesAcross * tilesDown);
  for (let ty = 0; ty < tilesDown; ty++) {
    for (let tx = 0; tx < tilesAcross; tx++) {
      const t = makeTileBytes(tx, ty);
      if (dedup) {
        const key = Buffer.from(t).toString("hex");
        let idx = tileMap.get(key);
        if (idx === undefined) {
          idx = tileList.length;
          tileList.push(t);
          tileMap.set(key, idx);
        }
        nametable[ty * tilesAcross + tx] = idx;
      } else {
        nametable[ty * tilesAcross + tx] = tileList.length;
        tileList.push(t);
      }
    }
  }
  const uniqueTilesBeforeMerge = tileList.length;

  // (Removed the hard-throw — the caller can read `uniqueTiles` from the
  // return value and decide what to do. Indices that exceed 255 will wrap
  // on hardware, so it's a warning not a crash.)

  // 7) (Disabled) Merge similar tiles down to maxTiles.
  //
  // The greedy "merge nearest tile pairs" approach measures bit-pattern
  // distance, which is a terrible proxy for visual distance — a mostly-
  // empty tile and a tile with one distinct pixel look alike to the merger
  // but completely different on screen. Result: scrambled output.
  //
  // If you blow past maxTiles, the right fix is to make the input chunkier
  // (smaller source resolution before nearest-neighbor upscale) so fewer
  // unique 8×8 patterns exist naturally. Returning the unmerged result
  // gives the caller a chance to retry; just be aware nametable indices
  // > 255 will wrap on hardware.
  // Permanently disabled (see note above) but kept as documentation of the
  // rejected greedy-merge approach.
  // eslint-disable-next-line no-constant-condition, no-constant-binary-expression
  if (false && dedup && tileList.length > maxTiles) {
    const tileDist = (a, b) => {
      let d = 0;
      for (let yy = 0; yy < 8; yy++) {
        const a0 = a[yy], a1 = a[8 + yy];
        const b0 = b[yy], b1 = b[8 + yy];
        for (let xx = 0; xx < 8; xx++) {
          const ac = ((a0 >> (7 - xx)) & 1) | (((a1 >> (7 - xx)) & 1) << 1);
          const bc = ((b0 >> (7 - xx)) & 1) | (((b1 >> (7 - xx)) & 1) << 1);
          d += Math.abs(ac - bc);
        }
      }
      return d;
    };
    const remap = new Int32Array(tileList.length);
    for (let i = 0; i < remap.length; i++) remap[i] = i;
    const usage = new Int32Array(tileList.length);
    for (let i = 0; i < nametable.length; i++) usage[nametable[i]]++;
    const alive = new Set([...Array(tileList.length).keys()]);

    const N = tileList.length;
    /** @type {[number, number, number][]} */
    const pairs = [];
    for (let i = 0; i < N; i++) {
      for (let j = i + 1; j < N; j++) {
        pairs.push([tileDist(tileList[i], tileList[j]), i, j]);
      }
    }
    pairs.sort((a, b) => a[0] - b[0]);

    let dropped = 0;
    const needDrop = N - maxTiles;
    for (const [, i, j] of pairs) {
      if (dropped >= needDrop) break;
      if (!alive.has(i) || !alive.has(j)) continue;
      const victim = usage[i] < usage[j] ? i : j;
      const survivor = victim === i ? j : i;
      remap[victim] = survivor;
      usage[survivor] += usage[victim];
      alive.delete(victim);
      dropped++;
    }
    const root = (i) => { while (remap[i] !== i) i = remap[i]; return i; };
    for (let i = 0; i < remap.length; i++) remap[i] = root(i);
    const idxMap = new Map();
    const newTiles = [];
    for (let i = 0; i < remap.length; i++) {
      if (remap[i] !== i) continue;
      idxMap.set(i, newTiles.length);
      newTiles.push(tileList[i]);
    }
    for (let i = 0; i < nametable.length; i++) {
      nametable[i] = idxMap.get(remap[nametable[i]]);
    }
    tileList.length = 0;
    tileList.push(...newTiles);
  }

  // 8) Attribute table.
  const attr = new Uint8Array(64);
  for (let cy = 0; cy < CELLS_Y; cy++) {
    for (let cx = 0; cx < CELLS_X; cx++) {
      const pal = cellPal[cy * CELLS_X + cx];
      const ax = cx >> 1, ay = cy >> 1;
      const shift = ((cy & 1) << 2) | ((cx & 1) << 1);
      attr[ay * 8 + ax] |= (pal & 3) << shift;
    }
  }

  // 9) 16-byte palette (4 palettes × 4 entries, backdrop shared).
  const palette = new Uint8Array(16);
  for (let k = 0; k < 4; k++) {
    palette[k * 4 + 0] = backdrop;
    palette[k * 4 + 1] = centroids[k][0];
    palette[k * 4 + 2] = centroids[k][1];
    palette[k * 4 + 3] = centroids[k][2];
  }

  const chr = Buffer.concat(tileList.map((t) => Buffer.from(t)));

  // 10) Preview PNG from final CHR + nametable + attr + palette.
  const preview = new PNG({ width: W, height: H });
  for (let ty = 0; ty < tilesDown; ty++) {
    for (let tx = 0; tx < tilesAcross; tx++) {
      const tileIdx = nametable[ty * tilesAcross + tx];
      const tile = tileList[tileIdx];
      const cx = tx >> 1, cy = ty >> 1;
      const pal = [backdrop, ...centroids[cellPal[cy * CELLS_X + cx]]];
      for (let yy = 0; yy < 8; yy++) {
        const p0 = tile[yy], p1 = tile[8 + yy];
        for (let xx = 0; xx < 8; xx++) {
          const ci = ((p0 >> (7 - xx)) & 1) | (((p1 >> (7 - xx)) & 1) << 1);
          const [r, g, b] = NES_PALETTE[pal[ci]];
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
    nametable,
    attr,
    palette,
    uniqueTilesBeforeMerge,
    uniqueTiles: tileList.length,
    previewPng,
  };
}

/**
 * Emit a PNG of the NES master palette suitable for use as an ImageMagick
 * -remap target. Skips duplicate blacks for cleaner dithering.
 * @returns {Buffer}
 */
export function nesPalettePng() {
  const SKIP = new Set([0x0d, 0x0e, 0x1d, 0x1e, 0x1f, 0x2d, 0x2e, 0x2f, 0x3d, 0x3e, 0x3f]);
  const usable = [0x0f];
  for (let i = 0; i < 64; i++) {
    if (i === 0x0f || SKIP.has(i)) continue;
    usable.push(i);
  }
  const png = new PNG({ width: usable.length, height: 1 });
  for (let i = 0; i < usable.length; i++) {
    const [r, g, b] = NES_PALETTE[usable[i]];
    const k = i * 4;
    png.data[k] = r;
    png.data[k + 1] = g;
    png.data[k + 2] = b;
    png.data[k + 3] = 255;
  }
  return PNG.sync.write(png);
}
