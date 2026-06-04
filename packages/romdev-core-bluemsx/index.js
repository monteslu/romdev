// romdev-core-bluemsx — binary package: blueMSX libretro core (MSX / MSX2).
// Exports the WASM core paths AND the C-BIOS directory. C-BIOS (2-clause BSD)
// is the open-source MSX BIOS that lets cartridge homebrew boot with no
// proprietary ROM; romdev points blueMSX at the `… - C-BIOS` machine config.
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WASM = path.join(__dirname, "wasm");

// MSX2 C-BIOS is the default machine (superset — also runs MSX1 carts). An
// `msx1` id can be added later, same core.
export const platforms = ["msx"];

export const core = {
  name: "bluemsx",
  jsPath: path.join(WASM, "bluemsx_libretro.js"),
  wasmPath: path.join(WASM, "bluemsx_libretro.wasm"),
};

// Directory holding the C-BIOS .rom files the core loads at boot (populated by
// scripts/build-bluemsx.sh from the C-BIOS release).
export const biosDir = path.join(__dirname, "bios");
