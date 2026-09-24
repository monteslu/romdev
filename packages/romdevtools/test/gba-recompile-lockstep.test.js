// GBA recompile vs mGBA, instruction by instruction from power-on.
//
// A synthetic ROM is recompiled through the real pipeline (emitWat, the
// streaming assembler), run in node's WebAssembly with the cart's per-step
// trace ring, and compared against romdev's mGBA's free-running trace with
// register columns: pc, the clock delta, r0-r14 and cpsr of EVERY
// instruction.
//
// Skipped when the mGBA core is not staged.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { LibretroHost } from "romdev-core-host/index.js";
import { resolveCore } from "../src/cores/registry.js";
import { emitWat, recompileSection } from "../src/analysis/recompile/wat/gba/index.js";
import { assembleWat } from "../src/analysis/recompile/wat/assemble.js";

const core = (() => { try { return resolveCore("gba"); } catch { return null; } })();
const skip = !core ? "mGBA not staged" : false;

/**
 * A GBA ROM: `b $080000C0` at the entry, `main` (ARM words) at $C0, `block`
 * (ARM words) at $100.
 * @param {number[]} main
 * @param {number[]} block
 */
function makeRom(main, block) {
  const r = new Uint8Array(0x400);
  const dv = new DataView(r.buffer);
  dv.setUint32(0, 0xEA00002E, true);
  r.set([...Buffer.from("LOCKSTEP")], 0xA0);
  main.forEach((w, i) => dv.setUint32(0xC0 + 4 * i, w >>> 0, true));
  block.forEach((w, i) => dv.setUint32(0x100 + 4 * i, w >>> 0, true));
  return r;
}

/**
 * Run the cart and mGBA side by side for `frames` frames; the first
 * instruction that differs, or null.
 */
async function lockstep(rom, frames) {
  const { bytes } = await assembleWat(emitWat(rom));
  const { instance } = await WebAssembly.instantiate(bytes, {});
  const x = instance.exports;
  const lay = recompileSection(rom).json;
  const t = lay.trace;
  const dv = () => new DataView(x.memory.buffer);
  x.wc_init();
  dv().setUint32(t.enable.offset, 1, true);
  const dir = mkdtempSync(path.join(os.tmpdir(), "romdev-gbalock-"));
  const ref = new LibretroHost();
  try {
    const romPath = path.join(dir, "t.gba");
    writeFileSync(romPath, rom);
    await ref.loadCore(core.jsPath, core.wasmPath, { hwRender: core.hwRender, noderawfs: core.noderawfs });
    // mGBA registers its register filler with the game: arm the trace
    // after the load, before the settle frames
    await ref.loadMedia({ platform: "gba", path: romPath, beforeSettle: () => ref.setTrace({ capacity: 1 << 21, registers: true }) });
    const cq = [], rq = [];
    let rgot = 0, n = 0, off0 = null;
    const pull = () => {
      const d = dv();
      const cnt = d.getUint32(t.cursor.offset, true);
      assert.ok(cnt < t.entries, "the cart ring holds the frame");
      for (let i = 0; i < cnt; i++) {
        const o = t.offset + i * t.stride;
        const r = [];
        for (let k = 0; k < 15; k++) r.push(d.getUint32(o + 12 + 4 * k, true));
        cq.push({ pc: d.getUint32(o, true), clk: d.getUint32(o + 8, true), cpsr: d.getUint32(o + 76, true), r });
      }
      d.setUint32(t.cursor.offset, 0, true);
      const tr = ref.readTrace(rgot);
      assert.equal(tr.lost, 0, "the reference trace lost nothing");
      for (let k = 0; k < tr.pc.length; k++) {
        const r = [];
        for (let j = 0; j < 15; j++) r.push(tr.regs[`r${j}`][k]);
        rq.push({ pc: tr.pc[k], clk: tr.clock[k], cpsr: tr.regs.cpsr[k], r });
      }
      rgot = tr.to;
      while (cq.length && rq.length) {
        const c = cq.shift(), e = rq.shift();
        const dc = (c.clk - e.clk) | 0;
        if (off0 === null) off0 = dc;
        // mGBA's trace pc is gprs[PC]: exec + 8 in ARM, + 4 in Thumb
        const why = ((e.pc - c.pc) | 0) !== ((c.cpsr & 0x20) ? 4 : 8) ? "pc" : dc !== off0 ? "clock"
          : (c.cpsr >>> 0) !== (e.cpsr >>> 0) ? "cpsr" : c.r.findIndex((v, k) => (v >>> 0) !== (e.r[k] >>> 0)) >= 0 ? "regs" : null;
        if (why) return { at: n, why, cart: [c.pc, c.cpsr, ...c.r].map((v) => (v >>> 0).toString(16)), ref: [e.pc, e.cpsr, ...e.r].map((v) => (v >>> 0).toString(16)) };
        n++;
      }
      return null;
    };
    x.wc_render();
    let bad = pull();
    for (let f = 0; f < frames && !bad; f++) { ref.stepFrames(1); x.wc_render(); bad = pull(); }
    return { bad, n };
  } finally {
    ref.dispose?.();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("ARM code in IWRAM runs what the pipeline fetched: stores to the next two instructions are not seen", { skip, timeout: 180000 }, async () => {
  // main ($C0): copy the block to $03000000 and jump there
  const main = [
    0xE28F0038,             // add r0, pc, #0x38   (r0 = $08000100)
    0xE3A01403,             // mov r1, #0x03000000
    0xE3A0200C,             // mov r2, #12
    0xE4903004,             // ldr r3, [r0], #4
    0xE4813004,             // str r3, [r1], #4
    0xE2522001,             // subs r2, r2, #1
    0x1AFFFFFB,             // bne (ldr)
    0xE3A01403,             // mov r1, #0x03000000
    0xE12FFF11,             // bx r1
  ];
  // block (IWRAM): zero the next two instructions (in the pipeline: they
  // still run) and one three ahead (not yet fetched: it does not run)
  const block = [
    0xE28F000C,             //  0 add r0, pc, #12  (r0 -> 20)
    0xE28F100C,             //  4 add r1, pc, #12  (r1 -> 24)
    0xE3A02000,             //  8 mov r2, #0
    0xE5802000,             // 12 str r2, [r0]     (20: already fetched)
    0xE5812000,             // 16 str r2, [r1]     (24: already fetched)
    0xE3A04001,             // 20 mov r4, #1
    0xE3A05002,             // 24 mov r5, #2
    0xE5802014,             // 28 str r2, [r0, #20] (40: fetched after this)
    0xE3A06003,             // 32 mov r6, #3
    0xE3A07004,             // 36 mov r7, #4
    0xE3A08005,             // 40 mov r8, #5  -> andeq r0,r0,r0 when it runs
    0xEAFFFFFE,             // 44 b 44
  ];
  const { bad, n } = await lockstep(makeRom(main, block), 3);
  assert.equal(bad, null, bad ? `diverged at instruction ${bad.at} (${bad.why}): cart ${bad.cart.join(" ")} vs mGBA ${bad.ref.join(" ")}` : "");
  assert.ok(n > 1000, `compared ${n} instructions`);
});
