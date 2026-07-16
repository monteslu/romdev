// R23 + R23e sports + racing genre coverage tests.
// Confirms sports + racing templates build to valid ROMs on every
// supported platform (nes, gb, gbc, snes, genesis, sms, atari7800),
// and createGame scaffolds them correctly for the full matrix.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

async function readSource(rel) {
  return readFile(join(REPO_ROOT, rel), "utf-8");
}

test("R23 NES sports + racing templates build via buildForPlatform", { timeout: 180000 }, async () => {
  const { buildForPlatform } = await import("../src/toolchains/index.js");
  const runtimeC = await readSource("src/platforms/nes/lib/c/nes_runtime.c");
  const runtimeH = await readSource("src/platforms/nes/lib/c/nes_runtime.h");
  const crt0     = await readSource("src/toolchains/cc65/presets/nes/chr-ram-runtime.crt0.s");
  const cfg      = await readSource("src/toolchains/cc65/presets/nes/chr-ram-runtime.cfg");

  for (const t of ["sports", "racing"]) {
    const main = await readSource(`examples/nes/templates/${t}.c`);
    const r = await buildForPlatform({
      platform: "nes",
      language: "c",
      sources: { "main.c": main, "nes_runtime.c": runtimeC, "_preset_crt0.s": crt0 },
      includes: { "nes_runtime.h": runtimeH },
      linkerConfig: cfg,
    });
    assert.equal(r.ok, true, `nes/${t} build failed: ${(r.log || "").slice(-300)}`);
    assert.ok(r.binary.length >= 16 + 16384, `nes/${t}: ROM too small`);
  }
});

test("R23 Genesis sports + racing templates build via buildGenesisC", { timeout: 180000 }, async () => {
  const { buildGenesisC } = await import("romdev-toolchain-m68k-gcc");
  // R30: scaffolds now include genesis_sfx — provide it.
  const sfxH = await readSource("../romdev-toolchain-m68k-gcc/share/genesis/lib/c/genesis_sfx.h");
  const sfxC = await readSource("../romdev-toolchain-m68k-gcc/share/genesis/lib/c/genesis_sfx.c");
  for (const t of ["sports", "racing"]) {
    const src = await readSource(`examples/genesis/templates/${t}.c`);
    const r = await buildGenesisC({
      sources: { "main.c": src, "genesis_sfx.c": sfxC },
      headers: { "genesis_sfx.h": sfxH },
      sgdk: true,
    });
    assert.equal(r.ok, true, `genesis/${t} build failed at ${r.stage}: ${(r.log || "").slice(-300)}`);
    const headerStart = Buffer.from(r.binary.subarray(0x100, 0x110)).toString("ascii");
    assert.equal(headerStart, "SEGA MEGA DRIVE ", `genesis/${t}: missing SEGA header`);
  }
});

test("R23e GB sports + racing templates build via buildForPlatform", { timeout: 180000 }, async () => {
  const { buildForPlatform } = await import("../src/toolchains/index.js");
  const runtimeC = await readSource("src/platforms/gb/lib/c/gb_runtime.c");
  const runtimeH = await readSource("src/platforms/gb/lib/c/gb_runtime.h");
  const hwH      = await readSource("src/platforms/gb/lib/c/gb_hardware.h");
  for (const t of ["sports", "racing"]) {
    const main = await readSource(`examples/gb/templates/${t}.c`);
    const r = await buildForPlatform({
      platform: "gb",
      language: "c",
      sources: { "main.c": main, "gb_runtime.c": runtimeC },
      includes: { "gb_runtime.h": runtimeH, "gb_hardware.h": hwH },
    });
    assert.equal(r.ok, true, `gb/${t} build failed at ${r.stage}: ${(r.log || "").slice(-300)}`);
    assert.ok(r.binary.length >= 16384, `gb/${t}: ROM too small`);
  }
});

test("R23e SNES sports + racing templates build via buildSnesC", { timeout: 180000 }, async () => {
  const { buildSnesC } = await import("../src/toolchains/snes-c/snes-c.js");
  // R31: SNES sports + racing now use snes_sfx — provide it.
  const sfxH = await readSource("src/platforms/snes/lib/c/snes_sfx.h");
  const sfxC = await readSource("src/platforms/snes/lib/c/snes_sfx.c");
  const sfxDataAsm = await readSource("src/platforms/snes/lib/c/snes_sfx_data.asm");
  const apuBlob = await readFile(join(REPO_ROOT, "src/platforms/snes/lib/audio/apu_blob.bin"));
  for (const t of ["sports", "racing"]) {
    const main = await readSource(`examples/snes/templates/${t}.c`);
    const data = await readSource(`examples/snes/templates/${t}-data.asm`);
    const r = await buildSnesC({
      sources: { "main.c": main, "data.asm": data, "snes_sfx_data.asm": sfxDataAsm },
      headers: { "snes_sfx.h": sfxH, "snes_sfx.c": sfxC },
      binaryIncludes: { "apu_blob.bin": new Uint8Array(apuBlob) },
      pvsneslib: true,
    });
    assert.equal(r.ok, true, `snes/${t} build failed at ${r.stage}: ${(r.log || "").slice(-300)}`);
    assert.ok(r.binary.length >= 32768, `snes/${t}: ROM too small`);
  }
});

test("R23e SMS sports + racing templates build via buildForPlatform", { timeout: 180000 }, async () => {
  const { buildForPlatform } = await import("../src/toolchains/index.js");
  // R35: sms_sfx wrapper is now part of the SMS runtime.
  const runtimes = {
    "vdp_init.c":     await readSource("src/platforms/sms/lib/c/vdp_init.c"),
    "load_palette.c": await readSource("src/platforms/sms/lib/c/load_palette.c"),
    "load_tiles.c":   await readSource("src/platforms/sms/lib/c/load_tiles.c"),
    "vblank_wait.c":  await readSource("src/platforms/sms/lib/c/vblank_wait.c"),
    "joypad_read.c":  await readSource("src/platforms/sms/lib/c/joypad_read.c"),
    "sprite_table.c": await readSource("src/platforms/sms/lib/c/sprite_table.c"),
    "sms_sfx.c":      await readSource("src/platforms/sms/lib/c/sms_sfx.c"),
    "sms_music.c":    await readSource("src/platforms/sms/lib/c/sms_music.c"),
  };
  const hw    = await readSource("src/platforms/sms/lib/c/sms_hw.h");
  const sfxH  = await readSource("src/platforms/sms/lib/c/sms_sfx.h");
  for (const t of ["sports", "racing"]) {
    const main = await readSource(`examples/sms/templates/${t}.c`);
    const r = await buildForPlatform({
      platform: "sms",
      language: "c",
      sources: { "main.c": main, ...runtimes },
      includes: { "sms_hw.h": hw, "sms_sfx.h": sfxH, "sms_music.h": await readSource("src/platforms/sms/lib/c/sms_music.h") },
    });
    assert.equal(r.ok, true, `sms/${t} build failed at ${r.stage}: ${(r.log || "").slice(-300)}`);
    assert.ok(r.binary.length >= 16384, `sms/${t}: ROM too small`);
  }
});

test("R23e Atari 7800 sports + racing templates build via buildForPlatform", { timeout: 120000 }, async () => {
  const { buildForPlatform } = await import("../src/toolchains/index.js");
  // R40: 7800 scaffolds now include atari7800_sfx.
  const sfxC = await readSource("src/platforms/atari7800/lib/c/atari7800_sfx.c");
  const sfxH = await readSource("src/platforms/atari7800/lib/c/atari7800_sfx.h");
  for (const t of ["sports", "racing"]) {
    const main = await readSource(`examples/atari7800/templates/${t}.c`);
    const r = await buildForPlatform({
      platform: "atari7800",
      language: "c",
      sources: { "main.c": main, "atari7800_sfx.c": sfxC },
      includes: { "atari7800_sfx.h": sfxH },
    });
    assert.equal(r.ok, true, `atari7800/${t} build failed at ${r.stage}: ${(r.log || "").slice(-300)}`);
    assert.ok(r.binary.length >= 16384, `atari7800/${t}: ROM too small`);
  }
});

test("R23e createGame supports sports + racing on EVERY tier-1 platform", { timeout: 30000 }, async () => {
  const { createProjectImpl } = await import("../src/mcp/tools/project.js");
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  for (const platform of ["nes", "gb", "gbc", "snes", "genesis", "sms", "atari7800"]) {
    for (const genre of ["sports", "racing"]) {
      const projPath = await mkdtemp(join(tmpdir(), `r23e-${platform}-${genre}-`));
      const r = await createProjectImpl({
        platform,
        name: `${platform}-${genre}`,
        path: projPath,
        template: genre,
        overwrite: true,
      });
      assert.equal(r.platform, platform);
      assert.equal(r.template, genre);
      const main = r.files.find((f) => /^main\.(c|s|asm)$/.test(f));
      assert.ok(main, `${platform}/${genre}: no main source in files`);
    }
  }
});

test("R23e createGame rejects an unknown template with a clear error", { timeout: 10000 }, async () => {
  const { createProjectImpl } = await import("../src/mcp/tools/project.js");
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const projPath = await mkdtemp(join(tmpdir(), "r23-bad-"));
  // The 14×5 grid is complete (2026-06-11): every platform now ships all five
  // canonical genres, including atari2600/puzzle (TILE TWINS, a memory match-
  // pairs game). So there's no longer a canonical genre any platform LACKS —
  // the rejection path is exercised with a genuinely unknown template name.
  await assert.rejects(
    () => createProjectImpl({
      platform: "atari2600",
      name: "x",
      path: projPath,
      template: "fighting",
      overwrite: true,
    }),
    /Unknown template 'fighting'/,
  );
});
