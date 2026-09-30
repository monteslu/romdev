// main.js - decomp-permuter's src/main.py: load permuter directories, score
// their bases, then evaluate seeds until done (non-random), a zero is found
// (--stop-on-zero), or the caller aborts. Multi-threaded mode runs the
// candidate evaluation in node worker threads (upstream: multiprocessing).
//
// Output lines match upstream's so existing log readers keep working:
//   "[fn] base score = N", "found new best score! (N vs M)", "wrote to <dir>", ...
import { existsSync, mkdirSync, writeFileSync, readFileSync, statSync, rmSync } from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { Compiler } from "./compiler.js";
import { CandidateConstructionFailure } from "./error.js";
import {
  get_settings, get_default_randomization_weights, json_prop, json_dict, merge_randomization_weights, trim_source,
} from "./helpers.js";
import { Permuter } from "./permuter.js";
import { preprocess as defaultPreprocess } from "./preprocess.js";
import { Scorer, PENALTY_INF } from "./scorer.js";
import { setObjdumpGlue, resolveObjdumpGlue } from "./objdump.js";

export const DEFAULT_RAND_KEEP_PROB = 0.6;

/** Options with upstream's defaults (main.Options), plus the in-process hooks. */
export function makeOptions(o) {
  return {
    directories: o.directories,
    show_errors: false, show_timings: false, print_diffs: false, stack_differences: false,
    algorithm: "difflib", abort_exceptions: false, better_only: false, best_only: false,
    score_threshold: null, quiet: false, stop_on_zero: false, keep_prob: DEFAULT_RAND_KEEP_PROB,
    force_seed: null, threads: 1, use_network: false, network_debug: false, network_priority: 1.0,
    no_context_output: false, debug_mode: false, speed: 100, ign_branch_targets: true,
    // In-process extensions (not upstream flags):
    out: null, // (s: string) => void, receives everything upstream prints to stdout
    signal: null, // AbortSignal: stop like Ctrl+C ("Exiting.")
    pahConfig: null, // permuter@home Config (default: pah.conf in the working directory)
    workers: null, // force worker threads even for threads == 1 (keeps the caller's event loop free)
    preprocess: null, // (filename) => string: `cpp -P -nostdinc -DPERMUTER` equivalent
    compileFn: null, // (cPath, oPath) => Promise<boolean> instead of compile.sh
    compileModule: null, // {url, name, config?}: module export fn(cPath, oPath, config, compileScript) (worker threads import it)
    compileTimeoutMs: 0,
    tmpDir: null, // scratch dir for candidate .c/.o (default: <dir>/.permuter-tmp)
    objdumpGlue: null, // {mips: "/path/to/objdump.mjs", ...}
    onResult: null, // (info) => void for every scored candidate (stats)
    ...o,
  };
}

class Printer {
  constructor(write) {
    this.write = write;
    this._last_progress = null;
  }

  progress(message) {
    let clear = "";
    if (this._last_progress != null) {
      const pad = Math.max(this._last_progress.length - message.length + 10, 0);
      clear = "\b".repeat(pad) + " ".repeat(pad) + "\r";
    }
    this.write(clear + message);
    this._last_progress = message;
  }

  print(message, permuter, who, { color = "", keep_progress = false } = {}) {
    if (this._last_progress != null) {
      if (keep_progress) this.write("\n");
      else {
        const pad = this._last_progress.length + 10;
        this.write("\r" + " ".repeat(pad) + "\r");
      }
    }
    if (permuter != null) message = `[${permuter.unique_name}] ${message}`;
    if (who != null) message = `[${who}] ${message}`;
    if (color) message = `${color}${message}\u001b[0m`;
    this.write(message + "\n");
    this._last_progress = null;
  }
}

function writeCandidate(perm, result, no_context_output, print) {
  let ctr = 0;
  let output_dir;
  for (;;) {
    ctr += 1;
    output_dir = path.join(perm.dir, `output-${result.score}-${ctr}`);
    try {
      mkdirSync(output_dir);
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
    }
  }
  const source = result.source;
  if (source == null) throw new Error("Permuter._need_to_send_source is wrong!");
  writeFileSync(path.join(output_dir, "source.c"), no_context_output ? trim_source(source, perm.fn_name) : source, { flag: "wx" });
  writeFileSync(path.join(output_dir, "score.txt"), `${result.score}\n`, { flag: "wx" });
  writeFileSync(path.join(output_dir, "diff.txt"), perm.diff(source) + "\n", { flag: "wx" });
  print(`wrote to ${output_dir}`);
  return output_dir;
}

/**
 * Run the permuter over `options.directories`. Resolves to each permuter's
 * best score (like main.run) and a `stats` record for the caller.
 */
export async function run(options) {
  const o = makeOptions(options);
  const write = o.out ?? ((s) => process.stdout.write(s));
  const print = (s = "") => write(s + "\n");
  if (o.compileModule && !o.compileFn) o.compileFn = await loadCompileModule(o.compileModule);
  if (o.objdumpGlue) for (const [arch, glue] of Object.entries(o.objdumpGlue)) setObjdumpGlue(arch, glue);
  const context = {
    printer: new Printer(write), iteration: 0, errors: 0, internal_errors: 0,
    internal_error_stack_traces: new Set(), permuters: [], timings: { perm: 0, stringify: 0, compile: 0, score: 0 },
    improvements: [], outputs: [],
  };
  const stats = { iterations: 0, compileFailures: 0, internalErrors: 0, improvements: context.improvements, outputs: context.outputs,
    stopReason: null, foundZero: false, passCounts: {} };
  print("Loading...");
  let force_seed = null, force_rng_seed = null;
  if (o.force_seed) {
    const seed_parts = String(o.force_seed).split(",").map((s) => BigInt(s.trim()));
    force_rng_seed = seed_parts[seed_parts.length - 1];
    force_seed = seed_parts.length === 1 ? 0n : seed_parts[0];
  }
  const name_counts = new Map();
  const configs = [];
  for (const d of o.directories) {
    const compile_cmd = path.join(d, "compile.sh");
    const target_o = path.join(d, "target.o");
    const base_c = path.join(d, "base.c");
    for (const fname of o.compileFn ? [target_o, base_c] : [compile_cmd, target_o, base_c]) {
      if (!existsSync(fname) || !statSync(fname).isFile()) throw new PermuterUsageError(`Missing file ${fname}`);
    }
    const settings = get_settings(d);
    const compiler_type = json_prop(settings, "compiler_type", "str", "base");
    const default_weights = get_default_randomization_weights(compiler_type);
    const weight_overrides = json_dict(json_prop(settings, "weight_overrides", "dict", {}), "float");
    const randomization_weights = merge_randomization_weights(default_weights, weight_overrides);
    let fn_name = null;
    if ("func_name" in settings) fn_name = json_prop(settings, "func_name", "str");
    if (!fn_name) {
      try { fn_name = readFileSync(path.join(d, "function.txt"), "utf8").trim(); } catch (e) { if (e.code !== "ENOENT") throw e; }
    }
    print(fn_name ? `${base_c} (${fn_name})` : base_c);
    const tmpDir = o.tmpDir ?? path.join(d, ".permuter-tmp");
    const compilerOpts = { show_errors: o.show_errors, debug_mode: o.debug_mode, tmpDir, timeoutMs: o.compileTimeoutMs,
      log: (s) => write(s) };
    const compiler = new Compiler(compile_cmd, { ...compilerOpts, compileFn: o.compileFn });
    const objdump_command = json_prop(settings, "objdump_command", "str", "") || null;
    const scorerOpts = { target_o, stack_differences: o.stack_differences, algorithm: o.algorithm, debug_mode: o.debug_mode,
      ign_branch_targets: o.ign_branch_targets, objdump_command };
    const scorer = await Scorer.create(scorerOpts);
    const c_source = await (o.preprocess ?? defaultPreprocess)(base_c);
    const permOpts = {
      dir: d, fn_name, source_file: base_c, source: c_source, randomization_weights, force_seed, force_rng_seed,
      keep_prob: o.keep_prob, need_profiler: o.show_timings, need_all_sources: o.print_diffs, show_errors: o.show_errors,
      best_only: o.best_only, better_only: o.better_only, score_threshold: o.score_threshold, debug_mode: o.debug_mode,
      speed: o.speed,
    };
    let permuter;
    try {
      permuter = await Permuter.create({ ...permOpts, compiler, scorer, log: print });
    } catch (e) {
      if (e instanceof CandidateConstructionFailure) throw new PermuterUsageError(e.message);
      throw e;
    }
    context.permuters.push(permuter);
    configs.push({ permOpts: { ...permOpts, fn_name: permuter.fn_name }, compile_cmd, compileModule: o.compileModule, compilerOpts: { ...compilerOpts, log: undefined },
      scorerOpts, base: { score: permuter.base_score, hash: permuter.base_hash, source: permuter.base_source } });
    name_counts.set(permuter.fn_name, (name_counts.get(permuter.fn_name) ?? 0) + 1);
  }
  print();
  if (!context.permuters.length) {
    print("No permuters!");
    return { bestScores: [], stats };
  }
  for (const permuter of context.permuters) {
    if (name_counts.get(permuter.fn_name) > 1) permuter.unique_name += ` (${permuter.dir})`;
    print(`[${permuter.unique_name}] base score = ${permuter.best_score}`);
  }
  stats.baseScores = context.permuters.map((p) => p.base_score);
  if (o.debug_mode) {
    for (const p of context.permuters) {
      for (const block of p.scorer.debugLog) write(block + "\n");
    }
    print("End of Debug Mode... Exiting");
    return { bestScores: context.permuters.map((p) => p.best_score), stats: { ...stats, stopReason: "debug" } };
  }

  const post_score = (permuter, result, who) => {
    if (result.isEvalError) {
      context.internal_errors += 1;
      stats.internalErrors += 1;
      if (result.exc_str != null) {
        if (context.internal_error_stack_traces.has(result.exc_str)) return false;
        context.internal_error_stack_traces.add(result.exc_str);
        context.printer.print("internal permuter failure.", permuter, who, { keep_progress: true });
        print(result.exc_str);
      }
      if (result.seed != null) {
        let seed_str = String(result.seed[1]);
        if (result.seed[0] !== 0n) seed_str = `${result.seed[0]},${seed_str}`;
        print(`To reproduce the failure, rerun with: --seed ${seed_str}`);
      }
      if (o.abort_exceptions) throw new PermuterAbort("internal permuter failure (--abort-exceptions)");
      return false;
    }
    if (o.print_diffs) {
      print();
      print(permuter.diff(result.source));
    }
    if (result.profiler) for (const k of Object.keys(context.timings)) context.timings[k] += result.profiler[k] ?? 0;
    const score_value = result.score;
    context.iteration += 1;
    stats.iterations = context.iteration;
    if (result.pass) stats.passCounts[result.pass] = (stats.passCounts[result.pass] ?? 0) + 1;
    let disp_score;
    if (score_value === PENALTY_INF) {
      disp_score = "inf";
      context.errors += 1;
      stats.compileFailures += 1;
    } else disp_score = String(score_value);
    let status_line = `iteration ${context.iteration}, ${context.errors} errors, `;
    if (context.internal_errors) status_line += `${context.internal_errors} permuter failures, `;
    status_line += `score = ${disp_score}`;
    if (o.show_timings) {
      const total = Object.values(context.timings).reduce((a, b) => a + b, 0) || 1;
      status_line += "  \t" + Object.entries(context.timings).map(([k, v]) => `${Math.round(100 * v / total)}% ${k}`).join(", ");
    }
    if (o.onResult) o.onResult({ score: score_value, pass: result.pass ?? null, iteration: context.iteration });
    if (permuter.should_output(result)) {
      const former_best = permuter.best_score;
      permuter.record_result(result);
      let color, msg;
      if (score_value < former_best) { color = "\u001b[32;1m"; msg = `found new best score! (${score_value} vs ${permuter.base_score})`; }
      else if (score_value === former_best) { color = "\u001b[32;1m"; msg = `tied best score! (${score_value} vs ${permuter.base_score})`; }
      else if (score_value < permuter.base_score) { color = "\u001b[33m"; msg = `found a better score! (${score_value} vs ${permuter.base_score})`; }
      else { color = "\u001b[33m"; msg = `found different asm with same score (${score_value})`; }
      context.printer.print(msg, permuter, who, { color });
      const dir = writeCandidate(permuter, result, o.no_context_output, print);
      context.outputs.push({ dir, score: score_value, pass: result.pass ?? null, iteration: context.iteration });
      if (score_value < permuter.base_score) context.improvements.push({ score: score_value, previous: permuter.base_score, iteration: context.iteration, pass: result.pass ?? null, dir });
    }
    if (!o.quiet) context.printer.progress(status_line);
    return score_value === 0;
  };

  let found_zero = false;
  const aborted = () => o.signal?.aborted;
  const useWorkers = o.workers ?? (o.threads > 1 || o.use_network);
  if (useWorkers && o.compileFn && !o.compileModule) throw new PermuterUsageError("worker threads need options.compileModule ({url, name}); a compileFn closure cannot cross threads");
  try {
    if (!useWorkers) {
      for (const [permuter_index, seed] of cycle_seeds(context.permuters)) {
        if (aborted()) { stats.stopReason = "aborted"; break; }
        const permuter = context.permuters[permuter_index];
        const start = performance.now();
        const result = await permuter.try_eval_candidate(seed);
        if (post_score(permuter, result, null)) {
          found_zero = true;
          if (o.stop_on_zero) { stats.stopReason = "zero"; break; }
        }
        if (permuter.speed !== 100) await sleep((performance.now() - start) * (100 / permuter.speed - 1));
        // Yield so an abort signal can land between candidates.
        await new Promise((r) => setImmediate(r));
      }
    } else {
      const r = await runWorkers({ o, context, configs, post_score });
      found_zero = r.found_zero;
      stats.stopReason = r.stopReason;
    }
  } catch (e) {
    if (e instanceof PermuterAbort) { stats.stopReason = "abort-exceptions"; print(e.message); }
    else throw e;
  } finally {
    for (const cfg of configs) {
      try { rmSync(cfg.compilerOpts.tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
  if (!stats.stopReason) stats.stopReason = aborted() ? "aborted" : "exhausted";
  if (stats.stopReason === "aborted") {
    print();
    print("Exiting.");
  }
  stats.foundZero = found_zero;
  if (found_zero) print("\nFound zero score! Exiting.");
  stats.bestScores = context.permuters.map((p) => p.best_score);
  return { bestScores: stats.bestScores, stats };
}

class PermuterAbort extends Error {}

/** Import a compile module ({url, name, config}) as a (cPath, oPath) => Promise<boolean> function. */
export async function loadCompileModule({ url, name, config = null }) {
  const fn = (await import(url))[name];
  if (typeof fn !== "function") throw new PermuterUsageError(`compile module ${url} has no function ${name}`);
  return (cPath, oPath, script) => fn(cPath, oPath, config, script);
}

export class PermuterUsageError extends Error {
  constructor(message) { super(message); this.name = "PermuterUsageError"; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

/** All (permuter index, seed) pairs, cycling over permuters (main.cycle_seeds). */
export function* cycle_seeds(permuters) {
  const iterators = permuters.map((p, i) => [i, p.seed_iterator()]);
  let i = 0;
  while (iterators.length) {
    i %= iterators.length;
    const [perm_ind, it] = iterators[i];
    const item = it.next();
    if (item.done) {
      iterators.splice(i, 1);
      i -= 1;
    } else {
      yield [perm_ind, item.value];
    }
    i += 1;
  }
}

const WORKER_URL = new URL("./worker.js", import.meta.url);

/**
 * Multi-threaded evaluation: local worker threads and permuter@home
 * connections pull seeds from the parent, which scores and writes results.
 */
async function runWorkers({ o, context, configs, post_score }) {
  const seed_iterators = context.permuters.map((p) => p.seed_iterator());
  let seed_iterators_remaining = seed_iterators.length;
  let next_iterator_index = 0;
  // get_task(-1): round-robin over permuters (local workers); get_task(i): permuter i (a p@h connection).
  const get_task = (perm_index = -1) => {
    if (perm_index !== -1) {
      const it = seed_iterators[perm_index];
      if (it == null) return null;
      const n = it.next();
      if (n.done) { seed_iterators[perm_index] = null; seed_iterators_remaining -= 1; return null; }
      return [perm_index, n.value];
    }
    while (seed_iterators_remaining > 0) {
      const idx = next_iterator_index;
      next_iterator_index = (next_iterator_index + 1) % seed_iterators.length;
      const task = get_task(idx);
      if (task) return task;
    }
    return null;
  };
  const threads = Math.max(0, o.threads);
  const glue = {};
  for (const p of context.permuters) glue[p.scorer.arch.name] = await resolveObjdumpGlue(p.scorer.arch.name);
  let found_zero = false;
  let stopReason = null;
  let stopping = false;
  const workers = [];
  const netConns = [];
  // Connect to permuter@home first (upstream does, before starting workers).
  if (o.use_network) {
    const { connect, enable_debug_mode, EOFError } = await import("./net/core.js");
    const { start_client } = await import("./net/client.js");
    const print = (s) => context.printer.write(s + "\n");
    print("Connecting to permuter@home...");
    if (o.network_debug) enable_debug_mode();
    let first_stats = null;
    for (let perm_index = 0; perm_index < context.permuters.length; perm_index++) {
      let port;
      try {
        port = await connect(o.pahConfig ?? null);
      } catch (e) {
        if (e instanceof EOFError || e.name === "ServerError") throw new PermuterUsageError(`Error: ${e.message}`);
        throw e;
      }
      const conn = { queue: [], waiter: null, finished: false, done: null, outstanding: 0, exhausted: false };
      conn.nextTask = () => new Promise((resolve) => {
        if (conn.queue.length) resolve(conn.queue.shift());
        else conn.waiter = resolve;
      });
      conn.put = (task) => {
        if (conn.waiter) { const w = conn.waiter; conn.waiter = null; w(task); } else conn.queue.push(task);
      };
      conn.port = port;
      netConns.push(conn);
      const { done, stats } = await start_client(port, context.permuters[perm_index], perm_index, conn.nextTask,
        (item, source, who) => onNetFeedback(item, source, who), o.network_priority);
      conn.done = done;
      first_stats ??= stats;
    }
    const plural = (n, noun) => `${n} ${noun}${n !== 1 ? "s" : ""}`;
    print(`Connected! ${plural(first_stats[1], "server")} online (${plural(Math.trunc(first_stats[2]), "core")}, ${plural(first_stats[0], "other client")})`);
  }
  if (!threads && !netConns.length) throw new PermuterUsageError("No workers available! Exiting.");

  let finishAll = () => {};
  let rejectAll = () => {};
  let resolveAll = () => {};
  function onNetFeedback(item, source, who) {
    try {
      if (item.type === "need_work") {
        if (stopping) return;
        const conn = netConns[source];
        if (conn.exhausted) return;
        const task = get_task(source);
        if (task) { conn.outstanding += 1; conn.put(task[1]); } else if (seed_iterators_remaining === 0 || seed_iterators[source] == null) {
          // No more seeds for this connection: stop sending, but keep the
          // connection until the work already out comes back (upstream never
          // hangs up and waits forever; hanging up at once loses results).
          stopReason ??= "exhausted";
          conn.exhausted = true;
          conn.put(null);
          if (conn.outstanding <= 0) conn.port.shutdown();
        }
      } else if (item.type === "message") {
        context.printer.print(item.text, null, who, { keep_progress: true });
        // A server that disconnects takes its share of the outstanding work with it.
        const conn = netConns[source];
        if (conn.exhausted && item.text === "disconnected") conn.port.shutdown();
      } else if (item.type === "done") {
        const conn = netConns[source];
        conn.outstanding -= 1;
        if (conn.exhausted && conn.outstanding <= 0) conn.port.shutdown();
        if (stopping && o.stop_on_zero && found_zero) return;
        if (post_score(context.permuters[source], item.result, who)) {
          found_zero = true;
          if (o.stop_on_zero) { stopReason = "zero"; finishAll(); }
        }
      } else if (item.type === "finished") {
        const conn = netConns[source];
        conn.finished = true;
        if (item.reason) context.printer.print(item.reason, context.permuters.length > 1 ? context.permuters[source] : null, null, { keep_progress: true });
        checkDone();
      }
    } catch (e) {
      finishAll();
      rejectAll(e);
    }
  }
  let live = 0;
  const checkDone = () => {
    if (live === 0 && (stopping || netConns.every((c) => c.finished))) resolveAll();
  };
  await new Promise((resolveP, rejectP) => {
    resolveAll = resolveP;
    rejectAll = rejectP;
    finishAll = () => {
      if (stopping) return;
      stopping = true;
      for (const w of workers) w.postMessage({ type: "finish" });
      // Signal the connections that no more work is coming, and hang up.
      for (const c of netConns) { c.put(null); c.port.shutdown(); }
      checkDone();
    };
    // Abort: let each worker finish the candidate it is on (a compile can own a
    // WASM child process that must not be orphaned mid-request), then force it.
    const onAbort = () => {
      stopReason = "aborted";
      finishAll();
      const t = setTimeout(() => { for (const w of workers) w.terminate(); }, 2000);
      t.unref?.();
    };
    if (o.signal) {
      if (o.signal.aborted) { stopReason = "aborted"; finishAll(); }
      else o.signal.addEventListener("abort", onAbort, { once: true });
    }
    for (let k = 0; k < threads && !stopping; k++) {
      const w = new Worker(WORKER_URL, { workerData: { configs, glue, keep_prob: o.keep_prob } });
      workers.push(w);
      live += 1;
      w.on("message", (msg) => {
        try {
          if (msg.type === "need") {
            // Hand out a batch, so a busy parent event loop (the host process
            // may be serving other work) does not stall the worker per candidate.
            if (stopping) { w.postMessage({ type: "finish" }); return; }
            const tasks = [];
            for (let q = 0; q < (msg.count ?? 1); q++) {
              const task = get_task();
              if (!task) break;
              tasks.push({ perm_index: task[0], seed: task[1] });
            }
            // An empty, exhausted batch means: drain what you hold, then stop.
            if (!tasks.length) stopReason ??= "exhausted";
            w.postMessage({ type: "tasks", tasks, exhausted: !tasks.length });
          } else if (msg.type === "done") {
            if (stopping && o.stop_on_zero && found_zero) return;
            if (post_score(context.permuters[msg.perm_index], msg.result, null)) {
              found_zero = true;
              if (o.stop_on_zero) { stopReason = "zero"; finishAll(); }
            }
          } else if (msg.type === "fatal") {
            stopReason = "worker-failed";
            context.printer.print(`worker failed: ${msg.error}`, null, null, { keep_progress: true });
            finishAll();
          }
        } catch (e) {
          finishAll();
          rejectAll(e);
        }
      });
      w.on("error", (e) => { context.printer.print(`worker error: ${e.message}`, null, null, { keep_progress: true }); });
      w.on("exit", () => {
        live -= 1;
        if (live === 0 && (stopping || !netConns.length)) {
          o.signal?.removeEventListener?.("abort", onAbort);
          if (!netConns.length) resolveAll(); else checkDone();
        }
      });
    }
    checkDone();
  });
  for (const c of netConns) { c.port.close(); await c.done; }
  return { found_zero, stopReason };
}
