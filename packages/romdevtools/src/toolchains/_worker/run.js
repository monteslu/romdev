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

// The pure marshalling + output helpers moved to ../common/io.js (so the
// browser-loadable pipeline never imports this node-only module). Re-exported
// here so every existing `from "../_worker/run.js"` import keeps working.
export { textFile, binaryFile, getOutputBytes, getOutputText } from "../common/io.js";
