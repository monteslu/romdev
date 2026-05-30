// wasm-worker.js — child process that runs ONE WASM toolchain call in isolation.
//
// Spawned as `child_process.fork(__filename)` by the pool. Listens for jobs
// over IPC, runs them, returns results. If the WASM aborts / SIGSEGVs / OOMs,
// the child exits and the parent sees the exit code — the MCP server stays
// up regardless.
//
// Protocol (parent → child, via process.send):
//   { type: "run", job }                      run a build job
//   { type: "prewarm", gluePath }             instantiate a module to warm cache
//   { type: "ping" }                          health check
//   { type: "shutdown" }                      exit cleanly
//
// Protocol (child → parent):
//   { type: "ready" }                         after each job, available again
//   { type: "result", id, result }            job complete
//   { type: "error", id, error }              job threw something catchable
//   { type: "pong" }                          ping reply
//
// Crashes (uncaught WASM Abort, native SIGSEGV, OOM) → process exits;
// parent's 'exit' handler reports {ok:false, stage:"crash"} to the caller.

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

// Keep a small per-worker cache of loaded module factories. The factory is
// what the emcc glue exports; calling it returns an instantiated module
// (which is what we throw away each call — the factory itself is reusable
// because emscripten supports it via wasmBinary reuse).
const factoryCache = new Map();   // gluePath → { factory, wasmBinary }

async function loadFactory(gluePath) {
  const cached = factoryCache.get(gluePath);
  if (cached) return cached;
  // Accept .js (CommonJS glue) or .mjs (ES-module glue). emcc's EXPORT_ES6=1
  // output is .mjs-style (uses import.meta.url, dynamic require); some of
  // our older toolchains use .js. The sibling .wasm is always alongside.
  const wasmPath = gluePath.replace(/\.(m?js)$/, ".wasm");
  const wasmBinary = await readFile(wasmPath);
  const factory = (await import(gluePath)).default;
  const entry = { factory, wasmBinary };
  factoryCache.set(gluePath, entry);
  return entry;
}

function ensureDir(FS, dir) {
  const parts = dir.split("/").filter(Boolean);
  let cur = "";
  for (const p of parts) {
    cur += "/" + p;
    try { FS.mkdir(cur); } catch {}
  }
}

async function preloadHostDir(FS, hostDir, mfsDir) {
  ensureDir(FS, mfsDir);
  const entries = await readdir(hostDir, { withFileTypes: true });
  for (const e of entries) {
    const hp = path.join(hostDir, e.name);
    const mp = mfsDir + "/" + e.name;
    if (e.isDirectory()) {
      await preloadHostDir(FS, hp, mp);
    } else if (e.isFile()) {
      const data = await readFile(hp);
      FS.writeFile(mp, new Uint8Array(data));
    }
  }
}

/**
 * Execute one job inside this worker.
 *
 * @param {{
 *   gluePath: string,
 *   argv: string[],
 *   stdinText?: string,
 *   inputFiles?: Array<{vfsPath:string, encoding:"utf8"|"base64", data:string}>,
 *   hostDirMounts?: Array<{hostDir:string, vfsDir:string}>,
 *   outputFiles?: Array<{vfsPath:string, encoding:"utf8"|"base64"}>,
 * }} job
 * @returns {Promise<{exitCode:number, log:string, outputs:Record<string,string>}>}
 */
async function runJob(job) {
  const { factory, wasmBinary } = await loadFactory(job.gluePath);

  let log = "";
  const print = (msg) => { log += msg + "\n"; };

  let capturedExit = null;

  // Build moduleArgs. Inject stdin via a small custom stdin function if the
  // job provides one (SDCC sdcpp/sdcc use this).
  const moduleArgs = {
    wasmBinary,
    noInitialRun: true,
    print,
    printErr: print,
    quit: (status, toThrow) => {
      capturedExit = status;
      throw toThrow ?? new Error("exit " + status);
    },
    onExit: (status) => { capturedExit = status; },
  };
  if (job.stdinText != null) {
    let idx = 0;
    const buf = Buffer.from(job.stdinText, "utf8");
    moduleArgs.stdin = () => {
      if (idx >= buf.length) return null;
      return buf[idx++];
    };
  }

  const mod = await factory(moduleArgs);

  // Populate MEMFS from the job spec.
  for (const m of (job.hostDirMounts ?? [])) {
    await preloadHostDir(mod.FS, m.hostDir, m.vfsDir);
  }
  for (const f of (job.inputFiles ?? [])) {
    const parent = path.posix.dirname(f.vfsPath);
    if (parent !== "/" && parent !== ".") ensureDir(mod.FS, parent);
    const bytes = f.encoding === "base64"
      ? new Uint8Array(Buffer.from(f.data, "base64"))
      : f.data;
    mod.FS.writeFile(f.vfsPath, bytes);
  }
  // Pre-create parent directories for declared output files so tools
  // that write to e.g. /work/out.s don't ENOENT when /work doesn't exist
  // (which happens when the job has no inputFiles, only stdin + outputs).
  for (const f of (job.outputFiles ?? [])) {
    const parent = path.posix.dirname(f.vfsPath);
    if (parent !== "/" && parent !== ".") ensureDir(mod.FS, parent);
  }

  // Run callMain. Catch the "quit/exit threw" pattern emcc uses.
  let exitCode = 0;
  const originalExit = process.exit;
  process.exit = (c) => {
    capturedExit = c ?? 0;
    throw new Error("intercepted exit " + capturedExit);
  };
  try {
    mod.callMain(job.argv);
  } catch (e) {
    if (e && typeof e === "object" && "status" in e) {
      exitCode = /** @type {any} */ (e).status;
    } else if (capturedExit !== null) {
      exitCode = capturedExit;
    } else {
      // Non-exit throw — bubble up so the worker reports it as an error.
      // Won't crash the worker (caught here), but the build is recorded as failed.
      log += `\n[worker] Abort in WASM: ${e?.message ?? e}\n`;
      exitCode = exitCode || 1;
    }
  } finally {
    process.exit = originalExit;
  }
  if (capturedExit !== null && exitCode === 0) exitCode = capturedExit;
  if (process.exitCode != null && process.exitCode !== 0) {
    if (exitCode === 0) exitCode = process.exitCode;
    process.exitCode = undefined;
  }

  // Collect outputs.
  /** @type {Record<string, string>} */
  const outputs = {};
  for (const f of (job.outputFiles ?? [])) {
    try {
      const bytes = mod.FS.readFile(f.vfsPath);
      outputs[f.vfsPath] = f.encoding === "base64"
        ? Buffer.from(bytes).toString("base64")
        : new TextDecoder().decode(bytes);
    } catch {
      // file absent — caller decides what's required
      outputs[f.vfsPath] = "";
    }
  }

  return { exitCode, log, outputs };
}

// ── IPC dispatch ────────────────────────────────────────────────

if (typeof process.send !== "function") {
  console.error("wasm-worker.js must be launched via child_process.fork");
  process.exit(2);
}

// Signal the parent we're ready to take jobs.
process.send({ type: "ready" });

process.on("message", async (msg) => {
  try {
    if (msg.type === "ping") {
      process.send({ type: "pong" });
      return;
    }
    if (msg.type === "shutdown") {
      process.exit(0);
    }
    if (msg.type === "prewarm") {
      await loadFactory(msg.gluePath);
      process.send({ type: "prewarmed", id: msg.id, gluePath: msg.gluePath });
      return;
    }
    if (msg.type === "run") {
      const result = await runJob(msg.job);
      process.send({ type: "result", id: msg.id, result });
      // After every job, signal ready again so the pool can recycle us.
      process.send({ type: "ready" });
      return;
    }
    process.send({ type: "error", id: msg.id, error: `unknown message type: ${msg.type}` });
  } catch (e) {
    // This catches JS-level errors inside the worker (e.g. file-not-found,
    // bad job spec). Real WASM aborts that bypass our handlers will crash
    // the process — the parent sees that via the 'exit' event with a
    // non-zero code, not via this path.
    process.send({
      type: "error",
      id: msg?.id,
      error: e?.stack ?? e?.message ?? String(e),
    });
    process.send({ type: "ready" });
  }
});

// Unhandled rejections inside emcc's async code occasionally land here.
// Log them, but the process keeps going so the parent's idle-pool logic
// can decide what to do.
process.on("unhandledRejection", (reason) => {
  console.error("[wasm-worker] unhandledRejection:", reason);
});
