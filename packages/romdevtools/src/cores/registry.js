// Core registry. Maps platform IDs to their libretro WASM core.
//
// The shipped core wasm lives in the per-platform binary packages
// (romdev-core-* / romdev-platform-*) — NOT in this package. `resolveCore`
// resolves each platform from the `pkg` named in its CORES entry. The local
// `src/cores/wasm/` dir is a gitignored BUILD-STAGING area: `scripts/build-*.sh`
// emit there, and it serves as a dev fallback when you're working in-tree
// without the satellite packages built. It is empty in a fresh clone and does
// NOT ship in the npm tarball.

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Build-staging dir for `.js` + `.wasm` core pairs (gitignored; dev fallback
 *  only — the shipped wasm resolves from the satellite packages). */
export const CORES_DIR = path.resolve(__dirname, "wasm");

/**
 * @typedef {Object} CoreInfo
 * @property {string} platform     short platform id ("nes", "gb", ...)
 * @property {string} coreName     filename stem (matches `<coreName>_libretro.js`)
 * @property {string} pkg          binary package that SHIPS this core's wasm.
 *   `romdev-core-*` = a standalone core (often shared: gpgx serves genesis/sms/
 *   gg, gambatte serves gb/gbc). `romdev-platform-*` = a core bundled WITH the
 *   dedicated toolchain nothing else uses (snes9x+asar+wla, mGBA+arm-gcc,
 *   stella+dasm) — they ship together because only that platform needs them.
 * @property {string} displayName
 * @property {string} [aka]        comma-separated synonyms accepted in resolvers
 */

/**
 * The single source of truth for every platform's core: its filename stem, the
 * package that ships it, and display metadata — all in one record so there's no
 * second map to keep in sync.
 * @type {Record<string, CoreInfo>}
 */
export const CORES = {
  nes: { platform: "nes", coreName: "fceumm", pkg: "romdev-core-fceumm", displayName: "Nintendo Entertainment System (fceumm)" },
  gb: { platform: "gb", coreName: "gambatte", pkg: "romdev-core-gambatte", displayName: "Game Boy / GBC (gambatte)" },
  gbc: { platform: "gbc", coreName: "gambatte", pkg: "romdev-core-gambatte", displayName: "Game Boy / GBC (gambatte)" },
  atari2600: { platform: "atari2600", coreName: "stella2014", pkg: "romdev-platform-atari2600", displayName: "Atari 2600 (Stella)" },
  atari7800: { platform: "atari7800", coreName: "prosystem", pkg: "romdev-core-prosystem", displayName: "Atari 7800 (ProSystem)" },
  lynx: { platform: "lynx", coreName: "handy", pkg: "romdev-core-handy", displayName: "Atari Lynx (Handy)" },
  sms: { platform: "sms", coreName: "genesis_plus_gx", pkg: "romdev-core-gpgx", displayName: "Sega Master System (Genesis Plus GX)" },
  gg: { platform: "gg", coreName: "genesis_plus_gx", pkg: "romdev-core-gpgx", displayName: "Sega Game Gear (Genesis Plus GX)" },
  genesis: { platform: "genesis", coreName: "genesis_plus_gx", pkg: "romdev-core-gpgx", displayName: "Sega Genesis / Mega Drive (Genesis Plus GX)" },
  snes: { platform: "snes", coreName: "snes9x", pkg: "romdev-platform-snes", displayName: "SNES (snes9x)" },
  gba: { platform: "gba", coreName: "mgba", pkg: "romdev-platform-gba", displayName: "Game Boy Advance (mGBA)" },
  c64: { platform: "c64", coreName: "vice_x64", pkg: "romdev-core-vice", displayName: "Commodore 64 (VICE x64)" },
  pce: { platform: "pce", coreName: "geargrafx", pkg: "romdev-core-geargrafx", displayName: "PC Engine / TurboGrafx-16 (Geargrafx)", aka: "turbografx,tg16,pcengine" },
  msx: { platform: "msx", coreName: "bluemsx", pkg: "romdev-core-bluemsx", displayName: "MSX / MSX2 (blueMSX)", aka: "msx2" },
};

/** Try to get {jsPath,wasmPath} for a core from its binary package. */
function resolveCoreFromPackage(pkg, coreName) {
  if (!pkg) return null;
  try {
    const dir = path.dirname(fileURLToPath(import.meta.resolve(pkg)));
    const jsPath = path.join(dir, "wasm", `${coreName}_libretro.js`);
    const wasmPath = path.join(dir, "wasm", `${coreName}_libretro.wasm`);
    if (existsSync(jsPath) && existsSync(wasmPath)) return { jsPath, wasmPath };
  } catch { /* package not resolvable — fall through to the dev-staging dir */ }
  return null;
}

/**
 * Resolve a platform id to absolute paths for its core. Tries the binary
 * package first (the shipped layout), then the gitignored `src/cores/wasm/`
 * build-staging dir (in-tree dev fallback). Returns null if neither has it.
 * @param {string} platform
 * @returns {{ platform: string, coreName: string, pkg: string, displayName: string, jsPath: string, wasmPath: string } | null}
 */
export function resolveCore(platform) {
  const info = CORES[platform];
  if (!info) return null;
  const fromPkg = resolveCoreFromPackage(info.pkg, info.coreName);
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
