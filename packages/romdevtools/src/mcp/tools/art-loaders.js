// art-loaders.js — Round 11 "art-first workflow" tools.
//
// Parse FOSS pixel-art / level-editor output formats (Tiled .tmj,
// LibreSprite .ase, GIF, TexturePacker JSON sheet) into the platform's
// native tile bytes. Lets non-coders / lower-end agents author retro
// games using the editors they already know — no shelling out, no
// ImageMagick, no install instructions.
//
// Shared design notes:
//   - All loaders emit `tile_bytes_base64` (one big blob of tile data,
//     deduped) + per-frame/slice/cell `tile_indices: number[]` pointing
//     into it. Matches NES CHR-bank layout: upload the blob, reference
//     by index.
//   - Indexed (PLTE) input is preserved 1:1 via paletteHint. Truecolor
//     input falls back to nearest-neighbour against the platform master.
//   - All tile bytes go through `rgbaToTiles(platform, ...)` so per-
//     platform encoding (NES planar, GB interleaved, SNES planar-pairs,
//     Genesis packed, etc.) is correct.
//   - Output dir option: when caller passes `outputDir`, blobs are
//     written to <name>.bin files and the response carries paths
//     instead of base64. Saves agent context.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { inflateSync, gunzipSync } from "node:zlib";
import path from "node:path";
import { PNG } from "pngjs";
import Aseprite from "ase-parser";
import { GifReader } from "omggif";

import { jsonContent, safeTool } from "../util.js";
import { rgbaToTiles } from "../../platforms/common/image-to-tiles.js";
import { intentZod } from "../../platforms/common/intent.js";
import { crossPlatformSpriteImportImpl } from "./sprite-pipeline.js";

// ─── Helpers ─────────────────────────────────────────────────────

/** Encode an array of [r,g,b] to a paletteHint suitable for rgbaToTiles. */
function paletteFromAse(asePalette) {
  // ase-parser palette[]: { red, green, blue, alpha, name }
  return asePalette.map((c) => [c.red, c.green, c.blue]);
}

/** Round up to multiple of 8. */
function padTo8(n) { return Math.ceil(n / 8) * 8; }

/**
 * Embed a sub-rect of an RGBA buffer into a new buffer padded to
 * tile-size multiples. Areas outside the source = fully transparent.
 *
 * @param {Buffer|Uint8Array} src  RGBA bytes
 * @param {number} srcW
 * @param {number} sx @param {number} sy @param {number} sw @param {number} sh
 * @returns {{w:number, h:number, pixels:Uint8Array}}
 */
function cropPad8(src, srcW, sx, sy, sw, sh) {
  const w = padTo8(sw);
  const h = padTo8(sh);
  const out = new Uint8Array(w * h * 4);  // zero = transparent
  for (let y = 0; y < sh; y++) {
    const srcRow = ((sy + y) * srcW + sx) * 4;
    const dstRow = (y * w) * 4;
    out.set(src.subarray(srcRow, srcRow + sw * 4), dstRow);
  }
  return { w, h, pixels: out };
}

/**
 * Global tile-dedupe. Given a list of {w,h,pixels} sub-images, encode each
 * to platform tile bytes and return {tile_bytes (one big Uint8Array),
 * tile_count, indices: number[][] — per input, the list of dedup'd indices}.
 *
 * @param {string} platform
 * @param {{w,h,pixels:Uint8Array}[]} items
 * @param {[number,number,number][]} [paletteHint]
 * @param {"merge"|"preserve"|"preserve-blanks"} [dedup="merge"]
 *   - "merge"           (default) — collapse byte-identical tiles to one bank
 *                       slot. Best for ROM-size optimization.
 *   - "preserve"        — every tile gets its own bank slot, regardless of
 *                       content equality. Best for "fixed N-slot grid where
 *                       slot K always = slot K" (e.g. animation frames).
 *   - "preserve-blanks" — dedup non-blank tiles, but every blank tile gets
 *                       a unique slot. Useful when blanks are placeholders
 *                       you'll fill in later.
 */
function dedupTiles(platform, items, paletteHint, dedup = "merge") {
  /** @type {Map<string, number>} */
  const seen = new Map();
  /** @type {Uint8Array[]} */
  const bank = [];
  const indices = [];
  for (const item of items) {
    const r = rgbaToTiles(platform, {
      width: item.w, height: item.h, pixels: item.pixels, paletteHint,
    });
    const bytesPerTile = r.tiles.length / r.totalTiles;
    const perItem = [];
    for (let t = 0; t < r.totalTiles; t++) {
      const slice = r.tiles.slice(t * bytesPerTile, (t + 1) * bytesPerTile);
      let idx;
      if (dedup === "preserve") {
        // Every tile gets a unique slot.
        idx = bank.length;
        bank.push(slice);
      } else {
        const isBlank = slice.every((b) => b === 0);
        if (dedup === "preserve-blanks" && isBlank) {
          // Every blank tile gets its own slot — never collapse them.
          idx = bank.length;
          bank.push(slice);
        } else {
          const key = Buffer.from(slice).toString("base64");
          idx = seen.get(key);
          if (idx === undefined) {
            idx = bank.length;
            bank.push(slice);
            seen.set(key, idx);
          }
        }
      }
      perItem.push(idx);
    }
    indices.push(perItem);
  }
  const bytesPerTile = bank[0]?.length ?? 0;
  const tile_bytes = new Uint8Array(bank.length * bytesPerTile);
  for (let i = 0; i < bank.length; i++) tile_bytes.set(bank[i], i * bytesPerTile);
  return { tile_bytes, tile_count: bank.length, indices, bytes_per_tile: bytesPerTile };
}

/**
 * Format a tile_bytes Uint8Array as source code for a given target language.
 * Supported emit modes:
 *   "raw"    — bytes as base64 (the default; same as current behaviour)
 *   "c"      — C array: `const uint8_t tiles[] = { 0x00,0x00,... };`
 *   "ca65"   — cc65/ca65 asm: `.byte $00,$00, ...`
 *   "rgbasm" — RGBDS gb asm:  `db $00,$00, ...`
 *
 * Comments mark each tile boundary so the agent can map slot N → bytes N..N+sz.
 *
 * @param {Uint8Array} buf
 * @param {string} emit
 * @param {number} bytesPerTile
 * @param {Record<string, {tile_indices:number[]}>} [tiles]
 *   Optional tiles map — if given, comments at each tile boundary include
 *   the names of slices that map to that tile (for the dedup="merge" case
 *   where multiple named slices share the same tile bytes).
 * @returns {string}
 */
function formatTileBytesAs(buf, emit, bytesPerTile, tiles) {
  if (emit === "raw") return Buffer.from(buf).toString("base64");
  // Build a reverse-index: tile-id → slice names sharing that tile.
  const tileNames = new Map();
  if (tiles) {
    for (const [name, info] of Object.entries(tiles)) {
      for (const idx of info.tile_indices ?? []) {
        if (!tileNames.has(idx)) tileNames.set(idx, []);
        tileNames.get(idx).push(name);
      }
    }
  }
  let lineByte, prefix, openLine, closeLine;
  if (emit === "c") {
    prefix = "0x";
    lineByte = ",";
    openLine = "  ";
    closeLine = "";
  } else if (emit === "ca65") {
    prefix = "$";
    lineByte = ",";
    openLine = "  .byte ";
    closeLine = "";
  } else if (emit === "rgbasm") {
    prefix = "$";
    lineByte = ",";
    openLine = "  db ";
    closeLine = "";
  } else {
    throw new Error(`formatTileBytesAs: unknown emit '${emit}'. Use raw|c|ca65|rgbasm.`);
  }
  const lines = [];
  if (emit === "c") {
    lines.push("/* generated by romdev — " + buf.length + " bytes total, " + (buf.length / bytesPerTile) + " tiles */");
    lines.push("const unsigned char tiles[] = {");
  }
  for (let t = 0; t < buf.length / bytesPerTile; t++) {
    const names = tileNames.get(t);
    const comment = names && names.length
      ? `${emit === "c" ? "/* " : "; "}tile ${t}${emit === "c" ? "" : ""}: ${names.join(", ")}${emit === "c" ? " */" : ""}`
      : `${emit === "c" ? "/* " : "; "}tile ${t}${emit === "c" ? " */" : ""}`;
    lines.push("  " + comment);
    let row = openLine;
    for (let i = 0; i < bytesPerTile; i++) {
      const byte = buf[t * bytesPerTile + i].toString(16).padStart(2, "0");
      row += prefix + byte;
      if (t * bytesPerTile + i < buf.length - 1) row += lineByte;
    }
    lines.push(row + closeLine);
  }
  if (emit === "c") lines.push("};");
  return lines.join("\n");
}

/**
 * Format a tile-name → tile-index map as platform-source defines.
 *
 * @param {Record<string, {tile_indices:number[]}>} tiles
 * @param {string} emit "c" | "ca65" | "rgbasm"
 * @returns {string}
 */
function formatDefines(tiles, emit) {
  const lines = [];
  if (emit === "c") {
    lines.push("/* tile-name → first tile-index defines */");
    for (const [name, info] of Object.entries(tiles)) {
      const idx = info.tile_indices?.[0] ?? 0;
      lines.push(`#define T_${name.replace(/[^A-Za-z0-9_]/g, "_").toUpperCase()} ${idx}`);
    }
  } else if (emit === "ca65" || emit === "rgbasm") {
    lines.push(`; tile-name → first tile-index defines (${emit})`);
    for (const [name, info] of Object.entries(tiles)) {
      const idx = info.tile_indices?.[0] ?? 0;
      const sym = name.replace(/[^A-Za-z0-9_]/g, "_").toUpperCase();
      // ca65 uses `=` for constants; rgbasm uses `EQU`.
      lines.push(emit === "ca65" ? `T_${sym} = ${idx}` : `T_${sym} EQU ${idx}`);
    }
  } else if (emit !== "raw") {
    throw new Error(`formatDefines: unknown emit '${emit}'.`);
  }
  return lines.join("\n");
}

/**
 * Maybe write a big blob to disk; returns either {bytes_base64} or
 * {bytes_path, bytes_size}.
 */
async function maybeWriteBlob(buf, outputDir, name) {
  if (!outputDir) {
    return { bytes_base64: Buffer.from(buf).toString("base64") };
  }
  await mkdir(outputDir, { recursive: true });
  const p = path.join(outputDir, name);
  await writeFile(p, buf);
  return { bytes_path: p, bytes_size: buf.length };
}

// ─── loadTilemap (Tiled .tmj) ────────────────────────────────────

function decodeTiledLayerData(layer) {
  // Tiled JSON layer.data is either:
  //   - array of gids (encoding="" / unspecified)
  //   - base64 string (encoding="base64", optional compression "gzip"|"zlib"|"zstd")
  if (Array.isArray(layer.data)) return Uint32Array.from(layer.data);
  if (layer.encoding === "base64") {
    let buf = Buffer.from(layer.data, "base64");
    if (layer.compression === "gzip") buf = gunzipSync(buf);
    else if (layer.compression === "zlib") buf = inflateSync(buf);
    else if (layer.compression === "zstd") {
      throw new Error(
        `loadTilemap: zstd compression not supported. Re-export from Tiled with ` +
        `Map > Map Properties > Compression set to 'zlib', 'gzip', or 'uncompressed'.`
      );
    }
    // Tiled writes 32-bit little-endian gids.
    const out = new Uint32Array(buf.length / 4);
    for (let i = 0; i < out.length; i++) {
      out[i] = buf[i*4] | (buf[i*4+1]<<8) | (buf[i*4+2]<<16) | (buf[i*4+3]<<24);
    }
    return out;
  }
  throw new Error(`loadTilemap: unknown layer encoding '${layer.encoding}'`);
}

async function loadTilemapImpl({ path: tmjPath, platform, outputDir }) {
  const raw = await readFile(tmjPath, "utf8");
  const m = JSON.parse(raw);
  const warnings = [];
  const tilesets = (m.tilesets ?? []).map((t) => ({
    firstgid: t.firstgid,
    name: t.name,
    image: t.image,
    tilewidth: t.tilewidth,
    tileheight: t.tileheight,
    tilecount: t.tilecount,
    columns: t.columns,
  }));
  if (tilesets.length > 1) {
    warnings.push(`Map uses ${tilesets.length} tilesets. gid math will subtract firstgid of the FIRST tileset only. Multi-tileset support deferred — re-export with one merged tileset for accurate indices.`);
  }
  const firstgid = tilesets[0]?.firstgid ?? 1;

  /** @type {Record<string, any>} */
  const layers = {};
  /** @type {Record<string, any[]>} */
  const object_layers = {};

  for (const layer of m.layers ?? []) {
    if (layer.type === "tilelayer") {
      const gids = decodeTiledLayerData(layer);
      // Convert: gid 0 = empty, otherwise tile = gid - firstgid.
      const cellCount = layer.width * layer.height;
      let maxIdx = 0;
      for (let i = 0; i < cellCount; i++) {
        const g = gids[i];
        if (g > maxIdx) maxIdx = g;
      }
      const bytesPerCell = (maxIdx - firstgid + 1) > 255 ? 2 : 1;
      const data = new Uint8Array(cellCount * bytesPerCell);
      const empty = new Uint8Array(Math.ceil(cellCount / 8));
      for (let i = 0; i < cellCount; i++) {
        const g = gids[i] & 0x1FFFFFFF;  // mask flip bits
        if (g === 0) {
          empty[i >> 3] |= 1 << (i & 7);
        } else {
          const idx = g - firstgid;
          if (bytesPerCell === 1) data[i] = idx & 0xFF;
          else {
            data[i*2] = idx & 0xFF;
            data[i*2 + 1] = (idx >> 8) & 0xFF;
          }
        }
      }
      const dataBlob = await maybeWriteBlob(data, outputDir, `${layer.name}.data.bin`);
      const emptyBlob = await maybeWriteBlob(empty, outputDir, `${layer.name}.empty.bin`);
      layers[layer.name] = {
        width: layer.width,
        height: layer.height,
        bytes_per_cell: bytesPerCell,
        ...Object.fromEntries(Object.entries(dataBlob).map(([k,v]) => [`data_${k.slice(6)}`, v])),
        ...Object.fromEntries(Object.entries(emptyBlob).map(([k,v]) => [`empty_${k.slice(6)}`, v])),
      };
    } else if (layer.type === "objectgroup") {
      object_layers[layer.name] = (layer.objects ?? []).map((o) => {
        /** @type {any} */
        const out = {
          id: o.id, name: o.name, type: o.type ?? o.class ?? "",
          x: o.x, y: o.y, width: o.width, height: o.height,
        };
        if (o.gid !== undefined) out.gid = o.gid;
        if (o.point) out.point = true;
        if (o.ellipse) out.ellipse = true;
        if (o.polygon) out.polygon = o.polygon;
        if (o.polyline) out.polyline = o.polyline;
        if (o.properties) {
          out.properties = {};
          for (const p of o.properties) out.properties[p.name] = p.value;
        }
        return out;
      });
    } else {
      warnings.push(`Skipping layer '${layer.name}' (type='${layer.type}' not supported)`);
    }
  }
  return {
    platform,
    path: tmjPath,
    width: m.width,
    height: m.height,
    tile_size: m.tilewidth,  // Tiled supports tilewidth != tileheight; we surface width
    orientation: m.orientation ?? "orthogonal",
    layers,
    object_layers,
    tilesets,
    warnings,
  };
}

// ─── loadAsepriteSheet (.ase) ────────────────────────────────────

/**
 * Decode an .ase cel's `rawCelData` (indexed color depth = palette indices,
 * RGBA color depth = RGBA bytes, grayscale = 16-bit) into RGBA bytes.
 */
function aseCelToRgba(cel, colorDepth, palette) {
  const px = cel.w * cel.h;
  const rgba = new Uint8Array(px * 4);
  const data = cel.rawCelData;
  if (colorDepth === 32) {
    // already RGBA
    rgba.set(data);
  } else if (colorDepth === 8) {
    // indexed — look up palette
    for (let i = 0; i < px; i++) {
      const idx = data[i];
      const c = palette[idx];
      if (!c || idx === 0 /* assume index 0 = transparent */) {
        rgba[i*4 + 3] = 0;
      } else {
        rgba[i*4 + 0] = c.red;
        rgba[i*4 + 1] = c.green;
        rgba[i*4 + 2] = c.blue;
        rgba[i*4 + 3] = c.alpha ?? 255;
      }
    }
  } else if (colorDepth === 16) {
    // grayscale: 2 bytes per pixel = value + alpha
    for (let i = 0; i < px; i++) {
      const v = data[i*2];
      const a = data[i*2 + 1];
      rgba[i*4 + 0] = v;
      rgba[i*4 + 1] = v;
      rgba[i*4 + 2] = v;
      rgba[i*4 + 3] = a;
    }
  } else {
    throw new Error(`.ase color depth ${colorDepth} not supported`);
  }
  return rgba;
}

async function loadAsepriteSheetImpl({ path: asePath, platform, _tile_size = 8, outputDir, slice_strategy = "slices", emit = "raw", emitDefines = false }) {
  const buf = await readFile(asePath);
  const ase = new Aseprite(buf, path.basename(asePath));
  ase.parse();

  const warnings = [];
  const colorDepth = ase.colorDepth;  // 8 / 16 / 32

  // Build palette: if indexed, ase.palette; if RGBA, scan distinct colors.
  /** @type {{red,green,blue,alpha?:number}[]} */
  let palette = ase.palette?.colors ?? [];

  // Validate: reject tilemap-mode cels (Aseprite 1.3+).
  for (const f of ase.frames) {
    for (const c of f.cels) {
      if (c.tilemapMetadata) {
        throw new Error(
          `loadAsepriteSheet: frame ${c.frameNumber} has a tilemap-mode cel — ` +
          `not yet supported. In LibreSprite/Aseprite, Layer > Convert > To Tilemap > Off, ` +
          `then re-export.`
        );
      }
    }
  }

  // Flatten each frame to a full-canvas RGBA buffer (sheet width/height).
  const sheetW = ase.width;
  const sheetH = ase.height;
  /** @type {Uint8Array[]} */
  const frameRgba = [];
  for (const f of ase.frames) {
    const canvas = new Uint8Array(sheetW * sheetH * 4);
    for (const cel of f.cels) {
      if (cel.cellType === 1) continue;  // linked cel — TODO follow link
      const rgba = aseCelToRgba(cel, colorDepth, palette);
      // Blit into canvas at (cel.xpos, cel.ypos), respecting opacity.
      for (let y = 0; y < cel.h; y++) {
        for (let x = 0; x < cel.w; x++) {
          const sx = cel.xpos + x;
          const sy = cel.ypos + y;
          if (sx < 0 || sx >= sheetW || sy < 0 || sy >= sheetH) continue;
          const so = (y * cel.w + x) * 4;
          const a = rgba[so + 3];
          if (a === 0) continue;
          const co = (sy * sheetW + sx) * 4;
          canvas[co + 0] = rgba[so + 0];
          canvas[co + 1] = rgba[so + 1];
          canvas[co + 2] = rgba[so + 2];
          canvas[co + 3] = rgba[so + 3];
        }
      }
    }
    frameRgba.push(canvas);
  }

  // Pick slicing strategy.
  /** @type {{name:string, x:number, y:number, w:number, h:number, frame:number}[]} */
  const slices = [];
  if (slice_strategy === "slices" && ase.slices?.length) {
    for (const s of ase.slices) {
      for (const k of s.keys ?? []) {
        slices.push({
          name: s.name,
          x: k.x, y: k.y, w: k.width, h: k.height,
          frame: k.frameNumber ?? 0,
        });
      }
    }
  } else if (slice_strategy === "frames" || slices.length === 0) {
    // Each frame is one slice
    for (let i = 0; i < ase.frames.length; i++) {
      slices.push({ name: `frame_${i}`, x: 0, y: 0, w: sheetW, h: sheetH, frame: i });
    }
  }
  if (slices.length === 0) {
    warnings.push("No slices found and no frames to slice — output will be empty.");
  }

  // Crop each slice into an 8-padded RGBA buffer.
  const cropped = slices.map((s) => cropPad8(frameRgba[s.frame], sheetW, s.x, s.y, s.w, s.h));

  // Dedupe + encode.
  const paletteHint = palette.length ? paletteFromAse(palette) : undefined;
  const { tile_bytes, tile_count, indices, bytes_per_tile } = dedupTiles(platform, cropped, paletteHint);

  // Build tiles object.
  /** @type {Record<string, any>} */
  const tiles = {};
  for (let i = 0; i < slices.length; i++) {
    const s = slices[i];
    const wt = Math.ceil(s.w / 8);
    const ht = Math.ceil(s.h / 8);
    tiles[s.name] = {
      tile_indices: indices[i],
      width_tiles: wt,
      height_tiles: ht,
    };
  }

  // Tags → frame ranges + delays.
  /** @type {Record<string, any>} */
  const tags = {};
  for (const tag of ase.tags ?? []) {
    const from = tag.from, to = tag.to;
    const frameDelays = [];
    for (let f = from; f <= to; f++) {
      frameDelays.push(ase.frames[f]?.frameDuration ?? 100);
    }
    tags[tag.name] = {
      from, to,
      direction: tag.animDirection ?? "forward",
      repeat: tag.repeat ?? 0,
      delays_ms: frameDelays,
    };
  }

  const blob = await maybeWriteBlob(tile_bytes, outputDir, "tiles.bin");
  const formatted = emit !== "raw" ? formatTileBytesAs(tile_bytes, emit, bytes_per_tile, tiles) : null;
  const defines = (emit !== "raw" && emitDefines) ? formatDefines(tiles, emit) : null;
  return {
    platform,
    path: asePath,
    width: sheetW, height: sheetH,
    color_depth: colorDepth,
    palette: palette.map((c) => ({ r: c.red, g: c.green, b: c.blue, a: c.alpha ?? 255 })),
    tiles,
    tile_count,
    bytes_per_tile,
    ...Object.fromEntries(Object.entries(blob).map(([k,v]) => [`tile_${k}`, v])),
    ...(formatted ? { tile_source: formatted, emit } : {}),
    ...(defines ? { defines } : {}),
    tags,
    warnings,
  };
}

// ─── loadGifAnimation ────────────────────────────────────────────

async function loadGifAnimationImpl({ path: gifPath, platform, outputDir, frame_indices, emit = "raw" }) {
  const buf = await readFile(gifPath);
  const reader = new GifReader(new Uint8Array(buf));
  const w = reader.width;
  const h = reader.height;
  const numFrames = reader.numFrames();
  const idxs = frame_indices && frame_indices.length ? frame_indices : Array.from({length: numFrames}, (_, i) => i);
  const delays_ms = [];
  /** @type {{w,h,pixels:Uint8Array}[]} */
  const padded = [];
  const warnings = [];
  if (w % 8 !== 0 || h % 8 !== 0) {
    warnings.push(`GIF dims ${w}×${h} are not multiples of 8 — each frame will be padded to ${padTo8(w)}×${padTo8(h)} with transparent edges.`);
  }
  for (const i of idxs) {
    const out = new Uint8Array(w * h * 4);
    reader.decodeAndBlitFrameRGBA(i, out);
    const info = reader.frameInfo(i);
    delays_ms.push(info.delay * 10);  // GIF stores hundredths of a second
    padded.push(cropPad8(out, w, 0, 0, w, h));
  }
  // GIFs don't expose a global palette via omggif's high-level API,
  // so we let rgbaToTiles do nearest-neighbour against the platform master.
  const { tile_bytes, tile_count, indices, bytes_per_tile } = dedupTiles(platform, padded);
  const blob = await maybeWriteBlob(tile_bytes, outputDir, "tiles.bin");
  const tiles_per_frame = indices[0]?.length ?? 0;
  // GIF frames don't have explicit names, so emit is bytes-only here (no defines).
  const formatted = emit !== "raw" ? formatTileBytesAs(tile_bytes, emit, bytes_per_tile) : null;
  return {
    platform,
    path: gifPath,
    width: w, height: h,
    frames: idxs.length,
    tile_count,
    bytes_per_tile,
    tiles_per_frame,
    ...Object.fromEntries(Object.entries(blob).map(([k,v]) => [`tile_${k}`, v])),
    ...(formatted ? { tile_source: formatted, emit } : {}),
    frame_tile_indices: indices,
    delays_ms,
    warnings,
  };
}

// ─── loadSpriteSheet (PNG + TexturePacker-style JSON) ───────────

async function loadSpriteSheetImpl({ pngPath, manifestPath, platform, outputDir, emit = "raw", emitDefines = false, dedup = "merge" }) {
  const pngBuf = await readFile(pngPath);
  const png = PNG.sync.read(pngBuf);
  const raw = await readFile(manifestPath, "utf8");
  const manifest = JSON.parse(raw);

  // Manifest layout: {frames: {name: {frame:{x,y,w,h}, ...}}, meta:{frameTags:[...]}}.
  // TexturePacker also supports an array-of-frames form; LibreSprite/Aseprite
  // use the hash form. Support both.
  /** @type {Array<{name:string, x:number, y:number, w:number, h:number}>} */
  const slices = [];
  if (Array.isArray(manifest.frames)) {
    for (const f of manifest.frames) {
      const r = f.frame;
      slices.push({ name: f.filename ?? f.name, x: r.x, y: r.y, w: r.w, h: r.h });
    }
  } else if (manifest.frames && typeof manifest.frames === "object") {
    for (const [name, f] of Object.entries(manifest.frames)) {
      const r = f.frame;
      slices.push({ name, x: r.x, y: r.y, w: r.w, h: r.h });
    }
  } else {
    throw new Error("loadSpriteSheet: manifest has no .frames map/array.");
  }

  const cropped = slices.map((s) => cropPad8(png.data, png.width, s.x, s.y, s.w, s.h));
  // Use the PNG's PLTE as paletteHint if present.
  let paletteHint;
  if (png.palette?.length) {
    paletteHint = png.palette.map((c) => [c[0], c[1], c[2]]);
  }
  const { tile_bytes, tile_count, indices, bytes_per_tile } = dedupTiles(platform, cropped, paletteHint, dedup);

  /** @type {Record<string, any>} */
  const tiles = {};
  for (let i = 0; i < slices.length; i++) {
    const s = slices[i];
    tiles[s.name] = {
      tile_indices: indices[i],
      width_tiles: Math.ceil(s.w / 8),
      height_tiles: Math.ceil(s.h / 8),
    };
  }

  // frameTags (LibreSprite)
  /** @type {Record<string, any>} */
  const tags = {};
  if (manifest.meta?.frameTags) {
    for (const t of manifest.meta.frameTags) {
      tags[t.name] = { from: t.from, to: t.to, direction: t.direction ?? "forward" };
    }
  }

  const blob = await maybeWriteBlob(tile_bytes, outputDir, "tiles.bin");
  const formatted = emit !== "raw" ? formatTileBytesAs(tile_bytes, emit, bytes_per_tile, tiles) : null;
  const defines = (emit !== "raw" && emitDefines) ? formatDefines(tiles, emit) : null;
  return {
    platform,
    png_path: pngPath,
    manifest_path: manifestPath,
    width: png.width,
    height: png.height,
    palette: (paletteHint ?? []).map(([r, g, b]) => ({ r, g, b })),
    tiles,
    tile_count,
    bytes_per_tile,
    ...Object.fromEntries(Object.entries(blob).map(([k,v]) => [`tile_${k}`, v])),
    ...(formatted ? { tile_source: formatted, emit } : {}),
    ...(defines ? { defines } : {}),
    tags,
    warnings: [],
  };
}

// ─── MCP tool registration ───────────────────────────────────────

export function registerArtLoaderTools(server, z, sessionKey) {
  server.tool(
    "importArt",
    "Import art from an editor file or a source ROM into the target platform's native tile bytes, one tool keyed by `from`. " +
    "Shared spine: `platform` (controls the tile encoding — NES planar 2bpp, GB interleaved 2bpp, SNES planar-pairs 4bpp, Genesis packed 4bpp, ...), " +
    "`outputDir` (write blobs to disk instead of base64-inlining), and for the editor formats `emit` " +
    "(c=`const unsigned char tiles[]`; ca65=`.byte $NN` for cc65/NES; rgbasm=`db $NN` for GB/GBC — each tile preceded by a slice-naming comment) " +
    "+ `emitDefines` (name→tile-id constants). All editor loaders dedup tiles and return tile_bytes + per-frame/slice/cell `tile_indices`.\n" +
    "• from:'aseprite' — parse a LibreSprite/Aseprite `.ase` (`path`). Each slice (or each frame if no slices, via `slice_strategy`) becomes a named tile group; tags → named frame ranges with delays. Indexed mode preserves the artist's palette.\n" +
    "• from:'gif' — decode a GIF (`path`) to per-frame tile data + delays. `frame_indices` extracts a subset. (omggif doesn't apply GIF disposal — export with Disposal:Replace.)\n" +
    "• from:'texturepacker' — import a TexturePacker-style PNG+JSON sheet (`pngPath`+`manifestPath`; LibreSprite: Export Sprite Sheet > JSON-Hash). Named deduped tile groups per frame; `meta.frameTags` surfaced; `dedup:'merge'|'preserve'|'preserve-blanks'` (preserve keeps a fixed slot-per-slice grid).\n" +
    "• from:'tiled' — parse a Tiled `.tmj` map (`path`). Tile layers → per-cell `data` blob (+ `empty_mask` so 'no tile' ≠ 'tile 0'); object layers → named {x,y,w,h,name,type,properties} arrays for spawn points/triggers. (zstd-compressed maps: re-export zlib/gzip/uncompressed.)\n" +
    "• from:'rom' — the demake lift: extract a rectangular tile-grid region from ANOTHER platform's ROM and re-encode it for `platform` in one call (extract+crop+quantize+optional manifest). Source: `sourceBank` (NES, easiest) or `sourceOffset`; `sourceTileX/Y/W/H` index the rendered grid. For a real multi-sprite character use sprites({op:'capture'}) instead.",
    {
      from: z.enum(["aseprite", "gif", "texturepacker", "tiled", "rom"])
        .describe("aseprite=.ase file; gif=GIF animation; texturepacker=PNG+JSON sheet; tiled=.tmj map; rom=lift a tile region from a source ROM (demake)."),
      platform: z.string().describe("Target platform id — controls the tile byte encoding. (from:'rom' = the TARGET; pass the source platform as `sourcePlatform`.)"),
      outputDir: z.string().optional().describe("Editor formats only — write tile blobs here instead of base64-inlining (from:'rom' uses outputPng/outputManifest instead)."),
      emit: z.enum(["raw", "c", "ca65", "rgbasm"]).default("raw").describe("from:aseprite/gif/texturepacker — tile_bytes output format (tiled/rom ignore it)."),
      emitDefines: z.boolean().default(false).describe("from:aseprite/texturepacker, emit≠'raw' — also emit name→tile-id defines in the emit syntax (gif has no named tiles)."),
      // editor-file inputs
      path: z.string().optional().describe("from:aseprite/gif/tiled — absolute path to the .ase / .gif / .tmj file."),
      pngPath: z.string().optional().describe("from:texturepacker — absolute path to the sheet .png."),
      manifestPath: z.string().optional().describe("from:texturepacker — absolute path to the sheet .json (TexturePacker-style)."),
      slice_strategy: z.enum(["slices", "frames", "grid"]).default("slices").describe("from:aseprite — chop the canvas by 'slices' (default; falls back to 'frames' if the .ase has no slices), 'frames', or 'grid' (not yet implemented)."),
      frame_indices: z.array(z.number().int().min(0)).optional().describe("from:gif — frame indices to extract (default: all)."),
      dedup: z.enum(["merge", "preserve", "preserve-blanks"]).default("merge").describe("from:texturepacker — 'merge' (default, collapse identical tiles), 'preserve' (fixed slot per slice), 'preserve-blanks' (dedup non-blank, unique slot per blank)."),
      // from:'rom' (cross-platform demake lift)
      sourceRom: z.string().optional().describe("from:rom — absolute path to the source ROM file."),
      sourcePlatform: z.string().optional().describe("from:rom — source platform id (nes, gb, gbc, snes, sms, gg, genesis, ...)."),
      sourceBank: z.number().int().min(0).optional().describe("from:rom, NES: 4 KB CHR bank index. Takes precedence over sourceOffset if both are passed."),
      sourceOffset: z.number().int().min(0).optional().describe("from:rom — raw byte offset to tile data; use instead of sourceBank. NES with neither defaults to the whole CHR ROM."),
      sourceTileX: z.number().int().min(0).optional().describe("from:rom — leftmost tile column of the source region."),
      sourceTileY: z.number().int().min(0).optional().describe("from:rom — topmost tile row of the source region."),
      sourceTileW: z.number().int().min(1).optional().describe("from:rom — region width in tile cells."),
      sourceTileH: z.number().int().min(1).optional().describe("from:rom — region height in tile cells."),
      outputPng: z.string().optional().describe("from:rom — absolute path to write the output PNG (required)."),
      outputManifest: z.string().optional().describe("from:rom — TexturePacker-style manifest path (needed to feed a later from:'texturepacker' import)."),
      quantizeMode: z.enum(["frequency", "luminance", "platform-master"]).optional().describe("from:rom — palette quantization strategy (default from intent; rom-hack skips quantize entirely)."),
      tilesPerRow: z.number().int().min(1).max(64).default(16).describe("from:rom — source bank grid width (tiles/row) before cropping (16 matches the extract default)."),
      namePrefix: z.string().default("tile").describe("from:rom — per-tile name prefix in the emitted manifest (entries are namePrefix_row_col)."),
      paletteFromEmulator: z.boolean().optional().describe("from:rom — color the source extract from the live emulator palette (NES/SNES/Genesis; needs a loaded ROM matching sourcePlatform). Default from intent; true with no ROM loaded is an error."),
      paletteIndex: z.number().int().min(0).max(15).default(0).describe("from:rom — subpalette index for the source-side live-palette read (NES 0-7, SNES 0-15, Genesis 0-3)."),
      intent: intentZod(z).optional().describe("from:rom ONLY (REQUIRED there — call errors without it) — 'homebrew' (live/default palette + platform-master quantize) or 'rom-hack' (grayscale, frequency quantize, source bytes preserved). The editor formats ignore it."),
    },
    safeTool(async (args) => {
      switch (args.from) {
        case "aseprite": {
          if (!args.path) throw new Error("importArt({from:'aseprite'}): `path` (the .ase file) is required.");
          return jsonContent(await loadAsepriteSheetImpl(args));
        }
        case "gif": {
          if (!args.path) throw new Error("importArt({from:'gif'}): `path` (the .gif file) is required.");
          return jsonContent(await loadGifAnimationImpl(args));
        }
        case "texturepacker": {
          if (!args.pngPath || !args.manifestPath) throw new Error("importArt({from:'texturepacker'}): `pngPath` and `manifestPath` are required.");
          return jsonContent(await loadSpriteSheetImpl(args));
        }
        case "tiled": {
          if (!args.path) throw new Error("importArt({from:'tiled'}): `path` (the .tmj file) is required.");
          return jsonContent(await loadTilemapImpl(args));
        }
        case "rom": {
          if (!args.sourceRom || !args.sourcePlatform) throw new Error("importArt({from:'rom'}): `sourceRom` and `sourcePlatform` are required.");
          if (!args.outputPng) throw new Error("importArt({from:'rom'}): `outputPng` is required.");
          // crossPlatformSpriteImportImpl expects `targetPlatform`; map our spine `platform` onto it.
          return jsonContent(await crossPlatformSpriteImportImpl({ ...args, targetPlatform: args.platform, sessionKey }));
        }
        default: throw new Error(`importArt: unknown from '${args.from}'`);
      }
    }),
  );
}
