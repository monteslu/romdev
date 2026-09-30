// A minimal ELF32 object writer for line-probe fixtures: one NULL section,
// one PROGBITS `.text`, one SYMTAB `.symtab` and its two string tables.
// Synthetic and redistributable; ported from the workbench's test fixture.

function cstrTable(names) {
  const parts = [Buffer.from([0])];
  const offsets = new Map();
  let size = 1;
  for (const n of names) { offsets.set(n, size); const b = Buffer.from(n + "\0", "utf8"); parts.push(b); size += b.length; }
  return [Buffer.concat(parts), offsets];
}

/** A relocatable ELF32 object with `.text` and STT_FUNC `symbols` ([name, value, size]). */
export function buildElf32(textBytes, symbols = [], { bigEndian = true } = {}) {
  const u32 = (v) => { const b = Buffer.alloc(4); bigEndian ? b.writeUInt32BE(v >>> 0) : b.writeUInt32LE(v >>> 0); return b; };
  const u16 = (v) => { const b = Buffer.alloc(2); bigEndian ? b.writeUInt16BE(v) : b.writeUInt16LE(v); return b; };
  const [shstrtab, shstrOff] = cstrTable([".text", ".symtab", ".strtab", ".shstrtab"]);
  const [strtab, strOff] = cstrTable(symbols.map(([n]) => n));
  const text = Buffer.from(textBytes);
  const headerSize = 52, textOff = headerSize;
  const entries = [[0, 0, 0, 0, 0], ...symbols.map(([n, v, s]) => [strOff.get(n), v, s, (1 << 4) | 2, 1])];
  const symtab = Buffer.concat(entries.map(([name, value, size, info, shndx]) => Buffer.concat([u32(name), u32(value), u32(size), Buffer.from([info, 0]), u16(shndx)])));
  const symtabOff = textOff + text.length, strtabOff = symtabOff + symtab.length, shstrtabOff = strtabOff + strtab.length, shoff = shstrtabOff + shstrtab.length;
  const sections = [
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    [shstrOff.get(".text"), 1, 0x6, 0, textOff, text.length, 0, 0, 4, 0],
    [shstrOff.get(".symtab"), 2, 0, 0, symtabOff, symtab.length, 3, 1, 4, 16],
    [shstrOff.get(".strtab"), 3, 0, 0, strtabOff, strtab.length, 0, 0, 1, 0],
    [shstrOff.get(".shstrtab"), 3, 0, 0, shstrtabOff, shstrtab.length, 0, 0, 1, 0],
  ];
  const sectionBlob = Buffer.concat(sections.map((e) => Buffer.concat(e.map(u32))));
  const ident = Buffer.concat([Buffer.from("\x7fELF", "latin1"), Buffer.from([1, bigEndian ? 2 : 1, 1]), Buffer.alloc(9)]);
  const header = Buffer.concat([ident, u16(1), u16(8), u32(1), u32(0), u32(0), u32(shoff), u32(0), u16(headerSize), u16(0), u16(0), u16(40), u16(sections.length), u16(4)]);
  return Buffer.concat([header, text, symtab, strtab, shstrtab, sectionBlob]);
}
