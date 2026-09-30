// sweep-build.js - compile a wave of candidate sources and score them into
// one table: a bounded pool, at `nice`, skipping any object whose source,
// compile command and compiler identity are unchanged, and one row per
// candidate with the standard metric columns plus a watch-row signature. The
// compile command is the project's (a {source}/{output} template); this does
// not own the build.
//
// Plain JS ESM + JSDoc.

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { CompilerTimeoutError, executableIdentity, nicePrefix, renderCompileCommand, runCompiler } from "./campaign.js";
import { compareCandidate, loadTarget } from "./compare.js";
import { displayPath } from "./model.js";
import { discoverObjdump } from "./objdump.js";
import { SweepError, readManifest } from "./sweep.js";
import { evaluateWatchRows, watchRowPayload } from "./watch-rows.js";
import { sorted, splitlines, strip, strRepr, pyStr, isInputError, osErrorText } from "./py.js";
import { dumps } from "./pyjson.js";
import { isReportedError } from "./py-extra.js";

export const BUILD_SCHEMA = "decomp-workbench-sweep-build-v1";
export const DEFAULT_JOBS = 4;
export const DEFAULT_NICE = 10;
export const CACHE_FILE = ".sweep-build.json";
export const SORT_ORDERS = Object.freeze(["words", "rows-away", "watch", "name"]);

/** A wave could not be prepared, built, or scored. */
export class SweepBuildError extends SweepError {}

/** One candidate: how it built, and how it scored. */
export class BuildResult {
  constructor({ label, source, object_path, status, comparison = null, detail = "", watch = {} }) {
    Object.assign(this, { label, source, object_path, status, comparison, detail, watch });
    Object.freeze(this);
  }
  get scored() { return this.comparison !== null; }
  get signature() { return pyStr(this.watch.watch_signature ?? ""); }
  asDict() {
    const payload = { label: this.label, source: this.source, object: this.object_path, status: this.status, detail: this.detail };
    const c = this.comparison;
    if (c) {
      payload.comparison = c.asDict();
      Object.assign(payload, { verdict: c.verdict, words: c.word_mismatches, raw: c.raw_word_mismatches, opcodes: c.opcode_mismatches,
        regs: c.register_mismatches, fp: c.fp_register_mismatches, gaps: c.aligned_gaps, insns: c.candidate_instructions,
        frame: c.candidate_frame_size, exact: c.exact });
    }
    Object.assign(payload, this.watch);
    return payload;
  }
}

/** Rank one row; every order ends on the label so ties never reshuffle. */
function sortKey(item, order) {
  const c = item.comparison;
  if (!c) return [1, 0, 0, 0, item.label];
  if (order === "name") return [0, item.label];
  if (order === "watch") {
    const broken = Math.trunc(Number(item.watch.watch_broken ?? 0));
    const unknown = Math.trunc(Number(item.watch.watch_out_of_range ?? 0));
    return [0, broken + unknown, item.signature, c.word_mismatches, item.label];
  }
  if (order === "rows-away") {
    const layout = c.layout || {};
    const rowsAway = layout.rows_away ?? null;
    return [0, rowsAway === null ? c.word_mismatches : Math.trunc(Number(rowsAway)), c.word_mismatches, item.label];
  }
  return [0, c.word_mismatches, c.raw_word_mismatches, c.opcode_mismatches, Math.abs(c.instruction_delta), item.label];
}

/** A whole wave: what was asked for, what happened, and the table. */
export class SweepBuild {
  constructor({ target, template, objects, jobs, nice, watch, results, order = "words", colliding_stems = [] }) {
    Object.assign(this, { target, template, objects, jobs, nice, watch, results, order, colliding_stems });
    Object.freeze(this);
  }
  get ranked() { return sorted(this.results.filter((r) => r.scored), (r) => sortKey(r, this.order)); }
  get unscored() { return sorted(this.results.filter((r) => !r.scored), (r) => r.label); }
  count(status) { return this.results.filter((r) => r.status === status).length; }
  asDict() {
    return {
      schema: BUILD_SCHEMA, target: this.target, compile_command: this.template, objects: this.objects, jobs: this.jobs, nice: this.nice,
      order: this.order, watch_row_set: this.watch.map((w) => w.asDict()), candidate_count: this.results.length,
      compiled: this.count("compiled"), cached: this.count("cached"), failed: this.count("failed"), unreadable: this.count("unreadable"),
      colliding_stems: [...this.colliding_stems], results: this.ranked.map((r) => r.asDict()), unscored: this.unscored.map((r) => r.asDict()),
    };
  }
}

const expand = (p) => (p === "~" || p.startsWith("~/") ? (process.env.HOME ?? "") + p.slice(1) : p);
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const stemOf = (p) => { const b = path.basename(p); const i = b.lastIndexOf("."); return i > 0 ? b.slice(0, i) : b; };

/** Expand files, directories and sweep manifests into one ordered list of absolute paths. */
export function collectSources(inputs, { suffix = ".c", cwd = process.cwd() } = {}) {
  const found = [], seen = new Set();
  const add = (p) => {
    let resolved = path.resolve(cwd, expand(p));
    try { resolved = fs.realpathSync(resolved); } catch { /* strict=False: keep the absolute path */ }
    if (seen.has(resolved)) return;
    seen.add(resolved);
    found.push(resolved);
  };
  for (const entry of inputs) {
    const p = expand(String(entry));
    const abs = path.resolve(cwd, p);
    if (isDir(abs)) {
      const manifestPath = path.join(abs, "sweep.json");
      if (isFile(manifestPath)) {
        const manifest = readManifest(manifestPath);
        for (const v of manifest.variants) add(path.join(abs, v.filename));
        continue;
      }
      for (const name of sorted(fs.readdirSync(abs).filter((n) => n.endsWith(suffix)))) {
        add(path.join(abs, name));
      }
      continue;
    }
    if (isFile(abs)) { add(abs); continue; }
    throw new SweepBuildError(`${p} is neither a file nor a directory. \`sweep build\` takes candidate sources, directories of them, `
      + "or a generated sweep directory holding sweep.json.");
  }
  if (!found.length) {
    throw new SweepBuildError(`no candidate sources found. A directory contributes its *${suffix} files; a sweep directory contributes its manifest's variants.`);
  }
  return found;
}

/** A label unique across the whole wave (colliding stems gain a path digest). */
export function assignLabels(sources) {
  const counts = new Map();
  for (const s of sources) counts.set(stemOf(s), (counts.get(stemOf(s)) ?? 0) + 1);
  const labels = new Map();
  for (const s of sources) {
    const stem = stemOf(s);
    if (counts.get(stem) === 1) { labels.set(s, stem); continue; }
    labels.set(s, `${stem}-${createHash("sha256").update(Buffer.from(String(s), "utf8")).digest("hex").slice(0, 8)}`);
  }
  return labels;
}

function collidingStems(sources) {
  const counts = new Map();
  for (const s of sources) counts.set(stemOf(s), (counts.get(stemOf(s)) ?? 0) + 1);
  return sorted([...counts].filter(([, n]) => n > 1).map(([s]) => s));
}

/** Compact sorted-key JSON, as json.dumps(..., sort_keys=True, separators=(",", ":")). */
function compactJson(value) {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return "[" + value.map(compactJson).join(",") + "]";
  if (typeof value === "object") return "{" + sorted(Object.keys(value)).map((k) => dumps(k) + ":" + compactJson(value[k])).join(",") + "}";
  return dumps(value);
}

function fingerprint(source, command, { compiler }) {
  const h = createHash("sha256");
  h.update(fs.readFileSync(source));
  h.update(Buffer.from([0]));
  h.update(Buffer.from(command.join("\0"), "utf8"));
  h.update(Buffer.from([0]));
  h.update(Buffer.from(compactJson(compiler), "utf8"));
  return h.digest("hex");
}

function readCache(directory) {
  let payload;
  try { payload = JSON.parse(fs.readFileSync(path.join(directory, CACHE_FILE), "utf8")); } catch { return {}; }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return {};
  return Object.fromEntries(Object.entries(payload).map(([k, v]) => [String(k), pyStr(v)]));
}

function writeCache(directory, entries) {
  try { fs.writeFileSync(path.join(directory, CACHE_FILE), dumps(entries) + "\n", "utf8"); } catch { /* rebuilds next time */ }
}

async function compileOne(source, { output, template, niceness, environment, compile_cwd, timeout, cached_fingerprint, compiler }) {
  const command = [...nicePrefix(niceness), ...renderCompileCommand(template, source, output)];
  const fp = fingerprint(source, command, { compiler });
  if (cached_fingerprint === fp && isFile(output) && fs.statSync(output).size > 0) return ["cached", "", fp];
  fs.mkdirSync(path.dirname(output), { recursive: true });
  let result;
  try {
    result = await runCompiler(command, { environment, compile_cwd, timeout });
  } catch (e) {
    if (e instanceof CompilerTimeoutError) return ["failed", e.message, fp];
    return ["failed", `cannot run the compiler: ${e.message}`, fp];
  }
  if (result.returncode || !isFile(output) || fs.statSync(output).size === 0) {
    const detail = (strip(result.stderr) || strip(result.stdout)) || "the compiler reported success but produced no object";
    const lines = splitlines(detail);
    return ["failed", detail ? (lines[lines.length - 1] ?? "") : "", fp];
  }
  return ["compiled", "", fp];
}

/** Compile every source at `nice` with a bounded pool, score each, and return the wave. */
export async function runSweepBuild(sources, { target, template, objects, jobs = DEFAULT_JOBS, niceness = DEFAULT_NICE, watch = [], objdump = null,
  symbol = null, section = ".text", object_suffix = ".o", environment = null, compile_cwd = null, timeout = 300.0, order = "words", refresh = false,
  cwd = process.cwd() }) {
  if (jobs < 1) throw new SweepBuildError("--jobs must be at least 1");
  if (!SORT_ORDERS.includes(order)) throw new SweepBuildError(`unknown --sort ${strRepr(order)}; expected one of ` + SORT_ORDERS.join(", "));
  const targetPath = path.resolve(cwd, expand(String(target)));
  if (!isFile(targetPath)) throw new SweepBuildError(`target object does not exist: ${targetPath}`);
  const objectDir = path.resolve(cwd, expand(String(objects)));
  fs.mkdirSync(objectDir, { recursive: true });
  const ccwd = compile_cwd ? path.resolve(cwd, expand(String(compile_cwd))) : path.resolve(cwd);
  if (!isDir(ccwd)) throw new SweepBuildError(`compiler working directory does not exist: ${ccwd}`);
  const env = environment === null ? { ...process.env } : { ...environment };
  const cache = refresh ? {} : readCache(objectDir);
  const fresh = {};
  const labels = assignLabels(sources);
  const plan = sources.map((s) => [s, path.join(objectDir, `${labels.get(s)}${object_suffix}`)]);
  const compiler = sources.length ? executableIdentity(renderCompileCommand(template, sources[0], path.join(objectDir, "probe.o")), { cwd: ccwd }) : {};
  const outcomes = new Map();
  for (const [s] of plan) if (!isFile(s)) outcomes.set(s, ["failed", "the candidate source does not exist", ""]);
  const queue = plan.filter(([s]) => !outcomes.has(s));
  let next = 0;
  const worker = async () => {
    while (next < queue.length) {
      const [s, output] = queue[next++];
      try {
        outcomes.set(s, await compileOne(s, { output, template, niceness, environment: env, compile_cwd: ccwd, timeout,
          cached_fingerprint: cache[labels.get(s)] ?? null, compiler }));
      } catch (e) {
        outcomes.set(s, ["failed", `${e?.name ?? "Error"}: ${e?.message ?? e}`, ""]);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(jobs, Math.max(1, queue.length)) }, worker));
  const objdumpPath = discoverObjdump(objdump, { cwd });
  const loaded = loadTarget(targetPath, { objdump: objdumpPath, symbol, section, cwd });
  const results = [];
  for (const [s, output] of plan) {
    const [status, detail, fp] = outcomes.get(s) ?? ["failed", "not built", ""];
    const label = labels.get(s);
    if ((status === "compiled" || status === "cached") && fp) fresh[label] = fp;
    if (status === "failed") {
      results.push(new BuildResult({ label, source: displayPath(s, cwd), object_path: null, status, detail }));
      continue;
    }
    let comparison;
    try {
      comparison = compareCandidate(loaded, output, { objdump: objdumpPath, section, cwd });
    } catch (e) {
      if (!isInputError(e) && !isReportedError(e)) throw e;
      const text = e.code && /^E[A-Z]+$/.test(e.code) ? osErrorText(e) : String(e.message ?? "");
      results.push(new BuildResult({ label, source: displayPath(s, cwd), object_path: displayPath(output, cwd), status: "unreadable",
        detail: text ? splitlines(text)[0] : "" }));
      continue;
    }
    let watchPayload = {};
    if (watch.length) {
      watchPayload = watchRowPayload(evaluateWatchRows(watch, { diff_sites: comparison.diff_sites,
        compared_rows: Math.max(comparison.target_instructions, comparison.candidate_instructions) }));
    }
    results.push(new BuildResult({ label, source: displayPath(s, cwd), object_path: displayPath(output, cwd), status, comparison, watch: watchPayload }));
  }
  writeCache(objectDir, fresh);
  return new SweepBuild({ target: displayPath(targetPath, cwd), template, objects: displayPath(objectDir, cwd), jobs, nice: niceness,
    watch: [...watch], results, order, colliding_stems: collidingStems(sources) });
}

const column = (v) => (v === null || v === undefined ? "-" : String(v));
const rj = (v, n) => String(v).padStart(n);

/** Render the wave as one scored table, then everything that did not score. */
export function buildLines(wave, { limit = 40 } = {}) {
  const headerWatch = wave.watch.map((w) => w.label).join(" ");
  const sigWidth = wave.watch.length ? Math.max(headerWatch.length, wave.watch.length) : 0;
  const lines = [
    `sweep build: ${wave.results.length} candidate(s) -> ${wave.target}`,
    `${wave.count("compiled")} compiled, ${wave.count("cached")} already current, ${wave.count("failed")} failed, `
      + `${wave.count("unreadable")} unreadable  (jobs=${wave.jobs}, nice=${wave.nice})`,
    "",
  ];
  if (wave.colliding_stems.length) {
    const shown = wave.colliding_stems.slice(0, 8).join(", ");
    const more = wave.colliding_stems.length - 8;
    lines.push(`note: ${wave.colliding_stems.length} file name(s) appear in more than one input directory (${shown}`
      + (more > 0 ? `, +${more} more` : "")
      + "). Each candidate still gets its own object and row; the labels below carry a short path digest to tell them apart.", "");
  }
  if (wave.watch.length) lines.push(`watch rows (. healed, X broken, ? out of range): ${headerWatch}`, "");
  const sigColumn = wave.watch.length ? "sig".padEnd(sigWidth) + "  " : "";
  lines.push(` words   raw  opcodes  regs   fp  gaps  insns   frame  ${sigColumn}verdict                    candidate`);
  const ranked = wave.ranked;
  for (const item of ranked.slice(0, limit)) {
    const c = item.comparison;
    const sig = wave.watch.length ? item.signature.padEnd(sigWidth) + "  " : "";
    lines.push(`${rj(c.word_mismatches, 6)} ${rj(c.raw_word_mismatches, 5)} ${rj(c.opcode_mismatches, 8)} ${rj(c.register_mismatches, 5)} `
      + `${rj(c.fp_register_mismatches, 4)} ${rj(c.aligned_gaps, 5)} ${rj(c.candidate_instructions, 6)} ${rj(column(c.candidate_frame_size), 7)}  `
      + `${sig}${String(c.verdict).padEnd(26)} ${item.label}`);
  }
  if (ranked.length > limit) lines.push(` ... ${ranked.length - limit} more scored candidate(s); --limit 0 prints every row`);
  const unscored = wave.unscored;
  if (unscored.length) {
    lines.push("", `not scored (${unscored.length}):`);
    for (const item of unscored.slice(0, limit)) lines.push(`  ${item.status.padEnd(11)} ${item.label}  ${item.detail}`);
    if (unscored.length > limit) lines.push(`  ... ${unscored.length - limit} more`);
  }
  const exact = ranked.filter((r) => r.comparison && r.comparison.exact);
  if (exact.length) {
    lines.push("", `EXACT: ${exact.map((r) => r.label).join(", ")}. \`compare --json\` the object before believing it, and run the `
      + "project's own link/ROM verification: a wave scores objects, not builds.");
  }
  lines.push("", `objects in ${wave.objects}; a re-run skips any whose source and compile command are unchanged (--refresh rebuilds every one).`);
  return lines;
}
