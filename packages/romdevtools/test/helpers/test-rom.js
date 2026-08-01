// test-rom.js — locate the gitignored NES test ROM, or say why it is absent.
//
// A handful of tests drive a REAL commercial NES ROM (nestest.nes) because
// nothing else exercises the same paths: documented per-instruction CPU
// behaviour, real bank layout, a genuine iNES header. That ROM is commercial
// content, so it is gitignored and ships in no npm tarball — it exists only on
// a dev box that put it there.
//
// That makes it the one fixture a clean checkout cannot obtain, which matters
// for CI: without a guard those tests fail with an opaque `loaded: undefined`
// that reads exactly like a broken core. `requireTestRom()` turns that into an
// explicit skip with a reason, so a CI run is honestly green on the 240+ files
// it CAN run and states which it could not.
//
//   import { requireTestRom } from "./helpers/test-rom.js";
//   const ROM = requireTestRom(import.meta.url);
//   test("...", { skip: ROM.skip }, async () => { ... ROM.path ... });

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * @param {string} importMetaUrl the calling test's import.meta.url
 * @param {string} [name] rom filename under test/roms/
 * @returns {{path: string, skip: false|string}} `skip` is a reason string when
 *   the ROM is absent — pass it straight to node:test's `skip` option.
 */
export function requireTestRom(importMetaUrl, name = "nestest.nes") {
  // Resolved against the CALLER's url (tests live in test/), so `./roms/…`,
  // not `../roms/…` — the helper's own directory is irrelevant here.
  const path = fileURLToPath(new URL(`./roms/${name}`, importMetaUrl));
  if (existsSync(path)) return { path, skip: false };
  return {
    path,
    skip: `test/roms/${name} not present (commercial ROM: gitignored, not in any npm tarball, so a clean checkout cannot have it)`,
  };
}
