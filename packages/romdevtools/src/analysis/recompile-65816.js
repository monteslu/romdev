// NES (6502) → SNES (65816) static recompile — emit backend, phase 1.
//
// The flagship port-engine's emit half. romdev already LIFTS a ROM (functions,
// CFG, decompile via the rizin engine); this is the inverse — it EMITS a target
// CPU. NES→SNES is the pilot because the 65816 boots in 6502 EMULATION mode, so
// the game's 6502 logic runs essentially unmodified: most instructions are a 1:1
// textual rewrite of the da65 disassembly into asar 65816 syntax. The only real
// work is the hardware seam (NES PPU/APU registers have no meaning on SNES) and
// refusing the handful of constructs that DON'T map mechanically.
//
// This module is the translator. Its input is the da65 6502 asm that
// disasm({target:'rom'}) already produces; its output is asar-ready 65816 source
// (a main.asm + a seam include) plus a residue report of anything it refused to
// translate. It builds via the bundled asar toolchain and is verified by booting
// the result and comparing against the NES original with frame({op:'sideBySide'}).
//
// SCOPE (phase 1 / M1-M2): NROM (mapper 0), documented 6502 opcodes, the boot +
// vblank-driven structure. OUT of scope (each its own later task): a real
// NES-PPU-on-SNES runtime shim (the seam is STUBBED here, see emitSeam), APU
// audio, mappers > 0, undocumented opcodes (refused), cycle-timed raster splits.
//
// Plain JS ESM + JSDoc. See internal-romdev/PORTING_MENTAL_MODELS.md Part 4.

import { NES_REGISTERS } from "../platforms/common/registers.js";

/**
 * The 151 documented 6502 mnemonics. Anything da65 emits outside this set — or
 * any `.byte` fallback inside a code path — is an undocumented opcode, which is
 * a DIFFERENT instruction on the 65816 and must be refused, not mistranslated.
 */
export const DOCUMENTED_6502 = new Set([
  "adc", "and", "asl", "bcc", "bcs", "beq", "bit", "bmi", "bne", "bpl", "brk",
  "bvc", "bvs", "clc", "cld", "cli", "clv", "cmp", "cpx", "cpy", "dec", "dex",
  "dey", "eor", "inc", "inx", "iny", "jmp", "jsr", "lda", "ldx", "ldy", "lsr",
  "nop", "ora", "pha", "php", "pla", "plp", "rol", "ror", "rti", "rts", "sbc",
  "sec", "sed", "sei", "sta", "stx", "sty", "tax", "tay", "tsx", "txa", "txs",
  "tya",
]);

/**
 * Instructions that, in 65816 EMULATION mode (E=1), behave IDENTICALLY to the
 * 6502 — same encoding intent, same flags, 8-bit A/X/Y, stack pinned to page 1,
 * direct page 0. These pass through as the exact same mnemonic + operand. This
 * is the whole "near-free" property: no rep/sep width management is needed for
 * game logic because E-mode forces the 6502 register widths.
 *
 * The set is DOCUMENTED_6502 minus the ones needing special handling:
 *   - brk / rti      → interrupt structure differs; handled at the seam/vectors
 *   - sed            → decimal mode flag semantics differ on 65816 (refused if
 *                      decimal arithmetic follows; bare cld/sed flag ops are ok
 *                      but we flag sed as residue to be safe)
 * Everything else, including all addressing modes, is a pass-through.
 */
const PASSTHROUGH = new Set(
  [...DOCUMENTED_6502].filter((m) => !["brk", "sed", "rti"].includes(m)),
);

/** A parsed da65 line. */
/**
 * @typedef {Object} ParsedLine
 * @property {"instr"|"label"|"directive"|"equ"|"comment"|"blank"|"data"} kind
 * @property {string} raw          original text (sans the trailing da65 comment)
 * @property {string} [label]      leading label, e.g. "L8016" (colon stripped)
 * @property {string} [mnemonic]   lowercased, e.g. "lda"
 * @property {string} [operand]    e.g. "#$00", "$2000", "L8016", "$0200,x"
 * @property {number} [addr]       resolved CPU address of this instruction
 */

const RE_EQU = /^\s*(\w+)\s*:=\s*(\$[0-9A-Fa-f]+)\s*$/;
const RE_DIRECTIVE = /^\s*\.(org|setcpu|byte|word|addr|res|segment)\b(.*)$/i;
// label:  mnemonic  operand    (label optional; operand optional)
const RE_INSTR = /^(?:(\w+):)?\s+([a-z]{3})(?:\s+(\S.*?))?\s*$/;
// bare "label:" on its own line
const RE_LABEL_ONLY = /^(\w+):\s*$/;

/**
 * Strip da65's trailing `; ....` comment (which carries the byte encoding + file
 * offset + register annotation). We keep the structured data we need separately;
 * the comment itself isn't valid to re-emit verbatim.
 */
function stripComment(line) {
  const i = line.indexOf(";");
  return i === -1 ? line : line.slice(0, i).replace(/\s+$/, "");
}

/**
 * Parse one da65 line into structured form. Robust to label-only lines, equ
 * definitions (`L90AA := $90AA`), directives (`.org`, `.byte`, `.setcpu`), and
 * the standard `label: mnemonic operand` instruction form.
 * @param {string} rawLine
 * @returns {ParsedLine}
 */
export function parseDa65Line(rawLine) {
  const noComment = stripComment(rawLine);
  if (!noComment.trim()) return { kind: "blank", raw: "" };

  const mEqu = noComment.match(RE_EQU);
  if (mEqu) return { kind: "equ", raw: noComment, label: mEqu[1], operand: mEqu[2] };

  const mDir = noComment.match(RE_DIRECTIVE);
  if (mDir) {
    const name = mDir[1].toLowerCase();
    // .byte/.word/.addr/.res are DATA; .org/.setcpu are structural directives.
    return { kind: /^(byte|word|addr|res)$/.test(name) ? "data" : "directive", raw: noComment };
  }

  const mLabel = noComment.match(RE_LABEL_ONLY);
  if (mLabel) return { kind: "label", raw: noComment, label: mLabel[1] };

  const mInstr = noComment.match(RE_INSTR);
  if (mInstr) {
    const mnem = mInstr[2].toLowerCase();
    return {
      kind: "instr", raw: noComment,
      label: mInstr[1] || undefined,
      mnemonic: mnem,
      operand: mInstr[3] ? mInstr[3].trim() : undefined,
    };
  }
  // Anything we can't classify is treated as data (safe; never mistranslated).
  return { kind: "data", raw: noComment };
}

/**
 * Detect a hardware-register access — the seam. Returns the register's low
 * address (0x2000-0x401F) if the operand targets a NES PPU/APU register, else
 * null. Only absolute operands count (`$2000`, `$2000,x`); immediates and
 * zero-page never hit the register file.
 * @param {string|undefined} operand
 */
export function seamRegister(operand) {
  if (!operand) return null;
  // absolute (optionally indexed): $NNNN possibly followed by ,x / ,y
  const m = operand.match(/^\$([0-9A-Fa-f]{3,4})(?:\s*,\s*[xy])?$/);
  if (!m) return null;
  const addr = parseInt(m[1], 16);
  if (addr in NES_REGISTERS) return addr;
  // $4014 (OAMDMA) and the $2000-$2007 / $4000-$4017 ranges are the seam even
  // if a specific sub-address isn't named in the table.
  if ((addr >= 0x2000 && addr <= 0x2007) || (addr >= 0x4000 && addr <= 0x4017)) return addr;
  return null;
}

/**
 * Classify + translate ONE instruction line. Returns either:
 *   { ok:true, out: [asm lines] }                  — translated (1+ lines)
 *   { ok:false, reason, line }                      — refused (residue)
 * The label (if any) is emitted as its own `label:` line so branch targets
 * resolve regardless of how asar formats them.
 * @param {ParsedLine} p
 */
export function translateInstr(p) {
  const out = [];
  if (p.label) out.push(`${p.label}:`);
  const mnem = p.mnemonic;
  const operand = p.operand;

  // Refuse the non-mechanical constructs up front.
  if (mnem === "sed") {
    return { ok: false, reason: "decimal-mode (sed): 65816 BCD edge-flag semantics differ from 6502", line: p.raw };
  }
  if (mnem === "jmp" && operand && operand.startsWith("(")) {
    return { ok: false, reason: "indirect jump (jmp (addr)): target is computed — resolve with breakpoint({on:'jumptable'})", line: p.raw };
  }

  // The hardware seam: any PPU/APU register access becomes a seam call.
  const reg = seamRegister(operand);
  if (reg != null) {
    out.push(...emitSeamAccess(mnem, operand, reg, p.raw));
    return { ok: true, out };
  }

  // 1:1 pass-through for the documented, E-mode-identical instruction set.
  if (PASSTHROUGH.has(mnem)) {
    out.push(`        ${mnem}${operand ? "     " + operand : ""}`);
    return { ok: true, out };
  }

  // brk / rti reach here — handled structurally elsewhere; for a generic
  // function body they're unexpected, so flag rather than emit blindly.
  if (mnem === "rti" || mnem === "brk") {
    return { ok: false, reason: `${mnem}: interrupt-return/break needs explicit vector handling in v1`, line: p.raw };
  }

  // Unknown mnemonic = undocumented opcode da65 named, or a parse miss.
  return { ok: false, reason: `unrecognized/undocumented opcode '${mnem}' — not a documented 6502 instruction`, line: p.raw };
}

/**
 * Emit the seam call(s) for one PPU/APU access. v1 routes through stub
 * subroutines (emitSeam) so the future NES-PPU-on-SNES runtime can drop in
 * behind this boundary without touching the recompiler.
 *
 * Contract: A holds the value (for writes) / receives it (for reads); the
 * register low byte is passed in X so one seam routine handles the whole file.
 * @returns {string[]}
 */
function emitSeamAccess(mnem, operand, reg, _rawForComment) {
  const regName = NES_REGISTERS[reg] || `REG_${reg.toString(16)}`;
  const lowByte = `#$${(reg & 0xff).toString(16).padStart(2, "0")}`;
  const lines = [`        ; seam: ${mnem} ${operand} (${regName})`];
  if (mnem === "sta") {
    // store A → register: A already holds the value.
    lines.push(`        ldx     ${lowByte}`, `        jsr     NES_PPU_WRITE`);
  } else if (mnem === "stx" || mnem === "sty") {
    lines.push(`        txa`, `        ldx     ${lowByte}`, `        jsr     NES_PPU_WRITE`);
  } else if (mnem === "lda" || mnem === "ldx" || mnem === "ldy" || mnem === "bit") {
    lines.push(`        ldx     ${lowByte}`, `        jsr     NES_PPU_READ`);
    if (mnem === "bit") lines.push(`        ; (bit set N/V from the read value)`);
  } else {
    // Read-modify-write or anything else against a register: refuse-safe — emit
    // a marker the residue pass can flag. (Rare against MMIO; not in the pilot.)
    lines.push(`        ; UNTRANSLATED seam access: ${mnem} ${operand}`);
  }
  return lines;
}

/**
 * The seam stub include (v1). Trap-to-rts for writes; reads return a sane
 * constant. The ONE detail that makes the boot loop progress: the $2002
 * (PPUSTATUS) read must return bit 7 set, so vblank-wait loops
 * (`bit $2002 / bpl`) terminate — otherwise the port spins forever and never
 * reaches its main loop. The real PPU shim (task #2) replaces these bodies.
 */
export function emitSeam() {
  return [
    "; ── NES hardware seam (v1 stubs) ──────────────────────────────────────",
    "; Writes trap to rts; reads return a safe constant. The PPUSTATUS read",
    "; returns $80 (vblank bit set) so `bit $2002 / bpl` boot loops terminate.",
    "; Replaced wholesale by the NES-PPU-on-SNES runtime (separate task).",
    "NES_PPU_WRITE:",
    "        rts",
    "NES_PPU_READ:",
    "        lda     #$80            ; vblank set → boot wait-loops exit",
    "        rts",
    "NES_APU_WRITE:",
    "        rts",
    "NES_OAM_DMA:",
    "        rts",
    "",
  ].join("\n");
}

/**
 * The asar LoROM wrapper: bank map, native→still-emulation preamble, the
 * translated body, the seam include, and the reset/NMI/IRQ vectors. The CPU
 * enters at RESET in emulation mode (E=1) so the 6502 logic runs as-is.
 *
 * @param {Object} a
 * @param {string} a.body         translated 65816 body (the functions)
 * @param {string} a.resetLabel   label the reset vector points at
 * @param {string} [a.nmiLabel]   label for the NMI vector (defaults to a stub)
 * @param {boolean} [a.withShim]  include + call the NES-PPU-on-SNES shim
 *   (nes_ppu_shim.asm). When true, the init preamble calls NES_SHIM_PRESENT
 *   (in native mode, before dropping to emulation) so the static boot picture
 *   the original ROM produced is drawn — turning the blank port into a real
 *   rendered screen.
 */
export function emitMainAsm({ body, resetLabel, nmiLabel, withShim }) {
  const nmi = nmiLabel || "NMI_STUB";
  return [
    "; NES→SNES recompiled image (romdev emit backend, phase 1).",
    "; The 6502 game logic runs in 65816 EMULATION mode (E=1) unmodified.",
    "lorom",
    "",
    "org $008000",
    "RESET_ENTRY:",
    "        sei",
    "        clc",
    "        xce             ; → native mode briefly to set up the stack...",
    "        rep #$30        ; A/X/Y 16-bit for init",
    "        ldx     #$1FFF",
    "        txs             ; SNES stack",
    "        sep #$30        ; back to 8-bit",
    ...(withShim
      ? ["        jsr     NES_SHIM_PRESENT   ; draw the converted NES boot picture (native mode)"]
      : []),
    "        sec",
    "        xce             ; → EMULATION mode: now the 6502 logic runs as-is",
    `        jmp     ${resetLabel}`,
    "",
    "; ── recompiled 6502 logic (emulation mode) ───────────────────────────",
    body,
    "",
    nmiLabel ? "" : "NMI_STUB:\n        rti\n",
    "incsrc \"nes_seam.asm\"",
    ...(withShim ? ["incsrc \"nes_ppu_shim.asm\""] : []),
    "",
    "; ── interrupt vectors (native + emulation) ───────────────────────────",
    "org $00FFEA",
    `        dw      ${nmi}          ; native NMI`,
    "org $00FFFC",
    "        dw      RESET_ENTRY     ; emulation RESET",
    "org $00FFFE",
    "        dw      NMI_STUB        ; emulation IRQ/BRK",
    "",
  ].join("\n");
}

/**
 * Truncate a da65 listing at the first end-of-routine (rts/rti/rtl, or a bare
 * `jmp`/`jmp (ind)` at the top level), keeping everything up to and including
 * it. A flat full-PRG disasm renders data tables AFTER the first routine as
 * bogus "code" (the M0 audit showed the $938D+ data band); slicing the first
 * routine yields clean single-function input for M1. The leading
 * directive/equ preamble is always kept.
 *
 * NOTE: the reset routine ends in `jmp L8000` (an infinite main loop), so the
 * first bare `jmp` IS its terminator — correct cut point for the pilot.
 * @param {string} da65Asm
 * @returns {string}
 */
export function sliceFirstRoutine(da65Asm) {
  const lines = da65Asm.split("\n");
  const kept = [];
  let sawInstruction = false;
  for (const line of lines) {
    kept.push(line);
    const p = parseDa65Line(line);
    if (p.kind === "instr") {
      sawInstruction = true;
      const m = p.mnemonic;
      // end-of-routine: rts/rti/rtl, or a bare jmp (the loop terminator)
      if (m === "rts" || m === "rti" || m === "rtl" || m === "jmp") {
        if (sawInstruction) break;
      }
    }
  }
  return kept.join("\n");
}

/**
 * Full NES→SNES recompile of a da65 6502 listing into assemble-ready asar
 * sources. This is the orchestrator the `disasm({target:'recompile'})` op
 * calls: translate the body, derive the entry label, stub unresolved callees
 * (M1 isolation), and emit the LoROM wrapper + seam include.
 *
 * @param {string} da65Asm  the `asm` string from da65 / disasm({target:'rom'})
 * @param {Object} [opts]
 * @param {string} [opts.entry]  override the reset-vector entry label
 * @param {boolean} [opts.stubUndefined=true]  stub callees not defined in the
 *   slice (needed when recompiling a single function in isolation; set false
 *   once the whole reachable graph is translated)
 * @param {boolean} [opts.withShim=false]  emit a call to + incsrc of the
 *   NES-PPU-on-SNES shim (the caller supplies nes_ppu_shim.asm separately)
 * @returns {{ mainAsm: string, seamAsm: string, residue: Array<{reason,line}>,
 *             entry: string, instrCount: number, seamCount: number, stubbed: string[] }}
 */
export function recompileNesToSnes(da65Asm, opts = {}) {
  const { body, equs, residue, instrCount, seamCount } = translateBody(da65Asm);
  const fullBody = (equs.length ? equs.join("\n") + "\n" : "") + body;
  const entry = opts.entry || entryLabel(fullBody) || "RECOMPILE_ENTRY";
  const stubUndefined = opts.stubUndefined !== false;
  const stubbed = stubUndefined ? findUndefinedLabels(fullBody, equs) : [];
  const withStubs = fullBody + (stubbed.length ? "\n" + emitStubs(stubbed) : "");
  const mainAsm = emitMainAsm({ body: withStubs, resetLabel: entry, withShim: !!opts.withShim });
  const seamAsm = emitSeam();
  return { mainAsm, seamAsm, residue, entry, instrCount, seamCount, stubbed };
}

/**
 * Translate a block of da65 6502 asm text (one function or the whole listing)
 * into 65816. Returns the translated body, the collected equ definitions, and a
 * residue list of refused lines.
 *
 * @param {string} da65Asm  the `asm` string from disasm({target:'rom'})
 * @returns {{ body: string, equs: string[], residue: Array<{reason,line}>, instrCount: number, seamCount: number }}
 */
export function translateBody(da65Asm) {
  const lines = da65Asm.split("\n");
  const bodyLines = [];
  const equs = [];
  const residue = [];
  let instrCount = 0;
  let seamCount = 0;

  for (const raw of lines) {
    const p = parseDa65Line(raw);
    switch (p.kind) {
      case "blank":
      case "comment":
        break;
      case "directive":
        // drop .org/.setcpu — the wrapper owns layout/cpu.
        break;
      case "equ":
        equs.push(`${p.label} = ${p.operand}`);
        break;
      case "label":
        bodyLines.push(`${p.label}:`);
        break;
      case "data":
        // A .byte inside the translated stream is either a data table caught in
        // the function tail or an undocumented opcode. Flag as residue so it's
        // never silently emitted as wrong code; the caller decides cut points.
        residue.push({ reason: "data/.byte in code stream (data table or undocumented opcode)", line: p.raw.trim() });
        break;
      case "instr": {
        const r = translateInstr(p);
        if (r.ok) {
          instrCount++;
          if (r.out.some((l) => l.includes("NES_PPU_") || l.includes("seam:"))) seamCount++;
          bodyLines.push(...r.out);
        } else {
          residue.push({ reason: r.reason, line: r.line.trim() });
          // Emit a visible marker so the asm still shows where logic was dropped.
          if (p.label) bodyLines.push(`${p.label}:`);
          bodyLines.push(`        ; UNTRANSLATED: ${p.raw.trim()}  (${r.reason})`);
        }
        break;
      }
      default:
        break;
    }
  }
  return { body: bodyLines.join("\n"), equs, residue, instrCount, seamCount };
}

/**
 * Find labels REFERENCED by jsr/jmp/branch in the body that are not DEFINED
 * (no `label:`) and not declared as an equ. In a single-function slice (M1)
 * these are callees in other functions; stubbing them lets the slice assemble
 * and run in isolation. M2 replaces stubs with the real translated functions.
 * @param {string} body
 * @param {string[]} equs   equ lines ("L90AA = $90AA")
 * @returns {string[]} undefined label names
 */
export function findUndefinedLabels(body, equs = []) {
  const defined = new Set();
  const equNames = new Set(equs.map((e) => e.split(/\s*=/)[0].trim()));
  const referenced = new Set();
  for (const line of body.split("\n")) {
    const def = line.match(/^(\w+):/);
    if (def) defined.add(def[1]);
    // jsr/jmp/branch operand that is a bare label (Lxxxx or a name), not $hex/#imm
    const ref = line.match(/^\s+(?:jsr|jmp|b\w\w)\s+([A-Za-z_]\w*)\s*$/);
    if (ref) referenced.add(ref[1]);
  }
  return [...referenced].filter(
    (n) => !defined.has(n) && !equNames.has(n) && !SEAM_LABELS.has(n),
  );
}

/** Labels defined in the seam include — never stub these (they'd redefine). */
const SEAM_LABELS = new Set([
  "NES_PPU_WRITE", "NES_PPU_READ", "NES_APU_WRITE", "NES_OAM_DMA",
]);

/**
 * The label on the FIRST translated instruction — the entry point the reset
 * vector should target. da65 names the entry `L8000:` (or `reset:` with
 * untilReturn aliasing). Returns null if the body has no labeled entry, in
 * which case the caller should inject one.
 * @param {string} body
 */
export function entryLabel(body) {
  for (const line of body.split("\n")) {
    const m = line.match(/^(\w+):/);
    if (m) return m[1];
  }
  return null;
}

/**
 * Emit `label: rts` stubs for a list of undefined callee labels (M1 isolation).
 * @param {string[]} names
 */
export function emitStubs(names) {
  if (!names.length) return "";
  return [
    "; ── unresolved callee stubs (M1 single-function isolation) ──",
    ...names.map((n) => `${n}:\n        rts`),
    "",
  ].join("\n");
}
