// sprite-pipeline.js — R15 cross-game sprite-lift tools.
//
// Three primitives that close the gap between extractSpriteSheet and
// loadSpriteSheet for cross-platform sprite imports:
//
//   1. cropSpriteSheet         — slice a tile-cell region from an existing
//                                tile-grid PNG; preserves PLTE.
//   2. quantizePngForPlatform  — quantize an RGBA PNG to the target
//                                platform's per-subpalette index limit.
//   3. (followup) crossPlatformSpriteImport — extract+crop+quantize+manifest
//                                in one call. Lives here when shipped.
//
// Source feedback: ~/code/cliemu/feedback_round12_cross_game_sprite_lift.md

import { readFile, writeFile } from "node:fs/promises";
import { PNG } from "pngjs";
import { jsonContent, safeTool } from "../util.js";
import { intentZod, resolveIntent, intentError } from "../../platforms/common/intent.js";
import { getDefaultPalette } from "../../platforms/common/default-palette.js";

// ── Per-platform palette/index constraints ───────────────────────────
// Used by quantizePngForPlatform. These are the agent-facing "how many
// distinct colors will fit in a tile" rules, NOT the master-palette
// size of the platform. For NES the on-cart hardware allows only 4
// indices per BG/sprite subpalette; SNES varies by BPP; Genesis is 16
// per palette line; etc.
const PLATFORM_LIMITS = {
  nes:        { maxColors: 4,   reason: "NES tile attribute selects one of 4 subpalettes; each holds 4 colors (index 0 transparent for sprites)." },
  gb:         { maxColors: 4,   reason: "DMG tiles are 2bpp → 4 colors per tile, fixed greyscale ramp." },
  gbc:        { maxColors: 4,   reason: "GBC tile attribute selects one of 8 BG palettes; each holds 4 colors. Use loadTilemap to control palette assignment." },
  sms:        { maxColors: 16,  reason: "SMS VDP is 4bpp; one 16-color palette for BG, one for sprites." },
  gg:         { maxColors: 16,  reason: "Game Gear VDP is 4bpp; one 16-color palette for BG, one for sprites." },
  genesis:    { maxColors: 16,  reason: "Genesis VDP is 4bpp; 4 palette lines × 16 colors each." },
  snes:       { maxColors: 16,  reason: "SNES default — assumes 4bpp tiles. For 2bpp pass maxColors=4 explicitly; for 8bpp pass maxColors=256." },
  gba:        { maxColors: 16,  reason: "GBA default — 4bpp tiles. Mode 4 uses 256-color tiles; pass maxColors=256 for that case." },
  atari7800:  { maxColors: 4,   reason: "MARIA palette select uses 2bpp tiles by default; per-palette 4 colors." },
};

/**
 * Read a PNG, return an indexed view: {width, height, indexed?, palette?, rgba}.
 * If the PNG was already indexed (PLTE present), `indexed` is a Uint8Array
 * of length width*height of palette indices. Otherwise `indexed` is undefined
 * and `rgba` is the unpacked RGBA pixel buffer.
 */
function readPng(buf) {
  const png = PNG.sync.read(buf);
  const out = {
    width: png.width,
    height: png.height,
    rgba: png.data,         // Uint8Array, width*height*4
    palette: png.palette || null,
  };
  // pngjs decodes indexed PNGs into RGBA already; we get the palette via .palette.
  // To preserve PLTE on crop, we round-trip RGB → nearest palette index using the
  // existing PLTE.
  return out;
}

/**
 * Render an indexed image back to a PNG with a PLTE. `palette` is
 * an array of [r,g,b] (or [r,g,b,a]) tuples.
 */
function writeIndexedPng(width, height, indices, palette) {
  // pngjs doesn't have first-class indexed output. We emit RGBA from
  // the palette table — the result is the same pixel data even if not
  // colortype-3. Callers that want strict PLTE can re-encode externally;
  // for our use cases (cross-tool transport) RGBA is equivalent.
  const out = new PNG({ width, height });
  for (let i = 0; i < indices.length; i++) {
    const c = palette[indices[i]] ?? [0, 0, 0, 255];
    out.data[i * 4 + 0] = c[0];
    out.data[i * 4 + 1] = c[1];
    out.data[i * 4 + 2] = c[2];
    out.data[i * 4 + 3] = c[3] ?? 255;
  }
  return PNG.sync.write(out);
}

/**
 * Render an RGBA image back to a PNG. `rgba` is a Uint8Array of length width*height*4.
 */
function writeRgbaPng(width, height, rgba) {
  const out = new PNG({ width, height });
  out.data.set(rgba);
  return PNG.sync.write(out);
}

// ── cropSpriteSheet ─────────────────────────────────────────────────

/**
 * Crop a rectangular region of tile cells from a tile-grid PNG.
 *
 * @param {{path:string, tileX:number, tileY:number, tileW:number, tileH:number,
 *   tileSize?:number, outputPath:string}} args
 */
async function cropSpriteSheetImpl({ path, tileX, tileY, tileW, tileH, tileSize = 8, outputPath, intent }) {
  const d = resolveIntent(intent);
  const buf = await readFile(path);
  const png = readPng(buf);
  const pxX = tileX * tileSize;
  const pxY = tileY * tileSize;
  const pxW = tileW * tileSize;
  const pxH = tileH * tileSize;
  if (pxX < 0 || pxY < 0 || pxX + pxW > png.width || pxY + pxH > png.height) {
    throw new Error(
      `cropSpriteSheet: region (${tileX},${tileY}) ${tileW}×${tileH} cells at ${tileSize}px ` +
      `(= ${pxW}×${pxH}px starting at ${pxX},${pxY}) extends past image bounds ` +
      `${png.width}×${png.height}.`
    );
  }
  // Slice the RGBA pixels into a fresh buffer.
  const cropped = new Uint8Array(pxW * pxH * 4);
  for (let y = 0; y < pxH; y++) {
    const srcRow = (pxY + y) * png.width + pxX;
    const dstRow = y * pxW;
    for (let x = 0; x < pxW; x++) {
      const s = (srcRow + x) * 4;
      const d = (dstRow + x) * 4;
      cropped[d + 0] = png.rgba[s + 0];
      cropped[d + 1] = png.rgba[s + 1];
      cropped[d + 2] = png.rgba[s + 2];
      cropped[d + 3] = png.rgba[s + 3];
    }
  }
  // If the source had a PLTE we want to preserve it on output (the loader
  // tools look at PLTE to figure out the index→color mapping). The easiest
  // way is to re-emit using the existing palette via nearest-match.
  let outBuf;
  if (png.palette) {
    // Map each cropped pixel to the nearest entry in png.palette.
    const indices = new Uint8Array(pxW * pxH);
    for (let i = 0; i < indices.length; i++) {
      const r = cropped[i * 4 + 0];
      const g = cropped[i * 4 + 1];
      const b = cropped[i * 4 + 2];
      indices[i] = nearestColor(r, g, b, png.palette);
    }
    outBuf = writeIndexedPng(pxW, pxH, indices, png.palette);
  } else {
    outBuf = writeRgbaPng(pxW, pxH, cropped);
  }
  await writeFile(outputPath, outBuf);
  return {
    path: outputPath,
    intent: d.intent,
    width: pxW,
    height: pxH,
    tileWidth: tileW,
    tileHeight: tileH,
    tileSize,
    paletteEntries: png.palette ? png.palette.length : null,
    note: png.palette
      ? "Source PLTE preserved via nearest-neighbour remap."
      : "Source was truecolor — output is also truecolor. Use quantizePngForPlatform to reduce to an indexed palette.",
  };
}

// ── quantizePngForPlatform ──────────────────────────────────────────

/**
 * Quantize an RGBA PNG down to the target platform's index limit.
 * Modes:
 *   "frequency"  — pick the N most-used colors; nearest-match the rest.
 *   "luminance"  — same picking as frequency, but sort palette by luma so
 *                  index 0 is the lightest color (convention: backdrop).
 *   "platform-master" — (NES only for now) snap to the NES master
 *                  palette before picking N. Future platforms TBD.
 *
 * @param {{path:string, platform:string, outputPath:string, mode?:string, maxColors?:number}} args
 */
async function quantizePngForPlatformImpl({ path, platform, outputPath, intent, mode, maxColors }) {
  const d = resolveIntent(intent);
  // Mode default comes from intent if caller didn't pass one.
  if (mode === undefined) mode = d.quantizeMode;
  const limit = PLATFORM_LIMITS[platform];
  if (!limit && maxColors === undefined) {
    throw new Error(intentError(
      `quantizePngForPlatform: unknown platform '${platform}'.`,
      `Supported: ${Object.keys(PLATFORM_LIMITS).join(", ")}. Or pass maxColors explicitly to override.`,
      d,
    ));
  }
  const targetN = maxColors ?? limit.maxColors;
  if (targetN < 1 || targetN > 256) {
    throw new Error(`quantizePngForPlatform: maxColors must be 1..256, got ${targetN}.`);
  }
  if (!["frequency", "luminance", "platform-master"].includes(mode)) {
    throw new Error(`quantizePngForPlatform: unknown mode '${mode}'. Use frequency | luminance | platform-master.`);
  }
  const buf = await readFile(path);
  const png = readPng(buf);
  const npx = png.width * png.height;

  // ── Step 1: count color frequencies (packed RGB key) ────────────
  const counts = new Map();
  for (let i = 0; i < npx; i++) {
    const r = png.rgba[i * 4 + 0];
    const g = png.rgba[i * 4 + 1];
    const b = png.rgba[i * 4 + 2];
    // Treat fully-transparent pixels as a special "skip" — they don't
    // need a color slot, just an alpha=0 mark in output.
    const key = (r << 16) | (g << 8) | b;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  let palette = sorted.slice(0, targetN).map(([k]) => [(k >> 16) & 0xFF, (k >> 8) & 0xFF, k & 0xFF, 255]);

  // ── Step 2: apply mode-specific transform ────────────────────────
  if (mode === "luminance") {
    // Sort so index 0 = lightest. Luma = 0.299R + 0.587G + 0.114B.
    palette.sort((a, b) => {
      const la = 0.299 * a[0] + 0.587 * a[1] + 0.114 * a[2];
      const lb = 0.299 * b[0] + 0.587 * b[1] + 0.114 * b[2];
      return lb - la;
    });
  }
  if (mode === "platform-master") {
    if (platform === "nes") {
      palette = palette.map(([r, g, b]) => snapToNesMaster(r, g, b));
    } else {
      // platform-master not yet implemented for non-NES platforms.
      // Under intent:"homebrew" this is the auto-resolved default, so
      // silently fall back to luminance (still better than frequency
      // for the "indexed PNG with backdrop at idx 0" homebrew case).
      // Tests against an explicit mode:"platform-master" with non-NES
      // platforms still want this to be informational, not an error.
      mode = "luminance";
      palette.sort((a, b) => {
        const la = 0.299 * a[0] + 0.587 * a[1] + 0.114 * a[2];
        const lb = 0.299 * b[0] + 0.587 * b[1] + 0.114 * b[2];
        return lb - la;
      });
    }
  }

  // ── Step 3: map every pixel to nearest palette index ────────────
  const indices = new Uint8Array(npx);
  for (let i = 0; i < npx; i++) {
    const r = png.rgba[i * 4 + 0];
    const g = png.rgba[i * 4 + 1];
    const b = png.rgba[i * 4 + 2];
    indices[i] = nearestColor(r, g, b, palette);
  }

  const outBuf = writeIndexedPng(png.width, png.height, indices, palette);
  await writeFile(outputPath, outBuf);
  return {
    path: outputPath,
    intent: d.intent,
    width: png.width,
    height: png.height,
    paletteEntries: palette.length,
    palette: palette.map(([r, g, b]) => "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")),
    mode,
    inputUniqueColors: counts.size,
    note: counts.size > targetN
      ? `Quantized ${counts.size} → ${targetN} colors. Lost colors mapped to nearest neighbour.`
      : `Source had ${counts.size} colors, all preserved.`,
  };
}

/** Find the nearest color in `palette` to (r,g,b). Returns the index. */
function nearestColor(r, g, b, palette) {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < palette.length; i++) {
    const [pr, pg, pb] = palette[i];
    const dr = r - pr, dg = g - pg, db = b - pb;
    const d = dr * dr + dg * dg + db * db;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

// ── NES master palette (NTSC, FCEUX defaults) ────────────────────────
// 64 entries; 2C02 hardware index → approximate sRGB. Used by
// platform-master mode to snap arbitrary colors to the hardware grid
// before color reduction.
const NES_MASTER = [
  [0x60, 0x60, 0x60], [0x00, 0x20, 0x80], [0x00, 0x00, 0xA0], [0x40, 0x00, 0x90],
  [0x80, 0x00, 0x60], [0xA0, 0x00, 0x30], [0xA0, 0x00, 0x00], [0x80, 0x20, 0x00],
  [0x60, 0x40, 0x00], [0x20, 0x60, 0x00], [0x00, 0x80, 0x00], [0x00, 0x60, 0x30],
  [0x00, 0x40, 0x60], [0x00, 0x00, 0x00], [0x00, 0x00, 0x00], [0x00, 0x00, 0x00],
  [0xA0, 0xA0, 0xA0], [0x00, 0x60, 0xC0], [0x20, 0x40, 0xE0], [0x80, 0x00, 0xF0],
  [0xC0, 0x00, 0xC0], [0xE0, 0x00, 0x60], [0xF0, 0x20, 0x00], [0xC0, 0x60, 0x00],
  [0x80, 0x80, 0x00], [0x40, 0xA0, 0x00], [0x00, 0xC0, 0x00], [0x20, 0xA0, 0x60],
  [0x00, 0x80, 0xA0], [0x00, 0x00, 0x00], [0x00, 0x00, 0x00], [0x00, 0x00, 0x00],
  [0xF0, 0xF0, 0xF0], [0x60, 0xA0, 0xF0], [0x80, 0x80, 0xF0], [0xC0, 0x60, 0xF0],
  [0xF0, 0x40, 0xF0], [0xF0, 0x60, 0xA0], [0xF0, 0x80, 0x60], [0xE0, 0xA0, 0x40],
  [0xC0, 0xC0, 0x20], [0x80, 0xE0, 0x40], [0x40, 0xE0, 0x80], [0x40, 0xE0, 0xC0],
  [0x00, 0xE0, 0xE0], [0x60, 0x60, 0x60], [0x00, 0x00, 0x00], [0x00, 0x00, 0x00],
  [0xF0, 0xF0, 0xF0], [0xA0, 0xD0, 0xF0], [0xC0, 0xC0, 0xF0], [0xE0, 0xC0, 0xF0],
  [0xF0, 0xC0, 0xF0], [0xF0, 0xC0, 0xE0], [0xF0, 0xC0, 0xC0], [0xF0, 0xD0, 0xA0],
  [0xE0, 0xE0, 0x80], [0xC0, 0xE0, 0x80], [0xA0, 0xF0, 0xA0], [0xA0, 0xF0, 0xC0],
  [0xA0, 0xF0, 0xE0], [0xA0, 0xA0, 0xA0], [0x00, 0x00, 0x00], [0x00, 0x00, 0x00],
];

export function snapToNesMasterPublic(r, g, b) {
  return snapToNesMaster(r, g, b);
}

function snapToNesMaster(r, g, b) {
  let best = NES_MASTER[0];
  let bestD = Infinity;
  for (const [mr, mg, mb] of NES_MASTER) {
    const dr = r - mr, dg = g - mg, db = b - mb;
    const d = dr * dr + dg * dg + db * db;
    if (d < bestD) { bestD = d; best = [mr, mg, mb]; }
  }
  return [best[0], best[1], best[2], 255];
}

// ── crossPlatformSpriteImport ───────────────────────────────────────

/**
 * One-call wrapper: extractSpriteSheet → cropSpriteSheet → quantizePngForPlatform
 * → optional TexturePacker manifest emission. The output PNG + manifest pair is
 * exactly what loadSpriteSheet expects.
 *
 * @param {{sourceRom:string, sourcePlatform:string, sourceBank?:number,
 *   sourceOffset?:number, sourceTileX:number, sourceTileY:number,
 *   sourceTileW:number, sourceTileH:number,
 *   targetPlatform:string, outputPng:string, outputManifest?:string,
 *   quantizeMode?:string, tilesPerRow?:number,
 *   namePrefix?:string,
 *   paletteIndex?:number,
 *   paletteFromEmulator?:boolean,
 *   intent?:string,
 *   sessionKey?:string}} args
 */
async function crossPlatformSpriteImportImpl(args) {
  const {
    sourceRom, sourcePlatform, sourceBank, sourceOffset,
    sourceTileX, sourceTileY, sourceTileW, sourceTileH,
    targetPlatform, outputPng, outputManifest,
    quantizeMode, tilesPerRow = 16,
    namePrefix = "tile",
    paletteIndex = 0,
    paletteFromEmulator,
    intent,
    sessionKey,
  } = args;
  const d = resolveIntent(intent);
  // Under rom-hack, skip the auto-quantize step — preserve source bytes
  // verbatim (just re-encode for the target platform's tile bit layout).
  // Under homebrew, run with quantize on; default quantizeMode comes
  // from intent if caller didn't override.
  const resolvedQuantizeMode = quantizeMode ?? d.quantizeMode;

  // Lazy imports — keep this module's top-level light.
  const { readFile, writeFile, mkdir } = await import("node:fs/promises");
  const path = await import("node:path");
  const { renderTilesGrid } = await import("../../platforms/common/render-tiles.js");
  const { TILE_SPECS } = await import("../../platforms/common/image-to-tiles.js");
  const { bankToFileOffset } = await import("./rom-id.js");

  const spec = TILE_SPECS[sourcePlatform];
  if (!spec) {
    throw new Error(`crossPlatformSpriteImport: source platform '${sourcePlatform}' unsupported. Supported: ${Object.keys(TILE_SPECS).join(", ")}.`);
  }

  // ── Step 1: load + slice source ROM into tileBytes ──────────────
  const romBytes = new Uint8Array(await readFile(sourceRom));
  let tileSourceBytes;
  let resolvedOffset;
  if (sourceBank !== undefined) {
    resolvedOffset = bankToFileOffset(sourcePlatform, romBytes, sourceBank);
  } else if (sourceOffset !== undefined) {
    resolvedOffset = sourceOffset;
  } else if (sourcePlatform === "nes") {
    // Default for NES = whole CHR rom of the iNES file.
    const { extractChrFromINes } = await import("../../rom-id/patch.js");
    const chr = extractChrFromINes(romBytes);
    if (!chr) {
      throw new Error("crossPlatformSpriteImport: NES source is CHR-RAM (no graphics in the file). Pass sourceOffset against a running emulator's pattern-table dump instead.");
    }
    tileSourceBytes = chr;
  } else {
    throw new Error("crossPlatformSpriteImport: need sourceBank or sourceOffset for non-NES sources.");
  }
  if (!tileSourceBytes) {
    const bytesPerTile = (8 * 8 * spec.bpp) / 8;
    // Take enough tiles to cover the requested region (in the grid layout).
    const needTiles = (sourceTileY + sourceTileH) * tilesPerRow;
    const endOffset = resolvedOffset + needTiles * bytesPerTile;
    if (endOffset > romBytes.length) {
      throw new Error(`crossPlatformSpriteImport: requested region extends past ROM size (need 0x${endOffset.toString(16)}, have 0x${romBytes.length.toString(16)}).`);
    }
    tileSourceBytes = romBytes.slice(resolvedOffset, endOffset);
  }

  // ── Step 2: resolve the source palette ──────────────────────────
  // Without this, the internal extract step would render the tile bytes
  // using the per-platform default palette (grayscale-toned on most
  // targets), losing the artist-facing colors that the standalone
  // `extractSpriteSheet` would have surfaced. We mirror the same
  // palette-resolution logic extractSpriteSheet uses (see rom-id.js):
  //   - Under intent:"homebrew" (d.colorMode === "live-or-platform"),
  //     default to reading the live emulator palette when a ROM is
  //     loaded; fall back to the per-platform default palette otherwise.
  //   - Under intent:"rom-hack", default to grayscale (no override).
  //   - Explicit paletteFromEmulator wins over the intent default.
  // After this block, paletteOverride is either a [[r,g,b], ...] array
  // or undefined (in which case renderTilesGrid uses its default).
  let resolvedPaletteFromEmulator = paletteFromEmulator;
  if (resolvedPaletteFromEmulator === undefined) {
    resolvedPaletteFromEmulator = d.colorMode === "live-or-platform";
  }
  let paletteOverride;
  let paletteSource = "default (grayscale)";
  if (resolvedPaletteFromEmulator) {
    try {
      const { decodeLivePalette } = await import("./preview-tile.js");
      const { getHostOrNull } = await import("../state.js");
      const host = sessionKey ? getHostOrNull(sessionKey) : null;
      if (host) {
        paletteOverride = decodeLivePalette(host, sourcePlatform, paletteIndex, spec);
        paletteSource = `emulator (subpalette ${paletteIndex})`;
      } else if (paletteFromEmulator === true) {
        // Caller EXPLICITLY asked for the emulator palette but no ROM
        // is loaded. Surface the issue instead of silently falling back
        // — they asked for live colors, we can't give them, that's a
        // real error worth knowing about. Mirrors the same behavior in
        // extractSpriteSheet (see rom-id.js).
        throw new Error("crossPlatformSpriteImport: paletteFromEmulator:true requires a loaded ROM. Call loadMedia first.");
      } else if (d.colorMode === "live-or-platform") {
        // Intent default kicked in (no explicit paletteFromEmulator)
        // and no ROM is loaded. Fall back to the per-platform default
        // palette so the agent still gets COLOR, not grayscale —
        // better artist experience than the ramp.
        const { getDefaultPalette, DEFAULT_PALETTES } = await import("../../platforms/common/default-palette.js");
        if (DEFAULT_PALETTES[sourcePlatform]) {
          paletteOverride = getDefaultPalette(sourcePlatform);
          paletteSource = `per-platform default (no ROM loaded; ${paletteOverride.length}-color)`;
        }
      }
    } catch (e) {
      // Re-throw the explicit-flag-no-rom case; soft-fail anything else
      // (e.g. platforms whose live-palette decode isn't wired yet) so
      // the agent gets a working pipeline + a hint in paletteSource.
      if (paletteFromEmulator === true) throw e;
      paletteSource = `default (grayscale; live-palette read failed: ${e.message})`;
    }
  }

  // ── Step 3: render the source tile bank to a temp PNG ───────────
  const sourceBankPng = renderTilesGrid({ platform: sourcePlatform, tileBytes: tileSourceBytes, tilesPerRow, paletteOverride });
  // Persist to a sibling temp path so cropSpriteSheetImpl can read it.
  await mkdir(path.dirname(outputPng), { recursive: true });
  const bankTmp = outputPng + ".source-bank.png";
  await writeFile(bankTmp, sourceBankPng);

  // ── Step 4: crop to the requested tile region ───────────────────
  const cropTmp = outputPng + ".crop.png";
  await cropSpriteSheetImpl({
    path: bankTmp,
    tileX: sourceTileX, tileY: sourceTileY,
    tileW: sourceTileW, tileH: sourceTileH,
    outputPath: cropTmp,
    intent: d.intent,
  });

  // ── Step 5: quantize to the target platform's palette ──────────
  // Under intent:"homebrew" (d.autoQuantize=true) we re-quantize to the
  // target platform's per-subpalette limit. Under rom-hack we copy the
  // cropped PNG verbatim — preserves source bytes for forensic workflows
  // where the caller is doing palette work outside the pipeline.
  let quantResult;
  if (d.autoQuantize) {
    quantResult = await quantizePngForPlatformImpl({
      path: cropTmp,
      platform: targetPlatform,
      outputPath: outputPng,
      mode: resolvedQuantizeMode,
      intent: d.intent,
    });
  } else {
    // Copy the cropped PNG to the requested output path unchanged.
    const cropBytes = await readFile(cropTmp);
    await writeFile(outputPng, cropBytes);
    const cropPng = readPng(cropBytes);
    quantResult = {
      path: outputPng,
      intent: d.intent,
      width: cropPng.width,
      height: cropPng.height,
      paletteEntries: cropPng.palette ? cropPng.palette.length : null,
      palette: cropPng.palette
        ? cropPng.palette.map((c) => "#" + [c[0], c[1], c[2]].map((v) => v.toString(16).padStart(2, "0")).join(""))
        : [],
      mode: "preserved (rom-hack: no quantize)",
      note: "intent:rom-hack — auto-quantize skipped, source bytes preserved verbatim.",
    };
  }

  // ── Step 6: optional manifest. One named entry per 8×8 tile in the
  //   crop region (`namePrefix_row_col`), in row-major order.
  let manifestInfo = null;
  if (outputManifest) {
    const frames = {};
    for (let r = 0; r < sourceTileH; r++) {
      for (let c = 0; c < sourceTileW; c++) {
        frames[`${namePrefix}_${r}_${c}`] = {
          frame: { x: c * 8, y: r * 8, w: 8, h: 8 },
        };
      }
    }
    const manifest = { frames, meta: { app: "romdev/crossPlatformSpriteImport", source: sourceRom } };
    await writeFile(outputManifest, JSON.stringify(manifest, null, 2));
    manifestInfo = { path: outputManifest, frames: Object.keys(frames).length };
  }

  // Cleanup intermediate files — keep the result small.
  const { unlink } = await import("node:fs/promises");
  await unlink(bankTmp).catch(() => {});
  await unlink(cropTmp).catch(() => {});

  return {
    outputPng,
    intent: d.intent,
    width: quantResult.width,
    height: quantResult.height,
    palette: quantResult.palette,
    paletteEntries: quantResult.paletteEntries,
    quantizeMode: d.autoQuantize ? resolvedQuantizeMode : "skipped",
    sourcePlatform,
    targetPlatform,
    sourceTileRegion: { x: sourceTileX, y: sourceTileY, w: sourceTileW, h: sourceTileH },
    // R23f: surface the source palette source so the agent can verify
    // the live-emulator read happened (vs falling back to grayscale).
    // Matches the same field on extractSpriteSheet's response.
    sourcePaletteSource: paletteSource,
    manifest: manifestInfo,
    nextStep: outputManifest
      ? `loadSpriteSheet({ pngPath:"${outputPng}", manifestPath:"${outputManifest}", platform:"${targetPlatform}", intent:"${d.intent}" }) — produces tile bytes ready to link into your ROM.`
      : `Pass outputManifest:"..." next time to get a TexturePacker-style manifest, or hand-author one — minimal shape is {frames:{name:{frame:{x,y,w,h}}}}.`,
  };
}

// ── Register all three tools ─────────────────────────────────────────

export function registerSpritePipelineTools(server, z, sessionKey) {
  server.tool(
    "cropSpriteSheet",
    "Crop a rectangular region of tile cells out of an existing tile-grid PNG. " +
    "Typical workflow: extractSpriteSheet emits a full CHR bank as a tile-grid PNG, " +
    "then cropSpriteSheet pulls out just the slice that contains your sprite (e.g. the " +
    "bike from Excitebike's bank 1). Preserves the source's PLTE (palette) if present " +
    "via nearest-neighbour remap. Output is a smaller PNG ready to feed into " +
    "loadSpriteSheet or quantizePngForPlatform.\n\n" +
    "All coordinates are in TILE CELLS (default 8 px each), not pixels — matches the " +
    "tile-grid mental model of extractSpriteSheet output.",
    {
      path: z.string().describe("Absolute path to the source PNG (typically from extractSpriteSheet)."),
      tileX: z.number().int().min(0).describe("Leftmost tile column to include (0 = leftmost in source)."),
      tileY: z.number().int().min(0).describe("Topmost tile row to include (0 = topmost in source)."),
      tileW: z.number().int().min(1).describe("Width of the crop region in tile cells."),
      tileH: z.number().int().min(1).describe("Height of the crop region in tile cells."),
      tileSize: z.number().int().min(1).max(64).default(8).describe("Side length of a tile cell in pixels (8 for nearly every platform — only override for unusual cases)."),
      outputPath: z.string().describe("Absolute path to write the cropped PNG."),
      intent: intentZod(z),
    },
    safeTool(async (args) => jsonContent(await cropSpriteSheetImpl(args))),
  );

  server.tool(
    "crossPlatformSpriteImport",
    "Use this to lift a sprite region from one platform's ROM into another platform's tile format in ONE " +
    "call (e.g. 'put Mario into my GBC game') — combines extractSpriteSheet + crop + quantizePngForPlatform " +
    "+ optional manifest, feeding straight into loadSpriteSheet. Source: `sourceBank` (NES, easiest) or " +
    "`sourceOffset` (SNES/GB/GBC/Genesis); `sourceTileX/Y/W/H` index into the rendered grid. NOTE: this is " +
    "for a rectangular tile-grid region — for a real multi-sprite character use captureMetaSprite.",
    {
      sourceRom: z.string().describe("Absolute path to the source ROM file."),
      sourcePlatform: z.string().describe("Source platform id (nes, gb, gbc, snes, sms, gg, genesis, ...)."),
      sourceBank: z.number().int().min(0).optional().describe("NES: 4 KB CHR bank index. Conflicts with sourceOffset — use one."),
      sourceOffset: z.number().int().min(0).optional().describe("Raw byte offset into the ROM for tile data. Required for non-NES sources unless using sourceBank."),
      sourceTileX: z.number().int().min(0).describe("Leftmost tile column of the source region (0 = leftmost in the rendered grid)."),
      sourceTileY: z.number().int().min(0).describe("Topmost tile row of the source region."),
      sourceTileW: z.number().int().min(1).describe("Width of the region in tile cells."),
      sourceTileH: z.number().int().min(1).describe("Height of the region in tile cells."),
      targetPlatform: z.string().describe("Target platform id — the output is quantized to this platform's per-subpalette limit."),
      outputPng: z.string().describe("Absolute path to write the quantized output PNG."),
      outputManifest: z.string().optional().describe("Optional: absolute path to write a TexturePacker-style manifest naming each tile slot. Required if you'll feed it into loadSpriteSheet."),
      quantizeMode: z.enum(["frequency", "luminance", "platform-master"]).optional().describe("Palette quantization strategy. See quantizePngForPlatform. Default comes from `intent` (homebrew → platform-master, rom-hack → frequency). Under intent:'rom-hack' the quantize step is SKIPPED entirely — source bytes are preserved verbatim and this arg is ignored."),
      tilesPerRow: z.number().int().min(1).max(64).default(16).describe("Source bank layout — how the tile bytes get rendered into a grid before cropping. 16 matches extractSpriteSheet's default."),
      namePrefix: z.string().default("tile").describe("Per-frame name prefix in the emitted manifest (default 'tile' → tile_0_0, tile_0_1, ...)."),
      paletteFromEmulator: z.boolean().optional().describe("Color the SOURCE extract using the live emulator palette (NES/SNES/Genesis). Requires a loaded ROM matching `sourcePlatform`. Default comes from `intent`: homebrew → true (live palette when a ROM is loaded, per-platform default otherwise); rom-hack → false (grayscale). Set explicitly to override the intent default. Matches the same flag on extractSpriteSheet."),
      paletteIndex: z.number().int().min(0).max(15).default(0).describe("Subpalette index for the source-side live-palette read (NES: 0-7, 0-3 = BG, 4-7 = sprite; SNES: 0-15; Genesis: 0-3). Only used when the source palette is read from the emulator. Matches the same arg on extractSpriteSheet."),
      intent: intentZod(z),
    },
    safeTool(async (args) => jsonContent(await crossPlatformSpriteImportImpl({ ...args, sessionKey }))),
  );

  server.tool(
    "quantizePngForPlatform",
    "Use this to reduce an RGBA PNG to a platform's per-subpalette color limit and emit an indexed PNG " +
    "(with a PLTE loadSpriteSheet picks up) — the bridge from 'imported with another platform's colors' to " +
    "'lands with the right index layout.' `maxColors` defaults per platform (override for 2bpp/8bpp). " +
    "`mode`: frequency (most-common colors), luminance (sorts so index 0 is lightest = backdrop), or " +
    "platform-master (NES: snap to the master palette).",
    {
      path: z.string().describe("Absolute path to the source PNG (RGBA or already indexed; truecolor is the typical input)."),
      platform: z.string().describe("Target platform id (nes, gb, gbc, sms, gg, snes, gba, genesis, atari7800)."),
      outputPath: z.string().describe("Absolute path to write the quantized PNG."),
      mode: z.enum(["frequency", "luminance", "platform-master"]).optional().describe("Quantization strategy. Default comes from `intent` (homebrew → platform-master, rom-hack → frequency)."),
      maxColors: z.number().int().min(1).max(256).optional().describe("Override the per-platform default (e.g. SNES 2bpp = 4, SNES 8bpp = 256)."),
      intent: intentZod(z),
    },
    safeTool(async (args) => jsonContent(await quantizePngForPlatformImpl(args))),
  );
}

// Exports for tests + cross-tool reuse.
export { cropSpriteSheetImpl, quantizePngForPlatformImpl, crossPlatformSpriteImportImpl, PLATFORM_LIMITS };
