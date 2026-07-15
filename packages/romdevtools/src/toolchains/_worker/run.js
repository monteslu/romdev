// run.js — caller-facing wrapper around the worker pool.
//
// Each toolchain helper (runCc65, runSdcc, runAsar, runDasm, ...) calls
// `runIsolated()` with a structured spec instead of the old callback-style
// `runEmscriptenTool(setup, collect)`. That spec gets handed to a child
// worker that runs the WASM in isolation — so a WASM abort can't take
// down the MCP server.
//
// The result shape mirrors the old in-process tool: { exitCode, log, ...outputs }.

import { runInWorker } from "./pool.js";

/**
 * @typedef {Object} InputFile
 * @property {string} vfsPath  e.g. "/work/main.c"
 * @property {"utf8" | "base64"} encoding
 * @property {string} data
 */

/**
 * @typedef {Object} HostDirMount
 * @property {string} hostDir  absolute path on the host
 * @property {string} vfsDir   target mount path in MEMFS
 */

/**
 * @typedef {Object} OutputFile
 * @property {string} vfsPath
 * @property {"utf8" | "base64"} encoding
 */

/**
 * @typedef {Object} IsolatedJob
 * @property {string} gluePath
 * @property {string[]} argv
 * @property {string} [stdinText]
 * @property {InputFile[]} [inputFiles]
 * @property {HostDirMount[]} [hostDirMounts]
 * @property {OutputFile[]} [outputFiles]
 */

/**
 * Run a WASM tool job in an isolated child worker.
 *
 * @param {IsolatedJob} job
 * @returns {Promise<{
 *   exitCode: number,
 *   log: string,
 *   outputs: Record<string, string>,
 *   crash?: { exitCode: number | null, signal: string | null },
 * }>}
 */
export async function runIsolated(job) {
  return await runInWorker(job);
}

/** Convenience: get bytes (Uint8Array) for an output file from the result. */
export function getOutputBytes(result, vfsPath) {
  const data = result.outputs?.[vfsPath];
  if (!data) return null;
  return new Uint8Array(Buffer.from(data, "base64"));
}

/** Convenience: get text for an output file from the result. */
export function getOutputText(result, vfsPath) {
  return result.outputs?.[vfsPath] ?? "";
}

/** Convert text → InputFile spec. */
export function textFile(vfsPath, content) {
  return { vfsPath, encoding: "utf8", data: content };
}

/** Convert binary (Uint8Array / Buffer) → InputFile spec. */
export function binaryFile(vfsPath, bytes) {
  // Accept EITHER raw bytes OR a base64 STRING — the same either/or contract the
  // toolchain wrappers honor individually (asar/cc65/vasm68k/wladx all guard with
  // `x instanceof Uint8Array ? x : Buffer.from(x, "base64")`). The MCP
  // `binaryIncludes` schema delivers base64 STRINGS; the old `Buffer.from(string)`
  // here decoded them as UTF-8, so the base64 TEXT itself became the file bytes —
  // .incbin then embedded base64 text into the ROM. That corrupted every
  // user-supplied binary include on the paths that mount via binaryFile (GBA's
  // maxmod soundbank stub + the generic gcc runner used by Genesis/MIPS/SH):
  // the GBA maxmod "silent without print()" hunt traced back to exactly this.
  const buf = Buffer.isBuffer(bytes) ? bytes
    : bytes instanceof Uint8Array ? Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    : Buffer.from(bytes, "base64");
  return { vfsPath, encoding: "base64", data: buf.toString("base64") };
}
