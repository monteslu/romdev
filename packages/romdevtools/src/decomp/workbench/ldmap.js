// ldmap.js - read a linked project's symbols: from its `ld -Map`, and from
// its ELF.
//
// What a naive "extract addr + name" scan gets wrong, and this does not:
//   - The VRAM<->ROM mapping is derived, not hardcoded: only sections that
//     print `load address 0x...` (their script used AT()) resolve; a section
//     without one is NOT assumed to have LMA == VMA.
//   - Several output sections can share a VMA (a nested lookup table, or an
//     N64 overlay group). The single-answer lookups resolve through the
//     smallest candidate; sectionsContaining / sectionsLoadedAt return every
//     candidate for a caller that needs the exact answer.
//   - A symbol name is not unique across a map; a by-name lookup answers
//     with the LAST placement the map printed.
//   - `. = ALIGN(...)` location-counter updates are not symbols.
//   - Tiling gaps are reported, not raised.
//
// The ELF half reads .symtab directly: whether a name is object-backed or
// absolute (SHN_ABS), its size and its type. An absolute symbol carrying a
// non-zero size is a linker-script assignment that shadowed a real
// definition (ld keeps the overridden definition's st_size and st_type).
//
// Plain JS ESM + JSDoc.

import { readFileSync } from "node:fs";
import { ValueError, sorted, splitlines, strip, rstrip, minBy } from "./py.js";

const MAP_HEADER = "Linker script and memory map";
const OUTPUT_SECTION_RE = /^\s*(?<name>\.\S+)\s+0x(?<vma>[0-9a-fA-F]+)\s+0x(?<size>[0-9a-fA-F]+)(?:\s+load address\s+0x(?<load>[0-9a-fA-F]+))?\s*$/;
const INPUT_SECTION_RE = /^\s*(?<name>\.\S+)\s+0x(?<vma>[0-9a-fA-F]+)\s+0x(?<size>[0-9a-fA-F]+)\s+(?<path>\S+)\s*$/;
const SYMBOL_RE = /^\s*0x(?<address>[0-9a-fA-F]+)\s+(?<rest>\S.*?)\s*$/;
const CONTINUATION_RE = /^\s+0x[0-9a-fA-F]+\s+0x[0-9a-fA-F]+/;
const hex = (s) => parseInt(s, 16);
const isSpace = (c) => c !== undefined && c !== "" && /^\s$/.test(c);

function bisectRight(arr, x) {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (x < arr[mid]) hi = mid; else lo = mid + 1; }
  return lo;
}

/** One output section's placement, plus its LMA if AT()'d. */
export class OutputSection {
  constructor({ name, vma, size, load_address = null }) { Object.assign(this, { name, vma, size, load_address }); Object.freeze(this); }
  get end() { return this.vma + this.size; }
  contains(address) { return this.size === 0 ? address === this.vma : this.vma <= address && address < this.end; }
  asDict() { return { name: this.name, vma: this.vma, size: this.size, load_address: this.load_address }; }
}

/** One object's contribution to an output section. */
export class InputSection {
  constructor({ name, output_section, vma, size, object_path }) { Object.assign(this, { name, output_section, vma, size, object_path }); Object.freeze(this); }
  get end() { return this.vma + this.size; }
  contains(address) { return this.size === 0 ? address === this.vma : this.vma <= address && address < this.end; }
  asDict() { return { name: this.name, output_section: this.output_section, vma: this.vma, size: this.size, object_path: this.object_path }; }
}

/** One symbol-table row: a name placed at an address. */
export class LinkerSymbol {
  constructor({ name, address, is_assignment, expression = null }) { Object.assign(this, { name, address, is_assignment, expression }); Object.freeze(this); }
  asDict() { return { name: this.name, address: this.address, is_assignment: this.is_assignment, expression: this.expression }; }
}

/** One parsed linker map: its sections, input records, and symbols. */
export class LdMap {
  constructor({ path = null, sections = [], input_sections = [], symbols = [] }) {
    this.path = path;
    this.sections = Object.freeze([...sections]);
    this.input_sections = Object.freeze([...input_sections]);
    this.symbols = Object.freeze([...symbols]);
    const byName = new Map();
    for (const s of this.symbols) byName.set(s.name, s); // last write wins
    this._by_name = byName;
    this._by_address = Object.freeze(sorted(this.symbols, (s) => s.address));
    this._addresses = this._by_address.map((s) => s.address);
  }

  /** One symbol's last-written placement, or null. */
  symbol(name) { return this._by_name.get(name) ?? null; }
  /** The distinct names this map defines. */
  symbolNames() { return new Set(this._by_name.keys()); }
  /** Every symbol row, ascending address order, duplicates included. */
  symbolsSorted() { return this._by_address; }
  /** [nearest symbol at or below address, offset], or null. */
  symbolContaining(address) {
    const index = bisectRight(this._addresses, address) - 1;
    if (index < 0) return null;
    const symbol = this._by_address[index];
    return [symbol, address - symbol.address];
  }
  sectionsSorted() { return sorted(this.sections, (s) => s.vma); }
  /** Every output section whose extent holds address, smallest first. */
  sectionsContaining(address) { return sorted(this.sections.filter((s) => s.contains(address)), (s) => [s.size, s.vma]); }
  /** The smallest output section whose extent holds address. */
  sectionContaining(address) { const c = this.sectionsContaining(address); return c.length ? c[0] : null; }
  inputSectionsSorted() { return sorted(this.input_sections, (s) => s.vma); }
  inputSectionContaining(address) {
    const c = this.input_sections.filter((s) => s.contains(address));
    return c.length ? minBy(c, (s) => [s.size, s.vma]) : null;
  }
  /** VRAM address to ROM offset, through AT()'d sections only. */
  romForVram(address) {
    const c = this.sectionsContaining(address).filter((s) => s.load_address !== null);
    if (!c.length) return null;
    return c[0].load_address + (address - c[0].vma);
  }
  /** Every output section whose AT() load range holds offset, smallest first. */
  sectionsLoadedAt(offset) {
    const c = [];
    for (const s of this.sections) {
      if (s.load_address === null) continue;
      if (s.size === 0) { if (offset === s.load_address) c.push(s); continue; }
      if (s.load_address <= offset && offset < s.load_address + s.size) c.push(s);
    }
    return sorted(c, (s) => [s.size, s.load_address]);
  }
  /** ROM offset to VRAM address. */
  vramForRom(offset) {
    const c = this.sectionsLoadedAt(offset);
    if (!c.length) return null;
    return c[0].vma + (offset - c[0].load_address);
  }
}

function mergeWrappedNames(lines) {
  const merged = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    const stripped = strip(line);
    const hasCont = index + 1 < lines.length && CONTINUATION_RE.test(lines[index + 1]);
    if (stripped.startsWith(".") && !stripped.includes(" ") && hasCont) {
      merged.push(rstrip(line) + " " + strip(lines[index + 1]));
      index += 2;
      continue;
    }
    merged.push(line);
    index += 1;
  }
  return merged;
}

/** Parse one GNU `ld -Map` file's text. */
export function parseLdMap(text, { path = null } = {}) {
  const lines = mergeWrappedNames(splitlines(text));
  let start = 0;
  for (let i = 0; i < lines.length; i++) if (strip(lines[i]) === MAP_HEADER) { start = i + 1; break; }
  const sections = [], inputSections = [], symbols = [];
  let currentOutput = "";
  for (const line of lines.slice(start)) {
    const stripped = strip(line);
    if (!stripped) continue;
    const lead = line.slice(0, 1);
    if (!isSpace(lead) && stripped.startsWith(".")) {
      const m = OUTPUT_SECTION_RE.exec(line);
      if (!m) continue;
      const g = m.groups;
      const section = new OutputSection({ name: g.name, vma: hex(g.vma), size: hex(g.size), load_address: g.load !== undefined ? hex(g.load) : null });
      sections.push(section);
      currentOutput = section.name;
      continue;
    }
    if (isSpace(lead) && stripped.startsWith(".")) {
      const m = INPUT_SECTION_RE.exec(line);
      if (!m) continue;
      const g = m.groups;
      inputSections.push(new InputSection({ name: g.name, output_section: currentOutput, vma: hex(g.vma), size: hex(g.size), object_path: g.path }));
      continue;
    }
    if (stripped.startsWith("0x")) {
      const m = SYMBOL_RE.exec(line);
      if (!m) continue;
      const address = hex(m.groups.address);
      const rest = m.groups.rest;
      const at = rest.indexOf(" = ");
      if (at >= 0) {
        const name = rest.slice(0, at), expression = rest.slice(at + 3);
        if (name === ".") continue;
        symbols.push(new LinkerSymbol({ name, address, is_assignment: true, expression }));
      } else if (!rest.includes(" ") && !rest.includes("\t")) {
        symbols.push(new LinkerSymbol({ name: rest, address, is_assignment: false }));
      }
      continue;
    }
  }
  return new LdMap({ path, sections, input_sections: inputSections, symbols });
}

/** Read and parse one `ld -Map` file from disk (`display`: the path as the caller named it). */
export function readLdMap(p, { display = null } = {}) {
  const text = new TextDecoder("utf-8", { fatal: false }).decode(readFileSync(p));
  return parseLdMap(text, { path: display ?? String(p) });
}

/** One place two consecutive input-section extents fail to tile. */
export class TilingGap {
  constructor({ output_section, low, high, gap }) { Object.assign(this, { output_section, low, high, gap }); Object.freeze(this); }
  get kind() { return this.gap > 0 ? "gap" : "overlap"; }
  asDict() {
    return { output_section: this.output_section, kind: this.kind, low_object: this.low.object_path, low_end: this.low.end,
      high_object: this.high.object_path, high_start: this.high.vma, bytes: Math.abs(this.gap) };
  }
}

/** Report every place consecutive input-section extents don't tile. */
export function auditTiling(ldmap) {
  const byOutput = new Map();
  for (const item of ldmap.input_sections) {
    if (item.size === 0) continue;
    if (!byOutput.has(item.output_section)) byOutput.set(item.output_section, []);
    byOutput.get(item.output_section).push(item);
  }
  let findings = [];
  for (const [name, items] of byOutput) {
    const ordered = sorted(items, (s) => s.vma);
    for (let i = 0; i + 1 < ordered.length; i++) {
      const low = ordered[i], high = ordered[i + 1];
      const delta = high.vma - low.end;
      if (delta !== 0) findings.push(new TilingGap({ output_section: name, low, high, gap: delta }));
    }
  }
  findings = sorted(findings, (f) => [f.output_section, f.low.vma]);
  return findings;
}

/** One symbol's address in two maps, and the delta between them. */
export class SymbolMovement {
  constructor({ name, base_address, shifted_address }) { Object.assign(this, { name, base_address, shifted_address }); Object.freeze(this); }
  get delta() { return this.shifted_address - this.base_address; }
  asDict() { return { name: this.name, base_address: this.base_address, shifted_address: this.shifted_address, delta: this.delta }; }
}

/** Per-shared-symbol placement deltas between a base map and a shifted one. */
export class MovementAudit {
  constructor({ base_path, shifted_path, allowed_deltas, movements, only_in_base, only_in_shifted }) {
    Object.assign(this, { base_path, shifted_path, allowed_deltas: new Set(allowed_deltas), movements, only_in_base, only_in_shifted });
    Object.freeze(this);
  }
  get anomalies() { return this.movements.filter((m) => !this.allowed_deltas.has(m.delta)); }
  get anomalous_names() { return new Set(this.anomalies.map((m) => m.name)); }
  asDict() {
    return { base: this.base_path, shifted: this.shifted_path, allowed_deltas: sorted([...this.allowed_deltas]),
      shared_symbols: this.movements.length, only_in_base: [...this.only_in_base], only_in_shifted: [...this.only_in_shifted],
      anomalies: this.anomalies.map((m) => m.asDict()) };
  }
}

/** Compare every symbol two maps share and flag deltas outside allowed_deltas. */
export function auditSymbolMovement(base, shifted, { allowed_deltas = [0] } = {}) {
  const baseNames = base.symbolNames(), shiftedNames = shifted.symbolNames();
  let movements = [];
  for (const name of baseNames) {
    if (!shiftedNames.has(name)) continue;
    movements.push(new SymbolMovement({ name, base_address: base.symbol(name).address, shifted_address: shifted.symbol(name).address }));
  }
  movements = sorted(movements, (m) => m.base_address);
  return new MovementAudit({
    base_path: base.path, shifted_path: shifted.path, allowed_deltas, movements,
    only_in_base: sorted([...baseNames].filter((n) => !shiftedNames.has(n))),
    only_in_shifted: sorted([...shiftedNames].filter((n) => !baseNames.has(n))),
  });
}

// ELF symbol table

export const SHN_UNDEF = 0;
export const SHN_LORESERVE = 0xFF00;
export const SHN_ABS = 0xFFF1;
export const SHN_COMMON = 0xFFF2;
export const ELF_SYMBOL_KINDS = Object.freeze({ 0: "notype", 1: "object", 2: "func", 3: "section", 4: "file", 5: "common", 6: "tls" });
export const ELF_SYMBOL_BINDINGS = Object.freeze({ 0: "local", 1: "global", 2: "weak" });
const ELF_SKIPPED_KINDS = new Set(["file", "section"]);
const SHT_SYMTAB = 2, SHF_ALLOC = 0x2, ELF32_SYM_SIZE = 16;

/** The file is not the big-endian 32-bit ELF this reader was written for. */
export class ElfFormatError extends ValueError {
  constructor(message) { super(message); this.name = "ValueError"; }
}

/** One ELF section header: enough of it to own an address. */
export class ElfSection {
  constructor({ name, address, size, allocated }) { Object.assign(this, { name, address, size, allocated }); Object.freeze(this); }
  get end() { return this.address + this.size; }
  contains(address) { return this.size === 0 ? address === this.address : this.address <= address && address < this.end; }
  asDict() { return { name: this.name, address: this.address, size: this.size, allocated: this.allocated }; }
}

/** One .symtab entry, with the three facts a map cannot print. */
export class ElfSymbol {
  constructor({ name, value, size, kind, binding, section_index, section = null }) {
    Object.assign(this, { name, value, size, kind, binding, section_index, section });
    Object.freeze(this);
  }
  get is_absolute() { return this.section_index === SHN_ABS; }
  get is_undefined() { return this.section_index === SHN_UNDEF; }
  get is_object_backed() { return this.section_index > 0 && this.section_index < SHN_LORESERVE; }
  get shadows_definition() { return this.is_absolute && this.size > 0; }
  asDict() { return { name: this.name, value: this.value, size: this.size, kind: this.kind, binding: this.binding, section: this.section }; }
}

/** One linked ELF's symbol table and the sections its symbols live in. */
export class ElfSymbols {
  constructor({ path = null, sections = [], symbols = [] }) {
    this.path = path;
    this.sections = Object.freeze([...sections]);
    this.symbols = Object.freeze([...symbols]);
    const byName = new Map();
    for (const s of this.symbols) byName.set(s.name, s);
    this._by_name = byName;
  }
  symbol(name) { return this._by_name.get(name) ?? null; }
  names() { return new Set(this._by_name.keys()); }
  /** The smallest allocated section whose extent holds address. */
  sectionAt(address) {
    const c = this.sections.filter((s) => s.allocated && s.contains(address));
    return c.length ? minBy(c, (s) => [s.size, s.address]) : null;
  }
}

/** Parse one big-endian ELF32's .symtab into named, typed symbols. */
export function parseElfSymbols(data, { path = null } = {}) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const label = path || "input";
  if (buf.length < 52 || !buf.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
    throw new ElfFormatError(`${label} is not an ELF file (bad magic): --elf wants the linked ELF your \`ld\` produced, not the image or the map`);
  }
  if (buf[4] !== 1) throw new ElfFormatError(`${label}: only 32-bit ELF (EI_CLASS=1) is supported, got class ${buf[4]}`);
  if (buf[5] !== 2) throw new ElfFormatError(`${label}: only big-endian ELF (EI_DATA=2) is supported, got data encoding ${buf[5]}`);
  const shoff = buf.readUInt32BE(0x20);
  const shentsize = buf.readUInt16BE(0x2E), shnum = buf.readUInt16BE(0x30), shstrndx = buf.readUInt16BE(0x32);
  if (shoff === 0 || shnum === 0) throw new ElfFormatError(`${label} carries no section header table`);
  const header = (index) => {
    const o = shoff + index * shentsize;
    return [0, 1, 2, 3, 4, 5, 6].map((k) => buf.readUInt32BE(o + k * 4));
  };
  const stringAt = (tableOffset, tableSize, index) => {
    const start = tableOffset + index;
    const limit = tableOffset + tableSize;
    let end = buf.indexOf(0, start);
    if (end < 0 || end >= limit) end = limit;
    return [...buf.subarray(start, end)].map((b) => (b < 0x80 ? String.fromCharCode(b) : "\ufffd")).join("");
  };
  const sh = header(shstrndx);
  const shstrOffset = sh[4], shstrSize = sh[5];
  const sections = [];
  let symtab = null;
  for (let i = 0; i < shnum; i++) {
    const [name, kind, flags, address, fileOffset, size, link] = header(i);
    sections.push(new ElfSection({ name: stringAt(shstrOffset, shstrSize, name), address, size, allocated: !!(flags & SHF_ALLOC) }));
    if (kind === SHT_SYMTAB && symtab === null) symtab = [fileOffset, size, link];
  }
  if (symtab === null) throw new ElfFormatError(`${label} carries no .symtab: this ELF is stripped, and a stripped link cannot answer which of its symbols are absolute`);
  const [symOffset, symSize, strIndex] = symtab;
  const st = header(strIndex);
  const strOffset = st[4], strSize = st[5];
  const symbols = [];
  for (let i = 0; i < Math.floor(symSize / ELF32_SYM_SIZE); i++) {
    const o = symOffset + i * ELF32_SYM_SIZE;
    const stName = buf.readUInt32BE(o), stValue = buf.readUInt32BE(o + 4), stSize = buf.readUInt32BE(o + 8);
    const stInfo = buf[o + 12], stShndx = buf.readUInt16BE(o + 14);
    const name = stringAt(strOffset, strSize, stName);
    if (!name) continue;
    const kind = ELF_SYMBOL_KINDS[stInfo & 0xF] ?? `type-${stInfo & 0xF}`;
    if (ELF_SKIPPED_KINDS.has(kind)) continue;
    const owner = stShndx > 0 && stShndx < SHN_LORESERVE && stShndx < sections.length ? sections[stShndx].name : null;
    symbols.push(new ElfSymbol({ name, value: stValue, size: stSize, kind, binding: ELF_SYMBOL_BINDINGS[stInfo >> 4] ?? `bind-${stInfo >> 4}`, section_index: stShndx, section: owner }));
  }
  return new ElfSymbols({ path, sections, symbols });
}

/** Read and parse one linked ELF's symbol table from disk (`display`: the path as named). */
export function readElfSymbols(p, { display = null } = {}) {
  return parseElfSymbols(readFileSync(p), { path: display ?? String(p) });
}
