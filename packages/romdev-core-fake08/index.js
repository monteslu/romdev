// romdev-core-fake08 — binary package: FAKE-08 libretro core (PICO-8 player).
// Exports absolute paths to the bundled WASM so romdev's registry can load it via
// the package (instead of reaching into romdev's own src/). FAKE-08 is MIT-licensed
// and needs NO BIOS; it runs .p8 (Lua) and .p8.png carts at 128×128.
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WASM = path.join(__dirname, "wasm");

export const platform = "pico8";

// Emulator core (libretro) — glue .js + .wasm.
export const core = {
  name: "fake08",
  jsPath: path.join(WASM, "fake08_libretro.js"),
  wasmPath: path.join(WASM, "fake08_libretro.wasm"),
};
