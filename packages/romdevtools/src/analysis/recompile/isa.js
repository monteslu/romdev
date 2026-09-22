// Per-ISA descriptor for the IR exporter.
//
// The exporter's structure - batched all-alignment decode, bank windows with
// lookahead, completeness accounting - is ISA-AGNOSTIC. What varies is small
// and enumerable, so it lives here rather than being threaded as a growing
// list of parameters.
//
// Adding an ISA needs two things that are NOT here, because neither can be
// faked: a working objdump arch, and a cycle table extracted from a core we
// verify against. See internal-romdev/recomp/01_PORTING_A_PLATFORM.md.
import { z80Cycles, z80Flags, z80Control, CYCLE_PROVENANCE } from "./z80-metadata.js";
import { liftZ80, DOCUMENTED_Z80 } from "./lift-z80.js";
import { m68kCycles, m68kControl, M68K_CYCLE_PROVENANCE } from "./m68k-metadata.js";
import { gbCycles, gbControl, GB_CYCLE_PROVENANCE, GB_ILLEGAL } from "./gb-metadata.js";

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
    cycles: z80Cycles,
    control: z80Control,
    flags: z80Flags,
    lift: (mnem, ops) =>
      liftZ80(`${mnem} ${ops.replace(/0x([0-9a-f]+)/gi, "$$$1")}`).ir
        .filter((n) => n.name !== "RECOMPILE_ENTRY"),
    documented: (m) => DOCUMENTED_Z80.has(m),
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
    cycles: gbCycles,
    control: gbControl,
    flags: null,
    lift: null,
    documented: (m) => !/^(\.|unknown|bad)/i.test(m),
    // 0x00 is `nop`: one byte, decodes and stops, so zero padding cannot
    // carry a decode out of a batch slice. Same property as Z80.
    pad: Buffer.from([0x00]),
    illegal: GB_ILLEGAL,
    provenance: GB_CYCLE_PROVENANCE,
  },
};

/** Which ISA a platform's cartridge code is written in. */
export const PLATFORM_ISA = {
  sms: "z80", gg: "z80", msx: "z80", z80: "z80",
  genesis: "m68k",
  gb: "gb", gbc: "gb",
};

export function isaFor(platform) {
  const key = PLATFORM_ISA[platform];
  if (!key) return null;
  return ISAS[key];
}
