// Packaging contract for the N64/PS1 cores + MIPS toolchain. These ship as separate
// npm packages (romdev-core-pcsx-rearmed, romdev-core-parallel-n64,
// romdev-toolchain-mips-gcc); this pins the shape a consumer relies on so a bad
// build/pack can't silently ship (the "pcsx_vram.wasm" baked-name bug that the
// npm-pack smoke test caught).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PKGS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const CORE_PKGS = [
  { dir: "romdev-core-pcsx-rearmed", platform: "ps1", coreName: "pcsx_rearmed" },
  { dir: "romdev-core-parallel-n64", platform: "n64", coreName: "parallel_n64" },
];

for (const { dir, platform, coreName } of CORE_PKGS) {
  test(`packaging: ${dir} ships a self-consistent core`, () => {
    const base = path.join(PKGS, dir);
    if (!existsSync(base)) { console.log(`${dir} not present; skipping`); return; }
    const pkg = JSON.parse(readFileSync(path.join(base, "package.json"), "utf8"));
    // files allowlist ships index.js + wasm/ + README
    assert.ok(pkg.files?.includes("wasm") && pkg.files?.includes("index.js"), "files allowlist ships index.js + wasm/");
    assert.ok(pkg.scripts?.prepublishOnly?.includes("verify-wasm"), "prepublishOnly runs verify-wasm");
    // the glue + wasm exist under the published names
    const glue = path.join(base, "wasm", `${coreName}_libretro.js`);
    const wasm = path.join(base, "wasm", `${coreName}_libretro.wasm`);
    assert.ok(existsSync(glue), `${coreName}_libretro.js present`);
    assert.ok(existsSync(wasm), `${coreName}_libretro.wasm present`);
    // CRITICAL: the glue must reference its OWN published wasm name (not a dev scratch
    // name like pcsx_vram.wasm) — else a consumer that loads the factory without the
    // host's wasmBinary override gets ENOENT.
    const glueText = readFileSync(glue, "utf8");
    assert.ok(glueText.includes(`${coreName}_libretro.wasm`),
      `${coreName}_libretro.js references its own wasm name (not a dev scratch name)`);
    // index.js exports the registry shape
    const idx = readFileSync(path.join(base, "index.js"), "utf8");
    assert.ok(idx.includes(`platform = "${platform}"`) && idx.includes(`${coreName}_libretro.js`),
      "index.js exports platform + core{jsPath,wasmPath}");
  });
}
