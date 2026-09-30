// elf-symbols.js - where one function starts and stops, read from the
// object's own symbol table rather than inferred from printed labels (a
// label is not a function boundary: splat targets carry a symbol for every
// jump-table destination inside a body). Declines with null, never throws.
//
// Plain JS ESM + JSDoc.

import { readFileSync } from "node:fs";
import { cString, asciiReplace } from "./elf.js";
import { minBy } from "./py.js";

export const STT_FUNC = 2;
const STT_SECTION = 3, STT_FILE = 4;
const STB_GLOBAL = 1, STB_WEAK = 2;
const SHT_SYMTAB = 2, SHT_NOBITS = 8;

/** One symbol's section-relative byte range, and how it was decided. */
export class SymbolExtent {
  constructor({ name, section, start, stop, basis }) { Object.assign(this, { name, section, start, stop, basis }); Object.freeze(this); }
  contains(offset) { if (offset < this.start) return false; return this.stop === null || offset < this.stop; }
}

export class ElfSymbol {
  constructor({ name, value, size, info, section_index }) { Object.assign(this, { name, value, size, info, section_index }); Object.freeze(this); }
  get kind() { return this.info & 0xF; }
  get binding() { return this.info >> 4; }
  get is_function() { return this.kind === STT_FUNC; }
  get starts_a_function() {
    if (this.is_function) return true;
    return Boolean(this.name && (this.binding === STB_GLOBAL || this.binding === STB_WEAK) && this.kind !== STT_SECTION && this.kind !== STT_FILE);
  }
}

function sections(data) {
  if (data.length < 52 || data[0] !== 0x7f || data[1] !== 0x45 || data[2] !== 0x4c || data[3] !== 0x46) return null;
  if (data[4] !== 1 || data[5] !== 2) return null;
  const e_shoff = data.readUInt32BE(0x20), e_shentsize = data.readUInt16BE(0x2E), e_shnum = data.readUInt16BE(0x30), e_shstrndx = data.readUInt16BE(0x32);
  if (e_shoff === 0 || e_shnum === 0 || e_shstrndx >= e_shnum) return null;
  const raw = [];
  for (let index = 0; index < e_shnum; index++) {
    const o = e_shoff + index * e_shentsize;
    if (o + 40 > data.length) return null;
    const w = (k) => data.readUInt32BE(o + 4 * k);
    raw.push([w(0), w(1), w(4), w(5), w(6), w(9)]);
  }
  const [, , strOff, strSize] = raw[e_shstrndx];
  const shstrtab = data.subarray(strOff, strOff + strSize);
  const nameAt = (off) => { let end = shstrtab.indexOf(0, off); if (end < 0) end = shstrtab.length; return asciiReplace(shstrtab.subarray(off, end)); };
  return raw.map((e) => [nameAt(e[0]), e[1], e[2], e[3], e[4], e[5]]);
}

/** Every symtab entry plus a section-name -> index map, or null. */
export function readSymbols(p) {
  let data;
  try { data = readFileSync(p); } catch { return null; }
  const secs = sections(data);
  if (secs === null) return null;
  const indices = new Map();
  secs.forEach(([name], index) => indices.set(name, index));
  const symtab = secs.find((e) => e[1] === SHT_SYMTAB) ?? null;
  if (symtab === null) return null;
  const [, , symOffset, symSize, symLink, symEntsize] = symtab;
  if (symEntsize < 16 || symLink >= secs.length) return null;
  const [, stype, strOffset, strSize] = secs[symLink];
  if (stype === SHT_NOBITS) return null;
  const strtab = data.subarray(strOffset, strOffset + strSize);
  const nameAt = (off) => (off >= strtab.length ? "" : cString(strtab, off));
  const symbols = [];
  for (let c = symOffset; c < symOffset + symSize; c += symEntsize) {
    if (c + 16 > data.length) break;
    symbols.push(new ElfSymbol({ name: nameAt(data.readUInt32BE(c)), value: data.readUInt32BE(c + 4), size: data.readUInt32BE(c + 8),
      info: data[c + 12], section_index: data.readUInt16BE(c + 14) }));
  }
  return [symbols, indices];
}

/** Where `symbol`'s code lives in `section`, or null when the object cannot say. */
export function symbolExtent(p, symbol, { section = ".text" } = {}) {
  const read = readSymbols(p);
  if (read === null) return null;
  const [symbols, indices] = read;
  const sectionIndex = indices.get(section);
  if (sectionIndex === undefined) return null;
  const inSection = symbols.filter((s) => s.section_index === sectionIndex);
  let m = inSection.find((s) => s.name === symbol) ?? null;
  if (m === null) {
    const folded = inSection.filter((s) => s.name.toLowerCase() === symbol.toLowerCase());
    if (folded.length !== 1) return null;
    m = folded[0];
  }
  if (m.size) return new SymbolExtent({ name: m.name, section, start: m.value, stop: m.value + m.size, basis: "size" });
  const successors = inSection.filter((s) => s.starts_a_function && s.value > m.value);
  if (successors.length) {
    const nearest = minBy(successors, (s) => [s.value, !s.is_function]);
    return new SymbolExtent({ name: m.name, section, start: m.value, stop: nearest.value, basis: nearest.is_function ? "next-function" : "next-global" });
  }
  return new SymbolExtent({ name: m.name, section, start: m.value, stop: null, basis: "section-end" });
}
