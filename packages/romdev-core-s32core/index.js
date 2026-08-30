// romdev-core-s32core — binary package: the sync32 console core.
// Exports absolute paths to the bundled WASM so romdev's registry can load it
// via the package (instead of reaching into romdev's own gitignored src/).
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WASM = path.join(__dirname, "wasm");

export const platform = "sync32";

// Emulator core (libretro) — glue .js + .wasm.
//
// Built with NODERAWFS: the frontend fopen()s the .s32 by its REAL path and
// streams the game's "<romname>/" data directory straight off the host
// filesystem, so a cart's resources are read from disk rather than preloaded
// into MEMFS. That is why the registry marks this core `noderawfs: true`.
export const core = {
  name: "s32core",
  jsPath: path.join(WASM, "s32core_libretro.js"),
  wasmPath: path.join(WASM, "s32core_libretro.wasm"),
};
