import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PNG } from "pngjs";
import { getHost } from "../state.js";
import { imageContent, jsonContent, safeTool } from "../util.js";
import { decodeOAM, decodePpuRegs, ppuRegsPopulated } from "../../platforms/snes/ppu.js";

// Get the platform's visible sprites in the generic shape, or null if
// not supported. Drives the screenshot overlay AND any future agents
// that want a one-call "what sprites are on screen right now."
function visibleSpritesFor(host, platform) {
  if (platform === "snes") {
    try {
      const oam = host.readMemory("snes_oam", 0, 544);
      const fillram = host.readMemory("snes_fillram", 0, 0x8000);
      const ppu = ppuRegsPopulated(fillram) ? decodePpuRegs(fillram) : null;
      const sprites = decodeOAM(oam, ppu ? {
        smallSize: ppu.objSize.small, largeSize: ppu.objSize.large,
        objNameBaseByte: ppu.objNameBaseByte, objGapByte: ppu.objGapByte,
      } : {});
      // Overlay only the truly renderable sprites — not every populated OAM
      // slot. Off-screen/hidden slots would clutter the screenshot with boxes
      // for sprites that aren't actually drawn.
      return sprites.filter((s) => s.renderable);
    } catch { return null; }
  }
  if (platform === "nes") {
    try {
      const oam = host.readMemory("nes_oam", 0, 256);
      const out = [];
      for (let i = 0; i < 64; i++) {
        const o = i * 4;
        const y = oam[o + 0];
        if (y >= 0xEF) continue; // NES "off-screen" Y
        out.push({
          slot: i, x: oam[o + 3], y, tile: oam[o + 1],
          size: { w: 8, h: 8 },
        });
      }
      return out;
    } catch { return null; }
  }
  return null;
}

/**
 * Decode a PNG, draw a colored 1-pixel rectangle for each sprite, and
 * re-encode. Sprite color is derived from slot so two sprites at the same
 * coords get distinguishable boxes. NES Y values are pre-incremented by
 * 1 (the convention from the hardware); we follow each platform's reading.
 */
function overlaySpriteBoxes(pngBase64, sprites, platform) {
  const buf = Buffer.from(pngBase64, "base64");
  const img = PNG.sync.read(buf);
  const W = img.width, H = img.height;
  // NES: Y in OAM is "actual Y - 1" — most modern emulators expose the
  // raw OAM byte. Add 1 to display the screen-pixel coord.
  const yShift = platform === "nes" ? 1 : 0;
  for (const s of sprites) {
    const x = s.x | 0;
    const y = (s.y | 0) + yShift;
    const w = s.size?.w ?? 8;
    const h = s.size?.h ?? 8;
    if (x >= W || y >= H || x + w <= 0 || y + h <= 0) continue;
    // Pick a distinguishable color per slot. HSV-ish via slot * 47 mod 360.
    const hue = (s.slot * 47) % 360;
    const [r, g, b] = hsvToRgb(hue / 360, 1, 1);
    drawRect(img.data, W, H, x, y, w, h, r, g, b);
  }
  return PNG.sync.write(img);
}

function drawRect(data, W, H, x, y, w, h, r, g, b) {
  const set = (px, py) => {
    if (px < 0 || px >= W || py < 0 || py >= H) return;
    const o = (py * W + px) * 4;
    data[o] = r; data[o + 1] = g; data[o + 2] = b; data[o + 3] = 0xFF;
  };
  for (let dx = 0; dx < w; dx++) {
    set(x + dx, y);
    set(x + dx, y + h - 1);
  }
  for (let dy = 0; dy < h; dy++) {
    set(x, y + dy);
    set(x + w - 1, y + dy);
  }
}

function hsvToRgb(h, s, v) {
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  let r = 0, g = 0, b = 0;
  switch (i % 6) {
    case 0: r = v; g = t; b = p; break;
    case 1: r = q; g = v; b = p; break;
    case 2: r = p; g = v; b = t; break;
    case 3: r = p; g = q; b = v; break;
    case 4: r = t; g = p; b = v; break;
    case 5: r = v; g = p; b = q; break;
  }
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

export function registerFrameTools(server, z, sessionKey) {
  server.tool(
    "stepFrames",
    "Advance emulation by N frames as fast as possible — NO real-time pacing, NO audio sync, NO vsync. Cores run at WASM speed: NES ~6-15k fps, SNES/Genesis ~2-5k fps, GB ~10k+ fps. That means stepFrames(3600) = 1 minute of game time in ~5-30ms (cheaper than a screenshot). Don't be timid: skip past title screens with stepFrames(300), advance through a level with stepFrames(7200) = 2 minutes, etc. Prefer ONE big call over many small ones. Returns the new frame count and framebuffer dimensions. Default 1 frame. TIP: if your very next call is a screenshot (the drive-then-look loop), use `stepAndScreenshot` instead to fold both into one round trip.",
    {
      frames: z.number().int().min(1).max(1_000_000).default(1).describe("Number of frames to step (1-1,000,000). Don't be conservative — 36000 frames (10 min) typically completes in <1s."),
    },
    safeTool(async ({ frames }) => {
      const host = getHost(sessionKey);
      const n = host.stepFrames(frames);
      return jsonContent({
        framesRun: n,
        frameCount: host.status.frameCount,
        framebuffer: { width: host.status.fbWidth, height: host.status.fbHeight },
      });
    }),
  );

  // Contract: an image goes to disk (path) OR comes back inline (inline:true).
  // No path + not inline → error. Keeps PNGs out of context unless asked for.
  function requireImageTarget(outPath, inline, tool) {
    if (!outPath && !inline) {
      throw new Error(`${tool}: pass path (write the image to disk, returns {path}) or inline:true (return the image in the response).`);
    }
  }

  // Nearest-neighbor downscale of a PNG by an integer divisor. Nearest-neighbor
  // (not averaging) is deliberate: it keeps pixel-art edges crisp and palette
  // colors exact, so a half-size sanity-check shot still reads accurately. The
  // PNG is fully decoded already (it's a tiny framebuffer), so this is cheap.
  function downscalePng(pngBase64, scale) {
    const src = PNG.sync.read(Buffer.from(pngBase64, "base64"));
    const dw = Math.max(1, Math.round(src.width * scale));
    const dh = Math.max(1, Math.round(src.height * scale));
    const dst = new PNG({ width: dw, height: dh });
    for (let y = 0; y < dh; y++) {
      const sy = Math.min(src.height - 1, Math.floor(y / scale));
      for (let x = 0; x < dw; x++) {
        const sx = Math.min(src.width - 1, Math.floor(x / scale));
        const si = (sy * src.width + sx) * 4;
        const di = (y * dw + x) * 4;
        dst.data[di] = src.data[si];
        dst.data[di + 1] = src.data[si + 1];
        dst.data[di + 2] = src.data[si + 2];
        dst.data[di + 3] = src.data[si + 3];
      }
    }
    return { base64: PNG.sync.write(dst).toString("base64"), width: dw, height: dh };
  }

  // PNG capture. Writes to outPath, or returns inline when `inline`.
  async function shootPng({ path: outPath, inline, overlayBoxes, scale }) {
    const host = getHost(sessionKey);
    const shot = host.screenshot();
    let pngBase64 = shot.pngBase64;
    let width = shot.width, height = shot.height;
    let overlayInfo = null;
    if (overlayBoxes) {
      const platform = host.status.platform;
      const sprites = visibleSpritesFor(host, platform);
      if (sprites) {
        const overlaid = overlaySpriteBoxes(pngBase64, sprites, platform);
        pngBase64 = overlaid.toString("base64");
        overlayInfo = { platform, spritesDrawn: sprites.length };
      } else {
        overlayInfo = { platform, spritesDrawn: 0, note: `overlay not yet supported for '${platform}'` };
      }
    }
    // Downscale AFTER overlay so the boxes scale with the image. scale=1 (or
    // unset) is the full-resolution default; a quarter-size shot is ~75%
    // fewer image tokens for routine "did it change?" sanity checks.
    if (scale && scale < 1) {
      const small = downscalePng(pngBase64, scale);
      pngBase64 = small.base64; width = small.width; height = small.height;
    }
    if (!inline) {
      await writeFile(outPath, Buffer.from(pngBase64, "base64"));
      const json = jsonContent({ path: outPath, width, height, ...(scale && scale < 1 ? { scale, fullWidth: shot.width, fullHeight: shot.height } : {}), overlay: overlayInfo });
      json._observerImages = [{ kind: "image", mimeType: "image/png", base64: pngBase64 }];
      return json;
    }
    // inline:true — ALSO write the PNG to a temp file so a follow-up crop/convert
    // (ImageMagick etc.) has a real path instead of ENOENT-ing on a base64 blob.
    // Path is stable per frame so repeated shots of the same frame don't pile up.
    const tempPath = path.join(tmpdir(), `romdev-shot-${host.status.platform ?? "rom"}-f${host.status.frameCount ?? 0}.png`);
    try { await writeFile(tempPath, Buffer.from(pngBase64, "base64")); } catch { /* best-effort; inline image is still returned */ }
    return {
      content: [
        imageContent(pngBase64),
        { type: "text", text: `framebuffer ${shot.width}x${shot.height}${scale && scale < 1 ? ` (scaled to ${width}x${height})` : ""}${overlayInfo ? ` (overlay: ${overlayInfo.spritesDrawn} sprites)` : ""} — also written to ${tempPath} (use this path for ImageMagick/crops; pass outputPath for a permanent location).` },
      ],
    };
  }

  // ASCII/ANSI capture.
  async function shootAscii({ cols, rows, symbols, colors, path: outPath, inline }) {
    const host = getHost(sessionKey);
    const { width, height, rgba } = host.screenshotRgba();
    // Default each cell to "2 game tiles" (8×8 platforms) so the grid maps
    // to tile coords: cell (c,r) covers tiles (c*2..c*2+1, r*2..r*2+1).
    if (cols == null) cols = Math.max(4, Math.floor(width / 16));
    if (rows == null) rows = Math.max(4, Math.floor(height / 16));
    const { renderRgbaToAnsi } = await import("../../host/chafa-render.js");
    const ansi = await renderRgbaToAnsi(rgba, width, height, { cols, rows, symbols, colors });
    // Livestream sidebands: the human sees BOTH the real PNG and the ANSI.
    const shot = host.screenshot();
    const observerSidebands = {
      _observerImages: [{ kind: "image", mimeType: "image/png", base64: shot.pngBase64 }],
      _observerAnsi: ansi,
    };
    let result;
    if (!inline) {
      await writeFile(outPath, ansi, "utf-8");
      result = jsonContent({ path: outPath, framebuffer: { width, height }, terminal: { cols, rows, symbols, colors }, ansiBytes: Buffer.byteLength(ansi, "utf-8") });
    } else {
      result = {
        content: [
          { type: "text", text: ansi },
          { type: "text", text: `framebuffer ${width}x${height} → terminal ${cols}x${rows} (${symbols}/${colors}, ${Buffer.byteLength(ansi, "utf-8")}B)` },
        ],
      };
    }
    Object.assign(result, observerSidebands);
    return result;
  }

  server.tool(
    "screenshot",
    "Use this to capture the latest frame. DEFAULT writes the image to `path` and returns `{path}` — pass " +
    "`inline:true` to get the image in the response instead (you MUST pass one or the other). `format:'png'` " +
    "(default) = real frame, exact colors; `format:'ascii'` = lossy chafa text render for agents that can't " +
    "view images. `overlayBoxes:true` (png) draws a colored box around each visible sprite (SNES+NES). ASCII " +
    "grid/symbol/color knobs are in the param hints. TIP: if you just stepped frames to reach this moment, " +
    "`stepAndScreenshot` does the step + this capture in one call — use it for the drive-then-look loop.",
    {
      format: z.enum(["png", "ascii"]).default("png").describe("'png' (default) = real image. 'ascii' = lossy text render for environments that can't show images."),
      path: z.string().optional().describe("Absolute path to write to (PNG bytes or ANSI text per format). Required unless inline:true."),
      inline: z.boolean().default(false).describe("If true, return the image/ANSI in the response instead of writing to disk. Default false — then `path` is required."),
      overlayBoxes: z.boolean().default(false).describe("png only: draw colored sprite-bounding-box overlays (SNES + NES; ignored elsewhere)."),
      scale: z.number().gt(0).max(1).optional().describe("png only: downscale factor (0<scale≤1) using nearest-neighbor (keeps pixel art crisp). e.g. 0.5 = quarter the pixels, ~75% fewer image tokens — ideal for routine 'did it change?' checks. Omit/1 = full resolution."),
      cols: z.number().int().min(4).max(640).optional().describe("ascii only: terminal columns. Default framebuffer_width/16 (1 char ≈ 2 game tiles)."),
      rows: z.number().int().min(4).max(480).optional().describe("ascii only: terminal rows. Default framebuffer_height/16."),
      symbols: z.enum(["ascii", "halfblock", "block", "quad", "sextant"]).default("ascii").describe("ascii only: chafa symbol set. 'ascii' (default) = pure ASCII; 'halfblock'/'quad'/'sextant' = denser, need Unicode."),
      colors: z.enum(["true", "256", "16", "fgbg"]).default("true").describe("ascii only: color depth. 'true' = 24-bit; '256'/'16' = palettes; 'fgbg' = mono shape."),
    },
    safeTool(async ({ format, path: outPath, inline, overlayBoxes, scale, cols, rows, symbols, colors }) => {
      requireImageTarget(outPath, inline, "screenshot");
      if (format === "ascii") return shootAscii({ cols, rows, symbols, colors, path: outPath, inline });
      return shootPng({ path: outPath, inline, overlayBoxes, scale });
    }),
  );


  server.tool(
    "stepAndScreenshot",
    "Step N frames, then capture a screenshot — one round-trip instead of two. Same output contract as " +
    "screenshot: DEFAULT writes the PNG to `path` and returns `{path}`; pass `inline:true` to get the image " +
    "in the response (you MUST pass one or the other).",
    {
      frames: z.number().int().min(1).max(1_000_000).default(1),
      path: z.string().optional().describe("Absolute path to write the PNG to. Required unless inline:true."),
      inline: z.boolean().default(false).describe("If true, return the image in the response instead of writing to disk. Default false — then `path` is required."),
    },
    safeTool(async ({ frames, path: outPath, inline }) => {
      requireImageTarget(outPath, inline, "stepAndScreenshot");
      const host = getHost(sessionKey);
      host.stepFrames(frames);
      const shot = host.screenshot();
      if (!inline) {
        await writeFile(outPath, Buffer.from(shot.pngBase64, "base64"));
        const json = jsonContent({ path: outPath, frameCount: host.status.frameCount, width: shot.width, height: shot.height });
        json._observerImages = [{ kind: "image", mimeType: "image/png", base64: shot.pngBase64 }];
        return json;
      }
      return {
        content: [
          imageContent(shot.pngBase64),
          { type: "text", text: `stepped ${frames} → frame ${host.status.frameCount} (${shot.width}x${shot.height})` },
        ],
      };
    }),
  );
}
