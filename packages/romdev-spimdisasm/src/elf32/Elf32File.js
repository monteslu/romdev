// SPDX-License-Identifier: MIT
// Port of spimdisasm/elf32/Elf32File.py

import { GlobalConfig, InputEndian, Abi, ArchLevel } from "../common/GlobalConfig.js";
import { FileSectionType } from "../common/FileSectionType.js";
import { RelocType } from "../common/Relocation.js";
import * as Utils from "../common/Utils.js";
import { hexU } from "../py/pyutils.js";
import { atLeast } from "../version.js";
import {
  Elf32HeaderIdentifier,
  Elf32ObjectFileType,
  Elf32HeaderFlag,
  Elf32SectionHeaderType,
  Elf32SectionHeaderFlag,
  Elf32SymbolTableType,
  Elf32SymbolTableBinding,
  Elf32SymbolVisibility,
  Elf32SectionHeaderNumber,
} from "./Elf32Constants.js";
import { Elf32Dyns } from "./Elf32Dyns.js";
import { Elf32GlobalOffsetTable } from "./Elf32GlobalOffsetTable.js";
import { Elf32Header } from "./Elf32Header.js";
import { Elf32RegInfo } from "./Elf32RegInfo.js";
import { Elf32SectionHeaders } from "./Elf32SectionHeaders.js";
import { Elf32StringTable } from "./Elf32StringTable.js";
import { Elf32Syms } from "./Elf32Syms.js";
import { Elf32Rels } from "./Elf32Rels.js";
import { enumCall, enumRepr } from "./_util.js";

function out(s = "", end = "\n") {
  process.stdout.write(s + end);
}

const ljust = (s, w) => String(s).padEnd(w);
const rjust = (s, w) => String(s).padStart(w);

/** Python format spec "> <w>X": right aligned, space sign, uppercase hex. */
function spaceSignHex(n, w) {
  return (" " + hexU(n)).padStart(w);
}

/** Python str.isprintable() for a single code point in 0..255 */
function isPrintableLatin1(c) {
  if (c < 0x20) return false;
  if (c >= 0x7f && c <= 0xa0) return false;
  if (c === 0xad) return false;
  return true;
}

function pyFlagList(flags) {
  return `[${flags.map(enumRepr).join(", ")}]`;
}

export class Elf32File {
  constructor(array_of_bytes) {
    this.header = Elf32Header.fromBytearray(array_of_bytes);

    const dataEncoding = this.header.ident.getDataEncoding();
    if (dataEncoding === Elf32HeaderIdentifier.DataEncoding.DATA2MSB) GlobalConfig.ENDIAN = InputEndian.BIG;
    else if (dataEncoding === Elf32HeaderIdentifier.DataEncoding.DATA2LSB) GlobalConfig.ENDIAN = InputEndian.LITTLE;

    const [elfFlags, unknownElfFlags] = Elf32HeaderFlag.parseFlags(this.header.flags);
    this.elfFlags = elfFlags;
    this.unknownElfFlags = unknownElfFlags;

    this.strtab = null;
    this.symtab = null;

    this.dynamic = null;
    this.dynstr = null;
    this.dynsym = null;

    /** @deprecated Map<FileSectionType, Elf32SectionHeaderEntry> */
    this.progbits = new Map();
    /** @deprecated */
    this.nobits = null;

    /** @deprecated */
    this.progbitsSmall = new Map();
    /** @deprecated */
    this.nobitsSmall = null;

    /** @deprecated Map<FileSectionType, Elf32Rels> */
    this.rel = new Map();

    this.progbitsExecute = new Map();
    this.progbitsWrite = new Map();
    this.progbitsNoWrite = new Map();

    this.nobitsPerName = new Map();

    this.smallSections = new Map();

    this.relPerName = new Map();

    this.reginfo = null;

    this.sectionHeaders = new Elf32SectionHeaders(array_of_bytes, this.header.shoff, this.header.shnum);

    const shstrtabSectionEntry = this.sectionHeaders.sections.at(this.header.shstrndx);
    if (shstrtabSectionEntry === undefined) throw Object.assign(new Error("list index out of range"), { name: "IndexError" });
    this.shstrtab = new Elf32StringTable(array_of_bytes, shstrtabSectionEntry.offset, shstrtabSectionEntry.size);

    this.got = null;

    for (const entry of this.sectionHeaders.sections) {
      const sectionEntryName = this.shstrtab.get(entry.name);

      const callback = Elf32File._sectionProcessorCallbacks.get(entry.type);
      if (callback !== undefined) callback.call(this, array_of_bytes, entry, sectionEntryName);
      else if (GlobalConfig.VERBOSE) Utils.eprint("Unknown section header type found:", sectionEntryName, entry, "\n");
    }

    if (this.got !== null && this.dynamic !== null && this.dynsym !== null) this.got.initTables(this.dynamic, this.dynsym);
  }

  handleHeaderIdent() {
    if (this.header.ident.getVersion() !== 1) {
      Utils.eprint(`Warning: Elf version '${this.header.ident.getVersion()}' when version '1' was expected.`);
    }
  }

  handleFlags() {
    const has = (f) => this.elfFlags.includes(f);
    const warnUnhandled = (name) => {
      Utils.eprint(`Warning: Elf with ${name} flag.`);
      Utils.eprint("\t This flag is currently not handled in any way, please report this");
    };

    if (this.unknownElfFlags !== 0) Utils.eprint(`Warning: Elf header has unknown flags: 0x${hexU(this.unknownElfFlags)}`);

    if (has(Elf32HeaderFlag.PIC) || has(Elf32HeaderFlag.CPIC)) GlobalConfig.PIC = true;

    if (has(Elf32HeaderFlag.XGOT)) warnUnhandled("XGOT");
    if (has(Elf32HeaderFlag.F_64BIT_WHIRL)) warnUnhandled("F_64BIT_WHIRL");
    if (has(Elf32HeaderFlag.ABI_ON32)) warnUnhandled("ABI_ON32");
    if (has(Elf32HeaderFlag._32BITSMODE)) warnUnhandled("32BITSMODE");
    if (has(Elf32HeaderFlag.FP64)) warnUnhandled("FP64");
    if (has(Elf32HeaderFlag.NAN2008)) warnUnhandled("NAN2008");

    if (has(Elf32HeaderFlag.ABI2) && has(Elf32HeaderFlag.O64)) {
      Utils.eprint("Warning: Elf compiled using N64 ABI. Support is in experimental state");
      // spimdisasm 1.35.x set N32 here
      GlobalConfig.ABI = atLeast("1.39.0") ? Abi.N64 : Abi.N32;
    } else if (has(Elf32HeaderFlag.ABI2)) {
      Utils.eprint("Warning: Elf compiled using N32 ABI. Support is in experimental state");
      GlobalConfig.ABI = Abi.N32;
    } else if (has(Elf32HeaderFlag.O64)) {
      Utils.eprint("Warning: Elf compiled using O64 ABI. Support is in experimental state");
      GlobalConfig.ABI = Abi.O64;
    }

    if (has(Elf32HeaderFlag.EABI32)) {
      Utils.eprint("Warning: Elf compiled using EABI32 ABI. Support is in experimental state");
      GlobalConfig.ABI = Abi.EABI32;
    }

    if (has(Elf32HeaderFlag.EABI64)) {
      Utils.eprint("Warning: Elf compiled using EABI64 ABI. Support is in experimental state");
      GlobalConfig.ABI = Abi.EABI64;
    }

    // Python builds this from a set intersection; the name order follows set
    // iteration, which for these few enum members is not reproducible without
    // their object hashes. Only the warning text depends on it.
    const unkArchLevel = [Elf32HeaderFlag.ARCH_5, Elf32HeaderFlag.ARCH_32, Elf32HeaderFlag.ARCH_64, Elf32HeaderFlag.ARCH_32R2, Elf32HeaderFlag.ARCH_64R2].filter(has);
    if (unkArchLevel.length > 0) {
      const unkArchLevelNames = `[${unkArchLevel.map((x) => `'${x.name}'`).join(", ")}]`;
      Utils.eprint(`Warning: Elf uses not supported architecture level: ${unkArchLevelNames}`);
      Utils.eprint("\t This means this elf probably uses an unknown instruction set");
    }

    if (has(Elf32HeaderFlag.ARCH_1)) GlobalConfig.ARCHLEVEL = ArchLevel.MIPS1;
    else if (has(Elf32HeaderFlag.ARCH_2)) GlobalConfig.ARCHLEVEL = ArchLevel.MIPS2;
    else if (has(Elf32HeaderFlag.ARCH_3)) GlobalConfig.ARCHLEVEL = ArchLevel.MIPS3;
    else if (has(Elf32HeaderFlag.ARCH_4)) GlobalConfig.ARCHLEVEL = ArchLevel.MIPS4;
    else if (has(Elf32HeaderFlag.ARCH_5)) {
      // spimdisasm 1.42.x maps ARCH_5 to MIPS4 (earlier releases used MIPS5)
      GlobalConfig.ARCHLEVEL = atLeast("1.42.0") ? ArchLevel.MIPS4 : ArchLevel.MIPS5;
    } else if (has(Elf32HeaderFlag.ARCH_32)) GlobalConfig.ARCHLEVEL = ArchLevel.MIPS32;
    else if (has(Elf32HeaderFlag.ARCH_64)) GlobalConfig.ARCHLEVEL = ArchLevel.MIPS64;
    else if (has(Elf32HeaderFlag.ARCH_32R2)) GlobalConfig.ARCHLEVEL = ArchLevel.MIPS32R2;
    else if (has(Elf32HeaderFlag.ARCH_64R2)) GlobalConfig.ARCHLEVEL = ArchLevel.MIPS64R2;
  }

  _processSection_NULL(_array_of_bytes, _entry, _sectionEntryName) {}

  _processSection_PROGBITS(array_of_bytes, entry, sectionEntryName) {
    const fileSecType = FileSectionType.fromStr(sectionEntryName);
    const smallFileSecType = FileSectionType.fromSmallStr(sectionEntryName);
    const [flags, unknownFlags] = Elf32SectionHeaderFlag.parseFlags(entry.flags);

    if (fileSecType !== FileSectionType.Invalid) {
      this.progbits.set(fileSecType, entry);
      if (fileSecType === FileSectionType.Text) this.sectionHeaders.mipsText = entry;
      else if (fileSecType === FileSectionType.Data) this.sectionHeaders.mipsData = entry;
    } else if (smallFileSecType !== FileSectionType.Invalid) {
      this.progbitsSmall.set(smallFileSecType, entry);
    } else if (sectionEntryName === ".got") {
      this.got = new Elf32GlobalOffsetTable(array_of_bytes, entry.offset, entry.size);
    } else if (sectionEntryName === ".interp" || sectionEntryName === ".MIPS.stubs" || sectionEntryName === ".init") {
      Utils.printVerbose(`Unhandled PROGBITS found: '${sectionEntryName}'`);
    } else if (GlobalConfig.VERBOSE) {
      Utils.eprint(`Unhandled PROGBITS found: '${sectionEntryName}'`, entry, "\n");
    }

    if (smallFileSecType !== FileSectionType.Invalid) this.smallSections.set(sectionEntryName, entry);

    if (sectionEntryName === ".got") {
      this.got = new Elf32GlobalOffsetTable(array_of_bytes, entry.offset, entry.size);
    } else if (flags.includes(Elf32SectionHeaderFlag.EXECINSTR) && sectionEntryName !== ".vutext") {
      this.progbitsExecute.set(sectionEntryName, entry);
    } else if (sectionEntryName === ".rodata" || sectionEntryName === ".rdata") {
      // Some compilers set the Write flag on .rodata sections
      this.progbitsNoWrite.set(sectionEntryName, entry);
    } else if (flags.includes(Elf32SectionHeaderFlag.WRITE)) {
      this.progbitsWrite.set(sectionEntryName, entry);
    } else if (flags.includes(Elf32SectionHeaderFlag.ALLOC)) {
      this.progbitsNoWrite.set(sectionEntryName, entry);
    } else if (flags.includes(Elf32SectionHeaderFlag.STRINGS)) {
      this.progbitsNoWrite.set(sectionEntryName, entry);
    } else if (sectionEntryName === ".comment") {
      // Usually strings specifying the compiler used to build
    } else if (sectionEntryName === ".pdr") {
      // Debugging section
    } else if (!GlobalConfig.QUIET) {
      Utils.eprint(`Unhandled PROGBITS found: '${sectionEntryName}', flags: ${pyFlagList(flags)}, unknownFlags: ${unknownFlags}\n`);
    }
  }

  _processSection_SYMTAB(array_of_bytes, entry, sectionEntryName) {
    if (sectionEntryName === ".symtab") this.symtab = new Elf32Syms(array_of_bytes, entry.offset, entry.size);
    else if (GlobalConfig.VERBOSE) Utils.eprint("Unhandled SYMTAB found: ", sectionEntryName, entry, "\n");
  }

  _processSection_STRTAB(array_of_bytes, entry, sectionEntryName) {
    if (sectionEntryName === ".strtab") this.strtab = new Elf32StringTable(array_of_bytes, entry.offset, entry.size);
    else if (sectionEntryName === ".dynstr") this.dynstr = new Elf32StringTable(array_of_bytes, entry.offset, entry.size);
    else if (sectionEntryName === ".shstrtab") {
      // nothing
    } else if (GlobalConfig.VERBOSE) Utils.eprint("Unhandled STRTAB found: ", sectionEntryName, entry, "\n");
  }

  _processSection_RELA(_array_of_bytes, _entry, _sectionEntryName) {}

  _processSection_HASH(_array_of_bytes, _entry, _sectionEntryName) {}

  _processSection_DYNAMIC(array_of_bytes, entry, sectionEntryName) {
    if (sectionEntryName === ".dynamic") this.dynamic = new Elf32Dyns(array_of_bytes, entry.offset, entry.size);
    else if (GlobalConfig.VERBOSE) Utils.eprint("Unhandled DYNAMIC found: ", sectionEntryName, entry, "\n");
  }

  _processSection_NOTE(_array_of_bytes, _entry, _sectionEntryName) {}

  _processSection_NOBITS(array_of_bytes, entry, sectionEntryName) {
    if (sectionEntryName === ".bss") this.nobits = entry;
    // Upstream uses `if` here (not elif), so .bss also reaches the verbose branch.
    if (sectionEntryName === ".sbss") this.nobitsSmall = entry;
    else if (GlobalConfig.VERBOSE) Utils.eprint("Unhandled NOBITS found: ", sectionEntryName, entry, "\n");

    const smallFileSecType = FileSectionType.fromSmallStr(sectionEntryName);
    if (smallFileSecType !== FileSectionType.Invalid) this.smallSections.set(sectionEntryName, entry);

    this.nobitsPerName.set(sectionEntryName, entry);
  }

  _processSection_REL(array_of_bytes, entry, sectionEntryName) {
    const sectName = sectionEntryName.slice(4);

    if (sectionEntryName.startsWith(".rel")) {
      const fileSecType = FileSectionType.fromStr(sectName);
      if (fileSecType !== FileSectionType.Invalid) this.rel.set(fileSecType, new Elf32Rels(sectionEntryName, array_of_bytes, entry.offset, entry.size));
      else if (GlobalConfig.VERBOSE) Utils.eprint("Unhandled REL subsection found: ", sectionEntryName, entry, "\n");
    } else if (GlobalConfig.VERBOSE) {
      Utils.eprint("Unhandled REL found: ", sectionEntryName, entry, "\n");
    }

    if (sectionEntryName.startsWith(".rel")) this.relPerName.set(sectName, new Elf32Rels(sectionEntryName, array_of_bytes, entry.offset, entry.size));
    else Utils.eprint("Unhandled REL found: ", sectionEntryName, entry, "\n");
  }

  _processSection_DYNSYM(array_of_bytes, entry, sectionEntryName) {
    if (sectionEntryName === ".dynsym") this.dynsym = new Elf32Syms(array_of_bytes, entry.offset, entry.size);
    else if (GlobalConfig.VERBOSE) Utils.eprint("Unhandled DYNSYM found: ", sectionEntryName, entry, "\n");
  }

  _processSection_MIPS_LIBLIST(_array_of_bytes, _entry, _sectionEntryName) {}
  _processSection_MIPS_MSYM(_array_of_bytes, _entry, _sectionEntryName) {}
  _processSection_MIPS_CONFLICT(_array_of_bytes, _entry, _sectionEntryName) {}
  _processSection_MIPS_GPTAB(_array_of_bytes, _entry, _sectionEntryName) {}
  _processSection_MIPS_DEBUG(_array_of_bytes, _entry, _sectionEntryName) {}

  _processSection_MIPS_REGINFO(array_of_bytes, entry, sectionEntryName) {
    if (sectionEntryName === ".reginfo") this.reginfo = Elf32RegInfo.fromBytearray(array_of_bytes, entry.offset);
    else if (GlobalConfig.VERBOSE) Utils.eprint("Unhandled MIPS_REGINFO found: ", sectionEntryName, entry, "\n");
  }

  _processSection_MIPS_OPTIONS(_array_of_bytes, _entry, _sectionEntryName) {}
  _processSection_MIPS_SYMBOL_LIB(_array_of_bytes, _entry, _sectionEntryName) {}
  _processSection_MIPS_ABIFLAGS(_array_of_bytes, _entry, _sectionEntryName) {}

  static _sectionProcessorCallbacks = new Map([
    [Elf32SectionHeaderType.NULL.value, Elf32File.prototype._processSection_NULL],
    [Elf32SectionHeaderType.PROGBITS.value, Elf32File.prototype._processSection_PROGBITS],
    [Elf32SectionHeaderType.SYMTAB.value, Elf32File.prototype._processSection_SYMTAB],
    [Elf32SectionHeaderType.STRTAB.value, Elf32File.prototype._processSection_STRTAB],
    [Elf32SectionHeaderType.HASH.value, Elf32File.prototype._processSection_HASH],
    [Elf32SectionHeaderType.DYNAMIC.value, Elf32File.prototype._processSection_DYNAMIC],
    [Elf32SectionHeaderType.NOBITS.value, Elf32File.prototype._processSection_NOBITS],
    [Elf32SectionHeaderType.REL.value, Elf32File.prototype._processSection_REL],
    [Elf32SectionHeaderType.DYNSYM.value, Elf32File.prototype._processSection_DYNSYM],
    [Elf32SectionHeaderType.MIPS_LIBLIST.value, Elf32File.prototype._processSection_MIPS_LIBLIST],
    [Elf32SectionHeaderType.MIPS_MSYM.value, Elf32File.prototype._processSection_MIPS_MSYM],
    [Elf32SectionHeaderType.MIPS_CONFLICT.value, Elf32File.prototype._processSection_MIPS_CONFLICT],
    [Elf32SectionHeaderType.MIPS_GPTAB.value, Elf32File.prototype._processSection_MIPS_GPTAB],
    [Elf32SectionHeaderType.MIPS_DEBUG.value, Elf32File.prototype._processSection_MIPS_DEBUG],
    [Elf32SectionHeaderType.MIPS_REGINFO.value, Elf32File.prototype._processSection_MIPS_REGINFO],
    [Elf32SectionHeaderType.MIPS_OPTIONS.value, Elf32File.prototype._processSection_MIPS_OPTIONS],
    [Elf32SectionHeaderType.MIPS_SYMBOL_LIB.value, Elf32File.prototype._processSection_MIPS_SYMBOL_LIB],
    [Elf32SectionHeaderType.MIPS_ABIFLAGS.value, Elf32File.prototype._processSection_MIPS_ABIFLAGS],
  ]);

  readelf_fileHeader() {
    out("ELF Header:");
    out("  Magic:  ", "");
    for (const magic of this.header.ident.ident) out(` ${hexU(magic, 2)}`, "");
    out("\n          ", "");
    for (const magic of this.header.ident.ident) {
      let character = String.fromCharCode(magic);
      if (!isPrintableLatin1(magic)) character = hexU(magic, 2);
      out(` ${rjust(character, 2)}`, "");
    }
    out();

    out(`  ${ljust("Class:", 34)} ${this.header.ident.getFileClass().name.replace("CLASS", "ELF")}`);

    out(`  ${ljust("Data:", 34)} `, "");
    const dataEncoding = this.header.ident.getDataEncoding();
    if (dataEncoding === Elf32HeaderIdentifier.DataEncoding.DATANONE) out("Invalid data encoding");
    else if (dataEncoding === Elf32HeaderIdentifier.DataEncoding.DATA2LSB) out("2's complement, little endian");
    else if (dataEncoding === Elf32HeaderIdentifier.DataEncoding.DATA2MSB) out("2's complement, big endian");
    else out(dataEncoding.name);

    out(`  ${ljust("Version:", 34)} `, "");
    const version = this.header.ident.getVersion();
    out(`${version}` + (version === 1 ? " (current)" : ""));

    out(`  ${ljust("OS/ABI:", 34)} `, "");
    const osAbi = this.header.ident.getOsAbi();
    if (osAbi === Elf32HeaderIdentifier.OsAbi.NONE) out("UNIX - System V");
    else if (osAbi === Elf32HeaderIdentifier.OsAbi.IRIX) out("SGI Irix");
    else out(osAbi.name);

    out(`  ${ljust("ABI Version:", 34)} ${this.header.ident.getAbiVersion()}`);

    out(`  ${ljust("Type:", 34)} `, "");
    const filetype = Elf32ObjectFileType.fromValueOrNull(this.header.type);
    if (filetype !== null) {
      out(`${filetype.name}`, "");
      if (filetype === Elf32ObjectFileType.NONE) out(" (No file type)");
      else if (filetype === Elf32ObjectFileType.REL) out(" (Relocatable file)");
      else if (filetype === Elf32ObjectFileType.EXEC) out(" (Executable file)");
      else if (filetype === Elf32ObjectFileType.DYN) out(" (Shared object file)");
      else if (filetype === Elf32ObjectFileType.CORE) out(" (Core file)");
      else out(" (Unknown)");
    } else {
      out(`0x${hexU(this.header.type, 4)}`, "");
      if (this.header.type >= 0xfe00 && this.header.type <= 0xfeff) out(" (OS-specific)");
      if (this.header.type >= 0xff00 && this.header.type <= 0xffff) out(" (Processor-specific)");
      else out(" (Unknown)");
    }

    out(`  ${ljust("Machine:", 34)} ${this.header.machine}`);
    out(`  ${ljust("Version:", 34)} 0x${hexU(this.header.version)}`);
    out(`  ${ljust("Entry point address:", 34)} 0x${hexU(this.header.entry, 8)}`);
    out(`  ${ljust("Start of program headers:", 34)} 0x${hexU(this.header.phoff)} (bytes into file)`);
    out(`  ${ljust("Start of section headers:", 34)} 0x${hexU(this.header.shoff)} (bytes into file)`);

    out(`  ${ljust("Flags:", 34)} 0x${hexU(this.header.flags)}`, "");
    for (const flag of this.elfFlags) {
      let printableFlagName = flag.name.toLowerCase().replaceAll("arch_", "mips");
      if (printableFlagName.length > 0 && printableFlagName[0] === "_") printableFlagName = printableFlagName.slice(1);
      out(`, ${printableFlagName}`, "");
    }
    if (this.unknownElfFlags !== 0) out(`, 0x${hexU(this.unknownElfFlags, 8)}`, "");
    out();

    out(`  ${ljust("Size of this header:", 34)} 0x${hexU(this.header.ehsize)} (bytes)`);
    out(`  ${ljust("Size of program headers:", 34)} 0x${hexU(this.header.phentsize)} (bytes)`);
    out(`  ${ljust("Number of program headers:", 34)} ${this.header.phnum}`);
    out(`  ${ljust("Size of section headers:", 34)} 0x${hexU(this.header.shentsize)} (bytes)`);
    out(`  ${ljust("Number of section headers:", 34)} ${this.header.shnum}`);
    out(`  ${ljust("Section header string table index:", 34)} ${this.header.shstrndx}`);
    out();
  }

  readelf_sectionHeaders() {
    const flagsKeys = new Map([
      [Elf32SectionHeaderFlag.WRITE, "W"],
      [Elf32SectionHeaderFlag.ALLOC, "A"],
      [Elf32SectionHeaderFlag.EXECINSTR, "X"],
      [Elf32SectionHeaderFlag.MERGE, "M"],
      [Elf32SectionHeaderFlag.STRINGS, "S"],
      [Elf32SectionHeaderFlag.INFO_LINK, "I"],
      [Elf32SectionHeaderFlag.LINK_ORDER, "L"],
      [Elf32SectionHeaderFlag.OS_NONCONFORMING, "O"],
      [Elf32SectionHeaderFlag.GROUP, "G"],
      [Elf32SectionHeaderFlag.TLS, "T"],
      [Elf32SectionHeaderFlag.COMPRESSED, "C"],
      [Elf32SectionHeaderFlag.EXCLUDE, "E"],
    ]);

    out(`There are ${this.sectionHeaders.length} section headers, starting at offset 0x${hexU(this.sectionHeaders.shoff)}:`);
    out();
    out("Section Headers:");

    let largestSectionHeaderName = 17;
    for (const header of this.sectionHeaders) {
      const name = this.shstrtab.get(header.name);
      largestSectionHeaderName = Math.max(largestSectionHeaderName, name.length);
    }

    out(`  [${rjust("Nr", 2)}] ${ljust("Name", largestSectionHeaderName)}  ${ljust("Type", 15)} ${ljust("Addr", 8)} ${ljust("Off", 6)} ${ljust("Size", 6)} ES Flg Lk Inf Al`);

    let i = 0;
    for (const header of this.sectionHeaders) {
      const name = this.shstrtab.get(header.name);

      const headerType = Elf32SectionHeaderType.fromValue(header.type);
      let headerTypeStr = `<0x${hexU(header.type)}>`;
      if (headerType !== null) headerTypeStr = headerType.name;

      let [flags, unknownFlags] = Elf32SectionHeaderFlag.parseFlags(header.flags);
      let flagsStr = "";
      for (const flag of flags) flagsStr += flagsKeys.get(flag);

      if ((unknownFlags & 0x0ff00000) >>> 0) flagsStr += "o";
      unknownFlags = (unknownFlags & ~0x0ff00000) >>> 0;
      if ((unknownFlags & 0xf0000000) >>> 0) flagsStr += "p";
      unknownFlags = (unknownFlags & ~0xf0000000) >>> 0;

      out(
        `  [${rjust(i, 2)}] ${ljust(name, largestSectionHeaderName)}  ${ljust(headerTypeStr, 15)} ${hexU(header.addr, 8)} ${hexU(header.offset, 6)} ${hexU(header.size, 6)} ${hexU(header.entsize, 2)} ${rjust(flagsStr, 3)} ${spaceSignHex(header.link, 2)} ${spaceSignHex(header.info, 3)} ${rjust(hexU(header.addralign), 2)}`,
      );
      if (unknownFlags) out(`Warning unknown flags: 0x${hexU(unknownFlags)}`);
      i++;
    }

    out("Key to Flags:");
    out("  W (write), A (alloc), X (execute), M (merge), S (strings), I (info),");
    out("  L (link order), O (extra OS processing required), G (group), T (TLS),");
    out("  C (compressed), x (unknown), o (OS specific), E (exclude),");
    out("  D (mbind), p (processor specific)");
    out();
  }

  _readelf_symbol_table(symbolTable, stringTable) {
    let symbolTableName = "";
    for (const header of this.sectionHeaders) {
      if (header.offset === symbolTable.offset) symbolTableName = this.shstrtab.get(header.name);
    }

    out(`Symbol table '${symbolTableName}' contains ${symbolTable.symbols.length} entries:`);
    out(` ${rjust("Num", 5)}: ${rjust("Value", 8)} ${rjust("Size", 5)} ${ljust("Type", 7)} ${ljust("Bind", 6)} ${ljust("Vis", 9)} ${rjust("Ndx", 15)} Name`);

    symbolTable.symbols.forEach((sym, i) => {
      const entryType = enumCall(Elf32SymbolTableType, sym.stType);

      let bind = String(sym.stBind);
      const stBind = Elf32SymbolTableBinding.fromValue(sym.stBind);
      if (stBind !== null) bind = stBind.name;

      let visibility = `0x${hexU(sym.other)}`;
      const stOther = Elf32SymbolVisibility.fromValue(sym.other);
      if (stOther !== null) visibility = stOther.name;

      let ndx = `0x${hexU(sym.shndx)}`;
      const shndx = Elf32SectionHeaderNumber.fromValue(sym.shndx);
      if (shndx !== null) {
        ndx = shndx.name;
      } else if (entryType === Elf32SymbolTableType.OBJECT || entryType === Elf32SymbolTableType.FUNC) {
        // spimdisasm-extension: instead of a number we use the section name if available
        const section = this.sectionHeaders.get(sym.shndx);
        if (section !== null) ndx = this.shstrtab.get(section.name);
      }

      let symName = "";
      if (stringTable !== null) symName = stringTable.get(sym.name);
      if (symName === "") {
        if (entryType === Elf32SymbolTableType.SECTION) {
          const section = this.sectionHeaders.get(sym.shndx);
          if (section !== null) symName = this.shstrtab.get(section.name);
        }
      }

      out(` ${rjust(i, 5)}: ${hexU(sym.value, 8)} ${rjust(hexU(sym.size), 5)} ${ljust(entryType.name, 7)} ${ljust(bind, 6)} ${ljust(visibility, 9)} ${rjust(ndx, 15)} ${symName}`);
    });

    out();
  }

  readelf_syms() {
    if (this.symtab === null) return;
    this._readelf_symbol_table(this.symtab, this.strtab);
  }

  readelf_dyn_syms() {
    if (this.dynsym === null) return;
    this._readelf_symbol_table(this.dynsym, this.dynstr);
  }

  readelf_relocs() {
    for (const relSection of this.rel.values()) {
      out(`Relocation section '${relSection.sectionName}' at offset 0x${hexU(relSection.offset)} contains ${relSection.relocations.length} entries:`);
      out(` ${ljust("Offset", 8)} ${ljust("Info", 8)} ${ljust("Type", 12)} ${rjust("Sym.Value", 9)} Sym.Name`);
      let sym;
      for (const rel of relSection.relocations) {
        let relType = String(rel.rType);
        const rType = RelocType.fromValue(rel.rType);
        if (rType !== null) relType = rType.name;

        let symValue = "";
        let symName = "";
        if (this.symtab !== null) {
          sym = this.symtab.get(rel.rSym);
          symValue = hexU(sym.value, 8);
          if (this.strtab !== null) symName = this.strtab.get(sym.name);
        }
        if (symName === "") {
          if (sym === undefined) throw Object.assign(new Error("cannot access local variable 'sym' where it is not associated with a value"), { name: "UnboundLocalError" });
          const section = this.sectionHeaders.get(sym.shndx);
          if (section !== null) symName = this.shstrtab.get(section.name);
        }

        out(` ${hexU(rel.offset, 8)} ${hexU(rel.info, 8)} ${ljust(relType, 12)} ${rjust(symValue, 9)} ${symName}`);
      }
      out();
    }
    out();
  }

  readelf_displayGot() {
    const accessStrOf = (access) => (access < 0 ? `-0x${hexU(-access)}` : `0x${hexU(access)}`);

    out("Primary GOT:");
    let gpValue = 0x7ff0;
    let entryAddress = 0;
    if (this.dynamic !== null && this.dynamic.pltGot !== null) {
      gpValue = this.dynamic.getGpValue() || 0;
      if (GlobalConfig.GP_VALUE !== null) gpValue = GlobalConfig.GP_VALUE;
      entryAddress = this.dynamic.pltGot;
      out(` Canonical gp value: ${hexU(gpValue)}`);
      out();
    }

    if (this.got !== null) {
      out(" Reserved entries:");
      out(`   Address ${rjust("Access", 12)}  Initial Purpose`);
      if (this.got.localsTable.length === 0) throw Object.assign(new Error("list index out of range"), { name: "IndexError" });
      out(`  ${rjust(hexU(entryAddress), 8)} ${ljust(accessStrOf(entryAddress - gpValue), 5)}($gp) ${hexU(this.got.localsTable[0], 8)} Lazy resolver`);
      entryAddress += 4;
      out();

      out(" Local entries:");
      out(`   Address ${rjust("Access", 12)}  Initial`);
      for (const x of this.got.localsTable.slice(1)) {
        out(`  ${rjust(hexU(entryAddress), 8)} ${ljust(accessStrOf(entryAddress - gpValue), 5)}($gp) ${hexU(x, 8)}`);
        entryAddress += 4;
      }
      out();

      out(" Global entries:");
      out(`  ${rjust("Address", 8)} ${rjust("Access", 12)}  Initial Sym.Val. Type    ${ljust("Ndx", 12)} Name`);
      for (const gotEntry of this.got.globalsTable) {
        const entryType = enumCall(Elf32SymbolTableType, gotEntry.symEntry.stType);
        let ndx = `0x${hexU(gotEntry.symEntry.shndx)}`;
        const shndx = Elf32SectionHeaderNumber.fromValue(gotEntry.symEntry.shndx);
        if (shndx !== null) ndx = shndx.name;
        let symName = "";
        if (this.dynstr !== null) symName = this.dynstr.get(gotEntry.symEntry.name);
        out(`  ${rjust(hexU(entryAddress), 8)} ${ljust(accessStrOf(entryAddress - gpValue), 5)}($gp) ${hexU(gotEntry.getAddress(), 8)} ${hexU(gotEntry.symEntry.value, 8)} ${ljust(entryType.name, 7)} ${ljust(ndx, 12)} ${symName}`);
        entryAddress += 4;
      }
      out();
    }
    out();
  }
}
