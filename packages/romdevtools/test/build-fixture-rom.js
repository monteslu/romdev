// build-fixture-rom.js — build a real, bootable ROM from our OWN example
// sources for tests that just need *a* valid ROM of a given platform (load,
// step, screenshot, read memory, savestate, watchpoints). This replaces
// depending on an external test ROM on disk: the tests now run unconditionally
// and reference no ROM file we don't generate ourselves.
//
// For tests that genuinely need a SPECIFIC commercial ROM's behavior (battery
// SRAM quirks, a particular mapper), use rom-fixtures.js (user-supplied,
// env-gated) instead — those legitimately skip when absent.
import { readFile, writeFile, mkdtemp } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { buildForPlatform } from "../src/toolchains/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXAMPLES = path.join(__dirname, "..", "examples");

// Cache built ROMs per platform across tests in a run (building is ~hundreds of
// ms; we don't want to pay it once per test).
const cache = new Map();

const EXAMPLE_SOURCE = {
  nes: { dir: "nes", file: "main.c", language: "c", ext: "nes" },
  c64: { dir: "c64", file: "main.c", language: "c", ext: "prg" },
  atari7800: { dir: "atari7800", file: "main.c", language: "c", ext: "a78" },
  lynx: { dir: "lynx", file: "main.c", language: "c", ext: "lnx" },
};

/**
 * Build the example ROM for `key` (a platform id, or a `<platform>-<variant>`
 * key from EXAMPLE_SOURCE), write it to a temp file, return its absolute path.
 * Cached per key per process.
 * @param {string} key
 * @returns {Promise<string>} absolute path to the built ROM
 */
export async function buildExampleRom(key) {
  if (cache.has(key)) return cache.get(key);
  const spec = EXAMPLE_SOURCE[key];
  if (!spec) throw new Error(`buildExampleRom: no example mapping for '${key}'`);
  const platform = key.split("-")[0];
  const source = await readFile(path.join(EXAMPLES, spec.dir, spec.file), "utf8");
  const built = await buildForPlatform({
    platform, source, sourceName: spec.file, language: spec.language,
  });
  if (!built.binary) {
    throw new Error(`buildExampleRom: '${key}' example failed to build`);
  }
  const dir = await mkdtemp(path.join(os.tmpdir(), `romdev-fixture-${key}-`));
  const romPath = path.join(dir, `example.${spec.ext}`);
  await writeFile(romPath, built.binary);
  cache.set(key, romPath);
  return romPath;
}
