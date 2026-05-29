// romdev-core-gambatte — binary package: gambatte libretro core (GB / GBC).
// Exports absolute paths to the bundled WASM so romdev's registry can load
// it via the package (instead of reaching into romdev's own src/).
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WASM = path.join(__dirname, "wasm");

export const platform = "gb";

// Emulator core (libretro) — glue .js + .wasm.
export const core = {
  name: "gambatte",
  jsPath: path.join(WASM, "gambatte_libretro.js"),
  wasmPath: path.join(WASM, "gambatte_libretro.wasm"),
};
