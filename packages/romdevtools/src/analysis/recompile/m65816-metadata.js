// 65816 (SNES) cycle and control-flow metadata for the IR exporter.
//
// snes9x has NO per-opcode cycle table: it charges `AddCycles(CPU.MemSpeed)`
// per memory access at 159 inline sites, and MemSpeed is 6 (fast bank) or 8
// (slow bank) master-clock units. An opcode's cost is therefore
//
//     accesses * MemSpeed + internal ONE_CYCLEs
//
// which is a function of the ADDRESSING MODE plus a per-opcode internal
// count. Those are the two things tabulated below. Constants come from
// snes9x's snes9x.h (ONE_CYCLE 6, SLOW_ONE_CYCLE 8), not from a datasheet.
//
// The recompiler charges in CPU cycles, not master-clock units, so the
// tables below are in CPU cycles: a fast access is 1, and the master-clock
// figure is recovered by multiplying by ONE_CYCLE.
export const ONE_CYCLE = 6;
export const SLOW_ONE_CYCLE = 8;

/** Bytes consumed by each addressing mode, EXCLUDING the opcode byte. */
const MODE_OPERAND_BYTES = {
  imp: 0, acc: 0,
  imm8: 1, imm16: 2, immM: -1, immX: -1,   // -1 = width follows M/X
  dp: 1, dpx: 1, dpy: 1,
  idp: 1, idpx: 1, idpy: 1, ildp: 1, ildpy: 1,
  abs: 2, absx: 2, absy: 2, absl: 3, abslx: 3,
  ind: 2, indx: 2, indl: 2,
  sr: 1, sry: 1,
  rel: 1, rell: 2,
  bm: 2,                                    // block move: two bank bytes
};

/** Memory ACCESSES each mode performs to form the address and fetch data. */
const MODE_ACCESSES = {
  imp: 0, acc: 0,
  imm8: 1, imm16: 2, immM: -1, immX: -1,
  dp: 2, dpx: 3, dpy: 3,
  idp: 4, idpx: 5, idpy: 5, ildp: 5, ildpy: 6,
  abs: 3, absx: 4, absy: 4, absl: 4, abslx: 5,
  ind: 4, indx: 5, indl: 5,
  sr: 3, sry: 5,
  rel: 1, rell: 2,
  bm: 7,
};

export const M65816_CYCLE_PROVENANCE = {
  source: "snes9x cpuaddr.h + snes9x.h",
  method:
    "snes9x has no opcode cycle table; it charges AddCycles(CPU.MemSpeed) " +
    "per access at 159 inline sites. Cost is derived as " +
    "accesses * MemSpeed + internal cycles, with the access count taken " +
    "from each addressing mode's helper in cpuaddr.h.",
  note:
    "MemSpeed is 6 for a fast bank and 8 for a slow one, so a cost in " +
    "master-clock units depends on WHERE the operand lives. These tables " +
    "are in CPU cycles (one fast access = 1).",
  oneCycle: ONE_CYCLE,
  slowOneCycle: SLOW_ONE_CYCLE,
};

export function modeOperandBytes(mode) { return MODE_OPERAND_BYTES[mode]; }
export function modeAccesses(mode) { return MODE_ACCESSES[mode]; }
