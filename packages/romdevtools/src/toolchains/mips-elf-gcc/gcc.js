// mips-elf-gcc — WASM toolchain wrappers for N64 / PS1 C builds.
//
// The full pipeline:
//   runCc1mips({source, headers, options, endian}) → MIPS assembly text (.s)
//   runMipsAs({source, includes, endian})           → .o ELF object
//   runMipsLd({objects, linkScript, endian})         → linked .elf (+ map)
//   runMipsObjcopy({elf})                            → raw .bin
//
// 0.81.0: the 4 stages come from the shared makeGccToolchain() factory
// (common/gcc-toolchain.js); this file is just the MIPS config + thin re-exports.
// Unlike the other arches, MIPS is bi-endian (N64 big, PS1 little) — its cc1 and
// as/ld want DIFFERENT endian flag spellings (cc1: -mel/-meb; as/ld: -EL/-EB), so
// the flags are functions of `endian` (default "big" for N64). MIPS32, ABI o32, -G0.
//
// WASM glue ships in romdev-toolchain-mips-gcc; resolution is lazy + memoized.
import { fileURLToPath } from "node:url";
import path from "node:path";

import { makeGccToolchain } from "../common/gcc-toolchain.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const { runCc1, runAs, runLd, runObjcopy } = makeGccToolchain({
  pkg: "romdev-toolchain-mips-gcc",
  localDir: __dirname,
  label: "mips-elf-gcc",
  glue: {
    cc1: "cc1.mjs",
    as: "mips-elf-as.mjs",
    ld: "mips-elf-ld.mjs",
    objcopy: "mips-elf-objcopy.mjs",
  },
  defaultEndian: "big",
  cc1Flags: (endian) => [endian === "little" ? "-mel" : "-meb", "-mabi=32"],
  asFlags: (endian) => [endian === "little" ? "-EL" : "-EB", "-mabi=32", "-G0"],
  ldFlags: (endian) => [endian === "little" ? "-EL" : "-EB"],
  ldScriptName: "link.ld",
  outputName: "main.bin",
});

/**
 * Compile a C source to MIPS assembly via cc1.
 * @param {{source:string, headers?:Record<string,string>, options?:string[], endian?:"big"|"little"}} args
 * @returns {Promise<{log:string, exitCode:number, asmSource:string|null, crash?:any}>}
 */
export const runCc1mips = runCc1;

/**
 * Assemble MIPS assembly with mips-elf-as.
 * @param {{source:string, includes?:Record<string,string>, binaryIncludes?:Record<string,Uint8Array>, options?:string[], endian?:"big"|"little"}} args
 * @returns {Promise<{log:string, exitCode:number, object:Uint8Array|null, crash?:any}>}
 */
export const runMipsAs = runAs;

/**
 * Link MIPS object files into an ELF executable (+ linker map).
 * @param {{objects:Record<string,Uint8Array>, linkScript:string, libraries?:string[], libraryPaths?:string[], archives?:Record<string,Uint8Array>, options?:string[], endian?:"big"|"little"}} args
 * @returns {Promise<{log:string, exitCode:number, elf:Uint8Array|null, map:string|null, crash?:any}>}
 */
export const runMipsLd = runLd;

/**
 * Strip an ELF down to a raw .bin.
 * @param {{elf:Uint8Array, options?:string[]}} args
 * @returns {Promise<{log:string, exitCode:number, binary:Uint8Array|null, crash?:any}>}
 */
export const runMipsObjcopy = runObjcopy;
