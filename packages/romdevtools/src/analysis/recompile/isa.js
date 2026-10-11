// Per-ISA descriptor for the IR exporter.
//
// The exporter's structure - batched all-alignment decode, bank windows with
// lookahead, completeness accounting - is ISA-AGNOSTIC. What varies is small
// and enumerable, so it lives here rather than being threaded as a growing
// list of parameters.
//
// Adding an ISA needs two things that are NOT here, because neither can be
// faked: a working objdump arch, and a cycle table extracted from a core we
// verify against.
import { z80Cycles, z80Flags, z80Control, CYCLE_PROVENANCE } from "./z80-metadata.js";
import { liftZ80, DOCUMENTED_Z80 } from "./lift-z80.js";
import { m68kCycles, m68kControl, M68K_CYCLE_PROVENANCE } from "./m68k-metadata.js";
import { gbCycles, gbControl, gbWindows, gbFixOps, GB_CYCLE_PROVENANCE, GB_ILLEGAL } from "./gb-metadata.js";
import { m6502Cycles, m6502Control, M6502_CYCLE_PROVENANCE } from "./m6502-metadata.js";
import { decodeBatch as decode6502, decodeLinear as decodeLinear6502 } from "./decode-6502.js";
import { decodeBatch as decode65816, decodeLinear as decodeLinear65816 } from "./decode-65816.js";
import { M65816_CYCLE_PROVENANCE, modeAccesses } from "./m65816-metadata.js";
import { armCycles, armControl, armDocumented, ARM_CYCLE_PROVENANCE } from "./arm-metadata.js";

// What binutils prints when a word is not a legal encoding (`@ <UNDEFINED>`)
// or when it gives up entirely. Shared by the ARM and Thumb rows so the two
// cannot drift - they are the same disassembler.
const ARM_DATA_MNEMONICS = new Set(["@", ".word", ".short", ".byte", ".inst"]);

/** @typedef {{arch:string, maxInstr:number, align:number, bankSize:number|null,
 *             cycles:(b:Buffer)=>number|null, control:Function,
 *             flags:Function|null, lift:Function|null,
 *             documented:(m:string)=>boolean, provenance:object}} IsaSpec */

/** @type {Record<string, IsaSpec>} */
export const ISAS = {
  z80: {
    arch: "z80",
    // DD/FD CB dd op is the longest Z80 instruction; bounds decode lookahead.
    maxInstr: 4,
    align: 1,
    bankSize: 0x4000,
    // This ISA's windows go through the SMS mapper logic; every other ISA
    // uses the flat chunked walk (see exportZ80IR's window choice).
    smsMapper: true,
    cycles: z80Cycles,
    control: z80Control,
    flags: z80Flags,
    lift: (mnem, ops) =>
      liftZ80(`${mnem} ${ops.replace(/0x([0-9a-f]+)/gi, "$$$1")}`).ir
        .filter((n) => n.name !== "RECOMPILE_ENTRY"),
    documented: (m) => DOCUMENTED_Z80.has(m),
    // relative encodings whose printed target moves with the decode address
    pcRelative: { branch: (m) => m === "jr" || m === "djnz" },
    // 0x00 is `nop` on Z80: one byte, decodes and stops. Padding a batch slice
    // with zeros cannot carry a decode into the next slice.
    pad: Buffer.from([0x00]),
    provenance: CYCLE_PROVENANCE,
  },
  m68k: {
    arch: "m68k",
    // WORST-CASE LENGTH, and this was measured rather than reasoned about.
    //
    // I first set 10 from "two-word opcode plus two long absolute operands".
    // A real cart then produced a 12-byte decode at offset 0x31E
    // (`00 32 ...` = orib with a full-format extension word), which ran past
    // the slice's real bytes and into the padding - caught by the exporter's
    // byte check, not by anything I reasoned.
    //
    // The length depends on the EXTENSION WORD, not the opcode alone, so a
    // sweep over opcodes with fixed operands reports 10 and is wrong. 24 is a
    // deliberate over-reservation: the 68000's widest documented encoding is
    // well under it, and over-reserving only costs decode bytes fed to
    // objdump, never correctness. Under-reserving silently truncates.
    maxInstr: 24,
    // 68000 instructions are WORD-ALIGNED. Odd offsets cannot begin an
    // instruction, so a secondary decode there would be fiction - unlike Z80,
    // where every byte is a legal entry point. Halves the offsets to export
    // and, more importantly, keeps the exporter from inventing records.
    align: 2,
    // Genesis maps ROM flat from $000000; no bank windows.
    bankSize: null,
    cycles: m68kCycles,
    control: m68kControl,
    flags: null,   // the recompiler lowers from mnemonic+ops; flags unmodelled
    lift: null,
    documented: () => true,
    // Bcc/BRA/BSR/DBcc targets and (d16,PC) / (d8,PC,Xn) operands are
    // printed as absolute addresses computed from the decode address
    pcRelative: {
      branch: (m) => /^(bra|bsr|bhi|bls|bcc|bcs|bne|beq|bvc|bvs|bpl|bmi|bge|blt|bgt|ble)[sbwl]?$/.test(m) || /^db[a-z]{1,2}$/.test(m),
      pcTokens: /%pc@\(0x([0-9a-f]+)/gi,
    },
    // 0x00 0x00 is NOT safe padding on m68k - it decodes as `orib`, a valid
    // instruction, so a decode ran 12 bytes into the padding and produced
    // bytes that did not match the ROM (caught by the byte check at offset
    // 798 of a real cart). 0x4AFC is ILLEGAL: exactly 2 bytes, decodes and
    // stops, so it terminates a slice the way 0x00 does on Z80.
    pad: Buffer.from([0x4a, 0xfc]),
    provenance: M68K_CYCLE_PROVENANCE,
  },
  gb: {
    // binutils decodes the Game Boy CPU via its `gbz80` machine (z80-dis.c
    // has full INSS_GBZ80 support), which objdump.js already exposes.
    arch: "gbz80",
    // The longest LR35902 instruction is 3 bytes (`ld (nn),a`, `jp nn`).
    // There is no DD/FD prefixing as on the Z80, and CB-prefixed ops are
    // exactly 2. 4 leaves headroom without costing correctness.
    maxInstr: 4,
    // Every byte is a legal entry point, as on the Z80.
    align: 1,
    // MBC banks the $4000-$7FFF window in 16KB units.
    bankSize: 0x4000,
    // Banks are seen through fixed CPU windows (bank 0 at $0000, the rest at
    // $4000), so the exporter walks one window per bank at its CPU address
    // rather than the flat file-offset walk. See gbWindows.
    windows: gbWindows,
    // `jr` targets are recomputed from the bytes at the true CPU address,
    // primary and secondary records alike. See gbFixOps.
    fixOps: gbFixOps,
    cycles: gbCycles,
    // gbControl classifies from the opcode BYTES; the exporter's control
    // hook passes (mnemonic, ops, addr, len, bytes). Wiring gbControl in
    // directly handed it the mnemonic string, so every record came out
    // kind:'none'.
    control: (mnemonic, ops, addr, len, bytes) => gbControl(bytes, addr),
    flags: null,
    lift: null,
    documented: (m) => !/^(\.|unknown|bad)/i.test(m),
    // 0x00 is `nop`: one byte, decodes and stops, so zero padding cannot
    // carry a decode out of a batch slice. Same property as Z80.
    pad: Buffer.from([0x00]),
    illegal: GB_ILLEGAL,
    provenance: GB_CYCLE_PROVENANCE,
  },
  m6502: {
    // NOT an objdump arch - binutils has no 6502 target, and da65 is a
    // whole-file disassembler that cannot be asked for one instruction at a
    // given offset without a per-offset flood. The 6502 needs neither: 256
    // fixed-length opcodes, no prefixes, so `decode` below IS the decoder.
    // It is validated against da65 on a real ROM (259/260 identical; the one
    // difference is da65 printing a symbol name for an address).
    arch: "m6502",
    decode: decode6502,
    decodeLinear: decodeLinear6502,
    // The longest 6502 instruction is 3 bytes; there are no prefixes.
    maxInstr: 3,
    // Every byte is a legal entry point.
    align: 1,
    // NROM maps 16KB or 32KB flat; mappers bank $8000-$FFFF in 16KB units.
    bankSize: 0x4000,
    cycles: m6502Cycles,
    control: m6502Control,
    flags: null,
    lift: null,
    documented: (m) => m !== ".byte",
    // $EA is `nop`: one byte, decodes and stops.
    pad: Buffer.from([0xea]),
    provenance: M6502_CYCLE_PROVENANCE,
  },
  m65816: {
    // No binutils target and no usable da65 batch mode, same as the 6502.
    // Validated against da65 on a 512KB LoROM cart: 182 of 183 instructions
    // identical, and the one difference is da65 giving up (`.byte $ad`)
    // where this decoder correctly reads `lda $1DF9`.
    arch: "m65816",
    decode: decode65816,
    decodeLinear: decodeLinear65816,
    // The longest 65816 instruction is 4 bytes (a long absolute operand).
    maxInstr: 4,
    align: 1,
    // LoROM maps 32KB per bank into $8000-$FFFF.
    bankSize: 0x8000,
    // snes9x charges per memory ACCESS, not from a table; cost is
    // accesses * MemSpeed + internals. See m65816-metadata.js.
    cycles: () => null,
    control: () => ({ kind: "none", fallsThrough: true }),
    flags: null,
    lift: null,
    documented: (m) => m !== ".byte",
    // $EA is `nop`: one byte, decodes and stops.
    pad: Buffer.from([0xea]),
    provenance: M65816_CYCLE_PROVENANCE,
  },
  gba: {
    // ARM7TDMI, ARM state. binutils' arm objdump ships in romdev-platform-gba
    // (same package as as/ld/objcopy) and objdump.js already exposes it as the
    // `arm` arch; there is also a `thumb` arch for force-thumb decoding.
    //
    // THUMB IS NOT COVERED HERE. Thumb is a 2-byte ISA sharing the same address
    // space, and which state the CPU is in at a given address is a RUN-TIME
    // fact (set by bx/blx). Decoding every offset twice and labelling both
    // "the instruction" would be inventing entry points, so this descriptor is
    // ARM-state only and a Thumb-state export is a separate, later ISA row.
    arch: "arm",
    // ARM instructions are EXACTLY 4 bytes. No prefixes, no variable-length
    // operands: there is nothing for the lookahead to be wrong about.
    maxInstr: 4,
    // WORD-ALIGNED. In ARM state the PC's low two bits are always zero, so an
    // unaligned offset cannot begin an instruction and a record there would be
    // fiction - the same reason m68k uses align:2.
    align: 4,
    // The GBA maps cartridge ROM FLAT at $08000000 (mirrored at $0A/$0C for
    // different waitstate rows). There is no bank window.
    bankSize: null,
    // ALWAYS null - mGBA has no per-opcode table to extract, because an
    // ARM7TDMI instruction's cost depends on the memory region touched, the
    // live WAITCNT value, and (for multiplies) register contents. The S/N/I
    // model and mGBA's verbatim waitstate arrays are in arm-metadata.js.
    cycles: armCycles,
    control: armControl,
    flags: null,   // the recompiler lowers from mnemonic+ops; flags unmodelled
    lift: null,
    documented: armDocumented,
    // b/bl/blx<cond> targets and the `@ (0x..)` pc-literal address are
    // printed from the decode address
    pcRelative: {
      branch: (m) => /^(b|bl|blx)(eq|ne|cs|hs|cc|lo|mi|pl|vs|vc|hi|ls|ge|lt|gt|le|al)?(\.n|\.w)?$/.test(m),
      comment: /@ \(?0x([0-9a-f]+)\)?/gi,
    },
    // binutils ARM prints an illegal word as `@ <UNDEFINED> instruction: 0x..`
    // - runObjdump surfaces mnemonic `@`. That is the ARM spelling of the
    // `.short` the m68k decoder emits, so the exporter must recognise it or
    // every undefined word becomes an "instruction" named `@`.
    dataMnemonics: ARM_DATA_MNEMONICS,
    // PADDING MUST BE A REAL 4-BYTE INSTRUCTION, and on ARM every 4-byte word
    // is exactly one instruction, so any legal word terminates a batch slice.
    // `00 00 a0 e1` is `mov r0, r0` (the canonical ARM nop) little-endian.
    //
    // Zero padding would NOT be safe in spirit even though it is fixed-length:
    // 0x00000000 decodes as `andeq r0, r0, r0`, which is legal but is also the
    // single most common data word in a ROM, so a bug that read padding as
    // real bytes would look like plausible output. A distinctive nop makes
    // that failure visible in the byte check instead of silent.
    pad: Buffer.from([0x00, 0x00, 0xa0, 0xe1]),
    provenance: ARM_CYCLE_PROVENANCE,
  },
  gbaThumb: {
    // ARM7TDMI, THUMB state. Same CPU and the same address space as the `gba`
    // row above - what differs is which state the core is in, which is a
    // RUN-TIME fact set by `bx`. Keeping the two as separate ISAs is
    // deliberate: decoding every offset in both states and calling both "the
    // instruction" would invent entry points that never execute.
    //
    // A GBA cart matters here because essentially all commercial game code is
    // Thumb - the 16-bit cart bus makes it roughly twice as fast to fetch -
    // so an ARM-only export stops about a dozen instructions into the boot,
    // at the `bx` that switches state.
    arch: "thumb",
    // A Thumb instruction is 2 bytes, EXCEPT `bl`/`blx <label>`, which is an
    // aligned PAIR of 16-bit halves that binutils prints as one 4-byte
    // instruction. So the longest decode is 4.
    maxInstr: 4,
    // HALFWORD-ALIGNED: in Thumb state the PC's low bit is always zero.
    align: 2,
    bankSize: null,
    // Same reason as the ARM row: mGBA has no per-opcode table, because cost
    // depends on the memory region, the live WAITCNT and (for multiplies)
    // register contents. Thumb fetches are 16-bit, so the S/N/I model uses
    // the 16-bit waitstate arrays in arm-metadata.js.
    cycles: armCycles,
    // Thumb shares ARM's mnemonics, so the same classifier applies. It
    // already covers the Thumb idioms: `pop {pc}` and `bx lr` as returns,
    // `bl <label>` as a call, `bx <reg>` as an indirect jump.
    control: armControl,
    flags: null,
    lift: null,
    documented: armDocumented,
    // b/bl/blx<cond> targets and the `@ (0x..)` pc-literal address are
    // printed from the decode address
    pcRelative: {
      branch: (m) => /^(b|bl|blx)(eq|ne|cs|hs|cc|lo|mi|pl|vs|vc|hi|ls|ge|lt|gt|le|al)?(\.n|\.w)?$/.test(m),
      comment: /@ \(?0x([0-9a-f]+)\)?/gi,
    },
    dataMnemonics: ARM_DATA_MNEMONICS,
    // `mov r8, r8` (46c0) is Thumb's canonical nop: two bytes, decodes and
    // stops, so padding a batch slice cannot carry a decode into the next.
    pad: Buffer.from([0xc0, 0x46]),
    provenance: ARM_CYCLE_PROVENANCE,
  },
};

/** Which ISA a platform's cartridge code is written in. */
export const PLATFORM_ISA = {
  sms: "z80", gg: "z80", msx: "z80", z80: "z80",
  genesis: "m68k",
  gb: "gb", gbc: "gb",
  nes: "m6502",
  snes: "m65816",
  gba: "gba",
  gbaThumb: "gbaThumb",
};

/**
 * The ISA a platform's cartridge code is written in.
 *
 * `cpuState` selects between a platform's INSTRUCTION SETS where it has more
 * than one. The GBA's ARM7TDMI runs ARM and Thumb over the same address
 * space, and which one is live at a given address is a run-time fact set by
 * `bx` - so it is a caller's choice, not a property of the platform. Without
 * this a caller had to pass the internal ISA key as a fake platform, which
 * the tool layer rightly rejects.
 */
export const PLATFORM_CPU_STATES = {
  gba: { arm: "gba", thumb: "gbaThumb" },
};

export function isaFor(platform, cpuState) {
  if (cpuState) {
    const states = PLATFORM_CPU_STATES[platform];
    const key = states && states[cpuState];
    if (!key) return null;
    return ISAS[key];
  }
  const key = PLATFORM_ISA[platform];
  if (!key) return null;
  return ISAS[key];
}

/** Which instruction sets a platform has, for error messages and discovery. */
export function cpuStatesFor(platform) {
  return Object.keys(PLATFORM_CPU_STATES[platform] || {});
}
