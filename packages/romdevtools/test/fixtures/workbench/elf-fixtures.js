// Minimal ELF32 big-endian object builders for the workbench ELF-reading
// tests. Hand-rolled on purpose: the tests must not need a MIPS toolchain.
// The bytes are synthetic.

export const ELF_HEADER_SIZE = 52, SECTION_HEADER_SIZE = 40;
export const STT_NOTYPE = 0, STT_FUNC = 2, STB_LOCAL = 0, STB_GLOBAL = 1;
export const SHT_REL = 9, SHN_UNDEF = 0, R_MIPS_32 = 2, R_MIPS_26 = 4, R_MIPS_HI16 = 5, R_MIPS_LO16 = 6;

export function pack(fmt, ...vals) {
  const sizes = { I: 4, H: 2, B: 1 };
  const buf = Buffer.alloc([...fmt].reduce((n, c) => n + sizes[c], 0));
  let o = 0;
  [...fmt].forEach((c, i) => { if (c === "I") buf.writeUInt32BE(vals[i] >>> 0, o); else if (c === "H") buf.writeUInt16BE(vals[i], o); else buf.writeUInt8(vals[i], o); o += sizes[c]; });
  return buf;
}

const ident = () => Buffer.from([0x7f, 0x45, 0x4c, 0x46, 1, 2, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
const elfHeader = (shoff, shnum, shstrndx) => Buffer.concat([ident(), pack("HHIIIIIHHHHHH", 1, 8, 1, 0, 0, shoff, 0, ELF_HEADER_SIZE, 0, 0, SECTION_HEADER_SIZE, shnum, shstrndx)]);

/** An object whose every caller section is SHT_PROGBITS, plus .shstrtab. */
export function buildElf32be(sections) {
  const entries = sections instanceof Map ? [...sections] : Object.entries(sections);
  const names = ["", ...entries.map(([n]) => n), ".shstrtab"];
  const shstrtab = Buffer.from(names.join("\0") + "\0", "ascii");
  const nameOff = new Map();
  let cursor = 0;
  for (const n of names) { if (!nameOff.has(n)) nameOff.set(n, cursor); cursor += n.length + 1; }
  let offset = ELF_HEADER_SIZE;
  const bodies = entries.map(([n, c]) => { const r = [n, c, offset]; offset += c.length; return r; });
  const shstrOff = offset; offset += shstrtab.length;
  const shoff = offset;
  const count = 1 + entries.length + 1;
  const sh = (no, t, so, ss) => pack("IIIIIIIIII", no, t, 0, 0, so, ss, 0, 0, 0, 0);
  const headers = [sh(0, 0, 0, 0), ...bodies.map(([n, c, o]) => sh(nameOff.get(n), 1, o, c.length)), sh(nameOff.get(".shstrtab"), 3, shstrOff, shstrtab.length)];
  return Buffer.concat([elfHeader(shoff, count, count - 1), ...bodies.map((b) => b[1]), shstrtab, ...headers]);
}

/** Big-endian 32-bit words. */
export function words(...values) { return Buffer.concat(values.map((v) => pack("I", v))); }

/** One code section and a symtab of [name, value, size, kind, binding]. */
export function buildObject({ text, symbols, section = ".text" }) {
  const ordered = [...symbols].map((s, i) => [s, i]).sort((a, b) => (a[0][4] !== STB_LOCAL) - (b[0][4] !== STB_LOCAL) || a[1] - b[1]).map((p) => p[0]);
  const firstGlobal = ordered.filter((s) => s[4] === STB_LOCAL).length + 1;
  let strtab = Buffer.from([0]);
  const nameOff = new Map();
  for (const [name] of ordered) if (!nameOff.has(name)) { nameOff.set(name, strtab.length); strtab = Buffer.concat([strtab, Buffer.from(name + "\0", "ascii")]); }
  const secNames = ["", section, ".symtab", ".strtab", ".shstrtab"];
  const shstrtab = Buffer.from(secNames.join("\0") + "\0", "ascii");
  const so = new Map(); let c = 0; for (const n of secNames) { so.set(n, c); c += n.length + 1; }
  const symtab = Buffer.concat([pack("IIIBBH", 0, 0, 0, 0, 0, 0), ...ordered.map(([n, v, s, k, b]) => pack("IIIBBH", nameOff.get(n), v, s, (b << 4) | k, 0, 1))]);
  let off = ELF_HEADER_SIZE;
  const textOff = off; off += text.length;
  const symOff = off; off += symtab.length;
  const strOff = off; off += strtab.length;
  const shOff = off; off += shstrtab.length;
  const hdr = (no, t, f, o, s, link = 0, info = 0, ent = 0) => pack("IIIIIIIIII", no, t, f, 0, o, s, link, info, 4, ent);
  const headers = [pack("IIIIIIIIII", 0, 0, 0, 0, 0, 0, 0, 0, 0, 0), hdr(so.get(section), 1, 6, textOff, text.length),
    hdr(so.get(".symtab"), 2, 0, symOff, symtab.length, 3, firstGlobal, 16), hdr(so.get(".strtab"), 3, 0, strOff, strtab.length),
    hdr(so.get(".shstrtab"), 3, 0, shOff, shstrtab.length)];
  return Buffer.concat([elfHeader(off, 5, 4), text, symtab, strtab, shstrtab, ...headers]);
}

/**
 * Sections, symbols {name, value, size, kind, binding, section|null} and
 * relocations {section, offset, symbol, type}.
 */
export function buildRelocatable(sections, symbols = [], relocations = []) {
  const content = sections instanceof Map ? [...sections] : Object.entries(sections);
  const sectionIndex = new Map(content.map(([n], i) => [n, 1 + i]));
  const symtabIndex = 1 + content.length, strtabIndex = symtabIndex + 1;
  const relSections = content.map(([n]) => n).filter((n) => relocations.some((r) => r.section === n));
  const S = symbols.map((s) => ({ value: 0, size: 0, kind: STT_NOTYPE, binding: STB_GLOBAL, section: null, ...s }));
  const ordered = S.map((s, i) => [s, i]).sort((a, b) => (a[0].binding !== STB_LOCAL) - (b[0].binding !== STB_LOCAL) || a[1] - b[1]).map((p) => p[0]);
  const firstGlobal = ordered.filter((s) => s.binding === STB_LOCAL).length + 1;
  const symbolIndex = new Map(ordered.map((s, i) => [s.name, 1 + i]));
  let strtab = Buffer.from([0]);
  const nameOff = new Map();
  for (const s of ordered) if (!nameOff.has(s.name)) { nameOff.set(s.name, strtab.length); strtab = Buffer.concat([strtab, Buffer.from(s.name + "\0", "ascii")]); }
  const symtab = Buffer.concat([pack("IIIBBH", 0, 0, 0, 0, 0, 0), ...ordered.map((s) => pack("IIIBBH", nameOff.get(s.name), s.value, s.size, (s.binding << 4) | s.kind, 0, s.section === null ? SHN_UNDEF : sectionIndex.get(s.section)))]);
  const relBodies = new Map(relSections.map((n) => [n, []]));
  for (const r of relocations) relBodies.get(r.section).push(pack("II", r.offset, (symbolIndex.get(r.symbol) << 8) | r.type));
  const names = ["", ...content.map(([n]) => n), ".symtab", ".strtab", ...relSections.map((n) => `.rel${n}`), ".shstrtab"];
  let shstrtab = Buffer.from([0]);
  const so = new Map([["", 0]]);
  for (const n of names.slice(1)) { if (so.has(n)) continue; so.set(n, shstrtab.length); shstrtab = Buffer.concat([shstrtab, Buffer.from(n + "\0", "ascii")]); }
  let cursor = ELF_HEADER_SIZE;
  const offsets = content.map(([, b]) => { const o = cursor; cursor += b.length; return o; });
  const symOff = cursor; cursor += symtab.length;
  const strOff = cursor; cursor += strtab.length;
  const relOffsets = new Map();
  for (const n of relSections) { relOffsets.set(n, cursor); cursor += Buffer.concat(relBodies.get(n)).length; }
  const shstrOff = cursor; cursor += shstrtab.length;
  const hdr = (no, t, o, s, { flags = 0, link = 0, info = 0, entsize = 0 } = {}) => pack("IIIIIIIIII", no, t, flags, 0, o, s, link, info, 4, entsize);
  const headers = [Buffer.alloc(40), ...content.map(([n, b], i) => hdr(so.get(n), 1, offsets[i], b.length, { flags: 6 })),
    hdr(so.get(".symtab"), 2, symOff, symtab.length, { link: strtabIndex, info: firstGlobal, entsize: 16 }),
    hdr(so.get(".strtab"), 3, strOff, strtab.length),
    ...relSections.map((n) => hdr(so.get(`.rel${n}`), SHT_REL, relOffsets.get(n), Buffer.concat(relBodies.get(n)).length, { link: symtabIndex, info: sectionIndex.get(n), entsize: 8 })),
    hdr(so.get(".shstrtab"), 3, shstrOff, shstrtab.length)];
  return Buffer.concat([elfHeader(cursor, names.length, names.length - 1), ...content.map(([, b]) => b), symtab, strtab,
    ...relSections.map((n) => Buffer.concat(relBodies.get(n))), shstrtab, ...headers]);
}
