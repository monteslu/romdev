// gambatte single-step and instruction trace while the game waits in HALT.
//
// Regression (feedback 2026-09-22, gb-stepinstructions-returns-empty-trace):
// once a game sat in HALT, the step hook froze the CPU but left the event
// loop running on a stale cycle counter, so events rescheduled themselves
// behind it forever and single-step never returned. A synthetic ROM that
// halts every frame waiting for VBlank reproduces it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { LibretroHost } from "romdev-core-host/index.js";
import { getCPUState } from "romdev-core-host/cpu-state.js";
import { resolveCore } from "../src/cores/registry.js";

function haltRom() {
  const rom = new Uint8Array(0x8000);
  rom[0x40] = 0xd9;                                   // VBlank: reti
  rom.set([0x00, 0xc3, 0x50, 0x01], 0x100);           // nop ; jp $0150
  // ld a,1 ; ldh (IE),a ; ei ; loop: halt ; nop ; jr loop
  rom.set([0x3e, 0x01, 0xe0, 0xff, 0xfb, 0x76, 0x00, 0x18, 0xfc], 0x150);
  return rom;
}

const core = (() => { try { return resolveCore("gb"); } catch { return null; } })();

test("gambatte: single-step and the instruction trace work while the game waits in HALT", { skip: !core && "gambatte not staged", timeout: 60000 }, async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "romdev-gbhalt-"));
  const h = new LibretroHost();
  try {
    const romPath = path.join(dir, "halt.gb");
    writeFileSync(romPath, haltRom());
    await h.loadCore(core.jsPath, core.wasmPath, { hwRender: core.hwRender, noderawfs: core.noderawfs });
    await h.loadMedia({ platform: "gb", path: romPath });
    h.stepFrames(120);

    // free-running trace of one frame: the VBlank handler and the halt loop
    assert.ok(h.traceSupported(), "this gambatte build records the instruction trace");
    h.setTrace({ capacity: 4096, registers: true });
    h.stepFrames(1);
    const t = h.readTrace(0);
    h.setTrace({ enabled: false });
    assert.ok(t.pc.length >= 3, `one frame runs the handler and the loop (${t.pc.length} instructions)`);
    assert.ok([...t.pc].includes(0x40), "the VBlank handler is in the trace");
    assert.ok([...t.pc].includes(0x155), "and the HALT it returns to");
    assert.ok(t.pc.length < 64, `the CPU spends the frame halted, not executing (${t.pc.length} instructions)`);
    assert.ok(t.regs && t.regs.sp.length === t.pc.length, "register columns are recorded per instruction");

    // single-step from inside HALT: returns, and advances through real pcs
    const pcs = [];
    for (let i = 0; i < 8; i++) {
      const s = h.stepInstruction();
      assert.equal(s.hit, true, `step ${i} fired`);
      pcs.push(s.pc);
    }
    assert.ok(pcs.every((p) => [0x40, 0x155, 0x156, 0x157].includes(p)), `steps land on the handler/loop: ${pcs.map((p) => p.toString(16))}`);
    assert.ok(getCPUState(h, "gb").coreInternal.cycleCounter > 0, "gb_cpu_regs carries gambatte's CPU clock");
  } finally {
    h.dispose?.();
    rmSync(dir, { recursive: true, force: true });
  }
});
