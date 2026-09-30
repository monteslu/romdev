// Port of m2c/arch_ppc.py
import { DecompFailure } from "./error.js";
import { IrPattern } from "./ir_pattern.js";
import { Target } from "./options.js";
import { AsmAddressMode, AsmGlobalSymbol, AsmInstruction, AsmLiteral, BinOp, Macro, Register, get_jump_target } from "./asm_instruction.js";
import { Instruction, InstructionMeta, StackLocation } from "./instruction.js";
import { AsmPattern, Replacement, SimpleAsmPattern, make_pattern } from "./asm_pattern.js";
import {
  Abi,
  AbiArgSlot,
  AddressMode,
  Arch,
  ArgLoc,
  BinaryOp,
  Cast,
  ErrorExpr,
  ExprStmt,
  Literal,
  TernaryOp,
  UnaryOp,
  as_intish,
  as_u32,
  as_type,
  format_hex,
} from "./translate.js";
import {
  add_imm,
  carry_add_to,
  carry_sub_from,
  error_stmt,
  fn_op,
  fold_divmod,
  fold_mul_chains,
  handle_add,
  handle_add_double,
  handle_add_float,
  handle_add_real,
  handle_addi,
  handle_addis,
  handle_cmpnez,
  handle_convert,
  handle_load,
  handle_loadx,
  handle_or,
  handle_rlwimi,
  handle_rlwinm,
  handle_rlwnm,
  handle_shift_right,
  handle_xor,
  load_upper,
  make_store,
  make_storex,
  void_fn_op,
} from "./evaluate.js";
import { InstrRef } from "./flow_graph.js";
import { Type } from "./types.js";
import { band, has, int_, lstrip, pyassert, pyeq, repr, rstrip } from "./py.js";

/**
 * For floating point, `x <= y` and `x >= y` use `cror` to OR together the `cr0_eq`
 * bit with either `cr0_lt` or `cr0_gt`.
 */
class FcmpoCrorPattern extends SimpleAsmPattern {
  pattern = make_pattern("fcmpo $cr0, $x, $y", "cror 2, N, 2");

  replace(m) {
    const fcmpo = m.body[0];
    pyassert(fcmpo instanceof Instruction);
    if (m.literals.get("N") === 0) return new Replacement([new AsmInstruction("fcmpo.lte.fictive", fcmpo.args)], m.body.length);
    else if (m.literals.get("N") === 1) return new Replacement([new AsmInstruction("fcmpo.gte.fictive", fcmpo.args)], m.body.length);
    return null;
  }
}

/** Comparison results extracted as ints. */
class MfcrPattern extends SimpleAsmPattern {
  pattern = make_pattern("mfcr $x", "rlwinm $x, $x, N, 31, 31");

  replace(m) {
    const x = m.regs.get("x");
    const n = m.literals.get("N");
    let reg;
    if (n === 1) reg = new Register("cr0_lt");
    else if (n === 2) reg = new Register("cr0_gt");
    else if (n === 3) reg = new Register("cr0_eq");
    else if (n === 4) reg = new Register("cr0_so");
    else return null;
    return new Replacement([new AsmInstruction("move.fictive", [x, reg])], m.body.length);
  }
}

/** `return fn(...);` emitted as `b fn` instead of `bl fn; blr`. */
class TailCallPattern extends AsmPattern {
  match(matcher) {
    if (matcher.index !== matcher.input.length - 1) return null;
    const instr = matcher.input[matcher.index];
    if (instr instanceof Instruction && instr.mnemonic === "b" && instr.args[0] instanceof AsmGlobalSymbol && !matcher.is_local_label(instr.args[0].symbol_name)) {
      return new Replacement([new AsmInstruction("bl", instr.args), new AsmInstruction("blr", [])], 1);
    }
    return null;
  }
}

/** Expand calls to MWCC's built-in `_{save,rest}{gpr,fpr}_` functions into register saves/restores. */
class SaveRestoreRegsFnPattern extends AsmPattern {
  match(matcher) {
    const bl = matcher.input[matcher.index];
    if (!(bl instanceof Instruction) || bl.mnemonic !== "bl" || !(bl.args[0] instanceof AsmGlobalSymbol)) return null;
    const parts = bl.args[0].symbol_name.split("_");
    if (parts.length !== 3 || parts[0]) return null;
    let mnemonic, size, reg_prefix;
    if (parts[1] === "savegpr" || parts[1] === "restgpr") {
      mnemonic = parts[1] === "savegpr" ? "stw" : "lwz";
      size = 4;
      reg_prefix = "r";
    } else if (parts[1] === "savefpr" || parts[1] === "restfpr") {
      mnemonic = parts[1] === "savefpr" ? "stfd" : "lfd";
      size = 8;
      reg_prefix = "f";
    } else return null;

    let addend = null;
    for (let i = matcher.index - 1; i >= 0; i--) {
      const instr = matcher.input[i];
      if (
        instr instanceof Instruction &&
        instr.mnemonic === "addi" &&
        instr.args[0] === new Register("r11") &&
        instr.args[1] === new Register("r1") &&
        instr.args[2] instanceof AsmLiteral
      ) {
        addend = instr.args[2].value;
        break;
      }
    }
    if (addend === null) return null;

    const regnum = int_(parts[2]);
    const new_instrs = [];
    for (let i = regnum; i < 32; i++) {
      const reg = new Register(reg_prefix + String(i));
      const stack_pos = new AsmAddressMode(new Register("r1"), new AsmLiteral(size * (i - 32) + addend), null);
      new_instrs.push(new AsmInstruction(mnemonic, [reg, stack_pos]));
    }
    return new Replacement(new_instrs, 1);
  }
}

/** Comparison against 0. */
class CmpnezPattern1 extends IrPattern {
  replacement = "cmpnez.fictive $o, $i";
  parts = ["addic $a, $i, -1", "subfe $o, $a, $i"];
}

class CmpnezPattern2 extends IrPattern {
  replacement = "cmpnez.fictive $o, $i";
  parts = ["neg $a, $i", "or $b, $a, $i", "srwi $o, $b, 31"];
}

class CmplezPattern extends IrPattern {
  replacement = "cmplez.fictive $o, $i";
  parts = ["cntlzw $a, $i", "li $b, 1", "rlwnm $o, $b, $a, 31, 31"];
}

class CmpgtzPattern extends IrPattern {
  replacement = "cmpgtz.fictive $o, $i";
  parts = ["neg $a, $i", "andc $b, $a, $i", "srwi $o, $b, 31"];
}

class CmpnePattern extends IrPattern {
  replacement = "cmpne.fictive $o, $x, $y";
  parts = ["subf $a, $x, $y", "subf $b, $y, $x", "or $c, $a, $b", "srwi $o, $c, 31"];
}

class CmplePattern extends IrPattern {
  replacement = "cmple.fictive $o, $x, $y";
  parts = ["srawi $a, $y, 31", "srwi $b, $x, 31", "subfc $c, $x, $y", "adde $o, $a, $b"];
}

class CmpltPattern1 extends IrPattern {
  replacement = "cmplt.fictive $o, $x, $y";
  parts = ["eqv $a, $y, $x", "subfc $b, $y, $x", "srwi $c, $a, 31", "addze $d, $c", "clrlwi $o, $d, 31"];
}

class CmpltPattern2 extends IrPattern {
  replacement = "cmplt.fictive $o, $x, $y";
  parts = ["xor $a, $y, $x", "srawi $b, $a, 1", "and $c, $a, $y", "subf $d, $c, $b", "srwi $o, $d, 31"];
}

class CmpleuPattern1 extends IrPattern {
  replacement = "cmpleu.fictive $o, $x, $y";
  parts = ["subf $a, $x, $y", "orc $b, $y, $x", "srwi $c, $a, 1", "subf $d, $c, $b", "srwi $o, $d, 31"];
}

class CmpleuPattern2 extends IrPattern {
  replacement = "cmpleu.fictive $o, $x, $y";
  parts = ["li $a, -1", "subfc $b, $x, $y", "subfze $o, $a"];
}

class CmpltuPattern1 extends IrPattern {
  replacement = "cmpltu.fictive $o, $x, $y";
  parts = ["subfc $a, $y, $x", "subfe $b, $a, $a", "neg $o, $b"];
}

class CmpltuPattern2 extends IrPattern {
  replacement = "cmpltu.fictive $o, $x, $y";
  parts = ["xor $a, $y, $x", "cntlzw $b, $a", "slw $c, $y, $b", "srwi $o, $c, 31"];
}

/** Split decrement-$ctr-and-branch instructions into a pair of instructions. */
class BranchCtrPattern extends AsmPattern {
  match(matcher) {
    const instr = matcher.input[matcher.index];
    if (instr instanceof Instruction && (instr.mnemonic === "bdz" || instr.mnemonic === "bdnz")) {
      const ctr = new Register("ctr");
      return new Replacement([new AsmInstruction("addi", [ctr, ctr, new AsmLiteral(-1)]), new AsmInstruction(instr.mnemonic + ".fictive", instr.args)], 1);
    }
    return null;
  }
}

class FloatishToUintPattern extends SimpleAsmPattern {
  pattern = make_pattern("bl __cvt_fp2unsigned");

  replace(m) {
    return new Replacement([new AsmInstruction("cvt.u.d.fictive", [new Register("r3"), new Register("f1")])], m.body.length);
  }
}

class LoopStructCopyPattern extends AsmPattern {
  loop_patterns = [
    // 4-aligned
    make_pattern(".loop:", ".set W, 8", ".set B, 4", "lwz $a, 4($x)", "lwzu $b, 8($x)", "stw $a, 4($y)", "stwu $b, 8($y)", "bdnz .loop"),
    make_pattern(".loop:", ".set W, 8", ".set B, 8", "lwzu $a, 8($x)", "lwz $b, 4($x)", "stwu $a, 8($y)", "stw $b, 4($y)", "bdnz .loop"),
    // 2-aligned
    make_pattern(".loop:", ".set W, 4", ".set B, 2", "lhz $a, 2($x)", "lhzu $b, 4($x)", "sth $a, 2($y)", "sthu $b, 4($y)", "bdnz .loop"),
    make_pattern(".loop:", ".set W, 4", ".set B, 4", "lhzu $a, 4($x)", "lhz $b, 2($x)", "sthu $a, 4($y)", "sth $b, 2($y)", "bdnz .loop"),
    // 1-aligned
    make_pattern(".loop:", ".set W, 2", ".set B, 1", "lbz $a, 1($x)", "lbzu $b, 2($x)", "stb $a, 1($y)", "stbu $b, 2($y)", "bdnz .loop"),
    make_pattern(".loop:", ".set W, 2", ".set B, 2", "lbzu $a, 2($x)", "lbz $b, 1($x)", "stbu $a, 2($y)", "stb $b, 1($y)", "bdnz .loop"),
  ];

  match(matcher) {
    let m = null;
    for (const pattern of this.loop_patterns) {
      m = matcher.try_match(pattern);
      if (m !== null) break;
    }
    if (m === null) return null;
    const new_instr = new AsmInstruction("loopstructcopy.fictive", [
      m.regs.get("y"),
      m.regs.get("x"),
      m.regs.get("y"),
      m.regs.get("x"),
      new Register("ctr"),
      new AsmLiteral(m.literals.get("W")),
      new AsmLiteral(m.literals.get("B")),
      new AsmLiteral(0),
      new AsmLiteral(0),
    ]);
    return new Replacement([m.body[0], new_instr], m.body.length);
  }
}

/** Recognizing struct copy when it starts with lwz lwz stw stw. */
class StructCopyPattern extends AsmPattern {
  pattern = make_pattern("lwz $a, I($s)", "lwz $b, (I+4)($s)", "stw $a, I($d)", "stw $b, (I+4)($d)");

  match(matcher) {
    let m = matcher.try_match(this.pattern);
    if (m === null) return null;
    let i = 8;
    const pattern_ext = [...this.pattern];
    for (;;) {
      const pattern2 = make_pattern(`lwz $a, (I+${i})($s)`, `lwz $b, (I+${i + 4})($s)`, `stw $a, (I+${i})($d)`, `stw $b, (I+${i + 4})($d)`);
      const m2 = matcher.try_match([...pattern_ext, ...pattern2]);
      if (m2) {
        m = m2;
        i += 8;
        pattern_ext.push(...pattern2);
      } else break;
    }

    const pattern_end_4b = make_pattern(`lwz $b, (I+${i})($s)`, `stw $b, (I+${i})($d)`);
    let m_end = matcher.try_match([...pattern_ext, ...pattern_end_4b]);
    if (m_end) {
      m = m_end;
      i += 4;
      pattern_ext.push(...pattern_end_4b);
    }

    const pattern_end_2b = make_pattern(`lhz $b, (I+${i})($s)`, `sth $b, (I+${i})($d)`);
    m_end = matcher.try_match([...pattern_ext, ...pattern_end_2b]);
    if (m_end) {
      m = m_end;
      i += 2;
      pattern_ext.push(...pattern_end_2b);
    }

    const pattern_end_1b = make_pattern(`lbz $b, (I+${i})($s)`, `stb $b, (I+${i})($d)`);
    m_end = matcher.try_match([...pattern_ext, ...pattern_end_1b]);
    if (m_end) {
      m = m_end;
      i += 1;
    }

    return new Replacement([new AsmInstruction("structcopy.fictive", [m.regs.get("d"), m.regs.get("s"), new AsmLiteral(i)])], m.body.length);
  }
}

class FloatishToSintIrPattern extends IrPattern {
  replacement = "fctiwz.fictive $i, $f";
  parts = ["fctiwz $t, $f", "stfd $t, (N-4)($r1)", "lwz $i, N($r1)"];
}

// Upstream mixes in CheckConstantMixin *after* IrPattern, so IrPattern.check
// (always true) wins in the MRO; the mixin's check is never used.

class SintToDoubleIrPattern extends IrPattern {
  replacement = "cvt.d.i.fictive $f, $i, K($k)";
  parts = ["lis $a, 0x4330", "stw $a, N($r1)", "xoris $b, $i, 0x8000", "stw $b, (N+4)($r1)", "lfd $d, N($r1)", "lfd $c, K($k)", "fsub $f, $d, $c"];
}

class UintToDoubleIrPattern extends IrPattern {
  replacement = "cvt.d.u.fictive $f, $i, K($k)";
  parts = ["lis $a, 0x4330", "stw $a, N($r1)", "stw $i, (N+4)($r1)", "lfd $d, N($r1)", "lfd $c, K($k)", "fsub $f, $d, $c"];
}

class SintToFloatIrPattern extends IrPattern {
  replacement = "cvt.s.i.fictive $f, $i, K($k)";
  parts = ["lis $a, 0x4330", "stw $a, N($r1)", "xoris $b, $i, 0x8000", "stw $b, (N+4)($r1)", "lfd $d, N($r1)", "lfd $c, K($k)", "fsubs $f, $d, $c"];
}

class UintToFloatIrPattern extends IrPattern {
  replacement = "cvt.s.u.fictive $f, $i, K($k)";
  parts = ["lis $a, 0x4330", "stw $a, N($r1)", "stw $i, (N+4)($r1)", "lfd $d, N($r1)", "lfd $c, K($k)", "fsubs $f, $d, $c"];
}

class LoopStructCopySetupPattern extends IrPattern {
  replacement = "loopstructcopy.fictive $a, $b, $x, $y, $z, W, B, B, T";
  parts = ["addi $a, $x, -B", "addi $b, $y, -B", "loopstructcopy.fictive $a, $b, $a, $b, $z, W, B, 0, 0"];

  static _by_offset(refs) {
    const ret = new Map();
    for (const ref of refs) {
      if (!(ref instanceof InstrRef)) continue;
      const ins = ref.instruction;
      if (ins.args.length !== 2) continue;
      const arg = ins.args[1];
      if (!(arg instanceof AsmAddressMode)) continue;
      if (!(arg.addend instanceof AsmLiteral)) continue;
      ret.set(arg.addend.value, ref);
    }
    return ret;
  }

  check(m, arch, flow_graph) {
    let offset = m.symbolic_args.get("B");
    pyassert(offset instanceof AsmLiteral);
    offset = offset.value;
    let tail_size = 0;

    const ref = m.body[2];
    pyassert(ref.instruction.mnemonic === "loopstructcopy.fictive");
    const dst = m.symbolic_registers.get("a");
    const src = m.symbolic_registers.get("b");
    const dst_refs_by_offset = LoopStructCopySetupPattern._by_offset(flow_graph.instr_uses.get(ref).get(dst));
    const src_refs_by_offset = LoopStructCopySetupPattern._by_offset(flow_graph.instr_uses.get(ref).get(src));

    const tails = [
      ["lwz", "stw", 4],
      ["lhz", "sth", 2],
      ["lbz", "stb", 1],
    ];
    for (const [load_mn, store_mn, width] of tails) {
      const load = src_refs_by_offset.get(offset + tail_size) ?? null;
      const store = dst_refs_by_offset.get(offset + tail_size) ?? null;
      if (load === null || store === null || load.instruction.mnemonic !== load_mn || store.instruction.mnemonic !== store_mn) continue;
      const temp_reg = load.instruction.args[0];
      pyassert(temp_reg instanceof Register);
      if (!flow_graph.instr_uses.get(load).get(temp_reg).has(store)) continue;
      tail_size += width;
      load.instruction = load.instruction.replace({ in_pattern: true });
      store.replace_instruction(new AsmInstruction("nop", []), arch);
    }

    m.symbolic_args.set("T", new AsmLiteral(tail_size));
    return true;
  }
}

const r = (names) => names.map((n) => new Register(n));

const argument_regs = r(["r3", "r4", "r5", "r6", "r7", "r8", "r9", "r10", "f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8", "f9", "f10", "f11", "f12", "f13"]);
const simple_temp_regs = r(["r11", "r12"]);
const temp_regs = [...argument_regs, ...simple_temp_regs, ...r(["r0", "f0", "cr0_gt", "cr0_lt", "cr0_eq", "cr0_so", "ctr"])];
const saved_regs = r([
  "lr",
  "r2",
  "r13",
  "r14",
  "r15",
  "r16",
  "r17",
  "r18",
  "r19",
  "r20",
  "r21",
  "r22",
  "r23",
  "r24",
  "r25",
  "r26",
  "r27",
  "r28",
  "r29",
  "r30",
  "r31",
  "f14",
  "f15",
  "f16",
  "f17",
  "f18",
  "f19",
  "f20",
  "f21",
  "f22",
  "f23",
  "f24",
  "f25",
  "f26",
  "f27",
  "f28",
  "f29",
  "f30",
  "f31",
]);
const stack_pointer_reg = new Register("r1");
const all_regs = [...saved_regs, ...temp_regs, stack_pointer_reg, ...r(["zero", "cr0", "cr1", "cr2", "cr3", "cr4", "cr5", "cr6", "cr7"])];

// List of all instructions where `$r0` as certain args is interpreted as `0`
// instead of the contents of `$r0`. The value is the affected argument index.
const INSTRS_R0_AS_ZERO = {
  addi: 1,
  addis: 1,
  dcbf: 0,
  dcbi: 0,
  dcbst: 0,
  dcbt: 0,
  dcbtst: 0,
  dcbz: 0,
  dcbz_l: 0,
  eciwx: 1,
  ecowx: 1,
  icbi: 0,
  lbz: 1,
  lbzx: 1,
  lfd: 1,
  lfdx: 1,
  lfs: 1,
  lfsx: 1,
  lha: 1,
  lhax: 1,
  lhbrx: 1,
  lhz: 1,
  lhzx: 1,
  lmw: 1,
  lswi: 1,
  lswx: 1,
  lwarx: 1,
  lwbrx: 1,
  lwz: 1,
  lwzx: 1,
  psq_lx: 1,
  psq_stx: 1,
  stb: 1,
  stbx: 1,
  stfd: 1,
  stfdx: 1,
  stfiwx: 1,
  stfs: 1,
  stfsx: 1,
  sth: 1,
  sthbrx: 1,
  sthx: 1,
  stmw: 1,
  stswi: 1,
  stswx: 1,
  stw: 1,
  stwbrx: 1,
  "stwcx.": 1,
  stwx: 1,
};

const instrs_ignore = new Set(["nop", "stmw", "lmw", "crclr", "crset"]);

const instrs_store = {
  stb: (a) => make_store(a, Type.int_of_size(8)),
  sth: (a) => make_store(a, Type.int_of_size(16)),
  stw: (a) => make_store(a, Type.reg32({ likely_float: false })),
  stbx: (a) => make_storex(a, Type.int_of_size(8)),
  sthx: (a) => make_storex(a, Type.int_of_size(16)),
  stwx: (a) => make_storex(a, Type.reg32({ likely_float: false })),
  stfs: (a) => make_store(a, Type.f32()),
  stfd: (a) => make_store(a, Type.f64()),
  stfsx: (a) => make_storex(a, Type.f32()),
  stfdx: (a) => make_storex(a, Type.f64()),
  psq_st: () => null,
};
const instrs_store_update = {
  stbu: (a) => make_store(a, Type.int_of_size(8)),
  sthu: (a) => make_store(a, Type.int_of_size(16)),
  stwu: (a) => make_store(a, Type.reg32({ likely_float: false })),
  stbux: (a) => make_storex(a, Type.int_of_size(8)),
  sthux: (a) => make_storex(a, Type.int_of_size(16)),
  stwux: (a) => make_storex(a, Type.reg32({ likely_float: false })),
  stfsu: (a) => make_store(a, Type.f32()),
  stfdu: (a) => make_store(a, Type.f64()),
  stfsux: (a) => make_storex(a, Type.f32()),
  stfdux: (a) => make_storex(a, Type.f64()),
};
const instrs_load = {
  lba: (a) => handle_load(a, Type.s8()),
  lbz: (a) => handle_load(a, Type.u8()),
  lha: (a) => handle_load(a, Type.s16()),
  lhz: (a) => handle_load(a, Type.u16()),
  lwz: (a) => handle_load(a, Type.reg32({ likely_float: false })),
  lbax: (a) => handle_loadx(a, Type.s8()),
  lbzx: (a) => handle_loadx(a, Type.u8()),
  lhax: (a) => handle_loadx(a, Type.s16()),
  lhzx: (a) => handle_loadx(a, Type.u16()),
  lwzx: (a) => handle_loadx(a, Type.reg32({ likely_float: false })),
  lfs: (a) => handle_load(a, Type.f32()),
  lfd: (a) => handle_load(a, Type.f64()),
  lfsx: (a) => handle_loadx(a, Type.f32()),
  lfdx: (a) => handle_loadx(a, Type.f64()),
  psq_l: () => new ErrorExpr("psq_l unimplemented"),
};
const instrs_load_update = {
  lbau: (a) => handle_load(a, Type.s8()),
  lbzu: (a) => handle_load(a, Type.u8()),
  lhau: (a) => handle_load(a, Type.s16()),
  lhzu: (a) => handle_load(a, Type.u16()),
  lwzu: (a) => handle_load(a, Type.reg32({ likely_float: false })),
  lbaux: (a) => handle_loadx(a, Type.s8()),
  lbzux: (a) => handle_loadx(a, Type.u8()),
  lhaux: (a) => handle_loadx(a, Type.s16()),
  lhzux: (a) => handle_loadx(a, Type.u16()),
  lwzux: (a) => handle_loadx(a, Type.reg32({ likely_float: false })),
  lfsu: (a) => handle_load(a, Type.f32()),
  lfdu: (a) => handle_load(a, Type.f64()),
  lfsux: (a) => handle_loadx(a, Type.f32()),
  lfdux: (a) => handle_loadx(a, Type.f64()),
};

const instrs_branches = {
  // The `!` indicates that the condition in the register is negated
  beq: "cr0_eq",
  bge: "!cr0_lt",
  bgt: "cr0_gt",
  ble: "!cr0_gt",
  blt: "cr0_lt",
  bne: "!cr0_eq",
  bns: "!cr0_so",
  bso: "cr0_so",
  bdnz: "ctr",
  bdz: "!ctr",
  "bdnz.fictive": "ctr",
  "bdz.fictive": "!ctr",
};
const instrs_no_dest = {
  sync: () => void_fn_op("M2C_SYNC", []),
  isync: () => void_fn_op("M2C_SYNC", []),
  "structcopy.fictive": (a) => void_fn_op("M2C_STRUCT_COPY", [a.reg(0), a.reg(1), a.full_imm(2)]),
};

const intish = () => ({ type: Type.intish() });

const instrs_dest_first_non_load = {
  // Integer arithmetic
  add: (a) => handle_add(a),
  addc: (a) => handle_add(a),
  adde: (a) => carry_add_to(handle_add(a)),
  addze: (a) => carry_add_to(a.reg(1)),
  addi: (a) => handle_addi(a.reg_ref(0), a.reg_ref(1), a.reg(1), a.s16_imm(2), a),
  addic: (a) => handle_addi(a.reg_ref(0), a.reg_ref(1), a.reg(1), a.s16_imm(2), a),
  addis: (a) => handle_addis(a),
  subf: (a) => fold_divmod(BinaryOp.intptr(a.reg(2), "-", a.reg(1))),
  subfc: (a) => fold_divmod(BinaryOp.intptr(a.reg(2), "-", a.reg(1))),
  subfe: (a) => carry_sub_from(fold_divmod(BinaryOp.intptr(a.reg(2), "-", a.reg(1)))),
  subfic: (a) => fold_divmod(BinaryOp.intptr(a.s16_imm(2), "-", a.reg(1))),
  subfze: (a) => carry_sub_from(fold_mul_chains(UnaryOp.sint("-", a.reg(1)))),
  neg: (a) => fold_mul_chains(UnaryOp.sint("-", a.reg(1))),
  divw: (a) => BinaryOp.sint(a.reg(1), "/", a.reg(2)),
  divwu: (a) => BinaryOp.uint(a.reg(1), "/", a.reg(2)),
  mulli: (a) => BinaryOp.int(a.reg(1), "*", a.s16_imm(2)),
  mullw: (a) => BinaryOp.int(a.reg(1), "*", a.reg(2)),
  mulhw: (a) => fold_divmod(BinaryOp.int(a.reg(1), "MULT_HI", a.reg(2))),
  mulhwu: (a) => fold_divmod(BinaryOp.int(a.reg(1), "MULTU_HI", a.reg(2))),
  // Bit arithmetic
  or: (a) => handle_or(a.reg(1), a.reg(2)),
  orc: (a) => handle_or(a.reg(1), new UnaryOp("~", a.reg(2), intish())),
  ori: (a) => handle_or(a.reg(1), a.u16_imm(2)),
  oris: (a) => handle_or(a.reg(1), a.shifted_u16_imm(2)),
  and: (a) => BinaryOp.int(a.reg(1), "&", a.reg(2)),
  andc: (a) => BinaryOp.int(a.reg(1), "&", new UnaryOp("~", a.reg(2), intish())),
  not: (a) => new UnaryOp("~", a.reg(1), intish()),
  nor: (a) => new UnaryOp("~", BinaryOp.int(a.reg(1), "|", a.reg(2)), intish()),
  xor: (a) => BinaryOp.int(a.reg(1), "^", a.reg(2)),
  eqv: (a) => new UnaryOp("~", BinaryOp.int(a.reg(1), "^", a.reg(2)), intish()),
  andi: (a) => BinaryOp.int(a.reg(1), "&", a.u16_imm(2)),
  andis: (a) => BinaryOp.int(a.reg(1), "&", a.shifted_u16_imm(2)),
  xori: (a) => handle_xor(a.reg(1), a.u16_imm(2)),
  xoris: (a) => BinaryOp.int(a.reg(1), "^", a.shifted_u16_imm(2)),
  "cmpnez.fictive": (a) => handle_cmpnez(a.reg(1)),
  "cmpne.fictive": (a) => BinaryOp.icmp(a.reg(1), "!=", a.reg(2)),
  "cmple.fictive": (a) => BinaryOp.scmp(a.reg(1), "<=", a.reg(2)),
  "cmplez.fictive": (a) => BinaryOp.scmp(a.reg(1), "<=", new Literal(0)),
  "cmplt.fictive": (a) => BinaryOp.scmp(a.reg(1), "<", a.reg(2)),
  "cmpgtz.fictive": (a) => BinaryOp.scmp(a.reg(1), ">", new Literal(0)),
  "cmpleu.fictive": (a) => BinaryOp.ucmp(a.reg(1), "<=", a.reg(2)),
  "cmpltu.fictive": (a) => BinaryOp.ucmp(a.reg(1), "<", a.reg(2)),
  rlwimi: (a) => handle_rlwimi(a.reg(0), a.reg(1), a.imm_value(2), a.imm_value(3), a.imm_value(4)),
  rlwinm: (a) => handle_rlwinm(a.reg(1), a.imm_value(2), a.imm_value(3), a.imm_value(4)),
  rlwnm: (a) => handle_rlwnm(a.reg(1), a.reg(2), a.imm_value(3), a.imm_value(4)),
  slw: (a) => fold_mul_chains(BinaryOp.int(a.reg(1), "<<", as_intish(a.reg(2)))),
  srw: (a) => fold_divmod(BinaryOp.ushift(a.reg(1), ">>", a.reg(2))),
  sraw: (a) => fold_divmod(BinaryOp.sshift(a.reg(1), ">>", a.reg(2))),
  srawi: (a) => handle_shift_right(a, { signed: true }),
  extsb: (a) => as_type(a.reg(1), Type.s8(), false),
  extsh: (a) => as_type(a.reg(1), Type.s16(), false),
  cntlzw: (a) => new UnaryOp("CLZ", a.reg(1), intish()),
  // Load Immediate
  li: (a) => a.full_imm(1),
  lis: (a) => load_upper(a),
  // Move from Special Register
  mflr: (a) => a.regs.get(new Register("lr")),
  mfctr: (a) => a.regs.get(new Register("ctr")),
  // Move pseudoinstructions
  mr: (a) => a.reg(1),
  "move.fictive": (a) => a.reg(1),
  // Floating Point Arithmetic
  fadd: (a) => handle_add_double(a),
  fadds: (a) => handle_add_float(a),
  fdiv: (a) => BinaryOp.f64(a.reg(1), "/", a.reg(2)),
  fdivs: (a) => BinaryOp.f32(a.reg(1), "/", a.reg(2)),
  fmul: (a) => BinaryOp.f64(a.reg(1), "*", a.reg(2)),
  fmuls: (a) => BinaryOp.f32(a.reg(1), "*", a.reg(2)),
  fsub: (a) => BinaryOp.f64(a.reg(1), "-", a.reg(2)),
  fsubs: (a) => BinaryOp.f32(a.reg(1), "-", a.reg(2)),
  fneg: (a) => new UnaryOp("-", a.reg(1), { type: Type.floatish() }),
  fmr: (a) => a.reg(1),
  frsp: (a) => handle_convert(a.reg(1), Type.f32(), Type.f64()),
  fctiwz: (a) => handle_convert(a.reg(1), Type.sintish(), Type.floatish()),
  "fctiwz.fictive": (a) => handle_convert(a.reg(1), Type.sintish(), Type.floatish()),
  "cvt.u.d.fictive": (a) => handle_convert(a.reg(1), Type.uintish(), Type.floatish()),
  "cvt.d.i.fictive": (a) => handle_convert(a.reg(1), Type.f64(), Type.sintish()),
  "cvt.d.u.fictive": (a) => handle_convert(a.reg(1), Type.f64(), Type.uintish()),
  "cvt.s.i.fictive": (a) => handle_convert(a.reg(1), Type.f32(), Type.sintish()),
  "cvt.s.u.fictive": (a) => handle_convert(a.reg(1), Type.f32(), Type.uintish()),
  // Floating Point Fused Multiply-{Add,Sub}
  fmadd: (a) => BinaryOp.f64(BinaryOp.f64(a.reg(1), "*", a.reg(2)), "+", a.reg(3)),
  fmadds: (a) => BinaryOp.f32(BinaryOp.f32(a.reg(1), "*", a.reg(2)), "+", a.reg(3)),
  fnmadd: (a) => new UnaryOp("-", BinaryOp.f64(BinaryOp.f64(a.reg(1), "*", a.reg(2)), "+", a.reg(3)), { type: Type.f64() }),
  fnmadds: (a) => new UnaryOp("-", BinaryOp.f32(BinaryOp.f32(a.reg(1), "*", a.reg(2)), "+", a.reg(3)), { type: Type.f32() }),
  fmsub: (a) => BinaryOp.f64(BinaryOp.f64(a.reg(1), "*", a.reg(2)), "-", a.reg(3)),
  fmsubs: (a) => BinaryOp.f32(BinaryOp.f32(a.reg(1), "*", a.reg(2)), "-", a.reg(3)),
  fnmsub: (a) => new UnaryOp("-", BinaryOp.f64(BinaryOp.f64(a.reg(1), "*", a.reg(2)), "-", a.reg(3)), { type: Type.f64() }),
  fnmsubs: (a) => new UnaryOp("-", BinaryOp.f32(BinaryOp.f32(a.reg(1), "*", a.reg(2)), "-", a.reg(3)), { type: Type.f32() }),
  fabs: (a) => fn_op("fabs", [a.reg(1)], Type.floatish()),
  fres: (a) => fn_op("__fres", [a.reg(1)], Type.floatish()),
  frsqrte: (a) => fn_op("__frsqrte", [a.reg(1)], Type.floatish()),
  fsel: (a) => new TernaryOp(BinaryOp.fcmp(a.reg(1), ">=", new Literal(0)), a.reg(2), a.reg(3), { type: Type.floatish() }),
};
const instrs_destination_first = { ...instrs_dest_first_non_load, ...instrs_load };

const instrs_ppc_compare = {
  // Integer (signed/unsigned)
  cmpw: (a, op) => BinaryOp.sintptr_cmp(a.reg(1), op, a.reg(2)),
  cmpwi: (a, op) => BinaryOp.sintptr_cmp(a.reg(1), op, a.s16_imm(2)),
  cmplw: (a, op) => BinaryOp.uintptr_cmp(a.reg(1), op, a.reg(2)),
  cmplwi: (a, op) => BinaryOp.uintptr_cmp(a.reg(1), op, a.s16_imm(2)),
  // Floating point
  fcmpo: (a, op) => BinaryOp.fcmp(a.reg(1), op, a.reg(2)),
  fcmpu: (a, op) => BinaryOp.fcmp(a.reg(1), op, a.reg(2)),
  "fcmpo.lte.fictive": (a, op) => BinaryOp.fcmp(a.reg(1), op !== "==" ? op : "<=", a.reg(2)),
  "fcmpo.gte.fictive": (a, op) => BinaryOp.fcmp(a.reg(1), op !== "==" ? op : ">=", a.reg(2)),
};

const PPC_ATTRS = {
  arch: Target.ArchEnum.PPC,
  re_comment: String.raw`[#;].*`,
  supports_dollar_regs: true,
  home_space_size: 8,
  stack_pointer_reg,
  frame_pointer_regs: r(["r30"]),
  return_address_reg: new Register("lr"),
  base_return_regs: [
    [new Register("r3"), false],
    [new Register("f1"), true],
  ],
  all_return_regs: r(["f1", "r3", "r4"]),
  argument_regs,
  simple_temp_regs,
  temp_regs,
  saved_regs,
  all_regs,
  aliased_regs: {},
  INSTRS_R0_AS_ZERO,
  instrs_ignore,
  instrs_store,
  instrs_store_update,
  instrs_load,
  instrs_load_update,
  instrs_branches,
  instrs_no_dest,
  instrs_dest_first_non_load,
  instrs_destination_first,
  instrs_ppc_compare,
};

export class PpcArch extends Arch {
  constructor() {
    super();
    Object.assign(this, PPC_ATTRS);
    this.ir_patterns = [
      new LoopStructCopySetupPattern(),
      new FloatishToSintIrPattern(),
      new SintToDoubleIrPattern(),
      new UintToDoubleIrPattern(),
      new SintToFloatIrPattern(),
      new UintToFloatIrPattern(),
      new CmpnezPattern1(),
      new CmpnezPattern2(),
      new CmplezPattern(),
      new CmpgtzPattern(),
      new CmpnePattern(),
      new CmplePattern(),
      new CmpltPattern1(),
      new CmpltPattern2(),
      new CmpleuPattern1(),
      new CmpleuPattern2(),
      new CmpltuPattern1(),
      new CmpltuPattern2(),
    ];
    this.asm_patterns = [
      new FcmpoCrorPattern(),
      new MfcrPattern(),
      new TailCallPattern(),
      new SaveRestoreRegsFnPattern(),
      new LoopStructCopyPattern(),
      new BranchCtrPattern(),
      new FloatishToUintPattern(),
      new StructCopyPattern(),
    ];
  }

  missing_return() {
    return [this.parse("blr", [], InstructionMeta.missing())];
  }

  normalize_instruction(instr, asm_state) {
    // Remove +/- suffix, which indicates branch-(un)likely and can be ignored
    if (instr.mnemonic.startsWith("b") && (instr.mnemonic.endsWith("+") || instr.mnemonic.endsWith("-"))) {
      return this.normalize_instruction(new AsmInstruction(instr.mnemonic.slice(0, -1), instr.args), asm_state);
    }

    const args = instr.args;
    const base_mnemonic = rstrip(instr.mnemonic, ".");
    const dot = instr.mnemonic.slice(base_mnemonic.length);

    const sub = (a, b) => (a instanceof AsmLiteral && b instanceof AsmLiteral ? new AsmLiteral(a.value - b.value) : new BinOp("-", a, b));
    const add = (a, b) => (a instanceof AsmLiteral && b instanceof AsmLiteral ? new AsmLiteral(a.value + b.value) : new BinOp("+", a, b));
    const make_dotted = (mn, a) => new AsmInstruction(mn + dot, a);
    const lit = (v) => new AsmLiteral(v);

    const r0_index = has(this.INSTRS_R0_AS_ZERO, instr.mnemonic) ? this.INSTRS_R0_AS_ZERO[instr.mnemonic] : null;
    if (r0_index !== null && args.length > r0_index) {
      let r0_arg = args[r0_index];
      if (r0_arg === new Register("r0")) r0_arg = new Register("zero");
      else if (r0_arg instanceof AsmAddressMode && r0_arg.base === new Register("r0")) r0_arg = new AsmAddressMode(new Register("zero"), r0_arg.addend, r0_arg.writeback);
      if (r0_arg !== args[r0_index]) {
        const new_args = [...args];
        new_args[r0_index] = r0_arg;
        return this.normalize_instruction(new AsmInstruction(instr.mnemonic, new_args), asm_state);
      }
    }
    if (args.length === 4) {
      if (base_mnemonic === "extlwi") return make_dotted("rlwinm", [...args.slice(0, 2), args[3], lit(0), sub(args[2], lit(1))]);
      if (base_mnemonic === "extrwi") return make_dotted("rlwinm", [...args.slice(0, 2), add(args[2], args[3]), sub(lit(32), args[2]), lit(31)]);
      if (base_mnemonic === "clrlslwi") {
        const b = args[2];
        const n = args[3];
        return make_dotted("rlwinm", [...args.slice(0, 2), n, sub(b, n), sub(lit(31), n)]);
      }
    }
    if (args.length === 3) {
      if (
        instr.mnemonic === "addi" &&
        args[2] instanceof Macro &&
        (args[1] === new Register("r2") || args[1] === new Register("r13")) &&
        (args[2].macro_name === "sda2" || args[2].macro_name === "sda21")
      ) {
        return new AsmInstruction("li", [args[0], args[2].argument]);
      }
      if (["subi", "subis", "subic"].includes(base_mnemonic) && args[2] instanceof AsmLiteral) {
        const mn = "add" + base_mnemonic.slice(3);
        const negated = new AsmLiteral(-args[2].value);
        return this.normalize_instruction(make_dotted(mn, [...args.slice(0, 2), negated]), asm_state);
      }
      if (["sub", "subo", "subc", "subco"].includes(base_mnemonic)) {
        const mn = "subf" + base_mnemonic.slice(3);
        return make_dotted(mn, [args[0], args[2], args[1]]);
      }
      if (base_mnemonic === "rotlwi") return make_dotted("rlwinm", [...args.slice(0, 2), args[2], lit(0), lit(31)]);
      if (base_mnemonic === "rotrwi") return make_dotted("rlwinm", [...args.slice(0, 2), sub(lit(32), args[2]), lit(0), lit(31)]);
      if (base_mnemonic === "slwi") return make_dotted("rlwinm", [...args.slice(0, 2), args[2], lit(0), sub(lit(31), args[2])]);
      if (base_mnemonic === "srwi") return make_dotted("rlwinm", [...args.slice(0, 2), sub(lit(32), args[2]), args[2], lit(31)]);
      if (base_mnemonic === "clrlwi") return make_dotted("rlwinm", [...args.slice(0, 2), lit(0), args[2], lit(31)]);
      if (base_mnemonic === "clrrwi") return make_dotted("rlwinm", [...args.slice(0, 2), lit(0), lit(0), sub(lit(31), args[2])]);
    }
    if (args.length === 2) {
      if (instr.mnemonic === "lis" && args[1] instanceof AsmLiteral) {
        const val = lit(band(args[1].value, 0xffff) * 0x10000);
        return new AsmInstruction("li", [args[0], val]);
      }
      if (instr.mnemonic === "lis" && args[1] instanceof Macro && args[1].macro_name === "ha" && args[1].argument instanceof AsmLiteral) {
        let value = args[1].argument.value;
        if (band(value, 0x8000)) value += 0x10000;
        const val = lit(band(value, 0xffff0000));
        return new AsmInstruction("li", [args[0], val]);
      }
      if (instr.mnemonic.startsWith("cmp") && !instr.mnemonic.includes("fictive")) {
        const cr0 = new Register("cr0");
        return new AsmInstruction(instr.mnemonic, [cr0, ...instr.args]);
      }
    }
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
    let eval_fn = null;

    const instr_str = String(new AsmInstruction(mnemonic, args));

    const cr0_bits = r(["cr0_lt", "cr0_gt", "cr0_eq", "cr0_so"]);

    const memory_sizes = { b: 1, h: 2, w: 4, fs: 4, fd: 8 };
    let psq_imms = 0;
    const size_key = rstrip(lstrip(mnemonic, "stl"), "azux");
    let size = has(memory_sizes, size_key) ? memory_sizes[size_key] : null;
    if (mnemonic.startsWith("psq_l") || mnemonic.startsWith("psq_st")) {
      psq_imms = 2;
      size = 8;
    }

    const make_memory_access = (arg, size) => {
      pyassert(size !== null);
      if (arg instanceof AsmAddressMode && arg.base === cls.stack_pointer_reg) {
        const loc = StackLocation.from_offset(arg.addend);
        if (loc === null) return [];
        else if (size === 8) return [loc, new StackLocation(loc.offset + 4, loc.symbolic_offset)];
        else {
          pyassert(size <= 4);
          return [loc];
        }
      }
      return [];
    };

    const unreachable_eval = () => {
      throw new DecompFailure(`Instruction ${instr_str} should be replaced before eval`);
    };

    const mn_nodot = rstrip(mnemonic, ".");

    if (mnemonic === "blr") {
      // Return
      pyassert(args.length === 0);
      inputs = [new Register("lr")];
      is_return = true;
    } else if (["beqlr", "bgelr", "bgtlr", "blelr", "bltlr", "bnelr", "bnglr", "bnllr", "bnslr", "bsolr"].includes(mnemonic)) {
      // Conditional return
      pyassert(args.length <= 1);
      inputs = [...cr0_bits, new Register("lr")];
      is_return = true;
      is_conditional = true;
      eval_fn = unreachable_eval;
    } else if (mnemonic === "bctr") {
      // Jump table (switch)
      pyassert(args.length === 0);
      inputs = [new Register("ctr")];
      jump_target = new Register("ctr");
      is_conditional = true;
      eval_fn = (s, a) => s.set_switch_expr(a.regs.get(new Register("ctr")));
    } else if (mnemonic === "bl") {
      // Function call to label
      pyassert(args.length === 1);
      inputs = [...cls.argument_regs];
      outputs = [...cls.all_return_regs];
      clobbers = [...cls.temp_regs];
      function_target = args[0];
      eval_fn = (s, a) => s.make_function_call(a.sym_imm(0), outputs);
    } else if (mnemonic === "bctrl" || mnemonic === "blrl") {
      // Function call to pointer in special reg ($ctr or $lr)
      pyassert(args.length === 0);
      const reg = new Register(mnemonic.slice(1, -1));
      inputs = [...cls.argument_regs];
      inputs.push(reg);
      outputs = [...cls.all_return_regs];
      clobbers = [...cls.temp_regs];
      function_target = reg;
      eval_fn = (s, a) => s.make_function_call(a.regs.get(reg), outputs);
    } else if (mnemonic === "b") {
      // Unconditional jump
      pyassert(args.length === 1);
      jump_target = get_jump_target(args[0]);
    } else if (has(cls.instrs_branches, mnemonic)) {
      // Normal branch
      pyassert(1 <= args.length && args.length <= 2);
      const raw_name = cls.instrs_branches[mnemonic];
      const negated = raw_name.startsWith("!");
      const reg_name = lstrip(raw_name, "!");
      inputs = [new Register(reg_name)];
      jump_target = get_jump_target(args[args.length - 1]);
      is_conditional = true;
      eval_fn = (s, a) => {
        let cond = a.cmp_reg(reg_name);
        if (negated) cond = cond.negated();
        s.set_branch_condition(cond);
      };
    } else if (has(cls.instrs_store, mnemonic)) {
      pyassert(args[0] instanceof Register && size !== null);
      is_store = true;
      if (mnemonic.endsWith("x")) {
        pyassert(args.length === 3 + psq_imms && args[1] instanceof Register && args[2] instanceof Register);
        inputs = [args[0], args[1], args[2]];
      } else {
        pyassert(args.length === 2 + psq_imms && args[1] instanceof AsmAddressMode);
        outputs = make_memory_access(args[1], size);
        inputs = new Array(outputs.length || 1).fill(args[0]);
        inputs.push(args[1].base);
      }
      eval_fn = (s, a) => {
        const store = cls.instrs_store[mnemonic](a);
        if (store !== null) s.store_memory(store, a.reg_ref(0));
      };
    } else if (has(cls.instrs_store_update, mnemonic)) {
      pyassert(args[0] instanceof Register && size !== null);
      is_store = true;
      if (mnemonic.endsWith("x")) {
        pyassert(args.length === 3 + psq_imms && args[1] instanceof Register && args[2] instanceof Register);
        inputs = [args[0], args[1], args[2]];
        outputs = [args[1]];
        eval_fn = (s, a) => {
          const store = cls.instrs_store_update[mnemonic](a);
          // Update the register in the second argument
          const update = a.reg_ref(1);
          const offset = a.reg(2);
          s.set_reg(update, add_imm(update, a.regs.get(update), offset, a));
          if (store !== null) s.store_memory(store, a.reg_ref(0));
        };
      } else {
        pyassert(args.length === 2 + psq_imms && args[1] instanceof AsmAddressMode);
        inputs = [args[0], args[1].base];
        outputs = [...make_memory_access(args[1], size), args[1].base];
        eval_fn = (s, a) => {
          const store = cls.instrs_store_update[mnemonic](a);
          // Update the register in the second argument
          const update = a.memory_ref(1);
          if (!(update instanceof AddressMode)) throw new DecompFailure(`Unhandled store-and-update arg in ${instr_str}: ${repr(update)}`);
          s.set_reg(update.base, add_imm(update.base, a.regs.get(update.base), new Literal(update.offset), a));
          if (store !== null) s.store_memory(store, a.reg_ref(0));
        };
      }
    } else if (has(cls.instrs_load, mnemonic)) {
      pyassert(args[0] instanceof Register && size !== null);
      if (mnemonic.endsWith("x")) {
        pyassert(args.length === 3 + psq_imms && args[1] instanceof Register && args[2] instanceof Register);
        inputs = [args[1], args[2]];
      } else {
        pyassert(args.length === 2 + psq_imms);
        if (args[1] instanceof AsmAddressMode) inputs = [...make_memory_access(args[1], size), args[1].base];
      }
      is_load = true;
      outputs = [args[0]];
      eval_fn = (s, a) => s.set_reg(a.reg_ref(0), cls.instrs_load[mnemonic](a));
    } else if (has(cls.instrs_load_update, mnemonic)) {
      pyassert(args[0] instanceof Register && size !== null);
      is_load = true;
      if (mnemonic.endsWith("x")) {
        pyassert(args.length === 3 + psq_imms && args[1] instanceof Register && args[2] instanceof Register);
        inputs = [args[1], args[2]];
        outputs = [args[0], args[1]];
        eval_fn = (s, a) => {
          const target = a.reg_ref(0);
          const val = cls.instrs_load_update[mnemonic](a);
          s.set_reg(target, val);
          // In `rD, rA, rB`, update `rA = rA + rB`
          const update_reg = a.reg_ref(1);
          const offset = a.reg(2);
          if (update_reg === target) throw new DecompFailure(`Invalid instruction, rA and rD must be different in ${instr_str}`);
          s.set_reg(update_reg, add_imm(update_reg, a.regs.get(update_reg), offset, a));
        };
      } else {
        pyassert(args.length === 2 + psq_imms && args[1] instanceof AsmAddressMode);
        inputs = [...make_memory_access(args[1], size), args[1].base];
        outputs = [args[0], args[1].base];
        eval_fn = (s, a) => {
          const target = a.reg_ref(0);
          const val = cls.instrs_load_update[mnemonic](a);
          s.set_reg(target, val);
          // In `rD, rA(N)`, update `rA = rA + N`
          const update = a.memory_ref(1);
          if (!(update instanceof AddressMode)) throw new DecompFailure(`Unhandled load-and-update arg in ${instr_str}: ${repr(update)}`);
          const update_reg = update.base;
          const offset = new Literal(update.offset);
          if (update_reg === target) throw new DecompFailure(`Invalid instruction, rA and rD must be different in ${instr_str}`);
          s.set_reg(update_reg, add_imm(update_reg, a.regs.get(update_reg), offset, a));
        };
      }
    } else if (mnemonic === "stmw" || mnemonic === "lmw") {
      pyassert(args.length === 2 && args[0] instanceof Register && args[1] instanceof AsmAddressMode && args[0].register_name[0] === "r");
      is_store = mnemonic === "stmw";
      let index = int_(args[0].register_name.slice(1));
      let offset = args[1].addend_as_literal();
      while (index <= 31) {
        const reg = new Register(`r${index}`);
        const mem = make_memory_access(new AsmAddressMode(args[1].base, new AsmLiteral(offset), null), 4);
        if (mnemonic === "stmw") {
          inputs.push(reg);
          outputs.push(...mem);
        } else {
          outputs.push(reg);
          inputs.push(...mem);
        }
        index += 1;
        offset += 4;
      }
      inputs.push(args[1].base);
      // TODO: These are only supported in function prologues/epilogues
      eval_fn = null;
    } else if (has(cls.instrs_no_dest, mnemonic)) {
      pyassert(!args.some((x) => x instanceof AsmAddressMode));
      inputs = args.filter((x) => x instanceof Register);
      eval_fn = (s, a) => s.write_statement(cls.instrs_no_dest[mnemonic](a));
    } else if (has(cls.instrs_destination_first, mn_nodot)) {
      pyassert(args[0] instanceof Register);
      outputs = [args[0]];
      if (mnemonic === "mflr") {
        pyassert(args.length === 1);
        inputs = [new Register("lr")];
      } else if (mnemonic === "mfctr") {
        pyassert(args.length === 1);
        inputs = [new Register("ctr")];
      } else if (mn_nodot === "rlwimi") {
        const notRegAm = (x) => !(x instanceof Register || x instanceof AsmAddressMode);
        pyassert(args.length === 5 && args[1] instanceof Register && notRegAm(args[2]) && notRegAm(args[3]) && notRegAm(args[4]));
        inputs = [args[0], args[1]];
      } else if (mnemonic.startsWith("cvt.")) {
        pyassert(args[1] instanceof Register);
        if (args.length === 2) inputs = [args[1]];
        else {
          pyassert(args[2] instanceof AsmAddressMode);
          size = 8;
          inputs = [...make_memory_access(args[2], size), args[1], args[2].base];
        }
      } else {
        pyassert(!args.some((x) => x instanceof AsmAddressMode));
        inputs = args.slice(1).filter((x) => x instanceof Register);
      }
      if (["adde", "addme", "addze", "subfe", "subfze"].includes(mn_nodot)) inputs.push(new Register("carry"));
      if (["addc", "addic", "subfc", "subfic"].includes(mn_nodot)) outputs.push(new Register("carry"));
      if (mnemonic.endsWith(".")) outputs.push(...cr0_bits);

      eval_fn = (s, a) => {
        const target = a.reg_ref(0);
        const val = cls.instrs_destination_first[mn_nodot](a);
        const target_val = s.set_reg(target, val);
        // Instructions ending in `.` update the condition reg
        if (mnemonic.endsWith(".")) {
          s.set_reg(new Register("cr0_eq"), BinaryOp.icmp(target_val, "==", new Literal(0, { type: target_val.type })));
          // Use manual casts for cr0_gt/cr0_lt so that the type of target_val is not modified
          // until the resulting bit is .use()'d.
          const target_s32 = new Cast(target_val, { reinterpret: true, silent: true, type: Type.s32() });
          s.set_reg(new Register("cr0_gt"), new BinaryOp(target_s32, ">", new Literal(0), { type: Type.s32() }));
          s.set_reg(new Register("cr0_lt"), new BinaryOp(target_s32, "<", new Literal(0), { type: Type.s32() }));
          s.set_reg(new Register("cr0_so"), fn_op("M2C_OVERFLOW", [target_val], Type.s32()));
        }
        if (outputs.includes(new Register("carry"))) {
          s.set_reg(new Register("carry"), fn_op("M2C_CARRY", [target_val], Type.s32()));
        }
      };
    } else if (mnemonic === "mtctr" || mnemonic === "mtlr") {
      pyassert(args.length === 1 && args[0] instanceof Register);
      const dest_reg = new Register(mnemonic.slice(2));
      inputs = [args[0]];
      outputs = [dest_reg];
      eval_fn = (s, a) => s.set_reg(dest_reg, a.reg(0));
    } else if (mnemonic === "loopstructcopy.fictive") {
      pyassert(args.length === 9);
      for (let k = 0; k < 5; k++) pyassert(args[k] instanceof Register);
      const width = args[5];
      const bias = args[6];
      const adj = args[7];
      const tail_size = args[8];
      inputs = [args[2], args[3], args[4]];
      outputs = [args[0], args[1]];
      eval_fn = (s, a) => {
        pyassert(width instanceof AsmLiteral);
        pyassert(bias instanceof AsmLiteral);
        pyassert(adj instanceof AsmLiteral);
        pyassert(tail_size instanceof AsmLiteral);
        const tail = tail_size.value;
        const offset = bias.value - adj.value;
        let dst = a.reg(2);
        let dst_out = dst;
        let src = a.reg(3);
        let src_out = src;
        if (offset !== 0) {
          dst = BinaryOp.int(dst, "+", new Literal(offset));
          src = BinaryOp.int(src, "+", new Literal(offset));
        }
        if (adj.value !== 0) {
          dst_out = BinaryOp.int(dst_out, "-", new Literal(adj.value));
          src_out = BinaryOp.int(src_out, "-", new Literal(adj.value));
        }
        const count = a.reg(4);
        let incr_size, copy_size;
        if (count instanceof Literal) {
          incr_size = new Literal(count.value * width.value);
          copy_size = new Literal(count.value * width.value + tail);
        } else {
          incr_size = BinaryOp.int(count, "*", new Literal(width.value));
          copy_size = incr_size;
          if (tail !== 0) copy_size = BinaryOp.int(copy_size, "+", new Literal(tail));
        }
        s.write_statement(void_fn_op("M2C_STRUCT_COPY", [dst, src, copy_size]));
        dst_out = handle_add_real(dst_out, incr_size, a);
        src_out = handle_add_real(src_out, incr_size, a);
        s.set_reg_real(a.reg_ref(0), dst_out, { function_return: true });
        s.set_reg_real(a.reg_ref(1), src_out, { function_return: true });
      };
    } else if (has(cls.instrs_ppc_compare, mnemonic)) {
      pyassert(args.length === 3 && args[1] instanceof Register);
      inputs = args.slice(1).filter((x) => x instanceof Register);
      outputs = [...cr0_bits];
      eval_fn = (s, a) => {
        const base_reg = a.reg_ref(0);
        if (base_reg !== new Register("cr0")) {
          const error = `"${instr_str}" is not supported, the first arg is not $cr0`;
          s.write_statement(error_stmt(error));
          return;
        }
        s.set_reg(new Register("cr0_eq"), cls.instrs_ppc_compare[mnemonic](a, "=="));
        s.set_reg(new Register("cr0_gt"), cls.instrs_ppc_compare[mnemonic](a, ">"));
        s.set_reg(new Register("cr0_lt"), cls.instrs_ppc_compare[mnemonic](a, "<"));
        s.set_reg(new Register("cr0_so"), new Literal(0));
      };
    } else if (cls.instrs_ignore.has(mnemonic)) {
      // pass
    } else {
      // If the mnemonic is unsupported, guess if it is destination-first
      let maybe_dest_first;
      if (args.length && args[0] instanceof Register) {
        inputs = args.slice(1).filter((x) => x instanceof Register);
        outputs = [args[0]];
        maybe_dest_first = true;
      } else maybe_dest_first = false;
      if (mnemonic.endsWith(".")) outputs.push(...cr0_bits);

      eval_fn = (s, a) => {
        const error = new ErrorExpr(`unknown instruction: ${instr_str}`);
        if (mnemonic.endsWith(".")) {
          // Unimplemented instructions that modify CR0
          s.set_reg(new Register("cr0_eq"), error);
          s.set_reg(new Register("cr0_gt"), error);
          s.set_reg(new Register("cr0_lt"), error);
          s.set_reg(new Register("cr0_so"), error);
        }
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
      is_conditional,
      is_return,
      is_load,
      is_store,
      eval_fn,
    });
  }

  arg_name(loc) {
    if (loc.offset !== null) return `arg_sp${format_hex(loc.offset)}`;
    pyassert(loc.reg !== null);
    const reg_num = int_(loc.reg.register_name.slice(1));
    if (loc.reg.register_name.startsWith("r")) return `arg${reg_num - 3}`;
    return `farg${reg_num - 1}`;
  }

  // Duplicated by MipseeArch.function_abi
  function_abi(fn_sig, likely_regs, { for_call }) {
    void for_call;
    const known_slots = [];
    const candidate_slots = [];

    // $rX & $fX regs can be interspersed in function args, unlike in the MIPS O32 ABI
    const intptr_regs = argument_regs.filter((x) => x.register_name[0] !== "f");
    const float_regs = argument_regs.filter((x) => x.register_name[0] === "f");

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
          // Stack variable
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
      argument_regs.forEach((reg, ind) => {
        if (reg.register_name[0] !== "f") candidate_slots.push(new AbiArgSlot(new ArgLoc(null, ind, reg), Type.intptr()));
        else candidate_slots.push(new AbiArgSlot(new ArgLoc(null, ind, reg), Type.floatish()));
      });
    }

    const valid_extra_regs = new Set(known_slots.filter((slot) => slot.loc.reg !== null).map((slot) => slot.loc.reg));
    const possible_slots = [];
    for (const slot of candidate_slots) {
      const reg = slot.loc.reg;
      if (reg === null || !likely_regs.has(reg)) continue;

      // Don't pass this register if lower numbered ones are undefined.
      if (pyeq(slot, candidate_slots[0])) {
        // For varargs, a subset of regs may be used.
      } else {
        // Only r3-r10/f1-f13 can be used for arguments
        const regname = reg.register_name;
        const prev_reg = new Register(`${regname[0]}${int_(regname.slice(1)) - 1}`);
        if (argument_regs.includes(prev_reg) && !valid_extra_regs.has(prev_reg)) continue;
      }

      valid_extra_regs.add(reg);

      if (!likely_regs.get(reg)) continue;

      possible_slots.push(slot);
    }

    return new Abi({ arg_slots: known_slots, possible_slots });
  }

  function_return(expr) {
    return new Map([
      [new Register("f1"), new Cast(expr, { reinterpret: true, silent: true, type: Type.floatish() })],
      [new Register("r3"), new Cast(expr, { reinterpret: true, silent: true, type: Type.intptr() })],
      [new Register("r4"), as_u32(new Cast(expr, { reinterpret: true, silent: false, type: Type.u64() }))],
    ]);
  }
}
