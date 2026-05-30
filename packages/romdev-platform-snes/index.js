// romdev-platform-snes — binary package: snes9x core + asar / tcc816 /
// wla-dx (wla-65816 + wlalink) toolchains. These ship together because the
// SNES platform is the only consumer of all of them.
// Exports absolute paths to the bundled WASM so romdev's resolvers can load
// them via the package (instead of reaching into romdev's own src/).
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WASM = path.join(__dirname, "wasm");

export const platform = "snes";

// Emulator core (libretro) — glue .js + .wasm.
export const core = {
  name: "snes9x",
  jsPath: path.join(WASM, "snes9x_libretro.js"),
  wasmPath: path.join(WASM, "snes9x_libretro.wasm"),
};

// Assembler / compiler / linker toolchains for SNES dev.
export const toolchain = {
  asar: { gluePath: path.join(WASM, "asar.js") },
  tcc816: { gluePath: path.join(WASM, "tcc816.js") },
  "wla-65816": { gluePath: path.join(WASM, "wla-65816.js") },
  wlalink: { gluePath: path.join(WASM, "wlalink.js") },
};
