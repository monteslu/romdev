// runRom.js — the human "fire it up" tier: one call opens an SDL window
// running a ROM on any romdev-core-* emulator core, with keyboard + hot-plug
// gamepad input, audio at the core's native rate, and aspect-correct
// pixel-perfect scaling. Built on romdev-core-host (the same libretro host
// the romdev MCP server uses) + the initSdl() hardening in ./sdl.js.
//
// DELIBERATELY SIMPLE. No agent surface: no save-state checkpoints, no rewind
// ring, no live-host-follow, no audio-paced burst stepping — those live in
// romdev's playtest (the agent tier). If this file starts growing them, it is
// becoming romdevtools; stop. (See internal plan §4.3.)

import path from "node:path";
import { readFile } from "node:fs/promises";
import { LibretroHost } from "romdev-core-host";
import { initSdl } from "./sdl.js";
import {
  SDL_BUTTON_TO_LIBRETRO_BIT,
  KEY_TO_LIBRETRO_BIT,
  STICK_DEADZONE,
  makeTriggerState,
  deriveTriggerState,
  normAxis,
  bitToName,
  tvAspectFor,
  effectiveAspect,
  initialWindowSize,
  letterbox,
  framebufferToRgba,
} from "./present.js";

/**
 * Resolve the caller's `core` option into { jsPath, wasmPath }.
 * Accepts a romdev-core-* package namespace (with a `core` export), a
 * { jsPath, wasmPath } object, or a { core: { jsPath, wasmPath } } wrapper.
 */
function resolveCorePaths(core) {
  if (!core) throw new Error("runRom: `core` is required — pass a romdev-core-* package namespace or { jsPath, wasmPath }");
  const c = core.core ?? core;
  if (typeof c.jsPath === "string" && typeof c.wasmPath === "string") {
    return { jsPath: c.jsPath, wasmPath: c.wasmPath };
  }
  throw new Error("runRom: couldn't find jsPath/wasmPath on `core` — pass a romdev-core-* package (import * as core from \"romdev-core-fceumm\") or { jsPath, wasmPath }");
}

/**
 * Open an SDL window and play a ROM on a romdev core until the human closes
 * it (ESC, window close, or Select+Start on the pad).
 *
 * @param {string | Uint8Array} rom  path to the ROM file, or its raw bytes
 * @param {Object} opts
 * @param {any} opts.core          a romdev-core-* package namespace or {jsPath,wasmPath}
 * @param {string} [opts.platform] platform id for the host (inferred from the
 *                                 core package's `platform` export when present)
 * @param {Record<string, number>} [opts.buttonMap] SDL button name → RetroPad bit
 *                                 (replaces the default map — GameTank/C64 layouts)
 * @param {Record<string, number>} [opts.keyMap]    keyboard key → RetroPad bit override
 * @param {number} [opts.scale=3]  initial window scale (multiples of framebuffer height)
 * @param {string} [opts.title]    window title (default: ROM basename + platform)
 * @param {"tv"|"fb"|"core"} [opts.aspect="tv"] window aspect: real-hardware
 *                                 display shape (tv), raw framebuffer (fb), or
 *                                 the core-reported ratio (core)
 * @param {(msg: string) => void} [opts.log] progress/warning logger (default: silent)
 * @returns {Promise<{ stop: () => void, closed: Promise<void>, host: LibretroHost,
 *                     frameCount: number, running: boolean }>}
 */
export async function runRom(rom, opts = {}) {
  const { jsPath, wasmPath } = resolveCorePaths(opts.core);
  const platform = opts.platform ?? opts.core?.platform ?? null;
  const scale = opts.scale ?? 3;
  const aspectMode = opts.aspect ?? "tv";
  const log = opts.log ?? (() => {});
  const buttonMap = opts.buttonMap ?? SDL_BUTTON_TO_LIBRETRO_BIT;
  const keyMap = opts.keyMap ?? KEY_TO_LIBRETRO_BIT;

  // SDL first — fail fast (and honestly: SDL_UNAVAILABLE) before touching the core.
  const sdl = await initSdl({ log, ...(opts._initSdlOpts ?? {}) });

  // Load core + ROM.
  const host = new LibretroHost();
  await host.loadCore(jsPath, wasmPath, {});
  const bytes = typeof rom === "string" ? new Uint8Array(await readFile(rom)) : rom;
  const name = typeof rom === "string" ? path.basename(rom) : "rom";
  host.loadMedia({ platform, bytes, name });

  const title = opts.title ?? (typeof rom === "string"
    ? `${path.basename(rom).replace(/\.[^.]+$/, "")}${platform ? ` (${platform})` : ""}`
    : platform ? `romdev — ${platform}` : "romdev");

  // First frame → framebuffer geometry → window size.
  host.stepFrames(1);
  const first = host.getFramebuffer();
  const fbWidth = first.width, fbHeight = first.height;
  const { width: winInitW, height: winInitH } = initialWindowSize({
    fbWidth, fbHeight, scale, aspectMode,
    platform: host.status.platform ?? platform,
    displayAspect: host.status.displayAspect,
  });

  // HW-render cores already own a GL context via native-gles; an accelerated
  // SDL window would open a second GL context on the same display and collide
  // (X BadAccess) — software blit for those, accelerated for the rest.
  const window = sdl.video.createWindow({
    title,
    width: winInitW,
    height: winInitH,
    resizable: true,
    accelerated: host.hwRender ? false : true,
    vsync: false,
  });

  // Audio at the core's native rate (mismatched rates click/starve).
  let audio = null;
  const sampleRate = Math.round(host.status.audioSampleRate ?? 48000);
  try {
    audio = sdl.audio.openDevice({ type: "playback" }, { channels: 2, frequency: sampleRate, format: "s16" });
    audio.play();
  } catch (e) {
    log(`audio init failed (continuing silent): ${e.message}`);
  }

  // Two-slot controllers with SDL hot-plug (player 1 keeps slot 0).
  /** @type {[any|null, any|null]} */
  const controllers = [null, null];
  function openInFreeSlot(device) {
    for (const slot of controllers) if (slot && slot._device === device) return;
    const idx = controllers.findIndex((c) => c == null);
    if (idx < 0) return;
    try {
      const inst = sdl.controller.openDevice(device);
      inst._device = device;
      controllers[idx] = inst;
      log(`controller slot ${idx + 1}: ${device.name}`);
    } catch (e) {
      log(`controller open failed: ${e.message}`);
    }
  }
  function closeBySlotMatching(device) {
    for (let i = 0; i < controllers.length; i++) {
      if (controllers[i] && controllers[i]._device === device) { controllers[i] = null; return; }
    }
  }
  for (const dev of sdl.controller.devices) {
    openInFreeSlot(dev);
    if (controllers.every((c) => c)) break;
  }
  const onDeviceAdd = (e) => openInFreeSlot(e.device);
  const onDeviceRemove = (e) => closeBySlotMatching(e.device);
  sdl.controller.on("deviceAdd", onDeviceAdd);
  sdl.controller.on("deviceRemove", onDeviceRemove);

  // Keyboard state.
  /** @type {Set<string>} */
  const heldKeys = new Set();
  let running = true;
  let frameCount = 0;
  // Title-bar fps window + reused RGBA conversion buffer (no per-tick alloc).
  let fpsFrames = 0, fpsWinStart = 0;
  /** @type {Buffer|null} */
  let rgbaScratch = null;
  let closeResolver = null;
  const closedPromise = new Promise((r) => { closeResolver = r; });

  window.on("close", () => stop());
  window.on("keyDown", (e) => {
    if (e.key === "escape") { stop(); return; }
    if (e.key) heldKeys.add(e.key.toLowerCase());
  });
  window.on("keyUp", (e) => { if (e.key) heldKeys.delete(e.key.toLowerCase()); });

  function stop() {
    if (!running) return;
    running = false;
    if (interval) clearInterval(interval);
    try { sdl.controller.off("deviceAdd", onDeviceAdd); } catch { /* detached */ }
    try { sdl.controller.off("deviceRemove", onDeviceRemove); } catch { /* detached */ }
    try { audio?.close(); } catch { /* already closed */ }
    try { if (!window.destroyed) window.destroy(); } catch { /* already gone */ }
    try { host.unloadMedia?.(); } catch { /* best-effort */ }
    if (closeResolver) closeResolver();
  }

  // Pace to the core's native refresh rate (a 30fps core double-ticked at 60Hz
  // falls behind every tick). Clamped so a bogus report can't run wild.
  const coreFps = host.status?.coreFps;
  const fps = (coreFps >= 20 && coreFps <= 120) ? coreFps : 60;
  const frameMs = 1000 / fps;

  // Per-slot trigger tracking (baseline + hysteresis) — the SAME derivation
  // playtest uses (present.js), so "when does a trigger count as pressed"
  // cannot disagree between the two windows.
  const triggerStates = [makeTriggerState(), makeTriggerState()];

  function readControllerInto(port, inst, outQuit, slot) {
    if (!inst) return;
    const btn = inst.buttons || {};
    if ((btn.back || btn.guide) && btn.start) { outQuit.quit = true; return; }
    for (const [sdlName, bit] of Object.entries(buttonMap)) {
      if (btn[sdlName]) port[bitToName(bit)] = true;
    }
    const axes = inst.axes || {};
    const lx = axes.leftStickX ?? 0;
    const ly = axes.leftStickY ?? 0;
    if (lx > STICK_DEADZONE) port.right = true;
    else if (lx < -STICK_DEADZONE) port.left = true;
    if (ly > STICK_DEADZONE) port.down = true;
    else if (ly < -STICK_DEADZONE) port.up = true;
    const trig = deriveTriggerState(axes, triggerStates[slot] ?? makeTriggerState());
    if (trig.l2) port.l2 = true;
    if (trig.r2) port.r2 = true;
    // Raw analog passthrough — feeds the host's ANALOG device (real stick
    // deflection) and any Active Bezel input reads; additive to the mask.
    port.axes = {
      lx: normAxis(lx), ly: normAxis(ly),
      rx: normAxis(axes.rightStickX ?? 0), ry: normAxis(axes.rightStickY ?? 0),
      lt: trig.lt, rt: trig.rt,
    };
  }

  function tick() {
    if (!running || window.destroyed) { stop(); return; }
    // Title-bar fps (1/s): what the machine actually achieves, not the target.
    {
      const now = performance.now();
      if (!fpsWinStart) fpsWinStart = now;
      else if (now - fpsWinStart >= 1000) {
        const fps = Math.round((fpsFrames * 1000) / (now - fpsWinStart));
        fpsFrames = 0; fpsWinStart = now;
        try { window.setTitle(`${title} | ${fps} fps`); } catch { /* mid-teardown */ }
      }
    }
    const outQuit = { quit: false };
    const port0 = {};
    const port1 = {};
    readControllerInto(port0, controllers[0], outQuit, 0);
    readControllerInto(port1, controllers[1], outQuit, 1);
    if (outQuit.quit) { stop(); return; }
    for (const [keyName, bit] of Object.entries(keyMap)) {
      if (heldKeys.has(keyName)) port0[bitToName(bit)] = true;
    }
    host.setInput({ ports: [port0, port1] });

    try {
      const n = host.stepFrames(1);
      frameCount += n;
      fpsFrames += n;
    } catch (e) {
      log(`step error: ${e.message}`);
      stop();
      return;
    }

    // Blit, aspect-correct into the current window size.
    try {
      const fb = host.getFramebuffer();
      rgbaScratch = framebufferToRgba(fb, rgbaScratch);
      const rgba = rgbaScratch;
      let targetAspect;
      if (aspectMode === "tv") {
        targetAspect = tvAspectFor(host.status.platform ?? platform, effectiveAspect(host.status.displayAspect, fb.width, fb.height));
      } else if (aspectMode === "core") {
        targetAspect = effectiveAspect(host.status.displayAspect, fb.width, fb.height);
      } else {
        targetAspect = fb.width / fb.height;
      }
      const curW = window.pixelWidth;
      const curH = window.pixelHeight;
      const { dstX, dstY, dstW, dstH } = letterbox(curW, curH, targetAspect);
      window.render(fb.width, fb.height, fb.width * 4, "rgba32", rgba, {
        scaling: "nearest",
        dstRect: { x: dstX, y: dstY, width: dstW, height: dstH },
      });
    } catch (e) {
      if (window.destroyed || e.message?.includes("destroyed")) { stop(); return; }
      log(`render error: ${e.message}`);
    }

    // Drain this tick's audio (cap runaway latency at 250ms).
    if (audio && host.state.audioRing.length > 0) {
      try {
        const bytesPerSecond = sampleRate * 4; // stereo s16
        const queuedMs = ((audio.queued ?? 0) / bytesPerSecond) * 1000;
        if (queuedMs < 250) {
          let total = 0;
          for (const buf of host.state.audioRing) total += buf.byteLength;
          const merged = Buffer.alloc(total);
          let off = 0;
          for (const buf of host.state.audioRing) {
            merged.set(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength), off);
            off += buf.byteLength;
          }
          audio.enqueue(merged);
        }
      } catch (e) {
        if (!e.message?.includes("closed")) log(`audio enqueue error: ${e.message}`);
      }
      host.state.audioRing.length = 0;
    }
  }

  const interval = setInterval(tick, frameMs);

  return {
    stop,
    closed: closedPromise,
    host,
    get frameCount() { return frameCount; },
    get running() { return running; },
  };
}
