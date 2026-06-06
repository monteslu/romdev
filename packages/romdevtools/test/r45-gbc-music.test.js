// R45 — GBC music_demo: hUGEDriver + sample song builds for the GBC tree.
//
// The GBC scaffold tree (R37) is independent of the GB tree, so we
// verify the music_demo wires up correctly through GBC's own runtime
// files. The driver source is identical (APU is the same DMG/CGB).
//
// In addition to the build smoke, we assert the main writes BCPS —
// that's the R37 "real CGB scaffold" marker.

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

test("R45 GBC music_demo: hUGEDriver compiles + GBC ROM builds with BCPS", { timeout: 300000 }, async () => {
  const { buildForPlatform } = await import("../src/toolchains/index.js");

  const main      = await readSrc("examples/gbc/templates/music_demo.c");
  const runtimeC  = await readSrc("src/platforms/gbc/lib/c/gb_runtime.c");
  const driverC   = await readSrc("src/platforms/gbc/lib/c/hUGEDriver.c");
  const songC     = await readSrc("src/platforms/gbc/lib/c/song_data.c");

  const runtimeH  = await readSrc("src/platforms/gbc/lib/c/gb_runtime.h");
  const hwH       = await readSrc("src/platforms/gbc/lib/c/gb_hardware.h");
  const driverH   = await readSrc("src/platforms/gbc/lib/c/hUGEDriver.h");
  const crt0      = await readSrc("src/platforms/gbc/lib/c/gb_crt0.s");

  // GBC scaffolds MUST visibly use BCPS so they're not just DMG ROMs with .gbc extension.
  assert.match(main, /BCPS/, "gbc music_demo: should write BCPS (CGB BG palette)");
  assert.match(main, /hUGE_init\s*\(/,      "music_demo must initialise the driver");
  assert.match(main, /hUGE_dosound\s*\(\)/, "music_demo must call hUGE_dosound() each frame");

  const r = await buildForPlatform({
    platform: "gbc",
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
  assert.equal(r.ok, true, `gbc music_demo build failed at ${r.stage}: ${(r.log || "").slice(-500)}`);
  assert.ok(r.binary, "gbc music_demo: no binary produced");
  assert.ok(r.binary.length >= 16384, `gbc music_demo: ROM too small (${r.binary.length} bytes)`);
});
