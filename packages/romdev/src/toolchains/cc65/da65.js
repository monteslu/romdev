// da65 — cc65's 6502 / 65C02 / 65816 disassembler, in WASM.
//
// Run with --cpu 6502 (default). For SNES/65816 use --cpu 65816.

import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import path from "node:path";

import { runIsolated, textFile, binaryFile } from "../_worker/run.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// da65's WASM ships in @romdev/toolchain-cc65 (alongside cc65 / ca65 / ld65).
// Resolve from that package; fall back to a local copy under src/ if present
// (transition / dev). The package is a hard dep of romdev.
function resolveDa65Glue() {
  try {
    const u = import.meta.resolve("@romdev/toolchain-cc65");
    const p = path.join(path.dirname(fileURLToPath(u)), "wasm", "da65.js");
    if (existsSync(p)) return p;
  } catch { /* package not resolvable — fall through to local */ }
  const local = path.join(__dirname, "wasm", "da65.js");
  if (existsSync(local)) return local;
  throw new Error("da65 WASM not found — install @romdev/toolchain-cc65");
}
const GLUE = resolveDa65Glue();

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
 * @param {string[]} [args.options] extra da65 flags
 * @returns {Promise<{ asm: string, log: string, exitCode: number }>}
 */
export async function runDa65(args) {
  const cpu = args.cpu ?? "6502";
  const startAddress = args.startAddress ?? 0x8000;
  const extra = args.options ?? [];
  // Synthesize a minimal info file for non-6502 CPUs so da65 emits
  // mnemonics instead of `.byte` data dumps. RANGE Type=Code is the
  // magic incantation.
  const info = args.info ?? (cpu !== "6502" ? defaultCodeInfo(startAddress, args.bytes.length, cpu) : null);

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
    gluePath: GLUE,
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
