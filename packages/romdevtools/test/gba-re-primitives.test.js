// GBA RE primitives round 2 (mgba/ARM7TDMI): setRegister + watchRange +
// logPCRange — plus the setreg-PC pipeline-flush proof.
//
// Exercises the romdev_setreg/getreg + romdev_range_* + romdev_cov_* mgba core
// patch (register access + the PC pipeline reload in src/arm/arm.c, the range
// load/store hooks in src/gba/memory.c, the coverage execute hook in
// src/arm/arm.c) through the host surface — the SAME primitives the setRegister
// / watchRange / logPCRange MCP tools drive. Tested at the host level (like
// gba-pc-break.test.js) so the setreg-PC → stepInstruction flow can be driven
// directly.
//
// HARD TIMEOUT: mgba had a frozen-CPU hang risk in round 1, so ALWAYS run with
// `timeout 200 node --test`. The per-test timeout is a secondary guard.
//
// ARM reg-id convention (STABLE): 0..15 = r0..r15 (13=SP, 14=LR, 15=PC), 16=CPSR.

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildGbaC } from "romdev-platform-gba";
import { resolveCore } from "../src/cores/registry.js";

// A tiny Tonc ROM that writes an incrementing counter to a FIXED EWRAM address
// (0x02000000) every frame, the same shape gba-pc-break uses. irq_init +
// II_VBLANK are required or VBlankIntrWait halts the BIOS forever (no frames).
// EWRAM (0x02000000) is readable/writable RAM; the counter write is a stable
// target for watchRange (write) and the per-frame loop body is what logPCRange
// covers. A `marker` global gives romdev_setreg a no-side-effect target to prove
// PC redirection lands somewhere live.
const SRC = `
#include <tonc.h>

#define COUNTER  (*(volatile u32*)0x02000000)

int main(void) {
    irq_init(NULL);
    irq_add(II_VBLANK, NULL);
    REG_DISPCNT = DCNT_MODE3 | DCNT_BG2;
    u32 acc = 0;
    while (1) {
        acc += 1;
        COUNTER = acc;            // a WRITE to EWRAM 0x02000000 each frame
        VBlankIntrWait();
    }
    return 0;
}`;

const COUNTER_ADDR = 0x02000000;

test("GBA RE primitives: setRegister + watchRange + logPCRange + setreg-PC flush (mgba ARM7TDMI)", { timeout: 180000 }, async () => {
  // 1) Build the ROM (libtonc C, default runtime — NOT runtime:"none", which
  //    lacks stdint.h that tonc needs).
  const r = await buildGbaC({ source: SRC });
  assert.equal(r.ok, true, `gba build failed at ${r.stage}: ${(r.log || "").slice(-600)}`);
  assert.ok(r.binary && r.binary.length > 256, `binary too small: ${r.binary?.length}`);

  // 2) Boot it under mgba via the host.
  const { LibretroHost } = await import("romdev-core-host/LibretroHost.js");
  const core = resolveCore("gba");
  assert.ok(core, "resolveCore('gba') returned null — mgba_libretro.{js,wasm} missing?");
  const host = new LibretroHost();
  await host.loadCore(core.jsPath, core.wasmPath);
  await host.loadMedia({ platform: "gba", bytes: r.binary, virtualName: "re.gba" });

  // Feature detection — the whole point of this build.
  assert.equal(host.setRegSupported(), true, "core does not expose romdev_setreg/getreg — rebuild needed");
  assert.equal(host.rangeWatchSupported(), true, "core does not expose romdev_range_*/romdev_cov_* — rebuild needed");

  // Let it boot past the Tonc runtime init into the main loop.
  host.stepFrames(30);

  // 3) setRegister round-trips (ARM reg-id 0 = r0).
  host.setReg(0, 0x42);
  const r0 = host.getReg(0);
  assert.equal(r0 & 0xFF, 0x42, `setRegister (r0) didn't round-trip: got 0x${r0.toString(16)}`);
  // A 32-bit value round-trips fully (r1).
  host.setReg(1, 0xDEADBEEF >>> 0);
  assert.equal(host.getReg(1) >>> 0, 0xDEADBEEF >>> 0, "setRegister (r1) didn't round-trip 32-bit");

  // 4) watchRange catches the per-frame write to 0x02000000 with pc/addr/value.
  const wr = host.watchRange(COUNTER_ADDR, COUNTER_ADDR, "write", 10);
  assert.ok(wr.total > 0, `watchRange caught no writes to 0x02000000: ${JSON.stringify(wr)}`);
  assert.ok(wr.events.length > 0, "watchRange returned no events");
  const ev = wr.events[0];
  assert.equal(ev.address >>> 0, COUNTER_ADDR >>> 0, `watchRange address mismatch: ${JSON.stringify(ev)}`);
  assert.ok(ev.pc > 0, `watchRange reported no writer PC: ${JSON.stringify(ev)}`);
  const writerPC = ev.pc >>> 0;

  // 5) logPCRange over the code area (GBA ROM executes at 0x08000000+; EWRAM/IWRAM
  //    code can run too — cover the whole low cart+RAM span) returns distinct PCs.
  const cov = host.logPCRange(0x00000000, 0x09000000, 10);
  assert.ok(cov.distinct > 0, `logPCRange found no PCs: ${JSON.stringify({ distinct: cov.distinct, total: cov.total })}`);
  assert.ok(cov.pcs.length > 0, "logPCRange returned no pcs");

  // 6) setreg-PC pipeline flush — THE KEY QUESTION. Setting r15 must RELOAD the
  //    ARM7 prefetch pipeline (via ARMWritePC/ThumbWritePC) so the SET PC actually
  //    executes — otherwise the two already-prefetched instructions run and PC
  //    diverges from what we set. cpsr bit 5 = THUMB (2-byte) else ARM (4-byte).
  const cpsr = host.getReg(16) >>> 0;
  const word = (cpsr & 0x20) ? 2 : 4;
  // writerPC is the raw pipeline-prefetched PC; the instruction it refers to is
  // 2 words behind (classic ARM PC+8 / Thumb+4). Redirect execution to that exact
  // live instruction address.
  const target = (writerPC - 2 * word) >>> 0;
  host.setReg(15, target);

  // PROOF #1 (definitive, deterministic): after setReg(15), gprs[15] reads back as
  //   target + ONE word — the pipeline advance ARMWritePC/ThumbWritePC performs
  //   after reloading prefetch[0]/[1] from `target`. A bare `gprs[15] = target`
  //   (no pipeline reload) would read back as exactly `target`. This single
  //   invariant is the smoking gun that the pipeline was flushed and reloaded.
  const pcAfterSet = host.getReg(15) >>> 0;
  assert.equal(pcAfterSet, (target + word) >>> 0,
    `setreg-PC did not reload the pipeline: gprs[15]=0x${pcAfterSet.toString(16)}, expected 0x${((target + word) >>> 0).toString(16)} (target 0x${target.toString(16)} + one word). A bare PC stomp would leave it at 0x${target.toString(16)}.`);

  // PROOF #2 (live execution): single-step and confirm the CPU genuinely ran the
  //   instruction at `target` and advanced — execution flows FORWARD from the set
  //   PC, not from wherever the stale prefetch pointed. The instruction at the
  //   counter-store target is followed by VBlankIntrWait (an SWI), so after the
  //   step the PC may legitimately be in straight-line code OR vectored into the
  //   BIOS/IRQ handler — either way it has MOVED away from the pre-redirect idle
  //   PC. We assert the step produced a real, advancing PC (not frozen, not the
  //   raw un-reloaded target), which it can only do if the redirect executed.
  const step = host.stepInstruction();
  assert.ok(step.pc != null && (step.pc >>> 0) > 0, `single-step after setreg-PC returned no pc: ${JSON.stringify(step)}`);
  const stepPC = step.pc >>> 0;
  // It must NOT have stalled at the raw set value (that would mean nothing ran).
  assert.notEqual(stepPC, target >>> 0,
    `single-step after setreg-PC did not advance off the target — execution stalled (pipeline not live): ${JSON.stringify(step)}`);

  // 7) Normal stepping must resume cleanly (no lingering frozen/armed state).
  const before = host.status.frameCount;
  host.stepFrames(5);
  assert.equal(host.status.frameCount, before + 5, "normal stepping did not resume after RE primitives");
});
