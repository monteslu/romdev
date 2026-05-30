// previewTileArt — render tile bytes against a palette to PNG. Pure
// compositing — no emulator build cycle. Replaces the build → load →
// screenshot loop per art tweak: encode bytes, preview, iterate, then
// patchFile once the bytes look right.
//
// Cross-platform: same call shape everywhere. The `platform` arg routes
// to the right decoder (NES 2bpp planar, GB 2bpp interleaved, SNES 4bpp
// planar-pairs, Genesis 4bpp packed, SMS/GG 4bpp interleaved, GBA 4bpp
// packed). The palette source axis is also generic: explicit indices,
// file dump, or live-from-emulator.

import { readFile, writeFile } from "node:fs/promises";
import { PNG } from "pngjs";
import { getHostOrNull } from "../state.js";
import { imageContent, jsonContent, safeTool, textContent } from "../util.js";
import { intentZod } from "../../platforms/common/intent.js";

import { decodeTile } from "../../platforms/common/tile-decode.js";
import { TILE_SPECS } from "../../platforms/common/image-to-tiles.js";
import { nesPaletteIndexToRgb } from "../../platforms/nes/ppu.js";

/**
 * Resolve tile bytes from one of: inline base64, raw file on disk, iNES
 * file (NES only — auto-locates CHR). Returns { bytes, source }.
 */
async function resolveTileBytes({ tileBytes, tilePath, tileStart, tileCount, platform, bytesPerTile }) {
  if (tileBytes) {
    return { bytes: Buffer.from(tileBytes, "base64"), source: "inline" };
  }
  if (!tilePath) {
    throw new Error("previewTileArt: must pass either tileBytes (base64) or tilePath.");
  }
  const file = await readFile(tilePath);
  // iNES auto-locate (NES only).
  if (platform === "nes" && file[0] === 0x4e && file[1] === 0x45 && file[2] === 0x53 && file[3] === 0x1a) {
    const prgSize = file[4] * 16384;
    const chrSize = file[5] * 8192;
    if (chrSize === 0) {
      throw new Error(`previewTileArt: '${tilePath}' is a CHR-RAM cart — no graphics in the file. Load it and pass paletteFromEmulator:true with tileBytes from a live readMemory.`);
    }
    const chr = file.slice(16 + prgSize, 16 + prgSize + chrSize);
    const startByte = (tileStart ?? 0) * bytesPerTile;
    const endByte = tileCount != null
      ? Math.min(startByte + tileCount * bytesPerTile, chr.length)
      : chr.length;
    return { bytes: chr.subarray(startByte, endByte), source: "file (iNES auto-CHR)" };
  }
  // Raw bytes — whole file is tile data.
  const startByte = (tileStart ?? 0) * bytesPerTile;
  const endByte = tileCount != null
    ? Math.min(startByte + tileCount * bytesPerTile, file.length)
    : file.length;
  return { bytes: file.subarray(startByte, endByte), source: "file (raw)" };
}

/**
 * Resolve a palette into N RGB triples for the platform's bit depth.
 * Generic across platforms — decodes each platform's native palette format
 * into a flat [r,g,b][] for the renderer.
 *
 * Inputs:
 *   palette          - explicit array of master-palette indices (NES) OR
 *                      explicit RGB triples (other platforms)
 *   palettePath      - raw palette dump from disk
 *   paletteFromEmulator - pull live palette from running emulator
 *   paletteIndex     - subpalette selector for platforms with multiple
 *                      subpalettes (NES 0-7, SNES 0-7 BG / 8-15 OBJ, etc.)
 */
async function resolvePalette({ platform, palette, palettePath, paletteIndex, paletteFromEmulator, spec, intentDefaults }) {
  // Default fallback: monotonic ramp so tiles are at least visible.
  const fallbackRamp = () => {
    const ramp = [];
    for (let i = 0; i < spec.maxColors; i++) {
      const v = Math.round((255 * i) / Math.max(spec.maxColors - 1, 1));
      ramp.push([v, v, v]);
    }
    return ramp;
  };

  // Explicit palette: shape depends on platform.
  if (palette) {
    if (platform === "nes") {
      if (palette.length !== 4) {
        throw new Error(`previewTileArt: NES palette must be 4 master-palette indices (0-63), got ${palette.length}`);
      }
      return palette.map((idx) => nesPaletteIndexToRgb(idx & 0x3F));
    }
    // Other platforms: accept either indices into a master palette OR
    // direct RGB triples (flat array of length N*3, OR array of [r,g,b]).
    if (Array.isArray(palette[0])) return palette;
    if (palette.length === spec.maxColors * 3) {
      const out = [];
      for (let i = 0; i < palette.length; i += 3) out.push([palette[i], palette[i + 1], palette[i + 2]]);
      return out;
    }
    // Fall through to master palette lookup if a master palette exists.
    if (spec.master) {
      return palette.map((idx) => spec.master[idx & 0xFF]);
    }
    throw new Error(`previewTileArt[${platform}]: palette must be either RGB triples or master-palette indices`);
  }

  if (paletteFromEmulator) {
    const host = getHostOrNull(sessionKey);
    if (host) {
      return decodeLivePalette(host, platform, paletteIndex ?? 0, spec);
    }
    // No ROM loaded. Under intent:"homebrew" (live-or-platform colorMode)
    // fall back to the per-platform default palette so the agent still
    // gets COLOR, not grayscale. Under rom-hack, the explicit
    // paletteFromEmulator:true was clearly an error — surface it.
    if (intentDefaults?.colorMode === "live-or-platform") {
      const { DEFAULT_PALETTES } = await import("../../platforms/common/default-palette.js");
      if (DEFAULT_PALETTES[platform]) return DEFAULT_PALETTES[platform];
    }
    throw new Error("previewTileArt: paletteFromEmulator:true requires a loaded ROM. Call loadMedia first.");
  }

  if (palettePath) {
    const data = await readFile(palettePath);
    return decodePaletteBytes(data, platform, paletteIndex ?? 0, spec);
  }

  return fallbackRamp();
}

/**
 * Read the live palette from the running emulator and decode subpalette N.
 */
export function decodeLivePalette(host, platform, subIdx, spec) {
  switch (platform) {
    case "nes": {
      const pal = host.readMemory("nes_palette", 0, 32);
      return decodeNesSubpalette(pal, subIdx);
    }
    case "snes": {
      const cgram = host.readMemory("snes_cgram", 0, 512);
      return decodeSnesSubpalette(cgram, subIdx, spec.maxColors);
    }
    case "genesis":
    case "megadrive":
    case "md": {
      const cram = host.readMemory("genesis_cram", 0, 128);
      return decodeGenesisSubpalette(cram, subIdx);
    }
    case "gb":
    case "gbc": {
      throw new Error("previewTileArt[gb]: live palette read not yet wired (DMG palette is in $FF47/$FF48/$FF49; CGB has BCPS/BCPD bg palette RAM). Pass explicit `palette` for now.");
    }
    default:
      throw new Error(`previewTileArt[${platform}]: live palette read not implemented`);
  }
}

function decodeNesSubpalette(pal32, subIdx) {
  if (subIdx < 0 || subIdx > 7) {
    throw new Error(`NES paletteIndex must be 0-7 (0-3 = BG, 4-7 = sprite), got ${subIdx}`);
  }
  const subStart = subIdx * 4;
  return [
    nesPaletteIndexToRgb(pal32[0] & 0x3F),         // universal BG color
    nesPaletteIndexToRgb(pal32[subStart + 1] & 0x3F),
    nesPaletteIndexToRgb(pal32[subStart + 2] & 0x3F),
    nesPaletteIndexToRgb(pal32[subStart + 3] & 0x3F),
  ];
}

/** SNES CGRAM is 256 BGR555 words = 512 bytes. Subpalette N occupies entries N*16..N*16+15. */
function decodeSnesSubpalette(cgram, subIdx, maxColors) {
  const start = subIdx * 16 * 2;
  const out = [];
  for (let i = 0; i < maxColors; i++) {
    const lo = cgram[start + i * 2];
    const hi = cgram[start + i * 2 + 1];
    const word = lo | (hi << 8);
    // BGR555: bits 0-4 = R, 5-9 = G, 10-14 = B. Expand 5-bit → 8-bit.
    const r5 = word & 0x1F;
    const g5 = (word >> 5) & 0x1F;
    const b5 = (word >> 10) & 0x1F;
    out.push([(r5 * 255 / 31) | 0, (g5 * 255 / 31) | 0, (b5 * 255 / 31) | 0]);
  }
  return out;
}

/** Genesis CRAM is 64 BGR XXXX-nibble entries (lower 12 bits used). */
function decodeGenesisSubpalette(cram, subIdx) {
  const start = subIdx * 16 * 2;
  const out = [];
  for (let i = 0; i < 16; i++) {
    const lo = cram[start + i * 2];
    const hi = cram[start + i * 2 + 1];
    const word = (hi << 8) | lo;
    // Format: 0000 BBB0 GGG0 RRR0 (3-bit channels with low bit zero).
    const r = (word & 0x000E) << 4;
    const g = (word & 0x00E0);
    const b = (word & 0x0E00) >> 4;
    // Expand 3-bit → 8-bit by replicating high bits.
    const r8 = r | (r >> 3) | (r >> 6);
    const g8 = g | (g >> 3) | (g >> 6);
    const b8 = b | (b >> 3) | (b >> 6);
    out.push([r8 & 0xFF, g8 & 0xFF, b8 & 0xFF]);
  }
  return out;
}

/** Same routines, fed bytes from disk instead of live memory. */
function decodePaletteBytes(data, platform, subIdx, spec) {
  switch (platform) {
    case "nes":  return decodeNesSubpalette(data, subIdx);
    case "snes": return decodeSnesSubpalette(data, subIdx, spec.maxColors);
    case "genesis":
    case "megadrive":
    case "md":   return decodeGenesisSubpalette(data, subIdx);
    default:
      throw new Error(`previewTileArt[${platform}]: palette file decode not implemented`);
  }
}

/**
 * Render N tiles to a PNG sheet given decoded pixel-index arrays + a
 * palette. Generic — works for any platform whose decoder we have.
 */
function renderSheet(tileBytes, platform, paletteRgb, tilesPerRow, scale, bytesPerTile, fallbackBg) {
  const tileCount = Math.floor(tileBytes.length / bytesPerTile);
  const cols = tilesPerRow;
  const rows = Math.max(1, Math.ceil(tileCount / cols));
  const tilePx = 8 * scale;
  const width = cols * tilePx;
  const height = rows * tilePx;
  const png = new PNG({ width, height });
  const [br, bg, bb] = paletteRgb[0] ?? fallbackBg;
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i + 0] = br;
    png.data[i + 1] = bg;
    png.data[i + 2] = bb;
    png.data[i + 3] = 0xff;
  }
  for (let t = 0; t < tileCount; t++) {
    const pixels = decodeTile(platform, tileBytes, t);
    const tx = t % cols;
    const ty = Math.floor(t / cols);
    for (let py = 0; py < 8; py++) {
      for (let px = 0; px < 8; px++) {
        const idx = pixels[py * 8 + px];
        const rgb = paletteRgb[idx] ?? fallbackBg;
        for (let sy = 0; sy < scale; sy++) {
          for (let sx = 0; sx < scale; sx++) {
            const x = tx * tilePx + px * scale + sx;
            const y = ty * tilePx + py * scale + sy;
            const o = (y * width + x) * 4;
            png.data[o + 0] = rgb[0];
            png.data[o + 1] = rgb[1];
            png.data[o + 2] = rgb[2];
            png.data[o + 3] = 0xff;
          }
        }
      }
    }
  }
  return { png: PNG.sync.write(png), width, height, tileCount };
}

export async function previewTileArtCore(args) {
  const { resolveIntent } = await import("../../platforms/common/intent.js");
  const d = resolveIntent(args.intent);
  const { platform, tilesPerRow = 16, scale = 1, outputPath } = args;
  const spec = TILE_SPECS[platform];
  if (!spec) {
    throw new Error(`previewTileArt: unknown platform '${platform}'. Supported: ${Object.keys(TILE_SPECS).join(", ")}`);
  }
  const bytesPerTile = (8 * 8 * spec.bpp) / 8;
  // ── Resolve paletteFromEmulator per intent ────────────────────
  // If not explicit, homebrew → true (live palette when possible);
  // rom-hack → false (default gray ramp). Explicit value wins.
  let resolvedPaletteFromEmulator = args.paletteFromEmulator;
  if (resolvedPaletteFromEmulator === undefined && !args.palette && !args.palettePath) {
    resolvedPaletteFromEmulator = d.colorMode === "live-or-platform";
  }

  const { bytes, source } = await resolveTileBytes({
    tileBytes: args.tileBytes, tilePath: args.tilePath,
    tileStart: args.tileStart, tileCount: args.tileCount,
    platform, bytesPerTile,
  });
  const paletteRgb = await resolvePalette({
    platform,
    palette: args.palette, palettePath: args.palettePath,
    paletteIndex: args.paletteIndex,
    paletteFromEmulator: resolvedPaletteFromEmulator,
    spec,
    intentDefaults: d,
  });

  const fallbackBg = [0, 0, 0];
  const { png, width, height, tileCount: rendered } = renderSheet(
    bytes, platform, paletteRgb, tilesPerRow, scale, bytesPerTile, fallbackBg,
  );

  const result = {
    platform,
    intent: d.intent,
    width,
    height,
    tilesRendered: rendered,
    bpp: spec.bpp,
    tileSourceMode: source,
    paletteUsed: paletteRgb.map(([r, g, b]) =>
      "#" + r.toString(16).padStart(2, "0") + g.toString(16).padStart(2, "0") + b.toString(16).padStart(2, "0")
    ),
    paletteSource: resolvedPaletteFromEmulator ? "emulator-or-platform-default"
      : args.palette ? "explicit"
      : args.palettePath ? "file"
      : "default-ramp",
  };

  if (outputPath) {
    await writeFile(outputPath, png);
    return { ...result, outputPath, note: `${png.length} bytes of PNG written to ${outputPath}.` };
  }
  return { ...result, pngBase64: png.toString("base64") };
}

export function registerPreviewTileTools(server, z, sessionKey) {
  server.tool(
    "previewTileArt",
    "Use this to preview tile bytes against a palette as a PNG — pure compositing, no build/load/screenshot " +
    "cycle. Author bytes → preview → iterate → patchFile once they look right. Cross-platform via " +
    "`platform` (nes/gb/gbc/sms/gg/snes/genesis/gba, each native encoding). Tile source: `tileBytes` " +
    "(base64) or `tilePath` (raw dump or iNES ROM; `tileStart`/`tileCount` to slice). Palette: explicit " +
    "`palette` or `paletteFromEmulator:true` (NES/SNES/Genesis — preview against the real game palette " +
    "without rebuilding; defaults to a gray ramp). See param hints for palettePath / paletteIndex.",
    {
      platform: z.enum(["nes", "gb", "gbc", "sms", "gg", "snes", "genesis", "megadrive", "md", "gba"]),
      tileBytes: z.string().optional().describe("Base64 of raw tile bytes."),
      tilePath: z.string().optional().describe("Path to tile dump (raw) or iNES ROM (NES auto-locates CHR)."),
      tileStart: z.number().int().min(0).optional().describe("Starting tile index in the source."),
      tileCount: z.number().int().min(1).max(8192).optional().describe("How many tiles to render. Default: all."),
      palette: z.array(z.any()).optional().describe("Explicit palette. NES: 4 master indices. Others: RGB triples or indices."),
      palettePath: z.string().optional().describe("Raw palette dump from disk."),
      paletteIndex: z.number().int().min(0).max(15).optional().describe("Subpalette index when source has multiple (NES 0-7, SNES 0-15, Genesis 0-3)."),
      paletteFromEmulator: z.boolean().optional().describe("Pull live palette from the running emulator. Default comes from `intent`: homebrew → true (falls back to per-platform default palette if no ROM is loaded); rom-hack → false (grayscale ramp)."),
      tilesPerRow: z.number().int().min(1).max(64).default(16),
      scale: z.number().int().min(1).max(8).default(1).describe("Pixel scale factor (1 = native)."),
      outputPath: z.string().optional().describe("Write PNG to disk; otherwise return inline base64."),
      intent: intentZod(z),
    },
    safeTool(async (args) => {
      const r = await previewTileArtCore(args);
      if (r.pngBase64) {
        return {
          content: [
            imageContent(r.pngBase64),
            textContent(JSON.stringify({ ...r, pngBase64: undefined })),
          ],
        };
      }
      return jsonContent(r);
    }),
  );
}
