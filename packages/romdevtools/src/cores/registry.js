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
  gametank: { platform: "gametank", coreName: "gametank", pkg: "romdev-core-gametank", displayName: "GameTank (Clyde Shaffer)", aka: "gtr" },
  // 32-bit MIPS tier. These cores HW-render (GL): the host lazy-loads the OPTIONAL
  // webgl-node bridge only when one of these boots (hwRender:true). The other 14 are
  // software-rendered and never touch GL, so a headless user without the GPU module
  // is unaffected.
  // parallel_n64 renders the RDP on the REAL GPU through glide64 (GL HLE) → native-gles
  // (the host's WebGL2 bridge), same path as Flycast. The host forces the glide64 plugin
  // via a core option. NOT software RDP (angrylion) — that was the old headless build.
  n64: { platform: "n64", coreName: "parallel_n64", pkg: "romdev-core-parallel-n64", displayName: "Nintendo 64 (ParaLLEl N64, glide64 GL)", hwRender: true },
  // beetle_psx_hw = mednafen PSX with the GLES3/WebGL2 HARDWARE renderer → rendered on
  // the real GPU through native-gles (like glide64-N64 + Flycast-DC). Ships with OpenBIOS
  // EMBEDDED (PCSX-Redux, MIT-licensed, region-free) so there's no copyrighted Sony
  // firmware to ship and no BIOS file to supply — the GPU PS1 path with an open BIOS.
  ps1: { platform: "ps1", coreName: "beetle_psx_hw", pkg: "romdev-core-beetle-psx-hw", displayName: "Sony PlayStation (Beetle PSX HW, OpenBIOS)", aka: "psx,playstation", hwRender: true },
  // Flycast = full Dreamcast emulator, GLES3/WebGL2 HW-render (PowerVR2 is GPU-first,
  // no software framebuffer path) → driven through the native-gles/webgl-node bridge
  // like the GL N64 build. HLE BIOS (reios) on by default — no firmware to ship.
  // noderawfs: the flycast WASM is built with -s NODERAWFS=1, so its filesystem IS
  // Node's real fs — libchdr fopens/seeks the disc image off DISK on demand instead
  // of the host loading the whole (up to ~1GB) CHD into the WASM heap (which OOM'd a
  // 1GB max-heap on big discs like Sonic Adventure). The host passes the REAL path
  // and skips the malloc+FS.writeFile for these cores. See LibretroHost.loadMedia.
  dreamcast: { platform: "dreamcast", coreName: "flycast", pkg: "romdev-core-flycast", displayName: "Sega Dreamcast (Flycast)", aka: "dc", hwRender: true, noderawfs: true },
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
