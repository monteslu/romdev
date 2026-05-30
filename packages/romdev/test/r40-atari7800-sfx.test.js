// R40 — Atari 7800 TIA sound wrapper smoke test.
//
// 7800 audio = TIA (the 2600's audio chip — MARIA is the 7800-specific
// video upgrade). 2 voices, AUDC/AUDF/AUDV per channel. Optional
// POKEY exists on some carts but isn't bundled. atari7800_sfx wraps
// the TIA into the cross-platform sfx_* shape.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

test("R40 7800 sfx wrapper: sfx_init + sfx_tone + sfx_noise + sfx_update compile + link", { timeout: 180000 }, async () => {
  const { buildForPlatform } = await import("../src/toolchains/index.js");
  const sfxH = await readFile(join(REPO_ROOT, "src/platforms/atari7800/lib/c/atari7800_sfx.h"), "utf-8");
  const sfxC = await readFile(join(REPO_ROOT, "src/platforms/atari7800/lib/c/atari7800_sfx.c"), "utf-8");
  const main = `
#include <stdint.h>
#include "atari7800_sfx.h"
void main(void) {
    sfx_init();
    sfx_tone(0, 8, 30);
    sfx_tone(1, 16, 15);
    sfx_noise(20);
    for (;;) sfx_update();
}
`;
  const r = await buildForPlatform({
    platform: "atari7800",
    language: "c",
    sources: { "main.c": main, "atari7800_sfx.c": sfxC },
    includes: { "atari7800_sfx.h": sfxH },
  });
  assert.equal(r.ok, true, `build failed at ${r.stage}: ${(r.log || "").slice(-500)}`);
  assert.ok(r.binary && r.binary.length >= 16384);
});
