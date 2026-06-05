// romdev_game_codes — the bundled game-code/cheat database for romdev, as its
// own package.
//
// Why a separate package: the pre-parsed cheat index is ~29MB of JSON. Keeping
// it out of romdev-mcp keeps that package small and lets the DB grow/version on
// its own cadence (more games, more platforms) without churning the main
// package. romdev-mcp depends on this package and resolves it at runtime via
// `import.meta.resolve("romdev_game_codes")`, then lazy-loads ONE platform's JSON
// on demand — never the whole DB into memory.
//
// Coverage: one `index/<platform>.json` per supported platform that the
// RetroArch/RetroDECK community cheats tree actually carries. Source data is the
// libretro-database cheats lineage (Game Genie code books / GameHacking.org),
// pre-parsed into a compact name→entries map by
// romdev/scripts/build-cheat-index.mjs.

import { fileURLToPath } from "node:url";
import path from "node:path";
import { existsSync, readdirSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Absolute path to the directory of per-platform index JSON files. */
export const indexDir = path.join(__dirname, "index");

/** Absolute path to a single platform's index JSON (may not exist). */
export function indexPath(platform) {
  return path.join(indexDir, `${platform}.json`);
}

/** True if this package carries a cheat index for the given platform id. */
export function hasPlatform(platform) {
  return existsSync(indexPath(platform));
}

/** Platform ids that have a bundled index (sync, reads the dir once). */
export function listPlatforms() {
  try {
    return readdirSync(indexDir).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).sort();
  } catch {
    return [];
  }
}

/**
 * Lazy-load and parse ONE platform's cheat index. Returns the parsed object
 * ({ platform, source, gameCount, games }) or null if not bundled / unreadable.
 * Caching is the caller's job (romdev's lookup.js caches per platform).
 * @param {string} platform
 * @returns {Promise<object|null>}
 */
export async function loadPlatformIndex(platform) {
  const p = indexPath(platform);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(await readFile(p, "utf8"));
  } catch {
    return null;
  }
}

/** Async platform list (mirrors listPlatforms without the sync require). */
export async function listPlatformsAsync() {
  try {
    const files = await readdir(indexDir);
    return files.filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).sort();
  } catch {
    return [];
  }
}
