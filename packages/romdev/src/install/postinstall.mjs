#!/usr/bin/env node
// romdev-mcp postinstall — make sure @kmamal/sdl's prebuilt native binary is
// present so the `playtest` window works out of the box.
//
// WHY: @kmamal/sdl ships its binary (dist/sdl.node) via its OWN `install`
// lifecycle script, NOT in the npm tarball. When romdev-mcp is installed as a
// transitive dependency — most notably under `npx romdev-mcp` — npm skips that
// nested install script, so the binary is never fetched and `playtest` can
// never open a window. romdev-mcp's own postinstall (this file) DOES run under
// npx, so we run @kmamal/sdl's installer ourselves.
//
// IMPORTANT: this must NEVER fail the romdev install. If the download is
// blocked (offline, proxy, CI with --ignore-scripts) we exit 0 and let the
// runtime self-heal in src/playtest/playtest.js handle it on first `playtest`.

import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import path from "node:path";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);

// @kmamal/sdl's `exports` doesn't expose ./package.json, so resolve the main
// entry and walk up to the dir that contains package.json.
function sdlPackageRoot() {
  let entry;
  try {
    entry = require.resolve("@kmamal/sdl");
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

async function main() {
  const pkgDir = sdlPackageRoot();
  if (!pkgDir) {
    // @kmamal/sdl not resolvable from here (odd hoisting / not installed yet) —
    // nothing to do; runtime self-heal will try again.
    return;
  }

  const sdlNode = path.join(pkgDir, "dist", "sdl.node");
  if (existsSync(sdlNode)) return; // already installed (local dev, cached, etc.)

  const installScript = path.join(pkgDir, "scripts", "install.mjs");
  if (!existsSync(installScript)) return; // can't repair

  try {
    // Force prebuilt-only: never let a missing prebuilt fall through to a
    // node-gyp source build, which would invoke clang/Xcode/Command Line Tools
    // on the host — exactly the "why is it compiling?" scare we must avoid.
    // @kmamal/sdl's installer already downloads a prebuilt; this is belt-and-
    // suspenders for anything in the chain that honors these flags.
    await execFileAsync(process.execPath, [installScript], {
      timeout: 120000,
      env: { ...process.env, npm_config_build_from_source: "false", npm_config_build_from_source_all: "false" },
    });
    if (existsSync(sdlNode)) {
      console.log("[romdev-mcp] fetched @kmamal/sdl native binary for playtest.");
    }
  } catch (e) {
    // Soft-fail: the playtest tool self-heals at runtime, and every headless
    // tool works regardless. Don't break the install over an optional window.
    console.warn(
      "[romdev-mcp] note: couldn't pre-fetch the @kmamal/sdl playtest binary " +
      `(${e?.message ?? e}). The interactive playtest window may need a one-time ` +
      `\`node "${installScript}"\` — headless build/run/screenshot are unaffected.`,
    );
  }
}

// Never let this script's failure abort `npm install`.
main().catch(() => {}).finally(() => process.exit(0));
