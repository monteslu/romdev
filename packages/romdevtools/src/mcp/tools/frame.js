import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PNG } from "pngjs";
import { cropPng, resamplePng } from "romdev-core-host/framebuffer-png.js";
import { getHost, getHostB } from "../state.js";
import { maybeAutoSnapshot } from "../auto-snapshot.js";
import { getActiveBezel, compositeFrame, activeBezelGeometry, activeBezelStatus, tickForFrame } from "../active-bezel.js";
import { framebufferToScreenshot } from "romdev-core-host/framebuffer-png.js";
import { ROMDEV_PIXEL_FORMAT_RGBA8888 } from "romdev-core-host/retroConstants.js";
import { imageContent, jsonContent, safeTool } from "../util.js";
import { decodeOAM, decodePpuRegs, ppuRegsPopulated } from "../../platforms/snes/ppu.js";
import { stepInstructionCore, stepInstructionsCore, attachObserverFrame } from "./watch-memory.js";
import { getRenderingContextCore } from "./rendering-context.js";
import { humanCoDriveWarning } from "./playtest.js";
import { runVerifyRecompile, runRecompileDiverge, runInstructionDiverge, runFuzzRecompile } from "./verify-recompile-op.js";
import { traceInstructionsCore } from "./trace-instructions.js";
import { measureCycles, mapBeside, annotateFunction } from "../../host/s32-cycles.js";
import { readS32RecompileLayout } from "../../analysis/recompile/native/s32-cart.js";
import { S32CartHost } from "../../host/S32CartHost.js";
import { installHost } from "../state.js";
import { readFileSync as readFileSyncCycles } from "node:fs";

/** Default profile groups for a native Genesis cart (object files -> subsystem). */
const GENESIS_NATIVE_GROUPS = {
  "68000 recompiled blocks": ["/^rd_blocks\\d*$/"], "68000 interpreter + dispatch": ["m68kcpu"],
  "VDP render": ["vdp_render"], "VDP ports/DMA": ["vdp_ctrl"], "Z80": ["z80", "memz80", "membnk"],
  "YM2612": ["ym2612"], "PSG": ["psg"], "audio mix/resample": ["sound", "blip_buf"],
  "68000 memory map + I/O": ["mem68k", "io_ctrl", "input", "gamepad", "md_cart", "sram", "genesis"],
  "host glue (frame loop, canvas, audio ring, libc)": ["main", "libc", "setjmp", "system_s32", "rd_stubs"],
};

/** frame({op:'cycles'}): sync32 cycles per frame (+ profile). */
async function runS32Cycles(sessionKey, args) {
  let host, cartPath = args.cart ?? null;
  if (cartPath) {
    const h = new S32CartHost();
    await h.loadMedia({ path: path.resolve(cartPath) });
    h.inner.status.mediaPath = path.resolve(cartPath);
    installHost(sessionKey, h.inner);
    host = h.inner;
  } else {
    host = getHost(sessionKey);
    cartPath = host.status?.mediaPath ?? null;
  }
  if (host.status?.platform !== "sync32" && host.platform !== "sync32") {
    // LibretroHost keeps the platform in status
    if (!(host.regionSize?.("sync32_timing") > 0)) throw new Error("frame({op:'cycles'}): the session's cart is not a sync32 cart (load one with loadMedia({platform:'sync32'}) or pass cart)");
  }
  const at = host.status?.frameCount ?? 0;
  const from = args.from ?? at + 1, to = args.to ?? from + (args.frames > 1 ? args.frames - 1 : 599);
  const map = args.map ? readFileSyncCycles(args.map, "utf8") : cartPath ? mapBeside(cartPath) : null;
  let groups = args.groups ?? null;
  if (!groups && cartPath) { try { if (readS32RecompileLayout(cartPath)) groups = GENESIS_NATIVE_GROUPS; } catch { /* not a native cart */ } }
  if (args.annotate) {
    if (!map || !cartPath) throw new Error("frame({op:'cycles', annotate}): needs the cart's linker map beside it (a native build writes <cart>.map)");
    return { cart: cartPath, ...(await annotateFunction({ host, image: new Uint8Array(readFileSyncCycles(cartPath)), map, fn: args.annotate, from, to, input: args.input, top: args.top })) };
  }
  const r = await measureCycles({ host, from, to, input: args.input, profile: !!args.profile, map, groups, top: args.top, series: !!args.series, perFrame: !!args.perFrame });
  return { cart: cartPath, ...r };
}

// Normalize each platform's render-context into a CONSERVATIVE renderEnabled
// (true | false | null). null = "can't tell from the registers" - verify never
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
    // atari2600 / atari7800 / lynx: no single reliable display-enable bit - let
    // the pixel check carry it; don't false-assert.
    return { renderEnabled: null };
  } catch {
    return { renderEnabled: null };
  }
}

/**
 * Dominant-color fraction at/above which a screen reads as "blank" to a
 * human even though *something* technically rendered. Set to 0.92 (one color
 * filling >=92% of the screen) - empirically the perceptual threshold where a
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
      note: "No frame has been stepped yet - render state is the pre-boot default and not meaningful. " +
        "Step frames first (frame({op:'step'}) or pass `frames`), then verify.",
      pixels, render,
    };
  }

  // --- fuse into a verdict + issues[] ---
  const issues = [];
  if (distinctColors <= 1) {
    issues.push({ check: "blankScreen", detail: `the entire framebuffer is one color (${pixels.dominantColor}) - nothing is being drawn.` });
  } else if (dominantFraction >= NEARLY_BLANK_DOMINANT) {
    issues.push({ check: "nearlyBlank", detail: `${pixels.dominantPct}% of the screen is a single color (${pixels.dominantColor}); only ${nonDominant} px differ - a backdrop with almost no content reads as blank to a human even though something rendered. Add visible content (a tilemap/background, more sprites) until <${Math.round(NEARLY_BLANK_DOMINANT * 100)}% is one color.` });
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
      : { issues, note: "Rendering looks broken - see issues[]. For per-platform thresholds + the full checklist, platform({op:'doc', platform, name:'mental_model'})." }),
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
      // Overlay only the truly renderable sprites - not every populated OAM
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
  // NES: Y in OAM is "actual Y - 1" - most modern emulators expose the
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
 * Lightweight pixel summary of an RGBA framebuffer - the same dominant-color /
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
  async function doStep({ frames, slot }) {
      // slot:'b' advances the COMPARISON host on its own. findDiverge steps both
      // slots in lockstep from wherever they stand, which is the wrong tool when
      // the two sides only diverge deep into a run: you need to warm each side to
      // a chosen frame FIRST and compare from there. Slot B had no way to advance
      // at all, so a caller could only compare against its power-on state.
      const slotB = slot === "b";
      const host = slotB ? getHostB(sessionKey) : getHost(sessionKey);
      // await: native-runtime hosts (jsgame) have an async stepFrames that yields for
      // the game's async work; awaiting a sync LibretroHost return is a harmless no-op.
      const n = await host.stepFrames(frames);
      // Slot B is comparison scratch: it drives no presentation, owns no bezel,
      // and must never touch the livestream, the auto-snapshot timeline, or the
      // playtest co-drive check. Advance it and report, nothing else.
      if (slotB) {
        return jsonContent({
          slot: "b",
          framesRun: n,
          frameCount: host.status.frameCount,
          framebuffer: { width: host.status.fbWidth, height: host.status.fbHeight },
        });
      }
      // Tick the Active Bezel for the frame the core just produced.
      //
      // The contract is "once per emulated frame", and it has to hold here
      // rather than only at capture time: a package with per-frame state -- an
      // animation, a room-transition, anything interpolated -- would otherwise
      // see a timeline with holes in it, ticking only when somebody happened to
      // take a screenshot. Cheap when no bezel is attached (an early return).
      tickForFrame(sessionKey, host);
      // Lazy auto-snapshot check: stepping is what actually advances the machine,
      // so it's the natural place to notice an interval has elapsed. No-op unless
      // armed, and it can never fail this call (see auto-snapshot.js).
      await maybeAutoSnapshot(sessionKey, host);
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
  async function shootPng({ path: outPath, inline, overlayBoxes, scale, crop, source }) {
    const host = getHost(sessionKey);
    // With an Active Bezel running, the COMPOSITE is the truth an agent needs:
    // it is what the human sees and what the package actually claims about the
    // game. `source:'core'` asks for the raw emulator picture instead, which is
    // the other half of the comparison that makes a package verifiable.
    const bezel = getActiveBezel(sessionKey);
    let shot, frameSource = "core";
    if (bezel && source !== "core") {
      const composed = compositeFrame(sessionKey, host, { source: source ?? "composite" });
      frameSource = composed.source;
      shot = composed.source === "composite"
        ? { ...framebufferToScreenshot(composed.width, composed.height, composed.rgba, composed.width * 4, ROMDEV_PIXEL_FORMAT_RGBA8888) }
        : host.screenshot();
    } else {
      shot = host.screenshot();
    }
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
    // Crop FIRST (native-res strip - the HUD-verification token-saver: a
    // 1-pixel-tick bar or an 8px counter stays legible, unlike a downscale),
    // then scale - so crop+integer-scale gives an enlarged detail view.
    const cropped = !!crop;
    if (cropped) {
      const c = cropPng(pngBase64, crop);
      pngBase64 = c.base64; width = c.width; height = c.height;
    }
    const scaled = scale && scale !== 1;
    if (scaled) {
      const r = resamplePng(pngBase64, scale);
      pngBase64 = r.base64; width = r.width; height = r.height;
    }
    if (!inline) {
      await writeFile(outPath, Buffer.from(pngBase64, "base64"));
      const json = jsonContent({ path: outPath, width, height, ...(cropped ? { crop } : {}), ...(scaled || cropped ? { ...(scaled ? { scale } : {}), fullWidth: shot.width, fullHeight: shot.height } : {}), overlay: overlayInfo,
        // With a bezel running, report WHICH picture this is and the three
        // geometries that are easy to conflate: the raw core framebuffer, the
        // game's intended display aspect, and the bezel's logical scene.
        ...(bezel ? { source: frameSource, geometry: activeBezelGeometry(sessionKey, host) } : {}) });
      json._observerImages = [{ kind: "image", mimeType: "image/png", base64: pngBase64 }];
      return json;
    }
    // inline:true - ALSO write the PNG to a temp file so a follow-up crop/convert
    // (ImageMagick etc.) has a real path instead of ENOENT-ing on a base64 blob.
    // Path is stable per frame so repeated shots of the same frame don't pile up.
    const tempPath = path.join(tmpdir(), `romdev-shot-${host.status.platform ?? "rom"}-f${host.status.frameCount ?? 0}.png`);
    try { await writeFile(tempPath, Buffer.from(pngBase64, "base64")); } catch { /* best-effort; inline image is still returned */ }
    return {
      content: [
        imageContent(pngBase64),
        { type: "text", text: `${bezel ? `[${frameSource}] ` : ""}framebuffer ${shot.width}x${shot.height}${cropped ? ` (cropped to ${width}x${height} at ${crop.x ?? 0},${crop.y ?? 0})` : ""}${scaled ? ` (scaled ${scale}x${cropped ? "" : ` to ${width}x${height}`})` : ""}${overlayInfo ? ` (overlay: ${overlayInfo.spritesDrawn} sprites)` : ""} - also written to ${tempPath} (use this path for ImageMagick/crops; pass outputPath for a permanent location).` },
      ],
    };
  }

  // ASCII/ANSI capture.
  async function shootAscii({ cols, rows, symbols, colors, path: outPath, inline }) {
    const host = getHost(sessionKey);
    const { width, height, rgba } = host.screenshotRgba();
    // Default to ONE cell per 8×8 tile (so a 256×224 NES frame → 32×28, legible
    // game state). The old /16 default (16×14 for NES) was too coarse to read
    // anything. The terminal symbol's own subcell shape adds
    // detail back, so this stays cheap.
    if (cols == null) cols = Math.max(8, Math.floor(width / 8));
    if (rows == null) rows = Math.max(8, Math.floor(height / 8));
    // Warn when the caller forced a grid so coarse it can't show game state.
    const tooCoarse = cols < Math.floor(width / 8) / 2 || rows < Math.floor(height / 8) / 2;
    const { renderRgbaToAnsi } = await import("romdev-core-host/chafa-render.js");
    const ansi = await renderRgbaToAnsi(rgba, width, height, { cols, rows, symbols, colors });
    // Livestream sidebands: the human sees BOTH the real PNG and the ANSI.
    const shot = host.screenshot();
    const observerSidebands = {
      _observerImages: [{ kind: "image", mimeType: "image/png", base64: shot.pngBase64 }],
      _observerAnsi: ansi,
    };
    const coarseNote = tooCoarse
      ? `NOTE: ${cols}x${rows} is too coarse to read game state from this ${width}x${height} frame. `
        + `For a pass/fail check ("are we in gameplay?"), a memory({op:'read'}) byte assertion is cheaper and exact - `
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

  async function doScreenshot({ format, path: outPath, inline, overlayBoxes, scale, crop, cols, rows, symbols, colors, source }) {
      requireImageTarget(outPath, inline, "frame({op:'screenshot'})");
      if (format === "ascii") return shootAscii({ cols, rows, symbols, colors, path: outPath, inline });

      // source:'both' captures the composite AND the raw core picture for the
      // SAME frame. That pairing is the point: a package can render a confident,
      // beautiful map of a room the game isn't in, and only the two pictures
      // side by side (plus the region trace) show it.
      if (source === "both") {
        const host = getHost(sessionKey);
        if (!getActiveBezel(sessionKey)) {
          throw new Error("frame({op:'screenshot', source:'both'}) needs an Active Bezel loaded - without one there is only the core picture. Load with loadMedia({useActiveBezel:true}).");
        }
        const compositeShot = await shootPng({ path: outPath, inline, overlayBoxes, scale, crop, source: "composite" });
        const corePath = outPath ? outPath.replace(/(\.png)?$/i, ".core.png") : undefined;
        const coreShot = await shootPng({ path: corePath, inline, overlayBoxes, scale, crop, source: "core" });
        const json = jsonContent({
          source: "both",
          composite: JSON.parse(compositeShot.content.find((c) => c.type === "text")?.text ?? "{}"),
          core: JSON.parse(coreShot.content.find((c) => c.type === "text")?.text ?? "{}"),
          geometry: activeBezelGeometry(sessionKey, host),
          activeBezel: activeBezelStatus(sessionKey),
          note: "Same frame, both pictures. Compare them against the guest's region reads to check the package's interpretation, not just that it drew something.",
        });
        // Forward BOTH pictures to the human's /livestream. This branch builds a
        // fresh JSON envelope, so without this the child shots' `_observerImages`
        // sidebands are dropped on the floor and the observer sees nothing at all
        // for the one call that has the most to show. Composite first: it is what
        // the human is actually looking at, and the observer leads with image[0].
        const observed = [];
        for (const child of [compositeShot, coreShot]) {
          if (Array.isArray(child?._observerImages)) observed.push(...child._observerImages);
        }
        if (observed.length) json._observerImages = observed;
        return json;
      }
      return shootPng({ path: outPath, inline, overlayBoxes, scale, crop, source });
  }

  // op:'verify' - one-call "did the game actually render / is it alive?" health
  // check for agents debugging WITHOUT vision. Fuses two independent signals:
  //   1. the render-enable/NMI verdict from getRenderingContext (per-platform
  //      register decode - already correct, reused not re-derived), and
  //   2. a pixel-level content check on the live framebuffer (is the screen
  //      actually showing more than one flat color?).
  // Frame-0 guard: before any frame is stepped, report the raw condition WITHOUT
  // an editorial verdict (so the header never "cries wolf" on boot).
  async function doVerify({ frames }) {
    const host = getHost(sessionKey);
    if (!host.status.platform || !host.status.loaded) {
      throw new Error("frame({op:'verify'}): no media loaded - loadMedia or build({output:'run'}) first.");
    }
    const json = jsonContent(await computeVerify(host, frames, sessionKey));
    // verify's whole job is "look at the screen" - so push the exact frame it
    // judged to the human's /livestream. Deferred provider: the PNG encode
    // happens async after the agent's (JSON-only) response goes out, at zero
    // cost to the agent. computeVerify already stepped the frames, so the
    // host's current framebuffer IS the verified frame.
    attachObserverFrame(json, host);
    return json;
  }

  // op:'sideBySide' - capture BOTH hosts (slot A + slot B) into one composited
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
        { type: "text", text: `side-by-side ${outW}x${outH} - left: ${panes.a.platform} @frame ${panes.a.frame} (${panes.a.distinctColors} colors), right: ${panes.b.platform} @frame ${panes.b.frame} (${panes.b.distinctColors} colors). Also written to ${tempPath}.` },
      ],
      _observerImages: [{ kind: "image", mimeType: "image/png", base64: pngBase64 }],
    };
  }

  // op:'compareRam' - the RAM-diff oracle. The STATE-level sibling of
  // sideBySide: instead of comparing pixels, compare the work-RAM of slot A
  // (the original) and slot B (the port) at the same game-moment. This is how a
  // logic port is proven correct INDEPENDENT of graphics - if the two machines'
  // RAM matches, the game logic is running identically even when one renders
  // blank (no PPU shim yet).
  //
  // Designed for a "smart-enough, not frontier" agent: it does the byte-compare
  // MECHANICALLY and returns a DIGESTED verdict - a match %, the diverging
  // address RANGES (run-length-encoded, not raw bytes), and plain-language
  // guidance - so the agent gets "addresses $0300-$0312 differ, likely your
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
        ? "IDENTICAL - slot A and slot B work-RAM match byte-for-byte. The port's logic is running exactly like the original at this moment."
        : matchPct >= 95
          ? `CLOSE (${matchPct}% match) - logic is largely tracking; ${ranges.length} diverging span(s). Inspect the ranges below (often graphics/timing scratch that doesn't affect logic). Read a range with memory({op:'read', region, offset}) on each slot to dig in.`
          : `DIVERGED (${matchPct}% match) - the port's logic is NOT tracking the original. Step both from a known-identical point (state restore), then compareRam after a few frames to find WHERE they split. The first diverging span is usually the root cause.`;

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

  // op:'findDiverge' - the ROOT-CAUSE finder. compareRam tells you slot A and
  // slot B differ; this tells you EXACTLY WHEN and WHERE they first split. It
  // snapshots both hosts, steps them in lockstep, and reports the first frame at
  // which the work-RAM diverges + the first diverging byte address. A
  // smart-enough agent shouldn't binary-search frames by hand - the tool does
  // the search and hands back "frame 47, $0312 (A=05 B=07): that's where your
  // port's logic split from the original."
  //
  // Both hosts' MACHINE STATE (RAM/CPU/PPU) is restored to the pre-search point
  // afterward via unserializeState, so the agent keeps working from where it was.
  // (The frameCount COUNTER keeps climbing - a known core behavior of
  // unserializeState - but the actual emulated state is rewound.)
  async function findDiverge(args) {
    // Recompile mode: a wasmcart built from a ROM vs that ROM's reference
    // core, loaded fresh, stepped on one schedule and one frame axis, with
    // every region/field of the cart's romdev.recompile layout compared on
    // every frame. Selected by passing the cart (or its layout regions).
    if (args.level === "instruction") return jsonContent(await runInstructionDiverge(sessionKey, { ...args }));
    if (args.cart || args.reference || args.fields || (args.regions && typeof args.regions === "object")) {
      return jsonContent(await runRecompileDiverge(sessionKey, { ...args }));
    }
    const { findDivergence } = await import("../../host/find-divergence.js");
    return jsonContent(findDivergence(getHost(sessionKey), getHostB(sessionKey), args));
  }

  // op:'compareRender' - the PRESENTATION oracle. The graphics-side sibling of
  // compareRam: instead of bytes, compare the decoded RENDERING STATE of slot A
  // (original) vs slot B (port) - "BG enabled? which tilemap/palette? sprites
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
          ? "Rendering state MATCHES - same platform, identical decoded render context. The port's presentation tracks the original."
          : `Rendering differs: ${lineDiff.onlyInOriginal.length} aspect(s) the ORIGINAL has that the port lacks (see onlyInOriginal - that's your shim's TODO list), ${lineDiff.onlyInPort.length} the port has extra. Fix the port until onlyInOriginal is empty.`)
      : `Cross-platform port (${platA}→${platB}): the two render models differ by hardware, so compare the summaries conceptually. originalRenderEnabled=${flagsA.renderEnabled}, portRenderEnabled=${flagsB.renderEnabled}. If the original renders and the port is forced-blank/disabled, the graphics shim hasn't enabled output yet - that's step one.`;

    return jsonContent({
      op: "compareRender",
      a: { platform: platA, renderEnabled: flagsA.renderEnabled, summary: sumA },
      b: { platform: platB, renderEnabled: flagsB.renderEnabled, summary: sumB },
      samePlatform,
      ...(lineDiff ? { diff: lineDiff } : {}),
      note,
    });
  }

  // op:'portStatus' - the CAPSTONE. One call that runs all the compare signals
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

    // 1. Logic (RAM) - only meaningful for a SAME-platform port (cross-platform
    //    RAM layouts differ, so a byte diff there isn't a logic verdict).
    const samePlatform = hostA.status.platform === hostB.status.platform;
    let logic = null;
    if (samePlatform) {
      try {
        const m = computeRamMatch(region);
        logic = { region, matchPct: m.matchPct, identical: m.diffBytes === 0, divergingBytes: m.diffBytes, divergingSpans: m.ranges.length };
      } catch (e) { logic = { error: e.message }; }
    }

    // 2. Presentation (render state) - per-side render-enable.
    let renderA, renderB;
    try { renderA = pickRenderFlags(await getRenderingContextCore({ platform: hostA.status.platform, area: "all", host: hostA })); }
    catch { renderA = { renderEnabled: null }; }
    try { renderB = pickRenderFlags(await getRenderingContextCore({ platform: hostB.status.platform, area: "all", host: hostB })); }
    catch { renderB = { renderEnabled: null }; }

    // 3. Pixels - is each side drawing more than a flat color?
    const pxA = pixelSummary(...rgbaTriple(hostA));
    const pxB = pixelSummary(...rgbaTriple(hostB));
    const aliveA = pxA.distinctColors > 2 && pxA.dominantPct < 99;
    const aliveB = pxB.distinctColors > 2 && pxB.dominantPct < 99;

    // Fuse into a single next-action verdict.
    let verdict, nextAction;
    if (samePlatform && logic && logic.identical) {
      if (aliveB) { verdict = "PORT LOOKS COMPLETE"; nextAction = "Logic matches byte-for-byte AND the port renders. Spot-check with frame({op:'sideBySide'}) and move on."; }
      else { verdict = "LOGIC DONE, PRESENTATION MISSING"; nextAction = "RAM matches the original exactly - the game logic is correct. The port renders blank: build/finish the graphics shim. Start with frame({op:'compareRender'}) to see what the original enables that the port doesn't."; }
    } else if (samePlatform && logic && !logic.error) {
      verdict = `LOGIC DIVERGED (${logic.matchPct}% RAM match)`;
      nextAction = "The port's logic is NOT tracking the original. Run frame({op:'findDiverge'}) from a known-identical point to get the first frame+address where they split, then breakpoint({on:'write', address}) on each slot to compare the code.";
    } else {
      // cross-platform - RAM diff isn't a logic verdict; lean on render + pixels.
      verdict = "CROSS-PLATFORM PORT";
      nextAction = aliveB
        ? "Both sides render - compare visually with frame({op:'sideBySide'}) and the decoded state with frame({op:'compareRender'}). RAM can't be byte-compared across different hardware."
        : "The port renders blank while the original draws. The graphics shim hasn't enabled output - frame({op:'compareRender'}) shows what to turn on. Verify logic another way (the recompiled CPU should be running even when blank).";
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

  async function doStepAndShot({ frames, path: outPath, inline, source, crop, scale, overlayBoxes }) {
      requireImageTarget(outPath, inline, "frame({op:'stepAndShot'})");
      const host = getHost(sessionKey);
      await host.stepFrames(frames);
      // Tick the bezel for the frames just produced, exactly as op:'step' does -
      // otherwise stepAndShot advances the machine behind the package's back and
      // a package with per-frame state sees a hole in its timeline.
      tickForFrame(sessionKey, host);

      // Capture through shootPng rather than re-implementing it.
      //
      // This op used to call host.screenshot() itself, which meant it silently
      // ignored `crop` - the one parameter the tool description actively
      // recommends for reading a HUD ("crop:{x,y,w,h} at native res - legible
      // AND a fraction of the image tokens"). An agent following that advice
      // got a full frame back with no error and reasoned about the wrong
      // pixels. Sharing the capture path also means `scale`, `overlayBoxes`
      // and the bezel `source` handling can never drift between the two ops
      // again.
      return await shootPng({ path: outPath, inline, overlayBoxes, scale, crop, source });
  }


  server.tool(
    "frame",
    "Advance the emulator and capture frames. `op`: 'step' | 'screenshot' | 'stepAndShot' | 'sideBySide' | 'compareRam' | 'findDiverge' | 'compareRender' | 'portStatus' | 'stepInstruction' | 'stepInstructions' | 'traceInstructions' | 'verify' | 'verifyRecompile' | 'fuzzRecompile'.\n" +
    "'step': advance N `frames` as fast as possible - NO pacing/audio/vsync. Cores run at WASM speed, so frames:3600 " +
    "(1 min of game time) finishes in ~5-30ms, cheaper than a screenshot. Don't be timid - skip a title with 300, a " +
    "level with 7200; prefer ONE big call.\n" +
    "'screenshot': capture the latest frame. `format:'png'` (default, exact colors) or `'ascii'` (lossy chafa text " +
    "render for agents that can't view images). `overlayBoxes` (png) draws a box per visible sprite (SNES+NES only); " +
"`scale` (png) resamples nearest-neighbor: 0<scale<1 DOWNscales (~75% fewer image tokens at 0.5 - the useful direction, for cheap 'did it change?' checks). integer scale≥2 UPscales (pixel-duplication, e.g. scale:4 → GB 160x144 → 640x576) - but this adds NO detail (it's the same pixels enlarged) and costs MORE image tokens; the native frame already has every pixel. Prefer scale:1 (default, native). Only upscale if YOUR client renders tiny images too small to be useful AND can't zoom - and know that VLM encoders resize to a fixed resolution anyway, so it may not change what the model sees (and can slightly degrade it). ascii cols/rows/symbols/colors knobs in the param hints. " +
    "**READING a HUD counter/bar? crop:{x,y,w,h} at native res - legible AND a fraction of the tokens (no external image tools).** **CHEAP VERIFY: for a binary pass/fail check (theme changed? sprite present? HUD ticked?) prefer scale:0.5 or " +
    "format:'ascii' - BETTER, read the byte directly: symbols({op:'resolve', name}) → memory({op:'read'}) is a 1-byte " +
    "assertion that costs zero image tokens.**\n" +
    "'stepAndShot': step + screenshot in ONE round-trip - the drive-then-look loop. Takes the same crop/scale/overlayBoxes/source as 'screenshot'.\n" +
    "'sideBySide': capture BOTH hosts (slot A + the slot-B comparison host) into ONE composited PNG - A left, B right, " +
    "divider between. The two-cores-in-one-call capture for the original-vs-port compare loop: loadMedia the original " +
    "in slot A, loadMedia({slot:'b'}) the port, then frame({op:'sideBySide', frames}) steps BOTH the same N frames and " +
    "shows them together. Panes are integer-upscaled to a shared height so a handheld next to a console reads at a " +
    "comparable size. Returns per-pane {platform, frame, distinctColors, dominantColor, dominantPct} so a no-vision " +
    "agent still gets a structured 'are both alive / how different' signal. Requires a ROM in slot B (loadMedia({slot:'b'})). " +
    "Same image contract as screenshot (path or inline:true).\n" +
    "'compareRam': the RAM-diff ORACLE - the STATE-level sibling of sideBySide. Compares the work-RAM (`region`, default " +
    "'system_ram') of slot A vs slot B at the same game-moment to prove a logic PORT is correct INDEPENDENT of graphics " +
    "(matching RAM = identical logic even when the port renders blank). Returns a DIGESTED verdict: matchPct, " +
    "identical, and the diverging address RANGES run-length-encoded with a 4-byte sample of each side (NOT raw byte " +
    "dumps) so even a small model gets '$0300-$0312 differ' not two hex blobs. Workflow: state-restore both to an " +
    "identical point, step both N frames, compareRam - the FIRST diverging span is usually the bug. Requires slot B.\n" +
    "'findDiverge': the ROOT-CAUSE finder built ON compareRam - where compareRam says THAT they differ, this says exactly " +
    "WHEN and WHERE. Snapshots both slots, steps them in lockstep up to `maxFrames`, and reports the first frame + first " +
    "byte address at which the work-RAM splits ({atFrame, address, a, b}). Non-destructive: both hosts are RESTORED to " +
    "their pre-search state. Run it from a known-identical point (state-restore both first) so 'first split' is meaningful. " +
    "The agent then disasms the code that writes that address on both sides. Requires slot B. " +
    "RECOMPILE MODE (pass `cart` + `reference`, or `regions`): a wasmcart recompiled from a ROM vs the ROM's reference core, both " +
    "loaded fresh, stepped on the SAME `input` schedule and frame axis as verifyRecompile, and every region + scalar field of the " +
    "cart's romdev.recompile layout (CPU registers vs cpu({op:'read'}) paths or reference struct offsets, cycle counters, " +
    "VRAM/RAM/palette/OAM) compared EVERY frame (or every `stride`) from `startFrame`; returns the first differing frame with " +
    "the region's first differing byte and the differing fields. Replaces native emulator trace differs: thousands of frames " +
    "in seconds, all in romdev. With `audio:true` each frame's audio chunk (sample count + samples, reference `audioStream`) is " +
    "compared too, and the first frame whose sound differs is a divergence (result.audio: frame, first differing sample, both counts). " +
    "INSTRUCTION LEVEL (`level:'instruction'`, with cart + reference): traces ONE frame on both sides - the cart's own trace ring " +
    "(declared in its romdev.recompile section) and the reference core's FREE-RUNNING instruction trace - and walks the two pc streams " +
    "to the first divergent instruction, with `context` instructions from both sides. Normalises what differs only in spelling (SNES " +
    "$80 bank mirrors, the GBA core's pipeline pc, the SNES ring's ROM-only filter), reports an interrupt handler entered at a " +
    "different instruction (kind 'interrupt-timing') and then strips handler runs to find the first divergence in program LOGIC, " +
    "compares per-instruction cycle costs when both sides record a clock (firstClockDivergence), compares per-instruction registers " +
    "where both traces carry them (GBA r0-r15/cpsr; NES a/x/y/s/p, GB sp/hl/bc/de, SMS/GG af..iy/sp/r, Genesis d0-d7/a0-a7/sr, SNES a/x/y/s/d/db/p " +
    "when the cart was built with options.traceEntries, which also makes the NES/GB ring hold a whole frame) and names the instruction that first produced a different value " +
    "(registers.producedBy), and reads the reference CPU at the first pc divergence (firstDivergence.refCpuHere). `atFrame` = the reference frame to trace (its execution from " +
    "the end of atFrame-1; 0 = the load-time frames from power-on); omitted, the per-frame differ runs first and the first differing frame is traced.\n" +
    "'compareRender': the PRESENTATION oracle - compare the decoded RENDERING STATE of slot A vs slot B (BG/sprites " +
    "enabled? which tilemap/palette? forced blank?) instead of bytes. This is what an agent building/tuning the graphics " +
    "shim needs: it says in plain terms WHAT the port's presentation is missing vs. the original. Same-platform ports get " +
    "a line diff (onlyInOriginal = your shim's TODO); cross-platform ports get both summaries + each side's renderEnabled " +
    "verdict. Requires slot B.\n" +
    "'portStatus': the CAPSTONE - ONE call that fuses logic (RAM), presentation (render state), and pixels into a single " +
    "'state of your port' verdict + the next concrete action (e.g. 'LOGIC DONE, PRESENTATION MISSING → build the graphics " +
    "shim, start with compareRender'). Use this FIRST when working a port to know what to do next; drill in with the " +
    "specific compare ops. Requires slot B.\n" +
    "'stepInstruction': execute exactly ONE CPU instruction and stop (finer than 'step'); freezes the CPU one " +
    "instruction later and returns { pc }. Pair with cpu({op:'read'}) to watch registers change while tracing a routine.\n" +
    "'stepInstructions': BULK single-step - execute `count` instructions and return an ORDERED `trace:[{pc, width, bytes}]` " +
    "in ONE call (the `note` boilerplate emitted once, not per entry). `width` = PC[k+1]-PC[k], so immediate widths are " +
    "visible directly - the 65816 `.a8` vs `.i16` case (a 2-byte lda #imm8 vs a 3-byte ldx #imm16 shows up only as the PC " +
    "delta), which is what confirms a routine's boundaries when static da65 floored the bank to `.byte`. `withRegisters:true` " +
    "adds the register file at each step. This collapses the ~1-round-trip-per-instruction cost of tracing a routine.\n" +
    "'traceInstructions': the instruction stream the host REALLY executes over `frames` frames (default 1, max 600) in ONE call: on a " +
    "core, the free-running trace (every executed pc + the core's clock at dispatch; stepInstructions freezes the CPU while the " +
    "machine finishes each frame, so it is NOT this); on a recompiled wasmcart, the trace ring its romdev.recompile section declares. " +
    "Returns the first `head` entries, the pcRanges loop map, and writes every entry to `outputPath` (one line per instruction) when " +
    "given. `fromPc` starts the output at that pc's first execution. `slot:'b'` traces the comparison host.\n" +
    "'verify': one-call 'is the game actually rendering / alive?' health check WITHOUT vision - for the spiral where an " +
    "agent can't see the screen and doesn't know if a black frame means broken. Pass `frames` to boot-then-check in one " +
    "call. Fuses (1) a pixel-content scan of the live framebuffer (distinctColors, dominant-color %) - works on EVERY " +
    "kind, wasmcart/jsgame included (GL carts scan the offscreen-GL readback) - and (2) the per-platform " +
    "render-ENABLE/NMI decode on the classic emulated platforms (native runtimes report render.renderEnabled:null). " +
    "Returns {verified:true|false|null, issues[], pixels, render}. verified:null + unsettled when no frame has been " +
    "stepped yet (it won't cry wolf on boot - step first). issues[] flags blankScreen/nearlyBlank/renderDisabled. " +
    "renderDisabled is only raised when the registers SAY so (never on an undecodable platform). Pass/fail with no " +
    "image tokens; for WHAT to fix, platform({op:'doc', platform, name:'mental_model'}).\n" +
    "'verifyRecompile': ONE call that verifies a recompiled wasmcart against its reference core. Loads `cart` (.wasc or bare " +
    ".wasm) in slot A and the source ROM `reference` in slot B (platform from the cart's romdev.recompile section or " +
    "`platform`), drives BOTH with one `input` schedule ('frame:buttons:hold,...' in REFERENCE frames; the wasmcart host maps " +
    "button names by POSITION, so `a` is the same physical button on both), aligns the frame axes itself (core settle frames " +
    "vs the wasmcart host's one settle frame and the cart's declared warmupFrames; the offset is in `alignment`, override " +
    "with cartFrameOffset, or cartFrameOffset:'auto' / section frameAlignment:'search' to FIND it by a sharp picture peak " +
    "within +-searchWindow at searchFrame, refused when no sharp peak exists), and at each of `atFrames` scores exact / content (non-backdrop) / moving (pixels that changed in " +
    "the reference over `movingWindow` frames) inside the reference's window of the cart framebuffer (centred, or cartOrigin), " +
    "optionally sweeping +-`sweep` cart frames to report the peak and its sharpness. Byte-compares every region of the cart's " +
    "romdev.recompile section (or caller `regions`: {name:{offset,length,ref,refOffset?,transform?,mask?}}) against the " +
    "reference's memory regions and reads `fields`/`probe` (probe.trapped fails the run). Writes [cart|ref|diff] PNGs " +
    "(mismatches magenta) to outputDir. Runs must-fail CONTROLS on separate cart instances: vramZero (zero the cart's VRAM " +
    "regions, render one frame), wrongFrame (the cart's aligned picture against a reference 5-120 frames earlier - the delta and " +
    "sample where the reference changed most - scored on the pixels where the two reference frames DIFFER; else the compared state " +
    "(equal at the aligned frame, different at the wrong one); `signal` says which decided, couldNotFail when neither can), wrongInput (a second cart run with ALL input withheld, then a perturbed schedule if that did not fail; couldNotFail explains a control no variant could fail). Verdict VERIFIED needs every scored frame >= 95% content " +
    "on >= 2000 content px (and >= 95% moving where >= 200 px moved), every control failing, no trap; reasons[] names each " +
    "miss. Returns a per-frame markdown `table`. Afterwards slot A = the cart and slot B = the reference at the last frame. " +
    "AUDIO (`audio:true` reports, `audio:'required'` makes it part of the verdict): both sides' samples are captured PER FRAME " +
    "on the same frame axis over `audioFrames` [from,to] (reference frames, default [1, last of atFrames]): the reference's " +
    "`audioStream` ('output' = what the core hands audio_batch_cb, or a per-frame stream region a core patch exposes, e.g. a " +
    "pre-resample stream; default the section's audio.reference) against the cart's wasmcart ring. Reports framesExactPct, " +
    "per-frame sample-count mismatches (firstCountMismatch), exactPct of stereo sample frames, maxAbsError, rmsError, firstMismatch " +
    "(frame, sample, channel, values), the cross-correlation lag of the mono mix (xcorr.lag, must be 0 for exact), an envelope " +
    "correlation and a spectral similarity (the only scores when the rates differ: mode 'similar', bar audioBar " +
    "{minSpectral, minEnvelope}, default 0.9). Audio must-fail controls (`audioControls`): silence, shift (one frame late), " +
    "stereoDrop (right channel zeroed) re-score the cart's own stream altered; channelDrop re-runs a fresh cart with one mixer " +
    "channel silenced through the section's audio.muteMask. A silent reference is never evidence. `audioWav:true` writes " +
    "[cart|ref|diff] WAVs to outputDir. The section's audio.streams (per-channel / pre-mix debug buffers) are captured per frame " +
    "and compared with their `ref` stream regions. The cart-side contract is AUDIO_CONTRACT in src/analysis/recompile/wat/cart-abi.js; " +
    "which stream each platform's cart must match (and each core's chain, rate and per-frame count) is AUDIO_REFERENCE there, echoed as " +
    "audio.referenceDoc. Pre-resample streams the romdev cores expose: gba_audio_raw (mGBA native, before its sinc resampler), gb_apu_raw " +
    "(gambatte's 2 MiHz PSG output, before blipper), gpgx_blip_deltas (genesis/sms/gg: every FM/PSG delta into blip_buf as time, delta_l, " +
    "delta_r); fceumm and snes9x need none (their output is the integer chain itself).\n" +
    "AUTO MODE (`auto:true`, or atFrames omitted): romdev chooses the input schedule, the scored frames and the audio window ITSELF, " +
    "from the REFERENCE core alone (the cart cannot influence the choice), then runs this same verification with the same bar. It runs a " +
    "no-input baseline and up to auto.candidates seeded schedules (start / a menu presses at varied times, then seeded play) on fresh " +
    "reference hosts to auto.horizon frames, scoring every auto.sampleEvery frames with the verifier's own functions: content pixels, " +
    "moving pixels, and whether the no-input picture there would fail the wrong-input control. The schedule with the most frames that " +
    "meet the content bar, move and respond to input wins (the first clearly good one stops the search); auto.frames scored frames are " +
    "spread over its run, the last one responding to input (the wrong-input control is scored there); the audio window is the loudest " +
    "stretch of up to auto.audioWindow frames before it, and audio becomes 'required' when the reference makes sound there (audio:false " +
    "opts out; a silent reference leaves audio out and says so). Pass `input` with auto to keep your schedule and let it choose only frames " +
    "and audio. Deterministic: the same cart, ROM and auto.seed choose the same schedule and frames; the result's `auto` block reports the " +
    "seed, every candidate's score, the chosen plan, the predicted per-frame evidence and `reproduce` (the exact by-hand call). When no " +
    "reference frame meets the bar it returns verdict INCONCLUSIVE with the reason and does not run the cart: never a pass, and the bar is " +
    "never lowered. When no schedule makes input visibly matter, it verifies with no input and notes that input was not exercised (the " +
    "wrong-input control is then skipped, as for any run without input). Cost: (candidates run + 1) x horizon reference frames, bounded by " +
    "auto.budgetSec of wall clock (a run cut short by the budget says so: its choice may differ on another machine).\n" +
    "'fuzzRecompile': run a recompiled `cart` ALONE under seeded random play (`seeds`, default [1,2,3]; `frames` per seed, default 3600 (the tool-wide frames default of 1 counts as unset), " +
    "`input` presses kept in every script, e.g. the Start that leaves the title) and report the first frame each seed TRAPS " +
    "at (its romdev.recompile probe.trapped) with the probe block there (trappc). A trap is invisible from outside - the host keeps " +
    "presenting the last picture - and the verified schedule only covers the code it reaches.\n" +
    "IMAGE CONTRACT (screenshot/stepAndShot): the image goes to `path` (default, returns {path}) OR inline:true - " +
    "you MUST pass one. Keeps PNGs out of context unless asked.",
    {
      op: z.enum(["step", "screenshot", "stepAndShot", "sideBySide", "compareRam", "findDiverge", "compareRender", "portStatus", "stepInstruction", "stepInstructions", "traceInstructions", "verify", "verifyRecompile", "fuzzRecompile", "cycles"]).describe("cycles = sync32 only: CPU cycles per frame over a frame span on an input schedule (min/mean/p95/max, frames over the 2.5M ABI floor and the 252/315 MHz budgets, worst frames), with profile:true a pc-sampling profile that sums to the same cycles (vblank wait excluded) attributed per function/object/group from the build's linker map; fuzzRecompile = seeded random play on a recompiled cart, first trap per seed; traceInstructions = the free-running instruction stream over N frames; step frames; capture a screenshot; step+capture in one call; capture both hosts side-by-side (A|B); compareRam = diff slot-A vs slot-B work-RAM (the logic-port oracle); findDiverge = find the first frame+byte where the two slots split (root-cause finder; with `cart` it runs the recompile per-frame state differ); compareRender = diff the decoded rendering state of the two slots (the presentation oracle); portStatus = ONE fused 'state of your port' verdict + next action (the capstone); single-step one CPU instruction; stepInstructions = bulk single-step N instructions into one ordered trace; verify the game is actually rendering/alive (no vision needed); verifyRecompile = verify a recompiled wasmcart against its reference core (scores, state compare, controls, verdict)."),
      count: z.number().int().min(1).max(1_000_000).optional().describe("op=stepInstructions/step: stepInstructions = how many CPU instructions to single-step into the trace (default 16, max 4096); step = accepted as an alias for `frames`, since the unit is fixed by the op."),
      withRegisters: z.boolean().default(false).describe("op=stepInstructions: include the CPU register file at each step (heavier payload; omit if you only need pc/width/bytes for boundary+immediate-width analysis)."),
      stepFormat: z.enum(["full", "compact"]).default("full").describe("op=stepInstructions: 'full' = per-step objects (pc/flow/width/nextPc); 'compact' = one string per step (`$PC flow->$target`) + a `pcRanges` loop-map with hit counts (~90% fewer tokens for triage)."),
      frames: z.number().int().min(1).max(1_000_000).default(1).describe("op=step/stepAndShot/sideBySide/compareRam/compareRender/traceInstructions/fuzzRecompile: frames to advance (traceInstructions: frames traced, max 600; fuzzRecompile: frames per seed, 1 = the default 3600) (1-1,000,000). For the slot-A/B compare ops, BOTH hosts step the same amount. 36000 (10 min) usually completes in <1s - don't be conservative."),
      slot: z.enum(["a", "b"]).default("a").describe("op=step/traceInstructions: which host to advance (or trace). 'a' (default) = the session's primary host. 'b' = the comparison host loaded via loadMedia({slot:'b'}) - use it to WARM each side to a chosen frame before frame({op:'findDiverge'}), which is required when the two sides only split deep into a run (compare from frame 60, not from power-on). Slot-B steps drive no presentation, no bezel, no livestream and no auto-snapshot."),
      region: z.string().optional().describe("op=compareRam/findDiverge/portStatus: memory region to diff across the two slots (default 'system_ram', the portable work-RAM). Both hosts must expose it."),
      regionB: z.string().optional().describe("op=findDiverge: slot-B region if different. wasmcart requires 'linear_memory' plus offsetB and compareLength locating the recompiled machine's RAM."),
      offsetA: z.number().int().min(0).default(0).describe("op=findDiverge: byte offset into slot A's selected region."),
      offsetB: z.number().int().min(0).default(0).describe("op=findDiverge: byte offset into slot B's selected region / WASM linear memory."),
      compareLength: z.number().int().min(1).max(16777216).optional().describe("op=findDiverge: number of bytes to compare. Required for wasmcart; map the emulated RAM explicitly, not the whole heap."),
      restore: z.boolean().default(true).describe("op=findDiverge: restore both machine states after searching. Native WASM runtimes cannot generally snapshot hidden VM state; pass false explicitly to advance both slots instead."),
      maxRanges: z.number().int().min(1).max(256).default(24).describe("op=compareRam: cap on the diverging address ranges returned (largest first)."),
      maxFrames: z.number().int().min(1).max(100000).default(600).describe("op=findDiverge: max frames to step in lockstep looking for the first divergence (default 600 = ~10s). In recompile mode: frames compared (each `stride` apart)."),
      cart: z.string().optional().describe("op=verifyRecompile/findDiverge/fuzzRecompile/cycles: path to the recompiled cart (.wasc, a bare .wasm that is wrapped in memory, or a natively recompiled .s32; op=cycles loads a sync32 cart fresh into slot A). Its `romdev.recompile` custom section, when present, supplies the reference platform, ROM sha1, warmupFrames, screen origin, button convention and the regions/fields to compare. Omitted: the wasmcart already in a slot."),
      reference: z.string().optional().describe("op=verifyRecompile/findDiverge: path to the SOURCE ROM, run on its reference core in slot B. Refused when the cart's section records a different ROM sha1. Omitted: the ROM already in the other slot."),
      platform: z.string().optional().describe("op=verifyRecompile/findDiverge: the reference core's loadMedia platform ('sms', 'gg', 'nes', 'gb', 'gbc', 'genesis', 'snes', 'gba'). Default: the cart section's `reference`/`platform`."),
      referenceCore: z.string().optional().describe("op=verifyRecompile/findDiverge: run the reference on a second core of the platform instead of its own (snes: 'bsnes', the accuracy reference for the firmware coprocessors ST011/ST018; the default is the core the recompiler follows, snes9x). A cart follows its reference core's timing, so another core measures how far that core's machine is from it; the cart's section can also name one."),
      firmware: z.string().optional().describe("op=verifyRecompile/findDiverge: path to the coprocessor firmware a cart was built with (its section's firmware, e.g. st011.rom), when it is not beside the reference ROM or in a firmware/ directory there; sha1 checked, then put in the reference core's system directory."),
      from: z.number().int().min(1).optional().describe("op=cycles: first measured frame, counted in frames stepped since loadMedia (default: the next frame). The session steps there first on the same input schedule."),
      to: z.number().int().min(1).optional().describe("op=cycles: last measured frame (default from+599, or from+frames-1). At most 4096 frames per call."),
      profile: z.boolean().optional().describe("op=cycles: also run s32core's pc-sampling profiler over from..to and attribute the cycles (per function, per object file, per group) with the cart's linker map (<cart>.map, written by disasm emit:'sync32'; or pass map). Profiled frames run in the core's slower instrumented loop; the cycle model is the same."),
      map: z.string().optional().describe("op=cycles: path of the GNU ld map for profile attribution (default <cart>.map)."),
      groups: z.record(z.string(), z.array(z.string())).optional().describe("op=cycles: profile groups, name -> object-file names or '/regex/' (a native Genesis cart gets 68000/VDP/Z80/YM2612/PSG/mix/host groups by default)."),
      top: z.number().int().min(1).max(200).optional().describe("op=cycles: how many functions to list (default 25)."),
      series: z.boolean().optional().describe("op=cycles: include every frame's cycle count."),
      annotate: z.string().optional().describe("op=cycles: a function name from the cart's map: per-instruction cycles per frame over from..to, with its Thumb-2 disassembly (hottest `top` instructions)."),
      perFrame: z.boolean().optional().describe("op=cycles with profile:true: split EVERY frame by subsystem group (min/mean/p95/max per group, the worst frame's split; with series:true the per-frame group series)."),
      atFrames: z.array(z.number().int().min(1)).min(1).max(64).optional().describe("op=verifyRecompile: REFERENCE frames (frames stepped after loadMedia on the reference core) to score, ascending. Pick late frames with real, moving pictures: a title screen proves little. Omitted (without auto:false): auto mode chooses them."),
      auto: z.union([z.boolean(), z.object({
        seed: z.number().int().min(1).optional().describe("seed of the candidate play scripts (default 1)"),
        horizon: z.number().int().min(120).max(36000).optional().describe("reference frames each candidate runs (default 3600)"),
        candidates: z.number().int().min(1).max(64).optional().describe("candidate schedules at most, the no-input baseline not counted (default 16)"),
        sampleEvery: z.number().int().min(5).max(600).optional().describe("frames between scored samples of each run (default 30)"),
        frames: z.number().int().min(1).max(64).optional().describe("scored frames to choose (default 6)"),
        audioWindow: z.number().int().min(30).max(36000).optional().describe("audio frames compared at most (default 600)"),
        budgetSec: z.number().min(5).max(7200).optional().describe("wall-clock cap on the exploration in seconds (default 300)"),
      }).strict()]).optional().describe("op=verifyRecompile: AUTO MODE (see the op description): romdev picks input, atFrames and the audio window from the reference core, then verifies. true = defaults; an object tunes {seed, horizon, candidates, sampleEvery, frames, audioWindow, budgetSec}. Implied when atFrames is omitted; auto:false restores the 'pass atFrames' error. Combine with input to keep your schedule. The result's auto block reports what was chosen and a reproduce call."),
      input: z.union([z.string(), z.array(z.object({ frame: z.number().int().min(0), buttons: z.union([z.string(), z.array(z.string()), z.record(z.string(), z.boolean())]), hold: z.number().int().min(1).optional() }))]).optional().describe("op=verifyRecompile/findDiverge/fuzzRecompile/cycles: ONE input schedule (op=cycles: frames counted since loadMedia) applied to both sides, in REFERENCE frames: 'frame:buttons:hold,...' (e.g. '700:start:10,900:right+b:15') or [{frame, buttons:'a+right'|['a']|{a:true}, hold}]. libretro names (a,b,x,y,l,r,start,select,up,down,left,right) or spatial names (south,east,west,north); prefix 'p2.' (p1-p4) for another controller ('900:p2.start:10'); the cart gets each press at frame+offset, by physical position."),
      wrongInput: z.union([z.string(), z.array(z.object({ frame: z.number().int().min(0), buttons: z.union([z.string(), z.array(z.string()), z.record(z.string(), z.boolean())]), hold: z.number().int().min(1).optional() }))]).optional().describe("op=verifyRecompile: schedule for the wrong-input control (default: withhold ALL input; if the picture still matches, a perturbed script with the start/select presses kept and every other press replaced). The control must FAIL."),
      cartFrameOffset: z.union([z.number().int().min(-10000).max(10000), z.literal("auto")]).optional().describe("op=verifyRecompile/findDiverge: override the computed alignment (cart frame = reference frame + offset). Default: reference settle frames - wasmcart settle frame (1) - the cart's warmupFrames, unless the cart's section says frameAlignment:'search'. 'auto' (or that section flag) FINDS the offset: a fresh cart and reference are run to searchFrame, every cart offset within +-searchWindow of the computed one is scored against that one reference picture, and the sharp peak wins (refused, naming the best candidates, when the peak is flat or below the bar). Each scored frame then refines it by up to +-2 when its own sweep peaks sharply elsewhere (row.refinedBy). Cost: one extra cart run to searchFrame+offset+window and 2*window+1 picture scores."),
      searchFrame: z.number().int().min(1).optional().describe("op=verifyRecompile/findDiverge: reference frame the offset search runs at (default: the first of atFrames; for findDiverge max(startFrame, 600)). Pick a frame whose picture moves, before the first input press if the game's timeline depends on when input arrives."),
      searchWindow: z.number().int().min(1).max(600).optional().describe("op=verifyRecompile/findDiverge: offsets searched either side of the computed one (default 120)."),
      minSharpness: z.number().min(0).max(100).optional().describe("op=verifyRecompile/findDiverge: points the searched peak must stand above every candidate two or more frames from it (default 2)."),
      sweep: z.number().int().min(0).max(30).optional().describe("op=verifyRecompile: also score cart frames +-sweep around each aligned frame and report the peak offset and its sharpness (peak minus best neighbour). A sharp peak at 0 means the cart tracks the reference; the verdict always scores the ALIGNED pair. Default 0."),
      cartOrigin: z.array(z.number().int().min(0)).length(2).optional().describe("op=verifyRecompile: [x,y] of the reference picture inside the cart framebuffer (e.g. [48,24] for a Game Gear cart rendering the full 256x192 raster). Default: the section's screen.origin, else centred."),
      cartButtonMap: z.record(z.string(), z.string()).optional().describe("op=verifyRecompile/findDiverge/fuzzRecompile: rename buttons for the CART side only, for a legacy cart that reads wasmcart pad bits by name instead of position (e.g. {a:'b', b:'a'}). A section with buttons:'byName' implies exactly that swap."),
      regions: z.record(z.string(), z.object({ offset: z.number().int().min(0), length: z.number().int().min(1), ref: z.string(), refOffset: z.number().int().min(0).optional(), transform: z.enum(["swap16", "lowbyte16", "highbyte16"]).optional(), mask: z.number().int().min(0).max(255).optional(), compare: z.boolean().optional() })).optional().describe("op=verifyRecompile/findDiverge: cart linear-memory spans to byte-compare against reference memory regions, {name:{offset,length,ref:'<region>',refOffset?,transform?,mask?}}. Merged over the cart's romdev.recompile section (same name = caller wins); the only source for a cart without the section. transform applies to the reference bytes (lowbyte16 = keep the low byte of each u16 word, e.g. gpgx's SMS CRAM); mask ANDs both sides; compare:false marks a DIAGNOSTIC region (reported with '(diag)', never in stateIdentical, the verdict or findDiverge)."),
      fields: z.record(z.string(), z.object({ offset: z.number().int().min(0), size: z.number().int().optional(), signed: z.boolean().optional(), mask: z.number().int().min(0).optional(), ref: z.union([z.string(), z.object({ cpu: z.string().optional(), region: z.string().optional(), offset: z.number().int().min(0).optional(), size: z.number().int().optional() })]).optional() })).optional().describe("op=verifyRecompile/findDiverge: scalar cart fields (little-endian, size 1/2/4 at `offset`) compared with the reference: ref 'cpu:<path>' reads cpu({op:'read'}) (e.g. 'cpu:pc', 'cpu:registers.A', 'cpu:coreInternal.count'), or '<region>+<offset>' / {region, offset} reads a reference memory region (e.g. genesis_m68k+5208 for Musashi's pc). mask ANDs both values."),
      probe: z.record(z.string(), z.object({ offset: z.number().int().min(0), size: z.number().int().optional() })).optional().describe("op=verifyRecompile/fuzzRecompile: cart-only probe fields reported per frame; a nonzero `trapped` fails the verdict (fuzzRecompile: is the trap it looks for)."),
      warmupFrames: z.number().int().min(0).max(1000).optional().describe("op=verifyRecompile/findDiverge: frames the cart runs inside its FIRST wc_render beyond the one the host counts (overrides the section's warmupFrames)."),
      vramZero: z.array(z.string()).optional().describe("op=verifyRecompile: region names the VRAM-zero control wipes (default: regions named *vram*/*chr*/*nametable*)."),
      controls: z.array(z.enum(["vramZero", "wrongFrame", "wrongInput"])).optional().describe("op=verifyRecompile: which must-fail controls to run (default all three). Dropping one is a claim you can defend: a still screen makes wrongFrame unfailable."),
      movingWindow: z.number().int().min(1).max(600).optional().describe("op=verifyRecompile: frames back for the moving-pixel mask (default 10)."),
      wrongFrameDelta: z.number().int().min(1).max(10000).optional().describe("op=verifyRecompile: how far before the right frame the wrong-frame control's reference is. Default: 5/10/20/30/60/120 are tried and the one where the reference picture CHANGED most is used (controls.wrongFrame.delta, .tried)."),
      wrongFrameMaxDelta: z.number().int().min(1).max(10000).optional().describe("op=verifyRecompile: upper bound on the wrong-frame candidates (default 120)."),
      minChangePx: z.number().int().min(1).optional().describe("op=verifyRecompile: pixels that must differ between the right and wrong reference frames before the wrong-frame control may be decided on them (default 50)."),
      minContentPct: z.number().min(0).max(100).optional().describe("op=verifyRecompile: bar for strict content % (default 95)."),
      minContentPx: z.number().int().min(0).optional().describe("op=verifyRecompile: minimum reference content pixels for a frame to count as evidence (default 2000)."),
      minMovingPct: z.number().min(0).max(100).optional().describe("op=verifyRecompile: bar for moving-pixel % (default 95)."),
      minMovingPx: z.number().int().min(0).optional().describe("op=verifyRecompile: moving pixels needed before the moving bar applies to a frame (default 200)."),
      requireStateMatch: z.boolean().optional().describe("op=verifyRecompile: any compared region/field difference fails the verdict (default TRUE: matching pixels over differing memory is not a verified recompile). false only reports differences in stateDiffs and lets the pixels decide; diagnostic regions (compare:false) never count."),
      outputDir: z.string().optional().describe("op=verifyRecompile: directory for the [cart|ref|diff] PNGs (default a temp dir, reported as outputDir)."),
      tag: z.string().optional().describe("op=verifyRecompile: PNG filename prefix (default the cart's basename)."),
      level: z.enum(["frame", "instruction"]).optional().describe("op=findDiverge (recompile mode): 'frame' (default) compares regions/fields per frame; 'instruction' traces one frame on both sides and returns the first divergent instruction (see the op description)."),
      atFrame: z.number().int().min(0).optional().describe("op=findDiverge level:'instruction': the REFERENCE frame whose execution is traced (from the end of atFrame-1 to the end of atFrame). Default: the first frame the per-frame differ finds different (bounded by startFrame/maxFrames)."),
      context: z.number().int().min(0).max(200).optional().describe("op=findDiverge level:'instruction': instructions of context reported on each side of a divergence (default 8)."),
      refState: z.boolean().optional().describe("op=findDiverge level:'instruction': read the reference CPU registers at the first pc divergence by replaying the frame to that instruction under the instruction watchdog (default true; single-CPU cores)."),
      seeds: z.array(z.number().int()).min(1).max(64).optional().describe("op=fuzzRecompile: seeds of the random play scripts (default [1,2,3])."),
      fromPc: z.number().int().min(0).optional().describe("op=traceInstructions: start the returned stream at the first execution of this pc (in the host's own pc spelling)."),
      maxEntries: z.number().int().min(4096).max(4194304).optional().describe("op=traceInstructions: core trace ring capacity (default 2,097,152 entries; the oldest are overwritten past it)."),
      head: z.number().int().min(0).max(4096).optional().describe("op=traceInstructions: entries returned inline (default 64); the rest go to outputPath."),
      startFrame: z.number().int().min(0).optional().describe("op=findDiverge: recompile mode - first reference frame compared; earlier frames run but are not compared (use it to bisect a late divergence cheaply)."),
      stride: z.number().int().min(1).max(10000).optional().describe("op=findDiverge: recompile mode - compare every Nth frame (default 1). A hit at stride N is between the reported frame and the last identical one; rerun there with stride 1."),
      audio: z.union([z.boolean(), z.literal("required")]).optional().describe("op=verifyRecompile: capture and score both sides' audio per frame (true = reported under `audio`; 'required' = an audio mismatch, a silent reference or an audio control that does not fail makes the run NOT VERIFIED). op=findDiverge (recompile): also compare each frame's audio chunk (sample count + samples); the first frame whose audio differs is a divergence (result.audio names the frame, the first differing sample and both counts)."),
      audioFrames: z.array(z.number().int().min(1)).length(2).optional().describe("op=verifyRecompile audio: [from, to] REFERENCE frames whose audio is compared (default [1, the last of atFrames]); the cart side is the same frames + the alignment offset."),
      audioStream: z.string().optional().describe("op=verifyRecompile/findDiverge audio: the reference stream: 'output' (what the core gives audio_batch_cb) or the name of a per-frame audio stream region the core exposes ('RDAS' header, e.g. a pre-resample stream). Default: the cart section's audio.reference, else 'output'."),
      audioBar: z.object({ minSpectral: z.number().min(0).max(1).optional(), minEnvelope: z.number().min(-1).max(1).optional() }).optional().describe("op=verifyRecompile audio: bar for streams whose rates differ (mode 'similar'): spectral similarity and envelope correlation (default 0.9 each). Exact mode (same rate and layout) needs 100% sample-exact, equal per-frame counts and xcorr lag 0."),
      audioControls: z.array(z.enum(["silence", "shift", "stereoDrop", "channelDrop"])).optional().describe("op=verifyRecompile audio: which audio must-fail controls run (default all four; channelDrop needs the section's audio.muteMask)."),
      audioDropChannel: z.string().optional().describe("op=verifyRecompile audio: the muteMask channel the channelDrop control silences (default: each declared channel in turn until one fails)."),
      audioWav: z.boolean().optional().describe("op=verifyRecompile audio: write <tag>_audio_cart.wav / _ref.wav / _diff.wav (diff = cart - ref, same rate only) to outputDir."),
      audioMaxLag: z.number().int().min(1).max(1000000).optional().describe("op=verifyRecompile audio: cross-correlation lag search either side of 0, in reference samples (default two frames of audio)."),
      format: z.enum(["png", "ascii", "full", "compact"]).default("png").describe("op=screenshot: 'png' (default, real image) or 'ascii' (lossy text render). op=stepInstructions: 'full' or 'compact' is accepted here as the trace format (same as stepFormat)."),
      source: z.enum(["composite", "core", "both"]).optional().describe("op=screenshot/stepAndShot, with an Active Bezel loaded: which picture to capture. 'composite' (default when a bezel is active) = the final scene the package rendered, which is what the human sees. 'core' = the RAW emulator framebuffer, ignoring the bezel. 'both' returns the two together - the comparison that shows whether the package's interpretation actually matches the game. Without a bezel, every value returns the core frame."),
      path: z.string().optional().describe("op=screenshot/stepAndShot/traceInstructions: absolute path to write to (required unless inline:true). `outputPath` is accepted as an alias - memory({op:'read'}) spells it that way, and one name failing on the other tool cost round trips."),
      outputPath: z.string().optional().describe("Alias for `path` (op=screenshot/stepAndShot), so the spelling memory({op:'read'}) uses works here too."),
      inline: z.boolean().default(false).describe("op=screenshot/stepAndShot: return the image in the response instead of writing to disk."),
      overlayBoxes: z.boolean().default(false).describe("op=screenshot png: draw a colored bounding box per visible sprite (SNES+NES only)."),
      crop: z.object({ x: z.number().int().min(0).optional(), y: z.number().int().min(0).optional(), w: z.number().int().min(1).optional(), h: z.number().int().min(1).optional() }).optional().describe("op=screenshot png: crop to a framebuffer-pixel rect BEFORE any scale (clamped to the frame). THE HUD-verification token-saver: a native-res strip of the counter/bar is legible AND a fraction of the image tokens of the full frame (poke a value → crop-read the HUD in one call, no external image tools). Compose with integer scale for an enlarged detail view."),
      scale: z.number().gt(0).max(16).refine((s) => s <= 1 || Number.isInteger(s), { message: "scale must be 0<scale≤1 (downscale) or an integer ≥2 (upscale)" }).optional().describe("op=screenshot png: nearest-neighbor resample factor. DEFAULT (unset/1) = NATIVE resolution - perfect pixels, the accurate representation; use this. 0<scale<1 DOWNscales (0.5 ≈ 75% fewer image tokens - useful for cheap 'did it change?' checks; NOT for READING text/counters - an 8px HUD font is illegible below native; use native res, ideally with `crop`). integer scale≥2 UPscales by pixel-duplication (e.g. scale:4 → GB 160x144 → 640x576): it adds NO information (same pixels enlarged), costs MORE image tokens, and since VLM encoders resize to their own fixed resolution it may not change what the model sees and can slightly degrade it. Only for clients that render tiny images too small to use and can't zoom."),
      cols: z.number().int().min(4).max(640).optional().describe("op=screenshot ascii: terminal columns (default fb_width/8 - one cell per 8×8 tile, legible game state)."),
      rows: z.number().int().min(4).max(480).optional().describe("op=screenshot ascii: terminal rows (default fb_height/8)."),
      symbols: z.enum(["ascii", "halfblock", "block", "quad", "sextant"]).default("ascii").describe("op=screenshot ascii: chafa symbol set."),
      colors: z.enum(["true", "256", "16", "fgbg"]).default("256").describe("op=screenshot ascii: color depth. Default '256' (indexed) - far fewer ANSI escape bytes than 'true' (truecolor per cell) for a near-identical read. Use 'true' only when exact color matters."),
    },
    safeTool(async (rawArgs) => {
      // One spelling wins before dispatch, so no core has to know both.
      const args = rawArgs.outputPath && !rawArgs.path
        ? { ...rawArgs, path: rawArgs.outputPath }
        : rawArgs;
      switch (args.op) {
        case "step": {
          // `count` is accepted as an alias: stepInstructions spells "how
          // many" that way and the unit is fixed by the op.
          if (args.count != null && args.frames !== 1 && args.count !== args.frames) throw new Error(`frame({op:'step'}): pass frames OR count, not both (${args.frames} vs ${args.count}).`);
          return doStep(args.count != null ? { ...args, frames: args.count } : args);
        }
        case "screenshot":
          if (args.format === "full" || args.format === "compact") throw new Error(`frame({op:'screenshot'}): format:'${args.format}' is a stepInstructions trace format; a screenshot takes 'png' or 'ascii'.`);
          return doScreenshot(args);
        case "stepAndShot":     return doStepAndShot(args);
        case "sideBySide":      return await doSideBySide(args);
        case "compareRam":      return compareRam(args);
        case "findDiverge":     return findDiverge(args);
        case "compareRender":   return await compareRender(args);
        case "portStatus":      return await portStatus(args);
        case "stepInstruction": return await stepInstructionCore(sessionKey);
        case "stepInstructions":
          if (args.count != null && args.count > 4096) throw new Error(`frame({op:'stepInstructions'}): count ${args.count} is over the 4096 cap - trace in chunks of <= 4096.`);
          return await stepInstructionsCore(sessionKey, { count: args.count ?? 16, withRegisters: args.withRegisters, format: args.format === "full" || args.format === "compact" ? args.format : args.stepFormat });
        case "verifyRecompile": return jsonContent(await runVerifyRecompile(sessionKey, { ...args }));
        case "fuzzRecompile": return jsonContent(await runFuzzRecompile(sessionKey, { ...args, frames: args.frames === 1 ? undefined : args.frames }));
        case "traceInstructions": return await traceInstructionsCore(sessionKey, { frames: args.frames, slot: args.slot, maxEntries: args.maxEntries, fromPc: args.fromPc, outputPath: args.path, head: args.head });
        case "verify":          return await doVerify(args);
        case "cycles":          return jsonContent(await runS32Cycles(sessionKey, args));
        default: throw new Error(`frame: unknown op '${args.op}'`);
      }
    }),
  );
}
