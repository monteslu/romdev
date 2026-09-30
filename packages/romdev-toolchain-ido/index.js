// romdev-toolchain-ido - binary package: IRIX IDO 5.3 / 7.1 compiler programs
// as WASM, one module per IRIX program under wasm/<version>/. Every module is
// linked with NODERAWFS (it reads and writes the real filesystem) and expects
// romdev's driver (romdevtools src/decomp/wasm-run.js) to supply the spawn hook
// cc uses to run its passes. err.english.cc sits beside the modules: cc finds
// it, and its passes, through the USR_LIB environment variable.
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const wasmDir = path.join(__dirname, "wasm");
export const versions = ["5.3", "7.1"];
export const programs = ["cc", "acpp", "cfe", "uopt", "ugen", "as0", "as1", "ujoin", "uld", "umerge", "usplit"];

/** Directory of one IDO version's modules. */
export function versionDir(version) {
  if (!versions.includes(version)) throw new Error(`IDO ${version} is not shipped (have ${versions.join(", ")})`);
  return path.join(wasmDir, version);
}
