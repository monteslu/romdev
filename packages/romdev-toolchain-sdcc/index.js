// romdev-toolchain-sdcc — binary package: SDCC C compiler + assemblers +
// linker + preprocessor (WASM), plus the sdcc target share/ tree (include +
// per-port lib) the compiler/linker need.
// Exports absolute paths to the bundled WASM + the share dir so romdev's
// resolver can load them via the package.
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WASM = path.join(__dirname, "wasm");

// share/sdcc/{include,lib/<port>} — mounted into MEMFS at call time.
export const shareDir = path.join(__dirname, "share", "sdcc");

// Compiler / assemblers / linker / preprocessor — SDCC family.
export const toolchain = {
  sdcc: { gluePath: path.join(WASM, "sdcc.js") },
  sdasgb: { gluePath: path.join(WASM, "sdasgb.js") },
  sdasz80: { gluePath: path.join(WASM, "sdasz80.js") },
  sdld: { gluePath: path.join(WASM, "sdld.js") },
  mcpp: { gluePath: path.join(WASM, "mcpp.js") },
};
