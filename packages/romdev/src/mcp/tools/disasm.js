// Disassembly MCP tools — exposed as `disassemble` and `disassembleRom`.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import nodePath from "node:path";
import { jsonContent, safeTool, writeOutput } from "../util.js";
import { parseSymbols, buildSymbolMap } from "../../toolchains/common/symbols.js";
import { registersForPlatform } from "../../platforms/common/registers.js";

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

export function registerDisasmTools(server, z) {
  server.tool(
    "disassemble",
    "Disassemble a chunk of raw bytes using cc65's da65. Provide bytes as `path` (a file on disk — preferred, " +
    "no base64 round-trip) OR `base64`. Defaults to 6502 / NES $8000. Supports 6502, 65c02, 65sc02, 65816, " +
    "huc6280. Emits `.org <startAddress>` by default so the output re-assembles through ca65 (addOrigin:false " +
    "to skip). Pass `symbolsPath`/`symbolsText` to annotate with labels (WLA .sym / cc65 .lbl). " +
    "NOTE: this is the RAW path — for a ROM file you want mapper-aware disassembly with `; @0xNNNN` file-offset " +
    "annotations and auto-tagged vectors, use `disassembleRom` instead. " +
    "DEFAULT writes asm to outputPath and returns {path, bytes}; pass inline:true to get the asm in the response.",
    {
      path: z.string().optional().describe("Absolute path to a raw binary file to disassemble. Provide this OR `base64`. Preferred — avoids a base64 round-trip."),
      base64: z.string().optional().describe("Base64 of the bytes to disassemble. Provide this OR `path`."),
      startAddress: z.number().int().min(0).max(0xffffff).default(0x8000).describe("Address of the first byte (e.g. 0x8000 for NES PRG)."),
      cpu: z.enum(["6502", "65c02", "65sc02", "65816", "huc6280"]).default("6502"),
      addOrigin: z.boolean().default(true).describe("Prepend `.org <startAddress>` so the asm re-assembles through ca65 unmodified (absolute branch targets otherwise fail with 'Range error'). Set false when feeding a linker config that sets the origin."),
      symbolsPath: z.string().optional().describe("Optional path to a symbol file (asar .sym, cc65 .lbl). Auto-detect format from extension."),
      symbolsText: z.string().optional().describe("Optional inline symbol-file text. If both this and symbolsPath are given, symbolsPath wins."),
      symbolsFormat: z.enum(["wla", "cc65-lbl"]).optional().describe("Explicit symbol-file format override (when filename and content are ambiguous)."),
      outputPath: z.string().optional().describe("Absolute path to write the asm text to. Required unless inline:true."),
      inline: z.boolean().default(false).describe("If true, return the asm text in the response instead of writing to disk. Default false — then outputPath is required."),
    },
    safeTool(async ({ path: inPath, base64, startAddress, cpu, addOrigin = true, symbolsPath, symbolsText, symbolsFormat, outputPath, inline }) => {
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
    }),
  );

  server.tool(
    "disassembleRom",
    "Use this to read what an existing ROM file does: mapper-aware disassembly with agent-friendly " +
    "annotations (auto-tagged reset/nmi/irq vectors, hardware register names on operands, and per-line " +
    "`; @0xNNNN` file offsets ready for patchFile — NES reports both .nes and PRG offsets). Platform is " +
    "sniffed from the extension (NES/SNES/SMS/GG/GB/GBC/Atari 2600/7800/C64/Genesis) or pass `platform`. " +
    "Use `endAddress`/`untilReturn` to grab exactly one routine, `dataRanges` to mark non-code, and " +
    "`outputPath` to write big disassemblies to disk instead of inline. (For raw bytes you already have, " +
    "use `disassemble`.) See param hints for the rest.",
    {
      path: z.string().describe("Absolute path to a ROM file (.nes / .sfc / .smc)."),
      platform: z.enum(["nes", "snes", "sms", "gg", "gb", "gbc", "atari2600", "atari7800", "c64", "genesis"]).optional().describe("Override platform detection. Omit to sniff from file extension."),
      bank: z.number().int().min(0).max(255).optional().describe("Which switchable ROM bank to map into the banked slot before disassembling. NES (mapper>0): maps 16KB PRG bank N at $8000-$BFFF (a $C000+ startAddress still reads the fixed top bank). GB/GBC: maps the bank at $4000-$7FFF (default bank 1). Lets you disassemble UxROM/MMC1/MMC3 bank N without slicing the ROM by hand."),
      startAddress: z.number().int().min(0).max(0xffffff).default(0x8000).describe("CPU address to start at. NES: $8000-$FFFF. SNES: $008000-$FFFFFF (bank-prefixed)."),
      length: z.number().int().min(1).max(65536).optional().describe("Bytes to disassemble. Default 256. Mutually exclusive with endAddress."),
      endAddress: z.number().int().min(0).max(0xffffff).optional().describe("CPU end address (inclusive). Alternative to length — useful when disassembling 'from X to Y'."),
      untilReturn: z.boolean().default(false).describe("Stop at the first rts/rti/rtl/bare-jmp encountered in the output. Use to grab exactly one routine after locating its entry via auto-tagged labels."),
      mapper: z.enum(["lorom", "hirom"]).optional().describe("SNES only: override mapper detection (header-less homebrew defaults to lorom)."),
      dataRanges: z.array(z.object({
        start: z.number().int().min(0).max(0xffffff).describe("CPU address (start of data range)."),
        length: z.number().int().min(1).describe("Length in bytes."),
      })).optional().describe("Address ranges to treat as DATA (emitted as `.byte` tables instead of disassembled as code). Use for sprite/tile/lookup tables embedded in the code stream."),
      autoLabelVectors: z.boolean().default(true).describe("Pre-seed reset/nmi/irq labels from the vector table. Hugely improves orientation in unknown ROMs."),
      annotateRegisters: z.boolean().default(true).describe("Append `; PPUMASK` etc. to operands that hit a known hardware register."),
      annotateFileOffsets: z.boolean().default(true).describe("Append `; @0xNNNN` to every disassembled line — direct file offset for patchFile."),
      addOrigin: z.boolean().default(true).describe("Prepend a `.org <startAddress>` directive (6502/cc65 output) so the asm RE-ASSEMBLES UNMODIFIED through ca65 — without it, absolute branch targets fail relocatable assembly with 'Range error'. Set false only when feeding a multi-segment linker config that sets the origin itself."),
      outputPath: z.string().optional().describe("Absolute path. If set, writes the raw asm to disk and returns `{outputPath, length, bytes}` instead of inline asm. Use for large disassemblies."),
    },
    safeTool(async (args) => {
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
        /\.(gen|md|bin)$/i.test(romPath) ? "genesis" :
        null
      );
      if (!resolved) {
        throw new Error(`could not detect platform from path '${romPath}'. Pass platform explicitly.`);
      }
      const cpuFamily = (resolved === "sms" || resolved === "gg") ? "z80"
                      : (resolved === "gb" || resolved === "gbc") ? "sm83"
                      : (resolved === "genesis") ? "m68k"
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

      const mapped = resolved === "snes"
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
      if (cpuFamily === "m68k") {
        const { runM68kdasm } = await import("../../toolchains/m68kdasm.js");
        const r = runM68kdasm({ bytes: mapped.bytes, startAddress });
        asm = r.asm;
        exitCode = r.exitCode;
        if (labels.length > 0) asm = injectVectorLabels(asm, labels);
      } else if (cpuFamily === "z80") {
        const { runZ80dasm } = await import("../../toolchains/z80dasm.js");
        const r = runZ80dasm({ bytes: mapped.bytes, startAddress });
        asm = r.asm;
        exitCode = r.exitCode;
        if (labels.length > 0) {
          asm = injectVectorLabels(asm, labels);
        }
      } else if (cpuFamily === "sm83") {
        const { runSm83dasm } = await import("../../toolchains/sm83dasm.js");
        const r = runSm83dasm({ bytes: mapped.bytes, startAddress });
        asm = r.asm;
        exitCode = r.exitCode;
        if (labels.length > 0) {
          asm = injectVectorLabels(asm, labels);
        }
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
    }),
  );

  server.tool(
    "disassembleProject",
    "Use this to turn a BANKED NES ROM into a complete, re-buildable project in ONE call — instead of " +
    "disassembling each bank by hand. For a mapper>0 ROM (UxROM/MMC1/MMC3/...) it: disassembles every 16KB " +
    "PRG bank (switchable banks decoded at $8000, the fixed top bank at $C000), writes one `bankN.asm` per " +
    "bank with a provenance header (`; bank N — prg 0xXXXX..0xYYYY`) and an `.org` so each file assembles " +
    "standalone, emits a per-bank ld65 linker config + a `build.sh`, and — critically — ROUND-TRIP VERIFIES " +
    "each bank by reassembling it and comparing the bytes against the original PRG slice (`roundTripOk` per " +
    "bank). A failing round-trip means the disassembly is NOT byte-exact — you'll know before you waste a " +
    "build cycle. NROM (mapper 0) ROMs are handled as a single bank. Writes everything under `outputDir`. " +
    "NES-ONLY today (the iNES 16KB-bank model + cc65 round-trip are baked in); for other systems use " +
    "`disassembleRom` per region — banked-rebuild scaffolding for SNES/GB/Genesis isn't built yet.",
    {
      path: z.string().describe("Absolute path to the .nes ROM."),
      outputDir: z.string().describe("Directory to write the project into (created if needed). Gets bankN.asm, bankN.cfg, build.sh, and a manifest."),
      verify: z.boolean().default(true).describe("Round-trip each bank (reassemble + compare to the original PRG bytes) and report `roundTripOk`. Default true — turn off only for a quick listing dump."),
      annotateRegisters: z.boolean().default(true).describe("Append `; PPUMASK` etc. on operands hitting a hardware register."),
    },
    safeTool(async ({ path: romPath, outputDir, verify = true, annotateRegisters: annotateRegistersFlag = true }) => {
      const { runDa65 } = await import("../../toolchains/cc65/da65.js");
      const data = new Uint8Array(await readFile(romPath));
      if (data[0] !== 0x4e || data[1] !== 0x45 || data[2] !== 0x53 || data[3] !== 0x1a) {
        throw new Error("disassembleProject: not an iNES file (only NES is supported today).");
      }
      const prgBanks16k = data[4] * 1;           // 16KB units per iNES header
      const prgSize = prgBanks16k * 16384;
      const mapperNum = ((data[6] >> 4) & 0xF) | (data[7] & 0xF0);
      const PRG_FILE_START = 16;
      const numBanks = prgSize >> 14;
      await mkdir(outputDir, { recursive: true });

      // Each switchable bank is decoded as if mapped at $8000; the LAST bank is
      // the one games keep fixed at $C000 (vectors live there), so decode it at
      // $C000 instead — that's where its absolute refs resolve.
      const regs = annotateRegistersFlag ? registersForPlatform("nes") : null;
      const banks = [];
      for (let b = 0; b < numBanks; b++) {
        const isFixedTop = (b === numBanks - 1) && numBanks > 1;
        const org = isFixedTop ? 0xC000 : 0x8000;
        const fileStart = PRG_FILE_START + b * 16384;
        const slice = data.slice(fileStart, fileStart + 16384);

        const da = await runDa65({ bytes: slice, startAddress: org, cpu: "6502", options: ["--comments", "4"] });
        if (da.exitCode !== 0) {
          banks.push({ bank: b, ok: false, error: firstErrorLine(da.asm), file: null });
          continue;
        }
        let asm = da.asm;
        if (regs) asm = annotateRegisters(asm, regs);
        asm = injectOrigin(asm, org);
        // Provenance header — makes a wrong-bank swap detectable by inspection.
        const hdr =
          `; bank ${b}${isFixedTop ? " (fixed, $C000)" : " (switchable, $8000)"} — ` +
          `prg 0x${(b * 16384).toString(16).toUpperCase().padStart(5, "0")}..` +
          `0x${(b * 16384 + 16383).toString(16).toUpperCase().padStart(5, "0")} ` +
          `(file 0x${fileStart.toString(16).toUpperCase()}), mapper ${mapperNum}\n`;
        asm = hdr + asm;

        const asmName = `bank${b}.asm`;
        await writeFile(nodePath.join(outputDir, asmName), asm);

        // Minimal ld65 config: one 16KB ROM bank at `org`, no header/CHR (we
        // verify PRG bytes only). Used for both round-trip and the user build.
        const cfg = bankLinkerConfig(org);
        await writeFile(nodePath.join(outputDir, `bank${b}.cfg`), cfg);

        const entry = { bank: b, org: "$" + org.toString(16).toUpperCase(), file: asmName, ok: true };

        if (verify) {
          const ca = await runCa65Local(asm);
          if (ca.exitCode !== 0 || !ca.object) {
            entry.roundTripOk = false;
            entry.roundTripError = `ca65 failed: ${firstErrorLine(ca.log)}`;
          } else {
            const ld = await runLd65Local(ca.object, cfg);
            if (ld.exitCode !== 0 || !ld.binary) {
              entry.roundTripOk = false;
              entry.roundTripError = `ld65 failed: ${firstErrorLine(ld.log)}`;
            } else {
              const ok = ld.binary.length === slice.length && slice.every((v, i) => v === ld.binary[i]);
              entry.roundTripOk = ok;
              if (!ok) {
                const at = firstDiffOffset(slice, ld.binary);
                entry.roundTripError = at < 0
                  ? `length mismatch (got ${ld.binary.length}, want ${slice.length})`
                  : `byte mismatch at PRG offset 0x${(b * 16384 + at).toString(16).toUpperCase()} (in-bank 0x${at.toString(16).toUpperCase()})`;
              }
            }
          }
        }
        banks.push(entry);
      }

      // build.sh: assemble every bank with the bundled cc65 (documents the
      // exact invocation; the project is self-contained on disk).
      const buildSh = buildScript(banks.filter((b) => b.ok));
      await writeFile(nodePath.join(outputDir, "build.sh"), buildSh);

      const verified = banks.filter((b) => b.roundTripOk !== undefined);
      const allOk = verified.length > 0 && verified.every((b) => b.roundTripOk);
      return jsonContent({
        ok: banks.every((b) => b.ok),
        path: romPath,
        outputDir,
        mapper: mapperNum,
        prgBanks: numBanks,
        banks,
        roundTrip: verify
          ? { verified: verified.length, allOk, failed: verified.filter((b) => !b.roundTripOk).map((b) => b.bank) }
          : { verified: 0, note: "verify:false — bytes not checked against the original" },
        note: verify
          ? (allOk
              ? `All ${verified.length} banks round-trip BYTE-EXACT. Edit the bankN.asm files and rebuild via build.sh (or buildSource per bank).`
              : `Some banks did NOT round-trip — see banks[].roundTripError. A failing bank's .asm will NOT rebuild to the original bytes.`)
          : `Listings written; round-trip verification skipped.`,
      });
    }),
  );
}

/** Minimal ld65 config: one 16KB ROM bank loaded at `org`, raw output. */
function bankLinkerConfig(org) {
  const hex = "$" + org.toString(16).toUpperCase();
  return [
    "MEMORY {",
    `  BANK: start ${hex}, size $4000, type ro, file %O, fill yes, fillval $FF;`,
    "}",
    "SEGMENTS {",
    "  CODE: load BANK, type ro;",
    "}",
  ].join("\n") + "\n";
}

/** build.sh documenting the per-bank assemble+link (uses cc65 on PATH). */
function buildScript(okBanks) {
  const lines = ["#!/bin/sh", "# Reassemble each bank. Requires cc65 (ca65/ld65) on PATH.", "set -e"];
  for (const b of okBanks) {
    lines.push(`ca65 -t nes ${b.file} -o bank${b.bank}.o`);
    lines.push(`ld65 -C bank${b.bank}.cfg bank${b.bank}.o -o bank${b.bank}.bin`);
  }
  lines.push("# Concatenate banks in order + prepend your iNES header to rebuild the ROM.");
  return lines.join("\n") + "\n";
}

/** Reassemble disasm output with the bundled ca65 (round-trip half 1). */
async function runCa65Local(asm) {
  const { runCa65 } = await import("../../toolchains/cc65/cc65.js");
  return runCa65({ source: asm, target: "nes" });
}

/** Link one bank object with a custom config (round-trip half 2). */
async function runLd65Local(object, cfg) {
  const { runLd65 } = await import("../../toolchains/cc65/cc65.js");
  return runLd65({ objects: { "out.o": object }, target: "nes", linkerConfig: cfg });
}

/** First differing byte index between two arrays, or -1 if equal up to min length. */
function firstDiffOffset(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
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
