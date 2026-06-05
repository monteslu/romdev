// Live regression guard for the Genesis SAT byte-order bug (v0.2.0 feedback #4):
// inspectSprites reported a 32×32 sprite as 8×8 with link 15, because gpgx's
// VRAM is host-LE word-byte-swapped and decodeGenesisSprites was reading the
// SAT words big-endian. This builds a ROM with KNOWN sprites and asserts the
// decoded size/position/tile/palette match what was set.

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildForPlatform } from "../src/toolchains/index.js";
import { resolveCore } from "../src/cores/registry.js";
import { LibretroHost } from "../src/host/index.js";
import { decodeGenesisSprites } from "../src/host/gpgx-state.js";

const SRC = `
#include <genesis.h>
int main() {
  VDP_init();
  // slot 0: 32x32 (SPRITE_SIZE(4,4)) at (100,120), pal1, tile5, priority 1, link 1
  VDP_setSpriteFull(0, 100, 120, SPRITE_SIZE(4,4), TILE_ATTR_FULL(PAL1,1,0,0,5), 1);
  // slot 1: 16x16 at (200,50), pal0, tile9, priority 0, link 0 (end)
  VDP_setSpriteFull(1, 200, 50, SPRITE_SIZE(2,2), TILE_ATTR_FULL(PAL0,0,0,0,9), 0);
  VDP_updateSprites(2, DMA);
  while (1) { VDP_waitVSync(); }
  return 0;
}
`;

test("decodeGenesisSprites reports correct size/pos/tile (SAT byte-order)", async () => {
  const b = await buildForPlatform({ platform: "genesis", source: SRC, sourceName: "main.c", language: "c" });
  assert.ok(b.binary, `genesis build failed: ${(b.log || "").slice(-400)}`);
  const host = new LibretroHost();
  const core = resolveCore("genesis");
  await host.loadCore(core.jsPath, core.wasmPath);
  await host.loadMedia({ platform: "genesis", bytes: b.binary });
  for (let i = 0; i < 60; i++) host.stepFrames(1);

  const vram = host.readMemory("video_ram", 0, 65536);
  const vdpRegs = host.readMemory("genesis_vdp_regs", 0, 32);
  const sprites = decodeGenesisSprites(vram, vdpRegs);

  const s0 = sprites.find((s) => s.slot === 0);
  assert.ok(s0, "slot 0 sprite present");
  // The headline bug: 32×32 must NOT come back as 8×8.
  assert.deepEqual(s0.size, { w: 32, h: 32 }, "slot 0 is 32×32 (the regression)");
  assert.equal(s0.x, 100, "slot 0 x");
  assert.equal(s0.y, 120, "slot 0 y");
  assert.equal(s0.tile, 5, "slot 0 tile");
  assert.equal(s0.palette, 1, "slot 0 palette");
  assert.equal(s0.priority, 1, "slot 0 priority");
  assert.equal(s0.link, 1, "slot 0 link points to slot 1 (not 15)");

  const s1 = sprites.find((s) => s.slot === 1);
  assert.ok(s1, "slot 1 sprite present (reached via the link chain)");
  assert.deepEqual(s1.size, { w: 16, h: 16 }, "slot 1 is 16×16");
  assert.equal(s1.x, 200, "slot 1 x");
  assert.equal(s1.y, 50, "slot 1 y");
  assert.equal(s1.tile, 9, "slot 1 tile");
  assert.equal(s1.link, 0, "slot 1 ends the chain");
}, { timeout: 60000 });
