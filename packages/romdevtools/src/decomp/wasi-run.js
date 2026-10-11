// wasi-run.js - runs INSIDE romdev's WASM worker (src/toolchains/_worker):
// executes one WASI preview-1 program (a Go tool built GOOS=wasip1 GOARCH=wasm
// by scripts/build-decomp-go-tools.sh) under node:wasi against the real tree.
//
// The job's cwd (the project directory) and any extra `preopens` are mapped
// at their own absolute paths, and PWD is the cwd, so Go's wasip1 runtime
// resolves relative paths exactly as the native tool would from the project
// root. stdin comes from the job; stdout/stderr are collected through
// scratch files under `tmpDir` (WASI takes host fds).
//
// WASI has no processes. A tool built with romdev's overlay hands the one
// child it needs (psx-assets' `cpp` for enum lookups) to the `romdev`
// imports: exec(reqPtr, reqLen) -> response length, take(ptr) -> copy it.
// The request is JSON {argv, dir} (dir: the guest's working directory); the
// response is a 4-byte little-endian exit status, then stdout. The program runs in a
// worker thread that blocks on a SharedArrayBuffer while this thread runs
// the argv through recipe.js's dispatch (romdev's WASM cpp) and replies.
import fs from "node:fs";
import path from "node:path";
import { WASI } from "node:wasi";
import { randomUUID } from "node:crypto";
import { Worker, isMainThread, workerData, MessageChannel, receiveMessageOnPort } from "node:worker_threads";

const cache = new Map(); // wasm path -> WebAssembly.Module

function runInThread({ job, port, flag }) {
  let mod = cache.get(job.wasm);
  if (!mod) { mod = new WebAssembly.Module(fs.readFileSync(job.wasm)); cache.set(job.wasm, mod); }
  fs.mkdirSync(job.tmpDir, { recursive: true });
  const tag = randomUUID().slice(0, 8);
  const inPath = path.join(job.tmpDir, `wasi-${tag}.in`), outPath = path.join(job.tmpDir, `wasi-${tag}.out`), errPath = path.join(job.tmpDir, `wasi-${tag}.err`);
  fs.writeFileSync(inPath, job.stdinBase64 ? Buffer.from(job.stdinBase64, "base64") : Buffer.alloc(0));
  const fin = fs.openSync(inPath, "r"), fout = fs.openSync(outPath, "w"), ferr = fs.openSync(errPath, "w");
  const preopens = {};
  for (const d of [job.cwd, ...(job.preopens ?? [])]) preopens[path.resolve(d)] = path.resolve(d);
  const sig = new Int32Array(flag);
  let memory = null, pending = null, exitCode;
  const romdev = {
    exec(ptr, len) {
      const { argv, dir } = JSON.parse(Buffer.from(memory.buffer, ptr, len).toString("utf8"));
      Atomics.store(sig, 0, 0);
      port.postMessage({ type: "exec", argv, dir });
      Atomics.wait(sig, 0, 0);
      const r = receiveMessageOnPort(port).message;
      const head = Buffer.alloc(4); head.writeInt32LE(r.code | 0, 0);
      pending = Buffer.concat([head, Buffer.from(r.stdout)]);
      if (r.log) fs.writeSync(ferr, r.log);
      return pending.length;
    },
    take(ptr) { new Uint8Array(memory.buffer, ptr, pending.length).set(pending); pending = null; },
  };
  try {
    const wasi = new WASI({
      version: "preview1",
      args: job.argv,
      env: { PWD: path.resolve(job.cwd), ...(job.env ?? {}) },
      preopens,
      stdin: fin, stdout: fout, stderr: ferr,
      returnOnExit: true,
    });
    const inst = new WebAssembly.Instance(mod, { ...wasi.getImportObject(), romdev });
    memory = inst.exports.memory;
    try { exitCode = wasi.start(inst); }
    catch (e) { fs.writeSync(ferr, `\n[${path.basename(job.wasm)}] aborted: ${e?.message ?? e}\n`); exitCode = 134; }
  } finally {
    fs.closeSync(fin); fs.closeSync(fout); fs.closeSync(ferr);
  }
  const out = fs.readFileSync(outPath), err = fs.readFileSync(errPath);
  for (const p of [inPath, outPath, errPath]) fs.rmSync(p, { force: true });
  return {
    exitCode: exitCode ?? 0,
    stdout: job.stdoutBase64 ? out.toString("base64") : out.toString("latin1"),
    stderr: err.toString("latin1"),
    log: err.toString("latin1") + (job.stdoutBase64 ? "" : out.toString("latin1")),
  };
}

if (!isMainThread && workerData?.romdevWasi) {
  const { job, port, flag } = workerData;
  let result;
  try { result = runInThread({ job, port, flag }); }
  catch (e) { result = { exitCode: 134, stdout: "", stderr: String(e?.stack ?? e), log: String(e?.stack ?? e) }; }
  port.postMessage({ type: "done", result });
}

/**
 * job: { wasm, argv, cwd, env?, preopens?: string[], stdinBase64?, tmpDir, stdoutBase64? }
 * @returns {Promise<{exitCode:number, stdout:string, stderr:string, log:string}>}
 */
export async function runWorkerJob(job) {
  const { port1, port2 } = new MessageChannel();
  const flag = new SharedArrayBuffer(4);
  const sig = new Int32Array(flag);
  const w = new Worker(new URL(import.meta.url), { workerData: { romdevWasi: true, job, port: port2, flag }, transferList: [port2] });
  let runArgv = null;
  return await new Promise((resolve, reject) => {
    let done = false;
    port1.on("message", async (m) => {
      // the thread has nothing left to do; do not let it linger in a long-lived worker
      if (m.type === "done") { done = true; port1.close(); w.terminate(); resolve(m.result); return; }
      if (m.type !== "exec") return;
      let r;
      try {
        if (!runArgv) ({ runArgv } = await import("./recipe.js"));
        const x = await runArgv(m.argv, { cwd: m.dir || job.cwd, tmpRoot: job.tmpDir });
        r = x.unsupported ? { code: 127, stdout: Buffer.alloc(0), log: `romdev: ${x.unsupported}\n` } : { code: x.code, stdout: x.stdout ?? Buffer.alloc(0), log: x.log ?? "" };
      } catch (e) { r = { code: 127, stdout: Buffer.alloc(0), log: `romdev: ${e?.message ?? e}\n` }; }
      port1.postMessage(r);
      Atomics.store(sig, 0, 1);
      Atomics.notify(sig, 0);
    });
    w.on("error", (e) => { if (!done) reject(e); });
    w.on("exit", (code) => { if (!done) reject(new Error(`WASI thread exited (${code}) before finishing`)); });
  });
}
