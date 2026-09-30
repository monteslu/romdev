// compiler.js - decomp-permuter's src/compiler.py: compile a candidate with
// the directory's compile.sh, keeping upstream's contract exactly:
//
//     bash compile.sh <input.c> -o <output.o>
//
// exit status 0 = the object exists and should be scored; anything else is a
// failed compile (score = PENALTY_INF). A caller may instead supply an
// in-process compile function with the same contract.
import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync, rmSync, copyFileSync, existsSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

let bashPath = null;
/** shutil.which("bash") */
function findBash() {
  if (bashPath) return bashPath;
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    const p = path.join(dir, "bash");
    if (dir && existsSync(p)) { bashPath = p; return p; }
  }
  throw new Error("No `bash` executable was found on PATH. Install bash and make sure it's on PATH.");
}

export function tryRemove(p) {
  try { rmSync(p, { force: true }); } catch { /* ignore */ }
}

export class Compiler {
  /**
   * @param {string|null} compile_cmd path to compile.sh (passed to `compileFn` as its third argument when given)
   * @param {{show_errors?: boolean, debug_mode?: boolean, tmpDir: string, compileFn?: ((cPath: string, oPath: string) => Promise<boolean>)|null, timeoutMs?: number, log?: (s: string) => void}} opts
   */
  constructor(compile_cmd, { show_errors = false, debug_mode = false, tmpDir, compileFn = null, timeoutMs = 0, log = (s) => process.stderr.write(s) }) {
    this.compile_cmd = compile_cmd;
    this.show_errors = show_errors;
    this.debug_mode = debug_mode;
    this.tmpDir = tmpDir;
    this.compileFn = compileFn;
    this.timeoutMs = timeoutMs;
    this.log = log;
    if (!compileFn) this._bash = findBash();
    mkdirSync(tmpDir, { recursive: true });
  }

  /**
   * Try to compile a piece of C code. Returns the path of the resulting .o
   * (the caller removes it), or null on failure.
   * @param {string} source
   * @returns {Promise<string|null>}
   */
  async compile(source, { show_errors = false } = {}) {
    show_errors = show_errors || this.show_errors || this.debug_mode;
    const tag = randomBytes(6).toString("hex");
    const c_name = path.join(this.tmpDir, `permuter${tag}.c`);
    const o_name = path.join(this.tmpDir, `permuter${tag}.o`);
    writeFileSync(c_name, source);
    if (this.debug_mode) {
      this.log("DEBUG MODE: Saving a full copy of base candidate source to ./debug_source.c\n");
      writeFileSync("./debug_source.c", source);
    }
    let ok;
    let output = "";
    try {
      if (this.compileFn) {
        ok = await this.compileFn(c_name, o_name, this.compile_cmd);
      } else {
        const r = await runProcess(this._bash, [this.compile_cmd, c_name, "-o", o_name], this.timeoutMs);
        ok = r.code === 0;
        output = r.output;
      }
    } catch (e) {
      ok = false;
      output = String(e?.message ?? e);
    }
    if (!ok) {
      if (show_errors && output) this.log(output);
      if (!show_errors) tryRemove(c_name);
      tryRemove(o_name);
      return null;
    }
    if (this.debug_mode) {
      this.log("DEBUG MODE: Saving the base candidate o file to ./debug_compiled_object.o\n\n");
      copyFileSync(o_name, "./debug_compiled_object.o");
    }
    tryRemove(c_name);
    return o_name;
  }
}

function runProcess(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (d) => { output += d; });
    child.stderr.on("data", (d) => { output += d; });
    let timer = null;
    if (timeoutMs > 0) timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } }, timeoutMs);
    child.on("error", (e) => { if (timer) clearTimeout(timer); resolve({ code: -1, output: output + String(e.message) }); });
    child.on("close", (code) => { if (timer) clearTimeout(timer); resolve({ code: code ?? -1, output }); });
  });
}
