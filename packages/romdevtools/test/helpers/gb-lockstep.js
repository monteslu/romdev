// The GB lockstep run itself (cart vs gambatte, instruction by instruction,
// then the picture), for test/gb-recompile-lockstep.test.js. It runs in a
// worker (gb-lockstep-worker.js): a ROM that never hands out a frame keeps
// wc_render or retro_run spinning in synchronous code no test timeout can
// interrupt, and only terminating the worker stops it.

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { LibretroHost } from "romdev-core-host/index.js";
import { resolveCore } from "../../src/cores/registry.js";
import { emitWat, recompileSection } from "../../src/analysis/recompile/wat/gb/index.js";
import { assembleWatSync } from "../../src/analysis/recompile/wat/assemble.js";

const core = resolveCore("gb");

/**
 * Run the cart and gambatte side by side for `frames` frames and return the
 * first instruction that differs (null when none does).
 * @param {Uint8Array} rom
 * @param {number} frames
 */
export async function lockstep(rom, frames) {
  const chunks = [];
  for await (const c of emitWat(rom, { traceEntries: 32768 })) chunks.push(c);
  const { instance } = await WebAssembly.instantiate(assembleWatSync(chunks.join("")), {});
  const x = instance.exports;
  const sec = recompileSection(rom, "", { traceEntries: 32768 }).json;
  const t = sec.trace;
  x.wc_init();
  const dir = mkdtempSync(path.join(os.tmpdir(), "romdev-gblock-"));
  const ref = new LibretroHost();
  try {
    const romPath = path.join(dir, "t.gb");
    writeFileSync(romPath, rom);
    await ref.loadCore(core.jsPath, core.wasmPath, { hwRender: core.hwRender, noderawfs: core.noderawfs });
    ref.setTrace({ capacity: 1 << 20, registers: true });
    await ref.loadMedia({ platform: rom[0x143] & 0x80 ? "gbc" : "gb", path: romPath });
    const cq = [], rq = [];
    let cgot = 0, rgot = 0, n = 0, off0 = null;
    const pull = () => {
      const dv = new DataView(x.memory.buffer);
      const cnt = dv.getUint32(t.cursor.offset, true);
      assert.ok(cnt - cgot <= t.entries, "the cart ring holds a whole frame");
      for (let i = cgot; i < cnt; i++) {
        const o = t.offset + (i % t.entries) * t.stride;
        cq.push([dv.getUint32(o, true) & 0xffff, dv.getUint32(o + 28, true), dv.getUint32(o + 8, true) & 0xffff,
          dv.getUint32(o + 12, true) & 0xffff, dv.getUint32(o + 16, true) & 0xffff, dv.getUint32(o + 20, true) & 0xffff,
          dv.getUint32(o + 24, true) & 0xffff]);
      }
      cgot = cnt;
      const r = ref.readTrace(rgot);
      assert.equal(r.lost, 0, "the reference trace lost nothing");
      assert.ok(r.regs.af, "the gambatte build records af (scripts/build-gambatte.sh)");
      for (let k = 0; k < r.pc.length; k++) rq.push([r.pc[k] & 0xffff, r.clock[k], r.regs.sp[k] & 0xffff, r.regs.hl[k] & 0xffff, r.regs.bc[k] & 0xffff, r.regs.de[k] & 0xffff, r.regs.af[k] & 0xffff]);
      rgot = r.to;
      while (cq.length && rq.length) {
        const c = cq.shift(), e = rq.shift();
        const d = (c[1] - e[1]) | 0;
        if (off0 === null) off0 = d;
        const names = ["pc", "clock", "sp", "hl", "bc", "de", "af"];
        for (let k = 0; k < 7; k++) {
          const bad = k === 1 ? d !== off0 : c[k] !== e[k];
          if (bad) return { at: n, what: names[k], cart: c.map((v) => v.toString(16)), ref: e.map((v) => v.toString(16)) };
        }
        n++;
      }
      return null;
    };
    // the reference's settle frames are the cart's first renders
    let bad = null;
    for (let k = 0; k < ref.status.settleFramesUsed && !bad; k++) { x.wc_render(); bad = pull(); }
    for (let f = 0; f < frames && !bad; f++) { ref.stepFrames(1); x.wc_render(); bad = pull(); }
    // the picture: the cart's framebuffer against gambatte's, exact RGB
    const fb = sec.framebuffer, rs = ref.screenshotRgba(), d = new DataView(x.memory.buffer);
    let px = 0;
    for (let y = 0; y < 144; y++) for (let xx = 0; xx < 160; xx++) {
      const i = (y * rs.width + xx) * 4;
      if ((d.getUint32(fb.offset + (y * fb.width + xx) * 4, true) & 0xffffff) !== ((rs.rgba[i] << 16) | (rs.rgba[i + 1] << 8) | rs.rgba[i + 2])) px++;
    }
    return { bad, n, px };
  } finally {
    ref.dispose?.();
    rmSync(dir, { recursive: true, force: true });
  }
}

