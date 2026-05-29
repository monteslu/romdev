// NES PPU decoders.
//
// Reads VIDEO_RAM (pattern tables, name tables) and active palette from
// SYSTEM_RAM or directly from the libretro VIDEO_RAM region, and produces
// PNG images the agent can view through MCP.
//
// The NES PPU has its own 16KB address space, but libretro exposes the
// 8KB CHR ROM/RAM (pattern tables) via RETRO_MEMORY_VIDEO_RAM. fceumm and
// nestopia both follow this convention.
//
// Pattern table layout (8×8 tiles, 2bpp):
//   16 bytes per tile.
//   bytes 0..7  = bit plane 0 (low bit of pixel)
//   bytes 8..15 = bit plane 1 (high bit of pixel)
//   pixel(x, y) = ((byte[y]   >> (7-x)) & 1)
//               | (((byte[y+8] >> (7-x)) & 1) << 1)
//
// Name table layout (32×30 tiles in screen position, then a 64-byte
// attribute table). We render the visible tile grid using the pattern
// table at $0000 and a default palette since we don't know which palette
// each region uses without parsing the attribute table.

import { PNG } from "pngjs";
import { NES_PALETTE } from "./palette.js";

/**
 * Decode a single 8×8 tile from a 16-byte slice into an array of 64 2-bit
 * pixel values (row-major, top-left first).
 * @param {Uint8Array} tile16
 * @returns {Uint8Array} length 64
 */
export function decodeTile(tile16) {
  const out = new Uint8Array(64);
  for (let y = 0; y < 8; y++) {
    const lo = tile16[y];
    const hi = tile16[y + 8];
    for (let x = 0; x < 8; x++) {
      const bit = 7 - x;
      const p = ((lo >> bit) & 1) | (((hi >> bit) & 1) << 1);
      out[y * 8 + x] = p;
    }
  }
  return out;
}

/**
 * Render a 256-tile pattern table (4KB) as a 128×128 PNG (16 tiles per row).
 *
 * @param {Uint8Array} chr4k 4096 bytes of pattern table data
 * @param {[number, number, number][]} [palette] 4 (r,g,b) entries; default
 *   light gray ramp so empty tiles are visible.
 * @returns {Buffer} PNG bytes
 */
export function renderPatternTablePng(chr4k, palette) {
  if (chr4k.length !== 4096) {
    throw new Error(`pattern table must be 4096 bytes, got ${chr4k.length}`);
  }
  const pal = palette ?? [
    [  0,  0,  0],   // 0 = transparent → black
    [ 80, 80, 80],
    [160,160,160],
    [240,240,240],
  ];

  const png = new PNG({ width: 128, height: 128 });
  const dst = png.data;
  for (let t = 0; t < 256; t++) {
    const tile = decodeTile(chr4k.subarray(t * 16, t * 16 + 16));
    const tx = t % 16;
    const ty = Math.floor(t / 16);
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        const p = tile[y * 8 + x];
        const [r, g, b] = pal[p];
        const dx = tx * 8 + x;
        const dy = ty * 8 + y;
        const o = (dy * 128 + dx) * 4;
        dst[o + 0] = r;
        dst[o + 1] = g;
        dst[o + 2] = b;
        dst[o + 3] = 0xff;
      }
    }
  }
  return PNG.sync.write(png);
}

/**
 * Render BOTH 4KB pattern tables side by side as a 256×128 PNG.
 *
 * @param {Uint8Array} chr8k 8192 bytes (both tables)
 * @returns {Buffer}
 */
export function renderBothPatternTablesPng(chr8k) {
  if (chr8k.length !== 8192) {
    throw new Error(`expected 8192 bytes of CHR, got ${chr8k.length}`);
  }
  const left = renderPatternTablePng(chr8k.subarray(0, 4096));
  const right = renderPatternTablePng(chr8k.subarray(4096));
  // Stitch together. Decode + recompose.
  const l = PNG.sync.read(left);
  const r = PNG.sync.read(right);
  const png = new PNG({ width: 256, height: 128 });
  for (let y = 0; y < 128; y++) {
    for (let x = 0; x < 128; x++) {
      const sIdx = (y * 128 + x) * 4;
      const dIdxL = (y * 256 + x) * 4;
      const dIdxR = (y * 256 + (x + 128)) * 4;
      png.data[dIdxL + 0] = l.data[sIdx + 0];
      png.data[dIdxL + 1] = l.data[sIdx + 1];
      png.data[dIdxL + 2] = l.data[sIdx + 2];
      png.data[dIdxL + 3] = l.data[sIdx + 3];
      png.data[dIdxR + 0] = r.data[sIdx + 0];
      png.data[dIdxR + 1] = r.data[sIdx + 1];
      png.data[dIdxR + 2] = r.data[sIdx + 2];
      png.data[dIdxR + 3] = r.data[sIdx + 3];
    }
  }
  return PNG.sync.write(png);
}

/**
 * Convert a NES palette entry (0..63) to the RGB triple. Convenience wrapper.
 * @param {number} idx
 * @returns {[number, number, number]}
 */
export function nesPaletteIndexToRgb(idx) {
  return NES_PALETTE[idx & 0x3f];
}

/**
 * Normalize the active NES palette into the generic shape used by
 * inspectPalette across every platform: `{index, r, g, b, rawWord}[]`.
 * On NES, rawWord is the 6-bit palette ROM index (0..63).
 * @param {Uint8Array} palette32
 * @returns {Array<{ index: number, r: number, g: number, b: number, rawWord: number }>}
 */
export function paletteToGenericColors(palette32) {
  const out = [];
  for (let i = 0; i < 32; i++) {
    const idx = palette32[i] & 0x3F;
    const [r, g, b] = NES_PALETTE[idx];
    out.push({ index: i, r, g, b, rawWord: idx });
  }
  return out;
}

/**
 * Render a NES background nametable into a real 256×240 PNG by compositing:
 *   - the 32×30 tile indices from the nametable
 *   - the active 4 BG palettes from the palette region
 *   - the active background CHR pattern table
 *   - the 64-byte attribute table at the end of the nametable
 *
 * @param {Object} args
 * @param {Uint8Array} args.nametable   1024 bytes (32×30 tiles + 64 attr bytes + 64 byte tile padding)
 * @param {Uint8Array} args.chr         4096 bytes — a single CHR pattern table
 * @param {Uint8Array} args.palette     32 bytes from $3F00-$3F1F
 * @returns {Buffer} PNG bytes
 */
export function renderNametablePng(args) {
  const { nametable, chr, palette } = args;
  if (nametable.length < 1024) throw new Error(`nametable must be ≥1024 bytes, got ${nametable.length}`);
  if (chr.length < 4096) throw new Error(`chr must be ≥4096 bytes, got ${chr.length}`);
  if (palette.length < 32) throw new Error(`palette must be ≥32 bytes, got ${palette.length}`);

  const png = new PNG({ width: 256, height: 240 });
  const dst = png.data;
  // Attribute table starts at +960 (32*30 = 960 tile indices), 64 bytes
  // covering 8×8 attribute cells (each cell = 4×4 tiles = 32×32 px).
  const attrBase = 960;

  for (let tileY = 0; tileY < 30; tileY++) {
    for (let tileX = 0; tileX < 32; tileX++) {
      const tileIdx = nametable[tileY * 32 + tileX];

      // Determine which BG palette this tile uses via the attribute table.
      const attrX = tileX >> 2;
      const attrY = tileY >> 2;
      const attrByte = nametable[attrBase + attrY * 8 + attrX];
      // Each 32x32 region splits into 4 16x16 quadrants. Which one are we in?
      const quadX = (tileX & 2) >> 1;
      const quadY = (tileY & 2) >> 1;
      const shift = (quadY * 2 + quadX) * 2;
      const palIdx = (attrByte >> shift) & 0x3;
      // BG palette base: $3F00 + palIdx * 4
      const palBase = palIdx * 4;
      const colors = [
        palette[0],            // universal background
        palette[palBase + 1],
        palette[palBase + 2],
        palette[palBase + 3],
      ];

      // Decode the tile bitplanes.
      for (let py = 0; py < 8; py++) {
        const lo = chr[tileIdx * 16 + py];
        const hi = chr[tileIdx * 16 + py + 8];
        for (let px = 0; px < 8; px++) {
          const bit = 7 - px;
          const p = ((lo >> bit) & 1) | (((hi >> bit) & 1) << 1);
          const palByte = colors[p];
          const [r, g, b] = NES_PALETTE[palByte & 0x3f];
          const sx = tileX * 8 + px;
          const sy = tileY * 8 + py;
          const o = (sy * 256 + sx) * 4;
          dst[o + 0] = r;
          dst[o + 1] = g;
          dst[o + 2] = b;
          dst[o + 3] = 0xff;
        }
      }
    }
  }
  return PNG.sync.write(png);
}

/**
 * Convenience: snapshot the active background from a loaded NES host.
 * Reads nametable, palette, and CHR via the patched fceumm memory regions
 * and composites them into a single PNG.
 *
 * @param {import("../../host/index.js").LibretroHost} host
 * @param {Object} [opts]
 * @param {0 | 1} [opts.which] which 1KB nametable (0 = $2000, 1 = $2400). Default 0.
 * @returns {Buffer}
 */
export function snapshotNametable(host, opts = {}) {
  const which = opts.which ?? 0;
  const nt = host.readMemory("nes_nametables", which * 1024, 1024);
  const palette = host.readMemory("nes_palette", 0, 32);
  const chr = host.readMemory("nes_chr", 0, 4096); // BG pattern table is at 0x0000
  return renderNametablePng({ nametable: nt, chr, palette });
}

/**
 * Render a 32-byte palette block (the NES has 32 palette entries total,
 * 16 BG + 16 sprite) as a 16×2 grid of swatches at 16px each → 256×32 PNG.
 *
 * @param {Uint8Array} palette32 32 bytes from $3F00–$3F1F
 * @returns {Buffer}
 */
export function renderPalettePng(palette32) {
  if (palette32.length !== 32) {
    throw new Error(`expected 32 bytes of palette, got ${palette32.length}`);
  }
  const SW = 16;
  const png = new PNG({ width: 16 * SW, height: 2 * SW });
  for (let i = 0; i < 32; i++) {
    const col = i % 16;
    const row = Math.floor(i / 16);
    const [r, g, b] = NES_PALETTE[palette32[i] & 0x3f];
    for (let y = 0; y < SW; y++) {
      for (let x = 0; x < SW; x++) {
        const dx = col * SW + x;
        const dy = row * SW + y;
        const o = (dy * 16 * SW + dx) * 4;
        png.data[o + 0] = r;
        png.data[o + 1] = g;
        png.data[o + 2] = b;
        png.data[o + 3] = 0xff;
      }
    }
  }
  return PNG.sync.write(png);
}

/**
 * Read the pattern tables from a loaded NES host and return a PNG of all
 * 512 tiles laid out as 32 columns × 16 rows of 8×8 tiles → 256×128 image.
 *
 * Preferred path: our patched fceumm exposes CHR via memory region
 * `nes_chr` (gathered from VPage[0..7]). That works for both CHR-ROM and
 * CHR-RAM carts and reflects the *current* state of pattern tables (some
 * games rewrite CHR-RAM mid-frame). Fallback path: parse the iNES file
 * on disk for carts where the memory region isn't available.
 *
 * @param {import("../../host/index.js").LibretroHost} host
 * @returns {Promise<{ width: number, height: number, png: Buffer, source: "live"|"ines" }>}
 */
export async function snapshotPatternTables(host) {
  // Read iNES header first to make the CHR-ROM vs CHR-RAM decision deterministic
  // (rather than guessing from all-zero live reads). iNES byte 5 = chrBanks:
  //   > 0  → CHR-ROM cart, baked-in tiles never change at runtime → use file.
  //   = 0  → CHR-RAM cart, tiles are written by the game at runtime → use live.
  // Agent feedback (2026-05-23): the all-zero heuristic mis-classified a real
  // CHR-ROM cart as CHR-RAM when the live read happened to return zeros before
  // the core fully loaded. Reading byte 5 is unambiguous.
  const { readFile } = await import("node:fs/promises");
  const status = host.getStatus();
  let inesBytes = null;
  if (status.mediaPath) {
    try {
      inesBytes = await readFile(status.mediaPath);
    } catch {
      // mediaPath may have been a virtual path (loadMediaBytes); fall through.
    }
  }
  const chrBanks = inesBytes && inesBytes.length >= 6 &&
    inesBytes[0] === 0x4e && inesBytes[1] === 0x45 && inesBytes[2] === 0x53 && inesBytes[3] === 0x1a
    ? inesBytes[5]
    : null;

  // CHR-ROM cart: the on-disk CHR is authoritative (it never changes).
  if (chrBanks !== null && chrBanks > 0 && inesBytes) {
    const ines = chrFromINes(inesBytes);
    return { ...ines, source: "ines" };
  }

  // CHR-RAM cart OR header unavailable (e.g. loaded via bytes): use live region.
  try {
    const chr = host.readMemory("nes_chr", 0, 8192);
    return {
      width: 256,
      height: 128,
      png: renderBothPatternTablesPng(chr),
      source: "live",
      hasChr: chrBanks === 0
        ? null  // CHR-RAM: "hasChr" doesn't really apply; live data is what game wrote
        : true,
    };
  } catch {
    // Region not exposed by this core (rare; needs the romdev fceumm patch).
  }

  // Last resort: nothing we can show.
  throw new Error(
    "inspectPatternTiles: could not read CHR. " +
    (status.mediaPath
      ? "ROM at " + status.mediaPath + " has no valid iNES header and the core didn't expose nes_chr."
      : "No ROM loaded — call loadMedia or loadMediaBytes first.")
  );
}

/**
 * Decode the CHR bank from an iNES file and render both pattern tables.
 *
 * iNES layout:
 *   bytes 0..15  header (PRG bank count at byte 4, CHR bank count at byte 5)
 *   bytes 16..   PRG ROM (prgBanks * 16384 bytes)
 *   then         CHR ROM (chrBanks * 8192 bytes)
 *
 * Returns a 256×128 PNG of both 4KB tables side by side. If the cart has
 * no CHR ROM (CHR-RAM only — chrBanks=0), returns a blank image since
 * the runtime CHR-RAM isn't accessible to us.
 *
 * @param {Uint8Array} ines full iNES file bytes
 * @returns {{ width: number, height: number, png: Buffer, hasChr: boolean }}
 */
export function chrFromINes(ines) {
  if (ines.length < 16 || ines[0] !== 0x4e || ines[1] !== 0x45 || ines[2] !== 0x53 || ines[3] !== 0x1a) {
    throw new Error("not a valid iNES file");
  }
  const prgBanks = ines[4];
  const chrBanks = ines[5];
  const chrOffset = 16 + prgBanks * 16384;
  if (chrBanks === 0) {
    // No CHR ROM (CHR-RAM cart). Return a placeholder 256×128 blank image.
    const blank = renderBothPatternTablesPng(new Uint8Array(8192));
    return { width: 256, height: 128, png: blank, hasChr: false };
  }
  const chr = ines.subarray(chrOffset, chrOffset + 8192);
  if (chr.length !== 8192) {
    throw new Error(`expected 8192 bytes of CHR at offset ${chrOffset}, got ${chr.length}`);
  }
  return {
    width: 256,
    height: 128,
    png: renderBothPatternTablesPng(new Uint8Array(chr)),
    hasChr: true,
  };
}
