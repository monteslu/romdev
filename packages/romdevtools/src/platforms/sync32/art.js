// sync32 art encoders — the simplest target format in the tree, and the one
// every agent porting to the console hand-rolled (a ~500-line quantizer with
// its own median cut, 2026-09-05) because encodeArt refused the platform.
//
// The console draws from 8-bit INDEXED pixels through ONE 256-entry RGB565
// palette. No bitplanes, no column-major sprite order, no attribute cells, no
// per-row colour limits. Two rules shape everything here:
//
//   * index 0 is the global transparent key for sprite() — never a colour.
//   * a per-level palette swap wants BANKED quantization: shared art (player,
//     objects) keeps fixed slots, terrain/background banks are overlaid per
//     level. So the caller chooses `baseIndex` + `maxColors` and the encoder
//     writes indices baseIndex..baseIndex+n-1, leaving the rest of the table
//     alone.
//
// Output is what sheet_load()/canvas() want: row-major bytes, plus the bank's
// RGB565 entries (little-endian, the console's byte order) and a C emitter.

import { PNG } from "pngjs";

/** RGB888 → RGB565 (the console's palette word). */
export function rgb565(r, g, b) {
  return ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3);
}

/** RGB565 → RGB888 (what the console actually shows for that entry). */
export function rgb565ToRgb(v) {
  const r = (v >> 11) & 31, g = (v >> 5) & 63, b = v & 31;
  return [(r << 3) | (r >> 2), (g << 2) | (g >> 4), (b << 3) | (b >> 2)];
}

/**
 * Median-cut quantization to at most `maxColors` RGB565 colours.
 * Colours are snapped to RGB565 BEFORE counting so two source colours the
 * console cannot tell apart never cost two slots.
 * @param {Uint8Array|Buffer} rgba
 * @param {number} count pixel count
 * @param {number} maxColors
 * @param {number} [alphaKey=128] alpha below this = transparent (index 0)
 * @returns {{palette: number[], indexOf: Map<number, number>}}  palette = RGB565 values; indexOf maps RGB565 → slot 0..n-1
 */
export function quantize565(rgba, count, maxColors, alphaKey = 128) {
  const hist = new Map();
  for (let i = 0; i < count; i++) {
    if (rgba[i * 4 + 3] < alphaKey) continue;
    const v = rgb565(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]);
    hist.set(v, (hist.get(v) ?? 0) + 1);
  }
  const colours = [...hist.entries()].map(([v, n]) => ({ v, n, rgb: rgb565ToRgb(v) }));
  let palette;
  if (colours.length <= maxColors) {
    palette = colours.sort((a, b) => b.n - a.n).map((c) => c.v);
  } else {
    // Median cut over the RGB888 view of the 565 histogram, weighted by count.
    let boxes = [colours];
    while (boxes.length < maxColors) {
      boxes.sort((a, b) => spread(b) - spread(a));
      const box = boxes.shift();
      if (!box || box.length < 2) { if (box) boxes.push(box); break; }
      const axis = widestAxis(box);
      box.sort((a, b) => a.rgb[axis] - b.rgb[axis]);
      const total = box.reduce((s, c) => s + c.n, 0);
      let acc = 0, cut = 0;
      for (; cut < box.length - 1; cut++) { acc += box[cut].n; if (acc * 2 >= total) break; }
      boxes.push(box.slice(0, cut + 1), box.slice(cut + 1));
    }
    palette = boxes.map((box) => {
      let r = 0, g = 0, b = 0, n = 0;
      for (const c of box) { r += c.rgb[0] * c.n; g += c.rgb[1] * c.n; b += c.rgb[2] * c.n; n += c.n; }
      return rgb565(Math.round(r / n), Math.round(g / n), Math.round(b / n));
    });
    // Two boxes can average to the same 565 word; keep the table minimal.
    palette = [...new Set(palette)];
  }
  const indexOf = new Map();
  const palRgb = palette.map(rgb565ToRgb);
  for (const c of colours) {
    let best = 0, bestD = Infinity;
    for (let i = 0; i < palRgb.length; i++) {
      const d = (palRgb[i][0] - c.rgb[0]) ** 2 + (palRgb[i][1] - c.rgb[1]) ** 2 + (palRgb[i][2] - c.rgb[2]) ** 2;
      if (d < bestD) { bestD = d; best = i; }
    }
    indexOf.set(c.v, best);
  }
  return { palette, indexOf };
}

function spread(box) {
  if (box.length < 2) return 0;
  let s = 0;
  for (let a = 0; a < 3; a++) {
    let lo = 255, hi = 0;
    for (const c of box) { if (c.rgb[a] < lo) lo = c.rgb[a]; if (c.rgb[a] > hi) hi = c.rgb[a]; }
    s += hi - lo;
  }
  return s;
}
function widestAxis(box) {
  let best = 0, bestW = -1;
  for (let a = 0; a < 3; a++) {
    let lo = 255, hi = 0;
    for (const c of box) { if (c.rgb[a] < lo) lo = c.rgb[a]; if (c.rgb[a] > hi) hi = c.rgb[a]; }
    if (hi - lo > bestW) { bestW = hi - lo; best = a; }
  }
  return best;
}

/**
 * PNG → 8-bit indexed pixels + an RGB565 palette BANK.
 * @param {Uint8Array|Buffer} pngBytes
 * @param {{maxColors?: number, baseIndex?: number, alphaKey?: number, palette?: number[]}} [opts]
 *   maxColors: colours in the bank (default 255 - baseIndex + 1 capped at 255)
 *   baseIndex: first palette slot the bank occupies (default 1 — index 0 is transparent)
 *   palette:   an existing bank (RGB565 values) to index against instead of quantizing
 * @returns {{width:number, height:number, pixels:Uint8Array, palette:number[], baseIndex:number, colors:number, transparentPixels:number, paletteBytes:Uint8Array}}
 */
export function encodeIndexed(pngBytes, opts = {}) {
  const png = PNG.sync.read(Buffer.from(pngBytes));
  const { width, height, data } = png;
  const baseIndex = opts.baseIndex ?? 1;
  if (baseIndex < 1 || baseIndex > 255) throw new Error(`sync32 art: baseIndex must be 1..255 (index 0 is the transparent key), got ${baseIndex}`);
  const room = 256 - baseIndex;
  const maxColors = Math.min(opts.maxColors ?? room, room);
  if (maxColors < 1) throw new Error(`sync32 art: no room for colours at baseIndex ${baseIndex}`);
  const alphaKey = opts.alphaKey ?? 128;
  const count = width * height;

  let palette, indexOf;
  if (Array.isArray(opts.palette) && opts.palette.length) {
    palette = opts.palette.slice(0, room);
    indexOf = null;
  } else {
    ({ palette, indexOf } = quantize565(data, count, maxColors, alphaKey));
  }
  const palRgb = palette.map(rgb565ToRgb);
  const pixels = new Uint8Array(count);
  let transparent = 0;
  const cache = new Map();
  for (let i = 0; i < count; i++) {
    if (data[i * 4 + 3] < alphaKey) { pixels[i] = 0; transparent++; continue; }
    const v = rgb565(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]);
    let slot = indexOf ? indexOf.get(v) : cache.get(v);
    if (slot === undefined) {
      const rgb = rgb565ToRgb(v);
      let best = 0, bestD = Infinity;
      for (let k = 0; k < palRgb.length; k++) {
        const d = (palRgb[k][0] - rgb[0]) ** 2 + (palRgb[k][1] - rgb[1]) ** 2 + (palRgb[k][2] - rgb[2]) ** 2;
        if (d < bestD) { bestD = d; best = k; }
      }
      slot = best; cache.set(v, slot);
    }
    pixels[i] = baseIndex + slot;
  }
  const paletteBytes = new Uint8Array(palette.length * 2);
  palette.forEach((v, i) => { paletteBytes[i * 2] = v & 0xff; paletteBytes[i * 2 + 1] = v >> 8; });
  return { width, height, pixels, palette, baseIndex, colors: palette.length, transparentPixels: transparent, paletteBytes };
}

/**
 * Dedupe an indexed image into 8x8 chr cells + a map. The framebuffer console
 * has no tilemap hardware, but a 320x240 background stored flat is 76 800
 * bytes against a 311 296-byte image budget; deduped to chr+map it is ~11 KB
 * — the reason every port re-implements this.
 * @param {Uint8Array} pixels
 * @param {number} width
 * @param {number} height
 * @param {{dedup?: boolean, flip?: boolean}} [opts]  flip: also match X/Y-flipped cells (map entries then carry flip bits in a uint16)
 * @returns {{chr: Uint8Array, map: Uint8Array|Uint16Array, mapWidth:number, mapHeight:number, uniqueTiles:number, totalTiles:number, mapBytes:Uint8Array, entryBits:8|16}}
 */
export function dedupeTiles(pixels, width, height, opts = {}) {
  if (width % 8 || height % 8) throw new Error(`sync32 tilemap: image ${width}x${height} must be a multiple of 8 in both dimensions`);
  const mw = width / 8, mh = height / 8;
  const total = mw * mh;
  const dedup = opts.dedup !== false;
  const flip = !!opts.flip;
  const cells = [];
  const seen = new Map();
  const entries = new Array(total);
  const key = (cell) => Buffer.from(cell).toString("latin1");
  const flipX = (c) => { const o = new Uint8Array(64); for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) o[y * 8 + x] = c[y * 8 + 7 - x]; return o; };
  const flipY = (c) => { const o = new Uint8Array(64); for (let y = 0; y < 8; y++) o.set(c.subarray((7 - y) * 8, (7 - y) * 8 + 8), y * 8); return o; };
  for (let ty = 0; ty < mh; ty++) {
    for (let tx = 0; tx < mw; tx++) {
      const cell = new Uint8Array(64);
      for (let y = 0; y < 8; y++) cell.set(pixels.subarray((ty * 8 + y) * width + tx * 8, (ty * 8 + y) * width + tx * 8 + 8), y * 8);
      let idx, fl = 0;
      if (dedup) {
        const k = key(cell);
        if (seen.has(k)) idx = seen.get(k);
        else if (flip) {
          const fx = key(flipX(cell)), fy = key(flipY(cell)), fxy = key(flipY(flipX(cell)));
          if (seen.has(fx)) { idx = seen.get(fx); fl = 1; }
          else if (seen.has(fy)) { idx = seen.get(fy); fl = 2; }
          else if (seen.has(fxy)) { idx = seen.get(fxy); fl = 3; }
        }
        if (idx === undefined) { idx = cells.length; cells.push(cell); seen.set(k, idx); }
      } else { idx = cells.length; cells.push(cell); }
      entries[ty * mw + tx] = { idx, fl };
    }
  }
  const unique = cells.length;
  const wide = unique > 256 || flip;
  const map = wide ? new Uint16Array(total) : new Uint8Array(total);
  for (let i = 0; i < total; i++) map[i] = wide ? (entries[i].idx | (entries[i].fl << 14)) : entries[i].idx;
  const chr = new Uint8Array(unique * 64);
  cells.forEach((c, i) => chr.set(c, i * 64));
  const mapBytes = new Uint8Array(map.buffer, map.byteOffset, map.byteLength);
  return { chr, map, mapWidth: mw, mapHeight: mh, uniqueTiles: unique, totalTiles: total, mapBytes, entryBits: wide ? 16 : 8 };
}

/**
 * A preview PNG of an indexed image through a bank (what the console shows).
 * @param {Uint8Array} pixels
 * @param {number} width
 * @param {number} height
 * @param {number[]} palette  the bank's RGB565 values
 * @param {number} baseIndex
 */
export function previewPng(pixels, width, height, palette, baseIndex) {
  const png = new PNG({ width, height });
  const rgb = palette.map(rgb565ToRgb);
  for (let i = 0; i < width * height; i++) {
    const p = pixels[i];
    const o = i * 4;
    if (p === 0) { png.data[o] = 255; png.data[o + 1] = 0; png.data[o + 2] = 255; png.data[o + 3] = 255; continue; } // magenta = transparent key
    const c = rgb[p - baseIndex] ?? [0, 0, 0];
    png.data[o] = c[0]; png.data[o + 1] = c[1]; png.data[o + 2] = c[2]; png.data[o + 3] = 255;
  }
  return PNG.sync.write(png);
}

const cLine = (arr, per, fmt) => {
  const rows = [];
  for (let i = 0; i < arr.length; i += per) rows.push("  " + Array.from(arr.slice(i, i + per), fmt).join(", ") + ",");
  return rows.join("\n");
};

/**
 * C source for an encoded sheet: the pixels, the palette bank and the
 * defines a game needs to place it (`NAME_W/H`, `NAME_PAL_BASE/COUNT`).
 */
export function emitSheetC(name, r) {
  const N = name.toUpperCase();
  return [
    `/* sync32 sheet '${name}': ${r.width}x${r.height}, 8-bit indices, row-major. Generated by romdev encodeArt. */`,
    `/* Palette bank: ${r.colors} RGB565 entries at index ${r.baseIndex}..${r.baseIndex + r.colors - 1}; index 0 = transparent. */`,
    `#include <stdint.h>`,
    `#define ${N}_W ${r.width}`,
    `#define ${N}_H ${r.height}`,
    `#define ${N}_PAL_BASE ${r.baseIndex}`,
    `#define ${N}_PAL_COUNT ${r.colors}`,
    `const uint16_t ${name}_pal[${r.colors}] = {`,
    cLine(r.palette, 8, (v) => "0x" + v.toString(16).padStart(4, "0")),
    `};`,
    `const uint8_t ${name}[${r.width * r.height}] = {`,
    cLine(r.pixels, 24, (v) => String(v)),
    `};`,
    `/* use: for (i) pal[${N}_PAL_BASE + i] = ${name}_pal[i]; api->palette_set(pal); int sh = api->sheet_load(${name}, ${N}_W, ${N}_H); */`,
    "",
  ].join("\n");
}

/** C source for a deduped chr + map background. */
export function emitTilemapC(name, r, t) {
  const N = name.toUpperCase();
  const mapType = t.entryBits === 16 ? "uint16_t" : "uint8_t";
  return [
    `/* sync32 background '${name}': ${r.width}x${r.height} as ${t.uniqueTiles} unique 8x8 cells + a ${t.mapWidth}x${t.mapHeight} map. Generated by romdev encodeArt. */`,
    `/* Palette bank: ${r.colors} RGB565 entries at index ${r.baseIndex}..${r.baseIndex + r.colors - 1}. */`,
    `#include <stdint.h>`,
    `#define ${N}_W ${r.width}`,
    `#define ${N}_H ${r.height}`,
    `#define ${N}_MAP_W ${t.mapWidth}`,
    `#define ${N}_MAP_H ${t.mapHeight}`,
    `#define ${N}_TILES ${t.uniqueTiles}`,
    `#define ${N}_PAL_BASE ${r.baseIndex}`,
    `#define ${N}_PAL_COUNT ${r.colors}`,
    t.entryBits === 16 ? `#define ${N}_MAP_FLIP_X 0x4000\n#define ${N}_MAP_FLIP_Y 0x8000\n#define ${N}_MAP_INDEX(e) ((e) & 0x3fff)` : `/* map entries are plain tile indices */`,
    `const uint16_t ${name}_pal[${r.colors}] = {`,
    cLine(r.palette, 8, (v) => "0x" + v.toString(16).padStart(4, "0")),
    `};`,
    `const uint8_t ${name}_chr[${t.uniqueTiles * 64}] = {`,
    cLine(t.chr, 32, (v) => String(v)),
    `};`,
    `const ${mapType} ${name}_map[${t.mapWidth * t.mapHeight}] = {`,
    cLine(t.map, t.mapWidth, (v) => String(v)),
    `};`,
    `/* draw: for each map cell (mx,my): const uint8_t *cell = ${name}_chr + ${N}_MAP_INDEX(${name}_map[my*${N}_MAP_W+mx]) * 64; copy its 8 rows into canvas() at (mx*8, my*8); then api->canvas_mark(y0, y1). */`,
    "",
  ].join("\n");
}
