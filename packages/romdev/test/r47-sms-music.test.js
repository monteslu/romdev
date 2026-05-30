// R47 — SMS music_demo template: 3-voice continuous PSG melody.
//
// sms_music.{h,c} is a tiny hand-rolled tracker on top of the SN76489
// PSG (port $7F). Voice 0 = melody, voice 1 = harmony, voice 2 = bass,
// driven by parallel per-voice (freq, length_frames) arrays. The
// scaffold music_demo.c calls music_init() + music_play(0) once at
// boot and music_update() once per vblank — same shape every other
// platform's music demo uses.

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

test("R47 SMS music_demo: tracker + scaffold compile + link", { timeout: 180000 }, async () => {
  const { buildForPlatform } = await import("../src/toolchains/index.js");
  const main      = await readSrc("examples/sms/templates/music_demo.c");
  const musicC    = await readSrc("src/platforms/sms/lib/c/sms_music.c");
  const musicH    = await readSrc("src/platforms/sms/lib/c/sms_music.h");
  const hw        = await readSrc("src/platforms/sms/lib/c/sms_hw.h");
  const vdpInit   = await readSrc("src/platforms/sms/lib/c/vdp_init.c");
  const loadPal   = await readSrc("src/platforms/sms/lib/c/load_palette.c");
  const loadTiles = await readSrc("src/platforms/sms/lib/c/load_tiles.c");
  const vblank    = await readSrc("src/platforms/sms/lib/c/vblank_wait.c");

  const r = await buildForPlatform({
    platform: "sms",
    language: "c",
    sources: {
      "main.c":         main,
      "sms_music.c":    musicC,
      "vdp_init.c":     vdpInit,
      "load_palette.c": loadPal,
      "load_tiles.c":   loadTiles,
      "vblank_wait.c":  vblank,
    },
    includes: {
      "sms_hw.h":    hw,
      "sms_music.h": musicH,
    },
  });
  assert.equal(r.ok, true, `sms music_demo build failed at ${r.stage}: ${(r.log || "").slice(-500)}`);
  assert.ok(r.binary && r.binary.length >= 16384, `sms music_demo: ROM too small (${r.binary && r.binary.length} bytes)`);
});

test("R47 sms_music.c song data is well-formed", async () => {
  const musicC = await readSrc("src/platforms/sms/lib/c/sms_music.c");
  // The "source IS the song" promise: per-voice freq + length tables visible.
  assert.match(musicC, /mel0_freq\s*\[/,  "voice 0 freq array missing");
  assert.match(musicC, /mel1_freq\s*\[/,  "voice 1 freq array missing");
  assert.match(musicC, /mel2_freq\s*\[/,  "voice 2 freq array missing");
  assert.match(musicC, /mel0_len\s*\[/,   "voice 0 length array missing");
  assert.match(musicC, /music_init\b/,    "music_init definition missing");
  assert.match(musicC, /music_play\b/,    "music_play definition missing");
  assert.match(musicC, /music_update\b/,  "music_update definition missing");
});

test("R47 music_demo.c wires the music driver into a vblank loop", async () => {
  const main = await readSrc("examples/sms/templates/music_demo.c");
  assert.match(main, /music_init\s*\(/,   "music_init call missing");
  assert.match(main, /music_play\s*\(/,   "music_play call missing");
  assert.match(main, /music_update\s*\(/, "music_update call missing");
  assert.match(main, /sms_vblank_wait/,   "vblank wait missing");
});

test("R47 SMS_RUNTIME registers sms_music files + TEMPLATES.sms.music_demo exists", async () => {
  const proj = await readSrc("src/mcp/tools/project.js");
  assert.match(proj, /sms_music\.h/,  "sms_music.h not in SMS_RUNTIME");
  assert.match(proj, /sms_music\.c/,  "sms_music.c not in SMS_RUNTIME");
  assert.match(proj, /music_demo:\s*\{[\s\S]*?templates\/music_demo\.c/,
    "TEMPLATES.sms.music_demo template not registered");
});
