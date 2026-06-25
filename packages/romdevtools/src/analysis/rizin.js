// rizin.js — thin driver for the Rizin RE analysis engine (romdev-analysis).
//
// Rizin runs as a one-shot CLI through the same isolated worker pool as the
// toolchains: `rizin -q -e scr.color=0 -c "<commands>" /work/rom.bin`.
// Output arrives on stdout (the emscripten patch routes rizin's cons layer
// through Module.print). JSON commands (aflj / axtj / agf json / pdj / iIj)
// give machine-readable results — prefer them from tool code.
//
// ⚠ Do NOT issue plugin-LISTING commands (`La`, `e asm.arch=??`) — they trap
// on a fn-pointer signature mismatch in the wasm build (see
// scripts/patches/README.md, Family 3). Everything on the analysis path works.
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import { readFile } from "node:fs/promises";
import { runIsolated } from "../toolchains/_worker/run.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Resolve the rizin glue path: romdev-analysis package first, then the
 * gitignored src/analysis/wasm staging dir (dev fallback). */
export function rizinGluePath() {
  try {
    const pkgDir = path.dirname(fileURLToPath(import.meta.resolve("romdev-analysis")));
    const p = path.join(pkgDir, "wasm", "rizin.js");
    if (fs.existsSync(p)) return p;
  } catch { /* package not installed — fall through to staging */ }
  const staged = path.join(__dirname, "wasm", "rizin.js");
  if (fs.existsSync(staged)) return staged;
  throw new Error(
    "rizin.wasm not found: install romdev-analysis or run scripts/build-rizin.sh"
  );
}

/** Map a romdev platform id to rizin asm.arch (null = let rizin's bin loader
 * sniff it — it natively detects iNES, GBA, SMD, GB and others). */
export const RIZIN_ARCH = {
  nes: "6502",
  atari2600: "6502",
  atari7800: "6502",
  c64: "6502",
  lynx: "6502", // 65C02 — 6502 plugin covers the base set
  sms: "z80",
  gg: "z80",
  msx: "z80",
  gb: "gb",
  gbc: "gb",
  gba: "arm",
  genesis: "m68k",
  snes: "snes", // rizin's 65816 plugin
  // HuC6280 — rizin has no HuC6280 plugin, but its 6502 plugin decodes the
  // 65C02 base well enough for FUNCTION/loader purposes (standard control flow).
  // Custom block-transfer/MMU opcodes mis-decode in the rizin disasm, but the
  // DECOMPILER uses the proper HuC6280 SLEIGH spec — so CFG/xrefs/functions are
  // approximate on PCE while decompile is accurate.
  pce: "6502",
  // 32-bit MIPS tier (analysis-first; the MIPS plugin ships in rizin.wasm). PS1 =
  // R3000 little-endian; N64 = R4300 big-endian. Endianness comes from RIZIN_ENDIAN
  // below — same arch, different byte order.
  ps1: "mips",
  n64: "mips",
};

/** Byte order per platform, for shared-arch families that ship both (MIPS). Only
 *  platforms NOT matching their arch default need an entry; absent → use the
 *  loader/arch default. PS1 is little, N64 is big. */
export const RIZIN_ENDIAN = {
  ps1: "little",
  n64: "big",
};

/**
 * Run rizin one-shot against a ROM (or any binary).
 *
 * The final command's output is redirected to a MEMFS file (`cmd > /work/out`)
 * and read back, rather than scraped from stdout. Rizin's cons layer flushes
 * its print buffer at 64KB boundaries WITHOUT a trailing newline, and the
 * worker's line-oriented capture would inject a stray newline mid-token — file
 * redirection sidesteps the chunking entirely and is exact for large JSON.
 *
 * @param {{
 *   romPath?: string,            // host path (read + injected into MEMFS)
 *   romBytes?: Uint8Array,       // OR raw bytes
 *   commands: string,            // rizin command string, ';'-separated
 *   arch?: string,               // explicit asm.arch override (else bin-sniffed)
 *   bits?: number,               // asm.bits override
 *   baddr?: number,              // base address override (rizin -B)
 *   writeable?: boolean,         // open file in rw mode (rizin -w) for patching
 * }} opts
 * @returns {Promise<{exitCode:number, output:string, log:string, crash?:object}>}
 */
export async function runRizin(opts) {
  const { romPath, romBytes, commands, arch, bits, baddr, writeable, timeoutMs, endian } = opts;
  if (!commands) throw new Error("runRizin: commands required");
  const bytes = romBytes ?? new Uint8Array(await readFile(romPath));

  const pre = ["e scr.color=0", "e scr.interactive=false", "e scr.prompt=false"];
  if (arch) pre.push(`e asm.arch=${arch}`);
  if (bits) pre.push(`e asm.bits=${bits}`);
  // Endianness matters for shared-arch families that ship both byte orders — most
  // pressingly MIPS: PS1 (R3000) is little-endian, N64 (R4300) is big-endian, same
  // `mips` plugin. Set both asm + cfg so the disasm AND the analysis loader agree.
  if (endian === "big" || endian === "little") {
    // `cfg.bigendian` is the rizin config var (there is NO `asm.bigendian` —
    // setting it errors). cfg.bigendian drives BOTH the disasm and the analysis.
    pre.push(`e cfg.bigendian=${endian === "big" ? "true" : "false"}`);
  }

  // Split trailing command off so its output (only) goes to the file. Earlier
  // commands (aaa, config) print nothing we need. Rizin's `cmd > file` writes
  // that command's result to MEMFS.
  const parts = commands.split(";");
  const last = parts.pop().trim();
  const head = parts.map((s) => s.trim()).filter(Boolean);
  const OUT = "/work/out.txt";
  const script = [...pre, ...head, `${last} > ${OUT}`].join("; ");

  const argv = ["-q"];
  if (baddr != null) argv.push("-B", "0x" + baddr.toString(16));
  if (writeable) argv.push("-w");
  argv.push("-c", script, "/work/rom.bin");

  const res = await runIsolated({
    gluePath: rizinGluePath(),
    argv,
    // A5: per-call timeout so a hung analysis (whole-ROM `aaa` on a multi-MB ROM)
    // can't wedge the shared worker pool — on timeout the worker is killed +
    // recycled and this call returns a clean { timedOut, log } result. Default
    // 60s; callers can override (a scoped `af @ addr` pass is near-instant).
    timeoutMs: timeoutMs ?? 60000,
    inputFiles: [{
      vfsPath: "/work/rom.bin",
      encoding: "base64",
      data: Buffer.from(bytes).toString("base64"),
    }],
    outputFiles: [{ vfsPath: OUT, encoding: "utf8" }],
  });
  // Surface a timeout as a thrown error so JSON callers get a clear signal
  // (runRizinJson already wraps crashes; this makes the timeout explicit).
  if (res.timedOut) {
    const e = new Error(res.log?.trim() || "rizin analysis timed out");
    /** @type {any} */ (e).timedOut = true;
    throw e;
  }
  return { ...res, output: res.outputs?.[OUT] ?? "" };
}

/** Run rizin and parse the redirected command output as JSON. */
export async function runRizinJson(opts) {
  const res = await runRizin(opts);
  if (res.crash) {
    throw new Error(`rizin crashed: ${res.log?.slice(-400) ?? "no log"}`);
  }
  const text = (res.output ?? "").trim();
  const start = text.search(/[\[{]/);
  if (start === -1) {
    throw new Error(
      `rizin returned no JSON (exit=${res.exitCode}): ${(res.log ?? text).slice(0, 400)}`
    );
  }
  return JSON.parse(text.slice(start));
}
