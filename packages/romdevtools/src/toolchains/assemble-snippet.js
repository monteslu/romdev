// assembleSnippet — take a small chunk of asm and return raw bytes.
//
// NOT a full build. NO header, NO linker config, NO segments. Just:
//   { cpu: "6502", origin: 0xC500, code: "lda #$05\nsta $0123\nrts" }
//   → { bytes: Uint8Array, asm: "...effective source...", log: string }
//
// This is the highest-leverage tool for ROM-hacking workflows: paired
// with patchFile, the agent does "assemble → splice" in 2 MCP calls
// instead of writing a wrapper.s + linkerConfig for every byte patch.
//
// Each CPU routes to the right assembler:
//   6502, 65c02, huc6280  → ca65 + ld65 with synthesized minimal config
//   65816                 → asar (uses inline `org` directive, emits raw)
//   68k                   → vasm68k -Fbin
//   z80                   → sdasz80 + sdld (via the existing sdcc helpers)
//   sm83 (gb/gbc)         → rgbasm + rgblink + rgbfix -p 0 (flat binary)
//   spc700                → NOT YET BUNDLED — throws structured error
//
// All return shape: { ok: true, cpu, origin, bytes: Uint8Array, length, hex, asm, log }

import path from "node:path";
import { fileURLToPath } from "node:url";

import { runCa65, runLd65 } from "./cc65/cc65.js";
import { runAsar } from "./asar/asar.js";
import { runVasm68k } from "./vasm68k/vasm68k.js";
import { runSdasz80, runSdld, ihxToBin } from "./sdcc/sdcc.js";
import { runRgbasm, runRgblink, runRgbfix } from "./rgbds/rgbds.js";
import { parseBuildLog } from "./parse-errors.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Build a transparent snippet-assembly error: lead with the FIRST structured
// diagnostic (file:line: message) parsed out of the raw log — the same
// issues[]-style surfacing build() does — instead of dumping the unparsed
// assembler stdout and making the agent grep it. Full log still appended for
// fallback. `where` is e.g. "ca65" / "ld65 link" / "asar".
function asmError(where, log) {
  const issues = parseBuildLog(log ?? "");
  const first = issues.find((i) => i.severity === "error") ?? issues[0];
  const headline = first
    ? `${first.file ? first.file + ":" : ""}${first.line ? first.line + ": " : ""}${first.message}`
    : "no structured diagnostic found";
  return new Error(
    `assembleSnippet[${where}] failed: ${headline}` +
    (issues.length > 1 ? ` (+${issues.length - 1} more issue(s))` : "") +
    `\nFix the source line above. Full assembler log:\n${log ?? ""}`,
  );
}

/**
 * CPU dialect → assembler dispatch. Keys are also the public API.
 */
const CPU_ASSEMBLERS = {
  "6502":    assembleCa65,
  "65c02":   assembleCa65,
  "huc6280": assembleCa65,
  "65816":   assembleAsar,
  "68k":     assembleVasm68k,
  "m68k":    assembleVasm68k,   // alias
  "z80":     assembleSdcc,
  "sm83":    assembleRgbds,     // GB/GBC LR35902
  "gb":      assembleRgbds,     // alias for sm83
  "gbc":     assembleRgbds,     // alias for sm83
  // spc700 — TODO: would need a dedicated SPC700 assembler bundle. We have
  // NO upstream WASM assembler for SPC700; raw 6502 doesn't work because
  // the ISA differs. Caller gets a clear "not supported yet" message.
  "spc700":  () => { throw new Error(
    "assembleSnippet: spc700 not yet supported. " +
    "No SPC700 assembler is currently bundled (would need to extract one " +
    "from bsnes or write a tiny encoder — captured in plan as future work).");
  },
};

/**
 * Public entry. Pure function shape; resolves to a result or throws.
 *
 * @param {Object} args
 * @param {string} args.cpu        one of the CPU keys above
 * @param {number} [args.origin]   where the code is intended to live in CPU
 *   address space. Required for any code that uses absolute addressing or
 *   relative branches that need a real target. Default 0x0000.
 * @param {string} args.code       the asm source (no .org / no headers needed —
 *   we synthesize them based on cpu + origin).
 * @returns {Promise<{ ok: boolean, cpu: string, origin: number, bytes: Uint8Array, length: number, hex: string, log: string }>}
 */
export async function assembleSnippet(args) {
  const { cpu, code } = args;
  const origin = args.origin ?? 0x0000;
  if (typeof code !== "string" || code.length === 0) {
    throw new Error("assembleSnippet: 'code' must be a non-empty string of asm source");
  }
  const dispatch = CPU_ASSEMBLERS[cpu];
  if (!dispatch) {
    throw new Error(
      `assembleSnippet: unknown cpu '${cpu}'. ` +
      `Supported: ${Object.keys(CPU_ASSEMBLERS).filter((k) => k !== "spc700").join(", ")}.`,
    );
  }
  const { bytes, log } = await dispatch({ origin, code });
  return {
    ok: true,
    cpu,
    origin,
    bytes,
    length: bytes.length,
    hex: Array.from(bytes, (b) => b.toString(16).padStart(2, "0").toUpperCase()).join(" "),
    log: log ?? "",
  };
}

// ─── ca65 (6502 + variants) ────────────────────────────────────────────
// Strategy: write source with `.org` directive, assemble to .o, link with
// a trivial config that places .CODE at the origin and outputs raw bytes.
async function assembleCa65({ origin, code }, cpu = "6502") {
  // Always start with .feature labels_without_colons so simple snippets
  // work with or without colons. ca65 default already accepts colons so
  // this is purely additive.
  const source = `.setcpu "${cpu.toUpperCase()}"\n.segment "CODE"\n${code}\n`;

  const asm = await runCa65({ source });
  if (!asm.object) {
    throw asmError("ca65", asm.log);
  }

  // Minimal linker config: one MEMORY block at `origin`, one SEGMENT
  // mapping CODE there. Output is raw bytes — no header bytes prepended.
  const cfg = `MEMORY { OUT: file = %O, start = $${origin.toString(16).toUpperCase()}, size = $10000 - $${origin.toString(16).toUpperCase()}, fill = no; }
SEGMENTS { CODE: load = OUT, type = ro; }
`;
  const linked = await runLd65({
    objects: { "snippet.o": asm.object },
    target: "none",
    linkerConfig: cfg,
  });
  if (!linked.binary) {
    throw asmError("ld65 link", linked.log);
  }
  return { bytes: linked.binary, log: (asm.log ?? "") + (linked.log ?? "") };
}

// ─── asar (65816) ─────────────────────────────────────────────────────
// Asar normally patches a ROM image. For a snippet we hand it a sentinel-
// filled 64KB scratch + an `org $origin` directive, then scan the file for
// the contiguous non-sentinel run and slice it out. Asar in default
// (LoROM-like) mode maps `$00:8000` → file offset $0000; the exact file
// position doesn't matter because we locate the bytes by scanning.
async function assembleAsar({ origin, code }) {
  if (origin > 0xFFFFFF) {
    throw new Error("assembleSnippet[asar]: origin must be a 24-bit SNES address (e.g. 0x008000)");
  }
  const hex24 = "$" + origin.toString(16).toUpperCase().padStart(6, "0");
  const SENTINEL = 0xAA;
  const baseRom = new Uint8Array(64 * 1024).fill(SENTINEL);
  const source = `org ${hex24}\n${code}\n`;
  const r = await runAsar({ source, baseRom, symbols: false });
  if (!r.binary) {
    throw asmError("asar", r.log);
  }
  const bin = r.binary;
  // Find first non-sentinel byte (asar may have written anywhere depending
  // on how it interpreted the absolute address). Then walk until a long
  // sentinel run signals end-of-code.
  let start = -1;
  for (let i = 0; i < bin.length; i++) {
    if (bin[i] !== SENTINEL) { start = i; break; }
  }
  if (start < 0) {
    throw new Error(`assembleSnippet[asar]: no bytes written (origin 0x${origin.toString(16)}) — the source assembled but emitted nothing at this origin. Check the org address and that the code actually emits bytes.\nFull log:\n${r.log ?? ""}`);
  }
  let end = start + 1;
  let sentinelRun = 0;
  for (let i = start; i < bin.length; i++) {
    if (bin[i] === SENTINEL) {
      sentinelRun++;
      if (sentinelRun >= 64) break;
    } else {
      sentinelRun = 0;
      end = i + 1;
    }
  }
  return { bytes: bin.slice(start, end), log: r.log ?? "" };
}

// ─── vasm68k (m68k) ────────────────────────────────────────────────────
// vasm has -Fbin output mode that emits raw bytes (no header, no symtab).
// We pass org via the source itself.
async function assembleVasm68k({ origin, code }) {
  // vasm motorola syntax treats lines starting in column 0 as labels. We
  // auto-indent any line that doesn't already start with whitespace and
  // doesn't look like a label definition (ends with `:` or starts with a
  // dot for local labels).
  const indented = code.split("\n").map((line) => {
    if (line.length === 0) return line;
    if (line[0] === " " || line[0] === "\t") return line;
    if (/^[A-Za-z_.][\w$]*:/.test(line) || line.startsWith(";") || line.startsWith("*")) return line;
    return "\t" + line;
  }).join("\n");
  const source = `\torg $${origin.toString(16).toUpperCase()}\n${indented}\n`;
  const r = await runVasm68k({ source, options: ["-Fbin"] });
  if (!r.binary || (r.exitCode != null && r.exitCode !== 0)) {
    throw asmError("vasm68k", r.log);
  }
  return { bytes: r.binary, log: r.log ?? "" };
}

// ─── sdcc (z80) ────────────────────────────────────────────────────────
// sdasz80 produces a .rel; sdld relocates _CODE to codeLoc=origin and emits
// an .ihx. We feed sdld a minimal empty crt0 (no entry, no startup code) so
// the snippet bytes are the entire output. Then parse the .ihx and slice
// from origin to the last byte written.
//
// Note: sdas refuses `.org` in a REL area, so we declare `_CODE` as REL and
// let sdld relocate it. Leading tabs are required on each instruction line.
async function assembleSdcc({ origin, code }) {
  const indented = code.split("\n").map((l) => l.trim() ? "\t" + l.trim() : l).join("\n");
  const source = `\t.module snippet\n\t.area _CODE\n${indented}\n`;
  const asm = await runSdasz80({ source });
  if (!asm.rel) {
    throw asmError("sdasz80", asm.log);
  }
  // Minimal empty crt0 rel: just declares _HEADER0 (zero bytes) and is
  // enough for sdld to satisfy its hardcoded crt0.rel dependency.
  const emptyCrt0 = "XL2\nH 1 areas 0 global symbols\nM crt0\nA _HEADER0 size 0 flags 0 addr 0\n";
  const linked = await runSdld({
    objects: { "main.rel": asm.rel },
    port: "z80",
    codeLoc: origin,
    crt0: emptyCrt0,
    libraries: [],
  });
  if (!linked.ihx) {
    throw asmError("sdld link", linked.log);
  }
  const padded = ihxToBin(linked.ihx, 0x10000, 0xFF);
  // Find first and last non-FF byte from origin onwards. The snippet bytes
  // are exactly the run from origin to the last set byte.
  let lastSet = origin - 1;
  for (let i = origin; i < padded.length; i++) {
    if (padded[i] !== 0xFF) lastSet = i;
  }
  if (lastSet < origin) {
    throw new Error(`assembleSnippet[sdld]: no bytes produced at origin 0x${origin.toString(16)}`);
  }
  return { bytes: padded.slice(origin, lastSet + 1), log: (asm.log ?? "") + (linked.log ?? "") };
}

// ─── rgbds (GB / GBC SM83) ─────────────────────────────────────────────
// rgbasm produces .o → rgblink → flat .gb (zero-padded). Slice from origin.
async function assembleRgbds({ origin, code }) {
  // rgbasm needs SECTION declarations to place code at an address.
  const sectionAt = `$${origin.toString(16).toUpperCase()}`;
  const source = `SECTION "snippet", ROMX[${sectionAt}], BANK[0]\n${code}\n`;
  // Actually GB has no BANK[0] for fixed ROM — use ROM0 if origin < 0x4000.
  const useRom0 = origin < 0x4000;
  const realSource = useRom0
    ? `SECTION "snippet", ROM0[${sectionAt}]\n${code}\n`
    : `SECTION "snippet", ROMX[${sectionAt}], BANK[1]\n${code}\n`;
  const asm = await runRgbasm({ source: realSource });
  if (!asm.object) {
    throw asmError("rgbasm", asm.log);
  }
  const linked = await runRgblink({ objects: { "snippet.o": asm.object }, padValue: 0x00 });
  if (!linked.binary) {
    throw asmError("rgblink link", linked.log);
  }
  // Slice from origin, find last non-zero byte.
  const start = useRom0 ? origin : (origin - 0x4000 + 0x4000); // bank 1 lives at file 0x4000
  let lastNonZero = start;
  for (let i = start; i < linked.binary.length; i++) {
    if (linked.binary[i] !== 0) lastNonZero = i;
  }
  return { bytes: linked.binary.slice(start, lastNonZero + 1), log: (asm.log ?? "") + (linked.log ?? "") };
}
