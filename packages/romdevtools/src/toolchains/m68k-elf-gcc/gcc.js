// m68k-elf-gcc — WASM toolchain wrappers for Genesis C builds.
//
// The full pipeline:
//   runCc1m68k({source, headers, options}) → m68k assembly text (.s)
//   runM68kAs({source, includes})           → .o ELF object
//   runM68kLd({objects, linkScript})         → linked .elf (+ map)
//   runM68kObjcopy({elf})                    → raw .bin Genesis ROM
//
// 0.81.0: the 4 stages are now produced by the shared makeGccToolchain() factory
// (common/gcc-toolchain.js) — every arch's cc1/as/ld/objcopy share the same
// input-marshalling + runIsolated + output-decoding; this file is just the m68k
// CONFIG (glue names, arch flags, link-script name, ROM extension) + thin named
// re-exports so existing call sites keep their runM68k* names.
//
// The WASM glue ships in romdev-toolchain-m68k-gcc (20MB); resolution is lazy +
// memoized, so booting the server never loads it unless a Genesis C ROM is built.
import { fileURLToPath } from "node:url";
import path from "node:path";

import { makeGccToolchain } from "../common/gcc-toolchain.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const { runCc1, runAs, runLd, runObjcopy } = makeGccToolchain({
  pkg: "romdev-toolchain-m68k-gcc",
  localDir: __dirname,
  label: "m68k-elf-gcc",
  glue: {
    cc1: "cc1-m68k.mjs",
    as: "m68k-elf-as.mjs",
    ld: "m68k-elf-ld.mjs",
    objcopy: "m68k-elf-objcopy.mjs",
  },
  // Genesis is always a bare 68000 (no 68020+).
  cc1Flags: ["-mcpu=68000"],
  asFlags: ["-march=68000"],
  ldScriptName: "genesis.ld",
  outputName: "main.bin",
});

/**
 * Compile a C source to m68k assembly via cc1.
 * @param {{source:string, headers?:Record<string,string>, options?:string[]}} args
 * @returns {Promise<{log:string, exitCode:number, asmSource:string|null, crash?:any}>}
 */
export const runCc1m68k = runCc1;

/**
 * Assemble m68k assembly with m68k-elf-as.
 * @param {{source:string, includes?:Record<string,string>, binaryIncludes?:Record<string,Uint8Array>, options?:string[]}} args
 * @returns {Promise<{log:string, exitCode:number, object:Uint8Array|null, crash?:any}>}
 */
export const runM68kAs = runAs;

/**
 * Link m68k object files into an ELF executable (+ linker map).
 * @param {{objects:Record<string,Uint8Array>, linkScript:string, libraries?:string[], libraryPaths?:string[], archives?:Record<string,Uint8Array>, options?:string[]}} args
 * @returns {Promise<{log:string, exitCode:number, elf:Uint8Array|null, map:string|null, crash?:any}>}
 */
export const runM68kLd = runLd;

/**
 * Strip an ELF down to a raw .bin (the Genesis ROM format).
 * @param {{elf:Uint8Array, options?:string[]}} args
 * @returns {Promise<{log:string, exitCode:number, binary:Uint8Array|null, crash?:any}>}
 */
export const runM68kObjcopy = runObjcopy;
