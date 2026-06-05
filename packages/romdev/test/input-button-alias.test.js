// Regression test for resolveButtonAlias — pins the platform-native button
// aliases to the EMPIRICALLY-VERIFIED mapping (probed against the running cores
// 2026-06-05 with per-platform hardware-register probe ROMs).
//
// The bug this guards: pressButton({button:'c'}) on Genesis used to resolve to
// libretro 'y', which actually presses Genesis A (SGDK BUTTON_A) — so a feedback
// agent's jump (BUTTON_A) only fired when it happened to include 'y'. The truth
// is genesis_plus_gx maps Genesis A/B/C onto libretro y/b/a, so Genesis C = 'a'.
//
// FULL 14-PLATFORM AUDIT (setInput({a}) → which physical button; probed live):
//   gpgx (INVERTED): genesis a→C b→B y→A | sms/gg a→button2 b→button1
//   correct:         nes(fceumm) gb/gbc(gambatte) snes(snes9x) gba(mgba)
//                    pce(geargrafx I/II) msx(bluemsx trig1/2) lynx(handy A/B)
//   single-fire:     c64(vice) atari2600(stella) — fire via b/south, a is a no-op
//   a7800(prosystem): a→INPT0(right/btn2) b→INPT1(left/btn1) — semantics fine,
//                     default boot is 1-button mode (both read INPT4 until you
//                     enable 2-button via CTLSWB). No alias remap needed.
// So the press-inversion is EXACTLY the three gpgx platforms (all handled here).

import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveButtonAlias } from "../src/mcp/tools/input.js";

test("Genesis 'c' alias resolves to libretro 'a' (Genesis C), not 'y'", () => {
  for (const plat of ["genesis", "megadrive", "md"]) {
    assert.equal(resolveButtonAlias("c", plat), "a",
      `${plat}: Genesis C is libretro 'a' (gpgx maps A/B/C -> y/b/a)`);
  }
});

test("raw libretro + spatial names pass through unchanged on Genesis", () => {
  // pressButton stays consistent with setInput: a/b/x/y and the spatial names
  // are NOT remapped — only the native 'c' alias is.
  for (const b of ["a", "b", "x", "y", "north", "east", "south", "west", "up", "start"]) {
    assert.equal(resolveButtonAlias(b, "genesis"), b, `${b} unchanged on Genesis`);
  }
});

test("SMS/GG '1'/'2' aliases resolve to libretro 'b'/'a' (gpgx inversion)", () => {
  // genesis_plus_gx maps SMS/GG button 1 (TL) → libretro 'b' and button 2 (TR)
  // → libretro 'a' — the same a↔primary inversion as Genesis. Verified
  // empirically against the running gpgx core 2026-06-05.
  for (const plat of ["sms", "gg"]) {
    assert.equal(resolveButtonAlias("1", plat), "b", `${plat}: button 1 (TL) = libretro b`);
    assert.equal(resolveButtonAlias("2", plat), "a", `${plat}: button 2 (TR) = libretro a`);
  }
});

test("native aliases fall back sanely on platforms without a specific map", () => {
  // c -> a, 1 -> a, 2 -> b even if the platform didn't special-case them, so a
  // call never silently presses nothing.
  assert.equal(resolveButtonAlias("c", "nes"), "a");
  assert.equal(resolveButtonAlias("1", "nes"), "a");
  assert.equal(resolveButtonAlias("2", "nes"), "b");
});

test("unknown / standard button names are identity", () => {
  assert.equal(resolveButtonAlias("a", "nes"), "a");
  assert.equal(resolveButtonAlias("start", "genesis"), "start");
  assert.equal(resolveButtonAlias("left", "snes"), "left");
});
