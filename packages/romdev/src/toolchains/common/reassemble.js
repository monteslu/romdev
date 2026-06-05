// Byte-exact disassemble → reassemble using NATIVE tools end to end.
//
// `reassembleForPlatform` is the entry point. It disassembles with the native
// binutils objdump for the CPU and reassembles with the matching native
// assembler, healing any instruction the assembler rejects to an exact `.byte`:
//   - 6502/65816 (NES/SNES/Atari/C64/PCE/Lynx) → da65 → ca65/ld65 (reassembleCc65Native)
//   - m68k (Genesis)                            → objdump → m68k-elf-as/ld/objcopy
//   - arm (GBA)                                 → objdump → arm-none-eabi-as/ld/objcopy
//   - z80 (SMS/GG/MSX) + gbz80 (GB/GBC)         → objdump → z80-elf-as + objcopy
//     (gbz80 objects can't be ld-linked, so as + `.org` + objcopy)
//
// objdump and `as` share GNU syntax, so the GNU CPUs need NO instruction
// translation — objdump's lines feed straight back into `as`. The byte-exact
// guarantee is the heal loop: assemble, diff vs the original, pin any
// mismatching/rejected line to a `.byte` of its exact bytes, retry. Always
// byte-exact; readability = how many lines stayed instructions.
//
// NOTE: the dialect/translator helpers further down (translateDisasm,
// reassembleByteExact, the CA65/VASM_M68K/SJASM_Z80/RGBDS_SM83 dialects, …) are
// LEGACY/DEAD — the translation layer for the old hand-rolled JS decoders, which
// are now deleted. reassembleForPlatform no longer calls them; left only until a
// dead-code sweep removes them.

/**
 * @typedef {Object} AsmDialect
 * @property {(addr:number)=>string} org         origin directive for `addr`
 * @property {(bytes:number[])=>string} dataDir   a data line emitting `bytes`
 * @property {(label:string)=>string} labelDef    a label definition line
 * @property {(label:string, addr:number)=>string} equate  define an out-of-window label = addr
 * @property {(insn:string)=>string|null} insn    translate a disasm instruction to native syntax, or null to force dc.b fallback
 */

const hex2 = (b) => "$" + (b & 0xFF).toString(16).padStart(2, "0").toUpperCase();

// Label form across disassemblers: `L` + 4..8 hex digits (m68k targets can be
// 24-bit, e.g. an $E0FF00xx RAM mirror → LE0FF0080).
const LABEL_RE = /^(L[0-9A-Fa-f]{4,8}):\s*$/;
const LABEL_REF_RE = /\bL[0-9A-Fa-f]{4,8}\b/g;

/** Parse one disasm line into {label?, code?, bytes?[]}. */
function parseLine(line) {
  // Label-only line: `L00023C:`
  const lm = line.match(LABEL_RE);
  if (lm) return { label: lm[1] };
  // Code + trailing `; ADDR BB BB` comment.
  const cm = line.match(/^\s*(.*?)\s*;\s*([0-9A-Fa-f]{4,8})\s+((?:[0-9A-Fa-f]{2}\s*)+)\s*$/);
  if (cm) {
    const bytes = cm[3].trim().split(/\s+/).map((h) => parseInt(h, 16));
    return { code: cm[1].trim(), addr: parseInt(cm[2], 16), bytes };
  }
  // A label on the same line as code: `L00023C:  jmp ...`  (rare)
  const both = line.match(/^(L[0-9A-Fa-f]{4,8}):\s+(.*?)\s*;\s*([0-9A-Fa-f]{4,8})\s+((?:[0-9A-Fa-f]{2}\s*)+)\s*$/);
  if (both) {
    const bytes = both[4].trim().split(/\s+/).map((h) => parseInt(h, 16));
    return { label: both[1], code: both[2].trim(), addr: parseInt(both[3], 16), bytes };
  }
  // Assembler STATE directives that emit no bytes but MUST be preserved for the
  // reassembly to be correct — chiefly the 65816 width directives `.a8/.a16/
  // .i8/.i16` (and `.setcpu`), which tell ca65 the accumulator/index size so
  // `lda #imm` etc. get the right operand width. Dropping them silently
  // mis-encodes everything after a width switch.
  const dir = line.match(/^\s*(\.(?:setcpu|a8|a16|i8|i16|smart)\b.*)$/i);
  if (dir) return { directive: dir[1].trim() };
  return {}; // comment/blank — skip
}

/**
 * Translate disassembler output into a native-assembler source that
 * reassembles byte-exact.
 *
 * @param {string} disasm  the disassembler's asm text
 * @param {number} startAddress
 * @param {AsmDialect} dialect
 * @returns {{ source: string, lines: number, fellBack: number }}
 *   `fellBack` = how many instruction lines were emitted as raw data because
 *   they didn't translate (high count = disassembler coverage gap, still
 *   byte-exact).
 */
export function translateDisasm(disasm, startAddress, dialect) {
  const raw = disasm.split(/\r?\n/).map(parseLine);

  // Which labels are DEFINED in-window vs merely REFERENCED (need an equate).
  const defined = new Set();
  const referenced = new Set();
  for (const p of raw) {
    if (p.label) defined.add(p.label);
    const refs = (p.code ?? "").match(LABEL_REF_RE);
    if (refs) for (const r of refs) referenced.add(r);
  }

  const out = [dialect.org(startAddress)];
  for (const lbl of referenced) {
    if (!defined.has(lbl)) out.push(dialect.equate(lbl, parseInt(lbl.slice(1), 16)));
  }

  let fellBack = 0;
  for (const p of raw) {
    if (p.directive) { const d = dialect.directive ? dialect.directive(p.directive) : null; if (d) out.push("\t" + d); continue; }
    if (p.label) out.push(dialect.labelDef(p.label));
    if (p.code != null) {
      const native = dialect.insn(p.code);
      if (native != null) {
        out.push("\t" + native);
      } else if (p.bytes && p.bytes.length) {
        // Untranslatable line → emit its exact bytes as data. Byte-exact wins.
        out.push(dialect.dataDir(p.bytes));
        fellBack++;
      }
    } else if (p.bytes && p.bytes.length && p.label == null) {
      // A pure-data line with no code (shouldn't happen often) — pass bytes.
      out.push(dialect.dataDir(p.bytes));
    }
  }
  return { source: out.join("\n") + "\n", lines: raw.length, fellBack };
}

/**
 * Reassemble disassembler output to BYTE-EXACT native asm, healing any
 * instruction that doesn't reassemble to its original bytes by falling it back
 * to a data directive.
 *
 * Translating an instruction string back to bytes isn't guaranteed identical —
 * an assembler may pick a different (equivalent) encoding, optimize a branch,
 * or resolve an addressing mode differently than the original. So we don't
 * trust the translation: we assemble, compare to the original bytes, and for
 * any line that produced wrong bytes we force a `dc.b` of its exact original
 * bytes, then re-assemble. This converges (each pass either matches or pins ≥1
 * more line to data) and the result is provably byte-exact.
 *
 * @param {string} disasm
 * @param {number} startAddress
 * @param {Uint8Array} original   the bytes the disasm came from
 * @param {AsmDialect} dialect
 * @param {(source:string)=>Promise<Uint8Array|null>} assemble  runs the native assembler
 * @param {number} [maxPasses=8]
 * @returns {Promise<{ source:string, bytes:Uint8Array|null, ok:boolean, passes:number, dcLines:number, note?:string }>}
 */
export async function reassembleByteExact(disasm, startAddress, original, dialect, assemble, maxPasses = 8) {
  const parsed = disasm.split(/\r?\n/).map(parseLine);
  // Index of code lines that we've forced to data (by their array position).
  const forced = new Set();

  // Heal by walking output and source IN LOCKSTEP, tracking an output cursor
  // by EMITTED length (not by the line's original address). A line that the
  // assembler re-encoded to the SAME length but different bytes is pinned and
  // we keep walking (no desync). A line whose bytes don't match AND whose
  // emitted length we can't trust desyncs the cursor — pin it and stop this
  // pass; next pass it's a `dc.b` of exact length, so the cursor re-syncs and
  // we make progress past it. Converges in (#length-changing lines) passes.
  // Forced (dc.b) lines always emit exactly their original bytes, so they
  // advance the cursor reliably.
  for (let pass = 0; pass < maxPasses; pass++) {
    const dia = { ...dialect, __forced: forced };
    const { source } = translateParsed(parsed, startAddress, dia);
    const asmResult = await assemble(source, source.split("\n"));
    // The callback returns a Uint8Array on success, or on assembler error an
    // object { error:true, failTexts:[trimmed source lines that errored] } so the
    // heal pins ONLY the rejected instructions — not the whole region (the
    // failure mode that cascaded everything to data).
    const out = asmResult instanceof Uint8Array ? asmResult : null;
    if (!out) {
      let pinnedAny = false;
      const failTexts = (asmResult && asmResult.failTexts) || [];
      for (const ft of failTexts) {
        // Match the failing emitted line back to a parsed code line (by its
        // translated instruction text). Pin the first unpinned match.
        for (let i = 0; i < parsed.length; i++) {
          const p = parsed[i];
          if (p.code == null || forced.has(i)) continue;
          const native = dialect.insn(p.code);
          if (native != null && ft.includes(native.trim())) { forced.add(i); pinnedAny = true; break; }
        }
      }
      if (!pinnedAny) {
        if (forced.size >= parsed.filter((p) => p.code != null).length) {
          return { source, bytes: null, ok: false, passes: pass + 1, dcLines: forced.size, note: "assembler rejected even the all-data fallback" };
        }
        const next = parsed.findIndex((p, i) => p.code != null && !forced.has(i));
        if (next < 0) { parsed.forEach((p, i) => { if (p.code != null) forced.add(i); }); }
        else forced.add(next);
      }
      continue;
    }
    if (out.length === original.length && firstDiff(original, out) < 0) {
      return { source, bytes: out, ok: true, passes: pass + 1, dcLines: forced.size };
    }
    // Walk output + source in lockstep by ORIGINAL length. A live instruction
    // the assembler re-encoded to the SAME length but different bytes (suba→lea,
    // jmp.l→jmp.w, stop) is pinned and we KEEP walking (the next line's bytes
    // still line up). A line whose bytes don't match AND whose successor doesn't
    // line up at original-length changed LENGTH → pin it and stop this pass; next
    // pass it's an exact-length data directive, so the cursor re-syncs and we get
    // past it. Converges in (#length-changing lines) passes; same-length
    // re-encodes are all caught in a single pass.
    let outPos = 0;
    let desynced = false;
    for (let i = 0; i < parsed.length && !desynced; i++) {
      const p = parsed[i];
      const len = p.bytes ? p.bytes.length : 0;
      if (!len) continue;
      let match = outPos + len <= out.length;
      if (match) for (let k = 0; k < len; k++) if (out[outPos + k] !== p.bytes[k]) { match = false; break; }
      if (match) { outPos += len; continue; }
      if (forced.has(i) || p.code == null) { outPos += len; continue; }
      forced.add(i);
      // Same-length re-encode? (the NEXT byte-bearing line's bytes appear right
      // after this line's original length → cursor still aligned, keep going.)
      const next = nextCodeOrData(parsed, i + 1);
      const sameLen = next && next.bytes &&
        outPos + len + next.bytes.length <= out.length &&
        next.bytes.every((b, k) => out[outPos + len + k] === b);
      if (sameLen) outPos += len; else desynced = true;
    }
    if (!desynced) {
      const next = parsed.findIndex((p, i) => p.code != null && !forced.has(i));
      if (next < 0) return { source, bytes: out, ok: false, passes: pass + 1, dcLines: forced.size, note: "could not reach byte-exact" };
      forced.add(next);
    }
  }
  // Final attempt: all-data.
  parsed.forEach((p, i) => { if (p.code != null) forced.add(i); });
  const dia = { ...dialect, __forced: forced };
  const { source } = translateParsed(parsed, startAddress, dia);
  const out = await assemble(source);
  const ok = out && out.length === original.length && firstDiff(original, out) < 0;
  return { source, bytes: out ?? null, ok: !!ok, passes: maxPasses, dcLines: forced.size, note: ok ? undefined : "fell back to all-data" };
}

/** Next parsed entry from index `from` that emits bytes (code or data). */
function nextCodeOrData(parsed, from) {
  for (let i = from; i < parsed.length; i++) {
    if (parsed[i].bytes && parsed[i].bytes.length) return parsed[i];
  }
  return null;
}

/** First differing byte index, or -1 if equal up to min length. */
function firstDiff(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}

/** Map a byte offset (relative to startAddress) to the parsed line that emits it. */
function lineOwningOffset(parsed, startAddress, offset) {
  const targetAddr = startAddress + offset;
  let best = -1;
  for (let i = 0; i < parsed.length; i++) {
    const p = parsed[i];
    if (p.addr != null && p.bytes && p.addr <= targetAddr && targetAddr < p.addr + p.bytes.length) return i;
    if (p.addr != null && p.addr <= targetAddr) best = i;
  }
  return best;
}

/** translateDisasm, but over already-parsed lines + a forced-to-data set
 *  (dialect.__forced is a Set of line indices to emit as data). */
function translateParsed(parsed, startAddress, dialect, forced) {
  const defined = new Set();
  const referenced = new Set();
  for (const p of parsed) {
    if (p.label) defined.add(p.label);
    const refs = (p.code ?? "").match(LABEL_REF_RE);
    if (refs) for (const r of refs) referenced.add(r);
  }
  // Emit LEADING directives (da65's `.setcpu`/`.a8`/`.i8` preamble) BEFORE the
  // org — ca65 needs `.setcpu` before `.org`, and an org placed above the cpu
  // directive mis-links (everything becomes fill). Find the first non-directive
  // /non-blank line; everything before it that's a directive is preamble.
  const out = [];
  let bodyStart = 0;
  for (let i = 0; i < parsed.length; i++) {
    const p = parsed[i];
    if (p.directive) {
      const d = dialect.directive ? dialect.directive(p.directive) : null;
      if (d) out.push("\t" + d);
      bodyStart = i + 1;
    } else if (p.label == null && p.code == null && (!p.bytes || !p.bytes.length)) {
      bodyStart = i + 1; // blank/comment in the preamble
    } else break;
  }
  out.push(dialect.org(startAddress));
  for (const lbl of referenced) if (!defined.has(lbl)) out.push(dialect.equate(lbl, parseInt(lbl.slice(1), 16)));
  let fellBack = 0;
  for (let i = bodyStart; i < parsed.length; i++) {
    const p = parsed[i];
    if (p.directive) { const d = dialect.directive ? dialect.directive(p.directive) : null; if (d) out.push("\t" + d); continue; }
    if (p.label) out.push(dialect.labelDef(p.label));
    if (p.code != null) {
      const isForced = dialect.__forced && dialect.__forced.has(i);
      const native = isForced ? null : dialect.insn(p.code);
      if (native != null) out.push("\t" + native);
      else if (p.bytes && p.bytes.length) { out.push(dialect.dataDir(p.bytes)); fellBack++; }
    } else if (p.bytes && p.bytes.length && p.label == null) {
      out.push(dialect.dataDir(p.bytes));
    }
  }
  return { source: out.join("\n") + "\n", fellBack };
}

// ── Dialects ──────────────────────────────────────────────────────────────

/** Common instruction translator: turns the disasm's `.dc.b/.dc.w/.byte` data
 *  pseudo-ops into the native one, otherwise passes the instruction through.
 *  Returns null only when the instruction text is obviously broken (contains
 *  "undefined" — a disassembler coverage gap) so the caller emits dc.b. */
function passthroughInsn(dataMnemonic) {
  return (code) => {
    if (/undefined/.test(code)) return null;       // broken disasm → dc.b fallback
    // Data pseudo-ops: .dc.w / .dc.b / .byte / .word → leave to dataDir via null
    if (/^\.?(dc\.[bwl]|byte|word)\b/i.test(code)) return null;
    return code;
  };
}

/** cc65 (ca65) dialect — for 6502 (NES/C64/Atari) and 65816 (SNES). da65's
 *  output is ALREADY cc65 syntax, so this is near-identity: keep the `.setcpu`
 *  and `.a8`/`.i8` size directives da65 emits (65816 needs them), pass
 *  instructions through, and let the heal loop pin any `.byte`/illegal lines.
 *  The org is injected separately in disasm.js / disassembleProject. */
export const CA65 = {
  org: (a) => "\t.org $" + a.toString(16).toUpperCase(),
  dataDir: (bytes) => "\t.byte " + bytes.map(hex2).join(","),
  labelDef: (l) => l + ":",
  equate: (l, a) => `${l} := $${a.toString(16).toUpperCase()}`,
  // Keep cc65 state directives verbatim — `.a8/.a16/.i8/.i16` are REQUIRED for
  // correct 65816 reassembly; `.setcpu` selects the CPU.
  directive: (d) => d,
  insn: (code) => {
    if (/undefined/.test(code)) return null;
    if (/^\.?(dc\.[bwl]|byte|word)\b/i.test(code)) return null;
    return code;
  },
};

/** vasm68k (Motorola m68k) dialect — Genesis. */
export const VASM_M68K = {
  org: (a) => "\torg $" + a.toString(16).toUpperCase(),
  dataDir: (bytes) => "\tdc.b " + bytes.map(hex2).join(","),
  labelDef: (l) => l + ":",
  equate: (l, a) => `${l} = $${a.toString(16).toUpperCase()}`,
  insn: passthroughInsn("dc.b"),
};

/** sjasm (Z80) dialect — SMS/GG. sjasm uses `org`, `db`, `label:`, and `$` hex. */
export const SJASM_Z80 = {
  org: (a) => "\torg $" + a.toString(16).toUpperCase(),
  dataDir: (bytes) => "\tdb " + bytes.map(hex2).join(","),
  labelDef: (l) => l + ":",
  equate: (l, a) => `${l} equ $${a.toString(16).toUpperCase()}`,
  insn: passthroughInsn("db"),
};

/** Translate sm83dasm operand syntax to RGBDS:
 *   - memory operands `(...)` → `[...]`  (rgbds uses brackets)
 *   - `sp++$N` → `sp+$N`, `sp+-$N` → `sp-$N`  (disasm doubles the sign)
 *   - `ldh a,($XX)` → `ldh a,[$FFXX]`  (disasm emits the low byte of the $FFxx page)
 * Anything still unfamiliar rides through; if rgbasm rejects it, the heal loop
 * falls the line back to `db`. */
function sm83ToRgbds(code) {
  if (/undefined/.test(code)) return null;
  if (/^\.?(dc\.[bwl]|byte|word|db|dw)\b/i.test(code)) return null;
  let c = code;
  c = c.replace(/sp\+\+/g, "sp+").replace(/sp\+-/g, "sp-");
  c = c.replace(/(ldh\s+(?:[^,]*,\s*)?)\(\$([0-9A-Fa-f]{1,2})\)/, (_, p, hh) => `${p}($FF${hh.padStart(2, "0")})`);
  c = c.replace(/\(([^()]*)\)/g, "[$1]");
  return c;
}

/** rgbds (sm83 / Game Boy) dialect. rgbasm: `db`, `label:`, needs a SECTION;
 *  modern rgbasm requires `DEF name EQU value` (bare `name EQU` is rejected as
 *  an undefined-macro call); memory operands use `[]` not `()`. */
export const RGBDS_SM83 = {
  // GB memory map: $0000-$3FFF = ROM0 (fixed bank 0), $4000-$7FFF = ROMX
  // (switchable bank). rgbds rejects a ROM0 section at $4000, so pick the
  // right section type by address.
  org: (a) => (a < 0x4000)
    ? `SECTION "dis", ROM0[$${a.toString(16).toUpperCase()}]`
    : `SECTION "dis", ROMX[$${a.toString(16).toUpperCase()}]`,
  dataDir: (bytes) => "\tdb " + bytes.map(hex2).join(","),
  labelDef: (l) => l + ":",
  equate: (l, a) => `DEF ${l} EQU $${a.toString(16).toUpperCase()}`,
  insn: sm83ToRgbds,
};

// ── Per-platform orchestrator ───────────────────────────────────────────────
//
// Disassemble a chunk of bytes for `platform` at CPU address `startAddress`,
// then reassemble it BYTE-EXACT in that platform's native assembler. Returns
// the reassembled source + verification. Picks the disassembler, dialect, and
// assembler per CPU family:
//   6502  (nes/c64/atari2600/atari7800) → da65 + ca65/ld65 (CA65 dialect)
//   65816 (snes)                        → da65 65816 + ca65/ld65 (CA65)
//   z80   (sms/gg)                      → z80dasm + sjasm (SJASM_Z80)
//   sm83  (gb/gbc)                      → sm83dasm + rgbds (RGBDS_SM83)
//   m68k  (genesis)                     → m68kdasm + vasm68k (VASM_M68K)

const CPU_FAMILY = {
  nes: "6502", c64: "6502", atari2600: "6502", atari7800: "6502", lynx: "6502",
  snes: "65816",
  sms: "z80", gg: "z80", msx: "z80",
  gb: "sm83", gbc: "sm83",
  genesis: "m68k", megadrive: "m68k", md: "m68k",
  gba: "arm",
  // PC Engine's HuC6280 is a 65C02 superset — the 6502-family da65/ca65 path
  // reassembles it (da65 also has an explicit --cpu huc6280 mode for decode).
  pce: "6502",
};

/** GAS (GNU as) dialect — for objdump output going back into binutils `as`.
 *  objdump and as share GNU syntax, so the instruction translation is a pure
 *  passthrough EXCEPT normalizeObjdump rewrote numeric operands to `$hex` (our
 *  house style) and in-range targets to `L______` labels. Convert `$hex`→`0xhex`
 *  for GAS; labels ride through. Data → `.byte`. The heal loop pins anything
 *  that doesn't reassemble to its exact bytes. */
function makeGasDialect() {
  return {
    org: () => "\t.text", // origin set by the linker script, not GAS .org
    dataDir: (b) => "\t.byte " + b.map((x) => "0x" + (x & 0xFF).toString(16).padStart(2, "0")).join(","),
    labelDef: (l) => l + ":",
    equate: (l, a) => `\t.set ${l}, 0x${a.toString(16)}`,
    insn: (code) => {
      if (/undefined|\bbad\b|\.dc\.|\.byte|\.word|\.short/i.test(code)) return null;
      return code.replace(/\$([0-9A-Fa-f]+)\b/g, (_, h) => "0x" + h);
    },
  };
}

/** Build a GNU as→ld→objcopy assemble callback for a binutils toolchain module.
 *  Wraps the dialect's source in a .text section at `startAddress`, links flat,
 *  and strips to a raw binary. The linker aligns the section end (trailing zero
 *  pad), so the callback trims the output back to `expectedLen` — the heal loop
 *  compares against the original length and any real length change still shows
 *  as a mid-stream diff. Same toolchain that builds the platform. */
function makeGnuAssemble(mod, machinePrefix, outputFormat, outputArch, startAddress, expectedLen) {
  const runAs = mod[`run${cap(machinePrefix)}As`];
  const runLd = mod[`run${cap(machinePrefix)}Ld`];
  const runObjcopy = mod[`run${cap(machinePrefix)}Objcopy`];
  const fmtLines = outputFormat ? `OUTPUT_FORMAT("${outputFormat}")\nOUTPUT_ARCH(${outputArch})\n` : "";
  const ld = `${fmtLines}ENTRY(_start)\nSECTIONS {\n  .text 0x${startAddress.toString(16)} : {\n    *(.text*)\n    *(.rodata*)\n    *(.data*)\n  }\n  /DISCARD/ : { *(.ARM.attributes) *(.comment) *(.note*) }\n}\n`;
  return async (src) => {
    const preamble = 3; // ".section .text", ".global _start", "_start:"
    const wrapped = `.section .text\n.global _start\n_start:\n${src}`;
    const a = await runAs({ source: wrapped }).catch(() => ({ object: null, log: "" }));
    if (!a || !a.object) {
      // Parse `as` error line numbers → the offending source lines, so the heal
      // can pin just those instructions to data instead of dropping the region.
      const srcLines = wrapped.split("\n");
      const failTexts = [];
      for (const m of (a?.log || "").matchAll(/:(\d+):\s*Error:/g)) {
        const ln = parseInt(m[1], 10) - 1; // 0-based into srcLines
        if (ln >= preamble && srcLines[ln]) failTexts.push(srcLines[ln].trim());
      }
      return { error: true, failTexts };
    }
    const l = await runLd({ objects: { "main.o": a.object }, linkScript: ld }).catch(() => null);
    if (!l || !l.elf) return null;
    const o = await runObjcopy({ elf: l.elf }).catch(() => null);
    if (!o || !o.binary) return null;
    let out = new Uint8Array(o.binary);
    if (out.length > expectedLen) out = out.slice(0, expectedLen);
    return out;
  };
}

function cap(s) {
  // m68k → M68k, arm → Arm (matches runM68kAs / runArmAs export names).
  if (s === "m68k") return "M68k";
  if (s === "arm") return "Arm";
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * @param {Object} a
 * @param {string} a.platform
 * @param {Uint8Array} a.bytes        the chunk to disassemble (already mapped to CPU space)
 * @param {number} a.startAddress     CPU address of byte 0
 * @returns {Promise<{ family:string, source:string, bytes:Uint8Array|null, ok:boolean,
 *   total:number, dcLines:number, readablePercent:number, note?:string }>}
 */
export async function reassembleForPlatform(a) {
  const { platform, bytes, startAddress } = a;
  const family = CPU_FAMILY[platform];
  if (!family) throw new Error(`reassembleForPlatform: no reassembly path for platform '${platform}'`);

  // ── disassemble (NATIVE binutils objdump — no hand-rolled decoders) ──
  // 6502/65816 use da65 (cc65's real disassembler); everything else uses the
  // matching binutils objdump. normalizeObjdump emits romdev's house format
  // (`<insn> ; ADDR bytes`) the heal loop's parseLine consumes.
  let disasm;
  if (family === "6502" || family === "65816") {
    const { runDa65 } = await import("../cc65/da65.js");
    const r = await runDa65({ bytes, startAddress, cpu: family === "65816" ? "65816" : "6502", options: ["--comments", "4"] });
    disasm = r.asm;
    // da65 output is already valid cc65 — heal it in place (cc65 reassembles its
    // own syntax natively).
    return reassembleCc65Native(disasm, startAddress, bytes, family);
  }
  // ALL non-6502 CPUs: disassemble with native objdump, reassemble with the
  // matching native binutils `as`/`ld`/`objcopy`. objdump output IS GNU-as
  // syntax, so there's no translation — keep its lines verbatim and pin only the
  // instructions `as` rejects (absolute branch/PC-relative forms) to `.byte`.
  // NO hand-rolled decoders anywhere.
  const { runObjdump } = await import("../objdump.js");
  if (family === "m68k") {
    disasm = (await runObjdump({ bytes, arch: "m68k", startAddress })).asm;
    const m = await import("../m68k-elf-gcc/gcc.js");
    return reassembleGnuNative(disasm, startAddress, bytes,
      { runAs: m.runM68kAs, runLd: m.runM68kLd, runObjcopy: m.runM68kObjcopy, fmtLines: `OUTPUT_FORMAT("elf32-m68k")\nOUTPUT_ARCH(m68k)\n` }, family);
  }
  if (family === "arm") {
    disasm = (await runObjdump({ bytes, arch: "arm", startAddress })).asm;
    const m = await import("../arm-none-eabi-gcc/gcc.js");
    return reassembleGnuNative(disasm, startAddress, bytes,
      { runAs: m.runArmAs, runLd: m.runArmLd, runObjcopy: m.runArmObjcopy }, family);
  }
  if (family === "z80" || family === "sm83") {
    // z80 binutils `as` handles BOTH the Z80 (-march=z80) and the Game Boy CPU
    // (-march=gbz80) — the same objdump that disassembled them.
    const arch = family === "sm83" ? "gbz80" : "z80";
    disasm = (await runObjdump({ bytes, arch, startAddress })).asm;
    const z = await import("../z80/binutils.js");
    return reassembleGnuNative(disasm, startAddress, bytes,
      { runAs: z.runZ80As, runObjcopy: z.runZ80Objcopy, march: arch, noLink: true }, family);
  }
  throw new Error(`reassembleForPlatform: no reassembly path for family '${family}'`);
}

/**
 * Reassemble a GNU-toolchain CPU (m68k / arm) from native objdump output using
 * the matching binutils `as`/`ld`/`objcopy`. objdump and as share GNU syntax, so
 * we keep objdump's instruction lines almost verbatim (only `$hex`→`0x`, our
 * house normalization) and place a label at each in-range branch target. Heal:
 * assemble; for any instruction `as` REJECTS (PC-relative/branch forms objdump
 * prints absolutely), pin that line to a `.byte` of its exact bytes and retry.
 * Floor = clean all-`.byte` (proven byte-exact). No hand-rolled de/encoding.
 * @returns same shape as reassembleForPlatform
 */
async function reassembleGnuNative(disasm, startAddress, original, tools, family) {
  // tools: { runAs, runLd, runObjcopy, fmtLines, asArgs? } — the matching
  // binutils chain for this CPU. asArgs (e.g. for z80's -march=gbz80) ride
  // through to the assembler call (the z80 wrapper bakes march in itself).
  const { runAs, runLd, runObjcopy, fmtLines = "" } = tools;
  const ld = `${fmtLines}ENTRY(_start)\nSECTIONS {\n  .text 0x${startAddress.toString(16)} : {\n    *(.text*) *(.rodata*) *(.data*)\n  }\n  /DISCARD/ : { *(.ARM.attributes) *(.comment) *(.note*) }\n}\n`;

  // Parse objdump's normalized lines into {label?, code?, addr, bytes}.
  const lines = disasm.split(/\r?\n/).map(parseLine);
  // Which in-range addresses are branch targets (need a label def)?
  const addrOf = new Map();
  for (const p of lines) if (p.addr != null && p.bytes) addrOf.set(p.addr, p);
  const codeIdx = [];
  lines.forEach((p, i) => { if (p.code != null && p.bytes) codeIdx.push(i); });
  const forced = new Set();

  const toGas = (code) => code.replace(/\$([0-9A-Fa-f]+)\b/g, (_, h) => "0x" + h);

  const build = () => {
    const out = [".section .text", ".global _start"];
    // No-link (z80/gbz80) path: place the section with `.org` so labels resolve
    // to real addresses before objcopy (there's no linker to set the origin).
    if (tools.noLink) out.push(`.org 0x${startAddress.toString(16)}`);
    out.push("_start:");
    for (let i = 0; i < lines.length; i++) {
      const p = lines[i];
      if (p.label) { out.push(p.label + ":"); continue; }
      if (p.code != null && p.bytes) {
        if (forced.has(i)) out.push("\t.byte " + p.bytes.map((b) => "0x" + b.toString(16).padStart(2, "0")).join(","));
        else out.push("\t" + toGas(p.code));
      }
    }
    return out.join("\n") + "\n";
  };
  const assemble = async (src) => {
    const a = await runAs({ source: src, march: tools.march }).catch(() => ({ object: null, log: "" }));
    if (!a || !a.object) return { ok: false, log: a?.log || "" };
    let elf;
    if (tools.noLink) {
      // z80/gbz80: `as` resolves all in-file labels (one source file, no cross-
      // refs), and ld rejects gbz80 objects ("instruction sets incompatible").
      // Skip ld — objcopy the assembled object straight to binary. Correct
      // section addresses come from the `.org startAddress` the source carries.
      elf = a.object;
    } else {
      const l = await runLd({ objects: { "main.o": a.object }, linkScript: ld }).catch(() => null);
      if (!l || !l.elf) return { ok: false, log: l?.log || "" };
      elf = l.elf;
    }
    const o = await runObjcopy({ elf }).catch(() => null);
    if (!o || !o.binary) return { ok: false, log: "" };
    let bin = new Uint8Array(o.binary);
    if (tools.noLink) {
      // The `.org startAddress` makes objcopy emit `startAddress` leading zero
      // bytes (the section's offset). Slice to the real region.
      bin = bin.slice(startAddress, startAddress + original.length);
    } else if (bin.length > original.length) {
      bin = bin.slice(0, original.length);
    }
    return { ok: true, bytes: bin };
  };

  const totalCode = codeIdx.length;
  for (let pass = 0; pass < 80; pass++) {
    const src = build();
    const r = await assemble(src);
    if (r.ok) {
      if (r.bytes.length === original.length && firstDiff(original, r.bytes) < 0) {
        return { family, source: src, bytes: r.bytes, ok: true, total: totalCode, dcLines: forced.size,
          readablePercent: totalCode ? Math.round(100 * (1 - forced.size / totalCode)) : 100 };
      }
      // Assembled but bytes differ → pin the code line owning the first diff.
      const d = firstDiff(original, r.bytes);
      const off = (d < 0 ? Math.min(r.bytes.length, original.length) : d) + startAddress;
      let owner = -1;
      for (const i of codeIdx) { const p = lines[i]; if (p.addr <= off && off < p.addr + p.bytes.length) { owner = i; break; } if (p.addr <= off) owner = i; }
      if (owner < 0 || forced.has(owner)) { const n = codeIdx.find((i) => !forced.has(i)); if (n == null) break; forced.add(n); }
      else forced.add(owner);
      continue;
    }
    // `as` rejected something → pin every code line whose translated text the
    // error log names. The wrapped source has a 3-line preamble.
    const srcLines = src.split("\n");
    let pinned = false;
    for (const m of (r.log || "").matchAll(/:(\d+):\s*(?:Error|Warning):/g)) {
      const ln = parseInt(m[1], 10) - 1;
      const text = (srcLines[ln] || "").trim();
      for (const i of codeIdx) { if (forced.has(i)) continue; if (("\t" + toGas(lines[i].code)).trim() === text) { forced.add(i); pinned = true; break; } }
    }
    if (!pinned) { const n = codeIdx.find((i) => !forced.has(i)); if (n == null) break; forced.add(n); }
  }
  // Floor: clean all-`.byte` (proven byte-exact, no labels to perturb layout).
  const rows = [".section .text", ".global _start", "_start:"];
  for (let i = 0; i < original.length; i += 16) rows.push("\t.byte " + Array.from(original.slice(i, i + 16)).map((b) => "0x" + b.toString(16).padStart(2, "0")).join(","));
  const r = await assemble(rows.join("\n") + "\n");
  const ok = r.ok && r.bytes.length === original.length && firstDiff(original, r.bytes) < 0;
  return { family, source: rows.join("\n") + "\n", bytes: ok ? r.bytes : null, ok, total: totalCode, dcLines: totalCode,
    readablePercent: 0, note: ok ? "byte-exact (data-only floor — some instructions didn't round-trip)" : "could not reach byte-exact" };
}

/**
 * Reassemble cc65 (6502/65816) families by using da65's output AS-IS — it's
 * already valid cc65 with its own equate/label structure. We inject `.org`
 * after `.setcpu` (the proven byte-exact recipe) and heal by replacing any
 * da65 CODE line that doesn't reassemble to its own bytes with a `.byte` of
 * those bytes (recovered from the line's `; ADDR BB` comment). Preserves
 * da65's equates/labels/`.a8`/`.i8` exactly.
 * @returns same shape as reassembleForPlatform
 */
async function reassembleCc65Native(disasm, startAddress, original, family) {
  const { runCa65, runLd65 } = await import("../cc65/cc65.js");
  const cpuTag = family === "65816" ? "65816" : "6502";
  const cfg = `MEMORY{M:start $${startAddress.toString(16)},size $${original.length.toString(16)},type ro,file %O,fill yes,fillval $FF;}\nSEGMENTS{CODE:load M,type ro;}\n`;

  // Split da65 output into lines, tagging code lines with their {addr,bytes}.
  const lines = disasm.split(/\r?\n/);
  const meta = lines.map((line) => {
    const m = line.match(/^\s*(?!L[0-9A-Fa-f]+:|;|\.)(\S.*?)\s*;\s*([0-9A-Fa-f]{4,8})\s+((?:[0-9A-Fa-f]{2}\s*)+)\s*$/);
    if (m) return { code: true, addr: parseInt(m[2], 16), bytes: m[3].trim().split(/\s+/).map((h) => parseInt(h, 16)) };
    return { code: false };
  });
  const forced = new Set(); // line indices replaced with .byte

  const build = () => {
    const out = lines.map((line, i) => {
      if (forced.has(i)) return "\t.byte " + meta[i].bytes.map(hex2).join(",");
      return line;
    });
    // inject `.org` right after `.setcpu`
    const src = out.join("\n").replace(/(\.setcpu\s+"[^"]+")/, `$1\n\t.org $${startAddress.toString(16).toUpperCase()}`);
    return src;
  };
  const assemble = async (src) => {
    const ca = await runCa65({ source: src, target: "none" }).catch(() => null);
    if (!ca || !ca.object) return null;
    const ld = await runLd65({ objects: { "o.o": ca.object }, target: "none", linkerConfig: cfg }).catch(() => null);
    return ld && ld.binary ? new Uint8Array(ld.binary) : null;
  };

  let source = build();
  const codeLineCount = meta.filter((m) => m.code).length;
  for (let pass = 0; pass < 80; pass++) {
    source = build();
    const out = await assemble(source);
    if (out && out.length === original.length && firstDiff(original, out) < 0) {
      return { family, source, bytes: out, ok: true, total: codeLineCount, dcLines: forced.size,
        readablePercent: codeLineCount ? Math.round(100 * (1 - forced.size / codeLineCount)) : 100 };
    }
    if (!out) {
      // ca65/ld failed — pin the first not-yet-pinned code line and retry.
      const next = meta.findIndex((m, i) => m.code && !forced.has(i));
      if (next < 0) break;
      forced.add(next);
      continue;
    }
    // byte mismatch: pin the code line owning the first diff.
    const d = firstDiff(original, out);
    const off = (d < 0 ? Math.min(out.length, original.length) : d) + startAddress;
    let owner = -1;
    for (let i = 0; i < meta.length; i++) {
      if (meta[i].code && meta[i].addr <= off && off < meta[i].addr + meta[i].bytes.length) { owner = i; break; }
      if (meta[i].code && meta[i].addr <= off) owner = i;
    }
    if (owner < 0 || forced.has(owner)) {
      const next = meta.findIndex((m, i) => m.code && !forced.has(i));
      if (next < 0) break;
      forced.add(next);
    } else {
      forced.add(owner);
    }
  }
  // Guaranteed floor: a CLEAN all-`.byte` dump of the original bytes (no da65
  // equates/labels/width-directives to desync). This is byte-exact on every
  // cc65 target we tested (incl. 65816, where mixing pinned `.byte` with live
  // instructions can break `.a8`/`.i8` width state — so when the incremental
  // heal can't converge, we emit pure data). Lower readability, but correct.
  {
    const rows = [`\t.setcpu "${cpuTag}"`, `\t.org $${startAddress.toString(16).toUpperCase()}`];
    for (let i = 0; i < original.length; i += 16) {
      rows.push("\t.byte " + Array.from(original.slice(i, i + 16)).map(hex2).join(","));
    }
    const flat = rows.join("\n") + "\n";
    const out = await assemble(flat);
    const ok = !!out && out.length === original.length && firstDiff(original, out) < 0;
    return { family, source: flat, bytes: out ?? null, ok, total: codeLineCount, dcLines: codeLineCount,
      readablePercent: 0,
      note: ok ? "incremental heal did not converge; emitted byte-exact data-only (low readability)" : "could not reach byte-exact even as data" };
  }
}
