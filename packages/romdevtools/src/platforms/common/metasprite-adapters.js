// Per-platform meta-sprite adapters. Each builds the uniform adapter the
// generic core (metasprite-core.js) consumes, from a live host (capture) or
// from saved bytes (re-render). See metasprite-core.js header for the shape.
//
// The two platform-specific axes that matter:
//   - tile bit-depth + byte layout (for encode/decode of tiles.bin)
//   - multi-cell tile order: Genesis is COLUMN-MAJOR (tile++ goes down a
//     column); SNES large OBJ + NES 8x16 + SMS-stacked are their own orders;
//     everything else is single-cell (8x8) so order is trivial.

// ---------- cell-order helpers ----------
// columnMajor: cell (col,row) → tile offset = col*hTiles + row  (Genesis)
function colMajorOrder(w, h) { const o = []; for (let c = 0; c < w; c++) for (let r = 0; r < h; r++) o.push(c * h + r); return o; }
function colMajorPos(w, h) { const p = []; for (let c = 0; c < w; c++) for (let r = 0; r < h; r++) p.push({ col: c, row: r }); return p; }
// rowMajor: tile offset = row*wTiles + col
function rowMajorOrder(w, h) { const o = []; for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) o.push(r * w + c); return o; }
function rowMajorPos(w, h) { const p = []; for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) p.push({ col: c, row: r }); return p; }

// ---------- generic tile encoders (export 8x8 index grids → native bytes) ----------
function encode2bppPlanar(grids) { // NES: plane0 (8 bytes) then plane1 (8 bytes)
  const out = new Uint8Array(grids.length * 16);
  grids.forEach((g, t) => {
    for (let y = 0; y < 8; y++) {
      let p0 = 0, p1 = 0;
      for (let x = 0; x < 8; x++) { const v = g[y][x]; if (v & 1) p0 |= 1 << (7 - x); if (v & 2) p1 |= 1 << (7 - x); }
      out[t * 16 + y] = p0; out[t * 16 + 8 + y] = p1;
    }
  });
  return out;
}
function encode2bppInterleaved(grids) { // GB: per row [lo,hi]
  const out = new Uint8Array(grids.length * 16);
  grids.forEach((g, t) => {
    for (let y = 0; y < 8; y++) {
      let lo = 0, hi = 0;
      for (let x = 0; x < 8; x++) { const v = g[y][x]; if (v & 1) lo |= 1 << (7 - x); if (v & 2) hi |= 1 << (7 - x); }
      out[t * 16 + y * 2] = lo; out[t * 16 + y * 2 + 1] = hi;
    }
  });
  return out;
}
function encode4bppGenesis(grids) { // packed: high nibble = left pixel
  const out = new Uint8Array(grids.length * 32);
  grids.forEach((g, t) => {
    for (let y = 0; y < 8; y++) for (let half = 0; half < 4; half++)
      out[t * 32 + y * 4 + half] = ((g[y][half * 2] & 0xF) << 4) | (g[y][half * 2 + 1] & 0xF);
  });
  return out;
}
function encode4bppSms(grids) { // interleaved per row [p0,p1,p2,p3]
  const out = new Uint8Array(grids.length * 32);
  grids.forEach((g, t) => {
    for (let y = 0; y < 8; y++) {
      let p0 = 0, p1 = 0, p2 = 0, p3 = 0;
      for (let x = 0; x < 8; x++) { const v = g[y][x], b = 7 - x; if (v & 1) p0 |= 1 << b; if (v & 2) p1 |= 1 << b; if (v & 4) p2 |= 1 << b; if (v & 8) p3 |= 1 << b; }
      out[t * 32 + y * 4] = p0; out[t * 32 + y * 4 + 1] = p1; out[t * 32 + y * 4 + 2] = p2; out[t * 32 + y * 4 + 3] = p3;
    }
  });
  return out;
}
function encode4bppSnes(grids) { // planar-pairs: bytes 0-15 planes0&1, 16-31 planes2&3
  const out = new Uint8Array(grids.length * 32);
  grids.forEach((g, t) => {
    for (let y = 0; y < 8; y++) {
      let p0 = 0, p1 = 0, p2 = 0, p3 = 0;
      for (let x = 0; x < 8; x++) { const v = g[y][x], b = 7 - x; if (v & 1) p0 |= 1 << b; if (v & 2) p1 |= 1 << b; if (v & 4) p2 |= 1 << b; if (v & 8) p3 |= 1 << b; }
      out[t * 32 + y * 2] = p0; out[t * 32 + y * 2 + 1] = p1;
      out[t * 32 + 16 + y * 2] = p2; out[t * 32 + 16 + y * 2 + 1] = p3;
    }
  });
  return out;
}

// =====================================================================
//  GENESIS
// =====================================================================
export async function genesisAdapter(host) {
  const { decode4bppTile, decodeGenesisSubpalette } = await import("../genesis/vdp.js");
  const { decodeGenesisSprites } = await import("romdev-core-host/gpgx-state.js");
  const vram = host.readMemory("video_ram", 0, 0x10000);
  const cram = host.readMemory("genesis_cram", 0, 128);
  const regs = host.readMemory("genesis_vdp_regs", 0, 32);
  const raw = decodeGenesisSprites(vram, regs);
  return {
    platform: "genesis", bpp: 4, screenW: 320, screenH: 224, tileColumnMajor: true,
    sprites: raw.map((s) => ({ slot: s.slot, x: s.x, y: s.y, wTiles: s.size.w / 8, hTiles: s.size.h / 8, tile: s.tile, palette: s.palette, flipH: s.flipH, flipV: s.flipV, priority: s.priority, visible: s.visible })),
    cellTileOrder: colMajorOrder, cellGridPositions: colMajorPos,
    getTilePixels: (idx) => decode4bppTile(vram.subarray((idx & 0x7FF) * 32, (idx & 0x7FF) * 32 + 32)),
    getPaletteRgb: (p) => decodeGenesisSubpalette(cram, p),
    exportPalette: () => ({ bytes: Uint8Array.from(cram), json: paletteLinesJson(cram, 4, 16, (i) => decodeGenesisSubpalette(cram, i)) }),
    encodeTiles: encode4bppGenesis,
  };
}

// =====================================================================
//  SNES — large OBJ are row-major in a wTiles×hTiles grid; tile index is
//  +1 across, +0x10 down (16-wide OBJ name table). We export contiguously.
// =====================================================================
export async function snesAdapter(host) {
  const { decodeOAM, decodeSnesTile, decodeCGRAM, decodePpuRegs, ppuRegsPopulated } =
    await import("../snes/ppu.js");
  const vram = host.readMemory("video_ram", 0, 0x10000);
  const cgram = host.readMemory("snes_cgram", 0, 512);
  const oam = host.readMemory("snes_oam", 0, 544);
  const fillram = host.readMemory("snes_fillram", 0, 0x8000);
  const colors = decodeCGRAM(cgram); // 256 entries
  // Live OBSEL → correct OBJ size pair so wTiles/hTiles are right (a 16×16
  // OBJ must capture as 2×2 tiles, not 1×1).
  const ppu = ppuRegsPopulated(fillram) ? decodePpuRegs(fillram) : null;
  const raw = decodeOAM(oam, ppu ? {
    smallSize: ppu.objSize.small, largeSize: ppu.objSize.large,
    objNameBaseByte: ppu.objNameBaseByte, objGapByte: ppu.objGapByte,
  } : {});
  // SNES OBJ palettes are CGRAM 128-255, 16 colors each (8 lines). palette
  // field is 0-7 → base = 128 + p*16.
  const palRgb = (p) => { const base = 128 + (p & 7) * 16; return colors.slice(base, base + 16).map((c) => [c.r, c.g, c.b]); };
  // Large-OBJ tile layout: within a wTiles×hTiles sprite, tile index goes
  // +1 per column and +0x10 per row (OBJ char table is 16 tiles wide).
  const orderFn = (w, h) => { const o = []; for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) o.push(r * 0x10 + c); return o; };
  return {
    platform: "snes", bpp: 4, screenW: 256, screenH: 224, tileColumnMajor: false,
    sprites: raw.map((s) => ({ slot: s.slot, x: s.x, y: s.y, wTiles: s.size.w / 8, hTiles: s.size.h / 8, tile: s.tile, palette: s.palette, flipH: s.flipH, flipV: s.flipV, priority: s.priority, visible: s.visible })),
    cellTileOrder: orderFn, cellGridPositions: rowMajorPos,
    getTilePixels: (idx) => { const off = ((idx & 0x1FF) * 32) & 0xFFFF; return decodeSnesTile(vram.subarray(off, off + 32), 4); },
    getPaletteRgb: palRgb,
    exportPalette: () => ({ bytes: Uint8Array.from(cgram), json: paletteLinesJson(cgram, 8, 16, (i) => palRgb(i), 128) }),
    encodeTiles: encode4bppSnes,
  };
}

// =====================================================================
//  NES — 8x8 (1 tile) or 8x16 (2 tiles stacked, top then bottom).
// =====================================================================
export async function nesAdapter(host) {
  const { decodeTile } = await import("../nes/ppu.js");
  const oam = host.readMemory("nes_oam", 0, 256);
  const chr = host.readMemory("nes_chr", 0, 0x2000); // 8KB pattern space
  const palBytes = host.readMemory("nes_palette", 0, 32);
  const ppu = host.readMemory("nes_ppu_regs", 0, 4);
  const spr8x16 = !!(ppu[0] & 0x20);
  // NES sprite palettes are entries 16..31 (4 lines of 4). palette field 0-3.
  const NES_RGB = nesMasterRgb();
  const palRgb = (p) => { const out = [[0, 0, 0]]; for (let i = 1; i < 4; i++) out.push(NES_RGB[palBytes[16 + p * 4 + i] & 0x3F]); return out; };
  const sprites = [];
  for (let i = 0; i < 64; i++) {
    const y = oam[i * 4], tile = oam[i * 4 + 1], attr = oam[i * 4 + 2], x = oam[i * 4 + 3];
    sprites.push({
      slot: i, x, y, wTiles: 1, hTiles: spr8x16 ? 2 : 1,
      tile: spr8x16 ? (tile & 0xFE) : tile,  // 8x16: bit0 selects pattern table, even tile is top
      palette: attr & 3, flipH: !!(attr & 0x40), flipV: !!(attr & 0x80), priority: (attr >> 5) & 1,
      visible: y < 0xEF,
    });
  }
  return {
    platform: "nes", bpp: 2, screenW: 256, screenH: 240, tileColumnMajor: false,
    sprites,
    cellTileOrder: (w, h) => rowMajorOrder(w, h),  // 8x16 → [0,1] = top,bottom
    cellGridPositions: rowMajorPos,
    getTilePixels: (idx) => flatToGrid(decodeTile(chr.subarray((idx & 0x1FF) * 16, (idx & 0x1FF) * 16 + 16))),
    getPaletteRgb: palRgb,
    exportPalette: () => ({ bytes: Uint8Array.from(palBytes), json: { "sprite0": palRgb(0).map(rgbHex), "sprite1": palRgb(1).map(rgbHex), "sprite2": palRgb(2).map(rgbHex), "sprite3": palRgb(3).map(rgbHex) } }),
    encodeTiles: encode2bppPlanar,
  };
}

// =====================================================================
//  GB / GBC — 8x8 or 8x16 (top tile = idx&0xFE, bottom = idx|1).
// =====================================================================
export async function gbAdapter(host, platform) {
  const { decodeGbTile } = await import("../gb/ppu.js");
  const oam = host.readMemory("gb_oam", 0, 0xA0);
  const vram = host.readMemory("gb_vram", 0, 0x2000);
  const io = host.readMemory("gb_io", 0, 0x80);
  const obj8x16 = !!(io[0x40] & 0x04);
  // DMG OBJ palettes OBP0 ($FF48) / OBP1 ($FF49): 4 shades. CGB has OBJ
  // palette RAM but we keep it simple: DMG grayscale by palette bits.
  const DMG = [[224,248,208],[136,192,112],[52,104,86],[8,24,32]];
  const obp = [io[0x48], io[0x49]];
  const palRgb = (p) => { const reg = obp[p & 1]; const out = []; for (let i = 0; i < 4; i++) out.push(DMG[(reg >> (i * 2)) & 3]); return out; };
  const sprites = [];
  for (let i = 0; i < 40; i++) {
    const y = oam[i * 4] - 16, x = oam[i * 4 + 1] - 8, t = oam[i * 4 + 2], a = oam[i * 4 + 3];
    sprites.push({
      slot: i, x, y, wTiles: 1, hTiles: obj8x16 ? 2 : 1,
      tile: obj8x16 ? (t & 0xFE) : t,
      palette: (a >> 4) & 1, flipH: !!(a & 0x20), flipV: !!(a & 0x40), priority: (a >> 7) & 1,
      visible: oam[i * 4] !== 0 && oam[i * 4] < 160,
    });
  }
  return {
    platform, bpp: 2, screenW: 160, screenH: 144, tileColumnMajor: false,
    sprites,
    cellTileOrder: rowMajorOrder, cellGridPositions: rowMajorPos,
    getTilePixels: (idx) => flatToGrid(decodeGbTile(vram, (idx & 0xFF) * 16)),
    getPaletteRgb: palRgb,
    exportPalette: () => ({ bytes: Uint8Array.from([obp[0], obp[1]]), json: { "obp0": palRgb(0).map(rgbHex), "obp1": palRgb(1).map(rgbHex) } }),
    encodeTiles: encode2bppInterleaved,
  };
}

// =====================================================================
//  SMS / GG — 8x8 sprites (8x16 stacked when reg1 bit1 set). One sprite
//  palette line (CRAM entries 16-31). Tile data base from VDP reg 6.
// =====================================================================
export async function smsAdapter(host, platform) {
  const { decodeSmsTile, decodeSmsVdpRegs, snapshotPalette } = await import("../sms/vdp.js");
  const vramRegion = platform === "gg" ? "gg_vram" : "sms_vram";
  const vram = host.readMemory(vramRegion, 0, 0x4000);
  const regs = host.readMemory("sms_vdp_regs", 0, 16);
  const dec = decodeSmsVdpRegs(regs);
  const { colors } = snapshotPalette(host, platform); // 32 entries
  const sprPal = colors.slice(16, 32).map((c) => [c.r, c.g, c.b]);
  const palRgb = () => sprPal;
  const big = dec.mode2.spriteSize8x16;
  const base = dec.spriteTileDataBaseDec;
  const sat = vram.slice(dec.spriteAttrTableBaseDec, dec.spriteAttrTableBaseDec + 256);
  const sprites = [];
  for (let i = 0; i < 64; i++) {
    const y = sat[i];
    if (y === 0xD0) break;                       // terminator
    const x = sat[0x80 + i * 2], tile = sat[0x80 + i * 2 + 1];
    sprites.push({
      slot: i, x, y: (y + 1) & 0xFF, wTiles: 1, hTiles: big ? 2 : 1,
      tile: big ? (tile & 0xFE) : tile, palette: 0, flipH: false, flipV: false, priority: 0,
      visible: true,
    });
  }
  return {
    platform, bpp: 4, screenW: platform === "gg" ? 160 : 256, screenH: platform === "gg" ? 144 : 192, tileColumnMajor: false,
    sprites,
    cellTileOrder: rowMajorOrder, cellGridPositions: rowMajorPos,
    getTilePixels: (idx) => { const out = decodeSmsTile(vram, base + (idx & 0x1FF) * 32); const g = []; for (let y = 0; y < 8; y++) g.push(Array.from(out.slice(y * 8, y * 8 + 8))); return g; },
    getPaletteRgb: palRgb,
    exportPalette: () => { const cram = host.readMemory(platform === "gg" ? "gg_cram" : "sms_cram", 0, platform === "gg" ? 64 : 32); return { bytes: Uint8Array.from(cram), json: { "sprite": sprPal.map(rgbHex) } }; },
    encodeTiles: encode4bppSms,
  };
}

// ---------- shared helpers ----------
// Some platform tile decoders return a flat Uint8Array(64); the core wants
// an 8x8 nested array of indices.
function flatToGrid(flat) { const g = []; for (let y = 0; y < 8; y++) { const row = []; for (let x = 0; x < 8; x++) row.push(flat[y * 8 + x]); g.push(row); } return g; }
function rgbHex(rgb) { return "#" + [rgb[0], rgb[1], rgb[2]].map((v) => (v & 0xFF).toString(16).padStart(2, "0")).join(""); }
function paletteLinesJson(cram, lines, perLine, lineRgbFn) {
  const json = {};
  for (let i = 0; i < lines; i++) json[String(i)] = lineRgbFn(i).map(rgbHex);
  return json;
}

// NES 2C02 master palette (sample — matches sprite-pipeline's NES_MASTER).
function nesMasterRgb() {
  // 64-entry approximation; index by the palette byte & 0x3F.
  const P = [
    [0x60,0x60,0x60],[0x00,0x20,0x80],[0x00,0x00,0xA0],[0x40,0x00,0x90],[0x80,0x00,0x60],[0xA0,0x00,0x30],[0xA0,0x00,0x00],[0x80,0x20,0x00],
    [0x60,0x40,0x00],[0x20,0x60,0x00],[0x00,0x80,0x00],[0x00,0x60,0x30],[0x00,0x40,0x60],[0,0,0],[0,0,0],[0,0,0],
    [0xA0,0xA0,0xA0],[0x00,0x60,0xC0],[0x20,0x40,0xE0],[0x80,0x00,0xF0],[0xC0,0x00,0xC0],[0xE0,0x00,0x60],[0xF0,0x20,0x00],[0xC0,0x60,0x00],
    [0x80,0x80,0x00],[0x40,0xA0,0x00],[0x00,0xC0,0x00],[0x20,0xA0,0x60],[0x00,0x80,0xA0],[0,0,0],[0,0,0],[0,0,0],
    [0xF0,0xF0,0xF0],[0x60,0xA0,0xF0],[0x80,0x80,0xF0],[0xC0,0x60,0xF0],[0xF0,0x40,0xF0],[0xF0,0x60,0xA0],[0xF0,0x80,0x60],[0xE0,0xA0,0x40],
    [0xC0,0xC0,0x20],[0x80,0xE0,0x40],[0x40,0xE0,0x80],[0x40,0xE0,0xC0],[0x00,0xE0,0xE0],[0x60,0x60,0x60],[0,0,0],[0,0,0],
    [0xF0,0xF0,0xF0],[0xA0,0xD0,0xF0],[0xC0,0xC0,0xF0],[0xE0,0xC0,0xF0],[0xF0,0xC0,0xF0],[0xF0,0xC0,0xE0],[0xF0,0xC0,0xC0],[0xF0,0xD0,0xA0],
    [0xE0,0xE0,0x80],[0xC0,0xE0,0x80],[0xA0,0xF0,0xA0],[0xA0,0xF0,0xC0],[0xA0,0xF0,0xE0],[0xA0,0xA0,0xA0],[0,0,0],[0,0,0],
  ];
  return P;
}

/** Build the right adapter for a platform from a live host. */
export async function buildAdapter(host, platform) {
  switch (platform) {
    case "genesis": return genesisAdapter(host);
    case "snes": return snesAdapter(host);
    case "nes": return nesAdapter(host);
    case "gb": case "gbc": return gbAdapter(host, platform);
    case "sms": case "gg": return smsAdapter(host, platform);
    case "c64":
      throw new Error("captureMetaSprite[c64]: the C64 has 8 hardware MOBs (24×21px bitmaps, not 8x8 tiles) — they don't fit the tile-based meta-sprite model. Use inspectSprites + the sprite data pointers, and author MOB bitmaps directly.");
    default:
      throw new Error(`captureMetaSprite: no meta-sprite adapter for platform '${platform}'. Supported: genesis, snes, nes, gb, gbc, sms, gg.`);
  }
}
