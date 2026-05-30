// pool.js — child-process pool for WASM toolchain isolation.
//
// Spawns N child workers (wasm-worker.js). Acquire/release semantics:
// when a caller wants to run a build, it grabs an idle worker, sends the
// job, awaits the result. If the worker crashes (SIGSEGV, native abort,
// OOM, anything that exits the process before answering), the pool
// detects the unexpected exit, REJECTS the in-flight job with
// {ok:false, stage:"crash"}, and replaces the worker so the next caller
// gets a fresh one.
//
// This is the chokepoint that gives MCP the "one bad build can't kill
// the server" property requested in Round 11 feedback.

import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WORKER_PATH = path.join(__dirname, "wasm-worker.js");

const POOL_SIZE = Number(process.env.ROM_DEV_WASM_POOL_SIZE ?? 2);

/**
 * @typedef {Object} Worker
 * @property {import("node:child_process").ChildProcess} child
 * @property {"idle"|"busy"|"dead"} state
 * @property {number} id
 * @property {((res:any)=>void)|null} pendingResolve
 * @property {((err:any)=>void)|null} pendingReject
 * @property {number|null} pendingJobId
 */

/** @type {Worker[]} */
const workers = [];
/** @type {Array<(w:Worker)=>void>} */
const waiters = [];
let nextWorkerId = 1;
let nextJobId = 1;

function spawnWorker() {
  const child = fork(WORKER_PATH, [], {
    // Use IPC, inherit stderr so worker logs surface during dev.
    stdio: ["ignore", "ignore", "inherit", "ipc"],
    // Pass through env so EMSDK paths, etc. work.
    env: process.env,
    // Don't inherit the parent's `--test`, `--inspect`, etc. node-level
    // flags. Workers run ordinary scripts; inheriting parent execArgv
    // makes them run as test files which never exits + double-loads modules.
    execArgv: [],
  });
  /** @type {Worker} */
  const w = {
    child,
    state: "busy",  // become idle after the first "ready"
    id: nextWorkerId++,
    pendingResolve: null,
    pendingReject: null,
    pendingJobId: null,
  };

  w.child.on("message", (msg) => {
    if (msg.type === "ready") {
      // Transition to idle and hand the worker to the next waiter.
      w.state = "idle";
      const waiter = waiters.shift();
      if (waiter) {
        waiter(w);
      } else {
        // Nothing waiting — unref so this idle worker doesn't hold the
        // parent's event loop open. Re-ref'd on next acquire.
        w.child.unref();
        w.child.channel?.unref?.();
      }
      return;
    }
    if (msg.type === "pong") {
      // health check
      return;
    }
    if (msg.type === "prewarmed") {
      // ack — pool decided to prewarm a module
      return;
    }
    if (msg.type === "result" && w.pendingResolve) {
      const resolve = w.pendingResolve;
      w.pendingResolve = null;
      w.pendingReject = null;
      w.pendingJobId = null;
      resolve(msg.result);
      return;
    }
    if (msg.type === "error" && w.pendingReject) {
      const reject = w.pendingReject;
      w.pendingResolve = null;
      w.pendingReject = null;
      w.pendingJobId = null;
      reject(new Error(`[worker ${w.id}] ${msg.error}`));
      return;
    }
  });

  w.child.on("exit", (code, signal) => {
    w.state = "dead";
    // If we had a job in flight, fail it with crash metadata.
    if (w.pendingReject) {
      const reject = w.pendingReject;
      w.pendingResolve = null;
      w.pendingReject = null;
      const err = new Error(
        `worker ${w.id} exited unexpectedly (code=${code} signal=${signal}) ` +
        `while running job ${w.pendingJobId}`
      );
      /** @type {any} */(err).crash = { exitCode: code, signal: signal ?? null };
      w.pendingJobId = null;
      reject(err);
    }
    // Remove from pool + spawn replacement so capacity is preserved.
    const idx = workers.indexOf(w);
    if (idx >= 0) workers.splice(idx, 1);
    // Replenish (only if we still want a pool — process not shutting down).
    if (!shuttingDown) {
      const replacement = spawnWorker();
      workers.push(replacement);
    }
  });

  w.child.on("error", (e) => {
    console.error(`[wasm-worker-pool] worker ${w.id} error:`, e);
  });

  return w;
}

let shuttingDown = false;
let initialized = false;

function ensureInit() {
  if (initialized) return;
  initialized = true;
  for (let i = 0; i < POOL_SIZE; i++) {
    workers.push(spawnWorker());
  }
}

/** Acquire an idle worker, blocking until one is available. */
function acquire() {
  ensureInit();
  return new Promise((resolve) => {
    // Look for an already-idle worker.
    const idle = workers.find((w) => w.state === "idle");
    if (idle) {
      idle.state = "busy";
      // Re-ref since idle workers are unref'd to keep the event loop free.
      idle.child.ref();
      idle.child.channel?.ref?.();
      resolve(idle);
      return;
    }
    // Queue up — the 'ready' handler will deliver to us.
    waiters.push((w) => {
      w.state = "busy";
      // Worker is already ref'd in spawn or was ref'd when previous job
      // started; the 'ready' handler only unrefs when no waiter exists.
      resolve(w);
    });
  });
}

/**
 * Run a WASM toolchain job in an isolated worker.
 *
 * @param {{
 *   gluePath: string,
 *   argv: string[],
 *   stdinText?: string,
 *   inputFiles?: Array<{vfsPath:string, encoding:"utf8"|"base64", data:string}>,
 *   hostDirMounts?: Array<{hostDir:string, vfsDir:string}>,
 *   outputFiles?: Array<{vfsPath:string, encoding:"utf8"|"base64"}>,
 * }} job
 * @returns {Promise<{exitCode:number, log:string, outputs:Record<string,string>, crash?:{exitCode:number|null, signal:string|null}}>}
 */
export async function runInWorker(job) {
  const w = await acquire();
  const id = nextJobId++;
  return new Promise((resolve, reject) => {
    const settle = (result, err) => {
      if (err) reject(err); else resolve(result);
    };
    w.pendingResolve = (result) => settle(result);
    w.pendingReject = (err) => {
      if (err && err.crash) {
        // Convert crash to a normal result so callers don't have to catch.
        settle({
          exitCode: err.crash.exitCode ?? -1,
          log: `[crash] worker exited unexpectedly — signal=${err.crash.signal} code=${err.crash.exitCode}\n`,
          outputs: {},
          crash: err.crash,
        });
      } else {
        settle(null, err);
      }
    };
    w.pendingJobId = id;
    w.child.send({ type: "run", id, job });
  });
}

/** Test-only: expose the current worker list for crash-isolation tests. */
export function _internalWorkers() {
  ensureInit();
  return workers.slice();
}

/** Pre-warm a specific WASM module in every worker. Speeds first call. */
export async function prewarm(gluePath) {
  ensureInit();
  // Don't await — fire-and-forget across all current workers.
  for (const w of workers) {
    if (w.state === "dead") continue;
    w.child.send({ type: "prewarm", id: nextJobId++, gluePath });
  }
}

/** Shut down all workers (called on process exit). */
export async function shutdown() {
  shuttingDown = true;
  for (const w of workers) {
    if (w.state === "dead") continue;
    try {
      if (w.child.connected) w.child.send({ type: "shutdown" });
    } catch { /* IPC channel already closed */ }
  }
  // Give them a moment to exit cleanly.
  await new Promise((r) => setTimeout(r, 100));
  for (const w of workers) {
    if (!w.child.killed) {
      try { w.child.kill("SIGTERM"); } catch {}
    }
  }
  workers.length = 0;
}

// Hook process exit so workers don't outlive us.
process.on("exit", () => {
  for (const w of workers) {
    try { if (!w.child.killed) w.child.kill("SIGTERM"); } catch {}
  }
});
// One-shot async-cleanup on SIGINT/SIGTERM. Use .catch to avoid emitting
// "ERR_IPC_CHANNEL_CLOSED" stacks when workers are already dead.
process.on("SIGINT", () => { shutdown().catch(() => {}).finally(() => process.exit(0)); });
process.on("SIGTERM", () => { shutdown().catch(() => {}).finally(() => process.exit(0)); });
