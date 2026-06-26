// romdev-core-parallel-n64 — binary package: ParaLLEl-N64 libretro core (N64).
// HEADLESS-ANGRYLION software build: GL is compiled OUT and the angrylion software
// RDP is forced, so raw CPU-rendered VI framebuffers DISPLAY (the GL/glide64 build
// only presents RDP display-lists). This is what lets romdev's software-3D homebrew
// render. CUSTOM romdev build: upstream core + romdev's debug exports
// (romdev_mips_regs_get, watchpoint/pcbreak/range live-debug, romdev_ai_get for the
// Audio Interface) + a clean-room IPL3 so build({platform:n64}) self-boots.
// Built reproducibly by scripts/build-parallel-n64.sh.
//
// Loaded with hwRender:false (the renderer presents via video_cb, not a GL FBO).
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WASM = path.join(__dirname, "wasm");

export const platform = "n64";

// Emulator core (libretro) — glue .js + .wasm. Software renderer (no GL bridge).
export const core = {
  name: "parallel_n64",
  jsPath: path.join(WASM, "parallel_n64_libretro.js"),
  wasmPath: path.join(WASM, "parallel_n64_libretro.wasm"),
  hwRender: false,
};
