// romdev-analysis-decompiler — binary package: Ghidra decompiler (WASM) +
// SLEIGH specs for all 14 retro CPUs. Driven one-shot via the REPL through
// romdev's WASM worker pool. See NOTICE for attribution.
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const decompiler = {
  name: "ghidra-decompile",
  jsPath: path.join(__dirname, "wasm", "decompile.js"),
  wasmPath: path.join(__dirname, "wasm", "decompile.wasm"),
  // SLEIGH home: the dir holding the .sla + .ldefs/.pspec/.cspec. Mounted into
  // MEMFS and pointed at via SLEIGHHOME.
  sleighDir: path.join(__dirname, "sleigh"),
};
