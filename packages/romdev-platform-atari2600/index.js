// romdev-platform-atari2600 — binary package: stella2014 core + dasm assembler.
// Exports absolute paths to the bundled WASM so romdev's resolvers can load
// them via the package (instead of reaching into romdev's own src/).
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WASM = path.join(__dirname, "wasm");

export const platform = "atari2600";

// Emulator core (libretro) — glue .js + .wasm.
export const core = {
  name: "stella2014",
  jsPath: path.join(WASM, "stella2014_libretro.js"),
  wasmPath: path.join(WASM, "stella2014_libretro.wasm"),
};

// Assembler toolchain — dasm.
export const toolchain = {
  dasm: { gluePath: path.join(WASM, "dasm.js") },
};
