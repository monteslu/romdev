// target-audit.js - verify a campaign/scratch target object's scope before
// anyone matches it. Static (ELF sanity, the literal-pool truncation
// heuristic, a data-scope report) plus one optional read-only ROM peek just
// past the object's own extracted .rodata extent. A function-owned literal
// pool that was externalized and cut off at the jump table's end is the
// defect this exists to catch on day one. See docs/target-audit.md.
//
// Severities compose into one verdict: any defect -> "defects"; otherwise
// any warning -> "warnings"; otherwise "ok". info never affects it.
//
// Plain JS ESM + JSDoc.

import { openSync, readSync, closeSync, statSync } from "node:fs";
import { ElfFormatError, readElf } from "./elf.js";
import { ValueError, sorted, hex, counter, mostCommon } from "./py.js";
import { pyRepr } from "./pyrepr.js";

export { ElfFormatError };

export const TARGET_AUDIT_SCHEMA = "decomp-workbench-target-audit-v1";
export const DEFECT = "defect";
export const WARNING = "warning";
export const INFO = "info";
const SEVERITY_ORDER = { [DEFECT]: 0, [WARNING]: 1, [INFO]: 2 };

export const OP_LW = 0x23;
export const OP_LWC1 = 0x31;
export const OP_LDC1 = 0x35;
export const OPCODE_NAMES = Object.freeze({ [OP_LW]: "lw", [OP_LWC1]: "lwc1", [OP_LDC1]: "ldc1" });
export const REGISTER_AT = 1;
export const ROM_READ_MIN_BYTES = 16;
export const ROM_READ_MAX_BYTES = 64;
const EVIDENCE_LIMIT = 20;

function word(data, offset) {
  if (offset < 0 || offset + 4 > data.length) return null;
  return data.readUInt32BE(offset);
}
const opcode = (w) => (w >>> 26) & 0x3F;
const rs = (w) => (w >>> 21) & 0x1F;
const signedLo = (w) => { const v = w & 0xFFFF; return v & 0x8000 ? v - 0x10000 : v; };

/** One thing this audit noticed, with enough evidence to act on it. */
export class Finding {
  constructor(severity, code, message, evidence = {}) {
    Object.assign(this, { severity, code, message, evidence });
    Object.freeze(this);
  }
  asDict() { return { severity: this.severity, code: this.code, message: this.message, evidence: this.evidence }; }
}

/** The full report: verdict, findings, and the evidence behind them. */
export class TargetAudit {
  constructor({ path, verdict, findings, data_scope, rom_check }) {
    Object.assign(this, { path, verdict, findings, data_scope, rom_check });
    Object.freeze(this);
  }
  get defects() { return this.findings.filter((f) => f.severity === DEFECT).length; }
  get warnings() { return this.findings.filter((f) => f.severity === WARNING).length; }
  asDict() {
    return { schema: TARGET_AUDIT_SCHEMA, path: this.path, verdict: this.verdict, defects: this.defects, warnings: this.warnings,
      findings: this.findings.map((f) => f.asDict()), data_scope: this.data_scope, rom_check: this.rom_check };
  }
}

function capped(items) {
  const shown = items.slice(0, EVIDENCE_LIMIT);
  return [shown, Math.max(0, items.length - shown.length)];
}

function sanityFindings(elf) {
  const findings = [];
  if (elf.section(".text") === null) findings.push(new Finding(DEFECT, "missing-text-section", "the object has no `.text` section at all", {}));
  const symtab = elf.section(".symtab");
  if (symtab === null) {
    findings.push(new Finding(DEFECT, "missing-symtab", "the object has no `.symtab`; a stripped object cannot be scoped against its own relocations", {}));
  } else if (symtab.size % 16 !== 0) {
    findings.push(new Finding(DEFECT, "symtab-entsize-mismatch", `.symtab size ${symtab.size} is not a multiple of the Elf32_Sym entry size (16)`, { symtab_size: symtab.size }));
  } else if (!(symtab.link >= 0 && symtab.link < elf.sections.length) || elf.sections[symtab.link].type !== 3) {
    findings.push(new Finding(DEFECT, "symtab-link-invalid", `.symtab's sh_link (${symtab.link}) does not name a string table section`, { sh_link: symtab.link }));
  }
  for (const name of elf.malformed_reloc_sections) {
    findings.push(new Finding(DEFECT, "reloc-section-malformed",
      `the relocation section covering \`${name}\` has an entry size, target section, or symbol-table link that does not match a conforming Elf32_Rel table`,
      { applies_to: name }));
  }
  const maxSymbol = elf.symbols.length;
  const badShndx = elf.symbols.filter((s) => ![0, 0xFFF1, 0xFFF2].includes(s.shndx) && s.shndx < 0xFF00 && s.shndx >= elf.sections.length).map((s) => s.index);
  if (badShndx.length) {
    const [shown, extra] = capped(badShndx);
    findings.push(new Finding(DEFECT, "symbol-shndx-invalid", `${badShndx.length} symbol(s) name a section index past the object's own section table`, { symbol_indices: shown, more: extra }));
  }
  const badRelocSyms = [];
  for (const [sectionName, entries] of elf.relocations) {
    for (const entry of entries) {
      if (!(entry.sym_index >= 0 && entry.sym_index < maxSymbol)) badRelocSyms.push({ applies_to: sectionName, offset: entry.offset, sym_index: entry.sym_index });
    }
  }
  if (badRelocSyms.length) {
    const [shown, extra] = capped(badRelocSyms);
    findings.push(new Finding(DEFECT, "reloc-symbol-index-out-of-range", `${badRelocSyms.length} relocation(s) name a symbol index outside the object's own symbol table`, { relocations: shown, more: extra }));
  }
  return findings;
}

/** What the literal-pool heuristic and the data-scope report share. */
class PoolEvidence {
  constructor(f) { Object.assign(this, f); Object.freeze(this); }
  get table_shape_confirmed() { return this.table_contiguous && this.table_start === 0; }
  get truncated_at_table() { return this.bytes_after_table === 0 && this.table_shape_confirmed && this.fp_pool_sites.length > 0; }
}

function poolEvidence(elf) {
  const textSection = elf.section(".text");
  const rodataSection = elf.section(".rodata");
  const textBytes = elf.sectionBytes(".text") ?? Buffer.alloc(0);
  const textIndex = textSection !== null ? textSection.index : null;
  const rodataSize = rodataSection !== null ? rodataSection.size : 0;
  const relocated = [];
  if (textIndex !== null) {
    for (const entry of elf.relocationsFor(".rodata")) {
      const symbol = elf.symbol(entry.sym_index);
      if (symbol !== null && symbol.shndx === textIndex) relocated.push(entry.offset);
    }
  }
  const jumpTableOffsets = sorted(relocated.filter((o) => o >= 0 && o + 4 <= rodataSize));
  const outOfRange = sorted(relocated.filter((o) => o < 0 || o + 4 > rodataSize));
  const tableStart = jumpTableOffsets.length ? jumpTableOffsets[0] : null;
  const tableEnd = jumpTableOffsets.length ? jumpTableOffsets.at(-1) + 4 : null;
  let tableContiguous = false;
  if (tableEnd !== null) {
    const expected = [];
    for (let o = jumpTableOffsets[0]; o < tableEnd; o += 4) expected.push(o);
    tableContiguous = expected.length === jumpTableOffsets.length && expected.every((v, i) => v === jumpTableOffsets[i]);
  }
  const bytesAfterTable = tableEnd !== null ? rodataSize - tableEnd : null;
  const fpPoolSites = [];
  const undefHilo = new Map();
  for (const entry of elf.relocationsFor(".text")) {
    if (entry.kind !== "R_MIPS_HI16" && entry.kind !== "R_MIPS_LO16") continue;
    const symbol = elf.symbol(entry.sym_index);
    if (symbol === null || symbol.defined) continue;
    if (entry.kind === "R_MIPS_HI16") { if (!undefHilo.has(symbol.name)) undefHilo.set(symbol.name, []); continue; }
    const w = word(textBytes, entry.offset);
    const addend = w !== null ? signedLo(w) : null;
    if (!undefHilo.has(symbol.name)) undefHilo.set(symbol.name, []);
    undefHilo.get(symbol.name).push(addend);
    if (w === null) continue;
    const op = opcode(w);
    if (!(op in OPCODE_NAMES) || rs(w) !== REGISTER_AT) continue;
    fpPoolSites.push({ text_offset: entry.offset, symbol: symbol.name, opcode: OPCODE_NAMES[op], addend });
  }
  return new PoolEvidence({ jump_table_offsets: jumpTableOffsets, table_start: tableStart, table_end: tableEnd, rodata_size: rodataSize,
    bytes_after_table: bytesAfterTable, table_contiguous: tableContiguous, out_of_range_offsets: outOfRange,
    fp_pool_sites: fpPoolSites, undef_hilo_symbols: undefHilo });
}

function literalPoolFindings(ev) {
  const findings = [];
  if (!ev.fp_pool_sites.length) return findings;
  const symbols = sorted([...new Set(ev.fp_pool_sites.map((s) => s.symbol))]);
  const common = {
    fp_pool_sites: [...ev.fp_pool_sites], distinct_undef_symbols: symbols, jump_table_words: ev.jump_table_offsets.length,
    jump_table_start: ev.table_start, jump_table_end: ev.table_end, jump_table_contiguous: ev.table_contiguous,
    rodata_size: ev.rodata_size, bytes_after_jump_table: ev.bytes_after_table, rodata_relocations_out_of_range: [...ev.out_of_range_offsets],
  };
  if (ev.table_end === null) {
    findings.push(new Finding(WARNING, "fp-literal-undef-no-jump-table-context",
      `${symbols.length} undefined symbol(s) are reached from `
      + "`.text` through `$at` the way a per-use-site FP literal "
      + "pool is (`lwc1`/`ldc1 %lo(sym)($at)`), but no jump table "
      + "was found in `.rodata` to check the boundary against -- "
      + "audit `.rodata`'s scope by hand or supply --rom to check "
      + "the bytes directly", common));
  } else if (ev.bytes_after_table === 0 && !ev.table_shape_confirmed) {
    const shape = !ev.table_contiguous
      ? `the relocated words are not contiguous 4-byte slots (${ev.jump_table_offsets.length} of them between ${ev.table_start} and ${ev.table_end})`
      : `the run starts at .rodata+${ev.table_start}, not at the section's start`;
    findings.push(new Finding(WARNING, "rodata-ends-at-text-relocated-words",
      "`.rodata` ends exactly where its `.text`-relocated words do, "
      + `while ${symbols.length} undefined symbol(s) are loaded through `
      + `\`$at\` -- but ${shape}, so this is not the jump table the `
      + "cef4c truncation defect needs. A `const` array of function "
      + "pointers at the end of `.rodata` has exactly this shape and "
      + "is healthy. Read the words before treating the section as "
      + "truncated; see docs/target-audit.md", common));
  } else if (ev.bytes_after_table === 0) {
    findings.push(new Finding(DEFECT, "literal-pool-truncated-at-jump-table",
      "`.rodata` ends exactly at the jump table's own end "
      + `(${ev.table_end} bytes), with zero bytes left over, `
      + `while ${symbols.length} undefined symbol(s) are loaded `
      + "through `$at` the way a per-use-site FP literal pool is -- "
      + "this is the cef4c defect: a function-owned literal pool "
      + "that used to sit right after the jump table was "
      + "externalized and the section truncated to hide it. See "
      + "docs/target-audit.md", common));
  } else {
    findings.push(new Finding(INFO, "literal-pool-present",
      `\`.rodata\` carries ${ev.bytes_after_table} byte(s) `
      + `past the jump table's end (${ev.table_end}); `
      + `${symbols.length} undefined symbol(s) are still loaded `
      + "through `$at`, but the section is not truncated at the "
      + "table boundary", common));
  }
  return findings;
}

function romCrossCheck({ rom, rom_offset, va, rodata_size, undef_fp_symbol_count, evaluate }) {
  const size = statSync(rom).size;
  const past = rom_offset + rodata_size;
  const window = Math.min(ROM_READ_MAX_BYTES, Math.max(ROM_READ_MIN_BYTES, 4 * Math.max(undef_fp_symbol_count, 1)));
  const result = { rom: String(rom), rodata_extent_rom_offset: rom_offset, rodata_extent_va: va, checked_rom_offset: past, checked_va: va + rodata_size, window_bytes: window };
  if (past < 0 || past + window > size) {
    result.words = [];
    return [result, new Finding(DEFECT, "rom-read-out-of-range",
      `the requested ROM window (offset ${hex(past, 0, { prefix: true })}, ${window} bytes) does not fit inside ${rom} (${size} bytes)`,
      { rom: String(rom), offset: past, window, size })];
  }
  const chunk = Buffer.alloc(window);
  const fd = openSync(rom, "r");
  let n;
  try { n = readSync(fd, chunk, 0, window, past); } finally { closeSync(fd); }
  const data = chunk.subarray(0, n);
  const words = [];
  for (let i = 0; i < data.length - 3; i += 4) words.push(data.readUInt32BE(i));
  result.words = words.map((w) => `0x${hex(w, 8)}`);
  if (!words.length || undef_fp_symbol_count === 0) return [result, null];
  const [[topValue, topCount]] = mostCommon(counter(words), 1);
  result.most_common_word = `0x${hex(topValue, 8)}`;
  result.most_common_count = topCount;
  result.matches_undef_fp_symbol_count = topCount === undef_fp_symbol_count;
  if (!evaluate) return [result, null];
  if (topCount === undef_fp_symbol_count && topCount >= 2) {
    return [result, new Finding(INFO, "rom-confirms-literal-pool",
      "ROM bytes immediately past the extracted `.rodata` extent "
      + `repeat 0x${hex(topValue, 8)} exactly ${topCount} time(s) -- `
      + `matching the ${undef_fp_symbol_count} undefined symbol(s) `
      + "`.text` loads through `$at`. The pool belongs to this "
      + "function", result)];
  }
  return [result, new Finding(WARNING, "rom-does-not-confirm-literal-pool",
    "ROM bytes immediately past the extracted `.rodata` extent do "
    + `not show a value repeated ${undef_fp_symbol_count} time(s) `
    + "(one per undefined `$at`-loaded symbol) -- inspect `words` "
    + "before trusting the truncation finding either way", result)];
}

/** The text the original printed for an OSError (`[Errno N] reason: 'path'`). */
function osText(e, p) {
  const errno = { ENOENT: [2, "No such file or directory"], EACCES: [13, "Permission denied"], EISDIR: [21, "Is a directory"] }[e?.code];
  return errno ? `[Errno ${errno[0]}] ${errno[1]}: '${p}'` : String(e?.message ?? e);
}

/** Audit one target/candidate object's ELF scope, statically. */
export function auditTarget(p, { rom = null, rom_offset = null, va = null } = {}) {
  const supplied = [rom !== null, rom_offset !== null, va !== null];
  if (supplied.some(Boolean) && !supplied.every(Boolean)) throw new ValueError("--rom, --rom-offset, and --va must be supplied together, or not at all");
  const elf = readElf(p);
  const findings = [...sanityFindings(elf)];
  const ev = poolEvidence(elf);
  if (ev.out_of_range_offsets.length) {
    findings.push(new Finding(DEFECT, "rodata-relocation-out-of-range",
      `${ev.out_of_range_offsets.length} relocation(s) into `
      + "`.text` name a `.rodata` offset that does not fit inside "
      + `\`.rodata\`'s own ${ev.rodata_size} bytes`,
      { offsets: [...ev.out_of_range_offsets], rodata_size: ev.rodata_size }));
  }
  findings.push(...literalPoolFindings(ev));
  const text = elf.section(".text"), data = elf.section(".data"), bss = elf.section(".bss"), rodata = elf.section(".rodata");
  const addends = (values) => sorted(values, (v) => [v === null ? 1 : 0, v === null ? 0 : v]);
  const undef = {};
  for (const name of sorted([...ev.undef_hilo_symbols.keys()])) undef[name] = addends(ev.undef_hilo_symbols.get(name));
  const dataScope = {
    text_size: text !== null ? text.size : 0, rodata_size: ev.rodata_size, data_size: data !== null ? data.size : 0,
    bss_size: bss !== null ? bss.size : 0, rodata_present: rodata !== null, jump_table_words: ev.jump_table_offsets.length,
    jump_table_start: ev.table_start, jump_table_end: ev.table_end, jump_table_contiguous: ev.table_contiguous,
    bytes_after_jump_table: ev.bytes_after_table, rodata_relocations_out_of_range: [...ev.out_of_range_offsets],
    undef_data_symbol_count: ev.undef_hilo_symbols.size, undef_data_symbols: undef,
  };
  let romCheck = null;
  if (rom !== null) {
    const count = new Set(ev.fp_pool_sites.map((s) => s.symbol)).size;
    let romFinding;
    try {
      [romCheck, romFinding] = romCrossCheck({ rom, rom_offset, va, rodata_size: ev.rodata_size, undef_fp_symbol_count: count, evaluate: ev.truncated_at_table });
    } catch (e) {
      if (!(e && typeof e.code === "string")) throw e;
      const text2 = osText(e, rom);
      romFinding = new Finding(DEFECT, "rom-read-failed", `could not read ${rom}: ${text2}`, {});
      romCheck = { rom: String(rom), error: text2 };
    }
    if (romFinding) findings.push(romFinding);
  }
  const ordered = sorted(findings, (f) => [SEVERITY_ORDER[f.severity], f.code]);
  const verdict = ordered.some((f) => f.severity === DEFECT) ? "defects" : ordered.some((f) => f.severity === WARNING) ? "warnings" : "ok";
  return new TargetAudit({ path: String(p), verdict, findings: ordered, data_scope: dataScope, rom_check: romCheck });
}

/** Render a TargetAudit as human-readable lines, in verdict order. */
export function targetAuditLines(audit) {
  const ds = audit.data_scope;
  const r8 = (v) => String(v).padStart(8);
  const lines = [
    `target audit: ${audit.path}`,
    `verdict: ${audit.verdict.toUpperCase()} (${audit.defects} defect(s), ${audit.warnings} warning(s))`,
    "", "data scope:",
    `  .text   ${r8(ds.text_size)} bytes`,
    `  .rodata ${r8(ds.rodata_size)} bytes` + (ds.rodata_present ? "" : "  (section absent)"),
    `  .data   ${r8(ds.data_size)} bytes`,
    `  .bss    ${r8(ds.bss_size)} bytes`,
  ];
  if (ds.jump_table_words) {
    const shape = ds.jump_table_contiguous ? "" : " (not contiguous)";
    lines.push(`  .text-relocated words: ${ds.jump_table_words}, .rodata+${pyRepr(ds.jump_table_start)}..${pyRepr(ds.jump_table_end)}${shape}, ${pyRepr(ds.bytes_after_jump_table)} byte(s) follow them`);
  }
  if (ds.undef_data_symbol_count) {
    lines.push(`  undefined data symbols reached via %hi/%lo: ${ds.undef_data_symbol_count}`);
    for (const [name, addends] of Object.entries(ds.undef_data_symbols)) lines.push(`    ${name}: addends ${pyRepr(addends)}`);
  }
  if (audit.rom_check !== null) {
    lines.push("", "rom cross-check:");
    for (const key of ["rom", "checked_rom_offset", "checked_va", "words", "most_common_word", "most_common_count", "matches_undef_fp_symbol_count", "error"]) {
      if (key in audit.rom_check) {
        const v = audit.rom_check[key];
        lines.push(`  ${key}: ${typeof v === "string" ? v : pyRepr(v)}`);
      }
    }
  }
  if (audit.findings.length) {
    lines.push("", "findings:");
    for (const f of audit.findings) lines.push(`  [${f.severity.toUpperCase()}] ${f.code}: ${f.message}`);
  } else lines.push("", "findings: none");
  return lines;
}
