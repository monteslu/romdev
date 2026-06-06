// Resolve a `linkerConfig` argument. If it looks like a known preset name
// (no newlines, matches a shipped file under presets/<platform>/), load
// the .cfg AND any companion support sources (e.g. a custom crt0).
// Otherwise treat the argument as the literal ld65 config contents.
//
// Presets layout: src/toolchains/cc65/presets/<platform>/
//   <preset>.cfg         — the ld65 config
//   <preset>.crt0.s      — optional custom crt0 spliced into sources
//   <preset>.*.s         — additional support sources

import path from "node:path";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PRESETS_DIR = path.resolve(__dirname, "presets");

/**
 * @param {string} platform
 * @param {string | undefined} arg
 * @returns {Promise<{ cfg: string | undefined, supportSources: Record<string, string> }>}
 */
export async function resolveLinkerConfig(platform, arg) {
  if (!arg) return { cfg: undefined, supportSources: {} };
  if (arg.includes("\n") || arg.length > 200) {
    return { cfg: arg, supportSources: {} };
  }
  const preset = arg.trim();
  if (!/^[a-z][a-z0-9-]*$/i.test(preset)) {
    return { cfg: arg, supportSources: {} };
  }
  const presetDir = path.join(PRESETS_DIR, platform);
  let cfg;
  try {
    cfg = await readFile(path.join(presetDir, `${preset}.cfg`), "utf-8");
  } catch {
    throw new Error(
      `linkerConfig: unknown preset '${preset}' for platform '${platform}'. ` +
      `Pass either a known preset name (e.g. 'chr-ram' for NES) or the full .cfg contents.`
    );
  }
  const supportSources = {};
  try {
    const entries = await readdir(presetDir);
    const prefix = `${preset}.`;
    for (const f of entries) {
      if (!f.startsWith(prefix) || f === `${preset}.cfg`) continue;
      const ext = path.extname(f).toLowerCase();
      if (ext === ".s" || ext === ".asm") {
        const contents = await readFile(path.join(presetDir, f), "utf-8");
        const suffix = f.slice(prefix.length);
        supportSources[`_preset_${suffix}`] = contents;
      }
    }
  } catch {
    // No support files.
  }
  return { cfg, supportSources };
}
