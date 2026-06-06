// R48 — Game Gear music driver + music_demo template.
//
// gg_music.{h,c} is a per-frame PSG music engine sitting on PSG channel 2
// (leaves 0/1 free for gg_sfx tones and 3 for noise). Three hand-authored
// songs ship in the note table. music_demo.c wires it to the full GG
// runtime so the player can switch songs from the d-pad.
//
// Smoke-tests verify that:
//   1. gg_music compiles cleanly against gg_hw.h on its own.
//   2. music_demo.c builds end-to-end with the full GG runtime + gg_sfx
//      + gg_music + sprite table + vdp_init.
//   3. The note table is source-visible and well-formed.

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

test("R48 GG music driver: gg_music.c compiles on its own", { timeout: 180000 }, async () => {
  const { buildForPlatform } = await import("../src/toolchains/index.js");
  const hw      = await readSrc("src/platforms/gg/lib/c/gg_hw.h");
  const musicH  = await readSrc("src/platforms/gg/lib/c/gg_music.h");
  const musicC  = await readSrc("src/platforms/gg/lib/c/gg_music.c");
  const main = `
#include "gg_hw.h"
#include "gg_music.h"
void main(void) {
    music_init();
    music_play(0);
    while (1) { music_update(); }
}
`;
  const r = await buildForPlatform({
    platform: "gg",
    language: "c",
    sources: { "main.c": main, "gg_music.c": musicC },
    includes: { "gg_hw.h": hw, "gg_music.h": musicH },
  });
  assert.equal(r.ok, true, `gg_music build failed at ${r.stage}: ${(r.log || "").slice(-500)}`);
  assert.ok(r.binary && r.binary.length >= 16384, `gg_music: ROM too small (${r.binary?.length} bytes)`);
});

test("R48 GG music_demo template builds with full runtime", { timeout: 240000 }, async () => {
  const { buildForPlatform } = await import("../src/toolchains/index.js");
  const hw         = await readSrc("src/platforms/gg/lib/c/gg_hw.h");
  const sfxH       = await readSrc("src/platforms/gg/lib/c/gg_sfx.h");
  const sfxC       = await readSrc("src/platforms/gg/lib/c/gg_sfx.c");
  const musicH     = await readSrc("src/platforms/gg/lib/c/gg_music.h");
  const musicC     = await readSrc("src/platforms/gg/lib/c/gg_music.c");
  const vdpInit    = await readSrc("src/platforms/gg/lib/c/vdp_init.c");
  const loadPal    = await readSrc("src/platforms/gg/lib/c/load_palette.c");
  const loadTiles  = await readSrc("src/platforms/gg/lib/c/load_tiles.c");
  const vblank     = await readSrc("src/platforms/gg/lib/c/vblank_wait.c");
  const joypad     = await readSrc("src/platforms/gg/lib/c/joypad_read.c");
  const sprites    = await readSrc("src/platforms/gg/lib/c/sprite_table.c");
  const main       = await readSrc("examples/gg/templates/music_demo.c");

  const r = await buildForPlatform({
    platform: "gg",
    language: "c",
    sources: {
      "main.c":         main,
      "gg_sfx.c":       sfxC,
      "gg_music.c":     musicC,
      "vdp_init.c":     vdpInit,
      "load_palette.c": loadPal,
      "load_tiles.c":   loadTiles,
      "vblank_wait.c":  vblank,
      "joypad_read.c":  joypad,
      "sprite_table.c": sprites,
    },
    includes: {
      "gg_hw.h":    hw,
      "gg_sfx.h":   sfxH,
      "gg_music.h": musicH,
    },
  });
  assert.equal(r.ok, true, `music_demo build failed at ${r.stage}: ${(r.log || "").slice(-500)}`);
  assert.ok(r.binary && r.binary.length >= 16384, `music_demo: ROM too small (${r.binary?.length} bytes)`);
});

test("R48 GG music note table is source-visible and well-formed", async () => {
  const musicC = await readSrc("src/platforms/gg/lib/c/gg_music.c");
  const musicH = await readSrc("src/platforms/gg/lib/c/gg_music.h");

  // At least one song array declared in the .c.
  assert.match(musicC, /const\s+music_note_t\s+song0\s*\[\s*\]/, "song0 array missing");
  // End sentinel present.
  assert.match(musicC, /\{\s*0\s*,\s*0\s*\}/, "missing {0,0} end sentinel");
  // music_song_count matches the bundled song count of 3.
  assert.match(musicC, /music_song_count\s*=\s*3/, "music_song_count != 3");

  // Header exposes the standard API + note macros.
  for (const sym of ["music_init", "music_play", "music_stop", "music_update", "NOTE_C4", "NOTE_REST"]) {
    assert.ok(musicH.includes(sym), `gg_music.h missing ${sym}`);
  }
});

test("R48 GG music_demo template is registered in TEMPLATES.gg", async () => {
  const projectJs = await readSrc("src/mcp/tools/project.js");
  assert.match(projectJs, /music_demo:\s*\{/, "music_demo not registered");
  assert.match(projectJs, /gg_music\.h/, "gg_music.h not in GG_RUNTIME");
  assert.match(projectJs, /gg_music\.c/, "gg_music.c not in GG_RUNTIME");
});
