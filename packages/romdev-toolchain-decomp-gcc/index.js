// romdev-toolchain-decomp-gcc - binary package: the gcc toolchains N64
// and PS1 matching-decompilation projects pin, as WASM, one directory per family, and
// the command-line tools their builds run:
//   wasm/kmc-2.7.2/            gcc (driver), cpp (cccp), cc1, as (binutils 2.6)
//   wasm/egcs-1.1.2/           gcc (driver), cpp (cccp), cc1, as (binutils 2.9.5)
//   wasm/psx-gcc-2.6.3/        cc1, cpp (cccp): PS1 gcc 2.6.3-psx
//   wasm/mips-linux-gnu-14.2/  gcc (driver), cpp, cc1 (assembles with
//                              romdev-toolchain-mips-gcc's mips-linux-gnu-as)
//   wasm/tools/                slinky-cli, pigment64, crunch64, raw-deflate
// Every module is linked with NODERAWFS (it reads and writes the real
// filesystem); romdevtools' decomp domain (src/decomp/toolchain.js) runs them in
// its WASM worker and supplies the spawn hook the driver runs its passes with.
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const wasmDir = path.join(__dirname, "wasm");
export const families = {
  "kmc-2.7.2": ["gcc", "cpp", "cc1", "as"],
  "egcs-1.1.2": ["gcc", "cpp", "cc1", "as"],
  "psx-gcc-2.6.3": ["cc1", "cpp"],
  "mips-linux-gnu-14.2": ["gcc", "cpp", "cc1"],
};
export const tools = ["slinky-cli", "pigment64", "crunch64", "raw-deflate"];

/** Directory of one family's modules. */
export function familyDir(family) {
  if (!families[family]) throw new Error(`no decomp gcc family '${family}' (have ${Object.keys(families).join(", ")})`);
  return path.join(wasmDir, family);
}
