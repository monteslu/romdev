// R22 template-parity smoke tests. Confirms the new SMS / Atari 7800 /
// Atari 2600 templates added in R22 all compile to valid ROMs.
//
// SMS: 5 new templates (hello_sprite, tile_engine, shmup, platformer, puzzle)
//      on top of the existing default. C via SDCC z80 port.
// Atari 7800: 4 new templates (hello_sprite, shmup, platformer, puzzle)
//      on top of the promoted default. C via cc65.
// Atari 2600: 2 new templates (paddle, single_screen) on top of the
//      promoted default. Assembly via dasm.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

const SMS_TEMPLATES = ["default", "hello_sprite", "tile_engine", "shmup", "platformer", "puzzle"];
const ATARI7800_TEMPLATES = ["default", "hello_sprite", "shmup", "platformer", "puzzle"];
const ATARI2600_TEMPLATES = ["default", "paddle", "single_screen"];

async function readSource(rel) {
  return readFile(join(REPO_ROOT, rel), "utf-8");
}

test("R22 SMS SDCC z80 templates: all compile to valid ROMs", { timeout: 300000 }, async () => {
  const { buildForPlatform } = await import("../src/toolchains/index.js");

  // R35: sms_sfx.c is a new runtime sibling — supply it whenever the
  // scaffold references it.
  const runtimes = {
    "vdp_init.c":     await readSource("src/platforms/sms/lib/c/vdp_init.c"),
    "load_palette.c": await readSource("src/platforms/sms/lib/c/load_palette.c"),
    "load_tiles.c":   await readSource("src/platforms/sms/lib/c/load_tiles.c"),
    "vblank_wait.c":  await readSource("src/platforms/sms/lib/c/vblank_wait.c"),
    "joypad_read.c":  await readSource("src/platforms/sms/lib/c/joypad_read.c"),
    "sprite_table.c": await readSource("src/platforms/sms/lib/c/sprite_table.c"),
    "sms_sfx.c":      await readSource("src/platforms/sms/lib/c/sms_sfx.c"),
  };
  const hw    = await readSource("src/platforms/sms/lib/c/sms_hw.h");
  const sfxH  = await readSource("src/platforms/sms/lib/c/sms_sfx.h");

  for (const t of SMS_TEMPLATES) {
    const mainPath = t === "default"
      ? "examples/sms/main.c"
      : `examples/sms/templates/${t}.c`;
    const main = await readSource(mainPath);
    /* The default template inlines everything; the others depend on the
     * runtime helpers under src/platforms/sms/lib/c/. We pass the
     * runtime files for all of them — the linker drops unreferenced
     * symbols, so it's harmless for default. */
    const r = await buildForPlatform({
      platform: "sms",
      language: "c",
      sources: { "main.c": main, ...(t === "default" ? {} : runtimes) },
      includes: { "sms_hw.h": hw, "sms_sfx.h": sfxH },
    });
    assert.equal(r.ok, true, `${t} build failed at ${r.stage || "?"}: ${(r.log || "").slice(-300)}`);
    assert.ok(r.binary.length >= 16384, `${t}: ROM too small: ${r.binary.length}`);
  }
});

test("R22 Atari 7800 cc65 templates: all compile to valid ROMs", { timeout: 180000 }, async () => {
  const { buildForPlatform } = await import("../src/toolchains/index.js");
  // R40: 7800 scaffolds now include atari7800_sfx.
  const sfxC = await readSource("src/platforms/atari7800/lib/c/atari7800_sfx.c");
  const sfxH = await readSource("src/platforms/atari7800/lib/c/atari7800_sfx.h");
  for (const t of ATARI7800_TEMPLATES) {
    const main = await readSource(`examples/atari7800/templates/${t}.c`);
    const r = await buildForPlatform({
      platform: "atari7800",
      language: "c",
      sources: { "main.c": main, "atari7800_sfx.c": sfxC },
      includes: { "atari7800_sfx.h": sfxH },
    });
    assert.equal(r.ok, true, `${t} build failed at ${r.stage || "?"}: ${(r.log || "").slice(-300)}`);
    assert.ok(r.binary.length >= 16384, `${t}: ROM too small: ${r.binary.length}`);
  }
});

test("R22 Atari 2600 dasm templates: all compile to valid ROMs", { timeout: 60000 }, async () => {
  const { buildForPlatform } = await import("../src/toolchains/index.js");

  for (const t of ATARI2600_TEMPLATES) {
    const src = await readSource(`examples/atari2600/templates/${t}.asm`);
    const r = await buildForPlatform({ platform: "atari2600", source: src });
    assert.equal(r.ok, true, `${t} build failed at ${r.stage || "?"}: ${(r.log || "").slice(-300)}`);
    // 4 KB cart is the canonical size.
    assert.equal(r.binary.length, 4096, `${t}: expected 4 KB cart, got ${r.binary.length}`);
  }
});

test("R22 createGame includes sms + atari7800 as supported platforms", async () => {
  const { createProjectImpl } = await import("../src/mcp/tools/project.js");
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  for (const platform of ["sms", "atari7800"]) {
    for (const genre of ["shmup", "platformer", "puzzle"]) {
      const projPath = await mkdtemp(join(tmpdir(), `r22-${platform}-${genre}-`));
      const r = await createProjectImpl({
        platform,
        name: `${platform}-${genre}`,
        path: projPath,
        template: genre,
        overwrite: true,
      });
      assert.equal(r.platform, platform);
      assert.equal(r.template, genre);
      assert.ok(Array.isArray(r.files));
    }
  }
});
