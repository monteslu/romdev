// Unit tests for the SHARED debug machinery (scripts/romdev-debug/romdev_debug.c).
// This is the ~70% that used to be copy-pasted into every core; now it lives in one
// place, so its logic (watchpoint, conditional watchpoint, read-watch, coverage
// dedup, range triples, pcbreak freeze, watchdog, regsnap packing, hit-return) is
// guarded HERE — break the cov ring and this fails, not a runtime surprise in core #12.
//
// Compiles the lib + a tiny C harness with whatever C compiler is on PATH and runs
// it. Skips (does not fail) when no compiler is available, so CI without a toolchain
// stays green — the per-platform run-side tests still exercise it through real cores.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const LIB_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "romdev-debug");

function findCC() {
  for (const cc of ["cc", "gcc", "clang"]) {
    const r = spawnSync(cc, ["--version"], { stdio: "ignore" });
    if (r.status === 0) return cc;
  }
  return null;
}

// The harness asserts the lib's behavior natively; a non-zero exit = a failed assert.
const HARNESS = `
#include "romdev_debug.h"
#include <assert.h>
#include <stdio.h>
int main(void) {
  unsigned out[32], out2[2]; unsigned n; int i;

  /* watchpoint: only a WRITE to the armed addr fires; out packs [en,addr,pc,val,hits,romoff,old] */
  romdev_watchpoint_set(0x1234, 1);
  assert(romdev_on_write(0x1000, 0, 0x42, 0x8000, 0xFFFFFFFF) == 0);   /* miss → no hit */
  assert(romdev_on_write(0x1234, 5, 0x42, 0x8050, 0x12345) == 1);     /* hit → 1 */
  romdev_watchpoint_get(out, 0);
  assert(out[0]==1 && out[1]==0x1234 && out[2]==0x8050 && out[3]==0x42 && out[4]==1 && out[5]==0x12345 && out[6]==5);

  /* conditional watchpoint: cond 1 = increase, only fires when newv > oldv */
  romdev_watchpoint_set_cond(0x20, 1, 1, 0);
  assert(romdev_wp_wants_old() == 1);
  assert(romdev_on_write(0x20, 9, 3, 0x100, 0) == 0);  /* 3<9 → no */
  romdev_watchpoint_get(out, 1); assert(out[4]==0);
  assert(romdev_on_write(0x20, 3, 9, 0x200, 0) == 1);  /* 9>3 → yes */
  romdev_watchpoint_get(out, 0); assert(out[4]==1);

  /* read-watch */
  romdev_readwatch_set(0x60, 1);
  assert(romdev_on_read(0x10, 5, 0x300) == 0);
  assert(romdev_on_read(0x60, 7, 0x400) == 1);
  romdev_readwatch_get(out, 0); assert(out[0]==1 && out[1]==0x60 && out[2]==0x400 && out[3]==7 && out[4]==1);

  /* coverage: dedup distinct in-window PCs, count total dispatches in-window */
  romdev_cov_set(0x8000, 0x9000, 1);
  romdev_on_dispatch(0x8000); romdev_on_dispatch(0x8004); romdev_on_dispatch(0x8000); /* dup */
  romdev_on_dispatch(0xA000); /* out of window — ignored */
  n = romdev_cov_get(out, 32, out2);
  assert(n==2 && out2[0]==2 && out2[1]==3);

  /* range: interleaved triples [pc,addr,val,...], out2=[total,stored] */
  romdev_range_set(0x6000, 0x6010, 3, 1);
  romdev_on_write(0x6000, 0, 0xAB, 0x300, 0);
  romdev_on_read(0x6004, 0xCD, 0x304);
  n = romdev_range_get(out, 32, out2);
  assert(n==2 && out2[0]==2 && out2[1]==2);
  assert(out[0]==0x300 && out[1]==0x6000 && out[2]==0xAB);
  assert(out[3]==0x304 && out[4]==0x6004 && out[5]==0xCD);

  /* pcbreak: fires at addr, freezes, stays frozen until cleared; out11 */
  romdev_pcbreak_set(0x8100, 1, 0);
  assert(romdev_on_dispatch(0x8050) == 0);
  assert(romdev_on_dispatch(0x8100) == 1);
  assert(romdev_on_dispatch(0x8104) == 1);   /* still frozen */
  romdev_pcbreak_get(out, 1); assert(out[0]==1 && out[1]==0x8100 && out[2]==1 && out[3]==0x8100);
  assert(romdev_on_dispatch(0x8108) == 0);   /* cleared → runs again */

  /* watchdog: trips after limit instructions */
  romdev_pcbreak_set(0,0,0); romdev_watchdog_set(3);
  assert(romdev_on_dispatch(1)==0 && romdev_on_dispatch(2)==0 && romdev_on_dispatch(3)==1);
  romdev_pcbreak_get(out, 1); assert(out[5]==1);

  /* single-step: one instruction runs, then freeze */
  romdev_pcbreak_set(0, 0, 1); romdev_watchdog_set(0);
  assert(romdev_on_dispatch(0x100)==0);   /* the one allowed instruction */
  assert(romdev_on_dispatch(0x104)==1);   /* step fires */

  /* regsnap: host reads [kind, count=19, regs0..18] = 21 words */
  for (i = 0; i < ROMDEV_SNAP_REGS; i++) romdev_snap_regs[i] = 0x100 + i;
  romdev_snap_kind = 3;
  romdev_regsnap_get(out, 0);
  assert(out[0]==3 && out[1]==19 && out[2]==0x100 && out[20]==(unsigned)(0x100+18));

  printf("ALL ROMDEV_DEBUG LIB TESTS PASSED\\n");
  return 0;
}
`;

test("shared romdev_debug.c — watchpoint/cov/range/pcbreak/watchdog/regsnap logic", { timeout: 60000 }, async () => {
  const cc = findCC();
  if (!cc) { console.log("no C compiler on PATH; skipping (per-platform run-side tests cover it via real cores)"); return; }

  const dir = await mkdtemp(path.join(tmpdir(), "romdev-dbg-"));
  try {
    const harnessPath = path.join(dir, "harness.c");
    const binPath = path.join(dir, "harness");
    await writeFile(harnessPath, HARNESS);
    // compile the lib + harness together
    execFileSync(cc, ["-std=c89", "-Wall", "-Werror", `-I${LIB_DIR}`,
      path.join(LIB_DIR, "romdev_debug.c"), harnessPath, "-o", binPath], { stdio: "pipe" });
    const out = execFileSync(binPath, [], { encoding: "utf8" });
    assert.match(out, /ALL ROMDEV_DEBUG LIB TESTS PASSED/, `harness output: ${out}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
