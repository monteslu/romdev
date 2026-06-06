// SNES PPU helpers — decode OAM, CGRAM, VRAM tiles, and BG tilemaps from
// snes9x's exposed memory regions (romdev/snes9x patch: snes_oam,
// snes_cgram, plus the standard video_ram → Memory.VRAM 64 KB region).
//
// OAM is 544 bytes: a 512-byte "low" table (128 sprites × 4 bytes) plus
// a 32-byte "high" table that holds the X-high bit and size bit for
// each sprite (2 bits × 128 sprites = 32 bytes).
//
// Low table layout per sprite (4 bytes):
//   byte 0: X position (low 8 bits)
//   byte 1: Y position
//   byte 2: tile number (low 8 bits)
//   byte 3: vhoopppN (V flip, H flip, priority 2 bits, palette 3 bits, name table bit)
//
// High table layout (32 bytes = 128 sprites × 2 bits):
//   sprite N:
//     bit 0: X high bit
//     bit 1: size (0 = small per OBSEL.size, 1 = large)
//
// CGDATA: 256 colors × uint16. Each color is BGR555:
//   bits 0-4   : red
//   bits 5-9   : green
//   bits 10-14 : blue
//   bit 15     : unused
//
// All values are derived from snes9x's own structures (see ppu.h SPPU.
// OAMData / SPPU.CGDATA), which are stable across snes9x versions.

// --- PPU register decode (from snes_fillram) -------------------------------
//
// snes9x DOES mirror the write-only PPU register file $2100-$213f into
// Memory.FillRAM — but indexed by the FULL register address, so OBSEL is
// FillRAM[0x2101], NOT FillRAM[0x101]. The `snes_fillram` region exposes
// the whole 32 KB shadow, so we can read back every PPU register the game
// last wrote. (Verified empirically; the old "snes9x doesn't expose PPU
// regs" assumption was reading the wrong offset.) This unlocks real OBSEL/
// BGMODE/TM/TS/color-math decoding instead of asking the agent to guess.

/** OBSEL ($2101) bits 5-7 select the small/large object-size PAIR. */
const OBJ_SIZE_TABLE = [
  { small: [8, 8],   large: [16, 16] },  // 0
  { small: [8, 8],   large: [32, 32] },  // 1
  { small: [8, 8],   large: [64, 64] },  // 2
  { small: [16, 16], large: [32, 32] },  // 3
  { small: [16, 16], large: [64, 64] },  // 4
  { small: [32, 32], large: [64, 64] },  // 5
  { small: [16, 32], large: [32, 64] },  // 6 (undocumented)
  { small: [16, 32], large: [32, 32] },  // 7 (undocumented)
];

/**
 * Decode the SNES PPU register file from the snes_fillram shadow.
 * @param {Uint8Array} fillram 32 KB region read via readMemory("snes_fillram", 0, 0x8000)
 * @returns {{
 *   inidisp:number, forcedBlank:boolean, brightness:number,
 *   bgMode:number, bg3Priority:number,
 *   obsel:number, objSizeSel:number, objSize:{small:[number,number],large:[number,number]},
 *   objNameBaseWord:number, objNameBaseByte:number, objNameSelect:number, objGapByte:number,
 *   bg:Array<{scBaseWord:number,scBaseByte:number,mapSize:number,mapWidth:number,mapHeight:number,charBaseWord:number,charBaseByte:number}>,
 *   tm:number, ts:number, mainScreen:object, subScreen:object,
 *   cgwsel:number, cgadsub:number, colorMath:object,
 *   raw:Object<string,number>
 * }}
 */
export function decodePpuRegs(fillram) {
  // FillRAM is indexed by full register address. Guard short reads.
  const r = (addr) => (addr < fillram.length ? fillram[addr] : 0);

  const inidisp = r(0x2100);
  const obsel = r(0x2101);
  const bgmode = r(0x2105);
  const bg3prio = (bgmode >> 3) & 1;

  // OBSEL: bits 0-2 = name base (×0x2000 words), bit 3-4 = name select gap,
  // bits 5-7 = size selection.
  const objNameBaseWord = (obsel & 0x07) << 13;       // word address
  const objNameSelectBits = (obsel >> 3) & 0x03;
  const objSizeSel = (obsel >> 5) & 0x07;
  const objSize = OBJ_SIZE_TABLE[objSizeSel];

  // Per-BG: BGxSC ($2107-210a) = tilemap base (bits 2-7 ×0x400 words) + size
  // (bits 0-1). BGxNBA ($210b/210c) packs two BGs per byte = char base
  // (×0x1000 words).
  const bg = [];
  const MAP_SIZE = [
    { w: 32, h: 32 }, { w: 64, h: 32 }, { w: 32, h: 64 }, { w: 64, h: 64 },
  ];
  for (let i = 0; i < 4; i++) {
    const bgsc = r(0x2107 + i);
    const scBaseWord = (bgsc & 0xFC) << 8;             // bits 2-7 → ×0x400 words
    const mapSize = bgsc & 0x03;
    const nbaByte = r(0x210b + (i >> 1));
    const nbaNybble = (i & 1) ? (nbaByte >> 4) & 0x0F : nbaByte & 0x0F;
    const charBaseWord = nbaNybble << 12;              // ×0x1000 words
    bg.push({
      scBaseWord,
      scBaseByte: scBaseWord * 2,
      mapSize,
      mapWidth: MAP_SIZE[mapSize].w,
      mapHeight: MAP_SIZE[mapSize].h,
      charBaseWord,
      charBaseByte: charBaseWord * 2,
    });
  }

  const tm = r(0x212c);
  const ts = r(0x212d);
  const screenBits = (b) => ({
    bg1: !!(b & 0x01), bg2: !!(b & 0x02), bg3: !!(b & 0x04),
    bg4: !!(b & 0x08), obj: !!(b & 0x10),
  });

  const cgwsel = r(0x2130);
  const cgadsub = r(0x2131);

  return {
    inidisp,
    forcedBlank: !!(inidisp & 0x80),
    brightness: inidisp & 0x0F,
    bgMode: bgmode & 0x07,
    bg3Priority: bg3prio,
    obsel,
    objSizeSel,
    objSize,
    objNameBaseWord,
    objNameBaseByte: objNameBaseWord * 2,
    objNameSelect: objNameSelectBits,
    // Second sprite tile page is objNameBase + (objNameSelect+1)×0x1000 words.
    objGapByte: (objNameSelectBits + 1) * 0x1000 * 2,
    bg,
    tm,
    ts,
    mainScreen: screenBits(tm),
    subScreen: screenBits(ts),
    cgwsel,
    cgadsub,
    colorMath: {
      addSubscreen: !!(cgwsel & 0x02),
      subtract: !!(cgadsub & 0x80),
      halve: !!(cgadsub & 0x40),
      enableObj: !!(cgadsub & 0x10),
      enableBackdrop: !!(cgadsub & 0x20),
    },
    raw: {
      INIDISP: inidisp, OBSEL: obsel, BGMODE: bgmode,
      BG1SC: r(0x2107), BG2SC: r(0x2108), BG3SC: r(0x2109), BG4SC: r(0x210a),
      BG12NBA: r(0x210b), BG34NBA: r(0x210c),
      TM: tm, TS: ts, CGWSEL: cgwsel, CGADSUB: cgadsub,
    },
  };
}

/**
 * Is the PPU register shadow actually populated? A freshly-reset core (no
 * frames stepped, or a game that hasn't touched the PPU) leaves FillRAM at
 * its init value, so $2100-$213f can read back as all-zero / all-same. Use
 * this to decide whether decoded regs are trustworthy.
 * @param {Uint8Array} fillram
 * @returns {boolean}
 */
export function ppuRegsPopulated(fillram) {
  // INIDISP, OBSEL, BGMODE, and at least one screen-enable being non-zero is
  // a strong signal the game has configured the PPU.
  if (fillram.length <= 0x213f) return false;
  const probe = [0x2100, 0x2101, 0x2105, 0x2107, 0x210b, 0x212c];
  return probe.some((a) => fillram[a] !== 0 && fillram[a] !== 0xFF);
}

/**
 * Decode the SNES OAM into the generic sprite shape used by inspectSprites.
 * @param {Uint8Array} oam 544 bytes (low table + high table)
 * @param {{ smallSize?: [number, number], largeSize?: [number, number] }} [opts]
 *   OBSEL.size selects the small/large pair per object. Pass the pair from
 *   decodePpuRegs().objSize for accuracy; if omitted we default to the most
 *   common {8×8, 16×16} pair.
 * @returns {Array<{
 *   slot: number, x: number, y: number, tile: number, palette: number,
 *   priority: number, flipH: boolean, flipV: boolean,
 *   size: { w: number, h: number }, visible: boolean,
 *   nameTable: 0 | 1, raw: { byte0: number, byte1: number, byte2: number, byte3: number, hiBits: number }
 * }>}
 */
export function decodeOAM(oam, opts = {}) {
  const smallSize = opts.smallSize ?? [8, 8];
  const largeSize = opts.largeSize ?? [16, 16];
  // OBJ tile VRAM addressing, when we know OBSEL (decodePpuRegs output).
  // Base page is objNameBaseByte; the name-table-select bit chooses the
  // second page at +objGapByte. Each 8×8 cell is 32 bytes (4bpp; OBJ is
  // always 4bpp). A 16×16 object occupies a 2×2 block of cells in VRAM.
  const objBaseByte = opts.objNameBaseByte ?? null;   // null → unknown OBSEL
  const objGapByte = opts.objGapByte ?? 0;
  const OBJ_TILE_BYTES = 32;
  const sprites = [];
  for (let i = 0; i < 128; i++) {
    const lo = i * 4;
    const x = oam[lo + 0];
    const y = oam[lo + 1];
    const tile = oam[lo + 2];
    const attr = oam[lo + 3];
    // High table: 2 bits per sprite, packed 4 sprites per byte.
    const hi = oam[512 + (i >> 2)];
    const hiShift = (i & 3) * 2;
    const hiBits = (hi >> hiShift) & 0x3;
    const xHigh = hiBits & 0x1;
    const sizeBit = (hiBits >> 1) & 0x1;
    const fullX = (xHigh ? 0x100 : 0) | x;
    const [w, h] = sizeBit ? largeSize : smallSize;
    // 9-bit X is signed: $100..$1FF wrap to negative (off the left edge).
    const sx = fullX >= 0x100 ? fullX - 0x200 : fullX;
    const nameTable = /** @type {0 | 1} */ (attr & 0x01);
    const tile9 = tile | (nameTable << 8); // 9-bit OBJ tile index
    const palette = (attr >> 1) & 0x7;

    // Renderability: an OBJ is renderable this frame only if it overlaps the
    // 256×224 (or ×239) screen box AND isn't parked at the off-screen-top
    // Y=$E0..$FF convention games use to "hide" sprites. This is the real
    // distinction Codex asked for — a populated OAM slot is NOT the same as
    // a drawn sprite.
    const onX = sx + w > 0 && sx < 256;
    const onY = y < 0xE0 && (y + h) > 0;      // Y≥0xE0 is the hide convention
    const renderable = onX && onY;
    let hiddenReason = null;
    if (!renderable) {
      if (y >= 0xE0) hiddenReason = "parked off-screen-top (Y≥0xE0, the common hide convention)";
      else if (!onX) hiddenReason = sx >= 256 ? "off right edge" : "off left edge";
      else if (!onY) hiddenReason = "off bottom";
    }

    // Resolve OBJ tile VRAM address + CGRAM palette range when OBSEL known.
    let tileVramAddr = null, tileVramByte = null;
    if (objBaseByte != null) {
      const page = nameTable ? objGapByte : 0;
      tileVramByte = objBaseByte + page + tile * OBJ_TILE_BYTES;
      tileVramAddr = "0x" + (tileVramByte & 0xFFFF).toString(16).padStart(4, "0");
    }
    // OBJ palettes occupy CGRAM 128..255 (palettes 8..15); each is 16 colors.
    const cgramPaletteBase = 128 + palette * 16;

    sprites.push({
      slot: i,
      x: sx, // sign-extended 9-bit X (negative = off the left edge)
      y, // SNES Y is 0..255; Y≥0xE0 is the off-screen-top hide convention
      tile: tile9,
      palette,
      cgramPaletteBase,                  // first CGRAM index of this OBJ's 16-color palette
      cgramPaletteRange: [cgramPaletteBase, cgramPaletteBase + 15],
      priority: (attr >> 4) & 0x3,
      flipH: !!((attr >> 6) & 0x1),
      flipV: !!((attr >> 7) & 0x1),
      size: { w, h },
      sizeIsLarge: !!sizeBit,
      // `visible` kept for back-compat; `renderable` is the precise answer.
      visible: renderable,
      renderable,
      hiddenReason,
      tileVramAddr,                      // resolved VRAM byte addr of tile 0 (null if OBSEL unknown)
      tileVramByte,
      nameTable,
      raw: { byte0: x, byte1: y, byte2: tile, byte3: attr, hiBits },
    });
  }
  return sprites;
}

/**
 * Inspect the OBJ palette lines that renderable sprites actually reference and
 * flag the ones that look UNINTENTIONAL — not just all-zero, but stale/default
 * "garbage" too. The classic SNES bug (Codex's Asteroids) is a sprite naming
 * OBJ palette line 1 or 3 when only line 0 was uploaded: the unused lines hold
 * whatever was in CGRAM (zero on some paths, a default ramp / leftover junk on
 * others), so the sprite renders with wrong/garbage colors. An all-zero-only
 * check misses the non-zero-junk case, so we grade each line on several
 * signals and classify it `uninitialized` (high confidence) or `suspicious`.
 *
 * The single strongest signal is **contiguity**: real games upload OBJ
 * palettes as a block starting at line 0, so a referenced line ABOVE the
 * highest authored-looking line — with nothing authored in between — almost
 * always means "I used a palette I never uploaded."
 *
 * @param {Array<ReturnType<typeof decodeOAM>[number]>} sprites
 * @param {Array<{r:number,g:number,b:number,rawWord:number}>} cgramColors decodeCGRAM() output (256 entries)
 * @returns {{ uninitializedPalettes:number[], suspiciousPalettes:number[], paletteReport:Array<{line:number,verdict:string,reasons:string[]}>, warnings:string[] }}
 */
export function checkObjPalettes(sprites, cgramColors) {
  const lineWords = (line) => {
    const base = 128 + line * 16;
    const w = [];
    for (let k = 0; k < 16; k++) w.push(cgramColors[base + k]?.rawWord ?? 0);
    return w;
  };
  // Heuristic signals for one OBJ palette line (16 BGR555 words). Index 0 is
  // the OBJ-transparent slot and the renderer ignores it, so judge colors 1-15.
  const analyzeLine = (line) => {
    const w = lineWords(line);
    const body = w.slice(1); // colors 1..15 — the ones that actually draw
    const reasons = [];
    const allZero = w.every((v) => v === 0);
    const bodyZero = body.every((v) => v === 0);
    const distinct = new Set(body).size;
    const uniform = distinct === 1;                 // every drawing color identical
    // Smooth-ramp / default-gradient smell: each channel monotonic across the
    // line (what a power-on/leftover default tends to look like). Cheap proxy:
    // the raw words are monotonic non-decreasing or non-increasing.
    let inc = true, dec = true;
    for (let k = 1; k < body.length; k++) {
      if (body[k] < body[k - 1]) inc = false;
      if (body[k] > body[k - 1]) dec = false;
    }
    const monotonic = (inc || dec) && distinct >= 8; // a long smooth ramp, not a real sprite palette
    if (allZero || bodyZero) reasons.push("all-zero (never written)");
    if (uniform && !bodyZero) reasons.push("every color identical (flat fill — stale/default, not a sprite palette)");
    if (monotonic) reasons.push("smooth color ramp across all 16 entries (looks like a power-on/leftover default, not authored art)");
    return { line, words: w, allZero: allZero || bodyZero, uniform, monotonic, distinct, reasons };
  };

  // What does an *authored* OBJ palette look like? Use the referenced lines'
  // own analysis: a line with several distinct non-zero colors and no default
  // smell is "authored". The highest authored line bounds the uploaded block.
  const usedLines = [...new Set(sprites.filter((s) => s.renderable).map((s) => s.palette))].sort((a, b) => a - b);
  const analyses = new Map(usedLines.map((l) => [l, analyzeLine(l)]));
  // Also probe line 0 (the conventional first OBJ palette) for the contiguity test.
  if (!analyses.has(0)) analyses.set(0, analyzeLine(0));
  const looksAuthored = (a) => a && a.distinct >= 2 && !a.allZero && !a.uniform && !a.monotonic;
  let highestAuthored = -1;
  for (const [line, a] of analyses) if (looksAuthored(a)) highestAuthored = Math.max(highestAuthored, line);

  const uninitializedPalettes = [];
  const suspiciousPalettes = [];
  const paletteReport = [];
  const warnings = [];
  for (const pal of usedLines) {
    const a = analyses.get(pal);
    const reasons = [...a.reasons];
    // Contiguity: a referenced line above the authored block, when SOME line
    // looks authored, is the "used a palette I never uploaded" footgun.
    if (highestAuthored >= 0 && pal > highestAuthored && !looksAuthored(a)) {
      reasons.push(
        `referenced but ABOVE the uploaded block (line ${highestAuthored} is the ` +
        `highest that looks authored) — likely never uploaded`
      );
    }
    if (reasons.length === 0) { paletteReport.push({ line: pal, verdict: "ok", reasons: [] }); continue; }
    const base = 128 + pal * 16;
    const highConfidence = a.allZero || reasons.some((r) => /never uploaded/.test(r));
    const verdict = highConfidence ? "uninitialized" : "suspicious";
    (highConfidence ? uninitializedPalettes : suspiciousPalettes).push(pal);
    paletteReport.push({ line: pal, verdict, reasons });
    warnings.push(
      `OBJ palette line ${pal} (CGRAM ${base}-${base + 15}) is referenced by a renderable ` +
      `sprite but looks ${verdict === "uninitialized" ? "UNINITIALIZED" : "SUSPICIOUS"}: ` +
      reasons.join("; ") + ". Sprites using it will likely render with wrong/garbage colors. " +
      `Upload this palette line explicitly (CGADD ${base} / setPaletteColor from ${base}), or point the sprite at an authored line.`
    );
  }
  return { uninitializedPalettes, suspiciousPalettes, paletteReport, warnings };
}

/**
 * Decode SNES CGRAM (palette) into normalized {index, r, g, b, rawWord}.
 * @param {Uint8Array} cgram 512 bytes (256 colors × uint16 little-endian)
 * @returns {Array<{ index: number, r: number, g: number, b: number, rawWord: number }>}
 */
export function decodeCGRAM(cgram) {
  const colors = [];
  for (let i = 0; i < 256; i++) {
    const off = i * 2;
    const word = cgram[off] | (cgram[off + 1] << 8);
    // BGR555 → 0..31 per channel. Expand to 0..255 with the common
    // (c << 3) | (c >> 2) approximation so the values are PNG-ready.
    const r5 = word & 0x1F;
    const g5 = (word >> 5) & 0x1F;
    const b5 = (word >> 10) & 0x1F;
    colors.push({
      index: i,
      r: (r5 << 3) | (r5 >> 2),
      g: (g5 << 3) | (g5 >> 2),
      b: (b5 << 3) | (b5 >> 2),
      rawWord: word,
    });
  }
  return colors;
}

import { PNG } from "pngjs";

// --- VRAM tile + tilemap decode --------------------------------------------
//
// These render helpers take bpp / tilemap base / tile base as parameters.
// You can get the live values from decodePpuRegs(snes_fillram) — BG mode,
// each BGxSC tilemap base, each BGxNBA char base, and OBSEL OBJ base are all
// decodable now (snes9x mirrors $2100-$213f into FillRAM). Defaults below are
// the PVSnesLib / SNES-common Mode-1 values (4bpp BG1/BG2, 2bpp BG3) for when
// you call these standalone without the decoded regs.
//
// SNES tile bitplane layout:
//   2bpp tile = 16 bytes: 8 rows × {plane0, plane1} interleaved.
//     row r: byte[r*2] = plane0 bits, byte[r*2+1] = plane1 bits.
//   4bpp tile = 32 bytes: first 16 bytes are planes 0&1 (as 2bpp),
//     next 16 bytes are planes 2&3 (same row interleave).
//   8bpp tile = 64 bytes: four 16-byte plane-pair groups.
//   In every plane, bit 7 = leftmost pixel.

const BPP_TILE_BYTES = { 2: 16, 4: 32, 8: 64 };

/**
 * Decode one SNES tile (2/4/8 bpp) into an 8×8 array of palette indices.
 * @param {Uint8Array} bytes tile bytes (16/32/64 depending on bpp)
 * @param {2|4|8} bpp
 * @returns {number[][]} 8 rows × 8 cols of palette indices
 */
export function decodeSnesTile(bytes, bpp = 4) {
  const planes = bpp; // number of bitplanes == bpp
  const rows = [];
  for (let y = 0; y < 8; y++) {
    const row = [];
    for (let x = 0; x < 8; x++) {
      let idx = 0;
      for (let p = 0; p < planes; p++) {
        // Plane pair group: planes 0&1 in bytes 0-15, 2&3 in 16-31, ...
        const pairGroup = p >> 1;            // 0,0,1,1,2,2,3,3 → group index
        const inPair = p & 1;                 // which plane of the pair
        const base = pairGroup * 16;
        const b = bytes[base + y * 2 + inPair];
        const bit = (b >> (7 - x)) & 1;
        idx |= bit << p;
      }
      row.push(idx);
    }
    rows.push(row);
  }
  return rows;
}

/**
 * Render a sheet of SNES VRAM tiles to a PNG. Lays tiles out 16 across.
 *
 * @param {Uint8Array} vram 64 KB
 * @param {Array<{r:number,g:number,b:number}>} cgramColors decodeCGRAM() output (256 entries)
 * @param {object} opts
 * @param {2|4|8} [opts.bpp=4]
 * @param {number} [opts.tileBaseByte=0]   byte offset into VRAM of tile 0
 * @param {number} [opts.tileCount]        how many tiles to render (default fills VRAM)
 * @param {number} [opts.paletteBase=0]    CGRAM index of color 0 of the sub-palette to use
 * @param {number} [opts.cols=16]
 * @returns {{ width:number, height:number, png:Buffer, tileCount:number, bpp:number, note:string }}
 */
export function renderSnesTilesheet(vram, cgramColors, opts = {}) {
  const bpp = opts.bpp ?? 4;
  const tileBytes = BPP_TILE_BYTES[bpp];
  if (!tileBytes) throw new Error(`SNES bpp must be 2, 4, or 8 — got ${bpp}`);
  const tileBase = opts.tileBaseByte ?? 0;
  const cols = opts.cols ?? 16;
  const paletteBase = opts.paletteBase ?? 0;
  const maxTiles = Math.floor((vram.length - tileBase) / tileBytes);
  const tileCount = Math.min(opts.tileCount ?? maxTiles, maxTiles);
  const rowsOfTiles = Math.ceil(tileCount / cols);
  const W = cols * 8;
  const H = rowsOfTiles * 8;
  const png = new PNG({ width: W, height: H });

  for (let t = 0; t < tileCount; t++) {
    const off = tileBase + t * tileBytes;
    const tile = decodeSnesTile(vram.subarray(off, off + tileBytes), bpp);
    const tx = (t % cols) * 8;
    const ty = Math.floor(t / cols) * 8;
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        const ci = tile[y][x];
        const c = cgramColors[paletteBase + ci] || { r: 0, g: 0, b: 0 };
        const o = ((ty + y) * W + (tx + x)) * 4;
        png.data[o + 0] = c.r;
        png.data[o + 1] = c.g;
        png.data[o + 2] = c.b;
        png.data[o + 3] = 0xFF;
      }
    }
  }
  return {
    width: W,
    height: H,
    png: PNG.sync.write(png),
    tileCount,
    bpp,
    note: `${tileCount} ${bpp}bpp tiles from VRAM byte offset 0x${tileBase.toString(16)} ` +
      `(palette base CGRAM index ${paletteBase}). If bpp/tileBase/paletteBase weren't supplied they ` +
      `default to Mode-1 values — get the live ones from getRenderingContext({platform:'snes'}).`,
  };
}

/**
 * Render a SNES BG tilemap to a PNG composite.
 *
 * A SNES tilemap is a grid of 16-bit little-endian entries:
 *   bits 0-9   : tile index (into the BG's tile data, ×tileBytes)
 *   bits 10-12 : palette (sub-palette number; CGRAM base = palette × paletteSize)
 *   bit 13     : priority
 *   bit 14     : horizontal flip
 *   bit 15     : vertical flip
 *
 * Map size is selected per-BG (32×32, 64×32, 32×64, 64×64 tiles), laid out
 * as up to four 32×32 "screens" in VRAM. We default to 32×32 (one screen);
 * the agent passes mapWidth/mapHeight (in tiles) for larger maps.
 *
 * @param {Uint8Array} vram 64 KB
 * @param {Array<{r:number,g:number,b:number}>} cgramColors decodeCGRAM() output
 * @param {object} opts
 * @param {number} [opts.tilemapBaseByte=0]  byte offset into VRAM of the tilemap
 * @param {number} [opts.tileBaseByte=0]     byte offset into VRAM of tile 0
 * @param {2|4|8} [opts.bpp=4]
 * @param {number} [opts.mapWidth=32]        tiles across (32 or 64)
 * @param {number} [opts.mapHeight=32]       tiles down (32 or 64)
 * @returns {{ width:number, height:number, png:Buffer, mapWidth:number, mapHeight:number, bpp:number, note:string }}
 */
export function renderSnesTilemap(vram, cgramColors, opts = {}) {
  const bpp = opts.bpp ?? 4;
  const tileBytes = BPP_TILE_BYTES[bpp];
  if (!tileBytes) throw new Error(`SNES bpp must be 2, 4, or 8 — got ${bpp}`);
  const tilemapBase = opts.tilemapBaseByte ?? 0;
  const tileBase = opts.tileBaseByte ?? 0;
  const mapW = opts.mapWidth ?? 32;
  const mapH = opts.mapHeight ?? 32;
  // Colors per sub-palette: 2bpp=4, 4bpp=16, 8bpp=256.
  const paletteSize = 1 << bpp;
  const W = mapW * 8;
  const H = mapH * 8;
  const png = new PNG({ width: W, height: H });

  // SNES tilemaps over 32 wide/tall are split into 32×32 screens arranged
  // left-to-right then top-to-bottom. Compute the VRAM entry offset for a
  // given (col,row) accounting for that screen layout.
  const screensX = mapW > 32 ? 2 : 1;
  const screenEntries = 32 * 32; // entries per 32×32 screen

  for (let row = 0; row < mapH; row++) {
    for (let col = 0; col < mapW; col++) {
      const scrX = col >> 5;       // which 32-col screen
      const scrY = row >> 5;       // which 32-row screen
      const screenIndex = scrY * screensX + scrX;
      const inX = col & 31;
      const inY = row & 31;
      const entryIndex = screenIndex * screenEntries + inY * 32 + inX;
      const eo = tilemapBase + entryIndex * 2;
      const word = vram[eo] | (vram[eo + 1] << 8);
      const tileIdx = word & 0x3FF;
      const palNum = (word >> 10) & 0x7;
      const hFlip = !!(word & 0x4000);
      const vFlip = !!(word & 0x8000);
      const tileOff = tileBase + tileIdx * tileBytes;
      const tile = decodeSnesTile(vram.subarray(tileOff, tileOff + tileBytes), bpp);
      const palBase = palNum * paletteSize;
      for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 8; x++) {
          const sy = vFlip ? 7 - y : y;
          const sx = hFlip ? 7 - x : x;
          const ci = tile[sy][sx];
          const c = cgramColors[palBase + ci] || { r: 0, g: 0, b: 0 };
          const px = col * 8 + x;
          const py = row * 8 + y;
          const o = (py * W + px) * 4;
          png.data[o + 0] = c.r;
          png.data[o + 1] = c.g;
          png.data[o + 2] = c.b;
          png.data[o + 3] = 0xFF;
        }
      }
    }
  }
  return {
    width: W,
    height: H,
    png: PNG.sync.write(png),
    mapWidth: mapW,
    mapHeight: mapH,
    bpp,
    note: `${mapW}×${mapH}-tile BG map from VRAM byte offset 0x${tilemapBase.toString(16)} ` +
      `(${bpp}bpp tiles at 0x${tileBase.toString(16)}). If tilemapBase/tileBase/bpp/mapSize weren't ` +
      `supplied they default to Mode-1 BG1 — get the live ones from getRenderingContext({platform:'snes'}).layers. ` +
      `Scroll is NOT applied; the visible window is a 256×224 sub-region.`,
  };
}

/**
 * Enumerate the distinct tile indices referenced by a SNES BG tilemap.
 * @param {Uint8Array} vram 64 KB
 * @param {object} opts { tilemapBaseByte=0, mapWidth=32, mapHeight=32 }
 * @returns {{ used:number[], count:number, mapWidth:number, mapHeight:number }}
 */
export function snesTilemapUsage(vram, opts = {}) {
  const tilemapBase = opts.tilemapBaseByte ?? 0;
  const mapW = opts.mapWidth ?? 32;
  const mapH = opts.mapHeight ?? 32;
  const screensX = mapW > 32 ? 2 : 1;
  const screenEntries = 32 * 32;
  const used = new Set();
  for (let row = 0; row < mapH; row++) {
    for (let col = 0; col < mapW; col++) {
      const scrX = col >> 5, scrY = row >> 5;
      const screenIndex = scrY * screensX + scrX;
      const entryIndex = screenIndex * screenEntries + (row & 31) * 32 + (col & 31);
      const eo = tilemapBase + entryIndex * 2;
      used.add((vram[eo] | (vram[eo + 1] << 8)) & 0x3FF);
    }
  }
  const arr = [...used].sort((a, b) => a - b);
  return { used: arr, count: arr.length, mapWidth: mapW, mapHeight: mapH };
}
