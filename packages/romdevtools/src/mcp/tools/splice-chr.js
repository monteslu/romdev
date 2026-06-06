// spliceCHR — png → platform-native tile bytes → splice into CHR file at a
// tile index. Composition of convertImageToTiles (existing) + patchFile (#73).
//
// Most common ROM-hack workflow for sprite/tile edits: open the CHR data in
// some pixel editor, save as PNG, drop into the ROM at the right tile slot.
// Currently this is 3+ MCP calls (read CHR bank, convertImageToTiles, patch).
// One call does the whole thing with a sidecar `expect` check on the tiles
// being overwritten.

import { readFile } from "node:fs/promises";

/**
 * Tile size in bytes per platform.
 *   NES, GB, GBC: 16 bytes/tile (2bpp, 8x8)
 */
function tileSizeForPlatform(platform) {
  switch (platform) {
    case "nes":
    case "gb":
    case "gbc": return 16;       // 2bpp × 8 rows
    case "c64": return 8;        // 1bpp charset, 8 rows × 1 byte
    case "sms":
    case "gg":
    case "snes":
    case "genesis":
    case "megadrive":
    case "md":
    case "gba": return 32;       // 4bpp × 8 rows
    case "atari2600":
    case "a2600":
    case "atari7800":
    case "a7800":
      throw new Error(
        `spliceCHR: ${platform} doesn't have a fixed CHR tile size. Sprites/playfield are ` +
        `1-bit bitmap bytes on 2600; 7800 graphics depend on per-display-list bit depth.`
      );
    default:
      throw new Error(`spliceCHR: tile size unknown for platform '${platform}'`);
  }
}

/**
 * Resolve the file-offset where the CHR region starts for a path. For NES
 * iNES files this is 16 + prgBanks*16384. Otherwise the caller must pass
 * `chrFileOffset` explicitly.
 */
async function resolveChrBase(path, platform, explicitOffset) {
  if (explicitOffset != null) return { fileOffset: explicitOffset, note: "explicit chrFileOffset" };
  if (platform === "nes") {
    const data = new Uint8Array(await readFile(path));
    if (data[0] !== 0x4e || data[1] !== 0x45 || data[2] !== 0x53 || data[3] !== 0x1a) {
      throw new Error(`spliceCHR: '${path}' is not a valid iNES ROM. Pass chrFileOffset explicitly.`);
    }
    const prgSize = data[4] * 16384;
    const off = 16 + prgSize;
    const chrSize = data[5] * 8192;
    if (chrSize === 0) {
      throw new Error(`spliceCHR: iNES ROM '${path}' has CHR-RAM (no CHR-ROM in the file). Use build({output:'rom'}) to generate CHR via your asm source.`);
    }
    return { fileOffset: off, chrSize, note: `iNES CHR-ROM bank @ file offset ${off}, ${chrSize} bytes` };
  }
  if (platform === "gb" || platform === "gbc") {
    throw new Error(`spliceCHR: Game Boy tiles are in PRG ROM at arbitrary offsets — pass chrFileOffset explicitly (no auto-detect for GB).`);
  }
  if (platform === "sms" || platform === "gg") {
    throw new Error(
      `spliceCHR: SMS/GG tiles are uploaded to VRAM at runtime from arbitrary ROM ` +
      `offsets — no auto-detect. Pass chrFileOffset explicitly. Typical approach: ` +
      `disassembleRom near the VDP $BE writes to find where the game loads tiles ` +
      `from in ROM, then point chrFileOffset there.`
    );
  }
  if (platform === "snes" || platform === "genesis" || platform === "megadrive" || platform === "md") {
    throw new Error(
      `spliceCHR[${platform}]: tile data lives at arbitrary ROM offsets (game-specific). ` +
      `Pass chrFileOffset explicitly. For SNES use disassembleRom + grep for DMA writes ` +
      `to VRAM; for Genesis grep for VDP_DATA ($C00000) writes.`
    );
  }
  if (platform === "c64") {
    throw new Error(
      `spliceCHR[c64]: C64 charset data lives at an arbitrary offset in your PRG ` +
      `(wherever you placed the 8-byte-per-char bitmap table). Pass chrFileOffset ` +
      `explicitly — it's the byte offset of char 0 in the file. Each char is 8 bytes ` +
      `(1bpp, bit set = foreground).`
    );
  }
  if (platform === "atari2600" || platform === "a2600") {
    throw new Error(
      `spliceCHR[2600]: the 2600 has no tile ROM region — graphics are 1-bit ` +
      `sprite bytes written by code to GRP0/GRP1/PF0/PF1/PF2/ENABL each scanline. ` +
      `There's nothing to splice generically. Use patchFile on specific ROM ` +
      `bytes (find them via disassembleRom + lda/sta GRP/PF refs).`
    );
  }
  if (platform === "atari7800" || platform === "a7800") {
    throw new Error(
      `spliceCHR[7800]: the 7800 reads tile/sprite graphics from MARIA display ` +
      `lists at runtime — they live at arbitrary ROM offsets per game. Pass ` +
      `chrFileOffset explicitly after finding the chargen base via ` +
      `disassembleRom (look for the CHARBASE register write at $87).`
    );
  }
  throw new Error(`spliceCHR: platform '${platform}' not yet supported. Pass chrFileOffset explicitly to splice raw tile bytes.`);
}

export async function spliceChrCore({
  path, outputPath, platform, pngBase64, tileIndex,
  chrFileOffset, bank, paletteHint, expect, allowExpand,
}) {
  const { imageToTiles } = await import("../../platforms/common/image-to-tiles.js");
  const png = Buffer.from(pngBase64, "base64");
  const hint = paletteHint ? paletteHint.map(parseRgb) : undefined;
  const conv = imageToTiles(platform, png, { maxTiles: 8192, paletteHint: hint });
  const tileBytes = conv.tiles;

  const tileSize = tileSizeForPlatform(platform);
  // Resolve CHR base: explicit chrFileOffset wins; else `bank` for NES; else auto.
  let chrBase;
  if (chrFileOffset != null) {
    chrBase = { fileOffset: chrFileOffset, note: "explicit chrFileOffset" };
  } else if (bank != null) {
    const { readFile } = await import("node:fs/promises");
    const data = new Uint8Array(await readFile(path));
    chrBase = { fileOffset: bankToChrOffset(platform, data, bank), note: `${platform} bank ${bank}` };
  } else {
    chrBase = await resolveChrBase(path, platform, chrFileOffset);
  }
  const writeOffset = chrBase.fileOffset + tileIndex * tileSize;

  const { patchFile } = await import("../../rom-id/patch.js");
  const r = await patchFile({
    path,
    outputPath,
    offset: writeOffset,
    base64: Buffer.from(tileBytes).toString("base64"),
    expect,
    allowExpand: allowExpand ?? false,
  });

  return {
    ...r,
    tileIndex,
    tilesWritten: conv.totalTiles,
    chrBase: chrBase.fileOffset,
    chrBaseNote: chrBase.note,
    pngDimensionsTiles: { across: conv.tilesAcross, down: conv.tilesDown },
  };
}

/**
 * Map "bank N" to a CHR file offset for the given platform. Same idea as the
 * NES helper in rom-id.js — kept separate here so spliceCHR can use it
 * without circular imports.
 */
function bankToChrOffset(platform, bytes, bank) {
  if (platform !== "nes") {
    throw new Error(`bank arg currently only supported for platform='nes'. Pass chrFileOffset explicitly for '${platform}'.`);
  }
  if (bytes[0] !== 0x4E || bytes[1] !== 0x45 || bytes[2] !== 0x53 || bytes[3] !== 0x1A) {
    throw new Error("bank arg requires an iNES file; pass chrFileOffset instead.");
  }
  const prgSize = bytes[4] * 16384;
  const chrSize = bytes[5] * 8192;
  if (chrSize === 0) throw new Error("CHR-RAM cart — no CHR in the file. Use writeMemory on the running emulator instead.");
  const chrBase = 16 + prgSize;
  const offset = chrBase + bank * 4096;
  if (offset >= chrBase + chrSize) {
    const maxBank = Math.floor(chrSize / 4096) - 1;
    throw new Error(`bank ${bank} out of range; cart has banks 0..${maxBank}.`);
  }
  return offset;
}

/** Parse an RGB color hint: "#RRGGBB" or [r, g, b]. Returns [r, g, b]. */
function parseRgb(input) {
  if (Array.isArray(input) && input.length === 3) return input;
  if (typeof input === "string") {
    const m = input.match(/^#?([0-9a-fA-F]{6})$/);
    if (m) {
      const v = parseInt(m[1], 16);
      return [(v >> 16) & 0xFF, (v >> 8) & 0xFF, v & 0xFF];
    }
  }
  throw new Error(`paletteHint entry must be "#RRGGBB" or [r,g,b]; got ${JSON.stringify(input)}`);
}

// spliceCHR folded into the `romPatch` tool (romPatch({op:'spliceCHR'}),
// rom-id.js, which imports spliceChrCore). Nothing registered here.
export function registerSpliceChrTools() {}
