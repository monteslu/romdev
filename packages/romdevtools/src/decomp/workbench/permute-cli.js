// permute-cli.js - `permute sweep`, `permute doctor`, `permute classify`
// (flat: permute-sweep, permute-doctor, permute-classify) and the bare
// `permute` listing.
//
// The sweep is the highest-value, zero-reasoning lever in a late-stage
// campaign, and the one every host re-implements. The command forces the
// parts that are not opinions -- real recovered flags, the replicated
// post-compile chain, --stack-diffs -- and reports, rather than promotes,
// what it found. The permuter itself is romdev's JS port (see
// permute-sweep.js for the backend contract).
//
// Plain JS ESM + JSDoc.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ArgumentTypeError } from "./argparse.js";
import { listingSpec } from "./cli.js";
import { ValueError, strRepr, isInputError, osErrorText } from "./py.js";
import { expanduser } from "./py-path.js";
import { dumps } from "./pyjson.js";
import {
  QueueItem, completedFunctions, earlierResults, loadGateNote, loadQueue, loadRanking, orderQueue, renderQueue, renderTable, sweepPayload,
} from "./permute.js";
import { CLASSES, classifyPayload, classifySummary, renderMarkdown } from "./permute-classify.js";
import { PermuterError, IMPORT_TOOL, SEARCH_TOOL, doctor, renderDoctor, resolvePlan, runSweep, writeSummary } from "./permute-sweep.js";
import { checkRankingFresh, freshnessNote, freshnessWarning, gitHead } from "./ranking.js";

const SWEEP_DESCRIPTION = "Drive decomp-permuter over a queue of functions with the fidelity a "
  + "transferable result needs. Each function's scratch is built from the "
  + "project's real recipe -- the codegen flags recovered from the build's "
  + "own dry run, plus any post-compile objcopy chain replicated into the "
  + "scratch's compile.sh -- and every search runs with --stack-diffs, "
  + "because a normalized score reports a match for a spill at the wrong "
  + "slot. The queue is ordered closest-first from a ranking, launches are "
  + "niced and load-gated, and a run that hit its cap while still "
  + "descending can be re-seeded once from its own best candidate. "
  + "Promotion is deliberately out of scope: a scratch score of 0 is a "
  + "candidate until the project's authoritative build says otherwise.";

const CLASSIFY_DESCRIPTION = "Read a sweep's summary.json and assign every function a measured wall "
  + "class. Wall classes used to be assigned by hand from verdict prose, and "
  + "the class that says 'nothing will move this' has repeatedly been wrong "
  + "-- which is expensive, because it is the class that routes a function "
  + "away from cheap search and towards bespoke instrumentation. The sweep "
  + "already measured what settles it: the base score, the best score, where "
  + "in the window the best candidate landed, and whether the search earned "
  + "its extension. MATCHED verifies on the real build. P_STUCK_DESCENDING "
  + "was still improving when the clock stopped it, and is the only class "
  + "that routes to trace levers or a human. P_STUCK_FLAT never improved, or "
  + "improved only in its opening minutes, and is the pool from which the "
  + "case for deeper instrumentation is argued. IMPORT_FAULT never measured "
  + "anything and routes to fixing the scratch.";

const DOCTOR_DESCRIPTION = "Preflight one function before an hour is spent searching it. Reports "
  + "the codegen flags recovered from the build, whether they came from the "
  + "build or from a fallback, the post-compile objcopy steps the scratch "
  + "replicated and the ones it could not, and whether the scratch base "
  + "compiles to a finite, non-zero score. Each of the three has silently "
  + "wasted whole campaign days: a scratch on the wrong ISA finds nothing "
  + "and reads as a hard function; a scratch missing the objcopy chain "
  + "finds a zero that does not transfer; a base that already scores 0 is "
  + "not scoring the function under test at all.";

/** An integer argument that must be greater than zero. */
export function positive(text) {
  if (!/^\s*[-+]?\d+\s*$/.test(text)) throw new ArgumentTypeError(`${strRepr(text)} is not an integer`);
  const value = parseInt(text, 10);
  if (value <= 0) throw new ArgumentTypeError(`${strRepr(text)} must be greater than 0`);
  return value;
}
positive.displayName = "_positive";

export function nonNegative(text) {
  if (!/^\s*[-+]?\d+\s*$/.test(text)) throw new ArgumentTypeError(`${strRepr(text)} is not an integer`);
  const value = parseInt(text, 10);
  if (value < 0) throw new ArgumentTypeError(`${strRepr(text)} must not be negative`);
  return value;
}
nonNegative.displayName = "_non_negative";

export function nonNegativeFloat(text) {
  const s = String(text).trim().toLowerCase();
  const value = /^[-+]?(inf|infinity)$/.test(s) ? (s.startsWith("-") ? -Infinity : Infinity) : s === "" ? NaN : Number(s);
  if (Number.isNaN(value) && !/nan$/.test(s)) throw new ArgumentTypeError(`${strRepr(text)} is not a number`);
  if (value < 0) throw new ArgumentTypeError(`${strRepr(text)} must not be negative`);
  return value;
}
nonNegativeFloat.displayName = "_non_negative_float";

/** Resolve the project root and its `[permuter]` defaults. */
async function loadOptions(args, ctx) {
  const { findProjectConfig, loadProjectConfig } = await import("./project-config.js");
  let configPath;
  if (args.project) {
    configPath = ctx.resolve(expanduser(args.project));
    try { if (fs.statSync(configPath).isDirectory()) configPath = path.join(configPath, ".decomp-workbench.toml"); } catch { /* a file path, possibly missing */ }
  } else configPath = findProjectConfig(ctx.cwd);
  const config = loadProjectConfig(configPath);
  return [String(config.root), config.permuter];
}

async function plan(args, extra, ctx) {
  const [root, options] = await loadOptions(args, ctx);
  return resolvePlan(root, options, {
    permuter_dir: args.permuter_dir ?? null, output_dir: args.output_dir ?? null, minutes: args.minutes ?? null,
    extend_minutes: args.extend_minutes || 0, threads: args.threads ?? null, jobs: args.jobs ?? null,
    load_threshold: args.load_threshold ?? null, make: args.make ?? null, extra, cpu_count: os.cpus().length || 4,
    objdump: args.objdump ?? null, check_fidelity: !args.no_fidelity, require_fidelity: !!args.require_fidelity,
  });
}

/** The permuter programs must exist before anything is imported or searched. */
function backendCapability(p) {
  try { p.tool(IMPORT_TOOL); p.tool(SEARCH_TOOL); return null; } catch (e) {
    if (e instanceof PermuterError) return e.message;
    throw e;
  }
}

/** Warn -- or refuse -- when the ranking measured a different tree. */
function rankingGate(root, rankingPath, { require_fresh }, io, ctx) {
  if (rankingPath === null || rankingPath === undefined) {
    if (require_fresh) { io.eprint("error: --require-fresh needs a ranking to check; pass --ranking or set permuter.ranking"); return 2; }
    return null;
  }
  const freshness = checkRankingFresh(rankingPath, (ctx.gitHead ?? gitHead)(root), { cwd: ctx.cwd });
  if (require_fresh && !freshness.fresh) { io.eprint(`error: ${freshness.message}`); return 2; }
  const warning = freshnessWarning(freshness);
  if (warning !== null) io.eprint(warning);
  const note = freshnessNote(freshness);
  if (note !== null) io.print(note);
  return null;
}

const reportable = (e) => e instanceof PermuterError || isInputError(e) || e instanceof SyntaxError;
const errText = (e) => (e && typeof e.code === "string" && /^E[A-Z]+$/.test(e.code) ? osErrorText(e) : e.message);

export async function permuteSweepCommand(args, io, ctx) {
  let p, queue;
  try {
    p = await plan(args, [...(args.permuter_args ?? [])], ctx);
    queue = loadQueue(ctx.resolve(args.queue));
  } catch (e) {
    if (!reportable(e)) throw e;
    io.eprint(`error: ${errText(e)}`);
    return 2;
  }
  if (args.function) { const wanted = new Set(args.function); queue = queue.filter((i) => wanted.has(i.function)); }
  const rankingPath = args.ranking ?? (p.options.ranking ? String(p.options.ranking) : null);
  const refused = rankingGate(p.root, rankingPath, { require_fresh: args.require_fresh }, io, ctx);
  if (refused !== null) return refused;
  let ranking;
  try { ranking = loadRanking(rankingPath === null ? null : path.resolve(ctx.cwd, expanduser(rankingPath))); } catch (e) {
    if (!reportable(e)) throw e;
    io.eprint(`error: ${errText(e)}`);
    return 2;
  }
  if (rankingPath !== null && !ranking.size) io.eprint(`warning: no differing_words rows read from ${rankingPath}; the queue keeps its own order`);
  let ordered = orderQueue(queue, ranking);
  const unranked = ordered.filter((i) => !ranking.has(i.function)).length;
  const summaryPath = path.join(p.output_dir, "summary.json");
  let carried = [];
  if (args.resume) {
    const done = completedFunctions(summaryPath);
    const before = ordered.length;
    ordered = ordered.filter((i) => !done.has(i.function));
    carried = earlierResults(summaryPath);
    io.print(`--resume: skipping ${before - ordered.length} already-run function(s)`);
  }
  if (args.limit !== null && args.limit !== undefined) ordered = ordered.slice(0, args.limit);
  if (carried.length) { const rerunning = new Set(ordered.map((i) => i.function)); carried = carried.filter((r) => !rerunning.has(r.function)); }
  if (unranked && ranking.size) io.print(`note: ${unranked} queued function(s) are unranked; they run last`);
  if (args.list || args.dry_run || !ordered.length) {
    io.print(renderQueue(ordered).join("\n"));
    if (args.dry_run) io.print(`dry run: ${p.minutes} min cap, ${p.jobs} concurrent, ${p.threads} thread(s) each, load gate ${formatLoad(p.load_threshold)}`);
    return 0;
  }
  const missing = backendCapability(p);
  if (missing !== null) { io.eprint(`error: ${missing}`); return 2; }
  io.print(`running ${ordered.length} function(s), ${p.jobs} concurrent, ${p.threads} permuter thread(s) each, ${p.minutes} min cap each`);
  const gate = loadGateNote(p.load_threshold);
  if (gate !== null) io.print(gate);
  const record = (results) => writeSummary(p.output_dir, sweepPayload(results, { final: false }), renderTable(results));
  let results;
  try {
    results = await runSweep(p, ordered, { carried, report: (m) => io.print(m), on_result: record, ...(ctx.runner ? { runner: ctx.runner } : {}) });
  } catch (e) {
    if (!(e instanceof PermuterError)) throw e;
    io.eprint(`error: ${e.message}`);
    return 2;
  }
  const payload = sweepPayload(results, { final: true });
  const table = renderTable(results);
  const [summaryJson, summaryTxt] = writeSummary(p.output_dir, payload, table);
  if (args.json) io.print(dumps(payload, { sortKeys: false }));
  else { io.print(table.join("\n")); io.print(`\nsummary: ${summaryJson}\n         ${summaryTxt}`); }
  return results.some((r) => r.error) ? 1 : 0;
}

/** `{plan.load_threshold}` prints a float as the original did (0.0, 9.5). */
function formatLoad(v) { return Number.isInteger(v) ? `${v}.0` : String(v); }

export async function permuteClassifyCommand(args, io, ctx) {
  let rows;
  try {
    const payload = JSON.parse(fs.readFileSync(ctx.resolve(expanduser(args.summary)), "utf8"));
    rows = classifySummary(payload);
  } catch (e) {
    if (!reportable(e)) throw e;
    io.eprint(`error: ${errText(e)}`);
    return 2;
  }
  if (args.wall_class) { const wanted = new Set(args.wall_class); rows = rows.filter((r) => wanted.has(r.wall_class)); }
  const document = classifyPayload(rows, { source: String(args.summary) });
  if (args.json) io.print(dumps(document, { sortKeys: false }));
  else io.print(renderMarkdown(rows, { source: String(args.summary) }).join("\n"));
  return 0;
}

export async function permuteDoctorCommand(args, io, ctx) {
  let report;
  try {
    const p = await plan(args, [], ctx);
    const refused = rankingGate(p.root, p.options.ranking ? String(p.options.ranking) : null, { require_fresh: args.require_fresh }, io, ctx);
    if (refused !== null) return refused;
    let item;
    if (args.queue) {
      const queue = new Map(loadQueue(ctx.resolve(args.queue)).map((i) => [i.function, i]));
      item = queue.get(args.function);
      if (!item) { io.eprint(`error: ${args.function} is not in ${args.queue}`); return 2; }
    } else {
      if (!args.source) { io.eprint("error: --source is required without --queue"); return 2; }
      item = new QueueItem({ function: args.function, source: args.source, asm: args.asm ?? null, object: args.object ?? null, asm_symbol: args.asm_symbol ?? null });
    }
    const missing = backendCapability(p);
    if (missing !== null) { io.eprint(`error: ${missing}`); return 2; }
    report = await doctor(p, item, { seconds: args.seconds, check_base: !args.no_base_check,
      target_object: args.target_object ? ctx.resolve(args.target_object) : null,
      candidate_object: args.candidate_object ? ctx.resolve(args.candidate_object) : null,
      ...(ctx.runner ? { runner: ctx.runner } : {}) });
  } catch (e) {
    if (!reportable(e)) throw e;
    io.eprint(`error: ${errText(e)}`);
    return 2;
  }
  if (args.json) io.print(dumps(report.asDict()));
  else io.print(renderDoctor(report).join("\n"));
  return report.ok ? 0 : 1;
}

const SHARED_ARGUMENTS = [
  { flags: ["--project"], metavar: "PATH", help: "project config file or directory (default: search upward)" },
  { flags: ["--permuter-dir"], metavar: "DIR", help: `directory holding romdev's JS permuter programs ${IMPORT_TOOL} and ${SEARCH_TOOL} (default: the romdev-permuter package)` },
  { flags: ["--output-dir"], metavar: "DIR", help: "where scratches, logs and the summary are written" },
  { flags: ["--make"], metavar: "EXE", help: "the project's make binary" },
  { flags: ["--minutes"], type: positive, metavar: "N", help: "per-function wall-clock cap" },
  { flags: ["--threads"], type: positive, metavar: "N", help: "threads per permuter instance (permuter -j)" },
  { flags: ["--load-threshold"], type: nonNegativeFloat, metavar: "X", help: "wait until the one-minute load average is below this before each launch; 0 disables the gate" },
  { flags: ["--json"], action: "store_true", help: "emit JSON" },
  { flags: ["--objdump"], metavar: "EXE", help: "objdump used to compare the scratch object with the project's own object (default: object.objdump)" },
  { flags: ["--no-fidelity"], action: "store_true", help: "skip the scratch-fidelity check: do not compile the base and compare it with the project's object for this translation unit" },
  { flags: ["--require-fidelity"], action: "store_true", help: "refuse a function whose scratch object is not the object the build produces; without it a difference is only a warning" },
  { flags: ["--require-fresh"], action: "store_true", help: "refuse to run unless the ranking's stamp matches the project's git HEAD; without it a mismatch is only a warning" },
];

const SWEEP_ARGUMENTS = [
  { dest: "queue", help: "queue file: JSON rows of {function, source, asm, ...}, or one 'function source [asm]' per line" },
  ...SHARED_ARGUMENTS,
  { flags: ["--ranking"], metavar: "FILE", help: "closeness ranking; queued functions are ordered by ascending differing_words, and unranked ones run last" },
  { flags: ["--function"], action: "append", metavar: "NAME", help: "restrict the sweep to this function (repeatable)" },
  { flags: ["--limit"], type: positive, metavar: "N", help: "cap how many functions are searched" },
  { flags: ["--jobs"], type: positive, metavar: "N", help: "how many functions to search at once" },
  { flags: ["--extend-minutes"], type: nonNegative, default: 0, metavar: "N", help: "re-seed from the best candidate and search this much longer, but only when the run hit its cap with its best result in the final third of the window (default: 0, off)" },
  { flags: ["--resume"], action: "store_true", help: "skip the functions a previous run in this output directory searched; a row that errored is retried, because nothing was measured about it" },
  { flags: ["--dry-run"], action: "store_true", help: "print the ordered queue and the resolved limits, and stop" },
  { flags: ["--list"], action: "store_true", help: "print the ordered queue and stop" },
  { flags: ["--permuter-arg"], action: "append", default: [], metavar: "ARG", dest: "permuter_args", help: "one extra argument forwarded verbatim to the permuter (repeatable). --stack-diffs is always passed and never needs repeating here" },
];

const CLASSIFY_ARGUMENTS = [
  { dest: "summary", help: "a permute-sweep summary.json" },
  { flags: ["--class"], action: "append", choices: [...CLASSES], dest: "wall_class", metavar: "NAME", help: `report only this class (repeatable): ${CLASSES.join(", ")}` },
  { flags: ["--json"], action: "store_true", help: "emit JSON instead of the pasteable markdown table" },
];

const DOCTOR_ARGUMENTS = [
  { dest: "function", help: "the function to preflight" },
  ...SHARED_ARGUMENTS,
  { flags: ["--queue"], metavar: "FILE", help: "read this function's row from a queue file" },
  { flags: ["--source"], metavar: "FILE", help: "the function's C source" },
  { flags: ["--asm"], metavar: "FILE", help: "the function's target assembly" },
  { flags: ["--object"], metavar: "TARGET", help: "the Make object target, if not derivable" },
  { flags: ["--asm-symbol"], metavar: "NAME", help: "the name the target assembly uses, when it differs from the C name" },
  { flags: ["--seconds"], type: positive, default: 120, metavar: "N", help: "how long the base-score check may run (default: 120)" },
  { flags: ["--target-object"], metavar: "FILE", help: "the assembled target object. With it, the doctor also reports whether the target's own call relocations name symbols this scratch can reproduce -- when they do not, the permuter score has a floor above zero and `linked-compare` is the oracle" },
  { flags: ["--candidate-object"], metavar: "FILE", help: "the candidate object, so a call to a symbol the candidate does not carry at all is told apart from an ordinary one" },
  { flags: ["--no-base-check"], action: "store_true", help: "report flags and objcopy steps without compiling the base" },
];

const sweepSpec = (pathWords, extra = {}) => ({ path: pathWords, handler: permuteSweepCommand, help: "drive decomp-permuter over a queue with a faithful scratch",
  description: SWEEP_DESCRIPTION, arguments: SWEEP_ARGUMENTS, defaults: { report_command: "permute-sweep" }, ...extra });
const doctorSpec = (pathWords, extra = {}) => ({ path: pathWords, handler: permuteDoctorCommand, help: "preflight one function's permuter scratch before searching it",
  description: DOCTOR_DESCRIPTION, arguments: DOCTOR_ARGUMENTS, defaults: { report_command: "permute-doctor", jobs: 1 }, ...extra });
const classifySpec = (pathWords, extra = {}) => ({ path: pathWords, handler: permuteClassifyCommand, help: "assign each swept function a measured wall class",
  description: CLASSIFY_DESCRIPTION, arguments: CLASSIFY_ARGUMENTS, defaults: { report_command: "permute-classify" }, ...extra });

export const COMMAND_SPECS = [
  sweepSpec(["permute-sweep"], { epilog: "example: decomp-workbench permute-sweep queue.json --ranking ranking.json --minutes 20 --resume" }),
  doctorSpec(["permute-doctor"], { epilog: "example: decomp-workbench permute-doctor func_80012574 --queue queue.json" }),
  classifySpec(["permute-classify"], { epilog: "example: decomp-workbench permute-classify .decomp-workbench/permute/summary.json" }),
  listingSpec(["permute"], { help: "run and preflight bounded decomp-permuter searches",
    description: "Bounded decomp-permuter searches whose scratch reproduces the project's real per-object recipe. Run `decomp-workbench permute sweep --help`." }),
  sweepSpec(["permute", "sweep"]),
  doctorSpec(["permute", "doctor"]),
  classifySpec(["permute", "classify"]),
];

export { ValueError };
