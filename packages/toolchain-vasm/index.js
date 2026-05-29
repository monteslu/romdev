// @romdev/toolchain-vasm — binary package: vasm m68k assembler
// (Motorola syntax, Genesis dev), bundled as WASM.
// Exports absolute paths to the bundled WASM so romdev's resolver can load
// it via the package.
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WASM = path.join(__dirname, "wasm");

// Assembler toolchain — vasm68k.
export const toolchain = {
  vasm68k: { gluePath: path.join(WASM, "vasm68k.js") },
};
