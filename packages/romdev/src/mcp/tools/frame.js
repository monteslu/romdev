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
  async function doStep({ frames }) {
      const host = getHost(sessionKey);
      const n = host.stepFrames(frames);
      return jsonContent({
        framesRun: n,
        frameCount: host.status.frameCount,
        framebuffer: { width: host.status.fbWidth, height: host.status.fbHeight },
      });
  }

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

  async function doScreenshot({ format, path: outPath, inline, overlayBoxes, scale, cols, rows, symbols, colors }) {
      requireImageTarget(outPath, inline, "frame({op:'screenshot'})");
      if (format === "ascii") return shootAscii({ cols, rows, symbols, colors, path: outPath, inline });
      return shootPng({ path: outPath, inline, overlayBoxes, scale });
  }

  async function doStepAndShot({ frames, path: outPath, inline }) {
      requireImageTarget(outPath, inline, "frame({op:'stepAndShot'})");
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
  }

  server.tool(
    "frame",
    "Advance the emulator and capture frames. `op`: 'step' | 'screenshot' | 'stepAndShot'.\n" +
    "'step': advance N `frames` as fast as possible — NO pacing/audio/vsync. Cores run at WASM speed (NES ~6-15k " +
    "fps, SNES/Genesis ~2-5k, GB ~10k+), so frames:3600 = 1 min of game time in ~5-30ms (cheaper than a " +
    "screenshot). Don't be timid — skip a title with 300, a level with 7200; prefer ONE big call.\n" +
    "'screenshot': capture the latest frame. `format:'png'` (default, exact colors) or `'ascii'` (lossy chafa text " +
    "render for agents that can't view images). `overlayBoxes` (png) draws a box per visible sprite (SNES+NES); " +
    "`scale` (0<≤1) downscales (~75% fewer image tokens at 0.5 for routine 'did it change?' checks); ascii cols/" +
    "rows/symbols/colors knobs in the param hints.\n" +
    "'stepAndShot': step + screenshot in ONE round-trip — the drive-then-look loop.\n" +
    "IMAGE CONTRACT (screenshot/stepAndShot): the image goes to `path` (default, returns {path}) OR inline:true — " +
    "you MUST pass one. Keeps PNGs out of context unless asked.",
    {
      op: z.enum(["step", "screenshot", "stepAndShot"]).describe("step frames; capture a screenshot; or step+capture in one call."),
      frames: z.number().int().min(1).max(1_000_000).default(1).describe("op=step/stepAndShot: frames to advance (1-1,000,000). Don't be conservative — 36000 (10 min) usually completes in <1s."),
      format: z.enum(["png", "ascii"]).default("png").describe("op=screenshot: 'png' (default, real image) or 'ascii' (lossy text render)."),
      path: z.string().optional().describe("op=screenshot/stepAndShot: absolute path to write to (required unless inline:true)."),
      inline: z.boolean().default(false).describe("op=screenshot/stepAndShot: return the image in the response instead of writing to disk."),
      overlayBoxes: z.boolean().default(false).describe("op=screenshot png: draw colored sprite-bounding-box overlays (SNES+NES)."),
      scale: z.number().gt(0).max(1).optional().describe("op=screenshot png: downscale factor (0<scale≤1, nearest-neighbor). 0.5 ≈ 75% fewer image tokens."),
      cols: z.number().int().min(4).max(640).optional().describe("op=screenshot ascii: terminal columns (default fb_width/16)."),
      rows: z.number().int().min(4).max(480).optional().describe("op=screenshot ascii: terminal rows (default fb_height/16)."),
      symbols: z.enum(["ascii", "halfblock", "block", "quad", "sextant"]).default("ascii").describe("op=screenshot ascii: chafa symbol set."),
      colors: z.enum(["true", "256", "16", "fgbg"]).default("true").describe("op=screenshot ascii: color depth."),
    },
    safeTool(async (args) => {
      switch (args.op) {
        case "step":        return doStep(args);
        case "screenshot":  return doScreenshot(args);
        case "stepAndShot": return doStepAndShot(args);
        default: throw new Error(`frame: unknown op '${args.op}'`);
      }
    }),
  );
}
