// pass-adapter.js - the user-supplied original/static pass differential: run
// one retained pass boundary through an explicit original command and a
// static-recompilation command, retain both outputs and their hashes in a
// project-visible directory, and optionally run the same downstream stage.
//
// Plain JS ESM + JSDoc.

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ValueError } from "./py.js";
import { RuntimeError, FileNotFoundError } from "./py-extra.js";
import { DEFAULT_STREAM_LIMIT, captureStreams } from "./artifacts.js";
import { CompilerTimeoutError, NotADirectoryError, executableIdentity, fileSha256, runCompiler } from "./campaign.js";
import { splitCommand } from "./command-line.js";

export const PASS_DIFF_SCHEMA = "decomp-workbench-original-pass-diff-v1";

const expandUser = (p) => (p === "~" || p.startsWith("~/") ? os.homedir() + p.slice(1) : p);
function resolved(p) {
  const abs = path.resolve(expandUser(String(p)));
  try { return realpathSync(abs); } catch {
    const parent = path.dirname(abs);
    return parent === abs ? abs : path.join(resolved(parent), path.basename(abs));
  }
}
const isFile = (p) => { try { return statSync(p).isFile(); } catch { return false; } };
const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };

/** Render an external pass without a shell or implicit mounts. */
export function renderPassCommand(template, { input_path, output_path, work_path }) {
  const parts = splitCommand(template);
  for (const placeholder of ["{input}", "{output}"]) {
    if (!parts.some((p) => p.includes(placeholder))) throw new ValueError(`pass command must contain ${placeholder}`);
  }
  const replacements = [["{input}", String(input_path)], ["{output}", String(output_path)], ["{work}", String(work_path)]];
  return parts.map((part) => replacements.reduce((v, [o, n]) => v.split(o).join(n), part));
}

function normalizedHash(file, { work }) {
  let data = readFileSync(file).toString("latin1").split("\r\n").join("\n");
  let real;
  try { real = realpathSync(work); } catch { real = work; }
  for (const spelling of new Set([String(work), real])) data = data.split(Buffer.from(spelling, "utf8").toString("latin1")).join("{WORK}");
  return createHash("sha256").update(Buffer.from(data, "latin1")).digest("hex");
}

async function runStage(name, command, { cwd, timeout, stream_limit, artifact_dir }) {
  const started = performance.now();
  let returncode, stdout, stderr;
  try {
    const p = await runCompiler(command, { environment: {}, compile_cwd: cwd, timeout });
    ({ returncode, stdout, stderr } = p);
  } catch (e) {
    if (!(e instanceof CompilerTimeoutError)) throw e;
    returncode = 124; stdout = e.stdout; stderr = `${e.stderr}\n${e.message}`.trim();
  }
  const s = captureStreams(stdout, stderr, { limit: stream_limit, artifact_dir, stem: name });
  return {
    command, executable: executableIdentity(command, { cwd }), returncode, duration_seconds: (performance.now() - started) / 1000,
    stdout: s.stdout, stderr: s.stderr, stdout_bytes: s.stdout_bytes, stderr_bytes: s.stderr_bytes,
    stdout_truncated: s.stdout_truncated, stderr_truncated: s.stderr_truncated, artifacts: s.artifacts,
  };
}

/** Run one retained boundary through original and static passes. */
export async function runPassDifferential(inputPath, { original_template, static_template, boundary, work_root, compile_cwd, timeout = 120.0, stream_limit = DEFAULT_STREAM_LIMIT, downstream_template = null }) {
  if (timeout <= 0) throw new ValueError("--timeout must be positive");
  const source = resolved(inputPath);
  if (!isFile(source)) throw new FileNotFoundError(`pass input does not exist: ${source}`);
  const cwd = resolved(compile_cwd);
  if (!isDir(cwd)) throw new NotADirectoryError(`pass working directory does not exist: ${cwd}`);
  const root = resolved(work_root);
  mkdirSync(root, { recursive: true });
  const runDir = mkdtempSync(path.join(root, `${boundary}-`));
  const originalOutput = path.join(runDir, "original.out"), staticOutput = path.join(runDir, "static.out");
  const streams = path.join(runDir, "streams");
  const stage = (name, cmd) => runStage(name, cmd, { cwd, timeout, stream_limit, artifact_dir: streams });
  const original = await stage("original", renderPassCommand(original_template, { input_path: source, output_path: originalOutput, work_path: runDir }));
  const stat = await stage("static", renderPassCommand(static_template, { input_path: source, output_path: staticOutput, work_path: runDir }));
  for (const [name, st, out] of [["original", original, originalOutput], ["static", stat, staticOutput]]) {
    if (st.returncode) throw new RuntimeError(`${name} pass failed with exit ${st.returncode}: ${String(st.stderr).trim() || "no diagnostic"}`);
    if (!isFile(out)) throw new RuntimeError(`${name} pass did not create ${out}`);
  }
  let downstream = null;
  if (downstream_template) {
    const originalFinal = path.join(runDir, "original.downstream"), staticFinal = path.join(runDir, "static.downstream");
    const od = await stage("original-downstream", renderPassCommand(downstream_template, { input_path: originalOutput, output_path: originalFinal, work_path: runDir }));
    const sd = await stage("static-downstream", renderPassCommand(downstream_template, { input_path: staticOutput, output_path: staticFinal, work_path: runDir }));
    for (const [name, st, out] of [["original downstream", od, originalFinal], ["static downstream", sd, staticFinal]]) {
      if (st.returncode || !isFile(out)) throw new RuntimeError(`${name} failed or did not produce its output (exit ${st.returncode})`);
    }
    downstream = { original: od, static: sd, original_sha256: fileSha256(originalFinal), static_sha256: fileSha256(staticFinal),
      identical: readFileSync(originalFinal).equals(readFileSync(staticFinal)) };
  }
  return {
    schema: PASS_DIFF_SCHEMA, boundary, work_directory: runDir, input: source, input_sha256: fileSha256(source),
    original: { ...original, output: originalOutput, output_sha256: fileSha256(originalOutput), normalized_sha256: normalizedHash(originalOutput, { work: runDir }) },
    static: { ...stat, output: staticOutput, output_sha256: fileSha256(staticOutput), normalized_sha256: normalizedHash(staticOutput, { work: runDir }) },
    byte_identical: readFileSync(originalOutput).equals(readFileSync(staticOutput)),
    normalized_identical: normalizedHash(originalOutput, { work: runDir }) === normalizedHash(staticOutput, { work: runDir }),
    downstream,
    proof: "One user-supplied pass boundary differential. Instrumentation and source conclusions require disabled-instrumentation and unedited-replay calibration plus downstream/collateral gates.",
  };
}
