// GBA (mgba / ARM7TDMI) callSubroutine instruction WATCHDOG — the fix for the
// "callSubroutine hung" black box. A routine that loops FOREVER (e.g. a codec
// fed a wrong pointer) spins inside one retro_run frame, so the host's per-frame
// cap can't catch it. The core's instruction watchdog (src/arm/arm.c) counts
// dispatched instructions and force-stops at the budget, ending the frame the
// SAME way the PC breakpoint does (romdev_end_frame: bump cpu->cycles, NO
// processEvents — so the VBlank IRQ never fires and rewrites the frozen PC). The
// host then returns { returned:false, watchdog:true, finalPC } instead of hanging.
//
// GBA has no buildSourceWithDebug/resolveSymbol wiring (it's the ARM GCC
// toolchain, not cc65/SDCC), so — exactly like gba-pc-break.test.js — we build
// with buildGbaC, boot under mgba via the host, and discover the spin loop's PC
// self-referentially via the write watchpoint (findWriter): the spin loop writes
// a marker to a fixed EWRAM address every iteration, so the watched PC IS an
// instruction inside the infinite loop. No symbol map needed; deterministic.
//
// HARD TIMEOUT: a watchdog bug (or a frozen CPU that doesn't end the frame) would
// hang retro_run forever, so this MUST be run with `timeout 180 node --test`. The
// per-test timeout is only a secondary guard.

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildGbaC } from "../src/toolchains/gba-c/gba-c.js";
import { resolveCore } from "../src/cores/registry.js";

// A tiny Tonc ROM. main() seeds the runtime, then enters an INFINITE loop that
// writes an incrementing marker to a FIXED EWRAM address (0x02000000) every
// iteration and never exits — the runaway shape callSubroutine must not hang on.
// (No VBlankIntrWait inside the spin: this is a genuine tight CPU loop, the worst
// case for the watchdog.) The store to 0x02000000 gives findWriter a real ARM PC
// that lives INSIDE the loop, which we then feed to callSubroutine as the entry.
const SRC = `
#include <tonc.h>

#define MARKER (*(volatile u32*)0x02000000)

int main(void) {
    REG_DISPCNT = DCNT_MODE3 | DCNT_BG2;
    u32 acc = 0;
    while (1) {            // spins FOREVER — the callSubroutine hang case
        acc += 1;
        MARKER = acc;      // a WRITE to EWRAM 0x02000000 every iteration
    }
    return 0;
}`;

const MARKER_ADDR = 0x02000000;

test("GBA watchdog: infinite-loop routine returns {watchdog:true} (mgba ARM7TDMI)", { timeout: 150000 }, async () => {
  // 1) Build the ROM.
  const r = await buildGbaC({ source: SRC });
  assert.equal(r.ok, true, `gba build failed at ${r.stage}: ${(r.log || "").slice(-600)}`);
  assert.ok(r.binary && r.binary.length > 256, `binary too small: ${r.binary?.length}`);

  // 2) Boot it under mgba via the host (mirrors what runSource does internally).
  const { LibretroHost } = await import("../src/host/LibretroHost.js");
  const core = resolveCore("gba");
  assert.ok(core, "resolveCore('gba') returned null — mgba_libretro.{js,wasm} missing?");
  const host = new LibretroHost();
  await host.loadCore(core.jsPath, core.wasmPath);
  await host.loadMedia({ platform: "gba", bytes: r.binary, virtualName: "wd.gba" });

  // Feature detection — the whole point of this build.
  assert.equal(host.pcBreakSupported(), true, "core does not expose romdev_pcbreak_* — rebuild needed");
  assert.equal(host.watchdogSupported(), true, "core does not expose romdev_watchdog_set — rebuild needed");
  assert.equal(host.setRegSupported(), true, "core does not expose romdev_setreg — callSubroutine needs it");

  // Let it boot past the Tonc runtime init into main()'s spin loop. (Each
  // stepFrames is a bounded retro_run; the spin itself never ends a frame on its
  // own, but the GBA frame loop's cycle budget still returns control per frame.)
  host.stepFrames(20);

  // 3) findWriter on 0x02000000 → the EXACT instruction PC inside the spin loop
  //    that writes the marker. (Confirms the write watch works AND gives a real
  //    entry PC that is genuinely inside an infinite loop.)
  host.setWatchpoint(MARKER_ADDR, true);
  let spinPC = null;
  for (let i = 0; i < 120; i++) {
    host.stepFrames(1);
    const w = host.getWatchpoint(false);
    if (w.hits > 0) { spinPC = w.lastPC >>> 0; break; }
  }
  host.setWatchpoint(0, false);
  assert.ok(spinPC != null && spinPC > 0, `findWriter didn't catch the 0x02000000 write (spinPC=${spinPC})`);

  // The watchpoint reports the RAW pipeline-prefetched gprs[ARM_PC] (= the
  // executing instruction's address + 2*wordsize). Tonc builds -mthumb, so the
  // CPU is in THUMB mode here (2-byte words → raw PC = instrAddr + 4). To enter
  // the loop cleanly via callSubroutine we need the ACTUAL instruction address
  // (raw - 4) and we must set THUMB mode by ORing bit 0 (otherwise the pipeline
  // reload would switch to ARM and run the thumb bytes as garbage). Confirm we're
  // really in THUMB before applying the offset.
  const regs0 = host.readMemory("gba_cpu_regs", 0, 80);
  const dv0 = new DataView(regs0.buffer, regs0.byteOffset, regs0.byteLength);
  const thumb = !!(dv0.getUint32(16 * 4, true) & 0x20); // cpsr T bit
  assert.equal(thumb, true, "expected THUMB mode (Tonc builds -mthumb) — entry-offset math assumes it");
  const instrAddr = (spinPC - 4) >>> 0; // raw → executing-instruction address (THUMB)
  const entryPC = (instrAddr | 1) >>> 0; // set THUMB bit so the pipeline reload stays THUMB

  // 4) THE WATCHDOG. Drive the infinite-loop routine via callSubroutine with
  //    sandbox:false (arm breakpoint + run; no stack-seeding restore — the routine
  //    never returns). entryPC lands inside the spin loop, so it can never reach
  //    the sentinel; only the instruction watchdog can stop it. If the watchdog
  //    were missing/broken this HANGS — the outer `timeout 180` kills it. With the
  //    watchdog it returns { returned:false, watchdog:true, finalPC inside the
  //    loop }. maxFrames is high but the watchdog (maxInstructions) is what
  //    actually stops it well before that — proving the per-frame cap is NOT what
  //    saved us (framesRun ends up tiny: 200k instrs ≈ a handful of frames).
  const wd = host.callSubroutine({
    pc: entryPC, maxFrames: 600, maxInstructions: 200000, sandbox: false,
  });

  assert.equal(wd.returned, false, "spin should not 'return': " + JSON.stringify(wd));
  assert.equal(wd.watchdog, true, "watchdog must trip on an infinite loop (no hang): " + JSON.stringify(wd));
  assert.ok(wd.finalPCRaw != null, "watchdog must report finalPC (where it's stuck): " + JSON.stringify(wd));

  // finalPC must be parked INSIDE the spin loop (the runaway was genuinely
  // looping when the watchdog fired). The loop body is a handful of THUMB
  // instructions; finalPC is the raw pipeline PC, so a small window around the
  // discovered spinPC is the right assertion (NOT exact equality — the watchdog
  // trips on whatever instruction happens to be dispatching at the budget).
  const finalPC = wd.finalPCRaw >>> 0;
  const dist = Math.abs((finalPC | 0) - (spinPC | 0));
  assert.ok(dist <= 32,
    `watchdog finalPC (0x${finalPC.toString(16)}) should be parked in the spin loop ` +
    `(near 0x${spinPC.toString(16)}); distance=${dist} — expected the runaway to be looping`);

  console.log("GBA watchdog OK:", JSON.stringify({
    returned: wd.returned, watchdog: wd.watchdog, finalPC: wd.finalPC,
    spinPC: "0x" + spinPC.toString(16), entryPC: "0x" + entryPC.toString(16), framesRun: wd.framesRun,
  }));

  // 5) After the watchdog tripped + the host disarmed, normal stepping must resume
  //    cleanly (no lingering frozen/armed state → no hang on subsequent frames).
  const before = host.status.frameCount;
  host.stepFrames(5);
  assert.equal(host.status.frameCount, before + 5, "normal stepping did not resume after the watchdog");
});
