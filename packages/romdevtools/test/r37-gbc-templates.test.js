// R37 — GBC tier-1: all 8 GB scaffolds build as GBC ROMs.
//
// GBC = DMG with color extensions. TEMPLATES.gbc aliases TEMPLATES.gb +
// LIB_PLATFORM = "gb" so the project tree resolves identically.
// patchGbHeader flips the $0143 CGB byte at the loadMedia step;
// gambatte boots into CGB mode automatically.

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

const GBC_TEMPLATES = ["default", "shmup", "platformer", "puzzle", "sports", "racing", "hello_sprite", "tile_engine"];

test("R37 GBC tier-1: every GBC scaffold compiles + writes BG palette via BCPS", { timeout: 300000 }, async () => {
  const { buildForPlatform } = await import("../src/toolchains/index.js");
  const crt0     = await readSrc("src/platforms/gbc/lib/c/gb_crt0.s");
  const runtimeC = await readSrc("src/platforms/gbc/lib/c/gb_runtime.c");
  const runtimeH = await readSrc("src/platforms/gbc/lib/c/gb_runtime.h");
  const hwH      = await readSrc("src/platforms/gbc/lib/c/gb_hardware.h");
  const fontH    = await readSrc("src/platforms/gbc/lib/c/font.h");  /* puzzle's HUD glyphs */
  for (const t of GBC_TEMPLATES) {
    const main = await readSrc(`examples/gbc/templates/${t}.c`);
    // Every gbc genre scaffold must visibly use BCPS/BCPD — that's
    // what makes it "color" instead of "shipped 4-shade-green DMG".
    assert.match(main, /BCPS/, `gbc/${t}: should write BCPS (BG palette) — otherwise it's a DMG-shaded ROM with .gbc extension`);
    const r = await buildForPlatform({
      platform: "gbc",
      language: "c",
      sources: { "main.c": main, "gb_runtime.c": runtimeC },
      includes: { "gb_runtime.h": runtimeH, "gb_hardware.h": hwH, "font.h": fontH },
      crt0,
      codeLoc: 0x150,
      /* statics above shadow_oam ($C100) — the project recipe default;
       * the puzzle's grid/shadow arrays overlap it at the sdld $C000 default */
      dataLoc: 0xC200,
    });
    assert.equal(r.ok, true, `gbc/${t} build failed at ${r.stage}: ${(r.log || "").slice(-300)}`);
    assert.ok(r.binary.length >= 16384, `gbc/${t}: ROM too small`);
  }
});
