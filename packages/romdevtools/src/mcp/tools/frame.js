import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PNG } from "pngjs";
import { resamplePng } from "../../host/framebuffer.js";
import { getHost } from "../state.js";
import { imageContent, jsonContent, safeTool } from "../util.js";
import { decodeOAM, decodePpuRegs, ppuRegsPopulated } from "../../platforms/snes/ppu.js";
import { stepInstructionCore, attachObserverFrame } from "./watch-memory.js";
import { getRenderingContextCore } from "./rendering-context.js";
import { humanCoDriveWarning } from "./playtest.js";

// Normalize each platform's render-context into a CONSERVATIVE renderEnabled
// (true | false | null). null = "can't tell from the registers" — verify never
// asserts renderDisabled on null, so a platform we can't decode just relies on
// the pixel check. This is the cross-platform contract for frame({op:'verify'}).
function pickRenderFlags(ctx) {
  const p = ctx.platform;
  try {
    if (p === "nes") {
      const m = ctx.nes && ctx.nes.ppumask;
      if (!m) return { renderEnabled: null };
      return { renderEnabled: !!(m.bgVisible || m.spritesVisible) };
    }
    if (p === "snes") {
      const s = ctx.snes;
      if (!s || !s.ppuRegistersAvailable) return { renderEnabled: null }; // regs not live yet
      if (s.forcedBlank) return { renderEnabled: false };
      if (s.brightness === 0) return { renderEnabled: false };
      return { renderEnabled: true };
    }
    if (p === "genesis" || p === "megadrive" || p === "md") {
      return { renderEnabled: ctx.displayEnabled == null ? null : !!ctx.displayEnabled };
    }
    if (p === "sms" || p === "gg") {
      return { renderEnabled: ctx.screenEnabled == null ? null : !!ctx.screenEnabled };
    }
    if (p === "gb" || p === "gbc") {
      const l = ctx.gb && ctx.gb.lcdc ? ctx.gb.lcdc : ctx.lcdc;
      if (!l) return { renderEnabled: null };
      return { renderEnabled: !!l.lcdEnable };
    }
    if (p === "gba") {
      if (ctx.forcedBlank) return { renderEnabled: false };
      const anyBg = Array.isArray(ctx.displayBg) && ctx.displayBg.some(Boolean);
      return { renderEnabled: !!(anyBg || ctx.displayObj) };
    }
    if (p === "pce") {
      return { renderEnabled: ctx.screenEnabled == null ? null : !!ctx.screenEnabled };
    }
    if (p === "msx") {
      return { renderEnabled: ctx.screenEnabled == null ? null : !!ctx.screenEnabled };
    }
    // atari2600 / atari7800 / lynx: no single reliable display-enable bit — let
    // the pixel check carry it; don't false-assert.
    return { renderEnabled: null };
  } catch {
    return { renderEnabled: null };
  }
}

/**
 * Dominant-color fraction at/above which a screen reads as "blank" to a
 * human even though *something* technically rendered. Set to 0.92 (one color
 * filling >=92% of the screen) — empirically the perceptual threshold where a
 * backdrop-with-a-lone-sprite still looks empty. Below this, there's enough
 * on-screen content that a person sees a populated frame. (Truly one/two-color
 * frames are caught separately by the distinctColors<=1 blankScreen check.)
 */
const NEARLY_BLANK_DOMINANT = 0.92;

/**
 * The cross-platform render-health computation behind frame({op:'verify'}).
 * Exported so tests can drive it per platform without the MCP wrapper.
 * @returns plain object {verified, frame, platform, pixels, render, issues?, note}
 */
export async function computeVerify(host, frames, sessionKey) {
  const platform = host.status.platform;
  if (frames && frames > 0) host.stepFrames(frames);
  const frameCount = host.status.frameCount;

  // --- pixel content check (platform-agnostic) ---
  const { width, height, rgba } = host.screenshotRgba();
  const counts = new Map();
  const total = width * height;
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    const key = (rgba[i] << 16) | (rgba[i + 1] << 8) | rgba[i + 2];
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  let topColor = 0, topCount = 0;
  for (const [c, n] of counts) if (n > topCount) { topCount = n; topColor = c; }
  const distinctColors = counts.size;
  const dominantFraction = total ? topCount / total : 1;
  const nonDominant = total - topCount;
  const pixels = {
    width, height,
    distinctColors,
    dominantColor: "#" + topColor.toString(16).padStart(6, "0"),
    dominantPct: Math.round(dominantFraction * 1000) / 10,
    nonDominantPixels: nonDominant,
  };

  // --- render-enable / NMI verdict (reused, per-platform) ---
  let render;
  try {
    const ctx = await getRenderingContextCore({ platform, area: "all", sessionKey });
    render = { summary: ctx.summary || [], ...pickRenderFlags(ctx) };
  } catch (e) {
    render = { summary: [`(render-context decode unavailable for '${platform}': ${e.message})`], renderEnabled: null };
  }

  // --- frame-0 guard: report raw, no verdict (never cry wolf on boot) ---
  if (frameCount === 0) {
    return {
      verified: null, unsettled: true, frame: 0, platform,
      note: "No frame has been stepped yet — render state is the pre-boot default and not meaningful. " +
        "Step frames first (frame({op:'step'}) or pass `frames`), then verify.",
      pixels, render,
    };
  }

  // --- fuse into a verdict + issues[] ---
  const issues = [];
  if (distinctColors <= 1) {
    issues.push({ check: "blankScreen", detail: `the entire framebuffer is one color (${pixels.dominantColor}) — nothing is being drawn.` });
  } else if (dominantFraction >= NEARLY_BLANK_DOMINANT) {
    issues.push({ check: "nearlyBlank", detail: `${pixels.dominantPct}% of the screen is a single color (${pixels.dominantColor}); only ${nonDominant} px differ — a backdrop with almost no content reads as blank to a human even though something rendered. Add visible content (a tilemap/background, more sprites) until <${Math.round(NEARLY_BLANK_DOMINANT * 100)}% is one color.` });
  }
  if (render && render.renderEnabled === false) {
    issues.push({ check: "renderDisabled", detail: `display output is disabled per the ${platform} registers: ${render.summary[0] || "see render.summary"}.` });
  }

  const ok = issues.length === 0;
  return {
    verified: ok,
    frame: frameCount,
    platform,
    ...(ok
      ? { note: `Frame ${frameCount}: rendering looks alive (${distinctColors} colors, ${Math.round((100 - pixels.dominantPct) * 10) / 10}% of the screen is non-backdrop).` }
      : { issues, note: "Rendering looks broken — see issues[]. For per-platform thresholds + the full checklist, getPlatformDoc({platform, doc:'mental_model'})." }),
    pixels, render,
  };
}

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
      // Surface a co-drive conflict the moment the agent steps: a human
      // actively playing in the playtest window means this step raced their
      // real-time loop. Field only appears when the conflict is real.
      const coDrive = humanCoDriveWarning(sessionKey);
      return jsonContent({
        framesRun: n,
        frameCount: host.status.frameCount,
        framebuffer: { width: host.status.fbWidth, height: host.status.fbHeight },
        ...(coDrive ? { humanCoDriveWarning: coDrive } : {}),
      });
  }

  // Contract: an image goes to disk (path) OR comes back inline (inline:true).
  // No path + not inline → error. Keeps PNGs out of context unless asked for.
  function requireImageTarget(outPath, inline, tool) {
    if (!outPath && !inline) {
      throw new Error(`${tool}: pass path (write the image to disk, returns {path}) or inline:true (return the image in the response).`);
    }
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
    // Resample AFTER overlay so the boxes scale with the image. scale=1 (or
    // unset) is the native-resolution default; scale<1 is a downscaled shot
    // (~75% fewer image tokens for routine "did it change?" sanity checks),
    // scale>=2 is an integer up-scale so tiny handheld targets read legibly.
    const scaled = scale && scale !== 1;
    if (scaled) {
      const r = resamplePng(pngBase64, scale);
      pngBase64 = r.base64; width = r.width; height = r.height;
    }
    if (!inline) {
      await writeFile(outPath, Buffer.from(pngBase64, "base64"));
      const json = jsonContent({ path: outPath, width, height, ...(scaled ? { scale, fullWidth: shot.width, fullHeight: shot.height } : {}), overlay: overlayInfo });
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
        { type: "text", text: `framebuffer ${shot.width}x${shot.height}${scaled ? ` (scaled ${scale}x to ${width}x${height})` : ""}${overlayInfo ? ` (overlay: ${overlayInfo.spritesDrawn} sprites)` : ""} — also written to ${tempPath} (use this path for ImageMagick/crops; pass outputPath for a permanent location).` },
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

  // op:'verify' — one-call "did the game actually render / is it alive?" health
  // check for agents debugging WITHOUT vision. Fuses two independent signals:
  //   1. the render-enable/NMI verdict from getRenderingContext (per-platform
  //      register decode — already correct, reused not re-derived), and
  //   2. a pixel-level content check on the live framebuffer (is the screen
  //      actually showing more than one flat color?).
  // Frame-0 guard: before any frame is stepped, report the raw condition WITHOUT
  // an editorial verdict (so the header never "cries wolf" on boot).
  async function doVerify({ frames }) {
    const host = getHost(sessionKey);
    if (!host.status.platform || !host.status.loaded) {
      throw new Error("frame({op:'verify'}): no media loaded — loadMedia or build({output:'run'}) first.");
    }
    const json = jsonContent(await computeVerify(host, frames, sessionKey));
    // verify's whole job is "look at the screen" — so push the exact frame it
    // judged to the human's /livestream. Deferred provider: the PNG encode
    // happens async after the agent's (JSON-only) response goes out, at zero
    // cost to the agent. computeVerify already stepped the frames, so the
    // host's current framebuffer IS the verified frame.
    attachObserverFrame(json, host);
    return json;
  }

  async function doStepAndShot({ frames, path: outPath, inline }) {
      requireImageTarget(outPath, inline, "frame({op:'stepAndShot'})");
      const host = getHost(sessionKey);
      host.stepFrames(frames);
      const shot = host.screenshot();
      const coDrive = humanCoDriveWarning(sessionKey);
      if (!inline) {
        await writeFile(outPath, Buffer.from(shot.pngBase64, "base64"));
        const json = jsonContent({ path: outPath, frameCount: host.status.frameCount, width: shot.width, height: shot.height, ...(coDrive ? { humanCoDriveWarning: coDrive } : {}) });
        json._observerImages = [{ kind: "image", mimeType: "image/png", base64: shot.pngBase64 }];
        return json;
      }
      return {
        content: [
          imageContent(shot.pngBase64),
          { type: "text", text: `stepped ${frames} → frame ${host.status.frameCount} (${shot.width}x${shot.height})${coDrive ? `\nWARNING: ${coDrive}` : ""}` },
        ],
      };
  }

  server.tool(
    "frame",
    "Advance the emulator and capture frames. `op`: 'step' | 'screenshot' | 'stepAndShot' | 'stepInstruction' | 'verify'.\n" +
    "'step': advance N `frames` as fast as possible — NO pacing/audio/vsync. Cores run at WASM speed, so frames:3600 " +
    "(1 min of game time) finishes in ~5-30ms, cheaper than a screenshot. Don't be timid — skip a title with 300, a " +
    "level with 7200; prefer ONE big call.\n" +
    "'screenshot': capture the latest frame. `format:'png'` (default, exact colors) or `'ascii'` (lossy chafa text " +
    "render for agents that can't view images). `overlayBoxes` (png) draws a box per visible sprite (SNES+NES only); " +
"`scale` (png) resamples nearest-neighbor: 0<scale<1 DOWNscales (~75% fewer image tokens at 0.5 — the useful direction, for cheap 'did it change?' checks). integer scale≥2 UPscales (pixel-duplication, e.g. scale:4 → GB 160x144 → 640x576) — but this adds NO detail (it's the same pixels enlarged) and costs MORE image tokens; the native frame already has every pixel. Prefer scale:1 (default, native). Only upscale if YOUR client renders tiny images too small to be useful AND can't zoom — and know that VLM encoders resize to a fixed resolution anyway, so it may not change what the model sees (and can slightly degrade it). ascii cols/rows/symbols/colors knobs in the param hints. " +
    "**CHEAP VERIFY: for a binary pass/fail check (theme changed? sprite present? HUD ticked?) prefer scale:0.5 or " +
    "format:'ascii' — BETTER, read the byte directly: symbols({op:'resolve', name}) → memory({op:'read'}) is a 1-byte " +
    "assertion that costs zero image tokens.**\n" +
    "'stepAndShot': step + screenshot in ONE round-trip — the drive-then-look loop. (No overlayBoxes/scale here — png only.)\n" +
    "'stepInstruction': execute exactly ONE CPU instruction and stop (finer than 'step'); freezes the CPU one " +
    "instruction later and returns { pc }. Pair with cpu({op:'read'}) to watch registers change while tracing a routine.\n" +
    "'verify': one-call 'is the game actually rendering / alive?' health check WITHOUT vision — for the spiral where an " +
    "agent can't see the screen and doesn't know if a black frame means broken. Pass `frames` to boot-then-check in one " +
    "call. Fuses (1) a pixel-content scan of the live framebuffer (distinctColors, dominant-color %) and (2) the " +
    "per-platform render-ENABLE/NMI decode (reused from the rendering-context decoder — works on all 14 platforms). " +
    "Returns {verified:true|false|null, issues[], pixels, render}. verified:null + unsettled when no frame has been " +
    "stepped yet (it won't cry wolf on boot — step first). issues[] flags blankScreen/nearlyBlank/renderDisabled. " +
    "renderDisabled is only raised when the registers SAY so (never on an undecodable platform). Pass/fail with no " +
    "image tokens; for WHAT to fix, getPlatformDoc({platform, doc:'mental_model'}).\n" +
    "IMAGE CONTRACT (screenshot/stepAndShot): the image goes to `path` (default, returns {path}) OR inline:true — " +
    "you MUST pass one. Keeps PNGs out of context unless asked.",
    {
      op: z.enum(["step", "screenshot", "stepAndShot", "stepInstruction", "verify"]).describe("step frames; capture a screenshot; step+capture in one call; single-step one CPU instruction; or verify the game is actually rendering/alive (no vision needed)."),
      frames: z.number().int().min(1).max(1_000_000).default(1).describe("op=step/stepAndShot: frames to advance (1-1,000,000). 36000 (10 min) usually completes in <1s — don't be conservative."),
      format: z.enum(["png", "ascii"]).default("png").describe("op=screenshot: 'png' (default, real image) or 'ascii' (lossy text render)."),
      path: z.string().optional().describe("op=screenshot/stepAndShot: absolute path to write to (required unless inline:true)."),
      inline: z.boolean().default(false).describe("op=screenshot/stepAndShot: return the image in the response instead of writing to disk."),
      overlayBoxes: z.boolean().default(false).describe("op=screenshot png: draw a colored bounding box per visible sprite (SNES+NES only)."),
      scale: z.number().gt(0).max(16).refine((s) => s <= 1 || Number.isInteger(s), { message: "scale must be 0<scale≤1 (downscale) or an integer ≥2 (upscale)" }).optional().describe("op=screenshot png: nearest-neighbor resample factor. DEFAULT (unset/1) = NATIVE resolution — perfect pixels, the accurate representation; use this. 0<scale<1 DOWNscales (0.5 ≈ 75% fewer image tokens — useful for cheap 'did it change?' checks). integer scale≥2 UPscales by pixel-duplication (e.g. scale:4 → GB 160x144 → 640x576): it adds NO information (same pixels enlarged), costs MORE image tokens, and since VLM encoders resize to their own fixed resolution it may not change what the model sees and can slightly degrade it. Only for clients that render tiny images too small to use and can't zoom."),
      cols: z.number().int().min(4).max(640).optional().describe("op=screenshot ascii: terminal columns (default fb_width/16)."),
      rows: z.number().int().min(4).max(480).optional().describe("op=screenshot ascii: terminal rows (default fb_height/16)."),
      symbols: z.enum(["ascii", "halfblock", "block", "quad", "sextant"]).default("ascii").describe("op=screenshot ascii: chafa symbol set."),
      colors: z.enum(["true", "256", "16", "fgbg"]).default("true").describe("op=screenshot ascii: color depth."),
    },
    safeTool(async (args) => {
      switch (args.op) {
        case "step":            return doStep(args);
        case "screenshot":      return doScreenshot(args);
        case "stepAndShot":     return doStepAndShot(args);
        case "stepInstruction": return await stepInstructionCore(sessionKey);
        case "verify":          return await doVerify(args);
        default: throw new Error(`frame: unknown op '${args.op}'`);
      }
    }),
  );
}
