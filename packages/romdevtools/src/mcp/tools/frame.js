import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PNG } from "pngjs";
import { resamplePng } from "../../host/framebuffer.js";
import { getHost, getHostB } from "../state.js";
import { imageContent, jsonContent, safeTool } from "../util.js";
import { decodeOAM, decodePpuRegs, ppuRegsPopulated } from "../../platforms/snes/ppu.js";
import { stepInstructionCore, stepInstructionsCore, attachObserverFrame } from "./watch-memory.js";
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
  if (frames && frames > 0) await host.stepFrames(frames);
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

/**
 * Lightweight pixel summary of an RGBA framebuffer — the same dominant-color /
 * distinct-color scan computeVerify uses, factored out so sideBySide can report
 * a per-pane "is this side alive / how different is it" signal without the full
 * render-context decode. No host needed; pure pixels. Exported for tests.
 */
export function pixelSummary(width, height, rgba) {
  const counts = new Map();
  const total = width * height;
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    const key = (rgba[i] << 16) | (rgba[i + 1] << 8) | rgba[i + 2];
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  let topColor = 0, topCount = 0;
  for (const [c, n] of counts) if (n > topCount) { topCount = n; topColor = c; }
  const dominantFraction = total ? topCount / total : 1;
  return {
    width, height,
    distinctColors: counts.size,
    dominantColor: "#" + topColor.toString(16).padStart(6, "0"),
    dominantPct: Math.round(dominantFraction * 1000) / 10,
  };
}

/**
 * Composite two framebuffers into one PNG, A on the left and B on the right,
 * separated by a vertical divider. Panes are integer-upscaled to a shared
 * height (the taller of the two) so a small handheld next to a console reads at
 * a comparable size; the upscale is nearest-neighbor to keep pixels crisp. The
 * background fills any letterbox gaps. Returns the encoded PNG buffer.
 *
 * @param {{width:number,height:number,rgba:Uint8Array|Buffer}} a left pane
 * @param {{width:number,height:number,rgba:Uint8Array|Buffer}} b right pane
 * @param {number} gap divider width in px
 * Exported for tests.
 */
export function compositeSideBySide(a, b, gap = 4) {
  // Integer scale each pane up toward the common (max) height. Integer-only so
  // pixel art stays sharp; a pane that doesn't divide evenly is centered.
  const targetH = Math.max(a.height, b.height);
  const scaleFor = (h) => Math.max(1, Math.floor(targetH / h));
  const aScale = scaleFor(a.height);
  const bScale = scaleFor(b.height);
  const aW = a.width * aScale, aH = a.height * aScale;
  const bW = b.width * bScale, bH = b.height * bScale;
  const outH = Math.max(aH, bH);
  const outW = aW + gap + bW;
  const out = new PNG({ width: outW, height: outH });
  // Backdrop: a neutral dark gray so a black game frame is still distinguishable
  // from the canvas, and the divider reads.
  for (let i = 0; i < out.data.length; i += 4) {
    out.data[i] = 0x20; out.data[i + 1] = 0x20; out.data[i + 2] = 0x20; out.data[i + 3] = 0xFF;
  }
  const blit = (pane, scale, dstX, dstW, dstH) => {
    const offY = Math.floor((outH - dstH) / 2); // vertically center a shorter pane
    for (let y = 0; y < dstH; y++) {
      const srcY = Math.floor(y / scale);
      for (let x = 0; x < dstW; x++) {
        const srcX = Math.floor(x / scale);
        const s = (srcY * pane.width + srcX) * 4;
        const d = ((offY + y) * outW + (dstX + x)) * 4;
        out.data[d] = pane.rgba[s];
        out.data[d + 1] = pane.rgba[s + 1];
        out.data[d + 2] = pane.rgba[s + 2];
        out.data[d + 3] = 0xFF;
      }
    }
  };
  blit(a, aScale, 0, aW, aH);
  blit(b, bScale, aW + gap, bW, bH);
  return { buffer: PNG.sync.write(out), outW, outH, aScale, bScale };
}

export function registerFrameTools(server, z, sessionKey) {
  async function doStep({ frames }) {
      const host = getHost(sessionKey);
      // await: native-runtime hosts (jsgame) have an async stepFrames that yields for
      // the game's async work; awaiting a sync LibretroHost return is a harmless no-op.
      const n = await host.stepFrames(frames);
      // Surface a co-drive conflict the moment the agent steps: a human
      // actively playing in the playtest window means this step raced their
      // real-time loop. Field only appears when the conflict is real.
      const coDrive = humanCoDriveWarning(sessionKey);
      // Livestream: the post-step frame (throttled to 1/2s per tool by the bus).
      return attachObserverFrame(jsonContent({
        framesRun: n,
        frameCount: host.status.frameCount,
        framebuffer: { width: host.status.fbWidth, height: host.status.fbHeight },
        ...(coDrive ? { humanCoDriveWarning: coDrive } : {}),
      }), host, `step ×${n}`);
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
    // Default to ONE cell per 8×8 tile (so a 256×224 NES frame → 32×28, legible
    // game state). The old /16 default (16×14 for NES) was too coarse to read
    // anything — feedback 0.44.0 #1. The terminal symbol's own subcell shape adds
    // detail back, so this stays cheap.
    if (cols == null) cols = Math.max(8, Math.floor(width / 8));
    if (rows == null) rows = Math.max(8, Math.floor(height / 8));
    // Warn when the caller forced a grid so coarse it can't show game state.
    const tooCoarse = cols < Math.floor(width / 8) / 2 || rows < Math.floor(height / 8) / 2;
    const { renderRgbaToAnsi } = await import("../../host/chafa-render.js");
    const ansi = await renderRgbaToAnsi(rgba, width, height, { cols, rows, symbols, colors });
    // Livestream sidebands: the human sees BOTH the real PNG and the ANSI.
    const shot = host.screenshot();
    const observerSidebands = {
      _observerImages: [{ kind: "image", mimeType: "image/png", base64: shot.pngBase64 }],
      _observerAnsi: ansi,
    };
    const coarseNote = tooCoarse
      ? `NOTE: ${cols}x${rows} is too coarse to read game state from this ${width}x${height} frame. `
        + `For a pass/fail check ("are we in gameplay?"), a memory({op:'read'}) byte assertion is cheaper and exact — `
        + `ascii is for a rough visual, not state.`
      : null;
    let result;
    if (!inline) {
      await writeFile(outPath, ansi, "utf-8");
      result = jsonContent({ path: outPath, framebuffer: { width, height }, terminal: { cols, rows, symbols, colors }, ansiBytes: Buffer.byteLength(ansi, "utf-8"), ...(coarseNote ? { note: coarseNote } : {}) });
    } else {
      result = {
        content: [
          { type: "text", text: ansi },
          { type: "text", text: `framebuffer ${width}x${height} → terminal ${cols}x${rows} (${symbols}/${colors}, ${Buffer.byteLength(ansi, "utf-8")}B)` + (coarseNote ? `\n${coarseNote}` : "") },
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

  // op:'sideBySide' — capture BOTH hosts (slot A + slot B) into one composited
  // PNG, A left, B right. The two-cores-in-one-call capture for the port-compare
  // loop: load the original in slot A, the port in slot B, step both the same N
  // frames, and look at them together. Also returns a per-pane pixel summary so
  // a no-vision agent gets a structured "both alive? how different?" signal.
  async function doSideBySide({ frames, path: outPath, inline }) {
    requireImageTarget(outPath, inline, "frame({op:'sideBySide'})");
    const hostA = getHost(sessionKey);   // throws with slot-A recovery guidance
    const hostB = getHostB(sessionKey);  // throws with "load slot B" guidance
    if (frames && frames > 0) {
      // Step both the same amount so the comparison is at the same game time.
      hostA.stepFrames(frames);
      hostB.stepFrames(frames);
    }
    const a = hostA.screenshotRgba();
    const b = hostB.screenshotRgba();
    const { buffer, outW, outH, aScale, bScale } = compositeSideBySide(a, b);
    const pngBase64 = buffer.toString("base64");
    const panes = {
      a: { platform: hostA.status.platform, frame: hostA.status.frameCount, scale: aScale, ...pixelSummary(a.width, a.height, a.rgba) },
      b: { platform: hostB.status.platform, frame: hostB.status.frameCount, scale: bScale, ...pixelSummary(b.width, b.height, b.rgba) },
    };
    if (!inline) {
      await writeFile(outPath, buffer);
      const json = jsonContent({ path: outPath, width: outW, height: outH, layout: "A|B", panes });
      // Show the human the composite (not either raw pane) on the livestream.
      json._observerImages = [{ kind: "image", mimeType: "image/png", base64: pngBase64 }];
      return json;
    }
    const tempPath = path.join(tmpdir(), `romdev-sidebyside-${hostA.status.platform ?? "a"}-vs-${hostB.status.platform ?? "b"}.png`);
    try { await writeFile(tempPath, buffer); } catch { /* best-effort */ }
    return {
      content: [
        imageContent(pngBase64),
        { type: "text", text: `side-by-side ${outW}x${outH} — left: ${panes.a.platform} @frame ${panes.a.frame} (${panes.a.distinctColors} colors), right: ${panes.b.platform} @frame ${panes.b.frame} (${panes.b.distinctColors} colors). Also written to ${tempPath}.` },
      ],
      _observerImages: [{ kind: "image", mimeType: "image/png", base64: pngBase64 }],
    };
  }

  // op:'compareRam' — the RAM-diff oracle. The STATE-level sibling of
  // sideBySide: instead of comparing pixels, compare the work-RAM of slot A
  // (the original) and slot B (the port) at the same game-moment. This is how a
  // logic port is proven correct INDEPENDENT of graphics — if the two machines'
  // RAM matches, the game logic is running identically even when one renders
  // blank (no PPU shim yet).
  //
  // Designed for a "smart-enough, not frontier" agent: it does the byte-compare
  // MECHANICALLY and returns a DIGESTED verdict — a match %, the diverging
  // address RANGES (run-length-encoded, not raw bytes), and plain-language
  // guidance — so the agent gets "addresses $0300-$0312 differ, likely your
  // sprite table" instead of two 2KB hex blobs to eyeball.
  // Core RAM comparison between the two slots for one region. Returns the raw
  // numbers + RLE ranges; the op wrappers add verdict text. Shared by
  // compareRam and portStatus. Throws if either slot lacks the region.
  function computeRamMatch(region) {
    const hostA = getHost(sessionKey);
    const hostB = getHostB(sessionKey);
    const sizeA = hostA.regionSize ? hostA.regionSize(region) : 0;
    const sizeB = hostB.regionSize ? hostB.regionSize(region) : 0;
    if (!sizeA || !sizeB) {
      throw new Error(`region '${region}' not available on ${!sizeA ? "slot A (" + hostA.status.platform + ")" : "slot B (" + hostB.status.platform + ")"}. Both hosts must expose it; 'system_ram' is the portable default.`);
    }
    const len = Math.min(sizeA, sizeB);
    const a = hostA.readMemory(region, 0, len);
    const b = hostB.readMemory(region, 0, len);
    const ranges = [];
    let diffBytes = 0;
    let runStart = -1;
    for (let i = 0; i < len; i++) {
      const differ = a[i] !== b[i];
      if (differ) {
        diffBytes++;
        if (runStart < 0) runStart = i;
      } else if (runStart >= 0) {
        ranges.push({ start: runStart, end: i - 1, length: i - runStart });
        runStart = -1;
      }
    }
    if (runStart >= 0) ranges.push({ start: runStart, end: len - 1, length: len - runStart });
    const matchPct = len ? Math.round(((len - diffBytes) / len) * 1000) / 10 : 100;
    return { sizeA, sizeB, len, a, b, ranges, diffBytes, matchPct };
  }

  function compareRam({ region = "system_ram", frames, maxRanges = 24 }) {
    const hostA = getHost(sessionKey);
    const hostB = getHostB(sessionKey);
    if (frames && frames > 0) { hostA.stepFrames(frames); hostB.stepFrames(frames); }

    let m;
    try { m = computeRamMatch(region); }
    catch (e) { throw new Error(`frame({op:'compareRam'}): ${e.message}`); }
    const { sizeA, sizeB, len, a, b, ranges, diffBytes, matchPct } = m;
    // Keep the biggest diverging spans (most informative), cap the list.
    const sorted = [...ranges].sort((x, y) => y.length - x.length);
    const shown = sorted.slice(0, maxRanges).map((r) => ({
      range: `$${r.start.toString(16).toUpperCase().padStart(4, "0")}-$${r.end.toString(16).toUpperCase().padStart(4, "0")}`,
      bytes: r.length,
      // a tiny sample so the agent can sanity-check WITHOUT a separate read
      a: Buffer.from(a.subarray(r.start, Math.min(r.start + 4, r.end + 1))).toString("hex"),
      b: Buffer.from(b.subarray(r.start, Math.min(r.start + 4, r.end + 1))).toString("hex"),
    }));

    const verdict =
      diffBytes === 0
        ? "IDENTICAL — slot A and slot B work-RAM match byte-for-byte. The port's logic is running exactly like the original at this moment."
        : matchPct >= 95
          ? `CLOSE (${matchPct}% match) — logic is largely tracking; ${ranges.length} diverging span(s). Inspect the ranges below (often graphics/timing scratch that doesn't affect logic). Read a range with memory({op:'read', region, offset}) on each slot to dig in.`
          : `DIVERGED (${matchPct}% match) — the port's logic is NOT tracking the original. Step both from a known-identical point (state restore), then compareRam after a few frames to find WHERE they split. The first diverging span is usually the root cause.`;

    return jsonContent({
      op: "compareRam",
      region,
      a: { platform: hostA.status.platform, frame: hostA.status.frameCount, bytes: sizeA },
      b: { platform: hostB.status.platform, frame: hostB.status.frameCount, bytes: sizeB },
      comparedBytes: len,
      matchPct,
      identical: diffBytes === 0,
      divergingBytes: diffBytes,
      divergingSpans: ranges.length,
      ranges: shown,
      ...(ranges.length > shown.length ? { rangesOmitted: ranges.length - shown.length } : {}),
      note: verdict,
    });
  }

  // op:'findDiverge' — the ROOT-CAUSE finder. compareRam tells you slot A and
  // slot B differ; this tells you EXACTLY WHEN and WHERE they first split. It
  // snapshots both hosts, steps them in lockstep, and reports the first frame at
  // which the work-RAM diverges + the first diverging byte address. A
  // smart-enough agent shouldn't binary-search frames by hand — the tool does
  // the search and hands back "frame 47, $0312 (A=05 B=07): that's where your
  // port's logic split from the original."
  //
  // Both hosts' MACHINE STATE (RAM/CPU/PPU) is restored to the pre-search point
  // afterward via unserializeState, so the agent keeps working from where it was.
  // (The frameCount COUNTER keeps climbing — a known core behavior of
  // unserializeState — but the actual emulated state is rewound.)
  function findDiverge({ region = "system_ram", maxFrames = 600 }) {
    const hostA = getHost(sessionKey);
    const hostB = getHostB(sessionKey);
    const sizeA = hostA.regionSize ? hostA.regionSize(region) : 0;
    const sizeB = hostB.regionSize ? hostB.regionSize(region) : 0;
    if (!sizeA || !sizeB) {
      throw new Error(`frame({op:'findDiverge'}): region '${region}' not available on ${!sizeA ? "slot A (" + hostA.status.platform + ")" : "slot B (" + hostB.status.platform + ")"}. Both hosts must expose it; 'system_ram' is the portable default.`);
    }
    const len = Math.min(sizeA, sizeB);
    // Save both so the search is non-destructive.
    const saveA = hostA.serializeState();
    const saveB = hostB.serializeState();
    const startFrameA = hostA.status.frameCount;

    const firstDiff = () => {
      const a = hostA.readMemory(region, 0, len);
      const b = hostB.readMemory(region, 0, len);
      for (let i = 0; i < len; i++) if (a[i] !== b[i]) return { offset: i, a: a[i], b: b[i] };
      return null;
    };

    let result;
    // If they already differ at frame 0, that IS the divergence point.
    let cur = firstDiff();
    if (cur) {
      result = { diverged: true, atFrame: 0, framesStepped: 0, offset: cur.offset, a: cur.a, b: cur.b };
    } else {
      // Step in lockstep, one frame at a time, until the first split or maxFrames.
      let stepped = 0;
      let found = null;
      for (let f = 1; f <= maxFrames; f++) {
        hostA.stepFrames(1);
        hostB.stepFrames(1);
        stepped = f;
        cur = firstDiff();
        if (cur) { found = { atFrame: f, offset: cur.offset, a: cur.a, b: cur.b }; break; }
      }
      result = found
        ? { diverged: true, atFrame: found.atFrame, framesStepped: stepped, offset: found.offset, a: found.a, b: found.b }
        : { diverged: false, framesStepped: stepped };
    }

    // Restore both hosts to where they were before the search.
    try { hostA.unserializeState(saveA); } catch { /* best-effort */ }
    try { hostB.unserializeState(saveB); } catch { /* best-effort */ }

    const addrHex = result.offset != null ? "$" + result.offset.toString(16).toUpperCase().padStart(4, "0") : null;
    return jsonContent({
      op: "findDiverge",
      region,
      a: { platform: hostA.status.platform },
      b: { platform: hostB.status.platform },
      searchStartedAtFrame: startFrameA,
      ...result,
      ...(addrHex ? { address: addrHex } : {}),
      note: result.diverged
        ? `First divergence at frame ${result.atFrame} (relative to search start), address ${addrHex}: slot A = $${result.a.toString(16).padStart(2, "0")}, slot B = $${result.b.toString(16).padStart(2, "0")}. This is where the port's logic first split from the original — decompile/disasm around the code that writes ${addrHex} on BOTH sides to find why. Both hosts' machine state (RAM/CPU/PPU) restored to the pre-search point.`
        : `No divergence in ${result.framesStepped} frames — the port's logic tracks the original across this window. Step further or raise maxFrames if you expect a later split. Both hosts' machine state restored to the pre-search point.`,
    });
  }

  // op:'compareRender' — the PRESENTATION oracle. The graphics-side sibling of
  // compareRam: instead of bytes, compare the decoded RENDERING STATE of slot A
  // (original) vs slot B (port) — "BG enabled? which tilemap/palette? sprites
  // on? forced blank?" This is what an agent building/tuning the graphics shim
  // needs: it says exactly WHAT the port's presentation is missing vs. the
  // original, in plain terms, without the agent decoding registers by hand.
  //
  // Works cross-platform: each side is decoded by its own platform's
  // rendering-context decoder (NES PPU, SNES PPU, Genesis VDP, ...), then the
  // human-readable `summary` lines are diffed. Same-platform ports get a literal
  // line diff; cross-platform ports get both summaries side by side (the agent
  // maps concepts, since e.g. "BG1 tile base" has no NES equivalent).
  async function compareRender({ frames }) {
    const hostA = getHost(sessionKey);
    const hostB = getHostB(sessionKey);
    if (frames && frames > 0) { hostA.stepFrames(frames); hostB.stepFrames(frames); }
    const platA = hostA.status.platform;
    const platB = hostB.status.platform;
    let ctxA, ctxB;
    try { ctxA = await getRenderingContextCore({ platform: platA, area: "all", host: hostA }); }
    catch (e) { ctxA = { platform: platA, summary: [`(render-context decode unavailable: ${e.message})`] }; }
    try { ctxB = await getRenderingContextCore({ platform: platB, area: "all", host: hostB }); }
    catch (e) { ctxB = { platform: platB, summary: [`(render-context decode unavailable: ${e.message})`] }; }

    const sumA = Array.isArray(ctxA.summary) ? ctxA.summary : [];
    const sumB = Array.isArray(ctxB.summary) ? ctxB.summary : [];
    const samePlatform = platA === platB;

    let lineDiff = null;
    if (samePlatform) {
      // Literal line diff: what the original shows that the port doesn't (and vice versa).
      const setB = new Set(sumB);
      const setA = new Set(sumA);
      lineDiff = {
        onlyInOriginal: sumA.filter((l) => !setB.has(l)),
        onlyInPort: sumB.filter((l) => !setA.has(l)),
        matching: sumA.filter((l) => setB.has(l)).length,
      };
    }

    // Per-slot render-enable verdict (reuse the same logic verify uses).
    const flagsA = pickRenderFlags(ctxA);
    const flagsB = pickRenderFlags(ctxB);

    const note = samePlatform
      ? (lineDiff.onlyInOriginal.length === 0 && lineDiff.onlyInPort.length === 0
          ? "Rendering state MATCHES — same platform, identical decoded render context. The port's presentation tracks the original."
          : `Rendering differs: ${lineDiff.onlyInOriginal.length} aspect(s) the ORIGINAL has that the port lacks (see onlyInOriginal — that's your shim's TODO list), ${lineDiff.onlyInPort.length} the port has extra. Fix the port until onlyInOriginal is empty.`)
      : `Cross-platform port (${platA}→${platB}): the two render models differ by hardware, so compare the summaries conceptually. originalRenderEnabled=${flagsA.renderEnabled}, portRenderEnabled=${flagsB.renderEnabled}. If the original renders and the port is forced-blank/disabled, the graphics shim hasn't enabled output yet — that's step one.`;

    return jsonContent({
      op: "compareRender",
      a: { platform: platA, renderEnabled: flagsA.renderEnabled, summary: sumA },
      b: { platform: platB, renderEnabled: flagsB.renderEnabled, summary: sumB },
      samePlatform,
      ...(lineDiff ? { diff: lineDiff } : {}),
      note,
    });
  }

  // op:'portStatus' — the CAPSTONE. One call that runs all the compare signals
  // (logic via RAM, presentation via render state, pixels via the content scan)
  // and returns a SINGLE digested "state of your port" verdict with the next
  // concrete action. For a smart-enough agent this collapses "which of the 4
  // oracles do I run, in what order, and how do I read them together?" into one
  // answer: "logic matches 100%, but the port renders blank → build the graphics
  // shim; start by enabling display output."
  async function portStatus({ frames, region = "system_ram" }) {
    const hostA = getHost(sessionKey);
    const hostB = getHostB(sessionKey);
    if (frames && frames > 0) { hostA.stepFrames(frames); hostB.stepFrames(frames); }

    // 1. Logic (RAM) — only meaningful for a SAME-platform port (cross-platform
    //    RAM layouts differ, so a byte diff there isn't a logic verdict).
    const samePlatform = hostA.status.platform === hostB.status.platform;
    let logic = null;
    if (samePlatform) {
      try {
        const m = computeRamMatch(region);
        logic = { region, matchPct: m.matchPct, identical: m.diffBytes === 0, divergingBytes: m.diffBytes, divergingSpans: m.ranges.length };
      } catch (e) { logic = { error: e.message }; }
    }

    // 2. Presentation (render state) — per-side render-enable.
    let renderA, renderB;
    try { renderA = pickRenderFlags(await getRenderingContextCore({ platform: hostA.status.platform, area: "all", host: hostA })); }
    catch { renderA = { renderEnabled: null }; }
    try { renderB = pickRenderFlags(await getRenderingContextCore({ platform: hostB.status.platform, area: "all", host: hostB })); }
    catch { renderB = { renderEnabled: null }; }

    // 3. Pixels — is each side drawing more than a flat color?
    const pxA = pixelSummary(...rgbaTriple(hostA));
    const pxB = pixelSummary(...rgbaTriple(hostB));
    const aliveA = pxA.distinctColors > 2 && pxA.dominantPct < 99;
    const aliveB = pxB.distinctColors > 2 && pxB.dominantPct < 99;

    // Fuse into a single next-action verdict.
    let verdict, nextAction;
    if (samePlatform && logic && logic.identical) {
      if (aliveB) { verdict = "PORT LOOKS COMPLETE"; nextAction = "Logic matches byte-for-byte AND the port renders. Spot-check with frame({op:'sideBySide'}) and move on."; }
      else { verdict = "LOGIC DONE, PRESENTATION MISSING"; nextAction = "RAM matches the original exactly — the game logic is correct. The port renders blank: build/finish the graphics shim. Start with frame({op:'compareRender'}) to see what the original enables that the port doesn't."; }
    } else if (samePlatform && logic && !logic.error) {
      verdict = `LOGIC DIVERGED (${logic.matchPct}% RAM match)`;
      nextAction = "The port's logic is NOT tracking the original. Run frame({op:'findDiverge'}) from a known-identical point to get the first frame+address where they split, then breakpoint({on:'write', address}) on each slot to compare the code.";
    } else {
      // cross-platform — RAM diff isn't a logic verdict; lean on render + pixels.
      verdict = "CROSS-PLATFORM PORT";
      nextAction = aliveB
        ? "Both sides render — compare visually with frame({op:'sideBySide'}) and the decoded state with frame({op:'compareRender'}). RAM can't be byte-compared across different hardware."
        : "The port renders blank while the original draws. The graphics shim hasn't enabled output — frame({op:'compareRender'}) shows what to turn on. Verify logic another way (the recompiled CPU should be running even when blank).";
    }

    return jsonContent({
      op: "portStatus",
      a: { platform: hostA.status.platform, frame: hostA.status.frameCount, renderEnabled: renderA.renderEnabled, pixelsAlive: aliveA },
      b: { platform: hostB.status.platform, frame: hostB.status.frameCount, renderEnabled: renderB.renderEnabled, pixelsAlive: aliveB },
      samePlatform,
      ...(logic ? { logic } : {}),
      verdict,
      nextAction,
    });
  }

  // Small helper: framebuffer RGBA as the (w,h,rgba) triple pixelSummary wants.
  function rgbaTriple(host) {
    const s = host.screenshotRgba();
    return [s.width, s.height, s.rgba];
  }

  async function doStepAndShot({ frames, path: outPath, inline }) {
      requireImageTarget(outPath, inline, "frame({op:'stepAndShot'})");
      const host = getHost(sessionKey);
      await host.stepFrames(frames);
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
    "Advance the emulator and capture frames. `op`: 'step' | 'screenshot' | 'stepAndShot' | 'sideBySide' | 'compareRam' | 'findDiverge' | 'compareRender' | 'portStatus' | 'stepInstruction' | 'verify'.\n" +
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
    "'sideBySide': capture BOTH hosts (slot A + the slot-B comparison host) into ONE composited PNG — A left, B right, " +
    "divider between. The two-cores-in-one-call capture for the original-vs-port compare loop: loadMedia the original " +
    "in slot A, loadMedia({slot:'b'}) the port, then frame({op:'sideBySide', frames}) steps BOTH the same N frames and " +
    "shows them together. Panes are integer-upscaled to a shared height so a handheld next to a console reads at a " +
    "comparable size. Returns per-pane {platform, frame, distinctColors, dominantColor, dominantPct} so a no-vision " +
    "agent still gets a structured 'are both alive / how different' signal. Requires a ROM in slot B (loadMedia({slot:'b'})). " +
    "Same image contract as screenshot (path or inline:true).\n" +
    "'compareRam': the RAM-diff ORACLE — the STATE-level sibling of sideBySide. Compares the work-RAM (`region`, default " +
    "'system_ram') of slot A vs slot B at the same game-moment to prove a logic PORT is correct INDEPENDENT of graphics " +
    "(matching RAM = identical logic even when the port renders blank). Returns a DIGESTED verdict: matchPct, " +
    "identical, and the diverging address RANGES run-length-encoded with a 4-byte sample of each side (NOT raw byte " +
    "dumps) so even a small model gets '$0300-$0312 differ' not two hex blobs. Workflow: state-restore both to an " +
    "identical point, step both N frames, compareRam — the FIRST diverging span is usually the bug. Requires slot B.\n" +
    "'findDiverge': the ROOT-CAUSE finder built ON compareRam — where compareRam says THAT they differ, this says exactly " +
    "WHEN and WHERE. Snapshots both slots, steps them in lockstep up to `maxFrames`, and reports the first frame + first " +
    "byte address at which the work-RAM splits ({atFrame, address, a, b}). Non-destructive: both hosts are RESTORED to " +
    "their pre-search state. Run it from a known-identical point (state-restore both first) so 'first split' is meaningful. " +
    "The agent then disasms the code that writes that address on both sides. Requires slot B.\n" +
    "'compareRender': the PRESENTATION oracle — compare the decoded RENDERING STATE of slot A vs slot B (BG/sprites " +
    "enabled? which tilemap/palette? forced blank?) instead of bytes. This is what an agent building/tuning the graphics " +
    "shim needs: it says in plain terms WHAT the port's presentation is missing vs. the original. Same-platform ports get " +
    "a line diff (onlyInOriginal = your shim's TODO); cross-platform ports get both summaries + each side's renderEnabled " +
    "verdict. Requires slot B.\n" +
    "'portStatus': the CAPSTONE — ONE call that fuses logic (RAM), presentation (render state), and pixels into a single " +
    "'state of your port' verdict + the next concrete action (e.g. 'LOGIC DONE, PRESENTATION MISSING → build the graphics " +
    "shim, start with compareRender'). Use this FIRST when working a port to know what to do next; drill in with the " +
    "specific compare ops. Requires slot B.\n" +
    "'stepInstruction': execute exactly ONE CPU instruction and stop (finer than 'step'); freezes the CPU one " +
    "instruction later and returns { pc }. Pair with cpu({op:'read'}) to watch registers change while tracing a routine.\n" +
    "'stepInstructions': BULK single-step — execute `count` instructions and return an ORDERED `trace:[{pc, width, bytes}]` " +
    "in ONE call (the `note` boilerplate emitted once, not per entry). `width` = PC[k+1]-PC[k], so immediate widths are " +
    "visible directly — the 65816 `.a8` vs `.i16` case (a 2-byte lda #imm8 vs a 3-byte ldx #imm16 shows up only as the PC " +
    "delta), which is what confirms a routine's boundaries when static da65 floored the bank to `.byte`. `withRegisters:true` " +
    "adds the register file at each step. This collapses the ~1-round-trip-per-instruction cost of tracing a routine.\n" +
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
      op: z.enum(["step", "screenshot", "stepAndShot", "sideBySide", "compareRam", "findDiverge", "compareRender", "portStatus", "stepInstruction", "stepInstructions", "verify"]).describe("step frames; capture a screenshot; step+capture in one call; capture both hosts side-by-side (A|B); compareRam = diff slot-A vs slot-B work-RAM (the logic-port oracle); findDiverge = find the first frame+byte where the two slots split (root-cause finder); compareRender = diff the decoded rendering state of the two slots (the presentation oracle); portStatus = ONE fused 'state of your port' verdict + next action (the capstone); single-step one CPU instruction; stepInstructions = bulk single-step N instructions into one ordered trace; or verify the game is actually rendering/alive (no vision needed)."),
      count: z.number().int().min(1).max(4096).default(16).describe("op=stepInstructions: how many CPU instructions to single-step into the trace (default 16, max 4096)."),
      withRegisters: z.boolean().default(false).describe("op=stepInstructions: include the CPU register file at each step (heavier payload; omit if you only need pc/width/bytes for boundary+immediate-width analysis)."),
      stepFormat: z.enum(["full", "compact"]).default("full").describe("op=stepInstructions: 'full' = per-step objects (pc/flow/width/nextPc); 'compact' = one string per step (`$PC flow->$target`) + a `pcRanges` loop-map with hit counts (~90% fewer tokens for triage)."),
      frames: z.number().int().min(1).max(1_000_000).default(1).describe("op=step/stepAndShot/sideBySide/compareRam/compareRender: frames to advance (1-1,000,000). For the slot-A/B compare ops, BOTH hosts step the same amount. 36000 (10 min) usually completes in <1s — don't be conservative."),
      region: z.string().optional().describe("op=compareRam/findDiverge/portStatus: memory region to diff across the two slots (default 'system_ram', the portable work-RAM). Both hosts must expose it."),
      maxRanges: z.number().int().min(1).max(256).default(24).describe("op=compareRam: cap on the diverging address ranges returned (largest first)."),
      maxFrames: z.number().int().min(1).max(100000).default(600).describe("op=findDiverge: max frames to step in lockstep looking for the first divergence (default 600 = ~10s)."),
      format: z.enum(["png", "ascii"]).default("png").describe("op=screenshot: 'png' (default, real image) or 'ascii' (lossy text render)."),
      path: z.string().optional().describe("op=screenshot/stepAndShot: absolute path to write to (required unless inline:true)."),
      inline: z.boolean().default(false).describe("op=screenshot/stepAndShot: return the image in the response instead of writing to disk."),
      overlayBoxes: z.boolean().default(false).describe("op=screenshot png: draw a colored bounding box per visible sprite (SNES+NES only)."),
      scale: z.number().gt(0).max(16).refine((s) => s <= 1 || Number.isInteger(s), { message: "scale must be 0<scale≤1 (downscale) or an integer ≥2 (upscale)" }).optional().describe("op=screenshot png: nearest-neighbor resample factor. DEFAULT (unset/1) = NATIVE resolution — perfect pixels, the accurate representation; use this. 0<scale<1 DOWNscales (0.5 ≈ 75% fewer image tokens — useful for cheap 'did it change?' checks). integer scale≥2 UPscales by pixel-duplication (e.g. scale:4 → GB 160x144 → 640x576): it adds NO information (same pixels enlarged), costs MORE image tokens, and since VLM encoders resize to their own fixed resolution it may not change what the model sees and can slightly degrade it. Only for clients that render tiny images too small to use and can't zoom."),
      cols: z.number().int().min(4).max(640).optional().describe("op=screenshot ascii: terminal columns (default fb_width/8 — one cell per 8×8 tile, legible game state)."),
      rows: z.number().int().min(4).max(480).optional().describe("op=screenshot ascii: terminal rows (default fb_height/8)."),
      symbols: z.enum(["ascii", "halfblock", "block", "quad", "sextant"]).default("ascii").describe("op=screenshot ascii: chafa symbol set."),
      colors: z.enum(["true", "256", "16", "fgbg"]).default("256").describe("op=screenshot ascii: color depth. Default '256' (indexed) — far fewer ANSI escape bytes than 'true' (truecolor per cell) for a near-identical read. Use 'true' only when exact color matters."),
    },
    safeTool(async (args) => {
      switch (args.op) {
        case "step":            return doStep(args);
        case "screenshot":      return doScreenshot(args);
        case "stepAndShot":     return doStepAndShot(args);
        case "sideBySide":      return await doSideBySide(args);
        case "compareRam":      return compareRam(args);
        case "findDiverge":     return findDiverge(args);
        case "compareRender":   return await compareRender(args);
        case "portStatus":      return await portStatus(args);
        case "stepInstruction": return await stepInstructionCore(sessionKey);
        case "stepInstructions": return await stepInstructionsCore(sessionKey, { count: args.count, withRegisters: args.withRegisters, format: args.stepFormat });
        case "verify":          return await doVerify(args);
        default: throw new Error(`frame: unknown op '${args.op}'`);
      }
    }),
  );
}
