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
