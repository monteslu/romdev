// sh-elf-gcc — WASM toolchain wrappers for Dreamcast (SH-4) C builds.
//
// The full pipeline:
//   runCc1sh({source, headers, options})  → SH assembly text (.s)
//   runShAs({source, includes})            → .o ELF object
//   runShLd({objects, linkScript})         → linked .elf (+ map)
//   runShObjcopy({elf})                    → raw .bin
//
// 0.81.0: the 4 stages come from the shared makeGccToolchain() factory
// (common/gcc-toolchain.js); this file is just the SH-4 config + thin re-exports.
// SH-4 little-endian, single-precision FP only (-m4-single-only at the cc1 level;
// --isa=sh4 at as; -EL at ld). NOTE: callers should default cc1 to -O1, not -O2 —
// the sh-elf cc1.wasm has an -O2-only pass that aborts on common control flow; that
// default lives in the sh-c builder, not here (this wrapper passes options through).
//
// WASM glue ships in romdev-toolchain-sh-gcc; resolution is lazy + memoized.
import { fileURLToPath } from "node:url";
import path from "node:path";

import { makeGccToolchain } from "../common/gcc-toolchain.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const { runCc1, runAs, runLd, runObjcopy } = makeGccToolchain({
  pkg: "romdev-toolchain-sh-gcc",
  localDir: __dirname,
  label: "sh-elf-gcc",
  glue: {
    cc1: "cc1.mjs",
    as: "sh-elf-as.mjs",
    ld: "sh-elf-ld.mjs",
    objcopy: "sh-elf-objcopy.mjs",
  },
  cc1Flags: ["-ml", "-m4-single-only"],
  asFlags: ["-little", "--isa=sh4"],
  ldFlags: ["-EL"],
  ldScriptName: "link.ld",
  outputName: "main.bin",
});

/**
 * Compile a C source to SH assembly via cc1.
 * @param {{source:string, headers?:Record<string,string>, options?:string[]}} args
 * @returns {Promise<{log:string, exitCode:number, asmSource:string|null, crash?:any}>}
 */
export const runCc1sh = runCc1;

/**
 * Assemble SH assembly with sh-elf-as.
 * @param {{source:string, includes?:Record<string,string>, binaryIncludes?:Record<string,Uint8Array>, options?:string[]}} args
 * @returns {Promise<{log:string, exitCode:number, object:Uint8Array|null, crash?:any}>}
 */
export const runShAs = runAs;

/**
 * Link SH object files into an ELF executable (+ linker map).
 * @param {{objects:Record<string,Uint8Array>, linkScript:string, libraries?:string[], libraryPaths?:string[], archives?:Record<string,Uint8Array>, options?:string[]}} args
 * @returns {Promise<{log:string, exitCode:number, elf:Uint8Array|null, map:string|null, crash?:any}>}
 */
export const runShLd = runLd;

/**
 * Strip an ELF down to a raw .bin.
 * @param {{elf:Uint8Array, options?:string[]}} args
 * @returns {Promise<{log:string, exitCode:number, binary:Uint8Array|null, crash?:any}>}
 */
export const runShObjcopy = runObjcopy;
