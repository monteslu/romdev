// @romdev/core-gpgx — binary package: Genesis Plus GX libretro core
// (Genesis / Master System / Game Gear).
// Exports absolute paths to the bundled WASM so romdev's registry can load
// it via the package (instead of reaching into romdev's own src/).
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WASM = path.join(__dirname, "wasm");

export const platform = "genesis";

// Emulator core (libretro) — glue .js + .wasm.
export const core = {
  name: "genesis_plus_gx",
  jsPath: path.join(WASM, "genesis_plus_gx_libretro.js"),
  wasmPath: path.join(WASM, "genesis_plus_gx_libretro.wasm"),
};
