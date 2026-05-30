// arm-none-eabi-gcc — WASM toolchain wrappers for GBA C builds.
//
// Mirrors src/toolchains/m68k-elf-gcc/gcc.js. The GBA target uses
// ARM7TDMI in Thumb-interwork mode by default (matches libgba's
// expectations).
//
// Pipeline:
//   runCc1arm({source, headers, options})   → ARM assembly text (.s)
//   runArmAs({asmSource, includes})         → .o ELF object
//   runArmLd({objects, linkScript})         → linked .elf
//   runArmObjcopy({elf})                    → raw .gba ROM
//
// Each step runs as a WASM module through the worker pool (R12
// crash isolation). The WASM tools live under wasm/ (cc1-arm.{mjs,wasm}
// etc.). emcc emits ESM (EXPORT_ES6=1) so we use .mjs extensions.

import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import path from "node:path";

import { runIsolated, textFile, binaryFile, getOutputBytes, getOutputText } from "../_worker/run.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// arm-none-eabi-gcc's WASM ships in romdev-platform-gba (the GBA platform is
// the only consumer). Resolve each tool's glue from that package; fall back to
// a local copy under src/ if present (transition / dev). emcc emits ESM
// (EXPORT_ES6=1) so the glue uses .mjs extensions. The package is a hard dep
// of romdev.
function resolveArmGlue(file) {
  try {
    const u = import.meta.resolve("romdev-platform-gba");
    const p = path.join(path.dirname(fileURLToPath(u)), "wasm", file);
    if (existsSync(p)) return p;
  } catch { /* package not resolvable — fall through to local */ }
  const local = path.join(__dirname, "wasm", file);
  if (existsSync(local)) return local;
  throw new Error(`arm-none-eabi-gcc WASM (${file}) not found — install romdev-platform-gba`);
}

// Lazy + memoized per tool: resolve only on the first GBA-C build that uses
// each tool, not at module load — so booting the server never touches this
// (155MB, incl. the 135MB cc1-arm) package unless a GBA C ROM is actually built.
const _glue = {};
const armGlue = (file) => (_glue[file] ??= resolveArmGlue(file));

/**
 * Compile a C source to ARM assembly via cc1.
 *
 * @param {Object} args
 * @param {string} args.source main C source text
 * @param {Record<string, string>} [args.headers] virtual headers visible via -I/work
 * @param {string[]} [args.options] extra cc1 flags
 * @returns {Promise<{log:string, exitCode:number, asmSource:string|null, crash?:any}>}
 */
export async function runCc1arm(args) {
  const { source, options = [] } = args;
  const headers = args.headers ?? {};
  /** @type {import("../_worker/run.js").InputFile[]} */
  const inputFiles = [textFile("/work/main.c", source)];
  for (const [name, content] of Object.entries(headers)) {
    inputFiles.push(textFile("/work/" + name, content));
  }
  const argv = [
    // GBA = ARM7TDMI. Thumb-interwork allows mixed ARM/Thumb code.
    "-mcpu=arm7tdmi",
    "-mthumb-interwork",
    "-iquote", "/work",
    "-I", "/work",
    ...options,
    "/work/main.c",
    "-o", "/work/main.s",
  ];
  const r = await runIsolated({
    gluePath: armGlue("cc1-arm.mjs"),
    argv,
    inputFiles,
    outputFiles: [{ vfsPath: "/work/main.s", encoding: "utf8" }],
  });
  return {
    log: r.log,
    exitCode: r.exitCode,
    asmSource: getOutputText(r, "/work/main.s") || null,
    ...(r.crash ? { crash: r.crash, stage: "crash" } : {}),
  };
}

/**
 * Assemble ARM assembly with arm-none-eabi-as.
 *
 * @param {Object} args
 * @param {string} args.source assembly source text
 * @param {Record<string, string>} [args.includes]
 * @param {Record<string, Uint8Array>} [args.binaryIncludes]
 * @param {string[]} [args.options]
 * @returns {Promise<{log:string, exitCode:number, object:Uint8Array|null, crash?:any}>}
 */
export async function runArmAs(args) {
  const { source, options = [] } = args;
  const includes = args.includes ?? {};
  const binaryIncludes = args.binaryIncludes ?? {};
  /** @type {import("../_worker/run.js").InputFile[]} */
  const inputFiles = [textFile("/work/main.s", source)];
  for (const [name, content] of Object.entries(includes)) {
    inputFiles.push(textFile("/work/" + name, content));
  }
  for (const [name, bytes] of Object.entries(binaryIncludes)) {
    inputFiles.push(binaryFile("/work/" + name, bytes));
  }
  const argv = [
    "-mcpu=arm7tdmi",
    "-mthumb-interwork",
    "-I", "/work",
    ...options,
    "/work/main.s",
    "-o", "/work/main.o",
  ];
  const r = await runIsolated({
    gluePath: armGlue("arm-none-eabi-as.mjs"),
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
 * Link ARM object files into an ELF executable.
 *
 * @param {Object} args
 * @param {Record<string, Uint8Array>} args.objects
 * @param {string} args.linkScript linker script contents (lnkscript / gba.ld)
 * @param {string[]} [args.libraryPaths]
 * @param {string[]} [args.libraries]
 * @param {Record<string, Uint8Array>} [args.archives]
 * @param {string[]} [args.options]
 * @returns {Promise<{log:string, exitCode:number, elf:Uint8Array|null, crash?:any}>}
 */
export async function runArmLd(args) {
  const { objects, linkScript, libraries = [], libraryPaths = [], options = [] } = args;
  const archives = args.archives ?? {};
  /** @type {import("../_worker/run.js").InputFile[]} */
  const inputFiles = [textFile("/work/gba.ld", linkScript)];
  for (const [name, bytes] of Object.entries(objects)) {
    inputFiles.push(binaryFile("/work/" + name, bytes));
  }
  for (const [name, bytes] of Object.entries(archives)) {
    inputFiles.push(binaryFile("/work/" + name, bytes));
  }
  const argv = [
    "-T", "/work/gba.ld",
    "-o", "/work/main.elf",
    ...libraryPaths.flatMap((p) => ["-L", p]),
    ...Object.keys(objects).map((n) => "/work/" + n),
    ...libraries.map((l) => `-l${l}`),
    ...options,
  ];
  const r = await runIsolated({
    gluePath: armGlue("arm-none-eabi-ld.mjs"),
    argv,
    inputFiles,
    outputFiles: [{ vfsPath: "/work/main.elf", encoding: "base64" }],
  });
  return {
    log: r.log,
    exitCode: r.exitCode,
    elf: getOutputBytes(r, "/work/main.elf"),
    ...(r.crash ? { crash: r.crash, stage: "crash" } : {}),
  };
}

/**
 * Strip an ELF down to a raw .gba ROM.
 *
 * @param {Object} args
 * @param {Uint8Array} args.elf
 * @param {string[]} [args.options]
 * @returns {Promise<{log:string, exitCode:number, binary:Uint8Array|null, crash?:any}>}
 */
export async function runArmObjcopy(args) {
  const { elf, options = [] } = args;
  /** @type {import("../_worker/run.js").InputFile[]} */
  const inputFiles = [binaryFile("/work/main.elf", elf)];
  const argv = [
    "-O", "binary",
    ...options,
    "/work/main.elf",
    "/work/main.gba",
  ];
  const r = await runIsolated({
    gluePath: armGlue("arm-none-eabi-objcopy.mjs"),
    argv,
    inputFiles,
    outputFiles: [{ vfsPath: "/work/main.gba", encoding: "base64" }],
  });
  return {
    log: r.log,
    exitCode: r.exitCode,
    binary: getOutputBytes(r, "/work/main.gba"),
    ...(r.crash ? { crash: r.crash, stage: "crash" } : {}),
  };
}
