// romdev-toolchain-sh-gcc — binary package: sh-elf gcc backend (cc1),
// assembler, linker, objcopy, objdump (WASM). Dreamcast SH-4, little-endian,
// m4-single-only FP. emcc emits ESM (EXPORT_ES6=1) so the glue uses .mjs.
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WASM = path.join(__dirname, "wasm");

export const toolchain = {
  "cc1":            { gluePath: path.join(WASM, "cc1.mjs") },
  "sh-elf-as":      { gluePath: path.join(WASM, "sh-elf-as.mjs") },
  "sh-elf-ld":      { gluePath: path.join(WASM, "sh-elf-ld.mjs") },
  "sh-elf-objcopy": { gluePath: path.join(WASM, "sh-elf-objcopy.mjs") },
  "sh-elf-objdump": { gluePath: path.join(WASM, "sh-elf-objdump.mjs") },
};

export const wasmDir = WASM;
