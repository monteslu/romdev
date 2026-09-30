// Port of m2c/arch_mips.py
import { DecompFailure } from "./error.js";
import { Target } from "./options.js";
import { Label } from "./asm_file.js";
import { AsmAddressMode, AsmGlobalSymbol, AsmInstruction, AsmLiteral, Register, get_jump_target } from "./asm_instruction.js";
import { Instruction, InstructionMeta, StackLocation } from "./instruction.js";
import { AsmPattern, Replacement, SimpleAsmPattern, make_pattern } from "./asm_pattern.js";
import {
  Abi,
  AbiArgSlot,
  Arch,
  ArgLoc,
  BinaryOp,
  Cast,
  CommentStmt,
  ErrorExpr,
  ExprStmt,
  Literal,
  SecondF64Half,
  UnaryOp,
  as_f32,
  as_f64,
  as_intish,
  as_s64,
  as_type,
  as_u32,
  as_u64,
  format_hex,
} from "./translate.js";
import {
  condition_from_expr,
  error_stmt,
  fn_op,
  fold_divmod,
  fold_mul_chains,
  handle_add,
  handle_add_double,
  handle_add_float,
  handle_add_real,
  handle_addi_mips,
  handle_bgez,
  handle_conditional_move,
  handle_convert,
  handle_la,
  handle_load,
  handle_lw,
  handle_lwl,
  handle_lwr,
  handle_or,
  handle_shift_right,
  handle_sltiu,
  handle_sltu,
  handle_swl,
  handle_swr,
  handle_xor,
  imm_add_32,
  load_upper,
  make_store,
  void_fn_op,
} from "./evaluate.js";
import { Type } from "./types.js";
import { band, floordiv, format, has, int_, pyassert } from "./py.js";

const R = (n) => new Register(n);

const LENGTH_TWO = new Set(["neg", "negu", "not", "neg.s", "abs.s", "sqrt.s", "neg.d", "abs.d", "sqrt.d"]);
const LENGTH_THREE = new Set([
  "slt", "slti", "sltu", "sltiu", "add", "addi", "addiu", "addu", "sub", "subu", "daddi", "daddiu", "dsubu",
  "add.s", "sub.s", "div.s", "mul.s", "add.d", "sub.d", "div.d", "mul.d", "ori", "and", "or", "nor", "xor",
  "andi", "xori", "sll", "sllv", "srl", "srlv", "sra", "srav", "dsll", "dsll32", "dsllv", "dsrl", "dsrl32",
  "dsrlv", "dsra", "dsra32", "dsrav", "div", "divu", "ddiv", "ddivu",
]);

export function other_f64_reg(reg) {
  pyassert(reg.is_float(), "tried to get complement reg of non-floating point register");
  const num = int_(reg.register_name.slice(1));
  return R(`f${num ^ 1}`);
}

class DivPattern extends SimpleAsmPattern {
  pattern = make_pattern("bnez $q, .A", "*", "break", ".A:", "li $at, -1", "bne $q, $at, .B", "li $at, 0x80000000", "bne $p, $at, .B", "nop", "break", ".B:");
  replace(m) {
    return new Replacement([m.body[1]], m.body.length - 1);
  }
}

class DivuPattern extends SimpleAsmPattern {
  pattern = make_pattern("bnez $q, .A", "nop", "break", ".A:");
  replace(m) {
    return new Replacement([], m.body.length - 1);
  }
}

/** Modulo by power of two. */
class ModP2Pattern1 extends SimpleAsmPattern {
  pattern = make_pattern("bgez $i, .A", "andi $o, $i, N", "beqz $o, .A", "nop", "addiu $o, $o, (-1 - N)", ".A:");
  replace(m) {
    const val = band(m.literals.get("N"), 0xffff) + 1;
    if (band(val, val - 1)) return null;
    const mod = new AsmInstruction("mod.fictive", [m.regs.get("o"), m.regs.get("i"), new AsmLiteral(val)]);
    return new Replacement([mod], m.body.length - 1);
  }
}

/** Modulo by power of two where the mask is too big to fit an andi. */
class ModP2Pattern2 extends SimpleAsmPattern {
  pattern = make_pattern("li $at, HI", "addiu $at, $at, LO?", "bgez $i, .A", "and $o, $i, $at", "beqz $o, .A", "addiu $at, $at, 1", "subu $o, $o, $at", ".A:");
  replace(m) {
    let val = band(m.literals.get("HI"), 0xffffffff) + 1;
    if (m.literals.has("LO")) val += band(m.literals.get("LO") + 0x8000, 0xffff) - 0x8000;
    if (!val || band(val, val - 1)) return null;
    const mod = new AsmInstruction("mod.fictive", [m.regs.get("o"), m.regs.get("i"), new AsmLiteral(val)]);
    return new Replacement([mod], m.body.length - 1);
  }
}

/** Division by power of two where input reg != output reg. */
class DivP2Pattern1 extends SimpleAsmPattern {
  pattern = make_pattern("bgez $i, .A", "sra $o, $i, N", "addiu $at, $i, ((1 << N) - 1)", "sra $o, $at, N", ".A:");
  replace(m) {
    const shift = band(m.literals.get("N"), 0x1f);
    const div = new AsmInstruction("div.fictive", [m.regs.get("o"), m.regs.get("i"), new AsmLiteral(2 ** shift)]);
    return new Replacement([div], m.body.length - 1);
  }
}

/** Division by power of two where input reg = output reg. */
class DivP2Pattern2 extends AsmPattern {
  pattern1 = make_pattern("bgez $x, .A", "move $at, $x", "addiu $at, $x, M", ".A:", "sra $x, $at, N");
  pattern2 = make_pattern("bgez $x, .A", "nop", "addiu $x, $x, M", ".A:", "sra $x, $x, N");
  pattern3 = make_pattern("bltzl $x, .A", "addiu $x, $x, M", ".A:", "sra $x, $x, N");
  match(matcher) {
    for (const pattern of [this.pattern1, this.pattern2, this.pattern3]) {
      const m = matcher.try_match(pattern);
      if (!m) continue;
      const shift = band(m.literals.get("N"), 0x1f);
      if (m.literals.get("M") !== 2 ** shift - 1) continue;
      const div = new AsmInstruction("div.fictive", [m.regs.get("x"), m.regs.get("x"), new AsmLiteral(2 ** shift)]);
      return new Replacement([div], m.body.length);
    }
    return null;
  }
}

class Div2S16Pattern extends SimpleAsmPattern {
  pattern = make_pattern("sll $i, $i, N", "sra $o, $i, N", "srl $i, $i, 0x1f", "addu $o, $o, $i", "sra $o, $o, 1");
  replace(m) {
    const div = new AsmInstruction("div.fictive", [m.regs.get("o"), m.regs.get("o"), new AsmLiteral(2)]);
    return new Replacement([m.body[0], m.body[1], div], m.body.length);
  }
}

class Div2S32Pattern1 extends SimpleAsmPattern {
  pattern = make_pattern("srl $t, $i, 0x1f", "addu $t, $i, $t", "sra $o, $t, 1");
  replace(m) {
    if (m.regs.get("t") === m.regs.get("i")) return null;
    const div = new AsmInstruction("div.fictive", [m.regs.get("o"), m.regs.get("i"), new AsmLiteral(2)]);
    return new Replacement([div], m.body.length);
  }
}

class Div2S32Pattern2 extends SimpleAsmPattern {
  pattern = make_pattern("srl $t, $i, 0x1f", "addu $i, $i, $t", "sra $o, $i, 1");
  replace(m) {
    if (m.regs.get("t") === m.regs.get("i")) return null;
    const div = new AsmInstruction("div.fictive", [m.regs.get("o"), m.regs.get("i"), new AsmLiteral(2)]);
    return new Replacement([div], m.body.length);
  }
}

class UtfPattern extends SimpleAsmPattern {
  pattern = make_pattern("bgez $x, .A", "cvt.s.w $o, $i", "li $at, 0x4f800000", "mtc1", "nop", "add.s", ".A:");
  replace(m) {
    const new_instr = new AsmInstruction("cvt.s.u.fictive", [m.regs.get("o"), m.regs.get("i")]);
    return new Replacement([new_instr], m.body.length - 1);
  }
}

class FtuPattern extends SimpleAsmPattern {
  pattern = make_pattern(
    "cfc1 $o, $31", "nop", "andi", "andi?", "*", "*", "li?", "mtc1", "mtc1?", "li", "*", "ctc1", "nop", "*",
    "cfc1", "nop", "andi", "andi?", "bnez", "nop", "mfc1", "li", "b", "or", ".A:", "b", "li", "*", "*", "nop", "bltz", "nop",
  );
  replace(m) {
    const sub = m.body.find((x) => x instanceof Instruction && x.mnemonic.startsWith("sub"));
    if (sub === undefined) throw new Error("StopIteration");
    const parts = sub.mnemonic.split(".");
    const fmt = parts[parts.length - 1];
    const args = [m.regs.get("o"), sub.args[1]];
    const new_instr = fmt === "s" ? new AsmInstruction("cvt.u.s.fictive", args) : new AsmInstruction("cvt.u.d.fictive", args);
    return new Replacement([new_instr], m.body.length);
  }
}

class Mips1DoubleLoadStorePattern extends AsmPattern {
  lwc_pattern = make_pattern("lwc1", "lwc1");
  swc_pattern = make_pattern("swc1", "swc1");
  match(matcher) {
    if (matcher.arch instanceof MipseeArch) return null;
    const m = matcher.try_match(this.lwc_pattern) || matcher.try_match(this.swc_pattern);
    if (!m) return null;
    const [a, b] = m.body;
    pyassert(a instanceof Instruction);
    pyassert(b instanceof Instruction);
    let [ra, ma] = a.args;
    let [rb, mb] = b.args;
    if (!(ra instanceof Register && ra.is_float() && other_f64_reg(ra) === rb && ma instanceof AsmAddressMode && mb instanceof AsmAddressMode && ma.base === mb.base)) return null;
    const num = int_(ra.register_name.slice(1));
    if (num % 2 === 1) {
      [ra, rb] = [rb, ra];
      [ma, mb] = [mb, ma];
    }
    if (ma.addend instanceof AsmLiteral && mb.addend instanceof AsmLiteral && ma.addend.value !== mb.addend.value + 4) return null;
    const new_mn = a.mnemonic === "lwc1" ? "ldc1" : "sdc1";
    const new_instr = new AsmInstruction(new_mn, [ra, mb]);
    return new Replacement([new_instr], m.body.length);
  }
}

class GccSqrtPatternJal extends SimpleAsmPattern {
  pattern = make_pattern("sqrt.s $o, $i", "c.eq.s", "nop?", "bc1t", "*", "jal sqrtf", "nop", "mov.s $o, $f0?");
  replace(m) {
    return new Replacement([m.body[0], m.wildcard_items[0]], m.body.length);
  }
}

class GccSqrtPatternJalr extends SimpleAsmPattern {
  pattern = make_pattern("sqrt.s $o, $i", "c.eq.s", "nop?", "bc1t", "*", "lui $x, %hi(sqrtf)", "addiu $x, $x, %lo(sqrtf)", "jalr $ra, $x", "nop", "mov.s $o, $f0?");
  replace(m) {
    return new Replacement([m.body[0], m.wildcard_items[0]], m.body.length);
  }
}

class TrapuvPattern extends SimpleAsmPattern {
  pattern = make_pattern("li $x, 0xfffa0000", "move $y, $sp", "addiu $sp, $sp, N", "ori $x, $x, 0x5a5a", ".loop:", "addiu $y, $y, -8", "sw $x, ($y)", "bne $y, $sp, .loop", "sw $x, 4($y)");
  replace(m) {
    const new_instr = new AsmInstruction("trapuv.fictive", []);
    return new Replacement([m.body[2], new_instr], m.body.length);
  }
}

/** Strip PIC .cpload pattern at the top of functions. */
class SetGpPattern extends AsmPattern {
  pattern = make_pattern("*", "addiu $gp, $gp, _", "addu $gp, $gp, $t9");
  match(matcher) {
    if (matcher.index !== 0) return null;
    const m = matcher.try_match(this.pattern);
    if (m === null) return null;
    const nop = new AsmInstruction("nop", []);
    return new Replacement([nop], m.body.length);
  }
}

/** IDO unrolled memcpy, used e.g. for struct copies. */
class MemcpyPatternBase extends AsmPattern {
  match(matcher) {
    let m = null;
    let pattern = null;
    for (const p of [this.pattern_mips1, this.pattern_mips2]) {
      m = matcher.try_match(p);
      pattern = p;
      if (m) break;
    }
    if (!m) return null;

    let e_src = null;
    let i_src = null;
    for (let i = matcher.index - 1; i >= 0; i--) {
      const item = matcher.input[i];
      if (item instanceof Label) break;
      if (!i_src && item.outputs.includes(m.regs.get("i"))) i_src = item;
      if (!e_src && item.outputs.includes(m.regs.get("e"))) e_src = item;
    }
    if (e_src === null || e_src.mnemonic !== "addiu") return null;
    if (e_src.args[1] !== m.regs.get("i") && (i_src === null || i_src.mnemonic !== "move" || i_src.args[1] !== e_src.args[1])) return null;
    pyassert(e_src.args[2] instanceof AsmLiteral);
    let length = e_src.args[2].value;

    const added_length = length;
    const m2 = matcher.try_match([...pattern, ...this.epilogue1]);
    if (m2) {
      m = m2;
      length += 4;
      const m3 = matcher.try_match([...pattern, ...this.epilogue1, ...this.epilogue2]);
      if (m3) {
        m = m3;
        length += 4;
      }
    }

    const from_reg = R("from");
    const to_reg = R("to");
    const from_offset = new AsmLiteral(m.literals.get("N"));
    const to_offset = new AsmLiteral(m.literals.get("M"));
    const added_len_arg = new AsmLiteral(added_length);
    const len_arg = new AsmLiteral(length);
    return new Replacement(
      [
        m.body[0],
        new AsmInstruction("addiu", [from_reg, m.regs.get("i"), from_offset]),
        new AsmInstruction("addiu", [to_reg, m.regs.get("o"), to_offset]),
        new AsmInstruction(this.instruction_name, [to_reg, from_reg, len_arg]),
        new AsmInstruction("addiu", [m.regs.get("o"), m.regs.get("o"), added_len_arg]),
        new AsmInstruction("addiu", [m.regs.get("i"), m.regs.get("i"), added_len_arg]),
        ...m.wildcard_items,
        new AsmInstruction("nop", []),
      ],
      m.body.length,
    );
  }
}

class AlignedMemcpyPattern extends MemcpyPatternBase {
  pattern_mips1 = make_pattern(".loop:", "lw $a, N($i)", "addiu $i, $i, 12", "sw $a, M($o)", "lw $b, (N-8)($i)", "addiu $o, $o, 12", "sw $b, (M-8)($o)", "lw $c, (N-4)($i)", "bne $i, $e, .loop", "sw $c, (M-4)($o)");
  pattern_mips2 = make_pattern(".loop:", "lw $a, N($i)", "addiu $i, $i, 12", "addiu $o, $o, 12", "sw $a, MM($o)", ".eq M, MM+12", "lw $b, (N-8)($i)", "sw $b, (M-8)($o)", "lw $c, (N-4)($i)", "bne $i, $e, .loop", "sw $c, (M-4)($o)");
  epilogue1 = make_pattern("lw $x, N($i)", "*", "sw $x, M($o)");
  epilogue2 = make_pattern("lw $y, (N+4)($i)", "*", "sw $y, (M+4)($o)");
  instruction_name = "memcpy.aligned.fictive";
}

class UnalignedMemcpyPattern extends MemcpyPatternBase {
  pattern_mips1 = make_pattern(
    ".loop:", "lwl $a, N($i)", "lwr $a, (N+3)($i)", "addiu $i, $i, 12", "swl $a, M($o)", "swr $a, (M+3)($o)", "lwl $b, (N-8)($i)", "lwr $b, (N-5)($i)",
    "addiu $o, $o, 12", "swl $b, (M-8)($o)", "swr $b, (M-5)($o)", "lwl $c, (N-4)($i)", "lwr $c, (N-1)($i)", "nop", "swl $c, (M-4)($o)", "bne $i, $e, .loop", "swr $c, (M-1)($o)",
  );
  pattern_mips2 = make_pattern(
    ".loop:", "lwl $a, N($i)", "lwr $a, (N+3)($i)", "addiu $i, $i, 12", "addiu $o, $o, 12", "swl $a, MM($o)", ".eq M, MM+12", "swr $a, (M-9)($o)", "lwl $b, (N-8)($i)",
    "lwr $b, (N-5)($i)", "swl $b, (M-8)($o)", "swr $b, (M-5)($o)", "lwl $c, (N-4)($i)", "lwr $c, (N-1)($i)", "swl $c, (M-4)($o)", "bne $i, $e, .loop", "swr $c, (M-1)($o)",
  );
  epilogue1 = make_pattern("lwl $x, N($i)", "lwr $x, (N+3)($i)", "*", "swl $x, M($o)", "swr $x, (M+3)($o)");
  epilogue2 = make_pattern("lwl $y, (N+4)($i)", "lwr $y, (N+7)($i)", "*", "swl $y, (M+4)($o)", "swr $y, (M+7)($o)");
  instruction_name = "memcpy.unaligned.fictive";
}

/** Remove additions of $gp used for position-independent jump tables. */
class GpJumpPattern extends SimpleAsmPattern {
  pattern = make_pattern("addu $x, $x, $gp", "jr $x");
  replace(m) {
    return new Replacement([m.body[1]], m.body.length);
  }
}

/** Some PS2 compilers emit ori for small stack additions instead of addiu. */
class OriSpPattern extends SimpleAsmPattern {
  pattern = make_pattern("ori $x, $sp, N");
  replace(m) {
    const n = m.literals.get("N");
    if (0 <= n && n < 16 && m.regs.get("x") !== R("sp")) {
      const ins = new AsmInstruction("addiu", [m.regs.get("x"), R("sp"), new AsmLiteral(n)]);
      return new Replacement([ins], m.body.length);
    }
    return null;
  }
}

/** `return fn(...);` may be optimized to a `j fn`. */
class TailCallPattern extends AsmPattern {
  match(matcher) {
    const instr = matcher.input[matcher.index];
    if (instr instanceof Instruction && instr.mnemonic === "j" && instr.args[0] instanceof AsmGlobalSymbol && !matcher.is_local_label(instr.args[0].symbol_name)) {
      return new Replacement(
        [new AsmInstruction("jal", instr.args), new AsmInstruction("nop", []), new AsmInstruction("jr", [R("ra")]), new AsmInstruction("nop", [])],
        1,
      );
    }
    return null;
  }
}

const regs = (names) => names.map(R);

export class MipsArch extends Arch {
  missing_return() {
    const meta = InstructionMeta.missing();
    return [this.parse("jr", [R("ra")], meta), this.parse("nop", [], meta)];
  }

  normalize_instruction(instr, asm_state) {
    const args = instr.args;
    const zero = R("zero");
    if (args.length === 3) {
      if (instr.mnemonic === "sll" && args[0] === zero && args[1] === zero) return new AsmInstruction("nop", []);
      if (instr.mnemonic === "or" && args[2] === zero) return new AsmInstruction("move", args.slice(0, 2));
      if (instr.mnemonic === "addu" && args[2] === zero) return new AsmInstruction("move", args.slice(0, 2));
      if (instr.mnemonic === "daddu" && args[2] === zero) return new AsmInstruction("move", args.slice(0, 2));
      if (instr.mnemonic === "nor" && args[1] === zero) return new AsmInstruction("not", [args[0], args[2]]);
      if (instr.mnemonic === "nor" && args[2] === zero) return new AsmInstruction("not", [args[0], args[1]]);
      if (instr.mnemonic === "addiu" && args[2] === new AsmLiteral(0)) return new AsmInstruction("move", args.slice(0, 2));
      if (instr.mnemonic === "paddub" && args[2] === zero) return new AsmInstruction("move", args.slice(0, 2));
      if (instr.mnemonic === "ori" && args[1] === zero && args[2] instanceof AsmLiteral) {
        return new AsmInstruction("li", [args[0], new AsmLiteral(band(args[2].value, 0xffff))]);
      }
      if (instr.mnemonic === "addiu" && args[1] === zero && args[2] instanceof AsmLiteral) {
        return new AsmInstruction("li", [args[0], new AsmLiteral(band(args[2].value + 0x8000, 0xffff) - 0x8000)]);
      }
      if (instr.mnemonic === "beq" && args[0] === zero && args[1] === zero) return new AsmInstruction("b", [args[2]]);
      if (["bne", "beq", "beql", "bnel"].includes(instr.mnemonic) && args[1] === zero) {
        const mn = instr.mnemonic.slice(0, 3) + "z" + instr.mnemonic.slice(3);
        return new AsmInstruction(mn, [args[0], args[2]]);
      }
    }
    if (args.length === 2) {
      if (instr.mnemonic === "beqz" && args[0] === zero) return new AsmInstruction("b", [args[1]]);
      if (instr.mnemonic === "lui" && args[1] instanceof AsmLiteral) return new AsmInstruction("li", [args[0], new AsmLiteral(band(args[1].value, 0xffff) * 0x10000)]);
      if (instr.mnemonic === "jalr" && args[0] !== R("ra")) throw new DecompFailure("Two-argument form of jalr is not supported.");
      if (["mult", "multu", "dmult", "dmultu", "madd", "maddu"].includes(instr.mnemonic)) return new AsmInstruction(instr.mnemonic, [zero, ...args]);
      if (LENGTH_THREE.has(instr.mnemonic)) return this.normalize_instruction(new AsmInstruction(instr.mnemonic, [args[0], ...args]), asm_state);
    }
    if (args.length === 1) {
      if (instr.mnemonic === "jalr") return new AsmInstruction("jalr", [R("ra"), args[0]]);
      if (LENGTH_TWO.has(instr.mnemonic)) return this.normalize_instruction(new AsmInstruction(instr.mnemonic, [args[0], ...args]), asm_state);
    }
    return instr;
  }

  parse(mnemonic, args, meta) {
    let inputs = [];
    let clobbers = [];
    let outputs = [];
    let jump_target = null;
    let function_target = null;
    let has_delay_slot = false;
    let is_branch_likely = false;
    let is_conditional = false;
    let is_return = false;
    let is_load = false;
    let is_store = false;
    let eval_fn = null;
    const cls = this;

    const instr_str = String(new AsmInstruction(mnemonic, args));

    const memory_sizes = { b: 1, h: 2, w: 4, d: 8, q: 16 };
    const c1 = mnemonic.slice(1, 2);
    const size = has(memory_sizes, c1) ? memory_sizes[c1] : null;

    const alt_mult_pipeline = mnemonic.endsWith("1");
    const base_mult_mnemonic = alt_mult_pipeline ? mnemonic.slice(0, -1) : mnemonic;
    const lo_reg = alt_mult_pipeline ? R("lo1") : R("lo");
    const hi_reg = alt_mult_pipeline ? R("hi1") : R("hi");

    const make_memory_access = (arg) => {
      pyassert(size !== null);
      if (arg instanceof AsmAddressMode && arg.base === cls.stack_pointer_reg) {
        const loc = StackLocation.from_offset(arg.addend);
        if (loc === null) return [];
        const at = (d) => new StackLocation(loc.offset + d, loc.symbolic_offset);
        if (size === 16) return [loc, at(4), at(8), at(12)];
        if (size === 8) return [loc, at(4)];
        pyassert(size <= 4);
        return [loc];
      }
      return [];
    };

    const unreachable_eval = () => {
      throw new DecompFailure(`Instruction ${instr_str} should be replaced before eval`);
    };

    if (mnemonic === "jr" && args[0] === R("ra")) {
      pyassert(args.length === 1);
      inputs = [R("ra")];
      is_return = true;
      has_delay_slot = true;
    } else if (mnemonic === "jr") {
      pyassert(args.length === 1 && args[0] instanceof Register);
      inputs.push(args[0]);
      jump_target = args[0];
      is_conditional = true;
      has_delay_slot = true;
      eval_fn = (s, a) => s.set_switch_expr(a.reg(0));
    } else if (mnemonic === "jal" || mnemonic === "bal") {
      pyassert(args.length === 1);
      inputs = [...cls.argument_regs];
      outputs = [...cls.all_return_regs];
      clobbers = [...cls.temp_regs];
      function_target = args[0];
      has_delay_slot = true;
      eval_fn = (s, a) => s.make_function_call(a.sym_imm(0), outputs);
    } else if (mnemonic === "jalr") {
      pyassert(args.length === 2 && args[0] === R("ra") && args[1] instanceof Register);
      inputs = [...cls.argument_regs];
      inputs.push(args[1]);
      outputs = [...cls.all_return_regs];
      clobbers = [...cls.temp_regs];
      function_target = args[1];
      has_delay_slot = true;
      eval_fn = (s, a) => s.make_function_call(a.reg(1), outputs);
    } else if (mnemonic === "b" || mnemonic === "j") {
      pyassert(args.length === 1);
      jump_target = get_jump_target(args[0]);
      has_delay_slot = true;
    } else if (["beql", "bnel", "beqzl", "bnezl", "bgezl", "bgtzl", "blezl", "bltzl", "bc1tl", "bc1fl"].includes(mnemonic)) {
      if (mnemonic === "beql" || mnemonic === "bnel") {
        pyassert(args.length === 3 && args[0] instanceof Register && args[1] instanceof Register);
        inputs.push(args[0]);
        inputs.push(args[1]);
      } else if (mnemonic === "bc1tl" || mnemonic === "bc1fl") {
        pyassert(args.length === 1);
        inputs.push(R("condition_bit"));
      } else {
        pyassert(args.length === 2 && args[0] instanceof Register);
        inputs.push(args[0]);
      }
      jump_target = get_jump_target(args[args.length - 1]);
      has_delay_slot = true;
      is_branch_likely = true;
      is_conditional = true;
      eval_fn = unreachable_eval;
    } else if (["beq", "bne", "beqz", "bnez", "bgez", "bgtz", "blez", "bltz", "bc1t", "bc1f"].includes(mnemonic)) {
      if (mnemonic === "beq" || mnemonic === "bne") {
        pyassert(args.length === 3 && args[0] instanceof Register && args[1] instanceof Register);
        inputs = [args[0], args[1]];
      } else if (mnemonic === "bc1t" || mnemonic === "bc1f") {
        pyassert(args.length === 1);
        inputs = [R("condition_bit")];
      } else {
        pyassert(args.length === 2 && args[0] instanceof Register);
        inputs = [args[0]];
      }
      jump_target = get_jump_target(args[args.length - 1]);
      has_delay_slot = true;
      is_conditional = true;
      eval_fn = (s, a) => {
        let cond;
        if (mnemonic === "bc1t" || mnemonic === "bc1f") {
          cond = condition_from_expr(a.regs.get(R("condition_bit")));
          if (mnemonic === "bc1f") cond = cond.negated();
        } else cond = cls.instrs_branches[mnemonic](a);
        s.set_branch_condition(cond);
      };
    } else if (mnemonic === "mfc0") {
      pyassert(args.length === 2 && args[0] instanceof Register);
      outputs = [args[0]];
      eval_fn = (s, a) => s.set_reg(a.reg_ref(0), new ErrorExpr(`mfc0 ${a.raw_arg(1)}`));
    } else if (mnemonic === "mtc0") {
      pyassert(args.length === 2 && args[0] instanceof Register);
      inputs = [args[0]];
      eval_fn = (s) => s.write_statement(error_stmt(instr_str));
    } else if (has(cls.instrs_no_dest, mnemonic)) {
      pyassert(!args.some((a) => a instanceof AsmAddressMode));
      inputs = args.filter((r) => r instanceof Register);
      eval_fn = (s, a) => s.write_statement(cls.instrs_no_dest[mnemonic](a));
    } else if (has(cls.instrs_store, mnemonic)) {
      pyassert(args[0] instanceof Register);
      outputs = make_memory_access(args[1]);
      inputs = [args[0]];
      is_store = true;
      if (mnemonic === "sdc1") inputs.push(other_f64_reg(args[0]));
      else if ((mnemonic === "sd" || mnemonic === "sq") && outputs.length) {
        const n = outputs.length;
        const base = inputs;
        inputs = [];
        for (let k = 0; k < n; k++) inputs.push(...base);
      }
      if (args[1] instanceof AsmAddressMode) inputs.push(args[1].base);
      eval_fn = (s, a) => {
        const store = cls.instrs_store[mnemonic](a);
        if (store !== null) s.store_memory(store, a.reg_ref(0));
      };
    } else if (mnemonic === "mtc1") {
      pyassert(args.length === 2 && args[0] instanceof Register && args[1] instanceof Register);
      inputs = [args[0]];
      outputs = [args[1]];
      eval_fn = (s, a) => s.set_reg(a.reg_ref(1), a.reg(0));
    } else if (has(cls.instrs_destination_first, mnemonic)) {
      pyassert(args[0] instanceof Register);
      outputs = [args[0]];
      const mn_parts = mnemonic.split(".");
      if (["add.d", "sub.d", "neg.d", "abs.d", "sqrt.d", "div.d", "mul.d", "mov.d"].includes(mnemonic)) {
        pyassert(2 <= args.length && args.length <= 3);
        for (const reg of args.slice(1)) {
          pyassert(reg instanceof Register);
          inputs.push(reg, other_f64_reg(reg));
        }
        outputs.push(other_f64_reg(args[0]));
      } else if (mn_parts[0] === "cvt" || mn_parts[0] === "trunc") {
        pyassert(args.length === 2 && args[1] instanceof Register);
        if (mn_parts[2] === "d") inputs = [args[1], other_f64_reg(args[1])];
        else inputs = [args[1]];
        if (mn_parts[1] === "d") outputs.push(other_f64_reg(args[0]));
      } else if (mnemonic.startsWith("l") && size !== null) {
        pyassert(args.length === 2);
        is_load = true;
        inputs = make_memory_access(args[1]);
        if (args[1] instanceof AsmAddressMode) inputs.push(args[1].base);
        if (mnemonic === "lwr") inputs.push(args[0]);
        else if (mnemonic === "ldc1") outputs.push(other_f64_reg(args[0]));
      } else if (mnemonic === "la" && args[1] instanceof AsmAddressMode) {
        inputs = [args[1].base];
      } else if (base_mult_mnemonic === "mfhi") {
        pyassert(args.length === 1);
        inputs = [hi_reg];
      } else if (base_mult_mnemonic === "mflo") {
        pyassert(args.length === 1);
        inputs = [lo_reg];
      } else if (mnemonic === "movn" || mnemonic === "movz") {
        pyassert(args.length === 3 && args[1] instanceof Register && args[2] instanceof Register);
        inputs = [args[0], args[1], args[2]];
      } else {
        pyassert(!args.some((a) => a instanceof AsmAddressMode));
        inputs = args.slice(1).filter((r) => r instanceof Register);
      }
      eval_fn = (s, a) => {
        const target = a.reg_ref(0);
        s.set_reg(target, cls.instrs_destination_first[mnemonic](a));
        if (outputs.length === 2) s.set_reg(other_f64_reg(target), new SecondF64Half());
      };
    } else if (has(cls.instrs_float_comp, mnemonic)) {
      pyassert(args.length === 2 && args[0] instanceof Register && args[1] instanceof Register);
      if (mnemonic.endsWith(".d")) inputs = [args[0], other_f64_reg(args[0]), args[1], other_f64_reg(args[1])];
      else inputs = [args[0], args[1]];
      outputs = [R("condition_bit")];
      eval_fn = (s, a) => s.set_reg(R("condition_bit"), cls.instrs_float_comp[mnemonic](a));
    } else if (has(cls.instrs_hi_lo, base_mult_mnemonic)) {
      pyassert(args.length === 3 && args[0] instanceof Register && args[1] instanceof Register && args[2] instanceof Register);
      inputs = [args[1], args[2]];
      if (base_mult_mnemonic === "madd" || base_mult_mnemonic === "maddu") inputs.push(lo_reg);
      outputs = [hi_reg, lo_reg];
      if (args[0] !== R("zero")) outputs.push(args[0]);
      eval_fn = (s, a) => {
        const [hi, lo] = cls.instrs_hi_lo[base_mult_mnemonic](a, lo_reg);
        s.set_reg(hi_reg, hi);
        s.set_reg(lo_reg, lo);
        const copy_lo_to = a.reg_ref(0);
        if (copy_lo_to !== R("zero")) s.set_reg(copy_lo_to, lo);
      };
    } else if (base_mult_mnemonic === "mtlo" || base_mult_mnemonic === "mthi") {
      pyassert(args.length === 1 && args[0] instanceof Register);
      inputs = [args[0]];
      const output_reg = base_mult_mnemonic === "mthi" ? hi_reg : lo_reg;
      outputs = [output_reg];
      eval_fn = (s, a) => s.set_reg(output_reg, a.reg(0));
    } else if (cls.instrs_ignore.has(mnemonic)) {
      // pass
    } else {
      let maybe_dest_first;
      if (args.length && args[0] instanceof Register) {
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

    return new Instruction({
      mnemonic,
      args,
      meta,
      inputs,
      clobbers,
      outputs,
      jump_target,
      function_target,
      has_delay_slot,
      is_branch_likely,
      is_conditional,
      is_return,
      is_load,
      is_store,
      eval_fn,
    });
  }

  arg_name(loc) {
    pyassert(loc.offset !== null);
    return `arg${floordiv(loc.offset, 4)}`;
  }

  default_function_abi_candidate_slots() {
    return [
      new AbiArgSlot(new ArgLoc(0, 0, R("f12")), Type.floatish()),
      new AbiArgSlot(new ArgLoc(4, 1, R("f13")), Type.floatish()),
      new AbiArgSlot(new ArgLoc(4, 2, R("f14")), Type.floatish()),
      new AbiArgSlot(new ArgLoc(12, 3, R("f15")), Type.floatish()),
      new AbiArgSlot(new ArgLoc(0, 4, R("a0")), Type.intptr()),
      new AbiArgSlot(new ArgLoc(4, 5, R("a1")), Type.any_reg()),
      new AbiArgSlot(new ArgLoc(8, 6, R("a2")), Type.any_reg()),
      new AbiArgSlot(new ArgLoc(12, 7, R("a3")), Type.any_reg()),
    ];
  }

  /** Compute stack positions/registers used by a function according to the o32 ABI. */
  function_abi(fn_sig, likely_regs, { for_call }) {
    const known_slots = [];
    let candidate_slots = [];
    if (fn_sig.params_known) {
      let offset = 0;
      let only_floats = true;
      if (fn_sig.return_type.is_struct()) {
        known_slots.push(new AbiArgSlot(new ArgLoc(0, 0, R("a0")), Type.ptr(fn_sig.return_type), { name: "__return__", comment: "return" }));
        offset = 4;
        only_floats = false;
      }
      fn_sig.params.forEach((param, ind) => {
        const param_type = param.type.decay();
        let [size, align] = param_type.get_parameter_size_align_bytes();
        size = band(size + 3, -4);
        only_floats = only_floats && param_type.is_float();
        offset = band(offset + align - 1, -align);
        const name = param.name;
        let reg2;
        if (ind < 2 && only_floats) {
          reg2 = R(ind === 0 ? "f12" : "f14");
          const is_double = param_type.is_float() && param_type.get_size_bits() === 64;
          known_slots.push(new AbiArgSlot(new ArgLoc(offset, floordiv(offset, 4), reg2), param_type, { name }));
          if (is_double && !for_call) {
            const name2 = name ? `${name}_lo` : null;
            reg2 = R(ind === 0 ? "f13" : "f15");
            known_slots.push(new AbiArgSlot(new ArgLoc(offset + 4, floordiv(offset, 4) + 1, reg2), Type.any_reg(), { name: name2 }));
          }
        } else {
          for (let i = floordiv(offset, 4); i < floordiv(offset + size, 4); i++) {
            const unk_offset = 4 * i - offset;
            reg2 = i < 4 ? R(`a${i}`) : null;
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
            known_slots.push(new AbiArgSlot(new ArgLoc(4 * i, i, reg2), sub_type, { name: name2, comment }));
          }
        }
        offset += size;
      });
      if (fn_sig.is_variadic) {
        for (let i = floordiv(offset, 4); i < 4; i++) candidate_slots.push(new AbiArgSlot(new ArgLoc(i * 4, i, R(`a${i}`)), Type.any_reg()));
      }
    } else {
      candidate_slots = this.default_function_abi_candidate_slots();
    }

    const valid_extra_regs = new Set(known_slots.filter((slot) => slot.loc.reg !== null).map((slot) => slot.loc.reg));
    const possible_slots = [];
    for (const slot of candidate_slots) {
      const reg = slot.loc.reg;
      if (reg === null || !likely_regs.has(reg)) continue;
      let require = null;
      if (slot === candidate_slots[0]) {
        // pass
      } else if (reg === R("f13") || reg === R("f14")) require = ["f12"];
      else if (reg === R("f15")) require = ["f14"];
      else if (reg === R("a1")) require = ["a0", "f12"];
      else if (reg === R("a2")) require = ["a1", "f13", "f14"];
      else if (reg === R("a3")) require = ["a2"];
      if (require && !require.some((r) => valid_extra_regs.has(R(r)))) continue;
      valid_extra_regs.add(reg);
      if ((reg === R("f13") || reg === R("f15")) && for_call) continue;
      if (!likely_regs.get(reg)) continue;
      possible_slots.push(slot);
    }
    return new Abi({ arg_slots: known_slots, possible_slots });
  }

  function_return(expr) {
    return new Map([
      [R("f0"), new Cast(expr, { reinterpret: true, silent: true, type: Type.floatish() })],
      [R("v0"), new Cast(expr, { reinterpret: true, silent: true, type: Type.intptr() })],
      [R("v1"), as_u32(new Cast(expr, { reinterpret: true, silent: false, type: Type.u64() }))],
      [R("f1"), new SecondF64Half()],
    ]);
  }
}

{
  const argument_regs = regs(["a0", "a1", "a2", "a3", "f12", "f13", "f14", "f15"]);
  const simple_temp_regs = regs([
    "v0", "v1", "t0", "t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8", "t9", "f0", "f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8", "f9", "f10", "f11", "f16", "f17", "f18", "f19",
  ]);
  const temp_regs = [...argument_regs, ...simple_temp_regs, ...regs(["at", "hi", "lo", "lo1", "hi1", "condition_bit"])];
  const saved_regs = regs(["s0", "s1", "s2", "s3", "s4", "s5", "s6", "s7", "f20", "f21", "f22", "f23", "f24", "f25", "f26", "f27", "f28", "f29", "f30", "f31", "ra", "31", "fp", "gp"]);
  const stack_pointer_reg = R("sp");
  const aliased_gp_regs = { s8: R("fp"), r0: R("zero") };
  const o32abi_float_regs = {};
  const fnames = ["fv0", "fv0f", "fv1", "fv1f", "ft0", "ft0f", "ft1", "ft1f", "ft2", "ft2f", "ft3", "ft3f", "fa0", "fa0f", "fa1", "fa1f", "ft4", "ft4f", "ft5", "ft5f", "fs0", "fs0f", "fs1", "fs1f", "fs2", "fs2f", "fs3", "fs3f", "fs4", "fs4f", "fs5", "fs5f"];
  fnames.forEach((n, i) => (o32abi_float_regs[n] = R(`f${i}`)));

  const instrs_store = {
    sb: (a) => make_store(a, Type.int_of_size(8)),
    sh: (a) => make_store(a, Type.int_of_size(16)),
    sw: (a) => make_store(a, Type.reg32({ likely_float: false })),
    sd: (a) => make_store(a, Type.reg64({ likely_float: false })),
    sq: (a) => make_store(a, Type.reg128()),
    swl: (a) => handle_swl(a),
    swr: (a) => handle_swr(a),
    swc1: (a) => make_store(a, Type.reg32({ likely_float: true })),
    sdc1: (a) => make_store(a, Type.reg64({ likely_float: true })),
  };
  const instrs_branches = {
    beq: (a) => BinaryOp.icmp(a.reg(0), "==", a.reg(1)),
    bne: (a) => BinaryOp.icmp(a.reg(0), "!=", a.reg(1)),
    beqz: (a) => BinaryOp.icmp(a.reg(0), "==", new Literal(0)),
    bnez: (a) => BinaryOp.icmp(a.reg(0), "!=", new Literal(0)),
    blez: (a) => BinaryOp.scmp(a.reg(0), "<=", new Literal(0)),
    bgtz: (a) => BinaryOp.scmp(a.reg(0), ">", new Literal(0)),
    bltz: (a) => handle_bgez(a).negated(),
    bgez: (a) => handle_bgez(a),
  };
  const trap = (op, cmp, imm) => (a) => void_fn_op("M2C_TRAP_IF", [BinaryOp[cmp](a.reg(0), op, imm ? a.s16_imm(1) : a.reg(1))]);
  const instrs_no_dest = {
    teq: trap("==", "icmp", false),
    tne: trap("!=", "icmp", false),
    tlt: trap("<", "scmp", false),
    tltu: trap("<", "ucmp", false),
    tge: trap(">=", "scmp", false),
    tgeu: trap(">=", "ucmp", false),
    teqi: trap("==", "icmp", true),
    tnei: trap("!=", "icmp", true),
    tlti: trap("<", "scmp", true),
    tltiu: trap("<", "ucmp", true),
    tgei: trap(">=", "scmp", true),
    tgeiu: trap(">=", "ucmp", true),
    break: (a) => void_fn_op("M2C_BREAK", a.count() >= 1 ? [a.s16_imm(0)] : []),
    sync: () => void_fn_op("M2C_SYNC", []),
    "trapuv.fictive": () => new CommentStmt("code compiled with -trapuv"),
    "memcpy.aligned.fictive": (a) => void_fn_op("M2C_MEMCPY_ALIGNED", [a.reg(0), a.reg(1), a.s16_imm(2)]),
    "memcpy.unaligned.fictive": (a) => void_fn_op("M2C_MEMCPY_UNALIGNED", [a.reg(0), a.reg(1), a.s16_imm(2)]),
  };
  const fc = (op, neg) => (a) => {
    const c = BinaryOp.fcmp(a.reg(0), op, a.reg(1));
    return neg ? c.negated() : c;
  };
  const dc = (op, neg) => (a) => {
    const c = BinaryOp.dcmp(a.dreg(0), op, a.dreg(1));
    return neg ? c.negated() : c;
  };
  const instrs_float_comp = {};
  for (const [suf, mk] of [
    ["s", fc],
    ["d", dc],
  ]) {
    Object.assign(instrs_float_comp, {
      [`c.eq.${suf}`]: mk("==", false),
      [`c.olt.${suf}`]: mk("<", false),
      [`c.oge.${suf}`]: mk(">=", false),
      [`c.ole.${suf}`]: mk("<=", false),
      [`c.ogt.${suf}`]: mk(">", false),
      [`c.neq.${suf}`]: mk("==", true),
      [`c.uge.${suf}`]: mk("<", true),
      [`c.ult.${suf}`]: mk(">=", true),
      [`c.ugt.${suf}`]: mk("<=", true),
      [`c.ule.${suf}`]: mk(">", true),
      [`c.seq.${suf}`]: mk("==", false),
      [`c.lt.${suf}`]: mk("<", false),
      [`c.ge.${suf}`]: mk(">=", false),
      [`c.le.${suf}`]: mk("<=", false),
      [`c.gt.${suf}`]: mk(">", false),
      [`c.sne.${suf}`]: mk("==", true),
      [`c.nle.${suf}`]: mk("<=", true),
      [`c.nlt.${suf}`]: mk("<", true),
      [`c.nge.${suf}`]: mk(">=", true),
      [`c.ngt.${suf}`]: mk(">", true),
    });
  }
  const madd = (name) => (a, lo_reg) => [new ErrorExpr(`${name} top half`), handle_add_real(a.regs.get(lo_reg), BinaryOp.int(a.reg(1), "*", a.reg(2)), a)];
  const instrs_hi_lo = {
    div: (a) => [BinaryOp.sint(a.reg(1), "%", a.reg(2)), BinaryOp.sint(a.reg(1), "/", a.reg(2))],
    divu: (a) => [BinaryOp.uint(a.reg(1), "%", a.reg(2)), BinaryOp.uint(a.reg(1), "/", a.reg(2))],
    ddiv: (a) => [BinaryOp.s64(a.reg(1), "%", a.reg(2)), BinaryOp.s64(a.reg(1), "/", a.reg(2))],
    ddivu: (a) => [BinaryOp.u64(a.reg(1), "%", a.reg(2)), BinaryOp.u64(a.reg(1), "/", a.reg(2))],
    mult: (a) => [fold_divmod(BinaryOp.int(a.reg(1), "MULT_HI", a.reg(2))), BinaryOp.int(a.reg(1), "*", a.reg(2))],
    multu: (a) => [fold_divmod(BinaryOp.int(a.reg(1), "MULTU_HI", a.reg(2))), BinaryOp.int(a.reg(1), "*", a.reg(2))],
    dmult: (a) => [BinaryOp.int64(a.reg(1), "DMULT_HI", a.reg(2)), BinaryOp.int64(a.reg(1), "*", a.reg(2))],
    dmultu: (a) => [BinaryOp.int64(a.reg(1), "DMULTU_HI", a.reg(2)), BinaryOp.int64(a.reg(1), "*", a.reg(2))],
    madd: madd("madd"),
    maddu: madd("maddu"),
  };
  const sub = (a) => fold_mul_chains(fold_divmod(BinaryOp.intptr(a.reg(1), "-", a.reg(2))));
  const instrs_destination_first = {
    slt: (a) => BinaryOp.scmp(a.reg(1), "<", a.reg(2)),
    slti: (a) => BinaryOp.scmp(a.reg(1), "<", a.s16_imm(2)),
    sltu: (a) => handle_sltu(a),
    sltiu: (a) => handle_sltiu(a),
    addi: (a) => handle_addi_mips(a),
    addiu: (a) => handle_addi_mips(a),
    add: (a) => handle_add(a),
    addu: (a) => handle_add(a),
    sub,
    subu: sub,
    negu: (a) => fold_mul_chains(UnaryOp.sint("-", a.reg(1))),
    neg: (a) => fold_mul_chains(UnaryOp.sint("-", a.reg(1))),
    "div.fictive": (a) => BinaryOp.sint(a.reg(1), "/", a.full_imm(2)),
    "mod.fictive": (a) => BinaryOp.sint(a.reg(1), "%", a.full_imm(2)),
    daddi: (a) => handle_addi_mips(a),
    daddiu: (a) => handle_addi_mips(a),
    daddu: (a) => handle_add(a),
    dsubu: (a) => fold_mul_chains(BinaryOp.intptr(a.reg(1), "-", a.reg(2))),
    dnegu: (a) => fold_mul_chains(new UnaryOp("-", as_s64(a.reg(1)), { type: Type.s64() })),
    dneg: (a) => fold_mul_chains(new UnaryOp("-", as_s64(a.reg(1)), { type: Type.s64() })),
    mfhi: (a) => a.regs.get(R("hi")),
    mflo: (a) => a.regs.get(R("lo")),
    mfhi1: (a) => a.regs.get(R("hi1")),
    mflo1: (a) => a.regs.get(R("lo1")),
    "add.s": (a) => handle_add_float(a),
    "sub.s": (a) => BinaryOp.f32(a.reg(1), "-", a.reg(2)),
    "neg.s": (a) => new UnaryOp("-", as_f32(a.reg(1)), { type: Type.f32() }),
    "abs.s": (a) => fn_op("fabsf", [as_f32(a.reg(1))], Type.f32()),
    "sqrt.s": (a) => fn_op("sqrtf", [as_f32(a.reg(1))], Type.f32()),
    "div.s": (a) => BinaryOp.f32(a.reg(1), "/", a.reg(2)),
    "mul.s": (a) => BinaryOp.f32(a.reg(1), "*", a.reg(2)),
    "add.d": (a) => handle_add_double(a),
    "sub.d": (a) => BinaryOp.f64(a.dreg(1), "-", a.dreg(2)),
    "neg.d": (a) => new UnaryOp("-", as_f64(a.dreg(1)), { type: Type.f64() }),
    "abs.d": (a) => fn_op("fabs", [as_f64(a.dreg(1))], Type.f64()),
    "sqrt.d": (a) => fn_op("sqrt", [as_f64(a.dreg(1))], Type.f64()),
    "div.d": (a) => BinaryOp.f64(a.dreg(1), "/", a.dreg(2)),
    "mul.d": (a) => BinaryOp.f64(a.dreg(1), "*", a.dreg(2)),
    "cvt.d.s": (a) => handle_convert(a.reg(1), Type.f64(), Type.f32()),
    "cvt.d.w": (a) => handle_convert(a.reg(1), Type.f64(), Type.intish()),
    "cvt.s.d": (a) => handle_convert(a.dreg(1), Type.f32(), Type.f64()),
    "cvt.s.w": (a) => handle_convert(a.reg(1), Type.f32(), Type.intish()),
    "cvt.w.d": (a) => handle_convert(a.dreg(1), Type.s32(), Type.f64()),
    "cvt.w.s": (a) => handle_convert(a.reg(1), Type.s32(), Type.f32()),
    "cvt.s.u.fictive": (a) => handle_convert(a.reg(1), Type.f32(), Type.u32()),
    "cvt.u.d.fictive": (a) => handle_convert(a.dreg(1), Type.u32(), Type.f64()),
    "cvt.u.s.fictive": (a) => handle_convert(a.reg(1), Type.u32(), Type.f32()),
    "trunc.w.s": (a) => handle_convert(a.reg(1), Type.s32(), Type.f32()),
    "trunc.w.d": (a) => handle_convert(a.dreg(1), Type.s32(), Type.f64()),
    ori: (a) => handle_or(a.reg(1), a.u16_imm(2)),
    and: (a) => BinaryOp.int(a.reg(1), "&", a.reg(2)),
    or: (a) => BinaryOp.int(a.reg(1), "|", a.reg(2)),
    not: (a) => new UnaryOp("~", a.reg(1), { type: Type.intish() }),
    nor: (a) => new UnaryOp("~", BinaryOp.int(a.reg(1), "|", a.reg(2)), { type: Type.intish() }),
    xor: (a) => BinaryOp.int(a.reg(1), "^", a.reg(2)),
    andi: (a) => BinaryOp.int(a.reg(1), "&", a.u16_imm(2)),
    xori: (a) => handle_xor(a.reg(1), a.u16_imm(2)),
    sll: (a) => fold_mul_chains(BinaryOp.int(a.reg(1), "<<", a.s16_imm(2))),
    sllv: (a) => fold_mul_chains(BinaryOp.int(a.reg(1), "<<", a.reg(2))),
    srl: (a) => fold_divmod(BinaryOp.ushift(a.reg(1), ">>", a.s16_imm(2))),
    srlv: (a) => fold_divmod(BinaryOp.ushift(a.reg(1), ">>", a.reg(2))),
    sra: (a) => handle_shift_right(a, { signed: true }),
    srav: (a) => fold_divmod(BinaryOp.sshift(a.reg(1), ">>", a.reg(2))),
    dsll: (a) => fold_mul_chains(BinaryOp.int64(a.reg(1), "<<", as_intish(a.s16_imm(2)))),
    dsll32: (a) => fold_mul_chains(BinaryOp.int64(a.reg(1), "<<", imm_add_32(a.s16_imm(2)))),
    dsllv: (a) => BinaryOp.int64(a.reg(1), "<<", as_intish(a.reg(2))),
    dsrl: (a) => new BinaryOp(as_u64(a.reg(1)), ">>", as_intish(a.s16_imm(2)), { type: Type.u64() }),
    dsrl32: (a) => new BinaryOp(as_u64(a.reg(1)), ">>", imm_add_32(a.s16_imm(2)), { type: Type.u64() }),
    dsrlv: (a) => new BinaryOp(as_u64(a.reg(1)), ">>", as_intish(a.reg(2)), { type: Type.u64() }),
    dsra: (a) => new BinaryOp(as_s64(a.reg(1)), ">>", as_intish(a.s16_imm(2)), { type: Type.s64() }),
    dsra32: (a) => new BinaryOp(as_s64(a.reg(1)), ">>", imm_add_32(a.s16_imm(2)), { type: Type.s64() }),
    dsrav: (a) => new BinaryOp(as_s64(a.reg(1)), ">>", as_intish(a.reg(2)), { type: Type.s64() }),
    move: (a) => a.reg(1),
    "move.fictive": (a) => a.reg(1),
    mfc1: (a) => a.reg(1),
    "mov.s": (a) => a.reg(1),
    "mov.d": (a) => as_f64(a.dreg(1)),
    movn: (a) => handle_conditional_move(a, true),
    movz: (a) => handle_conditional_move(a, false),
    cfc1: () => new ErrorExpr("cfc1"),
    li: (a) => a.full_imm(1),
    lui: (a) => load_upper(a),
    la: (a) => handle_la(a),
    lb: (a) => handle_load(a, Type.s8()),
    lbu: (a) => handle_load(a, Type.u8()),
    lh: (a) => handle_load(a, Type.s16()),
    lhu: (a) => handle_load(a, Type.u16()),
    lw: (a) => handle_lw(a),
    ld: (a) => handle_load(a, Type.reg64({ likely_float: false })),
    lq: (a) => handle_load(a, Type.reg128()),
    lwu: (a) => handle_load(a, Type.u32()),
    lwc1: (a) => handle_load(a, Type.reg32({ likely_float: true })),
    ldc1: (a) => handle_load(a, Type.reg64({ likely_float: true })),
    lwl: (a) => handle_lwl(a),
    lwr: (a) => handle_lwr(a),
    seb: (a) => as_type(a.reg(1), Type.s8(), false),
    seh: (a) => as_type(a.reg(1), Type.s16(), false),
  };

  Object.assign(MipsArch.prototype, {
    arch: Target.ArchEnum.MIPS,
    re_comment: "[#;].*",
    supports_dollar_regs: true,
    has_delay_slots: true,
    home_space_size: 0x10,
    stack_pointer_reg,
    frame_pointer_regs: [R("fp")],
    return_address_reg: R("ra"),
    base_return_regs: [
      [R("v0"), false],
      [R("f0"), true],
    ],
    all_return_regs: regs(["v0", "v1", "f0", "f1"]),
    argument_regs,
    simple_temp_regs,
    temp_regs,
    saved_regs,
    all_regs: [...saved_regs, ...temp_regs, stack_pointer_reg, R("zero")],
    aliased_gp_regs,
    o32abi_float_regs,
    aliased_regs: { ...o32abi_float_regs, ...aliased_gp_regs },
    asm_patterns: [
      new DivPattern(),
      new DivuPattern(),
      new DivP2Pattern1(),
      new DivP2Pattern2(),
      new Div2S16Pattern(),
      new Div2S32Pattern1(),
      new Div2S32Pattern2(),
      new ModP2Pattern1(),
      new ModP2Pattern2(),
      new UtfPattern(),
      new FtuPattern(),
      new Mips1DoubleLoadStorePattern(),
      new GccSqrtPatternJal(),
      new GccSqrtPatternJalr(),
      new TrapuvPattern(),
      new SetGpPattern(),
      new AlignedMemcpyPattern(),
      new UnalignedMemcpyPattern(),
      new GpJumpPattern(),
      new OriSpPattern(),
      new TailCallPattern(),
    ],
    instrs_ignore: new Set(["ctc1", "nop"]),
    instrs_store,
    instrs_branches,
    instrs_no_dest,
    instrs_float_comp,
    instrs_hi_lo,
    instrs_destination_first,
  });
}

export class MipseeArch extends MipsArch {
  default_function_abi_candidate_slots() {
    const out = [];
    for (let i = 0; i < 8; i++) out.push(new AbiArgSlot(new ArgLoc(null, i, R(`a${i}`)), Type.intptr()));
    for (let i = 0; i < 8; i++) out.push(new AbiArgSlot(new ArgLoc(null, 8 + i, R(`f${12 + i}`)), Type.floatish()));
    return out;
  }

  arg_name(loc) {
    if (loc.offset !== null) return `arg_sp${format_hex(loc.offset)}`;
    pyassert(loc.reg !== null);
    const reg_num = int_(loc.reg.register_name.slice(1));
    if (loc.reg.register_name.startsWith("a")) return `arg${reg_num}`;
    return `fparg${reg_num - 12}`;
  }

  function_abi(fn_sig, likely_regs, { for_call }) {
    void for_call;
    const known_slots = [];
    let candidate_slots = [];
    const intptr_regs = this.argument_regs.filter((r) => r.register_name[0] !== "f");
    const float_regs = this.argument_regs.filter((r) => r.register_name[0] === "f");

    if (fn_sig.params_known) {
      let ind = 0;
      let stack_offset = 0;
      for (const param of fn_sig.params) {
        const param_type = param.type.decay();
        let reg = null;
        let offset = null;
        const pool = param_type.is_float() ? float_regs : intptr_regs;
        if (pool.length) reg = pool.shift();
        else {
          offset = stack_offset;
          stack_offset += 4;
        }
        known_slots.push(new AbiArgSlot(new ArgLoc(offset, ind, reg), param_type, { name: param.name }));
        ind += 1;
      }
      if (fn_sig.is_variadic) {
        for (const reg of intptr_regs) {
          candidate_slots.push(new AbiArgSlot(new ArgLoc(null, ind, reg), Type.intptr()));
          ind += 1;
        }
        for (const reg of float_regs) {
          candidate_slots.push(new AbiArgSlot(new ArgLoc(null, ind, reg), Type.floatish()));
          ind += 1;
        }
      }
    } else {
      candidate_slots = this.default_function_abi_candidate_slots();
    }

    const possible_slots = [];
    const valid_extra_regs = new Set(known_slots.filter((slot) => slot.loc.reg !== null).map((slot) => slot.loc.reg));
    for (const slot of candidate_slots) {
      const reg = slot.loc.reg;
      if (reg === null || !likely_regs.has(reg)) continue;
      if (slot === candidate_slots[0]) {
        // pass
      } else {
        const regname = reg.register_name;
        const prev_reg = R(`${regname[0]}${int_(regname.slice(1)) - 1}`);
        if (this.argument_regs.includes(prev_reg) && !valid_extra_regs.has(prev_reg)) continue;
      }
      valid_extra_regs.add(reg);
      if (!likely_regs.get(reg)) continue;
      possible_slots.push(slot);
    }
    return new Abi({ arg_slots: known_slots, possible_slots });
  }
}

{
  const argument_regs = regs(["a0", "a1", "a2", "a3", "a4", "a5", "a6", "a7", "f12", "f13", "f14", "f15", "f16", "f17", "f18", "f19"]);
  const simple_temp_regs = regs(["v0", "v1", "t4", "t5", "t6", "t7", "t8", "t9", "f0", "f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8", "f9", "f10", "f11"]);
  const temp_regs = [...argument_regs, ...simple_temp_regs, ...regs(["at", "hi", "lo", "condition_bit"])];
  const saved_regs = regs(["s0", "s1", "s2", "s3", "s4", "s5", "s6", "s7", "f20", "f21", "f22", "f23", "f24", "f25", "f26", "f27", "f28", "f29", "f30", "f31", "ra", "31", "fp", "gp"]);
  const stack_pointer_reg = R("sp");
  const aliased_gp_regs = { s8: R("fp"), r0: R("zero") };
  const eabi64_float_regs = {};
  ["fv0", "fv1", "ft0", "ft1", "ft2", "ft3", "ft4", "ft5", "ft6", "ft7", "ft8", "ft9", "fa0", "fa1", "fa2", "fa3", "fa4", "fa5", "fa6", "fa7", "fs0", "fs1", "fs2", "fs3", "fs4", "fs5", "fs6", "fs7", "fs8", "fs9", "fs10", "fs11"].forEach(
    (n, i) => (eabi64_float_regs[n] = R(`f${i}`)),
  );
  const numeric_names = ["zero", "at", "v0", "v1", "a0", "a1", "a2", "a3", "a4", "a5", "a6", "a7", "t0", "t1", "t2", "t3", "s0", "s1", "s2", "s3", "s4", "s5", "s6", "s7", "t8", "t9", "k0", "k1", "gp", "sp", "fp", "ra"];
  const numeric_regs = {};
  numeric_names.forEach((n, i) => (numeric_regs[String(i)] = R(n)));
  Object.assign(MipseeArch.prototype, {
    stack_pointer_reg,
    home_space_size: 0,
    argument_regs,
    simple_temp_regs,
    temp_regs,
    saved_regs,
    all_regs: [...saved_regs, ...temp_regs, stack_pointer_reg, R("zero")],
    aliased_gp_regs,
    eabi64_float_regs,
    numeric_regs,
    aliased_regs: { ...eabi64_float_regs, ...aliased_gp_regs, ...numeric_regs },
  });
}
