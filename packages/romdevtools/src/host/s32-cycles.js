// sync32 cycle accounting: per-frame CPU cycles and a pc-sampling profile.
// Backs frame({op:'cycles'}) on a sync32 cart.
//
// s32core charges every ARMv8-M instruction a deterministic cycle cost and
// exposes (a) the work cycles of each frame, i.e. from one present() to the
// next with the vblank wait excluded (region sync32_timing, a 4096-frame
// ring), and (b) a pc profiler whose buckets sum to the same cycles (region
// sync32_profile; the vblank snap is not charged to anyone). This runs a
// frame span on an input schedule, reads both, and reports the per-frame
// series against the ABI floor (2.5M cycles, the 150 MHz guarantee) and the
// clocks shipping boards run at (252 MHz = 4.2M, 315 MHz = 5.25M), plus where
// the cycles went: per function (from the build's linker map), per object
// file and per named group of object files.
//
// The cycle costs are s32core's estimates: there is no flash wait-state or
// XIP cache model, so code and tables executed from flash cost what SRAM
// would. Hardware is the real answer.
//
// Plain JS ESM + JSDoc.

import { readFileSync, existsSync } from "node:fs";
import { parseInputSchedule, ScheduleDriver } from "./verify-recompile.js";

export const FLOOR = 2500000;
export const BUDGETS = { floor150MHz: 2500000, mhz252: 4200000, mhz315: 5250000 };
const XIP_BASE = 0x10100000;
const PROF_HDR = 16;
const PROF_MAX = 1 << 20;
const OUTSIDE = "(outside the image: RAM code, console)";

/** object-file name -> group name ("other" when no pattern matches) */
function groupMatcher(groups) {
  const cache = new Map();
  return (o) => {
    if (cache.has(o)) return cache.get(o);
    let hit = "other";
    outer: for (const [name, pats] of Object.entries(groups)) for (const p of pats) {
      if (p.startsWith("/") ? new RegExp(p.slice(1, p.lastIndexOf("/"))).test(o) : p === o) { hit = name; break outer; }
    }
    cache.set(o, hit);
    return hit;
  };
}

function u32s(host, region, offWords, n) {
  const b = host.readMemory(region, offWords * 4, n * 4);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const out = new Uint32Array(n);
  for (let i = 0; i < n; i++) out[i] = dv.getUint32(i * 4, true);
  return out;
}

/** The core's frame counter and the ring of per-frame work cycles. */
export function readTiming(host) {
  if (!(host.regionSize?.("sync32_timing") > 64)) throw new Error("this s32core build has no sync32_timing region (rebuild romdev-core-s32core with scripts/build-s32core.sh)");
  const h = u32s(host, "sync32_timing", 0, 16);
  if (h[0] !== 0x54323353) throw new Error("sync32_timing: bad magic");
  return { framesPresented: h[4], lastFrameCycles: h[5], cap: h[8], recorded: h[9] };
}
function ringCycles(host, recordedFrom, recordedTo, cap) {
  const all = u32s(host, "sync32_timing", PROF_HDR, cap);
  const out = [];
  for (let k = recordedFrom; k <= recordedTo; k++) out.push(all[(k - 1) % cap]);
  return out;
}

/** Symbols ({addr, size, name, object}) from a GNU ld map. */
export function parseLdMap(map) {
  const syms = [];
  const objs = [];
  const lines = map.split("\n");
  let cur = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    let m = /^ (\.(?:text|rodata)[^\s]*)\s+0x([0-9a-f]+)\s+0x([0-9a-f]+)\s+(\S+)$/.exec(l);
    if (!m && /^ \.(?:text|rodata)\S*$/.test(l) && i + 1 < lines.length) {
      const n = /^\s+0x([0-9a-f]+)\s+0x([0-9a-f]+)\s+(\S+)$/.exec(lines[i + 1]);
      if (n) { m = [null, l.trim(), n[1], n[2], n[3]]; i++; }
    }
    if (m) {
      const addr = parseInt(m[2], 16), size = parseInt(m[3], 16);
      const object = m[4].replace(/^.*\//, "").replace(/\.o$/, "");
      cur = { addr, size, object, section: m[1] };
      if (size) {
        objs.push(cur);
        // -ffunction-sections: a static function has its own .text.<name>
        // section but no symbol line in the map; name it after the section
        const fnm = /^\.text\.(.+)$/.exec(m[1]);
        if (fnm) syms.push({ addr, name: fnm[1], object, end: addr + size, fromSection: true });
      }
      continue;
    }
    const s = /^\s+0x([0-9a-f]{8})\s+([A-Za-z_][\w.$]*)\s*$/.exec(l);
    if (s && cur) {
      const addr = parseInt(s[1], 16);
      if (addr >= cur.addr && addr < cur.addr + cur.size) syms.push({ addr, name: s[2], object: cur.object, end: cur.addr + cur.size });
    }
  }
  // a global symbol at a section's start names it better than the section
  const seen = new Map();
  for (const s of syms) {
    const o = seen.get(s.addr);
    if (!o || (o.fromSection && !s.fromSection)) seen.set(s.addr, s);
  }
  syms.length = 0;
  syms.push(...seen.values());
  syms.sort((a, b) => a.addr - b.addr);
  for (let i = 0; i < syms.length; i++) {
    const next = i + 1 < syms.length ? syms[i + 1].addr : Infinity;
    syms[i].size = Math.min(syms[i].end, next) - syms[i].addr;
  }
  objs.sort((a, b) => a.addr - b.addr);
  return { syms, objs };
}

const pct = (v, of) => (of ? Math.round((v / of) * 10000) / 100 : 0);
function stats(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))];
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  return { frames: xs.length, min: s[0], mean: Math.round(mean), p50: q(0.5), p95: q(0.95), p99: q(0.99), max: s[s.length - 1],
    pctOfFloor: { min: pct(s[0], FLOOR), mean: pct(mean, FLOOR), max: pct(s[s.length - 1], FLOOR) } };
}

/**
 * Run `host` (a loaded sync32 LibretroHost) from its current frame to `to`,
 * on `input` (frames counted since loadMedia), measuring frames from..to.
 * @param {object} a
 * @param {object} a.host
 * @param {number} a.from        first measured frame (frames stepped since load, 1-based)
 * @param {number} a.to          last measured frame
 * @param {string|Array} [a.input]
 * @param {boolean} [a.profile]  also run the pc profiler over from..to
 * @param {string} [a.map]       linker map text (for per-function attribution)
 * @param {Record<string,string[]>} [a.groups] group name -> object-file names (or /regex/)
 * @param {number} [a.top=25]
 * @param {boolean} [a.series]   include the whole per-frame series
 * @param {boolean} [a.perFrame] with profile+map+groups: each group's cycles
 *                               frame by frame (min/mean/max per group)
 */
export async function measureCycles(a) {
  const host = a.host;
  const schedule = parseInputSchedule(a.input);
  const drv = new ScheduleDriver(host, schedule, null);
  drv.at = host.status?.frameCount ?? 0;
  if (a.from < drv.at + 1) throw new Error(`cycles: the session is already at frame ${drv.at}; from (${a.from}) must be later (load the cart fresh, or pass a later from)`);
  if (a.to < a.from) throw new Error("cycles: to must be >= from");
  await drv.to(a.from - 1);
  const t0 = readTiming(host);
  let prof = null;
  if (a.profile) {
    const n = Math.min(PROF_MAX - 1, 3 * 1024 * 1024 / 4);
    const ctl = new Uint32Array([0x50323353, 1, XIP_BASE, 2, n, 0, 1, 0]);
    host.writeMemory("sync32_profile", 0, new Uint8Array(ctl.buffer));
    prof = { base: XIP_BASE, shift: 2, n };
  }
  // per-frame group split: the buckets accumulate, so each frame's share is
  // the difference of the group sums before and after it
  let pf = null;
  if (prof && a.perFrame) {
    if (!a.map || !a.groups) throw new Error("cycles: perFrame needs the build's linker map and groups (a native cart built by romdev has both)");
    const { objs } = parseLdMap(a.map);
    const names = [...Object.keys(a.groups), "other"];
    const match = groupMatcher(a.groups);
    const idx = new Uint8Array(prof.n);
    let oi = 0;
    for (let b = 0; b < prof.n - 1; b++) {
      const addr = prof.base + (b << prof.shift);
      while (oi + 1 < objs.length && objs[oi + 1].addr <= addr) oi++;
      const o = objs[oi];
      idx[b] = names.indexOf(match(o && addr >= o.addr && addr < o.addr + o.size ? o.object : "(other)"));
    }
    idx[prof.n - 1] = names.indexOf(match(OUTSIDE));
    const prev = new Float64Array(names.length);
    const rows = names.map(() => []);
    drv.observe((f) => {
      if (f < a.from || f > a.to) return;
      const buckets = u32s(host, "sync32_profile", PROF_HDR, prof.n);
      const cur = new Float64Array(names.length);
      for (let b = 0; b < prof.n; b++) { const v = buckets[b]; if (v) cur[idx[b]] += v; }
      for (let g = 0; g < names.length; g++) { rows[g].push(cur[g] - prev[g]); prev[g] = cur[g]; }
    });
    pf = { names, rows };
  }
  await drv.to(a.to);
  const t1 = readTiming(host);
  const count = t1.recorded - t0.recorded;
  if (count !== a.to - a.from + 1) throw new Error(`cycles: the core recorded ${count} frames for ${a.to - a.from + 1} stepped (did the cart fault?)`);
  if (count > t1.cap) throw new Error(`cycles: ${count} frames exceed the core's ${t1.cap}-frame history; measure a shorter span per call`);
  const series = ringCycles(host, t0.recorded + 1, t1.recorded, t1.cap);
  const over = (lim) => series.filter((c) => c > lim).length;
  const out = {
    op: "cycles",
    frames: { from: a.from, to: a.to, count },
    cyclesPerFrame: stats(series),
    budgets: Object.fromEntries(Object.entries(BUDGETS).map(([k, v]) => [k, { cycles: v, framesOver: over(v), maxPct: pct(Math.max(...series), v) }])),
    worstFrames: series.map((c, i) => ({ frame: a.from + i, cycles: c })).sort((x, y) => y.cycles - x.cycles).slice(0, 5),
    ...(a.series ? { series } : {}),
    note: "Work cycles per 60 Hz frame from s32core's deterministic model: present() to present(), vblank wait excluded. The floor (2.5M) is the ABI guarantee (150 MHz-equivalent); shipping boards clock core 0 at 252 MHz (4.2M/frame) or 315 MHz (5.25M). No flash wait-state or XIP cache model: real hardware can only be slower where code or tables stream from flash.",
  };
  if (prof) {
    const h = u32s(host, "sync32_profile", 0, 8);
    const buckets = u32s(host, "sync32_profile", PROF_HDR, prof.n);
    host.writeMemory("sync32_profile", 4, new Uint8Array(4)); // disable
    let total = 0;
    for (const v of buckets) total += v;
    const measured = series.reduce((s, c) => s + c, 0);
    const outside = buckets[prof.n - 1];
    const res = { framesProfiled: h[7], cycles: total, matchesFrameTotal: total === measured, frameTotal: measured, outsideXipCycles: outside };
    if (a.map) {
      const { syms, objs } = parseLdMap(a.map);
      const fn = new Map(), ob = new Map();
      let si = 0, oi = 0, unattributed = 0;
      for (let b = 0; b < prof.n - 1; b++) {
        const v = buckets[b];
        if (!v) continue;
        const addr = prof.base + (b << prof.shift);
        while (si + 1 < syms.length && syms[si + 1].addr <= addr) si++;
        while (oi + 1 < objs.length && objs[oi + 1].addr <= addr) oi++;
        const s = syms[si];
        if (s && addr >= s.addr && addr < s.addr + Math.max(4, s.size)) fn.set(s.name, (fn.get(s.name) ?? 0) + v);
        else unattributed += v;
        const o = objs[oi];
        const on = o && addr >= o.addr && addr < o.addr + o.size ? o.object : "(other)";
        ob.set(on, (ob.get(on) ?? 0) + v);
      }
      ob.set(OUTSIDE, (ob.get(OUTSIDE) ?? 0) + outside);
      const perFrame = (v) => Math.round(v / count);
      res.byFunction = [...fn].sort((x, y) => y[1] - x[1]).slice(0, a.top ?? 25).map(([name, v]) => ({ name, cyclesPerFrame: perFrame(v), pct: pct(v, total) }));
      res.byObject = [...ob].sort((x, y) => y[1] - x[1]).map(([name, v]) => ({ object: name, cyclesPerFrame: perFrame(v), pct: pct(v, total) }));
      if (a.groups) {
        const g = new Map();
        const match = groupMatcher(a.groups);
        for (const [o, v] of ob) g.set(match(o), (g.get(match(o)) ?? 0) + v);
        res.byGroup = [...g].sort((x, y) => y[1] - x[1]).map(([group, v]) => ({ group, cyclesPerFrame: perFrame(v), pct: pct(v, total) }));
      }
      if (unattributed) res.unattributedCycles = unattributed;
      if (pf) {
        const sumFrames = pf.rows[0].map((_, i) => pf.rows.reduce((s, r) => s + r[i], 0));
        res.perFrameMatchesSeries = sumFrames.every((v, i) => v === series[i]);
        res.byGroupPerFrame = pf.names.map((group, g) => {
          const st = stats(pf.rows[g]);
          return { group, min: st.min, mean: st.mean, p95: st.p95, max: st.max };
        }).filter((r) => r.max > 0).sort((x, y) => y.mean - x.mean);
        const worst = series.indexOf(Math.max(...series));
        res.worstFrameByGroup = { frame: a.from + worst, cycles: series[worst], groups: Object.fromEntries(pf.names.map((n, g) => [n, pf.rows[g][worst]]).filter(([, v]) => v)) };
        if (a.series) res.groupSeries = Object.fromEntries(pf.names.map((n, g) => [n, pf.rows[g]]));
      }
    } else {
      res.note = "pass `map` (the build's linker map, e.g. <cart>.s32.map) to attribute the cycles to functions, objects and groups";
    }
    out.profile = res;
  }
  return out;
}

/** The linker map a native build wrote beside a cart, if any. */
export function mapBeside(cartPath) {
  for (const p of [cartPath + ".map", cartPath.replace(/\.s32$/, ".map")]) if (existsSync(p)) return readFileSync(p, "utf8");
  return null;
}

/**
 * Per-instruction cycles of one function over a frame span: the pc profiler
 * at halfword resolution across the function, and the function's code
 * disassembled from the cart image (Thumb-2), hottest instructions first and
 * in address order.
 * @param {object} a
 * @param {object} a.host        loaded sync32 LibretroHost
 * @param {Uint8Array} a.image   the .s32 file (its XIP image follows a 64-byte header)
 * @param {string} a.map         the build's linker map
 * @param {string} a.fn          function (symbol or .text.<static> section name)
 * @param {number} a.from
 * @param {number} a.to
 * @param {string|Array} [a.input]
 * @param {number} [a.top=40]
 */
export async function annotateFunction(a) {
  const { syms } = parseLdMap(a.map);
  const s = syms.find((x) => x.name === a.fn);
  if (!s) {
    const near = syms.filter((x) => x.name.includes(a.fn)).slice(0, 8).map((x) => x.name);
    throw new Error(`cycles annotate: no function '${a.fn}' in the map${near.length ? ` (did you mean ${near.join(", ")}?)` : ""}`);
  }
  const host = a.host;
  const drv = new ScheduleDriver(host, parseInputSchedule(a.input), null);
  drv.at = host.status?.frameCount ?? 0;
  if (a.from < drv.at + 1) throw new Error(`cycles annotate: the session is already at frame ${drv.at}; from must be later`);
  await drv.to(a.from - 1);
  const nb = Math.ceil(s.size / 2) + 1;
  if (nb > PROF_MAX) throw new Error(`cycles annotate: ${a.fn} is too large to annotate`);
  host.writeMemory("sync32_profile", 0, new Uint8Array(new Uint32Array([0x50323353, 1, s.addr, 1, nb, 0, 1, 0]).buffer));
  const t0 = readTiming(host);
  await drv.to(a.to);
  const t1 = readTiming(host);
  const frames = t1.recorded - t0.recorded;
  const buckets = u32s(host, "sync32_profile", PROF_HDR, nb);
  host.writeMemory("sync32_profile", 4, new Uint8Array(4));
  let total = 0;
  for (let i = 0; i < nb - 1; i++) total += buckets[i];
  const off = s.addr - XIP_BASE + 64;
  const { runObjdump } = await import("../toolchains/objdump.js");
  const r = await runObjdump({ bytes: a.image.subarray(off, off + s.size), arch: "thumb", startAddress: s.addr });
  const rows = (r.raw ?? "").split("\n").filter((l) => /^\s*[0-9a-f]+:\t/.test(l)).map((l) => {
    const addr = parseInt(l.trim().split(":")[0], 16);
    return { addr, cyclesPerFrame: Math.round(buckets[(addr - s.addr) >> 1] / Math.max(1, frames)), text: l.trim().replace(/^[0-9a-f]+:\s+/, "").replace(/\s+/g, " ") };
  });
  const top = a.top ?? 40;
  const hot = [...rows].sort((x, y) => y.cyclesPerFrame - x.cyclesPerFrame).slice(0, top);
  const hotSet = new Set(hot.map((x) => x.addr));
  return {
    function: a.fn, object: s.object, address: "0x" + s.addr.toString(16), bytes: s.size, frames, cyclesPerFrame: Math.round(total / Math.max(1, frames)),
    listing: rows.filter((x) => hotSet.has(x.addr)).map((x) => `${String(x.cyclesPerFrame).padStart(8)}  ${x.addr.toString(16)}  ${x.text}`),
    note: "cycles per frame charged to each instruction (s32core model); the listing is the hottest instructions in address order",
  };
}
