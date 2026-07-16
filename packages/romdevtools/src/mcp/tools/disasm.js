// Disassembly MCP tools — exposed as `disassemble` and `disassembleRom`.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import nodePath from "node:path";
import { jsonContent, safeTool, writeOutput } from "../util.js";
import { parseSymbols, buildSymbolMap } from "../../toolchains/common/symbols.js";
import { registersForPlatform } from "../../platforms/common/registers.js";
import { findReferencesCore } from "./find-references.js";
import { analyzeCfg, analyzeXrefs, analyzeFunctions, analyzeDecompile } from "../../analysis/analyze.js";
import { recompileNesToSnes, sliceFirstRoutine } from "../../analysis/recompile-65816.js";
import { decodePointerTable, reverseLookup } from "../../analysis/pointer-table.js";

/** cfg/xrefs/functions all operate on a ROM file. Reuse the `path` arg. */
function requireRomPath(args) {
  if (!args.path) throw new Error(`disasm target='${args.target}' requires \`path\` (the ROM file).`);
  return args.path;
}

/**
 * CPU address → file offset for a platform's ROM image, dispatching to the
 * per-platform mapper. Returns the offset or null (out of range / unmapped /
 * unsupported platform). The single home for "where in the file is CPU address
 * X" — used by file-offset annotation AND target=pointerTable.
 * @param {string} platform
 * @param {Uint8Array} data   full ROM image
 * @param {number} cpuAddr
 * @param {{bank?:number, snesMapper?:number}} [opts]
 */
function cpuAddrToFileOffset(platform, data, cpuAddr, opts = {}) {
  try {
    switch (platform) {
      case "snes": return mapSnesAddress(data, cpuAddr, 1, opts.snesMapper).fileOffset;
      case "sms": case "gg": return mapSmsAddress(data, cpuAddr, 1).fileOffset;
      case "gb": case "gbc": return mapGbAddress(data, cpuAddr, 1, opts.bank).fileOffset;
      case "atari2600": return mapAtari2600Address(data, cpuAddr, 1, opts.bank ?? 0).fileOffset;
      case "atari7800": return mapAtari7800Address(data, cpuAddr, 1, opts.bank ?? 0).fileOffset;
      case "c64": return mapC64Address(data, cpuAddr, 1, opts.bank ?? 0).fileOffset;
      case "genesis": case "megadrive": case "md": return mapGenesisAddress(data, cpuAddr, 1).fileOffset;
      case "nes": return mapNesAddress(data, cpuAddr, 1, opts.bank).fileOffset;
      default: return null; // msx/pce/lynx/gba: no static address mapper here
    }
  } catch {
    return null;
  }
}

/** Platforms target=pointerTable can map a CPU address for (has a mapper above).
 *  Their default jump-table word order: 6502/Z80/65816 are little-endian; the
 *  m68k (Genesis) stores words BIG-endian, so a Genesis `dc.w` table is BE. */
const POINTER_TABLE_PLATFORMS = new Set([
  "nes", "snes", "sms", "gg", "gb", "gbc", "atari2600", "atari7800", "c64", "genesis", "megadrive", "md",
]);
const BIG_ENDIAN_TABLE_PLATFORMS = new Set(["genesis", "megadrive", "md"]);

// ── Per-platform CPU-address → file-offset mappers ────────────────
// Each returns { bytes, fileOffset, cpu, notes } given the full ROM
// bytes and a desired CPU address. Throws with a clear message if the
// address can't be mapped (e.g. outside ROM, bank not present).

/**
 * NES iNES file. PRG-ROM starts at file offset 16; CPU $8000-$FFFF
 * maps into the last 32 KB of PRG (16KB carts mirror $8000 ↔ $C000).
 * Returns the slice starting at the requested CPU address.
 */
export function mapNesAddress(data, cpuAddr, length, bank) {
  if (data[0] !== 0x4e || data[1] !== 0x45 || data[2] !== 0x53 || data[3] !== 0x1a) {
    throw new Error("not a valid iNES file (missing NES\\x1a magic at offset 0)");
  }
  const prgBanks = data[4];
  const prgSize = prgBanks * 16384;
  const prgFileStart = 16;
  const num16kBanks = prgSize >> 14; // 16KB banks
  // Mapper number = high nibble of flags6 + high nibble of flags7.
  const mapperNum = ((data[6] >> 4) & 0xF) | (data[7] & 0xF0);
  // For NROM (mapper 0): 16KB → mirrored at $8000 + $C000; 32KB → linear $8000-$FFFF.
  // For mapper>0 the topmost bank is fixed at $C000-$FFFF (UxROM, MMC1 final
  // bank, MMC3 last two banks all do this); other banks are switchable.
  //
  // `bank` (when given) explicitly selects which 16KB PRG bank is mapped into
  // the SWITCHABLE slot ($8000-$BFFF). This is the fix for "disassemble UxROM
  // bank N at $8000" — previously impossible without slicing the ROM by hand.
  // A $C000+ address still resolves to the fixed top bank regardless of `bank`.
  let offsetInPrg;
  let mapperLabel;
  if (bank != null && mapperNum !== 0 && prgSize > 16384) {
    if (bank < 0 || bank >= num16kBanks) {
      throw new Error(`NES bank ${bank} out of range (ROM has ${num16kBanks} × 16KB PRG banks, 0-${num16kBanks - 1})`);
    }
    if (cpuAddr >= 0xC000) {
      // Fixed top bank — `bank` doesn't apply here.
      offsetInPrg = (prgSize - 0x4000) + (cpuAddr - 0xC000);
      mapperLabel = `mapper ${mapperNum} (fixed top bank at $C000; bank arg ignored above $C000)`;
    } else if (cpuAddr >= 0x8000) {
      offsetInPrg = bank * 0x4000 + (cpuAddr - 0x8000);
      mapperLabel = `mapper ${mapperNum} (PRG bank ${bank} mapped at $8000)`;
    } else {
      offsetInPrg = -1;
      mapperLabel = `mapper ${mapperNum}`;
    }
  } else if (prgSize === 16384) {
    // NROM-128 — mirror.
    offsetInPrg = cpuAddr & 0x3FFF;
    mapperLabel = `mapper ${mapperNum} (NROM-128 mirror)`;
  } else if (mapperNum === 0) {
    offsetInPrg = cpuAddr - 0x8000;
    mapperLabel = `mapper 0 (NROM-256)`;
  } else {
    // Banked mapper: top 16KB fixed at $C000, bank 0 at $8000 by default.
    if (cpuAddr >= 0xC000) {
      offsetInPrg = (prgSize - 0x4000) + (cpuAddr - 0xC000);
    } else if (cpuAddr >= 0x8000) {
      offsetInPrg = cpuAddr - 0x8000;
    } else {
      offsetInPrg = -1;
    }
    mapperLabel = `mapper ${mapperNum} (top bank fixed at $C000, bank 0 at $8000 — pass bank:N for a different switchable bank)`;
  }
  if (offsetInPrg < 0 || offsetInPrg >= prgSize) {
    throw new Error(`CPU address $${cpuAddr.toString(16)} outside PRG ROM (${prgSize} bytes, ${mapperLabel})`);
  }
  const fileOffset = prgFileStart + offsetInPrg;
  const slice = data.slice(fileOffset, fileOffset + length);
  return {
    bytes: slice,
    fileOffset,
    cpu: "6502",
    note: `${mapperLabel}, PRG ${prgSize >> 10} KB`,
    mapperNum,
    prgSize,
    prgFileStart,
  };
}

/**
 * SNES LoROM / HiROM file. Handles optional 512-byte SMC copier header,
 * picks LoROM vs HiROM by checking the internal header at $7FC0 or $FFC0.
 *
 * Mapping (no SA-1 / ExHiROM support yet — those are rare for the kind
 * of homebrew agents we care about):
 *   LoROM: bank $80-$FF mirrors $00-$7F. Address $XX:8000-$XX:FFFF →
 *          file offset = (bank & 0x7F) * 0x8000 + (addr & 0x7FFF) + copier_off
 *   HiROM: address $XX:0000-$XX:FFFF (banks $C0-$FF and $40-$7F) →
 *          file offset = (bank & 0x3F) * 0x10000 + (addr & 0xFFFF) + copier_off
 */
export function mapSnesAddress(data, cpuAddr, length, mapperHint) {
  // Strip optional 512B copier header (SMC files have it; SFC files don't).
  const copierOff = (data.length % 0x8000 === 0x200) ? 0x200 : 0;

  let isLo, mapper;
  if (mapperHint === "lorom") {
    isLo = true;
    mapper = "LoROM (user-specified)";
  } else if (mapperHint === "hirom") {
    isLo = false;
    mapper = "HiROM (user-specified)";
  } else {
    // Detect mapper: check internal header at LoROM ($7FC0) vs HiROM ($FFC0)
    // by looking at the mapper byte at offset $15 in the header. Valid
    // mapper bytes: $20 (LoROM), $21 (HiROM), $30 (FastROM LoROM), $31 (FastROM HiROM).
    const loMapperByte = data[copierOff + 0x7FC0 + 0x15];
    const hiMapperByte = data[copierOff + 0xFFC0 + 0x15];
    const detectedLo = loMapperByte === 0x20 || loMapperByte === 0x30 || loMapperByte === 0x32;
    const detectedHi = hiMapperByte === 0x21 || hiMapperByte === 0x31;
    if (!detectedLo && !detectedHi) {
      // No valid header — small homebrew often doesn't ship one. Default
      // to LoROM (most common for small carts; HiROM is unusual at <256KB).
      isLo = true;
      mapper = "LoROM (assumed — no valid header found)";
    } else {
      isLo = detectedLo;
      mapper = isLo ? "LoROM" : "HiROM";
    }
  }

  // Decompose CPU address into bank + offset-within-bank.
  const bank = (cpuAddr >>> 16) & 0xFF;
  const bankAddr = cpuAddr & 0xFFFF;

  let fileOffset;
  if (isLo) {
    // LoROM: only $8000-$FFFF inside a bank holds ROM data; bank $80-$FF mirrors $00-$7F.
    if (bankAddr < 0x8000) {
      throw new Error(`LoROM: CPU offset $${bankAddr.toString(16)} inside bank is RAM/IO; ROM data is at $8000-$FFFF`);
    }
    fileOffset = copierOff + ((bank & 0x7F) * 0x8000) + (bankAddr - 0x8000);
  } else {
    // HiROM: full 64KB banks; bank $C0+ is mirrors of $40+.
    fileOffset = copierOff + ((bank & 0x3F) * 0x10000) + bankAddr;
  }

  if (fileOffset < 0 || fileOffset >= data.length) {
    throw new Error(`${mapper}: CPU address $${cpuAddr.toString(16).padStart(6,"0")} → file offset 0x${fileOffset.toString(16)} outside ROM (${data.length} bytes)`);
  }
  const slice = data.slice(fileOffset, fileOffset + length);
  return {
    bytes: slice,
    fileOffset,
    cpu: "65816",
    note: `${mapper}${copierOff ? " (512B copier header stripped)" : ""}, ${data.length >> 10} KB`,
  };
}

/**
 * Walk a da65-format asm string and prepend `label:` to lines whose
 * leading "$XXXX" address matches a symbol. Loose pattern match — works
 * with da65's default `<addr>  <bytes>  <mnem>` columnar output.
 */
function annotateDisasmWithSymbols(asm, symbolMap) {
  const lines = asm.split(/\r?\n/);
  const out = [];
  for (const line of lines) {
    const m = line.match(/^([0-9A-Fa-f]{4,6}):?\s/);
    if (m) {
      const addr = parseInt(m[1], 16);
      const syms = symbolMap.at(addr);
      if (syms.length > 0) {
        out.push(syms.map((s) => `; ${s.name}:`).join("\n"));
      }
    }
    out.push(line);
  }
  return out.join("\n");
}

/**
 * Read N-byte little-endian word from a buffer. Used for vector tables.
 */
function readLEWord(data, offset, byteCount) {
  let v = 0;
  for (let i = 0; i < byteCount; i++) v |= data[offset + i] << (i * 8);
  return v >>> 0;
}

/**
 * Read the iNES vector table at PRG-end - 6 bytes. Returns { nmi, reset,
 * irq } as CPU addresses. Returns null if the file isn't iNES.
 */
function nesVectors(data) {
  if (data[0] !== 0x4e || data[1] !== 0x45 || data[2] !== 0x53 || data[3] !== 0x1a) return null;
  const prgSize = data[4] * 16384;
  const vecOff = 16 + prgSize - 6;
  return {
    nmi: readLEWord(data, vecOff, 2),
    reset: readLEWord(data, vecOff + 2, 2),
    irq: readLEWord(data, vecOff + 4, 2),
  };
}

/**
 * SNES native + emulation vectors. The internal header at $7FE4 / $FFE4
 * (LoROM / HiROM) holds the native vectors; $7FF4 / $FFF4 the emulation
 * vectors. Picks the right base from the mapping byte at $15.
 */
function snesVectors(data) {
  const copierOff = (data.length % 0x8000 === 0x200) ? 0x200 : 0;
  const hiMapper = data[copierOff + 0xFFC0 + 0x15];
  const isLo = !(hiMapper === 0x21 || hiMapper === 0x31);
  const headerBase = copierOff + (isLo ? 0x7FC0 : 0xFFC0);
  // Native vectors (cop, brk, abort, nmi, reset, irq) at header+$24..
  return {
    native_cop:   readLEWord(data, headerBase + 0x24, 2),
    native_brk:   readLEWord(data, headerBase + 0x26, 2),
    native_abort: readLEWord(data, headerBase + 0x28, 2),
    native_nmi:   readLEWord(data, headerBase + 0x2A, 2),
    native_reset: readLEWord(data, headerBase + 0x2C, 2),
    native_irq:   readLEWord(data, headerBase + 0x2E, 2),
    emu_cop:      readLEWord(data, headerBase + 0x34, 2),
    emu_abort:    readLEWord(data, headerBase + 0x38, 2),
    emu_nmi:      readLEWord(data, headerBase + 0x3A, 2),
    emu_reset:    readLEWord(data, headerBase + 0x3C, 2),
    emu_irqbrk:   readLEWord(data, headerBase + 0x3E, 2),
  };
}

/**
 * da65 with `--comments 4` emits lines like:
 *   `        lda     #$05                            ; 8000 A9 05`
 * with the CPU address in the trailing comment. Extract it.
 *
 * Returns the integer address, or null if the line has no address comment.
 */
function extractInstructionAddress(line) {
  // The trailing comment has form `; <4-6 hex> <bytes...>`. Anchor on
  // the *last* `;` in case the line has multiple.
  const m = line.match(/;\s+([0-9A-Fa-f]{4,6})\s+(?:[0-9A-Fa-f]{2}\b)/);
  return m ? parseInt(m[1], 16) : null;
}

/**
 * Annotate asm output with hardware register names. Matches operand patterns
 * like `$NNNN` and `$XX:NNNN` in the source column and appends a register
 * name to the trailing comment (or creates one).
 */
function annotateRegisters(asm, registers) {
  if (!registers) return asm;
  return asm.split(/\r?\n/).map((line) => {
    if (line.startsWith(";")) return line;
    // Split into source + existing-comment. Conservative — we only consider
    // the FIRST `; ` as the comment boundary (da65 always emits one).
    const sepIdx = line.indexOf(";");
    const src = sepIdx >= 0 ? line.slice(0, sepIdx) : line;
    let regName = null;
    const m24 = src.match(/\$([0-9A-Fa-f]{2}):([0-9A-Fa-f]{4})/);
    if (m24) {
      const addr = (parseInt(m24[1], 16) << 16) | parseInt(m24[2], 16);
      regName = registers[addr] ?? registers[addr & 0xFFFF] ?? null;
    }
    if (!regName) {
      const m16 = src.match(/\$([0-9A-Fa-f]{3,4})\b/);
      if (m16) {
        regName = registers[parseInt(m16[1], 16)] ?? null;
      }
    }
    if (!regName) return line;
    if (line.includes(regName)) return line;
    if (sepIdx >= 0) {
      // Tail-append into the existing comment, after the byte-count column.
      return line.replace(/\s*$/, " " + regName);
    }
    return line.replace(/\s*$/, "  ; " + regName);
  }).join("\n");
}

/**
 * Annotate asm output with file-offset comments. Given a CPU→file offset
 * translator function `cpuToFile(addr)`, each line with a parseable
 * trailing address comment gets `@0xNNNN` injected into it.
 */
function annotateFileOffsets(asm, cpuToFile, secondaryCpuToFile) {
  return asm.split(/\r?\n/).map((line) => {
    if (line.startsWith(";")) return line;
    const addr = extractInstructionAddress(line);
    if (addr == null) return line;
    let off;
    try { off = cpuToFile(addr); } catch { return line; }
    if (off == null) return line;
    let tag = "@0x" + off.toString(16).toUpperCase();
    if (secondaryCpuToFile) {
      let off2;
      try { off2 = secondaryCpuToFile(addr); } catch { /* swallow */ }
      if (off2 != null) {
        tag += " (prg @0x" + off2.toString(16).toUpperCase() + ")";
      }
    }
    if (line.includes(tag)) return line;
    return line.replace(/\s*$/, "  " + tag);
  }).join("\n");
}

/**
 * Scan disassembled asm for the first end-of-routine instruction (rts, rti,
 * rtl, or bare jmp at column 0). Returns the line index after it, or -1 if
 * none found. Used by `untilReturn`.
 */
/**
 * Inject vector-name labels into z80dasm output. The Z80 disassembler
 * emits `LXXXX:` labels for every branch target it sees, but doesn't
 * know which addresses are interrupt vectors. For each label whose
 * address matches a known vector ($0000=reset, $0038=irq, $0066=nmi, etc.),
 * emit an additional `<vec-name>:` comment line.
 */
function injectVectorLabels(asm, labels) {
  const byAddr = new Map();
  for (const l of labels) byAddr.set(l.addr, l.name);
  const lines = asm.split(/\r?\n/);
  const out = [];
  for (const line of lines) {
    // Match `LXXXX:` label lines (4 hex for Z80/SM83, 6 for m68k).
    const m = line.match(/^L([0-9A-F]{4,6}):/);
    if (m) {
      const addr = parseInt(m[1], 16);
      const name = byAddr.get(addr);
      if (name) out.push(`${name}:`);
    } else {
      // Or match an instruction line whose trailing comment says ADDR is a vector.
      const ma = line.match(/;\s+([0-9A-F]{4,6})\s+/);
      if (ma) {
        const addr = parseInt(ma[1], 16);
        const name = byAddr.get(addr);
        // Only insert the label if it wasn't already emitted as LXXXX.
        if (name) {
          // Don't double-insert if we just emitted the label above.
          if (out.length > 0 && !out[out.length - 1].startsWith(name + ":")) {
            out.push(`${name}:`);
          }
        }
      }
    }
    out.push(line);
  }
  return out.join("\n");
}

function findFirstReturnLine(asm, cpuFamily = "6502") {
  const lines = asm.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (cpuFamily === "z80" || cpuFamily === "sm83") {
      // SM83 differs from Z80 only by missing `retn` (no NMI-return alias).
      // Bare ret, reti, jp <addr>, jp <label> all terminate. Conditional
      // ret (`ret nz` etc) does NOT — routine continues past it.
      if (/^ret\s*(;|$)/.test(trimmed)) return i + 1;
      if (/^reti\b/.test(trimmed)) return i + 1;
      if (cpuFamily === "z80" && /^retn\b/.test(trimmed)) return i + 1;
      if (/^jp\s+\$[0-9A-Fa-f]/.test(trimmed)) return i + 1;
      if (/^jp\s+L[0-9A-Fa-f]/.test(trimmed)) return i + 1;
      // sm83-only: `jp hl` is an indirect jump-table dispatch; treat as
      // routine-end since the decoder can't follow it.
      if (cpuFamily === "sm83" && /^jp\s+hl\b/.test(trimmed)) return i + 1;
    } else {
      if (/^(rts|rti|rtl)\b/.test(trimmed)) return i + 1;
      if (/^jmp\s+\$[0-9A-Fa-f]/.test(trimmed)) return i + 1;
    }
  }
  return -1;
}

/**
 * SMS / Game Gear address mapping. The first 48 KB of the ROM is mapped
 * 1:1 to the Z80's lower 48 KB ($0000-$BFFF). Higher banks are
 * page-mapped via the sega mapper, but for v1 we treat the 16 KB at
 * $8000-$BFFF as "bank 0" by default.
 */
export function mapSmsAddress(data, cpuAddr, length, bank) {
  // Slot 0: $0000-$3FFF maps to file 0..$3FFF (bank 0, fixed).
  // Slot 1: $4000-$7FFF maps to file $4000..$7FFF (bank 1, fixed by default).
  // Slot 2: $8000-$BFFF maps to file $8000..$BFFF (banked — default = bank 2).
  //   Pass `bank` to page a different 16KB bank into slot 2 on a Sega-mapper
  //   cart (bank ignored for the fixed slots 0/1 — those windows have only one
  //   possible mapping, so there's nothing to get wrong).
  if (cpuAddr < 0xC000) {
    let fileOffset = cpuAddr;
    let note = `SMS/GG sega mapper, slot ${cpuAddr < 0x4000 ? 0 : cpuAddr < 0x8000 ? 1 : 2} (default bank)`;
    if (bank != null && cpuAddr >= 0x8000) {
      const numBanks = Math.ceil(data.length / 0x4000);
      if (bank < 0 || bank >= numBanks) {
        throw new Error(`SMS bank ${bank} out of range (ROM has ${numBanks} × 16KB banks, 0-${numBanks - 1})`);
      }
      fileOffset = bank * 0x4000 + (cpuAddr - 0x8000);
      note = `SMS/GG sega mapper, bank ${bank} paged into slot 2 ($8000)`;
    }
    if (fileOffset >= data.length) {
      throw new Error(`CPU address $${cpuAddr.toString(16)} past end of SMS ROM (${data.length} bytes)`);
    }
    return {
      bytes: data.slice(fileOffset, fileOffset + length),
      fileOffset,
      cpu: "z80",
      note,
    };
  }
  throw new Error(
    `CPU address $${cpuAddr.toString(16)} is in RAM ($C000-$FFFF), not ROM. ` +
    `For SMS disasm, target $0000-$BFFF.`
  );
}

/**
 * Game Boy / Game Boy Color address mapping.
 *   Slot 0: $0000-$3FFF = file 0..$3FFF (bank 0, fixed)
 *   Slot 1: $4000-$7FFF = file (bank * 0x4000)..(bank * 0x4000 + 0x3FFF)
 *           Default bank 1 — pass `bank` to disassembleRom for a different one.
 * RAM ($8000+) and I/O are not in the ROM file.
 */
export function mapGbAddress(data, cpuAddr, length, bank = 1) {
  if (cpuAddr < 0x4000) {
    const fileOffset = cpuAddr;
    if (fileOffset >= data.length) {
      throw new Error(`CPU address $${cpuAddr.toString(16)} past end of GB ROM (${data.length} bytes)`);
    }
    return {
      bytes: data.slice(fileOffset, fileOffset + length),
      fileOffset,
      cpu: "sm83",
      note: "GB mapper, slot 0 (bank 0, fixed)",
    };
  }
  if (cpuAddr < 0x8000) {
    const fileOffset = (bank * 0x4000) + (cpuAddr - 0x4000);
    if (fileOffset >= data.length) {
      throw new Error(
        `CPU $${cpuAddr.toString(16)} (bank ${bank}, file 0x${fileOffset.toString(16)}) ` +
        `past end of GB ROM (${data.length} bytes)`
      );
    }
    return {
      bytes: data.slice(fileOffset, fileOffset + length),
      fileOffset,
      cpu: "sm83",
      note: `GB mapper, slot 1 (bank ${bank})`,
    };
  }
  throw new Error(
    `CPU address $${cpuAddr.toString(16)} is in VRAM/WRAM/HRAM, not ROM. ` +
    `For GB disasm, target $0000-$7FFF.`
  );
}

/**
 * Atari 2600 address mapping. 4 KB carts mirror through $F000-$FFFF (and
 * $D000, $B000, etc. — the 2600 only decodes the low 13 bits of the
 * address). 8 KB+ carts use bank-switching schemes (F8, F6, F4, etc.)
 * that we don't fully model here — disassembling those needs the bank
 * arg to slice into the right 4KB window.
 */
export function mapAtari2600Address(data, cpuAddr, length, bank = 0) {
  // Strip mirrors: 2600 addresses are 13-bit. Anything in $1000-$1FFF
  // (mirrored as $3000, $5000, ..., $F000) maps to ROM.
  const stripped = cpuAddr & 0x1FFF;
  if (stripped < 0x1000) {
    throw new Error(
      `CPU address $${cpuAddr.toString(16)} is in TIA/RIOT/RAM space, not ROM. ` +
      `For 2600 disasm, target $1000-$1FFF (or any mirror: $3000, $5000, ..., $F000).`
    );
  }
  const offsetInBank = stripped - 0x1000;  // 0..0xFFF
  // Default 4KB cart: single bank, file offset = offsetInBank.
  // Larger carts: caller passes `bank` index.
  const bankSize = Math.min(data.length, 0x1000);
  const fileOffset = bank * bankSize + offsetInBank;
  if (fileOffset >= data.length) {
    throw new Error(
      `CPU $${cpuAddr.toString(16)} (bank ${bank}, file 0x${fileOffset.toString(16)}) ` +
      `past end of 2600 ROM (${data.length} bytes)`
    );
  }
  return {
    bytes: data.slice(fileOffset, fileOffset + length),
    fileOffset,
    cpu: "6502",
    note: data.length <= 0x1000
      ? "2600 4KB cart (no bank-switching)"
      : `2600 banked cart, bank ${bank} of ${Math.ceil(data.length / 0x1000)}`,
  };
}

/**
 * Genesis / Mega Drive address mapping. The cartridge ROM maps 1:1 into
 * the 68000 address space starting at $000000 — flat, big-endian, no
 * mapper for ROMs ≤ 4 MB (the common case). $000000-$0000FF is the vector
 * table (SP at $000000, reset PC at $000004); cart code typically begins
 * at the reset vector. We treat the CPU address as the file offset
 * directly.
 */
export function mapGenesisAddress(data, cpuAddr, length) {
  if (cpuAddr + length > data.length) {
    throw new Error(
      `Genesis: CPU address $${cpuAddr.toString(16)} + ${length} extends past ROM ` +
      `(${data.length} bytes). ROM maps 1:1 from $000000; for >4MB carts with mappers, ` +
      `slice the file manually.`
    );
  }
  return {
    bytes: data.slice(cpuAddr, cpuAddr + length),
    fileOffset: cpuAddr,
    cpu: "m68k",
    note: "Genesis ROM maps 1:1 to 68000 $000000+ (flat, big-endian).",
  };
}

/**
 * Atari 7800 address mapping. The cart has a 128-byte header at file
 * offset 0 (skip it). ROM body is at file offset 128 and maps into the
 * 6502 address space starting at varying high addresses depending on
 * cart size:
 *   16 KB: $C000-$FFFF
 *   32 KB: $8000-$FFFF
 *   48 KB: $4000-$FFFF (rare)
 *   144 KB SuperGame: bank-switched at $8000-$BFFF + fixed at $C000
 */
export function mapAtari7800Address(data, cpuAddr, length, bank = null) {
  // Detect header. "ATARI7800" magic at offset 1.
  const hasHeader =
    data.length > 128 &&
    String.fromCharCode(data[1], data[2], data[3], data[4], data[5], data[6], data[7], data[8], data[9])
      === "ATARI7800";
  const headerSize = hasHeader ? 128 : 0;
  const romSize = data.length - headerSize;
  // SuperGame banking: 16KB banks page into $8000-$BFFF; the LAST bank is fixed
  // at $C000-$FFFF. Pass `bank` to select the paged bank for a $8000-window
  // address (a $C000+ address always resolves to the fixed top bank, NES-style —
  // `bank` is ignored there, never silently misapplied).
  if (bank != null && bank !== 0 && cpuAddr >= 0x8000 && cpuAddr < 0xC000) {
    const numBanks = Math.floor(romSize / 0x4000);
    if (bank < 0 || bank >= numBanks) {
      throw new Error(`7800 bank ${bank} out of range (ROM has ${numBanks} × 16KB banks, 0-${numBanks - 1})`);
    }
    const fileOffset = headerSize + bank * 0x4000 + (cpuAddr - 0x8000);
    return {
      bytes: data.slice(fileOffset, fileOffset + length),
      fileOffset,
      cpu: "6502",
      note: `7800 SuperGame bank ${bank} paged into $8000-$BFFF`,
    };
  }
  // Default behavior: figure out which file-offset corresponds to cpuAddr.
  // For "fixed" carts (no banking), CPU $C000 maps to romStart + (romSize - 16KB)
  // etc. The simplest, most-correct model: assume cart fills high address
  // space ending at $FFFF.
  const cartStartCpu = 0x10000 - romSize;  // e.g. 32KB = $8000
  if (cpuAddr < cartStartCpu) {
    throw new Error(
      `CPU address $${cpuAddr.toString(16)} is below cart ROM (cart starts at $${cartStartCpu.toString(16)}). ` +
      `For 7800 disasm, target $${cartStartCpu.toString(16)}-$FFFF.`
    );
  }
  const fileOffset = headerSize + (cpuAddr - cartStartCpu);
  if (fileOffset >= data.length) {
    throw new Error(`CPU $${cpuAddr.toString(16)} past end of 7800 ROM`);
  }
  return {
    bytes: data.slice(fileOffset, fileOffset + length),
    fileOffset,
    cpu: "6502",
    note: hasHeader
      ? `7800 ATARI7800 header detected (128B skipped); cart maps to $${cartStartCpu.toString(16).toUpperCase()}-$FFFF`
      : `7800 headerless cart; cart maps to $${cartStartCpu.toString(16).toUpperCase()}-$FFFF`,
  };
}

/**
 * Map a C64 CPU address to a file offset in a .prg image.
 *
 * .prg layout: 2-byte little-endian LOAD ADDRESS, then the program bytes.
 *   file[0..1] = load address (e.g. $0801 for BASIC start)
 *   file[2..]  = program bytes loaded contiguously starting at that addr
 *
 * For .crt cart images we'd need to honor the C64 cart header (see CCS64
 * docs); not implemented here — pass `bank` instead and call with the raw
 * binary if you're hand-mapping.
 */
export function mapC64Address(data, cpuAddr, length, _bank = 0) {
  // Detect .prg by reading the load address and seeing if it makes sense.
  // (Anything is a valid load addr in theory, so we just trust the first
  // 2 bytes here.)
  const loadAddr = data[0] | (data[1] << 8);
  const fileOffset = 2 + (cpuAddr - loadAddr);
  if (cpuAddr < loadAddr) {
    throw new Error(
      `CPU $${cpuAddr.toString(16)} is below the .prg load address $${loadAddr.toString(16)}. ` +
      `This file loads at $${loadAddr.toString(16)} — start disasm there.`
    );
  }
  if (fileOffset < 2 || fileOffset >= data.length) {
    throw new Error(
      `CPU $${cpuAddr.toString(16)} maps to file offset ${fileOffset}, outside this ${data.length}-byte .prg.`
    );
  }
  return {
    bytes: data.slice(fileOffset, fileOffset + length),
    fileOffset,
    cpu: "6502",
    note: `c64 .prg load addr = $${loadAddr.toString(16).toUpperCase()}; first byte after header is at file offset 2`,
  };
}

async function disassembleCore({ path: inPath, base64, startAddress = 0x8000, cpu = "6502", addOrigin = true, symbolsPath, symbolsText, symbolsFormat, outputPath, inline }) {
      if (!inline && !outputPath) {
        throw new Error("disassemble: pass outputPath (write the asm to disk, returns {path}) or inline:true (return the asm in the response).");
      }
      if (!inPath && !base64) {
        throw new Error("disassemble: pass `path` (a binary file on disk) or `base64` (the bytes).");
      }
      const { runDa65 } = await import("../../toolchains/cc65/da65.js");
      const bytes = inPath
        ? new Uint8Array(await readFile(inPath))
        : new Uint8Array(Buffer.from(base64, "base64"));
      const r = await runDa65({ bytes, startAddress, cpu });
      let asm = r.asm;

      // On failure, surface the error in the response — never write the raw
      // da65 error text into outputPath (it'd masquerade as partial asm).
      if (r.exitCode !== 0) {
        return jsonContent({
          ok: false,
          exitCode: r.exitCode,
          bytes: bytes.length,
          startAddress,
          cpu,
          error: firstErrorLine(asm) ?? `da65 exited ${r.exitCode}`,
          errorText: asm,
          note: "Disassembly FAILED — outputPath not written. See `error`.",
        });
      }

      // Round-trip origin (cc65 family only — da65 is always 6502-family here).
      if (addOrigin) asm = injectOrigin(asm, startAddress);

      let symbolCount = 0;
      if (symbolsPath || symbolsText) {
        const text = symbolsPath ? await readFile(symbolsPath, "utf-8") : symbolsText;
        const symbols = parseSymbols({ text, path: symbolsPath, format: symbolsFormat });
        const map = buildSymbolMap(symbols);
        asm = annotateDisasmWithSymbols(asm, map);
        symbolCount = symbols.length;
      }
      const meta = {
        ok: true,
        exitCode: r.exitCode,
        bytes: bytes.length,
        startAddress,
        cpu,
        symbolCount,
        ...(inPath ? { sourcePath: inPath } : {}),
      };
      if (inline) {
        return jsonContent({ ...meta, asm });
      }
      const { path } = writeOutput(asm, { outputPath, what: "disassembly asm" });
      return jsonContent({ ...meta, path, asmBytes: asm.length });
}

async function disassembleRomCore(args) {
      const {
        path: romPath, platform, mapper,
        untilReturn, dataRanges,
        autoLabelVectors,
        outputPath,
      } = args;
      const addOrigin = args.addOrigin ?? true;
      // `let` because Genesis re-points an unset startAddress to the reset vector.
      let startAddress = args.startAddress;
      const annotateRegistersFlag = args.annotateRegisters ?? true;
      const annotateFileOffsetsFlag = args.annotateFileOffsets ?? true;

      const { runDa65 } = await import("../../toolchains/cc65/da65.js");
      const data = new Uint8Array(await readFile(romPath));

      // Resolve platform.
      const resolved = platform ?? (
        /\.nes$/i.test(romPath) ? "nes" :
        /\.(sfc|smc)$/i.test(romPath) ? "snes" :
        /\.sms$/i.test(romPath) ? "sms" :
        /\.gg$/i.test(romPath) ? "gg" :
        /\.gb$/i.test(romPath) ? "gb" :
        /\.gbc$/i.test(romPath) ? "gbc" :
        /\.a26$/i.test(romPath) ? "atari2600" :
        /\.a78$/i.test(romPath) ? "atari7800" :
        /\.prg$/i.test(romPath) ? "c64" :
        /\.gba$/i.test(romPath) ? "gba" :
        /\.(lnx|lyx)$/i.test(romPath) ? "lynx" :
        /\.(gen|md|bin)$/i.test(romPath) ? "genesis" :
        null
      );
      if (!resolved) {
        throw new Error(`could not detect platform from path '${romPath}'. Pass platform explicitly.`);
      }
      const cpuFamily = (resolved === "sms" || resolved === "gg") ? "z80"
                      : (resolved === "gb" || resolved === "gbc") ? "sm83"
                      : (resolved === "genesis") ? "m68k"
                      : (resolved === "gba") ? "arm"
                      : "6502";

      // Resolve length: endAddress wins over length; default 256.
      let length;
      if (args.endAddress != null) {
        if (args.length != null) {
          throw new Error("disassembleRom: pass either `length` OR `endAddress`, not both.");
        }
        length = args.endAddress - startAddress + 1;
        if (length <= 0) throw new Error(`disassembleRom: endAddress ($${args.endAddress.toString(16)}) must be >= startAddress ($${startAddress.toString(16)}).`);
      } else {
        length = args.length ?? 256;
      }

      // Genesis code lives in the low ROM; the default $8000 start (a
      // 6502/Z80 convention) is meaningless for 68000. If the caller
      // didn't override startAddress, begin at the reset vector ($000004
      // holds the reset PC).
      // Genesis code lives in low ROM; the $8000 schema default (a 6502/Z80
      // convention) is meaningless on 68000. When the caller left it at the
      // default, start at the reset vector ($000004 holds the reset PC).
      if (resolved === "genesis" && startAddress === 0x8000 && args.endAddress === undefined) {
        startAddress = (data[4] << 24 | data[5] << 16 | data[6] << 8 | data[7]) >>> 0;
        if (startAddress >= data.length) startAddress = 0x200; // fallback
      }
      // GBA ROM maps flat at 0x08000000; the cart entry is at file offset 0
      // (a branch over the 192-byte header). Default to disassembling from the
      // start of ROM in 0x08000000 space when the caller left the 6502 default.
      if (resolved === "gba" && startAddress === 0x8000 && args.endAddress === undefined) {
        startAddress = 0x08000000;
      }
      // Lynx: 65C02 cart image (after a 64-byte "LYNX" header). Homebrew runs
      // from $0200, not the $8000 6502 default — auto-bump when unspecified.
      if (resolved === "lynx" && startAddress === 0x8000 && args.endAddress === undefined) {
        startAddress = 0x0200;
      }

      // `bank` handling — NEVER silently ignore it (field report: SNES LoROM
      // `{startAddress:$83CD, bank:2}` used to read BANK 0's bytes and return a
      // plausible disassembly under the caller's bank-2 label — silently the
      // wrong 32KB, worse than an error).
      //  - SNES: the bank IS the address's high byte. Compose the full 24-bit
      //    address (same mapping readCart honors); the da65 bank-local masking
      //    + file-offset annotation (0.90.0) handle everything downstream.
      //  - sms/gg + atari7800: honored in their mappers (slot-2 / SuperGame
      //    windows) — see mapSmsAddress/mapAtari7800Address.
      //  - flat platforms (genesis/gba/lynx/c64 .prg): a meaningful bank is a
      //    caller error — REJECT it rather than return flat bytes under a
      //    banked label.
      if (resolved === "snes" && args.bank != null && startAddress < 0x10000) {
        startAddress = ((args.bank & 0xFF) << 16) | startAddress;
      }
      if (args.bank != null && args.bank !== 0 && (resolved === "genesis" || resolved === "gba" || resolved === "lynx" || resolved === "c64")) {
        throw new Error(
          `disasm({target:'rom'}): \`bank\` is not applicable on ${resolved} (flat address space — no cart banking). ` +
          `Pass the address directly.`,
        );
      }

      const mapped = resolved === "lynx"
        ? (() => {
            const hasHdr = data.length >= 64 && data[0] === 0x4c && data[1] === 0x59 && data[2] === 0x4e && data[3] === 0x58; // "LYNX"
            const base = hasHdr ? 64 : 0;
            const off = base + (startAddress - 0x0200); // flat image loaded at $0200
            if (off < base || off >= data.length) throw new Error(`Lynx: startAddress $${startAddress.toString(16)} is outside the cart image.`);
            return { bytes: data.slice(off, Math.min(data.length, off + length)), fileOffset: off, cpu: "6502" };
          })()
        : resolved === "gba"
        ? (() => {
            const base = 0x08000000;
            const off = (startAddress >>> 0) - base;
            if (off < 0 || off >= data.length) throw new Error(`GBA: startAddress $${startAddress.toString(16)} is outside ROM (maps 0x08000000..0x08000000+${data.length}).`);
            return { bytes: data.slice(off, Math.min(data.length, off + length)), fileOffset: off, cpu: "arm" };
          })()
        : resolved === "snes"
        ? mapSnesAddress(data, startAddress, length, mapper)
        : resolved === "sms" || resolved === "gg"
          ? mapSmsAddress(data, startAddress, length, args.bank)
          : resolved === "gb" || resolved === "gbc"
            ? mapGbAddress(data, startAddress, length, args.bank)
            : resolved === "atari2600"
              ? mapAtari2600Address(data, startAddress, length, args.bank ?? 0)
              : resolved === "atari7800"
                ? mapAtari7800Address(data, startAddress, length, args.bank ?? 0)
                : resolved === "c64"
                  ? mapC64Address(data, startAddress, length, args.bank ?? 0)
                  : resolved === "genesis"
                    ? mapGenesisAddress(data, startAddress, length)
                    : mapNesAddress(data, startAddress, length, args.bank);

      // Build vector labels + data ranges. For SMS, no vector table to
      // auto-read (Z80 uses reset $0000 + interrupt vector based on IM
      // mode). For NES/SNES we synthesize a da65 info file.
      let info = null;
      const labels = [];
      if (autoLabelVectors && cpuFamily === "6502") {
        let vecs = null;
        if (resolved === "nes") vecs = nesVectors(data);
        else if (resolved === "snes") vecs = snesVectors(data);
        else if (resolved === "atari2600") {
          // 2600 vectors at $FFFA-$FFFF (NMI/RESET/IRQ); all carts map them
          // to top of 4KB bank. Read last 6 bytes of the file.
          const off = data.length - 6;
          vecs = {
            nmi:   data[off + 0] | (data[off + 1] << 8),
            reset: data[off + 2] | (data[off + 3] << 8),
            irq:   data[off + 4] | (data[off + 5] << 8),
          };
        } else if (resolved === "atari7800") {
          // 7800 vectors at $FFFA-$FFFF (NMI/RESET/IRQ).
          const off = data.length - 6;
          vecs = {
            nmi:   data[off + 0] | (data[off + 1] << 8),
            reset: data[off + 2] | (data[off + 3] << 8),
            irq:   data[off + 4] | (data[off + 5] << 8),
          };
        }
        if (vecs) {
          for (const [name, addr] of Object.entries(vecs)) {
            if (addr >= startAddress && addr <= startAddress + length - 1) {
              labels.push({ name, addr });
            }
          }
        }
      }
      if (autoLabelVectors && cpuFamily === "z80") {
        // Z80 fixed vectors: reset = $0000, interrupt vectors at $0008
        // ($28 = rst 8), $0010, $0018, $0020, $0028, $0030, $0038. NMI = $0066.
        // SMS uses $38 (IM 1) for vblank, $66 (NMI) for the pause button.
        const z80Vectors = {
          reset: 0x0000,
          rst08: 0x0008, rst10: 0x0010, rst18: 0x0018,
          rst20: 0x0020, rst28: 0x0028, rst30: 0x0030,
          irq: 0x0038,    // SMS vblank handler when IM 1
          nmi: 0x0066,    // SMS pause button
        };
        for (const [name, addr] of Object.entries(z80Vectors)) {
          if (addr >= startAddress && addr <= startAddress + length - 1) {
            labels.push({ name, addr });
          }
        }
      }
      if (autoLabelVectors && cpuFamily === "sm83") {
        // GB vectors: rst $00-$38, plus dedicated IRQ vectors:
        //   $0040 vblank IRQ
        //   $0048 lcd-stat IRQ
        //   $0050 timer IRQ
        //   $0058 serial IRQ
        //   $0060 joypad IRQ
        //   $0100 entry point (cart code starts here after Nintendo logo)
        //   $0104-$0133 logo bytes (NOT code — auto-skip if window includes them)
        const gbVectors = {
          reset: 0x0000,
          rst08: 0x0008, rst10: 0x0010, rst18: 0x0018,
          rst20: 0x0020, rst28: 0x0028, rst30: 0x0030, rst38: 0x0038,
          vblank:   0x0040,
          lcd_stat: 0x0048,
          timer:    0x0050,
          serial:   0x0058,
          joypad:   0x0060,
          entry:    0x0100,
        };
        for (const [name, addr] of Object.entries(gbVectors)) {
          if (addr >= startAddress && addr <= startAddress + length - 1) {
            labels.push({ name, addr });
          }
        }
      }
      if (autoLabelVectors && cpuFamily === "m68k") {
        // Genesis 68000 vector table at $000000-$0000FF. The useful ones:
        //   $000000 initial SP, $000004 reset PC, $000060 HBL, $000070 VBL.
        // (The full table is 64 long-word vectors; these are the ones game
        // code reaches.) Read the targets from the ROM image and label any
        // that fall inside the disassembly window.
        const vec = (off) => (data[off] << 24 | data[off + 1] << 16 | data[off + 2] << 8 | data[off + 3]) >>> 0;
        const genVectors = {
          reset: vec(0x04),
          hbl:   vec(0x70),  // level-4 autovector (H-blank)
          vbl:   vec(0x78),  // level-6 autovector (V-blank)
        };
        for (const [name, t] of Object.entries(genVectors)) {
          if (t >= startAddress && t <= startAddress + length - 1) labels.push({ name, addr: t });
        }
      }
      // Dedup vector labels by ADDRESS. Two interrupt vectors legitimately
      // sharing one target is valid 6502 (e.g. one NES cart points NMI and IRQ both at
      // $C0F6) — but da65's LABELDEF and every dasm injector reject two labels
      // at the same address ("Label for address $XXXX already defined"). Keep
      // the first name (vector iteration order is reset/nmi/irq) and record the
      // dropped aliases so the response can surface them.
      const labelAliases = [];
      if (labels.length > 1) {
        const seen = new Map(); // addr -> first label name
        const deduped = [];
        for (const lab of labels) {
          if (seen.has(lab.addr)) {
            labelAliases.push({ alias: lab.name, sameAs: seen.get(lab.addr), addr: lab.addr });
          } else {
            seen.set(lab.addr, lab.name);
            deduped.push(lab);
          }
        }
        labels.length = 0;
        labels.push(...deduped);
      }

      const dataRangesInWindow = (dataRanges ?? []).filter((r) => {
        return r.start + r.length - 1 >= startAddress && r.start <= startAddress + length - 1;
      });

      let asm;
      let exitCode = 0;
      // Non-6502 CPUs disassemble through the native binutils objdump for that
      // ISA (m68k / arm+thumb / z80 / gbz80). The objdump WASM ships in the
      // matching toolchain package (a hard dependency), so it's always present.
      if (cpuFamily === "m68k" || cpuFamily === "arm" || cpuFamily === "z80" || cpuFamily === "sm83") {
        const { runObjdump, objdumpAvailable } = await import("../../toolchains/objdump.js");
        const arch = cpuFamily === "arm" ? (args.thumb ? "thumb" : "arm")
          : cpuFamily === "sm83" ? "gbz80"
          : cpuFamily; // m68k / z80
        if (!objdumpAvailable(arch)) {
          throw new Error(`disassembly needs the ${arch} objdump WASM (in the matching romdev toolchain package). Reinstall the toolchain package.`);
        }
        const r = await runObjdump({ bytes: mapped.bytes, arch, startAddress });
        asm = r.asm; exitCode = r.exitCode;
        if (labels.length > 0 && cpuFamily !== "arm") asm = injectVectorLabels(asm, labels);
      } else {
        // da65's --start-addr is a 16-bit address (it aborts on >= 0x10000). For a
        // banked SNES/PCE/… address (e.g. LoROM $02AF86, bank 2), the in-bank CPU
        // address IS the low 16 bits ($AF86) — so disassemble with the bank-local
        // start and remember the bank base to fold back into the file-offset
        // annotation, which needs the FULL cpu address to map to a ROM offset.
        const bankBase = startAddress & ~0xFFFF;      // 0 for a $0000-$FFFF address
        const da65Start = startAddress & 0xFFFF;      // legal 16-bit --start-addr
        if (labels.length > 0 || dataRangesInWindow.length > 0 || mapped.cpu !== "6502") {
          info = buildInfoFile({
            startAddress: da65Start, length,
            cpu: mapped.cpu,
            labels: labels.map((l) => ({ ...l, addr: l.addr & 0xFFFF })),
            dataRanges: dataRangesInWindow.map((d) => ({ ...d, start: d.start & 0xFFFF, end: d.end & 0xFFFF })),
          });
        }
        const needAddressColumn = annotateRegistersFlag || annotateFileOffsetsFlag;
        const r = await runDa65({
          bytes: mapped.bytes, startAddress: da65Start, cpu: mapped.cpu, info,
          options: needAddressColumn ? ["--comments", "4"] : [],
        });
        asm = r.asm;
        exitCode = r.exitCode;
        // Stash so the annotators below reconstruct the full 24-bit cpu address.
        args = { ...args, _bankBase: bankBase };
      }

      // File-offset annotation: per-line cpu→file translator (shared mapper).
      // `args.bank` maps $8000-$BFFF to the chosen switchable bank; mapNesAddress
      // ignores it for $C000+ (fixed top bank), so each line points at the right
      // PRG offset.
      if (annotateFileOffsetsFlag) {
        // da65 emitted bank-local 16-bit addresses; add the bank base back so the
        // file mapper resolves to the right ROM offset for a banked SNES address.
        const bankBase = args._bankBase ?? 0;
        const cpuToFile = (cpuAddr) => cpuAddrToFileOffset(resolved, data, (cpuAddr & 0xFFFF) + bankBase, { bank: args.bank, snesMapper: mapper });
        // Secondary translator for NES — also report the header-stripped
        // PRG offset, since patchFile against `prg.bin` (from extractCart)
        // needs the header-less frame.
        let secondaryCpuToFile;
        if (resolved === "nes") {
          secondaryCpuToFile = (cpuAddr) => {
            try {
              const off = mapNesAddress(data, cpuAddr, 1, args.bank).fileOffset;
              if (off == null) return null;
              return off - 16; // strip iNES header
            } catch {
              return null;
            }
          };
        }
        asm = annotateFileOffsets(asm, cpuToFile, secondaryCpuToFile);
      }

      if (annotateRegistersFlag) {
        const regs = registersForPlatform(resolved);
        asm = annotateRegisters(asm, regs);
      }

      // Emit an origin directive so the output ASSEMBLES UNMODIFIED. da65 emits
      // absolute label references for out-of-window branch/jump targets (e.g.
      // `bvs LC006` where LC006 := $C006); in ca65 relocatable mode the
      // assembler can't compute the signed branch offset to an absolute target
      // without knowing the segment's load address → "Range error". An `.org`
      // after `.setcpu` pins it. Only for the cc65/6502 family (da65 output);
      // the z80/sm83/m68k dasms have their own conventions. addOrigin:false
      // opts out (e.g. when feeding into a multi-segment linker config that
      // sets the origin itself).
      if (addOrigin && (cpuFamily === "6502") && exitCode === 0) {
        asm = injectOrigin(asm, startAddress);
      }

      // Truncate at first return (after annotations so we get the same line
      // count we wrote out).
      let truncatedAtReturn = false;
      if (untilReturn) {
        const cutAt = findFirstReturnLine(asm, cpuFamily);
        if (cutAt > 0) {
          asm = asm.split(/\r?\n/).slice(0, cutAt).join("\n") + "\n";
          truncatedAtReturn = true;
        }
      }

      const baseResult = {
        exitCode,
        path: romPath,
        platform: resolved,
        startAddress,
        length: mapped.bytes.length,
        fileOffset: mapped.fileOffset,
        cpu: mapped.cpu,
        note: mapped.note,
        labels: labels.length > 0 ? labels.map((l) => ({ name: l.name, addr: "$" + l.addr.toString(16).toUpperCase() })) : undefined,
        labelAliases: labelAliases.length > 0
          ? labelAliases.map((a) => ({ alias: a.alias, sameAs: a.sameAs, addr: "$" + a.addr.toString(16).toUpperCase() }))
          : undefined,
        dataRanges: dataRangesInWindow.length > 0 ? dataRangesInWindow : undefined,
        truncatedAtReturn: truncatedAtReturn || undefined,
      };

      // On a disassembler failure, do NOT write outputPath — otherwise the raw
      // da65 error string lands in the file the caller intends to Read as asm,
      // and looks like partial output. Surface a top-level `error` + ok:false
      // and keep the (error) text in `errorText` for diagnosis.
      if (exitCode !== 0) {
        return jsonContent({
          ...baseResult,
          ok: false,
          error: firstErrorLine(asm) ?? `disassembler exited ${exitCode}`,
          errorText: asm,
          note: (baseResult.note ? baseResult.note + " " : "") +
            "Disassembly FAILED — outputPath was NOT written (so a prior good file isn't clobbered with an error). See `error`.",
        });
      }

      if (outputPath) {
        await writeFile(outputPath, asm);
        return jsonContent({
          ...baseResult,
          ok: true,
          outputPath,
          asmBytes: asm.length,
          asmLines: asm.split(/\r?\n/).length - 1,
          hint: `${asm.length} bytes of asm written to ${outputPath}. Read it directly with your file tools.`,
        });
      }

      return jsonContent({ ...baseResult, ok: true, asm });
}

// The job-status file dropped in the output dir so a background disassembly's
// progress survives across MCP calls (no in-memory registry — poll reads the
// file). Presence + `status` is the source of truth.
const JOB_FILE = ".romdev-job.json";

/**
 * disasm({target:'project'}) orchestrator. Three modes:
 *   - default (sync): run to completion, return the full payload.
 *   - background:true → START the work detached, return {jobId} immediately (for
 *     multi-MB ROMs whose reassemble would time out the tool call).
 *   - job:'<id>' → POLL: read the status file; return progress, or the final
 *     payload once done, or the error if it failed.
 */
export async function disassembleProjectCore(args) {
  const { path: romPath, outputDir, platform, background, job } = args;

  // ── POLL an existing background job ────────────────────────────────────────
  if (job) {
    if (!outputDir) throw new Error("disasm({target:'project', job}): outputDir is required to locate the job status file.");
    let st;
    try { st = JSON.parse(await readFile(nodePath.join(outputDir, JOB_FILE), "utf8")); }
    catch { throw new Error(`disasm({target:'project', job:'${job}'}): no job found in '${outputDir}' (missing ${JOB_FILE}). Start one with background:true first.`); }
    if (st.jobId !== job) throw new Error(`disasm({target:'project'}): job '${job}' doesn't match the job in '${outputDir}' ('${st.jobId}'). Poll the outputDir you started.`);
    if (st.status === "running") {
      return jsonContent({
        ok: null, status: "running", jobId: job, platform: st.platform, outputDir,
        regionsDone: st.regionsDone ?? 0, regionsTotal: st.regionsTotal ?? null,
        note: `Still disassembling — ${st.regionsDone ?? 0}/${st.regionsTotal ?? "?"} regions done. Poll again: disasm({target:'project', job:'${job}', outputDir:'${outputDir}'}).`,
      });
    }
    if (st.status === "error") {
      return jsonContent({ ok: false, status: "error", jobId: job, platform: st.platform, outputDir, error: st.error, note: `Background disassembly FAILED: ${st.error}` });
    }
    // done → hand back the stored final payload verbatim.
    return jsonContent(st.result);
  }

  // ── START a background job ─────────────────────────────────────────────────
  if (background) {
    if (!outputDir) throw new Error("disasm({target:'project', background:true}): outputDir is required (the job writes its status + output there).");
    const resolved = platform ?? sniffPlatformFromPath(romPath);
    if (!resolved) throw new Error(`disassembleProject: could not detect platform from '${romPath}'. Pass platform explicitly.`);
    await mkdir(outputDir, { recursive: true });
    // A deterministic-but-unique id (no Date.now/random in scripts; here we're in
    // the server, so a monotonic counter + the dir is fine and readable).
    const jobId = `job-${resolved}-${(bgJobCounter++).toString(36)}`;
    const statusPath = nodePath.join(outputDir, JOB_FILE);
    await writeFile(statusPath, JSON.stringify({ jobId, status: "running", platform: resolved, regionsDone: 0, regionsTotal: null }, null, 2));
    // Fire-and-forget: run the work, updating the status file as it goes. Errors
    // are caught and recorded in the status file (the poll surfaces them) — an
    // unhandled rejection here must never crash the server.
    runProjectDisassembly(args, resolved, { statusPath, jobId }).then(
      async (payload) => { await writeFile(statusPath, JSON.stringify({ jobId, status: "done", platform: resolved, result: payload }, null, 2)); },
      async (err) => { await writeFile(statusPath, JSON.stringify({ jobId, status: "error", platform: resolved, error: String(err?.message ?? err) }, null, 2)).catch(() => {}); },
    );
    return jsonContent({
      ok: null, status: "running", jobId, platform: resolved, outputDir,
      note: `Disassembly started in the BACKGROUND (large ROM). Poll for completion: disasm({target:'project', job:'${jobId}', outputDir:'${outputDir}'}). ` +
        `The server keeps working even if this call's client times out; the poll returns the full result when done.`,
    });
  }

  // ── SYNC (default) ─────────────────────────────────────────────────────────
  const resolved = platform ?? sniffPlatformFromPath(romPath);
  if (!resolved) throw new Error(`disassembleProject: could not detect platform from '${romPath}'. Pass platform explicitly.`);
  await mkdir(outputDir, { recursive: true });
  return jsonContent(await runProjectDisassembly(args, resolved, null));
}

let bgJobCounter = 1;

/**
 * The actual disassemble-project work. Returns the payload OBJECT (not wrapped in
 * jsonContent — the caller wraps, so the same object can also be stored in the job
 * status file). `progress` (or null) receives {statusPath, jobId} to checkpoint
 * per-region completion for the poll surface.
 */
async function runProjectDisassembly({ path: romPath, outputDir }, resolved, progress) {
      const { reassembleForPlatform, CPU_FAMILY } = await import("../../toolchains/common/reassemble.js");
      const data = new Uint8Array(await readFile(romPath));
      await mkdir(outputDir, { recursive: true });

      // Plan the regions to disassemble for this platform (per-bank for banked
      // ROMs; one region for flat ROMs). Each region → its own byte-exact .asm.
      const regions = planRegions(resolved, data);
      if (!regions.length) throw new Error(`disassembleProject: no regions planned for '${resolved}' (unsupported or empty ROM).`);
      if (progress) {
        await writeFile(nodePath.join(outputDir, JOB_FILE),
          JSON.stringify({ jobId: progress.jobId, status: "running", platform: resolved, regionsDone: 0, regionsTotal: regions.length }, null, 2)).catch(() => {});
      }

      // Reassemble every region CONCURRENTLY. Each region is independent (its own
      // WASM worker job + its own file write), and the worker pool caps real
      // parallelism at ROM_DEV_WASM_POOL_SIZE — so firing all banks at once runs
      // pool-many at a time and cuts wall-time by that factor on multi-bank ROMs
      // (a 32-bank SNES cart no longer serializes 32 heal loops). Order is
      // preserved by mapping over indices. (For very large ROMs the async-job
      // path below still applies so the client never times out mid-run.)
      let regionsDone = 0;
      const out = await Promise.all(regions.map(async (reg) => {
        // Known-data regions (e.g. the GBA cartridge header) are emitted as a
        // clean `.byte` dump — byte-exact by construction, NOT a failed disasm.
        const r = reg.kind === "data"
          ? { ok: true, readablePercent: 0, source: dataRegionSource(reg.bytes, reg.startAddress, CPU_FAMILY[resolved]), note: "data region (not code)" }
          : await reassembleForPlatform({ platform: resolved, bytes: reg.bytes, startAddress: reg.startAddress });
        // A uniform-FILL region ($FF/$00 padding) disassembles into junk that
        // reports a high readablePercent — a trap (the emptiest bank looks the
        // "most readable"). Detect it and report readability HONESTLY as null +
        // a `fill` flag, so `readablePercent` never lies about padding.
        const fillByte = uniformFillByte(reg.bytes);
        const isFill = fillByte != null && reg.kind !== "data";
        const readablePercent = isFill ? null : r.readablePercent;
        const header = `; ${reg.label} — ${reg.bytes.length} bytes @ $${reg.startAddress.toString(16).toUpperCase()} ` +
          `(file 0x${reg.fileOffset.toString(16).toUpperCase()}), ${resolved}\n` +
          `; round-trip: ${r.ok ? "BYTE-EXACT" : "FAILED"} · ` +
          (isFill ? `FILL region (all $${fillByte.toString(16).toUpperCase().padStart(2, "0")}) — readability N/A`
                  : `readable ${r.readablePercent}%`) +
          (r.note ? ` · ${r.note}` : "") + "\n\n";
        await writeFile(nodePath.join(outputDir, reg.file), header + r.source);
        // Checkpoint progress for the poll surface (background jobs only).
        regionsDone++;
        if (progress) {
          await writeFile(nodePath.join(outputDir, JOB_FILE),
            JSON.stringify({ jobId: progress.jobId, status: "running", platform: resolved, regionsDone, regionsTotal: regions.length }, null, 2)).catch(() => {});
        }
        return {
          region: reg.name, file: reg.file, startAddress: "$" + reg.startAddress.toString(16).toUpperCase(),
          bytes: reg.bytes.length, roundTripOk: r.ok, readablePercent,
          ...(reg.kind === "data" ? { kind: "data" } : {}),
          ...(isFill ? { fill: true, fillByte: "$" + fillByte.toString(16).toUpperCase().padStart(2, "0") } : {}),
          ...(r.note ? { note: r.note } : {}),
        };
      }));

      const allOk = out.every((r) => r.roundTripOk);
      // Average readability over CODE regions only — fill regions have no
      // meaningful percent (readablePercent:null) and would skew the average.
      const codeRegions = out.filter((r) => r.readablePercent != null);
      const avgReadable = codeRegions.length
        ? Math.round(codeRegions.reduce((s, r) => s + r.readablePercent, 0) / codeRegions.length)
        : 0;

      // Make the project TURNKEY: write the rebuild glue (data blobs, the exact
      // build() call, and human-readable instructions) so it rebuilds without
      // hand-wiring a header/CHR-blob/linker .cfg. See disasm-rebuild.js.
      const { planRebuild } = await import("./disasm-rebuild.js");
      const plan = planRebuild(resolved, data, regions);
      const writtenBlobs = [];
      for (const [name, bytes] of Object.entries(plan.blobs)) {
        await writeFile(nodePath.join(outputDir, name), bytes);
        writtenBlobs.push({ file: name, bytes: bytes.length });
      }
      // Absolutize the bare filenames in the build call so the recipe is
      // copy-pasteable as-is.
      const absBuild = plan.build ? absolutizeBuild(plan.build, outputDir) : null;
      if (absBuild) {
        await writeFile(
          nodePath.join(outputDir, "rebuild.json"),
          JSON.stringify(absBuild, null, 2) + "\n"
        );
      }
      const buildMd = renderBuildMd({
        platform: resolved, romPath, outputDir, regions: out, blobs: writtenBlobs,
        build: absBuild, verifiable: plan.verifiable, notes: plan.notes, allOk,
      });
      await writeFile(nodePath.join(outputDir, "BUILD.md"), buildMd);

      // reassemble.json — the UNIFORM byte-exact rebuild manifest, written for
      // EVERY platform (unlike rebuild.json's one-call subset). It lets
      // build({output:'reassemble', path}) rebuild the ROM in one call on any
      // platform: assemble each region .asm and splice it into a copy of the
      // ORIGINAL rom (kept as original.rom) at its file offset, so the header,
      // inter-region gaps, and trailing pad come back verbatim. See toolchain.js.
      await writeFile(nodePath.join(outputDir, "original.rom"), data);
      // original.rom is a verbatim copy of the source ROM (the reassemble splice
      // template) — copyrighted cartridge data that must NEVER be committed. Emit
      // a .gitignore that excludes it plus common ROM extensions so a scaffolded
      // project can't accidentally check the ROM into git. Append (deduped) if a
      // .gitignore already exists so we don't clobber the user's rules.
      // NOTE: no `*.md` — Genesis ROMs share that extension with Markdown, and
      // ignoring it would exclude BUILD.md. `original.rom` covers the template on
      // every platform regardless; the extension list is a belt-and-suspenders
      // for any raw ROM a user drops in the dir.
      await ensureGitignore(outputDir, [
        "# romdev: never commit ROM data (original.rom is the reassemble template)",
        "original.rom",
        "*.rom", "*.nes", "*.sfc", "*.smc", "*.gb", "*.gbc", "*.gba",
        "*.gen", "*.sms", "*.gg", "*.a26", "*.a78", "*.lnx", "*.pce", "*.gtr",
        ".romdev-job.json",
      ]);
      const reassembleManifest = {
        platform: resolved,
        romTemplate: "original.rom",  // relative to the project dir
        romLength: data.length,
        regions: regions.map((reg) => ({
          file: reg.file,
          startAddress: reg.startAddress,
          fileOffset: reg.fileOffset,
          byteLength: reg.bytes.length,
          ...(reg.kind === "data" ? { kind: "data" } : {}),
        })),
      };
      await writeFile(
        nodePath.join(outputDir, "reassemble.json"),
        JSON.stringify(reassembleManifest, null, 2) + "\n"
      );

      // Return the raw payload OBJECT (the orchestrator wraps it in jsonContent
      // for the sync path, or stores it in the job status file for background).
      return {
        ok: allOk,
        path: romPath,
        platform: resolved,
        regions: out,
        roundTrip: { regions: out.length, allByteExact: allOk, failed: out.filter((r) => !r.roundTripOk).map((r) => r.region) },
        readablePercentAvg: avgReadable,   // over CODE regions only; fill/padding excluded
        fillRegions: out.filter((r) => r.fill).length,  // padding banks flagged (readablePercent:null), NOT counted as readable
        romProtected: ".gitignore",        // original.rom + ROM extensions git-ignored so the ROM can't be committed
        rebuild: {
          blobs: writtenBlobs,
          buildCall: absBuild,        // the exact build({...}) args to reproduce the ROM
          verifiable: plan.verifiable, // true = expected byte-identical via that call
          buildDoc: "BUILD.md",
          notes: plan.notes,
          // The UNIFORM one-call rebuild, available on EVERY platform (splices
          // the reassembled regions into a copy of the original for the gaps).
          reassemble: { output: "reassemble", platform: resolved, path: outputDir },
        },
        note: allOk
          ? `All ${out.length} region(s) round-trip BYTE-EXACT (avg ${avgReadable}% disassembled as instructions, the rest as .byte data). ` +
            `Rebuild byte-identical in ONE call: build({output:'reassemble', platform:'${resolved}', path:'${outputDir}'}).` +
            (absBuild
              ? ` (build() one-call rebuild also available via rebuild.json.)`
              : ``)
          : `Some regions did NOT round-trip byte-exact — see regions[].note. build({output:'reassemble', platform:'${resolved}', path:'${outputDir}'}) still rebuilds the original bytes (edited regions must reassemble to their length).`,
      };
}

/**
 * If a region is (near-)uniform fill — one byte value repeated — return that
 * byte; else null. Padding banks ($FF/$00) disassemble into junk that reports a
 * bogus-high readablePercent, so we flag them and exclude them from readability.
 * Threshold: ≥99.5% one value AND ≥256 bytes (small regions aren't "padding"),
 * so a real code bank with incidental repeats is never misflagged.
 */
function uniformFillByte(bytes) {
  if (!bytes || bytes.length < 256) return null;
  const first = bytes[0];
  let same = 0;
  for (let i = 0; i < bytes.length; i++) if (bytes[i] === first) same++;
  return same / bytes.length >= 0.995 ? first : null;
}

/**
 * Ensure a project dir's .gitignore contains each of `entries`, without
 * clobbering an existing one. Creates the file if absent; otherwise appends only
 * the lines not already present (whitespace-trimmed match), preserving the user's
 * existing rules and order. Blank/comment lines are appended verbatim only if the
 * whole block is new (we don't dedupe comments against existing text).
 */
async function ensureGitignore(outputDir, entries) {
  const gi = nodePath.join(outputDir, ".gitignore");
  let existing = "";
  try { existing = await readFile(gi, "utf8"); } catch { /* no .gitignore yet */ }
  const have = new Set(existing.split(/\r?\n/).map((l) => l.trim()).filter(Boolean));
  const toAdd = entries.filter((e) => {
    const t = e.trim();
    if (!t) return false;
    if (t.startsWith("#")) return existing === "" || !existing.includes(t); // keep the header once
    return !have.has(t);
  });
  if (!toAdd.length) return;
  const prefix = existing === "" ? "" : (existing.endsWith("\n") ? "" : "\n");
  await writeFile(gi, existing + prefix + toAdd.join("\n") + "\n");
}

/** Rewrite a planRebuild build()'s bare *Paths filenames to absolute paths. */
function absolutizeBuild(build, outputDir) {
  const out = { ...build };
  for (const key of ["sourcesPaths", "binaryIncludePaths", "includePaths"]) {
    if (out[key]) {
      const m = {};
      for (const [virt, file] of Object.entries(out[key])) m[virt] = nodePath.join(outputDir, file);
      out[key] = m;
    }
  }
  if (out.linkerConfigPath) out.linkerConfigPath = nodePath.join(outputDir, out.linkerConfigPath);
  return out;
}

/** Human + agent readable rebuild instructions for a disassembled project. */
function renderBuildMd({ platform, romPath, outputDir, regions, blobs, build, verifiable, notes, allOk }) {
  const lines = [];
  lines.push(`# Rebuilding this ${platform} project`, "");
  lines.push(`Disassembled from \`${nodePath.basename(romPath)}\` by \`disasm({target:'project'})\`.`, "");
  lines.push("## Files", "");
  for (const r of regions) {
    lines.push(`- \`${r.file}\` — ${r.region}${r.kind === "data" ? " (data)" : ""}, byte-exact${r.roundTripOk === false ? " ⚠ round-trip FAILED" : ""}.`);
  }
  for (const b of blobs) lines.push(`- \`${b.file}\` — ${b.bytes} bytes of binary data (extracted from the ROM; do not hand-edit).`);
  lines.push("- `original.rom` — a verbatim copy of the source ROM (the rebuild template; do not edit). **Copyrighted ROM data — never commit it. A `.gitignore` excluding it (and ROM extensions) is written for you.**");
  lines.push("- `reassemble.json` — the region→offset manifest the one-call rebuild reads.");
  lines.push("- `.gitignore` — keeps `original.rom` + raw ROM files out of git (appended if you already had one).");
  if (build) lines.push("- `rebuild.json` — the alternate cc65-native `build()` args below.");
  lines.push("");

  // The UNIFORM one-call rebuild — available on EVERY platform.
  lines.push("## Rebuild (recommended — one call, all platforms)", "");
  lines.push("Rebuild this project into a **byte-identical** ROM in one call:", "");
  lines.push("```json", JSON.stringify({ output: "reassemble", platform, path: outputDir }, null, 2), "```", "");
  lines.push(
    "Pass these as the arguments to the `build` tool. It assembles each region `.asm` " +
    "and splices the result into a copy of `original.rom`, so the header, gaps, and pad " +
    "return verbatim. `byteExact:true` = the rebuild equals the original exactly. Edit a " +
    "region `.asm` first to make a change — a same-length edit rebuilds a modified ROM; a " +
    "length-changing edit is reported (splicing would shift every later byte).", "",
  );

  if (build) {
    lines.push("## Rebuild (alternate — cc65-native `build()`)", "");
    if (verifiable) {
      lines.push("This platform also has a native `build()` recipe that rebuilds byte-identical:", "");
    } else {
      lines.push("Alternate native `build()` recipe (see Notes — may need linker adjustments):", "");
    }
    lines.push("```json", JSON.stringify(build, null, 2), "```", "");
    lines.push("The same JSON is in `rebuild.json`.", "");
  }
  if (notes) lines.push("## Notes", "", notes, "");
  if (!allOk) lines.push("> ⚠ Some regions did not round-trip byte-exact as INSTRUCTIONS (they floored to `.byte` data, which is still byte-exact). The one-call rebuild above is unaffected.", "");
  return lines.join("\n") + "\n";
}

/**
 * target:'recompile' — NES (6502) → SNES (65816) static recompile (emit backend
 * phase 1). Reads the NES ROM's PRG, disassembles the reset routine with da65,
 * translates it to asar-ready 65816 (the 6502 logic runs in EMULATION mode), and
 * returns the main.asm + seam include + a residue report. Optionally writes the
 * sources to `outputDir`. Build the result with build({platform:'snes'}) and
 * verify it with frame({op:'sideBySide'}) against the original.
 *
 * v1 scope: NROM, documented 6502, the reset/boot routine. The PPU/APU seam is
 * stubbed (no real NES-PPU-on-SNES runtime yet) so the port boots + runs the
 * logic but renders blank — the runtime shim is a separate task.
 */
/**
 * target=pointerTable — STATIC decode of a jump/pointer table into an
 * index→handler map (+ optional reverse lookup). The static complement to the
 * LIVE resolveJumptable. Handles contiguous LE/BE tables, SPLIT lo/hi arrays at
 * two bases, and the 6502 RTS-trick (+1). Works on every platform with an address
 * mapper (nes/snes/sms/gg/gb/gbc/2600/7800/c64/genesis); banked carts honor `bank`.
 * The default endian follows the CPU (Genesis/m68k → BE; everything else → LE),
 * overridable via `endian`.
 */
/**
 * target='source' — return a cart's high-level SOURCE instead of a disassembly, for
 * platforms where the "cart" IS source (not machine code). Today: PICO-8 (.p8 = Lua +
 * data sections; .p8.png = the same cart embedded in a label PNG). This is the honest
 * "understand this cart" path for a Lua VM — there's no machine code to disassemble, so
 * we hand back the actual Lua the game runs, plus a map of the other sections.
 */
async function readCartSourceCore(args) {
  const romPath = requireRomPath(args);
  const fs = await import("node:fs/promises");
  const lower = romPath.toLowerCase();
  const isPng = lower.endsWith(".p8.png");
  const isP8 = lower.endsWith(".p8");
  if (!isP8 && !isPng && args.platform !== "pico8") {
    throw new Error(
      `disasm({target:'source'}) is for source-form carts (PICO-8 .p8/.p8.png). '${romPath}' isn't one. ` +
      `For machine-code ROMs use target:'rom'/'project'/'decompile'.`,
    );
  }
  if (isPng) {
    // A .p8.png embeds the cart in the PNG's low bits — decoding needs the FAKE-08 core.
    throw new Error(
      "disasm({target:'source'}): .p8.png carts store the source steganographically in the PNG — " +
      "load it (loadMedia({platform:'pico8'})) to run it; export the .p8 text form to read the Lua. " +
      "Pass a plain-text .p8 here to read its source directly.",
    );
  }
  const text = await fs.readFile(romPath, "utf8");
  // Split on __section__ markers, preserving order.
  const parts = text.split(/(^__[a-z]+__$)/m);
  const sections = {};
  let current = "(header)";
  let buf = [];
  const flush = () => { if (buf.length) sections[current] = buf.join("\n").replace(/^\n+|\n+$/g, ""); buf = []; };
  for (const chunk of parts) {
    const m = chunk.match(/^__([a-z]+)__$/);
    if (m) { flush(); current = m[1]; } else { buf.push(chunk); }
  }
  flush();
  return {
    platform: "pico8",
    kind: "source",
    format: ".p8",
    note: "PICO-8 carts are SOURCE, not machine code — this is the Lua the game runs (+ its data sections). There is no disassembly to do.",
    lua: sections.lua ?? "",
    sections: Object.keys(sections),
    // Include non-lua data sections so callers can see the full cart shape (gfx/map/sfx/music/gff/label).
    dataSections: Object.fromEntries(
      Object.entries(sections).filter(([k]) => k !== "lua" && k !== "(header)"),
    ),
  };
}

async function pointerTableCore(args) {
  const { platform, loBase, hiBase, count, convention = "direct", reverseHandler, bank } = args;
  if (loBase == null) throw new Error("disasm({target:'pointerTable'}): loBase (the table / low-byte base) is required.");
  if (count == null) throw new Error("disasm({target:'pointerTable'}): count (number of entries) is required.");
  const romPath = requireRomPath(args);
  const data = new Uint8Array(await readFile(romPath));
  const resolved = platform ?? (/\.nes$/i.test(romPath) ? "nes" : /\.(sfc|smc)$/i.test(romPath) ? "snes" : /\.gb$/i.test(romPath) ? "gb" : /\.sms$/i.test(romPath) ? "sms" : /\.(gen|md|bin)$/i.test(romPath) ? "genesis" : null);
  if (!resolved || !POINTER_TABLE_PLATFORMS.has(resolved)) {
    throw new Error(`disasm({target:'pointerTable'}): platform '${resolved ?? "unknown"}' has no static address mapper. Supported: ${[...POINTER_TABLE_PLATFORMS].join(", ")}. (msx/pce/lynx/gba: locate the table live with breakpoint({on:'jumptable'}).)`);
  }
  // CPU address → file offset via the platform mapper (banked-cart aware).
  const toOffset = (cpuAddr) => cpuAddrToFileOffset(resolved, data, cpuAddr, { bank });
  // Default endian follows the CPU's word order unless the caller overrides it.
  const endian = args.endian ?? (BIG_ENDIAN_TABLE_PLATFORMS.has(resolved) ? "BE" : "LE");
  const { entries, form } = decodePointerTable({ data, toOffset, count, loBase, hiBase, convention, endian });
  const fmt = (n) => "$" + (n & 0xffff).toString(16).toUpperCase().padStart(4, "0");
  const out = {
    platform: resolved,
    form,
    count,
    entries: entries.map((e) => ({ index: e.index, handler: fmt(e.handler), storedWord: fmt(e.storedWord) })),
  };
  if (reverseHandler != null) {
    const indices = reverseLookup(entries, reverseHandler);
    out.reverse = {
      handler: fmt(reverseHandler),
      indices,
      note: indices.length
        ? `dispatch index/indices ${indices.join(", ")} land on ${fmt(reverseHandler)}.`
        : `no table index reaches ${fmt(reverseHandler)} (check loBase/hiBase/count/convention, or it's reached another way).`,
    };
  }
  out.note = "index→handler decoded statically. For a SPLIT table pass loBase (low array) + hiBase (high array); for a contiguous `dw` table pass only loBase. convention:'rts+1' adds 1 (6502 RTS trick). reverseHandler answers 'which state triggers this routine?'. (For a COMPUTED dispatcher whose table you can't locate statically, use the live breakpoint({on:'jumptable'}).)";
  return out;
}

async function recompileCore(args) {
  const { platform } = args;
  const targetPlatform = args.targetPlatform || "snes";
  if (platform && platform !== "nes") {
    throw new Error(`disasm({target:'recompile'}): only NES source is supported today (got '${platform}'). The engine is generic (lift→IR→emit); other source lifters land as they're built.`);
  }
  // The generic engine targets any platform with a registered emitter. SNES is the
  // 1:1 emulation-mode path (with the PPU shim/runtime render layers); Genesis is a
  // real 6502→68000 LOGIC translation (presentation seam stubbed — verify with the
  // RAM-diff oracle, frame({op:'compareRam'})).
  const { supportedPairs } = await import("../../analysis/recompile/index.js");
  const validTargets = new Set(supportedPairs().filter((p) => p.startsWith("nes→")).map((p) => p.split("→")[1]));
  if (!validTargets.has(targetPlatform)) {
    throw new Error(`disasm({target:'recompile'}): no emitter for target '${targetPlatform}'. Supported NES→ targets: ${[...validTargets].join(", ")}.`);
  }
  const romPath = requireRomPath(args);
  const rom = new Uint8Array(await readFile(romPath));
  // iNES validation: "NES\x1a" magic, then a 16-byte header, then PRG. v1 handles
  // NROM (mapper 0, 16KB or 32KB PRG). Give size vs mapper their OWN errors so the
  // message is never misleading (a 24KB mapper-0 ROM isn't a "mapped cart").
  const hasInes = rom.length >= 16 && rom[0] === 0x4e && rom[1] === 0x45 && rom[2] === 0x53 && rom[3] === 0x1a;
  if (!hasInes) {
    throw new Error("disasm({target:'recompile'}): not an iNES file (missing 'NES\\x1a' magic). Phase 1 takes a raw .nes ROM.");
  }
  const mapper = (rom[6] >> 4) | (rom[7] & 0xf0);
  if (mapper !== 0) {
    throw new Error(`disasm({target:'recompile'}): mapper ${mapper} is not supported in phase 1 — only NROM (mapper 0). Bank-switched carts need the per-bank recompile path (not yet built).`);
  }
  const prgSize = rom.length - 16;
  if (prgSize !== 0x4000 && prgSize !== 0x8000) {
    throw new Error(`disasm({target:'recompile'}): expected an NROM PRG of 16KB or 32KB; got ${prgSize} bytes. Phase 1 handles only those two sizes.`);
  }
  const prg = rom.subarray(16, 16 + prgSize);
  const prgBase = prgSize === 0x4000 ? 0xC000 : 0x8000; // 16KB mirrors into $C000

  // Disassemble from the REAL reset vector, not blindly from the PRG base. The
  // reset routine lives wherever $FFFC/$FFFD point — often deep in PRG, with data
  // or padding ($00 = brk) at the base. Starting at the base translated that
  // padding as 6 garbage `brk`s; starting at the reset vector yields the actual
  // boot routine (robotfindskitten: 6-instr-garbage → 70-instr clean, 0 residue).
  const resetVec = prg[prg.length - 4] | (prg[prg.length - 3] << 8);
  const resetOff = resetVec - prgBase;
  if (resetOff < 0 || resetOff >= prg.length) {
    throw new Error(`disasm({target:'recompile'}): reset vector $${resetVec.toString(16)} is outside the PRG window ($${prgBase.toString(16)}-$FFFF). Corrupt ROM or unexpected layout.`);
  }
  // Slice the PRG at the reset vector so da65 starts decoding real code there.
  const codeBytes = prg.subarray(resetOff);
  const { runDa65 } = await import("../../toolchains/cc65/da65.js");
  const da = await runDa65({ bytes: codeBytes, cpu: "6502", startAddress: resetVec, options: ["--comments", "4"] });
  const da65Full = da.asm ?? "";
  // Slice the first routine (the reset path) — a flat disasm renders data tables
  // after it as bogus code. Phase 1 = the boot routine.
  const da65Asm = sliceFirstRoutine(da65Full);

  // Optional NES-PPU-on-SNES shim: boot the original ROM, read its PPU state,
  // convert tiles/nametable/palette to SNES formats, and emit a shim that draws
  // that static boot picture.
  //
  // STATUS (WORKING, default OFF): the JS-side conversion (NES 2bpp→SNES 4bpp
  // tiles, NES palette→BGR555 CGRAM, nametable→tilemap) is correct and
  // unit-tested, and the emitted 65816 UPLOAD routine now DMAs all three to SNES
  // VRAM/CGRAM and turns the screen on — verified end-to-end on snes9x
  // (test/recompile-shim-render.test.js). It is still OFF by default because
  // phase 1 only draws the STATIC first screen: after the shim, the recompiled
  // NES logic runs against a STUBBED PPU seam, so animation/scroll/sprites are
  // not maintained (the next layer). Opt in with withShim:true for the static
  // boot picture. (frame compareRender/findDiverge are the oracles to debug it.)
  // The phase-2 runtime (withRuntime) implies the shim (it needs the BG + tiles
  // the shim uploads); enabling it turns the static port into a LIVE one (sprites
  // animate each vblank, the game's NMI runs). withShim alone is the static path.
  // The PPU shim/runtime are NES-PPU-on-SNES render layers — SNES target only. A
  // Genesis (or other) target is a LOGIC port (presentation seam stubbed); verify
  // it with the RAM-diff oracle, not a rendered screen.
  const snesTarget = targetPlatform === "snes";
  const wantRuntime = snesTarget && args.withRuntime === true;
  const wantShim = snesTarget && (args.withShim === true || wantRuntime);
  let shimAsm = null;
  let shimInfo = null;
  if (wantShim) {
    try {
      shimInfo = await buildNesPpuShim(rom);
      shimAsm = shimInfo.asm;
    } catch (e) {
      shimInfo = { error: e.message };
    }
  }

  // Phase-2 runtime: disassemble the NES NMI handler ($FFFA) so the runtime's
  // vblank handler can call the game's own per-frame logic, and emit the runtime.
  let runtimeAsm = null;
  let nmiDa65Asm = null;
  let nmiInfo = null;
  if (wantRuntime) {
    try {
      const nmiVec = prg[prg.length - 6] | (prg[prg.length - 5] << 8);
      const nmiOff = nmiVec - prgBase;
      let nesNmiLabel = null;
      if (nmiOff >= 0 && nmiOff < prg.length && nmiVec !== resetVec) {
        const nmiDa = await runDa65({ bytes: prg.subarray(nmiOff), cpu: "6502", startAddress: nmiVec, options: ["--comments", "4"] });
        nmiDa65Asm = sliceFirstRoutine(nmiDa.asm ?? "");
        // The translated NMI's entry label (derive it the same way the recompiler
        // will) so the runtime calls the right routine.
        const { entry: ne } = recompileNesToSnes(nmiDa65Asm, { stubUndefined: false });
        nesNmiLabel = ne === "RECOMPILE_ENTRY" ? "RECOMPILE_NMI_ENTRY" : ne;
      }
      const { emitPpuRuntime } = await import("../../analysis/nes-ppu-runtime.js");
      runtimeAsm = emitPpuRuntime({ nesNmiLabel });
      nmiInfo = { nmiVector: "$" + nmiVec.toString(16).toUpperCase().padStart(4, "0"), gameNmi: nesNmiLabel };
    } catch (e) {
      nmiInfo = { error: e.message };
    }
  }

  const { recompile } = await import("../../analysis/recompile/index.js");
  const { mainAsm, seamAsm, seamFile, residue, entry, nmiEntry, instrCount, seamCount, stubbed, targetIsa } =
    recompile(da65Asm, {
      source: "nes",
      target: targetPlatform,
      withShim: !!shimAsm,
      withRuntime: !!runtimeAsm,
      nmiSourceAsm: nmiDa65Asm,
    });

  const runtimeOn = !!runtimeAsm;
  let written = null;
  if (args.outputDir) {
    await mkdir(args.outputDir, { recursive: true });
    const mainPath = nodePath.join(args.outputDir, "main.asm");
    await writeFile(mainPath, mainAsm);
    written = { mainAsm: mainPath };
    // The phase-2 runtime supplies its own seam; the phase-1 path uses nes_seam.
    if (runtimeOn) {
      const rtPath = nodePath.join(args.outputDir, "nes_ppu_runtime.asm");
      await writeFile(rtPath, runtimeAsm);
      written.runtimeAsm = rtPath;
    } else {
      const seamPath = nodePath.join(args.outputDir, seamFile);
      await writeFile(seamPath, seamAsm);
      written.seamAsm = seamPath;
    }
    if (shimAsm) {
      const shimPath = nodePath.join(args.outputDir, "nes_ppu_shim.asm");
      await writeFile(shimPath, shimAsm);
      written.shimAsm = shimPath;
    }
  }

  const shimDrawn = !!shimAsm;
  return jsonContent({
    ok: true,
    source: "nes", target: targetPlatform, targetIsa,
    resetVector: "$" + resetVec.toString(16).toUpperCase().padStart(4, "0"),
    entry,
    ...(runtimeOn ? { nmiEntry, nmi: nmiInfo } : {}),
    instrCount, seamCount,
    stubbedCallees: stubbed,
    residue,
    ...(snesTarget ? {
      shim: shimDrawn
        ? { applied: true, phase: runtimeOn ? "live-background" : "static-boot-picture", tiles: shimInfo.tileCount, note: "Emitted the NES-PPU-on-SNES shim (converted tiles/nametable/palette → VRAM/CGRAM, BG1 on). It draws the original ROM's boot screen background." }
        : { applied: false, reason: shimInfo?.error || "withShim not set (default off)", note: "No PPU shim — the port runs the logic but renders blank. Pass withShim:true (static) or withRuntime:true (live) to draw the original ROM's picture on SNES." },
      runtime: runtimeOn
        ? { applied: true, phase: "live-sprites", gameNmi: nmiInfo?.gameNmi || null, note: "PHASE 2: the per-frame runtime is wired — each vblank it flushes the game's shadow OAM to SNES sprites and runs the game's NMI handler, so sprites ANIMATE (not a static screenshot). Background is from the shim; live nametable streaming is phase 3. Build all emitted files together with build({platform:'snes'})." }
        : { applied: false, note: "Static port (no per-frame runtime). Pass withRuntime:true to animate sprites + run the game's NMI each vblank." },
    } : {
      port: { kind: "logic-recompile", targetIsa, note: `LOGIC port: the NES 6502 was TRANSLATED to ${targetIsa} (not emulated) — game logic runs, the PPU/APU presentation seam is STUBBED. Build with the platform's toolchain, then VERIFY with the RAM-diff oracle: load the original NES ROM and this port side by side and frame({op:'compareRam'}) the work-RAM mirror. Presentation (a ${targetPlatform} render runtime) is a separate layer.` },
    }),
    note:
      `Recompiled the NES reset${runtimeOn ? " + NMI" : ""} routine(s) to ${targetIsa}. ${instrCount} instrs, ${seamCount} PPU/APU seam calls, ` +
      `${stubbed.length} callee(s) stubbed (isolation), ${residue.length} residue line(s). ` +
      (snesTarget
        ? (runtimeOn
          ? "PHASE 2: the 6502 logic runs in emulation mode; the runtime flushes sprites + runs the game NMI every vblank, and the shim draws the BG — so the port is LIVE (sprites move). "
          : shimDrawn
            ? `The 6502 logic runs in 65816 EMULATION mode; the shim draws the converted static boot picture (${shimInfo.tileCount} tiles). `
            : "The 6502 logic runs in 65816 EMULATION mode; the hardware seam is STUBBED so the port renders blank. ")
        : `The 6502 logic is TRANSLATED to ${targetIsa} (real ISA translation, not emulation); the PPU/APU seam is STUBBED so it's a LOGIC port — verify with frame({op:'compareRam'}) vs the NES original. `) +
      (written
        ? `Wrote ${Object.values(written).join(" + ")}. Build with the ${targetPlatform} toolchain; then loadMedia + frame({op:'compareRam'}) vs the NES original.`
        : `Pass outputDir to write the .asm files to disk for build({platform:'${targetPlatform}'}).`),
    ...(written ? { written } : { mainAsm, ...(runtimeOn ? { runtimeAsm } : { seamAsm }), ...(shimAsm ? { shimAsm } : {}) }),
  });
}

/**
 * Boot a NES ROM in a throwaway host, read its PPU state after boot, and build
 * the NES-PPU-on-SNES shim (converted tiles/nametable/palette + the DMA
 * routine). Returns { asm, tileCount }. Throws if the core/regions are
 * unavailable.
 * @param {Uint8Array} romBytes  full iNES file
 */
async function buildNesPpuShim(romBytes) {
  const { resolveCore } = await import("../../cores/registry.js");
  const { LibretroHost } = await import("../../host/index.js");
  const { buildSnesAssets, emitPpuShim } = await import("../../analysis/nes-ppu-shim.js");
  const core = resolveCore("nes");
  if (!core) throw new Error("NES core unavailable for shim boot");
  const host = new LibretroHost();
  try {
    await host.loadCore(core.jsPath, core.wasmPath);
    await host.loadMedia({ platform: "nes", bytes: romBytes, virtualName: "/rom.nes" });
    // Boot long enough for the game to finish its initial PPU upload.
    host.stepFrames(120);
    const chr = host.readMemory("nes_chr", 0, Math.min(0x2000, host.regionSize("nes_chr") || 0x2000));
    const nt = host.readMemory("nes_nametables", 0, 0x400); // first nametable: 960 tiles + 64 attr
    const pal = host.readMemory("nes_palette", 0, 32);
    const assets = buildSnesAssets({ chr, nametable: nt, palette: pal });
    return { asm: emitPpuShim(assets), tileCount: assets.tileCount };
  } finally {
    try { host.unloadMedia(); } catch { /* best-effort */ }
  }
}

export function registerDisasmTools(server, z) {
  server.tool(
    "disasm",
    "Disassemble code — raw bytes, a whole ROM (mapper-aware), a full re-buildable project, or find references to " +
    "an address. `target`: 'bytes' | 'rom' | 'project' | 'references'.\n" +
    "'bytes' = RAW da65 over a chunk (path/base64), 6502-family CPU via `cpu`; emits `.org` so it re-assembles.\n" +
    "'rom' = mapper-aware ROM disassembly with agent annotations: auto-tagged reset/nmi/irq vectors, hardware " +
    "register names on operands, per-line `; @0xNNNN` file offsets ready for romPatch (NES reports .nes AND PRG " +
    "offsets). Platform sniffed from extension. GBA=ARM7TDMI (ARM by default, `thumb:true` for Thumb). Use " +
    "`endAddress`/`untilReturn` for one routine, `dataRanges` to mark non-code, `bank` for a banked slot. " +
    "pce/msx are 'project'-only here — 'rom' doesn't map them yet.\n" +
    "'project' = turn a ROM into a complete re-buildable disassembly in one call across all systems; splits into " +
    "regions (PER-BANK on every banked format: NES mappers, SNES LoROM, GB MBC, Sega-mapper SMS/GG, MSX megaROM, " +
    "2600 F8/F6/F4, 7800 SuperGame, >32KB HuCards), REASSEMBLES each and verifies BYTE-EXACT (`roundTripOk`); " +
    "non-faithful lines fall back to `.byte` so it ALWAYS rebuilds; `readablePercent` reports instruction-vs-data (a uniform-FILL " +
    "bank — all $FF/$00 padding — reports `readablePercent:null` + `fill:true`, NOT a bogus 100%). Also writes a `.gitignore` " +
    "so the kept `original.rom` (copyrighted ROM data) can't be committed. **LARGE ROM (≥512KB, e.g. a 1MB SNES cart)? Pass " +
    "`background:true`** — the reassemble can take minutes and would time out the call; you get a `{jobId}` immediately, then poll " +
    "`disasm({target:'project', job, outputDir})` (reports `regionsDone/regionsTotal`, then the full result when `status:'done'`). " +
    "REBUILD (one call, ALL 15 classic platforms): `build({output:'reassemble', platform, path})` turns the project " +
    "dir back into a BYTE-IDENTICAL ROM — it assembles each region + splices them into the kept `original.rom` " +
    "(header/gaps/pad verbatim). Edit a region `.asm` first for a change: a same-length edit rebuilds a modified " +
    "ROM (`byteExact:false`), a length-changing edit is refused. NES/C64/7800/Lynx/PCE ALSO ship a cc65-native " +
    "one-call `build({output:'rom'})` recipe in rebuild.json (flat AND banked). (SNES 65816 usually lands at the " +
    "byte-exact data-only floor — its `.a8/.i8` width state desyncs when instructions and pinned `.byte` mix; the " +
    "reassemble rebuild is byte-identical regardless of readability.)\n" +
    "'references' = scan a ROM's code for operands matching a CPU `address` and classify each (call/jump/branch/" +
    "read/write); also walks the vector table. Banked carts are scanned PER BANK (all of the formats above) — " +
    "refs carry `prgBank` (NES) / `romBank` (everything else). LIMITATION: direct addressing only " +
    "(indirect/computed jumps are missed).\n" +
    "── RE ENGINE (Rizin + Ghidra, all platforms incl. the 3D CPUs: MIPS R3000/R4300 + SH-4) ──\n" +
    "'functions' = Rizin auto-detected function list {address,size,nbbs,cc,callers,callees,looksLikeData}; the " +
    "structural map of an unknown ROM. Sorted REAL CODE FIRST (by nbbs/cc) — don't rank by `size`, which is a lie " +
    "(rizin folds data tables into giant pseudo-functions). `looksLikeData:true` (and the top-level `dataCount`) flags " +
    "those data-folds so you don't waste a decompile on a graphics blob. " +
    "'cfg' = basic-block control-flow graph of the function at `address` (nodes + typed edges: " +
    "jump/branch_true/branch_false). 'xrefs' = every cross-reference TO `address`, following Rizin's analysis graph " +
    "(DEEPER than 'references', which is a flat da65 operand scan — prefer 'xrefs' once you've run a function pass, " +
    "'references' for a quick header-less operand sweep). Typical RE loop: 'functions' to carve → 'cfg'/'xrefs' to " +
    "trace → then the live tools (memory search, write-breakpoints, watch copy) to LABEL what you carved.\n" +
    "'decompile' = Ghidra C-like PSEUDOCODE for the function at `address`, with the decompiler's own WARNINGs and a " +
    "`qualityNote`. Hardware-register MMIO is NAMED in the output (e.g. `PPUMASK = 0x1e;` not `*0x2001 = 0x1e;`) " +
    "with a `/* hw registers: … */` legend at the top listing each substitution — on platforms with a register map " +
    "(NES/SNES/Genesis/GB/GBC/SMS/GG/2600/7800/C64). On the 6502 family (NES/2600/7800/C64/Lynx/PCE) a 6502-fold pass also " +
    "cleans the SLEIGH clutter: width types become C99 stdint (uint1→uint8_t, uint2→uint16_t), redundant nested width " +
    "casts collapse, and zero-page byte refs are named zp_XX — a `/* 6502 fold: … */` legend notes what was applied. ALTITUDE RULE: decompile is for UNDERSTANDING (and as a port spec when retargeting to a bigger " +
    "machine) — it is NOT the same-platform edit path. To CHANGE a ROM and rebuild it, use target:'project' " +
    "(byte-exact rebuildable asm); read the pseudocode as documentation alongside it. Per-CPU quality (calibrate, " +
    "don't treat low quality as a bug): ARM/GBA + M68K/Genesis = excellent (mostly-C games, real stack frames); " +
    "SM83/GB + Z80/SMS/GG/MSX = good; 65816/SNES + HuC6280/PCE = medium; 6502 family (NES/2600/7800/C64/Lynx) = " +
    "rough — carry-flag idioms and 16-bit math on an 8-bit CPU decompile to noise that only reads cleanly once an " +
    "LLM folds it. `address` for all four comes from target:'functions' (a CPU/virtual address; the file-offset " +
    "mapping is handled for you).",
    {
      target: z.enum(["bytes", "rom", "project", "references", "cfg", "xrefs", "functions", "decompile", "source", "resolveJumptable", "pointerTable", "recompile"]).describe("bytes = raw chunk; rom = mapper-aware ROM; project = full rebuildable disasm; references = flat da65 operand-refs to an address; functions/cfg/xrefs = Rizin RE engine (function list / control-flow graph / deep graph xrefs); decompile = Ghidra C pseudocode; resolveJumptable = recover a computed-jump dispatcher's targets (LIVE — redirects to breakpoint({on:'jumptable'}), which runs the emulator and records the real switch arms a static decompiler can't follow); recompile = EMIT backend — statically recompile a NES ROM's reset routine to SNES 65816 asar source that builds + boots (phase 1: NROM, 6502→65816 emulation mode, PPU/APU seam STUBBED). See the tool description for the RE loop + the decompile altitude rule + per-CPU quality (all 14 platforms)."),
      // shared
      path: z.string().optional().describe("target=bytes: raw binary path. target=rom/project/references: ROM file path."),
      base64: z.string().optional().describe("target=bytes: base64 of the bytes (OR `path`)."),
      platform: z.enum(["nes", "snes", "sms", "gg", "gb", "gbc", "atari2600", "atari7800", "c64", "genesis", "gba", "pce", "msx", "lynx", "pico8"]).optional().describe("target=rom/project/references: override platform (else sniffed from extension). target=source: pico8 (.p8 carts are Lua source)."),
      startAddress: z.number().int().min(0).max(0xffffffff).default(0x8000).describe("target=bytes/rom: address of the first byte (GBA auto-bumped to 0x08000000)."),
      length: z.number().int().min(1).max(65536).optional().describe("target=rom: bytes to disassemble (default 256; mutually exclusive with endAddress)."),
      addOrigin: z.boolean().default(true).describe("target=bytes/rom: prepend `.org` so the asm re-assembles through ca65."),
      outputPath: z.string().optional().describe("target=bytes/rom: write asm to disk and return {path}; required for bytes unless inline:true."),
      inline: z.boolean().default(false).describe("target=bytes: return asm in the response instead of writing to disk."),
      // bytes
      cpu: z.enum(["6502", "65c02", "65sc02", "65816", "huc6280"]).default("6502").describe("target=bytes: CPU dialect for da65."),
      symbolsPath: z.string().optional().describe("target=bytes: symbol file to annotate with labels (asar/WLA .sym or cc65 .lbl)."),
      symbolsText: z.string().optional().describe("target=bytes: inline symbol-file text."),
      symbolsFormat: z.enum(["wla", "cc65-lbl"]).optional().describe("target=bytes: explicit symbol-file format override."),
      // rom
      bank: z.number().int().min(0).max(255).optional().describe("target=rom / pointerTable: switchable ROM bank to map into the windowed slot. NES (mapper>0, $8000), GB/GBC ($4000), SMS/GG (Sega-mapper slot 2, $8000), Atari 2600/7800 (SuperGame $8000). SNES: the bank IS the address high byte — pass either a full 24-bit startAddress ($02AF86) OR a bank-local address + bank:2 (composed to $02AF86 internally); both map correctly. Flat platforms (Genesis/GBA/Lynx/C64) have no cart banking — a non-zero `bank` is REJECTED, never silently applied to bank 0."),
      thumb: z.boolean().default(false).describe("target=rom: GBA — disassemble as THUMB (16-bit) instead of ARM."),
      endAddress: z.number().int().min(0).max(0xffffff).optional().describe("target=rom: CPU end address (inclusive); alternative to length."),
      untilReturn: z.boolean().default(false).describe("target=rom: stop at the first return/unconditional-jump (rts/rti/rtl/jmp, or ret/reti/jp per CPU) — grab one routine."),
      mapper: z.enum(["lorom", "hirom"]).optional().describe("target=rom/references: SNES mapper override (header-less homebrew defaults lorom)."),
      dataRanges: z.array(z.object({
        start: z.number().int().min(0).max(0xffffff),
        length: z.number().int().min(1),
      })).optional().describe("target=rom: address ranges to emit as `.byte` data instead of code."),
      autoLabelVectors: z.boolean().default(true).describe("target=rom: pre-seed reset/nmi/irq labels from the vector table."),
      annotateRegisters: z.boolean().default(true).describe("target=rom: append `; PPUMASK` etc. to operands hitting a known hardware register."),
      annotateFileOffsets: z.boolean().default(true).describe("target=rom: append `; @0xNNNN` file offset to every line (for romPatch)."),
      // project
      outputDir: z.string().optional().describe("target=project: directory to write the project into (one .asm per region). target=recompile: directory to write main.asm + nes_seam.asm for build({platform:'snes'})."),
      background: z.boolean().default(false).describe("target=project: run the disassembly in the BACKGROUND and return IMMEDIATELY with a {jobId} instead of blocking. Use this for LARGE ROMs (≥512KB — a multi-bank SNES/Genesis cart) where the full reassemble can take minutes and would otherwise time out the tool call. Poll with disasm({target:'project', job:'<jobId>', outputDir}) until status is 'done' (or 'error'); the final poll returns the same payload the synchronous call would have. Small ROMs don't need this — they finish well within the call."),
      job: z.string().optional().describe("target=project: poll a background job started with background:true. Pass the jobId you got back (and the same outputDir). Returns {status:'running', regionsDone, regionsTotal} while working, or the full completion payload once status is 'done'. On 'error' the failure reason is included."),
      targetPlatform: z.string().optional().describe("target=recompile: the platform to EMIT (default 'snes'). The engine is generic (lift source→IR→emit target): 'snes' = 1:1 emulation-mode port with the PPU render layers (withShim/withRuntime); 'genesis' = real 6502→68000 LOGIC translation (presentation stubbed, verify with frame({op:'compareRam'})). Source `platform` is 'nes' today; more source lifters land as built."),
      withShim: z.boolean().default(false).describe("target=recompile: phase-1 STATIC render (default off). Emit the NES-PPU-on-SNES shim — boots the original ROM, converts its tiles/nametable/palette to SNES VRAM/CGRAM data + a 65816 upload routine that draws the original's STATIC boot screen on SNES (verified on snes9x). Draws the first screen only; sprites don't animate. For a LIVE port use withRuntime instead."),
      withRuntime: z.boolean().default(false).describe("target=recompile: phase-2 LIVE render (default off). Implies withShim (BG) and adds the per-frame runtime: each vblank it flushes the game's shadow OAM to SNES sprites and runs the game's own NMI handler, so SPRITES ANIMATE and the game's per-frame logic runs — the port plays, not just boots to a screenshot. Background is static from the shim; live nametable/scroll streaming is phase 3. Verified on snes9x."),
      // references / cfg / xrefs
      address: z.number().int().min(0).max(0xFFFFFFFF).optional().describe("target=references: CPU address to find references TO. target=cfg: address inside the function to graph. target=xrefs: address to find cross-references TO. target=decompile: address of the function to decompile (use an address from target='functions')."),
      maxRefsReturned: z.number().int().min(1).max(2048).default(256).describe("target=references: cap the references returned."),
      includeTableHits: z.boolean().default(false).describe("target=references: also scan the raw ROM for the address as a 16-bit POINTER (LE/BE, + the 6502 RTS-trick addr-1) — finds inline jump-table / trampoline call sites that no jsr/jmp/branch names. Auto-on when no direct refs are found; set true to get tableHits alongside direct refs too."),
      // target=pointerTable
      loBase: z.number().int().min(0).max(0xFFFFFF).optional().describe("target=pointerTable: CPU address of the table (contiguous form) OR the LOW-byte array (split form). Required."),
      hiBase: z.number().int().min(0).max(0xFFFFFF).optional().describe("target=pointerTable: CPU address of the HIGH-byte array (SPLIT lo/hi form). Omit for a contiguous `dw` table (hi byte follows each lo byte)."),
      count: z.number().int().min(1).max(4096).optional().describe("target=pointerTable: number of entries to decode."),
      convention: z.enum(["direct", "rts+1"]).default("direct").describe("target=pointerTable: 'direct' = the stored word IS the handler; 'rts+1' = the 6502 RTS-trick (table holds handler-1; +1 is applied)."),
      endian: z.enum(["LE", "BE"]).optional().describe("target=pointerTable: byte order of the CONTIGUOUS form (split lo/hi ignores this). Default follows the CPU — Genesis/m68k is BE, everything else LE; override only if a table is stored against type."),
      reverseHandler: z.number().int().min(0).max(0xFFFF).optional().describe("target=pointerTable: also report which dispatch INDEX/indices land on this handler address (reverse lookup — 'what state triggers this routine?')."),
    },
    safeTool(async (args) => {
      switch (args.target) {
        case "bytes":      return await disassembleCore(args);
        case "rom":        return await disassembleRomCore(args);
        case "project":    return await disassembleProjectCore(args);
        case "references": return jsonContent(await findReferencesCore(args));
        case "cfg":        return jsonContent(await analyzeCfg(requireRomPath(args), args.address, args.platform));
        case "xrefs":      return jsonContent(await analyzeXrefs(requireRomPath(args), args.address, args.platform));
        case "functions":  return jsonContent(await analyzeFunctions(requireRomPath(args), args.platform));
        case "decompile":  return jsonContent(await analyzeDecompile(requireRomPath(args), args.address, args.platform));
        case "source":     return jsonContent(await readCartSourceCore(args));
        case "recompile":  return await recompileCore(args);
        case "pointerTable": return jsonContent(await pointerTableCore(args));
        case "resolveJumptable":
          // A4: jumptable recovery is fundamentally a LIVE operation (it needs a
          // running emulator to observe the computed targets) — disasm is static
          // ROM analysis with no session. Redirect to the live op rather than
          // silently doing nothing.
          return jsonContent({
            live: true,
            redirect: "breakpoint({on:'jumptable'})",
            address: args.address != null ? "$" + (args.address >>> 0).toString(16).toUpperCase() : null,
            note: "Computed-jumptable recovery is LIVE, not static: it breaks at the dispatcher in a RUNNING emulator, single-steps through the indirect JMP (table,X)/RTS-trick, and records the targets it actually lands on. Load the ROM (playtest/loadMedia), drive it to the state that runs the dispatcher, then call breakpoint({on:'jumptable', address" +
              (args.address != null ? `: ${args.address}` : "") + "}). That returns the distinct computed targets; decompile({address: target}) each to read the switch arms. No static-only tool can do this — it needs the live emulator.",
          });
        default: throw new Error(`disasm: unknown target '${args.target}'`);
      }
    }),
  );
}

/** Trim a long trailing run of a single pad byte ($00 or $FF) from a flat ROM
 *  region so we don't disassemble megabytes of padding. Keeps everything up to
 *  the last non-pad byte (rounded up a little for alignment). */
function trimTrailingPad(bytes) {
  let end = bytes.length;
  while (end > 0 && (bytes[end - 1] === 0x00 || bytes[end - 1] === 0xFF)) end--;
  // keep a tiny tail so a final real instruction isn't clipped; align to 16.
  end = Math.min(bytes.length, (end + 16) & ~0xF);
  return end < bytes.length ? bytes.slice(0, end) : bytes;
}

/** Emit a known-data region as a clean, byte-exact `.byte` dump (GAS/cc65 both
 *  accept `.byte` with `.org`). 16 bytes per line, with the address in a comment. */
// Emit a byte-exact `.byte` dump for a known-DATA region (e.g. a cartridge
// header). The syntax must match the platform's reassembler: ca65/vasm
// (6502/65816) take `$`-prefixed hex and a bare `.org $...`; GNU `as`
// (z80/sm83/m68k/arm) take `0x` hex and reject a `$` operand (`$2E` reads as an
// undefined symbol → the link fails). `family` comes from CPU_FAMILY; default to
// the ca65 form for the 6502 platforms that have used this path historically.
function dataRegionSource(bytes, startAddress, family = "6502") {
  const gnu = family === "z80" || family === "sm83" || family === "m68k" || family === "arm";
  const hex = (b) => (gnu ? "0x" : "$") + b.toString(16).padStart(2, "0").toUpperCase();
  const org = gnu
    ? `\t.org 0x${startAddress.toString(16).toUpperCase()}`
    : `\t.org $${startAddress.toString(16).toUpperCase()}`;
  const rows = [org];
  for (let i = 0; i < bytes.length; i += 16) {
    const slice = Array.from(bytes.slice(i, i + 16));
    rows.push(
      "\t.byte " + slice.map(hex).join(",") +
      `\t; ${(startAddress + i).toString(16).toUpperCase().padStart(6, "0")}`
    );
  }
  return rows.join("\n") + "\n";
}

/** Sniff a platform from a ROM file extension (disassembleProject). */
function sniffPlatformFromPath(p) {
  if (/\.nes$/i.test(p)) return "nes";
  if (/\.(sfc|smc)$/i.test(p)) return "snes";
  if (/\.gbc$/i.test(p)) return "gbc";
  if (/\.gb$/i.test(p)) return "gb";
  if (/\.sms$/i.test(p)) return "sms";
  if (/\.gg$/i.test(p)) return "gg";
  if (/\.a26$/i.test(p)) return "atari2600";
  if (/\.a78$/i.test(p)) return "atari7800";
  if (/\.prg$/i.test(p)) return "c64";
  if (/\.(lnx|lyx)$/i.test(p)) return "lynx";
  if (/\.gba$/i.test(p)) return "gba";
  if (/\.gtr$/i.test(p)) return "gametank";
  if (/\.(z64|n64|v64)$/i.test(p)) return "n64";
  if (/\.(psexe|psx)$/i.test(p)) return "ps1"; // .exe/.bin are ambiguous — pass platform explicitly
  if (/\.(gen|md|bin)$/i.test(p)) return "genesis";
  return null;
}

/**
 * Plan the disassembly regions for a ROM. Banked NES → one region per 16KB PRG
 * bank (switchable at $8000, fixed top at $C000). Everything else → one region
 * covering the code body at its load address. Each region:
 *   { name, file, bytes, startAddress, fileOffset, label }
 */
function planRegions(platform, data) {
  const regions = [];
  if (platform === "nes") {
    if (data[0] !== 0x4e || data[1] !== 0x45 || data[2] !== 0x53 || data[3] !== 0x1a) {
      throw new Error("disassembleProject: not a valid iNES (.nes) file.");
    }
    const prgSize = data[4] * 16384;
    const numBanks = prgSize >> 14;
    const PRG = 16;
    for (let b = 0; b < numBanks; b++) {
      const isFixedTop = b === numBanks - 1 && numBanks > 1;
      const org = isFixedTop ? 0xC000 : 0x8000;
      const fileOffset = PRG + b * 16384;
      regions.push({
        name: `bank${b}`, file: `bank${b}.asm`,
        bytes: data.slice(fileOffset, fileOffset + 16384),
        startAddress: org, fileOffset,
        label: `bank ${b}${isFixedTop ? " (fixed $C000)" : " (switchable $8000)"}`,
      });
    }
    return regions;
  }
  if (platform === "snes") {
    // LoROM: 32KB banks each mapped at $8000. One region per 32KB chunk.
    const hasHeader = (data.length % 1024) === 512; // 512-byte copier header
    const base = hasHeader ? 512 : 0;
    const body = data.subarray(base);
    const BANK = 0x8000;
    for (let off = 0; off < body.length; off += BANK) {
      const idx = off / BANK;
      regions.push({
        name: `bank${idx}`, file: `bank${idx}.asm`,
        bytes: body.slice(off, off + BANK),
        startAddress: 0x8000, fileOffset: base + off,
        label: `LoROM bank ${idx}`,
      });
    }
    return regions;
  }
  if (platform === "gb" || platform === "gbc") {
    // 16KB banks; bank 0 fixed at $0000, banks 1+ at $4000.
    const BANK = 0x4000;
    for (let off = 0; off < data.length; off += BANK) {
      const idx = off / BANK;
      regions.push({
        name: `bank${idx}`, file: `bank${idx}.asm`,
        bytes: data.slice(off, off + BANK),
        startAddress: idx === 0 ? 0x0000 : 0x4000, fileOffset: off,
        label: `ROM bank ${idx}${idx === 0 ? " ($0000)" : " ($4000)"}`,
      });
    }
    return regions;
  }
  if (platform === "sms" || platform === "gg") {
    // Z80 mapped at $0000. ≤48KB fits the three slots flat — one region.
    // Bigger carts use the Sega mapper: 16KB banks, banks 0-1 fixed in slots
    // 0-1 ($0000/$4000), banks 2+ page into slot 2 ($8000) — one region per
    // bank so instructions never straddle a bank edge and every bank gets a
    // correct base address.
    if (data.length <= 0xC000) {
      regions.push({ name: "rom", file: "rom.asm", bytes: trimTrailingPad(data.slice(0)), startAddress: 0x0000, fileOffset: 0, label: "ROM ($0000)" });
      return regions;
    }
    const BANK = 0x4000;
    for (let off = 0; off < data.length; off += BANK) {
      const idx = off / BANK;
      const org = idx === 0 ? 0x0000 : idx === 1 ? 0x4000 : 0x8000;
      regions.push({
        name: `bank${idx}`, file: `bank${idx}.asm`,
        bytes: data.slice(off, off + BANK),
        startAddress: org, fileOffset: off,
        label: `Sega-mapper bank ${idx}${idx < 2 ? ` (fixed $${org.toString(16).toUpperCase()})` : " (slot 2, $8000)"}`,
      });
    }
    return regions;
  }
  if (platform === "genesis") {
    // 68k flat ROM at $000000; the reset PC is in the vector table. Disassemble
    // from the reset vector to end (the header + vectors before it are data),
    // trimming the trailing $00/$FF padding that fills a sized cart.
    const resetPc = (data[4] << 24 | data[5] << 16 | data[6] << 8 | data[7]) >>> 0;
    const start = (resetPc < data.length && resetPc >= 0x200) ? resetPc : 0x200;
    regions.push({ name: "rom", file: "rom.asm", bytes: trimTrailingPad(data.slice(start)), startAddress: start, fileOffset: start, label: `code from reset PC $${start.toString(16)}` });
    return regions;
  }
  if (platform === "c64") {
    const loadAddr = data[0] | (data[1] << 8);
    regions.push({ name: "prg", file: "prg.asm", bytes: data.slice(2), startAddress: loadAddr, fileOffset: 2, label: `PRG @ $${loadAddr.toString(16)}` });
    return regions;
  }
  if (platform === "atari2600") {
    // 4KB carts map flat at $F000. Banked carts (F8=8KB, F6=16KB, F4=32KB)
    // page 4KB banks into the SAME $F000 window — one region per bank.
    if (data.length <= 0x1000) {
      regions.push({ name: "rom", file: "rom.asm", bytes: data.slice(0), startAddress: 0xF000, fileOffset: 0, label: "4KB cart @ $F000" });
      return regions;
    }
    const BANK = 0x1000;
    for (let off = 0; off < data.length; off += BANK) {
      const idx = off / BANK;
      regions.push({
        name: `bank${idx}`, file: `bank${idx}.asm`,
        bytes: data.slice(off, off + BANK),
        startAddress: 0xF000, fileOffset: off,
        label: `banked cart 4KB bank ${idx} @ $F000`,
      });
    }
    return regions;
  }
  if (platform === "atari7800") {
    // ≤48KB carts map flat at the top of the address space. SuperGame banked
    // carts (>48KB) page 16KB banks into $8000-$BFFF with the LAST bank fixed
    // at $C000. A 128-byte .a78 header (magic "ATARI7800" at offset 1) is
    // split into its own data region so the cart banks stay 16KB-aligned.
    const hasA78 = data.length >= 17 &&
      String.fromCharCode(...data.subarray(1, 10)) === "ATARI7800";
    const base = hasA78 ? 128 : 0;
    const cartLen = data.length - base;
    if (cartLen <= 0xC000) {
      const org = 0x10000 - data.length; // header kept in-region (proven flat path)
      regions.push({ name: "rom", file: "rom.asm", bytes: data.slice(0), startAddress: org & 0xFFFF, fileOffset: 0, label: `cart @ $${(org & 0xFFFF).toString(16)}` });
      return regions;
    }
    if (hasA78) {
      regions.push({
        name: "a78_header", file: "a78_header.asm", bytes: data.slice(0, 128), kind: "data",
        startAddress: 0x0000, fileOffset: 0,
        label: ".a78 header (128 B data)",
      });
    }
    const BANK = 0x4000;
    const nBanks = Math.ceil(cartLen / BANK);
    for (let b = 0; b < nBanks; b++) {
      const isFixedTop = b === nBanks - 1;
      const org = isFixedTop ? 0xC000 : 0x8000;
      const fileOffset = base + b * BANK;
      regions.push({
        name: `bank${b}`, file: `bank${b}.asm`,
        bytes: data.slice(fileOffset, fileOffset + BANK),
        startAddress: org, fileOffset,
        label: `SuperGame bank ${b}${isFixedTop ? " (fixed $C000)" : " (switchable $8000)"}`,
      });
    }
    return regions;
  }
  if (platform === "lynx") {
    // The Lynx CPU is a 65C02 — the 6502-family da65/ca65 reassembly path
    // already handles it (CPU_FAMILY.lynx === "6502" in reassemble.js). A `.lnx`
    // file is a 64-byte LNX header ("LYNX" magic) followed by the raw cart
    // image; an unheadered `.o`/`.bin` is the image directly. Strip the header,
    // then disassemble the image as a flat 65C02 region.
    const hasLnxHeader = data.length >= 64 &&
      data[0] === 0x4c && data[1] === 0x59 && data[2] === 0x4e && data[3] === 0x58; // "LYNX"
    const base = hasLnxHeader ? 64 : 0;
    // Load address is loader-dependent on Lynx (the boot ROM copies the cart to
    // RAM); homebrew typically runs from $0200 up. We disassemble from $0200 and
    // LABEL it as an assumption so the user can re-org if their loader differs.
    const body = trimTrailingPad(data.slice(base));
    regions.push({
      name: "cart", file: "cart.asm", bytes: body,
      startAddress: 0x0200, fileOffset: base,
      label: `Lynx 65C02 cart @ $0200 (ASSUMED load addr — loader-dependent)${hasLnxHeader ? ", LNX header stripped" : ""}`,
    });
    return regions;
  }
  if (platform === "pce") {
    // PC Engine HuCard: the HuC6280 (65C02-family) image, banked in 8KB pages
    // via the MPRs. A 512-byte copier header (len % 1024 == 512) is split into
    // its own data region. NO trailing-pad trim — HuCard $FF padding is REAL
    // cart bytes and trimming it made the old rebuild lossy (the planner's own
    // notes flagged this as the fix needed).
    //   ≤32KB: flat at the top of the address space (vectors at $FFF6+ land
    //          correctly — the proven small-HuCard assumption).
    //   >32KB: one region per 8KB page; page 0 at $E000 (where MPR7 maps it
    //          at reset — the vectors live there), pages 1+ at $8000 (neutral
    //          window; bank registers decide at runtime).
    const hasCopier = (data.length % 1024) === 512;
    const base = hasCopier ? 512 : 0;
    if (hasCopier) {
      regions.push({
        name: "copier_header", file: "copier_header.asm", bytes: data.slice(0, 512), kind: "data",
        startAddress: 0x0000, fileOffset: 0,
        label: "512-byte copier header (data)",
      });
    }
    const body = data.subarray(base);
    if (body.length <= 0x8000) {
      const org = (0x10000 - body.length) & 0xffff;
      regions.push({
        name: "rom", file: "rom.asm", bytes: body.slice(0),
        startAddress: org, fileOffset: base,
        label: `HuCard @ $${org.toString(16)} (HuC6280)`,
      });
      return regions;
    }
    const PAGE = 0x2000;
    const nPages = Math.ceil(body.length / PAGE);
    for (let b = 0; b < nPages; b++) {
      const org = b === 0 ? 0xE000 : 0x8000;
      regions.push({
        name: `page${b}`, file: `page${b}.asm`,
        bytes: body.slice(b * PAGE, (b + 1) * PAGE),
        startAddress: org, fileOffset: base + b * PAGE,
        label: `HuCard 8KB page ${b}${b === 0 ? " (reset MPR7 → $E000, vectors)" : " ($8000 ASSUMED — MPRs map pages at runtime)"}`,
      });
    }
    return regions;
  }
  if (platform === "gametank") {
    // GameTank (Clyde Shaffer's open W65C02S console): a flat, size-keyed EEPROM
    // cart (default 32KB = EEPROM32K) mapped so the image ends at $FFFF — a 32KB
    // ROM spans $8000-$FFFF, with the 6-byte NMI/RESET/IRQ vector table at $FFFA.
    // One flat region at the top of the address space; the 65C02 rides the same
    // da65/ca65 6502-family path (--cpu 65c02). No trailing-pad trim: the cart is
    // exactly `size` bytes and the vectors + any pad are REAL bytes.
    const org = (0x10000 - data.length) & 0xffff;
    regions.push({
      name: "rom", file: "rom.asm", bytes: data.slice(0),
      startAddress: org, fileOffset: 0,
      label: `flat cart @ $${org.toString(16).toUpperCase()} (W65C02, vectors at $FFFA)`,
    });
    return regions;
  }
  if (platform === "msx") {
    // MSX cartridge maps at $4000-$BFFF; the 16-byte "AB" header at $4000 is
    // data (magic + INIT/STATEMENT/DEVICE/TEXT pointers), code follows.
    //   ≤32KB: skip the header, one flat region from $4010.
    //   >32KB (megaROM): 16KB banks via an ASCII16-style mapper — bank 0 at
    //   $4000 (header split out as a data region), banks 1+ at $8000.
    const hdr = data.length >= 2 && data[0] === 0x41 && data[1] === 0x42;
    const base = hdr ? 16 : 0;
    if (data.length <= 0x8000 + base) {
      regions.push({
        name: "rom", file: "rom.asm", bytes: trimTrailingPad(data.slice(base)),
        startAddress: 0x4000 + base, fileOffset: base,
        label: `cart @ $${(0x4000 + base).toString(16)} (Z80)`,
      });
      return regions;
    }
    if (hdr) {
      regions.push({
        name: "ab_header", file: "ab_header.asm", bytes: data.slice(0, 16), kind: "data",
        startAddress: 0x4000, fileOffset: 0,
        label: `"AB" cartridge header (16 B data @ $4000)`,
      });
    }
    const BANK = 0x4000;
    const nBanks = Math.ceil(data.length / BANK);
    for (let b = 0; b < nBanks; b++) {
      const skip = b === 0 ? base : 0;
      const org = b === 0 ? 0x4000 + base : 0x8000;
      regions.push({
        name: `bank${b}`, file: `bank${b}.asm`,
        bytes: data.slice(b * BANK + skip, (b + 1) * BANK),
        startAddress: org, fileOffset: b * BANK + skip,
        label: `megaROM 16KB bank ${b}${b === 0 ? ` ($${org.toString(16)})` : " ($8000 ASSUMED — mapper pages at runtime)"}`,
      });
    }
    return regions;
  }
  if (platform === "gba") {
    // GBA = ARM7TDMI. ROM maps flat at 0x08000000.
    //   0x000-0x0BF (192 B) = the cartridge HEADER (entry branch, Nintendo logo,
    //     title, checksums) — pure DATA. Disassembling it as code = garbage, so
    //     it's its own data-only region.
    //   0x0C0+ = code. Disassembled in ARM mode. HONEST CAVEAT: most GBA C code
    //     is compiled as THUMB (16-bit), which an ARM-mode disassembly decodes
    //     as garbage → it falls back to byte-exact `.byte` (low readability).
    //     Per-region ARM/Thumb mode-tracking isn't built yet (it's a real
    //     feature — the Thumb spans LOOK like valid ARM, including fake `bx`es,
    //     so naive mode-switch following is unreliable). To READ Thumb code use
    //     disassembleRom({platform:'gba', thumb:true}) on the span. The project
    //     ALWAYS rebuilds byte-exact regardless.
    regions.push({
      name: "header", file: "header.asm", bytes: data.slice(0, 0xC0), kind: "data",
      startAddress: 0x08000000, fileOffset: 0,
      label: "GBA cartridge header (192 B data: entry branch + Nintendo logo + title + checksums)",
    });
    regions.push({
      name: "code", file: "code.asm", bytes: trimTrailingPad(data.slice(0xC0)),
      startAddress: 0x080000C0, fileOffset: 0xC0,
      label: "GBA code @ 0x080000C0 (ARM7TDMI, ARM mode) — Thumb spans fall back to byte-exact data; use disassembleRom({thumb:true}) to read them",
    });
    return regions;
  }
  return regions;
}

/**
 * Prepend a `.org <addr>` directive to da65 output so it re-assembles
 * unmodified through ca65 (without it, absolute branch targets fail
 * relocatable assembly with "Range error"). Inserts AFTER any leading
 * `.setcpu` line da65 emits; idempotent (no-op if an `.org` is already
 * present near the top).
 * @param {string} asm
 * @param {number} addr
 * @returns {string}
 */
function injectOrigin(asm, addr) {
  const org = `.org $${(addr & 0xFFFF).toString(16).toUpperCase().padStart(4, "0")}`;
  const lines = asm.split(/\r?\n/);
  // Already has an origin in the first ~10 lines? leave it.
  if (lines.slice(0, 10).some((l) => /^\s*\.org\b/i.test(l))) return asm;
  // Insert right after the last leading directive (.setcpu / .segment /
  // comment / blank) so it sits with the other preamble.
  let insertAt = 0;
  for (let i = 0; i < lines.length && i < 10; i++) {
    if (/^\s*(\.setcpu|\.segment|;|$)/i.test(lines[i])) insertAt = i + 1;
    else break;
  }
  lines.splice(insertAt, 0, org);
  return lines.join("\n");
}

/** Best-effort: pull the first error-looking line out of a failed da65 dump. */
function firstErrorLine(text) {
  if (!text) return null;
  for (const line of text.split(/\r?\n/)) {
    if (/\b[Ee]rror\b|:\d+:/.test(line)) return line.trim();
  }
  const first = text.split(/\r?\n/).find((l) => l.trim());
  return first ? first.trim() : null;
}

/**
 * Synthesize a da65 info file with vector labels + data ranges in addition
 * to non-overlapping Code RANGEs so the whole window is decoded as code
 * except where the agent marked data.
 *
 * da65 errors with "Duplicate style for address ..." if any byte is covered
 * by two RANGEs — so we partition [startAddress, endAddress] into Code
 * gaps around the data ranges, rather than declaring one big Code RANGE
 * with data RANGEs on top.
 */
function buildInfoFile({ startAddress, length, cpu, labels, dataRanges }) {
  const lo = (n) => "$" + (n & 0xFFFF).toString(16).toUpperCase();
  const endAddress = startAddress + length - 1;
  const lines = [];

  // Sort + clip data ranges to window.
  const drs = dataRanges
    .map((r) => ({ start: Math.max(r.start, startAddress), end: Math.min(r.start + r.length - 1, endAddress) }))
    .filter((r) => r.start <= r.end)
    .sort((a, b) => a.start - b.start);

  // Emit alternating Code / ByteTable ranges.
  const isHighCpu = cpu === "65816";
  const codeRange = (s, e) => isHighCpu
    ? `RANGE { START ${lo(s)}; END ${lo(e)}; TYPE Code; ADDRMODE "MX"; };`
    : `RANGE { START ${lo(s)}; END ${lo(e)}; TYPE Code; };`;
  const dataRange = (s, e) =>
    `RANGE { START ${lo(s)}; END ${lo(e)}; TYPE ByteTable; };`;

  let cursor = startAddress;
  for (const dr of drs) {
    if (cursor < dr.start) lines.push(codeRange(cursor, dr.start - 1));
    lines.push(dataRange(dr.start, dr.end));
    cursor = dr.end + 1;
  }
  if (cursor <= endAddress) lines.push(codeRange(cursor, endAddress));

  for (const lab of labels) {
    if (lab.addr > 0xFFFF) continue;
    lines.push(`LABEL { NAME "${lab.name}"; ADDR ${lo(lab.addr)}; };`);
  }
  return lines.join("\n") + "\n";
}
