// preflight.js - no-candidate compiler wrapper and toolchain preflight: a
// disposable microcase is compiled through the user's template and its
// object must be readable by objdump before any candidate is spent.
//
// Plain JS ESM + JSDoc.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ValueError } from "./py.js";
import { DEFAULT_STREAM_LIMIT, captureStreams } from "./artifacts.js";
import { executableIdentity, fileSha256, renderCompileCommand, runCompiler, resolvePath, NotADirectoryError } from "./campaign.js";
import { dumpObject } from "./objdump.js";

export const PREFLIGHT_SOURCE = "int decomp_workbench_preflight(int value) {\n    return value + 1;\n}\n";

/** Compile a disposable microcase and verify that its object is readable. */
export async function compilePreflight(template, { compile_cwd, environment, timeout, objdump, section = ".text", stream_limit = DEFAULT_STREAM_LIMIT, artifact_dir = null }) {
  if (timeout <= 0) throw new ValueError("--timeout must be positive");
  const cwd = resolvePath(compile_cwd);
  let isDir = false; try { isDir = fs.statSync(cwd).isDirectory(); } catch { /* absent */ }
  if (!isDir) throw new NotADirectoryError(`compiler working directory does not exist: ${cwd}`);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "decomp-workbench-preflight-"));
  try {
    const source = path.join(root, "preflight.c"), output = path.join(root, "preflight.o");
    fs.writeFileSync(source, PREFLIGHT_SOURCE, "utf8");
    const command = renderCompileCommand(template, source, output);
    const started = performance.now();
    const common = (s) => ({ stdout: s.stdout, stderr: s.stderr, stdout_bytes: s.stdout_bytes, stderr_bytes: s.stderr_bytes,
      stdout_truncated: s.stdout_truncated, stderr_truncated: s.stderr_truncated, artifacts: s.artifacts });
    let proc;
    try { proc = await runCompiler(command, { environment, compile_cwd: cwd, timeout }); }
    catch (e) {
      if (e.kind !== "CompilerTimeoutError") throw e;
      const s = captureStreams(e.stdout, e.stderr, { limit: stream_limit, artifact_dir, stem: "doctor-preflight" });
      return { status: "timeout", ready: false, command, returncode: 124, duration_seconds: (performance.now() - started) / 1000, ...common(s),
        compiler: executableIdentity(command, { cwd }), working_directory: cwd, explicit_environment: environment, timeout_seconds: timeout };
    }
    const s = captureStreams(proc.stdout, proc.stderr, { limit: stream_limit, artifact_dir, stem: "doctor-preflight" });
    const isFile = (() => { try { return fs.statSync(output).isFile(); } catch { return false; } })();
    const report = { status: proc.returncode ? "failed" : "compiled", ready: false, command, returncode: proc.returncode,
      duration_seconds: (performance.now() - started) / 1000, ...common(s), compiler: executableIdentity(command, { cwd }), working_directory: cwd,
      explicit_environment: environment, timeout_seconds: timeout, object_created: isFile, object_bytes: isFile ? fs.statSync(output).size : 0,
      object_sha256: isFile ? fileSha256(output) : null };
    if (proc.returncode) return report;
    if (!isFile || fs.statSync(output).size === 0) { report.status = "missing-object"; return report; }
    let instructions;
    try { [, instructions] = dumpObject(output, { objdump, symbol: "decomp_workbench_preflight", section }); }
    catch (e) {
      if (!(e?.name === "ValueError" || e?.name === "RuntimeError" || e?.name === "OSError" || e?.name === "FileNotFoundError" || (e && typeof e.code === "string"))) throw e;
      report.status = "unreadable-object"; report.object_error = e.message; return report;
    }
    report.status = "ready"; report.ready = true; report.instructions = instructions.length;
    return report;
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
