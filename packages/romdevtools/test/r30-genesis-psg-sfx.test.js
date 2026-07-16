// R30 — Genesis PSG sound wrapper smoke test.
//
// Confirms genesis_sfx.{h,c} compiles + links against SGDK on the
// genesis-c toolchain. The wrapper provides sfx_init / sfx_tone /
// sfx_noise / sfx_update / sfx_off over SGDK's PSG_* helpers.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { buildGenesisC } from "../src/toolchains/genesis-c/genesis-c.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LIB_DIR = path.join(__dirname, "..", "..", "romdev-toolchain-m68k-gcc", "share", "genesis", "lib", "c");
const SFX_H = readFileSync(path.join(LIB_DIR, "genesis_sfx.h"), "utf-8");
const SFX_C = readFileSync(path.join(LIB_DIR, "genesis_sfx.c"), "utf-8");

test("R30 Genesis PSG sfx wrapper: sfx_init + sfx_tone + sfx_noise + sfx_update compile + link", { timeout: 180000 }, async () => {
  const main = `
#include <genesis.h>
#include "genesis_sfx.h"
int main(bool hard) {
    (void)hard;
    sfx_init();
    sfx_tone(0, 400, 20);
    sfx_tone(1, 200, 8);
    sfx_noise(12);
    while (TRUE) {
        sfx_update();
        SYS_doVBlankProcess();
    }
    return 0;
}
`;
  const r = await buildGenesisC({
    sources: { "main.c": main, "genesis_sfx.c": SFX_C },
    headers: { "genesis_sfx.h": SFX_H },
    sgdk: true,
  });
  assert.equal(r.ok, true, `build failed at ${r.stage}: ${(r.log || "").slice(-500)}`);
  assert.ok(r.binary && r.binary.length > 200_000);
  const headerStart = Buffer.from(r.binary.subarray(0x100, 0x110)).toString("ascii");
  assert.equal(headerStart, "SEGA MEGA DRIVE ", "missing SEGA header");
});
