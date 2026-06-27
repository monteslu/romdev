// romdev-core-beetle-psx-hw — binary package: Beetle PSX HW libretro core (PlayStation).
// mednafen PSX with the GLES3/WebGL2 HARDWARE renderer → rendered on the real GPU through
// native-gles (the host's WebGL2 bridge), like glide64-N64 + Flycast-DC. Ships with
// OpenBIOS EMBEDDED (PCSX-Redux, MIT, region-free) — no copyrighted Sony firmware, no BIOS
// file to supply. Built reproducibly by scripts/build-beetle-psx-hw.sh.
import { fileURLToPath } from "node:url";
import path from "node:path";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WASM = path.join(__dirname, "wasm");
export const platform = "ps1";
export const core = {
  name: "beetle_psx_hw",
  jsPath: path.join(WASM, "beetle_psx_hw_libretro.js"),
  wasmPath: path.join(WASM, "beetle_psx_hw_libretro.wasm"),
};
