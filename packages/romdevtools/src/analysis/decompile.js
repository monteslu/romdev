// decompile.js — drive the Ghidra decompiler WASM (romdev-analysis-decompiler)
// to turn a function into C pseudocode. Runs the decompiler's REPL one-shot
// through the isolated worker pool: mount the SLEIGH home + the ROM image,
// feed `load file <langid> <rom>; map function <addr>; decompile; print C`.
//
// The ROM is loaded as a RAW binary at VMA 0 — so the address passed must be a
// FILE OFFSET into the image we hand it, not a banked CPU address. Callers that
// have a CPU address use the disasm mappers to slice the right bank first; for
// the common flat/first-bank case the file offset equals the CPU address minus
// the platform's load base (handled in analyze.js).
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import { runIsolated } from "../toolchains/_worker/run.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Resolve the decompiler package (or the gitignored src staging fallback). */
function decompilerPaths() {
  let base;
  try {
    base = path.dirname(fileURLToPath(import.meta.resolve("romdev-analysis-decompiler")));
  } catch { base = null; }
  const candidates = [
    base && { js: path.join(base, "wasm", "decompile.js"), sleigh: path.join(base, "sleigh") },
    { js: path.join(__dirname, "decompiler", "wasm", "decompile.js"), sleigh: path.join(__dirname, "decompiler", "sleigh") },
  ].filter(Boolean);
  for (const c of candidates) if (fs.existsSync(c.js)) return c;
  throw new Error(
    "decompiler not found: install romdev-analysis-decompiler or run scripts/build-decompiler.sh"
  );
}

/** romdev platform → Ghidra SLEIGH language id. null = not decompilable yet. */
export const SLEIGH_LANGID = {
  nes: "6502:LE:16:default",
  atari2600: "6502:LE:16:default",
  atari7800: "6502:LE:16:default",
  c64: "6502:LE:16:default",
  lynx: "65C02:LE:16:default",
  sms: "z80:LE:16:default",
  gg: "z80:LE:16:default",
  msx: "z80:LE:16:default",
  gb: "SM83:LE:16:default",
  gbc: "SM83:LE:16:default",
  gba: "ARM:LE:32:v4t",
  genesis: "68000:BE:32:default",
  snes: "65816:LE:24:snes",
  pce: "HuC6280:LE:16:default",
  // 32-bit MIPS tier. PS1 R3000 = little-endian; N64 R4300 = big-endian (games run
  // 32-bit MIPS III code). Ghidra ships both MIPS variants in its stock SLEIGH.
  ps1: "MIPS:LE:32:default",
  n64: "MIPS:BE:32:default",
  // Dreamcast = SH-4 (SuperH), little-endian. Ghidra ships SuperH4 in its stock
  // SLEIGH; we compile SuperH4_le.sla (see scripts/build-decompiler.sh).
  dreamcast: "SuperH4:LE:32:default",
};

/**
 * Decompile the function at `fileOffset` in `romBytes` for `platform`.
 * @returns {{platform, langid, address, code, warnings:string[], raw:string}}
 */
export async function decompileFunction({ platform, romBytes, fileOffset, name = "fn_target", baseAddress = 0 }) {
  const langid = SLEIGH_LANGID[platform];
  if (!langid) throw new Error(`decompile: no SLEIGH language for platform '${platform}'`);
  const { js, sleigh } = decompilerPaths();
  // With a base address the image is placed at its TRUE virtual address, so absolute
  // calls, global references and jump tables resolve as they will in the running
  // program, and Ghidra's own names carry the real VA. `adjust vma` takes a `long`,
  // which is 32 bits in WASM: a base >= 0x80000000 would go negative, so it is applied
  // in two halves (adjustVma accumulates).
  const base = (baseAddress >>> 0);
  const addr = "0x" + ((base + (fileOffset >>> 0)) >>> 0).toString(16);
  const adjust = [];
  if (base) {
    const h1 = Math.floor(base / 2), h2 = base - h1;
    adjust.push(`adjust vma 0x${h1.toString(16)}`);
    if (h2) adjust.push(`adjust vma 0x${h2.toString(16)}`);
  }

  // REPL script. RawBinary loads at vma 0 (or the base); `print C` emits the pseudocode.
  const script = [
    `load file ${langid} /work/rom.bin`,
    ...adjust,
    `map function ${addr} ${name}`,
    `decompile ${name}`,
    `print C`,
    `quit`,
    "",
  ].join("\n");

  const res = await runIsolated({
    gluePath: js,
    argv: [],
    env: { SLEIGHHOME: "/sleigh" },
    stdinText: script,
    hostDirMounts: [{ hostDir: sleigh, vfsDir: "/sleigh" }],
    inputFiles: [{
      vfsPath: "/work/rom.bin",
      encoding: "base64",
      data: Buffer.from(romBytes).toString("base64"),
    }],
  });

  const raw = res.log ?? "";
  // The decompiler echoes each prompt; the C body follows `print C`.
  const code = extractC(raw);
  const warnings = [...raw.matchAll(/\/\* WARNING: (.+?) \*\//g)].map((m) => m[1]);
  if (!code) {
    throw new Error(`decompile produced no C output (exit=${res.exitCode}): ${raw.slice(-400)}`);
  }
  return { platform, langid, address: fileOffset, addressHex: addr, baseAddress: base, code, warnings, raw };
}

/** Pull the C function text out of the REPL transcript (between `print C` and
 * the next `[decomp]>` prompt). */
function extractC(transcript) {
  const lines = transcript.split("\n");
  const start = lines.findIndex((l) => /\[decomp\]>\s*print C\b/.test(l));
  if (start === -1) return null;
  const body = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\[decomp\]>/.test(lines[i])) break;
    body.push(lines[i]);
  }
  const text = body.join("\n").trim();
  return text.length ? text : null;
}
