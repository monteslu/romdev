// Instruction-level differ for recompiled carts: the cart's own pc/trace ring
// (declared in its romdev.recompile section) against the reference core's
// free-running instruction trace (romdev_trace_*), for ONE frame, with the
// first divergent instruction and context from both sides.
//
// Backs frame({op:'findDiverge', level:'instruction'}). Replaces the earlier
// Python pc differs (snes_pcdiff2.py, snes_reftrace.py, snes_pcdump.py,
// snesverify/pcdiff.py, pcdiff.py, lockstep.py, cosim_*.py/cjs, g2trace.py,
// g2regdiff.py, s1_differ.py, refdump.py, refseq.py). What they learned is
// kept here once:
//
//  * THE REFERENCE STREAM MUST BE FREE-RUNNING. Single-stepping a libretro core
//    freezes its CPU while the rest of the machine finishes the frame, so every
//    stepped instruction is a frame apart in machine time. The reference side
//    is the core's instruction trace, recorded while it runs normally.
//  * NORMALISE BEFORE COMPARING: bank mirrors (snes9x reports $80:xxxx for the
//    cart's $00:xxxx), the GBA core's pipeline pc (exec + 8 / + 4), recording
//    filters the cart applies (the SNES ring holds ROM pcs only, minus boot
//    loops) applied to the reference too.
//  * INTERRUPTS: a handler entered at a different instruction on the two sides
//    is reported (for a cycle-exact backend that IS the divergence) and then
//    stripped - cut from the vector entry until the stream comes back to the
//    pc the other side is at - so the first divergence in program LOGIC is
//    found too.
//  * ALIGN BY CONTENT when the frame boundaries do not coincide, with a window
//    long enough to be unique: a tight loop matches at every iteration, so an
//    ambiguous alignment is refused rather than guessed.
//  * A WRONG VALUE WITH THE SAME CONTROL FLOW is invisible to a pc compare
//    until it changes a branch (and a register can differ and reconverge, so
//    bisecting on "registers differ" finds A transition, not the first). When
//    the cart's trace carries registers the core also records per instruction
//    (GBA: r0-r15, cpsr; and with the backends' options.traceEntries rings:
//    NES a/x/y/s/p, GB sp/hl/bc/de, SMS/GG af/bc/de/hl/ix/iy/sp/r/af'../i,
//    Genesis d0-d7/a0-a7/sr, SNES a/x/y/s/d/db/p), every matched instruction's registers
//    are compared, and the instruction that first produced a different value
//    is named. Elsewhere the reference CPU state at the divergence is read by
//    stopping a replay with the instruction watchdog.

import { getCPUState } from "romdev-core-host/cpu-state.js";
import {
  ScheduleDriver, parseInputSchedule, shiftSchedule, resolveAlignment, wantsSearch,
  searchFrameOffset, BY_NAME_CART_MAP, findRecompileDivergence,
} from "./verify-recompile.js";

const hex = (v, w = 4) => "$" + (v >>> 0).toString(16).toUpperCase().padStart(w, "0");

// ─── per-reference conventions ───────────────────────────────────────────────

/** The SNES backend's default pc-ring skip ranges (boot loops that would fill the ring), for carts whose section predates `trace`. */
const SNES_SKIP_DEFAULT = [[0x8034, 0x8048], [0x8079, 0x80e7], [0x8a4e, 0x8a64]];

const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32be = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;

/**
 * How the reference core reports a pc, and where its interrupt handlers
 * start, per reference platform. `cart(e)` maps a cart trace entry to the
 * reference's pc spelling; `ref(pc)` normalises a reference pc (mirrors);
 * `vectors(rom)` = handler entry pcs in the REFERENCE spelling; `pcWidth` for
 * printing; `singleCpu` = the core's watchdog counts only this CPU's
 * instructions (a watchdog-stopped replay needs that).
 */
export const REFERENCE_PC = {
  nes: {
    pcWidth: 4, singleCpu: true,
    cart: (e) => e.pc & 0xffff, ref: (p) => p & 0xffff,
    vectors: (rom) => {
      if (!rom || rom.length < 16 + 0x4000) return [];
      const prgLen = rom[4] * 0x4000, base = 16 + ((rom[6] & 4) ? 512 : 0);
      const v = base + prgLen - 6;
      return [u16(rom, v), u16(rom, v + 4)]; // NMI, IRQ/BRK
    },
  },
  gb: { pcWidth: 4, singleCpu: true, cart: (e) => e.pc & 0xffff, ref: (p) => p & 0xffff, vectors: () => [0x40, 0x48, 0x50, 0x58, 0x60] },
  gbc: { pcWidth: 4, singleCpu: true, cart: (e) => e.pc & 0xffff, ref: (p) => p & 0xffff, vectors: () => [0x40, 0x48, 0x50, 0x58, 0x60] },
  // haltRepeat: genesis_plus_gx keeps a halted Z80 on its HALT (ENTER_HALT:
  // PC--) and dispatches it again every 4 T (60 master cycles, the trace's
  // clock unit), so its trace repeats the HALT pc until an interrupt; a cart
  // records the HALT once and idles.
  sms: { pcWidth: 4, singleCpu: true, haltRepeat: 60, cart: (e) => e.pc & 0xffff, ref: (p) => p & 0xffff, vectors: () => [0x38, 0x66] },
  gg: { pcWidth: 4, singleCpu: true, haltRepeat: 60, cart: (e) => e.pc & 0xffff, ref: (p) => p & 0xffff, vectors: () => [0x38, 0x66] },
  genesis: {
    // genesis_plus_gx dispatches its Z80 through the same hook, so the
    // watchdog counts both CPUs: no watchdog-stopped replay here.
    pcWidth: 6, singleCpu: false,
    cart: (e) => e.pc & 0xffffff, ref: (p) => p & 0xffffff,
    vectors: (rom) => {
      if (!rom || rom.length < 0x80) return [];
      const out = [];
      for (let v = 0x60; v <= 0x7c; v += 4) out.push(u32be(rom, v) & 0xffffff); // spurious + levels 1-7
      return out;
    },
  },
  snes: {
    pcWidth: 6, singleCpu: true,
    cart: (e) => (((e.pc >>> 16) & 0x7f) << 16) | (e.pc & 0xffff),
    ref: (p) => (((p >>> 16) & 0x7f) << 16) | (p & 0xffff),
    vectors: (rom) => {
      if (!rom) return [];
      const hdr = rom.length % 1024 === 512 ? 512 : 0;
      const out = [];
      for (let v = 0x7fe4; v < 0x8000; v += 2) {
        if (hdr + v + 1 >= rom.length) break;
        const t = u16(rom, hdr + v);
        if (t >= 0x8000 && t < 0xffff) out.push(t); // bank 0, already normalised
      }
      return out;
    },
  },
  gba: {
    // mGBA's dispatch pc is gprs[PC] + width = exec + 8 (ARM) / + 4 (Thumb),
    // the address romdev's GBA breakpoints use; the cart records the exec
    // address and its Thumb bit.
    pcWidth: 8, singleCpu: true,
    cart: (e) => (e.pc + (e.fields.thumb ? 4 : 8)) >>> 0, ref: (p) => p >>> 0,
    exec: (e) => e.pc >>> 0, // the instruction's own address, for people
    vectors: () => [0x18 + 8, 0x08 + 8], // IRQ, SWI (ARM state)
  },
};

// ─── the cart's trace descriptor ─────────────────────────────────────────────

/**
 * The cart's trace ring, from its section's `trace` key, or derived from the
 * older per-backend diagnostics for carts built before `trace` existed.
 * Normalised form:
 *   { base | baseField:{offset}, entries, stride,
 *     cursor:{offset, mode:'count'|'index', writable}, enable:{offset}|null,
 *     pc:{offset,shift,mask}, clock:{offset}|null, skipIf:{offset,bit}|null,
 *     fields:{name:{offset,size,shift,mask,ref}}, filter:{romOnly, skip}|null,
 *     note, source }
 * @param {object} layout validated romdev.recompile layout
 * @param {string} refPlatform
 */
export function traceDescriptor(layout, refPlatform) {
  const L = layout ?? {};
  if (L.trace) return { ...normaliseTrace(L.trace), source: "section" };
  const d = deriveTrace(L, refPlatform);
  if (!d) {
    throw new Error(`findDiverge level:'instruction': the cart declares no instruction trace (no \`trace\` in its romdev.recompile section) and none can be derived for platform '${L.platform ?? refPlatform}'. `
      + "A backend that records one declares {offset, entries, stride, cursor:{offset, mode}, pc:{offset, mask}, clock?, fields?} under `trace`.");
  }
  return { ...normaliseTrace(d), source: "derived" };
}

function normaliseTrace(t) {
  const span = (s, dflt = {}) => (s == null ? null : { size: 4, shift: 0, ...dflt, ...s });
  if (!(t.entries > 0) || !(t.stride > 0)) throw new Error("trace: entries and stride must be positive");
  if (t.offset == null && t.baseField == null) throw new Error("trace: needs offset (the ring base) or baseField (where the base is stored)");
  if (!t.cursor || t.cursor.offset == null) throw new Error("trace: needs cursor:{offset, mode}");
  const fields = {};
  for (const [n, f] of Object.entries(t.fields ?? {})) fields[n] = span(f);
  return {
    base: t.offset ?? null,
    baseField: t.baseField ?? null,
    entries: t.entries,
    stride: t.stride,
    cursor: { size: 4, mode: "count", writable: false, ...t.cursor },
    enable: t.enable ?? null,
    pc: span(t.pc ?? { offset: 0 }),
    clock: span(t.clock),
    skipIf: t.skipIf ?? null,
    fields,
    filter: t.filter ?? null,
    note: t.note,
  };
}

/** Rings the backends kept before the section declared `trace` (all offsets are the backends' fixed layouts). */
function deriveTrace(L, refPlatform) {
  const plat = L.platform ?? refPlatform;
  const diag = L.diagnostics ?? {};
  const probeOff = (name) => {
    const pb = diag.probeBlock;
    if (pb && Array.isArray(pb.fields)) { const i = pb.fields.indexOf(name); if (i >= 0) return pb.offset + (pb.stride ?? 4) * i; }
    if (L.probe?.[name]) return L.probe[name].offset;
    return null;
  };
  if (plat === "nes" && diag.pcRing && probeOff("ringi") != null) {
    return { offset: diag.pcRing.offset, entries: diag.pcRing.entries, stride: diag.pcRing.stride,
      cursor: { offset: probeOff("ringi"), mode: "count" },
      pc: { offset: 0, mask: 0xffff }, clock: { offset: 4 },
      fields: { opcode: { offset: 0, shift: 16, mask: 0xff } } };
  }
  if ((plat === "gb" || plat === "gbc")) {
    // wat/gb/emit.js: PROBE 0x20000, ring of 2048 x {pc, rombank, sp, hl} at +4096, count at +124
    return { offset: 0x20000 + 4096, entries: 2048, stride: 16, cursor: { offset: 0x20000 + 124, mode: "count", writable: true },
      pc: { offset: 0, mask: 0xffff },
      fields: { rombank: { offset: 4 }, sp: { offset: 8, mask: 0xffff, ref: "cpu:sp" }, hl: { offset: 12, mask: 0xffff, ref: "cpu:registers.HL" } } };
  }
  if ((plat === "sms" || plat === "gg") && probeOff("traceBase") != null && probeOff("tracei") != null) {
    return { baseField: { offset: probeOff("traceBase") }, entries: L.emitter === "flat" ? 16384 : 8192, stride: 4,
      cursor: { offset: probeOff("tracei"), mode: "count" },
      pc: { offset: 0, mask: 0xffff }, fields: { line: { offset: 0, shift: 16, mask: 0xffff } } };
  }
  if (plat === "snes" && L.pcRing && L.probe?.[L.pcRing.cursorField ?? "npc"]) {
    return { offset: L.pcRing.offset, entries: L.pcRing.entries, stride: L.pcRing.stride ?? 4,
      cursor: { offset: L.probe[L.pcRing.cursorField ?? "npc"].offset, mode: "count" },
      pc: { offset: 0, mask: 0xffffff },
      filter: { romOnly: "snesLoRom", skip: SNES_SKIP_DEFAULT },
      note: "derived from pcRing: the skip ranges are the backend defaults; a cart built with options.pcSkip skipped more" };
  }
  if (plat === "gba" && L.gba?.trace) {
    const t = L.gba.trace;
    const fields = { thumb: { offset: 4 } };
    for (let i = 0; i < 16; i++) fields[`r${i}`] = { offset: 12 + 4 * i, ref: { region: "gba_cpu_regs", offset: 4 * i, size: 4 } };
    fields.cpsr = { offset: 76, ref: { region: "gba_cpu_regs", offset: 64, size: 4 } };
    return { offset: t.offset, entries: t.capacity, stride: t.entryBytes,
      cursor: { offset: t.count.offset, mode: "index", writable: true }, enable: { offset: t.enable.offset },
      pc: { offset: 0 }, clock: { offset: 8 }, fields };
  }
  if (plat === "genesis") {
    // wat/genesis: STATE = 0x39000; ring base at +0xF4, enable +0xF8, cursor (index, wraps) +0xFC;
    // entries {pc | bit31 = interrupt event, master cycle, refresh, cycle end}
    const S = 0x39000;
    return { baseField: { offset: S + 0xf4 }, entries: 1 << 18, stride: 16,
      cursor: { offset: S + 0xfc, mode: "index", writable: true }, enable: { offset: S + 0xf8 },
      pc: { offset: 0, mask: 0xffffff }, skipIf: { offset: 0, bit: 31 },
      fields: { mc: { offset: 4 }, refresh: { offset: 8 } } };
  }
  return null;
}

// ─── reading the two traces ──────────────────────────────────────────────────

function rd32(host, off) {
  const b = host.readMemory(off, 4);
  return (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0;
}
function wr32(host, off, v) {
  host.writeMemory(off, Uint8Array.of(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff));
}

/** Arm the cart's ring before the traced frame; returns the cursor state to read against. */
export function armCartTrace(cartHost, d) {
  if (d.enable) wr32(cartHost, d.enable.offset, 1);
  if (d.cursor.mode === "index") {
    if (!d.cursor.writable) throw new Error("trace: an index-mode cursor must be writable (the differ restarts it at 0)");
    wr32(cartHost, d.cursor.offset, 0);
    return { c0: 0 };
  }
  if (d.cursor.writable) { wr32(cartHost, d.cursor.offset, 0); return { c0: 0 }; }
  return { c0: rd32(cartHost, d.cursor.offset) };
}

const takeBits = (v, s) => ((s.shift ? v >>> s.shift : v) & (s.mask ?? 0xffffffff)) >>> 0;

/**
 * Read the entries recorded since armCartTrace.
 * @returns {{entries:{pc:number, clock:number|null, fields:object}[], recorded:number, kept:number, truncated:boolean}}
 */
export function readCartTrace(cartHost, d, st) {
  const c1 = rd32(cartHost, d.cursor.offset);
  if (d.enable) wr32(cartHost, d.enable.offset, 0);
  const recorded = (c1 - st.c0) >>> 0;
  const kept = Math.min(recorded, d.entries);
  const base = d.base ?? rd32(cartHost, d.baseField.offset);
  const first = (c1 - kept) >>> 0; // count of the oldest kept entry
  const entries = [];
  // Read the kept span in at most two contiguous pieces (the ring may wrap).
  let k = 0;
  while (k < kept) {
    const pos = (first + k) % d.entries;
    const run = Math.min(kept - k, d.entries - pos);
    const bytes = cartHost.readMemory(base + pos * d.stride, run * d.stride);
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let i = 0; i < run; i++) {
      const o = i * d.stride;
      const w = (s) => dv.getUint32(o + s.offset, true);
      if (d.skipIf && ((w(d.skipIf) >>> d.skipIf.bit) & 1)) continue;
      const fields = {};
      for (const [n, s] of Object.entries(d.fields)) fields[n] = takeBits(w(s), s);
      entries.push({ pc: takeBits(w(d.pc), d.pc), clock: d.clock ? w(d.clock) : null, fields, n: first + k + i });
    }
    k += run;
  }
  return { entries, recorded, kept, truncated: recorded > d.entries };
}

/** Would the cart ring have recorded this (normalised) reference pc? */
function refKeep(filter, pc) {
  if (!filter) return true;
  if (filter.romOnly === "snesLoRom") {
    if ((pc & 0xffff) < 0x8000 || ((pc >>> 16) & 0x7f) >= 0x7e) return false;
  }
  if (filter.skip) {
    const lo16 = pc & 0xffff;
    for (const [lo, hi] of filter.skip) if (lo16 >= lo && lo16 <= hi) return false;
  }
  return true;
}

/**
 * Recognise a halted CPU's re-executions in a reference stream fed entry by
 * entry: an entry repeating the previous pc exactly `step` clock units later
 * starts a run, and the run continues while the pc stays the same (a frame
 * boundary resets the clock). `repeat(pc, clock)` is true for an entry to
 * drop; the first entry of a run is kept. `startedInRun()`: the stream's
 * first entry was itself a re-execution (its second entry repeated it).
 * @param {number|null|undefined} step
 */
export function collapseHaltRepeats(step) {
  let prevPc = null, prevClk = null, inRun = false, n = 0, first = false;
  const st = {
    collapsed: 0,
    repeat(pc, clock) {
      n++;
      let drop = false;
      if (step != null && prevPc === pc && (inRun || (prevClk != null && clock != null && ((clock - prevClk) >>> 0) === step))) {
        drop = true;
        inRun = true;
        if (n === 2) first = true;
      } else inRun = false;
      prevPc = pc; prevClk = clock;
      if (drop) st.collapsed++;
      return drop;
    },
    startedInRun: () => first,
  };
  return st;
}

// ─── the walk (pure: unit-tested on synthetic streams) ───────────────────────

/**
 * Compare two normalised pc streams from (ia, ib) on.
 *
 * Interrupt timing: when exactly one side is at a handler entry (a pc in
 * `vectors`), the mismatch is recorded as kind 'interrupt-timing' and the
 * handler run is cut - to the first point where that stream shows the pc the
 * other side is at, confirmed over `confirm` instructions - and the walk goes
 * on, so the first divergence in program logic is found as well.
 *
 * @param {number[]|Uint32Array} a cart pcs
 * @param {number[]|Uint32Array} b reference pcs
 * @param {object} [o]
 * @param {number} [o.ia=0] @param {number} [o.ib=0]
 * @param {Set<number>} [o.vectors]
 * @param {(number|null)[]} [o.aClock] @param {(number|null)[]} [o.bClock]
 * @param {(i:number, j:number) => object[]|null} [o.regDiff] registers of the
 *   matched pair (before either executes) that differ, or null
 * @param {number} [o.confirm=16] instructions a resume point must match for
 * @param {number} [o.maxHandler=200000] longest handler run searched
 * @returns {{matched:number, firstDivergence:object|null, firstLogicDivergence:object|null,
 *   firstClockDivergence:object|null, firstRegisterDivergence:object|null, strippedCart:object[], strippedRef:object[],
 *   endA:number, endB:number, exhausted:string|null}}
 */
export function walkStreams(a, b, o = {}) {
  const vectors = o.vectors ?? new Set();
  const confirm = o.confirm ?? 16, maxHandler = o.maxHandler ?? 200000;
  let i = o.ia ?? 0, j = o.ib ?? 0, matched = 0;
  let firstDivergence = null, firstLogicDivergence = null, firstClockDivergence = null, firstRegisterDivergence = null;
  const strippedCart = [], strippedRef = [];
  let lastPair = null;
  // A resume point must match for `confirm` instructions, or up to the next
  // handler entry on either side (two interrupts a few instructions apart are
  // the common case, and the second one is stripped on its own turn).
  const windowAt = (x, xi, y, yi) => {
    const n = Math.min(confirm, x.length - xi, y.length - yi);
    if (n <= 0) return false;
    for (let k = 0; k < n; k++) {
      if (k > 0 && (vectors.has(x[xi + k]) || vectors.has(y[yi + k]))) return true;
      if (x[xi + k] !== y[yi + k]) return false;
    }
    return true;
  };
  /** Cut a handler run from `s` starting at `si` until it rejoins `other[oi]`. */
  const handlerEnd = (s, si, other, oi) => {
    const lim = Math.min(s.length, si + maxHandler);
    for (let k = si + 1; k < lim; k++) if (s[k] === other[oi] && windowAt(s, k, other, oi)) return k;
    return lim === s.length ? -2 : -1; // -2: the stream ended inside the handler
  };
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      if (o.aClock && o.bClock && lastPair && lastPair[0] === i - 1 && lastPair[1] === j - 1 && firstClockDivergence == null) {
        const ca = o.aClock[i], cb = o.bClock[j], pa = o.aClock[i - 1], pb = o.bClock[j - 1];
        if (ca != null && cb != null && pa != null && pb != null && ((ca - pa) >>> 0) !== ((cb - pb) >>> 0)) {
          firstClockDivergence = { cart: i - 1, ref: j - 1, cartCycles: (ca - pa) >>> 0, refCycles: (cb - pb) >>> 0 };
        }
      }
      if (o.regDiff && firstRegisterDivergence == null) {
        const diffs = o.regDiff(i, j);
        if (diffs && diffs.length) firstRegisterDivergence = { cart: i, ref: j, diffs, afterPair: lastPair && lastPair[0] === i - 1 && lastPair[1] === j - 1 ? [i - 1, j - 1] : null };
      }
      lastPair = [i, j];
      matched++; i++; j++;
      continue;
    }
    const aVec = vectors.has(a[i]), bVec = vectors.has(b[j]);
    const kind = aVec !== bVec ? "interrupt-timing" : "pc";
    firstDivergence ??= { cart: i, ref: j, kind };
    if (kind === "interrupt-timing") {
      const cut = bVec ? handlerEnd(b, j, a, i) : handlerEnd(a, i, b, j);
      if (cut >= 0) {
        if (bVec) { strippedRef.push({ at: j, length: cut - j, entry: b[j], resumeAt: a[i] }); j = cut; }
        else { strippedCart.push({ at: i, length: cut - i, entry: a[i], resumeAt: b[j] }); i = cut; }
        lastPair = null;
        continue;
      }
      if (cut === -2) {
        // the traced span ends inside that handler: the overlap is used up
        if (bVec) strippedRef.push({ at: j, length: b.length - j, entry: b[j], resumeAt: null });
        else strippedCart.push({ at: i, length: a.length - i, entry: a[i], resumeAt: null });
        return { matched, firstDivergence, firstLogicDivergence: null, firstClockDivergence, firstRegisterDivergence, strippedCart, strippedRef,
          endA: i, endB: j, exhausted: bVec ? "ref-in-handler" : "cart-in-handler" };
      }
      firstLogicDivergence = { cart: i, ref: j, kind: "interrupt-no-resume" };
      break;
    }
    firstLogicDivergence = { cart: i, ref: j, kind };
    break;
  }
  const exhausted = firstLogicDivergence ? null : i >= a.length && j >= b.length ? "both" : i >= a.length ? "cart" : "ref";
  return { matched, firstDivergence, firstLogicDivergence, firstClockDivergence, firstRegisterDivergence, strippedCart, strippedRef, endA: i, endB: j, exhausted };
}

/**
 * Where the cart stream starts inside the reference stream. Direct when both
 * begin at the same instruction (a frame boundary that coincides); otherwise
 * the first cart window of `window` pcs (tried at a few cart offsets) that
 * occurs EXACTLY ONCE in the reference. Ambiguity is refused, not guessed.
 * @returns {{ia:number, ib:number, method:string, hits?:number}|{error:string, ambiguous?:boolean, hits?:number[]}}
 */
export function alignStreams(a, b, { window = 64, direct = true, tries = 64 } = {}) {
  if (!a.length || !b.length) return { error: `${!a.length ? "the cart" : "the reference"} recorded no instructions` };
  if (direct) {
    // Both streams start at the same frame boundary: a few equal pcs are
    // enough (the divergence being hunted may be a handful of instructions in).
    const n = Math.min(4, a.length, b.length);
    let same = true;
    for (let k = 0; k < n; k++) if (a[k] !== b[k]) { same = false; break; }
    if (same) return { ia: 0, ib: 0, method: "frame-start" };
  }
  const w = Math.min(window, a.length);
  // index the reference by a 3-pc key; verify the full window per candidate
  const idx = new Map();
  const key = (x, s) => `${x[s]},${x[s + 1]},${x[s + 2]}`;
  for (let s = 0; s + w <= b.length; s++) {
    const k = key(b, s);
    const l = idx.get(k);
    if (l) l.push(s); else idx.set(k, [s]);
  }
  let ambiguous = null;
  const step = Math.max(1, Math.floor((a.length - w) / tries));
  for (let st = 0; st + w <= a.length && st <= (tries * step); st += step) {
    const cands = idx.get(key(a, st)) ?? [];
    const hits = cands.filter((s) => { for (let k = 0; k < w; k++) if (b[s + k] !== a[st + k]) return false; return true; });
    if (hits.length === 1) return { ia: st, ib: hits[0], method: "window", window: w };
    if (hits.length > 1) ambiguous ??= { cartStart: st, hits: hits.slice(0, 8) };
  }
  if (ambiguous) return { error: `the cart's ${w}-pc windows match the reference at several places (e.g. cart[${ambiguous.cartStart}] at ref ${ambiguous.hits.join(", ")}): a loop matches at every iteration`, ambiguous: true, hits: ambiguous.hits };
  return { error: `no ${w}-pc window of the cart appears in the reference: the streams share no aligned stretch in this frame (the cart diverged before the traced window, or the frame boundaries are further apart than the traced span)` };
}

// ─── reference state at an instruction ───────────────────────────────────────

/**
 * The reference CPU state just BEFORE its k-th executed instruction (k counts
 * every instruction the trace saw, filtered or not). `from.snapshot`: restore
 * the frame-start savestate, arm the instruction watchdog at k+1 (the core
 * freezes at that dispatch without executing it) and run one frame.
 * `from.openRef` (the load-time frames): a fresh reference with the watchdog
 * armed before its settle frames.
 */
async function refCpuAt(refHost, refPlatform, from, k) {
  let h = refHost, fresh = false;
  if (from.snapshot) {
    h.unserializeState(from.snapshot);
    h.setWatchdog(k + 1);
    for (let f = 0; f < 3 && !h.getPCBreak(false).watchdog; f++) h.stepFrames(1);
  } else {
    h = await from.openRef({ beforeSettle: (x) => x.setWatchdog(k + 1) });
    fresh = true;
  }
  try {
    const st = h.getPCBreak(false);
    if (!st.watchdog) return { error: `the watchdog did not stop the reference at instruction ${k}` };
    return { stoppedAtPc: st.lastPC, cpu: getCPUState(h, refPlatform) };
  } finally {
    if (fresh) disposeHost(h);
    else { h.setWatchdog(0); h.setPCBreak(0, false, false); }
  }
}

// ─── the op ──────────────────────────────────────────────────────────────────

function disposeHost(h) {
  try { if (typeof h?.dispose === "function") h.dispose(); else if (typeof h?.destroy === "function") h.destroy(); } catch { /* best effort */ }
}

/**
 * Find the first divergent instruction between a recompiled cart and its
 * reference core, within one frame.
 *
 * @param {object} a
 * @param {() => Promise<object>} a.openCart   fresh cart host
 * @param {() => Promise<object>} a.openRef    fresh reference host (LibretroHost)
 * @param {string} a.refPlatform
 * @param {object} a.layout                    validated romdev.recompile layout
 * @param {Uint8Array} [a.rom]                 the source ROM (interrupt vectors)
 * @param {Array|string} [a.input]             schedule in reference frames
 * @param {number|"auto"} [a.cartFrameOffset]
 * @param {number} [a.atFrame]                 reference frame whose execution is traced
 *                                             (default: the first frame the per-frame differ finds different)
 * @param {number} [a.startFrame] @param {number} [a.maxFrames]   bounds for that per-frame search
 * @param {number} [a.context=8]               instructions of context each side
 * @param {boolean} [a.registers=true]         compare per-instruction registers where both traces carry them
 * @param {boolean} [a.refState=true]          read the reference CPU at the first pc divergence (watchdog replay)
 * @param {Record<string,string>} [a.cartButtonMap]
 * @param {number} [a.searchFrame] @param {number} [a.searchWindow] @param {number} [a.minSharpness]
 * @returns {Promise<{result:object, cartHost:object, refHost:object}>}
 */
export async function findInstructionDivergence(a) {
  const layout = a.layout ?? {};
  const conv = REFERENCE_PC[a.refPlatform];
  if (!conv) throw new Error(`findDiverge level:'instruction': no pc convention for reference platform '${a.refPlatform}' (supported: ${Object.keys(REFERENCE_PC).join(", ")})`);
  const d = traceDescriptor(layout, a.refPlatform);
  const context = a.context ?? 8;

  // 1. which frame
  let F = a.atFrame, frameLevel = null;
  if (F == null) {
    const cartHost = await a.openCart();
    let refHost;
    try {
      refHost = await a.openRef();
      frameLevel = await findRecompileDivergence({
        cartHost, refHost, refPlatform: a.refPlatform, layout, input: a.input, cartFrameOffset: a.cartFrameOffset,
        startFrame: a.startFrame, maxFrames: a.maxFrames, stride: 1, openCart: a.openCart, openRef: a.openRef,
        searchFrame: a.searchFrame, searchWindow: a.searchWindow, minSharpness: a.minSharpness, cartButtonMap: a.cartButtonMap,
      });
    } finally { disposeHost(cartHost); disposeHost(refHost); }
    if (!frameLevel.diverged) {
      return { result: { op: "findDiverge", mode: "recompile", level: "instruction", diverged: false, frameLevel,
        note: "No frame's compared state differs, so there is no frame to trace. Pass atFrame to trace a chosen frame anyway (a picture-only difference, or a later window)." } };
    }
    F = frameLevel.atRefFrame;
  }
  if (!Number.isInteger(F) || F < 0) throw new Error("findDiverge level:'instruction': atFrame must be a reference frame >= 0 (the frame whose execution is traced: from the end of atFrame-1 to the end of atFrame; 0 = the load-time frames, from power-on)");

  // 2. fresh hosts on the shared frame axis. Frame 0 is the load itself: the
  //    core's settle frames and the cart's first wc_render, traced from
  //    power-on through the hosts' beforeSettle hooks.
  const boot = F === 0;
  const cap = Math.max(1 << 16, Math.min(1 << 22, a.refTraceCapacity ?? (1 << 21)));
  const schedule = parseInputSchedule(a.input);
  const nameMap = a.cartButtonMap ?? (layout.buttons === "byName" ? BY_NAME_CART_MAP : null);
  let st = null;
  // Register columns the core records AND the cart's trace carries, compared per instruction.
  const regNames = (h) => (h.traceRegisterNames?.() ?? []).filter((n) => d.fields[n]);
  const wantRegs = (h) => (a.registers ?? true) && regNames(h).length > 0;
  const refCap = (h) => (wantRegs(h) ? Math.min(cap, 1 << 19) : cap);
  const refHost = await a.openRef(boot ? { beforeSettle: (h) => {
    if (!h.traceSupported?.()) throw new Error(`the ${a.refPlatform} reference core build does not record an instruction trace (romdev_trace_*); rebuild it with scripts/build-<core>.sh`);
    h.setTrace({ capacity: refCap(h), registers: wantRegs(h) });
  } } : undefined);
  let cartHost;
  try { cartHost = await a.openCart(boot ? { beforeSettle: (h) => { st = armCartTrace(h, d); } } : undefined); } catch (e) { disposeHost(refHost); throw e; }
  try {
    if (!refHost.traceSupported?.()) throw new Error(`the ${a.refPlatform} reference core build does not record an instruction trace (romdev_trace_*); rebuild it with scripts/build-<core>.sh`);
    const searched = !boot && wantsSearch(layout, a.cartFrameOffset);
    const alignment = resolveAlignment(cartHost, refHost, layout, searched ? undefined : a.cartFrameOffset);
    if (searched) {
      const found = await searchFrameOffset({ openCart: a.openCart, openRef: a.openRef, schedule, nameMap, base: alignment.computedOffset,
        frame: a.searchFrame ?? Math.max(F, 600), window: a.searchWindow, minSharpness: a.minSharpness, origin: layout.screen?.origin });
      Object.assign(alignment, { offset: found.offset, source: "search", search: found });
    }
    const off = alignment.offset;
    if (!boot && F - 1 + off < 0) throw new Error(`atFrame ${F} is before the cart's first frame at offset ${off}`);
    const ref = new ScheduleDriver(refHost, schedule);
    const cart = new ScheduleDriver(cartHost, shiftSchedule(schedule, off), nameMap);
    let snapshot = null;
    if (!boot) {
      await ref.to(F - 1);
      await cart.to(F - 1 + off);
      snapshot = typeof refHost.serializeState === "function" ? refHost.serializeState() : null;
      // 3. one frame, both traced
      refHost.setTrace({ capacity: refCap(refHost), registers: wantRegs(refHost) });
      st = armCartTrace(cartHost, d);
      await ref.to(F);
      await cart.to(F + off);
    }
    const rt0 = refHost.readTrace(0);
    refHost.setTrace({ enabled: false });
    const ct = readCartTrace(cartHost, d, st);
    // accumulated reference stream (a window-aligned cart frame may run past
    // the reference frame's end; the next reference frame is appended then)
    const rt = { pc: Array.from(rt0.pc), clock: Array.from(rt0.clock), lost: rt0.lost, frames: 1,
      regs: rt0.regs ? Object.fromEntries(Object.entries(rt0.regs).map(([n, v]) => [n, Array.from(v)])) : null };

    // 4. normalise
    const cartPcs = ct.entries.map((e) => conv.cart(e) >>> 0);
    const cartClk = ct.entries.map((e) => e.clock);
    let refAll = [];
    const refIdx = [];
    const refPcs = [], refClk = [];
    // A halted CPU's re-executions (conv.haltRepeat) collapse to the one
    // entry the cart records; a run under way when the trace started (the
    // cart was already idle, so it has no entry for it) is dropped whole.
    const halt = collapseHaltRepeats(conv.haltRepeat);
    const addRef = () => {
      for (let k = refAll.length; k < rt.pc.length; k++) {
        const p = conv.ref(rt.pc[k]) >>> 0;
        refAll.push(p);
        if (halt.repeat(p, rt.clock[k])) continue;
        if (!refKeep(d.filter, p)) continue;
        refIdx.push(k); refPcs.push(p); refClk.push(rt.clock[k]);
      }
    };
    addRef();
    if (halt.startedInRun() && refPcs.length && cartPcs[0] !== refPcs[0]) { refIdx.shift(); refPcs.shift(); refClk.shift(); halt.collapsed++; }
    const cmpRegs = rt.regs ? Object.keys(rt.regs).filter((n) => d.fields[n]) : [];
    const regDiff = cmpRegs.length ? (i, j) => {
      const e = ct.entries[i], k = refIdx[j];
      let out = null;
      for (const n of cmpRegs) {
        const m = (d.fields[n].mask ?? 0xffffffff) >>> 0;
        const cv = (e.fields[n] & m) >>> 0, rv = (rt.regs[n][k] & m) >>> 0;
        if (cv !== rv) (out ??= []).push({ reg: n, cart: cv, ref: rv });
      }
      return out;
    } : null;
    const vectors = new Set(conv.vectors(a.rom).map((v) => conv.ref(v) >>> 0));

    const base = {
      op: "findDiverge", mode: "recompile", level: "instruction",
      refFrame: F, cartFrame: boot ? 0 : F + off, alignment,
      ...(boot ? { traced: `the load-time frames from power-on: the reference core's ${refHost.status?.settleFramesUsed ?? "?"} settle frames and the cart's first wc_render (plus its ${layout.warmupFrames ?? 0} warm-up frames)` } : {}),
      ...(frameLevel ? { frameLevel: { atRefFrame: frameLevel.atRefFrame, lastIdenticalRefFrame: frameLevel.lastIdenticalRefFrame, regions: frameLevel.regions, fields: frameLevel.fields } } : {}),
      trace: {
        source: d.source, ...(d.note ? { note: d.note } : {}),
        cart: { recorded: ct.recorded, kept: ct.kept, compared: cartPcs.length, ringEntries: d.entries, truncated: ct.truncated },
        ref: { recorded: rt.pc.length, lost: rt.lost, compared: refPcs.length, filteredOut: refAll.length - refPcs.length - halt.collapsed,
          ...(halt.collapsed ? { haltRepeatsCollapsed: halt.collapsed } : {}) },
      },
      interruptVectors: [...vectors].map((v) => hex(v, conv.pcWidth)),
    };
    if (rt.lost) base.trace.ref.note = `the reference ran more than ${cap} instructions in this frame; the oldest ${rt.lost} were overwritten`;
    const result0 = base;

    // 5. align + walk
    let al = alignStreams(cartPcs, refPcs, { direct: !ct.truncated });
    if (ct.truncated && !d.filter && !boot) {
      // The ring kept the frame's last `kept` of `recorded` instructions. When
      // the frame starts coincide, that tail begins at reference index
      // recorded - kept: take it when the pcs there agree (a tail inside a
      // loop is otherwise ambiguous by content alone).
      const ib = ct.recorded - ct.kept;
      let ok = ib < refPcs.length;
      for (let k = 0; ok && k < Math.min(16, cartPcs.length, refPcs.length - ib); k++) ok = cartPcs[k] === refPcs[ib + k];
      if (ok) al = { ia: 0, ib, method: "count" };
    }
    if (al.error && !cartPcs.length) {
      const probe = {};
      for (const [n, f] of Object.entries(layout.probe ?? {})) { try { probe[n] = rd32(cartHost, f.offset); } catch { /* skip */ } }
      return done({ ...base, diverged: true, conclusion: "cart-idle", reason: `the cart executed no instructions in this frame while the reference ran ${refPcs.length}`,
        ...(Object.keys(probe).length ? { cartProbe: probe } : {}),
        note: `The cart ran nothing this frame${probe.trapped ? ` (it TRAPPED${probe.trappc != null ? ` at pc $${probe.trappc.toString(16)}` : ""})` : " (stopped or trapped)"}. The divergence is earlier: omit atFrame so the per-frame differ finds the first differing frame, or trace an earlier one.` });
    }
    if (al.error) {
      return done({ ...base, diverged: null, conclusion: "no-alignment", reason: al.error,
        cartHead: cartPcs.slice(0, 12).map((p) => hex(p, conv.pcWidth)), refHead: refPcs.slice(0, 12).map((p) => hex(p, conv.pcWidth)),
        note: ct.truncated
          ? `The cart ring kept only the last ${ct.kept} of ${ct.recorded} instructions this frame (a ${d.entries}-entry ring), and that tail does not align with the reference: the divergence is earlier in the frame than the ring reaches. Trace an earlier frame (atFrame), or rebuild the cart with a bigger ring where the backend offers one.`
          : "The two streams share no uniquely aligned stretch. Check the frame alignment (alignment.meaning), or trace the frame before (atFrame - 1)." });
    }
    let w = walkStreams(cartPcs, refPcs, { ia: al.ia, ib: al.ib, vectors, aClock: d.clock ? cartClk : null, bClock: d.clock ? refClk : null, regDiff });
    // The cart frame runs past the reference frame (window alignment): trace
    // up to two more reference frames and walk again.
    while (!boot && !w.firstLogicDivergence && !w.firstRegisterDivergence && (w.exhausted === "ref" || w.exhausted === "ref-in-handler") && rt.frames < 3) {
      refHost.setTrace({ capacity: refCap(refHost), registers: wantRegs(refHost) });
      await ref.to(F + rt.frames);
      const more = refHost.readTrace(0);
      refHost.setTrace({ enabled: false });
      rt.pc.push(...more.pc); rt.clock.push(...more.clock); rt.lost += more.lost; rt.frames++;
      if (rt.regs && more.regs) for (const n of Object.keys(rt.regs)) rt.regs[n].push(...more.regs[n]);
      addRef();
      w = walkStreams(cartPcs, refPcs, { ia: al.ia, ib: al.ib, vectors, aClock: d.clock ? cartClk : null, bClock: d.clock ? refClk : null, regDiff });
      result0.trace.ref = { ...result0.trace.ref, recorded: rt.pc.length, compared: refPcs.length, filteredOut: refAll.length - refPcs.length - halt.collapsed,
        ...(halt.collapsed ? { haltRepeatsCollapsed: halt.collapsed } : {}), frames: rt.frames };
    }

    const ctx = (arr, clk, at, entries, isCart) => {
      const out = [];
      for (let k = Math.max(0, at - context); k < Math.min(arr.length, at + context + 1); k++) {
        const e = { i: k, pc: hex(arr[k], conv.pcWidth), ...(clk?.[k] != null ? { clock: clk[k] } : {}), ...(k === at ? { here: true } : {}) };
        if (isCart && entries?.[k] && Object.keys(entries[k].fields).length) e.fields = entries[k].fields;
        out.push(e);
      }
      return out;
    };
    const execAt = (k) => (conv.exec && ct.entries[k] ? { execPc: hex(conv.exec(ct.entries[k]), conv.pcWidth) } : {});
    const describePoint = (p) => {
      if (!p) return null;
      const lastCart = p.cart - 1, lastRef = p.ref - 1;
      return {
        kind: p.kind, cartIndex: p.cart, refIndex: p.ref,
        cartPc: p.cart < cartPcs.length ? hex(cartPcs[p.cart], conv.pcWidth) : null, ...(p.cart < cartPcs.length ? execAt(p.cart) : {}),
        refPc: p.ref < refPcs.length ? hex(refPcs[p.ref], conv.pcWidth) : null,
        ...(lastCart >= 0 && lastRef >= 0 && cartPcs[lastCart] === refPcs[lastRef]
          ? { lastCommonPc: hex(cartPcs[lastCart], conv.pcWidth), ...(conv.exec ? { lastCommonExecPc: execAt(lastCart).execPc } : {}), meaning: `both sides executed ${hex(cartPcs[lastCart], conv.pcWidth)}; the next instruction differs (cart ${p.cart < cartPcs.length ? hex(cartPcs[p.cart], conv.pcWidth) : "end"}, reference ${p.ref < refPcs.length ? hex(refPcs[p.ref], conv.pcWidth) : "end"}), so ${hex(cartPcs[lastCart], conv.pcWidth)} is where control flow split` }
          : {}),
        cartContext: ctx(cartPcs, d.clock ? cartClk : null, p.cart, ct.entries, true),
        refContext: ctx(refPcs, refClk, p.ref, null, false),
      };
    };

    const result = {
      ...base,
      aligned: { method: al.method, cartStart: al.ia, refStart: al.ib },
      matched: w.matched,
      interrupts: { strippedCart: w.strippedCart.length, strippedRef: w.strippedRef.length,
        ...(w.strippedCart.length ? { firstCart: { at: w.strippedCart[0].at, entry: hex(w.strippedCart[0].entry, conv.pcWidth), length: w.strippedCart[0].length } } : {}),
        ...(w.strippedRef.length ? { firstRef: { at: w.strippedRef[0].at, entry: hex(w.strippedRef[0].entry, conv.pcWidth), length: w.strippedRef[0].length } } : {}) },
      firstDivergence: describePoint(w.firstDivergence),
      firstLogicDivergence: describePoint(w.firstLogicDivergence),
      firstClockDivergence: w.firstClockDivergence ? {
        cartIndex: w.firstClockDivergence.cart, refIndex: w.firstClockDivergence.ref,
        pc: hex(cartPcs[w.firstClockDivergence.cart], conv.pcWidth), ...execAt(w.firstClockDivergence.cart),
        cartCycles: w.firstClockDivergence.cartCycles, refCycles: w.firstClockDivergence.refCycles,
        meaning: `the instruction at ${hex(cartPcs[w.firstClockDivergence.cart], conv.pcWidth)} took ${w.firstClockDivergence.cartCycles} clock units on the cart and ${w.firstClockDivergence.refCycles} on the reference (same pcs on both sides up to here)`,
      } : null,
    };
    result.diverged = !!(w.firstDivergence || w.firstClockDivergence);

    // 6. registers, compared per matched instruction where both traces carry them
    if (cmpRegs.length) {
      const rd = w.firstRegisterDivergence;
      result.registers = { compared: cmpRegs, firstDiffering: null };
      if (rd) {
        const fx = (v) => hex(v, 8);
        result.registers.firstDiffering = { cartIndex: rd.cart, refIndex: rd.ref, pc: hex(cartPcs[rd.cart], conv.pcWidth), ...execAt(rd.cart),
          diffs: rd.diffs.map((x) => ({ reg: x.reg, cart: fx(x.cart), ref: fx(x.ref) })) };
        if (rd.afterPair) {
          const at = rd.afterPair[0], ex = execAt(at).execPc;
          result.registers.producedBy = { cartIndex: at, pc: hex(cartPcs[at], conv.pcWidth), ...execAt(at),
            meaning: `registers agree before ${hex(cartPcs[at], conv.pcWidth)}${ex ? ` (the instruction at ${ex})` : ""} executes and differ after it (${rd.diffs.map((x) => `${x.reg} cart ${fx(x.cart)} ref ${fx(x.ref)}`).join(", ")}): that instruction computed a different value` };
        } else {
          result.registers.note = rd.cart === al.ia
            ? `registers already differ at the first compared instruction: the wrong value was produced earlier; trace atFrame ${F - 1}${F - 1 === 0 ? " (the load-time frames)" : ""}`
            : "registers differ right after an interrupt handler run was stripped, so the producing instruction is inside or at the edge of that run";
        }
        result.diverged = true;
      }
    }
    // the reference CPU at the first pc divergence (a watchdog-stopped replay)
    const fdv = w.firstDivergence;
    if (fdv && conv.singleCpu && (snapshot || boot) && typeof refHost.setWatchdog === "function" && (a.refState ?? true) && fdv.ref < refIdx.length) {
      try {
        const r = await refCpuAt(refHost, a.refPlatform, snapshot ? { snapshot } : { openRef: a.openRef }, refIdx[fdv.ref]);
        if (result.firstDivergence) result.firstDivergence.refCpuHere = r.error ? { error: r.error } : r.cpu;
        if (snapshot) { refHost.unserializeState(snapshot); refHost.stepFrames(1); }
      } catch (e) { if (result.firstDivergence) result.firstDivergence.refCpuHere = { error: e.message }; }
    }

    // 7. verdict text
    if (!result.diverged) {
      result.conclusion = w.exhausted === "both" ? "no-divergence" : "no-divergence-in-overlap";
      result.note = `The cart's ${cartPcs.length - al.ia} traced instructions match the reference pc for pc${d.clock ? " and cycle for cycle" : ""}${result.registers?.compared?.length ? `, registers (${result.registers.compared.join(" ")}) included` : ""}, from ${al.method === "frame-start" ? "the frame start" : al.method === "count" ? `the ring's oldest entry (instruction ${al.ib} of the frame on both sides)` : `cart[${al.ia}] = ref[${al.ib}]`} to ${w.exhausted === "both" ? "the end of both" : `the end of the ${w.exhausted} stream`}.${ct.truncated ? ` The cart ring kept only the last ${ct.kept} of ${ct.recorded} instructions, so earlier ones were not compared.` : ""}`;
    } else {
      const fd = result.firstDivergence;
      result.conclusion = result.registers?.producedBy ? "registers" : fd?.kind === "interrupt-timing" ? "interrupt-timing" : fd ? "pc" : result.registers?.firstDiffering ? "registers" : "clock";
      const parts = [];
      if (fd) parts.push(fd.kind === "interrupt-timing"
        ? `an interrupt handler starts at a different instruction: cart[${fd.cartIndex}] ${fd.cartPc} vs ref[${fd.refIndex}] ${fd.refPc}`
        : `control flow splits after ${fd.lastCommonPc ?? "the aligned start"}: cart next ${fd.cartPc}, reference next ${fd.refPc}`);
      if (fd?.kind === "interrupt-timing") {
        parts.push(result.firstLogicDivergence
          ? `after stripping handler runs, logic splits after ${result.firstLogicDivergence.lastCommonPc ?? "?"} (cart next ${result.firstLogicDivergence.cartPc}, reference next ${result.firstLogicDivergence.refPc})`
          : `after stripping ${w.strippedCart.length + w.strippedRef.length} handler run(s) the program logic matches for the rest of the overlap (${w.exhausted === "both" ? "both streams" : `the ${w.exhausted.replace("-in-handler", " stream, which ends inside a handler")}`})`);
      }
      if (result.firstClockDivergence) parts.push(result.firstClockDivergence.meaning);
      if (result.registers?.producedBy) parts.unshift(`FIRST: ${result.registers.producedBy.meaning}`);
      result.note = parts.join("; ") + ".";
    }
    return done(result);
  } catch (e) {
    disposeHost(cartHost); disposeHost(refHost);
    throw e;
  }

  function done(result) { return { result, cartHost, refHost }; }
}
