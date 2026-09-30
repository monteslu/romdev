// Port of m2c/evaluate.py
// Functions for evaluating assembly instructions and building Expression trees.
import { AsmSymbolicData } from "./asm_file.js";
import { AsmAddressMode, AsmGlobalSymbol, AsmLiteral, BinOp, Register } from "./asm_instruction.js";
import { DecompFailure } from "./error.js";
import { Target } from "./options.js";
import {
  AddressMode,
  AddressOf,
  ArrayAccess,
  BinaryOp,
  CarryBit,
  Cast,
  Condition,
  ErrorExpr,
  ExprCondition,
  ExprStmt,
  Expression,
  FuncCall,
  GlobalSymbol,
  Literal,
  Load3Bytes,
  LocalVar,
  Lwl,
  StoreStmt,
  StructAccess,
  TernaryOp,
  UnalignedLoad,
  UnaryOp,
  as_intish,
  as_intptr,
  as_type,
  early_unwrap,
  early_unwrap_ints,
  var_for_expr,
} from "./translate.js";
import { FunctionParam, FunctionSignature, StructDeclaration, Type } from "./types.js";
import { normint, band, bit_length, bnot, bor, bxor, dcreplace, floordiv, format, pyassert, pyeq, pymod, pyround, shl, shr } from "./py.js";

export function error_stmt(msg) {
  return new ExprStmt(new ErrorExpr(msg));
}

export function deref(arg, regs, stack_info, { size, store = false }) {
  let offset;
  let v;
  if (arg instanceof Expression) {
    offset = 0;
    v = arg;
  } else if (arg instanceof AddressMode) {
    offset = arg.offset;
    if (stack_info.is_stack_reg(arg.base)) return stack_info.get_stack_var(offset, { store });
    v = regs.get(arg.base);
  } else {
    offset = arg.offset;
    v = stack_info.global_info.address_of_gsym(arg.sym.symbol_name);
  }

  if (v instanceof Literal && pymod(v.value, 2 ** 16) === 0) {
    v = new Literal(v.value + offset, { type: v.type });
    offset = 0;
  }

  let uw_var = early_unwrap(v);
  if (uw_var instanceof BinaryOp && uw_var.op === "+") {
    for (const [base, addend] of [
      [uw_var.left, uw_var.right],
      [uw_var.right, uw_var.left],
    ]) {
      const arch = stack_info.global_info.arch;
      if (addend instanceof Literal && (arch.is_likely_partial_offset(addend.value) || (offset === 0 && addend.value >= 0))) {
        offset += addend.value;
        v = base;
        uw_var = early_unwrap(v);
        break;
      }
    }
  }
  if (uw_var instanceof AddressOf && uw_var.expr instanceof StructAccess) {
    const base = uw_var.expr.struct_var;
    const iaddend = uw_var.expr.offset;
    const target = stack_info.global_info.target;
    const arch = stack_info.global_info.arch;
    if (arch.is_likely_partial_offset(iaddend) || target.compiler !== Target.CompilerEnum.IDO) {
      offset += iaddend;
      v = base;
      uw_var = early_unwrap(v);
    }
  }

  v.type.unify(Type.ptr());
  stack_info.record_struct_access(v, offset);
  let type = stack_info.unique_type_for("struct", [uw_var, offset], Type.any());

  if (offset >= 0x200000) {
    v = BinaryOp.int(new Literal(offset), "+", v);
    offset = 0;
  }

  const array_expr = array_access_from_add(v, offset, stack_info, { target_size: size, ptr: false });
  if (array_expr !== null) return array_expr;
  let [field_path, field_type] = v.type.get_deref_field(offset, { target_size: size });
  if (field_path !== null) {
    field_type.unify(type);
    type = field_type;
  } else field_path = null;

  return new StructAccess({ struct_var: v, offset, target_size: size, field_path, stack_info, type });
}

export function condition_from_expr(expr) {
  const uw_expr = early_unwrap(expr);
  if (uw_expr instanceof Condition && !(uw_expr instanceof BinaryOp && !uw_expr.is_comparison())) return uw_expr;
  return new ExprCondition(expr, { type: expr.type });
}

export function imm_add_32(expr) {
  if (expr instanceof Literal) return as_intish(new Literal(expr.value + 32));
  return BinaryOp.int(expr, "+", new Literal(32));
}

export function fn_op(fn_name, args, type) {
  const fn_sig = new FunctionSignature({
    return_type: type,
    params: args.map((arg) => new FunctionParam({ type: arg.type })),
    params_known: true,
    is_variadic: false,
  });
  return new FuncCall({ function: new GlobalSymbol({ c_symbol_name: fn_name, type: Type.function(fn_sig) }), args, type });
}

export function void_fn_op(fn_name, args) {
  const fn_call = fn_op(fn_name, args, Type.any_reg());
  fn_call.use();
  return new ExprStmt(fn_call);
}

export function load_upper(args) {
  pyassert(!(args.raw_arg(1) instanceof Literal), "normalize_instruction should convert lui/lis <literal> to li");
  const ref = args.hi_imm(1);
  const stack_info = args.stack_info;
  const source = stack_info.global_info.address_of_gsym(ref.sym.symbol_name);
  const imm = new Literal(ref.offset);
  return handle_addi_real(args.reg_ref(0), null, source, imm, args);
}

export function handle_convert(expr, dest_type, source_type) {
  const silent = dest_type.data().kind !== source_type.data().kind;
  expr.type.unify(source_type);
  return new Cast({ expr, type: dest_type, silent, reinterpret: false });
}

export function handle_la(args) {
  const output_reg = args.reg_ref(0);
  const target = args.memory_ref(1);
  const stack_info = args.stack_info;
  if (target instanceof AddressMode) return handle_addi(output_reg, target.base, args.regs.get(target.base), new Literal(target.offset), args);
  const sym = stack_info.global_info.address_of_gsym(target.sym.symbol_name);
  return add_imm(output_reg, sym, new Literal(target.offset), args);
}

export function handle_lw(args) {
  const ref = args.maybe_got_imm(1);
  if (ref !== null) {
    const sym = args.stack_info.global_info.address_of_gsym(ref.sym.symbol_name);
    return add_imm(args.reg_ref(0), sym, new Literal(ref.offset), args);
  }
  return handle_load(args, Type.reg32({ likely_float: false }));
}

export function handle_or(left, right, { is_arm = false } = {}) {
  if (pyeq(left, right)) return left;
  if (left instanceof Literal && left.value === 0) return right;
  if (right instanceof Literal && right.value === 0) return left;
  if (left instanceof Literal && right instanceof Literal) {
    if ((band(left.value, 0xffff) === 0 && band(right.value, 0xffff0000) === 0) || (band(right.value, 0xffff) === 0 && band(left.value, 0xffff0000) === 0)) {
      return new Literal({ value: bor(left.value, right.value) });
    }
  }
  const uw_left = early_unwrap(left);
  if (
    is_arm &&
    uw_left instanceof BinaryOp &&
    uw_left.op === "|" &&
    uw_left.right instanceof Literal &&
    right instanceof Literal &&
    (pymod(uw_left.right.value, 0x100) === 0 || pymod(right.value, 0x100) === 0)
  ) {
    const imm = bor(uw_left.right.value, right.value);
    return BinaryOp.int(uw_left.left, "|", new Literal(imm));
  }
  return BinaryOp.int(left, "|", right);
}

export function handle_bitinv(expr) {
  if (expr instanceof Literal) return s32_literal(bnot(expr.value));
  return UnaryOp.int("~", expr);
}

export function handle_sltu(args) {
  const right = args.reg(2);
  if (args.reg_ref(1) === new Register("zero")) {
    const uw_right = early_unwrap(right);
    if (uw_right instanceof BinaryOp && uw_right.op === "^") return BinaryOp.icmp(uw_right.left, "!=", uw_right.right);
    return BinaryOp.icmp(right, "!=", new Literal(0));
  }
  const left = args.reg(1);
  return BinaryOp.ucmp(left, "<", right);
}

export function handle_sltiu(args) {
  const left = args.reg(1);
  let right = args.s16_imm(2);
  if (right instanceof Literal) {
    const value = band(right.value, 0xffffffff);
    if (value === 1) {
      const uw_left = early_unwrap(left);
      if (uw_left instanceof BinaryOp && uw_left.op === "^") return BinaryOp.icmp(uw_left.left, "==", uw_left.right);
      return BinaryOp.icmp(left, "==", new Literal(0));
    } else right = new Literal(value);
  }
  return BinaryOp.ucmp(left, "<", right);
}

export function handle_xor(left, right) {
  if (right instanceof Literal && right.value === 1) {
    const uw_left = early_unwrap(left);
    if (uw_left instanceof BinaryOp && uw_left.is_comparison()) return uw_left.negated();
  }
  return BinaryOp.int(left, "^", right);
}

export function handle_addi_mips(args) {
  const output_reg = args.reg_ref(0);
  const source_reg = args.reg_ref(1);
  const ref = args.maybe_gprel_imm(2);
  if (ref !== null && source_reg === new Register("gp")) {
    const sym = args.stack_info.global_info.address_of_gsym(ref.sym.symbol_name);
    return add_imm(output_reg, sym, new Literal(ref.offset), args);
  }
  return handle_addi(output_reg, source_reg, args.reg(1), args.s16_imm(2), args);
}

export function handle_addi(output_reg, source_reg, source, imm, args) {
  if (pyeq(imm, new Literal(0))) return source;
  const arm = args.stack_info.global_info.arch.arch === Target.ArchEnum.ARM;
  const uw_source = early_unwrap(source);
  if (
    uw_source instanceof BinaryOp &&
    uw_source.op === "+" &&
    uw_source.right instanceof Literal &&
    imm instanceof Literal &&
    (pymod(uw_source.right.value, 0x10000) === 0 || (arm && pymod(imm.value, 0x100) === 0))
  ) {
    return add_imm(output_reg, uw_source.left, new Literal(imm.value + uw_source.right.value), args);
  }
  return handle_addi_real(output_reg, source_reg, source, imm, args);
}

export function handle_sub_arm(args) {
  const stack_info = args.stack_info;
  const output_reg = args.reg_ref(0);
  const source_reg = args.reg_ref(1);
  const lhs = args.reg(1);
  const rhs = args.reg_or_imm(2);
  if (rhs instanceof Literal && stack_info.is_stack_reg(source_reg) && stack_info.is_stack_reg(output_reg)) return lhs;
  return handle_sub(lhs, rhs);
}

export function handle_sub(lhs, rhs) {
  if (lhs instanceof Literal && rhs instanceof Literal) return s32_literal(lhs.value - rhs.value);
  if (pyeq(rhs, new Literal(0))) return lhs;
  return fold_mul_chains(fold_divmod(BinaryOp.intptr(lhs, "-", rhs)));
}

export function handle_addis(args) {
  const source_reg = args.reg_ref(1);
  const source = args.reg(1);
  const imm = args.shifted_u16_imm(2);
  return handle_addi_real(args.reg_ref(0), source_reg, source, imm, args);
}

export function handle_addi_real(output_reg, source_reg, source, imm, args) {
  const stack_info = args.stack_info;
  if (source_reg !== null && stack_info.is_stack_reg(source_reg)) {
    pyassert(imm instanceof Literal);
    if (stack_info.is_stack_reg(output_reg)) return source;
    const v = stack_info.get_stack_var(imm.value, { store: false });
    if (v instanceof LocalVar) stack_info.add_local_var(v);
    return new AddressOf(v, { type: v.type.reference() });
  }
  return add_imm(output_reg, source, imm, args);
}

export function add_imm(output_reg, source, imm, args) {
  const stack_info = args.stack_info;
  if (pyeq(imm, new Literal(0))) return source;
  else if (source.type.is_pointer_or_array()) {
    const dest_var = stack_info.get_planned_var(output_reg, args.instruction_ref);
    const arch = stack_info.global_info.arch;
    const inplace = dest_var !== null && var_for_expr(source) === dest_var;
    if (imm instanceof Literal && !arch.is_likely_partial_offset(imm.value) && !inplace) {
      const array_access = array_access_from_add(source, imm.value, stack_info, { target_size: null, ptr: true });
      if (array_access !== null) return array_access;
      const [field_path, field_type] = source.type.get_deref_field(imm.value, { target_size: null });
      if (field_path !== null) {
        return new AddressOf(new StructAccess({ struct_var: source, offset: imm.value, target_size: null, field_path, stack_info, type: field_type }), { type: field_type.reference() });
      }
    }
    if (imm instanceof Literal) {
      const target = source.type.get_pointer_target();
      if (target) {
        const target_size = target.get_size_bytes();
        if (target_size && pymod(imm.value, target_size) === 0) return new BinaryOp({ left: source, op: "+", right: as_intish(imm), type: source.type });
      }
    }
    return new BinaryOp({ left: source, op: "+", right: as_intish(imm), type: Type.ptr() });
  } else if (source instanceof Literal && imm instanceof Literal) {
    return new Literal(source.value + imm.value);
  }
  return BinaryOp.intptr(source, "+", imm);
}

export function handle_load(args, type) {
  const size = type.get_size_bytes();
  pyassert(size !== null);
  const output_reg = args.reg_ref(0);
  const expr = deref(args.memory_ref(1), args.regs, args.stack_info, { size });

  const load_rodata_constant = () => {
    if (!(expr instanceof StructAccess)) return null;
    const arch = args.stack_info.global_info.arch.arch;
    const is_arm = arch === Target.ArchEnum.ARM;
    const is_sh = arch === Target.ArchEnum.SH;
    if (is_arm && args.raw_arg(1) instanceof AsmAddressMode) return null;
    if (!is_arm && !is_sh && (!type.is_likely_float() || expr.offset !== 0)) return null;
    const target = early_unwrap(expr.struct_var);
    if (!(target instanceof AddressOf) || !(target.expr instanceof GlobalSymbol)) return null;
    const ent = target.expr.asm_data_entry;
    if (ent === null || !ent.is_readonly) return null;
    const data = ent.data_at_offset(expr.offset, size);
    if (data === null) return null;
    if (data instanceof Uint8Array && [2, 4, 8].includes(size)) {
      ent.used_as_literal = true;
      const big = args.stack_info.global_info.target.is_big_endian();
      let v = 0n;
      const bs = big ? [...data] : [...data].reverse();
      for (const b of bs) v = (v << 8n) | BigInt(b);
      // Values beyond 2**53 stay BigInt (see normint) so 64-bit patterns keep every bit.
      let val = normint(v);
      if (type.is_signed() && (v >> BigInt(size * 8 - 1)) & 1n) val = normint(v - (1n << BigInt(size * 8)));
      return new Literal({ value: val, type });
    }
    if ((is_arm || is_sh) && ent.is_text && data instanceof AsmSymbolicData) {
      let sym = data.data;
      let addend = 0;
      if (sym instanceof BinOp && (sym.op === "+" || sym.op === "-") && sym.rhs instanceof AsmLiteral) {
        addend = sym.rhs.value * (sym.op === "-" ? -1 : 1);
        sym = sym.lhs;
      }
      if (sym instanceof AsmGlobalSymbol) {
        ent.used_as_literal = true;
        let addr = args.stack_info.global_info.address_of_gsym(sym.symbol_name);
        addr = add_imm(output_reg, addr, new Literal(addend), args);
        return as_type(addr, type, true);
      }
    }
    return null;
  };

  const c = load_rodata_constant();
  if (c !== null) return c;
  return as_type(expr, type, true);
}

export function deref_unaligned(arg, regs, stack_info, { store = false } = {}) {
  return deref(arg, regs, stack_info, { size: 1, store });
}

export function handle_lwl(args) {
  const ref = args.memory_ref(1);
  const expr = deref_unaligned(ref, args.regs, args.stack_info);
  let key;
  if (ref instanceof AddressMode) key = [ref.offset, args.regs.get(ref.base)];
  else key = [ref.offset, ref.sym];
  return new Lwl(expr, key);
}

export function handle_lwr(args) {
  const uw_old_value = early_unwrap(args.reg(0));
  const ref = args.memory_ref(1);
  const big = args.stack_info.global_info.target.is_big_endian();
  const delta = big ? -3 : 3;
  let lwl_key;
  if (ref instanceof AddressMode) lwl_key = [ref.offset + delta, args.regs.get(ref.base)];
  else lwl_key = [ref.offset + delta, ref.sym];
  if (uw_old_value instanceof Lwl && uw_old_value.key[0] === lwl_key[0]) {
    let load_expr;
    if (big) load_expr = uw_old_value.load_expr;
    else load_expr = deref_unaligned(ref, args.regs, args.stack_info);
    return new UnalignedLoad(load_expr);
  }
  if (pymod(ref.offset, 4) === 2 && big) {
    const left_mem_ref = dcreplace(ref, { offset: ref.offset - 2 });
    const load_expr = deref_unaligned(left_mem_ref, args.regs, args.stack_info);
    return new Load3Bytes(load_expr);
  }
  return new ErrorExpr("Unable to handle lwr; missing a corresponding lwl");
}

export function make_store(args, type) {
  const size = type.get_size_bytes();
  pyassert(size !== null);
  const stack_info = args.stack_info;
  const source_reg = args.reg_ref(0);
  const source_raw = args.regs.get_raw(source_reg);
  let source_val;
  if (type.is_likely_float() && size === 8) source_val = args.dreg(0);
  else source_val = args.reg(0);
  const target = args.memory_ref(1);
  return make_store_real(source_val, source_raw, target, args.regs, stack_info, type);
}

export function make_store_real(source_val, source_raw, target, regs, stack_info, type) {
  const size = type.get_size_bytes();
  pyassert(size !== null);
  const is_stack = target instanceof AddressMode && stack_info.is_stack_reg(target.base);
  if (is_stack && source_raw !== null && stack_info.should_save(source_raw, target.offset)) return null;
  const dest = deref(target, regs, stack_info, { size, store: true });
  dest.type.unify(type);
  return new StoreStmt({ source: as_type(source_val, type, is_stack), dest });
}

export function make_storex(args, type) {
  const size = type.get_size_bytes();
  pyassert(size !== null);
  const source = args.reg(0);
  const ptr = BinaryOp.intptr(args.reg(1), "+", args.reg(2));
  const dest = deref(ptr, args.regs, args.stack_info, { size, store: true });
  dest.type.unify(type);
  return new StoreStmt({ source: as_type(source, type, false), dest });
}

export function handle_swl(args) {
  let source = args.reg(0);
  let target = args.memory_ref(1);
  if (!(early_unwrap(source) instanceof UnalignedLoad)) source = new UnalignedLoad(source);
  if (!args.stack_info.global_info.target.is_big_endian()) target = dcreplace(target, { offset: target.offset - 3 });
  const dest = deref_unaligned(target, args.regs, args.stack_info, { store: true });
  return new StoreStmt({ source, dest });
}

export function handle_swr(args) {
  const expr = early_unwrap(args.reg(0));
  const target = args.memory_ref(1);
  if (!(expr instanceof Load3Bytes)) return null;
  const real_target = dcreplace(target, { offset: target.offset - 2 });
  const dest = deref_unaligned(real_target, args.regs, args.stack_info, { store: true });
  return new StoreStmt({ source: expr, dest });
}

export function handle_shift_right(args, { signed, arm = false }) {
  const lhs = args.reg(1);
  const shift = arm ? args.reg_or_imm(2) : args.s16_imm(2);
  if (shift instanceof Literal && (shift.value === 16 || shift.value === 24)) {
    const expr = early_unwrap(lhs);
    const pow2 = shl(1, shift.value);
    if (expr instanceof BinaryOp && expr.right instanceof Literal) {
      let tp;
      if (signed) tp = shift.value === 16 ? Type.s16() : Type.s8();
      else tp = shift.value === 16 ? Type.u16() : Type.u8();
      const rhs = expr.right.value;
      if (expr.op === "<<" && rhs === shift.value) return as_type(expr.left, tp, false);
      else if (expr.op === "<<" && rhs > shift.value) {
        const new_shift = fold_mul_chains(BinaryOp.int(expr.left, "<<", new Literal(rhs - shift.value)));
        return as_type(new_shift, tp, false);
      } else if (expr.op === "*" && pymod(rhs, pow2) === 0 && rhs !== pow2) {
        const mul = BinaryOp.int(expr.left, "*", new Literal({ value: floordiv(rhs, pow2) }));
        return as_type(mul, tp, false);
      }
    }
  }
  if (signed) return fold_divmod(BinaryOp.sshift(lhs, ">>", shift));
  return BinaryOp.ushift(lhs, ">>", shift);
}

export function handle_sll(args, { arm = false } = {}) {
  const lhs = args.reg(1);
  const rhs = arm ? args.reg_or_imm(2) : args.s16_imm(2);
  if (lhs instanceof Literal && rhs instanceof Literal) return new Literal(shl(lhs.value, rhs.value));
  return fold_mul_chains(BinaryOp.int(lhs, "<<", as_intish(rhs)));
}

export function handle_conditional_move(args, nonzero) {
  const op = nonzero ? "!=" : "==";
  const val = args.reg(2);
  const type = Type.any_reg();
  return new TernaryOp(BinaryOp.icmp(val, op, new Literal(0, { type: val.type })), as_type(args.reg(1), type, true), as_type(args.reg(0), type, true), type);
}

/** Return a new BinaryOp instance if this one can be simplified to a single / or % op. */
export function fold_divmod(original_expr) {
  const mult_high_ops = ["MULT_HI", "MULTU_HI"];
  const possible_match_ops = [...mult_high_ops, "-", "+", ">>"];
  if (original_expr.is_floating() || !possible_match_ops.includes(original_expr.op)) return original_expr;

  let expr = original_expr;
  let left_expr = early_unwrap_ints(expr.left);
  let right_expr = early_unwrap_ints(expr.right);
  let divisor_shift = 0;

  if (left_expr instanceof Literal && !(right_expr instanceof Literal)) [left_expr, right_expr] = [right_expr, left_expr];

  if (left_expr instanceof BinaryOp && left_expr.op === ">>" && left_expr.right instanceof Literal && expr.op === "+" && right_expr instanceof CarryBit) {
    const new_denom = shl(1, left_expr.right.value);
    return BinaryOp.sint(left_expr.left, "/", new Literal(new_denom), { silent: true });
  }

  if (left_expr instanceof BinaryOp && left_expr.op === "/" && left_expr.right instanceof Literal && expr.op === ">>" && right_expr instanceof Literal) {
    const new_denom = shl(left_expr.right.value, right_expr.value);
    if (new_denom < 2 ** 32) return BinaryOp.int(left_expr.left, "/", new Literal(new_denom));
  }

  if (expr.op === "-" && right_expr instanceof BinaryOp && right_expr.op === "*") {
    const div_expr = early_unwrap_ints(right_expr.left);
    const mod_base = early_unwrap_ints(right_expr.right);
    if (div_expr instanceof BinaryOp && pyeq(early_unwrap_ints(div_expr.left), left_expr)) {
      const divisor = early_unwrap_ints(div_expr.right);
      if (
        (div_expr.op === "/" && pyeq(divisor, mod_base)) ||
        (div_expr.op === ">>" && divisor instanceof Literal && mod_base instanceof Literal && shl(1, divisor.value) === mod_base.value)
      ) {
        return BinaryOp.int(left_expr, "%", right_expr.right);
      }
    }
  }

  if (
    expr.op === "-" &&
    left_expr instanceof BinaryOp &&
    left_expr.op === ">>" &&
    pyeq(early_unwrap_ints(left_expr.right), new Literal(31)) &&
    right_expr instanceof BinaryOp &&
    right_expr.op === "/" &&
    right_expr.right instanceof Literal
  ) {
    [left_expr, right_expr] = [dcreplace(right_expr, { right: new Literal(-right_expr.right.value) }), left_expr];
  }

  if (
    expr.op === "+" &&
    left_expr instanceof BinaryOp &&
    left_expr.op === "/" &&
    left_expr.right instanceof Literal &&
    left_expr.right.value <= 2 ** 29 &&
    right_expr instanceof BinaryOp &&
    pyeq(early_unwrap_ints(right_expr.left), left_expr) &&
    right_expr.op === ">>" &&
    pyeq(early_unwrap_ints(right_expr.right), new Literal(31))
  ) {
    return left_expr;
  }

  if (
    expr.op === "-" &&
    left_expr instanceof BinaryOp &&
    left_expr.op === "/" &&
    left_expr.right instanceof Literal &&
    right_expr instanceof BinaryOp &&
    right_expr.op === ">>" &&
    pyeq(early_unwrap_ints(right_expr.right), new Literal(31))
  ) {
    const div_expr = left_expr;
    const shift_var_expr = early_unwrap_ints(right_expr.left);
    const div_var_expr = early_unwrap_ints(div_expr.left);
    if (pyeq(div_var_expr, shift_var_expr)) {
      if (div_expr.right instanceof Literal && div_expr.right.value >= 2 ** 30) return BinaryOp.int(div_expr.left, div_expr.op, div_expr.right);
      return div_expr;
    }
    if (
      shift_var_expr instanceof BinaryOp &&
      pyeq(early_unwrap_ints(div_expr.left), early_unwrap_ints(shift_var_expr.left)) &&
      shift_var_expr.op === "<<" &&
      shift_var_expr.right instanceof Literal
    ) {
      return div_expr;
    }
  }

  if (left_expr instanceof BinaryOp && expr.op === ">>" && right_expr instanceof Literal) {
    divisor_shift += right_expr.value;
    expr = left_expr;
    left_expr = early_unwrap_ints(expr.left);
    right_expr = early_unwrap_ints(expr.right);
    if (
      left_expr instanceof BinaryOp &&
      left_expr.op === "MULT_HI" &&
      expr.op === "+" &&
      (pyeq(right_expr, early_unwrap_ints(left_expr.left)) || pyeq(right_expr, early_unwrap_ints(left_expr.right)))
    ) {
      expr = left_expr;
      left_expr = early_unwrap_ints(expr.left);
      right_expr = early_unwrap_ints(expr.right);
    }
    if (left_expr instanceof Literal && !(right_expr instanceof Literal)) [left_expr, right_expr] = [right_expr, left_expr];
  }

  if (mult_high_ops.includes(expr.op) && left_expr instanceof BinaryOp && left_expr.op === ">>" && left_expr.right instanceof Literal) {
    divisor_shift += left_expr.right.value;
    left_expr = early_unwrap_ints(left_expr.left);
  }

  const round_div = (x, y) => {
    if (y <= 1) return null;
    const result = pyround(x / y);
    if (x / (y + 1) <= result && result <= x / (y - 1)) return result;
    return null;
  };

  if (mult_high_ops.includes(expr.op) && right_expr instanceof Literal) {
    const denom = round_div(2 ** (32 + divisor_shift), right_expr.value);
    if (denom !== null) return BinaryOp.int(left_expr, "/", new Literal(denom));
  }
  return original_expr;
}

/** Simplify an expression matching `CLZ(x) >> 5` into `x == 0`. */
export function replace_clz_shift(expr) {
  if (expr.is_floating() || expr.op !== ">>") return expr;
  const left_expr = early_unwrap_ints(expr.left);
  const right_expr = early_unwrap_ints(expr.right);
  if (!(left_expr instanceof UnaryOp && left_expr.op === "CLZ" && right_expr instanceof Literal && right_expr.value === 5)) return expr;
  const sub_expr = early_unwrap(left_expr.expr);
  if (sub_expr instanceof BinaryOp && !sub_expr.is_floating() && sub_expr.op === "-") return BinaryOp.icmp(sub_expr.right, "==", sub_expr.left);
  return BinaryOp.icmp(left_expr.expr, "==", new Literal(0, { type: left_expr.expr.type }));
}

/** Simplify expressions using `&`. */
export function replace_bitand(expr) {
  if (!expr.is_floating() && expr.op === "&") {
    if (pyeq(expr.right, new Literal(0))) return new Literal(0);
    if (pyeq(expr.right, new Literal(0xff))) return as_type(expr.left, Type.u8(), false);
    if (pyeq(expr.right, new Literal(0xffff))) return as_type(expr.left, Type.u16(), false);
  }
  return expr;
}

/** Simplify an expression involving +, -, * and << to a single multiplication. */
export function fold_mul_chains(expr, { allow_sll_chains = false } = {}) {
  const fold = (expr, toplevel, allow_sll) => {
    if (expr instanceof BinaryOp) {
      if ((expr.op === "<<" || expr.op === "*") && expr.right instanceof Literal) {
        const [lbase, lnum] = fold(expr.left, false, expr.op !== "<<");
        const rhs = expr.right.value;
        if (expr.op === "<<" && (allow_sll || allow_sll_chains)) {
          if (toplevel && lnum === 1 && !(1 <= rhs && rhs <= 4)) return [expr, 1];
          return [lbase, shl(lnum, rhs)];
        }
        if (expr.op === "*" && (allow_sll || allow_sll_chains || pymod(rhs, 2) !== 0)) return [lbase, lnum * rhs];
      }
      if ((expr.op === "+" || expr.op === "-") && toplevel) {
        const [lbase, lnum] = fold(expr.left, false, expr.op !== "<<");
        const [rbase, rnum] = fold(expr.right, false, expr.op !== "<<");
        if (pyeq(early_unwrap(lbase), early_unwrap(rbase))) {
          if (expr.op === "+") return [lbase, lnum + rnum];
          if (expr.op === "-") return [lbase, lnum - rnum];
        }
      }
    }
    if (expr instanceof UnaryOp && expr.op === "-" && !toplevel) {
      const [base, num] = fold(expr.expr, false, true);
      return [base, -num];
    }
    const uw_expr = early_unwrap(expr);
    if (uw_expr !== expr) {
      const [base, num] = fold(uw_expr, false, allow_sll);
      if (num !== 1) return [base, num];
    }
    return [expr, 1];
  };

  const [base, num] = fold(expr, true, true);
  if (num === 1) return expr;
  if (allow_sll_chains && num > 16 && band(num, num - 1) === 0) return BinaryOp.int(base, "<<", new Literal(bit_length(num) - 1));
  return BinaryOp.int(base, "*", new Literal(num));
}

export function fold_shift_right(expr, shift, { signed }) {
  const inner = early_unwrap_ints(expr);
  if (inner instanceof BinaryOp && inner.op === ">>" && inner.type.is_signed() === signed && inner.right instanceof Literal && inner.right.value + shift < 32) {
    expr = inner.left;
    shift += inner.right.value;
  }
  let ret;
  if (signed) ret = BinaryOp.sshift(expr, ">>", new Literal(shift));
  else ret = BinaryOp.ushift(expr, ">>", new Literal(shift));
  return fold_divmod(ret);
}

/** Given `expr` of the form `a + (imm * b + Y)` and an `offset` X, try to create `a->unk(X + Y)[b]`. */
export function array_access_from_add(expr, offset, stack_info, { target_size, ptr }) {
  expr = early_unwrap(expr);
  if (!(expr instanceof BinaryOp) || expr.op !== "+") return null;
  let base = expr.left;
  let addend = expr.right;
  if (addend.type.is_pointer_or_array() && !base.type.is_pointer_or_array()) [base, addend] = [addend, base];

  if (addend instanceof Literal) return null;

  let uw_addend = early_unwrap(addend);
  if (uw_addend instanceof BinaryOp && uw_addend.op === "+") {
    if (uw_addend.right instanceof Literal) {
      offset += uw_addend.right.value;
      addend = uw_addend.left;
    } else if (uw_addend.left instanceof Literal) {
      offset += uw_addend.left.value;
      addend = uw_addend.right;
    }
  }

  let index = addend;
  let scale = 1;
  uw_addend = early_unwrap(addend);
  if (uw_addend instanceof BinaryOp && (uw_addend.op === "*" || uw_addend.op === "<<") && uw_addend.right instanceof Literal) {
    index = uw_addend.left;
    scale = uw_addend.right.value;
    if (uw_addend.op === "<<") scale = shl(1, scale);
  }

  if (scale < 0) {
    scale = -scale;
    index = UnaryOp.sint("-", index);
  }

  let target_type = base.type.get_pointer_target();
  if (target_type === null) return null;

  const uw_base = early_unwrap(base);
  const typepool = stack_info.global_info.typepool;

  if (scale > 1 && offset === 0 && uw_base instanceof AddressOf && target_type.get_size_bytes() === null) {
    let inner_type = null;
    if (uw_base.expr instanceof GlobalSymbol && uw_base.expr.potential_array_dim(scale)[1] !== 0) {
      // pass
    } else if (scale === 2) inner_type = Type.int_of_size(16);
    else if (scale === 4) inner_type = Type.reg32({ likely_float: false });
    else if (typepool.unk_inference && uw_base.expr instanceof GlobalSymbol) {
      const struct_name = `_struct_${uw_base.expr.c_symbol_name}_0x${format(scale, "X")}`;
      let struct = typepool.get_struct_by_tag_name(struct_name, stack_info.global_info.typemap);
      if (struct === null) struct = StructDeclaration.unknown(typepool, scale, struct_name);
      else if (struct.size !== scale) throw new DecompFailure(`sizeof(struct ${struct_name}) != ${format(scale, "#x")}`);
      inner_type = Type.struct(struct);
    }
    if (inner_type !== null) {
      uw_base.expr.type.unify(Type.array(inner_type, null));
      target_type.unify(inner_type);
    }
  }

  if (target_type.get_size_bytes() === scale) {
    // base[index]
  } else {
    const [sub_path, sub_type, remaining_offset] = base.type.get_deref_field(offset, { target_size: scale, exact: false });
    if (sub_path === null || sub_path.length < 2 || sub_path[sub_path.length - 1] !== 0) return null;
    sub_path.pop();
    base = new StructAccess({ struct_var: base, offset: offset - remaining_offset, target_size: null, field_path: sub_path, stack_info, type: sub_type });
    offset = remaining_offset;
    target_type = sub_type;
  }

  let ret = new ArrayAccess(base, index, { type: target_type });
  const ret_ref = new AddressOf(ret, { type: ret.type.reference() });
  const [field_path, field_type] = ret_ref.type.get_deref_field(offset, { target_size });
  if (offset !== 0 || (target_size !== null && target_size !== scale)) {
    ret = new StructAccess({ struct_var: ret_ref, offset, target_size, field_path, stack_info, type: field_type });
  }
  if (ptr) ret = new AddressOf(ret, { type: ret.type.reference() });
  return ret;
}

export function handle_add(args) {
  const output_reg = args.reg_ref(0);
  const lhs = args.reg(1);
  const rhs = args.reg(2);
  if (rhs instanceof Literal) return fold_mul_chains(handle_addi_real(output_reg, args.reg_ref(1), lhs, rhs, args));
  if (lhs instanceof Literal) return fold_mul_chains(handle_addi_real(output_reg, args.reg_ref(2), rhs, lhs, args));
  return handle_add_real(lhs, rhs, args);
}

export function handle_add_arm(args) {
  if (args.raw_arg(2) instanceof Register) return handle_add(args);
  return handle_addi(args.reg_ref(0), args.reg_ref(1), args.reg(1), args.full_imm(2), args);
}

export function handle_add_real(lhs, rhs, args) {
  const stack_info = args.stack_info;
  if (pyeq(lhs, new Literal(0))) return rhs;
  if (pyeq(rhs, new Literal(0))) return lhs;
  let type = Type.intptr();
  if (lhs.type.is_pointer_or_array()) type = Type.ptr();
  else if (rhs.type.is_pointer_or_array()) type = Type.ptr();
  const expr = new BinaryOp({ left: as_intptr(lhs), op: "+", right: as_intptr(rhs), type });
  let folded_expr = fold_mul_chains(expr);
  if (folded_expr instanceof BinaryOp) folded_expr = fold_divmod(folded_expr);
  if (folded_expr !== expr) return folded_expr;
  const array_expr = array_access_from_add(expr, 0, stack_info, { target_size: null, ptr: true });
  if (array_expr !== null) return array_expr;
  return expr;
}

export function handle_add_float(args) {
  if (args.reg_ref(1) === args.reg_ref(2)) {
    const two = new Literal(1 << 30, { type: Type.f32() });
    return BinaryOp.f32(two, "*", args.reg(1));
  }
  return BinaryOp.f32(args.reg(1), "+", args.reg(2));
}

export function handle_add_double(args) {
  if (args.reg_ref(1) === args.reg_ref(2)) {
    const two = new Literal(2 ** 62, { type: Type.f64() });
    return BinaryOp.f64(two, "*", args.dreg(1));
  }
  return BinaryOp.f64(args.dreg(1), "+", args.dreg(2));
}

export function fold_shift_bgez(expr) {
  const uw_expr = early_unwrap(expr);
  if (!(uw_expr instanceof BinaryOp) || !(uw_expr.right instanceof Literal)) return null;
  const value = uw_expr.right.value;
  let shift;
  if (uw_expr.op === "<<") shift = value;
  else if (uw_expr.op === "*" && value > 0 && band(value, value - 1) === 0) shift = bit_length(value) - 1;
  else return null;
  const bitand = BinaryOp.int(uw_expr.left, "&", new Literal(shl(1, 31 - shift)));
  return new UnaryOp("!", bitand, { type: Type.boolean() });
}

export function handle_bgez(args) {
  const expr = args.reg(0);
  return fold_shift_bgez(expr) || BinaryOp.scmp(expr, ">=", new Literal(0));
}

export function rlwi_mask(mask_begin, mask_end) {
  const bits_upto = (m) => shl(1, 32 - m) - 1;
  const all_ones = 0xffffffff;
  let mask;
  if (mask_begin <= mask_end) mask = bits_upto(mask_begin) - bits_upto(mask_end + 1);
  else mask = bxor(bits_upto(mask_end + 1) - bits_upto(mask_begin), all_ones);
  return mask;
}

export function handle_rlwinm(source, shift, mask_begin, mask_end, simplify = true) {
  const all_ones = 0xffffffff;
  const mask = rlwi_mask(mask_begin, mask_end);
  const left_shift = shift;
  const right_shift = 32 - shift;
  const left_mask = band(shl(all_ones, left_shift), mask);
  const right_mask = band(shr(all_ones, right_shift), mask);

  simplify = simplify && !(left_mask && right_mask);

  if (source instanceof Literal) {
    const upper_value = band(shl(source.value, left_shift), mask);
    const lower_value = band(shr(source.value, right_shift), mask);
    return new Literal(bor(upper_value, lower_value));
  }

  let upper_bits;
  if (left_mask === 0) upper_bits = null;
  else {
    upper_bits = source;
    if (left_shift !== 0) upper_bits = BinaryOp.int(upper_bits, "<<", new Literal(left_shift));
    if (simplify) upper_bits = fold_mul_chains(upper_bits);
    if (left_mask !== band(shl(all_ones, left_shift), all_ones)) {
      upper_bits = BinaryOp.int(upper_bits, "&", new Literal(left_mask));
      if (simplify) upper_bits = replace_bitand(upper_bits);
    }
  }

  let lower_bits;
  if (right_mask === 0) lower_bits = null;
  else {
    lower_bits = BinaryOp.uint(source, ">>", new Literal(right_shift));
    if (simplify) lower_bits = replace_clz_shift(fold_divmod(lower_bits));
    if (right_mask !== band(shr(all_ones, right_shift), all_ones)) {
      lower_bits = BinaryOp.int(lower_bits, "&", new Literal(right_mask));
      if (simplify) lower_bits = replace_bitand(lower_bits);
    }
  }

  if (upper_bits === null && lower_bits === null) return new Literal(0);
  else if (upper_bits === null) {
    pyassert(lower_bits !== null);
    return lower_bits;
  } else if (lower_bits === null) return upper_bits;
  return BinaryOp.int(upper_bits, "|", lower_bits);
}

export function handle_rlwimi(base, source, shift, mask_begin, mask_end) {
  const mask_literal = new Literal(rlwi_mask(mask_begin, mask_end));
  const mask = new UnaryOp("~", mask_literal, { type: Type.u32() });
  const masked_base = BinaryOp.int(base, "&", mask);
  if (pyeq(source, new Literal(0))) return masked_base;
  const inserted = handle_rlwinm(source, shift, mask_begin, mask_end, false);
  if (pyeq(inserted, mask_literal)) return BinaryOp.int(base, "|", inserted);
  return BinaryOp.int(masked_base, "|", inserted);
}

export function handle_rlwnm(source, shift_source, mask_begin, mask_end) {
  const mask = rlwi_mask(mask_begin, mask_end);
  const shift = BinaryOp.int(shift_source, "&", new Literal(0x1f));
  const upper_bits = BinaryOp.int(BinaryOp.int(source, "<<", shift), "&", new Literal(mask));
  const lower_bits = BinaryOp.int(BinaryOp.int(source, ">>", BinaryOp.int(new Literal(32), "-", shift)), "&", new Literal(mask));
  return BinaryOp.int(upper_bits, "|", lower_bits);
}

export function handle_cmpnez(source) {
  let uw_source = early_unwrap(source);
  if (uw_source instanceof UnaryOp && uw_source.op === "-") {
    source = uw_source.expr;
    uw_source = early_unwrap(source);
  }
  if (uw_source instanceof BinaryOp && (uw_source.op === "-" || uw_source.op === "^")) return BinaryOp.icmp(uw_source.right, "!=", uw_source.left);
  return BinaryOp.icmp(source, "!=", new Literal(0));
}

export function handle_loadx(args, type) {
  const size = type.get_size_bytes();
  pyassert(size !== null);
  const ptr = BinaryOp.intptr(args.reg(1), "+", args.reg(2));
  const expr = deref(ptr, args.regs, args.stack_info, { size });
  return as_type(expr, type, true);
}

export function handle_arm_mov(args) {
  const dest = args.reg_ref(0);
  const source = args.raw_arg(1);
  const value = args.reg_or_imm(1);
  if (source instanceof Register && args.stack_info.is_stack_reg(source) && !args.stack_info.is_stack_reg(dest)) return handle_addi_real(dest, source, value, new Literal(0), args);
  return value;
}

export function eval_arm_cmp(s, lhs, rhs) {
  s.set_reg(new Register("z"), BinaryOp.icmp(lhs, "==", rhs));
  const sub = BinaryOp.intptr(lhs, "-", rhs);
  const sval = as_type(sub, Type.s32(), true, { unify: false });
  s.set_reg(new Register("n"), BinaryOp.scmp(sval, "<", new Literal(0)));
  const v = fn_op("M2C_OVERFLOW", [sval], Type.boolean());
  s.set_reg(new Register("v"), v);
  const ulhs = as_type(lhs, Type.u32(), true, { unify: false });
  const slhs = as_type(lhs, Type.s32(), true, { unify: false });
  const urhs = as_type(rhs, Type.u32(), true, { unify: false });
  const srhs = as_type(rhs, Type.s32(), true, { unify: false });
  s.set_reg(new Register("c"), BinaryOp.ucmp(ulhs, ">=", urhs));
  s.set_reg(new Register("hi"), BinaryOp.ucmp(ulhs, ">", urhs));
  s.set_reg(new Register("ge"), BinaryOp.scmp(slhs, ">=", srhs));
  s.set_reg(new Register("gt"), BinaryOp.scmp(slhs, ">", srhs));
}

export function set_arm_flags_from_add(s, val) {
  s.set_reg(new Register("z"), BinaryOp.icmp(val, "==", new Literal(0, { type: val.type })));
  const sval = as_type(val, Type.s32(), true, { unify: false });
  s.set_reg(new Register("n"), BinaryOp.scmp(sval, "<", new Literal(0)));
  s.set_reg(new Register("c"), new CarryBit(val));
  const v = fn_op("M2C_OVERFLOW", [sval], Type.boolean());
  s.set_reg(new Register("v"), v);
  const u64val = as_type(val, Type.u64(), false, { unify: false });
  const p32 = new Literal(2 ** 32);
  s.set_reg(new Register("hi"), BinaryOp.ucmp(u64val, ">", p32));
  const s64val = as_type(val, Type.s64(), false, { unify: false });
  s.set_reg(new Register("ge"), BinaryOp.scmp(s64val, ">=", new Literal(0)));
  s.set_reg(new Register("gt"), BinaryOp.scmp(s64val, ">", new Literal(0)));
}

export function carry_add_to(expr) {
  return fold_divmod(BinaryOp.intptr(expr, "+", new CarryBit()));
}

export function carry_sub_from(expr) {
  return BinaryOp.intptr(expr, "-", new UnaryOp("!", new CarryBit(), { type: Type.intish() }));
}

export function s32_literal(value) {
  return new Literal(band(value + 0x80000000, 0xffffffff) - 0x80000000);
}

export { ArrayAccess };
