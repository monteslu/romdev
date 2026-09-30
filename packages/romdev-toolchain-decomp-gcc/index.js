// romdev-toolchain-decomp-gcc - binary package: the gcc toolchains N64
// matching-decompilation projects pin, as WASM, one directory per family:
//   wasm/kmc-2.7.2/  gcc (driver), cpp (cccp), cc1, as (binutils 2.6)
// Every module is linked with NODERAWFS (it reads and writes the real
// filesystem); romdevtools' decomp domain (src/decomp/toolchain.js) runs them in
// its WASM worker and supplies the spawn hook the driver runs its passes with.
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const wasmDir = path.join(__dirname, "wasm");
export const families = { "kmc-2.7.2": ["gcc", "cpp", "cc1", "as"] };

/** Directory of one family's modules. */
export function familyDir(family) {
  if (!families[family]) throw new Error(`no decomp gcc family '${family}' (have ${Object.keys(families).join(", ")})`);
  return path.join(wasmDir, family);
}
