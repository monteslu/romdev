// present.js — the shared presentation + input-mapping primitives every SDL
// frontend over romdev-core-host needs: pixel-format → RGBA conversion for the
// window blit, aspect-correct letterboxing, the platform "TV" aspect table,
// and the default SDL-button / keyboard → RetroPad maps. Extracted from
// romdev's playtest window so there is ONE copy (playtest imports these too).

import {
  RETRO_PIXEL_FORMAT_0RGB1555,
  RETRO_PIXEL_FORMAT_RGB565,
  RETRO_PIXEL_FORMAT_XRGB8888,
  ROMDEV_PIXEL_FORMAT_RGBA8888,
} from "romdev-core-host/retroConstants.js";

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
export const SDL_BUTTON_TO_LIBRETRO_BIT = {
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
  leftShoulder: 10,   // RETRO L
  rightShoulder: 11,  // RETRO R
  leftStick: 14,      // RETRO L3
  rightStick: 15,     // RETRO R3
  // L2/R2 (bits 12/13) are ANALOG triggers — node-sdl exposes them as axes
  // (leftTrigger/rightTrigger), not buttons. They reach the mask through
  // deriveTriggerState below (baseline-relative threshold + hysteresis).
};

// Keyboard fallback for users without a gamepad. Same physical-position
// convention as the controller map: Z = bottom (NES A / SNES B), X = right
// (NES B / SNES A), A = left (SNES Y), S = top (SNES X). Arrows for D-pad.
// Enter = Start, RShift = Select, Q/W = L/R shoulders.
//
// Key strings come straight from node-sdl keyDown/keyUp events.
export const KEY_TO_LIBRETRO_BIT = {
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

// Analog stick → dpad direction (for games that only read dpad).
export const STICK_DEADZONE = 8000;

/* --- Trigger → L2/R2 + raw-axes normalization ------------------------------
 * ONE derivation shared by every SDL frontend (playtest, runRom, anything
 * else over the runner) so "when does a trigger count as pressed" cannot
 * disagree between windows.
 *
 * Two quirks force the shape:
 * - node-sdl axis units differ by backend/pad; normalize by magnitude
 *   (raw s16 vs already -1..1) instead of trusting either.
 * - X360 trigger axes can IDLE at ~mid-scale, so an absolute threshold
 *   either sticks "pressed" or never fires. Track a per-trigger BASELINE
 *   (minimum ever seen = the idle value) and threshold RELATIVE to it,
 *   with hysteresis so a half-pulled trigger cannot chatter the bit.
 * The corrected 0..1 pressure is also returned so the analog passthrough
 * reports 0 at idle no matter where the raw axis idles.
 */
export const TRIGGER_PRESS = 0.55;   // above baseline → bit sets
export const TRIGGER_RELEASE = 0.35; // below baseline → bit clears

/** Normalize a node-sdl axis value to -1..1 whatever its native unit. */
export function normAxis(value) {
  const v = value || 0;
  return Math.abs(v) > 2 ? Math.max(-1, Math.min(1, v / 32767)) : v;
}

/** Per-controller-slot trigger tracking state. */
export function makeTriggerState() {
  return { l2: false, r2: false, lBase: null, rBase: null };
}

/**
 * Fold this tick's trigger axes into `state`, returning the digital bits and
 * baseline-corrected pressures. Call once per poll per controller slot.
 * @param {{leftTrigger?: number, rightTrigger?: number}} axes node-sdl axes
 * @param {ReturnType<typeof makeTriggerState>} state
 * @returns {{l2: boolean, r2: boolean, lt: number, rt: number}}
 */
export function deriveTriggerState(axes, state) {
  const step = (raw, held, baseKey) => {
    const v = normAxis(raw);
    if (state[baseKey] === null || v < state[baseKey]) state[baseKey] = v;
    const range = Math.max(0.05, 1 - state[baseKey]);
    const pressure = Math.max(0, Math.min(1, (v - state[baseKey]) / range));
    const next = held ? pressure > TRIGGER_RELEASE : pressure > TRIGGER_PRESS;
    return { held: next, pressure };
  };
  const l = step(axes?.leftTrigger, state.l2, "lBase");
  const r = step(axes?.rightTrigger, state.r2, "rBase");
  state.l2 = l.held;
  state.r2 = r.held;
  return { l2: state.l2, r2: state.r2, lt: l.pressure, rt: r.pressure };
}

/** libretro JOYPAD bit → the host's setInput() button name. */
export function bitToName(bit) {
  return ({
    0: "b", 1: "y", 2: "select", 3: "start",
    4: "up", 5: "down", 6: "left", 7: "right",
    8: "a", 9: "x", 10: "l", 11: "r",
    12: "l2", 13: "r2", 14: "l3", 15: "r3",
  })[bit];
}

/**
 * "TV" aspect ratio per platform: the physical CRT/LCD shape the platform was
 * designed for — 4:3 for every console that hooked to a TV, native LCD aspect
 * for handhelds. Fallback when platform unknown: the core-reported aspect.
 * @param {string | null} platform
 * @param {number} displayAspect core-reported, used as fallback
 */
export function tvAspectFor(platform, displayAspect) {
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
    case "gametank":    return 4 / 3;    // composite out to a 4:3 display
    // Unknown platform (wasmcart/jsgame/newer cores): trust the reported
    // aspect only if it's a real ratio — hosts that don't know theirs report
    // 0, and a 0 aspect sizes a 0-width window (SDL "invalid width").
    default:            return Number.isFinite(displayAspect) && displayAspect > 0
      ? displayAspect
      : 4 / 3;
  }
}

/**
 * A usable aspect ratio from host status. `status.displayAspect ?? fbW/fbH`
 * is a trap: hosts that don't know their aspect report 0, and nullish
 * coalescing keeps the 0 — which then sizes a zero-width window. Prefer the
 * reported aspect only when it's a real positive ratio, else the
 * framebuffer's own shape, else 4:3 as the last resort (fb dims can be 0
 * before a cart settles its resolution).
 * @param {number | null | undefined} statusAspect host.status.displayAspect
 * @param {number} fbWidth
 * @param {number} fbHeight
 */
export function effectiveAspect(statusAspect, fbWidth, fbHeight) {
  if (Number.isFinite(statusAspect) && statusAspect > 0) return statusAspect;
  const fbAspect = fbWidth / fbHeight;
  if (Number.isFinite(fbAspect) && fbAspect > 0) return fbAspect;
  return 4 / 3;
}

/**
 * Initial window size, the way playtest and runRom open theirs: height =
 * fbHeight * scale, width follows the chosen aspect mode. THE function that
 * opened a 0-width window ("invalid width") when a host reported
 * displayAspect 0 — it lived duplicated + inline in both windows, so nothing
 * unit-tested it. Pure; throws a plain-language error instead of returning
 * dimensions SDL would reject.
 * @param {{fbWidth:number, fbHeight:number, scale:number,
 *          aspectMode:"tv"|"core"|"fb", platform:string|null,
 *          displayAspect:number|null|undefined}} p
 * @returns {{width:number, height:number}}
 */
export function initialWindowSize({ fbWidth, fbHeight, scale, aspectMode, platform, displayAspect }) {
  let width = fbWidth * scale;
  let height = fbHeight * scale;
  if (aspectMode === "tv" || aspectMode === "core") {
    const aspect = aspectMode === "tv"
      ? tvAspectFor(platform, effectiveAspect(displayAspect, fbWidth, fbHeight))
      : effectiveAspect(displayAspect, fbWidth, fbHeight);
    width = Math.round(height * aspect);
  }
  if (!(width > 0) || !(height > 0)) {
    throw new Error(
      `window sizing failed: framebuffer ${fbWidth}x${fbHeight}, scale ${scale}, ` +
      `aspect mode ${aspectMode} → ${width}x${height} (the host hasn't produced a real frame yet?)`);
  }
  return { width, height };
}

/**
 * Largest rect of `targetAspect` that fits inside a winW×winH window, centered
 * (letterbox/pillarbox). Pure — the image is ALWAYS drawn at this rect, so
 * resizing the window never stretches it off-aspect, it just grows the bars.
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

// 3x5 bitmap digits for the on-window fps counter (row bit patterns, MSB = left).
const FPS_DIGITS = [
  [0b111, 0b101, 0b101, 0b101, 0b111], // 0
  [0b010, 0b110, 0b010, 0b010, 0b111], // 1
  [0b111, 0b001, 0b111, 0b100, 0b111], // 2
  [0b111, 0b001, 0b111, 0b001, 0b111], // 3
  [0b101, 0b101, 0b111, 0b001, 0b001], // 4
  [0b111, 0b100, 0b111, 0b001, 0b111], // 5
  [0b111, 0b100, 0b111, 0b101, 0b111], // 6
  [0b111, 0b001, 0b010, 0b010, 0b010], // 7
  [0b111, 0b101, 0b111, 0b101, 0b111], // 8
  [0b111, 0b101, 0b111, 0b001, 0b111], // 9
];

/**
 * Draw an fps counter into the top-left of an RGBA frame buffer (in place,
 * after framebufferToRgba, before the window blit). Green digits on a black
 * backing box, sized relative to the framebuffer so it reads the same on a
 * 160x144 handheld and a 1280x720 wasmcart cart. Pure pixel writes — no
 * fonts, no allocations.
 * @param {Buffer|Uint8Array} rgba RGBA32 frame (width*height*4 bytes)
 * @param {number} width frame width in pixels
 * @param {number} height frame height in pixels
 * @param {number} fps value to display (clamped to 0..999)
 */
export function drawFpsOverlay(rgba, width, height, fps) {
  const s = Math.max(1, Math.round(height / 120)); // pixel scale
  const text = String(Math.max(0, Math.min(999, Math.round(fps))));
  const pad = s;
  const boxW = pad * 2 + text.length * 4 * s - s; // digits are 3 wide + 1 gap
  const boxH = pad * 2 + 5 * s;
  const x0 = 2, y0 = 2;
  for (let y = 0; y < boxH && y0 + y < height; y++) {
    for (let x = 0; x < boxW && x0 + x < width; x++) {
      const d = ((y0 + y) * width + (x0 + x)) * 4;
      rgba[d] = 0; rgba[d + 1] = 0; rgba[d + 2] = 0; rgba[d + 3] = 0xff;
    }
  }
  for (let i = 0; i < text.length; i++) {
    const glyph = FPS_DIGITS[text.charCodeAt(i) - 48];
    if (!glyph) continue;
    const gx = x0 + pad + i * 4 * s;
    const gy = y0 + pad;
    for (let row = 0; row < 5; row++) {
      for (let col = 0; col < 3; col++) {
        if (!((glyph[row] >> (2 - col)) & 1)) continue;
        for (let sy = 0; sy < s; sy++) {
          for (let sx = 0; sx < s; sx++) {
            const px = gx + col * s + sx;
            const py = gy + row * s + sy;
            if (px >= width || py >= height) continue;
            const d = (py * width + px) * 4;
            rgba[d] = 0x40; rgba[d + 1] = 0xff; rgba[d + 2] = 0x40; rgba[d + 3] = 0xff;
          }
        }
      }
    }
  }
}

/** Convert a libretro framebuffer (any pixel format) to RGBA32 for the window
 *  blit. (The GL/HW-render RGBA path forces alpha=255 — the GL render target
 *  leaves alpha=0, which SDL would composite as a black window.)
 *
 *  Runs once per window tick, so it matters at 60fps on big framebuffers
 *  (wasmcart 1280x720 = 3.7MB): pass the previous return value as `out` to
 *  reuse the buffer (a fresh Buffer.alloc per tick is ~220MB/s of zeroing +
 *  GC churn), and the two 32-bit-per-pixel formats take a word-at-a-time
 *  swizzle path instead of the per-byte loop.
 *  @param {{width:number, height:number, pitch:number, format:number, pixels:Uint8Array}} f
 *  @param {Buffer|null} [out] previous frame's buffer to reuse (size-checked)
 */
export function framebufferToRgba(f, out = null) {
  const need = f.width * f.height * 4;
  if (!out || out.length !== need) out = Buffer.alloc(need);
  // Word-at-a-time path for the 4-byte-per-pixel formats when rows are dense
  // and the source is 4-byte aligned (the normal case for both).
  const dense = f.pitch === f.width * 4 && (f.pixels.byteOffset & 3) === 0;
  if (f.format === ROMDEV_PIXEL_FORMAT_RGBA8888 && dense) {
    const src32 = new Uint32Array(f.pixels.buffer, f.pixels.byteOffset, f.width * f.height);
    const out32 = new Uint32Array(out.buffer, out.byteOffset, f.width * f.height);
    for (let i = 0; i < src32.length; i++) out32[i] = src32[i] | 0xff000000; // force alpha (LE: A is the high byte)
    return out;
  }
  if (f.format === RETRO_PIXEL_FORMAT_XRGB8888 && dense) {
    const src32 = new Uint32Array(f.pixels.buffer, f.pixels.byteOffset, f.width * f.height);
    const out32 = new Uint32Array(out.buffer, out.byteOffset, f.width * f.height);
    for (let i = 0; i < src32.length; i++) {
      const v = src32[i]; // LE bytes B,G,R,X → u32 0xXXRRGGBB
      out32[i] = 0xff000000 | ((v & 0xff) << 16) | (v & 0xff00) | ((v >>> 16) & 0xff);
    }
    return out;
  }
  if (f.format === ROMDEV_PIXEL_FORMAT_RGBA8888) {
    for (let y = 0; y < f.height; y++) {
      const src = y * f.pitch;
      const dst = y * f.width * 4;
      for (let x = 0; x < f.width; x++) {
        const s = src + x * 4;
        const d = dst + x * 4;
        out[d + 0] = f.pixels[s + 0];
        out[d + 1] = f.pixels[s + 1];
        out[d + 2] = f.pixels[s + 2];
        out[d + 3] = 0xff;
      }
    }
  } else if (f.format === RETRO_PIXEL_FORMAT_XRGB8888) {
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
