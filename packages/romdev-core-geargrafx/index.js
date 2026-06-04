// romdev-core-geargrafx — binary package: Geargrafx libretro core (PC Engine /
// TurboGrafx-16). Exports absolute paths to the bundled WASM for romdev's
// registry. PCE carts boot directly — no BIOS ROM needed.
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WASM = path.join(__dirname, "wasm");

export const platform = "pce";

export const core = {
  name: "geargrafx",
  jsPath: path.join(WASM, "geargrafx_libretro.js"),
  wasmPath: path.join(WASM, "geargrafx_libretro.wasm"),
};
