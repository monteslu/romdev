// campaign.js - parallel, cached, and resumable candidate compilation
// campaigns. The target is disassembled once and compared in process; each
// candidate costs one compiler run (in its own process group, ended with
// everything it started on timeout or interruption) and one objdump.
//
// Plain JS ESM + JSDoc.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnRouted } from "./proc.js";
import { createHash } from "node:crypto";
import { ValueError, sorted, strRepr } from "./py.js";
import { dumps } from "./pyjson.js";
import { DEFAULT_STREAM_LIMIT, captureStreams } from "./artifacts.js";
import { splitCommand } from "./command-line.js";
import { compareCandidate, loadTarget } from "./compare.js";
import { paretoLayers } from "./geometry.js";
import { loadOrCreateSalt, redactRecord, warnIfUnredacted } from "./ledger-redaction.js";
import { CompileResult, displayPath } from "./model.js";
import { discoverObjdump } from "./objdump.js";
import { fileSha256 as evidenceSha256 } from "./evidence.js";
import { FileNotFoundError, RuntimeError, OSError } from "./py-extra.js";

export const LEDGER_SCHEMA = "decomp-workbench-campaign-v1";
export const TERMINATE_GRACE_SECONDS = 2.0;

const RUNNING = new Set();

/** A compiler exceeded its deadline after its whole process group ended. */
export class CompilerTimeoutError extends RuntimeError {
  constructor(command, timeout, { stdout, stderr }) {
    super(`compiler exceeded --timeout=${formatG(timeout)} seconds`);
    this.name = "RuntimeError"; this.kind = "CompilerTimeoutError";
    Object.assign(this, { command, timeout, stdout, stderr });
  }
}

/** `{value:g}` for a timeout. */
export function formatG(value) {
  if (Number.isInteger(value)) return String(value);
  const s = Number(value).toPrecision(6);
  return s.includes("e") ? s.replace(/\.?0+e/, "e").replace(/e([+-])(\d)$/, "e$10$2") : s.replace(/\.?0+$/, "");
}

export class NotADirectoryError extends OSError { constructor(message) { super(message); this.name = "OSError"; this.kind = "NotADirectoryError"; } }

const expandUser = (p) => (p === "~" || String(p).startsWith("~/") ? os.homedir() + String(p).slice(1) : String(p));
/** Path(p).expanduser().resolve() */
export function resolvePath(p, cwd = process.cwd()) {
  const abs = path.resolve(cwd, expandUser(p));
  try { return fs.realpathSync(abs); } catch {
    let head = abs; const tail = [];
    while (head !== path.dirname(head)) {
      try { return path.join(fs.realpathSync(head), ...tail); } catch { tail.unshift(path.basename(head)); head = path.dirname(head); }
    }
    return abs;
  }
}
const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

function signalGroup(child, sig) {
  try { process.kill(-child.pid, sig); return true; } catch { return false; }
}

/** End one compiler and everything it started: TERM, then KILL after grace. */
export async function terminateProcessGroup(child, { grace = TERMINATE_GRACE_SECONDS } = {}) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (!signalGroup(child, "SIGTERM")) { try { child.kill("SIGTERM"); } catch { return; } }
  const deadline = Date.now() + grace * 1000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  if (!signalGroup(child, "SIGKILL")) { try { child.kill("SIGKILL"); } catch { /* gone */ } }
}

/** End every compiler this process started, and their children. */
export async function terminateRunningCompilers() {
  await Promise.all([...RUNNING].map((c) => terminateProcessGroup(c)));
}

/**
 * Run one compiler as the owner of its own process group. The environment
 * is the complete build environment, not an overlay on the host's.
 * Resolves {returncode, stdout, stderr}; rejects CompilerTimeoutError, or an
 * OSError when the program cannot be started.
 */
export function runCompiler(command, { environment, compile_cwd, timeout = null }) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnRouted(command, { cwd: compile_cwd, env: environment, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) { reject(Object.assign(new OSError(osMessage(e, command[0])), { code: e.code })); return; }
    RUNNING.add(child);
    const out = [], err = [];
    child.stdout.on("data", (d) => out.push(d));
    child.stderr.on("data", (d) => err.push(d));
    let timedOut = false, timer = null;
    if (timeout !== null && timeout !== undefined) {
      timer = setTimeout(async () => { timedOut = true; await terminateProcessGroup(child); }, timeout * 1000);
    }
    child.on("error", (e) => {
      if (timer) clearTimeout(timer);
      RUNNING.delete(child);
      reject(Object.assign(new OSError(osMessage(e, command[0])), { code: e.code }));
    });
    child.on("close", (code, sig) => {
      if (timer) clearTimeout(timer);
      RUNNING.delete(child);
      const dec = (chunks) => new TextDecoder("utf-8", { fatal: false }).decode(Buffer.concat(chunks));
      const stdout = dec(out), stderr = dec(err);
      if (timedOut) { reject(new CompilerTimeoutError(command, timeout ?? 0, { stdout, stderr })); return; }
      resolve({ args: command, returncode: code !== null ? code : -(os.constants.signals[sig] ?? 1), stdout, stderr });
    });
  });
}

function osMessage(e, program) {
  if (e?.code === "ENOENT") return `[Errno 2] No such file or directory: '${program}'`;
  if (e?.code === "EACCES") return `[Errno 13] Permission denied: '${program}'`;
  return String(e?.message ?? e);
}

/** A resolved source candidate and its reproducibility key. */
export class Candidate {
  constructor({ source, command, cache_key, provenance }) { Object.assign(this, { source, command, cache_key, provenance }); Object.freeze(this); }
}

/** One source compiled under a candidate-specific explicit environment. */
export class ParameterizedCandidate {
  constructor({ source, environment, metadata }) { Object.assign(this, { source, environment, metadata }); Object.freeze(this); }
}

/** Render a compiler command without invoking a shell. */
export function renderCompileCommand(template, source, output) {
  const parts = splitCommand(template);
  if (!parts.some((p) => p.includes("{source}"))) throw new ValueError("--compile-command must contain {source}");
  if (!parts.some((p) => p.includes("{output}"))) throw new ValueError("--compile-command must contain {output}");
  return parts.map((p) => p.split("{source}").join(String(source)).split("{output}").join(String(output)));
}

/** shutil.which */
export function which(name, env = process.env) {
  if (name.includes("/")) { try { fs.accessSync(name, fs.constants.X_OK); return isFile(name) ? name : null; } catch { return null; } }
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    const p = path.join(dir || ".", name);
    try { if (isFile(p)) { fs.accessSync(p, fs.constants.X_OK); return p; } } catch { /* next */ }
  }
  return null;
}

/** The `nice` prefix for a background pass, or nothing. */
export function nicePrefix(level) {
  if (level === null || level === undefined || level <= 0 || process.platform === "win32") return [];
  const exe = which("nice");
  return exe ? [exe, "-n", String(level)] : [];
}

export function fileSha256(p) { return evidenceSha256(p); }

/** The directly invoked compiler or wrapper, resolved and hashed. */
export function executableIdentity(command, { cwd = null } = {}) {
  const executable = command[0];
  const discovered = which(executable);
  let resolved = null;
  if (discovered !== null) resolved = resolvePath(discovered);
  else {
    let p = expandUser(executable);
    if (!path.isAbsolute(p) && cwd !== null) p = path.join(cwd, p);
    resolved = isFile(p) ? resolvePath(p) : null;
  }
  return { requested: executable, resolved, sha256: resolved ? fileSha256(resolved) : null };
}

const sortedObject = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

/** The explicit inputs represented by a campaign cache key. */
export function candidateProvenance(source, { command, target, symbol, environment, compile_cwd = null, section = ".text", objdump = null, compilation_envelope = null }) {
  const resolvedCwd = resolvePath(compile_cwd ?? process.cwd());
  const provenance = {
    schema: LEDGER_SCHEMA,
    source: resolvePath(source),
    source_sha256: fileSha256(source),
    target: resolvePath(target),
    target_sha256: fileSha256(target),
    command,
    compiler: executableIdentity(command, { cwd: resolvedCwd }),
    objdump: objdump ? executableIdentity([objdump], { cwd: resolvedCwd }) : null,
    compile_cwd: resolvedCwd,
    symbol,
    section,
    environment: sortedObject(environment),
    environment_mode: "sealed",
  };
  if (compilation_envelope && Object.keys(compilation_envelope).length) provenance.compilation_envelope = sortedObject(compilation_envelope);
  return provenance;
}

function keyOf(provenance) {
  return createHash("sha256").update(Buffer.from(canonicalJson(provenance), "utf8")).digest("hex");
}

/** Compact sorted-key JSON, ASCII-escaped, without touching string contents. */
export function canonicalJson(value) {
  if (value === null || value === undefined) return "null";
  if (value === true) return "true";
  if (value === false) return "false";
  if (typeof value === "number") return dumps(value);
  if (typeof value === "string") return dumps(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return "{" + keys.map((k) => dumps(k) + ":" + canonicalJson(value[k])).join(",") + "}";
}

/** Build a stable key from the inputs controlled by the workbench. */
export function candidateKey(source, opts) { return keyOf(candidateProvenance(source, opts)); }

/** Resolve and deduplicate candidates by reproducibility key. */
export function prepareCandidates(sources, { template, target, symbol, environment, compile_cwd = null, section = ".text", objdump = null, compilation_envelope = null }) {
  const prepared = [];
  const duplicates = {};
  const seen = new Map();
  for (const name of sources) {
    const source = resolvePath(name);
    if (!isFile(source)) throw new FileNotFoundError(`candidate source does not exist: ${source}`);
    const command = renderCompileCommand(template, source, "{cache_object}");
    const provenance = candidateProvenance(source, { command, target, symbol, environment, compile_cwd, section, objdump, compilation_envelope });
    const key = keyOf(provenance);
    (duplicates[key] ??= []).push(displayPath(source));
    if (seen.has(key)) continue;
    const c = new Candidate({ source, command, cache_key: key, provenance });
    seen.set(key, c);
    prepared.push(c);
  }
  return [prepared, duplicates];
}

let _signals = null;
async function signalsModule() {
  if (!_signals) {
    try { _signals = await import("./experiment-signals.js"); }
    catch { _signals = { evaluateSignals: (specs) => { if (specs && specs.length) throw new RuntimeError("experiment signals are unavailable"); return []; }, requiredSignalsPass: () => true }; }
  }
  return _signals;
}

const stemOf = (p) => { const b = path.basename(p); const i = b.lastIndexOf("."); return i > 0 ? b.slice(0, i) : b; };

async function compileCandidate(candidate, { target, template, cache_dir, objdump, section, environment, compile_cwd, keep_dir, timeout,
  stream_limit, artifact_dir, experiment, selected_region, signal_specs, signals }) {
  const started = performance.now();
  const cachedObject = path.join(cache_dir, `${candidate.cache_key}.o`);
  const cached = isFile(cachedObject) && fs.statSync(cachedObject).size > 0;
  let stdout = "", stderr = "", returncode = 0, command;
  if (cached) command = renderCompileCommand(template, candidate.source, cachedObject);
  else {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "decomp-workbench-campaign-"));
    try {
      const temporaryObject = path.join(temp, "candidate.o");
      command = renderCompileCommand(template, candidate.source, temporaryObject);
      try {
        const p = await runCompiler(command, { environment, compile_cwd, timeout });
        stdout = p.stdout; stderr = p.stderr; returncode = p.returncode;
      } catch (e) {
        if (e.kind === "CompilerTimeoutError") { returncode = 124; stdout = e.stdout; stderr = `${e.stderr}\n${e.message}`.trim(); }
        else if (e instanceof OSError) { returncode = 127; stderr = e.message; }
        else throw e;
      }
      if (returncode === 0 && isFile(temporaryObject) && fs.statSync(temporaryObject).size > 0) {
        const temporaryCache = path.join(cache_dir, `.${candidate.cache_key}.${process.pid}.tmp`);
        fs.copyFileSync(temporaryObject, temporaryCache);
        fs.renameSync(temporaryCache, cachedObject);
      }
    } finally { fs.rmSync(temp, { recursive: true, force: true }); }
  }
  let comparison = null, objectSha = null, kept = null;
  if (returncode === 0 && isFile(cachedObject)) {
    objectSha = fileSha256(cachedObject);
    try {
      comparison = compareCandidate(target, cachedObject, { objdump, section });
      comparison.candidate = displayPath(candidate.source);
      if (keep_dir) {
        const destination = path.join(keep_dir, `${candidate.cache_key.slice(0, 12)}-${stemOf(candidate.source)}.o`);
        fs.copyFileSync(cachedObject, destination);
        kept = destination;
      }
    } catch (e) {
      if (!(e instanceof OSError || e instanceof RuntimeError || e?.name === "RuntimeError" || e?.name === "OSError" || e?.name === "FileNotFoundError" || (e && typeof e.code === "string"))) throw e;
      returncode = 1;
      stderr = `${stderr}\ncomparison failed: ${e.message}`.trim();
    }
  }
  const streams = captureStreams(stdout, stderr, { limit: stream_limit, artifact_dir, stem: candidate.cache_key });
  const region = comparison !== null && selected_region ? regionScore(comparison, selected_region) : null;
  return new CompileResult({
    source: displayPath(candidate.source), command, returncode, stdout: streams.stdout, stderr: streams.stderr,
    object_path: kept, comparison, cache_key: candidate.cache_key, cached, duration_seconds: (performance.now() - started) / 1000,
    stdout_bytes: streams.stdout_bytes, stderr_bytes: streams.stderr_bytes, stdout_truncated: streams.stdout_truncated,
    stderr_truncated: streams.stderr_truncated, artifacts: streams.artifacts, experiment, region,
    signals: signals.evaluateSignals(signal_specs, comparison), object_sha256: objectSha,
  });
}

/** Append one self-contained JSONL record, with the target side redacted. */
export function appendLedger(p, result, { duplicate_sources, provenance, timeout, warn = (m) => process.stderr.write(m + "\n") }) {
  const payload = result.asDict();
  if (payload.comparison && typeof payload.comparison === "object") delete payload.comparison.aligned_row_receipts;
  let record = { schema: LEDGER_SCHEMA, recorded_at_unix: Date.now() / 1000, duplicate_sources, provenance,
    execution: { timeout_seconds: timeout }, ...payload };
  const warning = warnIfUnredacted(p);
  if (warning !== null) warn(warning);
  record = redactRecord(record, loadOrCreateSalt(p));
  fs.appendFileSync(p, dumps(record, { indent: null, sortKeys: true }) + "\n", "utf8");
}

/** Completed cache keys, without trusting a torn final JSONL line. */
export function recordedLedgerKeys(p) {
  if (!isFile(p)) return new Set();
  const text = fs.readFileSync(p, "utf8");
  const lines = text.split(/\r\n|\n|\r/);
  if (lines.length && lines.at(-1) === "") lines.pop();
  const keys = new Set();
  lines.forEach((line, index) => {
    if (!line.trim()) return;
    let record;
    try { record = JSON.parse(line); } catch {
      if (index === lines.length - 1) return;
      throw new ValueError(`invalid campaign ledger JSON at line ${index + 1}: ${p}`);
    }
    if (!record || typeof record !== "object" || Array.isArray(record)) throw new ValueError(`campaign ledger line ${index + 1} is not an object: ${p}`);
    if (typeof record.cache_key === "string" && record.cache_key) keys.add(record.cache_key);
  });
  return keys;
}

async function executeCandidates(candidates, duplicates, { target_object, template, cache_path, ledger_path, jobs, objdump_path, section,
  environment_for, compile_cwd_path, keep_path, stop_on_exact, timeout, stream_limit, artifact_path, candidate_metadata, selected_region,
  signal_specs, deduplicate_ledger, rank_by, warn }) {
  const signals = await signalsModule();
  const results = [];
  const recorded = ledger_path !== null && deduplicate_ledger ? recordedLedgerKeys(ledger_path) : new Set();
  const failure = (candidate, e) => new CompileResult({ source: displayPath(candidate.source), command: candidate.command, returncode: 1,
    stdout: "", stderr: `campaign error: ${e?.kind ?? e?.name ?? "Error"}: ${e?.message ?? e}`, object_path: null, comparison: null,
    cache_key: candidate.cache_key, experiment: candidate_metadata[candidate.cache_key] ?? null, signals: signals.evaluateSignals(signal_specs, null) });
  const record = (result, candidate) => {
    results.push(result);
    if (ledger_path && (!deduplicate_ledger || !recorded.has(result.cache_key))) {
      appendLedger(ledger_path, result, { duplicate_sources: duplicates[result.cache_key], provenance: candidate.provenance, timeout, warn });
      recorded.add(result.cache_key);
    }
    return result;
  };
  const queue = [...candidates];
  const pending = new Map();
  let nextId = 0;
  const submit = (count) => {
    for (let i = 0; i < count && queue.length; i++) {
      const candidate = queue.shift();
      const id = nextId++;
      const promise = compileCandidate(candidate, { target: target_object, template, cache_dir: cache_path, objdump: objdump_path, section,
        environment: environment_for(candidate), compile_cwd: compile_cwd_path, keep_dir: keep_path, timeout, stream_limit,
        artifact_dir: artifact_path, experiment: candidate_metadata[candidate.cache_key] ?? null, selected_region, signal_specs, signals })
        .then((r) => ({ id, candidate, result: r }), (e) => ({ id, candidate, result: failure(candidate, e) }));
      pending.set(id, promise);
    }
  };
  const onSignal = () => { terminateRunningCompilers(); };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    submit(jobs);
    let stop = false;
    while (pending.size && !stop) {
      const done = await Promise.race(pending.values());
      pending.delete(done.id);
      const r = record(done.result, done.candidate);
      if (stop_on_exact && r.comparison !== null && r.comparison.exact) stop = true;
      if (!stop) submit(1);
    }
    // Candidates already running finish and are recorded.
    for (const done of await Promise.all(pending.values())) record(done.result, done.candidate);
    pending.clear();
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  }
  const key = sortCampaignResultsKey(results, { rank_by, requiredSignalsPass: signals.requiredSignalsPass });
  return sorted(results, key);
}

function commonChecks({ jobs, timeout, stream_limit, rank_by }) {
  if (jobs < 1) throw new ValueError("--jobs must be at least 1");
  if (timeout !== null && timeout !== undefined && timeout <= 0) throw new ValueError("--timeout must be positive");
  if (stream_limit < 0) throw new ValueError("--stream-limit must be non-negative");
  if (!["auto", "words", "temp-prefix"].includes(rank_by)) throw new ValueError("rank_by must be auto, words, or temp-prefix");
}

function commonPaths({ target, compile_cwd, cache_dir, keep_objects, artifact_dir, ledger }) {
  const targetPath = resolvePath(target);
  if (!isFile(targetPath)) throw new FileNotFoundError(`target object does not exist: ${targetPath}`);
  const cwd = compile_cwd ? resolvePath(compile_cwd) : resolvePath(process.cwd());
  if (!isDir(cwd)) throw new NotADirectoryError(`compiler working directory does not exist: ${cwd}`);
  const cachePath = resolvePath(cache_dir);
  fs.mkdirSync(cachePath, { recursive: true });
  const keepPath = keep_objects ? resolvePath(keep_objects) : null;
  if (keepPath) fs.mkdirSync(keepPath, { recursive: true });
  const artifactPath = artifact_dir ? resolvePath(artifact_dir) : null;
  if (artifactPath) fs.mkdirSync(artifactPath, { recursive: true });
  const ledgerPath = ledger ? resolvePath(ledger) : null;
  if (ledgerPath) fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  return { targetPath, cwd, cachePath, keepPath, artifactPath, ledgerPath };
}

/**
 * Compile a candidate set and return [results, duplicates] in deterministic
 * order. With stop_on_exact, submission stops once one compares exact.
 */
export async function runCampaign(sources, { target, template, cache_dir, ledger = null, jobs = 1, objdump = null, symbol = null, section = ".text",
  environment = null, compile_cwd = null, keep_objects = null, stop_on_exact = true, timeout = 120.0, stream_limit = DEFAULT_STREAM_LIMIT,
  artifact_dir = null, candidate_metadata = null, selected_region = null, signal_specs = [], compilation_envelope = null, rank_by = "auto",
  warn = undefined }) {
  commonChecks({ jobs, timeout, stream_limit, rank_by });
  const { targetPath, cwd, cachePath, keepPath, artifactPath, ledgerPath } = commonPaths({ target, compile_cwd, cache_dir, keep_objects, artifact_dir, ledger });
  const env = environment ?? {};
  const objdumpPath = discoverObjdump(objdump);
  const [candidates, duplicates] = prepareCandidates(sources, { template, target: targetPath, symbol, environment: env, compile_cwd: cwd, section, objdump: objdumpPath, compilation_envelope });
  const targetObject = loadTarget(targetPath, { objdump: objdumpPath, symbol, section });
  const results = await executeCandidates(candidates, duplicates, { target_object: targetObject, template, cache_path: cachePath, ledger_path: ledgerPath,
    jobs, objdump_path: objdumpPath, section, environment_for: () => env, compile_cwd_path: cwd, keep_path: keepPath, stop_on_exact, timeout,
    stream_limit, artifact_path: artifactPath, candidate_metadata: candidate_metadata ?? {}, selected_region, signal_specs,
    deduplicate_ledger: false, rank_by, warn });
  return [results, duplicates];
}

/** Run one source under many explicit environments in one campaign core. */
export async function runParameterizedCampaign(variants, { target, template, cache_dir, ledger = null, jobs = 1, objdump = null, symbol = null,
  section = ".text", compile_cwd = null, keep_objects = null, stop_on_exact = false, timeout = 120.0, stream_limit = DEFAULT_STREAM_LIMIT,
  artifact_dir = null, rank_by = "auto", warn = undefined }) {
  commonChecks({ jobs, timeout, stream_limit, rank_by });
  const { targetPath, cwd, cachePath, keepPath, artifactPath, ledgerPath } = commonPaths({ target, compile_cwd, cache_dir, keep_objects, artifact_dir, ledger });
  const objdumpPath = discoverObjdump(objdump);
  const candidates = [], duplicates = {}, environments = {}, metadata = {};
  for (const variant of variants) {
    const [prepared] = prepareCandidates([variant.source], { template, target: targetPath, symbol, environment: variant.environment, compile_cwd: cwd, section, objdump: objdumpPath });
    const candidate = prepared[0];
    if (candidate.cache_key in environments) throw new ValueError("parameterized candidates have duplicate source/environment inputs");
    candidates.push(candidate);
    duplicates[candidate.cache_key] = [displayPath(candidate.source)];
    environments[candidate.cache_key] = variant.environment;
    metadata[candidate.cache_key] = variant.metadata;
  }
  const targetObject = loadTarget(targetPath, { objdump: objdumpPath, symbol, section });
  return executeCandidates(candidates, duplicates, { target_object: targetObject, template, cache_path: cachePath, ledger_path: ledgerPath, jobs,
    objdump_path: objdumpPath, section, environment_for: (c) => environments[c.cache_key], compile_cwd_path: cwd, keep_path: keepPath,
    stop_on_exact, timeout, stream_limit, artifact_path: artifactPath, candidate_metadata: metadata, selected_region: null, signal_specs: [],
    deduplicate_ledger: true, rank_by, warn });
}

/** Score one protected instruction region separately from its complement. */
export function regionScore(comparison, constraint) {
  const sites = comparison.aligned_diff_sites;
  const inside = sites.filter((s) => constraint.start <= Math.trunc(Number(s.index)) && Math.trunc(Number(s.index)) < constraint.end);
  const outside = sites.filter((s) => !(constraint.start <= Math.trunc(Number(s.index)) && Math.trunc(Number(s.index)) < constraint.end));
  const covered = comparison.target_instructions >= constraint.end && comparison.candidate_instructions >= constraint.end;
  const base = typeof constraint.asDict === "function" ? constraint.asDict() : { name: constraint.name, start: constraint.start, end: constraint.end };
  return { ...base, covered, exact: covered && !inside.length, selected_mismatches: inside.length, outside_mismatches: outside.length,
    outside_residual_sites: outside.slice(0, 64), outside_residual_sites_truncated: outside.length > 64 };
}

const defaultRequired = (receipts) => receipts.every((i) => !i.required || i.status === "PASS");

/** Rank region preservation before the ordinary whole-function metric. */
export function campaignResultSortKey(result, { by_raw = false, rank_by = "auto", requiredSignalsPass = defaultRequired } = {}) {
  const signalKey = [!requiredSignalsPass(result.signals ?? [])];
  const region = result.region;
  const regionKey = region !== null && region !== undefined ? [!region.exact, Math.trunc(Number(region.selected_mismatches)), Math.trunc(Number(region.outside_mismatches))] : [];
  const c = result.comparison;
  let metric = [];
  if (c !== null && c !== undefined) {
    if (rank_by === "temp-prefix") {
      const tempRow = c.temp_prefix_exact;
      metric = [c.alignment_method !== "positional-opcode", !c.pool_exact, tempRow !== null && tempRow !== undefined,
        -(tempRow !== null && tempRow !== undefined ? tempRow : c.target_instructions + 1), c.word_mismatches, c.aligned_total, c.candidate];
    } else if (rank_by === "words") metric = c.raw_sort_key;
    else if (by_raw) metric = [!c.exact, c.geometry_front || 0, c.raw_sort_key];
    else metric = c.sort_key;
  }
  return [c === null || c === undefined, ...signalKey, ...regionKey, metric, result.source];
}

/** The ordering key this result set can validly be sorted on. */
export function sortCampaignResultsKey(results, { rank_by = "auto", requiredSignalsPass = defaultRequired } = {}) {
  const comparisons = results.filter((r) => r.comparison).map((r) => r.comparison);
  const byRaw = comparisons.some((c) => !c.alignment_comparable);
  if (byRaw && rank_by === "auto") {
    const fronts = paretoLayers(comparisons.map((c) => c.geometry_vector));
    comparisons.forEach((c, i) => { c.geometry_front = fronts[i]; });
  } else for (const c of comparisons) c.geometry_front = null;
  return (r) => campaignResultSortKey(r, { by_raw: byRaw, rank_by, requiredSignalsPass });
}

/** Group successful variants that compiled to the same function bytes. */
export function groupObjectBasins(results, { rank_by = "auto" } = {}) {
  const materialized = [...results];
  const key = sortCampaignResultsKey(materialized, { rank_by });
  const buckets = new Map();
  for (const r of materialized) {
    if (!r.comparison) continue;
    const k = r.comparison.candidate_sha256;
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(r);
  }
  const grouped = [...buckets.values()].map((b) => sorted(b, key));
  return sorted(grouped, (b) => [key(b[0]), b[0].comparison ? b[0].comparison.candidate_sha256 : ""]);
}

export { strRepr };
