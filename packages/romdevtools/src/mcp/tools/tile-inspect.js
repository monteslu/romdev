// Text-mode tile inspection — programmatic alternatives to the PNG-returning
// inspect* tools. Use these when you want to do exact comparisons, scans, or
// bulk analysis without spending visual-reasoning budget per inspection.
//
// Source switch: every tool accepts an optional `path` to read CHR bytes
// from a file on disk instead of the running emulator. Without `path`, the
// tool reads the loaded emulator's pattern table / VRAM. The response
// always reports `source: "file" | "emulator"` so the caller knows which.

import { readFile } from "node:fs/promises";
import { getHost } from "../state.js";
import { jsonContent, imageContent, textContent, safeTool } from "../util.js";
import { inspectPatternTilesCore } from "./platform-tools.js";
import { extractSpriteSheetCore } from "./rom-id.js";
import { previewTileArtCore } from "./preview-tile.js";
import { intentZod } from "../../platforms/common/intent.js";

/** Pick the right memory region for the platform's tile data. */
function tileRegion(platform) {
  switch (platform) {
    case "nes": return "nes_chr";
    case "sms": return "sms_vram";
    case "gg":  return "gg_vram";
    case "gb":
    case "gbc": return "gb_vram";
    // snes9x + gpgx both expose VRAM via the generic libretro id.
    case "snes":
    case "genesis": return "video_ram";
    // PC Engine HuC6270 tiles are 4bpp planar-pairs (same as SNES) in VRAM.
    case "pce": return "pce_vdc_vram";
    default:
      throw new Error(`text-mode tile inspection not yet wired for platform '${platform}'`);
  }
}

/**
 * Resolve the CHR byte source for a tile-inspection tool. Returns
 *   { platform, bytes, source, chrBase }
 * where `bytes` is a flat Uint8Array of CHR ROM and `source` is "file" or
 * "emulator". `chrBase` is the file offset where CHR-ROM starts (relevant
 * for iNES files; 0 for raw CHR dumps).
 *
 * - If `path` is set, reads the file. For iNES files, auto-locates the CHR
 *   bank; for raw .chr/.bin files, treats the whole thing as CHR.
 * - If `path` is null, returns a thin shim with a `readTile` function that
 *   delegates to the running host. The bytes array isn't materialized for
 *   the emulator path — too expensive — so callers use `readTile` instead.
 */
async function resolveTileSource(platform, path, sessionKey) {
  if (path) {
    const data = new Uint8Array(await readFile(path));
    // iNES sniff.
    if (data[0] === 0x4e && data[1] === 0x45 && data[2] === 0x53 && data[3] === 0x1a) {
      const prgSize = data[4] * 16384;
      const chrSize = data[5] * 8192;
      if (chrSize === 0) {
        throw new Error(`CHR-RAM cart — '${path}' has no CHR in the file. Use source: emulator after loadMedia, or pass a separate chr.bin.`);
      }
      const chrBase = 16 + prgSize;
      return {
        platform,
        bytes: data.slice(chrBase, chrBase + chrSize),
        source: "file",
        sourcePath: path,
        chrBase,
      };
    }
    // Raw CHR file — assume the whole file is CHR.
    return { platform, bytes: data, source: "file", sourcePath: path, chrBase: 0 };
  }
  // Emulator path.
  const host = getHost(sessionKey);
  const p = platform ?? host.status.platform;
  const region = tileRegion(p);
  return { platform: p, source: "emulator", region, host, chrBase: 0 };
}

/** Read N bytes at offset from a resolved tile source. */
function readTileBytes(src, offset, length) {
  if (src.source === "file") return src.bytes.slice(offset, offset + length);
  return src.host.readMemory(src.region, offset, length);
}

// genesis-plus-gx stores VRAM as 16-bit words in HOST (little-endian) byte
// order, so the two bytes within each word are swapped relative to the logical
// big-endian VDP layout. Reading video_ram raw therefore yields tile bytes in
// the order [b1,b0,b3,b2,...]; decoding that directly scrambles pixel pairs.
// Un-swap each 16-bit word to recover the VDP-logical byte order. ONLY for the
// live emulator on Genesis — a CHR file on disk is already in logical order.
function genesisVramUnswap(bytes) {
  const out = new Uint8Array(bytes.length);
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    out[i] = bytes[i + 1];
    out[i + 1] = bytes[i];
  }
  if (bytes.length & 1) out[bytes.length - 1] = bytes[bytes.length - 1];
  return out;
}

// Whether a (resolved source, logicalPixels) pair needs the Genesis un-swap.
function needsGenesisUnswap(src, logicalPixels) {
  return logicalPixels && src.source === "emulator" && src.platform === "genesis";
}

// ── tiles op implementations (as:pixels|fingerprints|ascii) ─────────────
// Bodies of the former getTile/tileFingerprints/tilesAscii, verbatim. They
// share the module-scope source/swap helpers above.

async function tilesPixels(sessionKey, { platform, tileIndex, path, logicalPixels = true }) {
  const { decodeTile, tileStats, tileToAscii } = await import("../../platforms/common/tile-decode.js");
  const { TILE_SPECS } = await import("../../platforms/common/image-to-tiles.js");
  const src = await resolveTileSource(platform, path, sessionKey);
  const spec = TILE_SPECS[src.platform];
  const bytesPerTile = (8 * 8 * spec.bpp) / 8;
  let bytes = readTileBytes(src, tileIndex * bytesPerTile, bytesPerTile);
  const swap = needsGenesisUnswap(src, logicalPixels);
  if (swap) bytes = genesisVramUnswap(bytes);
  const pixels = decodeTile(src.platform, bytes, 0);
  const stats = tileStats(pixels);
  return jsonContent({
    platform: src.platform,
    source: src.source,
    ...(src.sourcePath ? { sourcePath: src.sourcePath } : {}),
    tileIndex,
    bpp: spec.bpp,
    ...(src.platform === "genesis" && src.source === "emulator" ? { byteSwapCorrected: swap } : {}),
    pixels: Array.from(pixels),
    ascii: tileToAscii(pixels, spec.maxColors),
    hash: stats.hash,
    nonzero: stats.nonzero,
    uniqueColors: stats.uniqueColors,
    histogram: stats.histogram,
  });
}

async function tilesFingerprints(sessionKey, { platform, start = 0, count = 256, path, logicalPixels = true }) {
  const { decodeTile, tileStats } = await import("../../platforms/common/tile-decode.js");
  const { TILE_SPECS } = await import("../../platforms/common/image-to-tiles.js");
  const src = await resolveTileSource(platform, path, sessionKey);
  const spec = TILE_SPECS[src.platform];
  const bytesPerTile = (8 * 8 * spec.bpp) / 8;
  const swap = needsGenesisUnswap(src, logicalPixels);
  const fingerprints = [];
  for (let i = 0; i < count; i++) {
    const idx = start + i;
    let bytes;
    try {
      bytes = readTileBytes(src, idx * bytesPerTile, bytesPerTile);
    } catch {
      break;
    }
    if (!bytes || bytes.length < bytesPerTile) break;
    if (swap) bytes = genesisVramUnswap(bytes);
    const pixels = decodeTile(src.platform, bytes, 0);
    const s = tileStats(pixels);
    fingerprints.push({
      idx,
      hash: s.hash,
      nonzero: s.nonzero,
      uniqueColors: s.uniqueColors,
    });
  }
  return jsonContent({
    platform: src.platform,
    source: src.source,
    ...(src.sourcePath ? { sourcePath: src.sourcePath } : {}),
    bpp: spec.bpp,
    count: fingerprints.length,
    fingerprints,
  });
}

async function tilesAsciiArt(sessionKey, { platform, start = 0, count = 16, path, logicalPixels = true }) {
  const { decodeTile, tileToAscii } = await import("../../platforms/common/tile-decode.js");
  const { TILE_SPECS } = await import("../../platforms/common/image-to-tiles.js");
  const src = await resolveTileSource(platform, path, sessionKey);
  const spec = TILE_SPECS[src.platform];
  const bytesPerTile = (8 * 8 * spec.bpp) / 8;
  const swap = needsGenesisUnswap(src, logicalPixels);
  const blocks = [];
  for (let i = 0; i < count; i++) {
    const idx = start + i;
    let bytes;
    try {
      bytes = readTileBytes(src, idx * bytesPerTile, bytesPerTile);
    } catch {
      break;
    }
    if (!bytes || bytes.length < bytesPerTile) break;
    if (swap) bytes = genesisVramUnswap(bytes);
    const pixels = decodeTile(src.platform, bytes, 0);
    blocks.push(`tile ${idx}:\n${tileToAscii(pixels, spec.maxColors)}`);
  }
  return jsonContent({
    platform: src.platform,
    source: src.source,
    ...(src.sourcePath ? { sourcePath: src.sourcePath } : {}),
    count: blocks.length,
    ascii: blocks.join("\n\n"),
  });
}

export function registerTileInspectTools(server, z, sessionKey) {
  server.tool(
    "tiles",
    "DECODE & render tile / CHR / pattern-table / VRAM bytes, one tool keyed by `op`. " +
    "`intent` is REQUIRED on EVERY call (no default); it only changes output for the file/preview palette path but the schema demands it always. " +
    "OP CHEAT-SHEET (params each op uses, plus the required `intent`): " +
    "png live VRAM → {platform?, scale?, bpp?, tileBaseByte?, paletteBase?, paletteIndex?, tileCount?, outputPath?|inline?}; " +
    "png file → {platform, path, bank?|offset?, count?, paletteIndex?, paletteFromEmulator?, tilesPerRow?, outputPath?}; " +
    "pixels → {tileIndex, platform?, path?, logicalPixels?}; " +
    "fingerprints → {start?, count?, platform?, path?, logicalPixels?}; " +
    "ascii → {start?, count?, platform?, path?, logicalPixels?}; " +
    "preview → {tileBytes|tilePath|fromEmulator, platform, palette?|paletteFromEmulator?|palettePath?, paletteIndex?, tileStart?|byteOffset?, tileCount?, tilesPerRow?, scale?, outputPath?}.\n" +
    "`source`: pass `path` to read from a ROM/CHR file on disk (iNES auto-locates CHR, raw .chr/.bin read as-is); " +
    "omit `path` to read the running emulator's pattern table / VRAM. **Every read reports `source:'file'|'emulator'`.** " +
    "**GENESIS NOTE: genesis-plus-gx stores VRAM as 16-bit words in host (little-endian) byte order, so raw video_ram " +
    "bytes have each word's two bytes swapped vs the VDP-logical layout. `op:pixels/fingerprints/ascii` UN-SWAP this for " +
    "the live emulator by default (`logicalPixels:true`); response reports `byteSwapCorrected`. No effect on file sources.**\n" +
    "• op:'png' — render tiles as a PNG sheet. No `path` → the running emulator (CHR-ROM cores read the iNES file; CHR-RAM " +
    "cores read live VRAM — blank tiles mean nothing uploaded yet). `path` set → render FROM a ROM file on disk (point at " +
    "the data with `bank` (NES, easiest) or raw `offset`; for file extraction **`intent:homebrew` colors from the live/default palette, " +
    "`intent:rom-hack` stays grayscale**; CHR-RAM carts have no file graphics). " +
    "SNES `bpp/tileBaseByte/paletteBase`, Genesis `paletteIndex`, `tileCount/scale`. PNG writes `outputPath` or `inline`.\n" +
    "• op:'pixels' — decode ONE tile to its 64 pixel indices (row-major) + stats/ascii/histogram. Exact byte-level analysis, no visual budget. (`tileIndex` required.)\n" +
    "• op:'fingerprints' — scan `start`..`start+count` tiles → one {idx,hash,nonzero,uniqueColors} each. Find blank/duplicate/distinct tiles fast (pure byte arithmetic), no PNG.\n" +
    "• op:'ascii' — render `start`..`start+count` tiles as ASCII art blocks. Precise text-based inspection/diffs.\n" +
    "• op:'preview' — composite tile BYTES against a palette to a PNG, no build/load/screenshot cycle. Author bytes → preview → iterate → patchFile. Source: `tileBytes` (base64) | `tilePath` | `fromEmulator:true` (live VRAM; Genesis byte-swap handled). Palette: explicit `palette`, `palettePath`, or `paletteFromEmulator:true` (NES/SNES/Genesis/PCE/MSX — GB/GBC not wired, pass explicit `palette`), else gray ramp. intent steers the palette default.",
    {
      op: z.enum(["png", "pixels", "fingerprints", "ascii", "preview"])
        .describe("png=PNG sheet (live VRAM, or a ROM file via path); pixels=one tile's 64 indices; fingerprints=hash scan; ascii=ASCII art; preview=composite arbitrary tileBytes against a palette."),
      platform: z.string().optional().describe("Override platform; defaults to the loaded ROM. REQUIRED for op:'png' file extraction (path) and op:'preview', and when reading pixels/fingerprints/ascii from `path`."),
      path: z.string().optional().describe("op:png/pixels/fingerprints/ascii — read tile bytes from this ROM/CHR file instead of the emulator (iNES auto-locates CHR, raw .chr/.bin read as-is)."),
      logicalPixels: z.boolean().default(true).describe("op:pixels/fingerprints/ascii, Genesis emulator source only: un-swap host-LE 16-bit VRAM words to VDP render order. No effect on file sources or other platforms."),
      // op:pixels
      tileIndex: z.number().int().min(0).max(8191).optional().describe("op:pixels — which tile to decode."),
      // op:fingerprints / op:ascii ranges
      start: z.number().int().min(0).default(0).describe("op:fingerprints/ascii — first tile index."),
      count: z.number().int().min(1).max(8192).optional().describe("How many tiles. op:fingerprints (default 256) / op:ascii (default 16, keep small) / op:png file extraction (default 256)."),
      // op:png shared
      scale: z.number().int().min(1).max(16).default(1).describe("op:png (live VRAM) / op:preview — integer nearest-neighbor upscale (default 1; 8×8 is tiny inline, scale:4 → 32×32 per tile). Ignored by op:png file extraction."),
      bpp: z.union([z.literal(2), z.literal(4), z.literal(8)]).default(4).describe("op:png SNES only: tile bit-depth (Mode 1 BG1/BG2 = 4bpp default, BG3 = 2bpp). snes9x can't auto-detect."),
      tileBaseByte: z.number().int().min(0).default(0).describe("op:png SNES only: byte offset into VRAM of tile 0 (BG character base)."),
      paletteBase: z.number().int().min(0).max(255).default(0).describe("op:png SNES only: CGRAM index of the sub-palette's color 0 used to colorize the sheet."),
      paletteIndex: z.number().int().min(0).max(15).default(0).describe("op:png Genesis live (0-3) / op:png file extraction (NES 0-7, SNES 0-15, Genesis 0-3) / op:preview subpalette index."),
      tileCount: z.number().int().min(0).default(0).describe("How many tiles to render. op:png SNES/Genesis live (0 = fill VRAM; SNES starts from tileBaseByte). op:preview also reads it (fromEmulator default 256; file/inline default = rest of source)."),
      // op:png file extraction (path)
      offset: z.number().int().min(0).optional().describe("op:png file (path): raw byte offset into the ROM file. Prefer `bank` when possible."),
      bank: z.number().int().min(0).max(127).optional().describe("op:png file (path) NES only: 4 KB CHR bank index (0 = first 4 KB). Takes precedence over `offset`."),
      paletteFromEmulator: z.boolean().optional().describe("op:png file extraction / op:preview — color with the live emulator palette (NES/SNES/Genesis, +PCE/MSX for preview). Default from `intent`."),
      tilesPerRow: z.number().int().min(1).max(64).default(16).describe("op:png file extraction / op:preview — tiles per row in the sheet."),
      // op:preview
      tileBytes: z.string().optional().describe("op:preview — base64 of raw tile bytes."),
      tilePath: z.string().optional().describe("op:preview — path to a tile dump (raw) or iNES ROM (NES auto-locates CHR)."),
      fromEmulator: z.boolean().optional().describe("op:preview — read tiles from the running emulator's live VRAM (tileStart/tileCount pick the range). Genesis byte-swap handled. Mutually exclusive with tileBytes/tilePath."),
      tileStart: z.number().int().min(0).optional().describe("op:preview — starting tile index in the source."),
      byteOffset: z.number().int().min(0).optional().describe("op:preview — start at a raw BYTE offset instead of a tile index (pass a watch({on:'dma'}) / disasm-references source directly). WARNS on misalignment. Takes precedence over tileStart."),
      palette: z.array(z.any()).optional().describe("op:preview — explicit palette (NES: 4 master indices; others: RGB triples or indices)."),
      palettePath: z.string().optional().describe("op:preview — raw palette dump from disk."),
      // shared output
      outputPath: z.string().optional().describe("op:png/preview — write the PNG to this path. op:png live VRAM REQUIRES outputPath or inline (no default). op:png file extraction + op:preview: omit to return the image inline."),
      inline: z.boolean().default(false).describe("op:png live VRAM only — return the image in the response instead of writing to disk (file extraction/preview return inline whenever outputPath is omitted)."),
      intent: intentZod(z),
    },
    safeTool(async (args) => {
      switch (args.op) {
        case "pixels": {
          if (args.tileIndex == null) throw new Error("tiles({op:'pixels'}): `tileIndex` is required.");
          return await tilesPixels(sessionKey, args);
        }
        case "fingerprints": return await tilesFingerprints(sessionKey, { ...args, count: args.count ?? 256 });
        case "ascii":        return await tilesAsciiArt(sessionKey, { ...args, count: args.count ?? 16 });
        case "png": {
          // path → render from a ROM file (richer extractSpriteSheet path);
          // no path → live VRAM pattern tables (inspectPatternTiles).
          if (args.path) {
            if (!args.platform) throw new Error("tiles({op:'png'}) with `path`: `platform` is required for file extraction.");
            return await extractSpriteSheetCore({ ...args, count: args.count || 256 }, sessionKey);
          }
          return await inspectPatternTilesCore(args, sessionKey);
        }
        case "preview": {
          const r = await previewTileArtCore({ ...args, sessionKey });
          if (r.pngBase64) {
            return { content: [imageContent(r.pngBase64), textContent(JSON.stringify({ ...r, pngBase64: undefined }))] };
          }
          // Lift the livestream sideband OUT of the core's plain result before
          // it's serialized — it must ride on the MCP result object, never in
          // the agent-visible JSON text.
          const sideband = r._observerImages;
          delete r._observerImages;
          const out = jsonContent(r);
          if (sideband) out._observerImages = sideband;
          return out;
        }
        default: throw new Error(`tiles: unknown op '${args.op}'`);
      }
    }),
  );
}
