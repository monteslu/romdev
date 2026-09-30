// proc.js - the one way a workbench command runs another program.
//
// A compiler, assembler, preprocessor, objdump/objcopy/ld, asm-processor or
// any IDO pass runs through romdev's WASM/JS toolchain (src/decomp/recipe.js,
// src/decomp/toolchain.js), never as a host binary. A program romdev has no
// WASM/JS equivalent for that is a compiler or build driver (gcc, clang, cc,
// make, an interpreter) is refused with exit 127 and a message naming it.
// Anything else - node scripts, the project's own wrapper scripts, git - runs
// as given.
//
// Commands that were synchronous stay synchronous: the WASM tool runs in a
// short-lived node child (proc-child.js) and this module waits for it.
//
// Plain JS ESM + JSDoc.

import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { statSync, openSync, readSync, closeSync } from "node:fs";
import { classifyCommand, parseShell } from "../recipe.js";
import { toolName } from "../toolchain.js";

const CHILD = fileURLToPath(new URL("./proc-child.js", import.meta.url));

/** Recipe kinds that run as WASM/JS. */
const ROUTED = new Set(["ido", "binutils", "asm-processor", "set-o32abi-bit", "cpp", "syntax-check", "iconv", "n64crc", "sha1sum", "armips", "python-port"]);

/** Program names that are host compilers or build drivers romdev never runs. */
const HOST_TOOLCHAIN = /(^|[-/])(gcc|g\+\+|cc|c\+\+|clang|clang\+\+|cpp|make|gmake|python[0-9.]*|pypy[0-9.]*|pip[0-9]*|ld|as|objdump|objcopy)$/;

/**
 * How a program would run.
 * @returns {{mode:'wasm'|'line'|'host'|'refuse', kind?:string, reason?:string}}
 */
export function routeFor(argv, cwd = process.cwd()) {
  const prog = argv[0] ?? "";
  if ((prog === "/bin/sh" || prog === "sh" || prog === "bash" || prog === "/bin/bash") && argv[1] === "-c") return lineRoute(argv[2] ?? "", cwd);
  // `make -n`: romdev's own Makefile reader prints the recipe (proc-child.js);
  // it must never reach the build runner, which would build the target.
  if (/^g?make$/.test(path.basename(prog)) && argv.some((a) => a === "-n" || a === "--dry-run" || a === "--just-print" || a === "--recon") && !isScript(resolveProgram(prog, cwd))) return { mode: "make-n" };
  const t = toolName(prog);
  if (t?.kind === "ido" || t?.kind === "binutils") return { mode: "wasm", kind: t.kind };
  const cls = classifyCommand(argv, cwd);
  if (ROUTED.has(cls.kind) || (cls.kind !== "unsupported" && cls.kind !== "fs" && cls.kind !== "print" && cls.kind !== "noop" && cls.kind !== "false")) {
    return { mode: "wasm", kind: cls.kind };
  }
  const base = path.basename(prog);
  // A script standing in for a tool (a test double, a project wrapper) runs
  // as given; a host compiler or build-driver BINARY never does.
  if (HOST_TOOLCHAIN.test(base) && !/\.(m?js|cjs)$/.test(base) && !isScript(resolveProgram(prog, cwd))) {
    return { mode: "refuse", reason: `no WASM/JS equivalent for '${prog}'; romdev runs compilers and build tools only through its WASM toolchain` };
  }
  return { mode: "host" };
}

/**
 * A shell line runs through the recipe runner when every program in it has a
 * WASM/JS form; a line of the project's own scripts runs in the host shell;
 * a line that names a host compiler, or mixes one with host scripts, is
 * refused.
 */
function lineRoute(line, cwd) {
  let parsed;
  try { parsed = parseShell(line); } catch { return { mode: "host" }; }
  const routes = parsed.flatMap(({ pipeline }) => pipeline.map((cmd) => routeFor(cmd.argv, cwd)));
  const refused = routes.find((x) => x.mode === "refuse");
  if (refused) return refused;
  const recipeKinds = new Set(["fs", "print", "noop", "false"]);
  const allRecipe = parsed.every(({ pipeline }) => pipeline.every((cmd) => {
    const x = routeFor(cmd.argv, cwd);
    return x.mode === "wasm" || recipeKinds.has(classifyCommand(cmd.argv, cwd).kind);
  }));
  if (allRecipe) return { mode: "line" };
  if (routes.some((x) => x.mode === "wasm")) return { mode: "refuse", reason: "this command line mixes host programs with a compiler step; romdev runs compiler steps only through its WASM toolchain, so give the compiler step its own command" };
  return { mode: "host" };
}

function resolveProgram(prog, cwd) {
  if (prog.includes("/")) return path.resolve(cwd, prog);
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, prog);
    try { if (statSync(p).isFile()) return p; } catch { /* keep looking */ }
  }
  return null;
}

/** Whether a program file is an interpreted script (starts with "#!"). */
function isScript(p) {
  if (!p) return false;
  try {
    const fd = openSync(p, "r"); const b = Buffer.alloc(2);
    readSync(fd, b, 0, 2, 0); closeSync(fd);
    return b.toString("latin1") === "#!";
  } catch { return false; }
}

function payload(argv, { cwd, stdin, mode, env }) {
  return JSON.stringify({ argv, cwd, mode, env: env ?? {}, stdin: stdin ? Buffer.from(stdin).toString("base64") : null });
}

/**
 * Run a program to completion, synchronously.
 * @param {string[]} argv
 * @param {{cwd?:string, env?:Record<string,string>, input?:Buffer|string, timeout?:number, encoding?:string|null, maxBuffer?:number}} [opts]
 * @returns {{status:number|null, signal:string|null, stdout:any, stderr:any, error?:Error}} (spawnSync-shaped)
 */
export function runProgramSync(argv, { cwd = process.cwd(), env = process.env, input = null, timeout, encoding = null, maxBuffer = 1 << 30, killSignal } = {}) {
  const route = routeFor(argv, cwd);
  const decode = (b) => (encoding && encoding !== "buffer" ? Buffer.from(b ?? "").toString(encoding) : Buffer.from(b ?? ""));
  if (route.mode === "refuse") return { status: 127, signal: null, stdout: decode(""), stderr: decode(`${route.reason}\n`) };
  if (route.mode === "host") {
    return spawnSync(argv[0], argv.slice(1), { cwd, env, input: input ?? undefined, timeout, maxBuffer, killSignal, encoding: encoding ?? "buffer" });
  }
  const r = spawnSync(process.execPath, [CHILD], { cwd, env, input: Buffer.from(payload(route.mode === "line" ? [argv[2]] : argv, { cwd, stdin: input, mode: route.mode, env })), timeout, maxBuffer, killSignal, encoding: "buffer" });
  return { ...r, stdout: decode(r.stdout), stderr: decode(r.stderr) };
}

/**
 * Start a program; resolves when it exits.
 * @returns {Promise<{code:number|null, signal:string|null, stdout:Buffer, stderr:Buffer}>}
 */
export function runProgram(argv, { cwd = process.cwd(), env = process.env, input = null, timeoutMs, detached = false, onSpawn } = {}) {
  const route = routeFor(argv, cwd);
  if (route.mode === "refuse") return Promise.resolve({ code: 127, signal: null, stdout: Buffer.alloc(0), stderr: Buffer.from(`${route.reason}\n`) });
  return new Promise((resolve) => {
    const child = route.mode === "host"
      ? spawn(argv[0], argv.slice(1), { cwd, env, detached, stdio: ["pipe", "pipe", "pipe"] })
      : spawn(process.execPath, [CHILD], { cwd, env, detached, stdio: ["pipe", "pipe", "pipe"] });
    onSpawn?.(child);
    const out = [], err = [];
    let timer = null;
    if (timeoutMs) timer = setTimeout(() => { try { detached ? process.kill(-child.pid, "SIGKILL") : child.kill("SIGKILL"); } catch {} }, timeoutMs);
    child.stdout.on("data", (d) => out.push(d));
    child.stderr.on("data", (d) => err.push(d));
    child.on("error", (e) => { if (timer) clearTimeout(timer); resolve({ code: 127, signal: null, stdout: Buffer.concat(out), stderr: Buffer.from(String(e.message)) }); });
    child.on("close", (code, signal) => { if (timer) clearTimeout(timer); resolve({ code, signal, stdout: Buffer.concat(out), stderr: Buffer.concat(err) }); });
    if (route.mode === "host") { if (input !== null && input !== undefined) child.stdin.end(input); else child.stdin.end(); }
    else child.stdin.end(payload(route.mode === "line" ? [argv[2]] : argv, { cwd, stdin: input, mode: route.mode, env }));
  });
}

/**
 * spawn() with the routing above: a host program is spawned as given; a
 * toolchain step is spawned as the node child that runs it through WASM; a
 * refused program is a child that prints why and exits 127. Returns the
 * ChildProcess, so callers keep their process-group and stream handling.
 */
export function spawnRouted(argv, options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const route = routeFor(argv, cwd);
  if (route.mode === "host") return spawn(argv[0], argv.slice(1), options);
  if (route.mode === "refuse") {
    return spawn(process.execPath, ["-e", `process.stderr.write(${JSON.stringify(route.reason + "\n")}); process.exit(127)`], { ...options, stdio: ["ignore", ...(options.stdio ?? ["pipe", "pipe", "pipe"]).slice(1)] });
  }
  const stdio = [...(options.stdio ?? ["pipe", "pipe", "pipe"])];
  stdio[0] = "pipe";
  const child = spawn(process.execPath, [CHILD], { ...options, stdio });
  child.stdin.end(payload(route.mode === "line" ? [argv[2]] : argv, { cwd, stdin: null, mode: route.mode, env: options.env }));
  return child;
}
