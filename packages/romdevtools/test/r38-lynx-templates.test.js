// R38 — Atari Lynx tier-1: 7 templates + MIKEY sfx wrapper.

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

const LYNX_TEMPLATES = ["default", "hello_sprite", "shmup", "platformer", "puzzle", "sports", "racing"];

test("R38 Lynx tier-1: all templates compile to valid .lnx ROMs", { timeout: 300000 }, async () => {
  const { buildForPlatform } = await import("../src/toolchains/index.js");
  const sfxC = await readSrc("src/platforms/lynx/lib/c/lynx_sfx.c");
  const sfxH = await readSrc("src/platforms/lynx/lib/c/lynx_sfx.h");
  for (const t of LYNX_TEMPLATES) {
    const main = await readSrc(`examples/lynx/templates/${t}.c`);
    const r = await buildForPlatform({
      platform: "lynx",
      language: "c",
      sources: { "main.c": main, "lynx_sfx.c": sfxC },
      includes: { "lynx_sfx.h": sfxH },
    });
    assert.equal(r.ok, true, `lynx/${t} build failed at ${r.stage}: ${(r.log || "").slice(-400)}`);
    assert.ok(r.binary.length >= 1024, `lynx/${t}: ROM too small`);
  }
});

test("R38 Lynx sfx wrapper compiles standalone", { timeout: 120000 }, async () => {
  const { buildForPlatform } = await import("../src/toolchains/index.js");
  const sfxC = await readSrc("src/platforms/lynx/lib/c/lynx_sfx.c");
  const sfxH = await readSrc("src/platforms/lynx/lib/c/lynx_sfx.h");
  const main = `
#include "lynx_sfx.h"
void main(void) {
    sfx_init();
    sfx_tone(0, 80, 8);
    sfx_noise(20);
    for (;;) sfx_update();
}
`;
  const r = await buildForPlatform({
    platform: "lynx",
    language: "c",
    sources: { "main.c": main, "lynx_sfx.c": sfxC },
    includes: { "lynx_sfx.h": sfxH },
  });
  assert.equal(r.ok, true, `lynx_sfx smoke failed at ${r.stage}: ${(r.log || "").slice(-400)}`);
});
