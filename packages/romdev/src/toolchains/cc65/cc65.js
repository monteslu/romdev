// cc65 — bundled 6502 C compiler + assembler + linker.
//
// Provides a Node API that runs cc65 → ca65 → ld65 entirely in WebAssembly.
// Each tool runs in its own Emscripten module with its own MEMFS. We shuttle
// files between them via byte arrays.
//
// Public API:
//   runCc65({ source, headers? }) → { asmSource, log, exitCode }
//   runCa65({ source, includes? }) → { object, log, exitCode }
//   runLd65({ objects, config, target, libraries? }) → { binary, log, exitCode }
//   buildC({ source, target, headers?, includes? }) → { binary, log, exitCode }
//   buildAsm({ source, target, includes? }) → { binary, log, exitCode }

import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import path from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// cc65's tool WASM AND its target share/ tree (include / asminc / lib / cfg /
// target) both ship in @romdev/toolchain-cc65. The share/ files are what ld65
// needs to link a target, so they must come from the same place as the WASM.
// Resolve the package's base dir once; fall back to a local copy under src/
// if present (transition / dev). The package is a hard dep of romdev.
function resolveCc65BaseDir() {
  try {
    const u = import.meta.resolve("@romdev/toolchain-cc65");
    const dir = path.dirname(fileURLToPath(u));
    if (existsSync(path.join(dir, "wasm", "cc65.js"))) return dir;
  } catch { /* package not resolvable — fall through to local */ }
  if (existsSync(path.join(__dirname, "wasm", "cc65.js"))) return __dirname;
  throw new Error("cc65 WASM not found — install @romdev/toolchain-cc65");
}
const CC65_BASE = resolveCc65BaseDir();
const WASM_DIR = path.join(CC65_BASE, "wasm");
const SHARE_DIR = path.join(CC65_BASE, "share", "cc65");

import { runIsolated, textFile, binaryFile, getOutputBytes, getOutputText } from "../_worker/run.js";

/**
 * Compile a C source to 6502 assembly via cc65.
 * @param {Object} args
 * @param {string} args.source
 * @param {Record<string, string>} [args.headers]
 * @param {string[]} [args.options] extra cc65 flags
 * @param {string} [args.target] target id (e.g. "nes", "c64")
 */
export async function runCc65(args) {
  const { source, options = [], target } = args;
  const headers = args.headers ?? {};
  /** @type {import("../_worker/run.js").InputFile[]} */
  const inputFiles = [textFile("/work/main.c", source)];
  for (const [name, content] of Object.entries(headers)) {
    inputFiles.push(textFile("/work/" + name, content));
  }
  const r = await runIsolated({
    gluePath: path.join(WASM_DIR, "cc65.js"),
    argv: [
      ...(target ? ["-t", target] : []),
      "-I", "/share/cc65/include",
      "-I", "/work",
      ...options,
      "-o", "/work/out.s",
      "/work/main.c",
    ],
    inputFiles,
    hostDirMounts: [
      { hostDir: path.join(SHARE_DIR, "include"), vfsDir: "/share/cc65/include" },
    ],
    outputFiles: [{ vfsPath: "/work/out.s", encoding: "utf8" }],
  });
  return {
    log: r.log,
    exitCode: r.exitCode,
    asmSource: getOutputText(r, "/work/out.s"),
    ...(r.crash ? { crash: r.crash, stage: "crash" } : {}),
  };
}

/**
 * Assemble a .s file with ca65.
 * @param {Object} args
 * @param {string} args.source assembly source
 * @param {Record<string, string>} [args.includes]
 * @param {string[]} [args.options]
 * @param {string} [args.target]
 */
export async function runCa65(args) {
  const { source, options = [], target } = args;
  const includes = args.includes ?? {};
  const binaryIncludes = args.binaryIncludes ?? {};
  /** @type {import("../_worker/run.js").InputFile[]} */
  const inputFiles = [textFile("/work/main.s", source)];
  for (const [name, content] of Object.entries(includes)) {
    inputFiles.push(textFile("/work/" + name, content));
  }
  for (const [name, b64] of Object.entries(binaryIncludes)) {
    const bytes = b64 instanceof Uint8Array ? b64 : Buffer.from(b64, "base64");
    inputFiles.push(binaryFile("/work/" + name, bytes));
  }
  const r = await runIsolated({
    gluePath: path.join(WASM_DIR, "ca65.js"),
    argv: [
      ...(target ? ["-t", target] : []),
      "-I", "/share/cc65/asminc",
      "-I", "/work",
      ...options,
      "-o", "/work/out.o",
      "/work/main.s",
    ],
    inputFiles,
    hostDirMounts: [
      { hostDir: path.join(SHARE_DIR, "asminc"), vfsDir: "/share/cc65/asminc" },
    ],
    outputFiles: [{ vfsPath: "/work/out.o", encoding: "base64" }],
  });
  return {
    log: r.log,
    exitCode: r.exitCode,
    object: getOutputBytes(r, "/work/out.o"),
    ...(r.crash ? { crash: r.crash, stage: "crash" } : {}),
  };
}

/**
 * Link object files into a final binary using ld65.
 *
 * @param {Object} args
 * @param {Record<string, Uint8Array>} args.objects map of name → object bytes
 * @param {string} args.target target id (resolves to lib/<target>.lib + cfg/<target>.cfg)
 * @param {string[]} [args.libraries] extra .lib names (without path) to add
 * @param {string[]} [args.options] extra ld65 flags
 * @param {boolean} [args.debug] if true, emit `/work/out.dbg` debug info
 * @param {string} [args.linkerConfig] custom ld65 config (overrides the per-target default)
 */
export async function runLd65(args) {
  const { objects, target, libraries = [], options = [], debug, linkerConfig } = args;
  const extra = debug ? ["--dbgfile", "/work/out.dbg"] : [];
  // If a custom config is supplied, use -C and skip -t (mixing the two confuses ld65;
  // -t auto-loads cfg/<target>.cfg from the search path which overrides our intent).
  const configArgs = linkerConfig
    ? ["-C", "/work/custom.cfg"]
    : ["-t", target];
  /** @type {import("../_worker/run.js").InputFile[]} */
  const inputFiles = [];
  for (const [name, bytes] of Object.entries(objects)) {
    inputFiles.push(binaryFile("/work/" + name, bytes));
  }
  if (linkerConfig) {
    inputFiles.push(textFile("/work/custom.cfg", linkerConfig));
  }
  const outputFiles = [{ vfsPath: "/work/out.bin", encoding: "base64" }];
  if (debug) outputFiles.push({ vfsPath: "/work/out.dbg", encoding: "utf8" });
  const r = await runIsolated({
    gluePath: path.join(WASM_DIR, "ld65.js"),
    argv: [
      ...configArgs,
      "-o", "/work/out.bin",
      ...extra,
      ...options,
      ...Object.keys(objects).map((n) => "/work/" + n),
      "/share/cc65/lib/" + target + ".lib",
      ...libraries.map((l) => "/share/cc65/lib/" + l),
    ],
    inputFiles,
    hostDirMounts: [
      { hostDir: path.join(SHARE_DIR, "lib"), vfsDir: "/share/cc65/lib" },
      { hostDir: path.join(SHARE_DIR, "cfg"), vfsDir: "/share/cc65/cfg" },
    ],
    outputFiles,
  });
  return {
    log: r.log,
    exitCode: r.exitCode,
    binary: getOutputBytes(r, "/work/out.bin"),
    dbg: debug ? getOutputText(r, "/work/out.dbg") : null,
    ...(r.crash ? { crash: r.crash, stage: "crash" } : {}),
  };
}

/**
 * Convenience: compile + assemble + link a C project to a binary.
 *
 * Supports either a single C source (`source: string`) or multiple translation
 * units (`sources: { "main.c": "...", "level.c": "...", "audio.s": "..." }`).
 * Files ending in `.s`/`.asm` are passed straight to ca65; everything else is
 * treated as C and compiled to .s first.
 *
 * @param {Object} args
 * @param {string} [args.source] single C file (shortcut)
 * @param {Record<string, string>} [args.sources] map of filename → source
 * @param {string} args.target target id (e.g. "nes")
 * @param {Record<string, string>} [args.headers] virtual headers visible to cc65
 * @param {Record<string, string>} [args.asmIncludes] virtual includes visible to ca65
 * @param {boolean} [args.debug] if true, also produce a ld65 .dbg file
 * @param {string} [args.linkerConfig] custom ld65 .cfg (overrides per-target default)
 */
export async function buildC(args) {
  const ccOpts = args.debug ? ["-g"] : [];
  const caOpts = args.debug ? ["-g"] : [];
  const sources = normalizeSources(args, "main.c");

  let log = "";
  /** @type {Record<string, Uint8Array>} */
  const objects = {};
  for (const [name, src] of Object.entries(sources)) {
    const ext = path.extname(name).toLowerCase();
    let asmSource;
    let asmName;
    if (ext === ".s" || ext === ".asm") {
      asmSource = src;
      asmName = name;
    } else {
      const cc = await runCc65({
        source: src,
        headers: args.headers,
        target: args.target,
        options: ccOpts,
      });
      log += `--- cc65 (${name}) ---\n` + cc.log + "\n";
      if (cc.exitCode !== 0 || !cc.asmSource) {
        return { binary: null, log, exitCode: cc.exitCode || 1, stage: "cc65" };
      }
      asmSource = cc.asmSource;
      asmName = name.replace(/\.(c|h)$/i, ".s");
    }
    const ca = await runCa65({
      source: asmSource,
      includes: args.asmIncludes,
      binaryIncludes: args.binaryIncludes,
      target: args.target,
      options: caOpts,
    });
    log += `--- ca65 (${asmName}) ---\n` + ca.log + "\n";
    if (ca.exitCode !== 0 || !ca.object) {
      return { binary: null, log, exitCode: ca.exitCode || 1, stage: "ca65" };
    }
    const objName = asmName.replace(/\.s$/, ".o");
    objects[objName] = ca.object;
  }
  const ld = await runLd65({
    objects,
    target: args.target,
    debug: args.debug,
    linkerConfig: args.linkerConfig,
  });
  log += "--- ld65 ---\n" + ld.log;
  return {
    binary: ld.binary,
    dbg: ld.dbg,
    log,
    exitCode: ld.exitCode,
    stage: ld.exitCode === 0 ? "done" : "ld65",
  };
}

/**
 * Convenience: assemble + link a ca65 project to a binary.
 *
 * Supports either a single .s source (`source: string`) or multiple
 * translation units (`sources: { "main.s": "...", "aliens.s": "..." }`).
 * Each source becomes its own .o file and the linker is called once with the
 * full bag.
 *
 * @param {Object} args
 * @param {string} [args.source]
 * @param {Record<string, string>} [args.sources]
 * @param {string} args.target
 * @param {Record<string, string>} [args.includes] visible to every ca65 invocation (via `.include "name"`)
 * @param {boolean} [args.debug]
 * @param {string} [args.linkerConfig] custom ld65 .cfg
 */
export async function buildAsm(args) {
  const caOpts = args.debug ? ["-g"] : [];
  const sources = normalizeSources(args, "main.s");

  let log = "";
  /** @type {Record<string, Uint8Array>} */
  const objects = {};
  for (const [name, src] of Object.entries(sources)) {
    const ca = await runCa65({
      source: src,
      includes: args.includes,
      binaryIncludes: args.binaryIncludes,
      target: args.target,
      options: caOpts,
    });
    log += `--- ca65 (${name}) ---\n` + ca.log + "\n";
    if (ca.exitCode !== 0 || !ca.object) {
      return { binary: null, log, exitCode: ca.exitCode || 1, stage: "ca65" };
    }
    const objName = name.replace(/\.(s|asm)$/i, ".o");
    objects[objName] = ca.object;
  }
  const ld = await runLd65({
    objects,
    target: args.target,
    debug: args.debug,
    linkerConfig: args.linkerConfig,
  });
  log += "--- ld65 ---\n" + ld.log;
  return {
    binary: ld.binary,
    dbg: ld.dbg,
    log,
    exitCode: ld.exitCode,
    stage: ld.exitCode === 0 ? "done" : "ld65",
  };
}

/**
 * Build helpers accept either { source: "..." } or { sources: {name: "..."}}.
 * This normalizes either shape into a single map. Throws if both/neither given.
 * @param {{source?: string, sources?: Record<string, string>}} args
 * @param {string} defaultName filename to assign when only `source` is given
 * @returns {Record<string, string>}
 */
function normalizeSources(args, defaultName) {
  if (args.sources && args.source) {
    throw new Error("pass either `source` (single) or `sources` (map), not both");
  }
  if (args.sources) {
    if (Object.keys(args.sources).length === 0) {
      throw new Error("`sources` must be a non-empty map of filename → contents");
    }
    return args.sources;
  }
  if (typeof args.source === "string") {
    return { [defaultName]: args.source };
  }
  throw new Error("missing `source` or `sources`");
}
