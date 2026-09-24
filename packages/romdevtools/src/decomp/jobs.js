// jobs.js - bounded candidate search as a cancellable, resumable background
// job around decomp-permuter. The permuter owns the mutation + scoring loop
// (it is the community's tool for exactly this); romdev owns the budget, the
// persistence, the process lifetime and the honest status.
//
// A job never touches the project's sources: import.py copies the TU + the
// target asm into its own directory under the workspace, and the compile
// script it writes runs the project's compiler with the candidate as input.
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { run } from "./mips-obj.js";
import { toolPaths, backendStatus } from "./m2c.js";
import { sha256Text, dependencyHash } from "./project.js";
import { profileFor } from "./platform.js";
import { atomicJson, hashRecord, storedMeasurementFreshness, fileRevisions, linkedMismatchCount } from "./measurement.js";

const jobsDir = (project) => path.join(project.ws, "jobs");
let counter = 0;
const ownedChildren = new Map();

/**
 * Build a decomp-permuter directory WITHOUT touching the project tree:
 *   base.c       the real TU with the candidate spliced in, preprocessed with the
 *                build's own includes/defines (pragmas stripped; the permuter
 *                replaces every other function with a declaration itself)
 *   target.o     the extracted asm assembled by romdev (same prelude the
 *                permuter's import.py uses)
 *   compile.sh   the project's compiler with the TU's exact flags (asm-processor
 *                stripped away: base.c has no GLOBAL_ASM left to process)
 *   settings.toml func_name + compiler_type + objdump
 */
async function preparePermuterDir(project, fn, baseCandidateText, jobDir, weights = null) {
  const t = toolPaths();
  if (!fs.existsSync(path.join(t.permuter, "permuter.py"))) throw Object.assign(new Error(`decomp-permuter not installed at ${t.permuter}. ${(await backendStatus()).permuter.setup}`), { code: "MISSING_BACKEND" });
  const { spliceFunction, ensureTarget } = await import("./compile.js");
  const tuRel = fn.source?.tu;
  if (!tuRel) throw Object.assign(new Error(`function '${fn.symbol}' is in no TU`), { code: "FUNCTION_NOT_IN_TU" });
  const target = await ensureTarget(project, fn);
  if (target.romOnly) throw Object.assign(new Error(`function '${fn.symbol}' has no extracted asm; the permuter needs a target .s`), { code: "NO_TARGET_ASM" });
  const inv = await project.compileInvocation(tuRel);
  // Preprocess the spliced TU with the build's include paths + defines.
  const tuText = await readFile(project.abs(tuRel), "utf8");
  const spliced = spliceFunction(tuText, fn.symbol, baseCandidateText).text.replace(/^[ \t]*#pragma\s+GLOBAL_ASM\([^)]*\)[ \t]*$/gm, "");
  const permDir = path.join(jobDir, "permuter");
  await mkdir(permDir, { recursive: true });
  const inPath = path.join(permDir, "base.in.c");
  await writeFile(inPath, spliced);
  const inc = inv.compile.reduce((acc, a, i, arr) => { if (arr[i - 1] === "-I") acc.push("-I", a); return acc; }, []);
  const defs = inv.compile.filter((a) => /^-D/.test(a));
  const pp = await run("gcc", ["-E", "-P", "-nostdinc", "-fno-builtin", "-std=gnu89", "-x", "c", ...inc, "-I", path.dirname(project.abs(tuRel)), ...defs, "-D_LANGUAGE_C", "-DPERMUTER", "-D__attribute__(x)=", "-U__GNUC__", inPath], { cwd: project.root, env: project.env, timeoutMs: 60_000 });
  if (pp.code !== 0) throw Object.assign(new Error(`preprocessing the TU for the permuter failed: ${pp.stderr.slice(0, 800)}`), { code: "SEARCH_IMPORT_FAILED" });
  await writeFile(path.join(permDir, "base.c"), pp.stdout);
  try { fs.unlinkSync(inPath); } catch {}
  await copyFileSafe(target.targetO, path.join(permDir, "target.o"));
  // compile.sh: the IDO invocation from the captured argv (drop the asm-processor wrapper + assembler section).
  const argv = inv.compile;
  let cc = argv;
  const bp = argv.findIndex((a) => /asm-processor\/build\.py$/.test(a));
  if (bp >= 0) {
    const firstSep = argv.indexOf("--");
    const secondSep = argv.indexOf("--", firstSep + 1);
    const compiler = argv[firstSep - 1];
    cc = [compiler, ...argv.slice(secondSep + 1)];
  }
  const objRel = inv.object;
  const ccOut = cc.map((a) => (a === tuRel ? '"$INPUT"' : a === objRel ? '"$OUTPUT"' : shq(a)));
  const envLines = Object.entries(project.env).map(([k, v]) => `export ${k}=${shq(v)}`).join("\n");
  const sh = `#!/usr/bin/env bash\nset -euo pipefail\nINPUT="$(realpath "$1")"\nOUTPUT="$(realpath "$3")"\n${envLines}\ncd ${shq(project.root)}\n${ccOut.join(" ")}\n`;
  await writeFile(path.join(permDir, "compile.sh"), sh, { mode: 0o755 });
  const objdump = project.m.toolchain.objdump?.path ?? (project.m.toolchain.binutilsPrefix ?? "mips-linux-gnu-") + "objdump";
  const profile = profileFor(project.m.splatPlatform ?? project.m.platform);
  const compilerKind = project.m.toolchain?.compiler?.kind ?? "ido";
  const permuterType = profile.permuterTypeByCompiler[compilerKind] ?? "gcc";
  await writeFile(path.join(permDir, "settings.toml"), `func_name = "${fn.symbol}"\ncompiler_type = "${permuterType}"\nobjdump_command = "${objdump} --disassemble --reloc --disassemble-zeroes -Mreg-names=32 -Mno-aliases"\n`
    + (weights ? "\n[weight_overrides]\n" + Object.entries(weights).map(([k, v]) => `${k} = ${v}.0`).join("\n") + "\n" : ""));
  await writeFile(path.join(jobDir, "import.log"), `base.c: preprocessed ${tuRel} with the candidate spliced at ${fn.symbol}\ncompile.sh: ${ccOut.join(" ")}\ntarget.o: ${target.targetO}\n`);
  return { permDir, importLog: path.join(jobDir, "import.log"), compile: ccOut.join(" ") };
}

function shq(s) { return /^[A-Za-z0-9_\/.=:+-]+$/.test(s) ? s : "'" + String(s).replace(/'/g, "'\\''") + "'"; }
async function copyFileSafe(src, dst) { const { copyFile } = await import("node:fs/promises"); await copyFile(src, dst); }

/**
 * Resolve a caller's seed to the BACKEND's grammar, or refuse it.
 *
 * decomp-permuter parses `--seed` as `map(int, s.split(","))`: one integer
 * (the RNG seed) or `permuterIndex,rngSeed`. A descriptive string like
 * `i5-schedule-rodata-297` passed argparse (type=str) and then crashed inside
 * the backend AFTER the job directory existed and the process had been
 * spawned - an orphan job and a stack trace instead of an error.
 *
 * Descriptive labels are genuinely useful, so rather than only refusing them
 * this maps one deterministically onto the backend's integer space: the same
 * string always yields the same seed, and the mapping is RETURNED so a run can
 * be reproduced exactly. A numeric seed is passed through untouched.
 *
 * @param {string|undefined|null} seed
 * @returns {{seed:string|null, resolved:string|null, from:string|null, mapping:string|null}}
 */
export function resolveSeed(seed) {
  if (seed == null || seed === "") return { seed: null, resolved: null, from: null, mapping: null };
  const raw = String(seed).trim();
  // The backend's own grammar: N or N,N (32-bit, non-negative).
  if (/^\d+(,\d+)?$/.test(raw)) {
    const parts = raw.split(",").map(Number);
    if (parts.some((n) => !Number.isSafeInteger(n) || n < 0 || n > 0xffffffff)) {
      throw Object.assign(new Error(`seed '${raw}': each part must be an integer in 0..4294967295. The backend parses --seed as 'rngSeed' or 'permuterIndex,rngSeed'.`), { code: "BAD_ARGS" });
    }
    return { seed: raw, resolved: raw, from: "numeric", mapping: null };
  }
  // A descriptive label: map it deterministically instead of refusing outright.
  if (/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(raw)) {
    const h = createHash("sha256").update(raw).digest();
    const n = h.readUInt32BE(0);
    return { seed: String(n), resolved: String(n), from: "label",
      mapping: `'${raw}' -> ${n} (sha256(label)[0..4) as a uint32; stable across runs and machines)` };
  }
  throw Object.assign(new Error(`seed '${raw}' is not usable. Supported: an integer ('297'), 'permuterIndex,rngSeed' ('0,297'), or a descriptive label matching [A-Za-z0-9][A-Za-z0-9._-]* which is mapped deterministically to an integer. The backend itself accepts ONLY integers, so an unmapped string crashes it.`), { code: "BAD_ARGS" });
}

/**
 * Start a search job.
 * @param {{project, fn, baseCandidateText, timeLimitS?:number, threads?:number, seed?:string, stopOnZero?:boolean, label?:string, resumeFrom?:string}} a
 */
export async function startSearch({ project, fn, baseCandidateText, timeLimitS = 300, threads = 2, seed, stopOnZero = true, label, resumeFrom, preflight = null,
  purpose, family, mutationPasses, noImprovementS = 30, repeatSearch = false }) {
  const t = toolPaths();
  // PREFLIGHT BEFORE SPENDING BUDGET.
  //
  // §9: a 300-second, eight-thread search returned no improvement after ~317
  // seconds. A search can only permute a base that COMPILES, and a base that
  // is already exact needs no search at all - both are answerable in one
  // compile, before committing minutes of CPU. The caller supplies the check;
  // this refuses to launch when it fails, because "budget exhausted" is a much
  // more expensive way to learn the same thing.
  if (preflight) {
    if (preflight.compileSucceeded === false) {
      throw Object.assign(new Error(`search preflight FAILED: the base candidate does not compile, so every mutation of it would also fail. Fix the diagnostics first - a search cannot permute a candidate the compiler rejects.${preflight.firstDiagnostic ? ` First error: ${preflight.firstDiagnostic}` : ""}`), { code: "PREFLIGHT_FAILED" });
    }
    if (preflight.exactFunctionMatch === true) {
      throw Object.assign(new Error("search preflight: the base candidate is ALREADY byte-exact. There is nothing to search for - verify it with decomp({op:'compare'}) and integrate it."), { code: "PREFLIGHT_ALREADY_EXACT" });
    }
  }
  // VALIDATE BEFORE ANYTHING EXISTS. This throws synchronously, so an invalid
  // seed cannot leave a job directory or a spawned process behind.
  const seedInfo = resolveSeed(seed);
  if (!preflight?.inputIdentity?.sha256 || preflight.measurementValidity?.state !== "valid" || preflight.compileSucceeded !== true
    || preflight.inputIdentity.candidateSha256 !== sha256Text(baseCandidateText)) {
    throw Object.assign(new Error("search requires a compiled, valid, correctly identified baseline; preflight:false cannot bypass measurement identity"), { code: "PREFLIGHT_REQUIRED" });
  }
  if (!purpose?.trim()) throw Object.assign(new Error("search requires a stated purpose: which residual/hypothesis justifies this budget?"), { code: "SEARCH_PURPOSE_REQUIRED" });
  if (preflight.inputIdentity.symbol !== fn.symbol || (preflight.inputIdentity.segment ?? null) !== (fn.segment ?? null)
    || preflight.inputIdentity.ownerMode !== "live" || preflight.inputIdentity.declarationsSha256 !== sha256Text("")) {
    throw Object.assign(new Error("search baseline must describe this function/overlay in the live owner without separate injected declarations"), { code: "PREFLIGHT_CONTEXT_MISMATCH" });
  }
  const validateBaseline = async () => {
    const invocation = await project.compileInvocation(fn.source.tu);
    const dep = await dependencyHash(project, fn.source.tu, invocation);
    const fresh = await storedMeasurementFreshness(project, preflight, { dependencyHash: dep.depsOk ? dep.hash : null });
    if (fresh.state !== "current") throw Object.assign(new Error(`search baseline needs refresh: ${fresh.reason}`), { code: "PREFLIGHT_STALE" });
  };
  await validateBaseline();
  const watched = [project.abs(fn.source.tu), ...preflight.inputIdentity.toolchain.map(f => f.path),
    ...preflight.referenceFiles.map(f => f.path), ...preflight.candidateDependencyFiles.map(f => f.path)];
  const beforePreparation = await fileRevisions(watched);
  let weights = null;
  if (mutationPasses?.length) {
    const type = profileFor(project.m.splatPlatform ?? project.m.platform).permuterTypeByCompiler[project.m.toolchain.compiler.kind] ?? "gcc";
    const query = await run(t.python, ["-c", "import sys,json; sys.path.insert(0,sys.argv[1]); from src.helpers import get_default_randomization_weights; print(json.dumps(get_default_randomization_weights(sys.argv[2])))", t.permuter, type]);
    if (query.code !== 0) throw new Error(`cannot discover backend mutation passes: ${query.stderr.slice(0, 200)}`);
    const available = Object.keys(JSON.parse(query.stdout));
    if (mutationPasses.some(p => !available.includes(p))) throw Object.assign(new Error(`unknown mutation pass; backend supports: ${available.join(", ")}`), { code: "BAD_ARGS" });
    weights = Object.fromEntries(available.map(p => [p, mutationPasses.includes(p) ? 1 : 0]));
  }
  if (family && !weights && !/PERM_\w+\s*\(/.test(baseCandidateText)) throw Object.assign(new Error("a declared search family needs mutationPasses or PERM macros; a prose label does not constrain the backend"), { code: "BAD_ARGS" });
  const searchScope = { baseline: preflight.inputIdentity.sha256, reference: preflight.referenceHash,
    output: preflight.outputIdentity, family: family ?? "undirected-randomization", mutationWeights: weights, seed: seedInfo.seed, threads,
    defaultWeightsSha256: sha256Text(await readFile(path.join(t.permuter, "default_weights.toml"), "utf8")),
    backend: (await backendStatus()).permuter?.commit ?? null };
  const searchIdentity = hashRecord(searchScope);
  const priorScope = [];
  for (const id of await readdir(jobsDir(project)).catch(() => [])) {
    try {
      const previous = await jobStatus(project, id);
      if (previous.searchIdentity === searchIdentity && ["complete-budget", "complete-no-progress"].includes(previous.status) && previous.improvements === 0) {
        priorScope.push({ jobId: id, elapsedS: previous.elapsedS, status: previous.status, scope: "same identified baseline/family/seed/threads/backend, bounded sample only" });
      }
    } catch {}
  }
  if (priorScope.length && !repeatSearch) throw Object.assign(new Error(`this exact search scope already made no improvement (${priorScope.map(p => p.jobId).join(", ")}); choose a new mechanism/seed or explicitly pass repeatSearch:true`), { code: "SEARCH_SCOPE_ALREADY_TESTED", priorScope });
  const jobId = `search-${fn.symbol}-${Date.now().toString(36)}${(counter++).toString(36)}`;
  const jobDir = path.join(jobsDir(project), jobId);
  await mkdir(jobDir, { recursive: true });
  const prep = await preparePermuterDir(project, fn, baseCandidateText, jobDir, weights);
  await validateBaseline();
  if (hashRecord(beforePreparation) !== hashRecord(await fileRevisions(watched))) {
    await atomicJson(path.join(jobDir, "preparation-invalid.json"), { reason: "inputs changed during search preparation", spawned: false });
    throw Object.assign(new Error("inputs changed during search preparation; no search was spawned, refresh baseline"), { code: "PREFLIGHT_STALE" });
  }
  const args = [path.join(t.permuter, "permuter.py"), prep.permDir, "-j", String(Math.max(1, threads)), "--quiet", "--no-context-output", ...(stopOnZero ? ["--stop-on-zero"] : []), ...(seedInfo.seed ? ["--seed", seedInfo.seed] : [])];
  const logPath = path.join(jobDir, "permuter.log");
  const out = fs.openSync(logPath, "a");
  const child = spawn("timeout", ["-s", "INT", "-k", "10", String(timeLimitS), t.python, ...args], { cwd: jobDir, env: { ...process.env, ...project.env, PYTHONUNBUFFERED: "1" }, detached: true, stdio: ["ignore", out, out] });
  child.unref();
  ownedChildren.set(prep.permDir, child);
  fs.closeSync(out);
  const rec = {
    jobId, project: project.id, function: { symbol: fn.symbol, segment: fn.segment, va: fn.vaHex }, label: label ?? null,
    status: "running", pid: child.pid, startedAt: new Date().toISOString(), timeLimitS, threads, seed: seedInfo.seed, seedRequested: seed ?? null, seedFrom: seedInfo.from, seedMapping: seedInfo.mapping, stopOnZero,
    resumeFrom: resumeFrom ?? null, baseCandidateSha256: sha256Text(baseCandidateText).slice(0, 16),
    purpose, family: family ?? null, mutationPasses: mutationPasses ?? null, searchScope, searchIdentity, priorScope, noImprovementS,
    ...(preflight ? { preflight } : {}),
    dir: jobDir, permuterDir: prep.permDir, log: logPath, importLog: prep.importLog,
    backend: { name: "decomp-permuter", commit: (await backendStatus()).permuter?.commit, argv: [t.python, ...args] },
    best: null,
  };
  await writeFile(path.join(jobDir, "base.c"), baseCandidateText);
  await atomicJson(path.join(jobDir, "job.json"), rec);
  // Watch only the child this process just created, never a recycled PID from
  // an old job record. The external timeout still enforces the overall budget
  // if this server exits. No-progress enforcement is process-local, disclosed.
  let lastImprovedAt = Date.now(), bestObserved = Infinity, checking = false, stopReason = null;
  const watchdog = setInterval(async () => {
    if (checking || child.exitCode != null || child.signalCode != null) return;
    checking = true;
    try {
      const log = await readFile(logPath, "utf8");
      const progress = searchLogProgress(log, preflight);
      if (progress.best != null && progress.best < bestObserved) { bestObserved = progress.best; lastImprovedAt = Date.now(); }
      const reason = progress.normalizedZeroNonExact ? "normalized-zero-nonexact-baseline"
        : Date.now() - lastImprovedAt >= noImprovementS * 1000 ? "no-improvement-budget" : null;
      if (reason && !stopReason) {
        stopReason = reason;
        await atomicJson(path.join(jobDir, "termination.json"), { reason, at: new Date().toISOString(), logBytes: Buffer.byteLength(log) });
        try { process.kill(-child.pid, "SIGINT"); } catch { child.kill("SIGINT"); }
      }
    } catch { /* import/startup may not have written its first log line yet */ }
    finally { checking = false; }
  }, 1000);
  watchdog.unref();
  child.once("exit", (code, signal) => {
    clearInterval(watchdog);
    ownedChildren.delete(prep.permDir);
    void atomicJson(path.join(jobDir, "exit.json"), { code, signal, at: new Date().toISOString() }).catch(() => {});
  });
  child.once("error", error => {
    clearInterval(watchdog);
    ownedChildren.delete(prep.permDir);
    void atomicJson(path.join(jobDir, "exit.json"), { code: null, error: error.message, at: new Date().toISOString() }).catch(() => {});
  });
  return rec;
}

export function searchLogProgress(log, preflight) {
  const base = Number(/base score\s*=\s*(\d+)/.exec(log)?.[1] ?? NaN);
  const improvements = [...log.matchAll(/found (?:new best|a better) score!? \((\d+) vs (\d+)\)/g)].map(m => Number(m[1]));
  return { base: Number.isFinite(base) ? base : null,
    best: improvements.length ? Math.min(...improvements) : Number.isFinite(base) ? base : null,
    normalizedZeroNonExact: base === 0 && preflight?.exactFunctionMatch === false,
    improvements: improvements.length };
}

export function searchBaseline(r) {
  return { compileSucceeded: r.compileSucceeded, strictMismatches: r.strictMismatches ?? null,
    linkedMismatches: linkedMismatchCount(r), exactFunctionMatch: r.exactFunctionMatch,
    inputIdentity: r.inputIdentity, outputIdentity: r.outputIdentity, referenceHash: r.referenceHash,
    measurementValidity: r.measurementValidity, verifierVersion: r.verifierVersion,
    producerSchema: r.producerSchema, compiler: r.compiler, referenceFiles: r.referenceFiles,
    candidateDependencyFiles: r.candidateDependencyFiles, functionReference: r.functionReference,
    firstDiagnostic: (r.diagnostics ?? []).find(d => d.severity === "error")?.message?.slice(0, 200) ?? null };
}

/** Only a recorded intentional stop can explain a shutdown KeyboardInterrupt.
 * Other tracebacks/errors, including ones preceding the stop, stay failures. */
export function searchLogErrors(log, termination, exit) {
  const count = text => (text.match(/(Traceback|Error:|error:)/g) ?? []).length;
  const expectedStop = ["no-improvement-budget", "normalized-zero-nonexact-baseline"].includes(termination?.reason)
    || exit?.code === 124;
  let shutdownTracebacks = 0;
  const diagnosticLog = expectedStop ? log.replace(
    /Traceback \(most recent call last\):\r?\n(?:[ \t].*\r?\n)*KeyboardInterrupt(?::[^\r\n]*)?(?:\r?\n|$)/g,
    (block, offset) => {
      if (Number.isInteger(termination?.logBytes) && Buffer.byteLength(log.slice(0, offset)) < termination.logBytes) return block;
      shutdownTracebacks++;
      return "";
    }) : log;
  return { errorLines: count(diagnosticLog), rawErrorLines: count(log), shutdownTracebacks };
}

/** Read a job record + derive live status from the log and output dirs. */
export async function jobStatus(project, jobId) {
  const jobDir = path.join(jobsDir(project), jobId);
  let rec;
  try { rec = JSON.parse(await readFile(path.join(jobDir, "job.json"), "utf8")); } catch { throw Object.assign(new Error(`no job '${jobId}' for project '${project.id}'`), { code: "JOB_NOT_FOUND" }); }
  const log = fs.existsSync(rec.log) ? await readFile(rec.log, "utf8") : "";
  const termination = await readFile(path.join(jobDir, "termination.json"), "utf8").then(JSON.parse, () => null);
  const exit = await readFile(path.join(jobDir, "exit.json"), "utf8").then(JSON.parse, () => null);
  const alive = await jobProcessAlive(rec);
  const ownershipUnknown = !alive && !!rec.pid && isAlive(rec.pid);
  // Permuter lines: "base score = N", "found new best score! (N vs M)", "iteration K", "Found zero score!"
  const baseScore = Number(/base score\s*=\s*(\d+)/.exec(log)?.[1] ?? NaN);
  const bestHits = [...log.matchAll(/found (?:new best|a better) score!? \((\d+) vs (\d+)\)/g)].map((m) => Number(m[1]));
  const zero = /Found zero score/.test(log) || /score 0\b/.test(log) && /output-0-/.test(log);
  const logErrors = searchLogErrors(log, termination, exit);
  const errors = logErrors.errorLines;
  // Best candidate on disk: output-<score>-<n>/source.c under the permuter dir.
  let best = null;
  try {
    const outs = (await readdir(rec.permuterDir)).filter((d) => /^output-(\d+)-\d+$/.test(d)).map((d) => ({ dir: d, score: Number(/^output-(\d+)-/.exec(d)[1]) })).sort((a, b) => a.score - b.score);
    if (outs.length) {
      const b = outs[0];
      const src = path.join(rec.permuterDir, b.dir, "source.c");
      best = { score: b.score, path: src, candidatesWritten: outs.length, sha256: fs.existsSync(src) ? sha256Text(await readFile(src, "utf8")).slice(0, 16) : null };
    }
  } catch {}
  let status = rec.status;
  if (status === "running" && !alive) status = zero ? "complete-zero" : "complete-budget";
  const progress = searchLogProgress(log, rec.preflight);
  if (!alive && termination?.reason === "no-improvement-budget") status = "complete-no-progress";
  if (!alive && progress.normalizedZeroNonExact) status = "complete-scorer-blind-spot";
  // A timeout's expected shutdown traceback is not a backend failure. An
  // actual error is still a failure even if a stop marker or best file exists.
  const intentionalInterrupt = !!rec.cancelledAt || ["no-improvement-budget", "normalized-zero-nonexact-baseline"].includes(termination?.reason);
  const unexpectedExit = exit?.error || (exit?.code != null && ![0, 124].includes(exit.code) && !(exit.code === 130 && intentionalInterrupt))
    || (exit?.signal && !(exit.signal === "SIGINT" && intentionalInterrupt));
  if (!alive && (errors > 0 || unexpectedExit)) status = "failed";
  if (rec.cancelledAt) status = alive ? "cancelling" : "cancelled";
  if (ownershipUnknown && rec.status === "running") status = "unknown-process-ownership";
  // A FINISHED job's elapsed time is endedAt - startedAt, not now - startedAt.
  //
  // This read `Date.now()` unconditionally, so a completed run's elapsed time
  // kept growing forever: four real jobs that ran 45-210 seconds
  // against minute-scale budgets reported ~9 DAYS, which reads as a runaway
  // permuter rather than a job that finished normally. `endedAt` was already
  // being recorded a few lines below - and note it is stamped AFTER this line,
  // so a job detected as finished on THIS call had no endedAt to use yet.
  // Stamp it first, then measure.
  if (!alive && !ownershipUnknown && !rec.endedAt && ["running", "cancelling"].includes(rec.status)) rec.endedAt = exit?.at ?? new Date().toISOString();
  const endMs = rec.endedAt ? Date.parse(rec.endedAt) : (rec.cancelledAt ? Date.parse(rec.cancelledAt) : Date.now());
  const elapsedS = Math.round((endMs - Date.parse(rec.startedAt)) / 1000);
  const derived = { ...rec, status, alive, ownershipUnknown, elapsedS, normalizedZeroNonExact: progress.normalizedZeroNonExact,
    terminationReason: termination?.reason ?? (progress.normalizedZeroNonExact ? "normalized-zero-nonexact-baseline" : null),
    noProgressWatchdog: "process-local; after a server restart only the external total-time budget remains active",
    baseScore: Number.isNaN(baseScore) ? null : baseScore, bestScoreSeen: bestHits.length ? Math.min(...bestHits) : null, improvements: bestHits.length, candidatesWritten: (log.match(/^wrote to /gm) ?? []).length, zeroFound: zero, ...logErrors, best,
    logTail: log.split("\n").filter(Boolean).slice(-6), note: status === "complete-budget" ? "budget exhausted - NOT a match unless best.score is 0 and compare confirms exact" : status === "complete-zero" ? "the permuter found a zero-score candidate; run decomp({op:'compare'}) on best.path to confirm strict equality" : undefined };
  if (status !== rec.status || (best && JSON.stringify(best) !== JSON.stringify(rec.best))) {
    rec.status = status; rec.best = best; if (!alive && !ownershipUnknown && !rec.endedAt) rec.endedAt = derived.endedAt ?? new Date().toISOString();
    await atomicJson(path.join(jobDir, "job.json"), rec);
  }
  return derived;
}

export async function cancelJob(project, jobId) {
  const current = await jobStatus(project, jobId);
  if (!current.alive && !current.ownershipUnknown) return { ...current, cancellationRequested: false,
    cancellationNote: "already stopped; preserved its actual completion reason and search-history evidence" };
  const jobDir = path.join(jobsDir(project), jobId);
  const rec = JSON.parse(await readFile(path.join(jobDir, "job.json"), "utf8"));
  if (rec.pid && isAlive(rec.pid) && !await jobProcessAlive(rec)) throw Object.assign(new Error("cannot establish that the live PID still belongs to this search; no process was signalled"), { code: "PROCESS_OWNERSHIP_UNKNOWN" });
  if (await jobProcessAlive(rec)) { try { process.kill(-rec.pid, "SIGINT"); } catch { try { process.kill(rec.pid, "SIGINT"); } catch {} } }
  rec.cancelledAt = new Date().toISOString(); rec.status = "cancelling";
  await atomicJson(path.join(jobDir, "job.json"), rec);
  return jobStatus(project, jobId);
}

export async function listJobs(project, symbol) {
  let ids = [];
  try { ids = await readdir(jobsDir(project)); } catch { return []; }
  const out = [];
  for (const id of ids) {
    try {
      const s = await jobStatus(project, id);
      if (symbol && s.function.symbol !== symbol) continue;
      // §11: after a restart a caller must be able to tell LIVE work from
      // terminal work "from authoritative process/job state", not from a
      // status field a dead process never got to update. `pid` is checked
      // against the OS; a record that still says "running" with no live
      // process is reported as abandoned rather than as work in progress.
      const live = s.alive;
      const lifecycle = s.ownershipUnknown ? "unknown" : live ? "live"
        : s.status === "running" ? "abandoned"
        : "terminal";
      out.push({ jobId: id, symbol: s.function.symbol, segment: s.function.segment ?? null,
        status: s.status, lifecycle, live, pid: s.pid ?? null,
        best: s.best?.score ?? null, bestPath: s.best?.path ?? null,
        elapsedS: s.elapsedS, startedAt: s.startedAt,
        ...(lifecycle === "abandoned" ? { abandonedNote: `the record says 'running' but pid ${s.pid} is not alive: the process died (a restart, an OOM kill, or a reboot) without updating its status. Its artifacts are still on disk and its best candidate is still usable; it will not make further progress.` } : {}) });
    } catch {}
  }
  return out.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
}

function isAlive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }

async function jobProcessAlive(rec) {
  if (!rec.pid || !isAlive(rec.pid)) return false;
  const child = ownedChildren.get(rec.permuterDir);
  if (child?.pid === rec.pid && child.exitCode == null && child.signalCode == null) return true;
  // A PID on its own is not job ownership after a restart. On Linux, require
  // the exact owned permuter directory in the process argv before status or
  // cancellation treats it as this search. Unknown ownership fails closed.
  try {
    const argv = (await readFile(`/proc/${rec.pid}/cmdline`, "utf8")).split("\0");
    return !!rec.permuterDir && argv.includes(rec.permuterDir) && argv.some(a => a.endsWith("permuter.py"));
  } catch { return false; }
}

/** A durable report of one job: base, best, every score improvement with its time, timings, and where everything is. */
export async function jobReport(project, jobId, { maxOutputs = 12 } = {}) {
  const s = await jobStatus(project, jobId);
  const log = fs.existsSync(s.log) ? await readFile(s.log, "utf8") : "";
  const history = [...log.matchAll(/found (?:new best|a better) score!? \((\d+) vs (\d+)\)/g)].map((m, i) => ({ n: i + 1, score: Number(m[1]), previous: Number(m[2]) }));
  const outputs = fs.existsSync(s.permuterDir) ? (await readdir(s.permuterDir)).filter((d) => /^output-\d+-\d+$/.test(d)).length : 0;
  const measuredOutputs = [];
  if (outputs && s.preflight?.inputIdentity && project.resolveFunction) {
    const { compileAndCompare, extractFunction } = await import("./compile.js");
    const fn = await project.resolveFunction({ symbol: s.function.symbol, segment: s.function.segment });
    const names = (await readdir(s.permuterDir)).filter(d => /^output-\d+-\d+$/.test(d))
      .sort((a, b) => Number(a.split("-")[1]) - Number(b.split("-")[1]));
    const seen = new Map();
    for (const name of names.slice(0, maxOutputs)) {
      const sourcePath = path.join(s.permuterDir, name, "source.c");
      try {
        const source = await readFile(sourcePath, "utf8");
        const text = extractFunction(source, s.function.symbol) ?? source;
        const sourceSha = sha256Text(text);
        if (seen.has(sourceSha)) { measuredOutputs.push({ sourcePath, duplicateSourceOf: seen.get(sourceSha) }); continue; }
        seen.set(sourceSha, sourcePath);
        const r = await compileAndCompare(project, fn, { candidateText: text, candidatePath: sourcePath, label: `search-verification:${jobId}` });
        const comparable = r.measurementValidity?.state === "valid" && r.inputIdentity?.dependencyHash === s.preflight.inputIdentity.dependencyHash
          && r.referenceHash === s.preflight.referenceHash && hashRecord(r.inputIdentity?.toolchain) === hashRecord(s.preflight.inputIdentity.toolchain)
          && r.inputIdentity?.ownerSha256 === s.preflight.inputIdentity.ownerSha256
          && r.inputIdentity?.ownerMode === s.preflight.inputIdentity.ownerMode
          && hashRecord(r.inputIdentity?.env) === hashRecord(s.preflight.inputIdentity.env)
          && hashRecord(r.inputIdentity?.invocation) === hashRecord(s.preflight.inputIdentity.invocation);
        measuredOutputs.push({ sourcePath, sourceSha, compiled: r.compileSucceeded, outputIdentity: r.outputIdentity,
          comparable, exact: comparable && r.exactFunctionMatch === true, linkedMismatches: linkedMismatchCount(r),
          usefulImprovement: comparable && linkedMismatchCount(r) != null && Number.isFinite(s.preflight.linkedMismatches)
            ? linkedMismatchCount(r) < s.preflight.linkedMismatches : null,
          artifacts: r.artifacts, inputIdentity: r.inputIdentity?.sha256 });
      } catch (e) { measuredOutputs.push({ sourcePath, error: e.message }); }
    }
    await atomicJson(path.join(s.dir, "output-verifications.json"), measuredOutputs);
  }
  // WHAT THE BUDGET ACTUALLY BOUGHT.
  //
  // §9: a 300s/8-thread run returned no improvement and left an 8-line log.
  // "No improvement" is only actionable if you know what was tried, so the
  // accounting below is read from the backend's own output rather than
  // inferred. A field the log does not support is reported as null - an
  // invented count would be worse than an absent one.
  const iterations = Number(/(?:iteration|tried)\s+(\d+)/i.exec(log)?.[1] ?? NaN);
  const compileFails = (log.match(/compile (?:error|failed)/gi) ?? []).length;
  const permMacros = /No perm macros found/i.test(log);
  const baseSources = Number(/Will try (\d+) different base sources/i.exec(log)?.[1] ?? NaN);
  const accounting = {
    elapsedS: s.elapsedS, timeLimitS: s.timeLimitS, threads: s.threads,
    candidatesWritten: outputs,
    improvements: history.length,
    uniqueVerifiedOutputs: measuredOutputs.length ? new Set(measuredOutputs.map(r => r.outputIdentity?.sha256).filter(Boolean)).size : null,
    usefulResidualImprovements: measuredOutputs.length ? measuredOutputs.filter(r => r.usefulImprovement === true).length : null,
    outputsVerified: measuredOutputs.length, outputsNotVerified: Math.max(0, outputs - measuredOutputs.length),
    allBackendUniqueOutputs: null,
    iterationsReported: Number.isFinite(iterations) ? iterations : null,
    compileFailures: compileFails || null,
    baseSources: Number.isFinite(baseSources) ? baseSources : null,
    mutationFamilies: s.mutationPasses?.length ? { enabledExclusively: s.mutationPasses, family: s.family }
      : permMacros ? "randomization only (no PERM macros in the base: the search explores random rewrites, not a declared family)" : "PERM macros present in the base",
    terminationReason: s.terminationReason ?? (s.zeroFound ? "zero score found"
      : s.status === "complete-budget" ? `time budget of ${s.timeLimitS}s exhausted`
      : s.status === "running" ? "still running"
      : s.status),
    note: Number.isFinite(iterations) ? undefined
      : "the backend's log does not report an iteration count, so effective compilations and cache hits cannot be stated. They are null rather than guessed.",
  };
  const exhaustedNoImprovement = s.status === "complete-budget" && history.length === 0;
  const report = { jobId, project: project.id, function: s.function, label: s.label, status: s.status, startedAt: s.startedAt, endedAt: s.endedAt ?? null, elapsedS: s.elapsedS, timeLimitS: s.timeLimitS, threads: s.threads, seed: s.seed,
    ...(s.seedRequested && s.seedFrom === "label" ? { seedRequested: s.seedRequested, seedMapping: s.seedMapping } : {}),
    ...(s.preflight ? { preflight: s.preflight } : {}),
    baseCandidateSha256: s.baseCandidateSha256, baseScore: s.baseScore, best: s.best, improvements: history, candidatesWritten: outputs, zeroFound: s.zeroFound, resumeFrom: s.resumeFrom,
    accounting, measuredOutputs, purpose: s.purpose, searchScope: s.searchScope, priorScope: s.priorScope,
    normalizedZeroNonExact: s.normalizedZeroNonExact,
    backend: s.backend, artifacts: { dir: s.dir, permuterDir: s.permuterDir, log: s.log, importLog: s.importLog, base: path.join(s.dir, "base.c") },
    verdict: s.normalizedZeroNonExact ? "scorer blind spot: normalized baseline zero was not exact under romdev; change the measurement/mechanism, not the integration verdict"
      : s.zeroFound ? "zero score found - run decomp({op:'compare'}) on best.path; the permuter's score is not the strict test" : s.status === "complete-budget" ? "budget exhausted - best is the closest candidate, not a match" : s.status,
    ...(exhaustedNoImprovement ? { recommendation: `${s.elapsedS}s of ${s.threads}-thread search produced NO improvement over base score ${s.baseScore}. ${permMacros ? "The base has no PERM macros, so this was undirected randomization - it cannot target a specific residual." : ""} Switch mechanism rather than re-running with a larger budget: diagnose the residual (decomp({op:'diagnose'})) to learn which groups exist, then test a bounded set of source levers (decomp({op:'variants'})). Re-running an exhausted undirected search explores the same space again.` } : {}) };
  const md = [`# search ${jobId}`, ``, `- function: ${s.function.symbol} (${s.function.segment} ${s.function.va})`, `- status: ${s.status} (${s.elapsedS}s of ${s.timeLimitS}s, ${s.threads} threads${s.seed ? ", seed " + s.seed : ""})`, `- base score: ${s.baseScore} → best: ${s.best?.score ?? "none"} (${outputs} candidates written, ${history.length} improvements)`, `- verdict: ${report.verdict}`, `- best candidate: ${s.best?.path ?? "none"}`, ``, `## improvements`, ...history.map((h) => `${h.n}. ${h.previous} → ${h.score}`), ``, `## artifacts`, `- ${s.dir}`, `- ${s.log}`].join("\n");
  await writeFile(path.join(s.dir, "report.json"), JSON.stringify(report, null, 2));
  await writeFile(path.join(s.dir, "report.md"), md);
  return { ...report, reportJson: path.join(s.dir, "report.json"), reportMd: path.join(s.dir, "report.md") };
}
