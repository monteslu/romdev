// Shared GCC-family toolchain factory (0.81.0). The arm/m68k/mips/sh "gcc" wrappers
// were ~73% identical: each exported runCc1X / runXAs / runXLd / runXObjcopy that did
// the same input-marshalling + runIsolated() + output-decoding, differing only in:
//   - the npm package the glue ships in + the glue filenames
//   - the per-stage arch flags (cc1 / as / ld), which for MIPS depend on endian
//   - the linker-script filename + the objcopy output filename
// makeGccToolchain(config, env?) returns the 4 run functions, so each arch shrinks to
// a small config object. Glue resolution is lazy+memoized (booting never loads a
// toolchain package until something is actually built with it).
//
// ENV INJECTION (0.95.0, for the browser IDEs): every stage runs through ONE
// seam — `runTool(job)` — and the caller may supply it via `env.runTool`. The
// job carries the logical tool identity ({ tool, glueFile, pkg }) plus the
// fully-marshalled { argv, inputFiles, outputFiles }; the host owns WASM
// instantiation and MEMFS mounting and returns { exitCode, log, outputs }.
// A browser Web Worker supplies its own runTool over the same glue files
// (fetched as static assets); node callers omit env and get the default
// child-process pool. The default is a LAZY dynamic import so a browser
// bundle that always injects runTool never loads node:child_process.
//
// All four stages keep the exact pre-refactor argv, /work paths, output encodings,
// and return shapes (including `...(r.crash ? { crash, stage:"crash" } : {})`).
// ONLY the pure io helpers are imported statically — glue resolution
// (./wasm-tool.js: node fs/url) and the worker pool (../_worker/run.js:
// node child_process) load lazily inside the default runner, so a browser
// bundle that injects env.runTool never touches a node builtin through here.
import { marshalInputs, getOutputBytes, getOutputText } from "./io.js";

/**
 * @typedef {Object} ToolJob
 * @property {"cc1"|"as"|"ld"|"objcopy"} tool  logical stage
 * @property {string}   glueFile   glue filename inside the package's wasm/ (e.g. "cc1-arm.mjs")
 * @property {string}   pkg        npm package the glue ships in
 * @property {string}   [gluePath] absolute glue path (set by the default node runner only)
 * @property {string[]} argv
 * @property {Array<{vfsPath:string, encoding:"utf8"|"base64", data:string}>} inputFiles
 * @property {Array<{vfsPath:string, encoding:"utf8"|"base64"}>} outputFiles
 */

/**
 * @typedef {Object} GccToolchainEnv
 * @property {(job: ToolJob) => Promise<{exitCode:number, log:string, outputs:Record<string,string>, crash?:any}>} [runTool]
 */

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

/** The default node runner: resolve the glue from the npm package, run in the
 *  isolated child-process pool. Loaded lazily so injecting env.runTool means
 *  the pool (node:child_process) is never imported. */
function makeDefaultRunTool(config) {
  let glue = null;
  let runIsolated = null;
  return async (job) => {
    if (!runIsolated) ({ runIsolated } = await import("../_worker/run.js"));
    if (!glue) {
      const { makeGlueResolver } = await import("./wasm-tool.js");
      glue = makeGlueResolver({ pkg: config.pkg, localDir: config.localDir, label: config.label });
    }
    return runIsolated({
      gluePath: glue(job.glueFile),
      argv: job.argv,
      inputFiles: job.inputFiles,
      outputFiles: job.outputFiles,
    });
  };
}

/**
 * Build the 4 GCC-stage run functions for one architecture.
 * @param {GccArchConfig} config
 * @param {GccToolchainEnv} [env]  optional injected environment (browser hosts)
 * @returns {{ runCc1:Function, runAs:Function, runLd:Function, runObjcopy:Function }}
 */
export function makeGccToolchain(config, env) {
  const runTool = env?.runTool ?? makeDefaultRunTool(config);
  const endianOf = (args) => args.endian ?? config.defaultEndian ?? "big";
  const job = (tool, glueFile, rest) => ({ tool, glueFile, pkg: config.pkg, ...rest });

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
    const r = await runTool(job("cc1", config.glue.cc1, {
      argv,
      inputFiles,
      outputFiles: [{ vfsPath: "/work/main.s", encoding: "utf8" }],
    }));
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
    const r = await runTool(job("as", config.glue.as, {
      argv,
      inputFiles,
      outputFiles: [{ vfsPath: "/work/main.o", encoding: "base64" }],
    }));
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
    const r = await runTool(job("ld", config.glue.ld, {
      argv,
      inputFiles,
      outputFiles: [
        { vfsPath: "/work/main.elf", encoding: "base64" },
        { vfsPath: "/work/main.map", encoding: "utf8" },
      ],
    }));
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
    const r = await runTool(job("objcopy", config.glue.objcopy, {
      argv,
      inputFiles,
      outputFiles: [{ vfsPath: "/work/" + config.outputName, encoding: "base64" }],
    }));
    return {
      log: r.log,
      exitCode: r.exitCode,
      binary: getOutputBytes(r, "/work/" + config.outputName),
      ...(r.crash ? { crash: r.crash, stage: "crash" } : {}),
    };
  }

  return { runCc1, runAs, runLd, runObjcopy };
}
