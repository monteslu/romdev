// permute.js - the parsers and the policy for driving the permuter over a
// queue of functions with scratch fidelity.
//
// Every host that runs the permuter at campaign scale re-invents the same
// batch loop, and each re-invention re-introduces the same faults that make a
// search answer the wrong question: the scratch searches the wrong ISA (the
// importer's default instead of the flags `make -n <object>` prints, which it
// prints only after the source is touched), the scratch object is not the
// real object (a post-compile objcopy chain the scratch never replays), and
// the score is normalized (without --stack-diffs a spill at the wrong slot
// scores zero). This module is the parser and the policy for those, plus the
// queue mechanics (closest-first ordering, resume, load gating, the
// score-trend extension). It deliberately stops short of promotion.
//
// Plain JS ESM + JSDoc.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ValueError, splitlines, strip, splitWs, sorted, strRepr, fixed, reEscape } from "./py.js";
import { expanduser } from "./py-path.js";
import { formatG } from "./globalcolor.js";

/** Codegen flags that must match the real per-file build exactly. */
export const CODEGEN_FLAG_RE = /-mips[0-9]|-O[0-9]|-Wo,[^ ]*|-Wab,[^ ]*|-g[0-9]?(?= |$)|-(?:32|n32|64)(?= |$)/g;

/** Post-compile passes a scratch cannot replicate (a script pass over the
 * object is digest-guarded against the matched bytes). */
export const DEFAULT_SKIP_POSTPROCESS = Object.freeze(["\\.py\\b"]);

export const LABEL_RE = /^\s*(?:glabel|endlabel|jlabel|dlabel)\s+(\S+)/gm;
export const BASE_SCORE_RE = /base score = (\d+)/;
export const PRESERVED_MACROS_RE = /^Preserving (?:macros: (.*?)|(no macros))\./m;
export const UNRANKED = 10 ** 9;
export const SWEEP_SCHEMA = "decomp-workbench-permute-sweep-v1";
export const DOCTOR_SCHEMA = "decomp-workbench-permute-doctor-v1";

/** The one-minute load average, or null where the host has none. */
export function loadAverage() {
  if (process.platform === "win32") return null;
  try { return os.loadavg()[0]; } catch { return null; }
}

/** Python regex source -> JS RegExp (the skip patterns are configured text). */
export function pyRegex(pattern, flags = "") {
  return new RegExp(String(pattern).replace(/\(\?P<([A-Za-z_]\w*)>/g, "(?<$1>").replace(/\\Z/g, "$").replace(/\\A/g, "^"), flags);
}

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------

const QUEUE_FIELDS = ["function", "source", "asm", "object", "asm_symbol", "label"];

/** One function to search, and the inputs its scratch needs. */
export class QueueItem {
  constructor({ function: fn, source, asm = null, object = null, asm_symbol = null, label = null }) {
    Object.assign(this, { function: fn, source, asm, object, asm_symbol, label });
    Object.freeze(this);
  }
  asDict() {
    const out = {};
    for (const k of QUEUE_FIELDS) if (this[k] !== null && this[k] !== undefined) out[k] = this[k];
    return out;
  }
}

function optionalText(value, origin, name) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !strip(value)) throw new ValueError(`${origin}: ${name} must be a non-empty string`);
  return value;
}

function queueItem(payload, { origin }) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new ValueError(`${origin}: each queue entry must be a JSON object`);
  const unknown = Object.keys(payload).filter((k) => !QUEUE_FIELDS.includes(k));
  if (unknown.length) throw new ValueError(`${origin}: unknown queue keys: ${sorted(unknown).join(", ")}`);
  for (const required of ["function", "source"]) {
    const value = payload[required];
    if (typeof value !== "string" || !strip(value)) throw new ValueError(`${origin}: queue entry needs a non-empty ${strRepr(required)}`);
  }
  return new QueueItem({
    function: String(payload.function), source: String(payload.source),
    asm: optionalText(payload.asm, origin, "asm"), object: optionalText(payload.object, origin, "object"),
    asm_symbol: optionalText(payload.asm_symbol, origin, "asm_symbol"), label: optionalText(payload.label, origin, "label"),
  });
}

/** Read a queue from JSON, or from one `function source [asm]` per line. */
export function loadQueue(p) {
  const origin = path.basename(String(p));
  const text = fs.readFileSync(expanduser(p), "utf8");
  const stripped = text.replace(/^\s+/, "");
  if (stripped.startsWith("{") || stripped.startsWith("[")) {
    const payload = JSON.parse(text);
    const rows = payload && typeof payload === "object" && !Array.isArray(payload) ? (payload.functions ?? []) : payload;
    if (!Array.isArray(rows)) throw new ValueError(`${origin}: queue JSON must be a list, or hold 'functions'`);
    return rows.map((row) => queueItem(row, { origin }));
  }
  const items = [];
  splitlines(text).forEach((line, idx) => {
    const entry = strip(line.split("#")[0]);
    if (!entry) return;
    const parts = splitWs(entry);
    if (parts.length < 2) throw new ValueError(`${origin}:${idx + 1}: expected 'function source [asm]', got ${strRepr(entry)}`);
    items.push(new QueueItem({ function: parts[0], source: parts[1], asm: parts.length > 2 ? parts[2] : null }));
  });
  return items;
}

const isInt = (v) => typeof v === "number" && Number.isInteger(v);

/** Read `{name: [differing_words, size_bytes]}` from a ranking report (a Map). */
export function loadRanking(p) {
  const ranking = new Map();
  if (p === null || p === undefined) return ranking;
  const source = expanduser(p);
  let st;
  try { st = fs.statSync(source); } catch { return ranking; }
  if (!st.isFile()) return ranking;
  const payload = JSON.parse(fs.readFileSync(source, "utf8"));
  const rows = payload && typeof payload === "object" && !Array.isArray(payload) ? (payload.functions ?? payload) : payload;
  if (!Array.isArray(rows)) return ranking;
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const name = row.name || row.function || row.symbol;
    const words = row.differing_words;
    if (typeof name === "string" && isInt(words)) {
      const size = row.size_bytes;
      ranking.set(name, [words, isInt(size) ? size : 0]);
    }
  }
  return ranking;
}

/** Closest first: fewest differing words, then smallest, then by name. */
export function orderQueue(items, ranking) {
  const get = (name) => (ranking instanceof Map ? ranking.get(name) : ranking?.[name]);
  return sorted(items, (item) => [get(item.function) ?? [UNRANKED, 0], item.function]);
}

// ---------------------------------------------------------------------------
// Build-recipe recovery
// ---------------------------------------------------------------------------

/** What the project's real build does to one translation unit's object. */
export class BuildRecipe {
  constructor({ flags = [], objcopy_steps = [], skipped_postprocess = [], from_dry_run = false, object = null, warnings = [] } = {}) {
    Object.assign(this, { flags, objcopy_steps, skipped_postprocess, from_dry_run, object, warnings });
    Object.freeze(this);
  }
  asDict() {
    return { object: this.object, flags: [...this.flags], objcopy_steps: [...this.objcopy_steps],
      skipped_postprocess: [...this.skipped_postprocess], from_dry_run: this.from_dry_run, warnings: [...this.warnings] };
  }
}

/** Join backslash-newline continuations before parsing a printed recipe. */
export function joinContinuations(text) { return text.split("\\\n").join(" "); }

/** Extract codegen flags and the post-compile chain from `make -n`. */
export function parseDryRun(text, { obj, compiler = null, skip_postprocess = DEFAULT_SKIP_POSTPROCESS } = {}) {
  const skips = skip_postprocess.map((p) => pyRegex(p));
  const mention = objectMentionRe(obj);
  const test = (re, s) => { re.lastIndex = 0; return re.test(s); };
  let flags = [];
  const objcopySteps = [], skipped = [];
  for (const line of splitlines(joinContinuations(text))) {
    if (!test(mention, line)) continue;
    const isCompile = compiler ? line.includes(compiler) : false;
    if (line.includes("objcopy") && !isCompile) {
      for (const segment of line.split("&&").map((s) => strip(s))) {
        if (!segment) continue;
        if (skips.some((s) => s.test(segment)) || !segment.includes("objcopy") || !test(mention, segment)) skipped.push(segment);
        else objcopySteps.push(segment);
      }
      continue;
    }
    if (flags.length) continue;
    if (compiler !== null && compiler !== undefined && !isCompile) continue;
    const found = [...new Set(line.match(CODEGEN_FLAG_RE) ?? [])];
    if (found.some((f) => f.startsWith("-mips"))) flags = found;
  }
  const warnings = flags.length ? [] : [`could not recover real compile flags for ${obj}: the scratch will `
    + "use the configured fallback and may search the wrong ISA. Check "
    + "that the object target is spelled the way the build spells it."];
  return new BuildRecipe({ flags, objcopy_steps: objcopySteps, skipped_postprocess: skipped, from_dry_run: flags.length > 0, object: obj, warnings });
}

/** Render a Make object target for one source path. */
export function objectTarget(template, source) {
  const p = path.posix.normalize(String(source).split(path.sep).join("/"));
  const name = path.posix.basename(p);
  const ext = path.posix.extname(name);
  const stem = ext && ext !== name ? name.slice(0, -ext.length) : name;
  const parent = path.posix.dirname(p);
  const values = { source: p, stem, name, parent };
  return template.replace(/\{(\w+)\}|\{\{|\}\}/g, (m, key) => (m === "{{" ? "{" : m === "}}" ? "}" : key in values ? values[key] : (() => { throw new ValueError(`KeyError: '${key}'`); })()));
}

/**
 * Recover one object's real recipe by asking the build to describe it.
 * The source is touched first: `make -n` prints nothing for an up-to-date
 * object, and nothing parses as "no flags".
 */
export async function recoverRecipe(root, item, {
  make = "make", object_template = "build/{source}.o", compiler = null, fallback_flags = [],
  skip_postprocess = DEFAULT_SKIP_POSTPROCESS, runner, timeout = 120.0, touch = true,
} = {}) {
  const obj = item.object || objectTarget(object_template, item.source);
  const sourcePath = path.join(String(root), item.source);
  if (touch) {
    try { if (fs.statSync(sourcePath).isFile()) { const t = new Date(); fs.utimesSync(sourcePath, t, t); } } catch { /* absent or permission-dependent */ }
  }
  let recipe;
  try {
    const completed = await runner([make, "-n", obj], { cwd: String(root), stdout: "pipe", stderr: "devnull", text: true, timeout, check: false });
    recipe = parseDryRun(completed.stdout || "", { obj, compiler, skip_postprocess });
  } catch (error) {
    if (!isProcessError(error)) throw error;
    recipe = new BuildRecipe({ object: obj, warnings: [`could not run \`${make} -n ${obj}\`: ${errorText(error)}`] });
  }
  if (!recipe.flags.length && fallback_flags.length) recipe = new BuildRecipe({ ...recipe, flags: [...fallback_flags] });
  return recipe;
}

/** OSError or a subprocess failure (the only kinds a recipe recovery absorbs). */
export function isProcessError(e) {
  return !!e && (e.name === "TimeoutExpired" || e.name === "SubprocessError" || e.name === "OSError" || e.name === "FileNotFoundError"
    || (typeof e.code === "string" && /^E[A-Z]+$/.test(e.code)));
}

/** How the original printed a subprocess/OS error inside a message. */
export function errorText(e) {
  if (e?.name === "TimeoutExpired") return `Command '${pyListRepr(e.argv ?? [])}' timed out after ${formatSeconds(e.timeout)} seconds`;
  if (e?.code === "ENOENT" && e.syscall?.startsWith("spawn")) return `[Errno 2] No such file or directory: '${e.path ?? e.spawnfile}'`;
  return e?.message ?? String(e);
}

export function pyListRepr(list) { return "[" + list.map((x) => strRepr(String(x))).join(", ") + "]"; }
function formatSeconds(v) { return Number.isInteger(v) ? `${v}.0` : String(v); }

const PATH_CHARACTER = "[^\\s\"'=;:&|<>()]";

/** Match the whole-token mentions of one object path, and only those. */
export function objectMentionRe(obj) {
  return new RegExp(`(?<!${PATH_CHARACTER})(?:\\./)*${reEscape(obj)}(?!${PATH_CHARACTER})`, "g");
}

/** Point the recovered post-compile chain at the scratch's own object. */
export function retargetObjcopy(steps, obj, output = '"$OUTPUT"') {
  const pattern = objectMentionRe(obj);
  return steps.map((step) => step.replace(pattern, () => output));
}

// ---------------------------------------------------------------------------
// Scratch preparation
// ---------------------------------------------------------------------------

/** Render a permuter settings file carrying the *real* flags. */
export function renderSettings({ compiler_command, assembler_command, flags, compiler_type = "ido", preserve_macros = [], decompme_compiler = null }) {
  const command = [strip(compiler_command), ...flags].filter(Boolean).join(" ");
  const lines = [`compiler_type = "${compiler_type}"`, 'compiler_command = """', command, '"""', `assembler_command = ${JSON.stringify(assembler_command)}`];
  if (preserve_macros.length) {
    lines.push("", "[preserve_macros]");
    for (const entry of preserve_macros) {
      const at = entry.indexOf("=");
      const pattern = at < 0 ? entry : entry.slice(0, at), kind = at < 0 ? "" : entry.slice(at + 1);
      lines.push(`${JSON.stringify(strip(pattern))} = ${JSON.stringify(strip(kind))}`);
    }
  }
  if (decompme_compiler) {
    const words = splitWs(compiler_command);
    const executable = words.length ? words[0] : "cc";
    lines.push("", "[decompme.compilers]", `${JSON.stringify(executable)} = ${JSON.stringify(decompme_compiler)}`);
  }
  return lines.join("\n") + "\n";
}

/** Rename a target `.s`'s own function labels, and nothing else. */
export function retargetLabels(text, { old, new: replacement }) {
  if (old === replacement) return text;
  return text.replace(new RegExp(`\\b${reEscape(old)}\\b`, "g"), () => replacement);
}

/** The human record of what the scratch did and did not replicate. */
export function recipeReport(recipe, replicated) {
  const origin = recipe.from_dry_run ? "make -n" : "fallback (NOT the real build)";
  const lines = [`flags: ${recipe.flags.join(" ") || "(none)"} [${origin}]`];
  for (const step of replicated) lines.push(`replicated: ${step}`);
  for (const step of recipe.skipped_postprocess) lines.push(`skipped (not replicable): ${step}`);
  for (const w of recipe.warnings) lines.push(`warning: ${w}`);
  return lines.join("\n") + "\n";
}

/** Append the retargeted post-compile chain to the scratch `compile.sh`. */
export function appendCompileSteps(compileScript, steps) {
  if (!steps.length) return;
  fs.appendFileSync(compileScript, "\n" + steps.map((s) => s + "\n").join(""), "utf8");
}

// ---------------------------------------------------------------------------
// Scratch fidelity, and the preserved-macro modes that repair it
// ---------------------------------------------------------------------------

export const FIDELITY_IDENTICAL = "identical";
export const FIDELITY_DIFFERS = "differs";
export const FIDELITY_UNKNOWN = "unknown";
export const FIDELITY_UNCHECKED = "unchecked";
export const CONFIGURED_MACROS = "configured";
export const NO_MACROS = "none";
export const DEFAULT_PRESERVE_MACRO_MODES = Object.freeze([CONFIGURED_MACROS, NO_MACROS]);

/** One way to import a translation unit, as far as macros are concerned. */
export class PreserveMacroMode {
  constructor(name, macros = [], regex = null) {
    Object.assign(this, { name, macros: [...macros], regex });
    Object.freeze(this);
  }
  /** What actually reaches the importer, for deduplication. */
  get key() { return JSON.stringify([this.macros, this.regex]); }
}

/** Turn configured mode names into the imports they stand for. */
export function resolvePreserveMacroModes(configured, modes = DEFAULT_PRESERVE_MACRO_MODES) {
  const resolved = [], seen = new Set();
  for (const name of (modes && modes.length ? modes : DEFAULT_PRESERVE_MACRO_MODES)) {
    let mode;
    if (name === CONFIGURED_MACROS) { const macros = [...configured]; mode = new PreserveMacroMode(name, macros, macros.length ? null : ""); }
    else if (name === NO_MACROS) mode = new PreserveMacroMode(name, [], "");
    else mode = new PreserveMacroMode(name, [...configured], name);
    if (seen.has(mode.key)) continue;
    seen.add(mode.key);
    resolved.push(mode);
  }
  return resolved;
}

/** The macros the importer says it preserved, or null if it never said. */
export function parsePreservedMacros(log) {
  const m = PRESERVED_MACROS_RE.exec(log);
  if (!m) return null;
  if (m[2] !== undefined) return [];
  return m[1].split(",").map((p) => strip(p)).filter(Boolean);
}

const macrosDict = (v) => (v === null || v === undefined ? null : [...v]);

/** One import mode, and what its object turned out to be. */
export class FidelityAttempt {
  constructor({ mode, status, differing_words = null, preserved_macros = [], reason = null }) {
    Object.assign(this, { mode, status, differing_words, preserved_macros, reason });
    Object.freeze(this);
  }
  asDict() {
    return { mode: this.mode, status: this.status, differing_words: this.differing_words,
      preserved_macros: macrosDict(this.preserved_macros), reason: this.reason };
  }
}

/** Whether the scratch object is the object the real build produces. */
export class ScratchFidelity {
  constructor({ status = FIDELITY_UNCHECKED, differing_words = null, mode = null, reason = null, object = null, preserved_macros = [], attempts = [] } = {}) {
    Object.assign(this, { status, differing_words, mode, reason, object, preserved_macros, attempts });
    Object.freeze(this);
  }
  get identical() { return this.status === FIDELITY_IDENTICAL; }
  /** The one token a report prints: `differs(4 words)`, or the status. */
  get summary() {
    if (this.status === FIDELITY_DIFFERS && this.differing_words !== null) {
      return `differs(${this.differing_words} word${this.differing_words === 1 ? "" : "s"})`;
    }
    return this.status;
  }
  asDict() {
    return { status: this.status, differing_words: this.differing_words, mode: this.mode, reason: this.reason, object: this.object,
      preserved_macros: macrosDict(this.preserved_macros), attempts: this.attempts.map((a) => a.asDict()) };
  }
}

/** Could preserved macros explain this difference? */
export function macroAttributable(fidelity) {
  if (fidelity.status !== FIDELITY_DIFFERS) return false;
  if (fidelity.preserved_macros === null || fidelity.preserved_macros === undefined) return true;
  return fidelity.preserved_macros.length > 0 || !fidelity.attempts.length;
}

/** The loud line a differing scratch owes the operator. */
export function fidelityWarning(fidelity, fn) {
  if (fidelity.status === FIDELITY_DIFFERS) {
    const where = fidelity.object ? ` for ${fidelity.object}` : "";
    return `the scratch object for ${fn} is not the object the build `
      + `produces${where}: ${fidelity.summary}. A score of 0 here does not `
      + "have to transfer. Tried import mode(s): "
      + (fidelity.attempts.map((a) => a.mode).join(", ") || "none");
  }
  if (fidelity.status === FIDELITY_UNKNOWN) {
    return `scratch fidelity for ${fn} could not be measured` + (fidelity.reason ? `: ${fidelity.reason}` : "");
  }
  return null;
}

// ---------------------------------------------------------------------------
// Run policy
// ---------------------------------------------------------------------------

const defaultSleep = (seconds) => new Promise((r) => setTimeout(r, seconds * 1000));

/** Block until the one-minute load average is under `threshold`. */
export async function waitForHeadroom(threshold, { label = "", load = loadAverage, sleep = defaultSleep, interval = 15.0, report = null } = {}) {
  if (threshold <= 0) return 0;
  let waited = 0;
  for (;;) {
    const current = load();
    if (current === null || current === undefined || current < threshold) return waited;
    if (waited === 0 && report) report(`load ${fixed(current, 1)} >= ${fixed(threshold, 1)}; waiting ${label}`.replace(/\s+$/, ""));
    await sleep(interval);
    waited += 1;
  }
}

/** The one line a sweep prints when its load gate cannot work here. */
export function loadGateNote(threshold, { load = loadAverage } = {}) {
  if (threshold <= 0 || (load() !== null && load() !== undefined)) return null;
  return `note: load_threshold ${formatG(threshold)} is set, but this host reports no `
    + "load average, so launches are not gated. Use --jobs/--threads to "
    + "bound the work instead.";
}

/** Was the search still descending when the wall clock cut it off? */
export function shouldExtend({ elapsed, minutes, best_score, best_age, extend_minutes }) {
  if (extend_minutes <= 0 || best_score === null || best_score === undefined || best_score === 0) return false;
  if (best_age === null || best_age === undefined) return false;
  const window = minutes * 60.0;
  if (window <= 0 || elapsed < window * 0.95) return false;
  return best_age < window / 3.0;
}

/** Where in the window the best output landed, as a 0..1 fraction. */
export function outputFraction({ elapsed, best_age }) {
  if (best_age === null || best_age === undefined || elapsed <= 0) return null;
  return Math.min(1.0, Math.max(0.0, (elapsed - best_age) / elapsed));
}

/** The permuter's lowest-scoring output directory and its score. */
export function bestOutput(scratch) {
  const candidates = [];
  let entries;
  try { entries = fs.readdirSync(scratch, { withFileTypes: true }); } catch { return [null, null]; }
  for (const e of entries) {
    if (!e.name.startsWith("output-")) continue;
    const full = path.join(String(scratch), e.name);
    let isDir = e.isDirectory();
    if (e.isSymbolicLink()) { try { isDir = fs.statSync(full).isDirectory(); } catch { isDir = false; } }
    if (!isDir) continue;
    const parts = e.name.split("-");
    if (parts.length >= 2 && /^\d+$/.test(parts[1].replace(/^-+/, ""))) candidates.push([parseInt(parts[1], 10), full]);
  }
  if (!candidates.length) return [null, null];
  const best = sorted(candidates, (c) => c[0])[0];
  return [best[1], best[0]];
}

/**
 * Build the permuter command line, with the fidelity flags forced on.
 * `interpreter` runs the permuter entry point (node, for the JS permuter).
 */
export function permuterArgv({ interpreter, permuter, scratch, threads, extra = [], nice = 15, posix = process.platform !== "win32" }) {
  const argv = [];
  if (nice !== null && nice !== undefined && posix) argv.push("nice", "-n", String(nice));
  argv.push(interpreter, String(permuter), "--stop-on-zero", "--quiet", "-j", String(threads));
  if (!extra.includes("--stack-diffs")) argv.push("--stack-diffs");
  argv.push(...extra, String(scratch));
  return argv;
}

export function parseBaseScore(log) {
  const m = BASE_SCORE_RE.exec(log);
  return m ? parseInt(m[1], 10) : null;
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export const SWEEP_RESULT_FIELDS = Object.freeze([
  "function", "source", "ok", "base_score", "best_score", "zero_found", "extended", "flags", "flags_recovered",
  "replicated_objcopy", "skipped_postprocess", "scratch_fidelity", "scratch_fidelity_words", "scratch_fidelity_mode",
  "scratch_fidelity_reason", "output_dir", "best_output_mtime_fraction", "window_seconds", "hit_cap", "seconds", "error", "warnings",
]);

/** One function's outcome. Promotion is deliberately absent. */
export class SweepResult {
  constructor({ function: fn, source, ok = false, base_score = null, best_score = null, zero_found = false, extended = false,
    flags = null, flags_recovered = false, replicated_objcopy = 0, skipped_postprocess = 0, scratch_fidelity = FIDELITY_UNCHECKED,
    scratch_fidelity_words = null, scratch_fidelity_mode = null, scratch_fidelity_reason = null, output_dir = null,
    best_output_mtime_fraction = null, window_seconds = null, hit_cap = false, seconds = 0.0, error = null, warnings = [] }) {
    Object.assign(this, { function: fn, source, ok, base_score, best_score, zero_found, extended, flags, flags_recovered,
      replicated_objcopy, skipped_postprocess, scratch_fidelity, scratch_fidelity_words, scratch_fidelity_mode,
      scratch_fidelity_reason, output_dir, best_output_mtime_fraction, window_seconds, hit_cap, seconds, error, warnings: [...warnings] });
  }
  asDict() { return Object.fromEntries(SWEEP_RESULT_FIELDS.map((k) => [k, Array.isArray(this[k]) ? [...this[k]] : this[k]])); }
}

export function sweepPayload(results, { final }) {
  return {
    schema: SWEEP_SCHEMA, final,
    results: results.map((r) => r.asDict()),
    totals: {
      run: results.length,
      zero_found: results.filter((r) => r.zero_found).length,
      extended: results.filter((r) => r.extended).length,
      errored: results.filter((r) => r.error).length,
      fallback_flags: results.filter((r) => r.ok && !r.flags_recovered).length,
      scratch_differs: results.filter((r) => r.scratch_fidelity === FIDELITY_DIFFERS).length,
    },
  };
}

function readSummaryRows(summary) {
  let st;
  try { st = fs.statSync(summary); } catch { return null; }
  if (!st.isFile()) return null;
  const payload = JSON.parse(fs.readFileSync(summary, "utf8"));
  return payload && typeof payload === "object" && !Array.isArray(payload) ? (payload.results ?? []) : [];
}

/** Names a previous sweep actually searched, for --resume (errored rows excluded). */
export function completedFunctions(summary) {
  const rows = readSummaryRows(summary);
  if (rows === null) return new Set();
  return new Set(rows.filter((r) => r && typeof r === "object" && !Array.isArray(r) && typeof r.function === "string" && r.ok && !r.error).map((r) => String(r.function)));
}

/** Carry a previous sweep's rows forward so the summary stays whole. */
export function earlierResults(summary) {
  const rows = readSummaryRows(summary);
  if (rows === null) return [];
  const carried = [];
  for (const row of rows) {
    if (row && typeof row === "object" && !Array.isArray(row) && typeof row.function === "string") {
      carried.push(new SweepResult(Object.fromEntries(Object.entries(row).filter(([k]) => SWEEP_RESULT_FIELDS.includes(k)))));
    }
  }
  return carried;
}

function fidelityCell(r) {
  if (r.scratch_fidelity === FIDELITY_DIFFERS && r.scratch_fidelity_words !== null) return `DIFFERS/${r.scratch_fidelity_words}`;
  return r.scratch_fidelity;
}

const noneStr = (v) => (v === null || v === undefined ? "None" : String(v));

export function renderTable(results) {
  const lines = [`${"function".padEnd(32)} ${"base".padStart(6)} ${"best".padStart(6)}  ${"zero".padEnd(5)} ${"ext".padEnd(4)} ${"flags".padEnd(9)} ${"scratch".padEnd(12)} ${"time".padStart(7)}`];
  for (const r of results) {
    lines.push(`${r.function.padEnd(32)} ${noneStr(r.base_score).padStart(6)} ${noneStr(r.best_score).padStart(6)}  `
      + `${(r.zero_found ? "yes" : "no").padEnd(5)} ${(r.extended ? "yes" : "no").padEnd(4)} `
      + `${(r.flags_recovered ? "real" : "FALLBACK").padEnd(9)} ${fidelityCell(r).padEnd(12)} ${fixed(r.seconds, 0).padStart(6)}s`);
  }
  if (results.length) {
    const zero = results.filter((r) => r.zero_found).length;
    const errored = results.filter((r) => r.error).length;
    const fallback = results.filter((r) => r.ok && !r.flags_recovered).length;
    const differs = results.filter((r) => r.scratch_fidelity === FIDELITY_DIFFERS).length;
    lines.push("", `${results.length} run, ${zero} reached score 0, ${errored} errored, ${fallback} searched with fallback flags, ${differs} on a scratch that is not the real object`);
  }
  return lines;
}

export function renderQueue(items) {
  const rows = [...items];
  const lines = [`${rows.length} queued function(s):`];
  for (const item of rows) lines.push(`  ${item.function}  (${item.source})`);
  if (!rows.length) lines.push("  nothing to do.");
  return lines;
}
