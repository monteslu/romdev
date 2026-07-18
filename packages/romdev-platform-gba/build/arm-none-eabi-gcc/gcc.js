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
// 0.95.0: `makeArmGccTools(env)` lets a host inject `env.runTool` (the browser
// Web Worker seam — see gcc-toolchain.js). The default exports are the no-env
// node tools, exactly as before. NO top-level node imports here: the localDir
// dev fallback is passed as a file: URL (wasm-tool converts on the node side),
// so a browser bundle can load this module untouched.
//
// The WASM glue ships in romdev-platform-gba (155MB, incl. the 135MB cc1-arm);
// resolution is lazy + memoized, so booting never loads it unless a GBA C ROM
// is actually built. ARMv4T (arm7tdmi), thumb-interwork.
import { makeGccToolchain } from "../common/gcc-toolchain.js";

const ARM_FLAGS = ["-mcpu=arm7tdmi", "-mthumb-interwork"];

/**
 * Build the 4 ARM tool runners, optionally over an injected environment.
 * @param {import("../common/gcc-toolchain.js").GccToolchainEnv} [env]
 * @returns {{ runCc1arm:Function, runArmAs:Function, runArmLd:Function, runArmObjcopy:Function }}
 */
export function makeArmGccTools(env) {
  const { runCc1, runAs, runLd, runObjcopy } = makeGccToolchain({
    pkg: "romdev-platform-gba",
    localDir: new URL(".", import.meta.url).href,
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
  }, env);
  return { runCc1arm: runCc1, runArmAs: runAs, runArmLd: runLd, runArmObjcopy: runObjcopy };
}

const defaultTools = makeArmGccTools();

/**
 * Compile a C source to ARM assembly via cc1.
 * @param {{source:string, headers?:Record<string,string>, options?:string[]}} args
 * @returns {Promise<{log:string, exitCode:number, asmSource:string|null, crash?:any}>}
 */
export const runCc1arm = defaultTools.runCc1arm;

/**
 * Assemble ARM assembly with arm-none-eabi-as.
 * @param {{source:string, includes?:Record<string,string>, binaryIncludes?:Record<string,Uint8Array>, options?:string[]}} args
 * @returns {Promise<{log:string, exitCode:number, object:Uint8Array|null, crash?:any}>}
 */
export const runArmAs = defaultTools.runArmAs;

/**
 * Link ARM object files into an ELF executable (+ linker map).
 * @param {{objects:Record<string,Uint8Array>, linkScript:string, libraries?:string[], libraryPaths?:string[], archives?:Record<string,Uint8Array>, options?:string[]}} args
 * @returns {Promise<{log:string, exitCode:number, elf:Uint8Array|null, map:string|null, crash?:any}>}
 */
export const runArmLd = defaultTools.runArmLd;

/**
 * Strip an ELF down to a raw .gba ROM.
 * @param {{elf:Uint8Array, options?:string[]}} args
 * @returns {Promise<{log:string, exitCode:number, binary:Uint8Array|null, crash?:any}>}
 */
export const runArmObjcopy = defaultTools.runArmObjcopy;
