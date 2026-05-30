// R39 — C64 tier-1: 5 genre scaffolds (shmup/platformer/puzzle/sports/racing)
// + SID sfx wrapper.

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

const C64_TEMPLATES = ["hello_sprite", "tile_engine", "shmup", "platformer", "puzzle", "sports", "racing"];

test("R39 C64 tier-1: all templates compile to valid .prg ROMs", { timeout: 300000 }, async () => {
  const { buildForPlatform } = await import("../src/toolchains/index.js");
  const regs = await readSrc("src/platforms/c64/lib/c64_registers.h");
  const sfxC = await readSrc("src/platforms/c64/lib/c/c64_sfx.c");
  const sfxH = await readSrc("src/platforms/c64/lib/c/c64_sfx.h");
  for (const t of C64_TEMPLATES) {
    const main = await readSrc(`examples/c64/templates/${t}.c`);
    const needsSfx = main.includes("c64_sfx.h");
    const sources = needsSfx
      ? { "main.c": main, "c64_sfx.c": sfxC }
      : { "main.c": main };
    const includes = needsSfx
      ? { "c64_registers.h": regs, "c64_sfx.h": sfxH }
      : { "c64_registers.h": regs };
    const r = await buildForPlatform({
      platform: "c64",
      language: "c",
      sources,
      includes,
    });
    assert.equal(r.ok, true, `c64/${t} build failed at ${r.stage}: ${(r.log || "").slice(-400)}`);
    assert.ok(r.binary.length >= 512, `c64/${t}: ROM too small (${r.binary.length} bytes)`);
  }
});

test("R39 C64 SID sfx wrapper compiles standalone", { timeout: 120000 }, async () => {
  const { buildForPlatform } = await import("../src/toolchains/index.js");
  const sfxC = await readSrc("src/platforms/c64/lib/c/c64_sfx.c");
  const sfxH = await readSrc("src/platforms/c64/lib/c/c64_sfx.h");
  const regs = await readSrc("src/platforms/c64/lib/c64_registers.h");
  const main = `
#include "c64_registers.h"
#include "c64_sfx.h"
void main(void) {
    sfx_init();
    sfx_tone(0, 0x10, 0x10, 30);
    sfx_noise(20);
    for (;;) sfx_update();
}
`;
  const r = await buildForPlatform({
    platform: "c64",
    language: "c",
    sources: { "main.c": main, "c64_sfx.c": sfxC },
    includes: { "c64_registers.h": regs, "c64_sfx.h": sfxH },
  });
  assert.equal(r.ok, true, `c64_sfx smoke failed at ${r.stage}: ${(r.log || "").slice(-400)}`);
});
