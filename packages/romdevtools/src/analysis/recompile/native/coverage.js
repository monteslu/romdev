// Which 68000 code a game actually runs, measured on the EXACT recompiled
// cart (the verified wasmcart, the oracle) rather than guessed statically.
//
// The cart's romdev.recompile section declares its instruction ring (one
// entry per executed instruction: pc, plus event entries with bit 31 set for
// interrupt entry). This runs the cart on the given input schedule and on
// seeded random play (the schedules frame({op:'fuzzRecompile'}) uses), reads
// the ring after every frame, and returns
//   pcs:   every instruction address executed,
//   pairs: every consecutive (pc, next pc) the cart ran, so a block builder
//          can tell a straight-line successor from a jump target it could not
//          see statically (jump tables, rts, rte),
//   irqTargets: first instruction after each interrupt entry.
//
// A native build compiles only these and interprets everything else, which
// is what keeps a 512 KB game inside a microcontroller's flash.
//
// Plain JS ESM + JSDoc.

import { readFileSync } from "node:fs";
import { WasmcartHost } from "../../../host/WasmcartHost.js";
import { readRecompileLayout, cartWasmBytes, wascFromWasm } from "../recompile-section.js";
import { parseInputSchedule, shiftSchedule, ScheduleDriver, wrongInputSchedule } from "../../../host/verify-recompile.js";

const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

/**
 * @param {object} a
 * @param {string} a.cart          path to the exact .wasc (built by disasm emit:'wasmcart')
 * @param {string|Array} [a.input] the gate schedule, in REFERENCE frames
 * @param {number} [a.frames]      reference frames to run the schedule for
 * @param {number[]} [a.fuzzSeeds] seeded random play scripts (fuzzRecompile's)
 * @param {number} [a.fuzzFrames]  cart frames per fuzz script
 * @param {string|Array} [a.fuzzInput] presses every fuzz script keeps (e.g. the Start)
 * @param {{input:string|Array, frames:number, label?:string}[]} [a.schedules] more
 *                                 schedules to run (other levels, longer play)
 * @param {(s:string)=>void} [a.onProgress]
 */
export async function collectCoverage(a) {
  const bytes = new Uint8Array(readFileSync(a.cart));
  const layout = readRecompileLayout(bytes);
  if (!layout?.trace) throw new Error(`coverage: ${a.cart} carries no romdev.recompile trace ring (build it with disasm emit:'wasmcart')`);
  const t = layout.trace;
  const wasm = cartWasmBytes(bytes);
  const loadBytes = wasm === bytes ? wascFromWasm(bytes, "cart") : bytes;
  const off = layout.conventions?.cartFrameOffset ?? 0;
  const pcMask = t.pc?.mask ?? 0xffffffff, pcOff = t.pc?.offset ?? 0;
  const skipBit = t.skipIf?.bit ?? 31;

  const pcs = new Map();       // pc -> executions
  const pairs = new Set();     // prev * 2^24 + next
  const irqTargets = new Set();
  const runs = [];
  // Z80 RAM after each run, for a native build that recompiles the Z80
  // driver too (the image with the most runs is the driver the game keeps)
  const zspec = layout.regions?.zram;
  const zImages = new Map();

  const runOne = async (label, schedule, frames) => {
    const h = new WasmcartHost();
    await h.loadMedia({ platform: "wasmcart", bytes: loadBytes });
    try {
      const base = t.baseField ? u32(h.readMemory(t.baseField.offset, 4), 0) : t.offset;
      h.writeMemory(t.enable.offset, Uint8Array.of(1, 0, 0, 0));
      const d = new ScheduleDriver(h, schedule, null);
      let insns = 0, prev = -1, afterIrq = false, overflow = 0;
      for (let f = 1; f <= frames; f++) {
        h.writeMemory(t.cursor.offset, new Uint8Array(4));
        await d.to(f);
        const n = u32(h.readMemory(t.cursor.offset, 4), 0);
        if (n >= t.entries - 1) overflow++;
        const ring = h.readMemory(base, n * t.stride);
        for (let i = 0; i < n; i++) {
          const raw = u32(ring, i * t.stride + pcOff);
          if ((raw >>> skipBit) & 1) { afterIrq = true; continue; }
          const pc = (raw & pcMask) >>> 0;
          pcs.set(pc, (pcs.get(pc) ?? 0) + 1);
          if (afterIrq) { irqTargets.add(pc); afterIrq = false; }
          if (prev >= 0) pairs.add(prev * 0x1000000 + pc);
          prev = pc;
          insns++;
        }
      }
      runs.push({ run: label, frames, instructions: insns, ...(overflow ? { ringOverflowFrames: overflow } : {}) });
      if (zspec && zspec.length === 0x2000) {
        const z = Uint8Array.from(h.readMemory(zspec.offset, 0x2000));
        const key = Buffer.from(z).toString("base64");
        const e = zImages.get(key) ?? { image: z, runs: [] };
        e.runs.push(label);
        zImages.set(key, e);
      }
    } finally {
      h.destroy?.();
    }
    a.onProgress?.(`coverage ${label}: ${pcs.size} pcs so far`);
  };

  if (a.input != null || a.frames) {
    const sched = shiftSchedule(parseInputSchedule(a.input), off);
    await runOne("schedule", sched, (a.frames ?? 3600) + off);
  }
  for (const [i, s] of (a.schedules ?? []).entries()) {
    await runOne(s.label ?? `schedule ${i + 2}`, shiftSchedule(parseInputSchedule(s.input), off), (s.frames ?? 3600) + off);
  }
  const base = parseInputSchedule(a.fuzzInput);
  const from = base.length ? Math.max(...base.map((p) => p.frame + p.hold)) + 30 : 60;
  for (const seed of a.fuzzSeeds ?? []) {
    const frames = a.fuzzFrames ?? 3600;
    const play = wrongInputSchedule([{ frame: from, buttons: ["a"], hold: 1 }], frames, seed).filter((p) => p.frame >= from);
    await runOne(`fuzz seed ${seed}`, [...base, ...play].sort((x, y) => x.frame - y.frame), frames);
  }
  // Z80 RAM holds data as well as the driver, so images differ between runs
  // even when the code does not; the builder walks the code in the first
  // run's image and checks it at run time
  const z80Images = [...zImages.values()];
  return { pcs, pairs, irqTargets, runs, z80Image: z80Images[0]?.image ?? null, z80Images: z80Images.map((z) => ({ runs: z.runs })), source: { cart: a.cart, romSha1: layout.romSha1 } };
}
