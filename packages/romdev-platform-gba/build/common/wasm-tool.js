// Shared WASM-toolchain plumbing (0.81.0). Every toolchain wrapper used to
// re-implement the SAME two things:
//   1. Resolve a tool's emscripten glue from its npm package, with a local
//      src/ fallback for dev, throwing an install hint if neither exists.
//   2. Marshal { name: text|bytes } maps into the runIsolated() inputFiles[]
//      shape (textFile / binaryFile per entry).
// This module owns both so the per-tool wrappers carry only what's genuinely
// tool-specific (package name, glue filename, argv, output decoding).
//
// Resolution stays LAZY at the call site (the wrappers memoize) so booting the
// server never touches a 100MB+ toolchain package unless that toolchain is
// actually used to build something.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
// (textFile/binaryFile live in the pure ./io.js — no worker import here, so
// importing this module never pulls the child-process pool.)

/**
 * Resolve a single tool glue FILE from its package, falling back to a local
 * in-tree copy. This is the arm/m68k/mips/sh-gcc + asar + wladx + rgbds + dasm +
 * vasm68k + sjasm + tcc816 shape (one .js/.mjs glue per tool).
 *
 * @param {Object} a
 * @param {string} a.pkg        npm package the glue ships in (e.g. "romdev-platform-gba")
 * @param {string} a.file       glue filename inside the package's wasm/ dir (e.g. "cc1-arm.mjs")
 * @param {string} a.localDir   the wrapper's __dirname (its wasm/ holds the dev fallback)
 * @param {string} [a.label]    tool name for the "not found" error (defaults to file)
 * @returns {string} absolute path to the glue file
 */
export function resolveGlueFile({ pkg, file, localDir, label }) {
  try {
    const u = import.meta.resolve(pkg);
    const p = path.join(path.dirname(fileURLToPath(u)), "wasm", file);
    if (existsSync(p)) return p;
  } catch { /* package not resolvable — fall through to local */ }
  // localDir may be a file: URL (wrappers that must stay free of top-level
  // node imports pass `new URL(".", import.meta.url).href`) — convert here.
  if (localDir?.startsWith("file:")) localDir = fileURLToPath(localDir);
  const local = path.join(localDir, "wasm", file);
  if (existsSync(local)) return local;
  throw new Error(`${label ?? file} WASM not found — install ${pkg}`);
}

/**
 * Resolve a tool's BASE directory (the caller derives wasm/ + share/ from it).
 * This is the cc65 + sdcc shape, where one package holds several tools + shared
 * data and the wrapper wants the root, validated by a sentinel file's presence.
 *
 * @param {Object} a
 * @param {string} a.pkg          npm package (e.g. "romdev-toolchain-cc65")
 * @param {string} a.sentinel     a path under the base that must exist (e.g. "wasm/cc65.js")
 * @param {string} a.localDir     the wrapper's __dirname (the dev fallback base)
 * @param {string} [a.label]      tool name for the "not found" error
 * @returns {string} absolute path to the base dir
 */
export function resolveToolBaseDir({ pkg, sentinel, localDir, label }) {
  try {
    const u = import.meta.resolve(pkg);
    const dir = path.dirname(fileURLToPath(u));
    if (existsSync(path.join(dir, sentinel))) return dir;
  } catch { /* package not resolvable — fall through to local */ }
  if (localDir?.startsWith("file:")) localDir = fileURLToPath(localDir);
  if (existsSync(path.join(localDir, sentinel))) return localDir;
  throw new Error(`${label ?? pkg} WASM not found — install ${pkg}`);
}

/**
 * A lazy, memoized glue resolver bound to a package + local dir. Returns a
 * function `glue(file)` that resolves+caches each glue path on first use.
 * Replaces the `const _glue = {}; const xGlue = (f) => (_glue[f] ??= ...)`
 * boilerplate every multi-tool wrapper repeats.
 *
 * @param {Object} a
 * @param {string} a.pkg
 * @param {string} a.localDir
 * @param {string} [a.label]
 * @returns {(file: string) => string}
 */
export function makeGlueResolver({ pkg, localDir, label }) {
  const cache = {};
  return (file) =>
    (cache[file] ??= resolveGlueFile({ pkg, file, localDir, label }));
}

// marshalInputs (and textFile/binaryFile) are pure and live in ./io.js so the
// browser-loadable pipeline can import them without touching node. Re-exported
// for the existing wrappers that import them from here.
export { marshalInputs, textFile, binaryFile } from "./io.js";
