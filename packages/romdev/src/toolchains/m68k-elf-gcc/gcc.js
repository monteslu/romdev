// m68k-elf-gcc — WASM toolchain wrappers for Genesis C builds.
//
// The full pipeline:
//   runCc1m68k({source, headers, options}) → m68k assembly text (.s)
//   runM68kAs({asmSource, includes})        → .o ELF object
//   runM68kLd({objects, linkScript})        → linked .elf
//   runM68kObjcopy({elf})                   → raw .bin Genesis ROM
//
// Each step runs as a WASM module through our worker pool (R12
// subprocess isolation), same pattern as wladx.js / tcc816.js. The JS
// glue replaces gcc's normal driver — gcc-the-driver spawns cc1/as/ld
// as subprocesses via fork/exec, which emscripten can't do. We don't
// need it: this file orchestrates the same steps through callMain.

import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import path from "node:path";

import { runIsolated, textFile, binaryFile, getOutputBytes, getOutputText } from "../_worker/run.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// m68k-elf-gcc's WASM ships in @romdev/toolchain-m68k-gcc. Resolve each tool's
// glue from that package; fall back to a local copy under src/ if present
// (transition / dev). emcc's `EXPORT_ES6=1` output is ESM (uses
// import.meta.url + dynamic require), so the glue uses .mjs extensions. The
// package is a hard dep of romdev.
function resolveM68kGlue(file) {
  try {
    const u = import.meta.resolve("@romdev/toolchain-m68k-gcc");
    const p = path.join(path.dirname(fileURLToPath(u)), "wasm", file);
    if (existsSync(p)) return p;
  } catch { /* package not resolvable — fall through to local */ }
  const local = path.join(__dirname, "wasm", file);
  if (existsSync(local)) return local;
  throw new Error(`m68k-elf-gcc WASM (${file}) not found — install @romdev/toolchain-m68k-gcc`);
}

// Lazy + memoized per tool: resolve only on the first Genesis-C build that uses
// each tool, not at module load — so booting the server never touches this
// (20MB) package unless a Genesis C ROM is actually built.
const _glue = {};
const m68kGlue = (file) => (_glue[file] ??= resolveM68kGlue(file));

// ── cc1 — m68k gcc C frontend, source → assembly ─────────────────────
//
// Canonical gcc invocation pattern (what `gcc -S` does internally):
//   cc1 -quiet <source.c> -mcpu=68000 -O<n> -o <out.s>
//
// We strip the -quiet so the agent sees diagnostics, and add a fixed
// `-mcpu=68000` since Genesis is always 68000 (no 68020+).

/**
 * Compile a C source to m68k assembly via cc1.
 *
 * @param {Object} args
 * @param {string} args.source main C source text
 * @param {Record<string, string>} [args.headers] virtual headers visible via -I/work
 * @param {string[]} [args.options] extra cc1 flags (e.g. ['-O2', '-Wall'])
 * @returns {Promise<{log:string, exitCode:number, asmSource:string|null, crash?:any}>}
 */
export async function runCc1m68k(args) {
  const { source, options = [] } = args;
  const headers = args.headers ?? {};
  /** @type {import("../_worker/run.js").InputFile[]} */
  const inputFiles = [textFile("/work/main.c", source)];
  for (const [name, content] of Object.entries(headers)) {
    inputFiles.push(textFile("/work/" + name, content));
  }
  const argv = [
    "-mcpu=68000",
    "-iquote", "/work",
    "-I", "/work",   // also handle #include <...> form (SGDK headers etc.)
    ...options,
    "/work/main.c",
    "-o", "/work/main.s",
  ];
  const r = await runIsolated({
    gluePath: m68kGlue("cc1-m68k.mjs"),
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

// ── m68k-elf-as — GNU assembler, .s → .o ─────────────────────────────

/**
 * Assemble m68k assembly with m68k-elf-as.
 *
 * @param {Object} args
 * @param {string} args.source assembly source text
 * @param {Record<string, string>} [args.includes] sibling .s/.inc files (text)
 * @param {Record<string, Uint8Array>} [args.binaryIncludes] sibling binary files
 *   the .s `.incbin`s — typically a rom_header.bin or similar pre-computed blob.
 *   Mounted into MEMFS verbatim at the given path.
 * @param {string[]} [args.options]
 * @returns {Promise<{log:string, exitCode:number, object:Uint8Array|null, crash?:any}>}
 */
export async function runM68kAs(args) {
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
    "-march=68000",
    "-I", "/work",
    ...options,
    "/work/main.s",
    "-o", "/work/main.o",
  ];
  const r = await runIsolated({
    gluePath: m68kGlue("m68k-elf-as.mjs"),
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

// ── m68k-elf-ld — GNU linker, .o + linker script → .elf ──────────────

/**
 * Link m68k object files into an ELF executable.
 *
 * @param {Object} args
 * @param {Record<string, Uint8Array>} args.objects name → .o bytes
 * @param {string} args.linkScript ld linker script contents (genesis.ld)
 * @param {string[]} [args.libraryPaths] paths to search for archives
 * @param {string[]} [args.libraries] -l<name> archives (e.g. ['gcc', 'c', 'md'])
 * @param {Record<string, Uint8Array>} [args.archives] additional .a archives to ship
 *   into MEMFS (e.g. {'libgcc.a': bytes, 'libmd.a': bytes})
 * @param {string[]} [args.options] extra ld flags
 * @returns {Promise<{log:string, exitCode:number, elf:Uint8Array|null, crash?:any}>}
 */
export async function runM68kLd(args) {
  const { objects, linkScript, libraries = [], libraryPaths = [], options = [] } = args;
  const archives = args.archives ?? {};
  /** @type {import("../_worker/run.js").InputFile[]} */
  const inputFiles = [textFile("/work/genesis.ld", linkScript)];
  for (const [name, bytes] of Object.entries(objects)) {
    inputFiles.push(binaryFile("/work/" + name, bytes));
  }
  for (const [name, bytes] of Object.entries(archives)) {
    inputFiles.push(binaryFile("/work/" + name, bytes));
  }
  const argv = [
    "-T", "/work/genesis.ld",
    "-o", "/work/main.elf",
    ...libraryPaths.flatMap((p) => ["-L", p]),
    ...Object.keys(objects).map((n) => "/work/" + n),
    ...libraries.map((l) => `-l${l}`),
    ...options,
  ];
  const r = await runIsolated({
    gluePath: m68kGlue("m68k-elf-ld.mjs"),
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

// ── m68k-elf-objcopy — extract raw Genesis ROM from ELF ──────────────

/**
 * Strip an ELF down to a raw .bin (the Genesis ROM format).
 *
 * @param {Object} args
 * @param {Uint8Array} args.elf input ELF bytes
 * @param {string[]} [args.options] extra objcopy flags
 * @returns {Promise<{log:string, exitCode:number, binary:Uint8Array|null, crash?:any}>}
 */
export async function runM68kObjcopy(args) {
  const { elf, options = [] } = args;
  /** @type {import("../_worker/run.js").InputFile[]} */
  const inputFiles = [binaryFile("/work/main.elf", elf)];
  const argv = [
    "-O", "binary",
    ...options,
    "/work/main.elf",
    "/work/main.bin",
  ];
  const r = await runIsolated({
    gluePath: m68kGlue("m68k-elf-objcopy.mjs"),
    argv,
    inputFiles,
    outputFiles: [{ vfsPath: "/work/main.bin", encoding: "base64" }],
  });
  return {
    log: r.log,
    exitCode: r.exitCode,
    binary: getOutputBytes(r, "/work/main.bin"),
    ...(r.crash ? { crash: r.crash, stage: "crash" } : {}),
  };
}
