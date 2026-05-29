// @romdev/toolchain-rgbds — binary package: RGBDS Game Boy assembler +
// linker + fix tool (WASM).
// Exports absolute paths to the bundled WASM so romdev's resolver can load
// them via the package.
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WASM = path.join(__dirname, "wasm");

// Assembler / linker / fix tool — RGBDS family.
export const toolchain = {
  rgbasm: { gluePath: path.join(WASM, "rgbasm.js") },
  rgblink: { gluePath: path.join(WASM, "rgblink.js") },
  rgbfix: { gluePath: path.join(WASM, "rgbfix.js") },
};
