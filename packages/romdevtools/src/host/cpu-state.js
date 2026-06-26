// Cross-platform CPU register extraction.
//
// Implementation strategy: parse the libretro core's serialize_state blob.
// Each core has a well-known savestate format; we locate the CPU register
// block by its sentinel tag and decode the fields per-core.
//
// This avoids per-core retro_get_memory_data patches just for CPU regs and
// works for every core that supports serialize_state (which is all of them
// in our bundle).

import { findSnes9xBlock } from "./snes9x-state.js";
import { decodeGenesisM68k } from "./gpgx-state.js";

/**
 * Decode the SNES 65816 CPU register block from a snes9x savestate.
 * Field order per src/snapshot.cpp SnapRegisters[]:
 *   PB(u8), DB(u8), P.W(u16), A.W(u16), D.W(u16), S.W(u16), X.W(u16),
 *   Y.W(u16), PCw(u16) — all uint16s big-endian per FreezeStruct.
 *
 * @param {Uint8Array} state
 * @returns {ReturnType<typeof formatCpuState> | null}
 */
function decodeSnes9xCPU(state) {
  const off = findSnes9xBlock(state, "REG");
  if (off < 0) return null;
  const u16be = (o) => (state[o] << 8) | state[o + 1];
  const PB = state[off + 0];
  const DB = state[off + 1];
  const P  = u16be(off + 2);
  const A  = u16be(off + 4);
  const D  = u16be(off + 6);
  const S  = u16be(off + 8);
  const X  = u16be(off + 10);
  const Y  = u16be(off + 12);
  const PC = u16be(off + 14);
  // P flags (low 8 bits, native mode):
  // N V M X D I Z C
  const p8 = P & 0xFF;
  return formatCpuState({
    pc: (PB << 16) | PC,
    registers: { A, X, Y, D, S, DB, PB, P },
    flags: {
      N: !!(p8 & 0x80),
      V: !!(p8 & 0x40),
      M: !!(p8 & 0x20), // memory/accumulator width (1 = 8-bit)
      X: !!(p8 & 0x10), // index width (1 = 8-bit)
      D: !!(p8 & 0x08),
      I: !!(p8 & 0x04),
      Z: !!(p8 & 0x02),
      C: !!(p8 & 0x01),
    },
    sp: S,
  });
}

/**
 * @typedef {Object} CPUState
 * @property {number} pc Program counter (24-bit on 65816)
 * @property {Record<string, number>} registers
 * @property {Record<string, boolean>} flags
 * @property {number} sp Stack pointer
 */

function formatCpuState(s) {
  // Pass-through helper so future per-platform decoders share one shape.
  return s;
}

/**
 * Decode the SPC700 CPU state from snes9x's "SND" block.
 *
 * SND block layout (per snes9x src/apu/bapu/smp/smp_state.cpp save_state):
 *   [0x10000]  apuram (64 KB)
 *   [4 LE]     clock
 *   [4 LE]     opcode_number
 *   [4 LE]     opcode_cycle
 *   [4 LE]     regs.pc        ← what we want
 *   [4 LE]     regs.sp
 *   [4 LE]     regs.B.a
 *   [4 LE]     regs.x
 *   [4 LE]     regs.B.y
 *   [4 LE × 8] regs.p.{n,v,p,b,h,i,z,c}   each as 32-bit bool
 *   ...
 * Each field is INT32(...) = set_le32 = 4-byte little-endian.
 *
 * @param {Uint8Array} state
 * @returns {ReturnType<typeof formatCpuState> | null}
 */
function decodeSnes9xSPC(state) {
  const off = findSnes9xBlock(state, "SND");
  if (off < 0) return null;
  // The block starts with 64KB of ARAM, then 3 INT32s before PC.
  const u32le = (o) => state[o] | (state[o + 1] << 8) | (state[o + 2] << 16) | (state[o + 3] << 24);
  let p = off + 0x10000; // skip apuram
  p += 4; // skip clock
  p += 4; // skip opcode_number
  p += 4; // skip opcode_cycle
  const pc = u32le(p) & 0xFFFF;            p += 4;
  const sp = u32le(p) & 0xFF;              p += 4;
  const a  = u32le(p) & 0xFF;              p += 4;
  const x  = u32le(p) & 0xFF;              p += 4;
  const y  = u32le(p) & 0xFF;              p += 4;
  const n  = !!u32le(p);                   p += 4;
  const v  = !!u32le(p);                   p += 4;
  const pf = !!u32le(p);                   p += 4; // direct page select (p flag)
  const b  = !!u32le(p);                   p += 4;
  const h  = !!u32le(p);                   p += 4;
  const i  = !!u32le(p);                   p += 4;
  const z  = !!u32le(p);                   p += 4;
  const c  = !!u32le(p);                   p += 4;
  return formatCpuState({
    pc,
    registers: { A: a, X: x, Y: y, SP: sp, YA: (y << 8) | a },
    flags: { N: n, V: v, P: pf, B: b, H: h, I: i, Z: z, C: c },
    sp,
  });
}

/**
 * Decode fceumm's X6502 struct from the nes_cpu_regs region (snapshot
 * of the live struct memcpy'd into a stable buffer by our patch).
 *
 * Struct layout (28 bytes, wasm32 default alignment):
 *   [0..3]   int32_t  tcount  (temporary cycle counter)
 *   [4..5]   uint16_t PC
 *   [6]      uint8_t  A
 *   [7]      uint8_t  X
 *   [8]      uint8_t  Y
 *   [9]      uint8_t  S      (stack pointer; SP = 0x100 | S)
 *   [10]     uint8_t  P      (NV-BDIZC flag register)
 *   [11]     uint8_t  mooPI  (previous interrupt mask — fceumm internal)
 *   [12]     uint8_t  jammed (illegal-opcode lock state)
 *   [13..15] padding
 *   [16..19] int32_t  count  (cycles remaining in slice)
 *   [20..23] uint32_t IRQlow (pending IRQ source bitmask)
 *   [24]     uint8_t  DB     (data bus latch)
 *   [25..27] padding
 *
 * @param {Uint8Array} bytes 28-byte snapshot
 * @returns {ReturnType<typeof formatCpuState> | null}
 */
/** MIPS R3000 (PS1) / R4300 (N64) register names, $0..$31. */
const MIPS_GPR_NAMES = [
  "zero", "at", "v0", "v1", "a0", "a1", "a2", "a3",
  "t0", "t1", "t2", "t3", "t4", "t5", "t6", "t7",
  "s0", "s1", "s2", "s3", "s4", "s5", "s6", "s7",
  "t8", "t9", "k0", "k1", "gp", "sp", "fp", "ra",
];

/** Decode the romdev MIPS regsnap (Uint32Array(35): 32 GPRs + LO + HI + PC) into a
 *  CPUState. Names follow the MIPS o32 ABI convention. */
function decodeMips(regs) {
  if (!regs || regs.length < 35) return null;
  const hx = (v) => "$" + (v >>> 0).toString(16).toUpperCase().padStart(8, "0");
  const named = {};
  for (let i = 0; i < 32; i++) named[MIPS_GPR_NAMES[i]] = hx(regs[i]);
  named.lo = hx(regs[32]);
  named.hi = hx(regs[33]);
  return {
    pc: regs[34] >>> 0,
    pcHex: hx(regs[34]),
    registers: named,
  };
}

function decode6502(bytes) {
  if (!bytes || bytes.length < 25) return null;
  const u16le = (o) => bytes[o] | (bytes[o + 1] << 8);
  const u32le = (o) => (bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16) | (bytes[o + 3] << 24)) >>> 0;
  const PC = u16le(4);
  const A  = bytes[6];
  const X  = bytes[7];
  const Y  = bytes[8];
  const S  = bytes[9];
  const P  = bytes[10];
  const tcount = u32le(0) | 0;
  const count  = u32le(16) | 0;
  const IRQlow = u32le(20);
  const DB     = bytes[24];
  const jammed = !!bytes[12];
  // 6502 P flags: N V - B D I Z C  (bit 5 unused / always reads 1)
  return formatCpuState({
    pc: PC,
    // Only the architectural 6502 registers go in `registers`. fceumm also
    // exposes core-internal latches/counters (data-bus latch, pending-IRQ
    // bitmask, cycle counters) — those are NOT 6502 state and were easy to
    // misread, so they live under `coreInternal`, clearly labeled.
    registers: { A, X, Y, S, P },
    coreInternal: {
      DB,       // data-bus latch (last value on the bus) — emulator-internal
      IRQlow,   // pending-IRQ source bitmask — emulator-internal
      tcount,   // temporary cycle counter — emulator-internal
      count,    // cycles remaining in the current slice — emulator-internal
      note: "fceumm core-internal values, NOT architectural 6502 registers — don't read these as CPU state.",
    },
    flags: {
      N: !!(P & 0x80),
      V: !!(P & 0x40),
      B: !!(P & 0x10),
      D: !!(P & 0x08),
      I: !!(P & 0x04),
      Z: !!(P & 0x02),
      C: !!(P & 0x01),
      jammed,
    },
    sp: 0x100 | S,
  });
}

/**
 * Decode the Z80 CPU state from gpgx's `Z80_Regs` struct.
 *
 * Struct layout (little-endian, PAIR = 4 bytes union: byte 0 = L, byte 1 = H):
 *   offset 0-3:   pc
 *           4-7:  sp
 *           8-11: af  (A at byte 9, F at byte 8)
 *          12-15: bc  (B at 13, C at 12)
 *          16-19: de  (D at 17, E at 16)
 *          20-23: hl  (H at 21, L at 20)
 *          24-27: ix
 *          28-31: iy
 *          32-35: wz  (memptr — internal)
 *          36-39: af2 (shadow)
 *          40-43: bc2
 *          44-47: de2
 *          48-51: hl2
 *          52:    r
 *          53:    r2
 *          54:    iff1
 *          55:    iff2
 *          56:    halt
 *          57:    im
 *          58:    i
 *          59-62: nmi_state, nmi_pending, irq_state, after_ei
 *
 * F flag bits (Z80 standard): SZ5H3PNC
 *   bit 7 S  — sign
 *   bit 6 Z  — zero
 *   bit 5 Y  — undocumented
 *   bit 4 H  — half-carry
 *   bit 3 X  — undocumented
 *   bit 2 PV — parity/overflow
 *   bit 1 N  — add/subtract
 *   bit 0 C  — carry
 *
 * @param {Uint8Array} bytes
 * @returns {CPUState}
 */
function decodeZ80(bytes) {
  const w = (off) => bytes[off] | (bytes[off + 1] << 8);
  const pc = w(0);
  const sp = w(4);
  const af = w(8);
  const bc = w(12);
  const de = w(16);
  const hl = w(20);
  const ix = w(24);
  const iy = w(28);
  const af2 = w(36);
  const bc2 = w(40);
  const de2 = w(44);
  const hl2 = w(48);
  const r = bytes[52];
  const r2 = bytes[53];
  const iff1 = bytes[54];
  const iff2 = bytes[55];
  const halt = bytes[56];
  const im = bytes[57];
  const i = bytes[58];

  const f = af & 0xFF;
  const a = (af >> 8) & 0xFF;

  return {
    pc,
    sp,
    registers: {
      A: a,
      F: f,
      B: (bc >> 8) & 0xFF,
      C: bc & 0xFF,
      D: (de >> 8) & 0xFF,
      E: de & 0xFF,
      H: (hl >> 8) & 0xFF,
      L: hl & 0xFF,
      AF: af,
      BC: bc,
      DE: de,
      HL: hl,
      IX: ix,
      IY: iy,
      AF_shadow: af2,
      BC_shadow: bc2,
      DE_shadow: de2,
      HL_shadow: hl2,
      I: i,
      R: (r & 0x7F) | (r2 & 0x80),  // refresh — H bit from r2, low 7 from r
    },
    flags: {
      S: !!(f & 0x80),
      Z: !!(f & 0x40),
      H: !!(f & 0x10),
      PV: !!(f & 0x04),
      N: !!(f & 0x02),
      C: !!(f & 0x01),
      raw: "0x" + f.toString(16).toUpperCase().padStart(2, "0"),
    },
    interrupts: {
      iff1: !!iff1,
      iff2: !!iff2,
      mode: im,
      halted: !!halt,
    },
  };
}

/**
 * Get the running core's CPU state in a generic shape.
 * Dispatches per-platform + per-CPU; returns null when not supported.
 *
 * @param {import("./LibretroHost.js").LibretroHost} host
 * @param {string} platform
 * @param {string} [cpu] "main" (default) or "spc700" for SNES
 * @returns {CPUState | null}
 */
export function getCPUState(host, platform, cpu = "main") {
  if (platform === "n64" || platform === "ps1") {
    return decodeMips(host.getMipsRegs?.());
  }
  if (platform === "nes") {
    const bytes = host.readMemory("nes_cpu_regs", 0, 28);
    return decode6502(bytes);
  }
  if (platform === "snes") {
    const state = host.serializeState();
    if (cpu === "spc700") return decodeSnes9xSPC(state);
    return decodeSnes9xCPU(state); // 65816
  }
  if (platform === "genesis") {
    if (cpu === "z80") {
      // gpgx runs ONE Z80 core for both SMS and Genesis — the global `Z80`
      // struct the patch snapshots for the `sms_z80_regs` region (id 0x133)
      // IS the Genesis sound Z80 when a Genesis ROM is loaded. So the same
      // region + decoder works here; no separate genesis_z80_regs needed.
      // (The Z80 is held in reset until the 68k releases it via $A11100/
      // $A11200 — a freshly-booted ROM may show PC=0 / all-zero regs.)
      const bytes = host.readMemory("sms_z80_regs", 0, 63);
      return decodeZ80(bytes);
    }
    // Default "main" → m68k. The gpgx region exposes the live struct;
    // we know the offsets from m68k.h (see gpgx-state.js comments).
    const SIZE = 5560; // m68ki_cpu_core size on wasm32 (libretro+jmp_buf)
    const bytes = host.readMemory("genesis_m68k", 0, SIZE);
    return decodeGenesisM68k(bytes);
  }
  if (platform === "sms" || platform === "gg") {
    // gpgx exposes the live Z80_Regs struct via sms_z80_regs.
    // sizeof(Z80_Regs) on wasm32 ≈ 60 + 4 (cycles) + 12 (daisy ptr + irq cb)
    // We only read the first 63 bytes (everything up through interrupt state).
    const bytes = host.readMemory("sms_z80_regs", 0, 63);
    return decodeZ80(bytes);
  }
  if (platform === "atari2600") {
    const b = host.readMemory("a26_cpu_regs", 0, 7);
    const pc = b[0] | (b[1] << 8);
    const p = b[5];
    return {
      pc,
      sp: 0x100 | b[6],
      registers: { A: b[2], X: b[3], Y: b[4], P: p, SP: b[6] },
      flags: {
        N: !!(p & 0x80), V: !!(p & 0x40), B: !!(p & 0x10), D: !!(p & 0x08),
        I: !!(p & 0x04), Z: !!(p & 0x02), C: !!(p & 0x01),
        raw: "0x" + p.toString(16).toUpperCase().padStart(2, "0"),
      },
    };
  }
  if (platform === "atari7800") {
    const b = host.readMemory("a78_cpu_regs", 0, 7);
    const pc = b[0] | (b[1] << 8);
    const p = b[5];
    return {
      pc,
      sp: 0x100 | b[6],
      registers: { A: b[2], X: b[3], Y: b[4], P: p, SP: b[6] },
      flags: {
        N: !!(p & 0x80), V: !!(p & 0x40), B: !!(p & 0x10), D: !!(p & 0x08),
        I: !!(p & 0x04), Z: !!(p & 0x02), C: !!(p & 0x01),
        raw: "0x" + p.toString(16).toUpperCase().padStart(2, "0"),
      },
    };
  }
  if (platform === "c64") {
    const b = host.readMemory("c64_cpu_regs", 0, 7);
    const pc = b[0] | (b[1] << 8);
    const p = b[5];
    // IO port at $0001 controls KERNAL/BASIC/CHAR-ROM banking. We read it
    // from mem_ram[1], which is the underlying RAM cell. The EFFECTIVE
    // port value lives in vice's pport.data_out struct (not exposed yet)
    // and may differ from mem_ram[1] depending on DDR bits at mem_ram[0].
    // Most agents care about the banking state — for that, the effective
    // value matters more; we expose mem_ram[1] as a useful approximation.
    const ioPort = host.readMemory("system_ram", 1, 1)[0];
    return {
      pc,
      sp: 0x100 | b[6],
      registers: { A: b[2], X: b[3], Y: b[4], P: p, SP: b[6] },
      flags: {
        N: !!(p & 0x80), V: !!(p & 0x40), B: !!(p & 0x10), D: !!(p & 0x08),
        I: !!(p & 0x04), Z: !!(p & 0x02), C: !!(p & 0x01),
        raw: "0x" + p.toString(16).toUpperCase().padStart(2, "0"),
      },
      ioPort: {
        raw: "0x" + ioPort.toString(16).toUpperCase().padStart(2, "0"),
        loram:    !!(ioPort & 0x01),  // BASIC ROM visible at $A000-$BFFF
        hiram:    !!(ioPort & 0x02),  // KERNAL ROM visible at $E000-$FFFF
        charen:   !!(ioPort & 0x04),  // 0 = char ROM at $D000, 1 = I/O at $D000
        cassetteWrite: !!(ioPort & 0x08),
        cassetteSwitch: !!(ioPort & 0x10),
        cassetteMotor: !!(ioPort & 0x20),
      },
    };
  }
  if (platform === "gb" || platform === "gbc") {
    // Patched gambatte exposes an 18-byte SM83 snapshot. Inline decoder
    // — see src/platforms/gb/ppu.js#decodeSm83State for the doc'd layout.
    const bytes = host.readMemory("gb_cpu_regs", 0, 18);
    const u16 = (off) => bytes[off] | (bytes[off + 1] << 8);
    const a = bytes[4], f = bytes[5];
    const b = bytes[6], c = bytes[7];
    const d = bytes[8], e = bytes[9];
    const h = bytes[10], l = bytes[11];
    return {
      pc: u16(0),
      sp: u16(2),
      registers: {
        A: a, F: f,
        B: b, C: c,
        D: d, E: e,
        H: h, L: l,
        AF: (a << 8) | f,
        BC: (b << 8) | c,
        DE: (d << 8) | e,
        HL: (h << 8) | l,
      },
      flags: {
        Z: !!(f & 0x80),
        N: !!(f & 0x40),
        H: !!(f & 0x20),
        C: !!(f & 0x10),
        raw: "0x" + f.toString(16).toUpperCase().padStart(2, "0"),
      },
      interrupts: {
        ime: !!bytes[12],
        halted: !!bytes[13],
      },
    };
  }
  if (platform === "gba") {
    // Patched mgba exposes a 20-u32 ARM7TDMI snapshot via gba_cpu_regs:
    //   [0..15] gprs r0..r15 (r13=SP, r14=LR, r15=PC), [16] cpsr.packed,
    //   [17] spsr.packed, [18] executionMode (0=ARM,1=THUMB), [19] privMode.
    // The PC is pipeline-prefetched: the executing instruction is PC-8 (ARM)
    // or PC-4 (THUMB). We report the raw PC and the adjusted "exec" address.
    const bytes = host.readMemory("gba_cpu_regs", 0, 80);
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const u32 = (i) => dv.getUint32(i * 4, true) >>> 0;
    const gprs = [];
    for (let i = 0; i < 16; i++) gprs.push(u32(i));
    const cpsr = u32(16);
    const spsr = u32(17);
    const thumb = u32(18) === 1 || !!(cpsr & 0x20);
    const pc = gprs[15];
    const MODES = {
      0x10: "user", 0x11: "fiq", 0x12: "irq", 0x13: "supervisor",
      0x17: "abort", 0x1b: "undefined", 0x1f: "system",
    };
    const hex32 = (n) => "0x" + (n >>> 0).toString(16).toUpperCase().padStart(8, "0");
    const registers = {};
    for (let i = 0; i < 13; i++) registers["R" + i] = gprs[i];
    registers.SP = gprs[13];   // R13
    registers.LR = gprs[14];   // R14
    registers.PC = gprs[15];   // R15
    return {
      pc,
      sp: gprs[13],
      // The instruction actually executing, accounting for pipeline prefetch.
      execPc: (pc - (thumb ? 4 : 8)) >>> 0,
      registers,
      cpu: thumb ? "arm7tdmi (THUMB)" : "arm7tdmi (ARM)",
      flags: {
        N: !!(cpsr & 0x80000000), Z: !!(cpsr & 0x40000000),
        C: !!(cpsr & 0x20000000), V: !!(cpsr & 0x10000000),
        I: !!(cpsr & 0x80), F: !!(cpsr & 0x40), T: thumb,
        raw: hex32(cpsr),
      },
      mode: MODES[cpsr & 0x1f] || ("0x" + (cpsr & 0x1f).toString(16)),
      cpsr: hex32(cpsr),
      spsr: hex32(spsr),
      note: "ARM PC is pipeline-prefetched; the executing instruction is at execPc " +
        "(PC-8 in ARM, PC-4 in THUMB). Registers are decimal; cpsr/spsr/execPc are hex.",
    };
  }
  if (platform === "lynx") {
    // Patched handy exposes a 16-byte 65C02 snapshot via lynx_cpu_regs (see
    // the handy memory-regions patch). Layout: [0] PC lo, [1] PC hi, [2] A,
    // [3] X, [4] Y, [5] SP, [6] P (status, bit5 set), [7] flags-from-NMI/IRQ.
    const b = host.readMemory("lynx_cpu_regs", 0, 8);
    const pc = b[0] | (b[1] << 8);
    const p = b[6];
    return {
      pc,
      sp: 0x100 | b[5],
      registers: { A: b[2], X: b[3], Y: b[4], P: p, SP: b[5] },
      cpu: "65c02",
      flags: {
        N: !!(p & 0x80), V: !!(p & 0x40), B: !!(p & 0x10), D: !!(p & 0x08),
        I: !!(p & 0x04), Z: !!(p & 0x02), C: !!(p & 0x01),
        raw: "0x" + p.toString(16).toUpperCase().padStart(2, "0"),
      },
    };
  }
  if (platform === "pce") {
    // Patched geargrafx exposes a packed HuC6280 snapshot via pce_cpu_regs (see
    // geargrafx-romdev-memory-regions.patch). Layout (LE):
    //   [0..1] PC  [2] A  [3] X  [4] Y  [5] S  [6] P
    //   [7..10] SPEED(s32)  [11] timer_enabled  [12] timer_counter
    //   [13] timer_reload  [14] IDR  [15] IRR
    // The HuC6280 is a 65C02 superset; P flags are the standard NV-BDIZC.
    const b = host.readMemory("pce_cpu_regs", 0, 16);
    const pc = b[0] | (b[1] << 8);
    const p = b[6];
    return {
      pc,
      sp: 0x2100 | b[5], // HuC6280 stack page is fixed at $21xx via MPR
      registers: {
        A: b[2], X: b[3], Y: b[4], S: b[5], P: p,
        timer_counter: b[12], timer_reload: b[13], IDR: b[14], IRR: b[15],
      },
      cpu: "huc6280",
      flags: {
        N: !!(p & 0x80), V: !!(p & 0x40), T: !!(p & 0x20), B: !!(p & 0x10),
        D: !!(p & 0x08), I: !!(p & 0x04), Z: !!(p & 0x02), C: !!(p & 0x01),
        raw: "0x" + p.toString(16).toUpperCase().padStart(2, "0"),
      },
    };
  }
  if (platform === "msx") {
    // Patched blueMSX exposes a packed Z80/R800 snapshot via msx_cpu_regs (see
    // bluemsx-romdev-memory-regions.patch). Layout (LE, all u16 then u8):
    //   af bc de hl ix iy pc sp | af1 bc1 de1 hl1 | i r iff1 iff2 im halt
    const b = host.readMemory("msx_cpu_regs", 0, 30);
    const w = (o) => b[o] | (b[o + 1] << 8);
    const af = w(0), bc = w(2), de = w(4), hl = w(6);
    const ix = w(8), iy = w(10), pc = w(12), sp = w(14);
    const f = af & 0xFF, a = (af >> 8) & 0xFF;
    return {
      pc,
      sp,
      cpu: "z80",
      registers: {
        A: a, F: f,
        B: (bc >> 8) & 0xFF, C: bc & 0xFF,
        D: (de >> 8) & 0xFF, E: de & 0xFF,
        H: (hl >> 8) & 0xFF, L: hl & 0xFF,
        AF: af, BC: bc, DE: de, HL: hl, IX: ix, IY: iy,
        AF_shadow: w(16), BC_shadow: w(18), DE_shadow: w(20), HL_shadow: w(22),
        I: b[24], R: b[25],
      },
      flags: {
        S: !!(f & 0x80), Z: !!(f & 0x40), H: !!(f & 0x10),
        PV: !!(f & 0x04), N: !!(f & 0x02), C: !!(f & 0x01),
        raw: "0x" + f.toString(16).toUpperCase().padStart(2, "0"),
      },
      interrupts: {
        iff1: !!b[26], iff2: !!b[27], mode: b[28], halted: !!b[29],
      },
    };
  }
  return null;
}
