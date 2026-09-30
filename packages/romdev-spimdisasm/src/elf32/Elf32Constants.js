// SPDX-License-Identifier: MIT
// Port of spimdisasm/elf32/Elf32Constants.py

import { createEnum } from "../py/pyutils.js";
import { withAliases, enumFromValue } from "./_util.js";

// a.k.a. EI
const FileClass = createEnum("FileClass", [
  ["CLASSNONE", 0], // Invalid class
  ["CLASS32", 1], // 32-bit objects
  ["CLASS64", 2], // 64-bit objects
  ["CLASSNUM", 3],
]);

const DataEncoding = createEnum("DataEncoding", [
  ["DATANONE", 0], // Invalid data encoding
  ["DATA2LSB", 1], // 2's complement, little endian
  ["DATA2MSB", 2], // 2's complement, big endian
  ["DATANUM", 3],
]);

const OsAbi = withAliases(
  createEnum("OsAbi", [
    ["NONE", 0], // UNIX System V ABI
    ["HPUX", 1],
    ["NETBSD", 2],
    ["GNU", 3],
    ["SOLARIS", 6],
    ["AIX", 7],
    ["IRIX", 8],
    ["FREEBSD", 9],
    ["TRU64", 10],
    ["MODESTO", 11],
    ["OPENBSD", 12],
    ["ARM_AEABI", 64],
    ["ARM", 97],
    ["STANDALONE", 255],
  ]),
  { SYSV: "NONE", LINUX: "GNU" },
);

export const Elf32HeaderIdentifier = Object.freeze({ FileClass, DataEncoding, OsAbi });

// ET (object file type)
export const Elf32ObjectFileType = createEnum("Elf32ObjectFileType", [
  ["NONE", 0],
  ["REL", 1],
  ["EXEC", 2],
  ["DYN", 3],
  ["CORE", 4],
  ["NUM", 5],
]);

const HEADER_FLAG_ENTRIES = [
  ["NOREORDER", 0x00000001],
  ["PIC", 0x00000002],
  ["CPIC", 0x00000004],
  ["XGOT", 0x00000008],
  ["F_64BIT_WHIRL", 0x00000010],
  ["ABI2", 0x00000020],
  ["ABI_ON32", 0x00000040],
  ["_32BITSMODE", 0x00000100],
  ["FP64", 0x00000200],
  ["NAN2008", 0x00000400],
  // ABI
  ["O32", 0x00001000],
  ["O64", 0x00002000],
  ["EABI32", 0x00003000],
  ["EABI64", 0x00004000],
  // CPU
  ["CPU", 0x00ff0000],
  ["_3900", 0x00810000],
  ["_4010", 0x00820000],
  ["_4100", 0x00830000],
  ["_4650", 0x00850000],
  ["_4120", 0x00870000],
  ["_4111", 0x00880000],
  ["SB1", 0x008a0000],
  ["OCTEON", 0x008b0000],
  ["XLR", 0x008c0000],
  ["OCTEON2", 0x008d0000],
  ["OCTEON3", 0x008e0000],
  ["_5400", 0x00910000],
  ["_5900", 0x00920000],
  ["IAMR2", 0x00930000],
  ["_5500", 0x00980000],
  ["_9000", 0x00990000],
  ["LS2E", 0x00a00000],
  ["LS2F", 0x00a10000],
  ["GS464", 0x00a20000],
  ["GS464E", 0x00a30000],
  ["GS264E", 0x00a40000],
  // arch level
  ["ARCH", 0xf0000000],
  ["ARCH_1", 0x00000000],
  ["ARCH_2", 0x10000000],
  ["ARCH_3", 0x20000000],
  ["ARCH_4", 0x30000000],
  ["ARCH_5", 0x40000000],
  ["ARCH_32", 0x50000000],
  ["ARCH_64", 0x60000000],
  ["ARCH_32R2", 0x70000000],
  ["ARCH_64R2", 0x80000000],
];

const CPU_NAMES = ["_3900", "_4010", "_4100", "_4650", "_4120", "_4111", "SB1", "OCTEON", "XLR", "OCTEON2", "OCTEON3", "_5400", "_5900", "IAMR2", "_5500", "_9000", "LS2E", "LS2F", "GS464", "GS464E", "GS264E"];
const ARCH_NAMES = ["ARCH_1", "ARCH_2", "ARCH_3", "ARCH_4", "ARCH_5", "ARCH_32", "ARCH_64", "ARCH_32R2", "ARCH_64R2"];
const SIMPLE_FLAG_NAMES = ["NOREORDER", "PIC", "CPIC", "XGOT", "F_64BIT_WHIRL", "ABI2", "ABI_ON32", "_32BITSMODE", "FP64", "NAN2008", "O32", "O64", "EABI32", "EABI64"];

// Legal values for e_flags field of Elf32_Ehdr
export const Elf32HeaderFlag = createEnum("Elf32HeaderFlag", HEADER_FLAG_ENTRIES, {}, {
  /** Returns [parsedFlags, remainingUnknownFlags] */
  parseFlags(rawFlags) {
    rawFlags >>>= 0;
    const parsedFlags = [];

    for (const n of SIMPLE_FLAG_NAMES) {
      const flagEnum = Elf32HeaderFlag[n];
      if ((rawFlags & flagEnum.value) >>> 0) {
        parsedFlags.push(flagEnum);
        rawFlags = (rawFlags & ~flagEnum.value) >>> 0;
      }
    }

    const cpu = (rawFlags & Elf32HeaderFlag.CPU.value) >>> 0;
    rawFlags = (rawFlags & ~Elf32HeaderFlag.CPU.value) >>> 0;
    const cpuName = CPU_NAMES.find((n) => Elf32HeaderFlag[n].value === cpu);
    if (cpuName !== undefined) parsedFlags.push(Elf32HeaderFlag[cpuName]);
    else rawFlags = (rawFlags | cpu) >>> 0;

    const archLevel = (rawFlags & Elf32HeaderFlag.ARCH.value) >>> 0;
    rawFlags = (rawFlags & ~Elf32HeaderFlag.ARCH.value) >>> 0;
    const archName = ARCH_NAMES.find((n) => Elf32HeaderFlag[n].value === archLevel);
    if (archName !== undefined) parsedFlags.push(Elf32HeaderFlag[archName]);
    else rawFlags = (rawFlags | archLevel) >>> 0;

    return [parsedFlags, rawFlags];
  },
});

// a.k.a. SHT (section header type)
export const Elf32SectionHeaderType = createEnum(
  "Elf32SectionHeaderType",
  [
    ["NULL", 0],
    ["PROGBITS", 1],
    ["SYMTAB", 2],
    ["STRTAB", 3],
    ["RELA", 4],
    ["HASH", 5],
    ["DYNAMIC", 6],
    ["NOTE", 7],
    ["NOBITS", 8],
    ["REL", 9],
    ["DYNSYM", 11],
    ["MIPS_LIBLIST", 0x70000000],
    ["MIPS_MSYM", 0x70000001],
    ["MIPS_CONFLICT", 0x70000002],
    ["MIPS_GPTAB", 0x70000003],
    ["MIPS_DEBUG", 0x70000005],
    ["MIPS_REGINFO", 0x70000006],
    ["MIPS_OPTIONS", 0x7000000d],
    ["MIPS_SYMBOL_LIB", 0x70000020],
    ["MIPS_ABIFLAGS", 0x7000002a],
  ],
  {},
  {
    fromValue(value) {
      return enumFromValue(Elf32SectionHeaderType, value);
    },
  },
);

const SECTION_FLAG_NAMES = ["WRITE", "ALLOC", "EXECINSTR", "MERGE", "STRINGS", "INFO_LINK", "LINK_ORDER", "OS_NONCONFORMING", "GROUP", "TLS", "COMPRESSED", "EXCLUDE"];

// Values for section header, sh_flags field.
export const Elf32SectionHeaderFlag = createEnum(
  "Elf32SectionHeaderFlag",
  [
    ["WRITE", 0x00000001],
    ["ALLOC", 0x00000002],
    ["EXECINSTR", 0x00000004],
    ["MERGE", 0x00000010],
    ["STRINGS", 0x00000020],
    ["INFO_LINK", 0x00000040],
    ["LINK_ORDER", 0x00000080],
    ["OS_NONCONFORMING", 0x00000100],
    ["GROUP", 0x00000200],
    ["TLS", 0x00000400],
    ["COMPRESSED", 0x00000800],
    ["EXCLUDE", 0x80000000],
  ],
  {},
  {
    /** Returns [parsedFlags, remainingUnknownFlags] */
    parseFlags(rawFlags) {
      rawFlags >>>= 0;
      const parsedFlags = [];
      for (const n of SECTION_FLAG_NAMES) {
        const flagEnum = Elf32SectionHeaderFlag[n];
        if ((rawFlags & flagEnum.value) >>> 0) {
          parsedFlags.push(flagEnum);
          rawFlags = (rawFlags & ~flagEnum.value) >>> 0;
        }
      }
      return [parsedFlags, rawFlags];
    },
  },
);

// a.k.a. STT (symbol table type)
export const Elf32SymbolTableType = createEnum("Elf32SymbolTableType", [
  ["NOTYPE", 0],
  ["OBJECT", 1],
  ["FUNC", 2],
  ["SECTION", 3],
  ["FILE", 4],
  ["COMMON", 5],
  ["TLS", 6],
  ["NUM", 7],
]);

// a.k.a. STB (symbol table binding)
export const Elf32SymbolTableBinding = createEnum(
  "Elf32SymbolTableBinding",
  [
    ["LOCAL", 0],
    ["GLOBAL", 1],
    ["WEAK", 2],
    ["LOOS", 10],
    ["HIOS", 12],
    ["LOPROC", 13],
    ["HIPROC", 14],
  ],
  {},
  {
    fromValue(value) {
      return enumFromValue(Elf32SymbolTableBinding, value);
    },
  },
);

// Symbol visibility specification encoded in the st_other field.
export const Elf32SymbolVisibility = createEnum(
  "Elf32SymbolVisibility",
  [
    ["DEFAULT", 0],
    ["INTERNAL", 1],
    ["HIDDEN", 2],
    ["PROTECTED", 3],
    ["PLT", 8],
    ["SC_ALIGN_UNUSED", 0xff],
  ],
  {},
  {
    fromValue(value) {
      return enumFromValue(Elf32SymbolVisibility, value);
    },
  },
);

// a.k.a. SHN (section header number)
export const Elf32SectionHeaderNumber = createEnum(
  "Elf32SectionHeaderNumber",
  [
    ["UNDEF", 0],
    ["ABS", 0xfff1],
    ["COMMON", 0xfff2],
    ["MIPS_ACOMMON", 0xff00],
    ["MIPS_TEXT", 0xff01],
    ["MIPS_DATA", 0xff02],
    ["MIPS_SCOMMON", 0xff03],
    ["MIPS_SUNDEFINED", 0xff04],
  ],
  {},
  {
    fromValue(value) {
      return enumFromValue(Elf32SectionHeaderNumber, value);
    },
  },
);

// a.k.a. DT
export const Elf32DynamicTable = createEnum("Elf32DynamicTable", [
  ["NULL", 0], // Marks end of dynamic section
  ["PLTGOT", 3], // Processor defined value
  ["MIPS_LOCAL_GOTNO", 0x7000000a], // Number of local GOT entries
  ["MIPS_SYMTABNO", 0x70000011], // Number of DYNSYM entries
  ["MIPS_GOTSYM", 0x70000013], // First GOT entry in DYNSYM
]);
