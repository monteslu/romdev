// sdl.js — hardened @kmamal/sdl loader. This is the SDL-init battle armor the
// romdev playtest window earned the hard way, extracted verbatim so every
// consumer (romdev's playtest, the SDK run bridges) shares ONE copy:
//
//   - @kmamal/sdl ships its native binary (`dist/sdl.node`) via an `install`
//     lifecycle script — NOT in the npm tarball. Transitive/npx installs skip
//     that script, so the binary is missing and the import throws.
//   - Worse, Node's ESM loader CACHES a failed dynamic import for the process
//     lifetime — once the first `import("@kmamal/sdl")` rejects, it can never
//     recover, even after the binary appears on disk. So the binary must be
//     verified (and repaired) BEFORE the first import.
//   - With no presentable display SDL silently picks the "offscreen"/"dummy"
//     video driver — createWindow SUCCEEDS but nothing appears on any screen.
//     We ask SDL which driver it actually selected and fail honestly.
//
// On failure throws an Error tagged `.code = "SDL_UNAVAILABLE"` plus
// `.sdlKind` ("missing-binary" | "install-failed" | "sdl-error" |
// "no-display") and, when actionable, `.fixCmd` — callers branch on these
// for an accurate user message instead of a module-load crash.

import path from "node:path";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);

/**
 * Find the on-disk root directory of the @kmamal/sdl package. Its `exports`
 * field doesn't expose `./package.json`, so we resolve the main entry and walk
 * up to the nearest directory containing a package.json.
 * @param {(id: string) => string} [resolve] test hook — defaults to require.resolve
 * @returns {string | null}
 */
export function sdlPackageRoot(resolve = require.resolve) {
  let entry;
  try {
    entry = resolve("@kmamal/sdl");
  } catch {
    return null;
  }
  let dir = path.dirname(entry);
  while (dir !== path.dirname(dir)) {
    if (existsSync(path.join(dir, "package.json"))) return dir;
    dir = path.dirname(dir);
  }
  return null;
}

let _sdlModule = null;

/**
 * Load @kmamal/sdl with the self-repair + honest-failure behavior described in
 * the header. Memoized per process (SDL can only init once anyway).
 *
 * @param {Object} [opts]
 * @param {(msg: string) => void} [opts.log] progress logger (default: silent)
 * @param {(id: string) => string} [opts.resolve] module resolver (test hook)
 * @param {() => Promise<any>} [opts.importSdl] importer (test hook)
 * @returns {Promise<any>} the SDL module namespace
 */
export async function initSdl(opts = {}) {
  if (_sdlModule) return _sdlModule;
  const log = opts.log ?? (() => {});

  // Resolve the package root (works under npx, local install, or a monorepo
  // symlink). Note: @kmamal/sdl's `exports` does NOT expose ./package.json, so
  // resolve the main entry and walk up to the dir that contains package.json.
  let sdlNode = null;
  let installScript = null;
  try {
    const pkgDir = sdlPackageRoot(opts.resolve);
    if (pkgDir) {
      sdlNode = path.join(pkgDir, "dist", "sdl.node");
      installScript = path.join(pkgDir, "scripts", "install.mjs");
    }
  } catch {
    // @kmamal/sdl itself isn't installed at all — nothing we can repair.
  }

  const tag = (err, kind, fixCmd) => {
    err.code = "SDL_UNAVAILABLE";
    err.sdlKind = kind;
    if (fixCmd) err.fixCmd = fixCmd;
    return err;
  };

  // @kmamal/sdl not resolvable AT ALL (not in the dep tree). The optionalDep
  // failed to install, or the consumer excluded it. Fail before importing.
  if (sdlPackageRoot(opts.resolve) == null) {
    throw tag(new Error(
      "@kmamal/sdl is not installed (it is an optional dependency — its install may have been skipped or failed)",
    ), "missing-binary", "npm install @kmamal/sdl");
  }

  // Self-heal: if the prebuilt binary is missing but the install script is
  // present, run it (exactly what the skipped postinstall would have done).
  // This MUST happen before the first import — Node's ESM loader caches a
  // rejected dynamic import for the process lifetime, so a failed first import
  // could never recover even after the binary lands on disk.
  if (sdlNode && !existsSync(sdlNode) && installScript && existsSync(installScript)) {
    log("@kmamal/sdl native binary missing — fetching prebuilt via its install script…");
    try {
      await execFileAsync(process.execPath, [installScript], {
        timeout: 120000,
        // Prebuilt-only — never fall through to a node-gyp/clang source build.
        env: { ...process.env, npm_config_build_from_source: "false", npm_config_build_from_source_all: "false" },
      });
    } catch (e) {
      throw tag(new Error(
        `the @kmamal/sdl native binary isn't installed and the auto-install failed: ${e?.message ?? e}`,
      ), "install-failed", `node "${installScript}"`);
    }
  }

  // Still missing after the heal attempt → fail with the exact fix, BEFORE the
  // import (so we never cache a rejection).
  if (sdlNode && !existsSync(sdlNode)) {
    throw tag(new Error(
      `the @kmamal/sdl native binary isn't installed (expected at ${sdlNode})`,
    ), "missing-binary", installScript ? `node "${installScript}"` : undefined);
  }

  // Force nearest-neighbor scaling globally. SDL2 reads this env var at init;
  // per-render scaling:"nearest" is also passed, but this is belt-and-
  // suspenders so a pixel-art ROM is NEVER blurred by bilinear filtering on any
  // path. 0 = nearest. MUST be set before SDL inits, i.e. before the import.
  if (!process.env.SDL_RENDER_SCALE_QUALITY) {
    process.env.SDL_RENDER_SCALE_QUALITY = "0";
  }

  // Deliver controller input even when the window is unfocused. SDL2 drops
  // controller button PRESSES while the app lacks input focus (releases pass,
  // so no stuck buttons) unless this hint is on, and @kmamal/sdl never sets
  // it. Playtest workflow constantly has the terminal focused while the pad
  // drives the game window. Keyboard stays focus-gated by design (routes to
  // the focused window; no hint governs it). MUST be set before SDL inits,
  // i.e. before the import. Respect an explicit user override (e.g. =0).
  if (!process.env.SDL_JOYSTICK_ALLOW_BACKGROUND_EVENTS) {
    process.env.SDL_JOYSTICK_ALLOW_BACKGROUND_EVENTS = "1";
  }

  try {
    const ns = opts.importSdl ? await opts.importSdl() : await import("@kmamal/sdl");
    const mod = ns.default || ns;
    // GROUND-TRUTH visibility check (cross-platform, NOT env-var guessing):
    // SDL picks a video driver at init. With no presentable surface (no desktop
    // session, no Xvfb, headless box) it falls back to "offscreen"/"dummy" —
    // createWindow then SUCCEEDS and audio plays, but nothing appears on any
    // physical screen. We catch it HERE by asking SDL which driver it actually
    // selected — works the same on Linux/macOS/Windows, and correctly ALLOWS a
    // real offscreen X server (Xvfb reports "x11", not "offscreen").
    const driver = mod?.info?.drivers?.video?.current;
    if (driver === "offscreen" || driver === "dummy") {
      throw tag(new Error(
        `SDL selected the "${driver}" video driver — there is no presentable display, ` +
        "so a window would render but never appear on a physical screen (you'd hear " +
        "audio but see nothing). Run where a real desktop session (or Xvfb) exists.",
      ), "no-display");
    }
    _sdlModule = mod;
    return _sdlModule;
  } catch (e) {
    if (e?.sdlKind) throw e; // already-tagged (e.g. the offscreen check above)
    const isModuleErr = e?.code === "ERR_MODULE_NOT_FOUND" ||
      /sdl\.node|dist[\\/]/.test(e?.message || "");
    throw tag(new Error(e?.message ?? String(e)),
      isModuleErr ? "missing-binary" : "sdl-error",
      isModuleErr && installScript ? `node "${installScript}"` : undefined);
  }
}

/** Test-only: clear the memoized SDL module. */
export function _resetSdlForTest() {
  _sdlModule = null;
}
