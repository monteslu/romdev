// R33 — GBA maxmod link smoke test.
//
// Confirms libmm.a is bundled + the maxmod symbols (mmInitDefault,
// mmVBlank, mmFrame, mmStart, etc.) resolve when buildGbaC is called
// with `maxmod: true`. Doesn't actually play music — that requires a
// soundbank built from .xm/.mod sources via the bundled host tool
// (mmutil), which is a separate scaffold-asset step.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

import { buildGbaC } from "../src/toolchains/gba-c/gba-c.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

test("R33 maxmod SOURCE is bundled (built from source, not a prebuilt libmm.a)", () => {
  // maxmod now compiles from its own .s source in-build — no opaque libmm.a.
  const srcDir = join(REPO_ROOT, "../romdev-platform-gba/share/gba/lib/maxmod/source");
  const gbaDir = join(REPO_ROOT, "../romdev-platform-gba/share/gba/lib/maxmod/source_gba");
  assert.ok(existsSync(join(srcDir, "mm_main.s")), "maxmod source/mm_main.s missing");
  assert.ok(existsSync(join(srcDir, "mm_mas.s")), "maxmod source/mm_mas.s missing");
  assert.ok(existsSync(join(gbaDir, "mm_mixer_gba.s")), "maxmod source_gba/mm_mixer_gba.s missing");
  assert.ok(existsSync(join(REPO_ROOT, "../romdev-platform-gba/share/gba/lib/maxmod/asm_include/mp_macros.inc")),
    "maxmod asm_include/mp_macros.inc missing");
});

test("R33 maxmod headers (maxmod.h + mm_types.h) are bundled", () => {
  assert.ok(existsSync(join(REPO_ROOT, "../romdev-platform-gba/share/gba/lib/maxmod/include/maxmod.h")));
  assert.ok(existsSync(join(REPO_ROOT, "../romdev-platform-gba/share/gba/lib/maxmod/include/mm_types.h")));
});

test("R33 GBA libtonc + maxmod: minimal ROM links cleanly", { timeout: 180000 }, async () => {
  // No soundbank — just verify the maxmod symbols resolve through libmm.a.
  // A real game would also pass a soundbank.bin compiled by mmutil.
  const main = `
#include <tonc.h>
#include <maxmod.h>

extern void mmInitDefault(mm_addr soundbank, mm_word number_of_channels);
extern void mmFrame(void);
extern void mmVBlank(void);

static u8 dummy_soundbank[256] __attribute__((aligned(4))) = { 0 };

int main(void) {
    irq_init(NULL);
    irq_add(II_VBLANK, mmVBlank);
    tte_init_chr4c_default(0, BG_CBB(0) | BG_SBB(31));
    REG_DISPCNT = DCNT_MODE0 | DCNT_BG0;
    tte_write("maxmod link OK");
    mmInitDefault(dummy_soundbank, 8);
    while (1) {
        VBlankIntrWait();
        mmFrame();
    }
}
`;
  const r = await buildGbaC({ source: main, maxmod: true });
  assert.equal(r.ok, true, `build failed at ${r.stage}: ${(r.log || "").slice(-500)}`);
  assert.ok(r.binary && r.binary.length > 1024);
});
