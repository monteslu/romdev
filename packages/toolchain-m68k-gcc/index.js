// @romdev/toolchain-m68k-gcc — binary package: m68k-elf gcc backend
// (cc1-m68k), assembler, linker, objcopy (WASM). emcc emits ESM
// (EXPORT_ES6=1) so the glue uses .mjs extensions.
// Exports absolute paths to the bundled WASM so romdev's resolver can load
// them via the package.
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WASM = path.join(__dirname, "wasm");

// Compiler backend / assembler / linker / objcopy — m68k-elf gcc family.
export const toolchain = {
  "cc1-m68k": { gluePath: path.join(WASM, "cc1-m68k.mjs") },
  "m68k-elf-as": { gluePath: path.join(WASM, "m68k-elf-as.mjs") },
  "m68k-elf-ld": { gluePath: path.join(WASM, "m68k-elf-ld.mjs") },
  "m68k-elf-objcopy": { gluePath: path.join(WASM, "m68k-elf-objcopy.mjs") },
};
