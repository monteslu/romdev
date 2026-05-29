// tcc-65816 — Tiny C Compiler fork that emits wla-dx assembly for the
// WDC 65816 (SNES CPU). Bundled as WASM via scripts/build-tcc816.sh.
//
// STATUS (R14, 2026-05-26): tcc itself works end-to-end through the
// pool — `runTcc816({source})` returns the .s assembly. The full
// `C source → SNES ROM` pipeline ALSO needs wla-65816 + wlalink (to
// assemble + link the tcc output) AND a libpvsneslib-equivalent
// runtime + crt0. Those two are pending — see PLAN.md for the
// roadmap. Today this module is callable directly (for agents
// inspecting what tcc would produce for a given C source) but is
// NOT wired into buildSource yet.

import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import path from "node:path";

import { runIsolated, textFile, getOutputText } from "../_worker/run.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// tcc816's WASM ships in @romdev/platform-snes (the SNES platform is the only
// consumer). Resolve from that package; fall back to a local copy under src/
// if present (transition / dev). The package is a hard dep of romdev.
function resolveTcc816Glue() {
  try {
    const u = import.meta.resolve("@romdev/platform-snes");
    const p = path.join(path.dirname(fileURLToPath(u)), "wasm", "tcc816.js");
    if (existsSync(p)) return p;
  } catch { /* package not resolvable — fall through to local */ }
  const local = path.join(__dirname, "wasm", "tcc816.js");
  if (existsSync(local)) return local;
  throw new Error("tcc816 WASM not found — install @romdev/platform-snes");
}
// Lazy + memoized: resolve only on the first tcc816 (SNES C) build, not at boot.
let _gluePath;
const gluePath = () => (_gluePath ??= resolveTcc816Glue());

/**
 * Compile a C source to 65816 assembly via tcc-65816.
 *
 * @param {Object} args
 * @param {string} args.source main C source
 * @param {Record<string, string>} [args.headers] virtual headers visible to tcc via -I/work
 * @param {string[]} [args.options] extra tcc flags
 * @param {boolean} [args.hirom] route through tcc's -H flag (Mode 21)
 * @param {boolean} [args.fastrom] route through tcc's -F flag
 * @returns {Promise<{log:string, exitCode:number, asmSource:string|null, crash?:any}>}
 */
export async function runTcc816(args) {
  const { source, options = [], hirom, fastrom } = args;
  const headers = args.headers ?? {};
  /** @type {import("../_worker/run.js").InputFile[]} */
  const inputFiles = [textFile("/work/main.c", source)];
  for (const [name, content] of Object.entries(headers)) {
    inputFiles.push(textFile("/work/" + name, content));
  }
  const argv = [
    ...(hirom ? ["-H"] : []),
    ...(fastrom ? ["-F"] : []),
    "-c",
    "-I", "/work",
    ...options,
    "-o", "/work/out.s",
    "/work/main.c",
  ];
  const r = await runIsolated({
    gluePath: gluePath(),
    argv,
    inputFiles,
    outputFiles: [{ vfsPath: "/work/out.s", encoding: "utf8" }],
  });
  return {
    log: r.log,
    exitCode: r.exitCode,
    asmSource: getOutputText(r, "/work/out.s") || null,
    ...(r.crash ? { crash: r.crash, stage: "crash" } : {}),
  };
}
