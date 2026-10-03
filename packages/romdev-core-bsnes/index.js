// romdev-core-bsnes - binary package: the bsnes libretro core (SNES), built
// by romdevtools/scripts/build-bsnes.sh. Not loadMedia's default SNES core
// (that is snes9x): romdev's registry lists it in ALT_CORES as the accuracy
// reference for the coprocessors that run firmware, which a caller names with
// loadMedia({core:'bsnes'}) or verifyRecompile({referenceCore:'bsnes'}). The
// ST011 / ST018 need their firmware (st011.rom / st018.rom) in the core's
// system directory. GPL-3.0.
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WASM = path.join(__dirname, "wasm");

export const platform = "snes";

export const core = {
  name: "bsnes",
  jsPath: path.join(WASM, "bsnes_libretro.js"),
  wasmPath: path.join(WASM, "bsnes_libretro.wasm"),
};
