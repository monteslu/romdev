// romdev-core-prosystem — binary package: ProSystem libretro core (Atari 7800).
// Exports absolute paths to the bundled WASM so romdev's registry can load
// it via the package (instead of reaching into romdev's own src/).
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WASM = path.join(__dirname, "wasm");

export const platform = "atari7800";

// Emulator core (libretro) — glue .js + .wasm.
export const core = {
  name: "prosystem",
  jsPath: path.join(WASM, "prosystem_libretro.js"),
  wasmPath: path.join(WASM, "prosystem_libretro.wasm"),
};
