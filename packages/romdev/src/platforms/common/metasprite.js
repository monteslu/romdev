// Public meta-sprite entry points: capture from a live host, and re-render
// from saved files. All platform specifics live in metasprite-adapters.js
// (live decode) + the tile decoders below (saved-file decode).

import { buildAdapter } from "./metasprite-adapters.js";
import { captureFromAdapter, renderSavedMetaSprite, clusterSprites } from "./metasprite-core.js";

/** Capture a meta-sprite from the current frame on `host` for `platform`. */
export async function captureMetaSprite(host, platform, opts = {}) {
  const adapter = await buildAdapter(host, platform);
  return captureFromAdapter(adapter, opts);
}

/** Cluster the on-screen sprites into likely objects. */
export async function groupVisibleSprites(host, platform, opts = {}) {
  const adapter = await buildAdapter(host, platform);
  return clusterSprites(adapter.sprites, opts);
}

// ---- saved-file re-render ----
// Decode tiles.bin back into 8x8 index grids using the layout's platform +
// bpp (inverse of the encoders in metasprite-adapters.js), then re-render
// via the same core path used at capture time.

function decodeTilesBin(tiles, platform, bpp) {
  const grids = [];
  const tileBytes = bpp === 4 ? 32 : 16;
  const count = Math.floor(tiles.length / tileBytes);
  for (let t = 0; t < count; t++) {
    const base = t * tileBytes;
    const g = Array.from({ length: 8 }, () => new Array(8).fill(0));
    if (platform === "nes") {
      // 2bpp planar: plane0 bytes 0-7, plane1 bytes 8-15
      for (let y = 0; y < 8; y++) { const p0 = tiles[base + y], p1 = tiles[base + 8 + y]; for (let x = 0; x < 8; x++) { const b = 7 - x; g[y][x] = ((p0 >> b) & 1) | (((p1 >> b) & 1) << 1); } }
    } else if (platform === "gb" || platform === "gbc") {
      // 2bpp interleaved: per row [lo,hi]
      for (let y = 0; y < 8; y++) { const lo = tiles[base + y * 2], hi = tiles[base + y * 2 + 1]; for (let x = 0; x < 8; x++) { const b = 7 - x; g[y][x] = ((lo >> b) & 1) | (((hi >> b) & 1) << 1); } }
    } else if (platform === "genesis") {
      // 4bpp packed: high nibble = left pixel
      for (let y = 0; y < 8; y++) for (let half = 0; half < 4; half++) { const byte = tiles[base + y * 4 + half]; g[y][half * 2] = (byte >> 4) & 0xF; g[y][half * 2 + 1] = byte & 0xF; }
    } else if (platform === "sms" || platform === "gg") {
      // 4bpp interleaved: per row [p0,p1,p2,p3]
      for (let y = 0; y < 8; y++) { const p0 = tiles[base + y * 4], p1 = tiles[base + y * 4 + 1], p2 = tiles[base + y * 4 + 2], p3 = tiles[base + y * 4 + 3]; for (let x = 0; x < 8; x++) { const b = 7 - x; g[y][x] = ((p0 >> b) & 1) | (((p1 >> b) & 1) << 1) | (((p2 >> b) & 1) << 2) | (((p3 >> b) & 1) << 3); } }
    } else { // snes: 4bpp planar-pairs
      for (let y = 0; y < 8; y++) { const p0 = tiles[base + y * 2], p1 = tiles[base + y * 2 + 1], p2 = tiles[base + 16 + y * 2], p3 = tiles[base + 16 + y * 2 + 1]; for (let x = 0; x < 8; x++) { const b = 7 - x; g[y][x] = ((p0 >> b) & 1) | (((p1 >> b) & 1) << 1) | (((p2 >> b) & 1) << 2) | (((p3 >> b) & 1) << 3); } }
    }
    grids.push(g);
  }
  return grids;
}

/**
 * Re-render a saved meta-sprite (tiles.bin + layout.json) to a PNG. The
 * palette comes from the layout's `palettes` (hex strings), so palette.bin
 * isn't strictly needed for the preview.
 * @param {Uint8Array} tiles
 * @param {object} layout
 */
export function renderSaved(tiles, layout) {
  const bpp = layout.bpp ?? (["genesis", "snes", "sms", "gg"].includes(layout.platform) ? 4 : 2);
  const exportTiles = decodeTilesBin(tiles, layout.platform, bpp);
  // Palette: parse hex strings from layout.palettes into rgb arrays keyed by
  // the same palette index the pieces reference.
  const palMap = {};
  for (const [k, hexes] of Object.entries(layout.palettes || {})) {
    palMap[k] = hexes.map((h) => {
      const m = /^#?([0-9a-fA-F]{6})$/.exec(h); if (!m) return [0, 0, 0];
      const n = parseInt(m[1], 16); return [(n >> 16) & 0xFF, (n >> 8) & 0xFF, n & 0xFF];
    });
  }
  // A minimal adapter the core's renderer can use: cell order from layout +
  // a palette lookup. Reuse the same cell-order rules.
  const colMajor = !!layout.tileColumnMajor;
  const order = colMajor
    ? (w, h) => { const o = []; for (let c = 0; c < w; c++) for (let r = 0; r < h; r++) o.push(c * h + r); return o; }
    : (w, h) => { const o = []; for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) o.push(r * w + c); return o; };
  const pos = colMajor
    ? (w, h) => { const p = []; for (let c = 0; c < w; c++) for (let r = 0; r < h; r++) p.push({ col: c, row: r }); return p; }
    : (w, h) => { const p = []; for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) p.push({ col: c, row: r }); return p; };
  const adapter = {
    platform: layout.platform,
    cellTileOrder: order,
    cellGridPositions: pos,
    getPaletteRgb: (p) => palMap[String(p)] || palMap[Object.keys(palMap)[0]] || [[0, 0, 0]],
  };
  return renderSavedMetaSprite({ adapter, layout, exportTiles });
}

export { emitMetaSpriteCode } from "./metasprite-codegen.js";
