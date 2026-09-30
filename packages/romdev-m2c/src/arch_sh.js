// Port of m2c/arch_sh.py
/* eslint no-unused-vars: ["error", { "args": "none" }] -- keeps upstream's parameter lists */
import { DecompFailure } from "./error.js";
import { Target } from "./options.js";
import { AsmSymbolicData } from "./asm_file.js";
import { AsmAddressMode, AsmGlobalSymbol, AsmInstruction, AsmLiteral, BinOp, JumpTarget, Register, Writeback, get_jump_target } from "./asm_instruction.js";
import { AsmPattern, Replacement, SimpleAsmPattern, make_pattern } from "./asm_pattern.js";
import { get_literal_pool_symbol, get_literal_pool_symbolic_data } from "./flow_graph.js";
import { Instruction, InstructionMeta, StackLocation } from "./instruction.js";
import { IrPattern } from "./ir_pattern.js";
import { Abi, AbiArgSlot, Arch, InstrArgs, ArgLoc, BinaryOp, CarryBit, Cast, ErrorExpr, ExprStmt, Literal, UnaryOp, as_s16, as_type, as_u16, as_u32, early_unwrap } from "./translate.js";
import {
  condition_from_expr,
  fn_op,
  fold_divmod,
  fold_mul_chains,
  fold_shift_right,
  handle_add,
  handle_add_real,
  handle_addi,
  handle_bitinv,
  handle_load,
  handle_loadx,
  handle_or,
  handle_sub,
  handle_xor,
  make_store,
  make_storex,
  void_fn_op,
} from "./evaluate.js";
import { Type } from "./types.js";
import { floordiv, format, has, int_, pyassert, pyeq } from "./py.js";

/** dataclasses.replace(instr_args, raw_args=...) */
function with_raw_args(a, raw_args) {
  return new InstrArgs(a.instruction_ref, raw_args, a.regs, a.stack_info);
}

const MOV_TYPES = {
  "mov.b": () => Type.s8(),
  "mov.w": () => Type.s16(),
  "mov.l": () => Type.reg32({ likely_float: false }),
};
const MOV_STRIDES = { "mov.b": 1, "mov.w": 2, "mov.l": 4 };

function mov_type(mnemonic) {
  if (!has(MOV_TYPES, mnemonic)) throw new Error(`KeyError: '${mnemonic}'`);
  return MOV_TYPES[mnemonic]();
}
function mov_stride(mnemonic) {
  if (!has(MOV_STRIDES, mnemonic)) throw new Error(`KeyError: '${mnemonic}'`);
  return MOV_STRIDES[mnemonic];
}

const SH_STACK_POINTER_REG = new Register("r15");

export class FarJumpPattern extends AsmPattern {
  pattern = make_pattern("mov.l $t,@-$r15", "mov.l _, $t", "jmp @$t", "mov.l @$r15+,$t");

  match(matcher) {
    const m = matcher.try_match(this.pattern);
    if (m === null) return null;
    const load = m.body[1];
    pyassert(load instanceof Instruction);
    const target_name = get_literal_pool_symbol(load.args[0], m.asm_data);
    if (target_name === null || !matcher.is_local_label(target_name)) return null;
    return new Replacement([new AsmInstruction("bra", [new AsmGlobalSymbol(target_name)]), new AsmInstruction("nop", [])], m.body.length);
  }
}

export class JumpTablePattern extends AsmPattern {
  pattern1 = make_pattern("mova _, $b", "mov.w @($b,$i),$i", "add $i, $b", "jmp @$b", "nop");

  pattern2 = make_pattern("mova _, $b", "mov.w @($b,$i),$i", "add $i, $b", "bra .dispatch", "nop", "nop?", ".dispatch:", "jmp @$b", "nop");

  match(matcher) {
    for (const pattern of [this.pattern1, this.pattern2]) {
      const m = matcher.try_match(pattern);
      if (!m) continue;

      const mova = m.body[0];
      pyassert(mova instanceof Instruction);
      pyassert(mova.args[0] instanceof AsmGlobalSymbol);

      const table_name = mova.args[0].symbol_name;
      const table = m.asm_data.values.get(table_name) ?? null;
      if (table === null) return null;
      const targets = [];
      for (const entry of table.data) {
        if (
          !(entry instanceof AsmSymbolicData) ||
          !(entry.data instanceof BinOp) ||
          entry.data.op !== "-" ||
          !(entry.data.lhs instanceof AsmGlobalSymbol) ||
          entry.data.rhs !== new AsmGlobalSymbol(table_name)
        ) {
          return null;
        }
        targets.push(entry.data.lhs);
      }
      if (!targets.length) return null;
      const jump = new AsmInstruction("tablejmp.doubled.fictive", [m.regs.get("i"), ...targets]);
      return new Replacement([jump], m.body.length);
    }
    return null;
  }
}

export class BrafJumpTablePattern extends SimpleAsmPattern {
  pattern = make_pattern("mova _, $b", "mov.w @($b,$i),$b", "braf $b", "nop", ".base:");

  replace(m) {
    const mova = m.body[0];
    pyassert(mova instanceof Instruction);
    if (!(mova.args[0] instanceof AsmGlobalSymbol)) return null;
    const table = m.asm_data.values.get(mova.args[0].symbol_name) ?? null;
    if (table === null) return null;
    const base = m.labels.get(".base");
    const targets = [];
    for (const entry of table.data) {
      if (
        !(entry instanceof AsmSymbolicData) ||
        !(entry.data instanceof BinOp) ||
        entry.data.op !== "-" ||
        !(entry.data.lhs instanceof AsmGlobalSymbol) ||
        !(entry.data.rhs instanceof AsmGlobalSymbol) ||
        !base.names.includes(entry.data.rhs.symbol_name)
      ) {
        return null;
      }
      targets.push(entry.data.lhs);
    }
    if (!targets.length) return null;
    const jump = new AsmInstruction("tablejmp.doubled.fictive", [m.regs.get("i"), ...targets]);
    return new Replacement([jump, base], m.body.length);
  }
}

export class BsrfCallPattern extends SimpleAsmPattern {
  pattern = make_pattern("mov.l _,$r", "bsrf $r", "*", ".base:");

  replace(m) {
    const load = m.body[0];
    pyassert(load instanceof Instruction);
    const delay = m.wildcard_items[0];
    if (!(delay instanceof Instruction)) return null;
    const entry = get_literal_pool_symbolic_data(load.args[0], m.asm_data);
    if (
      entry === null ||
      !(entry.data instanceof BinOp) ||
      entry.data.op !== "-" ||
      !(entry.data.lhs instanceof AsmGlobalSymbol) ||
      !(entry.data.rhs instanceof AsmGlobalSymbol) ||
      !m.labels.get(".base").names.includes(entry.data.rhs.symbol_name)
    ) {
      return null;
    }
    return new Replacement([new AsmInstruction("bsr", [entry.data.lhs]), delay, m.labels.get(".base")], m.body.length);
  }
}

export class NegateTPattern extends SimpleAsmPattern {
  pattern = make_pattern("rotcl $r", "xor #1, $r", "rotcr $r");

  replace(m) {
    return new Replacement([new AsmInstruction("negatet.fictive", [])], m.body.length, []);
  }
}

export class Shar31Pattern extends SimpleAsmPattern {
  pattern = make_pattern("shll $r", "subc $r, $r");

  replace(m) {
    const reg = m.regs.get("r");
    const temp = Register.fictive(reg.register_name);
    return new Replacement(
      [new AsmInstruction("move.fictive", [temp, reg]), new AsmInstruction("shll", [temp]), new AsmInstruction("shar.fictive", [reg, reg, new AsmLiteral(31)])],
      m.body.length,
    );
  }
}

/** Replace writebacks in mov address modes by separate add instructions. */
export class Sh2AddrModeWritebackPattern extends AsmPattern {
  match(matcher) {
    const instr = matcher.input[matcher.index];
    if (!(instr instanceof Instruction) || !instr.args.length) return null;
    if (!["mov.b", "mov.w", "mov.l"].includes(instr.mnemonic)) return null;

    let addr, addr_arg;
    if (instr.args[0] instanceof AsmAddressMode) {
      addr = instr.args[0];
      addr_arg = 0;
    } else if (instr.args[1] instanceof AsmAddressMode) {
      addr = instr.args[1];
      addr_arg = 1;
    } else return null;

    if (addr.writeback === null) return null;
    if (addr.base === SH_STACK_POINTER_REG) return null;

    if (addr.base === instr.args[0] || addr.base === instr.args[1]) {
      throw new DecompFailure("Writeback with base register also used as load/store value, " + `for instruction: ${instr}`);
    }

    pyassert(addr.addend === new AsmLiteral(0));

    const new_args = [...instr.args];
    new_args[addr_arg] = new AsmAddressMode(addr.base, addr.addend, null);
    const stride = mov_stride(instr.mnemonic);
    if (addr.writeback === Writeback.PRE) {
      return new Replacement([new AsmInstruction("add", [new AsmLiteral(-stride), addr.base]), new AsmInstruction(instr.mnemonic, new_args)], 1);
    }
    return new Replacement([new AsmInstruction(instr.mnemonic, new_args), new AsmInstruction("add", [new AsmLiteral(stride), addr.base])], 1);
  }
}

export class Shar16Pattern extends IrPattern {
  replacement = "shar16.fictive $i, $o";
  parts = ["swap.w $i, $t", "exts.w $t, $o"];
}

const R = (names) => names.map((r) => new Register(r));

const SH2_ARGUMENT_REGS = R(["r4", "r5", "r6", "r7"]);
const SH2_SIMPLE_TEMP_REGS = R(["r0", "r1", "r2", "r3"]);
const SH2_TEMP_REGS = [...SH2_ARGUMENT_REGS, ...SH2_SIMPLE_TEMP_REGS, new Register("condition_bit")];
const SH2_SAVED_REGS = R(["r8", "r9", "r10", "r11", "r12", "r13", "r14", "pr"]);
const SH2_ALL_REGS = [...SH2_SAVED_REGS, ...SH2_TEMP_REGS, SH_STACK_POINTER_REG, ...R(["mach", "macl", "sr", "gbr", "vbr"])];

const SH2_INSTRS_COMPARE = {
  "cmp/pl": (a) => BinaryOp.scmp(a.reg(0), ">", new Literal(0)),
  "cmp/pz": (a) => BinaryOp.scmp(a.reg(0), ">=", new Literal(0)),
  "cmp/eq": (a) => BinaryOp.icmp(a.reg(1), "==", a.reg_or_s8_imm(0)),
  "cmp/ge": (a) => BinaryOp.scmp(a.reg(1), ">=", a.reg(0)),
  "cmp/gt": (a) => BinaryOp.scmp(a.reg(1), ">", a.reg(0)),
  "cmp/hi": (a) => BinaryOp.ucmp(a.reg(1), ">", a.reg(0)),
  "cmp/hs": (a) => BinaryOp.ucmp(a.reg(1), ">=", a.reg(0)),
  "cmp/str": (a) => fn_op("M2C_CMP_STR", [a.reg(1), a.reg(0)], Type.boolean()),
  tst: (a) =>
    a.reg_ref(1) === a.raw_arg(0)
      ? BinaryOp.icmp(a.reg(1), "==", new Literal(0))
      : BinaryOp.icmp(BinaryOp.intptr(a.reg(1), "&", a.reg_or_s8_imm(0)), "==", new Literal(0)),
};

const SH2_INSTRS_READ_MODIFY_WRITE = {
  // sh2 format is src, dst
  // add handler is dest, left, right
  add: (a) =>
    a.raw_arg(0) instanceof Register
      ? handle_add(with_raw_args(a, [a.raw_arg(1), a.raw_arg(1), a.raw_arg(0)]))
      : handle_addi(a.reg_ref(1), a.reg_ref(1), a.reg(1), a.s8_imm(0), a),
  sub: (a) => handle_sub(a.reg(1), a.reg(0)),
  and: (a) => BinaryOp.int(a.reg(1), "&", a.reg_or_imm(0)),
  or: (a) => handle_or(a.reg(1), a.reg_or_imm(0)),
  xor: (a) => handle_xor(a.reg(1), a.reg_or_imm(0)),
  xtrct: (a) => BinaryOp.uint(BinaryOp.ushift(a.reg(1), ">>", new Literal(16)), "|", BinaryOp.int(a.reg(0), "<<", new Literal(16))),
};

const SH2_INSTRS_SOURCE_DEST = {
  not: (a) => handle_bitinv(a.reg(0)),
  neg: (a) => UnaryOp.sint("-", a.reg(0)),
  "exts.b": (a) => as_type(a.reg(0), Type.s8(), false),
  "exts.w": (a) => as_type(a.reg(0), Type.s16(), false),
  "extu.b": (a) => as_type(a.reg(0), Type.u8(), false),
  "extu.w": (a) => as_type(a.reg(0), Type.u16(), false),
  "swap.w": (a) => BinaryOp.int(BinaryOp.ushift(a.reg(0), "<<", new Literal(16)), "|", BinaryOp.ushift(a.reg(0), ">>", new Literal(16))),
  "swap.b": (a) =>
    BinaryOp.uint(
      BinaryOp.uint(BinaryOp.int(a.reg(0), "&", new Literal(0xffff0000)), "|", BinaryOp.int(BinaryOp.int(a.reg(0), "&", new Literal(0xff)), "<<", new Literal(8))),
      "|",
      BinaryOp.int(BinaryOp.ushift(a.reg(0), ">>", new Literal(8)), "&", new Literal(0xff)),
    ),
  "shar16.fictive": (a) => fold_shift_right(a.reg(0), 16, { signed: true }),
};

const SH2_INSTRS_INTRINSICS = {
  "shar.fictive": (a) => fold_shift_right(a.reg(1), a.imm_value(2), { signed: true }),
  "vshar.fictive": (a) => BinaryOp.sshift(a.reg(1), ">>", a.reg(2)),
  "vshlr.fictive": (a) => BinaryOp.ushift(a.reg(1), ">>", a.reg(2)),
  "vshl.fictive": (a) => BinaryOp.int(a.reg(1), "<<", a.reg(2)),
  "divs.fictive": (a) => BinaryOp.sint(a.reg(1), "/", a.reg(2)),
  "divu.fictive": (a) => BinaryOp.uint(a.reg(1), "/", a.reg(2)),
};

const SH2_INSTRS_MULTIPLY = {
  "mul.l": (a) => BinaryOp.int(a.reg(1), "*", a.reg(0)),
  muls: (a) => BinaryOp.sint(as_s16(a.reg(1)), "*", as_s16(a.reg(0))),
  mulu: (a) => BinaryOp.uint(as_u16(a.reg(1)), "*", as_u16(a.reg(0))),
};

const SH2_INSTRS_SHIFT = {
  shll: (a) => fold_mul_chains(BinaryOp.int(a.reg(0), "<<", new Literal(1)), { allow_sll_chains: true }),
  shlr: (a) => fold_shift_right(a.reg(0), 1, { signed: false }),
  shar: (a) => fold_shift_right(a.reg(0), 1, { signed: true }),
  shll2: (a) => fold_mul_chains(BinaryOp.int(a.reg(0), "<<", new Literal(2)), { allow_sll_chains: true }),
  shlr2: (a) => fold_shift_right(a.reg(0), 2, { signed: false }),
  shll8: (a) => fold_mul_chains(BinaryOp.int(a.reg(0), "<<", new Literal(8)), { allow_sll_chains: true }),
  shlr8: (a) => fold_shift_right(a.reg(0), 8, { signed: false }),
  shll16: (a) => fold_mul_chains(BinaryOp.int(a.reg(0), "<<", new Literal(16)), { allow_sll_chains: true }),
  shlr16: (a) => fold_shift_right(a.reg(0), 16, { signed: false }),
  rotl: (a) => BinaryOp.uint(BinaryOp.ushift(a.reg(0), "<<", new Literal(1)), "|", BinaryOp.ushift(a.reg(0), ">>", new Literal(31))),
  rotr: (a) => BinaryOp.uint(BinaryOp.ushift(a.reg(0), ">>", new Literal(1)), "|", BinaryOp.ushift(a.reg(0), "<<", new Literal(31))),
};

const SH2_ATTRS = {
  arch: Target.ArchEnum.SH,
  re_comment: String.raw`!.*`,
  supports_dollar_regs: false,
  supports_at_addressing: true,
  asm_word_size: 2,
  has_delay_slots: true,
  home_space_size: 0,
  stack_pointer_reg: SH_STACK_POINTER_REG,
  frame_pointer_regs: [new Register("r14")],
  return_address_reg: new Register("pr"),
  base_return_regs: [[new Register("r0"), false]],
  all_return_regs: [new Register("r0"), new Register("r1")],
  argument_regs: SH2_ARGUMENT_REGS,
  simple_temp_regs: SH2_SIMPLE_TEMP_REGS,
  temp_regs: SH2_TEMP_REGS,
  saved_regs: SH2_SAVED_REGS,
  all_regs: SH2_ALL_REGS,
  aliased_regs: {},
  instrs_compare: SH2_INSTRS_COMPARE,
  instrs_read_modify_write: SH2_INSTRS_READ_MODIFY_WRITE,
  instrs_source_dest: SH2_INSTRS_SOURCE_DEST,
  instrs_intrinsics: SH2_INSTRS_INTRINSICS,
  instrs_multiply: SH2_INSTRS_MULTIPLY,
  instrs_shift: SH2_INSTRS_SHIFT,
};

const SH2_ASM_PATTERNS = () => [
  new FarJumpPattern(),
  new JumpTablePattern(),
  new BrafJumpTablePattern(),
  new BsrfCallPattern(),
  new Sh2AddrModeWritebackPattern(),
  new NegateTPattern(),
  new Shar31Pattern(),
];

export class Sh2Arch extends Arch {
  constructor() {
    super();
    // Python class attributes (set after super() so base-class constructors
    // cannot shadow them with instance fields).
    Object.assign(this, SH2_ATTRS);
    this.asm_patterns = SH2_ASM_PATTERNS();
    this.ir_patterns = [new Shar16Pattern()];
  }

  static mov_type(mnemonic) {
    return mov_type(mnemonic);
  }
  static mov_stride(mnemonic) {
    return mov_stride(mnemonic);
  }
  mov_type(mnemonic) {
    return mov_type(mnemonic);
  }
  mov_stride(mnemonic) {
    return mov_stride(mnemonic);
  }

  c_symbol_name(asm_name) {
    if (asm_name.length >= 2 && asm_name[0] === "_" && (/^\p{L}$/u.test(asm_name[1]) || asm_name[1] === "_")) return asm_name.slice(1);
    return asm_name;
  }

  missing_return() {
    const meta = InstructionMeta.missing();
    return [this.parse("rts", [], meta), this.parse("nop", [], meta)];
  }

  normalize_instruction(instr, asm_state) {
    const map = { "muls.w": "muls", "mulu.w": "mulu" };
    const mnemonic = has(map, instr.mnemonic) ? map[instr.mnemonic] : instr.mnemonic;
    return new AsmInstruction(mnemonic, instr.args);
  }

  parse(mnemonic, args, meta) {
    const cls = this;
    let inputs = [];
    let clobbers = [];
    let outputs = [];
    let is_return = false;
    let is_load = false;
    let is_store = false;
    let has_delay_slot = false;
    let is_conditional = false;
    let jump_target = null;
    let function_target = null;
    let eval_fn = null;

    if (mnemonic === "rts") {
      pyassert(args.length === 0);
      inputs = [new Register("pr")];
      is_return = true;
      has_delay_slot = true;
    } else if (mnemonic === "nop") {
      pyassert(args.length === 0);
    } else if (["mov", "lds", "sts"].includes(mnemonic)) {
      pyassert(args.length === 2 && args[1] instanceof Register);
      outputs = [args[1]];
      if (args[0] instanceof Register) {
        inputs = [args[0]];
        eval_fn = (s, a) => s.set_reg(a.reg_ref(1), a.reg(0));
      } else {
        pyassert(args[0] instanceof AsmLiteral);
        eval_fn = (s, a) => s.set_reg(a.reg_ref(1), a.s8_imm(0));
      }
    } else if (mnemonic === "move.fictive") {
      pyassert(args.length === 2 && args[0] instanceof Register && args[1] instanceof Register);
      inputs = [args[1]];
      outputs = [args[0]];
      eval_fn = (s, a) => s.set_reg(a.reg_ref(0), a.reg(1));
    } else if (mnemonic === "mova") {
      pyassert(args.length === 2 && args[0] instanceof AsmGlobalSymbol && args[1] === new Register("r0"));
      outputs = [new Register("r0")];
      eval_fn = (s, a) => s.set_reg(new Register("r0"), a.full_imm(0));
    } else if (["mov.b", "mov.l", "mov.w"].includes(mnemonic)) {
      pyassert(args.length === 2);
      if (args[0] instanceof Register) {
        pyassert(args[1] instanceof AsmAddressMode);
        inputs = [args[0], args[1].base];
        if (args[1].addend instanceof Register) inputs.push(args[1].addend);
        is_store = true;
        if (args[1].writeback === null) {
          eval_fn = (s, a) => {
            const store_type = cls.mov_type(mnemonic);
            const address = a.raw_arg(1);
            pyassert(address instanceof AsmAddressMode);
            let store;
            if (address.addend instanceof Register) {
              store = make_storex(with_raw_args(a, [a.raw_arg(0), address.base, address.addend]), store_type);
            } else {
              store = make_store(a, store_type);
            }
            if (store !== null) s.store_memory(store, a.reg_ref(0));
          };
        } else if (args[1].base === cls.stack_pointer_reg) {
          pyassert(args[1].writeback === Writeback.PRE);
          eval_fn = (s, a) => {
            const source_raw = a.regs.get_raw(a.reg_ref(0));
            if (source_raw === null || !s.stack_info.should_save(source_raw, null)) s.push_subroutine_arg(a.reg(0));
          };
        } else {
          // writeback on other registers is rewritten into an explicit
          // add by Sh2AddrModeWritebackPattern, so no eval_fn is needed.
        }
      } else {
        pyassert(args[1] instanceof Register);
        if (args[0] instanceof AsmAddressMode) {
          inputs = [args[0].base];
          if (args[0].addend instanceof Register) inputs.push(args[0].addend);
        }
        outputs = [args[1]];
        is_load = true;
        const load_type = cls.mov_type(mnemonic);
        if (args[0] instanceof AsmAddressMode && args[0].addend instanceof Register) {
          const indexed_base = args[0].base;
          const indexed_addend = args[0].addend;
          eval_fn = (s, a) => s.set_reg(a.reg_ref(1), handle_loadx(with_raw_args(a, [a.raw_arg(1), indexed_base, indexed_addend]), load_type));
        } else {
          eval_fn = (s, a) => s.set_reg(a.reg_ref(1), handle_load(with_raw_args(a, [a.raw_arg(1), a.raw_arg(0)]), load_type));
        }
      }
    } else if (mnemonic === "sts.l" || mnemonic === "stc.l") {
      pyassert(args.length === 2 && args[0] instanceof Register && args[1] instanceof AsmAddressMode && args[1].writeback === Writeback.PRE);
      const mem = args[1];
      inputs = [args[0], mem.base];
      is_store = true;
      eval_fn = (s, a) => {
        pyassert(args[0] === new Register("pr"));
        pyassert(mem.base === cls.stack_pointer_reg);
      };
    } else if (mnemonic === "lds.l" || mnemonic === "ldc.l") {
      pyassert(args.length === 2 && args[0] instanceof AsmAddressMode && args[0].writeback === Writeback.POST && args[1] instanceof Register);
      const mem = args[0];
      inputs = [mem.base];
      outputs = [args[1]];
      is_load = true;
      eval_fn = (s, a) => {
        pyassert(args[1] === new Register("pr"));
        pyassert(mem.base === cls.stack_pointer_reg);
      };
    } else if (mnemonic === "addc") {
      pyassert(args.length === 2 && args[0] instanceof Register && args[1] instanceof Register);
      const t_reg = new Register("condition_bit");
      inputs = [args[0], args[1], t_reg];
      outputs = [args[1], t_reg];
      eval_fn = (s, a) => {
        let result = handle_add_real(a.reg(1), a.reg(0), a);
        result = handle_add_real(result, a.regs.get(t_reg), a);
        result = s.set_reg(a.reg_ref(1), result);
        s.set_reg(t_reg, new CarryBit(result));
      };
    } else if (mnemonic === "subc") {
      pyassert(args.length === 2 && args[0] instanceof Register && args[1] instanceof Register);
      const t_reg = new Register("condition_bit");
      inputs = [args[0], args[1], t_reg];
      outputs = [args[1], t_reg];
      eval_fn = (s, a) => {
        const lhs = a.reg(1);
        const rhs = a.reg(0);
        const carry = a.regs.get(t_reg);
        const result = handle_sub(handle_sub(lhs, rhs), carry);
        let borrow;
        if (pyeq(carry, new Literal(0))) borrow = BinaryOp.ucmp(lhs, "<", rhs);
        else if (pyeq(carry, new Literal(1))) borrow = BinaryOp.ucmp(lhs, "<=", rhs);
        else {
          borrow = new BinaryOp({
            left: BinaryOp.ucmp(lhs, "<", rhs),
            op: "||",
            right: new BinaryOp({ left: BinaryOp.icmp(lhs, "==", rhs), op: "&&", right: condition_from_expr(carry), type: Type.boolean() }),
            type: Type.boolean(),
          });
        }
        s.set_reg(a.reg_ref(1), result);
        s.set_reg(t_reg, borrow);
      };
    } else if (mnemonic === "negc") {
      pyassert(args.length === 2 && args[0] instanceof Register && args[1] instanceof Register);
      const t_reg = new Register("condition_bit");
      inputs = [args[0], t_reg];
      outputs = [args[1], t_reg];
      eval_fn = (s, a) => {
        const value = a.reg(0);
        const carry = a.regs.get(t_reg);
        const result = handle_sub(UnaryOp.int("-", value), carry);
        let borrow;
        if (pyeq(carry, new Literal(0))) borrow = BinaryOp.icmp(value, "!=", new Literal(0));
        else if (pyeq(carry, new Literal(1))) borrow = new Literal(1);
        else {
          borrow = new BinaryOp({ left: BinaryOp.icmp(value, "!=", new Literal(0)), op: "||", right: condition_from_expr(carry), type: Type.boolean() });
        }
        s.set_reg(a.reg_ref(1), result);
        s.set_reg(t_reg, borrow);
      };
    } else if (has(cls.instrs_read_modify_write, mnemonic)) {
      pyassert(args.length === 2 && args[1] instanceof Register);
      inputs = [args[1]];
      if (args[0] instanceof Register) inputs.unshift(args[0]);
      outputs = [args[1]];
      eval_fn = (s, a) => s.set_reg(a.reg_ref(1), cls.instrs_read_modify_write[mnemonic](a));
    } else if (has(cls.instrs_source_dest, mnemonic)) {
      pyassert(args.length === 2 && args[0] instanceof Register && args[1] instanceof Register);
      inputs = [args[0]];
      outputs = [args[1]];
      eval_fn = (s, a) => s.set_reg(a.reg_ref(1), cls.instrs_source_dest[mnemonic](a));
    } else if (has(cls.instrs_intrinsics, mnemonic)) {
      pyassert(args[0] instanceof Register);
      inputs = args.slice(1).filter((arg) => arg instanceof Register);
      outputs = [args[0]];
      eval_fn = (s, a) => s.set_reg(a.reg_ref(0), cls.instrs_intrinsics[mnemonic](a));
    } else if (has(cls.instrs_multiply, mnemonic)) {
      pyassert(args.length === 2 && args[0] instanceof Register && args[1] instanceof Register);
      inputs = [args[0], args[1]];
      outputs = [new Register("macl")];
      eval_fn = (s, a) => s.set_reg(new Register("macl"), cls.instrs_multiply[mnemonic](a));
    } else if (mnemonic === "dmuls.l" || mnemonic === "dmulu.l") {
      pyassert(args.length === 2 && args[0] instanceof Register && args[1] instanceof Register);
      inputs = [args[0], args[1]];
      outputs = [new Register("mach"), new Register("macl")];
      const high_op = mnemonic === "dmuls.l" ? "MULT_HI" : "MULTU_HI";
      eval_fn = (s, a) => {
        s.set_reg(new Register("mach"), fold_divmod(BinaryOp.int(a.reg(1), high_op, a.reg(0))));
        s.set_reg(new Register("macl"), BinaryOp.int(a.reg(1), "*", a.reg(0)));
      };
    } else if (mnemonic === "clrmac") {
      pyassert(!args.length);
      outputs = [new Register("macl"), new Register("mach")];
      eval_fn = (s, a) => {
        s.set_reg(new Register("macl"), new Literal(0));
        s.set_reg(new Register("mach"), new Literal(0));
      };
    } else if (mnemonic === "rotcl" || mnemonic === "rotcr") {
      pyassert(args.length === 1 && args[0] instanceof Register);
      const t_reg = new Register("condition_bit");
      inputs = [args[0], t_reg];
      outputs = [args[0], t_reg];
      eval_fn = (s, a) => {
        const original = a.reg(0);
        const carry_in = a.regs.get(t_reg);
        let shifted, incoming_bit, carry_out;
        if (mnemonic === "rotcl") {
          shifted = BinaryOp.ushift(original, "<<", new Literal(1));
          incoming_bit = carry_in;
          carry_out = new CarryBit(shifted);
        } else {
          shifted = BinaryOp.ushift(original, ">>", new Literal(1));
          incoming_bit = BinaryOp.uint(carry_in, "<<", new Literal(31));
          carry_out = BinaryOp.int(original, "&", new Literal(1));
        }
        const result = pyeq(carry_in, new Literal(0)) ? shifted : BinaryOp.int(shifted, "|", incoming_bit);
        s.set_reg(a.reg_ref(0), result);
        s.set_reg(t_reg, carry_out);
      };
    } else if (has(cls.instrs_shift, mnemonic)) {
      pyassert(args.length === 1 && args[0] instanceof Register);
      inputs = [args[0]];
      outputs = [args[0]];
      const sets_t = ["shll", "shlr", "shar", "rotl", "rotr"].includes(mnemonic);
      if (sets_t) outputs.push(new Register("condition_bit"));
      eval_fn = (s, a) => {
        const original = a.reg(0);
        s.set_reg(a.reg_ref(0), cls.instrs_shift[mnemonic](a));
        if (sets_t) {
          let carry;
          if (["shlr", "shar", "rotr"].includes(mnemonic)) {
            carry = BinaryOp.intptr(original, "&", new Literal(1));
          } else {
            const as_u32_ = as_type(original, Type.u32(), true, { unify: false });
            carry = BinaryOp.int(as_u32_, ">>", new Literal(31));
          }
          s.set_reg(new Register("condition_bit"), carry);
        }
      };
    } else if (mnemonic === "dt") {
      pyassert(args.length === 1 && args[0] instanceof Register);
      inputs = [args[0]];
      outputs = [args[0], new Register("condition_bit")];
      eval_fn = (s, a) => {
        const value = s.set_reg(a.reg_ref(0), BinaryOp.intptr(a.reg(0), "-", new Literal(1)));
        s.set_reg(new Register("condition_bit"), BinaryOp.icmp(value, "==", new Literal(0)));
      };
    } else if (has(cls.instrs_compare, mnemonic)) {
      inputs = args.filter((arg) => arg instanceof Register);
      outputs = [new Register("condition_bit")];
      eval_fn = (s, a) => s.set_reg(new Register("condition_bit"), cls.instrs_compare[mnemonic](a));
    } else if (["bf", "bf.s", "bt", "bt.s"].includes(mnemonic)) {
      pyassert(args.length === 1);
      inputs = [new Register("condition_bit")];
      jump_target = get_jump_target(args[0]);
      is_conditional = true;
      has_delay_slot = mnemonic.endsWith(".s");
      eval_fn = (s, a) => {
        let condition = condition_from_expr(a.regs.get(new Register("condition_bit")));
        if (mnemonic.startsWith("bf")) condition = condition.negated();
        s.set_branch_condition(condition);
      };
    } else if (mnemonic === "bsr") {
      pyassert(args.length === 1);
      inputs = [...cls.argument_regs];
      outputs = [...cls.all_return_regs];
      clobbers = [...cls.temp_regs];
      function_target = args[0];
      has_delay_slot = true;
      eval_fn = (s, a) => s.make_function_call(a.sym_imm(0), outputs);
    } else if (mnemonic === "bra") {
      pyassert(args.length === 1);
      jump_target = get_jump_target(args[0]);
      has_delay_slot = true;
    } else if (mnemonic === "jmp") {
      pyassert(args.length === 1 && args[0] instanceof AsmAddressMode && args[0].addend === new AsmLiteral(0));
      inputs = [args[0].base];
      jump_target = args[0].base;
      is_conditional = true;
      has_delay_slot = true;
      eval_fn = (s, a) => {
        const address = a.raw_arg(0);
        pyassert(address instanceof AsmAddressMode);
        s.set_switch_expr(a.regs.get(address.base));
      };
    } else if (mnemonic === "jsr") {
      pyassert(args.length === 1 && args[0] instanceof AsmAddressMode && args[0].addend === new AsmLiteral(0));
      const target_reg = args[0].base;
      inputs = [...cls.argument_regs, target_reg];
      outputs = [...cls.all_return_regs];
      clobbers = [...cls.temp_regs];
      function_target = target_reg;
      has_delay_slot = true;
      eval_fn = (s, a) => s.make_function_call(a.regs.get(target_reg), outputs);
    } else if (mnemonic === "tablejmp.doubled.fictive") {
      pyassert(args.length >= 2 && args[0] instanceof Register);
      const targets = [];
      for (const arg of args.slice(1)) {
        pyassert(arg instanceof AsmGlobalSymbol);
        targets.push(new JumpTarget(arg.symbol_name));
      }
      inputs = [args[0]];
      jump_target = targets;
      is_conditional = true;
      eval_fn = (s, a) => {
        let index = a.reg(0);
        const unwrapped = early_unwrap(index);
        if (unwrapped instanceof BinaryOp && unwrapped.op === "*" && pyeq(early_unwrap(unwrapped.right), new Literal(2))) {
          index = unwrapped.left;
        } else {
          index = BinaryOp.ushift(index, ">>", new Literal(1));
        }
        s.set_switch_expr(index, true);
      };
    } else if (mnemonic === "movt") {
      pyassert(args.length === 1 && args[0] instanceof Register);
      inputs = [new Register("condition_bit")];
      outputs = [args[0]];
      eval_fn = (s, a) => s.set_reg(a.reg_ref(0), a.regs.get(new Register("condition_bit")));
    } else if (mnemonic === "clrt" || mnemonic === "sett") {
      pyassert(!args.length);
      outputs = [new Register("condition_bit")];
      const val = mnemonic === "sett" ? 1 : 0;
      eval_fn = (s, a) => s.set_reg(new Register("condition_bit"), new Literal(val));
    } else if (mnemonic === "negatet.fictive") {
      pyassert(!args.length);
      inputs = outputs = [new Register("condition_bit")];
      eval_fn = (s, a) => {
        const condition = condition_from_expr(a.regs.get(new Register("condition_bit")));
        s.set_reg(new Register("condition_bit"), condition.negated());
      };
    } else if (mnemonic === "tas.b") {
      pyassert(args.length === 1 && args[0] instanceof AsmAddressMode && args[0].addend === new AsmLiteral(0));
      const base = args[0].base;
      const t_reg = new Register("condition_bit");
      inputs = [base];
      outputs = [t_reg];
      is_load = is_store = true;
      eval_fn = (s, a) => {
        const result = fn_op("M2C_TAS_B", [a.regs.get(base)], Type.intish());
        s.set_reg(t_reg, result);
      };
    } else if (mnemonic === "stc") {
      pyassert(args.length === 2 && args[0] instanceof Register && args[1] instanceof Register);
      outputs = [args[1]];
      eval_fn = (s, a) => {
        const fn_name = "M2C_LOAD_" + a.reg_ref(0).register_name.toUpperCase();
        s.set_reg(a.reg_ref(1), fn_op(fn_name, [], Type.u32()));
      };
    } else if (mnemonic === "ldc") {
      pyassert(args.length === 2 && args[0] instanceof Register && args[1] instanceof Register);
      inputs = [args[0]];
      eval_fn = (s, a) => {
        const fn_name = "M2C_STORE_" + a.reg_ref(1).register_name.toUpperCase();
        s.write_statement(void_fn_op(fn_name, [a.reg(0)]));
      };
    } else {
      const instr_str = String(new AsmInstruction(mnemonic, args));
      eval_fn = (s, a) => {
        const error = new ErrorExpr(`unknown instruction: ${instr_str}`);
        s.write_statement(new ExprStmt(error));
      };
    }

    return new Instruction({
      mnemonic,
      args,
      meta,
      inputs,
      clobbers,
      outputs,
      eval_fn,
      jump_target,
      function_target,
      is_conditional,
      is_return,
      is_load,
      is_store,
      has_delay_slot,
    });
  }

  process_flowgraph(asm_data, flow_graph) {
    // Find intrinsic functions and replace them by fake instructions (see upstream).
    const seen = new Set();

    const make_intrinsic_instruction = (fn_name) => {
      const table = {
        ___sdivsi3: "divs.fictive",
        ___udivsi3: "divu.fictive",
        ___ashrsi3: "vshar.fictive",
        ___ashlsi3: "vshl.fictive",
        ___lshrsi3: "vshlr.fictive",
      };
      const mn = has(table, fn_name) ? table[fn_name] : null;
      if (mn !== null) return new AsmInstruction(mn, [new Register("r0"), new Register("r4"), new Register("r5")]);
      if (fn_name.startsWith("___ashiftrt_r4_")) {
        const shift = int_(fn_name.slice("___ashiftrt_r4_".length));
        return new AsmInstruction("shar.fictive", [new Register("r4"), new Register("r4"), new AsmLiteral(shift)]);
      }
      return null;
    };

    const loc_from_mov_operand = (arg, stack_regs) => {
      if (arg instanceof Register) return arg;
      if (arg instanceof AsmAddressMode && stack_regs.has(arg.base) && arg.writeback === null) return StackLocation.from_offset(arg.addend);
      return null;
    };

    const rec = (node, reg_sym_values, stack_regs) => {
      if (seen.has(node)) return;
      seen.add(node);
      for (const ref of node.block.instruction_refs) {
        const ins = ref.instruction;
        if (ins.mnemonic === "mov" && ins.args[0] === this.stack_pointer_reg) {
          pyassert(ins.args[1] instanceof Register);
          stack_regs = new Set([...stack_regs, ins.args[1]]);
          continue;
        }
        if (ins.mnemonic === "mov.l") {
          const src = ins.args[0];
          const dst = ins.args[1];
          if (dst instanceof Register) {
            const target = get_literal_pool_symbol(src, asm_data);
            if (target !== null) {
              const intrinsic = make_intrinsic_instruction(target);
              if (intrinsic !== null) {
                reg_sym_values.set(dst, intrinsic);
                ref.instruction = ins.replace({ in_pattern: true });
                continue;
              }
            }
          }
          const src_loc = loc_from_mov_operand(src, stack_regs);
          const dst_loc = loc_from_mov_operand(dst, stack_regs);
          if (src_loc !== null && dst_loc !== null) {
            if (reg_sym_values.has(src_loc)) {
              reg_sym_values.set(dst_loc, reg_sym_values.get(src_loc));
              ref.instruction = ins.replace({ in_pattern: true });
            } else if (reg_sym_values.has(dst_loc)) {
              reg_sym_values.delete(dst_loc);
            }
            continue;
          }
        }
        if (ins.mnemonic === "jsr") {
          pyassert(ins.function_target instanceof Register);
          const new_ins = reg_sym_values.get(ins.function_target) ?? null;
          if (new_ins !== null) {
            ref.replace_instruction(new_ins, this);
            ref.instruction.clobbers.length = 0;
            continue;
          }
        }
        for (const loc of [...ins.clobbers, ...ins.outputs]) {
          if (loc instanceof Register) {
            if (reg_sym_values.has(loc)) reg_sym_values.delete(loc);
            if (stack_regs.has(loc) && loc !== this.stack_pointer_reg) {
              stack_regs = new Set([...stack_regs].filter((r) => r !== loc));
            }
          }
        }
      }
      for (const child of node.children()) rec(child, new Map(reg_sym_values), stack_regs);
    };

    rec(flow_graph.entry_node(), new Map(), new Set([this.stack_pointer_reg]));
  }

  arg_name(loc) {
    if (loc.offset !== null) return `arg${floordiv(loc.offset, 4) + 4}`;
    pyassert(loc.reg !== null);
    const reg_num = int_(loc.reg.register_name.slice(1));
    return `arg${reg_num - 4}`;
  }

  function_abi(fn_sig, likely_regs, { for_call }) {
    void for_call;
    const known_slots = [];
    let candidate_slots = [];
    const possible_slots = [];

    if (fn_sig.params_known) {
      if (fn_sig.return_type.is_struct() && fn_sig.return_type.get_parameter_size_align_bytes()[0] > 8) {
        known_slots.push(new AbiArgSlot(new ArgLoc(null, -1, new Register("r2")), Type.ptr(fn_sig.return_type), { name: "__return__", comment: "return" }));
      }

      let reg_num = 0;
      for (const param of fn_sig.params) {
        const param_type = param.type.decay();
        const [size] = param_type.get_parameter_size_align_bytes();
        const size_regs = floordiv(size + 3, 4);
        const name = param.name;
        for (let i = reg_num; i < reg_num + size_regs; i++) {
          const unk_offset = 4 * (i - reg_num);
          const reg = i < 4 ? new Register(`r${i + 4}`) : null;
          const stack_loc = reg !== null ? null : (i - 4) * 4;
          let name2, sub_type, comment;
          if (size_regs > 1) {
            name2 = name ? `${name}_unk${format(unk_offset, "X")}` : null;
            sub_type = Type.any();
            comment = `${param_type}+${format(unk_offset, "#x")}`;
          } else {
            pyassert(unk_offset === 0);
            name2 = name;
            sub_type = param_type;
            comment = null;
          }
          known_slots.push(new AbiArgSlot(new ArgLoc(stack_loc, i, reg), sub_type, { name: name2, comment }));
        }
        reg_num += size_regs;
      }

      if (fn_sig.is_variadic) {
        for (let i = reg_num; i < 4; i++) candidate_slots.push(new AbiArgSlot(new ArgLoc(null, i, new Register(`r${i + 4}`)), Type.intptr()));
      }
    } else {
      candidate_slots = [0, 1, 2, 3].map((i) => new AbiArgSlot(new ArgLoc(null, i, new Register(`r${i + 4}`)), Type.intptr()));
    }

    let highest_likely = -1;
    for (let i = 4; i < 8; i++) {
      if (!likely_regs.has(new Register(`r${i}`))) break;
      if (likely_regs.get(new Register(`r${i}`))) highest_likely = i;
    }

    for (const slot of candidate_slots) {
      pyassert(slot.loc.reg !== null);
      if (int_(slot.loc.reg.register_name.slice(1)) <= highest_likely) possible_slots.push(slot);
    }

    return new Abi({ arg_slots: known_slots, possible_slots });
  }

  function_return(expr) {
    return new Map([
      [new Register("r0"), new Cast(expr, { reinterpret: true, silent: true, type: Type.intptr() })],
      [new Register("r1"), as_u32(new Cast(expr, { reinterpret: true, silent: false, type: Type.u64() }))],
    ]);
  }
}

const SH4_FP_ARGUMENT_REGS = [4, 5, 6, 7, 8, 9, 10, 11].map((i) => new Register(`fr${i}`));
const SH4_FP_TEMP_REGS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((i) => new Register(`fr${i}`));
const SH4_FP_SAVED_REGS = [12, 13, 14, 15].map((i) => new Register(`fr${i}`));

const SH4_ATTRS = {
  base_return_regs: [
    [new Register("r0"), false],
    [new Register("fr0"), true],
  ],
  all_return_regs: [new Register("r0"), new Register("r1"), new Register("fr0")],
  fp_argument_regs: SH4_FP_ARGUMENT_REGS,
  fp_temp_regs: SH4_FP_TEMP_REGS,
  fp_saved_regs: SH4_FP_SAVED_REGS,
  argument_regs: [...SH2_ARGUMENT_REGS, ...SH4_FP_ARGUMENT_REGS],
  temp_regs: [...SH2_TEMP_REGS, ...SH4_FP_TEMP_REGS, new Register("fpul")],
  saved_regs: [...SH2_SAVED_REGS, ...SH4_FP_SAVED_REGS],
  all_regs: [...SH2_ALL_REGS, ...SH4_FP_TEMP_REGS, ...SH4_FP_SAVED_REGS, new Register("fpul"), new Register("fpscr")],
  instrs_load_const: {
    fldi0: (a) => new Literal(0x00000000, Type.f32()),
    fldi1: (a) => new Literal(0x3f800000, Type.f32()),
  },
};

export class Sh4Arch extends Sh2Arch {
  constructor() {
    super();
    Object.assign(this, SH4_ATTRS);
  }

  parse(mnemonic, args, meta) {
    const cls = this;
    const inputs = [];
    const clobbers = [];
    let outputs = [];
    let eval_fn = null;

    if (has(cls.instrs_load_const, mnemonic)) {
      pyassert(args.length === 1 && args[0] instanceof Register);
      outputs = [args[0]];
      eval_fn = (s, a) => s.set_reg(a.reg_ref(0), cls.instrs_load_const[mnemonic](a));
    }

    if (eval_fn !== null) return new Instruction({ mnemonic, args, meta, inputs, clobbers, outputs, eval_fn });

    return super.parse(mnemonic, args, meta);
  }

  function_return(expr) {
    const ret = Sh2Arch.prototype.function_return.call(this, expr);
    ret.set(new Register("fr0"), new Cast(expr, { reinterpret: true, silent: true, type: Type.floatish() }));
    return ret;
  }
}
