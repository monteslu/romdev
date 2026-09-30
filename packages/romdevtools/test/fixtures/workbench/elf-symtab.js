// A big-endian ELF32 assembled byte by byte with exactly the sections and
// symbols named, so every field the symbol reader keys on is chosen by the
// test (an absolute symbol carrying an inherited size cannot be asked of a
// toolchain on demand). Port of the workbench's own build_elf helper.

/**
 * @param {Array<[string, number, number, number]>} sections [name, address, size, flags]
 * @param {Array<[string, number, number, number, number, number]>} symbols [name, value, size, type, binding, shndx]
 */
export function buildElf(sections, symbols, { encoding = 2, elf_class = 1, with_symtab = true } = {}) {
  const names = ["", ...sections.map((s) => s[0]), ".shstrtab", ".symtab", ".strtab"];
  const shstr = Buffer.from(names.join("\0") + "\0", "latin1");
  const offsets = new Map();
  let pos = 0;
  // Later duplicates overwrite earlier ones, as a plain name->offset map does.
  for (const n of names) { offsets.set(n, pos); pos += n.length + 1; }
  const symbolNames = ["", ...symbols.map((s) => s[0])];
  const strtab = Buffer.from(symbolNames.join("\0") + "\0", "latin1");
  const stringOffsets = new Map();
  pos = 0;
  for (const n of symbolNames) { if (!stringOffsets.has(n)) stringOffsets.set(n, pos); pos += n.length + 1; }
  const sym = (name, value, size, info, other, shndx) => {
    const b = Buffer.alloc(16);
    b.writeUInt32BE(name, 0); b.writeUInt32BE(value >>> 0, 4); b.writeUInt32BE(size >>> 0, 8); b[12] = info; b[13] = other; b.writeUInt16BE(shndx, 14);
    return b;
  };
  let symtab = sym(0, 0, 0, 0, 0, 0);
  for (const [name, value, size, kind, binding, shndx] of symbols) symtab = Buffer.concat([symtab, sym(stringOffsets.get(name), value, size, (binding << 4) | kind, 0, shndx)]);
  const headerSize = 52;
  const bodyOffset = headerSize;
  const shstrOffset = bodyOffset, strtabOffset = shstrOffset + shstr.length, symtabOffset = strtabOffset + strtab.length;
  const tableOffset = symtabOffset + symtab.length;
  const count = 1 + sections.length + 3;
  const shstrtabIndex = 1 + sections.length, symtabIndex = shstrtabIndex + 1, strtabIndex = symtabIndex + 1;
  const shdr = (...f) => { const b = Buffer.alloc(40); f.forEach((v, i) => b.writeUInt32BE(v >>> 0, i * 4)); return b; };
  const headers = [shdr(0, 0, 0, 0, 0, 0, 0, 0, 0, 0)];
  for (const [name, address, size, flags] of sections) headers.push(shdr(offsets.get(name), 1, flags, address, bodyOffset, size, 0, 0, 1, 0));
  headers.push(shdr(offsets.get(".shstrtab"), 3, 0, 0, shstrOffset, shstr.length, 0, 0, 1, 0));
  if (with_symtab) headers.push(shdr(offsets.get(".symtab"), 2, 0, 0, symtabOffset, symtab.length, strtabIndex, 0, 4, 16));
  else headers.push(shdr(offsets.get(".symtab"), 1, 0, 0, symtabOffset, 0, 0, 0, 1, 0));
  headers.push(shdr(offsets.get(".strtab"), 3, 0, 0, strtabOffset, strtab.length, 0, 0, 1, 0));
  const ident = Buffer.from([0x7f, 0x45, 0x4c, 0x46, elf_class, encoding, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const h = Buffer.alloc(36);
  let o = 0;
  const u16 = (v) => { h.writeUInt16BE(v, o); o += 2; }, u32 = (v) => { h.writeUInt32BE(v >>> 0, o); o += 4; };
  u16(2); u16(8); u32(1); u32(0); u32(0); u32(tableOffset); u32(0); u16(headerSize); u16(0); u16(0); u16(40); u16(count); u16(shstrtabIndex);
  return Buffer.concat([ident, h, shstr, strtab, symtab, ...headers]);
}
