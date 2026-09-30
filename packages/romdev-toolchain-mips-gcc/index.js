// romdev-toolchain-mips-gcc - binary package: mips-elf gcc backend (cc1),
// assembler, linker, objcopy, objdump (WASM). Big-endian (N64 R4300) and
// little-endian (PS1 R3000) both emit from this one toolchain via -EB/-EL.
// emcc emits ESM (EXPORT_ES6=1) so the glue uses .mjs extensions.
//
// Also: mips-linux-gnu binutils (as/ld/objcopy/objdump), the traditional-MIPS
// ELF vectors N64 decomp projects build with. Those are linked with NODERAWFS
// (they work on the real filesystem) and are driven by romdevtools' decomp
// domain from its WASM worker (src/decomp/toolchain.js).
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WASM = path.join(__dirname, "wasm");

export const toolchain = {
  "cc1":              { gluePath: path.join(WASM, "cc1.mjs") },
  "mips-elf-as":      { gluePath: path.join(WASM, "mips-elf-as.mjs") },
  "mips-elf-ld":      { gluePath: path.join(WASM, "mips-elf-ld.mjs") },
  "mips-elf-objcopy": { gluePath: path.join(WASM, "mips-elf-objcopy.mjs") },
  "mips-elf-objdump": { gluePath: path.join(WASM, "mips-elf-objdump.mjs") },
  "mips-linux-gnu-as":      { gluePath: path.join(WASM, "mips-linux-gnu-as.mjs"), fs: "noderawfs" },
  "mips-linux-gnu-ld":      { gluePath: path.join(WASM, "mips-linux-gnu-ld.mjs"), fs: "noderawfs" },
  "mips-linux-gnu-objcopy": { gluePath: path.join(WASM, "mips-linux-gnu-objcopy.mjs"), fs: "noderawfs" },
  "mips-linux-gnu-objdump": { gluePath: path.join(WASM, "mips-linux-gnu-objdump.mjs"), fs: "noderawfs" },
};

export const wasmDir = WASM;
