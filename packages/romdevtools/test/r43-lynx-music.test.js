// R43 — Atari Lynx music_demo template: cc65's lynx_snd_play streaming
// music engine wired to a hand-authored bytestream in lynx_music.c.

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

test("R43 Lynx music_demo: hand-authored bytestream compiles via lynx_snd_play", { timeout: 180000 }, async () => {
  const { buildForPlatform } = await import("../src/toolchains/index.js");
  const main = await readSrc("examples/lynx/templates/music_demo.c");
  const musicC = await readSrc("src/platforms/lynx/lib/c/lynx_music.c");
  const musicH = await readSrc("src/platforms/lynx/lib/c/lynx_music.h");
  const r = await buildForPlatform({
    platform: "lynx",
    language: "c",
    sources: { "main.c": main, "lynx_music.c": musicC },
    includes: { "lynx_music.h": musicH },
  });
  assert.equal(r.ok, true, `lynx music_demo build failed at ${r.stage}: ${(r.log || "").slice(-400)}`);
  assert.ok(r.binary.length >= 1024, `lynx music_demo: ROM too small (${r.binary.length} bytes)`);
});

test("R43 Lynx music bytestream is well-formed", async () => {
  const musicC = await readSrc("src/platforms/lynx/lib/c/lynx_music.c");
  // Sanity: demo_music array declared, ends with the SndStop (0) sentinel.
  // NOTE: deliberately NOT requiring `const` — cc65's lynx_snd_play takes a
  // writable pointer, so demo_music must be non-const (the bytes still land
  // in ROM; the driver only reads). See lynx_music.c's declaration comment.
  assert.match(musicC, /unsigned\s+char\s+demo_music\s*\[\s*\]/, "demo_music array missing");
  assert.match(musicC, /\b0\s*\/\*\s*SndStop/i, "missing SndStop sentinel comment");
});
