// @romdev/core-vice — binary package: VICE x64 libretro core (Commodore 64).
// Exports absolute paths to the bundled WASM so romdev's registry can load
// it via the package (instead of reaching into romdev's own src/).
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WASM = path.join(__dirname, "wasm");

export const platform = "c64";

// Emulator core (libretro) — glue .js + .wasm.
export const core = {
  name: "vice_x64",
  jsPath: path.join(WASM, "vice_x64_libretro.js"),
  wasmPath: path.join(WASM, "vice_x64_libretro.wasm"),
};
