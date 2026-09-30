// wasm-run.js - runs INSIDE romdev's WASM worker (src/toolchains/_worker):
// executes one NODERAWFS toolchain program (IDO's cc and its passes, the
// mips-linux-gnu binutils) against the real filesystem, with stdio captured.
//
// IDO's `cc` is a driver: it forks and execs cfe, uopt, ugen and as1. The
// recompiled cc's fork is emulated in C (ido-static-recomp-wasm.patch) and its
// execvp calls Module.romdevSpawn, handled here: the pass runs synchronously as
// a fresh instance of its own module, its stdin/stdout/stderr wired to what the
// parent's fds 0/1/2 point at (cfe's stdout is a temp file cc dup2'd onto fd 1).
//
// Modules are compiled once per worker (WebAssembly.Module cache) and
// instantiated per run; every instance gets fresh linear memory, which IDO's
// guest-memory model requires (see the patch's memory_map).
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const cache = new Map(); // glue path -> { factory, module }

async function load(glue) {
  let e = cache.get(glue);
  if (e) return e;
  const factory = (await import(pathToFileURL(glue).href)).default;
  const bytes = fs.readFileSync(glue.replace(/\.m?js$/, ".wasm"));
  const module = new WebAssembly.Module(bytes);
  e = { factory, module, bytes };
  cache.set(glue, e);
  return e;
}

const S_IFCHR = 0o020000;

/** An fd stream backed by JS: collects writes, or serves reads from a buffer. */
function memStream(FS, { collect, input, writable }) {
  let pos = 0;
  // flags/position live in FSStream.shared (accessors); passing a `shared`
  // object here would replace the one the flags were just written into.
  const s = FS.createStream({
    path: writable ? "/dev/romdev-out" : "/dev/romdev-in",
    flags: writable ? 1 : 0, // O_WRONLY / O_RDONLY
    seekable: false,
    position: 0,
    node: { mode: S_IFCHR | 0o666, id: 0 },
    stream_ops: {
      write(_s, buffer, offset, length) { collect.push(Buffer.from(buffer.subarray(offset, offset + length))); return length; },
      read(_s, buffer, offset, length) {
        if (!input || pos >= input.length) return 0;
        const n = Math.min(length, input.length - pos);
        buffer.set(input.subarray(pos, pos + n), offset);
        pos += n;
        return n;
      },
      llseek() { throw new FS.ErrnoError(29); }, // ESPIPE
      close() {},
    },
  });
  return s;
}

function setStd(FS, fd, stream) {
  FS.closeStream(stream.fd);
  FS.closeStream(fd);
  stream.fd = fd;
  FS.streams[fd] = stream;
}

/** Read what remains of a parent's stream (a redirected stdin). */
function drainStream(FS, stream) {
  const chunks = [];
  const buf = new Uint8Array(65536);
  for (;;) {
    const n = FS.read(stream, buf, 0, buf.length);
    if (!n) break;
    chunks.push(Buffer.from(buf.subarray(0, n)));
  }
  return Buffer.concat(chunks);
}

function writeToStream(FS, stream, bytes) {
  let off = 0;
  // A fresh copy: emscripten's NODERAWFS write() reads `buffer.buffer` from
  // `offset` and ignores byteOffset, and small Node Buffers are views into a
  // shared pool (a view here once wrote this script's own source into cfe's
  // ucode file).
  const u8 = new Uint8Array(bytes);
  while (off < u8.length) off += FS.write(stream, u8, off, u8.length - off);
}

/**
 * Run one program synchronously. `programs` maps a program basename to its
 * glue path (all preloaded). Returns the exit code; stdio bytes go to the
 * given collectors.
 */
function execProgram(ctx, argv0, args, { stdin, stdout, stderr }) {
  const name = path.basename(argv0);
  const glue = ctx.programs[name];
  if (!glue) {
    stderr.push(Buffer.from(`romdev: no WASM module for program '${argv0}' (known: ${Object.keys(ctx.programs).join(", ")})\n`));
    return 127;
  }
  const entry = cache.get(glue);
  ctx.trace?.push([argv0, ...args]);
  if (process.env.ROMDEV_WASM_TRACE) process.stderr.write(`[wasm-run] ${argv0} ${args.join(" ")}\n`);
  const M = {
    noInitialRun: true,
    thisProgram: argv0,
    wasmBinary: entry.bytes,
    print: () => {},
    printErr: () => {},
    quit: (_status, toThrow) => { throw toThrow; },
    preRun: [(m) => { for (const k of Object.keys(m.ENV)) if (!(k in ctx.env)) delete m.ENV[k]; Object.assign(m.ENV, ctx.env); }],
    romdevSpawn: (file, childArgv, parent, pipe = {}) => {
      const PFS = parent.FS;
      // A driver built on libiberty's pex (modern gcc) names the parent fds
      // the child's stdio goes to; the others use the parent's own 0/1/2.
      const inFd = pipe.inFd ?? 0, outFd = pipe.outFd ?? 1, errFd = pipe.errFd ?? 2;
      const s0 = PFS.getStream(inFd), s1 = PFS.getStream(outFd), s2 = PFS.getStream(errFd);
      // stdin: the previous stage of a driver pipeline (gcc -pipe), else a file
      // or pipe the driver handed over / dup2-ed onto fd 0, else the driver's
      // own stdin (gcc reading "-"), which is the job's input.
      let childIn;
      if (pipe.pipeIn) { childIn = ctx.pipeBuf ?? Buffer.alloc(0); ctx.pipeBuf = null; }
      else if (inFd !== 0 && s0) childIn = drainStream(PFS, s0);
      else if (s0 && !s0.stream_ops) childIn = drainStream(PFS, s0);
      else childIn = ctx.inheritStdin ? ctx.stdinBuf : null;
      const out = [], err = [];
      const code = execProgram(ctx, childArgv[0] ?? file, childArgv.slice(1), { stdin: childIn, stdout: out, stderr: err });
      if (pipe.pipeOut) ctx.pipeBuf = Buffer.concat(out);
      else if (s1 && out.length) writeToStream(PFS, s1, Buffer.concat(out));
      if (s2 && err.length) writeToStream(PFS, s2, Buffer.concat(err));
      return (code & 0xff) << 8;
    },
  };
  // The glue compiles M.wasmBinary with `new WebAssembly.Module` on its
  // synchronous path; hand it the module compiled once for this worker.
  // (Its instantiateWasm hook would make instantiation asynchronous.)
  const RealModule = WebAssembly.Module;
  WebAssembly.Module = function (bytes) { return bytes === entry.bytes ? entry.module : new RealModule(bytes); };
  try { entry.factory(M); } finally { WebAssembly.Module = RealModule; }
  if (typeof M.callMain !== "function") throw new Error(`${name}: module did not initialise synchronously`);
  const FS = M.FS;
  setStd(FS, 0, memStream(FS, { input: stdin ?? null, writable: false }));
  setStd(FS, 1, memStream(FS, { collect: stdout, writable: true }));
  setStd(FS, 2, memStream(FS, { collect: stderr, writable: true }));
  let code;
  try {
    code = M.callMain(args);
  } catch (e) {
    if (e && typeof e === "object" && typeof e.status === "number") code = e.status;
    else { stderr.push(Buffer.from(`\n[${name}] aborted: ${e?.message ?? e}\n${process.env.ROMDEV_WASM_STACK ? String(e?.stack ?? "") + "\n" : ""}`)); code = 134; }
  }
  return code ?? 0;
}

/**
 * A MEMFS module (the gcc toolchain's cc1, used as the C preprocessor) run over
 * a copy of just the files it needs: each path in `mount` is read from disk
 * here, in the worker, and written into MEMFS at the same absolute path, and
 * the module's cwd is set to the job's cwd, so relative -I paths and the
 * #include resolution behave exactly as on the real tree.
 */
async function runMemfsJob(job) {
  const e = await load(job.glue);
  const stdout = [], stderr = [];
  const M = {
    noInitialRun: true,
    thisProgram: job.argv[0],
    wasmBinary: e.bytes,
    print: () => {}, printErr: () => {},
    quit: (_status, toThrow) => { throw toThrow; },
  };
  const RealModule = WebAssembly.Module;
  WebAssembly.Module = function (bytes) { return bytes === e.bytes ? e.module : new RealModule(bytes); };
  try { await e.factory(M); } finally { WebAssembly.Module = RealModule; }
  const FS = M.FS;
  const mkdirp = (d) => { let cur = ""; for (const part of d.split("/").filter(Boolean)) { cur += "/" + part; try { FS.mkdir(cur); } catch { /* exists */ } } };
  mkdirp(job.cwd);
  for (const f of job.mount ?? []) {
    let data;
    try { data = fs.readFileSync(f); } catch { continue; }
    mkdirp(path.posix.dirname(f));
    FS.writeFile(f, new Uint8Array(data));
  }
  for (const d of job.mountDirs ?? []) mkdirp(d);
  for (const f of job.memFiles ?? []) { mkdirp(path.posix.dirname(f.path)); FS.writeFile(f.path, new Uint8Array(Buffer.from(f.base64, "base64"))); }
  FS.chdir(job.cwd);
  setStd(FS, 0, memStream(FS, { input: job.stdinBase64 ? Buffer.from(job.stdinBase64, "base64") : null, writable: false }));
  setStd(FS, 1, memStream(FS, { collect: stdout, writable: true }));
  setStd(FS, 2, memStream(FS, { collect: stderr, writable: true }));
  let code;
  try { code = M.callMain(job.argv.slice(1)) ?? 0; }
  catch (err) {
    if (err && typeof err === "object" && typeof err.status === "number") code = err.status;
    else { stderr.push(Buffer.from(`\n[${path.basename(job.glue)}] aborted: ${err?.message ?? err}\n`)); code = 134; }
  }
  const outputs = {};
  for (const o of job.outputs ?? []) { try { outputs[o] = Buffer.from(FS.readFile(o)).toString("base64"); } catch { outputs[o] = null; } }
  const out = Buffer.concat(stdout), err = Buffer.concat(stderr);
  return { exitCode: code, stdout: out.toString("base64"), stderr: err.toString("latin1"), log: err.toString("latin1"), outputs };
}

/**
 * Worker entry (wasm-worker.js calls this for jobs carrying `handler`).
 * job: { argv:[program, ...args], cwd, programs:{name: gluePath}, env, stdinBase64? }
 * @returns {Promise<{exitCode:number, log:string, stdout:string, stderr:string, trace?:string[][]}>}
 */
export async function runWorkerJob(job) {
  if (job.kind === "memfs") return runMemfsJob(job);
  for (const g of Object.values(job.programs)) await load(g);
  const prevCwd = process.cwd();
  const stdout = [], stderr = [];
  const stdinBuf = job.stdinBase64 ? Buffer.from(job.stdinBase64, "base64") : null;
  // inheritStdin: a driver's subprograms read the job's stdin (gcc ... -).
  const ctx = { programs: job.programs, env: job.env ?? {}, trace: job.trace ? [] : null, inheritStdin: !!job.inheritStdin, stdinBuf };
  let exitCode;
  try {
    process.chdir(job.cwd);
    exitCode = execProgram(ctx, job.argv[0], job.argv.slice(1), { stdin: stdinBuf, stdout, stderr });
  } finally {
    process.chdir(prevCwd);
  }
  const out = Buffer.concat(stdout), err = Buffer.concat(stderr);
  return {
    exitCode,
    stdout: job.stdoutBase64 ? out.toString("base64") : out.toString("latin1"),
    stderr: err.toString("latin1"),
    log: err.toString("latin1") + (job.stdoutBase64 ? "" : out.toString("latin1")),
    ...(ctx.trace ? { trace: ctx.trace } : {}),
  };
}
