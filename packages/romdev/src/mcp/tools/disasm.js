// Disassembly MCP tools — exposed as `disassemble` and `disassembleRom`.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import nodePath from "node:path";
import { jsonContent, safeTool, writeOutput } from "../util.js";
import { parseSymbols, buildSymbolMap } from "../../toolchains/common/symbols.js";
import { registersForPlatform } from "../../platforms/common/registers.js";
import { findReferencesCore } from "./find-references.js";

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
  const loMapper = data[copierOff + 0x7FC0 + 0x15];
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
export function mapSmsAddress(data, cpuAddr, length) {
  // Slot 0: $0000-$3FFF maps to file 0..$3FFF (bank 0, fixed).
  // Slot 1: $4000-$7FFF maps to file $4000..$7FFF (bank 1, fixed by default).
  // Slot 2: $8000-$BFFF maps to file $8000..$BFFF (banked — default = bank 2).
  if (cpuAddr < 0xC000) {
    const fileOffset = cpuAddr;
    if (fileOffset >= data.length) {
      throw new Error(`CPU address $${cpuAddr.toString(16)} past end of SMS ROM (${data.length} bytes)`);
    }
    return {
      bytes: data.slice(fileOffset, fileOffset + length),
      fileOffset,
      cpu: "z80",
      note: `SMS/GG sega mapper, slot ${cpuAddr < 0x4000 ? 0 : cpuAddr < 0x8000 ? 1 : 2} (default bank)`,
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
export function mapAtari7800Address(data, cpuAddr, length, bank = 0) {
  // Detect header. "ATARI7800" magic at offset 1.
  const hasHeader =
    data.length > 128 &&
    String.fromCharCode(data[1], data[2], data[3], data[4], data[5], data[6], data[7], data[8], data[9])
      === "ATARI7800";
  const headerSize = hasHeader ? 128 : 0;
  const romSize = data.length - headerSize;
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
export function mapC64Address(data, cpuAddr, length, bank = 0) {
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
          ? mapSmsAddress(data, startAddress, length)
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
      // sharing one target is valid 6502 (Rygar points NMI and IRQ both at
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
        if (labels.length > 0 || dataRangesInWindow.length > 0 || mapped.cpu !== "6502") {
          info = buildInfoFile({
            startAddress, length,
            cpu: mapped.cpu,
            labels,
            dataRanges: dataRangesInWindow,
          });
        }
        const needAddressColumn = annotateRegistersFlag || annotateFileOffsetsFlag;
        const r = await runDa65({
          bytes: mapped.bytes, startAddress, cpu: mapped.cpu, info,
          options: needAddressColumn ? ["--comments", "4"] : [],
        });
        asm = r.asm;
        exitCode = r.exitCode;
      }

      // File-offset annotation: per-line cpu→file translator.
      if (annotateFileOffsetsFlag) {
        const cpuToFile = (cpuAddr) => {
          try {
            if (resolved === "snes") return mapSnesAddress(data, cpuAddr, 1, mapper).fileOffset;
            if (resolved === "sms" || resolved === "gg") return mapSmsAddress(data, cpuAddr, 1).fileOffset;
            if (resolved === "gb" || resolved === "gbc") return mapGbAddress(data, cpuAddr, 1, args.bank).fileOffset;
            if (resolved === "atari2600") return mapAtari2600Address(data, cpuAddr, 1, args.bank ?? 0).fileOffset;
            if (resolved === "atari7800") return mapAtari7800Address(data, cpuAddr, 1, args.bank ?? 0).fileOffset;
            if (resolved === "c64") return mapC64Address(data, cpuAddr, 1, args.bank ?? 0).fileOffset;
            if (resolved === "genesis") return mapGenesisAddress(data, cpuAddr, 1).fileOffset;
            // `args.bank` maps $8000-$BFFF to the chosen switchable bank;
            // mapNesAddress ignores it for $C000+ (fixed top bank), so each
            // annotated line points at the correct PRG offset.
            return mapNesAddress(data, cpuAddr, 1, args.bank).fileOffset;
          } catch {
            return null;
          }
        };
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

async function disassembleProjectCore({ path: romPath, outputDir, platform }) {
      const { reassembleForPlatform } = await import("../../toolchains/common/reassemble.js");
      const data = new Uint8Array(await readFile(romPath));
      const resolved = platform ?? sniffPlatformFromPath(romPath);
      if (!resolved) throw new Error(`disassembleProject: could not detect platform from '${romPath}'. Pass platform explicitly.`);
      await mkdir(outputDir, { recursive: true });

      // Plan the regions to disassemble for this platform (per-bank for banked
      // ROMs; one region for flat ROMs). Each region → its own byte-exact .asm.
      const regions = planRegions(resolved, data);
      if (!regions.length) throw new Error(`disassembleProject: no regions planned for '${resolved}' (unsupported or empty ROM).`);

      const out = [];
      for (const reg of regions) {
        // Known-data regions (e.g. the GBA cartridge header) are emitted as a
        // clean `.byte` dump — byte-exact by construction, NOT a failed disasm.
        const r = reg.kind === "data"
          ? { ok: true, readablePercent: 0, source: dataRegionSource(reg.bytes, reg.startAddress), note: "data region (not code)" }
          : await reassembleForPlatform({ platform: resolved, bytes: reg.bytes, startAddress: reg.startAddress });
        const header = `; ${reg.label} — ${reg.bytes.length} bytes @ $${reg.startAddress.toString(16).toUpperCase()} ` +
          `(file 0x${reg.fileOffset.toString(16).toUpperCase()}), ${resolved}\n` +
          `; round-trip: ${r.ok ? "BYTE-EXACT" : "FAILED"} · readable ${r.readablePercent}%` +
          (r.note ? ` · ${r.note}` : "") + "\n\n";
        await writeFile(nodePath.join(outputDir, reg.file), header + r.source);
        out.push({
          region: reg.name, file: reg.file, startAddress: "$" + reg.startAddress.toString(16).toUpperCase(),
          bytes: reg.bytes.length, roundTripOk: r.ok, readablePercent: r.readablePercent,
          ...(reg.kind === "data" ? { kind: "data" } : {}),
          ...(r.note ? { note: r.note } : {}),
        });
      }

      const allOk = out.every((r) => r.roundTripOk);
      const avgReadable = Math.round(out.reduce((s, r) => s + r.readablePercent, 0) / out.length);
      return jsonContent({
        ok: allOk,
        path: romPath,
        platform: resolved,
        regions: out,
        roundTrip: { regions: out.length, allByteExact: allOk, failed: out.filter((r) => !r.roundTripOk).map((r) => r.region) },
        readablePercentAvg: avgReadable,
        note: allOk
          ? `All ${out.length} region(s) round-trip BYTE-EXACT (avg ${avgReadable}% disassembled as instructions, the rest as .byte data). Edit the .asm files and rebuild.`
          : `Some regions did NOT round-trip byte-exact — see regions[].note.`,
      });
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
    "`endAddress`/`untilReturn` for one routine, `dataRanges` to mark non-code, `bank` for a banked slot.\n" +
    "'project' = turn a ROM into a complete re-buildable disassembly in one call across all systems; splits into " +
    "regions, REASSEMBLES each and verifies BYTE-EXACT (`roundTripOk`); non-faithful lines fall back to `.byte` so " +
    "it ALWAYS rebuilds; `readablePercent` reports instruction-vs-data. (SNES is byte-exact data-only for now.)\n" +
    "'references' = scan a ROM's code for operands matching a CPU `address` and classify each (call/jump/branch/" +
    "read/write); also walks the vector table. LIMITATION: direct addressing only (indirect/computed jumps + " +
    "cross-bank refs are missed).",
    {
      target: z.enum(["bytes", "rom", "project", "references"]).describe("bytes = raw chunk; rom = mapper-aware ROM; project = full rebuildable disasm; references = find refs to an address."),
      // shared
      path: z.string().optional().describe("target=bytes: raw binary path. target=rom/project/references: ROM file path."),
      base64: z.string().optional().describe("target=bytes: base64 of the bytes (OR `path`)."),
      platform: z.enum(["nes", "snes", "sms", "gg", "gb", "gbc", "atari2600", "atari7800", "c64", "genesis", "gba", "pce", "msx", "lynx"]).optional().describe("target=rom/project/references: override platform (else sniffed from extension)."),
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
      bank: z.number().int().min(0).max(255).optional().describe("target=rom: switchable ROM bank to map into the windowed slot (NES mapper>0 $8000 / GB $4000; also 2600/7800/c64)."),
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
      outputDir: z.string().optional().describe("target=project: directory to write the project into (one .asm per region)."),
      // references
      address: z.number().int().min(0).max(0xFFFFFF).optional().describe("target=references: CPU address to find references TO."),
      maxRefsReturned: z.number().int().min(1).max(2048).default(256).describe("target=references: cap the references returned."),
    },
    safeTool(async (args) => {
      switch (args.target) {
        case "bytes":      return await disassembleCore(args);
        case "rom":        return await disassembleRomCore(args);
        case "project":    return await disassembleProjectCore(args);
        case "references": return jsonContent(await findReferencesCore(args));
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
function dataRegionSource(bytes, startAddress) {
  const rows = [`\t.org $${startAddress.toString(16).toUpperCase()}`];
  for (let i = 0; i < bytes.length; i += 16) {
    const slice = Array.from(bytes.slice(i, i + 16));
    rows.push(
      "\t.byte " + slice.map((b) => "$" + b.toString(16).padStart(2, "0").toUpperCase()).join(",") +
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
    // Z80 mapped at $0000; one region for the whole ROM (Sega mapper banks
    // beyond 48KB are rarer in homebrew — treat as flat for now).
    regions.push({ name: "rom", file: "rom.asm", bytes: trimTrailingPad(data.slice(0)), startAddress: 0x0000, fileOffset: 0, label: "ROM ($0000)" });
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
    regions.push({ name: "rom", file: "rom.asm", bytes: data.slice(0), startAddress: 0xF000, fileOffset: 0, label: "4KB cart @ $F000" });
    return regions;
  }
  if (platform === "atari7800") {
    const org = 0x10000 - data.length; // cart maps to top of address space
    regions.push({ name: "rom", file: "rom.asm", bytes: data.slice(0), startAddress: org & 0xFFFF, fileOffset: 0, label: `cart @ $${(org & 0xFFFF).toString(16)}` });
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
    // PC Engine HuCard: the HuC6280 (65C02-family) image. cc65 pce.cfg maps the
    // reset/IRQ vectors at $FFF6+ and the program high; homebrew typically runs
    // from the ROM mapped at the top of the address space. Disassemble the image
    // as a flat region from the cart base — a HuCard has no header to strip.
    const body = trimTrailingPad(data.slice(0));
    const org = (0x10000 - body.length) & 0xffff; // cart maps to top of space
    regions.push({
      name: "rom", file: "rom.asm", bytes: body,
      startAddress: org, fileOffset: 0,
      label: `HuCard @ $${org.toString(16)} (HuC6280)`,
    });
    return regions;
  }
  if (platform === "msx") {
    // MSX cartridge maps at $4000-$BFFF; the 16-byte "AB" header at $4000 is
    // data (magic + INIT/STATEMENT/DEVICE/TEXT pointers), code follows. Skip the
    // header and disassemble the Z80 image from $4010.
    const hdr = data.length >= 2 && data[0] === 0x41 && data[1] === 0x42;
    const base = hdr ? 16 : 0;
    regions.push({
      name: "rom", file: "rom.asm", bytes: trimTrailingPad(data.slice(base)),
      startAddress: 0x4000 + base, fileOffset: base,
      label: `cart @ $${(0x4000 + base).toString(16)} (Z80)`,
    });
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
