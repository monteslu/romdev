// R49 — C64 music_demo: continuous 3-voice SID composition via a
// per-frame note-table sequencer (c64_music.{h,c}). The note table IS
// the song; we just verify it compiles into a real .prg with enough
// embedded data to be a recognisable melody.

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

test("R49 C64 music_demo: builds a real .prg with the music driver linked in", { timeout: 180000 }, async () => {
  const { buildForPlatform } = await import("../src/toolchains/index.js");
  const regs = await readSrc("src/platforms/c64/lib/c64_registers.h");
  const musicH = await readSrc("src/platforms/c64/lib/c/c64_music.h");
  const musicC = await readSrc("src/platforms/c64/lib/c/c64_music.c");
  const main = await readSrc("examples/c64/templates/music_demo.c");

  const r = await buildForPlatform({
    platform: "c64",
    language: "c",
    sources: { "main.c": main, "c64_music.c": musicC },
    includes: { "c64_registers.h": regs, "c64_music.h": musicH },
  });
  assert.equal(r.ok, true, `c64/music_demo build failed at ${r.stage}: ${(r.log || "").slice(-600)}`);
  assert.ok(r.binary && r.binary.length > 1024,
    `c64/music_demo: .prg too small (${r.binary ? r.binary.length : 0} bytes — expected >1 KB so the note tables made it in)`);
});

test("R49 C64 c64_music driver: smoke-builds standalone with a tiny main", { timeout: 120000 }, async () => {
  const { buildForPlatform } = await import("../src/toolchains/index.js");
  const regs = await readSrc("src/platforms/c64/lib/c64_registers.h");
  const musicH = await readSrc("src/platforms/c64/lib/c/c64_music.h");
  const musicC = await readSrc("src/platforms/c64/lib/c/c64_music.c");
  const main = `
#include "c64_registers.h"
#include "c64_music.h"
int main(void) {
    music_init();
    music_play();
    for (;;) music_update();
}
`;
  const r = await buildForPlatform({
    platform: "c64",
    language: "c",
    sources: { "main.c": main, "c64_music.c": musicC },
    includes: { "c64_registers.h": regs, "c64_music.h": musicH },
  });
  assert.equal(r.ok, true, `c64_music smoke failed at ${r.stage}: ${(r.log || "").slice(-600)}`);
});
