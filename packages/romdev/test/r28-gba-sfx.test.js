// R28 — GBA sfx wrapper smoke test.
//
// Confirms gba_sfx.{h,c} compiles + links alongside main.c on the
// libtonc runtime. The wrapper provides sfx_init / sfx_tone / sfx_noise
// over the GBA's DMG-compatible APU.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { buildGbaC } from "../src/toolchains/gba-c/gba-c.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LIB_DIR = path.join(__dirname, "..", "src", "platforms", "gba", "lib", "c");
const SFX_H = readFileSync(path.join(LIB_DIR, "gba_sfx.h"), "utf-8");
const SFX_C = readFileSync(path.join(LIB_DIR, "gba_sfx.c"), "utf-8");

test("R28 GBA sfx wrapper: sfx_init + sfx_tone + sfx_noise compile + link", { timeout: 180000 }, async () => {
  const main = `
#include <tonc.h>
#include "gba_sfx.h"

int main(void) {
    sfx_init();
    sfx_tone(1, 1900, 8);
    sfx_tone(2, 1300, 4);
    sfx_noise(6);
    sfx_off();
    while (1) { VBlankIntrWait(); }
    return 0;
}
`;
  const r = await buildGbaC({
    sources: { "main.c": main, "gba_sfx.c": SFX_C },
    headers: { "gba_sfx.h": SFX_H },
  });
  assert.equal(r.ok, true, `sfx build failed at ${r.stage}: ${(r.log || "").slice(-500)}`);
  assert.equal(r.runtime, "libtonc");
  assert.ok(r.binary.length > 256, "binary too small");
});
