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
  // NOTE: L2/R2 (bits 12/13) are ANALOG triggers in libretro — node-sdl exposes
  // them as axes (leftTrigger/rightTrigger), not buttons.
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
    default:            return displayAspect;
  }
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

/** Convert a libretro framebuffer (any pixel format) to RGBA32 for the window
 *  blit. (The GL/HW-render RGBA path forces alpha=255 — the GL render target
 *  leaves alpha=0, which SDL would composite as a black window.) */
export function framebufferToRgba(f) {
  const out = Buffer.alloc(f.width * f.height * 4);
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
