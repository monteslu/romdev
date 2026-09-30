// pass-replay.js - safe retained-listing edits and IDO as0/as1/ugen pass
// replay. replay-as1 edits a retained ugen listing and reruns as0 then as1;
// replay-ugen replays a (retained or patched) Ucode stream through the stock
// ugen and as1 binaries with the argv shape a capture run recorded, and
// verifies the object against the capture's own.
//
// Every pass is an external program of the project's toolchain, run in its
// own process group with an explicit environment.
//
// Plain JS ESM + JSDoc.

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, realpathSync, utimesSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ValueError, strRepr } from "./py.js";
import { RuntimeError, FileNotFoundError } from "./py-extra.js";
import { DEFAULT_STREAM_LIMIT, captureStreams } from "./artifacts.js";
import { CompilerTimeoutError, NotADirectoryError, fileSha256, nicePrefix, runCompiler } from "./campaign.js";
import { splitCommand } from "./command-line.js";
import { compareObjectFidelity } from "./fidelity.js";

export const UGEN_REPLAY_SCHEMA = "decomp-workbench-replay-ugen-v1";

const expandUser = (p) => (p === "~" || p.startsWith("~/") ? os.homedir() + p.slice(1) : p);
/** Path.resolve(): absolute, following symlinks that exist. */
function resolved(p) {
  const abs = path.resolve(expandUser(String(p)));
  try { return realpathSync(abs); } catch {
    const parent = path.dirname(abs);
    return parent === abs ? abs : path.join(resolved(parent), path.basename(abs));
  }
}
const isFile = (p) => { try { return statSync(p).isFile(); } catch { return false; } };
const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };
/** shutil.copy2 (content and mtime). */
function copy2(src, dst) {
  const target = isDir(dst) ? path.join(dst, path.basename(src)) : dst;
  copyFileSync(src, target);
  const st = statSync(src);
  try { utimesSync(target, st.atime, st.mtime); } catch { /* best effort */ }
  return target;
}

/** One regex-addressed listing insertion. */
export class ListingEdit {
  constructor({ position, pattern, text }) { Object.assign(this, { position, pattern, text }); Object.freeze(this); }
}

/** Translate the original's regex spelling to a JS RegExp (named groups). */
function compilePattern(pattern) {
  try { return new RegExp(pattern.replace(/\(\?P</g, "(?<").replace(/\(\?P=(\w+)\)/g, "\\k<$1>"), "gm"); } catch (e) {
    throw Object.assign(new ValueError(e.message), { reError: true });
  }
}

/** Apply validated before/after insertions to a retained listing. */
export function applyListingEdits(source, edits, { allow_multiple = false } = {}) {
  let result = source;
  for (const edit of edits) {
    if (edit.position !== "before" && edit.position !== "after") throw new ValueError(`unsupported listing edit: ${edit.position}`);
    const expression = compilePattern(edit.pattern);
    const matches = [...result.matchAll(expression)];
    if (!matches.length) throw new ValueError(`listing pattern did not match: ${strRepr(edit.pattern)}`);
    if (matches.length !== 1 && !allow_multiple) {
      throw new ValueError(`listing pattern matched ${matches.length} times: ${strRepr(edit.pattern)}; narrow it or pass --allow-multiple`);
    }
    result = result.replace(expression, (matched) => {
      let line = edit.text;
      if (line && !line.endsWith("\n")) line += "\n";
      if (edit.position === "before") return line + matched;
      return matched + (matched.endsWith("\n") ? "" : "\n") + line;
    });
  }
  return result;
}

/** Render one pass command without a shell. */
export function renderStageCommand(template, { listing, binasm, symtab, output, stage }) {
  if (stage !== "as0" && stage !== "as1") throw new ValueError(`unsupported pass stage: ${strRepr(stage)}`);
  const values = { "{listing}": String(listing), "{binasm}": String(binasm), "{symtab}": String(symtab), "{object}": String(output) };
  const parts = splitCommand(template);
  const required = stage === "as0" ? ["{listing}", "{binasm}"] : ["{binasm}", "{object}"];
  for (const placeholder of required) {
    if (!parts.some((p) => p.includes(placeholder))) throw new ValueError(`${stage} command must contain ${placeholder}`);
  }
  return parts.map((part) => Object.entries(values).reduce((v, [o, n]) => v.split(o).join(n), part));
}

function tempDir(prefix, parent) {
  return mkdtempSync(path.join(parent ?? os.tmpdir(), prefix));
}

/**
 * Edit a retained ugen listing and rerun as0 followed by as1. Resolves the
 * ReplayResult fields as a plain object.
 */
export async function replayAs1(listing, output, { as0_template, as1_template, edits = null, allow_multiple = false, keep_work = null,
  calibration_object = null, objdump = null, work_root = null, compile_cwd = null, environment = null, timeout = 120.0,
  stream_limit = DEFAULT_STREAM_LIMIT, artifact_dir = null, objdump_env = process.env } = {}) {
  const listingPath = resolved(listing);
  const outputPath = resolved(output);
  if (outputPath === listingPath) throw new ValueError("listing and object output must be different paths");
  if (timeout <= 0) throw new ValueError("--timeout must be positive");
  if (edits && edits.length && (calibration_object === null || calibration_object === undefined)) {
    throw new ValueError("edited replay requires --calibration-object from the normal unedited pipeline");
  }
  const source = readFileSync(listingPath, "utf8");
  const edited = applyListingEdits(source, edits || [], { allow_multiple });
  const retainedPath = keep_work ? resolved(keep_work) : null;
  if (retainedPath) {
    mkdirSync(retainedPath, { recursive: true });
    if (resolved(path.join(retainedPath, "replay.s")) === listingPath) throw new ValueError("--keep-work would overwrite the input listing; choose another directory");
  }
  const cwd = compile_cwd ? resolved(compile_cwd) : resolved(process.cwd());
  if (!isDir(cwd)) throw new NotADirectoryError(`pass working directory does not exist: ${cwd}`);
  const workParent = work_root ? resolved(work_root) : null;
  if (workParent) mkdirSync(workParent, { recursive: true });
  let calibration = null;
  if (calibration_object !== null && calibration_object !== undefined && edits && edits.length) {
    const control = tempDir("decomp-workbench-pass-control-", workParent);
    try {
      const controlOutput = path.join(control, "control.o");
      await replayAs1(listingPath, controlOutput, { as0_template, as1_template, work_root: workParent, compile_cwd: cwd, environment, timeout, stream_limit });
      calibration = compareObjectFidelity(calibration_object, controlOutput, { objdump, env: objdump_env });
      if (!calibration.pass) throw new ValueError("unedited replay failed section-scoped calibration; edited evidence would be ambiguous");
    } finally { rmSync(control, { recursive: true, force: true }); }
  }
  const work = tempDir("decomp-workbench-pass-replay-", workParent);
  let as0, as1, as0Command, as1Command;
  try {
    const replayListing = path.join(work, "replay.s"), binasm = path.join(work, "replay.G"), symtab = path.join(work, "replay.T"), temporaryObject = path.join(work, "replay.o");
    writeFileSync(replayListing, edited, "utf8");
    as0Command = renderStageCommand(as0_template, { listing: replayListing, binasm, symtab, output: temporaryObject, stage: "as0" });
    try { as0 = await runCompiler(as0Command, { environment: environment || {}, compile_cwd: cwd, timeout }); } catch (e) {
      if (e instanceof CompilerTimeoutError) throw new RuntimeError(`as0 ${e.message}`);
      throw e;
    }
    if (as0.returncode) throw new RuntimeError(`as0 failed (${as0.returncode}): ${as0.stderr.trim() || as0.stdout.trim()}`);
    if (!isFile(binasm)) throw new RuntimeError(`as0 succeeded but did not create ${binasm}`);
    as1Command = renderStageCommand(as1_template, { listing: replayListing, binasm, symtab, output: temporaryObject, stage: "as1" });
    try { as1 = await runCompiler(as1Command, { environment: environment || {}, compile_cwd: cwd, timeout }); } catch (e) {
      if (e instanceof CompilerTimeoutError) throw new RuntimeError(`as1 ${e.message}`);
      throw e;
    }
    if (as1.returncode) throw new RuntimeError(`as1 failed (${as1.returncode}): ${as1.stderr.trim() || as1.stdout.trim()}`);
    if (!isFile(temporaryObject)) throw new RuntimeError(`as1 succeeded but did not create ${temporaryObject}`);
    mkdirSync(path.dirname(outputPath), { recursive: true });
    copy2(temporaryObject, outputPath);
    if (retainedPath) for (const p of [replayListing, binasm, symtab, temporaryObject]) if (existsSync(p)) copy2(p, path.join(retainedPath, path.basename(p)));
  } finally { rmSync(work, { recursive: true, force: true }); }
  const s0 = captureStreams(as0.stdout, as0.stderr, { limit: stream_limit, artifact_dir, stem: "replay-as0" });
  const s1 = captureStreams(as1.stdout, as1.stderr, { limit: stream_limit, artifact_dir, stem: "replay-as1" });
  const meta = (s) => ({ stdout_bytes: s.stdout_bytes, stderr_bytes: s.stderr_bytes, stdout_truncated: s.stdout_truncated, stderr_truncated: s.stderr_truncated, artifacts: s.artifacts });
  return {
    as0_command: as0Command, as1_command: as1Command, as0_stdout: s0.stdout, as0_stderr: s0.stderr, as1_stdout: s1.stdout, as1_stderr: s1.stderr,
    output: outputPath, retained_directory: retainedPath, calibration, streams: { as0: meta(s0), as1: meta(s1) },
  };
}

// CapturedArgv access that does not depend on how its role table is stored.
function role(argv, name) {
  const roles = argv.roles;
  const entry = roles instanceof Map ? roles.get(name) : roles?.[name];
  return entry ?? null;
}
const roleIndex = (argv, name) => role(argv, name)?.[0] ?? null;
const roleValue = (argv, name) => role(argv, name)?.[1] ?? null;
const fileFor = (run, which, index) => (typeof run.fileFor === "function" ? run.fileFor(which, index) : run.file_for(which, index));

/** Rewrite one captured argv, keeping every flag in its original place. */
export function rebuildArgv(run, { input_path, replacements }) {
  const byIndex = new Map();
  for (const [index] of run.argv.inputs) { byIndex.set(index, String(input_path)); break; }
  for (const [name, p] of Object.entries(replacements)) {
    const i = roleIndex(run.argv, name);
    if (i !== null) byIndex.set(i, String(p));
  }
  const argv = run.argv.argv.map((value, i) => byIndex.get(i + 1) ?? value);
  if (!run.argv.inputs.length) argv.push(String(input_path));
  for (const [name, option] of [["output", "-o"], ["symtab", "-t"], ["temp", "-temp"]]) {
    if (name in replacements && roleIndex(run.argv, name) === null) argv.push(option, String(replacements[name]));
  }
  return argv;
}

/** The phase environment: the host's, plus capture suppressed. */
export function replayEnvironment(overrides, host = process.env) {
  return { ...host, WORKBENCH_CAPTURE_OFF: "1", ...(overrides || {}) };
}

async function runPhase(phase, command, { environment, compile_cwd, timeout, stream_limit, artifact_dir, stem, produces, host }) {
  let result;
  try { result = await runCompiler(command, { environment: replayEnvironment(environment, host), compile_cwd, timeout }); } catch (e) {
    if (e instanceof CompilerTimeoutError) throw new RuntimeError(`${phase} ${e.message}`);
    throw e;
  }
  const streams = captureStreams(result.stdout, result.stderr, { limit: stream_limit, artifact_dir, stem });
  if (result.returncode) throw new RuntimeError(`${phase} failed (${result.returncode}): ${result.stderr.trim() || result.stdout.trim()}`);
  if (!isFile(produces)) throw new RuntimeError(`${phase} succeeded but did not create ${produces}`);
  return { returncode: result.returncode, stdout: streams.stdout, stderr: streams.stderr };
}

/** Replay one Ucode stream through stock ugen and as1 using captured argv. */
export async function replayUgen(ucode, { toolchain, argv_from, output = null, as1_argv_from = null, expect = null, run_as1 = true, keep_work = null,
  work_root = null, compile_cwd = null, environment = null, timeout = 300.0, nice = 10, objdump = null, stream_limit = DEFAULT_STREAM_LIMIT,
  artifact_dir = null, host = process.env } = {}) {
  const { readCaptureRun, findCaptureRun, stockPhaseBinary } = await import("./capture.js");
  const stream = resolved(ucode);
  if (!isFile(stream)) throw new FileNotFoundError(`Ucode stream does not exist: ${stream}`);
  if (timeout <= 0) throw new ValueError("--timeout must be positive");
  const ugenRun = readCaptureRun(argv_from);
  if (ugenRun.phase !== "ugen" && ugenRun.phase !== "unknown") {
    throw new ValueError(`${ugenRun.directory} is a ${ugenRun.phase} run; --argv-from wants the ugen run whose argv shape to reuse`);
  }
  const ugenBinary = stockPhaseBinary(toolchain, "ugen");
  let as1Run = null, as1Discovery = "not requested";
  if (run_as1) {
    if (as1_argv_from !== null && as1_argv_from !== undefined) { as1Run = readCaptureRun(as1_argv_from); as1Discovery = "explicit --as1-argv-from"; }
    else {
      const binasmName = roleValue(ugenRun.argv, "output");
      as1Run = findCaptureRun(path.dirname(String(ugenRun.directory)), { phase: "as1", input_name: binasmName ? path.basename(binasmName) : null });
      as1Discovery = as1Run ? "matched the as1 run whose positional input is this ugen run's -o file" : "no as1 run consumed this ugen run's output";
    }
    if (!as1Run) throw new ValueError("no as1 capture run consumes this ugen run's output; pass --as1-argv-from <run-dir>, or --skip-as1 to stop at Binasm");
  }
  const as1Binary = run_as1 ? stockPhaseBinary(toolchain, "as1") : null;
  const workParent = work_root ? resolved(work_root) : null;
  if (workParent) mkdirSync(workParent, { recursive: true });
  const cwd = compile_cwd ? resolved(compile_cwd) : resolved(process.cwd());
  if (!isDir(cwd)) throw new NotADirectoryError(`pass working directory does not exist: ${cwd}`);
  const retained = keep_work ? resolved(keep_work) : null;
  if (retained) mkdirSync(retained, { recursive: true });
  const report = {
    schema: UGEN_REPLAY_SCHEMA,
    ucode: { path: stream, bytes: statSync(stream).size, sha256: fileSha256(stream) },
    toolchain: resolved(toolchain),
    ugen_binary: String(ugenBinary),
    as1_binary: as1Binary ? String(as1Binary) : null,
    argv_source: { ugen_run: String(ugenRun.directory), as1_run: as1Run ? String(as1Run.directory) : null, as1_discovery: as1Discovery },
  };
  const work = tempDir("decomp-workbench-replay-ugen-", workParent);
  try {
    const binasm = path.join(work, "replay.G"), symtab = path.join(work, "replay.T"), ugenTemp = path.join(work, "replay.temp"), listing = path.join(work, "replay.s");
    // ugen mutates the symbol table in place and as1 reads what ugen left:
    // start from the entry copy the wrapper retained, hand it to both.
    const symtabIndex = roleIndex(ugenRun.argv, "symtab");
    const seed = symtabIndex !== null ? fileFor(ugenRun, "before", symtabIndex) : null;
    if (seed) { copy2(String(seed.path), symtab); report.symtab_seed = String(seed.path); }
    else {
      writeFileSync(symtab, Buffer.alloc(0));
      report.symtab_seed = null;
      (report.warnings ??= []).push("the ugen run retained no entry symbol table; replaying with an empty one, which is only right for a self-contained stream");
    }
    const replacements = { output: binasm, symtab, temp: ugenTemp };
    if (roleIndex(ugenRun.argv, "listing") !== null) replacements.listing = listing;
    const ugenCommand = [...nicePrefix(nice), String(ugenBinary), ...rebuildArgv(ugenRun, { input_path: stream, replacements })];
    report.ugen_command = ugenCommand;
    const common = { environment, compile_cwd: cwd, timeout, stream_limit, artifact_dir, host };
    report.ugen = await runPhase("ugen", ugenCommand, { ...common, stem: "replay-ugen", produces: binasm });
    report.binasm = { bytes: statSync(binasm).size, sha256: fileSha256(binasm) };
    const objectPath = output !== null && output !== undefined ? resolved(output) : null;
    if (run_as1 && as1Run && as1Binary) {
      const replayObject = path.join(work, "replay.o");
      const as1Command = [...nicePrefix(nice), String(as1Binary), ...rebuildArgv(as1Run, { input_path: binasm, replacements: { output: replayObject, symtab } })];
      report.as1_command = as1Command;
      report.as1 = await runPhase("as1", as1Command, { ...common, stem: "replay-as1", produces: replayObject });
      report.object = { bytes: statSync(replayObject).size, sha256: fileSha256(replayObject) };
      report.verification = verifyReplayObject(replayObject, { as1_run: as1Run, expect, objdump, env: host });
      if (objectPath !== null) {
        mkdirSync(path.dirname(objectPath), { recursive: true });
        copy2(replayObject, objectPath);
        report.object.path = objectPath;
      }
    } else if (objectPath !== null) {
      mkdirSync(path.dirname(objectPath), { recursive: true });
      copy2(binasm, objectPath);
      report.binasm.path = objectPath;
    }
    if (retained) {
      for (const p of [stream, binasm, symtab, ugenTemp, listing]) {
        if (existsSync(p) && path.dirname(p) !== retained) copy2(p, path.join(retained, path.basename(p)));
      }
      report.retained_directory = retained;
    }
  } finally { rmSync(work, { recursive: true, force: true }); }
  report.proof = "Stock ugen and as1 ran on a retained stream with the captured argv "
    + "shape. Reproducing the capture's object byte for byte establishes the "
    + "replay itself is faithful; a patched variant's object difference is "
    + "then attributable to the patch, and to no C spelling.";
  return report;
}

/** Compare the replayed object with the capture's own object, if retained. */
function verifyReplayObject(replayed, { as1_run, expect, objdump, env }) {
  let reference = null, source = "none";
  if (expect !== null && expect !== undefined) { reference = resolved(expect); source = "--expect"; }
  else {
    const outputIndex = roleIndex(as1_run.argv, "output");
    const kept = outputIndex !== null ? fileFor(as1_run, "after", outputIndex) : null;
    if (kept) { reference = String(kept.path); source = "as1 capture run's retained output object"; }
  }
  if (reference === null || !isFile(reference)) {
    return { reference: null, reference_source: source, byte_identical: null,
      verdict: "not verified: no reference object. Re-run the capture so the as1 run retains its -o file, or pass --expect." };
  }
  const replayedHash = fileSha256(replayed), referenceHash = fileSha256(reference);
  const identical = replayedHash === referenceHash;
  const result = { reference, reference_source: source, reference_sha256: referenceHash, replayed_sha256: replayedHash, byte_identical: identical,
    verdict: identical ? "replay reproduces the reference object byte for byte" : "replay differs from the reference object" };
  if (!identical) {
    try { result.fidelity = compareObjectFidelity(reference, replayed, { objdump, env }); } catch (e) { result.fidelity_error = e.message; }
  }
  return result;
}
