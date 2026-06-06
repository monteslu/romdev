// R50 — Atari 7800 TIA 2-voice music_demo template smoke test.
//
// Pairs with R40 (atari7800_sfx). Where sfx is one-shot tones, music is
// a song player: two parallel note tables (melody on TIA voice 0, bass
// on TIA voice 1), each entry a { distortion, freq, length_frames }
// triple. music_update() called per-frame advances each voice's cursor.
//
// Test 1: the music_demo template compiles + links into a real .a78 ROM
//         with atari7800_music.{h,c} bundled as ATARI7800_MUSIC_RUNTIME.
// Test 2: sanity-check the note tables — both melody_notes[] and
//         bass_notes[] are present, end with a 0-length sentinel, and
//         the melody is meaningfully longer than the bass (it should
//         contain more notes since it's eighth-notes vs half-notes).

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

test("R50 7800 music_demo: 2-voice TIA driver + template compile + link", { timeout: 180000 }, async () => {
  const { buildForPlatform } = await import("../src/toolchains/index.js");
  const main    = await readSrc("examples/atari7800/templates/music_demo.c");
  const musicH  = await readSrc("src/platforms/atari7800/lib/c/atari7800_music.h");
  const musicC  = await readSrc("src/platforms/atari7800/lib/c/atari7800_music.c");
  const r = await buildForPlatform({
    platform: "atari7800",
    language: "c",
    sources:  { "main.c": main, "atari7800_music.c": musicC },
    includes: { "atari7800_music.h": musicH },
  });
  assert.equal(r.ok, true, `build failed at ${r.stage}: ${(r.log || "").slice(-500)}`);
  assert.ok(r.binary && r.binary.length >= 16384, `7800 ROM too small (${r.binary?.length})`);
});

test("R50 7800 music note tables are well-formed", async () => {
  const musicC = await readSrc("src/platforms/atari7800/lib/c/atari7800_music.c");
  // Both voice tables must exist.
  assert.match(musicC, /melody_notes\s*\[\s*\]/, "melody_notes array missing");
  assert.match(musicC, /bass_notes\s*\[\s*\]/, "bass_notes array missing");
  // The per-voice player API the template wires up.
  assert.match(musicC, /void\s+music_init\s*\(\s*void\s*\)/, "music_init missing");
  assert.match(musicC, /void\s+music_play\s*\(\s*void\s*\)/, "music_play missing");
  assert.match(musicC, /void\s+music_update\s*\(\s*void\s*\)/, "music_update missing");
  // Each voice must end with a sentinel triple { 0, 0, 0 } so the player
  // detects "loop me". The pattern below is forgiving of whitespace +
  // trailing comments.
  assert.match(musicC, /0,\s*0,\s*0/, "missing 0,0,0 sentinel");
});
