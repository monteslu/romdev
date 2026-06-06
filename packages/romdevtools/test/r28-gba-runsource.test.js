// R28 — end-to-end mgba core wiring.
//
// Confirms that a Tonc ROM built by our toolchain actually loads + runs
// under the bundled mgba_libretro core. Regression guard against the
// "no core available for platform 'gba'" path that existed pre-R28.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { buildGbaC } from "../src/toolchains/gba-c/gba-c.js";
import { resolveCore } from "../src/cores/registry.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LIB_DIR = path.join(__dirname, "..", "src", "platforms", "gba", "lib", "c");
const SFX_H = readFileSync(path.join(LIB_DIR, "gba_sfx.h"), "utf-8");
const SFX_C = readFileSync(path.join(LIB_DIR, "gba_sfx.c"), "utf-8");

test("R28 GBA mgba core is registered + resolvable", () => {
  const r = resolveCore("gba");
  assert.ok(r, "resolveCore('gba') returned null — mgba_libretro.{js,wasm} missing from src/cores/wasm/?");
  assert.equal(r.platform, "gba");
  assert.equal(r.coreName, "mgba");
  assert.match(r.displayName, /mGBA/);
});

test("R28 GBA: Tonc ROM with sfx + IRQ setup runs 10 frames under mgba", { timeout: 180000 }, async () => {
  // The fully-wired pattern: TTE on BG0, sprite sound, IRQ setup
  // (without irq_init the BIOS VBlankIntrWait halts forever).
  const main = `
#include <tonc.h>
#include "gba_sfx.h"

int main(void) {
    tte_init_chr4c_default(0, BG_CBB(0) | BG_SBB(31));
    irq_init(NULL);
    irq_add(II_VBLANK, NULL);
    sfx_init();
    sfx_tone(1, 1700, 8);
    REG_DISPCNT = DCNT_MODE0 | DCNT_BG0;
    tte_write("R28 mgba smoke OK");
    while (1) { VBlankIntrWait(); }
}
`;
  const r = await buildGbaC({
    sources: { "main.c": main, "gba_sfx.c": SFX_C },
    headers: { "gba_sfx.h": SFX_H },
  });
  assert.equal(r.ok, true, `build failed at ${r.stage}: ${(r.log || "").slice(-500)}`);
  assert.ok(r.binary && r.binary.length > 256);

  // Boot the rom under mgba via the host. Mirrors what runSource does
  // internally but skips the MCP plumbing.
  const { LibretroHost } = await import("../src/host/LibretroHost.js");
  const core = resolveCore("gba");
  const host = new LibretroHost();
  await host.loadCore(core.jsPath, core.wasmPath);
  await host.loadMedia({ platform: "gba", bytes: r.binary, virtualName: "smoke.gba" });
  host.stepFrames(10);
  assert.ok(host.status, "host.status missing");
  assert.ok(host.status.frameCount >= 10,
    `expected >=10 frames stepped, got ${host.status.frameCount}`);
});
