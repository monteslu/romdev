// R31 — SNES SPC700 sound wrapper smoke test.
//
// Confirms snes_sfx.{h,c} compiles + links against PVSnesLib on the
// snes-c toolchain. The wrapper uploads a prebuilt apu_blob (SPC700
// driver + sample bank) into ARAM at $0200 then dispatches commands
// via the APUIO ports at $2140-$2143.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

test("R31 SNES sfx wrapper: sfx_init + sfx_play compile + link with apu_blob.bin", { timeout: 180000 }, async () => {
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
    u16 frame = 0;
    while (1) {
        WaitForVBlank();
        if (frame == 30) sfx_play(1);
        if (frame == 60) sfx_play(2);
        frame++;
    }
}
`;
  const r = await buildSnesC({
    sources: { "main.c": main, "snes_sfx_data.asm": sfxDataAsm },
    headers: { "snes_sfx.h": sfxH, "snes_sfx.c": sfxC },
    binaryIncludes: { "apu_blob.bin": new Uint8Array(apuBlob) },
    pvsneslib: true,
  });
  assert.equal(r.ok, true, `build failed at ${r.stage}: ${(r.log || "").slice(-400)}`);
  assert.ok(r.binary && r.binary.length >= 32_768);
});

test("R31 apu_blob.bin exists and is at least driver + sample bank in size", async () => {
  // R31 originally pinned this at exactly 9240 bytes (driver + 2 BRR
  // samples). R46 added a music engine + song table at ARAM $5000,
  // which pushed the payload well past that — so this is now a lower-
  // bound check rather than an equality.
  const apuBlob = await readFile(join(REPO_ROOT, "src/platforms/snes/lib/audio/apu_blob.bin"));
  assert.ok(apuBlob.length >= 9240, `apu_blob.bin shrank below R31 baseline (got ${apuBlob.length})`);
});
