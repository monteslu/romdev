// GBA PC breakpoint / read watchpoint / single-step — end to end (mgba, ARM7TDMI).
//
// Exercises the romdev_pcbreak_* / romdev_readwatch_* mgba core patch (the
// ARM7 execute hook in src/arm/arm.c + the read hook in src/gba/memory.c)
// through the host surface — the same primitives the runUntilPC / runUntilRead /
// stepInstruction MCP tools drive. The breakpoint PC is discovered
// self-referentially via the write watchpoint (findWriter), so the test needs
// no symbol map and is deterministic.
//
// HARD TIMEOUTS everywhere: a frozen-CPU breakpoint that doesn't end the frame
// would hang retro_run forever, so the test must be run with `timeout 150 node
// --test`. The per-test timeout is a secondary guard.

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildGbaC } from "romdev-platform-gba";
import { resolveCore } from "../src/cores/registry.js";

// A tiny Tonc ROM that writes an incrementing counter to a FIXED EWRAM address
// (0x02000000) every frame. The store instruction's PC is a stable breakpoint
// target we discover via the write watchpoint. irq_init + II_VBLANK are required
// or VBlankIntrWait halts the BIOS forever (no frames). EWRAM (0x02000000) is
// readable/writable RAM; findWriter on it yields a real ARM PC.
const SRC = `
#include <tonc.h>

#define COUNTER  (*(volatile u32*)0x02000000)
#define READBACK (*(volatile u32*)0x02000010)

int main(void) {
    irq_init(NULL);
    irq_add(II_VBLANK, NULL);
    REG_DISPCNT = DCNT_MODE3 | DCNT_BG2;
    READBACK = 0xABCD;            // seed a readable slot once
    volatile u32 sink = 0;
    u32 acc = 0;
    while (1) {
        acc += 1;
        COUNTER = acc;            // a WRITE to EWRAM 0x02000000 each frame
        sink += READBACK;         // a READ of EWRAM 0x02000010 each frame
        VBlankIntrWait();
    }
    return 0;
}`;

const COUNTER_ADDR = 0x02000000;
const READBACK_ADDR = 0x02000010;

test("GBA PC breakpoint + read watch + single-step (mgba ARM7TDMI)", { timeout: 150000 }, async () => {
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
  await host.loadMedia({ platform: "gba", bytes: r.binary, virtualName: "bp.gba" });

  // Feature detection — the whole point of this build.
  assert.equal(host.pcBreakSupported(), true, "core does not expose romdev_pcbreak_* — rebuild needed");
  assert.equal(host.readWatchSupported(), true, "core does not expose romdev_readwatch_* — rebuild needed");

  // Let it boot past the Tonc runtime init into the main loop.
  host.stepFrames(20);

  // 3) findWriter on 0x02000000 → the EXACT instruction PC that writes the
  //    counter. (Confirms the write watch works AND gives a real bp target.)
  host.setWatchpoint(COUNTER_ADDR, true);
  let writerPC = null;
  for (let i = 0; i < 120; i++) {
    host.stepFrames(1);
    const w = host.getWatchpoint(false);
    if (w.hits > 0) { writerPC = w.lastPC; break; }
  }
  host.setWatchpoint(0, false);
  assert.ok(writerPC != null && writerPC > 0, `findWriter didn't catch the 0x02000000 write (writerPC=${writerPC})`);

  // 4) Arm the PC breakpoint on that exact PC and step frames until it hits —
  //    the SAME poll-and-capture-live pattern the runUntilPC MCP tool uses
  //    (capture the hit state BEFORE disarming; the core's pcbreak_set resets
  //    lastPC on re-arm/disarm, so the value must be read at the moment of hit).
  //    If TRAP 2 were wrong (frozen CPU, frame never completes) this HANGS — the
  //    outer `timeout 150` kills it. Each stepFrames(1) is one bounded retro_run.
  host.setPCBreak(writerPC, true, false);
  let bpHit = null;
  for (let i = 0; i < 300; i++) {
    host.stepFrames(1);
    const st = host.getPCBreak(false);
    if (st.hit) { bpHit = st; break; }
  }
  assert.ok(bpHit, "PC breakpoint never fired on the writer PC within 300 frames");
  assert.equal(bpHit.lastPC >>> 0, writerPC >>> 0, `frozen PC (${bpHit.lastPC}) != requested PC (${writerPC})`);

  // 5) With the CPU frozen, the gba_cpu_regs region reads the live registers.
  //    gprs[15] (PC) is at byte offset 60, cpsr at offset 64 (bit 5 = THUMB).
  //    ARM-PIPELINE NOTE: the breakpoint is matched/reported against the RAW
  //    gprs[ARM_PC] the EXECUTING instruction sees (= instr_addr + 2*wordsize,
  //    the same pipeline-prefetched value findWriter reports). The core freezes
  //    the CPU at the clean, resumable boundary right BEFORE that instruction's
  //    prefetch advance, so the live gprs[15] is exactly ONE instruction-word
  //    behind the reported breakpoint PC (4 in ARM, 2 in THUMB). The CPU is
  //    genuinely parked at the breakpoint — not free-running — which is what this
  //    asserts. (A user reads the executing-instruction address via
  //    getCPUState().execPc, which subtracts the pipeline offset.)
  const regs = host.readMemory("gba_cpu_regs", 0, 80);
  const dv = new DataView(regs.buffer, regs.byteOffset, regs.byteLength);
  const livePC = dv.getUint32(15 * 4, true) >>> 0;
  const cpsr = dv.getUint32(16 * 4, true) >>> 0;
  const word = (cpsr & 0x20) ? 2 : 4; // T bit (bit 5) → THUMB ? 2-byte : 4-byte
  const delta = (writerPC >>> 0) - livePC;
  assert.equal(delta, word,
    `frozen gprs[15] (0x${livePC.toString(16)}) is not one pipeline word behind the breakpoint PC ` +
    `(0x${(writerPC >>> 0).toString(16)}); delta=${delta}, expected ${word} — CPU not frozen at the breakpoint`);

  // Disarm before single-stepping.
  host.setPCBreak(0, false, false);

  // 6) Single-step must ADVANCE the PC — not re-stop on the same un-executed
  //    instruction. (The countdown-arm fix; a before-dispatch fire returns the
  //    same PC.)
  const step = host.stepInstruction();
  assert.ok(step.pc != null, `single-step returned no pc: ${JSON.stringify(step)}`);
  assert.notEqual(step.pc >>> 0, writerPC >>> 0, `single-step did not advance PC: ${JSON.stringify(step)}`);

  // 7) runUntilRead — POSITIVE: the program reads READBACK_ADDR (0x02000010)
  //    every frame (`sink += READBACK`). The read watch must catch it and report
  //    the EXACT reading instruction's PC + the value read. Live-capture the hit
  //    (the host's getReadWatch(true) clears state on re-arm, mirroring the MCP
  //    runUntilRead tool). The read hook is in GBALoad8/16/32.
  host.setReadWatch(READBACK_ADDR, true);
  let rdHit = null;
  for (let i = 0; i < 120; i++) {
    host.stepFrames(1);
    const st = host.getReadWatch(false);
    if (st.hits > 0) { rdHit = st; break; }
  }
  host.setReadWatch(0, false);
  assert.ok(rdHit, "read watch never fired on the per-frame read of 0x02000010");
  assert.ok(rdHit.lastPC != null && rdHit.lastPC > 0, `read watch reported no reader PC: ${JSON.stringify(rdHit)}`);
  // 0xABCD low byte = 0xCD (the read hook records the low byte of the value).
  assert.equal(rdHit.lastValue, 0xCD, `read watch value mismatch: ${JSON.stringify(rdHit)}`);

  // 8) After all breakpoint activity, normal stepping must resume cleanly (the
  //    core fully disarmed — no lingering frozen state / hang).
  const before = host.status.frameCount;
  host.stepFrames(5);
  assert.equal(host.status.frameCount, before + 5, "normal stepping did not resume after breakpoints");
});
