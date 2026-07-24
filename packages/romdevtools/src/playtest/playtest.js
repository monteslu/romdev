// Playtest — open an SDL window, render the loaded ROM at native framerate,
// drive it with whatever gamepad is plugged in. Uses the same SDL API
// pattern as the working retroemu player.

// The SDL loader hardening + the presentation/input primitives live in
// romdev-core-runner now (the shared human-tier SDL host) — playtest is the
// AGENT tier on top: live-host follow, checkpoints, rewind, co-drive
// detection, audio-paced stepping, resampler. One SDL host in the ecosystem.
import {
  initSdl,
  sdlPackageRoot as runnerSdlPackageRoot,
  SDL_BUTTON_TO_LIBRETRO_BIT,
  KEY_TO_LIBRETRO_BIT,
  STICK_DEADZONE,
  bitToName,
  tvAspectFor,
  effectiveAspect,
  initialWindowSize,
  letterbox as runnerLetterbox,
  framebufferToRgba,
} from "romdev-core-runner";
import { log } from "../mcp/log.js";
import { initResampler, resampleS16Stereo } from "romdev-audio-resampler";
import path from "node:path";
import { existsSync, writeFileSync, renameSync, mkdirSync } from "node:fs";


/**
 * Choose a default window title from the loaded host. Prefers the loaded
 * ROM/project basename (e.g. "asteroids.sfc" → "asteroids"); for in-memory
 * builds (runSource) the path is a synthetic "<memory.sfc>" with no project
 * name, so fall back to the platform, then the generic label.
 * @param {import("romdev-core-host/index.js").LibretroHost} host
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

// Re-exported from romdev-core-runner (single implementation); kept on this
// module for the existing tests + any external import of the old name.
export const sdlPackageRoot = runnerSdlPackageRoot;

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
/** Load @kmamal/sdl via romdev-core-runner's hardened initSdl() (self-repair
 *  for the missing native binary, failed-import-cache workaround, offscreen-
 *  driver detection). This wrapper only enriches the no-display message with
 *  the romdev-specific guidance the playtest tool passes through verbatim. */
async function getSdl() {
  try {
    return await initSdl({ log: (m) => log(`playtest: ${m}`) });
  } catch (e) {
    if (e?.sdlKind === "no-display") {
      const m = /"(offscreen|dummy)"/.exec(e.message ?? "");
      const driver = m ? m[1] : "offscreen";
      e.message =
        `SDL selected the "${driver}" video driver — there is no presentable display, ` +
        "so a playtest window would render but never appear on a physical screen " +
        "(you'd hear audio but see nothing). The server must run where it has a real " +
        "display: start it from a terminal INSIDE your logged-in desktop session " +
        "(`npx romdevtools`), then point your agent at that server. (A server spawned " +
        "by your agent host, over plain SSH, or from a tty/headless box has no display. " +
        "A virtual display like Xvfb works too — it reports as the real driver, not " +
        "\"offscreen\".)";
    }
    throw e;
  }
}

// (The generic SDL-button → RetroPad map + keyboard map + STICK_DEADZONE come
// from romdev-core-runner — the single shared copy.)

// N64-specific pad map. parallel_n64's RetroPad layout (its digital_cbuttons_map)
// is NOT the generic NES/SNES one — RETRO B="N64 A", RETRO Y="N64 B", RETRO X/A/L/R
// are the four C-buttons, RETRO Select="N64 L", RETRO R2="N64 R", RETRO L2="N64 Z".
// The N64's Z/L/R are DIGITAL buttons (its analog triggers don't exist), so on a
// modern pad they go on the SHOULDER buttons, NOT the analog triggers (which idle
// half-pressed and would stick). Layout for a standard X360-style pad:
//   Xbox A (bottom) = N64 A   (accelerate)
//   Xbox B (right)  = N64 B   (brake)
//   Xbox X (left)   = N64 Z   (FIRE ITEM)  ← a free face button, easy to reach
//   Xbox Y (top)    = N64 B   (alias, so either right/top brakes)
//   L shoulder      = N64 L
//   R shoulder      = N64 R   (hop / drift)
//   right stick     = the four C-buttons (in readControllerInto)
//   left stick/dpad = N64 analog stick (via the dpad→ANALOG synth in callbacks.js)
const SDL_BUTTON_TO_LIBRETRO_BIT_N64 = {
  dpadUp: 4, dpadDown: 5, dpadLeft: 6, dpadRight: 7,  // N64 d-pad (literal)
  a: 0,               // Xbox A (bottom) → RETRO B  = N64 A   (accelerate)
  b: 1,               // Xbox B (right)  → RETRO Y  = N64 B   (brake)
  y: 1,               // Xbox Y (top)    → RETRO Y  = N64 B   (alias)
  x: 12,              // Xbox X (left)   → RETRO L2 = N64 Z   (FIRE ITEM)
  start: 3,           // Start
  leftShoulder: 2,    // L shoulder → RETRO Select = N64 L
  rightShoulder: 13,  // R shoulder → RETRO R2     = N64 R   (hop/drift)
  // C-buttons (RETRO X/A/L/R) come from the RIGHT STICK in readControllerInto.
};

// C64-only keyboard fallback: PC key → the virtual C64 button name the host's
// C64 layer maps to the key matrix (Space/Run-Stop/Return/F1-F7). Lets a human
// with NO controller still reach the C64 keyboard keys games need to start.
// (Arrows + Z give the joystick + Fire via KEY_TO_LIBRETRO_BIT above.)
const C64_KEYBOARD_FALLBACK = {
  f1: "c64_f1", f2: "c64_f3", f3: "c64_f5", f4: "c64_f7",  // F1-F4 → C64 F1/F3/F5/F7
  space: "west",          // Space
  return: "r2",           // Return (also START via the standard map — harmless)
  escape: "l2",           // Run/Stop (note: ESC also closes — see handler order)
};

// Human-readable C64 controls (controller + keyboard), relayed to the user when
// a C64 game is in the playtest window so they're not guessing.
export const C64_BINDINGS_HELP = `C64 — a CONTROLLER alone is enough (no keyboard needed):
  D-pad / Left stick   Joystick (port 2 by default)
  Z / bottom face      Fire
  X face / Space key   Space
  L2                   Run/Stop
  R2 / Enter           Return
  Right stick  ↑/←/→/↓  F1 / F3 / F5 / F7   (the 1-player / start keys)
  Top face             F1 (also)

No controller? Keyboard fallback: Arrows = joystick, Z = Fire, F1-F4 = C64
F1/F3/F5/F7, Space = Space, Enter = Return, ESC = Run/Stop (hold; ESC tapped
also closes the window). Switch joystick port with input({op:'joyport'}).`;

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
  R                    Rewind one frame (while paused)
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
// letterbox lives in romdev-core-runner (single implementation); re-exported
// for the existing tests + external importers of the old name.
export const letterbox = runnerLetterbox;

// How recently (in window ticks ≈ frames at 60fps real time) the human must
// have pressed something for the session to count as "human input active".
// 120 ticks ≈ 2 s — long enough to span the natural gaps WITHIN active play
// (between taps), short enough that an agent isn't warned off long after the
// human set the pad down.
export const HUMAN_INPUT_ACTIVE_FRAMES = 120;

/**
 * Any button held in a built input-port object? The C64 virtual keys
 * (c64_f1 …) count too — any truthy value is a press.
 * @param {Record<string, boolean>} port
 */
export function anyButtonHeld(port) {
  for (const k in port) if (port[k]) return true;
  return false;
}

/**
 * Pure "when did the human last actually press something" tracker behind the
 * co-drive detection. The tick loop calls note() every unpaused frame; the
 * session handle (and through it catalog/frame/input warnings) asks active()/
 * framesSince(). Pure + exported so the activity contract is unit-testable
 * without an SDL window.
 * @param {number} [activeWindow] ticks within which a press counts as active
 */
export function createHumanInputTracker(activeWindow = HUMAN_INPUT_ACTIVE_FRAMES) {
  let lastTick = null;
  return {
    /** @param {boolean} pressing @param {number} tick */
    note(pressing, tick) { if (pressing) lastTick = tick; },
    /** @param {number} tick @returns {number | null} null = never pressed */
    framesSince(tick) { return lastTick == null ? null : Math.max(0, tick - lastTick); },
    /** @param {number} tick */
    active(tick) { return lastTick != null && tick - lastTick <= activeWindow; },
  };
}

/**
 * @param {Object} args
 * @param {import("romdev-core-host/index.js").LibretroHost} args.host
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

  // ── Eviction survivability: a rolling auto-checkpoint to DISK while the window
  // is open. Emulator state lives in server memory only, so a session eviction
  // (restart / reconnect / unload) while a HUMAN is mid-playthrough loses their
  // manual progress — the recovery hint can only restore a fresh boot. Writing a
  // rolling .state to disk every N seconds means their progress is never more than
  // N seconds from recoverable (state({op:'load', path})). F2 also writes here on
  // demand (so "I saved it" produces a real, reportable file). (v0.41.0 feedback
  // note 125904 #2/#3.)
  const checkpointPath = args.autoCheckpointPath ?? null;
  const checkpointEverySec = args.checkpointIntervalSec ?? 15;
  let lastCheckpointTick = 0;
  let lastCheckpointError = null;
  /** Serialize the live host and write it to the checkpoint path atomically
   *  (temp + rename). Synchronous + best-effort: never throws into the tick. */
  function writeCheckpoint(h, reason) {
    if (!checkpointPath || !h || !h.status?.loaded || typeof h.serializeState !== "function") return false;
    try {
      const blob = h.serializeState();
      if (!blob || !blob.length) return false;
      const dir = path.dirname(checkpointPath);
      if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
      const tmp = checkpointPath + ".tmp";
      writeFileSync(tmp, Buffer.from(blob));
      renameSync(tmp, checkpointPath);
      lastCheckpointError = null;
      log.debug(`[playtest] checkpoint (${reason}) → ${checkpointPath} (${blob.length} B)`);
      return true;
    } catch (e) {
      lastCheckpointError = e.message;
      log.debug(`[playtest] checkpoint failed: ${e.message}`);
      return false;
    }
  }
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
  // stretch. Shared + unit-tested in core-runner (the inline copy of this
  // math is what opened a 0-width window when a host reported aspect 0).
  const { width: winInitW, height: winInitH } = initialWindowSize({
    fbWidth, fbHeight, scale, aspectMode,
    platform: host.status.platform, displayAspect: host.status.displayAspect,
  });

  // Open the window.
  //
  // HW-render cores (n64/ps1/dreamcast) already own a GL context via native-gles
  // (the EGL pbuffer the core renders its RDP/GPU into; we glReadPixels it to CPU
  // pixels). If the SDL window ALSO requests an accelerated (GL) renderer, node-sdl
  // calls glXMakeCurrent on the same X display and the two GL contexts collide →
  // `X Error BadAccess (GLX X_GLXMakeCurrent)`, crashing the process. The window only
  // ever presents CPU pixels (window.render(..., "rgba32", rgba)), so it does NOT need
  // its own GL context — open a SOFTWARE-blit window for HW-render cores to avoid the
  // context fight. Software cores keep the accelerated path (faster upscale blit).
  const hwRenderCore = !!host.hwRender;
  const window = sdl.video.createWindow({
    title,
    width: winInitW,
    height: winInitH,
    resizable: true,
    accelerated: hwRenderCore ? false : true,
    vsync: false,
  });
  log.debug(`[playtest] window opened: ${winInitW}x${winInitH}, fb=${fbWidth}x${fbHeight}, aspect=${aspectMode}`);

  // Open audio at the core's NATIVE sample rate, not a hardcoded one.
  // snes9x emits at ~32040 Hz, fceumm at 48000, genesis-plus-gx at 44100.
  // Mismatched rates produce choppy/sped-up/cracking playback because the
  // SDL device consumes samples at the wrong rate, alternately starving
  // (clicks) and overflowing.
  //
  // EXCEPTION — very-low-rate cores (the GameTank ACP emits ~13983 Hz, 3x lower
  // than anything else): SDL's device buffer granularity (thousands of samples)
  // dwarfs a 60 fps core's ~233-sample-per-frame chunks at that rate, so the
  // device starves between ticks = clicks and pops. (RetroArch avoids this with
  // a sinc resampler + dynamic rate control to the device rate.) So for low
  // rates we open the device at 48 kHz and LINEAR-RESAMPLE each chunk up to it,
  // which makes the per-frame chunks big enough for clean playback.
  let audio = null;
  const coreSampleRate = Math.round(host.status.audioSampleRate ?? 48000);
  const AUDIO_RESAMPLE_TO = 48000;
  let needsResample = coreSampleRate > 0 && coreSampleRate < 24000;
  // Load the WASM+SIMD resampler if this core needs upsampling. If it fails to
  // load, fall back to opening the device at the native rate (better than no
  // audio) — needsResample is forced off so we never call a missing resampler.
  if (needsResample) {
    const ready = await initResampler();
    if (!ready) {
      log.error("[playtest] resampler WASM failed to load — using native rate (audio may click)");
      needsResample = false;
    }
  }
  const deviceSampleRate = needsResample ? AUDIO_RESAMPLE_TO : coreSampleRate;
  try {
    audio = sdl.audio.openDevice({ type: "playback" }, {
      channels: 2,
      frequency: deviceSampleRate,
      format: "s16",
    });
    audio.play();
    log.debug(`[playtest] audio: ${deviceSampleRate} Hz, stereo, s16` +
      (needsResample ? ` (resampled from core ${coreSampleRate} Hz)` : ""));
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

  // Human co-drive detection. tickCount advances every tick (even paused /
  // mid-rebuild) so "frames since the human pressed" tracks wall time at
  // ~60fps. humanInputDirty = the host's input state currently holds buttons
  // WE wrote for the human — it buys exactly one release write after they let
  // go, after which an idle window leaves the agent's setInput alone.
  let tickCount = 0;
  const humanInput = createHumanInputTracker();
  let humanInputDirty = false;

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

  // Reused RGBA conversion buffer (a fresh 3.7MB Buffer.alloc per tick on a
  // 1280x720 wasmcart cart is ~220MB/s of zeroing + GC churn — visible jank).
  /** @type {Buffer|null} */
  let rgbaScratch = null;

  // Perf telemetry, surfaced via playtest({op:'status'}).perf so "the window
  // feels slow" turns into numbers: emulated fps (frames stepped/sec, catch-up
  // bursts included), render ticks/sec, and an EMA of what each tick stage
  // costs. Cheap: two performance.now() reads per stage per tick.
  const perf = {
    fps: 0,             // emulated frames per wall second (60 = full speed)
    tickHz: 0,          // render/present passes per wall second
    stepMs: 0,          // EMA: emulation step burst per tick
    convertMs: 0,       // EMA: framebuffer→RGBA conversion per tick
    presentMs: 0,       // EMA: SDL render per tick
    audioQueuedMs: null, // last SDL audio queue depth (null = no audio device)
  };
  let perfFrames = 0, perfTicks = 0, perfWinStart = 0;
  const ema = (prev, v) => (prev === 0 ? v : prev + (v - prev) * 0.05);

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
      if (h && h.status?.loaded) {
        try { h.saveState("hotkey"); } catch { /* in-memory slot best-effort */ }
        // ALSO persist to disk so the save survives host death and the human gets
        // a real file (the in-memory 'hotkey' slot dies with an evicted host).
        if (checkpointPath && writeCheckpoint(h, "F2")) {
          log.info(`[playtest] F2 → saved to ${checkpointPath} (survives a session eviction; state({op:'load', path}) to restore).`);
        } else {
          log.info("[playtest] F2 → in-memory 'hotkey' slot saved (state({op:'export', fromSlot:'hotkey', path}) to persist it; it does NOT survive a host eviction).");
        }
      }
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
    if (key === "r") {
      // The ring buffer's top snapshot is the state *before* the currently
      // displayed frame; discard it, then restore the one before that and
      // re-run a frame to render it. (stepFrames is a no-op while paused, so
      // we resume/step/pause exactly like frame advance.)
      const h = getLiveHost();
      if (h && h.status?.loaded && h.status.paused && rewindBuffer.length > 1) {
        rewindBuffer.pop();
        const snap = rewindBuffer[rewindBuffer.length - 1];
        try {
          h.unserializeState(snap);
          h.resume();
          h.stepFrames(1);
          h.pause();
          frameCount++;
          humanInput.note(true, tickCount);
        } catch (e) {
          log.error("[playtest] rewind error:", e.message);
        }
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
  // Pace to the CORE's native refresh rate (status.coreFps), not a hardcoded 60: a
  // 30fps title (Sonic Adventure on flycast) at a 60Hz tick gets double-ticked —
  // wasting half the budget and, on the heavy interpreter-only DC core (23ms/frame,
  // no JIT), falling behind every tick → the black-flash/glitch. At its real 30fps
  // each frame gets a full 33ms tick, which the core can actually hit. Clamped so a
  // bogus report can't run the window absurdly fast or slow.
  const coreFps = openHost?.status?.coreFps;
  const fps = (coreFps >= 20 && coreFps <= 120) ? coreFps : 60;
  const frameMs = 1000 / fps;

  function tick() {
    if (!running || window.destroyed) { stop(); return; }
    tickCount++;
    // Roll the 1s perf window.
    {
      const now = performance.now();
      if (!perfWinStart) perfWinStart = now;
      else if (now - perfWinStart >= 1000) {
        perf.fps = Math.round((perfFrames * 1000) / (now - perfWinStart));
        perf.tickHz = Math.round((perfTicks * 1000) / (now - perfWinStart));
        perfFrames = 0; perfTicks = 0; perfWinStart = now;
      }
      perfTicks++;
    }
    // Resolve the session's CURRENT host this frame. A `runSource`/`loadMedia`
    // rebuild swapped it; we follow it so the window shows the latest build.
    // If there's transiently no host or no media loaded (mid-swap), skip this
    // frame — DON'T stop the window (that was the crash: the old host got its
    // media unloaded and stepFrames threw).
    const h = getLiveHost();
    if (!h || !h.status?.loaded) return;
    // Rolling auto-checkpoint to disk (eviction survivability). Cheap relative to
    // the N-second cadence; serialize off the live host so it captures the human's
    // exact progress. Skipped while paused (nothing changed) and on the very first
    // ticks (let the core settle).
    // Auto-checkpoint serializes the WHOLE machine state — cheap for 8/16-bit (KB,
    // instant) but BRUTAL for the hwRender 3D cores (DC/N64 savestate ≈16MB, ~18ms
    // to serialize), which would freeze the window for ~18ms every cadence on an
    // already-slow core. Skip it entirely for hwRender — same call as the rewind
    // buffer skip. (Eviction recovery matters less than a playable window here.)
    if (!h.hwRender && checkpointPath && tickCount - lastCheckpointTick >= checkpointEverySec * 60 && !h.status.paused) {
      lastCheckpointTick = tickCount;
      writeCheckpoint(h, "auto");
    }
    // While paused the window keeps RENDERING the frozen frame (so the human
    // still sees it), but must NOT touch input or step the core: otherwise the
    // per-tick setInput would clobber any input the AGENT set for an
    // inspect-while-paused experiment. stepFrames already returns 0 when
    // paused; skipping setInput too is what makes `pause` mean "stop fighting
    // me". The render block below runs unconditionally.
    // `paused` (the agent's pause) OR `_renderTickSuspended` (a breakpoint/watch
    // tool is driving the core exclusively this instant) → render only, don't
    // step. The latter prevents this 60fps tick from racing a runUntilPC loop and
    // stepping the CPU past the breakpoint between its iterations.
    const paused = !!h.status.paused || !!h._renderTickSuspended;
    // Read controller state for each slot independently. Slot 0 = port 0
    // (player 1), slot 1 = port 1 (player 2). Each slot's input is built
    // into its own port object. The agent's setInput is only overwritten
    // while the human is ACTUALLY pressing (see the write below) — an idle
    // window leaves it alone. Select+Start on any controller quits.
    let quit = false;
    const isC64 = h.status?.platform === "c64";
    const isN64 = h.status?.platform === "n64";
    function readControllerInto(port, inst) {
      if (!inst) return;
      const btn = inst.buttons || {};
      if ((btn.back || btn.guide) && btn.start) {
        quit = true;
        return;
      }
      const buttonMap = isN64 ? SDL_BUTTON_TO_LIBRETRO_BIT_N64 : SDL_BUTTON_TO_LIBRETRO_BIT;
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
      // NOTE: the analog triggers are NOT used for N64 — its Z/L/R are digital and
      // map to the SHOULDER buttons (see SDL_BUTTON_TO_LIBRETRO_BIT_N64). (node-sdl's
      // X360 trigger axes also idle at ~0.5, so reading them as buttons would stick.)
      // C64: the RIGHT stick selects the function keys (F1/F3/F5/F7) — the
      // Batocera/RetroDeck convention so a controller alone reaches the keyboard
      // keys C64 setup screens need. Emitted as virtual buttons the host's C64
      // layer maps to the key matrix; harmless on other platforms (no mapping).
      if (isC64) {
        const rx = axes.rightStickX ?? 0;
        const ry = axes.rightStickY ?? 0;
        if (ry < -STICK_DEADZONE) port.c64_f1 = true;        // up    → F1
        else if (ry > STICK_DEADZONE) port.c64_f7 = true;    // down  → F7
        if (rx < -STICK_DEADZONE) port.c64_f3 = true;        // left  → F3
        else if (rx > STICK_DEADZONE) port.c64_f5 = true;    // right → F5
      }
      // N64: the RIGHT stick drives the four C-buttons — the standard emulation
      // convention so a modern dual-stick pad plays N64 naturally (left stick =
      // analog stick via the d-pad synthesis in callbacks.js; right stick = C). The
      // C-buttons land on libretro bits A/X/L/R, which parallel_n64 reads as
      // C-Down/C-Up/C-Left/C-Right. Z is the left trigger (mapped above).
      if (isN64) {
        const rx = axes.rightStickX ?? 0;
        const ry = axes.rightStickY ?? 0;
        if (ry < -STICK_DEADZONE) port.x = true;        // up    → C-Up    (RETRO X)
        else if (ry > STICK_DEADZONE) port.a = true;    // down  → C-Down  (RETRO A)
        if (rx < -STICK_DEADZONE) port.l = true;        // left  → C-Left  (RETRO L)
        else if (rx > STICK_DEADZONE) port.r = true;    // right → C-Right (RETRO R)
      }
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
      // C64 keyboard fallback (no controller / mixing): map PC keys to the C64
      // KEYBOARD keys games need — the host's C64 layer routes these virtual
      // button names to the key matrix. (Arrows + Z=Fire already give the
      // joystick above.) The agent relays these to the human.
      if (isC64) {
        for (const [keyName, vbtn] of Object.entries(C64_KEYBOARD_FALLBACK)) {
          if (heldKeys.has(keyName)) port0[vbtn] = true;
        }
      }
      // Did the human actually press anything this tick (pad or keyboard,
      // either port)?
      const humanPressing = anyButtonHeld(port0) || anyButtonHeld(port1);
      humanInput.note(humanPressing, tickCount);
      // Capture snapshot before stepping so R can rewind to it later. SKIP for
      // hwRender cores (n64/ps1/dreamcast): their savestates are HUGE (N64 ≈16MB
      // each — 600 frames would be ~9GB of RAM) and serializeState costs ~8ms/frame
      // there, eating half the 16.6ms budget and starving the audio feed (the choppy
      // playback). The R-key rewind is a nicety, not worth that on the 3D engines —
      // pause + savestate still work for those. (Rewind buffer is playtest-only; it's
      // NOT part of the debug ABI, so dropping it on these cores changes nothing else.)
      // Hosts without savestates (wasmcart/jsgame) get no rewind buffer —
      // checking the method beats throwing into an empty catch every tick.
      if (h.status?.loaded && !h.hwRender && typeof h.serializeState === "function") {
        try {
          const snap = h.serializeState();
          rewindBuffer.push(snap);
          if (rewindBuffer.length > MAX_REWIND_FRAMES) rewindBuffer.shift();
        } catch {}
      }
      // Write input ONLY while the human is actually pressing, plus ONE
      // release write after they let go (humanInputDirty). The old behavior
      // wrote all-zeros EVERY tick, which silently clobbered the agent's
      // input({op:'set'}) even when nobody was touching the pad. An idle
      // window now leaves the host's input state alone; the human still
      // wins the instant they press.
      if (humanPressing || humanInputDirty) {
        h.setInput({ ports: [port0, port1] });
        humanInputDirty = humanPressing;
      }
      // AUDIO-PACED stepping, BUDGETED BY WALL-CLOCK. We catch the buffer up by
      // stepping extra frames per tick to keep SDL's queue topped — but a fast core
      // (n64 2.4ms/frame) and a SUB-REALTIME core (flycast DC ~60ms/frame) need very
      // different burst sizes. A fixed MAX_STEPS frame-count cap is the trap: 8 frames
      // is 19ms on n64 (fine) but 480ms on DC — which BLOCKS the Node event loop for
      // half a second per tick, so the window can't repaint and audio drains dry →
      // "breaks down, super choppy" death spiral that never recovers. The fix is to
      // cap by TIME: keep stepping only while we're under a wall-clock budget (~1.5
      // ticks). A sub-realtime core then runs steady-slow (audio underruns gracefully,
      // a constant low pitch) instead of stuttering — and the loop ALWAYS yields the
      // event loop promptly so the window stays responsive.
      let stepped = 0;
      const tStep = performance.now();
      try {
        if (audio && deviceSampleRate > 0) {
          const bps = deviceSampleRate * 4; // stereo s16
          const TARGET_MS = 60;             // keep ~60ms queued — drain sets the speed
          const BUDGET_MS = frameMs * 1.5;  // wall-clock ceiling for the whole burst
          const burstStart = performance.now();
          do {
            stepped += h.stepFrames(1);
            // Stop the instant we've spent our wall-clock budget — this is what keeps
            // a slow core from freezing the loop. A single frame already over budget
            // still steps once (progress), then we yield.
            if (performance.now() - burstStart >= BUDGET_MS) break;
            const qMs = ((audio.queued ?? 0) / bps) * 1000;
            let ringMs = 0;
            for (const b of h.state.audioRing) ringMs += (b.length / 2);
            ringMs = (ringMs / deviceSampleRate) * 1000;
            if (qMs + ringMs >= TARGET_MS) break;
          } while (true);
        } else {
          stepped = h.stepFrames(1); // no audio device → plain 1 frame/tick
        }
      } catch (e) {
        // A step error mid-swap (host being torn down/rebuilt) is transient —
        // skip this frame and let the next tick pick up the new host. Don't kill
        // the window. (A window-level failure is handled by the destroyed checks.)
        log.error("[playtest] step error (skipping frame):", e.message);
        return;
      }
      perf.stepMs = ema(perf.stepMs, performance.now() - tStep);
      perfFrames += stepped;
      if (stepped > 0) frameCount++;
    }

    if (!window.destroyed) {
      try {
        const tConvert = performance.now();
        const fb = h.getFramebuffer();
        rgbaScratch = framebufferToRgba(fb, rgbaScratch);
        const rgba = rgbaScratch;
        perf.convertMs = ema(perf.convertMs, performance.now() - tConvert);

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
          targetAspect = tvAspectFor(h.status.platform, effectiveAspect(h.status.displayAspect, fbW, fbH));
        } else if (aspectMode === "core") {
          targetAspect = effectiveAspect(h.status.displayAspect, fbW, fbH);
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

        const tPresent = performance.now();
        window.render(fbW, fbH, fbW * 4, "rgba32", rgba, {
          scaling: "nearest",
          dstRect: { x: dstX, y: dstY, width: dstW, height: dstH },
        });
        perf.presentMs = ema(perf.presentMs, performance.now() - tPresent);
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
      // Enqueue the real audio the core produced this tick. The AUDIO-PACED stepping
      // above already steps however many frames are needed to keep ~60ms queued, so
      // the buffer stays full from REAL samples — no silence padding, no rate-deficit
      // starvation. SDL's steady drain at the device rate is what sets emulation speed.
      // We only stop enqueuing if latency runs away (>250ms) — a safety valve, not
      // the normal path.
      try {
        const bytesPerSecond = deviceSampleRate * 2 /* ch */ * 2 /* s16 */;
        const queuedMs = ((audio.queued ?? 0) / bytesPerSecond) * 1000;
        perf.audioQueuedMs = Math.round(queuedMs);
        if (queuedMs < 250) {
          let total = 0;
          for (const buf of h.state.audioRing) total += buf.byteLength;
          const merged = Buffer.alloc(total);
          let off = 0;
          for (const buf of h.state.audioRing) {
            merged.set(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength), off);
            off += buf.byteLength;
          }
          audio.enqueue(needsResample
            ? resampleS16Stereo(merged, coreSampleRate, deviceSampleRate)
            : merged);
        }
      } catch (e) {
        if (!e.message?.includes("closed")) {
          log.error("[playtest] audio enqueue error:", e.message);
        }
      }
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
    // Live perf readout (rolling 1s fps/tickHz + per-stage EMAs) — the answer
    // to "the window feels slow, WHERE is the time going".
    get perf() { return { ...perf }; },
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
    // Human co-drive detection: has the human pressed anything (pad, keyboard,
    // or rewind-scrub) within the last ~2 s of window ticks? Drives the
    // catalog({op:'status'}) flags and the frame/input co-drive warnings so an
    // agent KNOWS when a human is driving the same emulator.
    humanInputActive() { return humanInput.active(tickCount); },
    // Ticks (≈ frames at 60fps real time) since the last human press; null if
    // the human hasn't touched anything since the window opened.
    framesSinceHumanInput() { return humanInput.framesSince(tickCount); },
    // Eviction-survivability state: where the rolling auto-checkpoint is written
    // and whether the last write succeeded. Surfaced in playtest({op:'status'})
    // so an agent can see the human's progress is being saved (and warn if not).
    lastCheckpoint() {
      return {
        path: checkpointPath,
        lastWrittenTick: lastCheckpointTick || null,
        lastError: lastCheckpointError,
      };
    },
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
