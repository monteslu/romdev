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
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadLibretroCore } from "../src/host/coreLoader.js";

const PKG_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const WASM_DIR = path.join(PKG_ROOT, "src", "cores", "wasm");
// Some cores ship only from their carved-out binary package (the registry resolves
// those first); look there too so the ABI check isn't silently skipped.
function resolveWasm(core) {
  const dev = path.join(WASM_DIR, `${core}.js`);
  if (existsSync(dev)) return { jsPath: dev, wasmPath: path.join(WASM_DIR, `${core}.wasm`) };
  // fall back to a sibling binary package's wasm/ dir (romdev-core-* / romdev-platform-*)
  const pkgsDir = path.join(PKG_ROOT, "..");
  if (existsSync(pkgsDir)) {
    for (const entry of readdirSync(pkgsDir)) {
      const cand = path.join(pkgsDir, entry, "wasm", `${core}.js`);
      if (existsSync(cand)) return { jsPath: cand, wasmPath: path.join(pkgsDir, entry, "wasm", `${core}.wasm`) };
    }
  }
  return null;
}

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
  { core: "bluemsx_libretro",         extra: ["_romdev_setreg", "_romdev_getreg", "_romdev_vramwatch_set", "_romdev_vramwatch_get"] },
  { core: "mgba_libretro",            extra: ["_romdev_setreg", "_romdev_getreg"] },
  // handy (Lynx 65C02) — the last inline holdout, now on the shared lib. The CPU_PEEK
  // read hook MUST evaluate the (side-effecting) I/O read exactly once; see the patch.
  { core: "handy_libretro",           extra: ["_romdev_setreg", "_romdev_getreg"] },
  // The newer cores migrated their divergent debug snippets onto the shared lib too.
  // MIPS cores read CPU state via romdev_mips_regs_get (no setReg/getReg); they ship
  // from their own binary packages (resolveWasm falls back to those).
  { core: "parallel_n64_libretro",    extra: ["_romdev_mips_regs_get", "_romdev_ai_get"] },
  // PS1: beetle_psx_hw is the ONE PS1 core — GPU (GL) + the full debug surface, after
  // the pcsx_rearmed split was collapsed. (mips_regs_get/spu_get are the R3000/SPU readers.)
  { core: "beetle_psx_hw_libretro",   extra: ["_romdev_mips_regs_get", "_romdev_spu_get"] },
];

for (const { core, extra } of MIGRATED_CORES) {
  test(`ABI: ${core} exports the full shared romdev_debug surface`, { timeout: 60000 }, async () => {
    const resolved = resolveWasm(core);
    if (!resolved || !existsSync(resolved.wasmPath)) {
      console.log(`${core} wasm not staged locally; skipping (build it to run this)`);
      return;
    }
    const mod = await loadLibretroCore(resolved);
    const missing = [...SHARED_ABI, ...extra].filter((s) => typeof mod[s] !== "function");
    assert.deepEqual(missing, [], `${core} is missing romdev_* exports: ${missing.join(", ")}`);
  });
}
