// Playtest — open an SDL window, render the loaded ROM at native framerate,
// drive it with whatever gamepad is plugged in. Uses the same SDL API
// pattern as the working retroemu player.

import {
  RETRO_PIXEL_FORMAT_0RGB1555,
  RETRO_PIXEL_FORMAT_RGB565,
  RETRO_PIXEL_FORMAT_XRGB8888,
} from "../host/retroConstants.js";

// One-pixel solid-black RGBA buffer; we stretch it across the letterbox
// bars each frame so they don't smear with leftover pixels.
const BLACK_PIXEL = Buffer.from([0, 0, 0, 0xFF]);

let _sdlModule = null;
async function getSdl() {
  if (_sdlModule) return _sdlModule;
  const ns = await import("@kmamal/sdl");
  _sdlModule = ns.default || ns;
  return _sdlModule;
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
  const { host } = args;
  if (!host) throw new Error("playtest requires a loaded host");
  const scale = args.scale ?? 3;
  const title = args.title ?? "romdev playtest";
  const aspectMode = args.aspect ?? "fb";

  const sdl = await getSdl();

  // Step one frame so we know the framebuffer dimensions + pixel format.
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
  console.error(`[playtest] window opened: ${winInitW}x${winInitH}, fb=${fbWidth}x${fbHeight}, aspect=${aspectMode}`);

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
    console.error(`[playtest] audio: ${coreSampleRate} Hz, stereo, s16`);
  } catch (e) {
    console.error("[playtest] audio init failed (continuing silent):", e.message);
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
      console.error(`[playtest] controller plugged in but both slots full — ignoring: ${device.name}`);
      return;
    }
    try {
      const inst = sdl.controller.openDevice(device);
      inst._device = device; // tag for deviceRemove matching
      controllers[idx] = inst;
      console.error(`[playtest] controller slot ${idx + 1}: ${device.name}`);
    } catch (e) {
      console.error(`[playtest] controller open failed (slot ${idx + 1}):`, e.message);
    }
  }

  function closeBySlotMatching(device) {
    for (let i = 0; i < controllers.length; i++) {
      const inst = controllers[i];
      if (inst && inst._device === device) {
        // SDL auto-closes the instance per its docs; just drop the ref.
        controllers[i] = null;
        console.error(`[playtest] controller slot ${i + 1} disconnected: ${device.name}`);
        return;
      }
    }
  }

  // Pre-open already-plugged controllers (up to slot 1).
  if (sdl.controller.devices.length === 0) {
    console.error("[playtest] no controller detected (keyboard fallback active)");
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

  window.on("close", () => { stop(); });
  window.on("keyDown", (e) => {
    if (e.key === "escape") { stop(); return; }
    if (e.key) heldKeys.add(e.key.toLowerCase());
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
    console.error(`[playtest] closed after ${frameCount} frames`);
    if (closeResolver) closeResolver();
  }

  // Tick = one emulated frame + render + audio drain. Driven by setInterval
  // so the Node event loop stays free for MCP requests on the same host.
  const frameMs = 1000 / 60;

  function tick() {
    if (!running || window.destroyed) { stop(); return; }
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
      console.error("[playtest] Select+Start pressed — closing");
      stop();
      return;
    }
    // Merge in keyboard state on port 0. ORed with controller state so a
    // user can mix both (rare, but harmless). Keyboard never reaches
    // port 1 — that's reserved for the second physical controller.
    for (const [keyName, bit] of Object.entries(KEY_TO_LIBRETRO_BIT)) {
      if (heldKeys.has(keyName)) port0[bitToName(bit)] = true;
    }
    host.setInput({ ports: [port0, port1] });

    let stepped = 0;
    try {
      stepped = host.stepFrames(1);
    } catch (e) {
      console.error("[playtest] step error:", e.message);
      stop();
      return;
    }
    if (stepped > 0) frameCount++;

    if (!window.destroyed) {
      try {
        const fb = host.getFramebuffer();
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
          targetAspect = tvAspectFor(host.status.platform, host.status.displayAspect ?? fbW / fbH);
        } else if (aspectMode === "core") {
          targetAspect = host.status.displayAspect ?? fbW / fbH;
        } else {
          targetAspect = fbW / fbH;
        }
        const winAspect = winPixelW / winPixelH;
        let dstW, dstH;
        if (winAspect > targetAspect) {
          dstH = winPixelH;
          dstW = Math.round(winPixelH * targetAspect);
        } else {
          dstW = winPixelW;
          dstH = Math.round(winPixelW / targetAspect);
        }
        const dstX = Math.round((winPixelW - dstW) / 2);
        const dstY = Math.round((winPixelH - dstH) / 2);

        window.render(fbW, fbH, fbW * 4, "rgba32", rgba, {
          scaling: "nearest",
          dstRect: { x: dstX, y: dstY, width: dstW, height: dstH },
        });
      } catch (e) {
        if (e.message?.includes("destroyed")) { stop(); return; }
        console.error("[playtest] render error:", e.message);
      }
    }

    if (running && audio && host.state.audioRing.length > 0) {
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
        if (!e.message?.includes("closed")) {
          console.error("[playtest] audio enqueue error:", e.message);
        }
      }
      // Always clear the ring — if we skipped enqueue we drop those samples.
      host.state.audioRing.length = 0;
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
