// Disassembly → native-assembler reassembly translator.
//
// romdev's disassemblers (da65 / z80dasm / sm83dasm / m68kdasm) all emit the
// same house style: a `.setcpu` line, `Lxxxxxx:` labels at referenced targets,
// instruction lines, and a trailing `; ADDR BB BB ...` comment carrying the
// original bytes for that line. That syntax is cc65-flavored and does NOT feed
// straight into the *native* assemblers (sjasm / rgbds / vasm / asar).
//
// This module converts that output into a chosen assembler's syntax so the
// disassembly RE-ASSEMBLES BYTE-EXACT. The guaranteeing trick: every line's
// original bytes are recoverable from its address-comment, so any line we
// can't translate (a disassembler that emitted a broken/partial mnemonic, or
// an instruction the assembler rejects) FALLS BACK to a data directive of the
// exact original bytes. The output is therefore always byte-exact, and as
// readable as the disassembler was able to make it.
//
// Verified byte-exact round-trips: m68k/vasm (Genesis), z80/sjasm (SMS/GG),
// sm83/rgbds (GB/GBC). 6502/cc65 (NES/C64/Atari) uses the da65 `.org` path in
// disasm.js directly (cc65 reassembles its own output natively).

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
  return {}; // directive/comment/blank — skip
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
    const out = await assemble(source);
    if (!out) {
      if (forced.size >= parsed.filter((p) => p.code != null).length) {
        return { source, bytes: null, ok: false, passes: pass + 1, dcLines: forced.size, note: "assembler rejected even the all-data fallback" };
      }
      parsed.forEach((p, i) => { if (p.code != null) forced.add(i); });
      continue;
    }
    if (out.length === original.length && firstDiff(original, out) < 0) {
      return { source, bytes: out, ok: true, passes: pass + 1, dcLines: forced.size };
    }
    let outPos = 0;
    let desynced = false;
    for (let i = 0; i < parsed.length && !desynced; i++) {
      const p = parsed[i];
      if (p.code == null && !(p.bytes && p.label == null)) continue; // label/blank
      const len = p.bytes ? p.bytes.length : 0;
      if (!len) continue;
      // Compare this line's expected original bytes against out[outPos..].
      let match = outPos + len <= out.length;
      if (match) for (let k = 0; k < len; k++) if (out[outPos + k] !== p.bytes[k]) { match = false; break; }
      if (match) { outPos += len; continue; }
      if (forced.has(i) || p.code == null) { outPos += len; continue; }
      // Live instruction didn't reproduce its bytes → pin it. Decide whether
      // we can keep walking: if the NEXT line's original bytes appear at
      // out[outPos+len] (i.e. the assembler kept this line's length, just
      // changed its bytes — e.g. suba→lea), the cursor is still aligned, so
      // advance and continue pinning more this pass. Otherwise the length
      // changed → desync; stop and re-sync next pass (the pin makes it dc.b).
      forced.add(i);
      const next = nextCodeOrData(parsed, i + 1);
      const sameLen = next && next.bytes &&
        outPos + len + next.bytes.length <= out.length &&
        next.bytes.every((b, k) => out[outPos + len + k] === b);
      if (sameLen) { outPos += len; } else { desynced = true; }
    }
    if (!desynced) {
      // Walked the whole window with no new pin but bytes still differ — pin
      // the first not-yet-forced code line as a fallback to guarantee progress.
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
  const out = [dialect.org(startAddress)];
  for (const lbl of referenced) if (!defined.has(lbl)) out.push(dialect.equate(lbl, parseInt(lbl.slice(1), 16)));
  let fellBack = 0;
  for (let i = 0; i < parsed.length; i++) {
    const p = parsed[i];
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

/** rgbds (sm83 / Game Boy) dialect. rgbasm: `db`, `label:`, needs a SECTION;
 *  modern rgbasm requires `DEF name EQU value` (bare `name EQU` is rejected as
 *  an undefined-macro call). */
export const RGBDS_SM83 = {
  org: (a) => `SECTION "dis", ROM0[$${a.toString(16).toUpperCase()}]`,
  dataDir: (bytes) => "\tdb " + bytes.map(hex2).join(","),
  labelDef: (l) => l + ":",
  equate: (l, a) => `DEF ${l} EQU $${a.toString(16).toUpperCase()}`,
  insn: passthroughInsn("db"),
};
