// wasm-tool.js - run an emscripten-built command-line tool (binutils objdump)
// in-process, once per call, with its WebAssembly.Module compiled only once.
//
// The permuter disassembles every candidate object, so paying the WASM compile
// per call would dominate a search. Each call still gets a fresh instance
// (emscripten tools are single-shot: callMain once, then the module is spent).
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** @type {Map<string, Promise<{factory: Function, module: WebAssembly.Module}>>} */
const cache = new Map();

async function load(gluePath) {
  let p = cache.get(gluePath);
  if (!p) {
    p = (async () => {
      const bytes = readFileSync(gluePath.replace(/\.m?js$/, ".wasm"));
      const module = await WebAssembly.compile(bytes);
      const factory = (await import(pathToFileURL(gluePath).href)).default;
      return { factory, module };
    })();
    cache.set(gluePath, p);
  }
  return p;
}

/**
 * Run a tool.
 * @param {string} gluePath emscripten ESM glue (.mjs; the .wasm sits beside it)
 * @param {string[]} argv arguments (no argv[0])
 * @param {Record<string, Uint8Array|string>} files MEMFS files to create first
 * @param {string[]} [outputs] MEMFS paths to read back after the run
 * @returns {Promise<{exitCode: number, stdout: string, stderr: string, outputs: Record<string, Uint8Array|null>}>}
 */
export async function runWasmTool(gluePath, argv, files = {}, outputs = []) {
  const { factory, module } = await load(gluePath);
  const out = [], err = [];
  let exitCode = null;
  const mod = await factory({
    noInitialRun: true,
    print: (s) => out.push(s),
    printErr: (s) => err.push(s),
    instantiateWasm(imports, receive) {
      WebAssembly.instantiate(module, imports).then((inst) => receive(inst, module));
      return {};
    },
    quit: (status, toThrow) => { exitCode = status; throw toThrow ?? new Error(`exit ${status}`); },
    onExit: (status) => { exitCode = status; },
  });
  for (const [p, data] of Object.entries(files)) {
    const dir = p.slice(0, p.lastIndexOf("/"));
    if (dir) {
      let cur = "";
      for (const part of dir.split("/").filter(Boolean)) {
        cur += "/" + part;
        try { mod.FS.mkdir(cur); } catch { /* exists */ }
      }
    }
    mod.FS.writeFile(p, data);
  }
  try {
    const r = mod.callMain(argv);
    if (exitCode == null) exitCode = typeof r === "number" ? r : 0;
  } catch (e) {
    if (e && typeof e === "object" && "status" in e) exitCode = e.status;
    else if (exitCode == null) { err.push(String(e?.message ?? e)); exitCode = 1; }
  }
  const read = {};
  for (const p of outputs) {
    try { read[p] = mod.FS.readFile(p); } catch { read[p] = null; }
  }
  return { exitCode: exitCode ?? 0, stdout: out.join("\n") + (out.length ? "\n" : ""), stderr: err.join("\n"), outputs: read };
}

// -- NODERAWFS tools ---------------------------------------------------------
// romdev's mips-linux-gnu binutils are NODERAWFS builds (they read the real
// filesystem), the same modules romdev's compile/compare path runs. Their
// glue initialises synchronously when handed a precompiled module; stdio is
// rebound to in-memory streams so output is captured rather than written to
// this process's fds.

/** @type {Map<string, {factory: Function, module: WebAssembly.Module, bytes: Buffer}>} */
const rawCache = new Map();

async function loadRaw(gluePath) {
  let e = rawCache.get(gluePath);
  if (!e) {
    const bytes = readFileSync(gluePath.replace(/\.m?js$/, ".wasm"));
    const module = new WebAssembly.Module(bytes);
    const factory = (await import(pathToFileURL(gluePath).href)).default;
    e = { factory, module, bytes };
    rawCache.set(gluePath, e);
  }
  return e;
}

const S_IFCHR = 0o020000;
function captureStream(FS, collect) {
  return FS.createStream({
    path: "/dev/romdev-out", flags: 1, seekable: false, position: 0,
    node: { mode: S_IFCHR | 0o666, id: 0 },
    stream_ops: {
      write(_s, buffer, offset, length) { collect.push(Buffer.from(buffer.subarray(offset, offset + length))); return length; },
      read() { return 0; },
      llseek() { throw new FS.ErrnoError(29); },
      close() {},
    },
  });
}
function bindStd(FS, fd, stream) {
  FS.closeStream(stream.fd);
  FS.closeStream(fd);
  stream.fd = fd;
  FS.streams[fd] = stream;
}

/**
 * Run a NODERAWFS tool (paths in argv are real host paths).
 * @returns {Promise<{exitCode: number, stdout: string, stderr: string}>}
 */
export async function runRawFsTool(gluePath, argv, { argv0 = "tool" } = {}) {
  const e = await loadRaw(gluePath);
  const out = [], err = [];
  const M = {
    noInitialRun: true, thisProgram: argv0, wasmBinary: e.bytes,
    print: () => {}, printErr: () => {},
    quit: (_status, toThrow) => { throw toThrow; },
  };
  const RealModule = WebAssembly.Module;
  WebAssembly.Module = function (bytes) { return bytes === e.bytes ? e.module : new RealModule(bytes); };
  try { e.factory(M); } finally { WebAssembly.Module = RealModule; }
  if (typeof M.callMain !== "function") throw new Error(`${gluePath}: module did not initialise synchronously`);
  const FS = M.FS;
  bindStd(FS, 1, captureStream(FS, out));
  bindStd(FS, 2, captureStream(FS, err));
  let code;
  try {
    code = M.callMain(argv);
  } catch (x) {
    if (x && typeof x === "object" && typeof x.status === "number") code = x.status;
    else { err.push(Buffer.from(String(x?.message ?? x))); code = 134; }
  }
  return { exitCode: code ?? 0, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") };
}
