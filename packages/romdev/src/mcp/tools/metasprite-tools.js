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

const SPRITE_PLATFORMS = "genesis, snes, nes, gb, gbc, sms, gg";

export function registerMetaSpriteTools(server, z, sessionKey) {
  server.tool(
    "captureMetaSprite",
    "Use this to lift a visible character/object from a ROM as a reusable meta-sprite — the RIGHT way " +
    "(NOT a screenshot crop, NOT crossPlatformSpriteImport): it preserves the real hardware composition " +
    "(multiple OAM/SAT entries with their own pos/size/tile/palette/flips) and handles per-platform " +
    `multi-cell tile order, so you avoid the 'looks right cropped, garbage in-game' bug. Works on ${SPRITE_PLATFORMS}. ` +
    "Select pieces by `slots` (from inspectSprites/groupVisibleSprites) or a pixel `rect`; emits tiles + " +
    "palette + layout.json + a preview RE-RENDERED from the exported data (and platform-idiomatic C with " +
    "`emit:'c'|'both'`). Step to a frame where the character is fully visible first.",
    {
      platform: z.string().optional().describe(`Defaults to the loaded host. One of: ${SPRITE_PLATFORMS}.`),
      rect: z.object({ x: z.number().int(), y: z.number().int(), w: z.number().int().min(1), h: z.number().int().min(1) }).optional().describe("Select sprite entries whose on-screen bounds intersect this pixel rectangle. Mutually exclusive with `slots`."),
      slots: z.array(z.number().int().min(0)).optional().describe("Explicit OAM/SAT slot numbers. Mutually exclusive with `rect`."),
      includePartials: z.boolean().default(true).describe("With `rect`: include sprites only partially inside it."),
      name: z.string().default("metasprite").describe("Asset name — used in layout.json, filenames, and C identifiers."),
      emit: z.enum(["json", "c", "both"]).default("json").describe("'json' = tiles/palette/layout/preview only. 'c'|'both' also emit a platform-idiomatic C asset (<name>.h)."),
      outputDir: z.string().optional().describe("Absolute dir to write tiles.bin, palette.bin, palette.json, layout.json, preview.png (+ <name>.h). Without it, layout + base64 come back inline."),
    },
    safeTool(async ({ platform, rect, slots, includePartials, name, emit, outputDir }) => {
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
          nextStep: `Inspect ${paths.preview}. Re-verify any time with renderMetaSpritePreview (no rebuild). Include ${cSource ? paths.asset_h : `${paths.tiles} + ${paths.layout}`} in your project.`,
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
    }),
  );

  server.tool(
    "renderMetaSpritePreview",
    "Re-render a captured meta-sprite to a PNG from its tiles.bin + layout.json — WITHOUT rebuilding a ROM. Verifies a captureMetaSprite asset (or a hand-edited layout) reconstructs correctly. Works for all supported platforms (decodes tiles per the layout's platform/bpp).",
    {
      tilesPath: z.string().describe("Absolute path to tiles.bin."),
      layoutPath: z.string().describe("Absolute path to layout.json (carries platform, bpp, palettes, pieces)."),
      outputPath: z.string().optional().describe("If set, write the PNG here and return its path; else return inline."),
    },
    safeTool(async ({ tilesPath, layoutPath, outputPath }) => {
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
    }),
  );

  server.tool(
    "groupVisibleSprites",
    "Cluster the current frame's on-screen hardware sprites into likely objects (player / enemy / projectile / HUD) by spatial proximity, so you can pick a coherent character to feed into captureMetaSprite({slots:[...]}). Returns groups sorted largest-first. " +
    `Works on ${SPRITE_PLATFORMS}.`,
    {
      platform: z.string().optional().describe(`Defaults to the loaded host. One of: ${SPRITE_PLATFORMS}.`),
      rect: z.object({ x: z.number().int(), y: z.number().int(), w: z.number().int().min(1), h: z.number().int().min(1) }).optional().describe("Only consider sprites intersecting this pixel rectangle."),
      gap: z.number().int().min(0).default(8).describe("Max pixel gap between two sprites' bounds to join the same group. Larger = looser."),
    },
    safeTool(async ({ platform, rect, gap }) => {
      const host = getHost(sessionKey);
      const p = platform ?? host.status.platform;
      const { groupVisibleSprites } = await import("../../platforms/common/metasprite.js");
      const { groups } = await groupVisibleSprites(host, p, { rect, gap });
      return jsonContent({
        platform: p, groupCount: groups.length, groups,
        hint: groups.length
          ? `Pick a group → captureMetaSprite({platform:"${p}", slots:[${groups[0].slots.join(",")}], outputDir:"..."}). Sorted largest-first.`
          : "No on-screen sprites — step to a gameplay frame with the character visible, or widen `rect`.",
      });
    }),
  );

  server.tool(
    "previewVisibleSprites",
    "On the CURRENTLY LOADED ROM: cluster the on-screen sprites into objects (groupVisibleSprites), render a thumbnail of each group, and hand back a ready-to-paste captureMetaSprite call for each. The fast 'what's on screen and which group do I lift?' step — drive the ROM to a good frame yourself first, then call this. Works on genesis, snes, nes, gb, gbc, sms, gg. (No folder scanning — this is the loaded ROM only; finding/driving ROMs is your job.) " +
    "The grouping JSON (slots/bounds/capture call) is ALWAYS returned. DEFAULT writes each group's thumbnail PNG to outputDir/group-<i>.png and puts thumbnailPath in each group; pass inline:true to get the thumbnail images in the response (you must pass one or the other).",
    {
      platform: z.string().optional().describe(`Defaults to the loaded host. One of: ${SPRITE_PLATFORMS}.`),
      gap: z.number().int().min(0).default(8).describe("Clustering looseness — max px gap between sprites to join a group."),
      maxGroups: z.number().int().min(1).max(20).default(8).describe("Cap how many groups to render thumbnails for (largest-first)."),
      outputDir: z.string().optional().describe("Directory to write per-group thumbnail PNGs (group-<i>.png). Required unless inline:true."),
      inline: z.boolean().default(false).describe("If true, return the thumbnail images in the response instead of writing to disk. Default false — then outputDir is required."),
    },
    safeTool(async ({ platform, gap, maxGroups, outputDir, inline }) => {
      const host = getHost(sessionKey);
      const p = platform ?? host.status.platform;
      const { groupVisibleSprites, captureMetaSprite } = await import("../../platforms/common/metasprite.js");
      const { groups } = await groupVisibleSprites(host, p, { gap });
      if (!groups.length) {
        return jsonContent({ platform: p, groupCount: 0, note: "No on-screen sprites — step to a gameplay frame with the character visible." });
      }
      if (!inline && !outputDir) {
        throw new Error("previewVisibleSprites: pass outputDir (write per-group thumbnail PNGs to disk, returns thumbnailPath per group) or inline:true (return the thumbnails in the response).");
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
          capture: `captureMetaSprite({platform:"${p}", slots:[${g.slots.join(",")}], name:"<name>", emit:"both", outputDir:"..."})`,
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
    }),
  );

  server.tool(
    "extractSpriteFromScreenshot",
    "Isolate a sprite from a screenshot by cropping a region and flood-filling the background away. The LOSSY fallback for when captureMetaSprite can't be used (no clean SAT composition). Crops `crop`, removes background via 'edge-flood' (flood inward from the crop border — removes a background that touches the edges) or 'color' (everything near `bgColor`), and if you give a `seed` keeps only the connected sprite component containing it (drops other objects). Emits a transparent PNG + a debug PNG (kept = original, rejected = magenta) so you can tune `tolerance`. Prefer captureMetaSprite when sprite groups exist — this is the screenshot-crop escape hatch.",
    {
      pngPath: z.string().describe("Absolute path to the source screenshot PNG."),
      crop: z.object({ x: z.number().int().min(0), y: z.number().int().min(0), w: z.number().int().min(1), h: z.number().int().min(1) }).describe("Region to crop, in source-image pixels."),
      seed: z.object({ x: z.number().int().min(0), y: z.number().int().min(0) }).optional().describe("A point ON the sprite, in CROP-relative coords. If given, only the connected non-background component containing it is kept."),
      backgroundMode: z.enum(["edge-flood", "color"]).default("edge-flood").describe("'edge-flood' (default): flood inward from the crop border. 'color': remove everything near `bgColor` anywhere."),
      bgColor: z.array(z.number().int().min(0).max(255)).length(3).optional().describe("[r,g,b] background color for 'color' mode (defaults to the top-left crop pixel)."),
      tolerance: z.number().min(0).max(441).default(24).describe("Color-match tolerance (0-441). Raise if background pixels leak into the sprite; lower if sprite pixels get removed."),
      previewScale: z.number().int().min(1).max(8).default(1).describe("Integer upscale for the output + debug PNGs."),
      outputDir: z.string().optional().describe("Dir to write sprite.png + debug.png. Without it, both come back inline as base64."),
    },
    safeTool(async ({ pngPath, crop, seed, backgroundMode, bgColor, tolerance, previewScale, outputDir }) => {
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

  server.tool(
    "emitMetaSpriteRenderer",
    "Generate a platform-idiomatic C asset + draw helper from a captureMetaSprite layout (tiles.bin + palette.bin + layout.json). The emitted code matches the platform's sprite hardware: Genesis = SGDK VDP_setSprite chain; NES/GB/GBC = shadow-OAM cell tables; SNES = oamSet-ready pieces; SMS/GG = SAT cell tables. Use when you captured with emit:'json' and now want the C glue.",
    {
      tilesPath: z.string().describe("Absolute path to tiles.bin."),
      palettePath: z.string().describe("Absolute path to palette.bin."),
      layoutPath: z.string().describe("Absolute path to layout.json (its `platform` selects the emitter)."),
      name: z.string().optional().describe("C identifier base (defaults to the layout's name)."),
      outputPath: z.string().optional().describe("If set, write the .h here and return its path; else return source inline."),
    },
    safeTool(async ({ tilesPath, palettePath, layoutPath, name, outputPath }) => {
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
    }),
  );
}
