// R36 — Game Gear tier-1: 7 scaffolds + PSG sound + dedicated runtime.
//
// GG = sister to SMS (same Z80, same VDP, same SN76489 PSG). genesis_plus_gx
// core handles both. This test confirms every GG scaffold compiles +
// links against the GG runtime + GG PSG wrapper.

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

const GG_TEMPLATES = ["shmup", "platformer", "puzzle", "sports", "racing", "hello_sprite", "tile_engine"];

test("R36 Game Gear tier-1 templates: all compile to valid ROMs", { timeout: 300000 }, async () => {
  const { buildForPlatform } = await import("../src/toolchains/index.js");
  const runtimes = {
    "vdp_init.c":     await readSrc("src/platforms/gg/lib/c/vdp_init.c"),
    "load_palette.c": await readSrc("src/platforms/gg/lib/c/load_palette.c"),
    "load_tiles.c":   await readSrc("src/platforms/gg/lib/c/load_tiles.c"),
    "vblank_wait.c":  await readSrc("src/platforms/gg/lib/c/vblank_wait.c"),
    "joypad_read.c":  await readSrc("src/platforms/gg/lib/c/joypad_read.c"),
    "sprite_table.c": await readSrc("src/platforms/gg/lib/c/sprite_table.c"),
    "gg_sfx.c":       await readSrc("src/platforms/gg/lib/c/gg_sfx.c"),
  };
  const includes = {
    "gg_hw.h":  await readSrc("src/platforms/gg/lib/c/gg_hw.h"),
    "gg_sfx.h": await readSrc("src/platforms/gg/lib/c/gg_sfx.h"),
  };
  for (const t of GG_TEMPLATES) {
    const main = await readSrc(`examples/gg/templates/${t}.c`);
    const r = await buildForPlatform({
      platform: "gg",
      language: "c",
      sources: { "main.c": main, ...runtimes },
      includes,
    });
    assert.equal(r.ok, true, `gg/${t} build failed at ${r.stage}: ${(r.log || "").slice(-300)}`);
    assert.ok(r.binary.length >= 16384, `gg/${t}: ROM too small: ${r.binary.length}`);
  }
});

test("R36 GG sfx wrapper compiles standalone", { timeout: 60000 }, async () => {
  const { buildForPlatform } = await import("../src/toolchains/index.js");
  const sfxC = await readSrc("src/platforms/gg/lib/c/gg_sfx.c");
  const sfxH = await readSrc("src/platforms/gg/lib/c/gg_sfx.h");
  const hw   = await readSrc("src/platforms/gg/lib/c/gg_hw.h");
  const main = `
#include "gg_hw.h"
#include "gg_sfx.h"
void main(void) {
    sfx_init();
    sfx_tone(0, 200, 8);
    sfx_noise(12);
    while (1) sfx_update();
}
`;
  const r = await buildForPlatform({
    platform: "gg",
    language: "c",
    sources: { "main.c": main, "gg_sfx.c": sfxC },
    includes: { "gg_hw.h": hw, "gg_sfx.h": sfxH },
  });
  assert.equal(r.ok, true, `gg_sfx smoke failed at ${r.stage}: ${(r.log || "").slice(-400)}`);
});
