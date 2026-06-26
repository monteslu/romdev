// romdev-core-pcsx-rearmed — binary package: PCSX-ReARMed libretro core (PS1).
// Software renderer + built-in HLE BIOS (no firmware to ship, no GL dependency).
// This is a CUSTOM romdev build: the upstream core plus romdev's debug exports
// (romdev_mips_regs_get, the watchpoint/pcbreak/range live-debug set, romdev_spu_get
// for the SPU, romdev_pad_get for SIO, romdev_vram_get for the GPU framebuffer).
// Built reproducibly by scripts/build-pcsx-rearmed.sh.
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WASM = path.join(__dirname, "wasm");

export const platform = "ps1";

// Emulator core (libretro) — glue .js + .wasm.
export const core = {
  name: "pcsx_rearmed",
  jsPath: path.join(WASM, "pcsx_rearmed_libretro.js"),
  wasmPath: path.join(WASM, "pcsx_rearmed_libretro.wasm"),
};
