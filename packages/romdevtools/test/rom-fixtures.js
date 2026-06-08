// rom-fixtures.js — resolve OPTIONAL external test ROMs for the suite.
//
// Some tests exercise behavior that only a real commercial ROM can trigger
// (battery SRAM on an NES RPG, a Lynx/7800 cart's CPU/HW regions, etc.). Those
// ROMs are copyrighted and personal — they are NOT in this repo and never will
// be, and we deliberately do NOT name them in committed source.
//
// Point a single env var at a directory of your own legally-owned ROMs and the
// tests that need them will run; otherwise each one skips. Nothing here leaks a
// path or a game title into git.
//
//   ROMDEV_TEST_ROMS=/path/to/your/roms  npm test
//
// Layout the resolver expects under $ROMDEV_TEST_ROMS (override individually if
// your filenames differ, see the *_FILE env vars below):
//   nes-battery-rpg.nes   c64-homebrew.prg   a7800-homebrew.a78   lynx-homebrew.lnx

import { existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.env.ROMDEV_TEST_ROMS || "";

/**
 * Resolve an optional external ROM. Returns an absolute path if it exists, else
 * null (so callers do `{ skip: !rom }`). Order of precedence:
 *   1. the per-fixture env override (e.g. ROMDEV_NES_BATTERY_ROM=/abs/path)
 *   2. <ROMDEV_TEST_ROMS>/<defaultName>
 * @param {string} envVar  per-fixture absolute-path override
 * @param {string} defaultName  filename under ROMDEV_TEST_ROMS
 * @returns {string|null}
 */
export function romFixture(envVar, defaultName) {
  const override = process.env[envVar];
  if (override) return existsSync(override) ? override : null;
  if (!ROOT) return null;
  const p = join(ROOT, defaultName);
  return existsSync(p) ? p : null;
}

// Named fixtures used across the suite. No game titles in committed source.
export const NES_BATTERY_ROM = romFixture("ROMDEV_NES_BATTERY_ROM", "nes-battery-rpg.nes");
export const C64_HOMEBREW_PRG = romFixture("ROMDEV_C64_PRG", "c64-homebrew.prg");
export const A7800_HOMEBREW = romFixture("ROMDEV_A7800_ROM", "a7800-homebrew.a78");
export const LYNX_HOMEBREW = romFixture("ROMDEV_LYNX_ROM", "lynx-homebrew.lnx");
