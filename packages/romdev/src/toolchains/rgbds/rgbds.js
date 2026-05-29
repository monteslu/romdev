// RGBDS — bundled Game Boy / GBC assembler + linker + fix tool.
//
// Pipeline: rgbasm (source .asm → .o object) → rgblink (.o → .gb) →
// rgbfix (patches header + checksums in-place).
//
// Each is its own Emscripten module run through the worker pool for
// crash isolation. Returns from each wrapper carry { exitCode, log,
// crash? } in addition to tool-specific fields.

import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import path from "node:path";

import { runIsolated, textFile, binaryFile, getOutputBytes } from "../_worker/run.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// RGBDS's WASM ships in romdev-toolchain-rgbds. Resolve each tool's glue
// from that package; fall back to a local copy under src/ if present
// (transition / dev). The package is a hard dep of romdev.
function resolveRgbdsGlue(file) {
  try {
    const u = import.meta.resolve("romdev-toolchain-rgbds");
    const p = path.join(path.dirname(fileURLToPath(u)), "wasm", file);
    if (existsSync(p)) return p;
  } catch { /* package not resolvable — fall through to local */ }
  const local = path.join(__dirname, "wasm", file);
  if (existsSync(local)) return local;
  throw new Error(`RGBDS WASM (${file}) not found — install romdev-toolchain-rgbds`);
}
// Lazy + memoized per tool: resolve (and possibly throw "not installed") only
// on the first GB/GBC asm build that uses each tool, not at module load — so
// booting the server never touches this package unless RGBDS is actually used.
const _glue = {};
const rgbdsGlue = (file) => (_glue[file] ??= resolveRgbdsGlue(file));

/**
 * Run rgbasm on a source program.
 * @param {Object} args
 * @param {string} args.source main .asm source
 * @param {Record<string, string>} [args.includes] virtual filename → contents
 * @param {string[]} [args.options]
 */
export async function runRgbasm(args) {
  const { source } = args;
  const includes = args.includes ?? {};
  const opts = args.options ?? [];
  /** @type {import("../_worker/run.js").InputFile[]} */
  const inputFiles = [textFile("/work/main.asm", source)];
  for (const [name, content] of Object.entries(includes)) {
    inputFiles.push(textFile("/work/" + name, content));
  }
  const r = await runIsolated({
    gluePath: rgbdsGlue("rgbasm.js"),
    argv: ["-I", "/work", ...opts, "-o", "/work/out.o", "/work/main.asm"],
    inputFiles,
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
 * Link rgbasm object(s) into a Game Boy ROM.
 * @param {Object} args
 * @param {Record<string, Uint8Array>} args.objects
 * @param {string[]} [args.options]
 */
export async function runRgblink(args) {
  const { objects } = args;
  const opts = args.options ?? [];
  /** @type {import("../_worker/run.js").InputFile[]} */
  const inputFiles = [];
  for (const [n, b] of Object.entries(objects)) inputFiles.push(binaryFile("/work/" + n, b));
  const r = await runIsolated({
    gluePath: rgbdsGlue("rgblink.js"),
    argv: ["-o", "/work/out.gb", ...opts, ...Object.keys(objects).map((n) => "/work/" + n)],
    inputFiles,
    outputFiles: [{ vfsPath: "/work/out.gb", encoding: "base64" }],
  });
  return {
    log: r.log,
    exitCode: r.exitCode,
    binary: getOutputBytes(r, "/work/out.gb"),
    ...(r.crash ? { crash: r.crash, stage: "crash" } : {}),
  };
}

/**
 * Patch a Game Boy ROM's header (fills logo, sets type byte, fixes checksums).
 * @param {Object} args
 * @param {Uint8Array} args.rom
 * @param {string[]} [args.options]
 */
export async function runRgbfix(args) {
  const { rom } = args;
  const opts = args.options ?? ["-v", "-p", "0xFF"];
  const r = await runIsolated({
    gluePath: rgbdsGlue("rgbfix.js"),
    argv: [...opts, "/work/out.gb"],
    inputFiles: [binaryFile("/work/out.gb", rom)],
    outputFiles: [{ vfsPath: "/work/out.gb", encoding: "base64" }],
  });
  return {
    log: r.log,
    exitCode: r.exitCode,
    binary: getOutputBytes(r, "/work/out.gb"),
    ...(r.crash ? { crash: r.crash, stage: "crash" } : {}),
  };
}

/**
 * Build a single .asm file all the way to a fixed .gb ROM.
 * @param {Object} args
 * @param {string} args.source
 * @param {Record<string, string>} [args.includes]
 */
export async function buildGB(args) {
  const a = await runRgbasm(args);
  if (a.exitCode !== 0 || !a.object) {
    return { binary: null, log: a.log, exitCode: a.exitCode || 1, stage: a.stage ?? "rgbasm" };
  }
  const l = await runRgblink({ objects: { "main.o": a.object } });
  if (l.exitCode !== 0 || !l.binary) {
    return {
      binary: null,
      log: a.log + "\n--- rgblink ---\n" + l.log,
      exitCode: l.exitCode || 1,
      stage: l.stage ?? "rgblink",
    };
  }
  const f = await runRgbfix({ rom: l.binary });
  return {
    binary: f.binary ?? l.binary,
    log: a.log + "\n--- rgblink ---\n" + l.log + "\n--- rgbfix ---\n" + f.log,
    exitCode: f.exitCode,
    stage: f.exitCode === 0 ? "done" : (f.stage ?? "rgbfix"),
  };
}
