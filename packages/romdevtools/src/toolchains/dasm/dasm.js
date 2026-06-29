// dasm — bundled 6502/6507 assembler (Atari 2600 + classic 6502).
//
// Runs in an isolated child worker for crash isolation.

import { fileURLToPath } from "node:url";
import path from "node:path";

import { runIsolated, textFile, getOutputBytes, getOutputText } from "../_worker/run.js";
import { resolveGlueFile } from "../common/wasm-tool.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// dasm's WASM ships in romdev-platform-atari2600 (the only platform that uses
// it); a local src/ copy is the dev fallback. Lazy + memoized: resolve only on
// the FIRST dasm build, not at boot — so booting the server never touches this
// package unless an Atari 2600 ROM is actually built.
let _gluePath;
const gluePath = () =>
  (_gluePath ??= resolveGlueFile({
    pkg: "romdev-platform-atari2600",
    file: "dasm.js",
    localDir: __dirname,
    label: "dasm",
  }));

/**
 * Run dasm on a source program in-memory.
 *
 * @param {Object} args
 * @param {string} args.source main assembly source
 * @param {Record<string, string>} [args.includes] virtual filename → source, mapped into MEMFS for `include`
 * @param {string[]} [args.options] additional CLI flags passed to dasm (e.g. ['-f3'])
 * @param {"raw" | "f1" | "f2" | "f3"} [args.outputFormat] dasm output format
 * @returns {Promise<{ binary: Uint8Array | null, listing: string, symbols: string, log: string, exitCode: number, crash?: any, stage?: string }>}
 */
export async function runDasm(args) {
  const { source } = args;
  if (typeof source !== "string") throw new TypeError("runDasm: source is required");
  const includes = args.includes ?? {};
  const extraOpts = args.options ?? [];
  const fmt = args.outputFormat ?? "raw";
  const fmtFlag =
    fmt === "raw" || fmt === "f1" ? "-f1" :
    fmt === "f2" ? "-f2" :
    fmt === "f3" ? "-f3" :
    "-f1";

  /** @type {import("../_worker/run.js").InputFile[]} */
  const inputFiles = [textFile("/work/main.asm", source)];
  for (const [name, content] of Object.entries(includes)) {
    inputFiles.push(textFile("/work/" + name, content));
  }

  const argv = [
    "/work/main.asm",
    "-o/work/out.bin",
    "-l/work/out.lst",
    "-s/work/out.sym",
    fmtFlag,
    ...extraOpts,
  ];
  const r = await runIsolated({
    gluePath: gluePath(),
    argv,
    inputFiles,
    outputFiles: [
      { vfsPath: "/work/out.bin", encoding: "base64" },
      { vfsPath: "/work/out.lst", encoding: "utf8" },
      { vfsPath: "/work/out.sym", encoding: "utf8" },
    ],
  });

  let exitCode = r.exitCode;
  // dasm prints `Complete. (N)` where N is its error count. callMain's exit
  // value doesn't reliably propagate through Emscripten, so we parse the log.
  if (exitCode === 0) {
    const m = /Complete\. \((\d+)\)/.exec(r.log);
    if (m) exitCode = parseInt(m[1], 10);
  }

  return {
    binary: getOutputBytes(r, "/work/out.bin"),
    listing: getOutputText(r, "/work/out.lst"),
    symbols: getOutputText(r, "/work/out.sym"),
    log: r.log,
    exitCode,
    ...(r.crash ? { crash: r.crash, stage: "crash" } : {}),
  };
}
