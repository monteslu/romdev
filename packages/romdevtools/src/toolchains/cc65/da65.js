// da65 — cc65's 6502 / 65C02 / 65816 disassembler, in WASM.
//
// Run with --cpu 6502 (default). For SNES/65816 use --cpu 65816.

import { fileURLToPath } from "node:url";
import path from "node:path";

import { runIsolated, textFile, binaryFile } from "../_worker/run.js";
import { resolveGlueFile } from "../common/wasm-tool.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// da65's WASM ships in romdev-toolchain-cc65 (alongside cc65 / ca65 / ld65); a
// local src/ copy is the dev fallback. Lazy + memoized: resolve only on the
// first da65 disassembly, not at boot.
let _glue;
const glue = () =>
  (_glue ??= resolveGlueFile({
    pkg: "romdev-toolchain-cc65",
    file: "da65.js",
    localDir: __dirname,
    label: "da65",
  }));

/** True if the da65 WASM (romdev-toolchain-cc65) is installed/resolvable, without
 *  throwing — for capability probes (catalog status) that must not crash when the
 *  toolchain is absent. */
export function da65Available() {
  try { return !!glue(); } catch { return false; }
}

/**
 * Disassemble a chunk of bytes.
 *
 * da65 quirk: by default it treats input bytes as DATA (emits `.byte`)
 * for 65816/65c02/etc. and only decodes opcodes for ranges marked as
 * Code in an info file. The 6502 default happens to decode because of
 * compatibility behavior. For non-6502 CPUs we synthesize a minimal
 * info file that declares the entire input range as Code. Callers can
 * override by passing their own `info` string.
 *
 * @param {Object} args
 * @param {Uint8Array} args.bytes   the bytes to disassemble
 * @param {"6502" | "65c02" | "65816" | "65sc02" | "huc6280"} [args.cpu] CPU dialect (default 6502)
 * @param {number} [args.startAddress] address of the first byte (default 0x8000 for NES)
 * @param {string} [args.info] explicit da65 info-file contents. If omitted
 *   AND cpu is non-6502, a minimal "treat the whole input as Code" info
 *   file is synthesized so the agent gets actual mnemonics.
 * @param {{start:number,end:number}[]} [args.codeSpans] region-relative byte
 *   offsets of REAL code (from the analysis engine). When present, only these
 *   ranges are declared `TYPE Code`; the gaps stay Data (`.byte`). This is what
 *   keeps a data byte mid-region from mis-decoding and desyncing everything
 *   after it. Ignored on 6502 (no width state to desync; the whole-range Code
 *   default already round-trips). Overridden by an explicit `info`.
 * @param {string[]} [args.options] extra da65 flags
 * @returns {Promise<{ asm: string, log: string, exitCode: number }>}
 */
export async function runDa65(args) {
  const cpu = args.cpu ?? "6502";
  const startAddress = args.startAddress ?? 0x8000;
  const extra = args.options ?? [];
  // Info-file precedence: explicit `info` > code-map RANGEs (65816 + spans) >
  // the whole-range-Code default (non-6502). 6502 with no spans/info uses da65's
  // built-in decode (no info file). An EMPTY spans array (`[]`, "region is all
  // data") is distinct from absent (`undefined`, "no code map — decode it all"):
  // for empty spans on 65816, codeMapInfo emits an info with zero Code RANGEs so
  // da65 dumps the whole region as `.byte`.
  const info = args.info
    ?? (cpu === "65816" && Array.isArray(args.codeSpans)
        ? codeMapInfo(startAddress, args.codeSpans, cpu)
        : (cpu !== "6502" ? defaultCodeInfo(startAddress, args.bytes.length, cpu) : null));

  /** @type {import("../_worker/run.js").InputFile[]} */
  const inputFiles = [binaryFile("/work/in.bin", args.bytes)];
  if (info) inputFiles.push(textFile("/work/in.info", info));
  // da65 writes output to stdout (we capture via the worker's print).
  const argv = [
    "--cpu", cpu,
    "--start-addr", "$" + startAddress.toString(16).toUpperCase(),
    ...(info ? ["-i", "/work/in.info"] : []),
    ...extra,
    "/work/in.bin",
  ];
  const r = await runIsolated({
    gluePath: glue(),
    argv,
    inputFiles,
  });
  return {
    asm: r.log,
    log: "",
    exitCode: r.exitCode,
    ...(r.crash ? { crash: r.crash, stage: "crash" } : {}),
  };
}

/**
 * Synthesize the minimum da65 info file that gets opcodes decoded.
 * Forces the entire input range to be treated as Code rather than
 * Data (the default for non-6502 CPUs).
 *
 * @param {number} startAddress
 * @param {number} length bytes available
 * @param {string} cpu
 */
function defaultCodeInfo(startAddress, length, cpu) {
  // Don't put CPU in the info file — we already pass --cpu, and da65
  // errors on duplicate. INPUTOFFS too; we set --start-addr.
  // 65816 RANGEs need an ADDRMODE: M0X0 = both 16-bit, M1X1 = both 8-bit
  // (the reset state). Default to M1X1 — matches what hardware boots
  // into. Caller can override via custom info string for 16-bit modes.
  const hex = (n) => "$" + n.toString(16).toUpperCase();
  const endAddress = startAddress + length - 1;
  // da65 ADDRMODE grammar (from src/da65/infofile.c):
  //   char 0 must be 'm' or 'M' (lowercase = A is 16-bit, uppercase = 8-bit)
  //   char 1 must be 'x' or 'X' (lowercase = X/Y are 16-bit, uppercase = 8-bit)
  // Post-reset SNES state is 8-bit A AND 8-bit X/Y → "MX".
  // RANGE START/END are 16-bit only — da65 doesn't accept 24-bit
  // bank-prefixed addresses in info-file RANGEs (it's an old NES/65xx
  // tool). Strip the bank for the info file; we'll still pass the full
  // 24-bit start to --start-addr so the asm output uses real labels.
  const lo16 = (n) => "$" + (n & 0xFFFF).toString(16).toUpperCase();
  const start16 = lo16(startAddress);
  const end16 = lo16(endAddress);
  // Top-level sections (RANGE { ... }) need a trailing semicolon, per
  // da65's parser (src/da65/infofile.c line 921 InfoConsumeSemi after
  // each section).
  if (cpu === "65816") {
    return `RANGE {\n  START ${start16};\n  END ${end16};\n  TYPE Code;\n  ADDRMODE "MX";\n};\n`;
  }
  return `RANGE { START ${hex(startAddress)}; END ${hex(endAddress)}; TYPE Code; };\n`;
}

/**
 * Build a da65 info file that declares ONLY the given spans as `TYPE Code`.
 * Everything not covered stays da65's default (Data → `.byte`). This is the
 * 65816 readability-floor fix: da65 decodes real functions as opcodes and never
 * tries to decode inline data (which would mis-decode and desync the .a8/.i8
 * width state for the rest of the region). Byte-exact by construction — the
 * gaps are literal bytes, the code round-trips.
 *
 * `spans` are region-relative byte offsets ({start, end} half-open); we add
 * `startAddress` to get CPU addresses, then strip to the low 16 bits (da65
 * RANGEs are 16-bit — the bank comes from --start-addr). Spans are assumed
 * pre-merged, non-overlapping, sorted; each maps to one Code RANGE.
 *
 * @param {number} startAddress CPU address of region byte 0
 * @param {{start:number,end:number}[]} spans region-relative code byte offsets
 * @param {string} _cpu (only 65816 reaches here — kept for call-site symmetry)
 */
function codeMapInfo(startAddress, spans, _cpu) {
  const lo16 = (n) => "$" + ((startAddress + n) & 0xFFFF).toString(16).toUpperCase();
  // ADDRMODE "MX" = post-reset 8-bit A / 8-bit X,Y — the entry width for each
  // span. NOTE: da65 does NOT auto-widen on a mid-span `rep #$30`, so a 16-bit
  // immediate after a rep can render one byte short + a spurious following op.
  // That's still BYTE-EXACT (the reassemble heal pins any line whose bytes don't
  // round-trip), just imperfect readability inside 16-bit routines. Threading
  // the real M/X state (from a break-instant P, or a rep/sep scan) into the seed
  // is the future quality win; the entry seed is correct for boot/8-bit code.
  return spans
    .map((s) => `RANGE {\n  START ${lo16(s.start)};\n  END ${lo16(s.end - 1)};\n  TYPE Code;\n  ADDRMODE "MX";\n};\n`)
    .join("");
}
