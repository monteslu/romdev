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
  makeTriggerState,
  deriveTriggerState,
  normAxis,
  bitToName,
  tvAspectFor,
  effectiveAspect,
  initialWindowSize,
  drawFpsOverlay,
  letterbox as runnerLetterbox,
  framebufferToRgba,
} from "romdev-core-runner";
import { log } from "../mcp/log.js";
import { getActiveBezel, compositeFrame, tickActiveBezel, releaseBezelGl, notifyActiveBezel, setActiveBezelBypassed } from "../mcp/active-bezel.js";
import { framebufferToScreenshot } from "romdev-core-host/framebuffer-png.js";
import { ROMDEV_PIXEL_FORMAT_RGBA8888 } from "romdev-core-host/retroConstants.js";
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
  H                    Reset (soft — the console RESET button; RetroArch's default binding)
  B                    Suspend/resume the Active Bezel (keeps its state; raw core picture while off)
  F2                   Save state (to slot)
  F3                   Toggle on-screen fps counter (fps is always in the title bar)
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
  for (const k in port) {
    if (k === "axes") continue; // the axes OBJECT is always truthy; judge its values below
    if (port[k]) return true;
  }
  // Analog motion counts as pressing (it must flow to the host while the
  // human steers), but only past a threshold comfortably above stick drift —
  // an idle wobbling pad must NOT clobber the agent's input({op:'set'}).
  const a = port.axes;
  if (a && (Math.abs(a.lx) > 0.25 || Math.abs(a.ly) > 0.25
    || Math.abs(a.rx) > 0.25 || Math.abs(a.ry) > 0.25
    || a.lt > 0.35 || a.rt > 0.35)) return true;
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
 * @param {string} [args.sessionKey] session whose Active Bezel (if any) to composite
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
  // Needed to find this session's Active Bezel: the window must present the
  // same composite every capture shows, not the bare core picture.
  const sessionKey = args.sessionKey;
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
  /**
   * One diagnosable line for a host that just stopped stepping, or null if we
   * have nothing specific to add.
   *
   * "memory access out of bounds" alone gives a human no path forward. When the
   * host is a wasm cart we can say how big its linear memory actually grew,
   * which is the difference between "the cart has a bug" and "the cart ran out
   * of the memory its own build reserved". wasm32 tops out at 4 GB by
   * architecture and Emscripten builds usually cap themselves well below that
   * (openarena's binary declares max=2 GB), so a heap sitting on a power-of-two
   * boundary after a long session is the tell.
   *
   * Best-effort and never throws: this runs on the failure path.
   */
  function describeCartMemory(h) {
    try {
      if (typeof h?.wasmMemorySize !== "function") return null;
      const bytes = h.wasmMemorySize();
      if (!bytes) return null;
      const mb = bytes / (1024 * 1024);
      return `[playtest] cart WASM linear memory is ${mb.toFixed(0)} MB. `
        + "If the cart trapped with 'memory access out of bounds', it likely hit the "
        + "maximum its build declared (wasm32 allows at most 4096 MB; Emscripten caps "
        + "lower unless MAXIMUM_MEMORY says otherwise) — rebuild the cart with a higher "
        + "cap or a smaller resident asset set. Reload with loadMedia to recover.";
    } catch { return null; }
  }

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
  // With an Active Bezel attached, the COMPOSITE is what the human is meant to
  // see, and it has its own shape (a 16:9 scene, typically) that has nothing to
  // do with the core's framebuffer. Size the window to the scene, or the panel
  // gets letterboxed away into a 4:3 box built for the bare game.
  const openBezel = getActiveBezel(sessionKey);
  let bezelScene = null;
  if (openBezel) {
    try {
      const probe = compositeFrame(sessionKey, host, { source: "composite" });
      if (probe?.source === "composite") bezelScene = { width: probe.width, height: probe.height };
    } catch { /* fall back to the core framebuffer below */ }
  }
  const fbWidth = bezelScene?.width ?? first.width;
  const fbHeight = bezelScene?.height ?? first.height;

  // Decide initial window size. In "tv" / "core" modes, scale by height
  // and let the chosen aspect dictate width — keeps vertical resolution
  // honest (you can still count scanlines) while applying horizontal
  // stretch. Shared + unit-tested in core-runner (the inline copy of this
  // math is what opened a 0-width window when a host reported aspect 0).
  // A bezel's scene is already the finished picture at its intended shape, so
  // it must be presented 1:1 ("fb"). Applying the platform's TV aspect on top
  // would stretch a 16:9 composite as if it were a bare 4:3 NES frame, and the
  // panel's text is the first thing that smears when that happens.
  const { width: winInitW, height: winInitH } = initialWindowSize({
    fbWidth, fbHeight, scale,
    aspectMode: bezelScene ? "fb" : aspectMode,
    platform: host.status.platform,
    displayAspect: bezelScene ? fbWidth / fbHeight : host.status.displayAspect,
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
  //
  // A GPU Active Bezel owns a native-gles context for exactly the same reason,
  // on ANY platform -- an NES bezel compositing on the GPU collides just as a
  // Dreamcast core does. Checking only host.hwRender missed it, so
  // `loadMedia({activeBezelRenderer:'gpu'})` followed by playtest killed the
  // whole server every time. The composite likewise arrives as CPU pixels, so
  // the same software-blit window is the right answer.
  const gpuBezel = !!openBezel?.compositor?.gpuReady;
  /* EXPERIMENT (bezel-side agent, 2026-08-03): with releaseBezelGl()
   * serializing bezel GL against the window loop, the accelerated window
   * may be safe again for GPU bezels -- and the software 1080p blit costs
   * ~13.6ms/frame, which blows the 16.7ms budget and starves audio.
   * Opt-in via ROMDEV_ACCEL_WINDOW=1 so the default stays safe. */
  const forceAccel = process.env.ROMDEV_ACCEL_WINDOW === "1";
  /*
   * NON-LIBRETRO hosts hold a GL context too, and checking only `host.hwRender`
   * missed them: WasmcartHost/JsGameHost set `hwRender = null` (there is no
   * libretro HW-render path) but a GL cart still creates a real WebGL2 context
   * through webgl-node/native-gles. So `playtest({op:'open'})` on a GL wasmcart
   * took the accelerated branch and died exactly like a Dreamcast core:
   *
   *     [cart] wasmcart-lua: boot
   *     X Error of failed request: BadAccess ... X_GLXMakeCurrent
   *
   * killing the whole server. Same class as the two cases above, third
   * discovery of it -- so key off "does this host have a live GL context",
   * which every host kind can answer, rather than enumerating host types.
   *
   * wasmcart reports this per LOAD (`status.gl === "rendered"` only when the
   * cart actually requested a context), so a 2D cart keeps the fast
   * accelerated path and pays nothing. jsgame always drives WebGL2 through
   * rungame, so its kind alone is the signal.
   */
  const glHost = host.status?.gl === "rendered" || host.kind === "jsgame";
  const hwRenderCore = !!host.hwRender || glHost || (gpuBezel && !forceAccel);
  const window = sdl.video.createWindow({
    title,
    width: winInitW,
    height: winInitH,
    resizable: true,
    accelerated: hwRenderCore ? false : true,
    vsync: false,
  });
  log.debug(`[playtest] window opened: ${winInitW}x${winInitH}, fb=${fbWidth}x${fbHeight}, aspect=${aspectMode}`);

  /* GL-DIRECT PRESENT (bezel-side agent 2026-08-03; the ONLY present path
   * for GPU bezels since 2026-08-08): rebind the bezel compositor's context
   * onto this window's native handle and present by GPU blit + swap -- no
   * composite readback consumption here, no SDL software blit, no rescale
   * cliff at any window size. There is NO flag and NO fallback: the
   * ROMDEV_GL_PRESENT escape hatch let a broken native-gles attachWindow
   * hide behind a silent 29ms software blit (game at half speed) for two
   * days. A GPU bezel presents through GL or the window refuses to open --
   * the machines this runs on always have a GPU, so a failed bind means
   * the GL stack is broken and the fix is to repair it, not to limp. */
  let glPresent = false;
  if (gpuBezel) {
    if (window.native?.handle) {
      try {
        glPresent = !!openBezel.compositor.migrateToWindow?.(window.native.handle);
      } catch (e) {
        log.error("[playtest] GL-direct present setup failed:", e.message);
      }
    }
    if (!glPresent) {
      try { window.destroy(); } catch { /* window half-open */ }
      throw new Error(
        "playtest: GL-direct present failed for a GPU-bezel window ("
        + (window.native?.handle
          ? "the compositor could not bind the window surface"
          : "SDL exposed no native window handle")
        + "). There is no software fallback: the GL stack is broken -- check "
        + "native-gles attachWindow errors in the server log.");
    }
  }

  /* GL-DIRECT PRESENT FOR GL CARTS (no bezel involved). Same idea as the
   * bezel path above, one layer down: a GL cart renders on the GPU, and
   * without this its every frame is dragged back to the CPU by glReadPixels
   * and blitted in software -- ~5.4 ms of a 16.7 ms budget at 1080p, spent
   * moving pixels the GPU already had.
   *
   * Deliberately NOT fatal, unlike the bezel branch. A GPU bezel has no other
   * way to present, so a failed bind there means the GL stack is broken and
   * limping would hide it. A GL cart always has the readback path, and
   * attaching requires a PRIVATE context the host only has when it was loaded
   * with presentWindow -- so "cannot attach" is the ordinary case for an
   * already-loaded cart, not a broken stack. It stays on readback and says so
   * once. */
  let cartGlPresent = false;
  if (!glPresent && typeof host.canAttachWindow === "function" && host.canAttachWindow()) {
    if (window.native?.handle) {
      try {
        cartGlPresent = !!host.attachWindow(window.native.handle);
      } catch (e) {
        log.error("[playtest] GL cart direct present setup failed:", e.message);
      }
    }
    log.info(cartGlPresent
      ? "[playtest] GL cart presents DIRECT (GPU blit + swap — no readback)."
      : "[playtest] GL cart could not bind the window; using readback present.");
  } else if (!glPresent && host.status?.gl === "rendered") {
    log.debug("[playtest] GL cart on the shared offscreen context — readback present. "
      + "Load with presentWindow:true for GPU-direct present.");
  }

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
  // The resampler is ALWAYS loaded now, not just for low-rate cores: dynamic
  // rate control (the enqueue path) bends every chunk's ratio by the audio
  // queue error, which is what lets the loop step exactly one core frame per
  // tick instead of dropping/doubling frames to chase the clock. If the WASM
  // fails to load, DRC is off (drcReady=false, raw enqueue) and low-rate
  // cores also lose upsampling -- audible, never fatal.
  let drcReady = await initResampler();
  if (!drcReady) {
    log.error("[playtest] resampler WASM failed to load — dynamic rate control off (audio may click)");
    needsResample = false;
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
  // Per-slot trigger tracking (baseline + hysteresis) — lives beside the
  // slot map so it survives across ticks and resets with the controller.
  const triggerStates = [makeTriggerState(), makeTriggerState()];

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
        triggerStates[i] = makeTriggerState(); // new pad, new trigger baseline
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

  // A trapped WASM cart fails identically forever (see the step catch below),
  // so stop stepping after this many consecutive failures. Above 1 so a genuine
  // one-tick blip mid-swap still rides through; low enough that the log stays
  // readable. The window keeps rendering the last good frame either way.
  const MAX_CONSECUTIVE_STEP_ERRORS = 3;
  let consecutiveStepErrors = 0;
  let steppingDisabled = false;

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
    bezelMs: 0,         // EMA: Active Bezel tick+compose per composed frame
    bezelEveryN: 1,     // composing 1 frame in N (1 = every frame)
    bezelSkipped: 0,    // composites skipped since the window opened
  };

  // ── Bezel pacing: the GAME never waits for the overlay ──────────────
  //
  // The tick used to run core-step → bezel tick+compose → present in one
  // serial chain, so an expensive bezel slowed the GAME: audio, input latency
  // and physics all inherited its cost. A 25-31ms SNES HD bezel tick on top of
  // a 16.7ms frame budget is why an otherwise full-speed game played "slow as
  // fuck" from the pad.
  //
  // The core stepping above is already time-budgeted and audio-paced; this
  // does the same for the overlay, with the priority the report asks for:
  // DROP COMPOSITES, NEVER CORE FRAMES. A 60fps game under a 20fps overlay
  // refresh is playable; a 15fps game is not.
  //
  // Self-tuning from measured cost, so no per-package configuration: if a
  // tick+compose costs more than the frame budget, compose every Nth frame
  // where N is how many budgets it spans. Cheap bezels keep composing every
  // frame and are unaffected (N stays 1). The last composite is re-presented
  // on skipped frames, so the overlay holds still rather than flickering.
  //
  // Side benefit noted by the bezel agent: fewer composites means fewer
  // tick-time GL uploads interleaved with the window loop, which shrinks the
  // surface of the EGL/GLX driver-state crash.
  const BEZEL_MAX_EVERY_N = 8;   // never refresh slower than ~7.5fps at 60Hz
  let lastComposite = null;      // { rgba, width, height } re-presented while skipping
  /* Where the picture last landed inside the window, for the inverse transform
   * the mouse handlers need. Null until the first frame is presented, which is
   * why the handlers ignore events before then. */
  let lastPresentRect = null;
  let bezelFrameCounter = 0;
  let perfFrames = 0, perfTicks = 0, perfWinStart = 0;
  const ema = (prev, v) => (prev === 0 ? v : prev + (v - prev) * 0.05);
  // On-window fps: always in the title bar (updated 1/s, zero render cost);
  // a corner counter drawn into the frame is toggled by the human (F3) or
  // the agent (playtest({op:'fps'}) → session.setFpsOverlay).
  let fpsOverlay = !!args.fpsOverlay;

  window.on("close", () => { stop(); });

  /* ── Mouse → cart pointer (wasmcart FLAG_POINTER carts) ────────────────
   *
   * Without this a human could not CLICK a pointer-first cart in the playtest
   * window at all -- menus, card games, puzzle games, anything built for touch
   * were agent-drivable (input({op:'pointer'})) but not human-playable, which
   * is the wrong way round for an acceptance pass.
   *
   * Gated on the cart declaring FLAG_POINTER (0x08) so mouse movement never
   * reaches a pad-only cart. The window coordinate is inverted through the
   * SAME letterbox the frame was presented with, so a click lands exactly
   * where the human saw it -- including after a resize, since the rect is
   * recomputed every frame.
   */
  const WC_FLAG_POINTER = 0x08;
  const cartWantsPointer = () => {
    try {
      const info = typeof host.getInfo === "function" ? host.getInfo() : null;
      return !!((info?.flags ?? 0) & WC_FLAG_POINTER);
    } catch { return false; }
  };
  /** Window (backing-store) coords -> cart pixels, or null if outside the picture. */
  const windowToCart = (wx, wy) => {
    const r = lastPresentRect;
    if (!r || !r.w || !r.h) return null;             // nothing presented yet
    // node-sdl reports mouse in WINDOW points; the rect is in backing-store
    // pixels. On HiDPI those differ, so scale by the same ratio the presenter
    // used rather than assuming 1:1.
    const sx = (window.pixelWidth || r.winW) / (window.width || r.winW);
    const sy = (window.pixelHeight || r.winH) / (window.height || r.winH);
    const px = wx * sx, py = wy * sy;
    if (px < r.x || py < r.y || px >= r.x + r.w || py >= r.y + r.h) return null; // letterbox bar
    return {
      x: Math.floor((px - r.x) * r.fbW / r.w),
      y: Math.floor((py - r.y) * r.fbH / r.h),
    };
  };
  let mouseButtons = { left: false, right: false };
  const sendPointer = (pt, active = true) => {
    if (!pt || typeof host.setInput !== "function") return;
    try {
      host.setInput({ pointer: { id: 0, x: pt.x, y: pt.y, left: mouseButtons.left, right: mouseButtons.right, active } });
    } catch { /* a pointer-less host just ignores it; never kill the loop */ }
  };
  window.on("mouseMove", (e) => {
    if (!cartWantsPointer()) return;
    sendPointer(windowToCart(e.x, e.y));
  });
  window.on("mouseButtonDown", (e) => {
    if (!cartWantsPointer()) return;
    if (e.button === 1) mouseButtons.left = true;
    else if (e.button === 3) mouseButtons.right = true;
    sendPointer(windowToCart(e.x, e.y));
  });
  window.on("mouseButtonUp", (e) => {
    if (!cartWantsPointer()) return;
    if (e.button === 1) mouseButtons.left = false;
    else if (e.button === 3) mouseButtons.right = false;
    sendPointer(windowToCart(e.x, e.y));
  });
  // node-sdl names this "leave", not "mouseLeave" -- an unknown event name
  // makes createWindow throw "invalid event" and the whole window fails to open.
  window.on("leave", () => {
    if (!cartWantsPointer()) return;
    // Cursor left the window: release the slot so a cart does not keep drawing
    // a hover state for a mouse that is not there.
    mouseButtons = { left: false, right: false };
    if (typeof host.setInput === "function") {
      try { host.setInput({ pointer: { id: 0, x: 0, y: 0, left: false, right: false, active: false } }); } catch { /* ignore */ }
    }
  });
  window.on("keyDown", (e) => {
    if (e.key === "escape") { stop(); return; }
    const key = e.key ? e.key.toLowerCase() : "";
    // RetroArch-style emulator hotkeys — act on the live host, not game input.
    if (key === "p" || key === "space") {
      const h = getLiveHost();
      // Guarded like F2/F4: pause/resume are OPTIONAL host methods, and this
      // runs inside an SDL event callback where a throw escapes the tool-call
      // error path entirely and kills the process (it took the whole server
      // down on wasmcart/jsgame carts, losing every session's host from one
      // advertised keypress).
      if (h && typeof h.pause === "function" && typeof h.resume === "function") {
        try { h.status?.paused ? h.resume() : h.pause(); } catch (err) {
          log.debug("[playtest] pause toggle failed:", err.message);
        }
      } else {
        log.info("[playtest] P/Space — this host does not support pause.");
      }
      return;
    }
    // F11 — fullscreen toggle, the convention every player already knows.
    // ESC intentionally does NOT leave fullscreen: it closes the window (see
    // the handler above), and silently changing that would surprise anyone who
    // has learned ESC-to-quit here. Press F11 again to come back.
    if (key === "f11") {
      try { window.setFullscreen(!window.fullscreen); } catch { /* some drivers refuse; keep playing */ }
      return;
    }
    if (key === "f3") { fpsOverlay = !fpsOverlay; return; }
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
    if (key === "b") {
      // Suspend/resume the Active Bezel WITHOUT tearing it down: the guest
      // interpreter keeps every bit of its state and resume never re-runs
      // init(). While suspended the window (and captures) show the raw core
      // picture and pre_frame stops shaping the game.
      const bypassed = setActiveBezelBypassed(sessionKey);
      if (bypassed !== null) log.info(`[playtest] B → bezel ${bypassed ? "SUSPENDED (raw core picture)" : "active"}`);
      return;
    }
    if (key === "h") {
      // Soft reset — same path as host({op:'reset'}): the console RESET
      // button, work RAM persists. The attached bezel is told continuity
      // broke so it drops caches from the abandoned timeline.
      const h = getLiveHost();
      if (h && h.status?.loaded) {
        try {
          h.reset();
          notifyActiveBezel(sessionKey, "reset");
          log.info("[playtest] H → soft reset");
        } catch (err) {
          log.debug("[playtest] reset failed:", err.message);
        }
      }
      return;
    }
    if (key === "k") {
      const h = getLiveHost();
      // Reachable on any host with pause now, so guard the optional methods
      // and the async stepFrames (jsgame returns a promise: an unhandled
      // rejection here is the same uncaught-in-callback hazard as the throw).
      if (h && h.status?.loaded && h.status.paused
          && typeof h.pause === "function" && typeof h.resume === "function") {
        try {
          h.resume();
          const stepped = h.stepFrames(1);
          if (stepped && typeof stepped.then === "function") {
            stepped.catch((err) => log.debug("[playtest] frame advance failed:", err.message))
              .finally(() => h.pause());
          } else {
            h.pause();
          }
        } catch (err) {
          try { h.pause(); } catch { /* leave it paused-ish; nothing else to do */ }
          log.debug("[playtest] frame advance failed:", err.message);
        }
      }
      return;
    }
    if (key === "r") {
      // The ring buffer's top snapshot is the state *before* the currently
      // displayed frame; discard it, then restore the one before that and
      // re-run a frame to render it. (stepFrames is a no-op while paused, so
      // we resume/step/pause exactly like frame advance.)
      const h = getLiveHost();
      if (h && h.status?.loaded && h.status.paused && rewindBuffer.length > 1
          && typeof h.pause === "function" && typeof h.resume === "function"
          && typeof h.unserializeState === "function") {
        rewindBuffer.pop();
        const snap = rewindBuffer[rewindBuffer.length - 1];
        try {
          h.unserializeState(snap);
          h.resume();
          const stepped = h.stepFrames(1);
          if (stepped && typeof stepped.then === "function") {
            stepped.catch((err) => log.error("[playtest] rewind error:", err.message))
              .finally(() => h.pause());
          } else {
            h.pause();
          }
          frameCount++;
          humanInput.note(true, tickCount);
        } catch (e) {
          try { h.pause(); } catch { /* nothing else to do */ }
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
    if (tickTimer) clearTimeout(tickTimer);
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
  // 30fps title (some DC discs on flycast) at a 60Hz tick gets double-ticked —
  // wasting half the budget and, on a heavy core with a big per-frame cost,
  // falling behind every tick → the black-flash/glitch. At its real 30fps
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
        // Title-bar readout — the human's always-on fps display.
        try { window.setTitle(`${title} | ${perf.fps} fps`); } catch { /* window mid-teardown */ }
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
    // `steppingDisabled` — the core trapped and cannot be stepped again; treat
    // it exactly like paused so the window keeps presenting the last good frame
    // (and the human can still hit F2/ESC) instead of going black or spinning.
    const paused = !!h.status.paused || !!h._renderTickSuspended || steppingDisabled;
    // Read controller state for each slot independently. Slot 0 = port 0
    // (player 1), slot 1 = port 1 (player 2). Each slot's input is built
    // into its own port object. The agent's setInput is only overwritten
    // while the human is ACTUALLY pressing (see the write below) — an idle
    // window leaves it alone. Select+Start on any controller quits.
    let quit = false;
    const isC64 = h.status?.platform === "c64";
    const isN64 = h.status?.platform === "n64";
    function readControllerInto(port, inst, slot) {
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
      // Triggers → L2/R2 digital bits, through the SHARED baseline+hysteresis
      // derivation (see romdev-core-runner/present.js — X360 trigger axes can
      // idle mid-scale, so a naive threshold sticks or never fires). Most
      // retro platforms ignore bits 12/13 entirely, which is exactly what
      // makes them free real estate for an Active Bezel. Skipped on N64:
      // its Z is already mapped to the trigger as a DIGITAL shoulder press
      // via SDL_BUTTON_TO_LIBRETRO_BIT_N64.
      const trig = deriveTriggerState(axes, triggerStates[slot] ?? makeTriggerState());
      if (!isN64) {
        if (trig.l2) port.l2 = true;
        if (trig.r2) port.r2 = true;
      }
      // Raw analog passthrough: sticks -1..1, triggers baseline-corrected
      // 0..1. Additive — the digital mask above stays the game contract; the
      // axes feed the core's ANALOG device (real N64 steering instead of
      // full-deflection d-pad synthesis) and an Active Bezel's ab.input
      // reads (sticks + trigger pressure on every platform).
      port.axes = {
        lx: normAxis(lx), ly: normAxis(ly),
        rx: normAxis(axes.rightStickX ?? 0), ry: normAxis(axes.rightStickY ?? 0),
        lt: trig.lt, rt: trig.rt,
      };
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
    readControllerInto(port0, controllers[0], 0);
    readControllerInto(port1, controllers[1], 1);
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
          // Keep ~100ms queued — the drain still sets the speed, but with
          // enough cushion that ONE late tick cannot empty the device.
          //
          // At 60ms the queue measured as an oscillation between 0 and 67ms
          // (sampled once a second over ten seconds, bezel active AND
          // suspended — so this is the loop's own pacing, not compositing
          // cost): the device was running dry and refilling, which is what
          // clicks and pops actually are. The window is paced by
          // setInterval, whose ~16ms floor sits under NTSC's 16.69ms, so
          // ticks arrive slightly fast and any GC pause or MCP request on
          // this event loop lands as a gap the 60ms buffer could not
          // absorb.
          //
          // 100ms is ~6 frames of latency, still well under the 250ms
          // runaway valve below, and it widens the skip/burst deadband
          // (SKIP_MS - TARGET_MS is one frame either way) so the regulator
          // settles instead of hunting between "step extra" and "skip".
          const TARGET_MS = 100;
          const BUDGET_MS = frameMs * 1.5;  // wall-clock ceiling for the whole burst
          // ONE core frame per tick in the steady state -- smooth game time
          // is the contract, and skip/burst repair is what made "60fps but
          // janky". The tick schedule holds the cadence at frameMs and the
          // resample-ratio nudge (see the enqueue below) holds the queue at
          // target, so in steady state neither branch below fires.
          //   - Stall recovery: queue under HALF target (a GC pause ate the
          //     cushion) -> burst extra frames under the wall-clock budget.
          //   - Runaway valve: queue past 2x target -> skip this step. Only
          //     reachable after resume-from-pause or a scheduler anomaly.
          let preMs = ((audio.queued ?? 0) / bps) * 1000;
          for (const b of h.state.audioRing) preMs += (b.length / 2 / deviceSampleRate) * 1000;
          if (preMs >= TARGET_MS * 2) {
            // present without stepping; the drain brings it back
          } else {
            stepped += h.stepFrames(1);
            if (preMs < TARGET_MS / 2) {
              const burstStart = performance.now();
              do {
                if (performance.now() - burstStart >= BUDGET_MS) break;
                const qMs = ((audio.queued ?? 0) / bps) * 1000;
                let ringMs = 0;
                for (const b of h.state.audioRing) ringMs += (b.length / 2);
                ringMs = (ringMs / deviceSampleRate) * 1000;
                if (qMs + ringMs >= TARGET_MS) break;
                stepped += h.stepFrames(1);
              } while (true);
            }
          }
        } else {
          stepped = h.stepFrames(1); // no audio device → plain 1 frame/tick
        }
      } catch (e) {
        // A step error mid-swap (host being torn down/rebuilt) is transient —
        // skip this frame and let the next tick pick up the new host. Don't kill
        // the window. (A window-level failure is handled by the destroyed checks.)
        //
        // But a WASM instance that has TRAPPED is not transient: once a cart
        // traps (`memory access out of bounds` — typically its linear memory
        // hit the ceiling declared in the binary), every later frame traps too.
        // Retrying a corpse 60 times a second buries the real cause under
        // identical lines and burns the tick budget, so give up after a few
        // consecutive failures and say WHY in one diagnosable line.
        // A single good frame clears the counter (see below).
        consecutiveStepErrors++;
        if (consecutiveStepErrors >= MAX_CONSECUTIVE_STEP_ERRORS) {
          steppingDisabled = true;
          log.error(`[playtest] step failed ${consecutiveStepErrors}x in a row — stopping. Last error: ${e.message}`);
          log.error(`[playtest] ${describeCartMemory(h) ?? "The core is not steppable; reload with loadMedia to recover."}`);
          return;
        }
        log.error("[playtest] step error (skipping frame):", e.message);
        return;
      }
      consecutiveStepErrors = 0;
      perf.stepMs = ema(perf.stepMs, performance.now() - tStep);
      perfFrames += stepped;
      if (stepped > 0) frameCount++;
    }

    if (!window.destroyed) {
      // GL CART DIRECT PRESENT: the cart drew straight into the window's own
      // surface, so presenting is a swap and nothing else. Taking this branch
      // BEFORE the block below is the entire point -- that block's first act
      // is getFramebuffer(), which forces the glReadPixels round trip this
      // path exists to avoid, so merely skipping the blit would keep the cost.
      //
      // No bezel case here: an Active Bezel needs the pixels on the CPU to
      // compose, and its own GL-direct path (glPresent) already handled the
      // window. cartGlPresent is only ever set when there is no bezel.
      if (cartGlPresent) {
        try {
          const tPresentGl = performance.now();
          const swapped = h.presentGl?.();
          perf.presentMs = ema(perf.presentMs, performance.now() - tPresentGl);
          perf.convertMs = 0; // no conversion happens on this path at all
          if (!swapped) {
            // The host lost its attachment (media swapped under us, context
            // destroyed). Fall back to readback for the rest of the session
            // rather than presenting nothing.
            cartGlPresent = false;
            log.info("[playtest] GL-direct present dropped — reverting to readback present.");
          }
        } catch (e) {
          cartGlPresent = false;
          log.error("[playtest] GL-direct present failed, reverting to readback:", e.message);
        }
        // Presented. The readback/blit block below is skipped, but NOT the
        // rest of the tick: the audio enqueue after it paces the whole loop.
      }
      // `cartGlPresent` can be cleared by the block above (a dropped
      // attachment falls back to readback on the SAME tick rather than
      // showing nothing).
      if (!cartGlPresent) try {
        // Active Bezel: run the guest against the frame the core just produced
        // and present the COMPOSITE. This is the human's view, so the window
        // showing the bare core picture while every capture shows the composite
        // would be the two disagreeing about what the game looks like.
        //
        // The tick happens HERE rather than at capture time so the guest sees
        // one tick per emulated frame while a human plays -- a package with
        // per-frame state (an animation, an interpolated marker) would
        // otherwise freeze whenever nobody took a screenshot.
        let fb, rgba;
        const liveBezel = getActiveBezel(sessionKey);
        let composed = null;
        if (liveBezel) {
          // Compose on a schedule derived from what the bezel actually costs
          // (see the pacing note above). On a skipped frame we re-present the
          // previous composite: the game keeps running at full rate underneath
          // and only the overlay refreshes slower.
          bezelFrameCounter++;
          const due = bezelFrameCounter >= perf.bezelEveryN;
          if (due) {
            bezelFrameCounter = 0;
            const tBezel = performance.now();
            try {
              const core = h.screenshotRgba();
              composed = tickActiveBezel(sessionKey, core.rgba, core.width, core.height,
                                         h.status.frameCount);
            } catch { composed = null; }
            const bezelMs = performance.now() - tBezel;
            perf.bezelMs = ema(perf.bezelMs, bezelMs);

            // Retune from the EMA, not the last sample, so one slow frame (a
            // streaming rebuild) doesn't permanently halve the refresh rate and
            // one fast frame doesn't undo a real slowdown.
            const spans = Math.ceil(perf.bezelMs / frameMs);
            perf.bezelEveryN = Math.max(1, Math.min(BEZEL_MAX_EVERY_N, spans));

            if (composed) {
              const cw = composed.width ?? composed.physicalWidth;
              const ch = composed.height ?? composed.physicalHeight;
              const px = composed.rgba ?? composed;
              // Hold a Buffer view for re-presenting. The compositor may reuse
              // its backing store next compose, but we only re-present between
              // composes, so the view is valid exactly while it is used.
              lastComposite = {
                rgba: Buffer.isBuffer(px) ? px : Buffer.from(px.buffer, px.byteOffset, px.byteLength),
                width: cw, height: ch,
              };
            }
          } else if (lastComposite) {
            perf.bezelSkipped++;
            composed = lastComposite;   // re-present, don't re-tick
          }
        } else if (lastComposite) {
          // Bezel unloaded or swapped: drop the held composite so a stale
          // overlay (possibly at the previous package's dimensions) can never
          // be re-presented over a later load.
          lastComposite = null;
          bezelFrameCounter = 0;
          perf.bezelMs = 0;
          perf.bezelEveryN = 1;
        }
        // convertMs times ONLY this section (buffer wrap / rgba conversion).
        // It used to start above the bezel block, so it re-counted the whole
        // bezel tick+compose and read as phantom CPU conversion cost.
        const tConvert = performance.now();
        if (composed) {
          const cw = composed.width ?? composed.physicalWidth;
          const ch = composed.height ?? composed.physicalHeight;
          const pixels = composed.rgba ?? composed;
          // node-sdl's render() requires a Node Buffer; the compositor hands
          // back a Uint8ClampedArray, which throws "buffer must be a Buffer"
          // every frame and leaves the window black. Wrap (no copy) rather
          // than convert.
          rgba = Buffer.isBuffer(pixels)
            ? pixels
            : Buffer.from(pixels.buffer, pixels.byteOffset, pixels.byteLength);
          fb = { width: cw, height: ch };
        } else {
          // No bezel, or the guest faulted this frame: show the raw core
          // picture rather than freezing on a stale composite.
          fb = h.getFramebuffer();
          // A GL cart's readback is ALREADY tightly-packed RGBA8888 with
          // alpha forced opaque, so converting it is a 2-million-pixel copy
          // that produces a byte-identical buffer (measured 3.8 ms/frame at
          // 1080p). Hand SDL the readback directly in that case; every other
          // pixel format still goes through the converter.
          if (fb.format === ROMDEV_PIXEL_FORMAT_RGBA8888
              && fb.pitch === fb.width * 4
              && fb.pixels instanceof Uint8Array) {
            rgba = Buffer.from(fb.pixels.buffer, fb.pixels.byteOffset, fb.pixels.byteLength);
          } else {
            rgbaScratch = framebufferToRgba(fb, rgbaScratch);
            rgba = rgbaScratch;
          }
        }
        perf.convertMs = ema(perf.convertMs, performance.now() - tConvert);
        if (fpsOverlay) {
          // drawFpsOverlay writes INTO the buffer. On a re-presented composite
          // that buffer is the retained one, so the counter would bake into the
          // held image and every skipped frame would stamp another one over it.
          // Draw on a copy whenever we're re-presenting.
          if (composed && composed === lastComposite) {
            rgba = Buffer.from(rgba);
          }
          drawFpsOverlay(rgba, fb.width, fb.height, perf.fps);
        }

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
        if (composed) {
          // The composite is already the finished picture at its intended
          // shape; the platform's TV aspect describes the BARE GAME and would
          // stretch the whole scene, smearing the package's text first.
          targetAspect = fbW / fbH;
        } else if (aspectMode === "tv") {
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
        // Remember where the picture actually landed so the mouse handlers can
        // invert this transform (window coords -> cart pixels). Computed here
        // rather than in the handler because the letterbox depends on the live
        // window size and the frame's aspect, both of which are known here and
        // change under a resize.
        lastPresentRect = { x: dstX, y: dstY, w: dstW, h: dstH, fbW, fbH, winW: curW, winH: curH };

        // Serialization boundary: finish and detach the bezel's GL context
        // before SDL presents. Both stacks share Mesa driver state in this
        // process, and running them back to back in one tick is what corrupts
        // it (see releaseBezelGl). Only after a fresh compose -- a
        // re-presented composite did no GL work, and a bezel-less session has
        // no context to release. With GL-direct present there is only ONE
        // stack, so neither the release nor the SDL render happens at all.
        if (glPresent && composed) {
          /* One GL stack: blit + swap. Audio enqueue below still runs. */
          const tPresentGl = performance.now();
          openBezel.compositor.presentWindow(dstX, dstY, dstW, dstH, curW, curH);
          perf.presentMs = ema(perf.presentMs, performance.now() - tPresentGl);
        } else if (glPresent && openBezel?.compositor?.gpuReady) {
          /* Bezel suspended (B) or guest fault while GL-direct present owns
           * this window. The SDL software renderer must NOT touch it: ANGLE's
           * CAMetalLayer sits over the view, SDL's draws land UNDERNEATH it —
           * the window freezes on the last GL frame (reads as a crash) — and
           * once both stacks have touched one window the GL picture does not
           * come back when the bezel reactivates. One window, one stack:
           * present the raw core frame through the SAME GL pipeline — draw it
           * into the scene, blit, swap. */
          const comp = openBezel.compositor;
          const tPresentGl = performance.now();
          comp.reset();
          const gameH = 1080;                       // compositor logical space
          const gameW = Math.round(gameH * targetAspect);
          comp.drawGame((1920 - gameW) / 2, 0, gameW, gameH, 0); // nearest: bare core pixels
          comp.compose(rgba, fbW, fbH);
          const sceneAspect = (comp.outputWidth || 1920) / (comp.outputHeight || 1080);
          const d = letterbox(curW, curH, sceneAspect);
          comp.presentWindow(d.dstX, d.dstY, d.dstW, d.dstH, curW, curH);
          perf.presentMs = ema(perf.presentMs, performance.now() - tPresentGl);
        } else {
          if (composed && composed !== lastComposite) releaseBezelGl();

          const tPresent = performance.now();
          window.render(fbW, fbH, fbW * 4, "rgba32", rgba, {
            // Nearest keeps emulator pixels crisp, which is right for a bare
            // core frame. A bezel composite is mostly anti-aliased panel art and
            // text, so nearest re-aliases exactly the edges the guest smoothed —
            // linear is the honest presentation of what it drew.
            scaling: composed ? "linear" : "nearest",
            dstRect: { x: dstX, y: dstY, width: dstW, height: dstH },
          });
          perf.presentMs = ema(perf.presentMs, performance.now() - tPresent);
        }
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
          // Dynamic rate control (the RetroArch model): nudge the effective
          // input rate by the queue error, clamped to +/-0.5%. Queue above
          // target -> pretend the core rate is a hair higher (fewer device
          // samples out, queue drains); below -> lower (more samples out,
          // queue refills). Inaudible at this magnitude, and it replaces
          // frame drop/double as the clock-difference absorber.
          if (drcReady) {
            const drcTarget = 100;
            const drcAdj = Math.max(-0.005, Math.min(0.005,
              0.02 * (queuedMs - drcTarget) / drcTarget));
            audio.enqueue(resampleS16Stereo(
              merged, coreSampleRate * (1 + drcAdj), deviceSampleRate));
          } else {
            audio.enqueue(merged);
          }
        }
      } catch (e) {
        if (!e.message?.includes("closed")) {
          log.error("[playtest] audio enqueue error:", e.message);
        }
      }
      h.state.audioRing.length = 0;
    }
  }

  // Drift-compensated scheduler, NOT setInterval: integer-ms timers floor
  // 16.688ms (NTSC) to ~16ms, which runs the loop ~3% hot. The old design
  // repaired that by SKIPPING core steps when the audio queue overfilled --
  // a duplicated frame roughly twice a second, i.e. permanent visible jank
  // at a "perfect 60fps". Anchoring each tick to an absolute schedule keeps
  // the long-run cadence exactly frameMs; the sub-ms residual against the
  // audio clock is absorbed by the resample-ratio nudge below, not by
  // dropping or doubling game frames.
  let tickTimer = null;
  let nextTickAt = performance.now() + frameMs;
  function scheduleTick() {
    if (!running) return;
    const delay = Math.max(0, nextTickAt - performance.now());
    tickTimer = setTimeout(() => {
      nextTickAt += frameMs;
      // After a long stall (GC, a heavy MCP call), don't sprint through the
      // backlog of missed ticks -- realign the schedule and let the audio
      // cushion + catch-up stepping recover.
      if (performance.now() > nextTickAt + frameMs) {
        nextTickAt = performance.now() + frameMs;
      }
      tick();
      scheduleTick();
    }, delay);
  }
  scheduleTick();

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
    // On-screen fps counter control — same state the F3 hotkey flips, so the
    // agent and the human never fight over separate flags.
    get fpsOverlay() { return fpsOverlay; },
    setFpsOverlay(v) { fpsOverlay = !!v; return fpsOverlay; },
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
      // This op's whole job is "capture what the HUMAN sees". With a bezel
      // running that is the composite, so reading the bare core framebuffer
      // here would answer a different question than the one asked — and would
      // disagree with the window sitting in front of them.
      let shot = null;
      if (getActiveBezel(sessionKey)) {
        try {
          const c = compositeFrame(sessionKey, h, { source: "composite" });
          if (c?.source === "composite") {
            shot = framebufferToScreenshot(c.width, c.height, c.rgba, c.width * 4,
                                           ROMDEV_PIXEL_FORMAT_RGBA8888);
          }
        } catch { shot = null; }
      }
      if (!shot) shot = h.screenshot();
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
