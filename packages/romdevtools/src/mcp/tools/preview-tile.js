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

import { decodeTile } from "../../platforms/common/tile-decode.js";
import { TILE_SPECS } from "../../platforms/common/image-to-tiles.js";
import { nesPaletteIndexToRgb } from "../../platforms/nes/ppu.js";
import { decodeMsxPalette, isV9938Mode } from "../../platforms/msx/vdp.js";

// Live-VRAM tile region per platform (mirrors tile-inspect.js). Genesis/SNES
// share the generic libretro video_ram id.
function liveTileRegion(platform) {
  switch (platform) {
    case "nes": return "nes_chr";
    case "sms": return "sms_vram";
    case "gg": return "gg_vram";
    case "gb":
    case "gbc": return "gb_vram";
    case "snes":
    case "genesis":
    case "megadrive":
    case "md": return "video_ram";
    default: throw new Error(`previewTileArt: fromEmulator not wired for platform '${platform}'`);
  }
}

/**
 * Resolve tile bytes from one of: live emulator VRAM (fromEmulator), inline
 * base64, raw file on disk, or iNES file (NES auto-locates CHR).
 * Returns { bytes, source }.
 */
async function resolveTileBytes({ tileBytes, tilePath, fromEmulator, tileStart, tileCount, platform, bytesPerTile, sessionKey }) {
  if (fromEmulator) {
    const host = getHostOrNull(sessionKey);
    if (!host || !host.status?.platform) {
      throw new Error("previewTileArt: fromEmulator:true requires a loaded ROM — call loadMedia first.");
    }
    const region = liveTileRegion(platform);
    const startByte = (tileStart ?? 0) * bytesPerTile;
    const lenBytes = (tileCount ?? 256) * bytesPerTile;
    let bytes = host.readMemory(region, startByte, lenBytes);
    // Genesis VRAM is host-LE 16-bit-word-swapped — un-swap so tiles decode in
    // VDP render order (same correction getTile applies). Other platforms /
    // file sources are already logical.
    const md = platform === "genesis" || platform === "megadrive" || platform === "md";
    if (md && region === "video_ram") {
      const sw = new Uint8Array(bytes.length);
      for (let i = 0; i + 1 < bytes.length; i += 2) { sw[i] = bytes[i + 1]; sw[i + 1] = bytes[i]; }
      if (bytes.length & 1) sw[bytes.length - 1] = bytes[bytes.length - 1];
      bytes = sw;
    }
    return { bytes: Buffer.from(bytes), source: md ? "emulator (VRAM, byte-swap corrected)" : "emulator (VRAM)" };
  }
  if (tileBytes) {
    return { bytes: Buffer.from(tileBytes, "base64"), source: "inline" };
  }
  if (!tilePath) {
    throw new Error("previewTileArt: must pass tileBytes (base64), tilePath, or fromEmulator:true.");
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
async function resolvePalette({ platform, palette, palettePath, paletteIndex, paletteFromEmulator, spec, intentDefaults, sessionKey }) {
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
    case "pce": {
      // VCE 512-entry 9-bit GRB; subIdx picks one of the 16-color sub-palettes
      // (0-15 = BG sub-palettes, 16-31 = sprite sub-palettes).
      const pal = host.readMemory("pce_vce_palette", 0, 1024);
      const u16 = (i) => pal[i * 2] | (pal[i * 2 + 1] << 8);
      const base = (subIdx & 0x1f) * 16;
      const out = [];
      for (let i = 0; i < 16; i++) {
        const v = u16(base + i) & 0x1ff;
        out.push([
          Math.round(((v >> 3) & 7) * 255 / 7), // red
          Math.round(((v >> 6) & 7) * 255 / 7), // green
          Math.round((v & 7) * 255 / 7),        // blue
        ]);
      }
      return out;
    }
    case "msx": {
      // V9938 paletteReg (16 × 9-bit GRB) on MSX2 modes; TMS9918 fixed otherwise.
      const palBytes = host.readMemory("msx_palette", 0, 32);
      const regs = host.readMemory("msx_vdp_regs", 0, 64);
      const { entries } = decodeMsxPalette(palBytes, isV9938Mode(regs));
      return entries.map((e) => [e.r, e.g, e.b]);
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
  const { platform, tilesPerRow = 16, scale = 1, outputPath, sessionKey } = args;

  // MSX screen-2 tiles are TWO parallel tables (1bpp pattern + per-row fg/bg
  // color), so they don't fit the single-blob spec path. Handle MSX specially:
  // read both tables from the live VDP and composite each tile.
  if (platform === "msx") {
    return previewMsxScreen2(args, d);
  }

  const spec = TILE_SPECS[platform];
  if (!spec) {
    throw new Error(`previewTileArt: unknown platform '${platform}'. Supported: ${Object.keys(TILE_SPECS).join(", ")}, msx`);
  }
  const bytesPerTile = (8 * 8 * spec.bpp) / 8;
  // byteOffset: preview tiles starting at a raw BYTE offset (e.g. a watchDma /
  // findReferences source, which is byte-exact but rarely tile-aligned). Convert
  // to a tile index and WARN if it isn't a clean multiple of the tile size — a
  // mid-tile start silently scrambles every tile, which is the trap the agent
  // hit. (Takes precedence over tileStart when both are given.)
  let alignmentWarning;
  if (typeof args.byteOffset === "number") {
    const rem = args.byteOffset % bytesPerTile;
    if (rem !== 0) {
      const lower = args.byteOffset - rem;
      const upper = lower + bytesPerTile;
      alignmentWarning =
        `byteOffset 0x${args.byteOffset.toString(16).toUpperCase()} is NOT a multiple of the ${bytesPerTile}-byte ${platform} tile size ` +
        `(${spec.bpp}bpp) — tiles will be mis-decoded. Nearest tile-aligned offsets: ` +
        `0x${lower.toString(16).toUpperCase()} or 0x${upper.toString(16).toUpperCase()}. ` +
        `(A DMA/findReferences source is byte-exact but rarely tile-aligned — a graphic usually starts a few bytes after a header.)`;
    }
    args = { ...args, tileStart: Math.floor(args.byteOffset / bytesPerTile) };
  }
  // ── Resolve paletteFromEmulator per intent ────────────────────
  // If not explicit, homebrew → true (live palette when possible);
  // rom-hack → false (default gray ramp). Explicit value wins.
  let resolvedPaletteFromEmulator = args.paletteFromEmulator;
  if (resolvedPaletteFromEmulator === undefined && !args.palette && !args.palettePath) {
    // If the TILES come from the live emulator, default the palette to live
    // too — "preview my uploaded tiles" almost always means against the live
    // palette. Otherwise fall back to the intent default.
    resolvedPaletteFromEmulator = args.fromEmulator ? true : d.colorMode === "live-or-platform";
  }

  const { bytes, source } = await resolveTileBytes({
    tileBytes: args.tileBytes, tilePath: args.tilePath, fromEmulator: args.fromEmulator,
    tileStart: args.tileStart, tileCount: args.tileCount,
    platform, bytesPerTile, sessionKey,
  });
  const paletteRgb = await resolvePalette({
    platform,
    palette: args.palette, palettePath: args.palettePath,
    paletteIndex: args.paletteIndex,
    paletteFromEmulator: resolvedPaletteFromEmulator,
    spec,
    intentDefaults: d,
    sessionKey,
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
    ...(alignmentWarning ? { alignmentWarning } : {}),
  };

  if (outputPath) {
    await writeFile(outputPath, png);
    // Livestream sideband: the human sees the rendered sheet even though the
    // agent only gets the path.
    return { ...result, outputPath, note: `${png.length} bytes of PNG written to ${outputPath}.`,
      _observerImages: [{ kind: "image", mimeType: "image/png", base64: png.toString("base64") }] };
  }
  return { ...result, pngBase64: png.toString("base64") };
}

/**
 * Preview MSX screen-2 tiles. Reads the pattern-generator + color tables from
 * the running VDP's VRAM (bases from VDP R4 / R3+R10) and composites each 8×8
 * tile against the active MSX palette. screen-2 has 768 tiles (3 banks of 256).
 */
async function previewMsxScreen2(args, d) {
  const { tilesPerRow = 16, scale = 1, outputPath, sessionKey, tileCount = 256, tileStart = 0 } = args;
  const host = getHostOrNull(sessionKey);
  if (!host) {
    throw new Error("previewTileArt[msx]: needs a loaded ROM (screen-2 tiles live in the running VDP's VRAM). Call loadMedia first.");
  }
  const vram = host.readMemory("msx_vram", 0, host.regionSize("msx_vram"));
  const regs = host.readMemory("msx_vdp_regs", 0, 64);
  // Pattern-generator base = R4 << 11; color table base = (R3 | R10<<8) << 6.
  const patBase = (regs[4] & 0x3f) << 11;
  const colBase = ((regs[3] & 0xff) | ((regs[10] & 0x07) << 8)) << 6;
  const palBytes = host.readMemory("msx_palette", 0, 32);
  const { decodeMsxPalette, isV9938Mode } = await import("../../platforms/msx/vdp.js");
  const { decodeMsxScreen2Tile } = await import("../../platforms/msx/tiles.js");
  const { entries } = decodeMsxPalette(palBytes, isV9938Mode(regs));
  const paletteRgb = entries.map((e) => [e.r, e.g, e.b]);

  const n = Math.min(tileCount, 768 - tileStart);
  const cols = Math.min(tilesPerRow, n);
  const rows = Math.ceil(n / cols);
  const W = cols * 8 * scale, H = rows * 8 * scale;
  const png = new PNG({ width: W, height: H });
  for (let t = 0; t < n; t++) {
    const tile = tileStart + t;
    const pattern = vram.slice(patBase + tile * 8, patBase + tile * 8 + 8);
    const color = vram.slice(colBase + tile * 8, colBase + tile * 8 + 8);
    const px = decodeMsxScreen2Tile(pattern, color); // 64 indices into the 16-color palette
    const tx = (t % cols) * 8 * scale, ty = Math.floor(t / cols) * 8 * scale;
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        const [r, g, b] = paletteRgb[px[y * 8 + x] & 0x0f] ?? [0, 0, 0];
        for (let sy = 0; sy < scale; sy++) for (let sx = 0; sx < scale; sx++) {
          const o = ((ty + y * scale + sy) * W + (tx + x * scale + sx)) * 4;
          png.data[o] = r; png.data[o + 1] = g; png.data[o + 2] = b; png.data[o + 3] = 255;
        }
      }
    }
  }
  const buf = PNG.sync.write(png);
  const result = {
    platform: "msx", intent: d.intent, width: W, height: H,
    tilesRendered: n, bpp: 1, mode: "screen2",
    patternBase: "$" + patBase.toString(16), colorBase: "$" + colBase.toString(16),
    paletteUsed: paletteRgb.map(([r, g, b]) => "#" + r.toString(16).padStart(2, "0") + g.toString(16).padStart(2, "0") + b.toString(16).padStart(2, "0")),
    note: "MSX screen-2: pattern + per-row color read from live VRAM (bases shown). Each row uses 2 colors (the screen-2 constraint).",
  };
  if (outputPath) {
    await writeFile(outputPath, buf);
    return { ...result, outputPath,
      _observerImages: [{ kind: "image", mimeType: "image/png", base64: buf.toString("base64") }] };
  }
  return { ...result, pngBase64: buf.toString("base64") };
}

// previewTileArt folded into the `tiles` tool (tiles({op:'preview'}), in
// tile-inspect.js). The router imports previewTileArtCore from this module;
// nothing is registered here anymore.
export function registerPreviewTileTools() {}
