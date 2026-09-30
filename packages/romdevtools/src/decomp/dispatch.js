// dispatch.js - resource-aware parallel candidate production.
//
// `runBatch` is a serial `for` loop: it generates and compares one function at
// a time even when the functions live in independent translation units. On a
// 12-core/24-thread machine that leaves the whole mechanical frontier idle
// while an agent hand-orchestrates work in fragile prose.
//
// TWO RULES SHAPE EVERYTHING HERE.
//
// 1. PARALLEL WORK ENDS AT EVIDENCE. Generating a candidate and comparing it
//    produces evidence in the workspace and touches nothing in the project
//    tree. Editing shared sources and integrating do touch it, and they stay
//    serialized behind the function / TU-collateral / full-ROM gates. This
//    module therefore NEVER integrates and never writes to the checkout.
//
// 2. MEMORY IS THE REAL BUDGET, NOT CORES. A thread count cannot express "IDO
//    under instrumentation takes 1.5 GB". Workers are admitted against a
//    measured memory ceiling, actual peak RSS is recorded per worker class, and
//    concurrency adapts from what was measured rather than from a hardcoded
//    number. The box that OOM-killed a romdev server twice is the reason this
//    is not `Promise.all(everything)`.
//
// Per-TU locks are the correctness requirement: two workers must never build
// the same owner concurrently, because compileAndCompare splices the candidate
// into that TU.
//
// Plain JS ESM + JSDoc.

import os from "node:os";

/** Worker classes, with their starting memory estimates (MiB). Estimates are
 *  only a seed - measured peak RSS replaces them as soon as one completes. */
export const WORKER_CLASSES = Object.freeze({
  generate: { label: "m2c generation", startMiB: 400 },
  compare: { label: "candidate compile + compare", startMiB: 600 },
  instrumented: { label: "instrumented IDO", startMiB: 1500 },
  permuter: { label: "romdev-permuter (decomp-permuter port)", startMiB: 1200 },
  emulator: { label: "emulator/runtime", startMiB: 800 },
});

/**
 * A memory-bounded, per-key-locked work pool.
 *
 * `budgetMiB` is the ceiling for THIS pool, not for the machine: the caller
 * reserves headroom for the server and the build first.
 */
export class Dispatcher {
  /**
   * @param {{budgetMiB?:number, maxWorkers?:number, reserveMiB?:number, onEvent?:(e:object)=>void}} [opts]
   */
  constructor(opts = {}) {
    const totalMiB = Math.floor(os.totalmem() / (1024 * 1024));
    // Reserve for the romdev server itself, the OS, and any build that runs.
    this.reserveMiB = opts.reserveMiB ?? Math.min(8192, Math.floor(totalMiB * 0.25));
    this.budgetMiB = opts.budgetMiB ?? Math.max(1024, totalMiB - this.reserveMiB);
    this.maxWorkers = opts.maxWorkers ?? Math.max(1, Math.min(os.cpus().length - 2, 12));
    this.onEvent = opts.onEvent ?? (() => {});

    this.inFlightMiB = 0;
    this.running = 0;
    this.locks = new Set();          // per-TU (or any key) exclusion
    this.measured = new Map();       // class -> {peakMiB, samples}
    this.cancelled = false;
    this._waiters = [];
    this.stats = { admitted: 0, completed: 0, failed: 0, deferredForMemory: 0, deferredForLock: 0 };
  }

  /** Current memory estimate for a class: measured peak if we have one. */
  estimateMiB(cls) {
    const m = this.measured.get(cls);
    if (m?.peakMiB) return Math.max(m.peakMiB, 64);
    return WORKER_CLASSES[cls]?.startMiB ?? 512;
  }

  /** Record a real peak so later admissions use measurement, not a guess. */
  recordPeak(cls, peakMiB) {
    if (!Number.isFinite(peakMiB) || peakMiB <= 0) return;
    const m = this.measured.get(cls) ?? { peakMiB: 0, samples: 0 };
    // Track the high-water mark: admitting against an average overcommits.
    m.peakMiB = Math.max(m.peakMiB, Math.round(peakMiB));
    m.samples++;
    this.measured.set(cls, m);
  }

  cancel() { this.cancelled = true; this._release(); }

  _release() { const w = this._waiters; this._waiters = []; for (const r of w) r(); }
  _wait() { return new Promise((r) => this._waiters.push(r)); }

  /**
   * Run `fn` under the pool's budget and an optional exclusive `lockKey`.
   * Resolves to `{ok, value|error, class, lockKey, peakMiB, ms}`.
   */
  async run({ cls = "compare", lockKey = null, fn, label }) {
    const need = this.estimateMiB(cls);
    // Admission: wait for both memory headroom and the lock.
    for (;;) {
      if (this.cancelled) return { ok: false, cancelled: true, class: cls, lockKey, label };
      const memOk = this.inFlightMiB + need <= this.budgetMiB || this.running === 0; // never deadlock on an over-budget single job
      const slotOk = this.running < this.maxWorkers;
      const lockOk = !lockKey || !this.locks.has(lockKey);
      if (memOk && slotOk && lockOk) break;
      if (!memOk) this.stats.deferredForMemory++;
      else if (!lockOk) this.stats.deferredForLock++;
      await this._wait();
    }

    if (lockKey) this.locks.add(lockKey);
    this.inFlightMiB += need;
    this.running++;
    this.stats.admitted++;
    const startedAt = Date.now();
    const rssBefore = process.memoryUsage().rss / (1024 * 1024);
    this.onEvent({ type: "start", cls, lockKey, label, running: this.running, inFlightMiB: this.inFlightMiB });

    try {
      const value = await fn();
      // Best-effort peak: in-process work shows up in our own RSS. A child
      // process reports its own peak through the result when it can.
      const peak = Math.max(rssBefore, process.memoryUsage().rss / (1024 * 1024));
      const delta = peak - rssBefore;
      this.recordPeak(cls, value?.peakMiB ?? (delta > 1 ? delta : need));
      this.stats.completed++;
      return { ok: true, value, class: cls, lockKey, label, ms: Date.now() - startedAt };
    } catch (e) {
      this.stats.failed++;
      return { ok: false, error: e, class: cls, lockKey, label, ms: Date.now() - startedAt };
    } finally {
      this.running--;
      this.inFlightMiB -= need;
      if (lockKey) this.locks.delete(lockKey);
      this.onEvent({ type: "end", cls, lockKey, label, running: this.running });
      this._release();
    }
  }

  /** Run many tasks under the pool; order of completion is not order of input. */
  async all(tasks) {
    return await Promise.all(tasks.map((t) => this.run(t)));
  }

  report() {
    return {
      budgetMiB: this.budgetMiB, reserveMiB: this.reserveMiB, maxWorkers: this.maxWorkers,
      machine: { totalMiB: Math.floor(os.totalmem() / (1024 * 1024)), cpus: os.cpus().length },
      measuredPeakMiB: Object.fromEntries([...this.measured].map(([k, v]) => [k, { peakMiB: v.peakMiB, samples: v.samples }])),
      stats: this.stats,
      policy: "admission is by MEASURED memory, not a hardcoded worker count; per-TU locks keep two workers off the same owner; "
        + "parallelism ends at candidate/evidence production - shared source edits and integration stay serialized behind the "
        + "function, TU-collateral and full-ROM gates.",
    };
  }
}

/**
 * Bulk triage of untouched functions (the reporter's item 10).
 *
 * Runs resolve -> generate -> compile/compare per function, in parallel across
 * INDEPENDENT translation units, and buckets every result by what actually
 * blocks it. Never integrates, never edits the tree.
 *
 * @param {import("./project.js").Project} project
 * @param {string[]} symbols
 */
export async function triage(project, symbols, {
  maxFunctions = 64, budgetMiB, maxWorkers, timeBudgetS = 3600, onEvent,
} = {}) {
  const { generateCandidate } = await import("./m2c.js");
  const { compileAndCompare } = await import("./compile.js");
  const started = Date.now();
  const d = new Dispatcher({ budgetMiB, maxWorkers, onEvent });
  // Entries may be bare names or {symbol, segment} target records. A bare name
  // is not an identity when overlays share a VA, and keying anything by name
  // alone would also let two different overlay functions collide in the maps
  // below.
  const { normalizeTarget, targetId } = await import("./plan.js");
  const picked = symbols.slice(0, maxFunctions).map(normalizeTarget);
  const keyOf = (t) => `${t.segment ?? ""}:${t.symbol}`;

  const tasks = picked.map((t) => ({
    cls: "compare",
    label: t.symbol,
    key: keyOf(t),
    // THE LOCK KEY IS THE TU: compileAndCompare splices the candidate into its
    // owning translation unit, so two workers on one TU would race.
    lockKey: null, // resolved below once we know the TU
    fn: async () => {
      if ((Date.now() - started) / 1000 > timeBudgetS) return { symbol: t.symbol, segment: t.segment ?? null, skipped: "time budget exhausted" };
      const fn = await project.resolveFunction({ symbol: t.symbol, segment: t.segment, va: t.va });
      const g = await generateCandidate(project, fn);
      const r = await compileAndCompare(project, fn, { candidateText: g.code, candidatePath: g.candidatePath, label: "triage" });
      return { symbol: t.symbol, targetId: targetId(fn), segment: fn.segment ?? null, fn, g, r };
    },
  }));

  // Resolve TUs first (cheap, and it gives us the lock keys + independence).
  const tuOf = new Map();
  await Promise.all(picked.map(async (t) => {
    try { const f = await project.resolveFunction({ symbol: t.symbol, segment: t.segment, va: t.va }); tuOf.set(keyOf(t), f.source?.tu ?? null); } catch { tuOf.set(keyOf(t), null); }
  }));
  for (const t of tasks) t.lockKey = tuOf.get(t.key) ?? `__no_tu__${t.key}`;

  const settled = await d.all(tasks);

  const buckets = {
    "exact-pending-semantic-review": [], "compilable-structurally-close": [],
    "allocation-schedule-residual": [], "wrong-control-flow-or-shape": [],
    "type-or-prototype-blocker": [], "m2c-or-import-failure": [],
    "likely-known-libultra-source": [], "manual-first-large-function": [],
    skipped: [],
  };

  for (const s of settled) {
    const sym = s.label;
    if (!s.ok) {
      const msg = String(s.error?.message ?? s.error ?? "");
      const code = s.error?.code ?? "ERROR";
      const bucket = /FUNCTION_NOT_IN_TU|NO_TARGET_ASM|M2C|import/i.test(code + msg) ? "m2c-or-import-failure" : "m2c-or-import-failure";
      buckets[bucket].push({ symbol: sym, code, error: msg.slice(0, 200) });
      continue;
    }
    const v = s.value;
    if (v?.skipped) { buckets.skipped.push({ symbol: sym, reason: v.skipped }); continue; }
    const { fn, g, r } = v;
    const sizeBytes = fn?.sizeBytes ?? 0;
    // Carry the EVIDENCE into the bucket. A bucket name without the compiler's
    // own words is just a label, and the next agent has to re-run everything to
    // learn what actually blocked the function.
    const diags = (r?.diagnostics ?? []).filter((d) => d?.severity === "error");
    const firstErrors = diags.slice(0, 4).map((d) => String(d.message ?? d).replace(/^cfe: (Error|Warning \d+): /, "").slice(0, 160));
    const row = {
      symbol: sym, tu: fn?.source?.tu ?? null, sizeBytes,
      compileSucceeded: r?.compileSucceeded ?? false,
      functionLocal: r?.verdict?.functionLocal ?? null,
      distance: r?.distance?.value ?? null,
      kinds: r?.differenceKinds ?? [],
      missingDeclarations: (g?.missingDeclarations ?? []).map((m) => m.name).slice(0, 8),
      ...(firstErrors.length ? { errorCount: diags.length, firstErrors } : {}),
      candidatePath: g?.candidatePath ?? null,
      ms: s.ms,
    };

    if (r?.exactFunctionMatch && r?.verdict?.functionLocal === "exact") {
      // EXACT IS NOT DONE. A byte-exact candidate can still be artificial, so
      // it is queued for semantic review rather than declared finished.
      buckets["exact-pending-semantic-review"].push(row);
    } else if (!r?.compileSucceeded) {
      // An undeclared identifier is a TYPE problem (fixable by context/headers);
      // a syntax error is m2c emitting C the compiler cannot parse. Those need
      // different work, so they must not share a bucket.
      const undeclared = row.missingDeclarations.length
        || firstErrors.some((m) => /undeclared|not declared|unknown type|undefined symbol/i.test(m));
      buckets[undeclared ? "type-or-prototype-blocker" : "m2c-or-import-failure"].push(row);
    } else if (sizeBytes >= 4096) {
      buckets["manual-first-large-function"].push(row);
    } else if (row.kinds.some((k) => /register|schedul|alloc|reorder/i.test(k))) {
      buckets["allocation-schedule-residual"].push(row);
    } else if (row.distance != null && row.distance <= 20) {
      buckets["compilable-structurally-close"].push(row);
    } else {
      buckets["wrong-control-flow-or-shape"].push(row);
    }
  }

  const counts = Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, v.length]));
  return {
    requested: symbols.length, processed: picked.length,
    elapsedS: Math.round((Date.now() - started) / 1000),
    counts, buckets,
    dispatcher: d.report(),
    note: "TRIAGE ONLY: nothing was integrated and the project tree was not modified. "
      + "'exact-pending-semantic-review' means byte-exact, NOT accepted - a candidate can be exact and artificial, "
      + "so it still needs the semantic gate before integration.",
  };
}
