// romdev-core-flycast — binary package: Flycast libretro core (Dreamcast).
// A CUSTOM romdev build: the upstream core compiled to single-threaded WASM (the
// SH-4/ARM/DSP interpreters, no JIT), with worker-thread creation neutered
// (pthread_create no-op), ThreadedRendering forced off, and the reios HLE BIOS
// defaulted on so a raw homebrew .elf boots directly. PowerVR2 renders through
// WebGL2 (GL_ENABLE_GET_PROC_ADDRESS); flycast_emulate_framebuffer scans out a
// direct 2D framebuffer. Built reproducibly by scripts/build-flycast.sh.
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WASM = path.join(__dirname, "wasm");

export const platform = "dreamcast";

// Emulator core (libretro) — glue .js + .wasm.
export const core = {
  name: "flycast",
  jsPath: path.join(WASM, "flycast_libretro.js"),
  wasmPath: path.join(WASM, "flycast_libretro.wasm"),
};
