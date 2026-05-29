// Genesis VDP helpers — decode SAT, CRAM, and 4bpp tile bytes.
//
// Mirrors the shape of src/platforms/nes/ppu.js, src/platforms/gb/ppu.js,
// and src/platforms/snes/ppu.js. Used by the rom-dev-mcp debug tools
// (inspectSprites, getPalette, etc.) for the Genesis platform.
//
// Memory regions exposed by the gpgx libretro patch (see memory.js):
//   genesis_cram  — 128 B, 64 colors × uint16 big-endian, 9-bit BGR
//   genesis_vsram — 128 B, per-cell vertical scroll
//   genesis_vdp_regs — 32 bytes (VDP registers $00-$1F)
//
// SAT lives inside VRAM at an address chosen by VDP reg $05 (default
// $D800 in SGDK's setup). The SAT entry size is 8 bytes:
//
//   word 0 (Y):     uuuuuu YYYYYYYYYY (10-bit Y, offset by 128)
//   byte 2 (size):  ----wwhh          (2-bit width, 2-bit height, in tiles)
//   byte 3 (link):  -LLLLLLL          (7-bit next-sprite index, 0 = end)
//   word 4 (attr):  pV HFppCCCCCCCCCC (priority, V/H flip, palette, tile)
//   word 6 (X):     uuuuuu XXXXXXXXXX (10-bit X, offset by 128)
//
// Where:
//   priority = bit 15 of the attr word
//   V flip   = bit 12, H flip = bit 11
//   palette  = bits 13-14 (0..3)
//   tile     = bits 0-10 (0..2047)

import { PNG } from "pngjs";

/**
 * Decode the Genesis SAT into the generic sprite shape used by
 * inspectSprites. The SAT is a 640-byte (80 entries) blob lifted from
 * VRAM at the address held by VDP register $05.
 *
 * Y/X positions are offset by 128 on hardware (so X=128 is the left
 * edge of the visible screen). We translate to screen-coordinates
 * for the caller's convenience: visible = (x >= 128 && y >= 128).
 *
 * @param {Uint8Array} sat 640 bytes (80 sprites × 8 bytes)
 * @returns {Array<{
 *   slot: number, x: number, y: number, tile: number, palette: number,
 *   priority: number, flipH: boolean, flipV: boolean, link: number,
 *   size: { w: number, h: number }, visible: boolean,
 *   raw: { y: number, size: number, link: number, attr: number, x: number }
 * }>}
 */
export function decodeSAT(sat) {
  const sprites = [];
  for (let i = 0; i < 80; i++) {
    const off = i * 8;
    const rawY = (sat[off] << 8) | sat[off + 1];
    const sizeByte = sat[off + 2];
    const link = sat[off + 3] & 0x7F;
    const attr = (sat[off + 4] << 8) | sat[off + 5];
    const rawX = (sat[off + 6] << 8) | sat[off + 7];
    const y = (rawY & 0x3FF) - 128;
    const x = (rawX & 0x3FF) - 128;
    const widthTiles = ((sizeByte >> 2) & 0x3) + 1; // 1..4
    const heightTiles = (sizeByte & 0x3) + 1; // 1..4
    sprites.push({
      slot: i,
      x,
      y,
      tile: attr & 0x07FF,
      palette: (attr >> 13) & 0x3,
      priority: (attr >> 15) & 0x1,
      flipH: !!(attr & 0x0800),
      flipV: !!(attr & 0x1000),
      link,
      size: { w: widthTiles * 8, h: heightTiles * 8 },
      visible: y > -32 && y < 224 && x > -32 && x < 320,
      raw: {
        y: rawY,
        size: sizeByte,
        link: sat[off + 3],
        attr,
        x: rawX,
      },
    });
  }
  return sprites;
}

/**
 * Decode CRAM (128 bytes = 64 colors × uint16 big-endian) into
 * 64 RGB triples (each 0..255).
 *
 * Genesis colour word is BGR-aligned in 4-bit nibbles, but the
 * actual values are 3-bit (top bit of each nibble is unused):
 *   0BGR  where each letter is a 3-bit channel (values 0..7)
 *
 * We expand to 0..255 by multiplying the 3-bit value by 36
 * (≈ 255/7).
 *
 * @param {Uint8Array} cram 128 bytes
 * @returns {Array<[number, number, number]>} 64 RGB triples
 */
export function decodeCRAM(cram) {
  const colors = [];
  const n = Math.floor(cram.length / 2);
  for (let i = 0; i < n; i++) {
    const w = (cram[i * 2] << 8) | cram[i * 2 + 1];
    const r = (w >> 1) & 0x7;
    const g = (w >> 5) & 0x7;
    const b = (w >> 9) & 0x7;
    colors.push([
      Math.round((r / 7) * 255),
      Math.round((g / 7) * 255),
      Math.round((b / 7) * 255),
    ]);
  }
  return colors;
}

/**
 * Decode a 4bpp Genesis tile (32 bytes) into an 8×8 array of palette
 * indices (0..15). Each byte contains two pixels: high nibble = left
 * pixel, low nibble = right pixel. Rows are packed top-to-bottom.
 *
 * @param {Uint8Array} tileBytes 32 bytes
 * @returns {number[][]} 8 rows × 8 columns of palette indices
 */
export function decode4bppTile(tileBytes) {
  if (tileBytes.length !== 32) {
    throw new Error(`Genesis tile must be exactly 32 bytes, got ${tileBytes.length}`);
  }
  const rows = [];
  for (let y = 0; y < 8; y++) {
    const row = [];
    for (let x = 0; x < 4; x++) {
      const b = tileBytes[y * 4 + x];
      row.push((b >> 4) & 0xF, b & 0xF);
    }
    rows.push(row);
  }
  return rows;
}

/**
 * Validate generated Genesis tile + palette data against the VDP's hard
 * constraints. Catches the "builds fine, renders garbage" generated-asset
 * bug: a 4bpp tile pixel is a 4-bit palette index (0..15), and a Genesis
 * palette LINE is exactly 16 colors. If a generator computed a 17th color
 * or packed a value > 0xF, the tile bytes still assemble (they're just
 * bytes) but decode wrong on hardware.
 *
 * @param {object} args
 * @param {Uint8Array} [args.tileData] raw 4bpp tile bytes (multiple of 32).
 * @param {number} [args.maxPaletteIndex] highest palette index the art is
 *   allowed to use (default 15 = a full 16-color line). Pass e.g. 14 if
 *   you reserve index 15.
 * @param {Array<Array|string>} [args.palette] palette as lines: an array of
 *   lines, each an array of colors (any form). Flags lines with >16 colors.
 * @returns {{ ok:boolean, errors:string[], warnings:string[], stats:object }}
 */
export function validateGenesisTiles(args = {}) {
  const errors = [];
  const warnings = [];
  const maxIdx = args.maxPaletteIndex ?? 15;
  const stats = {};

  if (args.tileData) {
    const td = args.tileData;
    if (td.length % 32 !== 0) {
      errors.push(`tileData length ${td.length} is not a multiple of 32 (each 4bpp tile is exactly 32 bytes). The last ${td.length % 32} bytes are a partial tile — a sign the generator's stride is wrong.`);
    }
    const tileCount = Math.floor(td.length / 32);
    let highestIndex = 0;
    const tilesOverMax = [];
    // Every nibble in a byte IS already 0..15 (it's 4 bits), so "nibble > 0xF"
    // can't physically occur in a byte. The real, catchable error is a pixel
    // index ABOVE the palette the art is supposed to use — i.e. the generator
    // emitted color #16+ which on a 16-color line wraps/garbles. We flag the
    // highest index used and any tile that exceeds maxPaletteIndex.
    for (let t = 0; t < tileCount; t++) {
      let tileMax = 0;
      for (let i = 0; i < 32; i++) {
        const b = td[t * 32 + i];
        const hi = (b >> 4) & 0xF, lo = b & 0xF;
        if (hi > tileMax) tileMax = hi;
        if (lo > tileMax) tileMax = lo;
      }
      if (tileMax > highestIndex) highestIndex = tileMax;
      if (tileMax > maxIdx) tilesOverMax.push({ tile: t, maxIndex: tileMax });
    }
    stats.tileCount = tileCount;
    stats.highestPaletteIndexUsed = highestIndex;
    if (tilesOverMax.length) {
      errors.push(
        `${tilesOverMax.length} tile(s) use a palette index above ${maxIdx} ` +
        `(highest seen: ${highestIndex}). A Genesis 4bpp line has only 16 colors ` +
        `(indices 0-15). This is the classic '17th color leaked into the tile ` +
        `words' bug — the art will render with wrong/garbled colors. First few: ` +
        tilesOverMax.slice(0, 5).map((x) => `tile ${x.tile} (idx ${x.maxIndex})`).join(", ") + "."
      );
    }
  }

  if (args.palette) {
    const lines = Array.isArray(args.palette[0]) || typeof args.palette[0] === "object"
      ? args.palette
      : [args.palette]; // single flat line
    lines.forEach((line, i) => {
      const n = Array.isArray(line) ? line.length : Object.keys(line).length;
      if (n > 16) {
        errors.push(`palette line ${i} has ${n} colors — a Genesis palette line holds exactly 16. Colors beyond index 15 can't be represented; split across multiple lines or reduce to 16.`);
      } else if (n === 16) {
        warnings.push(`palette line ${i} uses all 16 slots (index 0 is the transparent/backdrop color for sprites — make sure that's intended).`);
      }
    });
    stats.paletteLines = lines.length;
  }

  if (!args.tileData && !args.palette) {
    warnings.push("nothing to validate — pass tileData and/or palette.");
  }

  return { ok: errors.length === 0, errors, warnings, stats };
}

/**
 * Decode a sub-palette (16 colors) out of the full 64-color CRAM.
 * Palette index 0..3 → CRAM offset palette * 32 bytes.
 *
 * @param {Uint8Array} cram 128 bytes
 * @param {number} paletteIndex 0..3
 * @returns {Array<[number, number, number]>} 16 RGB triples
 */
export function decodeGenesisSubpalette(cram, paletteIndex) {
  if (paletteIndex < 0 || paletteIndex > 3) {
    throw new Error(`Genesis palette index must be 0..3, got ${paletteIndex}`);
  }
  const off = paletteIndex * 32;
  return decodeCRAM(cram.subarray(off, off + 32));
}

/**
 * Convert a [r,g,b] 0..255 triple to the Genesis 16-bit colour word
 * (3-bit channels quantised, BGR order, 4-bit nibble alignment).
 *
 * @param {number} r 0..255
 * @param {number} g 0..255
 * @param {number} b 0..255
 * @returns {number} 16-bit colour word
 */
export function rgbToGenesisColor(r, g, b) {
  const rq = Math.round((r / 255) * 7) & 0x7;
  const gq = Math.round((g / 255) * 7) & 0x7;
  const bq = Math.round((b / 255) * 7) & 0x7;
  return (bq << 9) | (gq << 5) | (rq << 1);
}

/**
 * Decode the 32 VDP registers (genesis_vdp_regs) into a human-readable
 * object. These are the gpgx mirror of the VDP's internal write-only
 * registers (snapshotted at save-state time).
 *
 * Only the most useful fields are surfaced; full register reference
 * lives in the Sega VDP manual.
 *
 * @param {Uint8Array} regs 32 bytes
 * @returns {{
 *   displayEnabled: boolean,
 *   vblankInt: boolean, hblankInt: boolean, extInt: boolean,
 *   mode5: boolean, mode4: boolean,
 *   nameTableA: number, nameTableB: number, nameTableW: number,
 *   spriteTable: number, hScrollTable: number,
 *   bgColor: { palette: number, index: number },
 *   hMode: 'H32' | 'H40',
 *   vMode: 'V28' | 'V30',
 * }}
 */
export function decodeVDPRegs(regs) {
  return {
    // Mode register #1 ($00)
    hblankInt:        !!(regs[0x00] & 0x10),
    // Mode register #2 ($01)
    displayEnabled:   !!(regs[0x01] & 0x40),
    vblankInt:        !!(regs[0x01] & 0x20),
    mode5:            !!(regs[0x01] & 0x04),
    // Mode register #3 ($0B)
    extInt:           !!(regs[0x0B] & 0x08),
    mode4:            !(regs[0x01] & 0x04),
    // Plane base addresses ($02 = A, $04 = B, $03 = W)
    nameTableA:       (regs[0x02] & 0x38) << 10,
    nameTableB:       (regs[0x04] & 0x07) << 13,
    nameTableW:       (regs[0x03] & 0x3E) << 10,
    // SAT base ($05)
    spriteTable:      (regs[0x05] & 0x7E) << 9,
    // HScroll table ($0D)
    hScrollTable:     (regs[0x0D] & 0x3F) << 10,
    // Backdrop ($07)
    bgColor: {
      palette: (regs[0x07] >> 4) & 0x3,
      index:   regs[0x07] & 0xF,
    },
    // Mode register #4 ($0C)
    hMode:            (regs[0x0C] & 0x81) ? 'H40' : 'H32',
    vMode:            (regs[0x01] & 0x08) ? 'V30' : 'V28',
    // Plane size ($10): bits 0-1 = horizontal cells, bits 4-5 = vertical.
    // 0b00=32, 0b01=64, 0b11=128 cells. (0b10 is invalid → treat as 64.)
    planeSize:        decodePlaneSize(regs[0x10]),
  };
}

const PLANE_CELLS = { 0: 32, 1: 64, 2: 64, 3: 128 };

/**
 * Decode VDP reg $10 (plane size) into {wCells, hCells}.
 * @param {number} reg10
 * @returns {{ wCells: number, hCells: number }}
 */
export function decodePlaneSize(reg10) {
  const w = PLANE_CELLS[reg10 & 0x3] ?? 64;
  const h = PLANE_CELLS[(reg10 >> 4) & 0x3] ?? 64;
  return { wCells: w, hCells: h };
}

/**
 * Render a sheet of Genesis VRAM tiles to a PNG, 16 across.
 *
 * Genesis tiles are 4bpp (32 bytes each), indexed 0..2047 in VRAM. We
 * colorize with a chosen 16-color CRAM sub-palette (0..3).
 *
 * @param {object} host LibretroHost
 * @param {object} opts
 * @param {number} [opts.paletteIndex=0]  CRAM sub-palette 0..3
 * @param {number} [opts.tileCount]       how many tiles (default fills VRAM)
 * @param {number} [opts.cols=16]
 * @returns {{ width:number, height:number, png:Buffer, tileCount:number, paletteIndex:number, note:string }}
 */
export function snapshotPatternTiles(host, opts = {}) {
  const paletteIndex = Math.max(0, Math.min(3, opts.paletteIndex ?? 0));
  const cols = opts.cols ?? 16;
  const vram = host.readMemory("video_ram", 0, 0x10000);
  const cram = host.readMemory("genesis_cram", 0, 128);
  const pal = decodeGenesisSubpalette(cram, paletteIndex);
  const maxTiles = Math.floor(vram.length / 32);
  const tileCount = Math.min(opts.tileCount ?? maxTiles, maxTiles);
  const rowsOfTiles = Math.ceil(tileCount / cols);
  const W = cols * 8;
  const H = rowsOfTiles * 8;
  const png = new PNG({ width: W, height: H });

  for (let t = 0; t < tileCount; t++) {
    const tile = decode4bppTile(vram.subarray(t * 32, t * 32 + 32));
    const tx = (t % cols) * 8;
    const ty = Math.floor(t / cols) * 8;
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        const ci = tile[y][x];
        const [r, g, b] = pal[ci] || [0, 0, 0];
        const o = ((ty + y) * W + (tx + x)) * 4;
        png.data[o + 0] = r;
        png.data[o + 1] = g;
        png.data[o + 2] = b;
        png.data[o + 3] = 0xFF;
      }
    }
  }
  return {
    width: W,
    height: H,
    png: PNG.sync.write(png),
    tileCount,
    paletteIndex,
    note: `${tileCount} 4bpp tiles from VRAM (colorized with CRAM sub-palette ${paletteIndex}). ` +
      `Tile N = VRAM byte offset N×32. Genesis VRAM holds tiles + name tables + SAT + HScroll, ` +
      `so high tile indices may be non-tile data rendered as noise.`,
  };
}

/**
 * Render a Genesis scroll plane (A or B) tilemap to a PNG composite.
 *
 * The plane is a grid of `wCells × hCells` name-table entries living in
 * VRAM at the plane's base address (VDP reg $02 for A, $04 for B). Each
 * entry is a 16-bit big-endian word:
 *   bit 15    = priority
 *   bits 14-13 = palette (0..3)
 *   bit 12    = vertical flip
 *   bit 11    = horizontal flip
 *   bits 10-0 = tile index into VRAM (×32 bytes per tile)
 *
 * Like the GB BG-map snapshot, this renders the WHOLE plane — scroll is
 * NOT applied (the visible 320×224 / 256×224 window is a sub-region).
 *
 * @param {object} host  LibretroHost
 * @param {object} opts
 * @param {'A'|'B'} [opts.plane='A']
 * @returns {{ width:number, height:number, png:Buffer, plane:string,
 *             baseAddr:number, wCells:number, hCells:number, note:string }}
 */
export function snapshotPlaneMap(host, opts = {}) {
  const plane = (opts.plane || "A").toUpperCase() === "B" ? "B" : "A";
  const regs = host.readMemory("genesis_vdp_regs", 0, 32);
  const cram = host.readMemory("genesis_cram", 0, 128);
  const decoded = decodeVDPRegs(regs);
  const base = plane === "B" ? decoded.nameTableB : decoded.nameTableA;
  const { wCells, hCells } = decoded.planeSize;

  // Read all 64 KB of VRAM (exposed as the generic "video_ram" region
  // for genesis). Reading it whole is cheap and avoids per-tile bounds
  // math against the name-table + tile-data addresses.
  const vram = host.readMemory("video_ram", 0, 0x10000);

  // Pre-decode all four sub-palettes to RGB.
  const palettes = [0, 1, 2, 3].map((pi) => decodeGenesisSubpalette(cram, pi));

  const W = wCells * 8;
  const H = hCells * 8;
  const png = new PNG({ width: W, height: H });

  for (let cy = 0; cy < hCells; cy++) {
    for (let cx = 0; cx < wCells; cx++) {
      const entryOff = base + (cy * wCells + cx) * 2;
      const word = (vram[entryOff] << 8) | vram[entryOff + 1];
      const tileIdx = word & 0x7FF;
      const hFlip = !!(word & 0x800);
      const vFlip = !!(word & 0x1000);
      const palIdx = (word >> 13) & 0x3;
      const tileOff = tileIdx * 32;
      const tile = decode4bppTile(vram.subarray(tileOff, tileOff + 32));
      const pal = palettes[palIdx];
      for (let ty = 0; ty < 8; ty++) {
        for (let tx = 0; tx < 8; tx++) {
          const sy = vFlip ? 7 - ty : ty;
          const sx = hFlip ? 7 - tx : tx;
          const ci = tile[sy][sx];
          const [r, g, b] = pal[ci] || [0, 0, 0];
          const px = cx * 8 + tx;
          const py = cy * 8 + ty;
          const o = (py * W + px) * 4;
          png.data[o + 0] = r;
          png.data[o + 1] = g;
          png.data[o + 2] = b;
          // Color index 0 is transparent on hardware; render it opaque
          // here so the composite is viewable (you're inspecting the
          // raw map, not compositing over a backdrop).
          png.data[o + 3] = 0xFF;
        }
      }
    }
  }

  return {
    width: W,
    height: H,
    png: PNG.sync.write(png),
    plane,
    baseAddr: "$" + base.toString(16).toUpperCase().padStart(4, "0"),
    wCells,
    hCells,
    note: `Plane ${plane} (${wCells}×${hCells} cells = ${W}×${H}px). Scroll NOT applied — the on-screen window is a sub-region. hMode=${decoded.hMode}, displayEnabled=${decoded.displayEnabled}.`,
  };
}

/**
 * Enumerate distinct tile indices referenced by Plane A, Plane B, and the
 * sprite attribute table at the current VDP state.
 *
 * @param {object} host LibretroHost
 * @returns {{ planeA:number[], planeB:number[], sprites:number[] }}
 */
export function genesisTileUsage(host) {
  const regs = host.readMemory("genesis_vdp_regs", 0, 32);
  const vram = host.readMemory("video_ram", 0, 0x10000);
  const decoded = decodeVDPRegs(regs);
  const { wCells, hCells } = decoded.planeSize;

  const planeIndices = (base) => {
    const used = new Set();
    for (let i = 0; i < wCells * hCells; i++) {
      const o = base + i * 2;
      used.add(((vram[o] << 8) | vram[o + 1]) & 0x7FF);
    }
    return [...used].sort((a, b) => a - b);
  };

  // Sprites: SAT is 80 entries × 8 bytes at spriteTable; attr word at +4,
  // low 11 bits = tile. We walk the linked list via the `link` field, but
  // a flat scan of all 80 entries is simpler and safe here.
  const satBase = decoded.spriteTable;
  const sat = vram.subarray(satBase, satBase + 640);
  const sprites = new Set();
  for (let i = 0; i < 80; i++) {
    const attr = (sat[i * 8 + 4] << 8) | sat[i * 8 + 5];
    sprites.add(attr & 0x07FF);
  }

  return {
    planeA: planeIndices(decoded.nameTableA),
    planeB: planeIndices(decoded.nameTableB),
    sprites: [...sprites].sort((a, b) => a - b),
  };
}
