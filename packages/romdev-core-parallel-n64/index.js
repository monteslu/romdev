// romdev-core-parallel-n64 - binary package: ParaLLEl-N64 libretro core (N64).
// GL-rendered build: the RDP runs on the real GPU through glide64 (GL HLE) and
// romdev-core-host's native-gles bridge. CUSTOM romdev build: upstream core + romdev's debug exports
// (romdev_mips_regs_get, watchpoint/pcbreak/range live-debug, romdev_ai_get for the
// Audio Interface) + a clean-room IPL3 so build({platform:n64}) self-boots.
// Built reproducibly by scripts/build-parallel-n64.sh.
//
// Loaded with hwRender:true (glide64 renders into the host's GL framebuffer).
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WASM = path.join(__dirname, "wasm");

export const platform = "n64";

// Emulator core (libretro) - glue .js + .wasm. GL renderer (glide64).
export const core = {
  name: "parallel_n64",
  jsPath: path.join(WASM, "parallel_n64_libretro.js"),
  wasmPath: path.join(WASM, "parallel_n64_libretro.wasm"),
  hwRender: true,
};
