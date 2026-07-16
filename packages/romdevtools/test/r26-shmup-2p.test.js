// R26 — 2P competitive shmup on platforms with native dual-controller
// hardware. Adds shmup_2p template to Genesis + SMS. Each player owns
// their own ship + bullet pool + score; enemies are shared (first hit
// wins). Existing single-player `shmup` template unchanged.

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

test("R26 Genesis shmup_2p builds via buildGenesisC", { timeout: 180000 }, async () => {
  const { buildGenesisC } = await import("romdev-toolchain-m68k-gcc");
  const src = await readSource("examples/genesis/templates/shmup_2p.c");
  // R30: scaffold uses genesis_sfx — provide it.
  const sfxH = await readSource("../romdev-toolchain-m68k-gcc/share/genesis/lib/c/genesis_sfx.h");
  const sfxC = await readSource("../romdev-toolchain-m68k-gcc/share/genesis/lib/c/genesis_sfx.c");
  const r = await buildGenesisC({
    sources: { "main.c": src, "genesis_sfx.c": sfxC },
    headers: { "genesis_sfx.h": sfxH },
    sgdk: true,
  });
  assert.equal(r.ok, true, `genesis/shmup_2p build failed at ${r.stage}: ${(r.log || "").slice(-300)}`);
  const headerStart = Buffer.from(r.binary.subarray(0x100, 0x110)).toString("ascii");
  assert.equal(headerStart, "SEGA MEGA DRIVE ", "genesis/shmup_2p: missing SEGA header");
});

test("R26 SMS shmup_2p builds via buildForPlatform", { timeout: 180000 }, async () => {
  const { buildForPlatform } = await import("../src/toolchains/index.js");
  // R35: SMS scaffolds now use sms_sfx.
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
  const main = await readSource("examples/sms/templates/shmup_2p.c");
  const r = await buildForPlatform({
    platform: "sms",
    language: "c",
    sources: { "main.c": main, ...runtimes },
    includes: { "sms_hw.h": hw, "sms_sfx.h": sfxH, "sms_music.h": await readSource("src/platforms/sms/lib/c/sms_music.h") },
  });
  assert.equal(r.ok, true, `sms/shmup_2p build failed at ${r.stage}: ${(r.log || "").slice(-300)}`);
  assert.ok(r.binary.length >= 16384, `sms/shmup_2p: ROM too small: ${r.binary.length}`);
});

test("R26 createProject scaffolds shmup_2p with sms_joypad_read_p2 helper", async () => {
  const { createProjectImpl } = await import("../src/mcp/tools/project.js");
  const { mkdtemp, readFile: rd } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  // SMS test: verify the joypad_read.c that ships includes the new
  // sms_joypad_read_p2 helper R26 needed.
  const projPath = await mkdtemp(join(tmpdir(), "r26-sms-2p-"));
  const r = await createProjectImpl({
    platform: "sms",
    name: "sms-2p-test",
    path: projPath,
    template: "shmup_2p",
    overwrite: true,
  });
  assert.equal(r.platform, "sms");
  assert.equal(r.template, "shmup_2p");
  assert.ok(r.files.includes("joypad_read.c"), "shmup_2p must ship joypad_read.c");
  const joypadSrc = await rd(join(projPath, "joypad_read.c"), "utf-8");
  assert.match(joypadSrc, /sms_joypad_read_p2/, "joypad_read.c must contain the p2 helper for shmup_2p to compile");
});
