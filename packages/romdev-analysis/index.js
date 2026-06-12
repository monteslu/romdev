// romdev-analysis — binary package: Rizin RE analysis engine.
// Exports absolute paths to the bundled WASM so romdev can load it via the
// package (instead of reaching into romdev's own src/). Driven one-shot
// ("rizin -q -c '<cmds>' rom") through romdev's WASM worker pool.
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WASM = path.join(__dirname, "wasm");

// Rizin CLI — glue .js + .wasm (MODULARIZE/ES6, Node-only, single-threaded).
export const rizin = {
  name: "rizin",
  jsPath: path.join(WASM, "rizin.js"),
  wasmPath: path.join(WASM, "rizin.wasm"),
};
