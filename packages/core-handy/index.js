// @romdev/core-handy — binary package: Handy libretro core (Atari Lynx).
// Exports absolute paths to the bundled WASM so romdev's registry can load
// it via the package (instead of reaching into romdev's own src/).
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WASM = path.join(__dirname, "wasm");

export const platform = "lynx";

// Emulator core (libretro) — glue .js + .wasm.
export const core = {
  name: "handy",
  jsPath: path.join(WASM, "handy_libretro.js"),
  wasmPath: path.join(WASM, "handy_libretro.wasm"),
};
