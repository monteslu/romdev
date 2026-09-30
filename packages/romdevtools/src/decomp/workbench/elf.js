// elf.js - an ELF32 big-endian relocatable object reader: sections, the
// symbol table and REL relocations. Structural defects past the header are
// returned as facts (malformed_reloc_sections), never thrown.
//
// Plain JS ESM + JSDoc.

import { readFileSync } from "node:fs";
import { ValueError } from "./py.js";

const ELF_MAGIC = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);
export const SHT_NULL = 0, SHT_PROGBITS = 1, SHT_SYMTAB = 2, SHT_STRTAB = 3, SHT_REL = 9, SHT_NOBITS = 8;
export const SHN_UNDEF = 0, SHN_ABS = 0xFFF1, SHN_COMMON = 0xFFF2;
export const ELF32_REL_ENTSIZE = 8, ELF32_SYM_ENTSIZE = 16;

export const R_MIPS_NAMES = Object.freeze({
  0: "R_MIPS_NONE", 1: "R_MIPS_16", 2: "R_MIPS_32", 3: "R_MIPS_REL32", 4: "R_MIPS_26", 5: "R_MIPS_HI16", 6: "R_MIPS_LO16",
  7: "R_MIPS_GPREL16", 8: "R_MIPS_LITERAL", 9: "R_MIPS_GOT16", 10: "R_MIPS_PC16", 11: "R_MIPS_CALL16", 12: "R_MIPS_GPREL32",
  16: "R_MIPS_SHIFT5", 17: "R_MIPS_SHIFT6", 18: "R_MIPS_64", 19: "R_MIPS_GOT_DISP", 20: "R_MIPS_GOT_PAGE", 21: "R_MIPS_GOT_OFST",
  22: "R_MIPS_GOT_HI16", 23: "R_MIPS_GOT_LO16", 24: "R_MIPS_SUB", 30: "R_MIPS_JALR",
});

export function rMipsName(rType) { return R_MIPS_NAMES[rType] ?? `R_MIPS_${rType}`; }

/** The file is not a supported ELF32 big-endian relocatable object. */
export class ElfFormatError extends ValueError {
  constructor(message) { super(message); this.name = "ValueError"; this.elfFormat = true; }
}

export class Section {
  constructor(f) { Object.assign(this, f); Object.freeze(this); }
  asDict() {
    const { index, name, type, flags, addr, offset, size, link, info, addralign, entsize } = this;
    return { index, name, type, flags, addr, offset, size, link, info, addralign, entsize };
  }
}

export class Symbol_ {
  constructor(f) { Object.assign(this, f); Object.freeze(this); }
  get bind() { return this.info >> 4; }
  get type() { return this.info & 0xF; }
  get defined() { return this.shndx !== SHN_UNDEF; }
  asDict() {
    return { index: this.index, name: this.name, value: this.value, size: this.size, bind: this.bind, type: this.type, shndx: this.shndx, defined: this.defined };
  }
}
export { Symbol_ as Symbol };

export class Reloc {
  constructor(f) { Object.assign(this, f); Object.freeze(this); }
  get kind() { return rMipsName(this.type); }
  asDict() { return { offset: this.offset, sym_index: this.sym_index, type: this.type, kind: this.kind, applies_to: this.applies_to }; }
}

export class ElfObject {
  constructor({ path = null, data, sections, symbols, relocations, malformed_reloc_sections = [] }) {
    Object.assign(this, { path, data, sections, symbols, relocations, malformed_reloc_sections });
    Object.freeze(this);
  }
  section(name) { return this.sections.find((s) => s.name === name) ?? null; }
  sectionBytes(name) {
    const s = this.section(name);
    if (s === null) return null;
    if (s.type === SHT_NOBITS) return Buffer.alloc(0);
    return this.data.subarray(s.offset, s.offset + s.size);
  }
  symbol(index) { return index >= 0 && index < this.symbols.length ? this.symbols[index] : null; }
  relocationsFor(name) { return this.relocations.get(name) ?? []; }
  symbolName(index) { const s = this.symbol(index); return s !== null ? s.name : null; }
}

/** NUL-terminated ASCII string at offset, "" when out of range. */
export function cString(table, offset) {
  if (offset < 0 || offset > table.length) return "";
  let end = table.indexOf(0, offset);
  if (end === -1) end = table.length;
  return asciiReplace(table.subarray(offset, end));
}

/** bytes.decode("ascii", errors="replace") */
export function asciiReplace(bytes) {
  let s = "";
  for (const b of bytes) s += b < 0x80 ? String.fromCharCode(b) : "\ufffd";
  return s;
}

function u32(data, off) { if (off < 0 || off + 4 > data.length) throw new RangeError("unpack_from requires a buffer of at least " + (off + 4) + " bytes"); return data.readUInt32BE(off); }
function u16(data, off) { if (off < 0 || off + 2 > data.length) throw new RangeError("unpack_from requires a buffer of at least " + (off + 2) + " bytes"); return data.readUInt16BE(off); }
export { u32 as readU32, u16 as readU16 };

/** Parse an ELF32 big-endian relocatable object from raw bytes. */
export function parseElf(data, { path = null } = {}) {
  data = Buffer.from(data);
  if (data.length < 52 || !data.subarray(0, 4).equals(ELF_MAGIC)) throw new ElfFormatError("not an ELF file (bad magic)");
  if (data[4] !== 1) throw new ElfFormatError(`only 32-bit ELF (EI_CLASS=1) is supported, got ${data[4]}`);
  if (data[5] !== 2) throw new ElfFormatError(`only big-endian ELF (EI_DATA=2) is supported, got ${data[5]}`);
  const e_shoff = u32(data, 0x20), e_shentsize = u16(data, 0x2E), e_shnum = u16(data, 0x30), e_shstrndx = u16(data, 0x32);
  if (e_shoff === 0 || e_shnum === 0) throw new ElfFormatError("ELF file carries no section header table");
  const rawHeader = (index) => { const o = e_shoff + index * e_shentsize; return Array.from({ length: 10 }, (_, k) => u32(data, o + 4 * k)); };
  if (!(e_shstrndx >= 0 && e_shstrndx < e_shnum)) throw new ElfFormatError(`e_shstrndx ${e_shstrndx} names no section`);
  const sh = rawHeader(e_shstrndx);
  const shstrtab = data.subarray(sh[4], sh[4] + sh[5]);
  const sections = [];
  for (let index = 0; index < e_shnum; index++) {
    const [name_off, type, flags, addr, offset, size, link, info, addralign, entsize] = rawHeader(index);
    sections.push(new Section({ index, name: cString(shstrtab, name_off), type, flags, addr, offset, size, link, info, addralign, entsize }));
  }
  const symbols = [];
  const symtab = sections.find((s) => s.type === SHT_SYMTAB) ?? null;
  if (symtab !== null) {
    const strSec = symtab.link >= 0 && symtab.link < sections.length ? sections[symtab.link] : null;
    const strtab = strSec !== null ? data.subarray(strSec.offset, strSec.offset + strSec.size) : Buffer.alloc(0);
    const raw = data.subarray(symtab.offset, symtab.offset + symtab.size);
    const count = Math.floor(raw.length / ELF32_SYM_ENTSIZE);
    for (let index = 0; index < count; index++) {
      const o = index * ELF32_SYM_ENTSIZE;
      symbols.push(new Symbol_({ index, name: cString(strtab, raw.readUInt32BE(o)), value: raw.readUInt32BE(o + 4), size: raw.readUInt32BE(o + 8),
        info: raw[o + 12], other: raw[o + 13], shndx: raw.readUInt16BE(o + 14) }));
    }
  }
  const relocations = new Map();
  const malformed = [];
  for (const section of sections) {
    if (section.type !== SHT_REL) continue;
    const target = section.info >= 0 && section.info < sections.length ? sections[section.info] : null;
    const targetName = target !== null ? target.name : section.name;
    const entsize = section.entsize || ELF32_REL_ENTSIZE;
    const raw = data.subarray(section.offset, section.offset + section.size);
    if (target === null || entsize !== ELF32_REL_ENTSIZE || section.size % ELF32_REL_ENTSIZE !== 0
      || !(section.link >= 0 && section.link < sections.length) || sections[section.link].type !== SHT_SYMTAB) malformed.push(section.name);
    const count = Math.floor(raw.length / ELF32_REL_ENTSIZE);
    const entries = [];
    for (let i = 0; i < count; i++) {
      const r_offset = raw.readUInt32BE(i * 8), r_info = raw.readUInt32BE(i * 8 + 4);
      entries.push(new Reloc({ offset: r_offset, sym_index: r_info >>> 8, type: r_info & 0xFF, applies_to: targetName }));
    }
    if (!relocations.has(targetName)) relocations.set(targetName, []);
    relocations.get(targetName).push(...entries);
  }
  return new ElfObject({ path, data, sections, symbols, relocations, malformed_reloc_sections: malformed });
}

/** Parse an ELF object from a file path. */
export function readElf(p) { return parseElf(readFileSync(p), { path: String(p) }); }
