// Text-mode tile inspection — programmatic alternatives to the PNG-returning
// inspect* tools. Use these when you want to do exact comparisons, scans, or
// bulk analysis without spending visual-reasoning budget per inspection.
//
// Source switch: every tool accepts an optional `path` to read CHR bytes
// from a file on disk instead of the running emulator. Without `path`, the
// tool reads the loaded emulator's pattern table / VRAM. The response
// always reports `source: "file" | "emulator"` so the caller knows which.

import { readFile } from "node:fs/promises";
import { getHostOrNull, getHost } from "../state.js";
import { jsonContent, safeTool } from "../util.js";

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

export function registerTileInspectTools(server, z, sessionKey) {
  server.tool(
    "getTile",
    "Decode a single tile and return its 64 pixel indices (top-left, row-major). Use for exact " +
    "byte-level analysis instead of inspectPatternTiles (which returns a PNG you have to view " +
    "visually).\n\n" +
    "Source selection: pass `path` to read CHR bytes from a file on disk (iNES files auto-locate " +
    "CHR, raw .chr files are read as-is). Omit `path` to read from the running emulator's pattern " +
    "table / VRAM. The response always reports `source: \"file\" | \"emulator\"` so you know which.\n\n" +
    "GENESIS NOTE: genesis-plus-gx stores VRAM as 16-bit words in host (little-endian) byte order, " +
    "so raw video_ram bytes have each word's two bytes swapped vs the VDP-logical layout (readMemory " +
    "exposes those raw bytes too). By default getTile UN-SWAPS this for the live emulator so `pixels` " +
    "are in true render order; pass `logicalPixels:false` to see the raw host byte order instead. " +
    "The response reports `byteSwapCorrected:true` when the un-swap was applied.",
    {
      platform: z.string().optional().describe("Required when reading from `path` (no running emulator to sniff from)."),
      tileIndex: z.number().int().min(0).max(8191),
      path: z.string().optional().describe("Absolute path to a ROM file (.nes auto-finds CHR) or raw .chr/.bin. Omit to read from the running emulator."),
      logicalPixels: z.boolean().default(true).describe("Genesis emulator source only: un-swap the host-LE 16-bit VRAM words so pixels match VDP render order (default true — the byte order you almost always want). Set false to inspect the raw host bytes. No effect on other platforms or file sources."),
    },
    safeTool(async ({ platform, tileIndex, path, logicalPixels = true }) => {
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
    }),
  );

  server.tool(
    "tileFingerprints",
    "Scan tiles and return one fingerprint per tile: {idx, hash, nonzero, uniqueColors}. Quickly " +
    "find blank tiles, duplicates, and visually-distinct sprites without rendering every tile to " +
    "PNG. Fast — pure byte arithmetic.\n\n" +
    "Source selection: pass `path` to read from a CHR file on disk, omit for the running emulator. " +
    "Response reports `source: \"file\" | \"emulator\"`.",
    {
      platform: z.string().optional(),
      start: z.number().int().min(0).default(0).describe("First tile index."),
      count: z.number().int().min(1).max(8192).default(256),
      path: z.string().optional().describe("Optional ROM or CHR file. Omit to read from the running emulator."),
      logicalPixels: z.boolean().default(true).describe("Genesis emulator source only: un-swap host-LE VRAM words to VDP render order (default true)."),
    },
    safeTool(async ({ platform, start, count, path, logicalPixels = true }) => {
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
    }),
  );

  server.tool(
    "tilesAscii",
    "Render a range of tiles as ASCII art instead of PNG. Best for precise inspection or text-" +
    "based comparisons. Returns one block per tile separated by newlines.\n\n" +
    "Source selection: pass `path` for a CHR file on disk, omit for the running emulator. Response " +
    "reports `source: \"file\" | \"emulator\"`.",
    {
      platform: z.string().optional(),
      start: z.number().int().min(0).default(0),
      count: z.number().int().min(1).max(64).default(16),
      path: z.string().optional().describe("Optional ROM or CHR file."),
      logicalPixels: z.boolean().default(true).describe("Genesis emulator source only: un-swap host-LE VRAM words to VDP render order (default true)."),
    },
    safeTool(async ({ platform, start, count, path, logicalPixels = true }) => {
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
    }),
  );
}
