// Tests for the elf32 port, on synthetic in-memory ELF32 MIPS objects.
import test from "node:test";
import assert from "node:assert/strict";

import { RABBITIZER_SKIP } from "./helpers/payload.mjs";

// Loading the port loads romdev-rabbitizer's WASM; without that payload every
// test here skips with the reason instead of the file failing to import.
const { configureVersion, common, elf32 } = RABBITIZER_SKIP ? {} : await import("../src/index.js");
const { Elf32File, Elf32HeaderFlag, Elf32SectionHeaderFlag, Elf32SectionHeaderType, Elf32ObjectFileType, Elf32Constants, Elf32Relocs } = elf32 ?? {};

const SHT = { NULL: 0, PROGBITS: 1, SYMTAB: 2, STRTAB: 3, NOBITS: 8, REL: 9, REGINFO: 0x70000006 };

/** Build a small relocatable MIPS ELF32 object. */
function buildElf({ little = false, flags = 0x20921001, gp = -0x7ff0 } = {}) {
  const u8 = [];
  const w = (n, size) => {
    for (let i = 0; i < size; i++) {
      const shift = little ? i * 8 : (size - 1 - i) * 8;
      u8.push(Number((BigInt.asUintN(64, BigInt(n)) >> BigInt(shift)) & 0xffn));
    }
  };
  const bytesAt = () => u8.length;
  const align = (a) => {
    while (u8.length % a) u8.push(0);
  };

  // placeholder header, filled at the end
  for (let i = 0; i < 0x34; i++) u8.push(0);

  const text = [0x27bdfff8, 0x0c000000, 0x00000000, 0x03e00008, 0x27bd0008];
  const textOff = bytesAt();
  for (const x of text) w(x, 4);

  const shstr = "\0.text\0.rel.text\0.symtab\0.strtab\0.shstrtab\0.reginfo\0.bss\0";
  const shName = (n) => shstr.indexOf(`\0${n}\0`) + 1;
  const shstrOff = bytesAt();
  for (const c of shstr) u8.push(c.charCodeAt(0));

  const str = "\0func_a\0data_b\0";
  const strOff = bytesAt();
  for (const c of str) u8.push(c.charCodeAt(0));
  align(4);

  // symtab: null, section .text, func_a (FUNC GLOBAL in .text), data_b (OBJECT LOCAL, UNDEF)
  const symOff = bytesAt();
  const sym = (name, value, size, info, other, shndx) => {
    w(name, 4);
    w(value, 4);
    w(size, 4);
    u8.push(info, other);
    w(shndx, 2);
  };
  sym(0, 0, 0, 0, 0, 0);
  sym(0, 0, 0, 0x03, 0, 1);
  sym(1, 0, 0x14, 0x12, 0, 1);
  sym(8, 0x10, 4, 0x01, 2, 0);
  const symSize = bytesAt() - symOff;

  // .rel.text: R_MIPS_26 against func_a at 4, R_MIPS_HI16 against data_b at 0
  const relOff = bytesAt();
  w(4, 4);
  w((2 << 8) | 4, 4);
  w(0, 4);
  w((3 << 8) | 5, 4);
  const relSize = bytesAt() - relOff;

  // .reginfo
  const regOff = bytesAt();
  w(0x800000f0, 4);
  for (const x of [1, 2, 3, 0xffffffff]) w(x, 4);
  w(gp, 4);

  align(4);
  const shoff = bytesAt();
  const sh = (name, type, fl, addr, off, size, link, info, al, ent) => {
    for (const x of [name, type, fl, addr, off, size, link, info, al, ent]) w(x, 4);
  };
  sh(0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
  sh(shName(".text"), SHT.PROGBITS, 0x6, 0, textOff, text.length * 4, 0, 0, 16, 0);
  sh(shName(".rel.text"), SHT.REL, 0x40, 0, relOff, relSize, 3, 1, 4, 8);
  sh(shName(".symtab"), SHT.SYMTAB, 0, 0, symOff, symSize, 4, 2, 4, 16);
  sh(shName(".strtab"), SHT.STRTAB, 0, 0, strOff, str.length, 0, 0, 1, 0);
  sh(shName(".shstrtab"), SHT.STRTAB, 0, 0, shstrOff, shstr.length, 0, 0, 1, 0);
  sh(shName(".reginfo"), SHT.REGINFO, 0x2, 0, regOff, 0x18, 0, 0, 4, 0x18);
  sh(shName(".bss"), SHT.NOBITS, 0x3, 0, regOff + 0x18, 0x40, 0, 0, 16, 0);
  const shnum = 8;

  // header
  const hdr = [];
  const hw = (n, size) => {
    for (let i = 0; i < size; i++) hdr.push((n >>> (little ? i * 8 : (size - 1 - i) * 8)) & 0xff);
  };
  hdr.push(0x7f, 0x45, 0x4c, 0x46, 1, little ? 1 : 2, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0);
  hw(1, 2); // REL
  hw(8, 2); // EM_MIPS
  hw(1, 4);
  hw(0, 4); // entry
  hw(0, 4); // phoff
  hw(shoff, 4);
  hw(flags, 4);
  hw(0x34, 2);
  hw(0, 2);
  hw(0, 2);
  hw(0x28, 2);
  hw(shnum, 2);
  hw(5, 2); // shstrndx
  for (let i = 0; i < 0x34; i++) u8[i] = hdr[i];
  return Uint8Array.from(u8);
}

function summarize(elf) {
  return {
    type: elf.header.type,
    machine: elf.header.machine,
    shnum: elf.header.shnum,
    names: elf.sectionHeaders.sections.map((s) => elf.shstrtab.get(s.name)),
    flags: elf.elfFlags.map((f) => f.name),
    unknown: elf.unknownElfFlags,
    syms: elf.symtab.symbols.map((s) => [elf.strtab.get(s.name), s.value, s.size, s.stBind, s.stType, s.other, s.shndx]),
    rels: [...elf.relPerName.get(".text")].map((r) => [r.offset, r.rSym, r.rType]),
    gp: elf.reginfo.gpValue,
    cpr: elf.reginfo.cprmask,
    exec: [...elf.progbitsExecute.keys()],
    nobits: [...elf.nobitsPerName.keys()],
  };
}

const EXPECTED = {
  type: 1,
  machine: 8,
  shnum: 8,
  names: ["", ".text", ".rel.text", ".symtab", ".strtab", ".shstrtab", ".reginfo", ".bss"],
  flags: ["NOREORDER", "O32", "_5900", "ARCH_3"],
  unknown: 0,
  syms: [
    ["", 0, 0, 0, 0, 0, 0],
    ["", 0, 0, 0, 3, 0, 1],
    ["func_a", 0, 0x14, 1, 2, 0, 1],
    ["data_b", 0x10, 4, 0, 1, 2, 0],
  ],
  rels: [
    [4, 2, 4],
    [0, 3, 5],
  ],
  gp: -0x7ff0,
  cpr: [1, 2, 3, 0xffffffff],
  exec: [".text"],
  nobits: [".bss"],
};

if (!RABBITIZER_SKIP) {
  test.beforeEach(() => configureVersion("1.42.4"));
  test.after(() => configureVersion("1.42.4"));
}

for (const little of [false, true]) {
  test(`parses a synthetic ${little ? "little" : "big"}-endian MIPS ELF32 object`, { skip: RABBITIZER_SKIP }, () => {
    const elf = new Elf32File(buildElf({ little }));
    assert.deepEqual(summarize(elf), EXPECTED);
    assert.equal(common.GlobalConfig.ENDIAN, little ? common.InputEndian.LITTLE : common.InputEndian.BIG);
    assert.equal(elf.header.type, Elf32ObjectFileType.REL.value);
    assert.equal(elf.sectionHeaders.mipsText, elf.sectionHeaders.sections[1]);
    assert.equal(elf.rel.get(common.FileSectionType.Text).sectionName, ".rel.text");
    assert.equal(Elf32Relocs.fromValue(elf.relPerName.get(".text").relocations[0].rType), Elf32Relocs.MIPS_26);
  });
}

test("names used by the splat PS2 elf reader exist with Python semantics", { skip: RABBITIZER_SKIP }, () => {
  const elf = new Elf32File(buildElf());
  assert.ok(elf.elfFlags.includes(Elf32Constants.Elf32HeaderFlag._5900));
  const [flags, unknown] = Elf32SectionHeaderFlag.parseFlags(elf.sectionHeaders.sections[7].flags);
  assert.deepEqual(flags, [Elf32SectionHeaderFlag.WRITE, Elf32SectionHeaderFlag.ALLOC]);
  assert.equal(unknown, 0);
  assert.equal(Elf32Constants.Elf32SectionHeaderType.fromValue(8), Elf32SectionHeaderType.NOBITS);
  assert.equal(Elf32Constants.Elf32SectionHeaderType.fromValue(0x12345), null);
  const sorted = [...elf.sectionHeaders].sort((a, b) => a.offset - b.offset);
  assert.equal(sorted.length, 8);
  // SHN special indices and out-of-range behaviour of Elf32SectionHeaders.__getitem__
  assert.equal(elf.sectionHeaders.get(0), null);
  assert.equal(elf.sectionHeaders.get(0xff01), elf.sectionHeaders.mipsText);
  assert.equal(elf.sectionHeaders.get(9), null);
  assert.throws(() => elf.sectionHeaders.get(8), /index out of range/);
  // Enum aliases resolve to the same member
  const { OsAbi } = Elf32Constants.Elf32HeaderIdentifier;
  assert.equal(OsAbi.SYSV, OsAbi.NONE);
  assert.equal(OsAbi.LINUX, OsAbi.GNU);
  assert.equal([...OsAbi].length, 14);
});

test("header flag parsing keeps unknown bits", { skip: RABBITIZER_SKIP }, () => {
  const [flags, unknown] = Elf32HeaderFlag.parseFlags(0x40000000 | 0x00ab0000 | 0x800 | 0x2);
  assert.deepEqual(flags.map((f) => f.name), ["PIC", "ARCH_5"]);
  assert.equal(unknown, 0x00ab0800);
  const [f2, u2] = Elf32HeaderFlag.parseFlags(0x90000000);
  assert.deepEqual(f2, []);
  assert.equal(u2, 0x90000000);
});

test("handleFlags version gates (ARCH_5 level, N64 ABI)", { skip: RABBITIZER_SKIP }, () => {
  const arch5 = buildElf({ flags: 0x40001000 });
  configureVersion("1.42.4");
  new Elf32File(arch5).handleFlags();
  assert.equal(common.GlobalConfig.ARCHLEVEL, common.ArchLevel.MIPS4);
  configureVersion("1.39.3");
  new Elf32File(arch5).handleFlags();
  assert.equal(common.GlobalConfig.ARCHLEVEL, common.ArchLevel.MIPS5);

  const n64 = buildElf({ flags: 0x20002020 });
  configureVersion("1.39.3");
  new Elf32File(n64).handleFlags();
  assert.equal(common.GlobalConfig.ABI, common.Abi.N64);
  configureVersion("1.35.0");
  new Elf32File(n64).handleFlags();
  assert.equal(common.GlobalConfig.ABI, common.Abi.N32);

  configureVersion("1.42.4");
  new Elf32File(buildElf({ flags: 0x00000006 })).handleFlags();
  assert.equal(common.GlobalConfig.PIC, true);
});

test("perturbing one byte changes the parse result", { skip: RABBITIZER_SKIP }, () => {
  const good = buildElf();
  const base = summarize(new Elf32File(good));
  assert.deepEqual(base, EXPECTED);

  // e_flags low byte: NOREORDER cleared
  const flagsByte = good.slice();
  flagsByte[0x27] ^= 0x01;
  assert.notDeepEqual(summarize(new Elf32File(flagsByte)), base);

  // a relocation info byte (rType of the first entry)
  const elf = new Elf32File(good);
  const relOff = elf.sectionHeaders.sections[2].offset;
  const relByte = good.slice();
  relByte[relOff + 7] = 6;
  assert.notDeepEqual(summarize(new Elf32File(relByte)), base);

  // magic and class bytes are rejected
  const magic = good.slice();
  magic[1] = 0x46;
  assert.throws(() => new Elf32File(magic), /wrong magic/);
  const cls = good.slice();
  cls[4] = 2;
  assert.throws(() => new Elf32File(cls), /Unsupported ELF file class/);
  const enc = good.slice();
  enc[5] = 0;
  assert.throws(() => new Elf32File(enc), /Unsupported ELF data encoding/);
});

test("string table iteration and readelf output", { skip: RABBITIZER_SKIP }, () => {
  const elf = new Elf32File(buildElf());
  assert.deepEqual([...elf.strtab], ["", "func_a", "data_b"]);
  const chunks = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (s) => {
    chunks.push(String(s));
    return true;
  };
  try {
    elf.readelf_sectionHeaders();
    elf.readelf_syms();
  } finally {
    process.stdout.write = orig;
  }
  const text = chunks.join("");
  assert.match(text, /\n {2}\[ 1\] \.text {14}PROGBITS {8}00000000 000034 000014 00 {2}AX {2}0 {2} 0 10\n/);
  assert.match(text, / {4}2: 00000000 {4}14 FUNC {4}GLOBAL DEFAULT {13}\.text func_a\n/);
  assert.match(text, / {4}3: 00000010 {5}4 OBJECT {2}LOCAL {2}HIDDEN {14}UNDEF data_b\n/);
});
