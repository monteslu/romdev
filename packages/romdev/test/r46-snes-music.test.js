// R46 — SNES SPC700 continuous music smoke test.
//
// Validates the music engine extension to the R31 sfx driver:
//   - sfx_music_play() / sfx_music_stop() exist in snes_sfx.{h,c}
//   - apu_blob.bin grew vs R31 (new driver code + song table linked in)
//   - The music_demo template + driver source compile + link
//   - All R31 sfx commands still exist (sfx_play, sfx_release)
//
// Doesn't run the ROM in an emulator (that's a separate verify step) —
// the build-passes contract is enough to catch regressions in the
// driver source, the apu_blob.asm assembler invocation, or the C
// wrapper signatures.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

// R31 apu_blob was exactly 9240 bytes. The R46 music engine adds
// ~80 bytes of driver code and a song table at ARAM $5000 — that
// $5000 base alone forces the payload past ~20 KB. Anything above
// the R31 baseline proves the new code path is linked.
const R31_APU_BLOB_SIZE = 9240;

test("R46 apu_blob.bin grew vs R31 (music engine + song table linked in)", async () => {
  const apuBlob = await readFile(join(REPO_ROOT, "src/platforms/snes/lib/audio/apu_blob.bin"));
  assert.ok(
    apuBlob.length > R31_APU_BLOB_SIZE,
    `apu_blob.bin is ${apuBlob.length} bytes — expected > ${R31_APU_BLOB_SIZE} (R31 baseline) after music-engine extension`,
  );
});

test("R46 snes_sfx.h declares sfx_music_play + sfx_music_stop", async () => {
  const sfxH = await readFile(join(REPO_ROOT, "src/platforms/snes/lib/c/snes_sfx.h"), "utf-8");
  assert.match(sfxH, /void\s+sfx_music_play\s*\(\s*void\s*\)\s*;/);
  assert.match(sfxH, /void\s+sfx_music_stop\s*\(\s*void\s*\)\s*;/);
  // R31 surface still intact
  assert.match(sfxH, /void\s+sfx_play\s*\(\s*u8\s+cmd\s*\)\s*;/);
  assert.match(sfxH, /void\s+sfx_release\s*\(\s*void\s*\)\s*;/);
  assert.match(sfxH, /u8\s+sfx_init\s*\(\s*void\s*\)\s*;/);
});

test("R46 spc_driver.asm dispatches commands $03 + $04", async () => {
  const drv = await readFile(join(REPO_ROOT, "src/platforms/snes/lib/audio/spc_driver.asm"), "utf-8");
  // Music start/stop command bytes
  assert.match(drv, /cmp\s+a,\s*#\$03/);
  assert.match(drv, /cmp\s+a,\s*#\$04/);
  // Music engine should touch voice 1 (VOL $10/$11, PITCH $12/$13,
  // KON bit 1 = $02). Just spot-check a couple distinctive lines.
  assert.match(drv, /\$f3,\s*#\$02/); // KON $02 (voice 1)
});

test("R46 SNES music demo: music_demo.c + driver compile + link with apu_blob.bin", { timeout: 180000 }, async () => {
  const { buildSnesC } = await import("../src/toolchains/snes-c/snes-c.js");
  const sfxH = await readFile(join(REPO_ROOT, "src/platforms/snes/lib/c/snes_sfx.h"), "utf-8");
  const sfxC = await readFile(join(REPO_ROOT, "src/platforms/snes/lib/c/snes_sfx.c"), "utf-8");
  const sfxDataAsm = await readFile(join(REPO_ROOT, "src/platforms/snes/lib/c/snes_sfx_data.asm"), "utf-8");
  const apuBlob = await readFile(join(REPO_ROOT, "src/platforms/snes/lib/audio/apu_blob.bin"));
  const musicDemoC = await readFile(join(REPO_ROOT, "examples/snes/templates/music_demo.c"), "utf-8");
  const musicDemoDataAsm = await readFile(join(REPO_ROOT, "examples/snes/templates/music_demo-data.asm"), "utf-8");

  const r = await buildSnesC({
    sources: { "main.c": musicDemoC, "snes_sfx_data.asm": sfxDataAsm, "data.asm": musicDemoDataAsm },
    headers: { "snes_sfx.h": sfxH, "snes_sfx.c": sfxC },
    binaryIncludes: { "apu_blob.bin": new Uint8Array(apuBlob) },
    pvsneslib: true,
  });
  assert.equal(r.ok, true, `build failed at ${r.stage}: ${(r.log || "").slice(-400)}`);
  assert.ok(r.binary && r.binary.length >= 32_768, "expected a >= 32KB SNES ROM out");
});

test("R46 backwards-compat: R31 sfx-only template still builds", { timeout: 180000 }, async () => {
  // Same shape as r31-snes-sfx.test.js but exercised against the R46
  // driver/blob to prove the music extension didn't regress existing
  // sfx code paths.
  const { buildSnesC } = await import("../src/toolchains/snes-c/snes-c.js");
  const sfxH = await readFile(join(REPO_ROOT, "src/platforms/snes/lib/c/snes_sfx.h"), "utf-8");
  const sfxC = await readFile(join(REPO_ROOT, "src/platforms/snes/lib/c/snes_sfx.c"), "utf-8");
  const sfxDataAsm = await readFile(join(REPO_ROOT, "src/platforms/snes/lib/c/snes_sfx_data.asm"), "utf-8");
  const apuBlob = await readFile(join(REPO_ROOT, "src/platforms/snes/lib/audio/apu_blob.bin"));

  const main = `
#include <snes.h>
#include "snes_sfx.c"
int main(void) {
    consoleInit();
    sfx_init();
    sfx_play(1);
    sfx_play(2);
    while (1) { WaitForVBlank(); }
}
`;
  const r = await buildSnesC({
    sources: { "main.c": main, "snes_sfx_data.asm": sfxDataAsm },
    headers: { "snes_sfx.h": sfxH, "snes_sfx.c": sfxC },
    binaryIncludes: { "apu_blob.bin": new Uint8Array(apuBlob) },
    pvsneslib: true,
  });
  assert.equal(r.ok, true, `R31-compat build failed at ${r.stage}: ${(r.log || "").slice(-400)}`);
});
