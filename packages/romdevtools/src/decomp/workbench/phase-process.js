// phase-process.js - running one stock compiler pass (ugen, as0, as1, the
// project's objdump) the way the pass-replay and fidelity commands need it:
// its own process group, a complete environment, a deadline that ends the
// pass and everything it started, and the identity (resolved path + hash) of
// the executable that ran.
//
// Plain JS ESM + JSDoc.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, statSync, realpathSync, accessSync, constants as fsConstants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { formatG } from "./globalcolor.js";

export const TERMINATE_GRACE_SECONDS = 2.0;

/** A pass exceeded its deadline after its whole process group ended. */
export class CompilerTimeoutError extends Error {
  constructor(command, timeout, { stdout = "", stderr = "" } = {}) {
    super(`compiler exceeded --timeout=${formatG(timeout)} seconds`);
    this.name = "RuntimeError";
    Object.assign(this, { command, timeout, stdout, stderr });
  }
}

/** Hash one file. */
export function fileSha256(p) { return createHash("sha256").update(readFileSync(p)).digest("hex"); }

/** shutil.which(): the first executable of that name on PATH, or null. */
export function which(name, env = process.env) {
  if (name.includes("/")) { try { return statSync(name).isFile() ? name : null; } catch { return null; } }
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, name);
    try { if (statSync(p).isFile()) { accessSync(p, fsConstants.X_OK); return p; } } catch { /* next */ }
  }
  return null;
}

const isFile = (p) => { try { return statSync(p).isFile(); } catch { return false; } };

/** The directly invoked program: requested name, resolved path, content hash. */
export function executableIdentity(command, { cwd = null } = {}) {
  const executable = command[0];
  const discovered = which(executable);
  let resolved = null;
  if (discovered !== null) {
    try { resolved = realpathSync(path.resolve(discovered.replace(/^~(?=\/|$)/, os.homedir()))); } catch { resolved = path.resolve(discovered); }
  } else {
    let p = executable.replace(/^~(?=\/|$)/, os.homedir());
    if (!path.isAbsolute(p) && cwd !== null) p = path.join(cwd, p);
    if (isFile(p)) { try { resolved = realpathSync(p); } catch { resolved = path.resolve(p); } }
  }
  return { requested: executable, resolved, sha256: resolved ? fileSha256(resolved) : null };
}

/** The `nice` prefix for a background pass, or nothing. */
export function nicePrefix(level) {
  if (level === null || level === undefined || level <= 0 || process.platform === "win32") return [];
  const exe = which("nice");
  return exe ? [exe, "-n", String(level)] : [];
}

/**
 * Run one pass as the owner of its own process group. `environment` is the
 * complete environment (not an overlay). Resolves {returncode, stdout, stderr};
 * rejects with CompilerTimeoutError on the deadline and with the spawn error
 * (an OSError) when the program cannot start.
 */
export function runCompiler(command, { environment, compile_cwd, timeout = null }) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command[0], command.slice(1), { cwd: compile_cwd, env: environment, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) { reject(e); return; }
    const out = [], err = [];
    let timedOut = false, settled = false;
    child.stdout.on("data", (d) => out.push(d));
    child.stderr.on("data", (d) => err.push(d));
    const group = (sig) => { try { process.kill(-child.pid, sig); return true; } catch { try { child.kill(sig); } catch { /* gone */ } return false; } };
    const timer = timeout !== null && timeout !== undefined ? setTimeout(() => {
      timedOut = true;
      group("SIGTERM");
      setTimeout(() => group("SIGKILL"), TERMINATE_GRACE_SECONDS * 1000).unref();
    }, timeout * 1000) : null;
    child.on("error", (e) => { if (settled) return; settled = true; if (timer) clearTimeout(timer); reject(e); });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      const stdout = new TextDecoder("utf-8").decode(Buffer.concat(out));
      const stderr = new TextDecoder("utf-8").decode(Buffer.concat(err));
      if (timedOut) { reject(new CompilerTimeoutError(command, timeout ?? 0, { stdout, stderr })); return; }
      resolve({ args: command, returncode: code ?? (signal ? -(os.constants.signals[signal] ?? 1) : 1), stdout, stderr });
    });
  });
}
