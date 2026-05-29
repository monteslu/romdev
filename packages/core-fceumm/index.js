// @romdev/core-fceumm — binary package: fceumm libretro core (NES).
// Exports absolute paths to the bundled WASM so romdev's registry can load
// it via the package (instead of reaching into romdev's own src/).
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WASM = path.join(__dirname, "wasm");

export const platform = "nes";

// Emulator core (libretro) — glue .js + .wasm.
export const core = {
  name: "fceumm",
  jsPath: path.join(WASM, "fceumm_libretro.js"),
  wasmPath: path.join(WASM, "fceumm_libretro.wasm"),
};
