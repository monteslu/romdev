// Shared GCC-family toolchain factory (0.81.0). The arm/m68k/mips/sh "gcc" wrappers
// were ~73% identical: each exported runCc1X / runXAs / runXLd / runXObjcopy that did
// the same input-marshalling + runIsolated() + output-decoding, differing only in:
//   - the npm package the glue ships in + the glue filenames
//   - the per-stage arch flags (cc1 / as / ld), which for MIPS depend on endian
//   - the linker-script filename + the objcopy output filename
// makeGccToolchain(config) returns the 4 run functions, so each arch shrinks to a
// small config object. Glue resolution is lazy+memoized (booting never loads a
// toolchain package until something is actually built with it).
//
// All four stages keep the exact pre-refactor argv, /work paths, output encodings,
// and return shapes (including `...(r.crash ? { crash, stage:"crash" } : {})`), so
// this is a pure de-duplication — no behavior change.
import { runIsolated, getOutputBytes, getOutputText } from "../_worker/run.js";
import { makeGlueResolver, marshalInputs } from "./wasm-tool.js";

/**
 * @typedef {Object} GccArchConfig
 * @property {string}   pkg          npm package the glue ships in
 * @property {string}   localDir     the wrapper's __dirname (dev fallback base)
 * @property {string}   label        tool label for "not found" errors
 * @property {Object}   glue         glue filenames per stage
 * @property {string}   glue.cc1     e.g. "cc1-m68k.mjs"
 * @property {string}   glue.as      e.g. "m68k-elf-as.mjs"
 * @property {string}   glue.ld      e.g. "m68k-elf-ld.mjs"
 * @property {string}   glue.objcopy e.g. "m68k-elf-objcopy.mjs"
 * @property {string[]|((endian:string)=>string[])} cc1Flags  arch flags for cc1 (before -iquote/-I)
 * @property {string[]|((endian:string)=>string[])} asFlags   arch flags for as (before -I)
 * @property {string[]|((endian:string)=>string[])} [ldFlags] arch flags for ld (before -T); default []
 * @property {string}   ldScriptName name the link script is mounted as (e.g. "genesis.ld")
 * @property {string}   outputName   objcopy output filename (e.g. "main.bin", "main.gba")
 * @property {string}   [defaultEndian] "big"|"little" — only meaningful when flags are fns
 */

/** Resolve a flags entry that may be a constant array or an endian-dependent fn. */
function flags(entry, endian) {
  return typeof entry === "function" ? entry(endian) : (entry ?? []);
}

/**
 * Build the 4 GCC-stage run functions for one architecture.
 * @param {GccArchConfig} config
 * @returns {{ runCc1:Function, runAs:Function, runLd:Function, runObjcopy:Function }}
 */
export function makeGccToolchain(config) {
  const glue = makeGlueResolver({ pkg: config.pkg, localDir: config.localDir, label: config.label });
  const endianOf = (args) => args.endian ?? config.defaultEndian ?? "big";

  /** cc1: C source → assembly (.s). */
  async function runCc1(args) {
    const { source, options = [] } = args;
    const inputFiles = marshalInputs({ primary: { name: "main.c", text: source }, text: args.headers ?? {} });
    const argv = [
      ...flags(config.cc1Flags, endianOf(args)),
      "-iquote", "/work",
      "-I", "/work",
      ...options,
      "/work/main.c",
      "-o", "/work/main.s",
    ];
    const r = await runIsolated({
      gluePath: glue(config.glue.cc1),
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

  /** as: assembly (.s) → object (.o). */
  async function runAs(args) {
    const { source, options = [] } = args;
    const inputFiles = marshalInputs({
      primary: { name: "main.s", text: source },
      text: args.includes ?? {},
      binary: args.binaryIncludes ?? {},
    });
    const argv = [
      ...flags(config.asFlags, endianOf(args)),
      "-I", "/work",
      ...options,
      "/work/main.s",
      "-o", "/work/main.o",
    ];
    const r = await runIsolated({
      gluePath: glue(config.glue.as),
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

  /** ld: objects + link script → ELF (+ map). */
  async function runLd(args) {
    const { objects, linkScript, libraries = [], libraryPaths = [], options = [] } = args;
    const inputFiles = marshalInputs({
      text: { [config.ldScriptName]: linkScript },
      binary: { ...objects, ...(args.archives ?? {}) },
    });
    const argv = [
      ...flags(config.ldFlags, endianOf(args)),
      "-T", "/work/" + config.ldScriptName,
      "-o", "/work/main.elf",
      "-Map=/work/main.map",
      ...libraryPaths.flatMap((p) => ["-L", p]),
      ...Object.keys(objects).map((n) => "/work/" + n),
      ...libraries.map((l) => `-l${l}`),
      ...options,
    ];
    const r = await runIsolated({
      gluePath: glue(config.glue.ld),
      argv,
      inputFiles,
      outputFiles: [
        { vfsPath: "/work/main.elf", encoding: "base64" },
        { vfsPath: "/work/main.map", encoding: "utf8" },
      ],
    });
    return {
      log: r.log,
      exitCode: r.exitCode,
      elf: getOutputBytes(r, "/work/main.elf"),
      map: getOutputText(r, "/work/main.map") || null,
      ...(r.crash ? { crash: r.crash, stage: "crash" } : {}),
    };
  }

  /** objcopy: ELF → raw binary. */
  async function runObjcopy(args) {
    const { elf, options = [] } = args;
    const inputFiles = marshalInputs({ binary: { "main.elf": elf } });
    const argv = [
      "-O", "binary",
      ...options,
      "/work/main.elf",
      "/work/" + config.outputName,
    ];
    const r = await runIsolated({
      gluePath: glue(config.glue.objcopy),
      argv,
      inputFiles,
      outputFiles: [{ vfsPath: "/work/" + config.outputName, encoding: "base64" }],
    });
    return {
      log: r.log,
      exitCode: r.exitCode,
      binary: getOutputBytes(r, "/work/" + config.outputName),
      ...(r.crash ? { crash: r.crash, stage: "crash" } : {}),
    };
  }

  return { runCc1, runAs, runLd, runObjcopy };
}
