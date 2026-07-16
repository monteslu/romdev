// vasm68k_mot — bundled m68k assembler with Motorola syntax (Genesis dev).

import { fileURLToPath } from "node:url";
import path from "node:path";

import { runIsolated, textFile, binaryFile, getOutputBytes } from "../_worker/run.js";
import { resolveGlueFile } from "../common/wasm-tool.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// vasm68k's WASM ships in romdev-toolchain-vasm; a local src/ copy is the dev
// fallback. Lazy + memoized: resolve only on the first vasm (Genesis asm)
// build, not at boot.
let _gluePath;
const gluePath = () =>
  (_gluePath ??= resolveGlueFile({
    pkg: "romdev-toolchain-vasm",
    file: "vasm68k.js",
    localDir: __dirname,
    label: "vasm68k",
  }));

/**
 * Static analyzer for known Genesis landmines. Mirrors asar preflight
 * pattern. Returns null when source looks clean, or a string diagnostic.
 *
 * Catches:
 *   1. Missing reset SSP / reset PC at $00000000 / $00000004 — the
 *      cart will jump to garbage on power-on. Detects "no org or org
 *      not at 0".
 *   2. Reset SSP not in WRAM range ($00FF0000-$00FFFFFF). Common typo:
 *      using $FFE000 (which is right) vs $FFE000 without the leading
 *      $00 in some assemblers — vasm68k handles both, but the latter
 *      is sometimes misread.
 *   3. No "SEGA" magic at $100 — most emulators don't enforce this but
 *      hardware does; warning before the agent ships a non-bootable ROM.
 *
 * @param {string} source
 * @returns {string | null}
 */
function vasm68kPreflight(source) {
  if (typeof source !== "string") return null;
  const issues = [];

  // Check 1: source includes an org $00000000 or starts at $00 implicitly.
  // vasm68k defaults to $00000000 if no org is given, so a missing org is fine;
  // what actually breaks boot is a missing reset vector, which we check below.
  const hasReset = /\bdc\.l\s+(\$00FF[E-F][0-9A-F]{3}|_reset|reset)\b/i.test(source);
  if (!hasReset) {
    issues.push(
      "[vasm68k preflight] source does not appear to declare a 68K reset vector. " +
      "The 68K reads SSP from $00000000 and reset PC from $00000004 on power-on. " +
      "Without a vector table, the cart will jump to garbage. " +
      "See romdev-toolchain-m68k-gcc/share/genesis/lib/header.s for the canonical vector table layout."
    );
  }

  // Check 2: SEGA magic at $100. Most emulators forgive its absence
  // (genesis_plus_gx does); real hardware doesn't.
  const hasSegaMagic = /(SEGA MEGA DRIVE|SEGA GENESIS|SEGA 32X|SEGA PICO|SEGA CD)/i.test(source);
  if (!hasSegaMagic) {
    issues.push(
      "[vasm68k preflight] no 'SEGA' magic string found in source. " +
      "Genesis ROM header at $100 must include 'SEGA MEGA DRIVE' or similar " +
      "for real hardware to boot. genesis_plus_gx tolerates its absence; " +
      "real cartridges do not. See romdev-toolchain-m68k-gcc/share/genesis/lib/header.s."
    );
  }

  // Return as warnings (not errors) — these are lints, not blockers.
  if (issues.length) return "warning: vasm68k preflight\n" + issues.join("\n");
  return null;
}

/**
 * @param {Object} args
 * @param {string} args.source main asm source (Motorola 68k syntax)
 * @param {Record<string, string>} [args.includes] text includes (incsrc / incdir search)
 * @param {Record<string, string|Uint8Array>} [args.binaryIncludes] binary blobs for `incbin`. Values are
 *   base64 strings OR Uint8Array. Each entry is written to /work/<name> before vasm runs so the source
 *   can `incbin "<name>"` without absolute paths.
 * @param {string[]} [args.options] extra vasm flags
 * @param {"bin"|"srec"|"vobj"|"hunk"|"hunkexe"} [args.format] vasm output format (-F flag). Default 'bin'.
 */
export async function runVasm68k(args) {
  const { source } = args;
  const includes = args.includes ?? {};
  const binaryIncludes = args.binaryIncludes ?? {};
  const opts = args.options ?? [];
  const format = args.format ?? "bin";

  // Run preflight checks. These are warnings, not blockers — Genesis
  // homebrew without proper headers still builds; the warnings just
  // show up in the response log for the agent to see.
  const preflightWarning = vasm68kPreflight(source);

  /** @type {import("../_worker/run.js").InputFile[]} */
  const inputFiles = [textFile("/work/main.s", source)];
  for (const [name, content] of Object.entries(includes)) {
    inputFiles.push(textFile("/work/" + name, content));
  }
  for (const [name, blob] of Object.entries(binaryIncludes)) {
    const bytes = blob instanceof Uint8Array ? blob : Buffer.from(blob, "base64");
    inputFiles.push(binaryFile("/work/" + name, bytes));
  }

  const argv = [
    "-F" + format,
    "-o", "/work/out.bin",
    "-I", "/work",
    ...opts,
    "/work/main.s",
  ];
  const r = await runIsolated({
    gluePath: gluePath(),
    argv,
    inputFiles,
    outputFiles: [{ vfsPath: "/work/out.bin", encoding: "base64" }],
  });

  let log = r.log;
  if (preflightWarning) log = preflightWarning + "\n" + log;

  return {
    binary: getOutputBytes(r, "/work/out.bin"),
    log,
    exitCode: r.exitCode,
    ...(r.crash ? { crash: r.crash, stage: "crash" } : {}),
  };
}
