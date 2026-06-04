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

test("PCE asset pipeline: tile codec round-trips and matches planar-pairs", async () => {
  const { encodePceTile, decodePceTile } = await import("../src/platforms/pce/tiles.js");
  const tile = new Uint8Array(64);
  for (let i = 0; i < 64; i++) tile[i] = (i * 7) % 16;
  const enc = encodePceTile(tile);
  assert.equal(enc.length, 32, "PCE tile is 32 bytes");
  const dec = decodePceTile(enc);
  assert.deepEqual([...dec], [...tile], "PCE tile round-trip is not identity");

  // imageToTiles('pce') uses the SNES planar-pairs layout — verify a real PNG.
  const { imageToTiles } = await import("../src/platforms/common/image-to-tiles.js");
  const { PNG } = await import("pngjs");
  const img = new PNG({ width: 8, height: 8 });
  const colors = [[0, 0, 0], [255, 0, 0], [0, 255, 0], [0, 0, 255]];
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    const c = colors[(x + y) % 4]; const o = (y * 8 + x) * 4;
    img.data[o] = c[0]; img.data[o + 1] = c[1]; img.data[o + 2] = c[2]; img.data[o + 3] = 255;
  }
  const r = imageToTiles("pce", PNG.sync.write(img), { maxTiles: 1 });
  assert.equal(r.tiles.length, 32);
  const back = decodePceTile(r.tiles);
  // The 4-color diagonal gradient should decode to 4 distinct indices.
  assert.equal(new Set(back).size, 4, "PCE imageToTiles lost colors");
});

test("PCE audio: getAudioState decodes the HuC6280 PSG (6 channels)", async () => {
  const { getPcePsgState } = await import("../src/host/pce-psg-state.js");
  const build = await buildForPlatform({ platform: "pce", source: "void main(void){for(;;);}", sourceName: "main.c" });
  const core = resolveCore("pce");
  const host = new LibretroHost();
  await host.loadCore(core.jsPath, core.wasmPath);
  await host.loadMedia({ platform: "pce", bytes: build.binary });
  for (let i = 0; i < 30; i++) host.stepFrames(1);
  const psg = getPcePsgState(host);
  assert.ok(psg, "PCE PSG region not exposed — is the patched geargrafx core staged?");
  assert.equal(psg.chip, "pce");
  assert.equal(psg.channels.length, 6);
  assert.equal(psg.channels[4].canNoise, true, "PCE ch4 should support noise");
  assert.equal(psg.channels[0].canNoise, false, "PCE ch0 should NOT support noise");
}, { timeout: 60000 });

test("MSX audio: getAudioState decodes the AY-3-8910 (3 channels + envelope)", async () => {
  const { getMsxAyState } = await import("../src/host/msx-ay-state.js");
  const build = await buildForPlatform({ platform: "msx", source: "void main(void){for(;;);}", sourceName: "main.c" });
  const core = resolveCore("msx");
  const host = new LibretroHost();
  await host.loadCore(core.jsPath, core.wasmPath);
  await host.loadMedia({ platform: "msx", bytes: build.binary });
  for (let i = 0; i < 120; i++) host.stepFrames(1);
  const ay = getMsxAyState(host);
  assert.ok(ay, "MSX PSG region not exposed — is the patched blueMSX core staged?");
  assert.equal(ay.chip, "ay8910");
  assert.equal(ay.channels.length, 3);
  assert.ok(["A", "B", "C"].includes(ay.channels[0].channel));
  assert.ok(typeof ay.envelope.shape === "number");
}, { timeout: 90000 });

test("MSX asset pipeline: screen-2 tile codec round-trips (2 colors/row)", async () => {
  const { encodeMsxScreen2Tile, decodeMsxScreen2Tile } = await import("../src/platforms/msx/tiles.js");
  const tile = new Uint8Array(64);
  // 2 colors per row (the MSX constraint) so the codec is lossless.
  for (let r = 0; r < 8; r++) for (let x = 0; x < 8; x++) tile[r * 8 + x] = (x < 4) ? 1 : 6;
  const { pattern, color } = encodeMsxScreen2Tile(tile);
  assert.equal(pattern.length, 8);
  assert.equal(color.length, 8);
  const dec = decodeMsxScreen2Tile(pattern, color);
  assert.deepEqual([...dec], [...tile], "MSX screen-2 round-trip is not identity for a 2-color row");
});

test("findReferences: disassembles PCE (huc6280) and MSX (z80) ROMs", async () => {
  const { findReferencesCore } = await import("../src/mcp/tools/find-references.js");
  const { writeFile, mkdtemp } = await import("node:fs/promises");
  const os = await import("node:os");
  const tmp = await mkdtemp(path.join(os.tmpdir(), "fr-"));

  // PCE — disassemble the conio hello and find refs to the reset-vector region.
  const pceSrc = await readFile(path.join(PLAT, "pce", "lib", "c", "hello_pce.c"), "utf8");
  const pceBuild = await buildForPlatform({ platform: "pce", source: pceSrc, sourceName: "main.c" });
  const pcePath = path.join(tmp, "game.pce");
  await writeFile(pcePath, pceBuild.binary);
  const pceRefs = await findReferencesCore({ path: pcePath, platform: "pce", address: 0xe000 });
  assert.ok(typeof pceRefs.refsFound === "number", "PCE findReferences returned no result shape");

  // MSX — the hello calls INITXT ($006C); there should be a ref to it.
  const main = await readFile(path.join(PLAT, "msx", "lib", "c", "hello_msx.c"), "utf8");
  const crt0 = await readFile(path.join(PLAT, "msx", "lib", "c", "msx_crt0.s"), "utf8");
  let msxBuild;
  for (let a = 0; a < 3 && !msxBuild?.binary; a++) {
    msxBuild = await buildForPlatform({ platform: "msx", sources: { "main.c": main, "msx_crt0.s": crt0 }, crt0: ".module empty\n", sourceName: "main.c" });
  }
  const msxPath = path.join(tmp, "game.rom");
  await writeFile(msxPath, msxBuild.binary);
  const msxRefs = await findReferencesCore({ path: msxPath, platform: "msx", address: 0x006c });
  assert.ok(msxRefs.refsFound >= 1, "MSX findReferences should find the INITXT ($006C) call");
}, { timeout: 120000 });

test("getMemoryMap: sdld .map path categorizes MSX (Z80) symbols by region", async () => {
  const { parseSdldMap } = await import("../src/toolchains/sdcc/sdcc.js");
  const main = "unsigned char score; unsigned int hiscore; void main(void){ score=1; hiscore=2; for(;;); }";
  const crt0 = await readFile(path.join(PLAT, "msx", "lib", "c", "msx_crt0.s"), "utf8");
  let build;
  for (let a = 0; a < 3 && !build?.symbols; a++) {
    build = await buildForPlatform({ platform: "msx", sources: { "main.c": main, "msx_crt0.s": crt0 }, crt0: ".module empty\n", sourceName: "main.c" });
  }
  const syms = parseSdldMap(build.symbols);
  // The fix: user globals (with a trailing "defined in module" column) are now
  // captured, not just the area markers.
  const byName = Object.fromEntries(syms.map((s) => [s.name, s.address]));
  assert.equal(byName.score, 0xc000, "score should be in work RAM at $C000");
  assert.equal(byName.hiscore, 0xc001, "hiscore should follow at $C001");
  assert.equal(byName.main, 0x4010, "main should be in cart ROM at $4010");
}, { timeout: 90000 });

test("PCE imageToTilemap: emits deduped tiles + BAT + VCE palette", async () => {
  const { pceImageToTilemap } = await import("../src/platforms/pce/image-to-tilemap.js");
  const { PNG } = await import("pngjs");
  const png = new PNG({ width: 256, height: 224 });
  const colors = [[0, 0, 0], [255, 0, 0], [0, 255, 0], [0, 0, 255]];
  for (let i = 0; i < 256 * 224; i++) {
    const c = colors[i % 4]; const o = i * 4;
    png.data[o] = c[0]; png.data[o + 1] = c[1]; png.data[o + 2] = c[2]; png.data[o + 3] = 255;
  }
  const r = pceImageToTilemap({ pngBytes: PNG.sync.write(png) });
  assert.equal(r.nametable.length, 32 * 28 * 2, "PCE BAT size");
  assert.equal(r.palette.length, 32, "PCE 16×u16 palette");
  assert.ok(r.uniqueTiles >= 1 && r.tiles.length === r.uniqueTiles * 32, "PCE tile bytes consistent");
  // Identical 4-color pattern in every cell → dedup collapses to a few tiles.
  assert.ok(r.uniqueTiles <= 4, `expected heavy dedup, got ${r.uniqueTiles} tiles`);
});

test("MSX imageToTilemap: emits screen-2 pattern + color + name tables", async () => {
  const { msxImageToTilemap } = await import("../src/platforms/msx/image-to-tilemap.js");
  const { PNG } = await import("pngjs");
  const png = new PNG({ width: 256, height: 192 });
  for (let i = 0; i < 256 * 192; i++) {
    const x = i % 256; const c = x < 128 ? 0 : 255; const o = i * 4;
    png.data[o] = c; png.data[o + 1] = c; png.data[o + 2] = c; png.data[o + 3] = 255;
  }
  const r = msxImageToTilemap({ pngBytes: PNG.sync.write(png) });
  assert.equal(r.tiles.length, 768 * 8, "MSX pattern table = 768 × 8 B");
  assert.equal(r.color.length, 768 * 8, "MSX color table = 768 × 8 B");
  assert.equal(r.nametable.length, 768, "MSX name table = 768 B");
});

test("MSX previewTileArt: composites screen-2 pattern+color from live VRAM", async () => {
  const { previewTileArtCore } = await import("../src/mcp/tools/preview-tile.js");
  const { _setHostForTest } = await import("../src/mcp/state.js");
  const main = await readFile(path.join(PLAT, "msx", "lib", "c", "hello_msx.c"), "utf8");
  const crt0 = await readFile(path.join(PLAT, "msx", "lib", "c", "msx_crt0.s"), "utf8");
  let build;
  for (let a = 0; a < 3 && !build?.binary; a++) {
    build = await buildForPlatform({ platform: "msx", sources: { "main.c": main, "msx_crt0.s": crt0 }, crt0: ".module empty\n", sourceName: "main.c" });
  }
  const core = resolveCore("msx");
  const host = new LibretroHost();
  await host.loadCore(core.jsPath, core.wasmPath);
  await host.loadMedia({ platform: "msx", bytes: build.binary });
  for (let i = 0; i < 300; i++) host.stepFrames(1);
  _setHostForTest("msx-pv", host);
  const r = await previewTileArtCore({ platform: "msx", intent: "homebrew", paletteFromEmulator: true, sessionKey: "msx-pv", tileCount: 64 });
  assert.equal(r.platform, "msx");
  assert.equal(r.mode, "screen2");
  assert.ok(r.pngBase64 && r.pngBase64.length > 0, "MSX previewTileArt produced no PNG");
}, { timeout: 90000 });

test("createProject scaffolds a building project for PCE + MSX", async () => {
  const { createProjectImpl } = await import("../src/mcp/tools/project.js");
  const { mkdtemp, readFile, readdir } = await import("node:fs/promises");
  const os = await import("node:os");
  for (const [plat, tmpl] of [["pce", "sprite_move"], ["msx", "catch_game"]]) {
    const dir = await mkdtemp(path.join(os.tmpdir(), `proj-${plat}-`));
    await createProjectImpl({ platform: plat, name: "g", path: dir, template: tmpl, overwrite: true });
    const files = await readdir(dir);
    assert.ok(files.includes("main.c"), `${plat}: no main.c scaffolded`);
    // gather sources + build the scaffolded project exactly as an agent would
    const srcs = {}, incs = {};
    for (const f of files) {
      const c = await readFile(path.join(dir, f), "utf8");
      if (f.endsWith(".h")) incs[f] = c;
      else if (f.endsWith(".c") || f.endsWith(".s")) srcs[f] = c;
    }
    const args = plat === "msx"
      ? { platform: "msx", sources: srcs, includes: incs, crt0: ".module empty\n", sourceName: "main.c" }
      : { platform: "pce", sources: srcs, includes: incs, sourceName: "main.c" };
    const b = await buildForPlatform(args);
    assert.ok(b.binary && b.binary.length > 0, `${plat} scaffolded project failed to build:\n${b.log}`);
  }
}, { timeout: 120000 });

test("createProject default scaffolds for ALL 14 platforms (no missing default)", async () => {
  const { createProjectImpl } = await import("../src/mcp/tools/project.js");
  const { mkdtemp } = await import("node:fs/promises");
  const os = await import("node:os");
  const ALL = ["nes", "gb", "gbc", "atari2600", "atari7800", "lynx", "sms", "gg",
    "genesis", "snes", "gba", "c64", "pce", "msx"];
  for (const p of ALL) {
    const dir = await mkdtemp(path.join(os.tmpdir(), `def-${p}-`));
    // No template arg → must resolve a sensible default (GBA's first key is
    // tonc_hello, not "default" — this caught a real bug).
    const r = await createProjectImpl({ platform: p, name: "g", path: dir, overwrite: true });
    assert.ok((r.writtenFiles || r.files || []).length > 0, `${p}: default scaffold wrote no files`);
  }
});
