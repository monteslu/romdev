// Hand-built ELF32 big-endian objects for the target audit tests: section
// specs carry their own sh_type/sh_link/sh_info/sh_entsize, and helpers build
// Elf32_Sym/Elf32_Rel tables. Shapes only; no game-derived bytes.
export const ELF_HEADER_SIZE = 52, SECTION_HEADER_SIZE = 40;
export const SHT_NULL = 0, SHT_PROGBITS = 1, SHT_SYMTAB = 2, SHT_STRTAB = 3, SHT_REL = 9;
export const STB_LOCAL = 0, STB_GLOBAL = 1, STT_NOTYPE = 0, STT_OBJECT = 1, STT_SECTION = 3;
export const SHN_UNDEF = 0;
export const R_MIPS_32 = 2, R_MIPS_HI16 = 5, R_MIPS_LO16 = 6;
export const OP_LUI = 0x0F, OP_LW = 0x23, OP_LWC1 = 0x31, OP_LDC1 = 0x35, REGISTER_AT = 1;

export const word = (opcode, rs, rt, imm) => (((opcode & 0x3F) << 26) | ((rs & 0x1F) << 21) | ((rt & 0x1F) << 16) | (imm & 0xFFFF)) >>> 0;
const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32BE(v >>> 0); return b; };
export const words = (...values) => Buffer.concat(values.map(u32));
export const symInfo = (bind, kind) => (bind << 4) | kind;

export function symEntry({ name_offset, value = 0, size = 0, info, shndx }) {
  const b = Buffer.alloc(16);
  b.writeUInt32BE(name_offset, 0); b.writeUInt32BE(value, 4); b.writeUInt32BE(size, 8); b[12] = info; b[13] = 0; b.writeUInt16BE(shndx, 14);
  return b;
}
export function relEntry({ offset, sym_index, r_type }) { return Buffer.concat([u32(offset), u32(((sym_index << 8) | r_type) >>> 0)]); }

export class StringTable {
  constructor() { this.blob = [Buffer.from([0])]; this.length = 1; this.offsets = new Map(); }
  add(name) {
    if (name === "") return 0;
    if (this.offsets.has(name)) return this.offsets.get(name);
    const offset = this.length;
    const b = Buffer.concat([Buffer.from(name, "ascii"), Buffer.from([0])]);
    this.blob.push(b); this.length += b.length; this.offsets.set(name, offset);
    return offset;
  }
  bytes() { return Buffer.concat(this.blob); }
}

export function sectionSpec(name, content = Buffer.alloc(0), { type = SHT_PROGBITS, link = 0, info = 0, entsize = 0, addralign = 4 } = {}) {
  return { name, content: Buffer.from(content), type, link, info, entsize, addralign };
}

export function buildElf32be(sections) {
  const names = ["", ...sections.map((s) => s.name), ".shstrtab"];
  const shstr = [Buffer.from([0])];
  let shLen = 1;
  const nameOffsets = new Map([["", 0]]);
  for (const name of names.slice(1)) {
    if (nameOffsets.has(name)) continue;
    nameOffsets.set(name, shLen);
    const b = Buffer.concat([Buffer.from(name, "ascii"), Buffer.from([0])]);
    shstr.push(b); shLen += b.length;
  }
  const shstrtab = Buffer.concat(shstr);
  let offset = ELF_HEADER_SIZE;
  const bodies = sections.map((s) => { const o = offset; offset += s.content.length; return [s, o]; });
  const shstrtabOffset = offset;
  offset += shstrtab.length;
  const shoff = offset;
  const headerCount = 1 + sections.length + 1;
  const header = Buffer.alloc(ELF_HEADER_SIZE);
  Buffer.from([0x7f, 0x45, 0x4c, 0x46, 1, 2, 1]).copy(header, 0);
  header.writeUInt16BE(1, 16); header.writeUInt16BE(8, 18); header.writeUInt32BE(1, 20);
  header.writeUInt32BE(0, 24); header.writeUInt32BE(0, 28); header.writeUInt32BE(shoff, 32); header.writeUInt32BE(0, 36);
  header.writeUInt16BE(ELF_HEADER_SIZE, 40); header.writeUInt16BE(0, 42); header.writeUInt16BE(0, 44);
  header.writeUInt16BE(SECTION_HEADER_SIZE, 46); header.writeUInt16BE(headerCount, 48); header.writeUInt16BE(headerCount - 1, 50);
  const sh = (nameOff, type, shOffset, size, { link = 0, info = 0, addralign = 0, entsize = 0 } = {}) =>
    Buffer.concat([nameOff, type, 0, 0, shOffset, size, link, info, addralign, entsize].map(u32));
  const headers = [sh(0, SHT_NULL, 0, 0)];
  for (const [s, o] of bodies) headers.push(sh(nameOffsets.get(s.name), s.type, o, s.content.length, s));
  headers.push(sh(nameOffsets.get(".shstrtab"), SHT_STRTAB, shstrtabOffset, shstrtab.length));
  return Buffer.concat([header, ...bodies.map(([s]) => s.content), shstrtab, ...headers]);
}

export function poolSymbol(name, hi_offset, lo_offset, { opcode = OP_LWC1, base_register = REGISTER_AT } = {}) {
  return { name, hi_offset, lo_offset, opcode, base_register };
}

/** A synthetic target.o-shaped object for the truncation heuristic. */
export function buildTargetObject({ jump_table_words, rodata_extra_bytes, pool_symbols, include_decoy = false, include_symtab = true,
  rel_text_entsize = null, jump_table_start = 0, jump_table_stride = 4, stray_rodata_reloc_offsets = [] }) {
  let textSize = Math.max(0, ...pool_symbols.map((p) => p.lo_offset + 4));
  const decoyHi = textSize, decoyLo = textSize + 4;
  if (include_decoy) textSize += 8;
  textSize = Math.max(textSize, 4);
  textSize = (textSize + 3) & ~3;
  const text = Buffer.alloc(textSize);
  const place = (o, v) => text.writeUInt32BE(v >>> 0, o);
  for (const p of pool_symbols) { place(p.hi_offset, word(OP_LUI, 0, p.base_register, 0)); place(p.lo_offset, word(p.opcode, p.base_register, 8, 0)); }
  if (include_decoy) { place(decoyHi, word(OP_LUI, 0, 2, 0)); place(decoyLo, word(OP_LW, 2, 3, 0)); }
  const strtab = new StringTable();
  const textSymbolIndex = 1;
  const tableOffsets = Array.from({ length: jump_table_words }, (_, slot) => jump_table_start + slot * jump_table_stride);
  const tableEnd = tableOffsets.length ? tableOffsets.at(-1) + 4 : jump_table_start;
  const rodata = Buffer.alloc(tableEnd + rodata_extra_bytes);
  const indexByName = new Map();
  let next = textSymbolIndex + 1;
  for (const p of pool_symbols) if (!indexByName.has(p.name)) indexByName.set(p.name, next++);
  if (include_decoy) indexByName.set("D_decoy", next++);
  const relText = [];
  for (const p of pool_symbols) {
    const i = indexByName.get(p.name);
    relText.push(relEntry({ offset: p.hi_offset, sym_index: i, r_type: R_MIPS_HI16 }), relEntry({ offset: p.lo_offset, sym_index: i, r_type: R_MIPS_LO16 }));
  }
  if (include_decoy) {
    const i = indexByName.get("D_decoy");
    relText.push(relEntry({ offset: decoyHi, sym_index: i, r_type: R_MIPS_HI16 }), relEntry({ offset: decoyLo, sym_index: i, r_type: R_MIPS_LO16 }));
  }
  const TEXT_INDEX = 1, RODATA_INDEX = 3, SYMTAB_INDEX = 5, STRTAB_INDEX = 6;
  const relRodata = [...tableOffsets, ...stray_rodata_reloc_offsets].map((o) => relEntry({ offset: o, sym_index: textSymbolIndex, r_type: R_MIPS_32 }));
  const symbols = [symEntry({ name_offset: 0, info: 0, shndx: 0 }), symEntry({ name_offset: 0, info: symInfo(STB_LOCAL, STT_SECTION), shndx: TEXT_INDEX })];
  for (const p of pool_symbols) {
    if (indexByName.get(p.name) !== symbols.length) continue;
    symbols.push(symEntry({ name_offset: strtab.add(p.name), info: symInfo(STB_GLOBAL, STT_OBJECT), shndx: SHN_UNDEF }));
  }
  if (include_decoy && indexByName.get("D_decoy") === symbols.length) {
    symbols.push(symEntry({ name_offset: strtab.add("D_decoy"), info: symInfo(STB_GLOBAL, STT_OBJECT), shndx: SHN_UNDEF }));
  }
  const specs = [
    sectionSpec(".text", text),
    sectionSpec(".rel.text", Buffer.concat(relText), { type: SHT_REL, link: SYMTAB_INDEX, info: TEXT_INDEX, entsize: rel_text_entsize ?? 8 }),
    sectionSpec(".rodata", rodata),
    sectionSpec(".rel.rodata", Buffer.concat(relRodata), { type: SHT_REL, link: SYMTAB_INDEX, info: RODATA_INDEX, entsize: 8 }),
  ];
  if (include_symtab) {
    specs.push(sectionSpec(".symtab", Buffer.concat(symbols), { type: SHT_SYMTAB, link: STRTAB_INDEX, info: symbols.length, entsize: 16 }));
    specs.push(sectionSpec(".strtab", strtab.bytes(), { type: SHT_STRTAB }));
  }
  return buildElf32be(specs);
}
