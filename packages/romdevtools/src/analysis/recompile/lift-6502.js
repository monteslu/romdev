// 6502 → IR lifter. Turns one da65 6502 disassembly into the generic recompile
// IR (ir.js), tagging each instruction with an ABSTRACT op so a non-1:1 target
// emitter (m68k, z80, …) can translate the INTENT without knowing 6502. The 1:1
// emitter (65816 emulation mode) ignores the abstract tag and re-emits the
// mnemonic verbatim — both consume the same IR.
//
// This is the existing recompile-65816 classification logic, refactored to emit
// IR nodes instead of 65816 text. Same documented-opcode set, same seam
// detection, same refuse rules — but now source-agnostic at the boundary.
//
// Plain JS ESM + JSDoc.

import { parseDa65Line } from "../recompile-65816.js";
import { NES_REGISTERS } from "../../platforms/common/registers.js";
import {
  ABSTRACT, COND,
  irLabel, irReg, irBranch, irJump, irCall, irRet, irHwReg, irRefuse,
} from "./ir.js";

/** The 151 documented 6502 mnemonics — anything else (an undocumented opcode da65
 *  rendered, or a data byte caught in the stream) is REFUSED, not guessed. */
export const DOCUMENTED_6502 = new Set([
  "adc", "and", "asl", "bcc", "bcs", "beq", "bit", "bmi", "bne", "bpl", "brk",
  "bvc", "bvs", "clc", "cld", "cli", "clv", "cmp", "cpx", "cpy", "dec", "dex",
  "dey", "eor", "inc", "inx", "iny", "jmp", "jsr", "lda", "ldx", "ldy", "lsr",
  "nop", "ora", "pha", "php", "pla", "plp", "rol", "ror", "rti", "rts", "sbc",
  "sec", "sed", "sei", "sta", "stx", "sty", "tax", "tay", "tsx", "txa", "txs",
  "tya",
]);

/** mnemonic → abstract op, so an emitter switches on INTENT not the 6502 name.
 *  (Branches/jumps/calls/returns/hwreg are handled structurally below, not here.) */
const ABSTRACT_OF = {
  lda: ABSTRACT.LOAD_ACC, ldx: ABSTRACT.LOAD_X, ldy: ABSTRACT.LOAD_Y,
  sta: ABSTRACT.STORE_ACC, stx: ABSTRACT.STORE_X, sty: ABSTRACT.STORE_Y,
  tax: ABSTRACT.TRANSFER, tay: ABSTRACT.TRANSFER, txa: ABSTRACT.TRANSFER,
  tya: ABSTRACT.TRANSFER, tsx: ABSTRACT.TRANSFER, txs: ABSTRACT.TRANSFER,
  pha: ABSTRACT.PUSH, php: ABSTRACT.PUSH, pla: ABSTRACT.PULL, plp: ABSTRACT.PULL,
  adc: ABSTRACT.ADD, sbc: ABSTRACT.SUB, and: ABSTRACT.AND, ora: ABSTRACT.OR,
  eor: ABSTRACT.XOR, inc: ABSTRACT.INC, dec: ABSTRACT.DEC, asl: ABSTRACT.SHL,
  lsr: ABSTRACT.SHR, rol: ABSTRACT.ROL, ror: ABSTRACT.ROR, cmp: ABSTRACT.CMP,
  bit: ABSTRACT.BIT, inx: ABSTRACT.INX, iny: ABSTRACT.INY, dex: ABSTRACT.DEX,
  dey: ABSTRACT.DEY, cpx: ABSTRACT.CPX, cpy: ABSTRACT.CPY,
  clc: ABSTRACT.CLR_FLAG, sec: ABSTRACT.SET_FLAG, cli: ABSTRACT.CLR_FLAG,
  sei: ABSTRACT.SET_FLAG, clv: ABSTRACT.CLR_FLAG, cld: ABSTRACT.CLR_FLAG,
  nop: ABSTRACT.NOP,
};

/** 6502 conditional-branch mnemonic → ISA-neutral condition. */
const BRANCH_COND = {
  beq: COND.EQ, bne: COND.NE, bcc: COND.CC, bcs: COND.CS,
  bmi: COND.MI, bpl: COND.PL, bvc: COND.VC, bvs: COND.VS,
};

/**
 * Detect a hardware-register (MMIO) access — the seam. Returns the register's low
 * address if the operand targets a NES PPU/APU register, else null. Only absolute
 * operands count; immediates and zero-page never hit the register file.
 * @param {string|undefined} operand
 */
export function seamRegister(operand) {
  if (!operand) return null;
  const m = operand.match(/^\$([0-9A-Fa-f]{3,4})(?:\s*,\s*[xy])?$/);
  if (!m) return null;
  const addr = parseInt(m[1], 16);
  if (addr in NES_REGISTERS) return addr;
  if ((addr >= 0x2000 && addr <= 0x2007) || (addr >= 0x4000 && addr <= 0x4017)) return addr;
  return null;
}

/**
 * Lift one parsed da65 6502 line to an IR node (or null for blank/directive/equ —
 * those are handled by the orchestrator, which collects equs separately). The
 * leading label, if any, rides on the returned node so branch targets resolve.
 * @param {ReturnType<typeof parseDa65Line>} p
 * @returns {object|null}
 */
function liftInstr(p) {
  const label = p.label;
  const mnem = p.mnemonic;
  const operand = p.operand;

  // Refuse the non-mechanical constructs up front (same as the original).
  if (mnem === "sed") return irRefuse("decimal-mode (sed): BCD edge-flag semantics differ across ISAs", p.raw, label);
  if (mnem === "jmp" && operand && operand.startsWith("(")) {
    return irRefuse("indirect jump (jmp (addr)): target is computed — resolve with breakpoint({on:'jumptable'})", p.raw, label);
  }

  // Hardware seam: any PPU/APU register access becomes an IR hwreg node.
  const reg = seamRegister(operand);
  if (reg != null) {
    const isStore = mnem === "sta" || mnem === "stx" || mnem === "sty";
    const isLoad = mnem === "lda" || mnem === "ldx" || mnem === "ldy" || mnem === "bit";
    if (isStore) return irHwReg("write", reg, mnem, p.raw, label);
    if (isLoad) return irHwReg("read", reg, mnem, p.raw, label);
    return irRefuse(`hardware-register read-modify-write (${mnem} ${operand}): not in the mechanical set`, p.raw, label);
  }

  // Control flow → structural IR nodes.
  if (mnem === "jsr") return irCall(operand, p.raw, label);
  if (mnem === "jmp") return irJump(operand, p.raw, label);
  if (mnem === "rts") return irRet("sub", p.raw, label);
  if (mnem === "rti") return irRet("interrupt", p.raw, label);
  if (mnem === "brk") return irRefuse("brk: software interrupt needs explicit vector handling in v1", p.raw, label);
  if (mnem in BRANCH_COND) return irBranch(BRANCH_COND[mnem], operand, p.raw, label);

  // A documented data/ALU/transfer op → a `reg` node tagged with its abstract op.
  if (mnem in ABSTRACT_OF) {
    return irReg(ABSTRACT_OF[mnem], mnem, operand, p.raw, label);
  }

  // Unknown mnemonic = undocumented opcode or a parse miss.
  return irRefuse(`unrecognized/undocumented opcode '${mnem}' — not a documented 6502 instruction`, p.raw, label);
}

/**
 * Lift a block of da65 6502 asm text into an IR program. Returns the IR node list,
 * the collected equ definitions (address aliases), and a flag for whether the
 * first instruction was anchored (so the orchestrator can fix the entry label).
 * @param {string} da65Asm
 * @returns {{ ir: Array<object>, equs: string[], instrCount: number, seamCount: number, entry: string|null }}
 */
export function lift6502(da65Asm) {
  const lines = da65Asm.split("\n");
  const ir = [];
  const equs = [];
  let instrCount = 0;
  let seamCount = 0;
  let entry = null;
  const ENTRY_LABEL = "RECOMPILE_ENTRY";

  for (const raw of lines) {
    const p = parseDa65Line(raw);
    switch (p.kind) {
      case "blank":
      case "comment":
      case "directive":
        break;
      case "equ":
        equs.push(`${p.label} = ${p.operand}`);
        break;
      case "label":
        ir.push(irLabel(p.label));
        break;
      case "data":
        ir.push(irRefuse("data/.byte in code stream (data table or undocumented opcode)", p.raw));
        break;
      case "instr": {
        const node = liftInstr(p);
        if (!node) break;
        // Anchor the entry to the FIRST real instruction (lifted node), labeled or
        // not — da65 only labels branch targets, so a fall-through opener is
        // unlabeled and would otherwise let the reset skip the routine's setup.
        if (entry == null && node.op !== "refuse") {
          if (node.label) {
            entry = node.label;
          } else {
            entry = ENTRY_LABEL;
            ir.push(irLabel(ENTRY_LABEL));
          }
        } else if (entry == null && node.op === "refuse") {
          // even a refused opener anchors the entry so the vector lands at the top
          if (node.label) entry = node.label;
          else { entry = ENTRY_LABEL; ir.push(irLabel(ENTRY_LABEL)); }
        }
        if (node.op === "hwreg") seamCount++;
        if (node.op !== "refuse") instrCount++;
        ir.push(node);
        break;
      }
      default:
        break;
    }
  }
  return { ir, equs, instrCount, seamCount, entry };
}
