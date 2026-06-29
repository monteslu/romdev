// ABI conformance: every core that consumes the shared romdev_debug.c MUST export
// the full romdev_* debug ABI the host (LibretroHost.js) feature-detects. This is
// the test that turns ABI DRIFT into a test failure instead of a runtime surprise —
// the other half of the point of the shared-lib refactor. If a migration drops an
// export, or a future core links the lib but forgets to list a symbol in
// EXPORTED_FUNCTIONS, this fails loudly here.
//
// We load each migrated core's wasm and assert the symbols are callable. Cores are
// skipped (not failed) when their wasm isn't staged locally, so a partial checkout
// doesn't break the run.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadLibretroCore } from "../src/host/coreLoader.js";

const WASM_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "cores", "wasm");

// The shared-lib exports EVERY migrated core must carry (Part 1 of romdev_debug.h).
const SHARED_ABI = [
  "_romdev_watchpoint_set", "_romdev_watchpoint_set_cond", "_romdev_watchpoint_get",
  "_romdev_readwatch_set", "_romdev_readwatch_get",
  "_romdev_pcbreak_set", "_romdev_pcbreak_get", "_romdev_watchdog_set",
  "_romdev_cov_set", "_romdev_cov_get",
  "_romdev_range_set", "_romdev_range_get",
  "_romdev_regsnap_get", "_romdev_irqblock_set",
];

// The cores migrated to the shared lib (0.80.0 pilots). As more cores migrate, add
// them here — the test then guards their ABI too. `extra` = per-core exports that
// must ALSO be present (the genuinely per-core debug surface kept in each patch).
const MIGRATED_CORES = [
  { core: "gambatte_libretro",        extra: ["_romdev_setreg", "_romdev_getreg"] },
  { core: "fceumm_libretro",          extra: ["_romdev_setreg", "_romdev_getreg", "_romdev_vramwatch_set", "_romdev_vramwatch_get"] },
  { core: "genesis_plus_gx_libretro", extra: ["_romdev_setreg", "_romdev_getreg", "_romdev_vramwatch_set", "_romdev_dmawatch_set", "_romdev_run_pure"] },
  { core: "snes9x_libretro",          extra: ["_romdev_setreg", "_romdev_getreg", "_romdev_vramwatch_set", "_romdev_vramwatch_get"] },
  { core: "vice_x64_libretro",        extra: ["_romdev_setreg", "_romdev_getreg", "_romdev_disk_export", "_romdev_key_matrix", "_romdev_joyport_get"] },
  { core: "prosystem_libretro",       extra: ["_romdev_setreg", "_romdev_getreg"] },
  { core: "stella2014_libretro",      extra: ["_romdev_setreg", "_romdev_getreg"] },
  { core: "geargrafx_libretro",       extra: ["_romdev_setreg", "_romdev_getreg", "_romdev_vramwatch_set", "_romdev_vramwatch_get"] },
];

for (const { core, extra } of MIGRATED_CORES) {
  test(`ABI: ${core} exports the full shared romdev_debug surface`, { timeout: 60000 }, async () => {
    const jsPath = path.join(WASM_DIR, `${core}.js`);
    const wasmPath = path.join(WASM_DIR, `${core}.wasm`);
    if (!existsSync(jsPath) || !existsSync(wasmPath)) {
      console.log(`${core} wasm not staged locally; skipping (build it to run this)`);
      return;
    }
    const mod = await loadLibretroCore({ jsPath, wasmPath });
    const missing = [...SHARED_ABI, ...extra].filter((s) => typeof mod[s] !== "function");
    assert.deepEqual(missing, [], `${core} is missing romdev_* exports: ${missing.join(", ")}`);
  });
}
