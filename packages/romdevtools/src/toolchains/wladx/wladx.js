// wla-dx — WLA-DX assembler + wlalink linker, 65816 (SNES) variant.
//
// Two stages:
//   1. wla-65816  → assembles .asm → .o object file
//   2. wlalink    → links one or more .o + a [objects] linkfile → SNES ROM
//
// Bundled as WASM via scripts/build-wladx.sh. The build is two-stage
// (native generator then WASM library); see that script for details.
//
// Used by the SNES C build pipeline (R15): tcc-65816 emits wla-dx
// assembly, which we assemble with wla-65816 and link with wlalink.
// See `src/toolchains/index.js` SNES dispatch.

import { fileURLToPath } from "node:url";
import path from "node:path";

import { runIsolated, textFile, binaryFile, getOutputBytes } from "../_worker/run.js";
import { makeGlueResolver } from "../common/wasm-tool.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// wla-dx's WASM ships in romdev-platform-snes (the SNES platform is the only
// consumer); a local src/ copy is the dev fallback. Lazy + memoized per tool:
// resolve only on the first wla-dx (SNES asm) build that uses each tool, not at
// module load.
const wladxGlue = makeGlueResolver({ pkg: "romdev-platform-snes", localDir: __dirname, label: "wla-dx" });

/**
 * Assemble a single .asm source with wla-65816.
 *
 * @param {Object} args
 * @param {string} args.source main .asm source text
 * @param {Record<string, string>} [args.includes] virtual .inc / .asm includes
 * @param {Record<string, Uint8Array|string>} [args.binaryIncludes] for .incbin
 * @param {string[]} [args.options] extra flags
 * @returns {Promise<{log:string, exitCode:number, object:Uint8Array|null, crash?:any}>}
 */
export async function runWla65816(args) {
  const { source, options = [] } = args;
  const includes = args.includes ?? {};
  const binaryIncludes = args.binaryIncludes ?? {};
  /** @type {import("../_worker/run.js").InputFile[]} */
  const inputFiles = [textFile("/work/main.asm", source)];
  for (const [name, content] of Object.entries(includes)) {
    inputFiles.push(textFile("/work/" + name, content));
  }
  for (const [name, blob] of Object.entries(binaryIncludes)) {
    const bytes = blob instanceof Uint8Array ? blob : Buffer.from(blob, "base64");
    inputFiles.push(binaryFile("/work/" + name, bytes));
  }
  const argv = [
    "-I", "/work",   // wla-dx needs explicit include search dirs; mount /work
    "-x",            // enable WLA_FILENAME / WLA_TIME / WLA_VERSION substitutions
                     // (tcc-65816 output uses {WLA_FILENAME} in section names so each
                     // translation unit gets unique SECTION/RAMSECTION labels)
    ...options,
    "-o", "/work/main.o",
    "/work/main.asm",
  ];
  const r = await runIsolated({
    gluePath: wladxGlue("wla-65816.js"),
    argv,
    inputFiles,
    outputFiles: [{ vfsPath: "/work/main.o", encoding: "base64" }],
  });
  return {
    log: r.log,
    exitCode: r.exitCode,
    object: getOutputBytes(r, "/work/main.o"),
    ...(r.crash ? { crash: r.crash, stage: "crash" } : {}),
  };
}

/**
 * Link object files + a [objects] linkfile into a SNES ROM with wlalink.
 *
 * @param {Object} args
 * @param {Record<string, Uint8Array>} args.objects map of name → .o bytes
 * @param {string} args.linkfile WLA-DX linkfile contents ([objects] etc.)
 * @param {string[]} [args.options] extra flags (default ["-b"] for program output)
 * @returns {Promise<{log:string, exitCode:number, binary:Uint8Array|null, crash?:any}>}
 */
export async function runWlalink(args) {
  const { objects, linkfile, options = ["-b"] } = args;
  /** @type {import("../_worker/run.js").InputFile[]} */
  const inputFiles = [textFile("/work/link.txt", linkfile)];
  for (const [name, bytes] of Object.entries(objects)) {
    inputFiles.push(binaryFile("/work/" + name, bytes));
  }
  const argv = [
    ...options,
    "/work/link.txt",
    "/work/out.smc",
  ];
  const r = await runIsolated({
    gluePath: wladxGlue("wlalink.js"),
    argv,
    inputFiles,
    outputFiles: [{ vfsPath: "/work/out.smc", encoding: "base64" }],
  });
  return {
    log: r.log,
    exitCode: r.exitCode,
    binary: getOutputBytes(r, "/work/out.smc"),
    ...(r.crash ? { crash: r.crash, stage: "crash" } : {}),
  };
}
