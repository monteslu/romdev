// Playtest — open an SDL window, render the loaded ROM at native framerate,
// drive it with whatever gamepad is plugged in. Uses the same SDL API
// pattern as the working retroemu player.

import {
  RETRO_PIXEL_FORMAT_0RGB1555,
  RETRO_PIXEL_FORMAT_RGB565,
  RETRO_PIXEL_FORMAT_XRGB8888,
} from "../host/retroConstants.js";
import { log } from "../mcp/log.js";
import path from "node:path";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);

// One-pixel solid-black RGBA buffer; we stretch it across the letterbox
// bars each frame so they don't smear with leftover pixels.
const BLACK_PIXEL = Buffer.from([0, 0, 0, 0xFF]);

/**
 * Choose a default window title from the loaded host. Prefers the loaded
 * ROM/project basename (e.g. "asteroids.sfc" → "asteroids"); for in-memory
 * builds (runSource) the path is a synthetic "<memory.sfc>" with no project
 * name, so fall back to the platform, then the generic label.
 * @param {import("../host/index.js").LibretroHost} host
 * @returns {string}
 */
export function deriveTitle(host) {
  const mediaPath = host?.status?.mediaPath ?? "";
  const platform = host?.status?.platform ?? null;
  // Synthetic in-memory paths look like "<memory.sfc>" or "/rom.sfc" — no
  // real project name. Treat those as nameless and fall back.
  const real = mediaPath && !/^<memory|^\/rom\b|^\/rom\./.test(mediaPath);
  if (real) {
    const base = path.basename(mediaPath).replace(/\.[^.]+$/, "");
    if (base) return platform ? `${base} (${platform})` : base;
  }
  return platform ? `romdev — ${platform}` : "romdev playtest";
}

/**
 * Find the on-disk root directory of the @kmamal/sdl package. Its `exports`
 * field doesn't expose `./package.json`, so we resolve the main entry and walk
 * up to the nearest directory containing a package.json. Exported for tests.
 * @returns {string | null}
 */
export function sdlPackageRoot() {
  let entry;
  try {
    entry = require.resolve("@kmamal/sdl");
  } catch {
    return null;
  }
  let dir = path.dirname(entry);
  while (dir !== path.dirname(dir)) {
    if (existsSync(path.join(dir, "package.json"))) return dir;
    dir = path.dirname(dir);
  }
  return null;
}

/**
 * @kmamal/sdl ships its native binary (`dist/sdl.node`) via an `install`
 * lifecycle script — NOT in the npm tarball. When romdev is started with
 * `npx romdev-mcp`, npm's transitive install path skips that script, so the
 * binary is never fetched and `require('../../dist/sdl.node')` throws
 * ERR_MODULE_NOT_FOUND. Worse, Node's ESM loader CACHES a failed dynamic import
 * for the process lifetime — so once the first `import("@kmamal/sdl")` rejects,
 * it can never recover, even after the binary appears on disk.
 *
 * So we must verify (and repair) the binary BEFORE the first import. This
 * locates @kmamal/sdl, checks for dist/sdl.node, and if missing runs its own
 * scripts/install.mjs to download the prebuilt binary, then imports once.
 *
 * On failure throws an Error tagged with `.sdlKind` ("missing-binary" |
 * "install-failed" | "sdl-error") and, when actionable, `.fixCmd` — the tool
 * layer branches on these for an accurate message (vs the old one that always
 * blamed the desktop session).
 * @returns {Promise<any>} the SDL module
 */
let _sdlModule = null;
async function getSdl() {
  if (_sdlModule) return _sdlModule;

  // Resolve the package root (works under npx, local install, or a monorepo
  // symlink). Note: @kmamal/sdl's `exports` does NOT expose ./package.json, so
  // resolve the main entry and walk up to the dir that contains package.json.
  let sdlNode = null;
  let installScript = null;
  try {
    const pkgDir = sdlPackageRoot();
    if (pkgDir) {
      sdlNode = path.join(pkgDir, "dist", "sdl.node");
      installScript = path.join(pkgDir, "scripts", "install.mjs");
    }
  } catch {
    // @kmamal/sdl itself isn't installed at all — nothing we can repair.
  }

  const tag = (err, kind, fixCmd) => {
    err.sdlKind = kind;
    if (fixCmd) err.fixCmd = fixCmd;
    return err;
  };

  // Self-heal: if the prebuilt binary is missing but the install script is
  // present, run it (exactly what the skipped postinstall would have done).
  // This MUST happen before the first import — Node's ESM loader caches a
  // rejected dynamic import for the process lifetime, so a failed first import
  // could never recover even after the binary lands on disk.
  if (sdlNode && !existsSync(sdlNode) && installScript && existsSync(installScript)) {
    log("playtest: @kmamal/sdl native binary missing — fetching prebuilt via its install script…");
    try {
      await execFileAsync(process.execPath, [installScript], {
        timeout: 120000,
        // Prebuilt-only — never fall through to a node-gyp/clang source build.
        env: { ...process.env, npm_config_build_from_source: "false", npm_config_build_from_source_all: "false" },
      });
    } catch (e) {
      throw tag(new Error(
        `the @kmamal/sdl native binary isn't installed and the auto-install failed: ${e?.message ?? e}`,
      ), "install-failed", `node "${installScript}"`);
    }
  }

  // Still missing after the heal attempt → fail with the exact fix, BEFORE the
  // import (so we never cache a rejection).
  if (sdlNode && !existsSync(sdlNode)) {
    throw tag(new Error(
      `the @kmamal/sdl native binary isn't installed (expected at ${sdlNode})`,
    ), "missing-binary", installScript ? `node "${installScript}"` : undefined);
  }

  // Force nearest-neighbor scaling globally. SDL2 reads this env var at init;
  // we already pass scaling:"nearest" per render, but this is belt-and-
  // suspenders so a pixel-art ROM is NEVER blurred by bilinear filtering on any
  // path. 0 = nearest, 1 = linear, 2 = best. MUST be set before SDL inits, i.e.
  // before the import below.
  if (!process.env.SDL_RENDER_SCALE_QUALITY) {
    process.env.SDL_RENDER_SCALE_QUALITY = "0";
  }

  // Binary present (or path unresolvable — let import surface the real error).
  try {
    const ns = await import("@kmamal/sdl");
    _sdlModule = ns.default || ns;
    return _sdlModule;
  } catch (e) {
    const isModuleErr = e?.code === "ERR_MODULE_NOT_FOUND" ||
      /sdl\.node|dist[\\/]/.test(e?.message || "");
    throw tag(new Error(e?.message ?? String(e)),
      isModuleErr ? "missing-binary" : "sdl-error",
      isModuleErr && installScript ? `node "${installScript}"` : undefined);
  }
}

// Map SDL standard-controller button name → libretro JOYPAD bit.
// SDL names follow Xbox letter positions: A=bottom, B=right, X=left, Y=top.
// libretro RETRO_DEVICE_ID_JOYPAD also names by letter: B=0 (bottom-physical
// on a SNES/NES pad), A=8 (right), Y=1 (left), X=9 (top), SELECT=2, START=3,
// L=10, R=11, L2=12, R2=13, L3=14, R3=15.
//
// Both schemes share the "letter = physical position" convention, but Xbox
// swaps A/B vs SNES. We map by physical position so the bottom button is
// always "main action" (NES A / SNES B) and the right is "secondary"
// (NES B / SNES A) regardless of pad letters. That matches retroarch's
// default user mapping for an Xbox controller on a NES/SNES core.
const SDL_BUTTON_TO_LIBRETRO_BIT = {
  dpadUp: 4,
  dpadDown: 5,
  dpadLeft: 6,
  dpadRight: 7,
  a: 0,         // SDL bottom (Xbox A) → libretro B (NES A / SNES B) = main action
  b: 8,         // SDL right  (Xbox B) → libretro A (NES B / SNES A) = secondary
  x: 1,         // SDL left   (Xbox X) → libretro Y (SNES Y / unused on NES)
  y: 9,         // SDL top    (Xbox Y) → libretro X (SNES X / unused on NES)
  back: 2,      // SELECT
  guide: 2,
  start: 3,
  leftShoulder: 10,
  rightShoulder: 11,
  leftStick: 14,
  rightStick: 15,
};

// Analog stick → dpad direction (for games that only read dpad)
const STICK_DEADZONE = 8000;

// Keyboard fallback for users without a gamepad. Same physical-position
// convention as the controller map: Z = bottom (NES A / SNES B), X = right
// (NES B / SNES A), A = left (SNES Y), S = top (SNES X). Arrows for D-pad.
// Enter = Start, RShift = Select, Q/W = L/R shoulders. ESC closes the window.
//
// Key strings come straight from node-sdl keyDown/keyUp events.
const KEY_TO_LIBRETRO_BIT = {
  up: 4, down: 5, left: 6, right: 7,
  z: 0,                        // bottom face = B (NES A, SNES B) = main action
  x: 8,                        // right face  = A (NES B, SNES A)
  a: 1,                        // left  face  = Y (SNES)
  s: 9,                        // top   face  = X (SNES)
  return: 3,                   // Enter = START
  rshift: 2,                   // RShift = SELECT
  backspace: 2,                // also SELECT (laptop friendly)
  q: 10,                       // L shoulder
  w: 11,                       // R shoulder
};

// Human-readable summary printed by --help and at playtest startup.
export const KEYBOARD_BINDINGS_HELP = `Keyboard:
  Arrow keys           D-pad
  Z                    A / B (bottom face — main action; NES A, SNES B)
  X                    B / A (right face)
  A                    Y (SNES left face)
  S                    X (SNES top face)
  Q / W                L / R shoulders
  Enter                START
  RShift / Backspace   SELECT
  ESC                  Close playtest window

Emulator hotkeys (RetroArch defaults):
  P / Space            Pause / unpause emulation
  K                    Frame advance (step one frame while paused)
  R (hold)             Rewind (up to 10 seconds)
  F2                   Save state (to slot)
  F4                   Load state (from slot)

Gamepad: any SDL-recognized controller works. Physical-position mapping —
the BOTTOM face button is always the main action, regardless of pad letter.
  Select + Start (held together)   Close playtest window`;

/**
 * "TV" aspect ratio per platform. For consoles displayed on CRT
 * televisions, this is 4:3 — the actual physical screen shape, not
 * the framebuffer geometry. (Genesis H40 ships a 320×224 framebuffer
 * with displayAspect ≈ 10:7, but every actual Sega Mega Drive was
 * plugged into a 4:3 TV that stretched it horizontally.) Handheld
 * LCDs are their own aspect — GB is 10:9, GBA is 3:2.
 *
 * Fallback when platform unknown: use the core's reported displayAspect.
 *
 * @param {string | null} platform
 * @param {number} displayAspect core-reported, used as fallback
 */
/**
 * Largest rect of `targetAspect` that fits inside a winW×winH window, centered
 * (letterbox/pillarbox). Pure + exported so the aspect-on-resize behavior is
 * unit-testable without a display. The image is ALWAYS drawn at this rect, so
 * resizing the window never stretches it off-aspect — it just grows the bars.
 * @param {number} winW window backing-store width (px)
 * @param {number} winH window backing-store height (px)
 * @param {number} targetAspect desired width/height ratio
 * @returns {{dstX:number, dstY:number, dstW:number, dstH:number}}
 */
export function letterbox(winW, winH, targetAspect) {
  const winAspect = winW / winH;
  let dstW, dstH;
  if (winAspect > targetAspect) {
    // Window wider than target → full height, pillarbox left/right.
    dstH = winH;
    dstW = Math.round(winH * targetAspect);
  } else {
    // Window taller than target → full width, letterbox top/bottom.
    dstW = winW;
    dstH = Math.round(winW / targetAspect);
  }
  return {
    dstX: Math.round((winW - dstW) / 2),
    dstY: Math.round((winH - dstH) / 2),
    dstW,
    dstH,
  };
}

function tvAspectFor(platform, displayAspect) {
  switch (platform) {
    case "nes":
    case "snes":
    case "genesis":
    case "atari2600":
    case "atari7800":
    case "c64":
    case "sms":
      return 4 / 3;
    case "gg":          return 1.20;     // Game Gear LCD 160×144 → ~10:9 but stretched
    case "gb":
    case "gbc":         return 10 / 9;   // GB LCD 160×144 native
    case "gba":         return 3 / 2;    // GBA LCD 240×160 native
    case "lynx":        return 102 / 81; // Lynx LCD pixel aspect (4:3 displayed)
    default:            return displayAspect;
  }
}

/**
 * @param {Object} args
 * @param {import("../host/index.js").LibretroHost} args.host
 * @param {number} [args.scale]
 * @param {string} [args.title]
 * @param {"fb" | "tv" | "core"} [args.aspect] "fb" (default) = raw
 *   framebuffer aspect; pixels are square in the window. "tv" = the
 *   physical CRT/LCD shape the platform was designed for — 4:3 for
 *   every console that hooked to a TV, native LCD aspect for
 *   handhelds. This is what you want for "looks like the real hardware
 *   on its actual display." "core" = honor the core's reported
 *   display_aspect_ratio, which is the framebuffer's geometric ratio
 *   (often non-4:3 — Genesis H40 reports ~10:7). Use "core" when you
 *   need pixel-accurate framebuffer dimensions; use "tv" when you
 *   want the user-visible shape that matches the real hardware.
 */
export async function playtest(args) {
  const openHost = args.host;
  if (!openHost) throw new Error("playtest requires a loaded host");
  // Resolve the session's CURRENT host each frame so the window FOLLOWS a
  // rebuild. `runSource`/`loadMedia` call resetHost(), which replaces the host
  // object AND unloads the old one's media — a window pinned to the open-time
  // host would then throw "no media loaded" mid-tick and die. Following the
  // live host means the window shows the agent's latest build in place (the
  // documented "runSource updates the live game" UX) and never crashes on
  // rebuild. Falls back to the open-time host if the accessor is absent.
  const getLiveHost = typeof args.getLiveHost === "function" ? args.getLiveHost : () => openHost;
  const scale = args.scale ?? 3;
  // Default the window title to the loaded ROM/project name so the human can
  // tell which game they're looking at (instead of a generic "romdev
  // playtest"). buildProject loads with a virtualName of the project dir, and
  // file loads carry their own path — derive the basename from either. Falls
  // back to the platform name, then the generic label. An explicit `title`
  // arg always wins.
  const title = args.title ?? deriveTitle(openHost);
  // Default to "tv" — the 4:3 / native-LCD shape the game was authored for, so
  // the window looks like the real hardware (matches retroemu, which honors the
  // core's display aspect / 4:3 fallback). "fb" (raw square pixels) makes most
  // consoles look squished — NES 256×240 renders ~8% too narrow, Genesis H32
  // too tall, etc. Agents who want exact dev-time pixel geometry pass aspect:"fb".
  const aspectMode = args.aspect ?? "tv";

  const sdl = await getSdl();

  // Window sizing + audio rate are fixed at open from the open-time host.
  const host = openHost;
  host.stepFrames(1);
  const first = host.getFramebuffer();
  const fbWidth = first.width;
  const fbHeight = first.height;

  // Decide initial window size. In "tv" / "core" modes, scale by height
  // and let the chosen aspect dictate width — keeps vertical resolution
  // honest (you can still count scanlines) while applying horizontal
  // stretch.
  let winInitW = fbWidth * scale;
  let winInitH = fbHeight * scale;
  if (aspectMode === "tv" || aspectMode === "core") {
    const aspect = aspectMode === "tv"
      ? tvAspectFor(host.status.platform, host.status.displayAspect ?? fbWidth / fbHeight)
      : (host.status.displayAspect ?? fbWidth / fbHeight);
    winInitH = fbHeight * scale;
    winInitW = Math.round(winInitH * aspect);
  }

  // Open the window.
  const window = sdl.video.createWindow({
    title,
    width: winInitW,
    height: winInitH,
    resizable: true,
    accelerated: true,
    vsync: false,
  });
  log.debug(`[playtest] window opened: ${winInitW}x${winInitH}, fb=${fbWidth}x${fbHeight}, aspect=${aspectMode}`);

  // Open audio at the core's NATIVE sample rate, not a hardcoded one.
  // snes9x emits at ~32040 Hz, fceumm at 48000, genesis-plus-gx at 44100.
  // Mismatched rates produce choppy/sped-up/cracking playback because the
  // SDL device consumes samples at the wrong rate, alternately starving
  // (clicks) and overflowing.
  let audio = null;
  const coreSampleRate = Math.round(host.status.audioSampleRate ?? 48000);
  try {
    audio = sdl.audio.openDevice({ type: "playback" }, {
      channels: 2,
      frequency: coreSampleRate,
      format: "s16",
    });
    audio.play();
    log.debug(`[playtest] audio: ${coreSampleRate} Hz, stereo, s16`);
  } catch (e) {
    log.error("[playtest] audio init failed (continuing silent):", e.message);
  }

  // Two-slot controller state with SDL hot-plug. Slot 0 = player 1,
  // slot 1 = player 2. The first controller plugged in stays player 1
  // even if it's unplugged and replugged later (we re-fill the lowest
  // empty slot on add). A second controller plugged in mid-session lands
  // in slot 1 without restarting the window — this matters for events
  // where players come and go (Token Burn hackathon, friend wandering
  // over to play a finished build, etc.).
  /** @type {[any|null, any|null]} */
  const controllers = [null, null];

  function openInFreeSlot(device) {
    // If this device is already in a slot (re-add after deviceRemove),
    // don't open twice.
    for (const slot of controllers) {
      if (slot && slot._device === device) return;
    }
    // Find lowest empty slot.
    const idx = controllers.findIndex((c) => c == null);
    if (idx < 0) {
      log.debug(`[playtest] controller plugged in but both slots full — ignoring: ${device.name}`);
      return;
    }
    try {
      const inst = sdl.controller.openDevice(device);
      inst._device = device; // tag for deviceRemove matching
      controllers[idx] = inst;
      log.debug(`[playtest] controller slot ${idx + 1}: ${device.name}`);
    } catch (e) {
      log.error(`[playtest] controller open failed (slot ${idx + 1}):`, e.message);
    }
  }

  function closeBySlotMatching(device) {
    for (let i = 0; i < controllers.length; i++) {
      const inst = controllers[i];
      if (inst && inst._device === device) {
        // SDL auto-closes the instance per its docs; just drop the ref.
        controllers[i] = null;
        log.debug(`[playtest] controller slot ${i + 1} disconnected: ${device.name}`);
        return;
      }
    }
  }

  // Pre-open already-plugged controllers (up to slot 1).
  if (sdl.controller.devices.length === 0) {
    log.debug("[playtest] no controller detected (keyboard fallback active)");
  } else {
    for (const dev of sdl.controller.devices) {
      openInFreeSlot(dev);
      if (controllers.every((c) => c)) break;
    }
  }

  // Hot-plug: SDL emits 'deviceAdd' / 'deviceRemove' on sdl.controller.
  // Subscribe so a controller plugged in (or yanked) mid-session updates
  // our slot map. Important for hackathons + social play sessions where
  // a second controller arrives long after playtest started.
  const onDeviceAdd = (event) => openInFreeSlot(event.device);
  const onDeviceRemove = (event) => closeBySlotMatching(event.device);
  sdl.controller.on("deviceAdd", onDeviceAdd);
  sdl.controller.on("deviceRemove", onDeviceRemove);

  let running = true;
  let frameCount = 0;
  let closeResolver = null;
  const closedPromise = new Promise((r) => { closeResolver = r; });

  // Track pixel-size from resize events instead of polling window.width every
  // tick — that's the retroemu pattern. window.pixelWidth/height is the real
  // backing-store size (which is what dstRect cares about); on HiDPI it
  // differs from window.width.
  let winPixelW = window.pixelWidth;
  let winPixelH = window.pixelHeight;

  // Keyboard fallback state — tracked as a "currently pressed" set so we
  // can OR it into the input mask each tick.
  /** @type {Set<string>} */
  const heldKeys = new Set();

  // Rewind ring buffer — one serialized snapshot per frame, capped at 10 s.
  const MAX_REWIND_FRAMES = 600;
  /** @type {Uint8Array[]} */
  const rewindBuffer = [];

  window.on("close", () => { stop(); });
  window.on("keyDown", (e) => {
    if (e.key === "escape") { stop(); return; }
    const key = e.key ? e.key.toLowerCase() : "";
    // RetroArch-style emulator hotkeys — act on the live host, not game input.
    if (key === "p" || key === "space") {
      const h = getLiveHost();
      if (h) { h.status.paused ? h.resume() : h.pause(); }
      return;
    }
    if (key === "f2") {
      const h = getLiveHost();
      if (h && h.status?.loaded) { try { h.saveState("hotkey"); } catch {} }
      return;
    }
    if (key === "f4") {
      const h = getLiveHost();
      if (h && h.status?.loaded) { try { h.loadState("hotkey"); } catch (err) {
        log.debug("[playtest] load state failed (no save yet?):", err.message);
      } }
      return;
    }
    if (key === "k") {
      const h = getLiveHost();
      if (h && h.status?.loaded && h.status.paused) {
        h.resume();
        h.stepFrames(1);
        h.pause();
      }
      return;
    }
    if (key) heldKeys.add(key);
  });
  window.on("keyUp", (e) => {
    if (e.key) heldKeys.delete(e.key.toLowerCase());
  });
  window.on("resize", (e) => {
    winPixelW = e.pixelWidth ?? window.pixelWidth;
    winPixelH = e.pixelHeight ?? window.pixelHeight;
  });

  function stop() {
    if (!running) return;
    running = false;
    if (interval) clearInterval(interval);
    try { sdl.controller.off("deviceAdd", onDeviceAdd); } catch {}
    try { sdl.controller.off("deviceRemove", onDeviceRemove); } catch {}
    try { audio?.close(); } catch {}
    try { if (!window.destroyed) window.destroy(); } catch {}
    log.debug(`[playtest] closed after ${frameCount} frames`);
    if (closeResolver) closeResolver();
  }

  // Tick = one emulated frame + render + audio drain. Driven by setInterval
  // so the Node event loop stays free for MCP requests on the same host.
  const frameMs = 1000 / 60;

  function tick() {
    if (!running || window.destroyed) { stop(); return; }
    // Resolve the session's CURRENT host this frame. A `runSource`/`loadMedia`
    // rebuild swapped it; we follow it so the window shows the latest build.
    // If there's transiently no host or no media loaded (mid-swap), skip this
    // frame — DON'T stop the window (that was the crash: the old host got its
    // media unloaded and stepFrames threw).
    const h = getLiveHost();
    if (!h || !h.status?.loaded) return;
    // While paused the window keeps RENDERING the frozen frame (so the human
    // still sees it), but must NOT touch input or step the core: otherwise the
    // per-tick setInput would clobber any input the AGENT set for an
    // inspect-while-paused experiment. stepFrames already returns 0 when
    // paused; skipping setInput too is what makes `pause` mean "stop fighting
    // me". The render block below runs unconditionally.
    const paused = !!h.status.paused;
    // Read controller state for each slot independently. Slot 0 = port 0
    // (player 1), slot 1 = port 1 (player 2). Each slot's input is built
    // into its own port object; the agent's setInput is overwritten each
    // tick (matching prior behavior). Select+Start on any controller quits.
    let quit = false;
    function readControllerInto(port, inst) {
      if (!inst) return;
      const btn = inst.buttons || {};
      if ((btn.back || btn.guide) && btn.start) {
        quit = true;
        return;
      }
      for (const [sdlName, bit] of Object.entries(SDL_BUTTON_TO_LIBRETRO_BIT)) {
        if (btn[sdlName]) port[bitToName(bit)] = true;
      }
      const axes = inst.axes || {};
      const lx = axes.leftStickX ?? 0;
      const ly = axes.leftStickY ?? 0;
      if (lx > STICK_DEADZONE) port.right = true;
      else if (lx < -STICK_DEADZONE) port.left = true;
      if (ly > STICK_DEADZONE) port.down = true;
      else if (ly < -STICK_DEADZONE) port.up = true;
    }

    const port0 = {};
    const port1 = {};
    readControllerInto(port0, controllers[0]);
    readControllerInto(port1, controllers[1]);
    if (quit) {
      // Select+Start always closes — even while paused — so the human can
      // dismiss a frozen window from the pad.
      log.debug("[playtest] Select+Start pressed — closing");
      stop();
      return;
    }
    // While paused: do NOTHING here — no input, no step, no rewind-capture.
    // A paused window must truly freeze so it doesn't clobber input the AGENT
    // set for an inspect-while-paused experiment (use the K hotkey to frame-
    // advance, or release pause). The render block below still runs.
    if (!paused) {
      // Merge in keyboard state on port 0. ORed with controller state so a
      // user can mix both (rare, but harmless). Keyboard never reaches
      // port 1 — that's reserved for the second physical controller.
      for (const [keyName, bit] of Object.entries(KEY_TO_LIBRETRO_BIT)) {
        if (heldKeys.has(keyName)) port0[bitToName(bit)] = true;
      }
      const isRewinding = heldKeys.has("r") && rewindBuffer.length > 0;
      if (isRewinding) {
        // Restore the previous snapshot and run one frame to produce its visual.
        const snap = rewindBuffer.pop();
        try {
          h.unserializeState(snap);
          h.stepFrames(1);
          frameCount++;
        } catch (e) {
          log.error("[playtest] rewind error:", e.message);
        }
      } else {
        // Capture snapshot before stepping so it can be rewound to later.
        if (h.status?.loaded) {
          try {
            const snap = h.serializeState();
            rewindBuffer.push(snap);
            if (rewindBuffer.length > MAX_REWIND_FRAMES) rewindBuffer.shift();
          } catch {}
        }
        h.setInput({ ports: [port0, port1] });
        let stepped = 0;
        try {
          stepped = h.stepFrames(1);
        } catch (e) {
          // A step error mid-swap (host being torn down/rebuilt) is transient —
          // skip this frame and let the next tick pick up the new host. Don't kill
          // the window. (A window-level failure is handled by the destroyed checks.)
          log.error("[playtest] step error (skipping frame):", e.message);
          return;
        }
        if (stepped > 0) frameCount++;
      }
    }

    if (!window.destroyed) {
      try {
        const fb = h.getFramebuffer();
        const rgba = framebufferToRgba(fb);

        // Letterbox: compute the largest rect with the *target* aspect
        // ratio that fits inside the (possibly-resized) window, centered.
        // In "fb" mode the target is the raw framebuffer aspect; in "tv"
        // mode it's the core-reported display aspect (so 160×210 Atari
        // stays ~4:3 even after the user resizes).
        // node-sdl's window.render with a dstRect handles bar regions for
        // us — SDL clears the renderer each present, so we don't need to
        // paint black bars ourselves. Matches retroemu's renderer pattern
        // and avoids the multi-render flashing we hit before.
        const fbW = fb.width;
        const fbH = fb.height;
        let targetAspect;
        if (aspectMode === "tv") {
          targetAspect = tvAspectFor(h.status.platform, h.status.displayAspect ?? fbW / fbH);
        } else if (aspectMode === "core") {
          targetAspect = h.status.displayAspect ?? fbW / fbH;
        } else {
          targetAspect = fbW / fbH;
        }
        // Read the window's CURRENT backing-store size fresh every frame rather
        // than relying on the cached resize-event values. node-sdl can miss /
        // mis-report a resize event (and during a live drag the cached value
        // lags the actual window), which left the dstRect sized for the old
        // window while SDL stretched the texture to fill the new one — i.e. the
        // image stopped respecting the aspect ratio on resize. window.pixelWidth
        // is always the true current backing size; fall back to the cached
        // values only if the live read isn't available.
        const curW = window.pixelWidth || winPixelW;
        const curH = window.pixelHeight || winPixelH;
        const { dstX, dstY, dstW, dstH } = letterbox(curW, curH, targetAspect);

        window.render(fbW, fbH, fbW * 4, "rgba32", rgba, {
          scaling: "nearest",
          dstRect: { x: dstX, y: dstY, width: dstW, height: dstH },
        });
      } catch (e) {
        // A render throw usually means the window went away under us (the
        // SDL handle was freed without a 'close' event — compositor kill,
        // session loss). If the window is no longer alive, stop the loop so
        // we don't spin forever rendering into a corpse (the stale-status
        // bug). Only a transient error on a still-live window is logged.
        if (window.destroyed || e.message?.includes("destroyed")) { stop(); return; }
        log.error("[playtest] render error:", e.message);
      }
    } else {
      // Window vanished between the top-of-tick check and here.
      stop();
      return;
    }

    if (running && audio && h.state.audioRing.length > 0) {
      // SDL device tells us how many bytes are still queued (not yet played).
      // If we get >200ms ahead, the player got a stutter and is now
      // building latency — drop new samples until the queue drains back
      // to ~50ms. This keeps audio synced to wall clock without underruns.
      // Wrap the whole block in try/catch — stop() may have closed the
      // audio device between the running check and the access below.
      try {
        const bytesPerSecond = coreSampleRate * 2 /* ch */ * 2 /* s16 */;
        const queuedBytes = audio.queued ?? 0;
        const queuedMs = (queuedBytes / bytesPerSecond) * 1000;
        if (queuedMs < 200) {
          let total = 0;
          for (const buf of h.state.audioRing) total += buf.byteLength;
          const merged = Buffer.alloc(total);
          let off = 0;
          for (const buf of h.state.audioRing) {
            merged.set(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength), off);
            off += buf.byteLength;
          }
          audio.enqueue(merged);
        }
      } catch (e) {
        if (!e.message?.includes("closed")) {
          log.error("[playtest] audio enqueue error:", e.message);
        }
      }
      // Always clear the ring — if we skipped enqueue we drop those samples.
      h.state.audioRing.length = 0;
    }
  }

  const interval = setInterval(tick, frameMs);

  // Return a handle the MCP layer can use to stop the session and to wait
  // for natural close. The host stays usable by every other MCP tool while
  // the window is open — screenshots, readMemory, saveState, etc. all act
  // on the same emulator state the user is watching.
  return {
    stop,
    closed: closedPromise,
    get frameCount() { return frameCount; },
    get running() { return running; },
    // Truth-probe for the underlying SDL window. `running` is our own flag
    // and can lag reality if the window dies without firing a 'close' event
    // (compositor kill, X/Wayland session loss, invalid handle). Callers
    // that need an honest answer (playtestStatus) check this and reconcile.
    // Any throw from the SDL binding (handle freed under us) → treat as dead.
    windowAlive() {
      if (!running) return false;
      try {
        return !window.destroyed;
      } catch {
        return false;
      }
    },
    // How many gamepads are currently mapped to player slots. Live (reflects
    // hot-plug), so a caller can decide whether to surface the keyboard help.
    // 0 → the user has no pad and is on the keyboard fallback.
    get controllerCount() { return controllers.filter(Boolean).length; },
    // The emulator host the window is CURRENTLY rendering. The window follows
    // the session's live host (a `runSource`/`loadMedia` rebuild updates it in
    // place), so this is whatever the human is looking at right now. Exposed so
    // the agent can capture exactly that. See playtestFramebuffer.
    get host() { return getLiveHost(); },
    // Capture the framebuffer the human is currently looking at: PNG (base64) +
    // dims + the host's media/frame metadata, straight off the live window host.
    // Returns null if there's transiently no loaded host (mid-rebuild).
    captureFrame() {
      const h = getLiveHost();
      if (!h || !h.status?.loaded) return null;
      const shot = h.screenshot();
      return {
        pngBase64: shot.pngBase64,
        width: shot.width,
        height: shot.height,
        loadedMediaPath: h.status?.mediaPath ?? null,
        platform: h.status?.platform ?? null,
        frameCount: h.status?.frameCount ?? frameCount,
      };
    },
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function bitToName(bit) {
  return ({
    0: "b", 1: "y", 2: "select", 3: "start",
    4: "up", 5: "down", 6: "left", 7: "right",
    8: "a", 9: "x", 10: "l", 11: "r",
    12: "l2", 13: "r2", 14: "l3", 15: "r3",
  })[bit];
}

/** Convert libretro framebuffer (any pixel format) to RGBA32. */
function framebufferToRgba(f) {
  const out = Buffer.alloc(f.width * f.height * 4);
  if (f.format === RETRO_PIXEL_FORMAT_XRGB8888) {
    for (let y = 0; y < f.height; y++) {
      const src = y * f.pitch;
      const dst = y * f.width * 4;
      for (let x = 0; x < f.width; x++) {
        const s = src + x * 4;
        const d = dst + x * 4;
        out[d + 0] = f.pixels[s + 2];
        out[d + 1] = f.pixels[s + 1];
        out[d + 2] = f.pixels[s + 0];
        out[d + 3] = 0xff;
      }
    }
  } else if (f.format === RETRO_PIXEL_FORMAT_RGB565) {
    for (let y = 0; y < f.height; y++) {
      const src = y * f.pitch;
      const dst = y * f.width * 4;
      for (let x = 0; x < f.width; x++) {
        const s = src + x * 2;
        const p = f.pixels[s] | (f.pixels[s + 1] << 8);
        const r = (p >> 11) & 0x1f;
        const g = (p >> 5) & 0x3f;
        const b = p & 0x1f;
        const d = dst + x * 4;
        out[d + 0] = (r << 3) | (r >> 2);
        out[d + 1] = (g << 2) | (g >> 4);
        out[d + 2] = (b << 3) | (b >> 2);
        out[d + 3] = 0xff;
      }
    }
  } else if (f.format === RETRO_PIXEL_FORMAT_0RGB1555) {
    for (let y = 0; y < f.height; y++) {
      const src = y * f.pitch;
      const dst = y * f.width * 4;
      for (let x = 0; x < f.width; x++) {
        const s = src + x * 2;
        const p = f.pixels[s] | (f.pixels[s + 1] << 8);
        const r = (p >> 10) & 0x1f;
        const g = (p >> 5) & 0x1f;
        const b = p & 0x1f;
        const d = dst + x * 4;
        out[d + 0] = (r << 3) | (r >> 2);
        out[d + 1] = (g << 3) | (g >> 2);
        out[d + 2] = (b << 3) | (b >> 2);
        out[d + 3] = 0xff;
      }
    }
  } else {
    throw new Error(`Unsupported pixel format ${f.format}`);
  }
  return out;
}
