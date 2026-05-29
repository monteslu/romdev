// @romdev/toolchain-cc65 — binary package: cc65 C compiler + ca65 assembler +
// ld65 linker + da65 disassembler (WASM), plus the cc65 target share/ tree
// (include, asminc, lib, cfg, target) the linker needs.
// Exports absolute paths to the bundled WASM + the share dir so romdev's
// resolvers can load them via the package.
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WASM = path.join(__dirname, "wasm");

// share/cc65/{include,asminc,lib,cfg,target} — mounted into MEMFS at call time.
export const shareDir = path.join(__dirname, "share", "cc65");

// Compiler / assembler / linker / disassembler toolchain — cc65 family.
export const toolchain = {
  cc65: { gluePath: path.join(WASM, "cc65.js") },
  ca65: { gluePath: path.join(WASM, "ca65.js") },
  ld65: { gluePath: path.join(WASM, "ld65.js") },
  da65: { gluePath: path.join(WASM, "da65.js") },
};
