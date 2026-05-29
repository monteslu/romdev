// @romdev/platform-gba — binary package: mGBA core + arm-none-eabi-gcc
// toolchain (cc1-arm + as + ld + objcopy). These ship together because the
// GBA platform is the only consumer of the toolchain. emcc emits ESM
// (EXPORT_ES6=1) for the gcc tools so their glue uses .mjs extensions.
// Exports absolute paths to the bundled WASM so romdev's resolvers can load
// them via the package (instead of reaching into romdev's own src/).
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WASM = path.join(__dirname, "wasm");

export const platform = "gba";

// Emulator core (libretro) — glue .js + .wasm.
export const core = {
  name: "mgba",
  jsPath: path.join(WASM, "mgba_libretro.js"),
  wasmPath: path.join(WASM, "mgba_libretro.wasm"),
};

// Compiler backend / assembler / linker / objcopy — arm-none-eabi gcc family.
export const toolchain = {
  "cc1-arm": { gluePath: path.join(WASM, "cc1-arm.mjs") },
  "arm-none-eabi-as": { gluePath: path.join(WASM, "arm-none-eabi-as.mjs") },
  "arm-none-eabi-ld": { gluePath: path.join(WASM, "arm-none-eabi-ld.mjs") },
  "arm-none-eabi-objcopy": { gluePath: path.join(WASM, "arm-none-eabi-objcopy.mjs") },
};
