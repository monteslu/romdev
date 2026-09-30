// Port of m2c/arch_arm.py
import { DecompFailure } from "./error.js";
import { PyEnum, Target } from "./options.js";
import { AsmSymbolicData, Label } from "./asm_file.js";
import {
  ARM_BARREL_SHIFTER_OPS,
  AsmAddressMode,
  AsmGlobalSymbol,
  AsmInstruction,
  AsmLiteral,
  BinOp,
  JumpTarget,
  Macro,
  Register,
  RegisterList,
  Writeback,
  get_jump_target,
} from "./asm_instruction.js";
import { AsmPattern, Replacement, SimpleAsmPattern, make_pattern } from "./asm_pattern.js";
import { Instruction, InstructionMeta } from "./instruction.js";
import {
  Abi,
  AbiArgSlot,
  AddressMode,
  ArgLoc,
  Arch,
  BinaryOp,
  CarryBit,
  ErrorExpr,
  ExprStmt,
  Literal,
  SecondF64Half,
  UnaryOp,
  as_type,
  as_f32,
  as_f64,
  format_hex,
} from "./translate.js";
import {
  condition_from_expr,
  deref,
  eval_arm_cmp,
  fn_op,
  fold_divmod,
  fold_mul_chains,
  handle_add_arm,
  handle_add_double,
  handle_add_float,
  handle_add_real,
  handle_arm_mov,
  handle_bitinv,
  handle_convert,
  handle_la,
  handle_load,
  handle_or,
  handle_shift_right,
  handle_sll,
  handle_sub,
  handle_sub_arm,
  handle_xor,
  make_store,
  make_store_real,
  replace_bitand,
  set_arm_flags_from_add,
} from "./evaluate.js";
import { Type } from "./types.js";
import { band, bxor, floordiv, format, has, int_, pyassert, pymod, shr } from "./py.js";

export const SUFFIXABLE_INSTRUCTIONS = new Set([
  "adc", "adr", "add", "and", "asr", "b", "bic", "bl", "blx", "bx", "cbnz", "cbz", "clz", "cmn", "cmp", "cpy",
  "eor", "ldm", "ldr", "ldrb", "ldrh", "ldrsb", "ldrsh", "lsl", "lsr", "mla", "mls", "movimm.fictive", "mov",
  "mul", "mvn", "neg", "nop", "orn", "orr", "pop", "push", "rbit", "rev", "rev16", "revsh", "ror", "rrx", "rsb",
  "rsc", "sbc", "sdiv", "smlabb", "smlal", "smmla", "smmls", "smmul", "smulbb", "smull", "stm", "str", "strb",
  "strh", "sub", "tablejmp.fictive", "teq", "tst", "udiv", "umlal", "umull", "vldm", "vldr", "vstm", "vstr",
]);

export const LENGTH_THREE = new Set(["adc", "add", "and", "asr", "bic", "eor", "lsl", "lsr", "mul", "orn", "orr", "ror", "rsb", "rsc", "sbc", "sub"]);

export const THUMB1_FLAG_SETTING = new Set(["adc", "add", "and", "asr", "bic", "eor", "lsl", "lsr", "mov", "mul", "mvn", "neg", "orr", "ror", "sbc", "sub"]);

export const MAGIC_FUNCTIONS = {
  __divsi3: ["sdiv", "001"],
  _idiv: ["sdiv", "001"],
  __udivsi3: ["udiv", "001"],
  _uidiv: ["udiv", "001"],
  __modsi3: ["smod.fictive", "001"],
  __umodsi3: ["umod.fictive", "001"],
  _s32_div_f: ["sdivmod.fictive", "01"],
  _idivmod: ["sdivmod.fictive", "01"],
  _u32_div_f: ["udivmod.fictive", "01"],
  _uidivmod: ["udivmod.fictive", "01"],
  __clzsi2: ["clz", "00"],
  // Soft float emulation from fplib
  _fadd: ["add.s.fictive", "001"],
  _fsub: ["sub.s.fictive", "001"],
  _frsub: ["sub.s.fictive", "010"],
  _fmul: ["mul.s.fictive", "001"],
  _fdiv: ["div.s.fictive", "001"],
  _frdiv: ["div.s.fictive", "010"],
  _fsqrt: ["sqrt.s.fictive", "00"],
  _frnd: ["round.s.fictive", "00"],
  _fflt: ["cvt.s.w.fictive", "00"],
  _ffltu: ["cvt.s.u.fictive", "00"],
  _ffix: ["cvt.w.s.fictive", "00"],
  _ffixu: ["cvt.u.s.fictive", "00"],
  _f2d: ["cvt.d.s.fictive", "00"],
  _fls: ["c.lt.s.fictive", "01"],
  _fgr: ["c.gt.s.fictive", "01"],
  _fleq: ["c.le.s.fictive", "01"],
  _fgeq: ["c.ge.s.fictive", "01"],
  _feq: ["c.eq.s.fictive", "01"],
  _fneq: ["c.neq.s.fictive", "01"],
  _dadd: ["add.d.fictive", "002"],
  _dsub: ["sub.d.fictive", "002"],
  _drsub: ["sub.d.fictive", "020"],
  _dmul: ["mul.d.fictive", "002"],
  _ddiv: ["div.d.fictive", "002"],
  _drdiv: ["div.d.fictive", "020"],
  _dsqrt: ["sqrt.d.fictive", "00"],
  _drnd: ["round.d.fictive", "00"],
  _dflt: ["cvt.d.w.fictive", "00"],
  _dfltu: ["cvt.d.u.fictive", "00"],
  _dfix: ["cvt.w.d.fictive", "00"],
  _dfixu: ["cvt.u.d.fictive", "00"],
  _d2f: ["cvt.s.d.fictive", "00"],
  _dls: ["c.lt.d.fictive", "02"],
  _dgr: ["c.gt.d.fictive", "02"],
  _dleq: ["c.le.d.fictive", "02"],
  _dgeq: ["c.ge.d.fictive", "02"],
  _deq: ["c.eq.d.fictive", "02"],
  _dneq: ["c.neq.d.fictive", "02"],
};

const HI_REGS = new Set(["r8", "r9", "r10", "r11", "r12", "sp", "lr", "pc"].map((r) => new Register(r)));

export class Cc extends PyEnum {}
PyEnum.define(Cc, {
  EQ: "eq",
  NE: "ne",
  CS: "cs",
  CC: "cc",
  MI: "mi",
  PL: "pl",
  VS: "vs",
  VC: "vc",
  HI: "hi",
  LS: "ls",
  GE: "ge",
  LT: "lt",
  GT: "gt",
  LE: "le",
  AL: "al",
});

export const CC_REGS = new Map([
  [Cc.EQ, new Register("z")],
  [Cc.CS, new Register("c")],
  [Cc.MI, new Register("n")],
  [Cc.VS, new Register("v")],
  [Cc.HI, new Register("hi")],
  [Cc.GE, new Register("ge")],
  [Cc.GT, new Register("gt")],
]);

function cc_reg(cc) {
  const r = CC_REGS.get(cc);
  if (r === undefined) throw new Error(`KeyError: ${cc}`);
  return r;
}

const NEGATE = new Map([
  [Cc.EQ, Cc.NE],
  [Cc.NE, Cc.EQ],
  [Cc.CS, Cc.CC],
  [Cc.CC, Cc.CS],
  [Cc.MI, Cc.PL],
  [Cc.PL, Cc.MI],
  [Cc.VS, Cc.VC],
  [Cc.VC, Cc.VS],
  [Cc.HI, Cc.LS],
  [Cc.LS, Cc.HI],
  [Cc.GE, Cc.LT],
  [Cc.LT, Cc.GE],
  [Cc.GT, Cc.LE],
  [Cc.LE, Cc.GT],
]);

export function negate_cond(cc) {
  const r = NEGATE.get(cc);
  if (r === undefined) throw new Error(`KeyError: ${cc}`);
  return r;
}

const FACTOR = new Map([
  [Cc.EQ, [Cc.EQ, false]],
  [Cc.NE, [Cc.EQ, true]],
  [Cc.CS, [Cc.CS, false]],
  [Cc.CC, [Cc.CS, true]],
  [Cc.MI, [Cc.MI, false]],
  [Cc.PL, [Cc.MI, true]],
  [Cc.VS, [Cc.VS, false]],
  [Cc.VC, [Cc.VS, true]],
  [Cc.HI, [Cc.HI, false]],
  [Cc.LS, [Cc.HI, true]],
  [Cc.GE, [Cc.GE, false]],
  [Cc.LT, [Cc.GE, true]],
  [Cc.GT, [Cc.GT, false]],
  [Cc.LE, [Cc.GT, true]],
]);

export function factor_cond(cc) {
  const r = FACTOR.get(cc);
  if (r === undefined) throw new Error(`KeyError: ${cc}`);
  return r;
}

/** Returns [mnemonic, cc|null, set_flags, direction]. */
export function parse_suffix(mnemonic) {
  const ldm = mnemonic.startsWith("ldm") || mnemonic.startsWith("vldm");
  const stm = mnemonic.startsWith("stm") || mnemonic.startsWith("vstm");

  const strip_cc = (mn) => {
    for (const suffix of [...Cc.members.map((c) => c.value), "hs", "lo"]) {
      if (mn.endsWith(suffix)) {
        let cc;
        if (suffix === "hs") cc = Cc.CS;
        else if (suffix === "lo") cc = Cc.CC;
        else cc = Cc.of(suffix);
        return [mn.slice(0, -suffix.length), cc];
      }
    }
    return [mn, null];
  };

  const strip_dir = (mn) => {
    if (!ldm && !stm) return [mn, ""];
    if (["ia", "ib", "da", "db"].some((s) => mn.endsWith(s))) return [mn.slice(0, -2), mn.slice(-2)];
    if (["fa", "ea", "fd", "ed"].some((s) => mn.endsWith(s))) {
      const tr = { fa: ["da", "ib"], ea: ["db", "ia"], fd: ["ia", "db"], ed: ["ib", "da"] };
      return [mn.slice(0, -2), tr[mn.slice(-2)][ldm ? 0 : 1]];
    }
    return [mn, ""];
  };

  // bls should be parsed as b + ls, not bl + s
  let s_ok = !mnemonic.startsWith("b") || mnemonic.startsWith("bic");

  let memsize = "";
  if (mnemonic.startsWith("str") || mnemonic.startsWith("ldr")) {
    // ldrhs should be parsed as ldr + hs, not ldrh + s
    s_ok = false;
    for (const suffix of ["b", "h", "d"]) {
      if (mnemonic.endsWith(suffix)) {
        mnemonic = mnemonic.slice(0, -1);
        memsize = suffix;
        break;
      }
    }
    if ((memsize === "b" || memsize === "h") && mnemonic.endsWith("s") && (!strip_cc(mnemonic)[1] || strip_cc(mnemonic.slice(0, -1))[1])) {
      mnemonic = mnemonic.slice(0, -1);
      memsize = "s" + memsize;
    }
  }

  const orig_mn = mnemonic;
  for (const cc_is_last of [false, true]) {
    let direction;
    [mnemonic, direction] = strip_dir(orig_mn);
    let cc = null;
    let set_flags = "";
    if (cc_is_last) {
      [mnemonic, cc] = strip_cc(mnemonic);
      if (!direction) [mnemonic, direction] = strip_dir(mnemonic);
    }
    if (SUFFIXABLE_INSTRUCTIONS.has(mnemonic)) return [mnemonic + memsize, cc, set_flags, direction];
    if (mnemonic.endsWith("s") && s_ok) {
      set_flags = "s";
      mnemonic = mnemonic.slice(0, -1);
      if (SUFFIXABLE_INSTRUCTIONS.has(mnemonic)) return [mnemonic + memsize, cc, set_flags, direction];
    }
    if (!cc_is_last) {
      [mnemonic, cc] = strip_cc(mnemonic);
      if (SUFFIXABLE_INSTRUCTIONS.has(mnemonic)) return [mnemonic + memsize, cc, set_flags, direction];
    }
  }
  return [orig_mn + memsize, null, "", ""];
}

export function get_ldm_stm_offset(i, num_regs, direction) {
  if (direction === "ia") return 4 * i;
  if (direction === "ib") return 4 * (i + 1);
  if (direction === "da") return 4 * (i + 1 - num_regs);
  if (direction === "db") return 4 * (i - num_regs);
  pyassert(false, `bad ldm/stm direction ${direction}`);
}

export function other_f64_reg(reg) {
  const num = int_(reg.register_name.slice(1));
  return new Register(`r${num ^ 1}`);
}

export function vreg_type(reg) {
  const [tp] = reg.arm_regtype_index();
  if (tp === "s") return Type.reg32({ likely_float: true });
  else if (tp === "d") return Type.reg64({ likely_float: true });
  else if (tp === "q") return Type.reg128();
  pyassert(false, `invalid vldr target ${reg}`);
}

/** Detect switch jumps of the form "add pc, pc, reg, lsl 2". */
export class AddPcPcPattern extends AsmPattern {
  match(matcher) {
    const instr = matcher.input[matcher.index];
    if (!(instr instanceof Instruction) || !instr.mnemonic.startsWith("add")) return null;
    const [base, cc, set_flags] = parse_suffix(instr.mnemonic);
    if (
      base !== "add" ||
      set_flags ||
      instr.args[0] !== new Register("pc") ||
      instr.args[1] !== new Register("pc") ||
      !(instr.args[2] instanceof BinOp) ||
      instr.args[2].op !== "lsl" ||
      instr.args[2].rhs !== new AsmLiteral(2)
    ) {
      return null;
    }
    let i = matcher.index + 1;
    let seen_first = false;
    const new_args = [instr.args[2].lhs];
    while (i < matcher.input.length) {
      const ins2 = matcher.input[i];
      i += 1;
      if (ins2 instanceof Label) continue;
      if (!seen_first) {
        seen_first = true;
        continue;
      }
      if (ins2.mnemonic === "pop" && ins2.args[0] instanceof RegisterList && ins2.args[0].regs.includes(new Register("pc"))) {
        new_args.push(new AsmGlobalSymbol("_m2c_ret"));
      } else if (ins2.mnemonic === "b") {
        pyassert(ins2.args[0] instanceof AsmGlobalSymbol);
        new_args.push(ins2.args[0]);
      } else break;
    }
    const cc_str = cc !== null ? cc.value : "";
    const jump_ins = new AsmInstruction("tablejmp.fictive" + cc_str, new_args);
    return new Replacement([jump_ins], 1);
  }
}

/** Detect switch jumps emitted by MWCC for Thumb. */
export class ShortJumpTablePattern extends AsmPattern {
  pattern = make_pattern("adds $x, $x, $x", "add $x, $x, $pc", "ldrh $x, [$x, 6]", "movs $x, $x, lsl 0x10", "movs $x, $x, asr 0x10", "add $pc, $pc, $x", ".label:");

  match(matcher) {
    const m = matcher.try_match(this.pattern);
    if (!m) return null;
    const label = m.labels.get(".label").names[0];
    const ent = matcher.asm_data.values.get(label) ?? null;
    if (ent === null) return null;
    const new_args = [m.regs.get("x")];
    for (const data of ent.data) {
      if (
        !(data instanceof AsmSymbolicData) ||
        !(data.data instanceof BinOp) ||
        data.data.rhs !== new AsmLiteral(2) ||
        !(data.data.lhs instanceof BinOp) ||
        data.data.lhs.rhs !== new AsmGlobalSymbol(label)
      ) {
        break;
      }
      new_args.push(data.data.lhs.lhs);
    }
    const jump_ins = new AsmInstruction("tablejmp.fictive", new_args);
    return new Replacement([jump_ins], this.pattern.length - 1);
  }
}

function intersects(a, setb) {
  for (const x of a) if (setb.has(x)) return true;
  return false;
}

export class InstructionEffects {
  constructor() {
    this.inputs = new Set();
    this.outputs = new Set();
    this.is_effectful = false;
    this.has_load = false;
  }
  can_move_before(instr) {
    const outputs = [...instr.outputs, ...instr.clobbers];
    if (intersects([...instr.inputs, ...outputs], this.outputs)) return false;
    if (intersects(outputs, this.inputs)) return false;
    if (this.is_effectful && (instr.is_effectful || instr.is_load)) return false;
    if (this.has_load && instr.is_effectful) return false;
    return true;
  }
  add(instr) {
    for (const x of [...instr.outputs, ...instr.clobbers]) this.outputs.add(x);
    for (const x of instr.inputs) this.inputs.add(x);
    if (instr.is_effectful) this.is_effectful = true;
    if (instr.is_load) this.has_load = true;
  }
}

/** Replace conditionally executed instructions by branches. */
export class ConditionalInstrPattern extends AsmPattern {
  match(matcher) {
    let matched_cc = null;
    let i = 0;
    const if_instrs = [];
    const else_instrs = [];
    const before_instrs = [];
    const after_instrs = [];
    const mid_set = new InstructionEffects();
    const after_set = new InstructionEffects();
    let moved_before_streak = 0;
    let moved_after_streak = 0;
    const label1 = `._m2c_cc_${matcher.index}`;
    const label2 = `._m2c_cc2_${matcher.index}`;
    let flag_check = null;
    while (matcher.index + i < matcher.input.length) {
      const instr = matcher.input[matcher.index + i];
      if (!(instr instanceof Instruction)) break;
      const [base, cc, set_flags, direction] = parse_suffix(instr.mnemonic);
      if (cc === null) {
        if (matched_cc === null) return null;
        if (instr.is_jump()) break;
        if (mid_set.can_move_before(instr) && !after_instrs.length) {
          before_instrs.push(instr);
          moved_before_streak += 1;
        } else {
          after_set.add(instr);
          after_instrs.push(instr);
          moved_after_streak += 1;
        }
        i += 1;
        continue;
      }
      const outputs = [...instr.outputs, ...instr.clobbers];
      if (!after_set.can_move_before(instr)) break;
      if (after_instrs.length && instr.is_jump()) break;
      mid_set.add(instr);
      const new_instr = new AsmInstruction(base + set_flags + direction, instr.args);
      if (matched_cc === null) {
        if (base === "b") break;
        matched_cc = cc;
      }
      if (cc !== matched_cc && cc !== negate_cond(matched_cc)) break;
      if (flag_check !== null) if_instrs.push(flag_check);
      flag_check = null;
      if (matched_cc === cc) if_instrs.push(new_instr);
      else else_instrs.push(new_instr);
      i += 1;
      moved_before_streak = 0;
      moved_after_streak = 0;
      if (instr.is_jump()) break;
      if (outputs.includes(cc_reg(factor_cond(matched_cc)[0]))) {
        if (matched_cc === cc && !else_instrs.length) {
          const b_mn = "b" + negate_cond(matched_cc).value;
          flag_check = new AsmInstruction(b_mn, [new AsmGlobalSymbol(label1)]);
        } else break;
      }
    }
    if (matched_cc === null) return null;

    i -= moved_before_streak + moved_after_streak;
    before_instrs.splice(before_instrs.length - moved_before_streak);
    after_instrs.splice(after_instrs.length - moved_after_streak);

    const b_mn = "b" + negate_cond(matched_cc).value;
    if (else_instrs.length) {
      return new Replacement(
        [
          ...before_instrs,
          new AsmInstruction(b_mn, [new AsmGlobalSymbol(label1)]),
          ...if_instrs,
          new AsmInstruction("b", [new AsmGlobalSymbol(label2)]),
          Label.new(label1),
          ...else_instrs,
          Label.new(label2),
          ...after_instrs,
        ],
        i,
      );
    }
    return new Replacement([...before_instrs, new AsmInstruction(b_mn, [new AsmGlobalSymbol(label1)]), ...if_instrs, Label.new(label1), ...after_instrs], i);
  }
}

/** Replace negated registers in address modes by neg instructions. */
export class NegatedRegAddrModePattern extends AsmPattern {
  match(matcher) {
    const instr = matcher.input[matcher.index];
    if (!(instr instanceof Instruction)) return null;
    if (!instr.args.length || !(instr.args[instr.args.length - 1] instanceof AsmAddressMode)) return null;
    const last = instr.args[instr.args.length - 1];
    const addend = last.addend;
    const inner = addend instanceof BinOp && addend.op !== "-" ? addend.lhs : addend;
    if (!(inner instanceof BinOp) || inner.op !== "-") return null;
    const temp = Register.fictive("neg");
    let new_addend;
    if (addend instanceof BinOp && addend.op !== "-") new_addend = new BinOp(addend.op, temp, addend.rhs);
    else new_addend = temp;
    const new_args = [...instr.args];
    new_args[new_args.length - 1] = new AsmAddressMode(last.base, new_addend, last.writeback);
    return new Replacement([new AsmInstruction("rsb", [temp, inner.rhs, new AsmLiteral(0)]), new AsmInstruction(instr.mnemonic, new_args)], 1);
  }
}

/** Replace barrel shifted registers in address modes by additional instructions. */
export class ShiftedRegAddrModePattern extends AsmPattern {
  match(matcher) {
    const instr = matcher.input[matcher.index];
    if (!(instr instanceof Instruction)) return null;
    if (!instr.args.length || !(instr.args[instr.args.length - 1] instanceof AsmAddressMode)) return null;
    const last = instr.args[instr.args.length - 1];
    const addend = last.addend;
    if (!(addend instanceof BinOp) || !ARM_BARREL_SHIFTER_OPS.includes(addend.op)) return null;
    const temp = Register.fictive(addend.op);
    const new_args = [...instr.args];
    new_args[new_args.length - 1] = new AsmAddressMode(last.base, temp, last.writeback);
    return new Replacement([new AsmInstruction("mov", [temp, addend]), new AsmInstruction(instr.mnemonic, new_args)], 1);
  }
}

/** Replace writebacks in address modes by additional instructions. */
export class AddrModeWritebackPattern extends AsmPattern {
  match(matcher) {
    const instr = matcher.input[matcher.index];
    if (!(instr instanceof Instruction) || !instr.args.length) return null;
    const addr = instr.args[instr.args.length - 1];
    if (!(addr instanceof AsmAddressMode) || addr.writeback === null) return null;
    const new_args = [...instr.args];
    new_args[new_args.length - 1] = new AsmAddressMode(addr.base, new AsmLiteral(0), null);
    if (instr.args[0] === addr.base) {
      throw new DecompFailure("Writeback of same register as is being loaded/stored, " + `for instruction: ${instr}`);
    }
    if (addr.writeback === Writeback.PRE) {
      return new Replacement([new AsmInstruction("add", [addr.base, addr.base, addr.addend]), new AsmInstruction(instr.mnemonic, new_args)], 1);
    }
    return new Replacement([new AsmInstruction(instr.mnemonic, new_args), new AsmInstruction("add", [addr.base, addr.base, addr.addend])], 1);
  }
}

/** Replace register addends in address modes by a separate add instruction. */
export class RegRegAddrModePattern extends AsmPattern {
  match(matcher) {
    const instr = matcher.input[matcher.index];
    if (!(instr instanceof Instruction) || !instr.args.length) return null;
    const arg = instr.args[instr.args.length - 1];
    if (!(arg instanceof AsmAddressMode) || !(arg.addend instanceof Register)) return null;
    pyassert(arg.writeback === null);
    const temp = Register.fictive("mem_loc");
    const new_args = [...instr.args];
    new_args[new_args.length - 1] = new AsmAddressMode(temp, new AsmLiteral(0), null);
    return new Replacement([new AsmInstruction("add", [temp, arg.base, arg.addend]), new AsmInstruction(instr.mnemonic, new_args)], 1);
  }
}

/** Replace barrel shifted registers by additional instructions. */
export class ShiftedRegPattern extends AsmPattern {
  static _sets_flags(base, set_flags) {
    return Boolean(base === "tst" || base === "teq" || (["mov", "mvn", "and", "eor", "orr", "orn", "bic"].includes(base) && set_flags));
  }

  static _get_literal_carry(base, arg) {
    if (!(arg instanceof AsmLiteral)) return null;
    // Carry = bit 31 if the constant is greater than 255 and can be
    // produced by shifting an 8-bit value
    let value = band(arg.value, 0xffffffff);
    if (value >= 0x100 && value < band(value, -value) * 0x100) return shr(value, 31);
    if (base === "mov" || base === "mvn") value = bxor(value, 0xffffffff);
    if (value >= 0x100 && value < band(value, -value) * 0x100) return shr(value, 31);
    return null;
  }

  static sets_flags_based_on_barrel_shifter(base, set_flags, args) {
    if (!args.length) return false;
    const arg = args[args.length - 1];
    return (
      ShiftedRegPattern._sets_flags(base, set_flags) &&
      (ShiftedRegPattern._get_literal_carry(base, arg) !== null || (arg instanceof BinOp && ARM_BARREL_SHIFTER_OPS.includes(arg.op)))
    );
  }

  match(matcher) {
    const instr = matcher.input[matcher.index];
    if (!(instr instanceof Instruction) || !instr.args.length) return null;
    const [base, , set_flags] = parse_suffix(instr.mnemonic);
    const arg = instr.args[instr.args.length - 1];

    const literal_carry = ShiftedRegPattern._get_literal_carry(base, arg);
    if (literal_carry !== null) {
      if (!ShiftedRegPattern._sets_flags(base, set_flags)) return null;
      return new Replacement([instr, new AsmInstruction("setcarryi.fictive", [new AsmLiteral(literal_carry)])], 1);
    }

    if (!(arg instanceof BinOp) || !ARM_BARREL_SHIFTER_OPS.includes(arg.op)) return null;

    const temp = Register.fictive(arg.op);
    // (upstream builds the 3-arg form and pops the last arg for rrx; AsmInstruction
    // is interned here, so build the final arg list directly)
    const shift_args = arg.op === "rrx" ? [temp, arg.lhs] : [temp, arg.lhs, arg.rhs];
    const shift_ins = new AsmInstruction(arg.op, shift_args);
    const new_instrs = [shift_ins, new AsmInstruction(instr.mnemonic, [...instr.args.slice(0, -1), temp])];
    if (ShiftedRegPattern._sets_flags(base, set_flags)) new_instrs.push(new AsmInstruction("setcarry.fictive", [temp]));
    return new Replacement(new_instrs, 1);
  }
}

export class PopAndReturnPattern extends SimpleAsmPattern {
  pattern = make_pattern("pop {x}", "add $sp, $sp, N?", "bx $x");
  replace(m) {
    return new Replacement([new AsmInstruction("bx", [new Register("lr")])], m.body.length);
  }
}

export class OldThumbBlxPattern extends SimpleAsmPattern {
  pattern = make_pattern("mov $lr, $pc", "bx $x");
  replace(m) {
    return new Replacement([new AsmInstruction("blx", [m.regs.get("x")])], m.body.length);
  }
}

export class IndirectTailCallPattern extends SimpleAsmPattern {
  pattern = make_pattern("bx $x");
  replace(m) {
    if (m.regs.get("x") === new Register("lr")) return null;
    return new Replacement([new AsmInstruction("blx", [m.regs.get("x")]), new AsmInstruction("bx", [new Register("lr")])], m.body.length);
  }
}

/** `return fn(...);` may be optimized to perform a `b fn` instead of `bl fn; bx lr`. */
export class TailCallPattern extends AsmPattern {
  match(matcher) {
    const instr = matcher.input[matcher.index];
    if (instr instanceof Instruction && instr.mnemonic === "b" && instr.args[0] instanceof AsmGlobalSymbol && !matcher.is_local_label(instr.args[0].symbol_name)) {
      return new Replacement([new AsmInstruction("bl", instr.args), new AsmInstruction("bx", [new Register("lr")])], 1);
    }
    return null;
  }
}

/** Replace bl by b when used for intra-function jumps. */
export class BlBranchPattern extends AsmPattern {
  match(matcher) {
    const is_local_bl = (instr) => instr.mnemonic === "bl" && instr.args[0] instanceof AsmGlobalSymbol && matcher.is_local_label(instr.args[0].symbol_name);

    const instr = matcher.input[matcher.index];
    if (instr instanceof Instruction && is_local_bl(instr)) {
      return new Replacement([new AsmInstruction("b", instr.args)], 1, [new Register("lr")]);
    }

    if (matcher.index + 2 >= matcher.input.length) return null;
    const instr2 = matcher.input[matcher.index + 1];
    const label = matcher.input[matcher.index + 2];
    if (
      instr instanceof Instruction &&
      instr2 instanceof Instruction &&
      label instanceof Label &&
      is_local_bl(instr2) &&
      instr.jump_target instanceof JumpTarget &&
      label.names.includes(instr.jump_target.target) &&
      instr.is_conditional
    ) {
      const [base, cc] = parse_suffix(instr.mnemonic);
      if (base === "b" && cc !== null) {
        const b_mn = "b" + negate_cond(cc).value;
        return new Replacement([new AsmInstruction(b_mn, instr2.args)], 2, [new Register("lr")]);
      }
    }
    return null;
  }
}

export class MagicFuncPattern extends SimpleAsmPattern {
  pattern = make_pattern("bl");
  replace(m) {
    const ins = m.body[0];
    pyassert(ins instanceof Instruction);
    pyassert(ins.args[0] instanceof AsmGlobalSymbol);
    let target = ins.args[0].symbol_name;
    if (target.startsWith("_call_via_")) {
      const reg_name = target.slice(10);
      let reg = has(ArmArch.prototype.aliased_regs, reg_name) ? ArmArch.prototype.aliased_regs[reg_name] : null;
      if (reg === null && ArmArch.prototype.all_regs.includes(new Register(reg_name))) reg = new Register(reg_name);
      if (reg !== null) return new Replacement([new AsmInstruction("blx", [reg])], 1);
    }
    if (target.startsWith("__aeabi_")) target = target.slice(7);
    if (has(MAGIC_FUNCTIONS, target)) {
      const [mn, arg_str] = MAGIC_FUNCTIONS[target];
      const args = [...arg_str].map((x) => new Register("r" + x));
      return new Replacement([new AsmInstruction(mn, args)], 1, []);
    }
    return null;
  }
}

export class ArmArch extends Arch {
  missing_return() {
    return [this.parse("bx", [new Register("lr")], InstructionMeta.missing())];
  }

  normalize_instruction(instr, asm_state) {
    if (instr.mnemonic.endsWith(".n") || instr.mnemonic.endsWith(".w")) instr = new AsmInstruction(instr.mnemonic.slice(0, -2), instr.args);
    if (asm_state.is_thumb && !asm_state.is_unified) {
      if (instr.mnemonic.length > 3 && instr.mnemonic.endsWith("s")) {
        throw new DecompFailure("Missing '.syntax unified' marker");
      }
      if (THUMB1_FLAG_SETTING.has(instr.mnemonic) && instr.args.every((arg) => !HI_REGS.has(arg))) {
        instr = new AsmInstruction(instr.mnemonic + "s", instr.args);
      }
    }
    return this.normalize_instruction_real(instr);
  }

  normalize_instruction_real(instr) {
    let [base, cc, set_flags, direction] = parse_suffix(instr.mnemonic);
    if (cc === Cc.AL) {
      cc = null;
      instr = new AsmInstruction(base + set_flags + direction, instr.args);
    }
    const cc_str = cc ? cc.value : "";
    const suffix = cc_str + set_flags + direction;
    const args = instr.args;
    if (args.length === 3) {
      if (base === "lsl" && args[2] === new AsmLiteral(0)) return new AsmInstruction("mov" + suffix, args.slice(0, 2));
      if (base === "add" && !set_flags && args[2] === new AsmLiteral(0)) return new AsmInstruction("mov" + suffix, args.slice(0, 2));
      if (["asr", "lsl", "lsr", "ror"].includes(base)) return new AsmInstruction("mov" + suffix, [args[0], new BinOp(base, args[1], args[2])]);
    }
    if (args.length === 2) {
      if (instr.mnemonic === "mov" && args[0] === args[1] && args[1] === new Register("r8")) return new AsmInstruction("nop", []);
      if (
        base === "ldr" &&
        args[0] instanceof Register &&
        args[1] instanceof AsmAddressMode &&
        args[1].base === new Register("sp") &&
        args[1].addend === new AsmLiteral(4) &&
        args[1].writeback === Writeback.POST
      ) {
        return new AsmInstruction("pop" + suffix, [new RegisterList([args[0]])]);
      }
      if (base === "ldr" && args[1] instanceof Macro && args[1].macro_name === "eqsign") {
        const mn = args[1].argument instanceof AsmLiteral ? "movimm.fictive" : "adr";
        return new AsmInstruction(mn + suffix, [args[0], args[1].argument]);
      }
      if (
        base === "str" &&
        args[0] instanceof Register &&
        args[1] instanceof AsmAddressMode &&
        args[1].base === new Register("sp") &&
        args[1].addend === new AsmLiteral(-4) &&
        args[1].writeback === Writeback.PRE
      ) {
        return new AsmInstruction("push" + suffix, [new RegisterList([args[0]])]);
      }
      if (base === "cpy") return new AsmInstruction("mov" + suffix, args);
      if (base === "neg") return new AsmInstruction("rsb" + suffix, [...args, new AsmLiteral(0)]);
      if (base === "rrx") return new AsmInstruction("mov" + suffix, [args[0], new BinOp(base, args[1], new AsmLiteral(1))]);
      if (["stm", "ldm", "vstm", "vldm"].includes(base) && !direction) return this.normalize_instruction_real(new AsmInstruction(instr.mnemonic + "ia", args));
      const sp_excl = new AsmAddressMode(new Register("sp"), new AsmLiteral(0), Writeback.PRE);
      if ((base === "stm" || base === "vstm") && direction === "db" && args[0] === sp_excl) {
        const v = base === "vstm" ? "v" : "";
        return new AsmInstruction(v + "push" + cc_str, [args[1]]);
      }
      if ((base === "ldm" || base === "vldm") && direction === "ia" && args[0] === sp_excl) {
        const v = base === "vldm" ? "v" : "";
        return new AsmInstruction(v + "pop" + cc_str, [args[1]]);
      }
      if (LENGTH_THREE.has(base)) return this.normalize_instruction_real(new AsmInstruction(instr.mnemonic, [args[0], ...args]));
    }
    if (instr.mnemonic.startsWith("it")) return new AsmInstruction("nop", []);
    return instr;
  }

  parse(mnemonic, args, meta) {
    const cls = this;
    let inputs = [];
    let clobbers = [];
    let outputs = [];
    let jump_target = null;
    let function_target = null;
    let is_conditional = false;
    let is_return = false;
    let is_load = false;
    let is_store = false;
    let is_effectful = true;
    let eval_fn = null;

    const instr_str = String(new AsmInstruction(mnemonic, args));

    let [base, cc, set_flags, direction] = parse_suffix(mnemonic);
    let cc_negated;
    if (cc !== null) [cc, cc_negated] = factor_cond(cc);
    else cc_negated = false;

    const get_inputs = (starti) => {
      const ret = [];
      for (let arg of args.slice(starti)) {
        if (arg instanceof AsmAddressMode) {
          ret.push(arg.base);
          arg = arg.addend;
        }
        if (arg instanceof BinOp) {
          if (arg.rhs instanceof Register) ret.push(arg.rhs);
          arg = arg.lhs;
        }
        if (arg instanceof BinOp && arg.op === "-" && arg.lhs === new AsmLiteral(0)) arg = arg.rhs;
        if (arg instanceof Register) ret.push(arg);
      }
      return ret;
    };

    if (base === "b") {
      pyassert(args.length === 1);
      jump_target = get_jump_target(args[0]);
      if (cc !== null) {
        is_conditional = true;
        eval_fn = (s, a) => {
          let cond = condition_from_expr(a.regs.get(cc_reg(cc)));
          if (cc_negated) cond = cond.negated();
          s.set_branch_condition(cond);
        };
      }
    } else if (base === "cbz" || base === "cbnz") {
      pyassert(args.length === 2);
      pyassert(args[0] instanceof Register);
      inputs = [args[0]];
      jump_target = get_jump_target(args[1]);
      is_conditional = true;
      eval_fn = (s, a) => {
        const op = base === "cbz" ? "==" : "!=";
        s.set_branch_condition(BinaryOp.icmp(a.reg(0), op, new Literal(0)));
      };
    } else if (base === "bx" && args[0] === new Register("lr")) {
      pyassert(args.length === 1);
      inputs = [new Register("lr")];
      is_return = true;
    } else if (base === "pop") {
      pyassert(args.length === 1);
      pyassert(args[0] instanceof RegisterList);
      outputs = [...args[0].regs];
      if (args[0].regs.includes(new Register("pc"))) is_return = true;
    } else if (base === "blx" && args[0] instanceof Register) {
      inputs = [...cls.argument_regs];
      inputs.push(args[0]);
      outputs = [...cls.all_return_regs];
      clobbers = [...cls.temp_regs];
      function_target = args[0];
      eval_fn = (s, a) => s.make_function_call(a.reg(0), outputs);
    } else if (base === "bl" || base === "blx") {
      pyassert(args.length === 1);
      inputs = [...cls.argument_regs];
      outputs = [...cls.all_return_regs];
      clobbers = [...cls.temp_regs];
      function_target = args[0];
      eval_fn = (s, a) => s.make_function_call(a.sym_imm(0), outputs);
    } else if (base === "ldr" && args[0] === new Register("pc")) {
      pyassert(!set_flags);
      inputs = get_inputs(1);
      outputs = [...cls.all_return_regs];
      is_return = true;
      function_target = args[1];
      eval_fn = (s, a) => {
        const target = handle_load(a, Type.reg32({ likely_float: false }));
        s.make_function_call(target, outputs);
      };
    } else if (base === "tablejmp.fictive") {
      pyassert(args.length >= 1 && args[0] instanceof Register);
      const targets = [];
      for (const arg of args.slice(1)) {
        pyassert(arg instanceof AsmGlobalSymbol);
        targets.push(new JumpTarget(arg.symbol_name));
      }
      inputs = [args[0]];
      jump_target = targets;
      is_conditional = true;
      eval_fn = (s, a) => s.set_switch_expr(a.reg(0), true);
    } else if (has(cls.instrs_no_flags, base)) {
      pyassert(!set_flags);
      pyassert(args[0] instanceof Register);
      outputs = [args[0]];
      inputs = get_inputs(1);
      is_effectful = false;
      is_load = base.startsWith("ldr") || base === "vldr";

      if (base.startsWith("cvt.")) {
        pyassert(args.length === 2 && args[1] instanceof Register);
        const mn_parts = base.split(".");
        if (mn_parts[1] === "d") outputs.push(other_f64_reg(args[0]));
        if (mn_parts[2] === "d") inputs.push(other_f64_reg(args[1]));
      } else if (base.endsWith(".d.fictive")) {
        for (const reg of args.slice(1)) {
          pyassert(reg instanceof Register);
          inputs.push(reg, other_f64_reg(reg));
        }
        outputs.push(other_f64_reg(args[0]));
      }

      eval_fn = (s, a) => {
        const target = a.reg_ref(0);
        s.set_reg(target, cls.instrs_no_flags[base](a));
        if (outputs.length === 2) s.set_reg(other_f64_reg(target), new SecondF64Half());
      };
    } else if (has(cls.instrs_divmod, base)) {
      pyassert(!set_flags);
      outputs = [new Register("r0"), new Register("r1")];
      inputs = get_inputs(0);
      is_effectful = false;
      eval_fn = (s, a) => {
        const [div, mod] = cls.instrs_divmod[base](a);
        s.set_reg_real(new Register("r0"), div, { function_return: true });
        s.set_reg_real(new Register("r1"), mod, { function_return: true });
      };
    } else if (base === "ldm") {
      pyassert(!set_flags);
      pyassert(["ia", "ib", "da", "db"].includes(direction));
      pyassert(args[1] instanceof RegisterList);
      const reg_list = args[1];
      outputs = [...args[1].regs];
      let writeback = false;
      let base_reg;
      if (args[0] instanceof Register) base_reg = args[0];
      else {
        pyassert(args[0] instanceof AsmAddressMode);
        pyassert(args[0].addend === new AsmLiteral(0));
        pyassert(args[0].writeback === Writeback.PRE);
        base_reg = args[0].base;
        if (outputs.includes(base_reg)) {
          // pass
        } else {
          outputs.push(base_reg);
          writeback = true;
        }
      }
      inputs = [base_reg];
      is_effectful = false;
      is_load = true;

      eval_fn = (s, a) => {
        const loads = [];
        for (let i = 0; i < reg_list.regs.length; i++) {
          const offset = get_ldm_stm_offset(i, reg_list.regs.length, direction);
          const target = new AddressMode(offset, base_reg);
          loads.push(deref(target, a.regs, a.stack_info, { size: 4 }));
        }
        reg_list.regs.forEach((r, k) => {
          if (k < loads.length) s.set_reg(r, as_type(loads[k], Type.reg32({ likely_float: false }), true));
        });
        if (writeback) {
          const imm = new Literal(4 * reg_list.regs.length);
          const op = direction === "ia" || direction === "ib" ? "+" : "-";
          s.set_reg(base_reg, BinaryOp.intptr(a.regs.get(base_reg), op, imm));
        }
      };
    } else if (base === "stm") {
      pyassert(!set_flags);
      pyassert(["ia", "ib", "da", "db"].includes(direction));
      pyassert(args[1] instanceof RegisterList);
      const reg_list = args[1];
      inputs = [...args[1].regs];
      let writeback = false;
      let base_reg;
      if (args[0] instanceof Register) base_reg = args[0];
      else {
        pyassert(args[0] instanceof AsmAddressMode);
        pyassert(args[0].addend === new AsmLiteral(0));
        pyassert(args[0].writeback === Writeback.PRE);
        base_reg = args[0].base;
        outputs.push(base_reg);
        writeback = true;
      }
      inputs.push(base_reg);
      is_store = true;

      eval_fn = (s, a) => {
        reg_list.regs.forEach((r, i) => {
          const offset = get_ldm_stm_offset(i, reg_list.regs.length, direction);
          const target = new AddressMode(offset, base_reg);
          const store = make_store_real(a.regs.get(r), a.regs.get_raw(r), target, a.regs, a.stack_info, Type.reg32({ likely_float: false }));
          if (store !== null) s.store_memory(store, r);
        });
        if (writeback) {
          const imm = new Literal(4 * reg_list.regs.length);
          const op = direction === "ia" || direction === "ib" ? "+" : "-";
          s.set_reg(base_reg, BinaryOp.intptr(a.regs.get(base_reg), op, imm));
        }
      };
    } else if (base === "mov" && args[0] === new Register("pc")) {
      pyassert(args.length === 2 && args[1] instanceof Register);
      inputs.push(args[1]);
      if (args[1] === new Register("lr")) is_return = true;
      else {
        jump_target = args[1];
        is_conditional = true;
        eval_fn = (s, a) => s.set_switch_expr(a.reg(1));
      }
    } else if (has(cls.instrs_store, base)) {
      pyassert(args[0] instanceof Register);
      inputs = [args[0]];
      is_store = true;
      if (args[1] instanceof AsmAddressMode) inputs.push(args[1].base);
      eval_fn = (s, a) => {
        const store = cls.instrs_store[base](a);
        if (store !== null) s.store_memory(store, a.reg_ref(0));
      };
    } else if (has(cls.instrs_nz_flags, base)) {
      if (base === "mov" || base === "mvn") pyassert(args.length === 2);
      else if (base === "mla") pyassert(args.length === 4);
      else pyassert(args.length === 3);
      pyassert(args[0] instanceof Register);
      outputs = [args[0]];
      inputs = get_inputs(1);
      if (set_flags) {
        outputs.push(new Register("n"), new Register("z"));
        clobbers = [new Register("hi"), new Register("ge"), new Register("gt")];
      }
      is_effectful = false;

      eval_fn = (s, a) => {
        let val = cls.instrs_nz_flags[base](a);
        val = s.set_reg(a.reg_ref(0), val);
        if (set_flags) {
          if (base === "mov" || base === "mul" || base === "mla") {
            const sval = as_type(val, Type.s32(), true, { unify: false });
            s.set_reg(new Register("n"), BinaryOp.scmp(sval, "<", new Literal(0)));
          } else {
            const top_bit = BinaryOp.int(val, "&", new Literal(2 ** 31));
            s.set_reg(new Register("n"), BinaryOp.icmp(top_bit, "!=", new Literal(0)));
          }
          s.set_reg(new Register("z"), BinaryOp.icmp(val, "==", new Literal(0)));
        }
      };
    } else if (has(cls.instrs_mul_full, base)) {
      pyassert(args.length === 4);
      pyassert(args[0] instanceof Register);
      pyassert(args[1] instanceof Register);
      outputs = [args[0], args[1]];
      inputs = get_inputs(2);
      if (set_flags) {
        outputs.push(new Register("n"), new Register("z"));
        clobbers = [new Register("hi"), new Register("ge"), new Register("gt")];
      }
      is_effectful = false;

      eval_fn = (s, a) => {
        let [hi, lo] = cls.instrs_mul_full[base](a);
        lo = s.set_reg(a.reg_ref(0), lo);
        hi = s.set_reg(a.reg_ref(1), hi);
        if (set_flags) {
          const shi = as_type(hi, Type.s32(), true, { unify: false });
          s.set_reg(new Register("n"), BinaryOp.scmp(shi, "<", new Literal(0)));
          s.set_reg(new Register("z"), new BinaryOp(BinaryOp.icmp(lo, "==", new Literal(0)), "&&", BinaryOp.icmp(hi, "==", new Literal(0)), { type: Type.boolean() }));
        }
      };
    } else if (base === "smlal" || base === "umlal") {
      pyassert(args.length === 4);
      pyassert(args[0] instanceof Register);
      pyassert(args[1] instanceof Register);
      outputs = [args[0], args[1], new Register(base)];
      inputs = get_inputs(0);
      if (set_flags) {
        outputs.push(new Register("n"), new Register("z"));
        clobbers = [new Register("hi"), new Register("ge"), new Register("gt")];
      }
      is_effectful = false;

      eval_fn = (s, a) => {
        const signed = base === "smlal";
        const tp = signed ? Type.sintish() : Type.uintish();
        const tp64 = signed ? Type.s64() : Type.u64();
        const lhs = as_type(a.reg(2), tp, true);
        const rhs = as_type(a.reg(3), tp, true);
        const orig = BinaryOp.int(a.reg(0), "+", BinaryOp.int(a.reg(1), "<<", new Literal(32)));
        const mul = BinaryOp.int(lhs, "*", rhs);
        let mlal = as_type(BinaryOp.int(orig, "+", mul), tp64, true);
        mlal = s.set_reg(new Register(base), mlal);
        const upper = BinaryOp.int(mlal, ">>", new Literal(32));
        const lo = as_type(mlal, Type.int_of_size(32), false);
        const hi = as_type(upper, Type.int_of_size(32), false);
        s.set_reg(a.reg_ref(0), lo);
        s.set_reg(a.reg_ref(1), hi);
        if (set_flags) {
          const as_s64 = as_type(mlal, Type.s64(), true, { unify: false });
          s.set_reg(new Register("n"), BinaryOp.scmp(as_s64, "<", new Literal(0)));
          s.set_reg(new Register("z"), BinaryOp.icmp(mlal, "==", new Literal(0)));
        }
      };
    } else if (base === "tst" || base === "teq") {
      pyassert(args.length === 2);
      inputs = get_inputs(0);
      outputs = [new Register("n"), new Register("z")];
      clobbers = [new Register("hi"), new Register("ge"), new Register("gt")];
      is_effectful = false;

      eval_fn = (s, a) => {
        const lhs = a.reg(0);
        const rhs = a.reg_or_imm(1);
        let val;
        if (base === "tst") {
          val = BinaryOp.int(lhs, "&", rhs);
          s.set_reg(new Register("z"), BinaryOp.icmp(val, "==", new Literal(0)));
        } else {
          val = BinaryOp.int(lhs, "^", rhs);
          s.set_reg(new Register("z"), BinaryOp.icmp(lhs, "==", rhs));
        }
        const top_bit = BinaryOp.int(val, "&", new Literal(2 ** 31));
        s.set_reg(new Register("n"), BinaryOp.icmp(top_bit, "!=", new Literal(0)));
      };
    } else if (mnemonic === "setcarryi.fictive") {
      pyassert(args.length === 1 && args[0] instanceof AsmLiteral);
      const imm = args[0].value;
      outputs = [new Register("c"), new Register("hi")];
      inputs = imm ? [new Register("z")] : [];
      is_effectful = false;

      eval_fn = (s, a) => {
        s.set_reg(new Register("c"), new Literal(imm));
        if (imm === 0) s.set_reg(new Register("hi"), new Literal(0));
        else {
          const z = condition_from_expr(a.regs.get(new Register("z")));
          s.set_reg(new Register("hi"), z.negated());
        }
      };
    } else if (mnemonic === "setcarry.fictive") {
      pyassert(args.length === 1 && args[0] instanceof Register);
      outputs = [new Register("c"), new Register("hi")];
      inputs = [new Register("z")];
      is_effectful = false;

      eval_fn = (s, a) => {
        const c = s.set_reg(new Register("c"), new CarryBit(a.reg(0)));
        const z = condition_from_expr(a.regs.get(new Register("z")));
        const hi = new BinaryOp(c, "&&", z.negated(), { type: Type.boolean() });
        s.set_reg(new Register("hi"), hi);
      };
    } else if (has(cls.instrs_add, base)) {
      pyassert(args.length === 3 && args[0] instanceof Register);
      outputs = [args[0]];
      if (set_flags) outputs.push(...cls.flag_regs);
      inputs = get_inputs(1);
      if (base === "adc") inputs.push(new Register("c"));
      is_effectful = false;

      eval_fn = (s, a) => {
        let val = cls.instrs_add[base](a);
        val = s.set_reg(a.reg_ref(0), val);
        if (set_flags) set_arm_flags_from_add(s, val);
      };
    } else if (has(cls.instrs_sub, base)) {
      pyassert(args.length === 3 && args[0] instanceof Register);
      outputs = [args[0]];
      if (set_flags) outputs.push(...cls.flag_regs);
      inputs = get_inputs(1);
      if (base === "sbc" || base === "rsc") inputs.push(new Register("c"));
      is_effectful = false;

      eval_fn = (s, a) => {
        let val = cls.instrs_sub[base](a);
        if (val instanceof BinaryOp) val = fold_divmod(val);
        val = fold_mul_chains(val);
        val = s.set_reg(a.reg_ref(0), val);
        if (set_flags) {
          s.set_reg(new Register("z"), BinaryOp.icmp(val, "==", new Literal(0, { type: val.type })));
          let sval = as_type(val, Type.s32(), true, { unify: false });
          s.set_reg(new Register("n"), BinaryOp.scmp(sval, "<", new Literal(0)));
          const v = fn_op("M2C_OVERFLOW", [sval], Type.boolean());
          s.set_reg(new Register("v"), v);
          const uval = as_type(val, Type.u32(), true, { unify: false });
          sval = as_type(val, Type.s32(), true, { unify: false });
          const s64u = as_type(uval, Type.s64(), false, { unify: false });
          const s64s = as_type(sval, Type.s64(), false, { unify: false });
          s.set_reg(new Register("c"), BinaryOp.scmp(s64u, ">=", new Literal(0)));
          s.set_reg(new Register("hi"), BinaryOp.scmp(s64u, ">", new Literal(0)));
          s.set_reg(new Register("ge"), BinaryOp.scmp(s64s, ">=", new Literal(0)));
          s.set_reg(new Register("gt"), BinaryOp.scmp(s64s, ">", new Literal(0)));
        }
      };
    } else if (base === "cmp") {
      pyassert(args.length === 2 && args[0] instanceof Register);
      outputs = [...cls.flag_regs];
      inputs = get_inputs(0);
      is_effectful = false;
      eval_fn = (s, a) => eval_arm_cmp(s, a.reg(0), a.reg_or_imm(1));
    } else if (base === "cmn") {
      pyassert(args.length === 2 && args[0] instanceof Register);
      outputs = [...cls.flag_regs];
      inputs = get_inputs(0);
      is_effectful = false;
      eval_fn = (s, a) => {
        const lhs = a.reg(0);
        const rhs = a.reg_or_imm(1);
        if (rhs instanceof Literal && band(rhs.value, 0xffffffff) !== 0x80000000) eval_arm_cmp(s, lhs, new Literal(-rhs.value));
        else set_arm_flags_from_add(s, handle_add_real(lhs, rhs, a));
      };
    } else if (has(cls.instrs_float_comp, base)) {
      pyassert(args.length === 2 && args[0] instanceof Register && args[1] instanceof Register);
      if (mnemonic.includes(".d.")) inputs = [args[0], other_f64_reg(args[0]), args[1], other_f64_reg(args[1])];
      else inputs = [args[0], args[1]];

      let [cmp_cc, handler] = cls.instrs_float_comp[base];
      let fc_negated;
      [cmp_cc, fc_negated] = factor_cond(cmp_cc);
      const creg = cc_reg(cmp_cc);

      clobbers = cls.flag_regs.filter((r) => r !== creg);
      outputs = [new Register("r0"), creg];
      is_effectful = false;

      eval_fn = (s, a) => {
        const cond = handler(a);
        s.set_reg_real(new Register("r0"), cond, { function_return: true });
        s.set_reg(creg, fc_negated ? cond.negated() : cond);
      };
      // (upstream rebinds cc_negated here; the outer `cc` stays as parsed)
      cc_negated = fc_negated;
    } else if (cls.instrs_ignore.has(base)) {
      is_effectful = false;
    } else {
      let maybe_dest_first;
      if (args.length && args[0] instanceof Register && base !== "bx") {
        inputs = args.slice(1).filter((r) => r instanceof Register);
        outputs = [args[0]];
        maybe_dest_first = true;
      } else maybe_dest_first = false;

      eval_fn = (s, a) => {
        const error = new ErrorExpr(`unknown instruction: ${instr_str}`);
        if (maybe_dest_first) s.set_reg_real(a.reg_ref(0), error, { emit_exactly_once: true });
        else s.write_statement(new ExprStmt(error));
      };
    }

    if (cc !== null) inputs.push(cc_reg(cc));

    if (ShiftedRegPattern.sets_flags_based_on_barrel_shifter(base, set_flags, args)) outputs.push(new Register("c"), new Register("hi"));

    return new Instruction({
      mnemonic,
      args,
      meta,
      inputs,
      clobbers,
      outputs,
      jump_target,
      function_target,
      is_conditional,
      is_return,
      is_store,
      is_load,
      is_effectful,
      eval_fn,
    });
  }

  default_function_abi_candidate_slots() {
    return [0, 1, 2, 3].map((i) => new AbiArgSlot(new ArgLoc(null, i, new Register(`r${i}`)), Type.any_reg()));
  }

  is_likely_partial_offset(addend) {
    return addend < 0x1000000 && pymod(addend, 0x100) === 0;
  }

  arg_name(loc) {
    if (loc.offset !== null) return `arg${format_hex(floordiv(loc.offset, 4) + 4)}`;
    pyassert(loc.reg !== null);
    return `arg${loc.reg.register_name.slice(1)}`;
  }

  /** Compute stack positions/registers used by a function according to the agbcc ABI. */
  function_abi(fn_sig, likely_regs, { for_call }) {
    void for_call;
    const known_slots = [];
    let candidate_slots = [];
    if (fn_sig.params_known) {
      let offset = 0;
      if (fn_sig.return_type.is_struct() && fn_sig.return_type.get_parameter_size_align_bytes()[0] > 4) {
        known_slots.push(new AbiArgSlot(new ArgLoc(null, 0, new Register("r0")), Type.ptr(fn_sig.return_type), { name: "__return__", comment: "return" }));
        offset = 4;
      }

      for (const param of fn_sig.params) {
        const param_type = param.type.decay();
        let [size, align] = param_type.get_parameter_size_align_bytes();
        size = band(size + 3, ~3);
        offset = band(offset + align - 1, -align);
        const name = param.name;
        for (let i = floordiv(offset, 4); i < floordiv(offset + size, 4); i++) {
          const unk_offset = 4 * i - offset;
          let reg2 = null;
          let stack_loc = null;
          if (i < 4) reg2 = new Register(`r${i}`);
          else stack_loc = (i - 4) * 4;
          let name2, sub_type, comment;
          if (size > 4) {
            name2 = name ? `${name}_unk${format(unk_offset, "X")}` : null;
            sub_type = Type.any();
            comment = `${param_type}+${format(unk_offset, "#x")}`;
          } else {
            pyassert(unk_offset === 0);
            name2 = name;
            sub_type = param_type;
            comment = null;
          }
          known_slots.push(new AbiArgSlot(new ArgLoc(stack_loc, i, reg2), sub_type, { name: name2, comment }));
        }
        offset += size;
      }

      if (fn_sig.is_variadic) {
        for (let i = floordiv(offset, 4); i < 4; i++) candidate_slots.push(new AbiArgSlot(new ArgLoc(null, i, new Register(`r${i}`)), Type.any_reg()));
      }
    } else {
      candidate_slots = this.default_function_abi_candidate_slots();
    }

    const valid_extra_regs = new Set();
    for (const slot of known_slots) if (slot.loc.reg !== null) valid_extra_regs.add(slot.loc.reg);
    const possible_slots = [];

    let lasti = -1;
    for (let i = 0; i < 4; i++) {
      if (!likely_regs.has(new Register(`r${i}`))) break;
      lasti = i;
    }
    for (let i = lasti; i > 0; i--) {
      if (likely_regs.get(new Register(`r${i}`))) likely_regs.set(new Register(`r${i - 1}`), true);
    }

    for (const slot of candidate_slots) {
      const reg = slot.loc.reg;
      if (reg === null || !likely_regs.has(reg)) continue;

      let require = null;
      if (slot === candidate_slots[0]) {
        // pass
      } else if (reg === new Register("r1")) require = ["r0"];
      else if (reg === new Register("r2")) require = ["r1"];
      else if (reg === new Register("r3")) require = ["r2"];
      if (require && !require.some((r) => valid_extra_regs.has(new Register(r)))) continue;

      valid_extra_regs.add(reg);

      if (!likely_regs.get(reg)) continue;

      possible_slots.push(slot);
    }

    return new Abi({ arg_slots: known_slots, possible_slots });
  }

  function_return(expr) {
    return new Map([
      [new Register("r0"), as_type(expr, Type.intptr(), true, { unify: false })],
      [new Register("r1"), fn_op("SECOND_REG", [expr], Type.reg32({ likely_float: false }))],
    ]);
  }
}

{
  const argument_regs = ["r0", "r1", "r2", "r3"].map((r) => new Register(r));
  const simple_temp_regs = [
    new Register("r12"),
    ...Array.from({ length: 16 }, (_, i) => new Register(`s${i}`)),
    ...Array.from({ length: 8 }, (_, i) => new Register(`d${i}`)),
    ...Array.from({ length: 4 }, (_, i) => new Register(`q${i}`)),
  ];
  const flag_regs = ["n", "z", "c", "v", "hi", "ge", "gt"].map((r) => new Register(r));
  const temp_regs = [...argument_regs, ...simple_temp_regs, ...flag_regs];
  const saved_regs = [
    new Register("lr"),
    ...Array.from({ length: 8 }, (_, i) => new Register(`r${i + 4}`)),
    ...Array.from({ length: 16 }, (_, i) => new Register(`s${i + 16}`)),
    ...Array.from({ length: 8 }, (_, i) => new Register(`d${i + 8}`)),
    ...Array.from({ length: 4 }, (_, i) => new Register(`q${i + 4}`)),
  ];
  const stack_pointer_reg = new Register("sp");
  const R = (n) => new Register(n);

  Object.assign(ArmArch.prototype, {
    arch: Target.ArchEnum.ARM,
    re_comment: String.raw`^[ \t]*#.*|[@;].*`,
    supports_dollar_regs: false,
    home_space_size: 0,
    stack_pointer_reg,
    frame_pointer_regs: [R("r7"), R("r11")],
    return_address_reg: R("lr"),
    base_return_regs: [[R("r0"), false]],
    all_return_regs: [R("r0"), R("r1")],
    argument_regs,
    simple_temp_regs,
    flag_regs,
    temp_regs,
    saved_regs,
    all_regs: [...saved_regs, ...temp_regs, stack_pointer_reg, R("pc")],
    aliased_regs: {
      a1: R("r0"),
      a2: R("r1"),
      a3: R("r2"),
      a4: R("r3"),
      v1: R("r4"),
      v2: R("r5"),
      v3: R("r6"),
      v4: R("r7"),
      v5: R("r8"),
      v6: R("r9"),
      v7: R("r10"),
      v8: R("r11"),
      wr: R("r7"),
      sb: R("r9"),
      tr: R("r9"),
      sl: R("r10"),
      fp: R("r11"),
      ip: R("r12"),
      r13: R("sp"),
      r14: R("lr"),
      r15: R("pc"),
    },
    asm_patterns: [
      new AddPcPcPattern(),
      new ShortJumpTablePattern(),
      new ConditionalInstrPattern(),
      new NegatedRegAddrModePattern(),
      new ShiftedRegAddrModePattern(),
      new ShiftedRegPattern(),
      new AddrModeWritebackPattern(),
      new RegRegAddrModePattern(),
      new PopAndReturnPattern(),
      new OldThumbBlxPattern(),
      new IndirectTailCallPattern(),
      new TailCallPattern(),
      new BlBranchPattern(),
      new MagicFuncPattern(),
    ],
    instrs_ignore: new Set(["push", "vpush", "vpop", "nop"]),
    instrs_no_flags: {
      // Bit-fiddling
      clz: (a) => fn_op("CLZ", [a.reg(1)], Type.intish()),
      rbit: (a) => fn_op("REVERSE_BITS", [a.reg(1)], Type.intish()),
      rev: (a) => fn_op("BSWAP32", [a.reg(1)], Type.intish()),
      rev16: (a) => fn_op("BSWAP16X2", [a.reg(1)], Type.intish()),
      revsh: (a) => fn_op("BSWAP16", [a.reg(1)], Type.s16()),
      // Shifts
      lsl: (a) => handle_sll(a, { arm: true }),
      asr: (a) => handle_shift_right(a, { arm: true, signed: true }),
      lsr: (a) => handle_shift_right(a, { arm: true, signed: false }),
      ror: (a) => fn_op("ROTATE_RIGHT", [a.reg(1), a.reg_or_imm(2)], Type.intish()),
      rrx: (a) => fn_op("ARM_RRX", [a.reg(1), a.regs.get(new Register("c"))], Type.intish()),
      // Immediate movs
      adr: (a) => handle_la(a),
      "movimm.fictive": (a) => a.full_imm(1),
      // Loading instructions
      ldr: (a) => handle_load(a, Type.reg32({ likely_float: false })),
      ldrb: (a) => handle_load(a, Type.u8()),
      ldrsb: (a) => handle_load(a, Type.s8()),
      ldrh: (a) => handle_load(a, Type.u16()),
      ldrsh: (a) => handle_load(a, Type.s16()),
      vldr: (a) => handle_load(a, vreg_type(a.reg_ref(0))),
      // Arithmetic
      smulbb: (a) => BinaryOp.int(a.reg(1), "*", a.reg(2)),
      smlabb: (a) => handle_add_real(a.reg(3), BinaryOp.int(a.reg(1), "*", a.reg(2)), a),
      sdiv: (a) => BinaryOp.sint(a.reg(1), "/", a.reg(2)),
      udiv: (a) => BinaryOp.uint(a.reg(1), "/", a.reg(2)),
      "smod.fictive": (a) => BinaryOp.sint(a.reg(1), "%", a.reg(2)),
      "umod.fictive": (a) => BinaryOp.uint(a.reg(1), "%", a.reg(2)),
      // Floating point arithmetic
      "add.s.fictive": (a) => handle_add_float(a),
      "sub.s.fictive": (a) => BinaryOp.f32(a.reg(1), "-", a.reg(2)),
      "div.s.fictive": (a) => BinaryOp.f32(a.reg(1), "/", a.reg(2)),
      "mul.s.fictive": (a) => BinaryOp.f32(a.reg(1), "*", a.reg(2)),
      "sqrt.s.fictive": (a) => fn_op("sqrtf", [as_f32(a.reg(1))], Type.f32()),
      "round.s.fictive": (a) => fn_op("roundf", [as_f32(a.reg(1))], Type.f32()),
      "add.d.fictive": (a) => handle_add_double(a),
      "sub.d.fictive": (a) => BinaryOp.f64(a.dreg(1), "-", a.dreg(2)),
      "div.d.fictive": (a) => BinaryOp.f64(a.dreg(1), "/", a.dreg(2)),
      "mul.d.fictive": (a) => BinaryOp.f64(a.dreg(1), "*", a.dreg(2)),
      "sqrt.d.fictive": (a) => fn_op("sqrt", [as_f64(a.dreg(1))], Type.f64()),
      "round.d.fictive": (a) => fn_op("round", [as_f64(a.dreg(1))], Type.f64()),
      // Floating point conversions
      "cvt.d.s.fictive": (a) => handle_convert(a.reg(1), Type.f64(), Type.f32()),
      "cvt.d.w.fictive": (a) => handle_convert(a.reg(1), Type.f64(), Type.intish()),
      "cvt.d.u.fictive": (a) => handle_convert(a.reg(1), Type.f64(), Type.u32()),
      "cvt.s.d.fictive": (a) => handle_convert(a.dreg(1), Type.f32(), Type.f64()),
      "cvt.s.w.fictive": (a) => handle_convert(a.reg(1), Type.f32(), Type.intish()),
      "cvt.s.u.fictive": (a) => handle_convert(a.reg(1), Type.f32(), Type.u32()),
      "cvt.w.d.fictive": (a) => handle_convert(a.dreg(1), Type.s32(), Type.f64()),
      "cvt.w.s.fictive": (a) => handle_convert(a.reg(1), Type.s32(), Type.f32()),
      "cvt.u.d.fictive": (a) => handle_convert(a.dreg(1), Type.u32(), Type.f64()),
      "cvt.u.s.fictive": (a) => handle_convert(a.reg(1), Type.u32(), Type.f32()),
    },
    instrs_float_comp: {
      "c.eq.s.fictive": [Cc.EQ, (a) => BinaryOp.fcmp(a.reg(0), "==", a.reg(1))],
      "c.lt.s.fictive": [Cc.CC, (a) => BinaryOp.fcmp(a.reg(0), "<", a.reg(1))],
      "c.ge.s.fictive": [Cc.CS, (a) => BinaryOp.fcmp(a.reg(0), ">=", a.reg(1))],
      "c.le.s.fictive": [Cc.LS, (a) => BinaryOp.fcmp(a.reg(0), "<=", a.reg(1))],
      "c.gt.s.fictive": [Cc.HI, (a) => BinaryOp.fcmp(a.reg(0), ">", a.reg(1))],
      "c.neq.s.fictive": [Cc.NE, (a) => BinaryOp.fcmp(a.reg(0), "==", a.reg(1)).negated()],
      "c.eq.d.fictive": [Cc.EQ, (a) => BinaryOp.dcmp(a.dreg(0), "==", a.dreg(1))],
      "c.lt.d.fictive": [Cc.CC, (a) => BinaryOp.dcmp(a.dreg(0), "<", a.dreg(1))],
      "c.ge.d.fictive": [Cc.CS, (a) => BinaryOp.dcmp(a.dreg(0), ">=", a.dreg(1))],
      "c.le.d.fictive": [Cc.LS, (a) => BinaryOp.dcmp(a.dreg(0), "<=", a.dreg(1))],
      "c.gt.d.fictive": [Cc.HI, (a) => BinaryOp.dcmp(a.dreg(0), ">", a.dreg(1))],
      "c.neq.d.fictive": [Cc.NE, (a) => BinaryOp.dcmp(a.dreg(0), "==", a.dreg(1)).negated()],
    },
    instrs_divmod: {
      "sdivmod.fictive": (a) => [BinaryOp.sint(a.reg(0), "/", a.reg(1)), BinaryOp.sint(a.reg(0), "%", a.reg(1))],
      "udivmod.fictive": (a) => [BinaryOp.uint(a.reg(0), "/", a.reg(1)), BinaryOp.uint(a.reg(0), "%", a.reg(1))],
    },
    instrs_nz_flags: {
      mov: (a) => handle_arm_mov(a),
      mul: (a) => BinaryOp.int(a.reg(1), "*", a.reg(2)),
      mla: (a) => BinaryOp.int(BinaryOp.int(a.reg(1), "*", a.reg(2)), "+", a.reg(3)),
      mvn: (a) => handle_bitinv(a.reg_or_imm(1)),
      and: (a) => replace_bitand(BinaryOp.int(a.reg(1), "&", a.reg_or_imm(2))),
      orr: (a) => handle_or(a.reg(1), a.reg_or_imm(2), { is_arm: true }),
      eor: (a) => handle_xor(a.reg(1), a.reg_or_imm(2)),
      bic: (a) => BinaryOp.int(a.reg(1), "&", UnaryOp.int("~", a.reg_or_imm(2))),
      orn: (a) => BinaryOp.int(a.reg(1), "|", UnaryOp.int("~", a.reg_or_imm(2))),
    },
    instrs_mul_full: {
      smull: (a) => [fold_divmod(BinaryOp.int(a.reg(2), "MULT_HI", a.reg(3))), BinaryOp.int(a.reg(2), "*", a.reg(3))],
      umull: (a) => [fold_divmod(BinaryOp.int(a.reg(2), "MULTU_HI", a.reg(3))), BinaryOp.int(a.reg(2), "*", a.reg(3))],
    },
    instrs_store: {
      str: (a) => make_store(a, Type.reg32({ likely_float: false })),
      strb: (a) => make_store(a, Type.int_of_size(8)),
      strh: (a) => make_store(a, Type.int_of_size(16)),
      vstr: (a) => make_store(a, vreg_type(a.reg_ref(0))),
    },
    instrs_add: {
      add: (a) => handle_add_arm(a),
      adc: (a) => handle_add_real(handle_add_arm(a), a.regs.get(new Register("c")), a),
    },
    instrs_sub: {
      sub: (a) => handle_sub_arm(a),
      rsb: (a) => handle_sub(a.reg_or_imm(2), a.reg(1)),
      sbc: (a) => handle_add_real(handle_sub(a.reg(1), a.reg_or_imm(2)), condition_from_expr(a.regs.get(new Register("c"))).negated(), a),
      rsc: (a) => handle_add_real(handle_sub(a.reg_or_imm(2), a.reg(1)), condition_from_expr(a.regs.get(new Register("c"))).negated(), a),
    },
  });
}

/** Arch variant that follows the APCS ABI used on Gameboy Advance. */
export class ArmGbaArch extends ArmArch {}
ArmGbaArch.prototype.base_struct_align = 4;
