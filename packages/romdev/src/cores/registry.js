// Core registry. Maps platform IDs to bundled libretro WASM cores.
//
// All v1 cores ship inside the npm package under src/cores/wasm/. Resolution
// is a simple path lookup — there is no fetcher because there is nothing to
// fetch.

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Directory holding all bundled `.js` + `.wasm` libretro core pairs. */
export const CORES_DIR = path.resolve(__dirname, "wasm");

/**
 * @typedef {Object} CoreInfo
 * @property {string} platform     short platform id ("nes", "gb", ...)
 * @property {string} coreName     filename stem (matches `<coreName>_libretro.js`)
 * @property {string} displayName
 * @property {string} [aka]        comma-separated synonyms accepted in resolvers
 */

/**
 * @type {Record<string, CoreInfo>}
 */
export const CORES = {
  nes: { platform: "nes", coreName: "fceumm", displayName: "Nintendo Entertainment System (fceumm)" },
  gb: { platform: "gb", coreName: "gambatte", displayName: "Game Boy / GBC (gambatte)" },
  gbc: { platform: "gbc", coreName: "gambatte", displayName: "Game Boy / GBC (gambatte)" },
  atari2600: { platform: "atari2600", coreName: "stella2014", displayName: "Atari 2600 (Stella)" },
  atari7800: { platform: "atari7800", coreName: "prosystem", displayName: "Atari 7800 (ProSystem)" },
  lynx: { platform: "lynx", coreName: "handy", displayName: "Atari Lynx (Handy)" },
  sms: { platform: "sms", coreName: "genesis_plus_gx", displayName: "Sega Master System (Genesis Plus GX)" },
  gg: { platform: "gg", coreName: "genesis_plus_gx", displayName: "Sega Game Gear (Genesis Plus GX)" },
  genesis: { platform: "genesis", coreName: "genesis_plus_gx", displayName: "Sega Genesis / Mega Drive (Genesis Plus GX)" },
  snes: { platform: "snes", coreName: "snes9x", displayName: "SNES (snes9x)" },
  gba: { platform: "gba", coreName: "mgba", displayName: "Game Boy Advance (mGBA)" },
  c64: { platform: "c64", coreName: "vice_x64", displayName: "Commodore 64 (VICE x64)" },
};

/**
 * Resolve a platform id to absolute paths for its core.
 * Returns null if the core isn't bundled.
 * @param {string} platform
 * @returns {{ platform: string, coreName: string, displayName: string, jsPath: string, wasmPath: string } | null}
 */
// Platform → the @romdev binary package that ships its core wasm. Resolution
// tries the package first (the shipped layout), then falls back to a local
// src/cores/wasm copy (transition / dev). Add a row here as each platform's
// package is carved out; platforms not listed still resolve locally.
const CORE_PACKAGES = {
  atari2600: "@romdev/platform-atari2600",
  nes: "@romdev/core-fceumm",
  gb: "@romdev/core-gambatte",
  gbc: "@romdev/core-gambatte",
  genesis: "@romdev/core-gpgx",
  sms: "@romdev/core-gpgx",
  gg: "@romdev/core-gpgx",
  c64: "@romdev/core-vice",
  lynx: "@romdev/core-handy",
  atari7800: "@romdev/core-prosystem",
  snes: "@romdev/platform-snes",
  gba: "@romdev/platform-gba",
};

/** Try to get {jsPath,wasmPath} for a core from its @romdev package. */
function resolveCoreFromPackage(platform, coreName) {
  const pkg = CORE_PACKAGES[platform];
  if (!pkg) return null;
  try {
    const dir = path.dirname(fileURLToPath(import.meta.resolve(pkg)));
    const jsPath = path.join(dir, "wasm", `${coreName}_libretro.js`);
    const wasmPath = path.join(dir, "wasm", `${coreName}_libretro.wasm`);
    if (existsSync(jsPath) && existsSync(wasmPath)) return { jsPath, wasmPath };
  } catch { /* package not resolvable — fall through to local */ }
  return null;
}

export function resolveCore(platform) {
  const info = CORES[platform];
  if (!info) return null;
  const fromPkg = resolveCoreFromPackage(platform, info.coreName);
  if (fromPkg) return { ...info, ...fromPkg };
  const jsPath = path.join(CORES_DIR, `${info.coreName}_libretro.js`);
  const wasmPath = path.join(CORES_DIR, `${info.coreName}_libretro.wasm`);
  if (!existsSync(jsPath) || !existsSync(wasmPath)) return null;
  return { ...info, jsPath, wasmPath };
}

/** List all platforms whose core is actually bundled and resolvable. */
export function listAvailableCores() {
  return Object.keys(CORES).filter((p) => resolveCore(p) !== null);
}
