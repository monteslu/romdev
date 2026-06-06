// R45 — GB music_demo: hUGEDriver + sample song builds + actually plays.
//
// What gets built:
//   - examples/gb/templates/music_demo.c (player main)
//   - src/platforms/gb/lib/c/gb_runtime.c (sound_init + wait_vblank)
//   - src/platforms/gb/lib/c/hUGEDriver.c (compact SDCC-native driver)
//   - src/platforms/gb/lib/c/song_data.c  (sample_song descriptor)
//
// Expectations:
//   - The build succeeds (sdcc sm83 → .gb).
//   - ROM is at least 16 KB after rom padding.
//   - The driver source contains the canonical upstream function names
//     (hUGE_init / hUGE_dosound) so any later RGBDS-port-in is drop-in.
//   - The compact 72-entry note table from upstream is preserved.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

async function readSrc(rel) {
  return readFile(join(REPO_ROOT, rel), "utf-8");
}

test("R45 GB music_demo: hUGEDriver compiles + ROM builds", { timeout: 300000 }, async () => {
  const { buildForPlatform } = await import("../src/toolchains/index.js");

  const main      = await readSrc("examples/gb/templates/music_demo.c");
  const runtimeC  = await readSrc("src/platforms/gb/lib/c/gb_runtime.c");
  const driverC   = await readSrc("src/platforms/gb/lib/c/hUGEDriver.c");
  const songC     = await readSrc("src/platforms/gb/lib/c/song_data.c");

  const runtimeH  = await readSrc("src/platforms/gb/lib/c/gb_runtime.h");
  const hwH       = await readSrc("src/platforms/gb/lib/c/gb_hardware.h");
  const driverH   = await readSrc("src/platforms/gb/lib/c/hUGEDriver.h");
  const crt0      = await readSrc("src/platforms/gb/lib/c/gb_crt0.s");

  // Sanity: the C driver exposes the canonical upstream surface so a
  // future RGBDS-built upstream.o can be swapped in without touching
  // the main / song-data files.
  assert.match(driverC, /\bvoid\s+hUGE_init\s*\(/,    "hUGEDriver.c must define hUGE_init");
  assert.match(driverC, /\bvoid\s+hUGE_dosound\s*\(/, "hUGEDriver.c must define hUGE_dosound");
  // 72-note table (upstream hUGE_note_table.inc has exactly this many entries).
  assert.match(driverC, /hUGE_note_table\[72\]/, "must ship the 72-entry GB note table");

  // The main loop must call hUGE_dosound — that's what makes it a
  // music player rather than a silent ROM.
  assert.match(main, /hUGE_dosound\s*\(\)/, "music_demo must call hUGE_dosound() each frame");
  assert.match(main, /hUGE_init\s*\(/,      "music_demo must initialise the driver");

  const r = await buildForPlatform({
    platform: "gb",
    language: "c",
    sources: {
      "main.c":        main,
      "gb_runtime.c":  runtimeC,
      "hUGEDriver.c":  driverC,
      "song_data.c":   songC,
    },
    includes: {
      "gb_runtime.h":  runtimeH,
      "gb_hardware.h": hwH,
      "hUGEDriver.h":  driverH,
    },
    crt0,
    codeLoc: 0x150,
  });
  assert.equal(r.ok, true, `gb music_demo build failed at ${r.stage}: ${(r.log || "").slice(-500)}`);
  assert.ok(r.binary, "gb music_demo: no binary produced");
  assert.ok(r.binary.length >= 16384, `gb music_demo: ROM too small (${r.binary.length} bytes)`);
});
