// permute-sweep.js - orchestration for `permute sweep` and `permute doctor`:
// import one function into a scratch whose recipe matches the real build,
// run the permuter under a wall-clock cap, and record what came back.
// Nothing here interprets a result, and nothing here promotes one.
//
// THE PERMUTER BACKEND is romdev's JS port of decomp-permuter, driven as two
// node programs in the permuter directory (permuter.permuter_dir, default the
// romdev-permuter package's bin/):
//   import.mjs <source.c> <target.s> --settings <toml> [--preserve-macros RE]
//       writes the scratch to <cwd>/nonmatchings/<function>/ (base.c,
//       compile.sh, target.o, settings.toml) and logs "Preserving ...".
//   permuter.mjs --stop-on-zero --quiet -j N --stack-diffs [...] <scratch>
//       logs "base score = N" and writes output-<score>-<n>/ directories.
// These are the command-line contracts of decomp-permuter's import.py and
// permuter.py; no interpreter other than node is ever started for them.
//
// Plain JS ESM + JSDoc.

import fs from "node:fs";
import path from "node:path";
import { spawnRouted } from "./proc.js";
import { fileURLToPath } from "node:url";
import { ValueError, sorted } from "./py.js";
import { expanduser } from "./py-path.js";
import { compareObjects } from "./compare.js";
import { readElf, ElfFormatError } from "./elf.js";
import { formatG } from "./globalcolor.js";
import { dumps } from "./pyjson.js";
import {
  DOCTOR_SCHEMA, FIDELITY_DIFFERS, FIDELITY_IDENTICAL, FIDELITY_UNKNOWN, BuildRecipe, FidelityAttempt, PreserveMacroMode,
  ScratchFidelity, SweepResult, appendCompileSteps, bestOutput, fidelityWarning, macroAttributable, objectTarget,
  outputFraction, parseBaseScore, parsePreservedMacros, permuterArgv, recipeReport, recoverRecipe, renderSettings,
  resolvePreserveMacroModes, retargetLabels, retargetObjcopy, shouldExtend, waitForHeadroom, isProcessError, errorText,
} from "./permute.js";

export const IMPORT_TOOL = "import.mjs";
export const SEARCH_TOOL = "permuter.mjs";

/** Where romdev's JS permuter keeps its two programs, when it is installed. */
export function defaultPermuterDir() {
  const candidates = [];
  try { candidates.push(path.join(path.dirname(fileURLToPath(import.meta.resolve("romdev-permuter"))), "..", "bin")); } catch { /* not installed as a package */ }
  candidates.push(fileURLToPath(new URL("../../../../romdev-permuter/bin", import.meta.url)));
  return candidates.map((c) => path.resolve(c)).find((c) => fs.existsSync(c)) ?? path.resolve(candidates[candidates.length - 1]);
}

/** A scratch could not be prepared, or a tool is missing. */
export class PermuterError extends Error { constructor(message) { super(message); this.name = "PermuterError"; } }

/** A child ran past its deadline; `output` is what it printed first. */
export class TimeoutExpired extends Error {
  constructor(argv, timeout, output = "") {
    super(`Command '${JSON.stringify(argv)}' timed out after ${timeout} seconds`);
    this.name = "TimeoutExpired"; this.argv = argv; this.timeout = timeout; this.output = output;
  }
}

/** A child exited non-zero under check=true. */
export class SubprocessError extends Error { constructor(message) { super(message); this.name = "SubprocessError"; } }

export const TERMINATE_GRACE_SECONDS = 2.0;

/**
 * Run one tool as the owner of its own process group. On a timeout the whole
 * group ends (SIGTERM, then SIGKILL after a grace period): the permuter runs a
 * pool of compiling children, and ending only the parent leaks the pool.
 * stdout: "pipe" | "devnull" | {file: path} ; stderr: "pipe" | "devnull" | "stdout".
 * timeout is in seconds.
 */
export function runOwned(argv, { cwd = null, stdout = "pipe", stderr = "pipe", timeout = null, check = false, env = null } = {}) {
  return new Promise((resolve, reject) => {
    let outFd = null;
    const stdio = ["ignore", "pipe", "pipe"];
    if (stdout === "devnull") stdio[1] = "ignore";
    else if (stdout && typeof stdout === "object" && stdout.file) { outFd = fs.openSync(stdout.file, "a"); stdio[1] = outFd; }
    if (stderr === "devnull") stdio[2] = "ignore";
    else if (stderr === "stdout") stdio[2] = outFd !== null ? outFd : "pipe";
    let child;
    try {
      child = spawnRouted(argv, { cwd: cwd ?? undefined, env: env ?? process.env, stdio, detached: process.platform !== "win32" });
    } catch (e) { if (outFd !== null) fs.closeSync(outFd); reject(e); return; }
    let out = "", err = "", timedOut = false, timer = null;
    child.stdout?.on("data", (d) => { out += d; });
    child.stderr?.on("data", (d) => { if (stderr === "stdout") out += d; else err += d; });
    const group = (sig) => { try { process.kill(-child.pid, sig); return true; } catch { try { child.kill(sig); } catch {} return false; } };
    if (timeout !== null && timeout !== undefined) {
      timer = setTimeout(() => {
        timedOut = true;
        group("SIGTERM");
        setTimeout(() => group("SIGKILL"), TERMINATE_GRACE_SECONDS * 1000).unref();
      }, Math.max(0, timeout * 1000));
    }
    child.on("error", (e) => { if (timer) clearTimeout(timer); if (outFd !== null) fs.closeSync(outFd); reject(e); });
    child.on("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      if (outFd !== null) fs.closeSync(outFd);
      if (timedOut) { reject(new TimeoutExpired([...argv], timeout ?? 0, out)); return; }
      const returncode = code ?? (signal ? -1 : 0);
      if (check && returncode !== 0) { reject(new SubprocessError(`Command '${JSON.stringify(argv)}' returned non-zero exit status ${returncode}.`)); return; }
      resolve({ args: [...argv], returncode, stdout: out, stderr: err });
    });
  });
}

/** One resolved sweep: where it runs, for how long, under what limits. */
export class SweepPlan {
  constructor({ root, options, output_dir, minutes, extend_minutes, threads, jobs, load_threshold, extra = [], check_fidelity = true, require_fidelity = false }) {
    Object.assign(this, { root, options, output_dir, minutes, extend_minutes, threads, jobs, load_threshold, extra, check_fidelity, require_fidelity });
    Object.freeze(this);
  }
  get objdump() { return this.options.objdump ?? null; }
  /** The wall-clock cap on one scratch-preparation child, in seconds. */
  get step_timeout() { return this.options.step_timeout_seconds ?? 600.0; }
  /** The import modes this project tries, in order. */
  get preserve_macro_modes() { return resolvePreserveMacroModes(this.options.preserve_macros ?? [], this.options.preserve_macro_modes); }
  /** The program that runs the permuter's entry points: node. */
  get interpreter() { return process.execPath; }
  tool(name) {
    const directory = this.options.permuter_dir ? String(this.options.permuter_dir) : defaultPermuterDir();
    const tool = path.join(directory, name);
    let ok = false;
    try { ok = fs.statSync(tool).isFile(); } catch { ok = false; }
    if (!ok) {
      throw new PermuterError(`the JS permuter's ${name} is not at ${tool}: set permuter.permuter_dir in `
        + ".decomp-workbench.toml or pass --permuter-dir to a directory holding romdev's "
        + `${IMPORT_TOOL} and ${SEARCH_TOOL} (decomp-permuter's import.py/permuter.py contracts, run with node)`);
    }
    return tool;
  }
}

/** Apply command-line overrides over the project's configured defaults. */
export function resolvePlan(root, options, {
  permuter_dir = null, output_dir = null, minutes = null, extend_minutes = 0, threads = null, jobs = null, load_threshold = null,
  make = null, extra = [], cpu_count = 4, objdump = null, check_fidelity = true, require_fidelity = false,
} = {}) {
  root = String(root);
  let opts = options;
  const withField = (o, k, v) => { const copy = Object.create(Object.getPrototypeOf(o)); Object.assign(copy, o, { [k]: v }); return Object.isFrozen(o) ? Object.freeze(copy) : copy; };
  if (permuter_dir !== null && permuter_dir !== undefined) opts = withField(opts, "permuter_dir", expanduser(permuter_dir));
  if (make !== null && make !== undefined) opts = withField(opts, "make", make);
  if (objdump !== null && objdump !== undefined) opts = withField(opts, "objdump", objdump);
  const resolvedJobs = jobs || opts.jobs || 1;
  let resolvedThreads = threads || opts.threads || null;
  if (resolvedThreads === null) resolvedThreads = Math.max(1, Math.floor(Math.max(cpu_count - 2, 1) / Math.max(resolvedJobs, 1)));
  const directory = output_dir !== null && output_dir !== undefined ? expanduser(output_dir)
    : opts.output_dir ? String(opts.output_dir) : path.join(root, ".decomp-workbench", "permute");
  return new SweepPlan({
    root, options: opts,
    output_dir: path.isAbsolute(directory) ? directory : path.join(root, directory),
    minutes: minutes || opts.minutes || 20,
    extend_minutes: Math.max(0, extend_minutes),
    threads: Math.max(1, resolvedThreads),
    jobs: Math.max(1, resolvedJobs),
    load_threshold: load_threshold === null || load_threshold === undefined ? (opts.load_threshold ?? 0.0) : load_threshold,
    extra: [...extra], check_fidelity, require_fidelity,
  });
}

// ---------------------------------------------------------------------------
// Scratch preparation
// ---------------------------------------------------------------------------

const readText = (p) => new TextDecoder("utf-8", { fatal: false }).decode(fs.readFileSync(p));
const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

/** Copy the target assembly beside the scratch, renaming its label if asked. */
export function prepareTargetAsm(root, item, outDir) {
  if (item.asm === null || item.asm === undefined) {
    throw new PermuterError(`${item.function}: the queue entry has no 'asm' target; the permuter needs the function's target assembly`);
  }
  const source = path.isAbsolute(item.asm) ? item.asm : path.join(root, item.asm);
  if (!isFile(source)) throw new PermuterError(`${item.function}: target assembly not found: ${source}`);
  let text = readText(source);
  if (item.asm_symbol) text = retargetLabels(text, { old: item.asm_symbol, new: item.function });
  const target = path.join(outDir, "target.s");
  fs.writeFileSync(target, text, "utf8");
  return target;
}

/** Run the importer, then take ownership of its output. */
export async function importScratch(plan, item, outDir, settings, targetAsm, { preserve_macros = null, log_name = "import.log", runner = runOwned } = {}) {
  const source = path.isAbsolute(item.source) ? item.source : path.join(plan.root, item.source);
  const imported = path.join(plan.root, "nonmatchings", item.function);
  if (fs.existsSync(imported)) fs.rmSync(imported, { recursive: true, force: true });
  const argv = [plan.interpreter, plan.tool(IMPORT_TOOL), source, targetAsm, "--settings", settings];
  if (preserve_macros !== null && preserve_macros !== undefined) argv.push("--preserve-macros", preserve_macros);
  const logPath = path.join(outDir, log_name);
  let completed;
  try {
    completed = await runner(argv, { cwd: plan.root, stdout: "pipe", stderr: "stdout", text: true, timeout: plan.step_timeout, check: false });
  } catch (e) {
    if (e?.name !== "TimeoutExpired") throw e;
    fs.writeFileSync(logPath, e.output || "", "utf8");
    throw new PermuterError(`${item.function}: ${IMPORT_TOOL} did not finish within ${formatG(plan.step_timeout)}s (permuter.step_timeout_seconds); see ${logPath}`);
  }
  fs.writeFileSync(logPath, completed.stdout || "", "utf8");
  if (completed.returncode !== 0 || !isDir(imported)) throw new PermuterError(`${item.function}: ${IMPORT_TOOL} failed; see ${logPath}`);
  const scratch = path.join(outDir, "scratch");
  if (fs.existsSync(scratch)) fs.rmSync(scratch, { recursive: true, force: true });
  try { fs.renameSync(imported, scratch); } catch (e) {
    if (e.code !== "EXDEV") throw e;
    fs.cpSync(imported, scratch, { recursive: true }); fs.rmSync(imported, { recursive: true, force: true });
  }
  return scratch;
}

// ---------------------------------------------------------------------------
// Scratch fidelity
// ---------------------------------------------------------------------------

/**
 * Turn an imported `base.c` into the source the permuter compiles: expand the
 * `#pragma _permuter` bookkeeping exactly as the permuter's process_pragmas
 * does, line for line, so the fidelity check compiles what the search will.
 */
export function expandPermuterPragmas(source) {
  source = source.split(" = FIXEDADDR(").join(" : (");
  if (!source.includes("#pragma")) return source;
  const prefix = "#pragma _permuter ";
  const out = [];
  let sameLine = 0, ignore = 0;
  for (const raw of source.split("\n")) {
    let line = raw;
    const stripped = line.trim();
    if (stripped.startsWith(prefix)) {
      line = "";
      const directive = stripped.slice(prefix.length);
      if (directive === "sameline start") sameLine += 1;
      else if (directive === "sameline end") sameLine -= 1;
      else if (directive === "latedefine start") ignore += 1;
      else if (directive === "latedefine end") ignore -= 1;
      else if (directive.startsWith("define ")) line = "#" + directive;
      else if (directive.startsWith("b64literal ")) line = Buffer.from(directive.split(" ").slice(1).join(" "), "base64").toString("utf8");
    } else if (ignore > 0) {
      line = "";
    }
    if (!sameLine) line += "\n";
    else if (line && out.length && !out[out.length - 1].endsWith("\n")) line = " " + line.replace(/^\s+/, "");
    out.push(line);
  }
  return out.join("").replace(/\s+$/, "") + "\n";
}

/**
 * Run a permuter scratch compile.sh (`compile.sh <in> -o <out>`) through
 * romdev's WASM toolchain: the `cd` and each command line, with "$INPUT"
 * and "$OUTPUT" bound, dispatched by recipe.js. Diagnostics go to `log`.
 */
export async function runCompileScriptWasm(script, input, output, log, timeoutSeconds = null) {
  const { runRecipeLine } = await import("../recipe.js");
  const { DECOMP_HOME } = await import("../project.js");
  const quote = (p) => `'${String(p).replace(/'/g, "'\\''")}'`;
  const lines = fs.readFileSync(script, "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  let cwd = path.dirname(script);
  const commands = [];
  for (const l of lines) {
    if (/^(set|export)\s/.test(l) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(l)) continue;
    const cd = /^cd\s+(.+)$/.exec(l);
    if (cd) { cwd = path.resolve(cwd, cd[1].replace(/^'(.*)'$/, "$1").replace(/^"(.*)"$/, "$1")); continue; }
    commands.push(l.split('"$INPUT"').join(quote(path.resolve(input))).split('"$OUTPUT"').join(quote(path.resolve(output))));
  }
  const tmpBase = path.join(DECOMP_HOME, ".workbench-tmp");
  fs.mkdirSync(tmpBase, { recursive: true });
  const tmpRoot = fs.mkdtempSync(path.join(tmpBase, "scratch-"));
  const started = Date.now();
  try {
    for (const c of commands) {
      if (timeoutSeconds !== null && timeoutSeconds !== undefined && (Date.now() - started) / 1000 > timeoutSeconds) {
        throw Object.assign(new Error("compile.sh timed out"), { name: "TimeoutExpired" });
      }
      const r = await runRecipeLine(c, { cwd, tmpRoot });
      fs.appendFileSync(log, r.log ?? "");
      if (r.unsupported) { fs.appendFileSync(log, `compile.sh step not supported by romdev's toolchain: ${r.unsupported}\n`); return { returncode: 127 }; }
      if (r.code !== 0) return { returncode: r.code };
    }
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
  return { returncode: 0 };
}

/** Compile the scratch's unmodified base through its own `compile.sh`. */
export async function compileScratchBase(plan, scratch, outDir, { runner = runOwned } = {}) {
  const base = path.join(scratch, "base.c");
  if (!isFile(base)) throw new PermuterError(`the scratch has no base.c at ${base}`);
  const script = path.join(scratch, "compile.sh");
  if (!isFile(script)) throw new PermuterError(`the scratch has no compile.sh at ${script}`);
  const source = path.join(outDir, "fidelity-base.c");
  fs.writeFileSync(source, expandPermuterPragmas(readText(base)), "utf8");
  const obj = path.join(outDir, "fidelity-base.o");
  if (fs.existsSync(obj)) fs.unlinkSync(obj);
  const log = path.join(outDir, "fidelity-compile.log");
  fs.writeFileSync(log, "");
  let completed;
  try {
    // The scratch's compile.sh is run the way the permuter runs it: its cd
    // and command lines through romdev's WASM toolchain, never a host shell
    // and compiler. An injected runner (tests) takes the script as given.
    completed = runner === runOwned
      ? await runCompileScriptWasm(script, source, obj, log, plan.step_timeout)
      : await runner([script, source, "-o", obj], { cwd: plan.root, stdout: { file: log }, stderr: "stdout", timeout: plan.step_timeout, check: false });
  } catch (e) {
    if (e?.name !== "TimeoutExpired") throw e;
    throw new PermuterError(`the scratch base did not compile within ${formatG(plan.step_timeout)}s (permuter.step_timeout_seconds); see ${log}`);
  }
  if (completed.returncode !== 0 || !isFile(obj)) throw new PermuterError(`the scratch base did not compile; see ${log}`);
  return obj;
}

/** Is this scratch's object the object the real build produces? */
export async function checkScratchFidelity(plan, item, scratch, outDir, { mode, preserved_macros = null, runner = runOwned, compare = compareObjects } = {}) {
  const obj = item.object || objectTarget(plan.options.object_template ?? "build/{source}.o", item.source);
  const real = path.isAbsolute(obj) ? obj : path.join(plan.root, obj);
  const unknown = (reason) => new ScratchFidelity({ status: FIDELITY_UNKNOWN, mode, object: obj, preserved_macros, reason });
  if (!isFile(real)) return unknown(`the project's object ${obj} is not built, so there is nothing to compare the scratch against; build it first`);
  let candidate;
  try { candidate = await compileScratchBase(plan, scratch, outDir, { runner }); } catch (e) {
    if (!(e instanceof PermuterError) && !isProcessError(e)) throw e;
    return unknown(errorText(e));
  }
  let comparison;
  try { comparison = compare(real, candidate, { objdump: plan.objdump, symbol: item.function, cwd: plan.root }); } catch (e) {
    if (!(e?.name === "ValueError" || e?.name === "RuntimeError" || isProcessError(e))) throw e;
    return unknown(`could not compare the two objects: ${e.message}`);
  }
  if (comparison.error) return unknown(comparison.error);
  let words = comparison.word_mismatches || Math.abs(comparison.instruction_delta);
  let status;
  if (comparison.exact && !words) { status = FIDELITY_IDENTICAL; words = 0; }
  else { status = FIDELITY_DIFFERS; words = words || comparison.raw_word_mismatches; }
  return new ScratchFidelity({ status, differing_words: words, mode, object: obj, preserved_macros });
}

export const UNCHECKED_FIDELITY = new ScratchFidelity();

const modeRank = (outcome) => [({ [FIDELITY_IDENTICAL]: 0, [FIDELITY_DIFFERS]: 1 })[outcome.fidelity.status] ?? 2, outcome.fidelity.differing_words || 0];

/** A mode name that is safe as a filename component. */
export function modeSlug(name) { return name.replace(/[^A-Za-z0-9_.-]+/g, "_") || "mode"; }

async function importOneMode(plan, item, outDir, recipe, mode, targetAsm, { single, runner }) {
  const options = plan.options;
  const logName = single ? "import.log" : `import-${modeSlug(mode.name)}.log`;
  const settings = path.join(outDir, single ? "permuter_settings.toml" : `permuter_settings-${modeSlug(mode.name)}.toml`);
  fs.writeFileSync(settings, renderSettings({
    compiler_command: options.compiler_command || "", assembler_command: options.assembler_command || "", flags: recipe.flags,
    compiler_type: options.compiler_type ?? "ido", preserve_macros: mode.macros, decompme_compiler: options.decompme_compiler ?? null,
  }), "utf8");
  const scratch = await importScratch(plan, item, outDir, settings, targetAsm, { preserve_macros: mode.regex, log_name: logName, runner });
  const obj = item.object || objectTarget(options.object_template ?? "build/{source}.o", item.source);
  const steps = retargetObjcopy(recipe.objcopy_steps, obj);
  appendCompileSteps(path.join(scratch, "compile.sh"), steps);
  fs.writeFileSync(path.join(outDir, "recipe.txt"), recipeReport(recipe, steps) + `import mode: ${mode.name}\n`, "utf8");
  const preserved = parsePreservedMacros(readText(path.join(outDir, logName)));
  return [scratch, steps, preserved];
}

/**
 * Build one function's scratch from the project's *real* recipe; when that
 * scratch is not the build's object and preserved macro stubs could be why,
 * retry with narrower, finally empty, preserved sets.
 * Resolves to {out_dir, scratch, recipe, steps, fidelity}.
 */
export async function prepareScratch(plan, item, { runner = runOwned, fidelity_checker = checkScratchFidelity } = {}) {
  const options = plan.options;
  if (!options.compiler_command) {
    throw new PermuterError("permuter.compiler_command is not configured: the scratch has no base compile line to attach the recovered codegen flags to");
  }
  const outDir = path.join(plan.output_dir, item.function);
  fs.mkdirSync(outDir, { recursive: true });
  const recipe = await recoverRecipe(plan.root, item, {
    make: options.make ?? "make", object_template: options.object_template ?? "build/{source}.o", compiler: options.compiler_marker ?? null,
    fallback_flags: options.fallback_flags ?? [], skip_postprocess: options.skip_postprocess ?? ["\\.py\\b"], runner, timeout: plan.step_timeout,
  });
  const targetAsm = prepareTargetAsm(plan.root, item, outDir);
  const modes = plan.check_fidelity ? plan.preserve_macro_modes : [];
  if (!modes.length) {
    const [scratch, steps] = await importOneMode(plan, item, outDir, recipe, new PreserveMacroMode("configured", [...(options.preserve_macros ?? [])], null), targetAsm, { single: true, runner });
    return { out_dir: outDir, scratch, recipe, steps, fidelity: UNCHECKED_FIDELITY };
  }
  const single = modes.length === 1;
  const attempts = [], outcomes = [];
  for (const mode of modes) {
    const [scratch, steps, preserved] = await importOneMode(plan, item, outDir, recipe, mode, targetAsm, { single, runner });
    const fidelity = await fidelity_checker(plan, item, scratch, outDir, { mode: mode.name, preserved_macros: preserved, runner });
    outcomes.push({ mode, fidelity, scratch, steps });
    attempts.push(new FidelityAttempt({ mode: mode.name, status: fidelity.status, differing_words: fidelity.differing_words,
      preserved_macros: fidelity.preserved_macros, reason: fidelity.reason }));
    if (fidelity.status === FIDELITY_IDENTICAL) break;
    if (!macroAttributable(new ScratchFidelity({ ...fidelity, attempts: [...attempts] }))) break;
  }
  let chosen = sorted(outcomes.map((o, i) => [o, i]), ([o, i]) => [modeRank(o), i])[0][0];
  if (chosen !== outcomes[outcomes.length - 1]) {
    const [scratch, steps] = await importOneMode(plan, item, outDir, recipe, chosen.mode, targetAsm, { single, runner });
    chosen = { ...chosen, scratch, steps };
  }
  return { out_dir: outDir, scratch: chosen.scratch, recipe, steps: chosen.steps,
    fidelity: new ScratchFidelity({ ...chosen.fidelity, attempts: [...attempts] }) };
}

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

const monotonic = () => performance.now() / 1000;
const wallClock = () => Date.now() / 1000;

/** Run one bounded search; resolves to [base score, elapsed seconds]. */
export async function runPermuter(plan, scratch, outDir, { seconds, log_name = "permuter.log", runner = runOwned, clock = monotonic } = {}) {
  const logPath = path.join(outDir, log_name);
  const argv = permuterArgv({ interpreter: plan.interpreter, permuter: plan.tool(SEARCH_TOOL), scratch, threads: plan.threads,
    extra: plan.extra, nice: plan.options.nice ?? 15 });
  const started = clock();
  fs.writeFileSync(logPath, "");
  try {
    await runner(argv, { cwd: plan.root, stdout: { file: logPath }, stderr: "stdout", timeout: seconds, check: false });
  } catch (e) { if (e?.name !== "TimeoutExpired") throw e; }
  const elapsed = clock() - started;
  return [parseBaseScore(readText(logPath)), elapsed];
}

function bestAge(bestDir, now) {
  if (bestDir === null) return null;
  try { return now() - fs.statSync(bestDir).mtimeMs / 1000; } catch { return null; }
}

/** Prepare, search and record one function. Never rejects into the batch. */
export async function searchFunction(plan, item, { runner = runOwned, clock = monotonic, now = wallClock, report = null, fidelity_checker = checkScratchFidelity, sleep } = {}) {
  const result = new SweepResult({ function: item.function, source: item.source });
  const started = clock();
  try {
    const { out_dir: outDir, scratch, recipe, steps, fidelity } = await prepareScratch(plan, item, { runner, fidelity_checker });
    result.flags = recipe.flags.join(" ") || null;
    result.flags_recovered = recipe.from_dry_run;
    result.replicated_objcopy = steps.length;
    result.skipped_postprocess = recipe.skipped_postprocess.length;
    result.warnings = [...recipe.warnings];
    result.scratch_fidelity = fidelity.status;
    result.scratch_fidelity_words = fidelity.differing_words;
    result.scratch_fidelity_mode = fidelity.mode;
    result.scratch_fidelity_reason = fidelity.reason;
    const scratchWarning = fidelityWarning(fidelity, item.function);
    if (scratchWarning !== null) result.warnings.push(scratchWarning);
    for (const w of result.warnings) if (report) report(`WARNING [${item.function}] ${w}`);
    if (plan.require_fidelity && fidelity.status !== FIDELITY_IDENTICAL) {
      throw new PermuterError(`--require-fidelity: the scratch for ${item.function} is ${fidelity.summary} against the project's own object`
        + (fidelity.reason ? ` (${fidelity.reason})` : ""));
    }
    await waitForHeadroom(plan.load_threshold, { label: `before permuting ${item.function}`, report, ...(sleep ? { sleep } : {}) });
    const [baseScore, elapsed] = await runPermuter(plan, scratch, outDir, { seconds: plan.minutes * 60.0, runner, clock });
    result.base_score = baseScore;
    result.ok = true;
    result.window_seconds = plan.minutes * 60.0;
    result.hit_cap = elapsed >= result.window_seconds * 0.95;
    let [bestDir, bestScore] = bestOutput(scratch);
    const age = bestAge(bestDir, now);
    result.best_output_mtime_fraction = outputFraction({ elapsed, best_age: age });
    if (shouldExtend({ elapsed, minutes: plan.minutes, best_score: bestScore, best_age: age, extend_minutes: plan.extend_minutes })) {
      result.extended = true;
      fs.copyFileSync(path.join(bestDir, "source.c"), path.join(scratch, "base.c"));
      await waitForHeadroom(plan.load_threshold, { label: `before extending ${item.function}`, report, ...(sleep ? { sleep } : {}) });
      const [, extra] = await runPermuter(plan, scratch, outDir, { seconds: plan.extend_minutes * 60.0, log_name: "permuter-extend.log", runner, clock });
      result.window_seconds += plan.extend_minutes * 60.0;
      result.hit_cap = extra >= plan.extend_minutes * 60.0 * 0.95;
      [bestDir, bestScore] = bestOutput(scratch);
      result.best_output_mtime_fraction = outputFraction({ elapsed: extra, best_age: bestAge(bestDir, now) });
    }
    result.best_score = bestScore;
    result.zero_found = bestScore === 0;
    result.output_dir = bestDir !== null ? bestDir : outDir;
  } catch (e) {
    if (!(e instanceof PermuterError || e?.name === "ValueError" || isProcessError(e))) throw e;
    result.error = errorText(e);
  }
  result.seconds = clock() - started;
  return result;
}

/** Search every queued function, recording after each one completes. */
export async function runSweep(plan, queue, { carried = [], runner = runOwned, report = null, on_result = null, fidelity_checker = checkScratchFidelity, sleep } = {}) {
  const results = [...carried];
  if (plan.jobs === 1) {
    for (const item of queue) {
      results.push(await searchFunction(plan, item, { runner, report, fidelity_checker, sleep }));
      if (on_result) on_result(results);
    }
    return results;
  }
  let next = 0;
  const worker = async () => {
    while (next < queue.length) {
      const item = queue[next++];
      const r = await searchFunction(plan, item, { runner, report, fidelity_checker, sleep });
      results.push(r);
      if (on_result) on_result(results);
    }
  };
  await Promise.all(Array.from({ length: Math.min(plan.jobs, queue.length) }, worker));
  return results;
}

// ---------------------------------------------------------------------------
// Doctor
// ---------------------------------------------------------------------------

/** The preflight one function owes before an hour is spent searching it. */
export class DoctorReport {
  constructor({ function: fn, source, object, flags = [], flags_recovered = false, objcopy_steps = [], skipped_postprocess = [], replicated = [],
    base_compiles = null, base_score = null, fidelity = new ScratchFidelity(), placeholder = null, warnings = [], problems = [] }) {
    Object.assign(this, { function: fn, source, object, flags, flags_recovered, objcopy_steps, skipped_postprocess, replicated,
      base_compiles, base_score, fidelity, placeholder, warnings, problems });
  }
  get ok() { return !this.problems.length; }
  asDict() {
    return {
      schema: DOCTOR_SCHEMA, function: this.function, source: this.source, object: this.object, flags: [...this.flags],
      flags_recovered: this.flags_recovered, objcopy_steps: [...this.objcopy_steps], replicated: [...this.replicated],
      skipped_postprocess: [...this.skipped_postprocess], base_compiles: this.base_compiles, base_score: this.base_score,
      scratch_fidelity: this.fidelity.asDict(), placeholder_calls: this.placeholder === null ? null : this.placeholder.asDict(),
      warnings: [...this.warnings], problems: [...this.problems], ok: this.ok,
    };
  }
}

const withReport = (report, changes) => new DoctorReport({ ...report, ...changes });

/** Answer the questions a sweep cannot recover from getting wrong. */
export async function doctor(plan, item, { seconds = 120, check_base = true, target_object = null, candidate_object = null, runner = runOwned, clock = monotonic, fidelity_checker = checkScratchFidelity } = {}) {
  const obj = item.object || objectTarget(plan.options.object_template ?? "build/{source}.o", item.source);
  const problems = [];
  let prepared;
  try { prepared = await prepareScratch(plan, item, { runner, fidelity_checker }); } catch (e) {
    if (!(e instanceof PermuterError || e?.name === "ValueError" || isProcessError(e))) throw e;
    return new DoctorReport({ function: item.function, source: item.source, object: obj, problems: [errorText(e)] });
  }
  const { out_dir: outDir, scratch, recipe, steps, fidelity } = prepared;
  const scratchWarnings = [];
  const note = fidelityWarning(fidelity, item.function);
  if (note !== null) (plan.require_fidelity ? problems : scratchWarnings).push(note);
  if (!recipe.from_dry_run) {
    problems.push(`codegen flags were not recovered from \`${plan.options.make ?? "make"} -n ${obj}\`; `
      + "the search would explore whatever the fallback names, which is not "
      + "necessarily the ISA the real build uses");
  }
  const finding = await placeholderFinding(item, { target_object, candidate_object });
  if (finding !== null && finding.blocked) scratchWarnings.push(finding.message);
  const report = new DoctorReport({ function: item.function, source: item.source, object: obj, flags: recipe.flags,
    flags_recovered: recipe.from_dry_run, objcopy_steps: recipe.objcopy_steps, skipped_postprocess: recipe.skipped_postprocess,
    replicated: steps, fidelity, placeholder: finding, warnings: [...recipe.warnings, ...scratchWarnings] });
  if (!check_base) return withReport(report, { problems });
  const [baseScore] = await runPermuter(plan, scratch, outDir, { seconds: Number(seconds), log_name: "doctor.log", runner, clock });
  const compiles = baseScore !== null;
  if (!compiles) problems.push(`the scratch base did not produce a score: it did not compile, or the permuter failed; read ${path.join(outDir, "doctor.log")}`);
  else if (baseScore === 0) problems.push("the base already scores 0, so this scratch is not scoring the function under test -- check the target assembly and the symbol");
  return withReport(report, { base_compiles: compiles, base_score: baseScore, problems });
}

/** Read the target's call relocations, when the host supplied an object. */
export async function placeholderFinding(item, { target_object = null, candidate_object = null } = {}) {
  if (target_object === null || target_object === undefined) return null;
  let target, candidate;
  try {
    target = readElf(target_object);
    candidate = candidate_object === null || candidate_object === undefined ? null : readElf(candidate_object);
  } catch (e) {
    if (e instanceof ElfFormatError || e?.name === "ValueError" || (typeof e?.code === "string" && /^E[A-Z]+$/.test(e.code))) return null;
    throw e;
  }
  const { placeholderCallCheck } = await import("./reloc-surface.js");
  return placeholderCallCheck(target, candidate, { function: item.asm_symbol || item.function });
}

export function renderDoctor(report) {
  const lines = [
    `permute-doctor ${report.function}`,
    `  source           ${report.source}`,
    `  object           ${report.object}`,
    `  codegen flags    ${report.flags.join(" ") || "(none)"} [${report.flags_recovered ? "make -n" : "FALLBACK"}]`,
  ];
  lines.push(`  objcopy steps    ${report.objcopy_steps.length}`);
  for (const s of report.replicated) lines.push(`    replicated     ${s}`);
  for (const s of report.skipped_postprocess) lines.push(`    skipped        ${s}`);
  lines.push(`  scratch object  ${report.fidelity.summary}` + (report.fidelity.mode ? ` [${report.fidelity.mode}]` : ""));
  if (report.fidelity.reason) lines.push(`    why           ${report.fidelity.reason}`);
  for (const a of report.fidelity.attempts) lines.push(`    mode          ${a.mode}: ${a.status}` + (a.differing_words ? ` (${a.differing_words} word(s))` : ""));
  if (report.placeholder !== null) {
    const f = report.placeholder;
    lines.push(`  target calls    ${f.call_sites} R_MIPS_26 site(s), ${f.unreproducible.length} unreproducible by this scratch`);
    if (f.blocked) lines.push("    oracle        the permuter score cannot reach zero here; use `decomp-workbench linked-compare`");
  }
  if (report.base_compiles === null) lines.push("  base            not checked (--no-base-check)");
  else lines.push(`  base            ${report.base_compiles ? "compiles" : "DOES NOT COMPILE"}, score ${report.base_score === null ? "None" : report.base_score}`);
  for (const w of report.warnings) lines.push(`  warning         ${w}`);
  for (const p of report.problems) lines.push(`  problem         ${p}`);
  lines.push("  verdict         " + (report.ok ? "ready" : "NOT READY"));
  return lines;
}

/** Write summary.json (json.dumps indent=2, keys in record order) and summary.txt. */
export function writeSummary(directory, payload, table) {
  fs.mkdirSync(directory, { recursive: true });
  const summaryJson = path.join(directory, "summary.json");
  const summaryTxt = path.join(directory, "summary.txt");
  fs.writeFileSync(summaryJson, pyIndentJson(payload) + "\n", "utf8");
  fs.writeFileSync(summaryTxt, table.join("\n") + "\n", "utf8");
  return [summaryJson, summaryTxt];
}

/** json.dumps(value, indent=2) without sorting: insertion order kept. */
export function pyIndentJson(value) { return dumps(value, { sortKeys: false }); }

export { ValueError };
