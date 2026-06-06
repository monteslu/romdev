// Meta-sprite capture tools — lift a live character (composed of multiple
// hardware sprites / OAM entries) into a reusable homebrew asset, preserving
// each piece's position/size/tile-order/palette/flips. Works on every
// tile-based sprite platform: genesis, snes, nes, gb, gbc, sms, gg.
// (C64 MOBs are 24×21 bitmaps, not tiles — not supported; the adapter
// throws a clear explanation.)

import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { getHost } from "../state.js";
import { imageContent, jsonContent, safeTool } from "../util.js";
import { inspectSpritesCore } from "./platform-tools.js";

const SPRITE_PLATFORMS = "genesis, snes, nes, gb, gbc, sms, gg";

// ── sprites op implementations ──────────────────────────────────────────
// Each op is the body of one former narrow tool, verbatim. The `sprites`
// router (below) dispatches on `op` and returns the MCP-shaped result.

// op:'inspect' → inspectSpritesCore lives in platform-tools.js (reads native OAM).

async function spritesCapture(sessionKey, { platform, rect, slots, includePartials, name, emit, outputDir }) {
  const host = getHost(sessionKey);
  const p = platform ?? host.status.platform;
  const { captureMetaSprite } = await import("../../platforms/common/metasprite.js");
  const r = await captureMetaSprite(host, p, { rect, slots, includePartials, name });

  let cSource = null;
  if (emit === "c" || emit === "both") {
    const { emitMetaSpriteCode } = await import("../../platforms/common/metasprite.js");
    cSource = emitMetaSpriteCode({ layout: r.layout, tiles: r.tiles, palette: r.palette, varName: name });
  }

  if (outputDir) {
    await mkdir(outputDir, { recursive: true });
    const w = async (f, data) => { await writeFile(path.join(outputDir, f), data); return path.join(outputDir, f); };
    const paths = {
      tiles: await w("tiles.bin", r.tiles),
      palette: await w("palette.bin", r.palette),
      paletteJson: await w("palette.json", JSON.stringify(r.paletteJson, null, 2)),
      layout: await w("layout.json", JSON.stringify(r.layout, null, 2)),
      preview: await w("preview.png", r.previewPng),
    };
    if (cSource) paths.asset_h = await w(`${name}.h`, cSource);
    return jsonContent({
      platform: p, name, note: r.note,
      tileCount: r.layout.tileCount, pieceCount: r.layout.pieces.length,
      bounds: r.layout.bounds, origin: r.layout.origin, paths,
      nextStep: `Inspect ${paths.preview}. Re-verify any time with sprites({op:'render'}) (no rebuild). Include ${cSource ? paths.asset_h : `${paths.tiles} + ${paths.layout}`} in your project.`,
    });
  }
  return {
    content: [
      imageContent(r.previewPng.toString("base64")),
      { type: "text", text: JSON.stringify({
        platform: p, name, note: r.note, layout: r.layout,
        tilesBase64: Buffer.from(r.tiles).toString("base64"),
        paletteBase64: Buffer.from(r.palette).toString("base64"),
        ...(cSource ? { c: cSource } : {}),
        hint: "Pass outputDir next time to write files instead of inlining base64.",
      }) },
    ],
  };
}

async function spritesRender({ tilesPath, layoutPath, outputPath }) {
  const { renderSaved } = await import("../../platforms/common/metasprite.js");
  const tiles = new Uint8Array(await readFile(tilesPath));
  const layout = JSON.parse(await readFile(layoutPath, "utf-8"));
  const png = renderSaved(tiles, layout);
  if (outputPath) {
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, png);
    return jsonContent({ path: outputPath, width: layout.bounds.w, height: layout.bounds.h, pieceCount: layout.pieces.length });
  }
  return { content: [imageContent(png.toString("base64")), { type: "text", text: JSON.stringify({ name: layout.name, platform: layout.platform, bounds: layout.bounds, pieceCount: layout.pieces.length }) }] };
}

async function spritesGroup(sessionKey, { platform, rect, gap }) {
  const host = getHost(sessionKey);
  const p = platform ?? host.status.platform;
  const { groupVisibleSprites } = await import("../../platforms/common/metasprite.js");
  const { groups } = await groupVisibleSprites(host, p, { rect, gap });
  return jsonContent({
    platform: p, groupCount: groups.length, groups,
    hint: groups.length
      ? `Pick a group → sprites({op:'capture', platform:"${p}", slots:[${groups[0].slots.join(",")}], outputDir:"..."}). Sorted largest-first.`
      : "No on-screen sprites — step to a gameplay frame with the character visible, or widen `rect`.",
  });
}

async function spritesPreview(sessionKey, { platform, gap, maxGroups, outputDir, inline }) {
  const host = getHost(sessionKey);
  const p = platform ?? host.status.platform;
  const { groupVisibleSprites, captureMetaSprite } = await import("../../platforms/common/metasprite.js");
  const { groups } = await groupVisibleSprites(host, p, { gap });
  if (!groups.length) {
    return jsonContent({ platform: p, groupCount: 0, note: "No on-screen sprites — step to a gameplay frame with the character visible." });
  }
  if (!inline && !outputDir) {
    throw new Error("sprites({op:'preview'}): pass outputDir (write per-group thumbnail PNGs to disk, returns thumbnailPath per group) or inline:true (return the thumbnails in the response).");
  }
  if (!inline) await mkdir(outputDir, { recursive: true });
  const content = [];
  const observerImages = [];
  const summary = [];
  let i = 0;
  for (const g of groups.slice(0, maxGroups)) {
    let thumb = null;
    try {
      const cap = await captureMetaSprite(host, p, { slots: g.slots, name: "preview" });
      thumb = cap.previewPng;
    } catch { /* group may not be capturable (e.g. odd sizes) — still list it */ }
    const entry = {
      slots: g.slots,
      bounds: g.bounds,
      spriteCount: g.spriteCount,
      capture: `sprites({op:'capture', platform:"${p}", slots:[${g.slots.join(",")}], name:"<name>", emit:"both", outputDir:"..."})`,
    };
    if (thumb) {
      if (inline) {
        content.push(imageContent(thumb.toString("base64")));
      } else {
        const thumbPath = path.join(outputDir, `group-${i}.png`);
        await writeFile(thumbPath, thumb);
        entry.thumbnailPath = thumbPath;
        observerImages.push({ kind: "image", mimeType: "image/png", base64: thumb.toString("base64") });
      }
    }
    summary.push(entry);
    i++;
  }
  const note = "One thumbnail per group (largest-first). Paste a group's `capture` call to lift it.";
  if (inline) {
    content.push({ type: "text", text: JSON.stringify({ platform: p, groupCount: groups.length, shown: summary.length, groups: summary, note }) });
    return { content };
  }
  const json = jsonContent({ platform: p, groupCount: groups.length, shown: summary.length, groups: summary, note });
  if (observerImages.length) json._observerImages = observerImages;
  return json;
}

async function spritesExtractScreenshot({ pngPath, crop, seed, backgroundMode, bgColor, tolerance, previewScale, outputDir }) {
  const { extractSpriteFromScreenshot } = await import("../../platforms/common/screenshot-sprite.js");
  const pngBytes = await readFile(pngPath);
  const r = extractSpriteFromScreenshot({ pngBytes, crop, seed, backgroundMode, bgColor, tolerance, previewScale });
  if (outputDir) {
    await mkdir(outputDir, { recursive: true });
    const sp = path.join(outputDir, "sprite.png"); const dp = path.join(outputDir, "debug.png");
    await writeFile(sp, r.png); await writeFile(dp, r.debugPng);
    return jsonContent({ spritePath: sp, debugPath: dp, width: r.width, height: r.height, keptPixels: r.keptPixels, totalPixels: r.totalPixels, note: "Inspect debug.png (magenta = removed). Tune `tolerance` / `backgroundMode` / `seed` if the mask is wrong." });
  }
  return {
    content: [
      imageContent(r.png.toString("base64")),
      imageContent(r.debugPng.toString("base64")),
      { type: "text", text: JSON.stringify({ width: r.width, height: r.height, keptPixels: r.keptPixels, totalPixels: r.totalPixels, note: "First image = transparent sprite, second = debug mask (magenta = removed)." }) },
    ],
  };
}

async function spritesEmitC({ tilesPath, palettePath, layoutPath, name, outputPath }) {
  const { emitMetaSpriteCode } = await import("../../platforms/common/metasprite.js");
  const tiles = new Uint8Array(await readFile(tilesPath));
  const palette = new Uint8Array(await readFile(palettePath));
  const layout = JSON.parse(await readFile(layoutPath, "utf-8"));
  const c = emitMetaSpriteCode({ layout, tiles, palette, varName: name });
  if (outputPath) {
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, c);
    return jsonContent({ path: outputPath, bytes: c.length, name: name || layout.name, platform: layout.platform });
  }
  return jsonContent({ name: name || layout.name, platform: layout.platform, source: c });
}

export function registerMetaSpriteTools(server, z, sessionKey) {
  // rect/crop/point shapes reused across ops.
  const rectShape = z.object({ x: z.number().int(), y: z.number().int(), w: z.number().int().min(1), h: z.number().int().min(1) });

  server.tool(
    "sprites",
    "Hardware-sprite (OAM/SAT) inspection + the meta-sprite asset pipeline, one tool keyed by `op`.\n" +
    "• op:'inspect' — list the loaded ROM's active sprite table in a generic {slot,x,y,tile,palette,priority,flipH,flipV,size,visible}[] shape. " +
    "Each platform's adapter reads its native OAM and normalizes. `maxSlots`/`slots[]` shrink the response (honest slot indices kept). " +
    "JSON is always returned; sms/gg, gb/gbc, atari2600/7800 also render a sprite PNG (write to `outputPath` or `inline:true`); NES/SNES/Genesis/C64/GBA/PCE/MSX are JSON-only.\n" +
    "• op:'group' — cluster the current frame's on-screen sprites into likely objects (player/enemy/projectile/HUD) by proximity, sorted largest-first, so you can pick a coherent character to capture.\n" +
    "• op:'preview' — group + render a thumbnail per group + hand back a ready-to-paste capture call for each. The fast 'what's on screen, which do I lift?' step. JSON always returned; thumbnails to `outputDir/group-<i>.png` or `inline:true`.\n" +
    `• op:'capture' — lift a visible character as a reusable meta-sprite the RIGHT way (NOT a screenshot crop, NOT crossPlatformSpriteImport): preserves the real hardware composition (multiple OAM/SAT entries with their own pos/size/tile/palette/flips) and per-platform multi-cell tile order, so you AVOID the 'looks right cropped, garbage in-game' bug. Select pieces by \`slots\` (from op:'inspect'/'group') or pixel \`rect\`; emits tiles+palette+layout.json + a preview RE-RENDERED from the exported data (+ idiomatic C with \`emit:'c'|'both'\`). Step to a frame where the character is fully visible first. Sprite ops work on ${SPRITE_PLATFORMS}.\n` +
    "• op:'render' — re-render a captured meta-sprite to PNG from its tiles.bin + layout.json WITHOUT rebuilding a ROM. Verifies a capture (or hand-edited layout) reconstructs correctly.\n" +
    "• op:'emitC' — generate platform-idiomatic C (Genesis SGDK VDP_setSprite chain; NES/GB/GBC shadow-OAM cell tables; SNES oamSet pieces; SMS/GG SAT tables) from a layout. Use when you captured with emit:'json' and now want the C glue.\n" +
    "• op:'extractScreenshot' — LOSSY fallback when op:'capture' can't be used (no clean SAT composition): crop a screenshot region + flood-fill the background away. Emits a transparent PNG + debug PNG (magenta = removed) so you can tune `tolerance`. Prefer op:'capture' whenever sprite groups exist — this is the screenshot-crop escape hatch.",
    {
      op: z.enum(["inspect", "group", "preview", "capture", "render", "emitC", "extractScreenshot"])
        .describe("inspect=list OAM; group=cluster on-screen sprites; preview=group+thumbnails+capture calls; capture=lift a meta-sprite the right way; render=re-render a saved capture; emitC=generate C from a layout; extractScreenshot=lossy screenshot-crop fallback."),
      platform: z.string().optional().describe(`op:inspect/group/preview/capture — defaults to the loaded host. One of: ${SPRITE_PLATFORMS} (inspect also: atari2600/7800, c64, gba, pce, msx, lynx).`),
      // inspect
      maxSlots: z.number().int().min(1).max(128).optional().describe("op:inspect — return only the first N sprite slots (OAM order). Omit for all. e.g. maxSlots:8 = active piece + next preview."),
      // capture/render/emitC selection + assets
      rect: rectShape.optional().describe("op:capture — select sprite entries whose on-screen bounds intersect this pixel rectangle. Mutually exclusive with `slots`. (op:group: only consider sprites intersecting this rect.)"),
      slots: z.array(z.number().int().min(0).max(127)).optional().describe("op:inspect — return only these slot indices (non-contiguous OK), wins over maxSlots. op:capture — explicit OAM/SAT slot numbers to lift (mutually exclusive with `rect`)."),
      includePartials: z.boolean().default(true).describe("op:capture with `rect`: include sprites only partially inside it."),
      name: z.string().optional().describe("op:capture — asset name (layout.json, filenames, C identifiers; defaults 'metasprite'). op:emitC — C identifier base (defaults to the layout's name)."),
      emit: z.enum(["json", "c", "both"]).default("json").describe("op:capture — 'json' = tiles/palette/layout/preview only. 'c'|'both' also emit platform-idiomatic C (<name>.h)."),
      gap: z.number().int().min(0).default(8).describe("op:group/preview — max pixel gap between two sprites' bounds to join the same group. Larger = looser."),
      maxGroups: z.number().int().min(1).max(20).default(8).describe("op:preview — cap how many groups to render thumbnails for (largest-first)."),
      tilesPath: z.string().optional().describe("op:render/emitC — absolute path to tiles.bin."),
      palettePath: z.string().optional().describe("op:emitC — absolute path to palette.bin."),
      layoutPath: z.string().optional().describe("op:render/emitC — absolute path to layout.json (carries platform, bpp, palettes, pieces; its `platform` selects the emitter)."),
      // extractScreenshot
      pngPath: z.string().optional().describe("op:extractScreenshot — absolute path to the source screenshot PNG."),
      crop: rectShape.optional().describe("op:extractScreenshot — region to crop, in source-image pixels."),
      seed: z.object({ x: z.number().int().min(0), y: z.number().int().min(0) }).optional().describe("op:extractScreenshot — a point ON the sprite, in CROP-relative coords. If given, only the connected non-background component containing it is kept."),
      backgroundMode: z.enum(["edge-flood", "color"]).default("edge-flood").describe("op:extractScreenshot — 'edge-flood' (default): flood inward from the crop border. 'color': remove everything near `bgColor` anywhere."),
      bgColor: z.array(z.number().int().min(0).max(255)).length(3).optional().describe("op:extractScreenshot — [r,g,b] background color for 'color' mode (defaults to the top-left crop pixel)."),
      tolerance: z.number().min(0).max(441).default(24).describe("op:extractScreenshot — color-match tolerance (0-441). Raise if background leaks into the sprite; lower if sprite pixels get removed."),
      previewScale: z.number().int().min(1).max(8).default(1).describe("op:extractScreenshot — integer upscale for the output + debug PNGs."),
      // shared output
      outputPath: z.string().optional().describe("op:inspect (sprite PNG)/render/emitC — write the result here; else return inline/path per op."),
      outputDir: z.string().optional().describe("op:capture (tiles/palette/layout/preview + <name>.h) / op:preview (group-<i>.png) / op:extractScreenshot (sprite.png + debug.png) — output directory; without it those ops inline base64."),
      inline: z.boolean().default(false).describe("op:inspect/preview — return the image(s) in the response instead of writing to disk."),
    },
    safeTool(async (args) => {
      switch (args.op) {
        case "inspect":           return await inspectSpritesCore(args);
        case "group":             return await spritesGroup(sessionKey, args);
        case "preview":           return await spritesPreview(sessionKey, args);
        case "capture":           return await spritesCapture(sessionKey, { ...args, name: args.name ?? "metasprite" });
        case "render": {
          if (!args.tilesPath || !args.layoutPath) throw new Error("sprites({op:'render'}): `tilesPath` and `layoutPath` are required.");
          return await spritesRender(args);
        }
        case "emitC": {
          if (!args.tilesPath || !args.palettePath || !args.layoutPath) throw new Error("sprites({op:'emitC'}): `tilesPath`, `palettePath`, and `layoutPath` are required.");
          return await spritesEmitC(args);
        }
        case "extractScreenshot": {
          if (!args.pngPath || !args.crop) throw new Error("sprites({op:'extractScreenshot'}): `pngPath` and `crop` are required.");
          return await spritesExtractScreenshot(args);
        }
        default: throw new Error(`sprites: unknown op '${args.op}'`);
      }
    }),
  );

  server.tool(
    "validateGenesisTiles",
    "Validate generated Genesis 4bpp tile data and/or palette against the VDP's hard limits — catches the 'builds fine, renders garbage' asset bug (a 17th color leaking a palette index > 15 into the tile words, or a palette line with more than 16 colors). Pass `tileDataPath` (raw 4bpp .bin) and/or `paletteJson` (array of lines, each an array of colors). Returns {ok, errors[], warnings[], stats}.",
    {
      tileDataPath: z.string().optional().describe("Absolute path to raw 4bpp Genesis tile bytes (multiple of 32). Each pixel must be a palette index 0-15."),
      paletteJson: z.array(z.any()).optional().describe("Palette as lines: an array of lines, each an array of colors (any form). Flags any line with >16 colors."),
      maxPaletteIndex: z.number().int().min(0).max(15).default(15).describe("Highest palette index the art may use (default 15 = full 16-color line; pass 14 if you reserve index 15)."),
    },
    safeTool(async ({ tileDataPath, paletteJson, maxPaletteIndex }) => {
      const { validateGenesisTiles } = await import("../../platforms/genesis/vdp.js");
      let tileData;
      if (tileDataPath) tileData = new Uint8Array(await readFile(tileDataPath));
      const r = validateGenesisTiles({ tileData, palette: paletteJson, maxPaletteIndex });
      return jsonContent(r);
    }),
  );
}
