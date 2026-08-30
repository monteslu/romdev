// The sync32 CPU-state decoder, against a synthetic register block.
//
// The decoder's whole job is turning 50 little-endian u32s into something a
// developer can read, and the parts worth pinning are the ones that are easy
// to get subtly wrong: the APSR bit order, the single-precision float decode,
// and NOT inventing a pipeline offset (this core is an interpreter, so r15 is
// the next instruction — unlike the GBA path right above it, where PC really
// is prefetched).

import { test } from "node:test";
import assert from "node:assert/strict";
import { getCPUState } from "romdev-core-host/cpu-state.js";

/** A fake host whose sync32_cpu_regs region is whatever we hand it. */
function hostWith(words) {
  const buf = new Uint8Array(200);
  const dv = new DataView(buf.buffer);
  words.forEach((w, i) => dv.setUint32(i * 4, w >>> 0, true));
  return { readMemory: (region) => {
    assert.equal(region, "sync32_cpu_regs", "decoder must read the CPU region");
    return buf;
  } };
}

test("decodes registers, SP/LR/PC aliases and the APSR", () => {
  const words = new Array(50).fill(0);
  for (let i = 0; i < 13; i++) words[i] = 0x1000 + i;
  words[13] = 0x2007ff00;  // SP
  words[14] = 0x20030101;  // LR
  words[15] = 0x20030340;  // PC
  words[16] = 0b01100;     // Z|C set, N/V/Q clear

  const st = getCPUState(hostWith(words), "sync32");
  assert.equal(st.cpu, "cortex-m33 (ARMv8-M, Thumb-2)");
  assert.equal(st.pc, 0x20030340);
  assert.equal(st.sp, 0x2007ff00);
  assert.equal(st.registers.SP, 0x2007ff00);
  assert.equal(st.registers.LR, 0x20030101);
  assert.equal(st.registers.PC, 0x20030340);
  assert.equal(st.registers.R0, 0x1000);
  assert.equal(st.registers.R12, 0x100c);
  assert.deepEqual(
    { N: st.flags.N, Z: st.flags.Z, C: st.flags.C, V: st.flags.V, Q: st.flags.Q },
    { N: false, Z: true, C: true, V: false, Q: false },
  );

  // An interpreter has no prefetch to undo — reporting execPc would be
  // inventing one. (The GBA decoder next door DOES set it, correctly.)
  assert.equal(st.execPc, undefined, "sync32 must not report a pipeline-adjusted PC");
});

test("decodes non-zero FPU registers as single-precision floats, and omits zeros", () => {
  const words = new Array(50).fill(0);
  const bits = (f) => { const d = new DataView(new ArrayBuffer(4)); d.setFloat32(0, f, true); return d.getUint32(0, true); };
  words[17 + 0] = bits(1.5);      // S0
  words[17 + 31] = bits(-0.25);   // S31

  const st = getCPUState(hostWith(words), "sync32");
  assert.equal(st.fpu.S0, 1.5);
  assert.equal(st.fpu.S31, -0.25);
  // Only the interesting ones: a game that barely touches the FPU should not
  // dump 30 zeros into the response.
  assert.deepEqual(Object.keys(st.fpu), ["S0", "S31"]);
});

test("omits the fpu block entirely when every float register is zero", () => {
  const st = getCPUState(hostWith(new Array(50).fill(0)), "sync32");
  assert.equal(st.fpu, undefined);
  assert.equal(st.itstate, undefined, "a zero ITSTATE is not worth reporting");
});

test("reports ITSTATE when inside an IT block", () => {
  const words = new Array(50).fill(0);
  words[49] = 0x0c;
  const st = getCPUState(hostWith(words), "sync32");
  assert.equal(st.itstate, "0x0000000C");
});
