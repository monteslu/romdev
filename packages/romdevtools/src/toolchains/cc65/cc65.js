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

import { resolveToolBaseDir } from "../common/wasm-tool.js";
import { CBuild, BuildError } from "../common/c-build.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// cc65's tool WASM AND its target share/ tree (include / asminc / lib / cfg /
// target) both ship in romdev-toolchain-cc65. The share/ files are what ld65
// needs to link a target, so they must come from the same place as the WASM.
// Resolve the package's base dir once; fall back to a local copy under src/
// if present (transition / dev). The package is a hard dep of romdev.
// Lazy + memoized: resolve (and possibly throw "not installed") only on the
// first cc65 build (NES/C64/Atari7800/Lynx), not at module load — so booting
// the server never touches this package unless cc65 is actually used. Resolve
// the base dir once; derive the wasm + share dirs from it on demand.
let _cc65Base;
const cc65Base = () =>
  (_cc65Base ??= resolveToolBaseDir({
    pkg: "romdev-toolchain-cc65",
    sentinel: "wasm/cc65.js",
    localDir: __dirname,
    label: "cc65",
  }));

/** True if the cc65 build toolchain WASM (cc65 + ld65, in romdev-toolchain-cc65)
 *  is installed/resolvable, without throwing — for the catalog(status) capability
 *  probe. cc65, ca65, ld65, and da65 all ship in the SAME package, so this also
 *  reflects ld65 (the linker) availability. */
export function cc65Available() {
  try {
    const dir = cc65Base();
    return existsSync(path.join(dir, "wasm", "cc65.js")) && existsSync(path.join(dir, "wasm", "ld65.js"));
  } catch { return false; }
}
const wasmDir  = () => path.join(cc65Base(), "wasm");
const shareDir = () => path.join(cc65Base(), "share", "cc65");

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
    gluePath: path.join(wasmDir(), "cc65.js"),
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
      { hostDir: path.join(shareDir(), "include"), vfsDir: "/share/cc65/include" },
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
    gluePath: path.join(wasmDir(), "ca65.js"),
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
      { hostDir: path.join(shareDir(), "asminc"), vfsDir: "/share/cc65/asminc" },
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
  const outputFiles = [
    { vfsPath: "/work/out.bin", encoding: "base64" },
    // Always emit the linker map — its Segment list gives us per-segment
    // sizes (BSS / DATA / ZEROPAGE / stack), which we surface as RAM usage
    // so the agent sees "you used 380/512 B of BSS" instead of discovering
    // a silent overflow at runtime.
    { vfsPath: "/work/out.map", encoding: "utf8" },
  ];
  if (debug) outputFiles.push({ vfsPath: "/work/out.dbg", encoding: "utf8" });
  const r = await runIsolated({
    gluePath: path.join(wasmDir(), "ld65.js"),
    argv: [
      ...configArgs,
      "-o", "/work/out.bin",
      "--mapfile", "/work/out.map",
      ...extra,
      ...options,
      ...Object.keys(objects).map((n) => "/work/" + n),
      "/share/cc65/lib/" + target + ".lib",
      ...libraries.map((l) => "/share/cc65/lib/" + l),
    ],
    inputFiles,
    hostDirMounts: [
      { hostDir: path.join(shareDir(), "lib"), vfsDir: "/share/cc65/lib" },
      { hostDir: path.join(shareDir(), "cfg"), vfsDir: "/share/cc65/cfg" },
    ],
    outputFiles,
  });
  return {
    log: r.log,
    exitCode: r.exitCode,
    binary: getOutputBytes(r, "/work/out.bin"),
    dbg: debug ? getOutputText(r, "/work/out.dbg") : null,
    map: getOutputText(r, "/work/out.map") || null,
    ...(r.crash ? { crash: r.crash, stage: "crash" } : {}),
  };
}

/**
 * Parse an ld65 map file's "Segment list" into RAM-usage info. ld65's map
 * has a section like:
 *   Segments list:
 *   -------------
 *   ZEROPAGE          Start End   Size  Align ...
 *   BSS               000300 0004C8 0001C8 ...
 * We pull out the segments that live in RAM (BSS / DATA / ZEROPAGE / a few
 * common stack/heap names) with their sizes, so the agent can see how close
 * it is to the per-config RAM ceiling. Returns null if the map can't be
 * parsed (best-effort — never throws).
 * @param {string|null} mapText
 * @returns {{segments: Array<{name:string,start:number,end:number,size:number}>, note:string}|null}
 */
export function parseRamUsage(mapText) {
  if (!mapText || typeof mapText !== "string") return null;
  // The map's segment table rows look like: NAME  HHHHHH  HHHHHH  HHHHHH  ...
  // (name, start, end, size — all hex). Match those rows.
  const rows = [];
  const re = /^([A-Z_][A-Z0-9_]*)\s+([0-9A-Fa-f]{6})\s+([0-9A-Fa-f]{6})\s+([0-9A-Fa-f]{6})\b/gm;
  let m;
  while ((m = re.exec(mapText))) {
    const size = parseInt(m[4], 16);
    if (size === 0) continue;
    rows.push({ name: m[1], start: parseInt(m[2], 16), end: parseInt(m[3], 16), size });
  }
  if (!rows.length) return null;
  // RAM-resident segments (cc65 conventions). BSS = uninitialised globals,
  // DATA = initialised globals (RAM copy), ZEROPAGE = zp vars. Stack/heap
  // segments vary by target; include common names.
  // RAM = the data/bss/zp segments, AND they must live below the ROM window
  // (cc65 RAM is in low memory; PRG/code segments like STARTUP/CODE sit at
  // $8000+ on NES and shouldn't count as RAM usage).
  const segments = rows.filter(
    (r) => /^(BSS|DATA|ZEROPAGE|ZP|BSS2)$/.test(r.name) && r.start < 0x8000,
  );
  if (!segments.length) return null;
  return {
    segments,
    note: "RAM segments from the linker map (sizes in bytes). On NROM/CHR-RAM, " +
      "normal RAM is tight (~512 B for BSS/DATA outside zeropage + stack + " +
      "shadow OAM). If BSS+DATA approaches the config's RAM region size, you're " +
      "near overflow — symptoms are corrupted state / mystery crashes.",
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
  // Enable cc65's high-value warnings so the agent SEES real bugs (parsed into
  // structured issues[]). These are the valid cc65 -W names that catch actual
  // mistakes; unused-param is left off (scaffold callbacks commonly ignore
  // params). cc65's warning set is thin to begin with, but errors always surface
  // and these are pure upside. (NOTE: cc65 errors on an unknown -W name, so this
  // list is verified valid against the bundled cc65.)
  const ccWarn = ["-W", "unused-var,unused-func,unused-label,const-comparison,struct-param,pointer-sign"];
  const ccOpts = args.debug ? ["-g", ...ccWarn] : [...ccWarn];
  const caOpts = args.debug ? ["-g"] : [];
  const sources = normalizeSources(args, "main.c");

  const cb = new CBuild();
  try {
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
        // failure stage is bare "cc65" (no name) but the log header carries the name.
        const cc = await cb.stage("cc65",
          () => runCc65({ source: src, headers: args.headers, target: args.target, options: ccOpts }),
          (r) => r.asmSource, { logName: `cc65 (${name})` });
        asmSource = cc.asmSource;
        asmName = name.replace(/\.(c|h)$/i, ".s");
      }
      const ca = await cb.stage("ca65",
        () => runCa65({ source: asmSource, includes: args.asmIncludes, binaryIncludes: args.binaryIncludes, target: args.target, options: caOpts }),
        (r) => r.object, { logName: `ca65 (${asmName})` });
      objects[asmName.replace(/\.s$/, ".o")] = ca.object;
    }
    // ld65 is NOT throw-on-fail here: it returns its own success/failure inline with
    // dbg + ramUsage, so keep it as a plain call (the cc65 contract has no `ok` field).
    const ld = await runLd65({
      objects,
      target: args.target,
      debug: args.debug,
      linkerConfig: args.linkerConfig,
    });
    cb.log += "--- ld65 ---\n" + ld.log;   // exact: no trailing newline (matches pre-refactor)
    return {
      binary: ld.binary,
      dbg: ld.dbg,
      log: cb.log,
      exitCode: ld.exitCode,
      ramUsage: parseRamUsage(ld.map),
      stage: ld.exitCode === 0 ? "done" : "ld65",
    };
  } catch (e) {
    if (e instanceof BuildError) return e.fields();   // cc65 shape: no `ok` field
    throw e;
  }
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

  const cb = new CBuild();
  try {
    /** @type {Record<string, Uint8Array>} */
    const objects = {};
    for (const [name, src] of Object.entries(sources)) {
      const ca = await cb.stage("ca65",
        () => runCa65({ source: src, includes: args.includes, binaryIncludes: args.binaryIncludes, target: args.target, options: caOpts }),
        (r) => r.object, { logName: `ca65 (${name})` });
      objects[name.replace(/\.(s|asm)$/i, ".o")] = ca.object;
    }
    const ld = await runLd65({
      objects,
      target: args.target,
      debug: args.debug,
      linkerConfig: args.linkerConfig,
    });
    cb.log += "--- ld65 ---\n" + ld.log;
    return {
      binary: ld.binary,
      dbg: ld.dbg,
      log: cb.log,
      exitCode: ld.exitCode,
      ramUsage: parseRamUsage(ld.map),
      stage: ld.exitCode === 0 ? "done" : "ld65",
    };
  } catch (e) {
    if (e instanceof BuildError) return e.fields();   // cc65 shape: no `ok` field
    throw e;
  }
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
