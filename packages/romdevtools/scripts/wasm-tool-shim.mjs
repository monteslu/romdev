// wasm-tool-shim.mjs <glue.mjs> [args...]: run one of romdev's NODERAWFS WASM
// tools as a command. Build time only: a configure script that probes its
// target toolchain (gcc's checks of the assembler's features, which decide
// what cc1 emits) runs romdev's own WASM binutils through small PATH shims
// that call this. Nothing at romdev run time uses it.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [glue, ...args] = process.argv.slice(2);
const factory = (await import(pathToFileURL(path.resolve(glue)).href)).default;
const M = {
  noInitialRun: true,
  thisProgram: path.basename(glue, ".mjs"),
  wasmBinary: fs.readFileSync(glue.replace(/\.mjs$/, ".wasm")),
  print: (s) => process.stdout.write(s + "\n"),
  printErr: (s) => process.stderr.write(s + "\n"),
  quit: (_status, toThrow) => { throw toThrow; },
};
// Instantiated synchronously (the glue is built with WASM_ASYNC_COMPILATION=0):
// the module object is ready when the factory returns.
factory(M);
let code = 0;
try { code = M.callMain(args) ?? 0; }
catch (e) { if (typeof e?.status === "number") code = e.status; else { process.stderr.write(String(e?.stack ?? e) + "\n"); code = 134; } }
process.exitCode = code;
