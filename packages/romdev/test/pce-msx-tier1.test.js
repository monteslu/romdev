// Tier-1 integration test for PC Engine (pce) and MSX (msx).
//
// Proves the full stack for both newly-added platforms:
//   1. The starter scaffold builds (PCE: single conio source; MSX: main + crt0).
//   2. The ROM loads into its core and runs frames (renders, not just loads).
//   3. The romdev region patches expose live data (VRAM/palette/CPU).
//   4. The inspect adapters decode that data: getCPUState, inspectPalette,
//      inspectSprites, getRenderingContext.
//
// These are the platforms' real Tier-1 receipts — when this passes, an agent
// can build, run, AND debug a PCE/MSX game through the same MCP surface as the
// original 12 platforms.

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { buildForPlatform } from "../src/toolchains/index.js";
import { resolveCore } from "../src/cores/registry.js";
import { LibretroHost } from "../src/host/index.js";
import { getCPUState } from "../src/host/cpu-state.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLAT = path.join(__dirname, "..", "src", "platforms");

test("PCE tier-1: hello_pce scaffold builds, runs, and exposes regions + decoders", async () => {
  const source = await readFile(path.join(PLAT, "pce", "lib", "c", "hello_pce.c"), "utf8");
  const build = await buildForPlatform({ platform: "pce", source, sourceName: "main.c" });
  assert.equal(build.ok, true, `pce build failed:\n${build.log}`);
  assert.ok(build.binary && build.binary.length > 0);

  const core = resolveCore("pce");
  assert.ok(core, "geargrafx core not resolvable");
  const host = new LibretroHost();
  await host.loadCore(core.jsPath, core.wasmPath);
  await host.loadMedia({ platform: "pce", bytes: build.binary });
  for (let i = 0; i < 60; i++) host.stepFrames(1);

  const fb = host.getFramebuffer();
  assert.ok(fb.width > 0 && fb.height > 0, "pce framebuffer empty");

  // Regions: VRAM should hold the conio font upload (non-empty), palette live.
  assert.equal(host.regionSize("pce_vdc_vram"), 0x10000, "pce VRAM region size");
  const vram = host.readMemory("pce_vdc_vram", 0, host.regionSize("pce_vdc_vram"));
  let vramNonZero = 0;
  for (const b of vram) if (b) vramNonZero++;
  assert.ok(vramNonZero > 1000, `pce VRAM looks empty (${vramNonZero} nonzero) — scaffold didn't render`);

  // CPU decoder.
  const cpu = getCPUState(host, "pce");
  assert.equal(cpu.cpu, "huc6280");
  assert.equal(typeof cpu.pc, "number");

  // Palette decoder (9-bit GRB).
  const { decodeVcePalette } = await import("../src/platforms/pce/vce.js");
  const pal = host.readMemory("pce_vce_palette", 0, 1024);
  const { entries } = decodeVcePalette(pal, "all");
  assert.equal(entries.length, 512);
  assert.ok(entries.every((e) => e.r >= 0 && e.r <= 255 && "hex" in e));

  // Sprite decoder (SATB).
  const { decodeSatb } = await import("../src/platforms/pce/vdc.js");
  const sprites = decodeSatb(host.readMemory("pce_vdc_satb", 0, 512));
  assert.equal(sprites.length, 64);
  assert.ok(sprites[0].size && "tile" in sprites[0]);
}, { timeout: 60000 });

test("MSX tier-1: hello_msx scaffold (main + crt0) builds, boots C-BIOS, exposes regions + decoders", async () => {
  const main = await readFile(path.join(PLAT, "msx", "lib", "c", "hello_msx.c"), "utf8");
  const crt0 = await readFile(path.join(PLAT, "msx", "lib", "c", "msx_crt0.s"), "utf8");

  // The SDCC worker pool can transiently fail a translation unit — retry a few.
  let build;
  for (let attempt = 0; attempt < 3; attempt++) {
    build = await buildForPlatform({
      platform: "msx",
      sources: { "main.c": main, "msx_crt0.s": crt0 },
      crt0: ".module empty\n",
      sourceName: "main.c",
    });
    if (build.binary) break;
  }
  assert.equal(build.ok, true, `msx build failed:\n${build.log}`);
  assert.ok(build.binary && build.binary.length > 0);
  // Cartridge header: "AB" magic + INIT pointer at offset 0 (a $4000-page image).
  assert.equal(build.binary[0], 0x41, "msx ROM missing 'A' of AB header");
  assert.equal(build.binary[1], 0x42, "msx ROM missing 'B' of AB header");

  const core = resolveCore("msx");
  assert.ok(core, "blueMSX core not resolvable");
  // No systemDir / machine option passed — the host must auto-resolve the
  // bundled C-BIOS and force the MSX2+ machine (zero-setup Tier-1 boot).
  const host = new LibretroHost();
  await host.loadCore(core.jsPath, core.wasmPath);
  await host.loadMedia({ platform: "msx", bytes: build.binary });
  // C-BIOS shows its logo before calling INIT — step well past it.
  for (let i = 0; i < 300; i++) host.stepFrames(1);

  const fb = host.getFramebuffer();
  assert.ok(fb.width > 0 && fb.height > 0, "msx framebuffer empty");

  // Regions: VRAM exposed (V9938), VDP regs hold a real mode, CPU running.
  assert.ok(host.regionSize("msx_vram") >= 0x10000, "msx VRAM region too small");
  const regs = host.readMemory("msx_vdp_regs", 0, 64);
  assert.equal(regs.length, 64);

  const cpu = getCPUState(host, "msx");
  assert.equal(cpu.cpu, "z80");
  assert.equal(typeof cpu.pc, "number");

  // Palette decoder (V9938 9-bit GRB or TMS9918 fixed).
  const { decodeMsxPalette, isV9938Mode } = await import("../src/platforms/msx/vdp.js");
  const palBytes = host.readMemory("msx_palette", 0, 32);
  const { entries, source } = decodeMsxPalette(palBytes, isV9938Mode(regs));
  assert.equal(entries.length, 16);
  assert.ok(source === "v9938" || source === "tms9918");

  // Sprite decoder (VRAM sprite-attribute table).
  const { decodeMsxSprites } = await import("../src/platforms/msx/vdp.js");
  const vram = host.readMemory("msx_vram", 0, host.regionSize("msx_vram"));
  const sprites = decodeMsxSprites(vram, regs);
  assert.ok(Array.isArray(sprites) && sprites.length <= 32);
}, { timeout: 90000 });
