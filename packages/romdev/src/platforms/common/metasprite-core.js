// Platform-agnostic meta-sprite capture.
//
// A meta-sprite is the live composition of a character's hardware sprites
// (OAM/SAT entries) lifted into a reusable asset: exported tiles + a layout
// describing each piece's position/size/palette/flips, plus a preview
// re-rendered FROM the exported data (never a screenshot crop).
//
// Each platform supplies an ADAPTER with a uniform interface, so the
// select / copy-tiles / normalize / render logic below is written once:
//
//   adapter = {
//     platform,                       // "genesis" | "snes" | ...
//     bpp,                            // 2 | 4 (for tiles)
//     screenW, screenH,              // visible bounds (for default select)
//     sprites,                        // [{slot,x,y,wTiles,hTiles,tile,palette,flipH,flipV,priority}]
//     cellTileOrder(wTiles,hTiles),   // → [tileIndexOffset, ...] in HARDWARE order
//     getTilePixels(tileIndex),       // → 8x8 array of palette indices (0=transparent)
//     getPaletteRgb(palette),         // → [[r,g,b], ...] for that sprite's palette line
//     exportPalette(),                // → { bytes:Uint8Array, json:{line:[hex...]}, lines:[..] }
//     tileColumnMajor,                // bool — true if cell order increments down columns (Genesis)
//   }

import { PNG } from "pngjs";

/**
 * Capture a meta-sprite using a platform adapter.
 * @param {object} adapter see header
 * @param {object} opts { rect?, slots?, includePartials?, name? }
 */
export function captureFromAdapter(adapter, opts = {}) {
  const name = opts.name || "metasprite";
  const includePartials = opts.includePartials !== false;
  const all = adapter.sprites;

  let selected;
  if (Array.isArray(opts.slots) && opts.slots.length) {
    const want = new Set(opts.slots);
    selected = all.filter((s) => want.has(s.slot));
  } else if (opts.rect) {
    const { x, y, w, h } = opts.rect;
    const rx2 = x + w, ry2 = y + h;
    selected = all.filter((s) => {
      const sx2 = s.x + s.wTiles * 8, sy2 = s.y + s.hTiles * 8;
      const hit = s.x < rx2 && sx2 > x && s.y < ry2 && sy2 > y;
      if (!hit) return false;
      if (includePartials) return true;
      return s.x >= x && s.y >= y && sx2 <= rx2 && sy2 <= ry2;
    });
  } else {
    selected = all.filter((s) => s.visible);
  }
  if (selected.length === 0) {
    throw new Error(
      `captureMetaSprite[${adapter.platform}]: no sprite entries matched. ` +
      `Pass slots:[...] (from inspectSprites/groupVisibleSprites) or a rect that overlaps a sprite, ` +
      `and step to a frame where the character is on screen.`
    );
  }

  const originX = Math.min(...selected.map((s) => s.x));
  const originY = Math.min(...selected.map((s) => s.y));
  let boundW = 0, boundH = 0;

  // Copy + dedup tiles by their decoded 8x8 pixel grid (platform-agnostic key).
  const tileByKey = new Map();
  /** @type {number[][][]} */ const exportTiles = []; // each is an 8x8 index grid
  const palettesUsed = new Set();
  const pieces = [];

  const copyTile = (tileIndex) => {
    const grid = adapter.getTilePixels(tileIndex);
    let key = "";
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) key += grid[r][c].toString(16);
    let exp = tileByKey.get(key);
    if (exp === undefined) { exp = exportTiles.length; tileByKey.set(key, exp); exportTiles.push(grid); }
    return exp;
  };

  for (const s of selected) {
    palettesUsed.add(s.palette);
    const order = adapter.cellTileOrder(s.wTiles, s.hTiles); // tile-index offsets, hardware order
    let firstExp = -1;
    for (const off of order) {
      const exp = copyTile(s.tile + off);
      if (firstExp === -1) firstExp = exp;
    }
    const px = s.x - originX, py = s.y - originY;
    boundW = Math.max(boundW, px + s.wTiles * 8);
    boundH = Math.max(boundH, py + s.hTiles * 8);
    pieces.push({
      slot: s.slot, x: px, y: py,
      wTiles: s.wTiles, hTiles: s.hTiles,
      wPx: s.wTiles * 8, hPx: s.hTiles * 8,
      sourceTile: s.tile, tileOffset: firstExp,
      palette: s.palette,
      priority: !!s.priority, flipH: !!s.flipH, flipV: !!s.flipV,
    });
  }

  const pal = adapter.exportPalette();
  const layout = {
    platform: adapter.platform,
    name,
    bpp: adapter.bpp,
    tileColumnMajor: !!adapter.tileColumnMajor,
    origin: { x: originX, y: originY },
    bounds: { w: boundW, h: boundH },
    tileCount: exportTiles.length,
    palettes: pal.json,
    pieces,
  };

  // Flatten exported tile pixel-grids into native bytes via the adapter.
  const tiles = adapter.encodeTiles(exportTiles);

  const previewPng = renderFromExported({ exportTiles, adapter, layout });

  return {
    layout, tiles, palette: pal.bytes, paletteJson: pal.json, previewPng,
    note: `${pieces.length} piece(s), ${exportTiles.length} unique tiles, ${boundW}×${boundH}px, ${adapter.bpp}bpp. ` +
      `Tile order ${adapter.tileColumnMajor ? "column-major (hardware)" : "row-major"} preserved. ` +
      `Palette line(s) used: ${[...palettesUsed].sort((a,b)=>a-b).join(",")}.`,
  };
}

/** Render a meta-sprite to PNG from decoded export tiles + layout. */
function renderFromExported({ exportTiles, adapter, layout }) {
  const W = Math.max(8, layout.bounds.w), H = Math.max(8, layout.bounds.h);
  const png = new PNG({ width: W, height: H });
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const o = (y * W + x) * 4, c = ((x >> 3) + (y >> 3)) & 1 ? 0x60 : 0x40;
    png.data[o] = c; png.data[o + 1] = c; png.data[o + 2] = c; png.data[o + 3] = 0xFF;
  }
  const palCache = {};
  const palOf = (p) => (palCache[p] ??= adapter.getPaletteRgb(p));
  for (const piece of layout.pieces) {
    const rgbPal = palOf(piece.palette);
    const order = adapter.cellTileOrder(piece.wTiles, piece.hTiles);
    // Map each hardware cell index to its (col,row) grid position.
    const cellPos = adapter.cellGridPositions(piece.wTiles, piece.hTiles);
    for (let i = 0; i < order.length; i++) {
      const expTile = piece.tileOffset + i;
      if (expTile >= exportTiles.length) continue;
      const grid = exportTiles[expTile];
      let { col, row } = cellPos[i];
      if (piece.flipH) col = piece.wTiles - 1 - col;
      if (piece.flipV) row = piece.hTiles - 1 - row;
      for (let ty = 0; ty < 8; ty++) for (let tx = 0; tx < 8; tx++) {
        const sx = piece.flipH ? 7 - tx : tx, sy = piece.flipV ? 7 - ty : ty;
        const ci = grid[sy][sx];
        if (ci === 0) continue;
        const [r, g, b] = rgbPal[ci] || [0, 0, 0];
        const px = piece.x + col * 8 + tx, py = piece.y + row * 8 + ty;
        if (px < 0 || py < 0 || px >= W || py >= H) continue;
        const o = (py * W + px) * 4;
        png.data[o] = r; png.data[o + 1] = g; png.data[o + 2] = b; png.data[o + 3] = 0xFF;
      }
    }
  }
  return PNG.sync.write(png);
}

/**
 * Re-render from already-saved files (tiles.bin + palette + layout). The
 * adapter here is a "decode-only" one built from the layout's bpp + saved
 * bytes (no live host needed).
 */
export function renderSavedMetaSprite({ adapter, layout, exportTiles }) {
  return renderFromExported({ exportTiles, adapter, layout });
}

/**
 * Generic spatial clustering of on-screen sprites into objects.
 * @param {Array} sprites uniform sprite list (with x,y,wTiles,hTiles,slot)
 * @param {object} opts { rect?, gap?=8 }
 */
export function clusterSprites(sprites, opts = {}) {
  const gap = opts.gap ?? 8;
  let list = sprites.filter((s) => s.visible);
  if (opts.rect) {
    const { x, y, w, h } = opts.rect, rx2 = x + w, ry2 = y + h;
    list = list.filter((s) => s.x < rx2 && s.x + s.wTiles * 8 > x && s.y < ry2 && s.y + s.hTiles * 8 > y);
  }
  const parent = list.map((_, i) => i);
  const find = (a) => { while (parent[a] !== a) a = parent[a] = parent[parent[a]]; return a; };
  const near = (a, b) => {
    const aw = a.wTiles * 8, ah = a.hTiles * 8, bw = b.wTiles * 8, bh = b.hTiles * 8;
    return a.x - gap < b.x + bw && a.x + aw + gap > b.x && a.y - gap < b.y + bh && a.y + ah + gap > b.y;
  };
  for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++)
    if (near(list[i], list[j])) parent[find(i)] = find(j);
  const byRoot = new Map();
  list.forEach((s, i) => { const r = find(i); (byRoot.get(r) || byRoot.set(r, []).get(r)).push(s); });
  const groups = [...byRoot.values()].map((grp) => {
    const x = Math.min(...grp.map((s) => s.x)), y = Math.min(...grp.map((s) => s.y));
    const x2 = Math.max(...grp.map((s) => s.x + s.wTiles * 8)), y2 = Math.max(...grp.map((s) => s.y + s.hTiles * 8));
    return { slots: grp.map((s) => s.slot).sort((a, b) => a - b), bounds: { x, y, w: x2 - x, h: y2 - y }, spriteCount: grp.length };
  });
  groups.sort((a, b) => (b.bounds.w * b.bounds.h) - (a.bounds.w * a.bounds.h));
  return { groups };
}
