// arm-none-eabi-gcc — WASM toolchain wrappers for GBA C builds.
//
// The full pipeline:
//   runCc1arm({source, headers, options}) → ARM assembly text (.s)
//   runArmAs({source, includes})           → .o ELF object
//   runArmLd({objects, linkScript})        → linked .elf (+ map)
//   runArmObjcopy({elf})                   → raw .gba ROM
//
// 0.81.0: the 4 stages come from the shared makeGccToolchain() factory
// (common/gcc-toolchain.js); this file is just the ARM config + thin re-exports
// so existing call sites keep their runArm*/runCc1arm names.
//
// The WASM glue ships in romdev-platform-gba (155MB, incl. the 135MB cc1-arm);
// resolution is lazy + memoized, so booting never loads it unless a GBA C ROM
// is actually built. ARMv4T (arm7tdmi), thumb-interwork.
import { fileURLToPath } from "node:url";
import path from "node:path";

import { makeGccToolchain } from "../common/gcc-toolchain.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ARM_FLAGS = ["-mcpu=arm7tdmi", "-mthumb-interwork"];

const { runCc1, runAs, runLd, runObjcopy } = makeGccToolchain({
  pkg: "romdev-platform-gba",
  localDir: __dirname,
  label: "arm-none-eabi-gcc",
  glue: {
    cc1: "cc1-arm.mjs",
    as: "arm-none-eabi-as.mjs",
    ld: "arm-none-eabi-ld.mjs",
    objcopy: "arm-none-eabi-objcopy.mjs",
  },
  cc1Flags: ARM_FLAGS,
  asFlags: ARM_FLAGS,
  ldScriptName: "gba.ld",
  outputName: "main.gba",
});

/**
 * Compile a C source to ARM assembly via cc1.
 * @param {{source:string, headers?:Record<string,string>, options?:string[]}} args
 * @returns {Promise<{log:string, exitCode:number, asmSource:string|null, crash?:any}>}
 */
export const runCc1arm = runCc1;

/**
 * Assemble ARM assembly with arm-none-eabi-as.
 * @param {{source:string, includes?:Record<string,string>, binaryIncludes?:Record<string,Uint8Array>, options?:string[]}} args
 * @returns {Promise<{log:string, exitCode:number, object:Uint8Array|null, crash?:any}>}
 */
export const runArmAs = runAs;

/**
 * Link ARM object files into an ELF executable (+ linker map).
 * @param {{objects:Record<string,Uint8Array>, linkScript:string, libraries?:string[], libraryPaths?:string[], archives?:Record<string,Uint8Array>, options?:string[]}} args
 * @returns {Promise<{log:string, exitCode:number, elf:Uint8Array|null, map:string|null, crash?:any}>}
 */
export const runArmLd = runLd;

/**
 * Strip an ELF down to a raw .gba ROM.
 * @param {{elf:Uint8Array, options?:string[]}} args
 * @returns {Promise<{log:string, exitCode:number, binary:Uint8Array|null, crash?:any}>}
 */
export const runArmObjcopy = runObjcopy;
