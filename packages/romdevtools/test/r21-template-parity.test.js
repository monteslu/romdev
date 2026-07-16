// R21 template-parity smoke tests. Confirms every new template
// (Genesis SGDK hello_sprite/tile_engine/shmup/platformer/puzzle,
// SNES PVSnesLib hello_sprite/shmup/platformer/puzzle, GB SDCC sm83
// shmup/platformer/puzzle) compiles to a valid ROM via its toolchain.
//
// Tests live under test/ rather than src/ because they exercise the
// build pipeline end-to-end (cold-load cc1.wasm/tcc-65816.wasm/sdcc.wasm)
// and would slow down the per-module test loop if they were in src/.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

const GENESIS_TEMPLATES = ["sgdk_hello", "hello_sprite", "tile_engine", "shmup", "platformer", "puzzle", "two_plane_parallax"];
const SNES_TEMPLATES = ["hello_sprite", "shmup", "platformer", "puzzle"];
const GB_TEMPLATES = ["shmup", "platformer", "puzzle"];

async function readSource(rel) {
  return readFile(join(REPO_ROOT, rel), "utf-8");
}

test("R21 Genesis SGDK templates: all compile to valid ROMs", { timeout: 180000 }, async () => {
  const { buildGenesisC } = await import("../src/toolchains/genesis-c/genesis-c.js");
  // R30: genre scaffolds now use genesis_sfx — provide it alongside main.c.
  const sfxH = await readSource("../romdev-toolchain-m68k-gcc/share/genesis/lib/c/genesis_sfx.h");
  const sfxC = await readSource("../romdev-toolchain-m68k-gcc/share/genesis/lib/c/genesis_sfx.c");
  for (const t of GENESIS_TEMPLATES) {
    const src = await readSource(`examples/genesis/templates/${t}.c`);
    const needsSfx = src.includes("genesis_sfx.h");
    const r = needsSfx
      ? await buildGenesisC({ sources: { "main.c": src, "genesis_sfx.c": sfxC }, headers: { "genesis_sfx.h": sfxH }, sgdk: true })
      : await buildGenesisC({ source: src, sgdk: true });
    assert.equal(r.ok, true, `${t} build failed at ${r.stage}: ${(r.log || "").slice(-300)}`);
    assert.equal(r.runtime, "sgdk");
    // SEGA header must be at $100
    const headerStart = Buffer.from(r.binary.subarray(0x100, 0x110)).toString("ascii");
    assert.equal(headerStart, "SEGA MEGA DRIVE ", `${t}: missing SEGA header`);
    // Reasonable size sanity (SGDK projects are 350-500 KB)
    assert.ok(r.binary.length > 300_000 && r.binary.length < 600_000,
      `${t}: unexpected binary size ${r.binary.length}`);
  }
});

test("R21 SNES PVSnesLib templates: all compile to valid ROMs", { timeout: 180000 }, async () => {
  const { buildSnesC } = await import("../src/toolchains/snes-c/snes-c.js");
  // R31: SNES genre scaffolds now include snes_sfx — provide it.
  const sfxH = await readSource("src/platforms/snes/lib/c/snes_sfx.h");
  const sfxC = await readSource("src/platforms/snes/lib/c/snes_sfx.c");
  const sfxDataAsm = await readSource("src/platforms/snes/lib/c/snes_sfx_data.asm");
  const { readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const apuBlob = await readFile(join(REPO_ROOT, "src/platforms/snes/lib/audio/apu_blob.bin"));
  for (const t of SNES_TEMPLATES) {
    const main = await readSource(`examples/snes/templates/${t}.c`);
    const data = await readSource(`examples/snes/templates/${t}-data.asm`);
    const needsSfx = main.includes("snes_sfx");
    const sources = needsSfx
      ? { "main.c": main, "data.asm": data, "snes_sfx_data.asm": sfxDataAsm }
      : { "main.c": main, "data.asm": data };
    const headers = needsSfx ? { "snes_sfx.h": sfxH, "snes_sfx.c": sfxC } : undefined;
    const binaryIncludes = needsSfx ? { "apu_blob.bin": new Uint8Array(apuBlob) } : undefined;
    const r = await buildSnesC({ sources, headers, binaryIncludes, pvsneslib: true });
    assert.equal(r.ok, true, `${t} build failed at ${r.stage}: ${(r.log || "").slice(-300)}`);
    // Reasonable size sanity (LoROM ≥ 32 KB).
    assert.ok(r.binary.length >= 32_768, `${t}: ROM too small: ${r.binary.length}`);
  }
});

test("R21 Game Boy SDCC sm83 templates: all compile to valid ROMs", { timeout: 180000 }, async () => {
  const { buildForPlatform } = await import("../src/toolchains/index.js");
  const runtimeC = await readSource("src/platforms/gb/lib/c/gb_runtime.c");
  const runtimeH = await readSource("src/platforms/gb/lib/c/gb_runtime.h");
  const hwH      = await readSource("src/platforms/gb/lib/c/gb_hardware.h");
  for (const t of GB_TEMPLATES) {
    const main = await readSource(`examples/gb/templates/${t}.c`);
    const r = await buildForPlatform({
      platform: "gb",
      language: "c",
      sources: { "main.c": main, "gb_runtime.c": runtimeC },
      includes: { "gb_runtime.h": runtimeH, "gb_hardware.h": hwH },
    });
    assert.equal(r.ok, true, `${t} build failed at ${r.stage || "?"}: ${(r.log || "").slice(-300)}`);
    assert.ok(r.binary.length >= 16384, `${t}: ROM too small: ${r.binary.length}`);
  }
});
