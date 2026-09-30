// Port of m2c/translate.py
/* eslint no-unused-vars: ["error", { "args": "none" }] -- keeps upstream's parameter lists */
import { ArchC, is_unk_type } from "./c_types.js";
import { parse as demangle_codewarrior_parse } from "./demangle_codewarrior.js";
import { DecompFailure, assert_never } from "./error.js";
import {
  ArchFlowGraph,
  BasicNode,
  ConditionalNode,
  InstrRef,
  PrologueRef,
  ReturnNode,
  SwitchNode,
  TerminalNode,
  locs_clobbered_until_dominator,
} from "./flow_graph.js";
import { simplify_ir_patterns } from "./ir_pattern.js";
import { CodingStyle, Formatter, Options, Target } from "./options.js";
import { AsmSymbolicData } from "./asm_file.js";
import { AsmAddressMode, AsmGlobalSymbol, AsmLiteral, BinOp, Macro, Register, RegisterList, Writeback } from "./asm_instruction.js";
import { Instruction, InstrProcessingFailure, StackLocation, set_current_instr } from "./instruction.js";
import { FunctionParam, StructDeclaration, Type } from "./types.js";
import {
  AssertionError,
  DefaultMap,
  DefaultPyDict,
  PyDict,
  PySet,
  ValueError,
  band,
  bnot,
  bor,
  compare,
  dcinit,
  dcreplace,
  factory,
  floordiv,
  float_repr,
  format,
  format_exp,
  format_fixed,
  format_general,
  has,
  hex,
  int_,
  objId,
  pyassert,
  pyeq,
  pyin,
  pymod,
  rstrip,
  shl,
  sorted,
  str,
} from "./py.js";
import { py_float } from "./asm_file.js";
import { print } from "./io.js";

/** Sort an array in place with a Python-style key (stable). */
function sort_inplace(arr, key) {
  const s = sorted(arr, key);
  arr.splice(0, arr.length, ...s);
}

/**
 * Arch-specific information that relates to the translation level. Extends ArchFlowGraph.
 */
export class Arch extends ArchFlowGraph {
  arg_name(loc) {
    throw new Error("abstract");
  }
  function_abi(fn_sig, likely_regs, { for_call }) {
    throw new Error("abstract");
  }
  function_return(expr) {
    throw new Error("abstract");
  }
  is_likely_partial_offset(addend) {
    return 0 <= addend && addend < 0x1000000 && [0, 2 ** 15 - 1].includes(pymod(addend, 2 ** 15));
  }
  c_symbol_name(asm_name) {
    return asm_name;
  }
  simplify_ir(asm_data, flow_graph, { debug_patterns }) {
    simplify_ir_patterns(this, asm_data, flow_graph, this.ir_patterns, { debug_patterns });
  }
}
Arch.prototype.ir_patterns = [];
Arch.prototype.base_struct_align = ArchC.prototype.base_struct_align;

export const ASSOCIATIVE_OPS = new Set(["+", "&&", "||", "&", "|", "^", "*"]);
export const COMPOUND_ASSIGNMENT_OPS = new Set(["+", "-", "*", "/", "%", "&", "|", "^", "<<", ">>"]);
export const PSEUDO_FUNCTION_OPS = new Set(["MULT_HI", "MULTU_HI", "DMULT_HI", "DMULTU_HI", "GLUE_F64", "CLZ"]);

export function as_type(expr, type, silent, { unify = true } = {}) {
  type = type.weaken_void_ptr();
  if (expr instanceof Literal) {
    // For literals we (try to) avoid ever propagating information backwards,
    // by creating a clone of the literal before casting it.
    expr = new Literal(expr.value, expr.type.clone_literal_type());
    unify = true;
  }
  const ptr_target_type = type.get_pointer_target();
  if (unify && expr.type.unify(type)) {
    if (silent || expr instanceof Literal) return expr;
  } else if (ptr_target_type !== null) {
    const ptr_target_type_size = ptr_target_type.get_size_bytes();
    const [field_path, field_type] = expr.type.get_deref_field(0, { target_size: ptr_target_type_size });
    if (field_path !== null && field_type.unify(ptr_target_type)) {
      expr = new AddressOf(
        new StructAccess({ struct_var: expr, offset: 0, target_size: ptr_target_type_size, field_path, stack_info: null, type: field_type }),
        { type },
      );
      if (silent) return expr;
    }
  }
  return new Cast({ expr, reinterpret: true, silent: false, type });
}

export function as_f32(expr) {
  return as_type(expr, Type.f32(), true);
}
export function as_f64(expr) {
  return as_type(expr, Type.f64(), true);
}
export function as_sintish(expr, { silent = false } = {}) {
  return as_type(expr, Type.sintish(), silent);
}
export function as_uintish(expr) {
  return as_type(expr, Type.uintish(), false);
}
export function as_s16(expr) {
  return as_type(expr, Type.s16(), false);
}
export function as_u16(expr) {
  return as_type(expr, Type.u16(), false);
}
export function as_u32(expr) {
  return as_type(expr, Type.u32(), false);
}
export function as_s64(expr, { silent = false } = {}) {
  return as_type(expr, Type.s64(), silent);
}
export function as_u64(expr, { silent = false } = {}) {
  return as_type(expr, Type.u64(), silent);
}
export function as_intish(expr) {
  return as_type(expr, Type.intish(), true);
}
export function as_int64(expr) {
  return as_type(expr, Type.int64(), true);
}
export function as_intptr(expr) {
  return as_type(expr, Type.intptr(), true);
}
export function as_ptr(expr) {
  return as_type(expr, Type.ptr(), true);
}
export function as_function_ptr(expr) {
  return as_type(expr, Type.ptr(Type.function()), true);
}

/** A persistent Var, that can be merged with other ones using a union-find-based setup. */
export class PlannedVar {
  constructor(_parent = null) {
    this._parent = _parent;
  }
  get_representative() {
    let root = this;
    const seen = [];
    while (root._parent !== null) {
      seen.push(root);
      root = root._parent;
    }
    for (const v of seen) v._parent = root;
    return root;
  }
  join(other) {
    const a = this.get_representative();
    const b = other.get_representative();
    if (a !== b) a._parent = b;
  }
}

export const PhiInheritSource = Object.freeze({ DOMINATOR: "DOMINATOR", ANY_PARENT: "ANY_PARENT" });

/** Function state that's persistent between multiple translation passes. */
export class PersistentFunctionState {
  constructor() {
    // (Register, Reference) -> PlannedVar
    this.planned_vars = new PyDict();
    // (Register, Node) -> PhiInheritSource
    this.planned_inherited_phis = new PyDict();
  }
}

export class StackInfo {
  constructor(fn, persistent_state, global_info, flow_graph) {
    this.function = fn;
    this.persistent_state = persistent_state;
    this.global_info = global_info;
    this.flow_graph = flow_graph;
    this.warnings = [];
    this.allocated_stack_size = 0;
    this.is_leaf = true;
    this.is_variadic = false;
    this.frame_pointer_reg = null;
    this.subroutine_arg_top = 0;
    this.callee_save_regs = new Set();
    this.callee_save_reg_region = [0, 0];
    this.unique_type_map = new PyDict();
    this.local_vars = [];
    this.temp_vars = [];
    this.naive_phi_vars = [];
    this.reg_vars = new Map();
    this.planned_vars = new PyDict();
    this.used_reg_vars = new Set();
    this.arguments = [];
    this.temp_name_counter = new Map();
    this.nonzero_accesses = new PySet();
    this.param_names = new PyDict();
    this.stack_pointer_type = null;
    this.replace_first_arg = null;
    this.weak_stack_var_types = new Map();
    this.weak_stack_var_locations = new Set();
  }

  temp_var(prefix) {
    const counter = (this.temp_name_counter.get(prefix) ?? 0) + 1;
    this.temp_name_counter.set(prefix, counter);
    return prefix + (counter > 1 ? `_${counter}` : "");
  }

  in_subroutine_arg_region(location) {
    if (this.global_info.arch.arch === Target.ArchEnum.PPC) return false;
    if (this.is_leaf) return false;
    return location < this.subroutine_arg_top;
  }

  in_callee_save_reg_region(location) {
    const [lower_bound, upper_bound] = this.callee_save_reg_region;
    if (lower_bound <= location && location < upper_bound) return true;
    // PPC saves LR in the header of the previous stack frame
    if (this.global_info.arch.arch === Target.ArchEnum.PPC && location === this.allocated_stack_size + 4) return true;
    return false;
  }

  location_above_stack(location) {
    return location >= this.allocated_stack_size;
  }

  add_known_param(loc, name, type) {
    if (loc.sort_index === 0 && type.is_pointer() && this.replace_first_arg === null) {
      const namespace = this.function.name.split("_")[0];
      const base_struct_type = type.get_pointer_target();
      const self_struct = this.global_info.typepool.get_struct_by_tag_name(namespace, this.global_info.typemap);
      if (self_struct !== null && base_struct_type !== null && base_struct_type.is_struct()) {
        const self_struct_type = Type.struct(self_struct);
        const [field_path, field_type] = self_struct_type.get_field(0, { target_size: base_struct_type.get_size_bytes() });
        if (field_path !== null && field_type.unify(base_struct_type) && !self_struct_type.unify(base_struct_type)) {
          this.replace_first_arg = [name || "_self", type];
          name = name === "thisx" ? "this" : "self";
          type = Type.ptr(Type.struct(self_struct));
        }
      }
    }
    if (name) this.param_names.set(loc, name);
    const arg = this.get_argument(loc);
    this.arguments.push(arg);
    sort_inplace(this.arguments, (a) => a.loc);
    arg.type.unify(type);
    return type;
  }

  get_param_name(loc) {
    return this.param_names.get(loc) ?? null;
  }

  add_local_var(v) {
    if (this.local_vars.some((x) => x.value === v.value)) return;
    this.local_vars.push(v);
    sort_inplace(this.local_vars, (x) => x.value);
  }

  add_argument(arg) {
    for (const a of this.arguments) {
      if (a.loc.equals(arg.loc)) {
        if (a.loc.reg === null && arg.loc.reg !== null) {
          this.arguments.splice(this.arguments.indexOf(a), 1);
          break;
        }
        return;
      }
    }
    this.arguments.push(arg);
    sort_inplace(this.arguments, (a) => a.loc);
  }

  get_argument(loc) {
    return new PassedInArg(loc, { stack_info: this, type: this.unique_type_for("arg", loc, Type.any_reg()) });
  }

  get_argument_above_stack(offset) {
    const aligned_offset = band(offset, -4);
    const loc = new ArgLoc(aligned_offset, null, null);
    const arg = this.get_argument(loc);
    if (aligned_offset === offset - 3) return [as_type(arg, Type.int_of_size(8), true), arg];
    if (aligned_offset === offset - 2) return [as_type(arg, Type.int_of_size(16), true), arg];
    return [arg, arg];
  }

  record_struct_access(ptr, location) {
    if (location) this.nonzero_accesses.add(unwrap_deep(ptr));
  }

  has_nonzero_access(ptr) {
    return this.nonzero_accesses.has(unwrap_deep(ptr));
  }

  unique_type_for(category, key, def) {
    const k = [category, key];
    if (!this.unique_type_map.has(k)) this.unique_type_map.set(k, def);
    return this.unique_type_map.get(k);
  }

  saved_reg_symbol(reg_name) {
    const sym_name = "saved_reg_" + reg_name;
    const type = this.unique_type_for("saved_reg", sym_name, Type.any_reg());
    return new GlobalSymbol({ c_symbol_name: sym_name, type });
  }

  should_save(expr, offset) {
    expr = early_unwrap(expr);
    if (expr instanceof GlobalSymbol && (expr.c_symbol_name.startsWith("saved_reg_") || expr.c_symbol_name === "sp")) return true;
    if (expr instanceof PassedInArg && expr.loc.offset !== null && (offset === null || offset === this.allocated_stack_size + expr.loc.offset)) return true;
    return false;
  }

  get_stack_var(location, { store }) {
    if (this.in_callee_save_reg_region(location)) {
      return new LocalVar(location, { type: Type.any_reg(), path: null });
    } else if (this.location_above_stack(location)) {
      const offset = location - this.allocated_stack_size;
      const [ret, arg] = this.get_argument_above_stack(offset);
      if (!store) this.add_argument(arg);
      return ret;
    } else if (this.in_subroutine_arg_region(location)) {
      return new SubroutineArg(location, { type: Type.any_reg() });
    } else {
      pyassert(this.stack_pointer_type !== null);
      let [field_path, field_type] = this.stack_pointer_type.get_deref_field(location, { target_size: null });

      const previous_stored_type = this.weak_stack_var_types.get(location) ?? null;
      if (previous_stored_type !== null) {
        if (!previous_stored_type.unify(field_type)) this.weak_stack_var_locations.add(location);
        if (store) field_type = Type.any_field();
        else field_type = previous_stored_type;
      }
      if (store) this.weak_stack_var_types.set(location, field_type);
      return new LocalVar(location, { type: field_type, path: field_path });
    }
  }

  maybe_get_register_var(reg) {
    return this.reg_vars.get(reg) ?? null;
  }

  add_register_var(reg, name) {
    const type = reg.is_float() ? Type.floatish() : Type.intptr();
    const v = new Var(this, { prefix: `var_${name}`, is_planned: true, type });
    this.reg_vars.set(reg, v);
    this.temp_vars.push(v);
  }

  get_planned_var(reg, source) {
    const v = this.reg_vars.get(reg) ?? null;
    if (v && source instanceof InstrRef && source.instruction.function_target === null) return v;
    return this.planned_vars.get([reg, source]) ?? null;
  }

  get_persistent_planned_var(reg, source) {
    let ret = this.persistent_state.planned_vars.get([reg, source]) ?? null;
    if (!ret) {
      ret = new PlannedVar();
      this.persistent_state.planned_vars.set([reg, source], ret);
    }
    return ret;
  }

  add_planned_inherited_phi(node, reg, source) {
    this.persistent_state.planned_inherited_phis.set([reg, node], source);
  }

  get_planned_inherited_phi(node, reg) {
    return this.persistent_state.planned_inherited_phis.get([reg, node]) ?? null;
  }

  is_stack_reg(reg) {
    if (reg === this.global_info.arch.stack_pointer_reg) return true;
    if (reg === this.frame_pointer_reg) return true;
    return false;
  }

  /** Reorganize struct information in unique_type_map by var & offset */
  get_struct_type_map() {
    const struct_type_map = new PyDict();
    for (const [[category, key], type] of this.unique_type_map) {
      if (category !== "struct") continue;
      const [v, offset] = key;
      if (!struct_type_map.has(v)) struct_type_map.set(v, new Map());
      struct_type_map.get(v).set(offset, type);
    }
    return struct_type_map;
  }

  toString() {
    return [
      `Stack info for function ${this.function.name}:`,
      `Allocated stack size: ${this.allocated_stack_size}`,
      `Leaf? ${this.is_leaf ? "True" : "False"}`,
      `Bounds of callee-saved vars region: (${this.callee_save_reg_region[0]}, ${this.callee_save_reg_region[1]})`,
      `Subroutine arg top: ${this.subroutine_arg_top}`,
      `Callee save registers: {${[...this.callee_save_regs].map((r) => `Register(register_name='${r.register_name}')`).join(", ")}}`,
    ].join("\n");
  }
}

export function get_stack_info(fn, persistent_state, global_info, flow_graph) {
  const arch = global_info.arch;
  const info = new StackInfo(fn, persistent_state, global_info, flow_graph);

  const callee_saved_offsets = [];
  const allowed_callee_save_gaps = new Set();
  const temp_reg_values = new Map();
  for (const inst of flow_graph.entry_node().block.instructions) {
    const arch_mnemonic = inst.arch_mnemonic(arch);
    if (inst.function_target) {
      break;
    } else if (arch_mnemonic === "mips:addiu" && inst.args[0] === arch.stack_pointer_reg) {
      pyassert(inst.args[2] instanceof AsmLiteral);
      info.allocated_stack_size = Math.abs(inst.args[2].as_s16());
    } else if (arch_mnemonic === "mips:subu" && inst.args[0] === arch.stack_pointer_reg && inst.args[1] === arch.stack_pointer_reg && temp_reg_values.has(inst.args[2])) {
      pyassert(inst.args[2] instanceof Register);
      info.allocated_stack_size = temp_reg_values.get(inst.args[2]);
    } else if (arch_mnemonic === "ppc:stwu" && inst.args[0] === arch.stack_pointer_reg) {
      pyassert(inst.args[1] instanceof AsmAddressMode);
      pyassert(inst.args[1].addend instanceof AsmLiteral);
      info.allocated_stack_size = Math.abs(inst.args[1].addend.value);
    } else if (arch_mnemonic === "arm:push" || arch_mnemonic === "arm:vpush") {
      pyassert(inst.args[0] instanceof RegisterList);
      for (const reg of [...inst.args[0].regs].reverse()) {
        const [tp] = reg.arm_regtype_index();
        const num_words = { r: 1, s: 1, d: 2, q: 4 }[tp];
        for (let i = 0; i < num_words; i++) {
          info.allocated_stack_size += 4;
          if (arch.saved_regs.includes(reg)) callee_saved_offsets.push(-info.allocated_stack_size);
        }
        if (arch.saved_regs.includes(reg)) info.callee_save_regs.add(reg);
        if (reg === new Register("lr")) info.is_leaf = false;
      }
    } else if ((arch_mnemonic === "arm:sub" || arch_mnemonic === "arm:add") && inst.args[0] === arch.stack_pointer_reg && inst.args[1] === arch.stack_pointer_reg && inst.args[2] instanceof AsmLiteral) {
      const imm = inst.args[2].value * (arch_mnemonic === "arm:add" ? -1 : 1);
      info.allocated_stack_size += Math.max(imm, 0);
    } else if (
      ["mips:move", "arm:mov", "ppc:mr"].includes(arch_mnemonic) &&
      inst.args[0] instanceof Register &&
      arch.frame_pointer_regs.includes(inst.args[0]) &&
      inst.args[1] === arch.stack_pointer_reg
    ) {
      info.frame_pointer_reg = inst.args[0];
    } else if (arch_mnemonic === "sh:mov" && inst.args[0] === arch.stack_pointer_reg && inst.args[1] instanceof Register && arch.frame_pointer_regs.includes(inst.args[1])) {
      info.frame_pointer_reg = inst.args[1];
    } else if (arch_mnemonic === "sh:add" && inst.args[0] instanceof AsmLiteral && inst.args[0].as_s8() < 0 && inst.args[1] === arch.stack_pointer_reg) {
      info.allocated_stack_size += -inst.args[0].as_s8();
    } else if (
      (arch_mnemonic === "sh:mov.l" || arch_mnemonic === "sh:sts.l") &&
      inst.args[0] instanceof Register &&
      arch.saved_regs.includes(inst.args[0]) &&
      inst.args[1] instanceof AsmAddressMode &&
      inst.args[1].base === arch.stack_pointer_reg &&
      inst.args[1].writeback === Writeback.PRE
    ) {
      info.allocated_stack_size += 4;
      info.callee_save_regs.add(inst.args[0]);
      callee_saved_offsets.push(-info.allocated_stack_size);
      if (inst.args[0] === arch.return_address_reg) info.is_leaf = false;
    } else if (
      ["mips:sw", "mips:sd", "mips:sq", "mips:swc1", "mips:sdc1", "ppc:stw", "ppc:stmw", "ppc:stfd", "ppc:psq_st"].includes(arch_mnemonic) &&
      inst.args[0] instanceof Register &&
      arch.saved_regs.includes(inst.args[0]) &&
      inst.args[1] instanceof AsmAddressMode &&
      inst.args[1].base === arch.stack_pointer_reg &&
      (!info.callee_save_regs.has(inst.args[0]) || arch_mnemonic === "ppc:psq_st")
    ) {
      if (inst.args[0] === arch.return_address_reg || inst.args[0] === new Register("r0")) info.is_leaf = false;
      const n = Math.min(inst.inputs.length, inst.outputs.length);
      for (let k = 0; k < n; k++) {
        const inp = inst.inputs[k];
        const mem = inst.outputs[k];
        if (inp instanceof Register && mem instanceof StackLocation) {
          pyassert(mem.symbolic_offset === null);
          const stack_offset = mem.offset;
          if (arch_mnemonic !== "ppc:psq_st") info.callee_save_regs.add(inp);
          callee_saved_offsets.push(stack_offset);
          if (arch_mnemonic === "mips:sd") allowed_callee_save_gaps.add(stack_offset + 8);
          if (arch_mnemonic === "mips:swc1") allowed_callee_save_gaps.add(stack_offset + 4);
        }
      }
    } else if (arch_mnemonic === "ppc:mflr" && inst.args[0] === new Register("r0")) {
      info.is_leaf = false;
    } else if (arch_mnemonic === "mips:li" && arch.temp_regs.includes(inst.args[0])) {
      pyassert(inst.args[0] instanceof Register);
      pyassert(inst.args[1] instanceof AsmLiteral);
      temp_reg_values.set(inst.args[0], inst.args[1].value);
    } else if (arch_mnemonic === "mips:ori" && inst.args[0] === inst.args[1] && temp_reg_values.has(inst.args[0])) {
      pyassert(inst.args[0] instanceof Register);
      pyassert(inst.args[2] instanceof AsmLiteral);
      temp_reg_values.set(inst.args[0], bor(temp_reg_values.get(inst.args[0]), inst.args[2].value));
    }
  }

  if (arch.arch === Target.ArchEnum.ARM || arch.arch === Target.ArchEnum.SH) {
    for (let i = 0; i < callee_saved_offsets.length; i++) callee_saved_offsets[i] += info.allocated_stack_size;
  }

  if (!info.is_leaf) {
    info.subroutine_arg_top = info.allocated_stack_size;
    for (const node of flow_graph.nodes) {
      for (const inst of node.block.instructions) {
        const arch_mnemonic = inst.arch_mnemonic(arch);
        if (inst.is_load) {
          for (const arg of inst.args) {
            if (arg instanceof AsmAddressMode && info.is_stack_reg(arg.base) && arg.addend instanceof AsmLiteral) {
              const offset = band(arg.addend.value, -4);
              if (offset >= arch.home_space_size) info.subroutine_arg_top = Math.min(info.subroutine_arg_top, offset);
            }
          }
        }
        if (
          ["mips:addiu", "ppc:addi", "arm:add"].includes(arch_mnemonic) &&
          inst.args[1] instanceof Register &&
          info.is_stack_reg(inst.args[1]) &&
          inst.args[0] instanceof Register &&
          !info.is_stack_reg(inst.args[0]) &&
          inst.args[2] instanceof AsmLiteral &&
          inst.args[2].value < info.allocated_stack_size
        ) {
          info.subroutine_arg_top = Math.min(info.subroutine_arg_top, inst.args[2].value);
        }
        if (arch_mnemonic === "arm:mov" && inst.args[1] instanceof Register && info.is_stack_reg(inst.args[1]) && inst.args[0] instanceof Register && !info.is_stack_reg(inst.args[0])) {
          info.subroutine_arg_top = 0;
        }
      }
    }
  }

  if (callee_saved_offsets.length) {
    callee_saved_offsets.sort((a, b) => a - b);
    const bottom = callee_saved_offsets[0];
    let top = bottom;
    let internal_padding_added = false;
    let has_warned = false;
    for (const offset of callee_saved_offsets) {
      while (top < offset && allowed_callee_save_gaps.has(top)) top += 4;
      if (offset !== top) {
        if (!internal_padding_added && offset === top + 4) internal_padding_added = true;
        else if (!has_warned) {
          has_warned = true;
          info.warnings.push(`Gap in callee-saved word stack region.\n` + `Saved: [${callee_saved_offsets.map((o) => hex(o)).join(", ")}], ` + `gap at: ${hex(top)}.`);
        }
      }
      top = offset + 4;
    }
    info.callee_save_reg_region = [bottom, top];
    info.subroutine_arg_top = Math.min(info.subroutine_arg_top, bottom);
  }

  const stack_struct_name = `_m2c_stack_${fn.name}`;
  let stack_struct = global_info.typepool.get_struct_by_tag_name(stack_struct_name, global_info.typemap);
  if (stack_struct !== null) {
    if (stack_struct.size !== info.allocated_stack_size) {
      throw new DecompFailure(
        `Function ${fn.name} has a provided stack type ${stack_struct_name} ` + `with size ${stack_struct.size}, but the detected stack size was ` + `${info.allocated_stack_size}.`,
      );
    }
  } else {
    stack_struct = StructDeclaration.unknown(global_info.typepool, info.allocated_stack_size, stack_struct_name);
  }
  stack_struct.is_stack = true;
  stack_struct.new_field_prefix = "sp";
  info.stack_pointer_type = Type.ptr(Type.struct(stack_struct));
  return info;
}

export function format_hex(val) {
  return format(val, "x").toUpperCase();
}

const ESCAPE_TABLE = new Map([
  [0, "\\0"],
  [8, "\\b"],
  [12, "\\f"],
  [10, "\\n"],
  [13, "\\r"],
  [9, "\\t"],
  [11, "\\v"],
  [0x5c, "\\\\"],
  [0x22, '\\"'],
]);

/** Returns the escaped byte as an array of byte values. */
export function escape_byte(b) {
  if (ESCAPE_TABLE.has(b)) return [...ESCAPE_TABLE.get(b)].map((c) => c.charCodeAt(0));
  if (b < 0x20 || b === 0xff || b === 0x7f) return [..."\\x" + b.toString(16).padStart(2, "0")].map((c) => c.charCodeAt(0));
  return [b];
}

export class Var {
  static __fields = [["stack_info"], ["prefix"], ["is_planned"], ["type"], ["is_emitted", false], ["name", null], ["debug_exprs", factory(() => [])]];
  constructor(...args) {
    dcinit(this, args);
  }
  format(fmt) {
    pyassert(this.is_emitted);
    if (this.name === null) this.name = this.stack_info.temp_var(this.prefix);
    return this.name;
  }
  toString() {
    return `<var: ${objId(this)}>`;
  }
}

export class Expression {
  dependencies() {
    throw new Error("abstract");
  }
  /** Mark an expression as "will occur in the output". */
  use() {
    for (const expr of this.dependencies()) expr.use();
  }
  format(fmt) {
    throw new Error("abstract");
  }
  toString() {
    const fmt = new Formatter({ debug: true });
    return '"' + this.format(fmt) + '"';
  }
}

export class Condition extends Expression {
  negated() {
    throw new Error("abstract");
  }
}

export class Statement {
  should_write() {
    throw new Error("abstract");
  }
  format(fmt) {
    throw new Error("abstract");
  }
  toString() {
    const fmt = new Formatter({ debug: true });
    return '"' + this.format(fmt) + '"';
  }
}

export class ErrorExpr extends Condition {
  static __fields = [["desc", null], ["type", factory(() => Type.any_reg())]];
  constructor(...args) {
    super();
    dcinit(this, args);
  }
  dependencies() {
    return [];
  }
  negated() {
    return this;
  }
  format(fmt) {
    if (this.desc !== null) return `M2C_ERROR(/* ${this.desc} */)`;
    return "M2C_ERROR()";
  }
}

export class CommentExpr extends Expression {
  static __fields = [["expr"], ["type"], ["prefix", null], ["suffix", null]];
  static __eq_fields = ["expr", "prefix", "suffix"];
  constructor(...args) {
    super();
    dcinit(this, args);
  }
  dependencies() {
    return [this.expr];
  }
  format(fmt) {
    const expr_str = this.expr.format(fmt);
    if (fmt.coding_style.comment_style === CodingStyle.CommentStyle.NONE) return expr_str;
    const prefix_str = this.prefix !== null ? `/* ${this.prefix} */ ` : "";
    const suffix_str = this.suffix !== null ? ` /* ${this.suffix} */` : "";
    return `${prefix_str}${expr_str}${suffix_str}`;
  }
  static wrap(expr, prefix = null, suffix = null) {
    if (prefix === null && suffix === null) return expr;
    return new CommentExpr({ expr, type: expr.type, prefix, suffix });
  }
}

export class SecondF64Half extends Expression {
  static __fields = [["type", factory(() => Type.any_reg())]];
  constructor(...args) {
    super();
    dcinit(this, args);
  }
  dependencies() {
    return [];
  }
  format(fmt) {
    return "(second half of f64)";
  }
}

export class CarryBit extends Expression {
  static __fields = [["expr", null], ["type", factory(() => Type.intish())]];
  constructor(...args) {
    super();
    dcinit(this, args);
  }
  dependencies() {
    return this.expr !== null ? [this.expr] : [];
  }
  format(fmt) {
    if (this.expr !== null) return `M2C_CARRY(${this.expr.format(fmt)})`;
    return "M2C_CARRY";
  }
}

function swap_lt_gt(op) {
  return [...op].map((c) => (c === "<" ? ">" : c === ">" ? "<" : c)).join("");
}

export class BinaryOp extends Condition {
  static __fields = [["left"], ["op"], ["right"], ["type"]];
  constructor(...args) {
    super();
    dcinit(this, args);
  }
  static int(left, op, right) {
    return new BinaryOp({ left: as_intish(left), op, right: as_intish(right), type: Type.intish() });
  }
  static int64(left, op, right) {
    return new BinaryOp({ left: as_int64(left), op, right: as_int64(right), type: Type.int64() });
  }
  static intptr(left, op, right) {
    return new BinaryOp({ left: as_intptr(left), op, right: as_intptr(right), type: Type.intptr() });
  }
  static icmp(left, op, right) {
    return new BinaryOp({ left: as_intptr(left), op, right: as_intptr(right), type: Type.boolean() });
  }
  static scmp(left, op, right) {
    return new BinaryOp({ left: as_sintish(left, { silent: true }), op, right: as_sintish(right, { silent: true }), type: Type.boolean() });
  }
  static sintptr_cmp(left, op, right) {
    return new BinaryOp({ left: as_type(left, Type.sintptr(), false), op, right: as_type(right, Type.sintptr(), false), type: Type.boolean() });
  }
  static ucmp(left, op, right) {
    return new BinaryOp({ left: as_uintish(left), op, right: as_uintish(right), type: Type.boolean() });
  }
  static uintptr_cmp(left, op, right) {
    return new BinaryOp({ left: as_type(left, Type.uintptr(), false), op, right: as_type(right, Type.uintptr(), false), type: Type.boolean() });
  }
  static fcmp(left, op, right) {
    return new BinaryOp({ left: as_f32(left), op, right: as_f32(right), type: Type.boolean() });
  }
  static dcmp(left, op, right) {
    return new BinaryOp({ left: as_f64(left), op, right: as_f64(right), type: Type.boolean() });
  }
  static sint(left, op, right, { silent = false } = {}) {
    return new BinaryOp({ left: as_sintish(left, { silent }), op, right: as_sintish(right, { silent }), type: Type.s32() });
  }
  static uint(left, op, right) {
    return new BinaryOp({ left: as_uintish(left), op, right: as_uintish(right), type: Type.u32() });
  }
  static sshift(left, op, right) {
    return new BinaryOp({ left: as_sintish(left), op, right: as_intish(right), type: Type.s32() });
  }
  static ushift(left, op, right) {
    return new BinaryOp({ left: as_uintish(left), op, right: as_intish(right), type: Type.u32() });
  }
  static s64(left, op, right) {
    return new BinaryOp({ left: as_s64(left), op, right: as_s64(right), type: Type.s64() });
  }
  static u64(left, op, right) {
    return new BinaryOp({ left: as_u64(left), op, right: as_u64(right), type: Type.u64() });
  }
  static f32(left, op, right) {
    return new BinaryOp({ left: as_f32(left), op, right: as_f32(right), type: Type.f32() });
  }
  static f64(left, op, right) {
    return new BinaryOp({ left: as_f64(left), op, right: as_f64(right), type: Type.f64() });
  }

  is_comparison() {
    return ["==", "!=", ">", "<", ">=", "<="].includes(this.op);
  }
  is_floating() {
    return this.left.type.is_float() && this.right.type.is_float();
  }
  negated() {
    if ((this.op === "&&" || this.op === "||") && this.left instanceof Condition && this.right instanceof Condition) {
      return new BinaryOp({ left: this.left.negated(), op: { "&&": "||", "||": "&&" }[this.op], right: this.right.negated(), type: Type.boolean() });
    }
    if (!this.is_comparison() || (this.is_floating() && ["<", ">", "<=", ">="].includes(this.op))) {
      return new UnaryOp("!", this, { type: Type.boolean() });
    }
    return new BinaryOp({ left: this.left, op: { "==": "!=", "!=": "==", ">": "<=", "<": ">=", ">=": "<", "<=": ">" }[this.op], right: this.right, type: Type.boolean() });
  }
  dependencies() {
    return [this.left, this.right];
  }
  normalize_for_formatting() {
    const right_expr = late_unwrap(this.right);
    if (!this.is_floating() && right_expr instanceof Literal && right_expr.value < 0) {
      if (this.op === "+") {
        const neg = new Literal({ value: -right_expr.value, type: right_expr.type });
        return new BinaryOp({ op: "-", left: this.left, right: neg, type: this.type });
      }
      if (this.op === "&" || this.op === "|") {
        const neg = new Literal({ value: bnot(right_expr.value), type: right_expr.type });
        const right = new UnaryOp("~", neg, { type: Type.any_reg() });
        return new BinaryOp({ op: this.op, left: this.left, right, type: this.type });
      }
    }
    return this;
  }
  format(fmt) {
    const left_expr = late_unwrap(this.left);
    let right_expr = late_unwrap(this.right);

    const adj = this.normalize_for_formatting();
    if (adj !== this) return adj.format(fmt);

    if (this.is_comparison() && left_expr instanceof Literal && !(right_expr instanceof Literal)) {
      return new BinaryOp({ left: right_expr, op: swap_lt_gt(this.op), right: left_expr, type: this.type }).format(fmt);
    }

    if ((this.op === "==" || this.op === "!=") && right_expr instanceof Literal) {
      right_expr = elide_literal_casts(as_type(right_expr, left_expr.type, true));
    }

    let lhs = left_expr.format(fmt);
    if (left_expr instanceof BinaryOp && left_expr.op === this.op && ASSOCIATIVE_OPS.has(this.op)) lhs = lhs.slice(1, -1);

    let rhs;
    if ((this.op === "/" || this.op === "%") && right_expr instanceof Literal) rhs = right_expr.format(fmt, true);
    else rhs = right_expr.format(fmt);

    if (PSEUDO_FUNCTION_OPS.has(this.op)) return `${this.op}(${lhs}, ${rhs})`;
    return `(${lhs} ${this.op} ${rhs})`;
  }
}

export class TernaryOp extends Expression {
  static __fields = [["cond"], ["left"], ["right"], ["type"]];
  constructor(...args) {
    super();
    dcinit(this, args);
  }
  dependencies() {
    return [this.cond, this.left, this.right];
  }
  format(fmt) {
    const cond_str = simplify_condition(this.cond).format(fmt);
    const left_str = this.left.format(fmt);
    const right_str = this.right.format(fmt);
    return `(${cond_str} ? ${left_str} : ${right_str})`;
  }
}

export class UnaryOp extends Condition {
  static __fields = [["op"], ["expr"], ["type"]];
  constructor(...args) {
    super();
    dcinit(this, args);
  }
  dependencies() {
    return [this.expr];
  }
  static int(op, expr) {
    return new UnaryOp({ op, expr: as_intish(expr), type: expr.type });
  }
  static sint(op, expr) {
    expr = as_sintish(expr, { silent: true });
    return new UnaryOp({ op, expr, type: expr.type });
  }
  negated() {
    if (this.op === "!" && (this.expr instanceof UnaryOp || this.expr instanceof BinaryOp)) return this.expr;
    return new UnaryOp("!", this, { type: Type.boolean() });
  }
  format(fmt) {
    if (PSEUDO_FUNCTION_OPS.has(this.op)) return `${this.op}(${format_expr(this.expr, fmt)})`;
    return `${this.op}${this.expr.format(fmt)}`;
  }
}

export class ExprCondition extends Condition {
  static __fields = [["expr"], ["type"], ["is_negated", false]];
  constructor(...args) {
    super();
    dcinit(this, args);
  }
  dependencies() {
    return [this.expr];
  }
  negated() {
    return new ExprCondition(this.expr, this.type, !this.is_negated);
  }
  format(fmt) {
    const neg = this.is_negated ? "!" : "";
    return `${neg}${this.expr.format(fmt)}`;
  }
}

const COMMA_CONDITION_DEFAULT_TYPE = Type.boolean();

export class CommaConditionExpr extends Condition {
  static __fields = [["statements"], ["condition"], ["type", COMMA_CONDITION_DEFAULT_TYPE]];
  constructor(...args) {
    super();
    dcinit(this, args);
  }
  dependencies() {
    pyassert(false, "CommaConditionExpr should not be used within translate.py");
    return [];
  }
  negated() {
    return new CommaConditionExpr(this.statements, this.condition.negated());
  }
  format(fmt) {
    const comma_joined = this.statements.map((stmt) => rstrip(stmt.format(fmt), ";")).join(", ");
    return `(${comma_joined}, ${this.condition.format(fmt)})`;
  }
}

export class Cast extends Expression {
  static __fields = [["expr"], ["type"], ["reinterpret", false], ["silent", true]];
  static __eq_fields = ["expr", "reinterpret", "silent"];
  constructor(...args) {
    super();
    dcinit(this, args);
  }
  dependencies() {
    return [this.expr];
  }
  use() {
    this.expr.type.unify(this.type);
    super.use();
  }
  needed_for_store() {
    if (!this.reinterpret) return true;
    if (!this.expr.type.unify(this.type)) return true;
    return false;
  }
  should_wrap_transparently() {
    return this.reinterpret && this.expr.type.is_float() === this.type.is_float() && should_wrap_transparently(this.expr);
  }
  format(fmt) {
    if (this.reinterpret && this.expr.type.is_float() !== this.type.is_float()) {
      if (fmt.valid_syntax) return `M2C_BITWISE(${this.type.format(fmt)}, ${this.expr.format(fmt)})`;
      return `(bitwise ${this.type.format(fmt)}) ${this.expr.format(fmt)}`;
    }
    if (this.reinterpret && (this.silent || (is_type_obvious(this.expr) && this.expr.type.unify(this.type)))) return this.expr.format(fmt);
    if (fmt.skip_casts) return this.expr.format(fmt);
    const fn_sig = this.type.get_function_pointer_signature();
    if (fn_sig) return `((${this.type.format(fmt)}) ${this.expr.format(fmt)})`;
    return `(${this.type.format(fmt)}) ${this.expr.format(fmt)}`;
  }
}

export class FuncCall extends Expression {
  static __fields = [["function"], ["args"], ["type"]];
  constructor(...args) {
    super();
    dcinit(this, args);
  }
  dependencies() {
    return [...this.args, this.function];
  }
  format(fmt) {
    const target = late_unwrap(this.function);
    const fn_sig = target.type.get_function_pointer_signature();
    if (fn_sig && target instanceof Cast && target.reinterpret) {
      const prototype_sig = target.expr.type.get_function_pointer_signature();
      if (prototype_sig && prototype_sig.unify_with_args(fn_sig)) {
        return new Cast(new FuncCall(target.expr, this.args, prototype_sig.return_type), this.type, { reinterpret: true, silent: true }).format(fmt);
      }
    }
    const args = this.args.map((arg) => format_expr(arg, fmt)).join(", ");
    return `${target.format(fmt)}(${args})`;
  }
}

export class LocalVar extends Expression {
  static __fields = [["value"], ["type"], ["path"]];
  static __eq_fields = ["value"];
  constructor(...args) {
    super();
    dcinit(this, args);
  }
  dependencies() {
    return [];
  }
  format(fmt) {
    const fallback_name = `unksp${format_hex(this.value)}`;
    if (this.path === null) return fallback_name;
    const name = StructAccess.access_path_to_field_name(this.path, fmt);
    if (name.startsWith("->")) return name.slice(2);
    return fallback_name;
  }
  /** Return a declaration for this LocalVar, if required. */
  toplevel_decl(fmt) {
    if (this.path === null || this.path.length !== 2 || typeof this.path[1] !== "string") return null;
    return this.type.to_decl(this.path[1], fmt);
  }
}

export class PlannedPhiExpr extends Expression {
  static __fields = [["var"], ["type"], ["sources"]];
  constructor(...args) {
    super();
    dcinit(this, args);
  }
  dependencies() {
    return [];
  }
  format(fmt) {
    return this.var.format(fmt);
  }
}

export class PassedInArg extends Expression {
  static __fields = [["loc"], ["stack_info"], ["type"]];
  static __eq_fields = ["loc"];
  constructor(...args) {
    super();
    dcinit(this, args);
  }
  dependencies() {
    return [];
  }
  format(fmt) {
    const name = this.stack_info.get_param_name(this.loc);
    if (name) return name;
    return this.stack_info.global_info.arch.arg_name(this.loc);
  }
}

export class SubroutineArg extends Expression {
  static __fields = [["value"], ["type"]];
  static __eq_fields = ["value"];
  constructor(...args) {
    super();
    dcinit(this, args);
  }
  dependencies() {
    return [];
  }
  format(fmt) {
    return `subroutine_arg${format_hex(floordiv(this.value, 4))}`;
  }
}

/**
 * Represents struct_var->offset. eq=True since it represents a live expression.
 */
export class StructAccess extends Expression {
  static __fields = [["struct_var"], ["offset"], ["target_size"], ["field_path"], ["stack_info"], ["type"], ["checked_late_field_path", false]];
  static __eq_fields = ["struct_var", "offset", "target_size"];
  constructor(...args) {
    super();
    dcinit(this, args);
    pyassert(this.stack_info !== null || this.field_path !== null, "Must provide at least one of (stack_info, field_path)");
    StructAccess.assert_valid_field_path(this.field_path);
  }
  static assert_valid_field_path(path) {
    pyassert(path === null || (path.length && typeof path[0] === "number"), "The first element of the field path, if present, must be an int");
  }
  /** Convert an access path into a dereferencing field name. */
  static access_path_to_field_name(path, fmt) {
    StructAccess.assert_valid_field_path(path);
    let output = "";
    if (path.length >= 2 && path[0] === 0 && typeof path[1] === "string") {
      output += `->${path[1]}`;
      path = path.slice(2);
    }
    for (const p of path) {
      if (typeof p === "string") output += `.${p}`;
      else if (typeof p === "number") output += `[${fmt.format_int(p)}]`;
      else assert_never(p);
    }
    return output;
  }
  dependencies() {
    return [this.struct_var];
  }
  make_reference() {
    const field_path = this.late_field_path();
    if (field_path && field_path.length >= 2 && field_path[field_path.length - 1] === 0) return dcreplace(this, { field_path: field_path.slice(0, -1) });
    return null;
  }
  late_field_path() {
    if (this.field_path === null && !this.checked_late_field_path) {
      const v = late_unwrap(this.struct_var);
      v.format(new Formatter());
      const [field_path, field_type] = v.type.get_deref_field(this.offset, { target_size: this.target_size });
      if (field_path !== null) {
        StructAccess.assert_valid_field_path(field_path);
        this.field_path = field_path;
        this.type.unify(field_type);
      }
      this.checked_late_field_path = true;
    }
    return this.field_path;
  }
  late_has_known_type() {
    if (this.late_field_path() !== null) return true;
    pyassert(this.stack_info !== null, "StructAccess must have stack_info if field_path isn't set");
    if (this.offset === 0) {
      const v = late_unwrap(this.struct_var);
      if (!this.stack_info.has_nonzero_access(v) && v instanceof AddressOf && v.expr instanceof GlobalSymbol && v.expr.type_provided) return true;
    }
    return false;
  }
  format(fmt) {
    let v = late_unwrap(this.struct_var);
    let has_nonzero_access = false;
    if (this.stack_info !== null) has_nonzero_access = this.stack_info.has_nonzero_access(v);

    let field_path = this.late_field_path();

    if (field_path !== null && !(field_path.length === 1 && field_path[0] === 0)) {
      has_nonzero_access = true;
    } else if (fmt.valid_syntax && (this.offset !== 0 || has_nonzero_access)) {
      const offset_str = fmt.format_int(this.offset);
      return `M2C_FIELD(${v.format(fmt)}, ${Type.ptr(this.type).format(fmt)}, ${offset_str})`;
    } else {
      const prefix = "unk" + (fmt.coding_style.unknown_underscore ? "_" : "");
      field_path = [0, prefix + format_hex(this.offset)];
    }
    let field_name = StructAccess.access_path_to_field_name(field_path, fmt);

    let deref = true;
    if (v instanceof AddressOf && !v.expr.type.is_array() && !(v.expr instanceof GlobalSymbol && v.expr.is_string_constant()) && field_name.startsWith("->")) {
      v = v.expr;
      field_name = field_name.replace("->", ".");
      deref = false;
    }

    if (this.offset === 0 && !has_nonzero_access) return `${deref ? "*" : ""}${v.format(fmt)}`;
    return `${parenthesize_for_struct_access(v, fmt)}${field_name}`;
  }
}

export class ArrayAccess extends Expression {
  static __fields = [["ptr"], ["index"], ["type"]];
  static __eq_fields = ["ptr", "index"];
  constructor(...args) {
    super();
    dcinit(this, args);
  }
  dependencies() {
    return [this.ptr, this.index];
  }
  format(fmt) {
    const base = parenthesize_for_struct_access(this.ptr, fmt);
    const index = format_expr(this.index, fmt);
    return `${base}[${index}]`;
  }
}

export class GlobalSymbol extends Expression {
  static __fields = [
    ["c_symbol_name"],
    ["type"],
    ["asm_data_entry", null],
    ["symbol_in_context", false],
    ["type_provided", false],
    ["initializer_in_typemap", false],
    ["demangled_str", null],
    ["is_referenced", false],
  ];
  constructor(...args) {
    super();
    dcinit(this, args);
  }
  dependencies() {
    return [];
  }
  use() {
    this.is_referenced = true;
  }
  is_string_constant() {
    const ent = this.asm_data_entry;
    if (!ent || ent.data.length !== 1 || !(ent.data[0] instanceof Uint8Array)) return false;
    return ent.is_string;
  }
  format_string_constant(fmt) {
    pyassert(this.is_string_constant(), "checked by caller");
    let has_trailing_null = false;
    let data = this.asm_data_entry.data[0];
    let end = data.length;
    while (end > 0 && data[end - 1] === 0) {
      end -= 1;
      has_trailing_null = true;
    }
    const escaped = [];
    for (let i = 0; i < end; i++) escaped.push(...escape_byte(data[i]));
    const strdata = decode_utf8_backslashreplace(Uint8Array.from(escaped));
    let ret = `"${strdata}"`;
    if (!has_trailing_null) ret += " /* not null-terminated */";
    return ret;
  }
  format(fmt) {
    return this.c_symbol_name;
  }
  /** Returns [array_dim, extra_bytes]. */
  potential_array_dim(element_size) {
    pyassert(element_size !== 0, "potential_array_dim cannot be called on zero size");
    if (this.asm_data_entry === null || this.asm_data_entry.is_jtbl) return [0, element_size];
    const [min_data_size, max_data_size] = this.asm_data_entry.size_range_bytes();
    if (element_size > max_data_size) return [0, max_data_size];
    if (min_data_size <= element_size && element_size <= max_data_size && !this.type.is_array()) return [1, 0];
    const array_dim = floordiv(min_data_size, element_size);
    const extra_bytes = pymod(min_data_size, element_size);
    if (extra_bytes !== 0) {
      const padding_bytes = element_size - extra_bytes;
      if (min_data_size + padding_bytes > max_data_size) return [array_dim, extra_bytes];
    }
    return [floordiv(max_data_size, element_size), 0];
  }
}

/** bytes.decode("utf-8", "backslashreplace") */
export function decode_utf8_backslashreplace(bytes) {
  let out = "";
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i];
    let n = 0;
    let cp = 0;
    if (b < 0x80) {
      out += String.fromCharCode(b);
      i++;
      continue;
    } else if (b >= 0xc2 && b <= 0xdf) {
      n = 1;
      cp = b & 0x1f;
    } else if (b >= 0xe0 && b <= 0xef) {
      n = 2;
      cp = b & 0x0f;
    } else if (b >= 0xf0 && b <= 0xf4) {
      n = 3;
      cp = b & 0x07;
    } else {
      out += "\\x" + b.toString(16).padStart(2, "0");
      i++;
      continue;
    }
    let ok = i + n < bytes.length + 0 && i + n <= bytes.length - 1 + 1;
    let j = 1;
    for (; j <= n; j++) {
      const c = bytes[i + j];
      if (c === undefined || (c & 0xc0) !== 0x80) {
        ok = false;
        break;
      }
      // Reject overlongs / surrogates / out of range like CPython's decoder
      if (j === 1) {
        if (b === 0xe0 && c < 0xa0) ok = false;
        if (b === 0xed && c > 0x9f) ok = false;
        if (b === 0xf0 && c < 0x90) ok = false;
        if (b === 0xf4 && c > 0x8f) ok = false;
        if (!ok) break;
      }
      cp = (cp << 6) | (c & 0x3f);
    }
    if (!ok || j <= n) {
      out += "\\x" + b.toString(16).padStart(2, "0");
      i++;
      continue;
    }
    out += String.fromCodePoint(cp);
    i += n + 1;
  }
  return out;
}

export class Literal extends Expression {
  static __fields = [["value"], ["type", factory(() => Type.any())], ["elide_cast", false]];
  static __eq_fields = ["value"];
  constructor(...args) {
    super();
    dcinit(this, args);
  }
  dependencies() {
    return [];
  }
  format(fmt, force_dec = false) {
    const enum_name = this.type.get_enum_name(this.value);
    if (enum_name !== null) return enum_name;

    if (this.type.is_likely_float()) {
      if (this.type.get_size_bits() === 64) return format_f64_imm(this.value);
      return format_f32_imm(this.value) + "f";
    }
    if (this.type.is_pointer() && this.value === 0) return "NULL";

    let prefix = "";
    let suffix = "";
    if (!fmt.skip_casts && !this.elide_cast) {
      if (this.type.is_pointer()) prefix = `(${this.type.format(fmt)})`;
      if (this.type.is_unsigned()) suffix = "U";
    }

    let value;
    if (force_dec) value = str(this.value);
    else {
      const size_bits = this.type.get_size_bits();
      let v = this.value;
      if (this.type.is_signed() && size_bits && band(v, shl(1, size_bits - 1)) && v > shl(3, size_bits - 2) && v < 2 ** size_bits) {
        v -= shl(1, size_bits);
      }
      value = fmt.format_int(v, size_bits);
    }
    return prefix + value + suffix;
  }
}

export class AddressOf extends Expression {
  static __fields = [["expr"], ["type", factory(() => Type.ptr())]];
  static __eq_fields = ["expr"];
  constructor(...args) {
    super();
    dcinit(this, args);
  }
  dependencies() {
    return [this.expr];
  }
  format(fmt) {
    if (this.expr instanceof GlobalSymbol) {
      if (this.expr.is_string_constant()) return this.expr.format_string_constant(fmt);
    }
    if (this.expr.type.is_array()) return `${this.expr.format(fmt)}`;
    if (this.expr.type.is_function()) return `${this.expr.format(fmt)}`;
    if (this.expr instanceof StructAccess) {
      const ref = this.expr.make_reference();
      if (ref) return `${ref.format(fmt)}`;
    }
    return `&${this.expr.format(fmt)}`;
  }
}

export class Lwl extends Expression {
  static __fields = [["load_expr"], ["key"], ["type", factory(() => Type.any_reg())]];
  static __eq_fields = ["load_expr", "key"];
  constructor(...args) {
    super();
    dcinit(this, args);
  }
  dependencies() {
    return [this.load_expr];
  }
  format(fmt) {
    return `M2C_LWL(${this.load_expr.format(fmt)})`;
  }
}

export class Load3Bytes extends Expression {
  static __fields = [["load_expr"], ["type", factory(() => Type.any_reg())]];
  static __eq_fields = ["load_expr"];
  constructor(...args) {
    super();
    dcinit(this, args);
  }
  dependencies() {
    return [this.load_expr];
  }
  format(fmt) {
    if (fmt.valid_syntax) return `M2C_FIRST3BYTES(${this.load_expr.format(fmt)})`;
    return `(first 3 bytes) ${this.load_expr.format(fmt)}`;
  }
}

export class UnalignedLoad extends Expression {
  static __fields = [["load_expr"], ["type", factory(() => Type.any_reg())]];
  static __eq_fields = ["load_expr"];
  constructor(...args) {
    super();
    dcinit(this, args);
  }
  dependencies() {
    return [this.load_expr];
  }
  format(fmt) {
    if (fmt.valid_syntax) return `M2C_UNALIGNED32(${this.load_expr.format(fmt)})`;
    return `(unaligned s32) ${this.load_expr.format(fmt)}`;
  }
}

export class EvalOnceExpr extends Expression {
  static __fields = [
    ["wrapped_expr"],
    ["var"],
    ["type"],
    ["sources"],
    ["emit_exactly_once"],
    ["trivial"],
    ["transparent"],
    ["is_fictive_temp"],
    ["forced_emit", false],
    ["is_used", false],
  ];
  constructor(...args) {
    super();
    dcinit(this, args);
  }
  dependency(may_move_forward) {
    if (this.trivial) return this.wrapped_expr;
    if (this.var.is_emitted) return null;
    if (!this.transparent && this.is_used && !may_move_forward) return null;
    return this.wrapped_expr;
  }
  dependencies() {
    pyassert(false, "never called, and it's unclear what to pass for may_move_forward");
  }
  use() {
    if (this.trivial || (this.transparent && !this.var.is_emitted)) {
      this.wrapped_expr.use();
    } else if (!this.is_used) {
      if (!this.emit_exactly_once) this.wrapped_expr.use();
    } else {
      this.var.is_emitted = true;
    }
    this.is_used = true;
  }
  force() {
    if (!this.forced_emit && !this.trivial) {
      this.forced_emit = true;
      this.var.is_emitted = true;
      this.use();
      this.use();
    }
  }
  uses_var() {
    return this.var.is_emitted && !this.trivial;
  }
  format(fmt) {
    if (!this.uses_var()) return this.wrapped_expr.format(fmt);
    return this.var.format(fmt);
  }
}

/** A NaivePhiExpr acts as a phi node (see upstream docs). */
export class NaivePhiExpr extends Expression {
  static __fields = [["reg"], ["node"], ["type"], ["sources"], ["uses_dominator"], ["used_naive_phis"], ["name", null], ["num_usages", 0], ["replacement_expr", null]];
  constructor(...args) {
    super();
    dcinit(this, args);
  }
  dependencies() {
    return [];
  }
  get_var_name() {
    return this.name || `unnamed-phi(${this.reg.register_name})`;
  }
  use() {
    if (this.num_usages === 0) this.used_naive_phis.push(this);
    this.num_usages += 1;
    if (this.replacement_expr !== null) this.replacement_expr.use();
  }
  format(fmt) {
    if (this.replacement_expr !== null) return this.replacement_expr.format(fmt);
    return this.get_var_name();
  }
}

export class SwitchControl {
  static __fields = [["control_expr"], ["num_cases", null], ["jump_table", null], ["offset", 0], ["is_irregular", false]];
  constructor(...args) {
    dcinit(this, args);
  }
  /** Return true if `cond` is the bounds check before using `jump_table`. */
  matches_guard_condition(cond) {
    const cmp_expr = simplify_condition(cond);
    if (!(cmp_expr instanceof BinaryOp) || !(cmp_expr.op === ">=" || cmp_expr.op === ">")) return false;
    const cmp_exclusive = cmp_expr.op === ">";
    const left_expr = late_unwrap_ints(cmp_expr.left);
    if (this.offset !== 0) {
      if (
        !(left_expr instanceof BinaryOp) ||
        !pyeq(late_unwrap(left_expr.left), late_unwrap(this.control_expr)) ||
        left_expr.op !== "+" ||
        !pyeq(late_unwrap(left_expr.right), new Literal(-this.offset))
      ) {
        return false;
      }
    } else if (!pyeq(left_expr, late_unwrap_ints(this.control_expr))) return false;
    const right_expr = late_unwrap(cmp_expr.right);
    if (!(right_expr instanceof Literal)) return false;
    return right_expr.value + (cmp_exclusive ? 1 : 0) === this.num_cases;
  }
  static irregular_from_expr(control_expr) {
    return new SwitchControl({ control_expr, offset: 0, is_irregular: true });
  }
  static from_expr(expr, num_cases) {
    const error_expr = new SwitchControl(expr);
    const struct_expr = early_unwrap(expr);
    if (!(struct_expr instanceof StructAccess) || struct_expr.offset !== 0) return error_expr;
    const add_expr = early_unwrap(struct_expr.struct_var);
    if (!(add_expr instanceof BinaryOp) || add_expr.op !== "+") return error_expr;
    const left_expr = early_unwrap(add_expr.left);
    const right_expr = early_unwrap(add_expr.right);
    let jtbl_addr_expr, mul_expr;
    if (left_expr instanceof AddressOf && left_expr.expr instanceof GlobalSymbol) {
      jtbl_addr_expr = left_expr;
      mul_expr = right_expr;
    } else if (right_expr instanceof AddressOf && right_expr.expr instanceof GlobalSymbol) {
      mul_expr = left_expr;
      jtbl_addr_expr = right_expr;
    } else return error_expr;
    const jump_table = jtbl_addr_expr.expr;
    pyassert(jump_table instanceof GlobalSymbol);
    if (!(mul_expr instanceof BinaryOp) || mul_expr.op !== "*" || !pyeq(early_unwrap(mul_expr.right), new Literal(4))) return error_expr;
    let control_expr = mul_expr.left;
    let offset = 0;
    const uw_control_expr = early_unwrap(control_expr);
    if (uw_control_expr instanceof BinaryOp && uw_control_expr.op === "+") {
      const offset_lit = early_unwrap(uw_control_expr.right);
      if (offset_lit instanceof Literal) {
        control_expr = uw_control_expr.left;
        offset = -offset_lit.value;
      }
    }
    if (jump_table.asm_data_entry === null || !jump_table.asm_data_entry.is_jtbl) return error_expr;
    return new SwitchControl(control_expr, num_cases, jump_table, offset);
  }
}

export class EvalOnceStmt extends Statement {
  static __fields = [["expr"]];
  constructor(...args) {
    super();
    dcinit(this, args);
  }
  should_write() {
    if (this.expr.emit_exactly_once && !this.expr.is_used) return true;
    if (!this.expr.var.is_emitted) return false;
    if (var_for_expr(late_unwrap(this.expr.wrapped_expr)) === this.expr.var) return false;
    return true;
  }
  format(fmt) {
    const val = elide_literal_casts(this.expr.wrapped_expr);
    if (this.expr.emit_exactly_once && !this.expr.is_used) {
      const val_str = format_expr(val, fmt);
      return `${val_str};`;
    }
    return format_assignment(this.expr.var, val, fmt);
  }
}

export class SetNaivePhiStmt extends Statement {
  static __fields = [["phi"], ["expr"]];
  constructor(...args) {
    super();
    dcinit(this, args);
  }
  should_write() {
    return !pyeq(late_unwrap(this.expr), this.phi);
  }
  format(fmt) {
    return format_assignment(this.phi, this.expr, fmt);
  }
}

export class ExprStmt extends Statement {
  static __fields = [["expr"]];
  constructor(...args) {
    super();
    dcinit(this, args);
  }
  should_write() {
    return true;
  }
  format(fmt) {
    return `${format_expr(this.expr, fmt)};`;
  }
}

export class StoreStmt extends Statement {
  static __fields = [["source"], ["dest"]];
  constructor(...args) {
    super();
    dcinit(this, args);
  }
  should_write() {
    return true;
  }
  format(fmt) {
    const dest = this.dest;
    let source = this.source;
    if ((dest instanceof StructAccess && dest.late_has_known_type()) || dest instanceof ArrayAccess || dest instanceof LocalVar || dest instanceof SubroutineArg) {
      source = elide_literal_casts(source);
    }
    return format_assignment(dest, source, fmt);
  }
}

export class CommentStmt extends Statement {
  static __fields = [["contents"]];
  constructor(...args) {
    super();
    dcinit(this, args);
  }
  should_write() {
    return true;
  }
  format(fmt) {
    return `// ${this.contents}`;
  }
}

export class AddressMode {
  static __fields = [["offset"], ["base"]];
  static __eq_fields = ["offset", "base"];
  constructor(...args) {
    dcinit(this, args);
  }
  toString() {
    if (this.offset) return `${this.offset}(${this.base})`;
    return `(${this.base})`;
  }
}

export class RawSymbolRef {
  static __fields = [["offset"], ["sym"]];
  static __eq_fields = ["offset", "sym"];
  constructor(...args) {
    dcinit(this, args);
  }
  toString() {
    if (this.offset) return `${this.sym.symbol_name} + ${this.offset}`;
    return this.sym.symbol_name;
  }
}

/** Metadata associated with a register value assignment. */
export class RegMeta {
  static __fields = [
    ["inherited", false],
    ["initial", false],
    ["is_read", false],
    ["function_return", false],
    ["uninteresting", false],
    ["force", false],
    ["in_pattern", false],
  ];
  constructor(...args) {
    dcinit(this, args);
  }
}

export class RegData {
  constructor(value, meta) {
    this.value = value;
    this.meta = meta;
  }
}

export class RegInfo {
  constructor({ stack_info, contents = new Map(), read_inherited = new Set(), _current_instr_ref = null }) {
    this.stack_info = stack_info;
    this.contents = contents;
    this.read_inherited = read_inherited;
    this._current_instr_ref = _current_instr_ref;
  }
  current_instr_ref() {
    pyassert(this._current_instr_ref !== null);
    return this._current_instr_ref;
  }
  current_instr() {
    return this.current_instr_ref().instruction;
  }
  has_current_instr() {
    return this._current_instr_ref !== null;
  }
  /** Python `with regs.set_current_instr(ref): fn()` */
  set_current_instr(instr_ref, fn) {
    pyassert(this._current_instr_ref === null);
    this._current_instr_ref = instr_ref;
    try {
      return set_current_instr(instr_ref.instruction, fn);
    } finally {
      this._current_instr_ref = null;
    }
  }
  /** Python __getitem__ */
  get(key) {
    if (this.has_current_instr() && !this.current_instr().inputs.includes(key)) {
      const lineno = this.get_instruction_lineno();
      return new ErrorExpr(`Read from unset register ${key} on line ${lineno}`);
    }
    if (key === new Register("zero")) return new Literal(0);
    const data = this.contents.get(key) ?? null;
    if (data === null) return new ErrorExpr(`Read from unset register ${key}`);
    const ret = data.value;
    const meta = data.meta;
    meta.is_read = true;
    if (meta.inherited) this.read_inherited.add(key);
    if (ret instanceof EvalOnceExpr && ret.trivial) return ret.wrapped_expr;
    if (meta.initial) {
      const uw_ret = unwrap_deep(ret);
      if (uw_ret instanceof PassedInArg) {
        const arg = this.stack_info.get_argument(uw_ret.loc);
        this.stack_info.add_argument(arg);
        arg.type.unify(ret.type);
      }
    }
    if (meta.force) {
      pyassert(ret instanceof EvalOnceExpr);
      ret.force();
    }
    return ret;
  }
  /** Python __contains__ */
  has(key) {
    return this.contents.has(key);
  }
  /** Assign a value to a register from inside an instruction context. */
  set_with_meta(key, value, meta) {
    const instr = this.current_instr();
    if (!instr.outputs.includes(key)) throw new DecompFailure(`Undeclared write to ${key} in ${instr}`);
    pyassert(key !== new Register("zero"));
    this.contents.set(key, new RegData(value, meta));
  }
  /** Assign a value to a register from outside an instruction context. */
  global_set_with_meta(key, value, meta) {
    pyassert(!this.has_current_instr());
    pyassert(key !== new Register("zero"));
    this.contents.set(key, new RegData(value, meta));
  }
  update_meta(key, meta) {
    pyassert(key !== new Register("zero"));
    if (!this.contents.has(key)) throw new Error(`KeyError: ${key}`);
    this.contents.set(key, new RegData(this.contents.get(key).value, meta));
  }
  /** Python __delitem__ */
  delete(key) {
    pyassert(key !== new Register("zero"));
    if (!this.contents.has(key)) throw new Error(`KeyError: ${key}`);
    this.contents.delete(key);
  }
  get_raw(key) {
    const data = this.contents.get(key) ?? null;
    return data !== null ? data.value : null;
  }
  get_meta(key) {
    const data = this.contents.get(key) ?? null;
    return data !== null ? data.meta : null;
  }
  get_instruction_lineno() {
    if (!this.has_current_instr()) return 0;
    return this.current_instr().meta.lineno;
  }
  toString() {
    return sorted(this.contents.entries(), (x) => x[0].register_name)
      .filter(([, v]) => !this.stack_info.should_save(v.value, null))
      .map(([k, v]) => `${k}: ${v.value}`)
      .join(", ");
  }
}

/** Contains translated assembly code, the block's branch condition, and block's final register states. */
export class BlockInfo {
  static __fields = [["to_write"], ["return_value"], ["switch_control"], ["branch_condition"], ["final_register_states"], ["has_function_call"]];
  constructor(...args) {
    dcinit(this, args);
  }
  toString() {
    const newline = "\n\t";
    return [
      `Statements: ${this.statements_to_write().map((w) => String(w)).join(newline)}`,
      `Branch condition: ${this.branch_condition === null ? "None" : this.branch_condition}`,
      `Final register states: ${this.final_register_states}`,
    ].join("\n");
  }
  statements_to_write() {
    return this.to_write.filter((st) => st.should_write());
  }
}

export function visualize_flowgraph(flow_graph, viz_type) {
  const fmt = new Formatter({ debug: true });
  const nodes = [];
  const edges = [];
  const emit_node = (name, lines) => nodes.push([name, lines]);
  const emit_edge = (source, target, attrs = {}) => edges.push([source, target, attrs]);

  for (const node of flow_graph.nodes) {
    const block_info = _get_optional_block_info(node);
    let asm_lines = [];
    let c_lines = [];
    if (block_info) {
      asm_lines = node.block.instructions.map((i) => `${i.meta.synthetic ? "*" : "&nbsp;"} ${i}`);
      c_lines = block_info.to_write.filter((w) => w.should_write()).map((w) => w.format(fmt));
    }
    if (node instanceof BasicNode) {
      emit_edge(node.name(), node.successor.name(), { color: "black" });
    } else if (node instanceof ConditionalNode) {
      if (block_info) {
        pyassert(block_info.branch_condition !== null);
        c_lines.push(`if (${block_info.branch_condition.format(fmt)})`);
      }
      emit_edge(node.name(), node.fallthrough_edge.name(), { label: "F", color: "blue" });
      emit_edge(node.name(), node.conditional_edge.name(), { label: "T", color: "red" });
    } else if (node instanceof ReturnNode) {
      if (block_info !== null && block_info.return_value) c_lines.push(`return (${block_info.return_value.format(fmt)});`);
      else c_lines.push("return;");
      emit_edge(node.name(), node.terminal.name());
    } else if (node instanceof SwitchNode) {
      pyassert(block_info !== null);
      const switch_control = block_info.switch_control;
      pyassert(switch_control !== null);
      c_lines.push(`switch (${switch_control.control_expr.format(fmt)})`);
      node.cases.forEach((c, i) => emit_edge(node.name(), c.name(), { label: String(i + switch_control.offset), color: "green" }));
    } else {
      pyassert(node instanceof TerminalNode);
      asm_lines.push("// exit");
      c_lines.push("// exit");
    }
    let line_label = "";
    const first_instr = node.block.instructions[0] ?? null;
    if (first_instr !== null && first_instr.meta.lineno > 0) line_label = ` (line ${first_instr.meta.lineno})`;
    let lines = [`// Node ${node.name()}${line_label}`];
    if (viz_type === Options.VisualizeTypeEnum.ASM) lines = lines.concat(asm_lines);
    else if (viz_type === Options.VisualizeTypeEnum.C) lines = lines.concat(c_lines);
    else throw new ValueError("Invalid viz_type: {viz_type!r}");
    emit_node(node.name(), lines);
  }
  const escape = (value) => value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n");
  const quote = (value) => '"' + escape(value) + '"';
  const lines = ["digraph {", '  node [shape="rect", fontname="Monospace"];', '  edge [fontname="Monospace"];'];
  for (const [name, source] of nodes) {
    const label = source.map((line) => escape(line) + "\\l").join("");
    lines.push(`  ${quote(name)} [label="${label}"];`);
  }
  for (const [source, target, attrs] of edges) {
    const attr_strs = Object.entries(attrs).map(([name, value]) => `${name}=${quote(value)}`);
    const attr_text = attr_strs.length ? ` [${attr_strs.join(", ")}]` : "";
    lines.push(`  ${quote(source)} -> ${quote(target)}${attr_text};`);
  }
  lines.push("}");
  return lines.join("\n") + "\n";
}

export function get_block_info_for_block(block) {
  const ret = block.block_info;
  pyassert(ret instanceof BlockInfo);
  return ret;
}
export function get_block_info(node) {
  return get_block_info_for_block(node.block);
}
function _get_optional_block_info(node) {
  if (node.block.block_info === null) return null;
  return get_block_info(node);
}

export class InstrArgs {
  static __fields = [["instruction_ref"], ["raw_args"], ["regs"], ["stack_info"]];
  constructor(...args) {
    dcinit(this, args);
  }
  raw_arg(index) {
    pyassert(index >= 0);
    if (index >= this.raw_args.length) throw new DecompFailure(`Too few arguments for instruction, expected at least ${index + 1}`);
    return this.raw_args[index];
  }
  reg_ref(index) {
    const ret = this.raw_arg(index);
    if (!(ret instanceof Register)) throw new DecompFailure(`Expected instruction argument to be a register, but found ${ret}`);
    return ret;
  }
  imm_value(index) {
    const arg = this.full_imm(index);
    pyassert(arg instanceof Literal);
    return arg.value;
  }
  reg(index) {
    return this.regs.get(this.reg_ref(index));
  }
  /** Extract a double from a register (may read the paired register). */
  dreg(index) {
    const reg = this.reg_ref(index);
    if (this.stack_info.global_info.arch.arch !== Target.ArchEnum.ARM && !reg.is_float()) throw new DecompFailure(`Expected instruction argument ${reg} to be a float register`);
    const ret = this.regs.get(reg);
    if (this.stack_info.global_info.arch.arch === Target.ArchEnum.PPC) return ret;
    if (!(ret instanceof Literal) || ret.type.get_size_bits() === 64) return ret;
    const reg_num = int_(reg.register_name.slice(1));
    if (reg_num % 2 !== 0) throw new DecompFailure("Tried to use a double-precision instruction with odd-numbered float " + `register ${reg}`);
    const other = this.regs.get(new Register(`${reg.register_name[0]}${reg_num + 1}`));
    if (other instanceof Literal && other.type.get_size_bits() !== 64) {
      const value = bor(ret.value, shl(other.value, 32));
      return new Literal(value, { type: Type.f64() });
    }
    ret.type.unify(Type.uintish());
    other.type.unify(Type.uintish());
    return new BinaryOp({ op: "GLUE_F64", left: other, right: ret, type: Type.f64() });
  }
  cmp_reg(key) {
    let cond = this.regs.get(new Register(key));
    if (!(cond instanceof Condition)) cond = BinaryOp.icmp(cond, "!=", new Literal(0));
    return cond;
  }
  full_imm(index) {
    const arg = strip_macros(this.raw_arg(index));
    return literal_expr(arg, this.stack_info);
  }
  s8_imm(index) {
    const ret = this.full_imm(index);
    if (ret instanceof Literal) return new Literal(band(ret.value + 0x80, 0xff) - 0x80);
    return ret;
  }
  s16_imm(index) {
    const ret = this.full_imm(index);
    if (ret instanceof Literal) return new Literal(band(ret.value + 0x8000, 0xffff) - 0x8000);
    return ret;
  }
  u16_imm(index) {
    const ret = this.full_imm(index);
    if (ret instanceof Literal) return new Literal(band(ret.value, 0xffff));
    return ret;
  }
  reg_or_imm(index) {
    const arg = this.raw_arg(index);
    if (arg instanceof Register) return this.regs.get(arg);
    return this.full_imm(index);
  }
  reg_or_s8_imm(index) {
    const arg = this.raw_arg(index);
    if (arg instanceof Register) return this.regs.get(arg);
    return this.s8_imm(index);
  }
  hi_imm(index) {
    const arg = this.raw_arg(index);
    if (!(arg instanceof Macro) || !["hi", "ha", "h"].includes(arg.macro_name)) throw new DecompFailure(`lui/lis argument must be a literal or %hi/@ha/@h macro, found ${arg}`);
    const ref = parse_symbol_ref(arg.argument);
    if (ref === null) throw new DecompFailure(`Invalid macro argument ${arg.argument}`);
    return ref;
  }
  maybe_gprel_imm(index) {
    const val = this.raw_arg(index);
    if (!(val instanceof Macro) || val.macro_name !== "gp_rel") return null;
    const ref = parse_symbol_ref(val.argument);
    if (ref === null) throw new DecompFailure(`Invalid macro argument ${val.argument}`);
    return ref;
  }
  maybe_got_imm(index) {
    const arg = this.raw_arg(index);
    if (!(arg instanceof AsmAddressMode) || arg.base !== new Register("gp")) return null;
    const val = arg.addend;
    if (!(val instanceof Macro) || !["got", "call16"].includes(val.macro_name)) return null;
    const ref = parse_symbol_ref(val.argument);
    if (ref === null) throw new DecompFailure(`Invalid macro argument ${val.argument}`);
    return ref;
  }
  shifted_u16_imm(index) {
    const raw_imm = this.u16_imm(index);
    pyassert(raw_imm instanceof Literal);
    return new Literal(shl(raw_imm.value, 16));
  }
  sym_imm(index) {
    const arg = this.raw_arg(index);
    if (arg instanceof AsmGlobalSymbol) return this.stack_info.global_info.address_of_gsym(arg.symbol_name);
    if (arg instanceof AsmLiteral) return this.full_imm(index);
    throw new DecompFailure(`Bad function call operand ${arg}`);
  }
  memory_ref(index) {
    const ret = strip_macros(this.raw_arg(index));
    const ref = parse_symbol_ref(ret);
    if (ref !== null) return ref;
    if (!(ret instanceof AsmAddressMode)) throw new DecompFailure("Expected instruction argument to be of the form offset($register), " + `but found ${ret}`);
    if (!(ret.addend instanceof AsmLiteral)) throw new DecompFailure(`Unable to parse offset for instruction argument ${ret}. ` + "Expected a constant or a %lo macro.");
    return new AddressMode({ offset: ret.addend.value, base: ret.base });
  }
  count() {
    return this.raw_args.length;
  }
}

/** Compute whether an EvalOnceExpr should be marked as `trivial = True`. */
export function is_trivial_expression(expr) {
  if (expr instanceof Literal || expr instanceof GlobalSymbol || expr instanceof SecondF64Half) return true;
  if (expr instanceof AddressOf) return expr.dependencies().every((e) => is_trivial_expression(e));
  return false;
}

/** Compute whether an EvalOnceExpr should be marked as `transparent = True`. */
export function should_wrap_transparently(expr) {
  if (
    expr instanceof Literal ||
    expr instanceof LocalVar ||
    expr instanceof PassedInArg ||
    expr instanceof NaivePhiExpr ||
    expr instanceof PlannedPhiExpr ||
    expr instanceof SecondF64Half ||
    expr instanceof SubroutineArg
  ) {
    return true;
  }
  if (expr instanceof EvalOnceExpr) return !expr.is_fictive_temp;
  if (expr instanceof GlobalSymbol) return !expr.is_string_constant();
  if (expr instanceof AddressOf) return should_wrap_transparently(expr.expr);
  if (expr instanceof Cast) return expr.should_wrap_transparently();
  if (expr instanceof StructAccess && expr.struct_var instanceof AddressOf && expr.struct_var.expr instanceof GlobalSymbol && should_wrap_transparently(expr.struct_var.expr)) return true;
  return false;
}

/** Determine whether an expression's type is "obvious". */
export function is_type_obvious(expr) {
  if (
    expr instanceof Cast ||
    expr instanceof Literal ||
    expr instanceof AddressOf ||
    expr instanceof LocalVar ||
    expr instanceof NaivePhiExpr ||
    expr instanceof PassedInArg ||
    expr instanceof PlannedPhiExpr ||
    expr instanceof FuncCall
  ) {
    return true;
  }
  if (expr instanceof EvalOnceExpr) {
    if (expr.uses_var()) return true;
    return is_type_obvious(expr.wrapped_expr);
  }
  return false;
}

/** Simplify a boolean expression. */
export function simplify_condition(expr) {
  if (expr instanceof EvalOnceExpr && !expr.uses_var()) return simplify_condition(expr.wrapped_expr);
  if (expr instanceof UnaryOp) {
    const inner = simplify_condition(expr.expr);
    if (expr.op === "!" && inner instanceof Condition) return inner.negated();
    return new UnaryOp({ expr: inner, op: expr.op, type: expr.type });
  }
  if (expr instanceof BinaryOp) {
    const left = simplify_condition(expr.left);
    const right = simplify_condition(expr.right);
    if (left instanceof UnaryOp && left.op === "!" && pyeq(right, new Literal(0))) {
      if (expr.op === "==") return left.expr;
      if (expr.op === "!=") return left;
    }
    if (left instanceof BinaryOp && (left.is_comparison() || left.op === "&") && pyeq(right, new Literal(0))) {
      if (expr.op === "==") return simplify_condition(left.negated());
      if (expr.op === "!=") return left;
    }
    if (expr.is_comparison() && left instanceof Literal && !(right instanceof Literal)) {
      return new BinaryOp({ left: right, op: swap_lt_gt(expr.op), right: left, type: expr.type });
    }
    return new BinaryOp({ left, op: expr.op, right, type: expr.type });
  }
  return expr;
}

/** Check if parentheses in a string are balanced. */
export function balanced_parentheses(string) {
  let bal = 0;
  for (const c of string) {
    if (c === "(") bal += 1;
    else if (c === ")") {
      if (bal === 0) return false;
      bal -= 1;
    }
  }
  return bal === 0;
}

/** Stringify an expression, stripping unnecessary parentheses around it. */
export function format_expr(expr, fmt) {
  const ret = expr.format(fmt);
  if (ret.startsWith("(") && balanced_parentheses(ret.slice(1, -1))) return ret.slice(1, -1);
  return ret;
}

/** Stringify `dest = source;`. */
export function format_assignment(dest, source, fmt) {
  let is_dest;
  if (dest instanceof Expression) {
    dest = late_unwrap(dest);
    const d = dest;
    is_dest = (e) => pyeq(e, d);
  } else {
    const d = dest;
    is_dest = (e) => var_for_expr(e) === d;
  }
  source = late_unwrap(source);
  if (source instanceof BinaryOp && COMPOUND_ASSIGNMENT_OPS.has(source.op)) {
    source = source.normalize_for_formatting();
    let rhs = null;
    if (is_dest(late_unwrap(source.left))) rhs = source.right;
    else if (is_dest(late_unwrap(source.right)) && ASSOCIATIVE_OPS.has(source.op)) rhs = source.left;
    if (rhs !== null) return `${dest.format(fmt)} ${source.op}= ${format_expr(rhs, fmt)};`;
  }
  return `${dest.format(fmt)} = ${format_expr(source, fmt)};`;
}

/** If an expression *may* expand to the read of a Var, return that var. */
export function var_for_expr(expr) {
  if (expr instanceof PlannedPhiExpr) return expr.var;
  if (expr instanceof EvalOnceExpr && !expr.trivial) return expr.var;
  return null;
}

export function parenthesize_for_struct_access(expr, fmt) {
  const s = expr.format(fmt);
  if (s.startsWith("*") || s.startsWith("&") || (expr instanceof Cast && expr.needed_for_store())) return `(${s})`;
  return s;
}

export function elide_literal_casts(expr) {
  const uw_expr = late_unwrap(expr);
  if (uw_expr instanceof Cast && !uw_expr.needed_for_store()) return elide_literal_casts(uw_expr.expr);
  if (uw_expr instanceof Literal && uw_expr.type.is_int() && uw_expr.value >= 0) return dcreplace(uw_expr, { elide_cast: true });
  return uw_expr;
}

export function uses_expr_sub(expr, expr_filter, is_parent_addressof, may_move_forward, seen) {
  const cache_key = `${objId(expr)},${may_move_forward ? 1 : 0},${is_parent_addressof ? 1 : 0}`;
  if (seen.has(cache_key)) return false;
  seen.add(cache_key);
  if (expr_filter(expr) && !is_parent_addressof) return true;
  if (expr instanceof EvalOnceExpr) {
    const e = expr.dependency(may_move_forward);
    return e !== null && uses_expr_sub(e, expr_filter, false, may_move_forward || expr.emit_exactly_once, seen);
  } else if (expr instanceof AddressOf) {
    return uses_expr_sub(expr.expr, expr_filter, true, may_move_forward, seen);
  } else {
    for (const e of expr.dependencies()) if (uses_expr_sub(e, expr_filter, false, may_move_forward, seen)) return true;
    return false;
  }
}

export function uses_expr(expr, expr_filter) {
  return uses_expr_sub(expr, expr_filter, false, false, new Set());
}

/** Unwrap EvalOnceExpr's, stopping at variable boundaries. */
export function late_unwrap(expr) {
  if (expr instanceof EvalOnceExpr && !expr.uses_var()) return late_unwrap(expr.wrapped_expr);
  if (expr instanceof NaivePhiExpr && expr.replacement_expr !== null) return late_unwrap(expr.replacement_expr);
  return expr;
}

/** Unwrap transparent EvalOnceExpr's. */
export function transparent_unwrap(expr) {
  if (expr instanceof EvalOnceExpr && expr.transparent && !expr.uses_var()) return transparent_unwrap(expr.wrapped_expr);
  return expr;
}

/** Unwrap EvalOnceExpr's, even past variable boundaries. */
export function early_unwrap(expr) {
  if (expr instanceof EvalOnceExpr && !expr.forced_emit && !expr.emit_exactly_once) return early_unwrap(expr.wrapped_expr);
  return expr;
}

export function early_unwrap_ints(expr) {
  const uw_expr = early_unwrap(expr);
  if (uw_expr instanceof Cast && uw_expr.reinterpret && uw_expr.type.is_int()) return early_unwrap_ints(uw_expr.expr);
  return uw_expr;
}

export function late_unwrap_ints(expr) {
  const uw_expr = late_unwrap(expr);
  if (uw_expr instanceof Cast && uw_expr.reinterpret && uw_expr.type.is_int()) return late_unwrap_ints(uw_expr.expr);
  return uw_expr;
}

export function unwrap_deep(expr) {
  if (expr instanceof EvalOnceExpr) return unwrap_deep(expr.wrapped_expr);
  return expr;
}

export function literal_expr(arg, stack_info) {
  if (arg instanceof AsmGlobalSymbol) return stack_info.global_info.address_of_gsym(arg.symbol_name);
  if (arg instanceof AsmLiteral) return new Literal(arg.value);
  if (arg instanceof BinOp) {
    const lhs = literal_expr(arg.lhs, stack_info);
    const rhs = literal_expr(arg.rhs, stack_info);
    return BinaryOp.int(lhs, arg.op, rhs);
  }
  throw new DecompFailure(`Instruction argument ${arg} must be a literal`);
}

export function parse_symbol_ref(arg) {
  if (arg instanceof AsmGlobalSymbol) return new RawSymbolRef({ offset: 0, sym: arg });
  if (arg instanceof BinOp && "+-".includes(arg.op) && arg.lhs instanceof AsmGlobalSymbol && arg.rhs instanceof AsmLiteral) {
    return new RawSymbolRef({ offset: arg.rhs.value * (arg.op === "-" ? -1 : 1), sym: arg.lhs });
  }
  return null;
}

function pack_f32_bits(value) {
  if (Number.isFinite(value) && !Number.isFinite(Math.fround(value))) throw new Error("OverflowError: float too large to pack with f format");
  const dv = new DataView(new ArrayBuffer(4));
  dv.setFloat32(0, value);
  return dv.getUint32(0);
}

export function format_f32_imm(num) {
  const bits = Number(BigInt.asUintN(32, BigInt(num)));
  const dv = new DataView(new ArrayBuffer(4));
  dv.setUint32(0, bits);
  const value = dv.getFloat32(0);
  const packed = bits;

  if (!value || value === 4294967296.0) return float_repr(value);

  let fmt_char;
  if (Math.abs(Math.log10(Math.abs(value))) > 6.9) fmt_char = "e";
  else if (Math.abs(value) < 1) fmt_char = "f";
  else fmt_char = "g";

  const fmt = (prec) => {
    let ret;
    if (fmt_char === "e") ret = format_exp(value, prec);
    else if (fmt_char === "f") ret = format_fixed(value, prec);
    else ret = format_general(value, prec);
    if (fmt_char === "e") return ret.replaceAll("e+", "e").replaceAll("e0", "e").replaceAll("e-0", "e-");
    if (ret.includes("e")) return "0";
    return ret;
  };

  let prec = 20;
  while (prec > 0) {
    prec -= 1;
    const value2 = py_float(fmt(prec));
    if (pack_f32_bits(value2) !== packed) {
      prec += 1;
      break;
    }
  }
  if (prec === 20) return float_repr(value);
  let ret = fmt(prec);
  if (!ret.includes(".") && !ret.includes("e")) ret += ".0";
  return ret;
}

export function format_f64_imm(num) {
  const dv = new DataView(new ArrayBuffer(8));
  dv.setBigUint64(0, BigInt.asUintN(64, BigInt(num)));
  return float_repr(dv.getFloat64(0));
}

/** Replace %lo(...) by 0, and assert that there are no %hi(...). */
export function strip_macros(arg) {
  if (arg instanceof Macro) {
    if (arg.macro_name === "sda2" || arg.macro_name === "sda21") return arg.argument;
    if (arg.macro_name === "hi") throw new DecompFailure("%hi macro outside of lui");
    if (arg.macro_name !== "lo" && arg.macro_name !== "l") throw new DecompFailure(`Unrecognized linker macro %${arg.macro_name}`);
    if (arg.argument instanceof AsmLiteral) return new AsmLiteral(arg.argument.value);
    return new AsmLiteral(0);
  } else if (arg instanceof AsmAddressMode && arg.addend instanceof Macro) {
    if (["sda2", "sda21", "gp_rel"].includes(arg.addend.macro_name)) return arg.addend.argument;
    if (arg.addend.macro_name !== "lo" && arg.addend.macro_name !== "l") throw new DecompFailure(`Bad linker macro in instruction argument ${arg}, expected %lo`);
    return new AsmAddressMode(arg.base, new AsmLiteral(0), arg.writeback);
  }
  return arg;
}

export class ArgLoc {
  static __fields = [["offset"], ["sort_index"], ["reg"]];
  constructor(...args) {
    dcinit(this, args);
  }
  __lt__(other) {
    if (this.sort_index !== null) {
      if (other.sort_index === null) return true;
      return this.sort_index < other.sort_index;
    }
    if (other.sort_index !== null) return false;
    pyassert(this.offset !== null);
    pyassert(other.offset !== null);
    return this.offset < other.offset;
  }
  equals(other) {
    if (!(other instanceof ArgLoc)) return false;
    if (this.offset !== null) return other.offset === this.offset;
    return other.offset === null && this.reg === other.reg;
  }
  __pykey() {
    if (this.offset !== null) return `AL:o${this.offset}`;
    return `AL:r${this.reg === null ? "N" : "#" + this.reg.__iid}`;
  }
}

export class AbiArgSlot {
  static __fields = [["loc"], ["type"], ["name", null], ["comment", null]];
  constructor(...args) {
    dcinit(this, args);
  }
}

export class Abi {
  static __fields = [["arg_slots"], ["possible_slots"]];
  constructor(...args) {
    dcinit(this, args);
  }
}

export function find_clobbers_until_dominator(stack_info, node) {
  pyassert(node.immediate_dominator !== null);
  const seen = new Set([node.immediate_dominator]);
  const stack = [...node.parents];
  const clobbered_vars = new Set();
  let has_fn_call = false;
  while (stack.length) {
    const n = stack.pop();
    if (seen.has(n)) continue;
    seen.add(n);
    for (const instr_ref of n.block.instruction_refs) {
      const instr = instr_ref.instruction;
      for (const loc of instr.outputs) {
        if (loc instanceof Register) {
          const v = stack_info.get_planned_var(loc, instr_ref);
          if (v !== null) clobbered_vars.add(v);
        }
      }
      if (instr.function_target !== null) has_fn_call = true;
    }
    stack.push(...n.parents);
  }
  return [clobbered_vars, has_fn_call];
}

export function reg_sources(node, reg) {
  pyassert(node.immediate_dominator !== null);
  const seen = new Set([node.immediate_dominator]);
  const stack = [...node.parents];
  const sources = [];
  let uses_dominator = false;
  while (stack.length) {
    const n = stack.pop();
    if (n === node.immediate_dominator) uses_dominator = true;
    if (seen.has(n)) continue;
    seen.add(n);
    let broke = false;
    const refs = n.block.instruction_refs;
    for (let i = refs.length - 1; i >= 0; i--) {
      const instr_ref = refs[i];
      const instr = instr_ref.instruction;
      if (instr.outputs.includes(reg)) {
        sources.push(instr_ref);
        broke = true;
        break;
      } else if (instr.clobbers.includes(reg)) {
        return [[], false];
      }
    }
    if (!broke) stack.push(...n.parents);
  }
  return [sources, uses_dominator];
}

export function assign_naive_phis(used_naive_phis, stack_info) {
  let i = 0;
  while (i < used_naive_phis.length) {
    const phi = used_naive_phis[i];
    pyassert(phi.num_usages > 0);
    pyassert(phi.sources.length >= 2);
    pyassert(phi.node.parents.length >= 2);

    const equivalent_blocks = new DefaultPyDict(() => []);
    for (const source of phi.sources) {
      let block;
      if (source instanceof InstrRef) block = source.block;
      else block = stack_info.flow_graph.entry_node().block;
      const expr = get_block_info_for_block(block).final_register_states.get(phi.reg);
      expr.type.unify(phi.type);
      equivalent_blocks.get(transparent_unwrap(expr)).push(block);
    }

    const exprs = [...equivalent_blocks.keys()];
    const first_uw = early_unwrap(exprs[0]);
    if (exprs.slice(1).every((e) => pyeq(early_unwrap(e), first_uw))) {
      const phi_expr = exprs.length === 1 ? exprs[0] : first_uw;
      phi.replacement_expr = as_type(phi_expr, phi.type, true);
      for (let k = 0; k < phi.num_usages; k++) phi_expr.use();
      if (exprs.length === 1) {
        if (phi.uses_dominator) stack_info.add_planned_inherited_phi(phi.node, phi.reg, PhiInheritSource.DOMINATOR);
        else if (is_trivial_expression(exprs[0])) stack_info.add_planned_inherited_phi(phi.node, phi.reg, PhiInheritSource.ANY_PARENT);
      }
    } else {
      for (const [, blocks] of equivalent_blocks) {
        for (const block of blocks) {
          const block_info = get_block_info_for_block(block);
          const expr = block_info.final_register_states.get(phi.reg);
          expr.use();
          const typed_expr = as_type(expr, phi.type, true);
          block_info.to_write.push(new SetNaivePhiStmt(phi, typed_expr));
        }
      }
    }
    i += 1;
  }

  for (const phi of used_naive_phis) {
    if (!phi.replacement_expr) {
      const output_reg_name = stack_info.function.reg_formatter.format(phi.reg);
      let prefix = `phi_${output_reg_name}`;
      if (stack_info.global_info.deterministic_vars) prefix = `${prefix}_${phi.node.block.index}`;
      phi.name = stack_info.temp_var(prefix);
      stack_info.naive_phi_vars.push(phi);
      const v = stack_info.get_persistent_planned_var(phi.reg, phi.sources[0]);
      for (const source of phi.sources.slice(1)) stack_info.get_persistent_planned_var(phi.reg, source).join(v);
    }
  }
}

/** Propagate RegMeta bits forwards/backwards. */
export function propagate_register_meta(nodes, reg) {
  const non_terminal = nodes.filter((n) => !(n instanceof TerminalNode));

  for (const n of non_terminal) {
    if (get_block_info(n).final_register_states.read_inherited.has(reg)) {
      for (const p of n.parents) {
        const par_meta = get_block_info(p).final_register_states.get_meta(reg);
        if (par_meta) par_meta.is_read = true;
      }
    }
  }

  let todo = [...non_terminal];
  while (todo.length) {
    const n = todo.pop();
    const meta = get_block_info(n).final_register_states.get_meta(reg);
    for (const p of n.parents) {
      const par_meta = get_block_info(p).final_register_states.get_meta(reg);
      if (par_meta && !par_meta.is_read && meta && meta.inherited && meta.is_read) {
        par_meta.is_read = true;
        todo.push(p);
      }
    }
  }

  for (const n of non_terminal) {
    const meta = get_block_info(n).final_register_states.get_meta(reg);
    if (meta) {
      if (meta.inherited) {
        meta.uninteresting = true;
        meta.function_return = true;
        meta.in_pattern = true;
      } else {
        meta.uninteresting = meta.uninteresting || meta.is_read || meta.function_return || meta.in_pattern;
      }
    }
  }

  todo = [...non_terminal];
  while (todo.length) {
    const n = todo.pop();
    if (n instanceof TerminalNode) continue;
    const meta = get_block_info(n).final_register_states.get_meta(reg);
    if (!meta || !meta.inherited) continue;
    let all_uninteresting = true;
    let all_function_return = true;
    let all_in_pattern = true;
    for (const p of n.parents) {
      const par_meta = get_block_info(p).final_register_states.get_meta(reg);
      if (par_meta) {
        all_uninteresting = all_uninteresting && par_meta.uninteresting;
        all_function_return = all_function_return && par_meta.function_return;
        all_in_pattern = all_in_pattern && par_meta.in_pattern;
      }
    }
    if (meta.uninteresting && !all_uninteresting && !meta.is_read) {
      meta.uninteresting = false;
      todo.push(...n.children());
    }
    if (meta.function_return && !all_function_return) {
      meta.function_return = false;
      todo.push(...n.children());
    }
    if (meta.in_pattern && !all_in_pattern) {
      meta.in_pattern = false;
      todo.push(...n.children());
    }
  }
}

/** Determine which of the arch's base_return_regs is most likely to contain the return value. */
export function determine_return_register(return_blocks, fn_decl_provided, arch) {
  const priority = (block_info, reg) => {
    const meta = block_info.final_register_states.get_meta(reg);
    if (!meta) return 4;
    if (meta.uninteresting) return 2;
    if (meta.in_pattern) return 1;
    if (meta.function_return) return 0;
    return 3;
  };
  if (!return_blocks.length) return null;
  let best_reg = null;
  let best_prio = -1;
  for (const [reg, floating] of arch.base_return_regs) {
    const prios = return_blocks.map((b) => priority(b, reg));
    const max_prio = Math.max(...prios);
    if (max_prio === 4) continue;
    if (max_prio <= 2 && !fn_decl_provided) continue;
    if (max_prio > best_prio) {
      best_prio = max_prio;
      best_reg = [reg, floating];
    }
  }
  return best_reg;
}

export class NodeState {
  constructor({ node, stack_info, regs }) {
    this.node = node;
    this.stack_info = stack_info;
    this.regs = regs;
    // LocalVar -> [Register, Expression, bool]
    this.local_var_writes = new PyDict();
    this.subroutine_args = new Map();
    this.in_pattern = false;
    this.to_write = [];
    this.branch_condition = null;
    this.switch_control = null;
    this.has_function_call = false;
  }

  _eval_once(expr, { emit_exactly_once, transparent, reg, source }) {
    const planned_var = this.stack_info.get_planned_var(reg, source);
    let is_fictive_temp = false;

    if (reg.register_name.includes("_fictive_")) {
      if (expr instanceof EvalOnceExpr && !expr.var.is_planned) {
        pyassert(!emit_exactly_once);
        pyassert(!planned_var);
        return expr;
      }
      reg = new Register(reg.register_name.split("_fictive_")[0]);
      is_fictive_temp = true;
    }

    const trivial = transparent && is_trivial_expression(expr);
    if (emit_exactly_once) expr.use();

    let force = false;
    let v;
    if (planned_var !== null) {
      v = planned_var;
      expr = as_type(expr, v.type, true);
      this.prevent_later_var_uses(new Set([v]));
      if (uses_expr(expr, (e) => var_for_expr(e) === v)) force = true;
    } else {
      let prefix = this.stack_info.function.reg_formatter.format(reg);
      if (prefix === "condition_bit") prefix = "cond";
      let temp_name = `temp_${prefix}`;
      if (this.stack_info.global_info.deterministic_vars) temp_name = `${temp_name}_${this.regs.get_instruction_lineno()}`;
      v = new Var(this.stack_info, temp_name, { is_planned: false, type: expr.type });
      this.stack_info.temp_vars.push(v);
    }

    const ret = new EvalOnceExpr({
      wrapped_expr: expr,
      var: v,
      type: expr.type,
      sources: [source],
      emit_exactly_once,
      trivial,
      transparent,
      is_fictive_temp,
    });
    const stmt = new EvalOnceStmt(ret);
    this.write_statement(stmt);
    v.debug_exprs.push(ret);

    if (planned_var !== null) {
      v.is_emitted = true;
      ret.use();
      if (force) ret.force();
    }
    return ret;
  }

  /** Prevent later uses of registers that recursively contain something that matches a filter. */
  _prevent_later_uses(expr_filter) {
    for (const [r, data] of [...this.regs.contents.entries()]) {
      const expr = data.value;
      if (expr instanceof PlannedPhiExpr || expr instanceof NaivePhiExpr) continue;
      if (!data.meta.force && uses_expr(expr, expr_filter)) {
        if (!(expr instanceof EvalOnceExpr)) assert_never(expr);
        this.regs.update_meta(r, dcreplace(data.meta, { force: true }));
      }
    }
    for (const [loc, [reg, write, force]] of [...this.local_var_writes.entries()]) {
      if (!force && uses_expr(write, expr_filter)) this.local_var_writes.set(loc, [reg, write, true]);
    }
  }

  prevent_later_value_uses(sub_expr) {
    this._prevent_later_uses((e) => pyeq(e, sub_expr));
  }

  prevent_later_var_uses(vars) {
    if (vars.size) this._prevent_later_uses((e) => vars.has(var_for_expr(e)));
  }

  prevent_later_function_calls() {
    this._prevent_later_uses((e) => e instanceof FuncCall);
  }

  prevent_later_reads() {
    this._prevent_later_uses((e) => e instanceof StructAccess || e instanceof ArrayAccess);
  }

  set_initial_reg(reg, expr, meta) {
    pyassert(meta.initial);
    expr = this._eval_once(expr, { emit_exactly_once: false, transparent: true, reg, source: new PrologueRef(reg) });
    this.regs.global_set_with_meta(reg, expr, meta);
    if (expr.var.is_emitted) this.regs.get(reg);
  }

  set_reg(reg, expr) {
    if (expr instanceof LocalVar) {
      if (
        this.node instanceof ReturnNode &&
        this.stack_info.maybe_get_register_var(reg) &&
        this.stack_info.in_callee_save_reg_region(expr.value) &&
        this.stack_info.callee_save_regs.has(reg)
      ) {
        return expr;
      }
      if (this.stack_info.global_info.stack_spill_detection && this.local_var_writes.has(expr)) {
        const [orig_reg, orig_expr, force] = this.local_var_writes.get(expr);
        if (orig_reg === reg) {
          expr = orig_expr;
          if (force) {
            let base_expr = expr;
            while (base_expr instanceof Cast) base_expr = base_expr.expr;
            if (base_expr instanceof EvalOnceExpr) base_expr.force();
          }
        }
      }
    }
    return this.set_reg_real(reg, expr);
  }

  set_reg_real(reg, uw_expr, { transparent = null, emit_exactly_once = false, function_return = false } = {}) {
    const source = this.regs.current_instr_ref();
    if (transparent === null) transparent = should_wrap_transparently(uw_expr);
    const expr = this._eval_once(uw_expr, { emit_exactly_once, transparent, reg, source });
    if (reg === new Register("zero")) {
      expr.use();
      this.write_statement(new ExprStmt(expr));
    } else {
      const in_pattern = source.instruction.in_pattern;
      this.regs.set_with_meta(reg, expr, new RegMeta({ in_pattern, function_return }));
    }
    return expr;
  }

  clear_caller_save_regs() {
    for (const reg of this.stack_info.global_info.arch.temp_regs) if (this.regs.has(reg)) this.regs.delete(reg);
  }

  maybe_clear_local_var_writes(func_args) {
    for (const arg of func_args) {
      if (uses_expr(arg, (expr) => expr instanceof AddressOf && expr.expr instanceof LocalVar)) {
        this.local_var_writes.clear();
        return;
      }
    }
  }

  set_branch_condition(cond) {
    pyassert(this.node instanceof ConditionalNode);
    pyassert(this.branch_condition === null);
    this.branch_condition = cond;
  }

  set_switch_expr(expr, just_index = false) {
    pyassert(this.node instanceof SwitchNode);
    pyassert(this.switch_control === null);
    if (just_index) this.switch_control = new SwitchControl(expr, { num_cases: this.node.cases.length });
    else this.switch_control = SwitchControl.from_expr(expr, this.node.cases.length);
  }

  write_statement(stmt) {
    this.to_write.push(stmt);
  }

  store_memory(store, reg) {
    const source = store.source;
    const dest = store.dest;
    if (dest instanceof SubroutineArg) {
      if (dest.value >= this.stack_info.global_info.arch.home_space_size) this.subroutine_args.set(dest.value, source);
      return;
    }
    let raw_value = source;
    while (raw_value instanceof Cast && raw_value.reinterpret) raw_value = raw_value.expr;
    if (dest instanceof LocalVar) {
      this.stack_info.add_local_var(dest);
      this.local_var_writes.set(dest, [reg, raw_value, false]);
    }
    if ((dest instanceof LocalVar || dest instanceof PassedInArg) && pyeq(early_unwrap(raw_value), dest)) return;
    source.use();
    dest.use();
    this.prevent_later_value_uses(dest);
    this.prevent_later_function_calls();
    this.write_statement(store);
  }

  push_subroutine_arg(source) {
    const m = new Map();
    for (const [offset, arg] of this.subroutine_args) m.set(offset + 4, arg);
    this.subroutine_args = m;
    this.subroutine_args.set(0, source);
  }

  _reg_probably_meant_as_function_argument(reg, call_instr) {
    for (const source of this.stack_info.flow_graph.instr_inputs.get(call_instr).get(reg)) {
      const uses = this.stack_info.flow_graph.instr_uses.get(source).get(reg);
      pyassert(uses.has(call_instr));
      if (uses.length === 1 && source instanceof InstrRef && source.instruction.function_target === null && call_instr.instruction.function_target !== reg) return true;
    }
    return false;
  }

  make_function_call(fn_target, outputs) {
    const call_instr = this.regs.current_instr_ref();
    const arch = this.stack_info.global_info.arch;
    fn_target = as_function_ptr(fn_target);
    const fn_sig = fn_target.type.get_function_pointer_signature();
    pyassert(fn_sig !== null, "known function pointers must have a signature");

    const instr_inputs = this.stack_info.flow_graph.instr_inputs.get(call_instr);
    const likely_regs = new Map();
    for (const [reg, data] of this.regs.contents) {
      if (!arch.argument_regs.includes(reg)) likely_regs.set(reg, false);
      else if (
        (arch.arch === Target.ArchEnum.PPC || arch.arch === Target.ArchEnum.ARM) &&
        !fn_sig.is_variadic &&
        (data.meta.inherited || data.meta.function_return || arch.arch === Target.ArchEnum.ARM) &&
        !this._reg_probably_meant_as_function_argument(reg, call_instr)
      ) {
        likely_regs.set(reg, false);
      } else if ([...instr_inputs.get(reg)].every((source) => !(source instanceof InstrRef) || source.instruction.in_pattern)) {
        likely_regs.set(reg, false);
      } else likely_regs.set(reg, true);
    }

    const abi = arch.function_abi(fn_sig, likely_regs, { for_call: true });

    const func_args = [];
    for (const slot of abi.arg_slots) {
      let expr;
      if (slot.loc.reg) expr = this.regs.get(slot.loc.reg);
      else {
        const offset = slot.loc.offset;
        pyassert(offset !== null);
        if (this.subroutine_args.has(offset)) {
          expr = this.subroutine_args.get(offset);
          this.subroutine_args.delete(offset);
        } else expr = new ErrorExpr(`Unable to find stack arg ${format(offset, "#x")} in block`);
      }
      func_args.push(CommentExpr.wrap(as_type(expr, slot.type, true), slot.comment));
    }

    for (const slot of abi.possible_slots) {
      pyassert(slot.loc.reg !== null);
      func_args.push(this.regs.get(slot.loc.reg));
    }

    for (const [, arg] of sorted(this.subroutine_args.entries(), (e) => e[0])) {
      if (fn_sig.params_known && !fn_sig.is_variadic) func_args.push(CommentExpr.wrap(arg, "extra?"));
      else func_args.push(arg);
    }

    if (!fn_sig.params_known) {
      while (func_args.length > fn_sig.params.length) fn_sig.params.push(new FunctionParam());
      const n = Math.min(func_args.length, fn_sig.params.length);
      for (let i = 0; i < n; i++) func_args[i] = as_type(func_args[i], fn_sig.params[i].type.decay(), true);
    }

    this.subroutine_args.clear();

    const source = this.regs.current_instr_ref();
    let call = new FuncCall(fn_target, func_args, fn_sig.return_type.weaken_void_ptr());
    call = this._eval_once(call, { emit_exactly_once: true, transparent: false, reg: new Register("ret"), source });

    this.clear_caller_save_regs();
    this.maybe_clear_local_var_writes(func_args);
    this.prevent_later_function_calls();
    this.prevent_later_reads();

    const return_reg_vals = arch.function_return(call);
    for (const out of outputs) {
      if (!(out instanceof Register)) continue;
      if (!return_reg_vals.has(out)) throw new Error(`KeyError: ${out}`);
      const val = return_reg_vals.get(out);
      this.set_reg_real(out, val, { transparent: false, function_return: true });
    }
    this.has_function_call = true;
  }
}

export function evaluate_instruction(instr_ref, state) {
  const instr = instr_ref.instruction;
  if (instr.is_return) pyassert(state.node instanceof ReturnNode);
  if (instr.is_conditional) pyassert(state.branch_condition === null && state.switch_control === null);
  if (instr.eval_fn !== null) {
    const args = new InstrArgs(instr_ref, instr.args, state.regs, state.stack_info);
    instr.eval_fn(state, args);
  }
  if (instr.is_conditional) pyassert(state.branch_condition !== null || state.switch_control !== null);
}

/** Given a node and current register contents, return a BlockInfo containing the translated AST. */
export function translate_node_body(state) {
  for (const instr_ref of state.node.block.instruction_refs) {
    state.regs.set_current_instr(instr_ref, () => evaluate_instruction(instr_ref, state));
  }
  if (state.branch_condition !== null) state.branch_condition.use();
  if (state.switch_control !== null) state.switch_control.control_expr.use();
  return new BlockInfo({
    to_write: state.to_write,
    return_value: null,
    switch_control: state.switch_control,
    branch_condition: state.branch_condition,
    final_register_states: state.regs,
    has_function_call: state.has_function_call,
  });
}

function py_exc_str(e) {
  if (e instanceof DecompFailure) return e.message;
  if (e && typeof e.message === "string") return e.message;
  return String(e);
}

export function translate_block(state, options) {
  const node = state.node;
  if (options.debug) print(`\nNode in question: ${node}`);
  let block_info;
  try {
    block_info = translate_node_body(state);
    if (options.debug) print(String(block_info));
  } catch (e0) {
    let e = e0;
    if (options.stop_on_error) throw e;
    let instr = null;
    if (e instanceof InstrProcessingFailure && e.cause instanceof Error) {
      instr = e.instr;
      e = e.cause;
    }
    let emsg;
    if (e instanceof DecompFailure) {
      emsg = py_exc_str(e);
      print(emsg);
    } else {
      print(`Traceback (most recent call last):\n${e && e.stack ? e.stack : e}`, { __print_opts: true, stderr: true });
      emsg = py_exc_str(e) || `${e && e.name ? e.name : "Error"}`;
      const parts = emsg.trim().split("\n");
      emsg = parts[parts.length - 1].trim();
    }
    const error_stmts = [new CommentStmt(`Error: ${emsg}`)];
    if (instr !== null) {
      print(`Error occurred while processing instruction: ${instr}`, { __print_opts: true, stderr: true });
      error_stmts.push(new CommentStmt(`At instruction: ${instr}`));
    }
    print({ __print_opts: true, stderr: true });
    block_info = new BlockInfo({
      to_write: error_stmts,
      return_value: null,
      switch_control: null,
      branch_condition: new ErrorExpr(),
      final_register_states: state.regs,
      has_function_call: false,
    });
  }
  return block_info;
}

/** Create a NodeState for translating a child of a node in the dominator tree. */
export function create_dominated_node_state(parent_state, child, used_naive_phis) {
  const stack_info = parent_state.stack_info;
  const new_regs = new RegInfo({ stack_info });
  const child_state = new NodeState({ node: child, regs: new_regs, stack_info });
  for (const [reg, data] of parent_state.regs.contents) {
    new_regs.global_set_with_meta(reg, data.value, new RegMeta({ inherited: true, force: data.meta.force, initial: data.meta.initial }));
  }

  const phi_regs = [...locs_clobbered_until_dominator(child)].filter((r) => r instanceof Register);
  for (const reg of phi_regs) {
    let [sources, uses_dominator] = reg_sources(child, reg);

    const inherited_phi = stack_info.get_planned_inherited_phi(child, reg);
    if (inherited_phi !== null) {
      if (inherited_phi === PhiInheritSource.DOMINATOR) {
        const meta = new_regs.get_meta(reg);
        if (meta !== null) {
          new_regs.update_meta(reg, dcreplace(meta, { initial: false }));
          continue;
        }
      } else {
        let found_par_value = null;
        for (const parent of child.parents) {
          if (parent.block.block_info) {
            const par_regs = get_block_info(parent).final_register_states;
            if (!par_regs.contents.has(reg)) throw new Error(`KeyError: ${reg}`);
            const par_value = par_regs.contents.get(reg).value;
            if (par_value instanceof EvalOnceExpr && par_value.trivial) {
              found_par_value = par_value;
              break;
            }
          }
        }
        if (found_par_value !== null) {
          const new_val = new EvalOnceExpr({
            wrapped_expr: found_par_value.wrapped_expr,
            var: new Var(stack_info, "_m2c_inherited_phi", { is_planned: false, type: found_par_value.type }),
            type: found_par_value.type,
            sources,
            emit_exactly_once: false,
            trivial: true,
            transparent: true,
            is_fictive_temp: false,
          });
          new_regs.global_set_with_meta(reg, new_val, new RegMeta({ inherited: true }));
          continue;
        }
      }
    }

    if (uses_dominator) {
      const dom_expr = parent_state.regs.get_raw(reg);
      if (dom_expr === null) sources = [];
      else if (dom_expr instanceof EvalOnceExpr || dom_expr instanceof PlannedPhiExpr || dom_expr instanceof NaivePhiExpr) sources.push(...dom_expr.sources);
      else assert_never(dom_expr);
    }

    if (sources.length) {
      let expr;
      const v = stack_info.get_planned_var(reg, sources[0]);
      if (v !== null && sources.slice(1).every((s) => stack_info.get_planned_var(reg, s) === v)) {
        expr = new PlannedPhiExpr(v, v.type, sources);
      } else {
        expr = new NaivePhiExpr({ reg, node: child, type: Type.any_reg(), sources, uses_dominator, used_naive_phis });
      }
      new_regs.global_set_with_meta(reg, expr, new RegMeta({ inherited: true }));
    } else if (new_regs.has(reg)) {
      new_regs.delete(reg);
    }
  }

  const [clobbered_vars, has_fn_call] = find_clobbers_until_dominator(stack_info, child);
  child_state.prevent_later_var_uses(clobbered_vars);

  if (child.parents.length !== 1 || parent_state.node.children().length !== 1) child_state.prevent_later_function_calls();
  if (has_fn_call) child_state.prevent_later_reads();
  return child_state;
}

/** Do translation for all non-terminal nodes, attaching block info to them. */
export function translate_all_blocks(initial_state, used_naive_phis, return_blocks, options) {
  const translate_stack = [[null, initial_state.node]];
  while (translate_stack.length) {
    const [parent_state, node0] = translate_stack.pop();
    let state;
    if (parent_state === null) state = initial_state;
    else state = create_dominated_node_state(parent_state, node0, used_naive_phis);
    const block_info = translate_block(state, options);
    const node = state.node;
    node.block.add_block_info(block_info);
    if (node instanceof ReturnNode) return_blocks.push(block_info);
    for (const child of [...state.node.immediately_dominates].reverse()) {
      if (!(child instanceof TerminalNode)) translate_stack.push([state, child]);
    }
  }
}

/** After translating a function, perform a final type-resolution pass. */
export function resolve_types_late(stack_info) {
  for (const location of [...stack_info.weak_stack_var_types.keys()]) stack_info.get_stack_var(location, { store: false });
  const struct_type_map = stack_info.get_struct_type_map();
  for (const [v, offset_type_map] of struct_type_map) {
    if (offset_type_map.size === 1 && offset_type_map.has(0)) {
      const type = offset_type_map.get(0);
      v.type.unify(Type.ptr(type));
    }
  }
}

export class FunctionInfo {
  constructor(stack_info, flow_graph, return_type, symbol) {
    this.stack_info = stack_info;
    this.flow_graph = flow_graph;
    this.return_type = return_type;
    this.symbol = symbol;
  }
}

export class FailedToGenerateInitializer extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}

export class GlobalInfo {
  constructor(asm_data, arch, target, local_functions, typemap, typepool, { deterministic_vars, stack_spill_detection }) {
    this.asm_data = asm_data;
    this.arch = arch;
    this.target = target;
    this.local_functions = local_functions; // Set<string>
    this.typemap = typemap;
    this.typepool = typepool;
    this.deterministic_vars = deterministic_vars;
    this.stack_spill_detection = stack_spill_detection;
    this.global_symbol_map = new Map();
    this.persistent_function_state = new DefaultMap(() => new PersistentFunctionState());
  }

  get_persistent_function_state(func_name) {
    return this.persistent_function_state.get(func_name);
  }

  asm_data_value(sym_name) {
    return this.asm_data.values.get(sym_name) ?? null;
  }

  address_of_gsym(sym_name) {
    let sym;
    if (this.global_symbol_map.has(sym_name)) sym = this.global_symbol_map.get(sym_name);
    else {
      const c_sym_name = this.arch.c_symbol_name(sym_name);
      let demangled_symbol = null;
      let demangled_str = null;
      if (this.target.language === Target.LanguageEnum.CXX && this.target.compiler === Target.CompilerEnum.MWCC) {
        try {
          demangled_symbol = demangle_codewarrior_parse(sym_name);
          demangled_str = String(demangled_symbol);
        } catch (e) {
          if (!(e instanceof ValueError)) throw e;
          demangled_symbol = null;
        }
      }
      sym = new GlobalSymbol({ c_symbol_name: c_sym_name, type: Type.any(), asm_data_entry: this.asm_data_value(sym_name), demangled_str });
      this.global_symbol_map.set(sym_name, sym);

      if (this.target.language === Target.LanguageEnum.CXX && this.target.compiler === Target.CompilerEnum.MWCC && sym_name.startsWith("__vt__") && sym.asm_data_entry !== null) {
        sym.type.unify(this.vtable_type(sym_name, sym.asm_data_entry));
      }

      const fn = this.typemap.functions.get(c_sym_name) ?? null;
      let ctype;
      if (fn !== null) ctype = fn.type;
      else ctype = this.typemap.var_types.get(c_sym_name) ?? null;

      if (ctype !== null) {
        sym.symbol_in_context = true;
        sym.initializer_in_typemap = this.typemap.vars_with_initializers.has(c_sym_name);
        let type;
        if (this.typepool.unk_inference && is_unk_type(ctype, this.typemap)) type = Type.gsym_unk_ctype(ctype, this.typemap, this.typepool);
        else type = Type.ctype(ctype, this.typemap, this.typepool);
        sym.type.unify(type);
        if (!this.typepool.unknown_decls.has(c_sym_name)) sym.type_provided = true;
      } else if (this.local_functions.has(sym_name)) {
        sym.type.unify(Type.function());
      }

      if (demangled_symbol !== null) sym.type.unify(Type.demangled_symbol(this.typemap, this.typepool, demangled_symbol));
    }
    return new AddressOf(sym, { type: sym.type.reference() });
  }

  /** Parse MWCC vtable data to create a custom struct to represent it. */
  vtable_type(sym_name, asm_data_entry) {
    const size = asm_data_entry.size_range_bytes()[1];
    const struct = StructDeclaration.unknown(this.typepool, size, sym_name, 4);
    let offset = 0;
    for (const entry of asm_data_entry.data) {
      if (entry instanceof Uint8Array) {
        if (entry.length % 4 !== 0) throw new DecompFailure(`Unable to parse misaligned vtable data in ${sym_name}`);
        for (let i = 0; i < floordiv(entry.length, 4); i++) {
          const field_name = `${struct.new_field_prefix}${format(offset, "X")}`;
          struct.try_add_field(Type.reg32({ likely_float: false }), offset, field_name, 4);
          offset += 4;
        }
      } else {
        const sym = entry.as_symbol_without_addend();
        if (sym === null) throw new DecompFailure(`Unable to parse vtable data in ${sym_name}`);
        let entry_name = sym;
        try {
          const demangled_field_sym = demangle_codewarrior_parse(sym);
          if (demangled_field_sym.name.qualified_name !== null && demangled_field_sym.name.qualified_name !== undefined) {
            const q = demangled_field_sym.name.qualified_name;
            entry_name = String(q[q.length - 1]);
          }
        } catch (e) {
          if (!(e instanceof ValueError)) throw e;
        }
        const field = struct.try_add_field(this.address_of_gsym(sym).type, offset, entry_name, 4);
        pyassert(field !== null);
        field.known = true;
        offset += 4;
      }
    }
    return Type.struct(struct);
  }

  /** Return true if the function exists in the context, and has no return value */
  is_function_known_void(sym_name) {
    const fn = this.typemap.functions.get(sym_name) ?? null;
    if (fn === null) return false;
    return fn.ret_type === null;
  }

  initializer_for_symbol(sym, fmt) {
    pyassert(sym.asm_data_entry !== null);
    const data = [...sym.asm_data_entry.data];

    const read_uint = (n) => {
      pyassert(0 < n && n <= 16);
      if (!data.length) throw new FailedToGenerateInitializer("not enough data");
      if (!(data[0] instanceof Uint8Array)) {
        const arg = data[0].data;
        throw new FailedToGenerateInitializer(`cannot parse ${arg} as integer`);
      }
      if (data[0].length < n) {
        if (data.length > 1) {
          const s = data[1];
          pyassert(s instanceof AsmSymbolicData);
          throw new FailedToGenerateInitializer(`partial read of ${s.data}`);
        } else throw new FailedToGenerateInitializer("not enough data");
      }
      let bs = data[0].slice(0, n);
      data[0] = data[0].slice(n);
      if (!data[0].length) data.shift();
      if (!this.target.is_big_endian()) bs = bs.reverse();
      let value = 0n;
      for (const b of bs) value = (value << 8n) | BigInt(b);
      return Number(value);
    };

    const try_read_pointer = () => {
      if (!data.length || data[0] instanceof Uint8Array) return null;
      const label = data[0].as_symbol_without_addend();
      if (label === null) return null;
      data.shift();
      const expr = this.address_of_gsym(label);
      expr.use();
      return expr;
    };

    const for_type = (type) => {
      if (type.is_struct() || type.is_array()) {
        const struct_fields = type.get_initializer_fields();
        if (!struct_fields || !struct_fields.length) {
          if (type.is_array()) throw new FailedToGenerateInitializer("unsized array");
          throw new FailedToGenerateInitializer("confusing struct layout");
        }
        const members = [];
        for (const field of struct_fields) {
          if (typeof field === "number") {
            for (let i = 0; i < field; i++) {
              const padding = read_uint(1);
              if (padding !== 0) throw new FailedToGenerateInitializer("non-zero padding");
            }
          } else members.push(for_type(field));
        }
        return fmt.format_array(members);
      }
      if (type.is_reg()) {
        const size = type.get_size_bytes();
        if (!size) throw new FailedToGenerateInitializer("unknown size");
        if (size === 4) {
          const ptr = try_read_pointer();
          if (ptr !== null) return as_type(ptr, type, true).format(fmt);
        }
        const value = read_uint(size);
        const enum_name = type.get_enum_name(value);
        if (enum_name !== null) return enum_name;
        const expr = as_type(new Literal(value), type, true);
        return elide_literal_casts(expr).format(fmt);
      }
      if (type.get_size_bits() === null) throw new FailedToGenerateInitializer("unknown type");
      throw new FailedToGenerateInitializer("bad type");
    };

    const type = sym.type.get_array()[0];
    if (sym.is_string_constant() && type !== null && type.get_size_bytes() === 1) return sym.format_string_constant(fmt);
    return for_type(sym.type);
  }

  find_forward_declares_needed(functions) {
    const funcs_seen = new Set();
    const forward_declares_needed = this.asm_data.mentioned_labels;
    for (const func of functions) {
      funcs_seen.add(func.stack_info.function.name);
      for (const instr of func.stack_info.function.body) {
        if (!(instr instanceof Instruction)) continue;
        for (const arg of instr.args) {
          let func_name;
          if (arg instanceof AsmGlobalSymbol) func_name = arg.symbol_name;
          else if (arg instanceof Macro && arg.argument instanceof AsmGlobalSymbol) func_name = arg.argument.symbol_name;
          else continue;
          if (this.local_functions.has(func_name)) {
            if (!funcs_seen.has(func_name)) forward_declares_needed.add(func_name);
          }
        }
      }
    }
    return forward_declares_needed;
  }

  global_decls(fmt, decls, functions) {
    const forward_declares_needed = this.find_forward_declares_needed(functions);
    const lines = [];
    const processed_names = new Set();
    for (;;) {
      const names = new Set();
      for (const [n, s] of this.global_symbol_map) if (s.is_referenced) names.add(n);
      if (decls === Options.GlobalDeclsEnum.ALL) {
        for (const [name, ent] of this.asm_data.values) if (!ent.is_text) names.add(name);
      }
      for (const p of processed_names) names.delete(p);
      if (!names.size) break;
      for (const name of sorted(names)) {
        processed_names.add(name);
        const sym = this.address_of_gsym(name).expr;
        pyassert(sym instanceof GlobalSymbol);
        let data_entry = sym.asm_data_entry;

        if (data_entry !== null && data_entry.is_text) {
          if (!sym.type.is_function()) continue;
          data_entry = null;
        }

        const is_in_file = data_entry !== null || this.local_functions.has(name);
        const is_global = sym.symbol_in_context;
        const is_const = data_entry !== null && data_entry.is_readonly;

        if (data_entry && data_entry.is_jtbl) continue;
        if (is_in_file && is_global && sym.type.is_function()) continue;
        if (this.local_functions.size === 1 && this.local_functions.has(name)) continue;
        if (!is_in_file && sym.type_provided) continue;

        let data_entry_order;
        if (data_entry) {
          const [file, index] = data_entry.sort_order;
          data_entry_order = data_entry.is_bss && fmt.backwards_bss ? [file, index * -1] : [file, index];
        } else data_entry_order = ["", 0];

        const sort_order = [!sym.type.is_function(), is_in_file, !is_in_file ? is_global : false, is_const, data_entry_order, name];
        let qualifier = "";
        let value = null;
        const comments = [];

        if (is_in_file && is_global) qualifier = "";
        else if (is_in_file) qualifier = "static";
        else qualifier = "extern";

        if (sym.type.is_function()) {
          comments.push(qualifier);
          qualifier = "";
        }

        let [element_type, array_dim] = sym.type.get_array();
        const is_vla = element_type !== null && (array_dim === null || array_dim <= 0);
        if (data_entry && (!sym.type_provided || is_vla)) {
          if (element_type === null) element_type = sym.type;
          const type_size = element_type.get_size_bytes();
          if (type_size) {
            const [potential_dim, extra_bytes] = sym.potential_array_dim(type_size);
            if (potential_dim === 0 && extra_bytes > 0) comments.push(`type too large by ${fmt.format_int(type_size - extra_bytes)}`);
            else if (potential_dim > 1 || is_vla) {
              array_dim = potential_dim;
              sym.type = Type.array(element_type, array_dim);
            }
            if (potential_dim !== 0 && extra_bytes > 0) comments.push(`extra bytes: ${fmt.format_int(extra_bytes)}`);
          }
        }

        if (data_entry && !data_entry.is_bss && !data_entry.is_text) {
          try {
            value = this.initializer_for_symbol(sym, fmt);
          } catch (e) {
            if (!(e instanceof FailedToGenerateInitializer)) throw e;
            comments.push(`unable to generate initializer: ${e.reason}`);
          }
        }

        if (is_const) {
          comments.push("const");
          if (sym.is_string_constant()) continue;
          if (array_dim === null && data_entry !== null && data_entry.used_as_literal) continue;
        }

        if (decls === Options.GlobalDeclsEnum.NONE) continue;
        if (decls !== Options.GlobalDeclsEnum.ALL && sym.initializer_in_typemap) continue;
        if (decls !== Options.GlobalDeclsEnum.ALL && this.target.language === Target.LanguageEnum.CXX && this.target.compiler === Target.CompilerEnum.MWCC && name.startsWith("__vt__")) continue;
        if (sym.type.is_function() && decls !== Options.GlobalDeclsEnum.ALL && this.local_functions.has(name) && !forward_declares_needed.has(name)) continue;

        qualifier = qualifier ? `${qualifier} ` : "";
        const value_str = value ? ` = ${value}` : "";
        lines.push([sort_order, fmt.with_comments(`${qualifier}${sym.type.to_decl(name, fmt)}${value_str};`, comments) + "\n"]);
      }
    }
    const sorted_lines = sorted(lines, (l) => l);
    return sorted_lines.map(([, line]) => line).join("");
  }
}

/** Modify the `outputs` list of function call Instructions using the context file. */
export function narrow_func_call_outputs(fn, global_info) {
  for (const instr of fn.body) {
    if (instr instanceof Instruction && instr.function_target instanceof AsmGlobalSymbol && global_info.is_function_known_void(instr.function_target.symbol_name)) {
      instr.outputs.length = 0;
    }
  }
}

/** Set up stack_info planned vars from state from earlier translation passes. */
export function setup_planned_vars(stack_info, persistent_state) {
  const planned_vars = new DefaultMap(() => []);
  for (const [key, persistent_var] of persistent_state.planned_vars) planned_vars.get(persistent_var.get_representative()).push(key);
  for (const keys of planned_vars.values()) {
    const reg = keys[0][0];
    const reg_name = stack_info.function.reg_formatter.format(reg);
    let prefix = `var_${reg_name}`;
    if (stack_info.global_info.deterministic_vars) {
      const lineno = Math.min(...keys.map(([, source]) => (!(source instanceof InstrRef) ? 0 : source.instruction.meta.lineno)));
      prefix = `${prefix}_${lineno}`;
    }
    const v = new Var(stack_info, { prefix, is_planned: true, type: Type.any_reg() });
    stack_info.temp_vars.push(v);
    for (const key of keys) stack_info.planned_vars.set(key, v);
  }
}

/** Set up per-register planned vars based on command line flags. */
export function setup_reg_vars(stack_info, options) {
  const arch = stack_info.global_info.arch;
  let reg_vars;
  const rv = options.reg_vars;
  if (rv.length === 1 && rv[0] === "saved") reg_vars = arch.saved_regs;
  else if (rv.length === 1 && rv[0] === "most") reg_vars = [...arch.saved_regs, ...arch.simple_temp_regs];
  else if (rv.length === 1 && rv[0] === "all") reg_vars = [...arch.saved_regs, ...arch.simple_temp_regs, ...arch.argument_regs];
  else reg_vars = rv.map((x) => stack_info.function.reg_formatter.parse(x, arch));
  for (const reg of reg_vars) {
    const reg_name = stack_info.function.reg_formatter.format(reg);
    stack_info.add_register_var(reg, reg_name);
  }
}

/** Set up initial register contents for translation. */
export function setup_initial_registers(state, fn_sig) {
  const stack_info = state.stack_info;
  const arch = stack_info.global_info.arch;
  state.set_initial_reg(arch.stack_pointer_reg, new GlobalSymbol("sp", { type: Type.ptr() }), new RegMeta({ initial: true }));
  for (const reg of arch.saved_regs) state.set_initial_reg(reg, stack_info.saved_reg_symbol(reg.register_name), new RegMeta({ initial: true }));

  const make_arg = (loc, type) => {
    if (loc.offset !== null) pyassert(pymod(loc.offset, 4) === 0);
    return new PassedInArg(loc, { stack_info, type });
  };

  const likely_regs = new Map();
  for (const reg of arch.argument_regs) likely_regs.set(reg, true);
  const abi = arch.function_abi(fn_sig, likely_regs, { for_call: false });
  for (const slot of abi.arg_slots) {
    const type = stack_info.add_known_param(slot.loc, slot.name, slot.type);
    if (slot.loc.reg !== null) state.set_initial_reg(slot.loc.reg, make_arg(slot.loc, type), new RegMeta({ uninteresting: true, initial: true }));
  }
  for (const slot of abi.possible_slots) {
    if (slot.loc.reg !== null) state.set_initial_reg(slot.loc.reg, make_arg(slot.loc, slot.type), new RegMeta({ uninteresting: true, initial: true }));
  }
}

/** Given a function, produce a FlowGraph with AST transformations for each block. */
export function translate_to_ast(fn, flow_graph, options, global_info) {
  const persistent_state = global_info.get_persistent_function_state(fn.name);
  const stack_info = get_stack_info(fn, persistent_state, global_info, flow_graph);
  const state = new NodeState({ node: flow_graph.entry_node(), regs: new RegInfo({ stack_info }), stack_info });

  setup_planned_vars(stack_info, persistent_state);
  setup_reg_vars(stack_info, options);

  const fn_sym = global_info.address_of_gsym(fn.name).expr;
  pyassert(fn_sym instanceof GlobalSymbol);

  const fn_type = fn_sym.type;
  fn_type.unify(Type.function());
  const fn_sig = Type.ptr(fn_type).get_function_pointer_signature();
  pyassert(fn_sig !== null, "fn_type is known to be a function");
  stack_info.is_variadic = fn_sig.is_variadic;

  setup_initial_registers(state, fn_sig);

  if (options.debug) {
    print(String(stack_info));
    print("\nNow, we attempt to translate:");
  }

  const used_naive_phis = [];
  const return_blocks = [];
  translate_all_blocks(state, used_naive_phis, return_blocks, options);

  const arch = global_info.arch;
  for (const [reg] of arch.base_return_regs) propagate_register_meta(flow_graph.nodes, reg);

  const return_type = fn_sig.return_type;
  let return_reg = null;
  if (!options.void && !return_type.is_void()) return_reg = determine_return_register(return_blocks, fn_sym.type_provided, arch);

  if (return_reg !== null) {
    const [reg, is_floating] = return_reg;
    if (is_floating) return_type.unify(Type.floatish());
    else return_type.unify(Type.intptr());
    for (const b of return_blocks) {
      if (b.final_register_states.has(reg)) {
        let ret_val = b.final_register_states.get(reg);
        ret_val = as_type(ret_val, return_type, true);
        ret_val.use();
        b.return_value = ret_val;
      }
    }
  } else {
    return_type.unify(Type.void());
  }

  assign_naive_phis(used_naive_phis, stack_info);

  if (!fn_sig.params_known) {
    while (fn_sig.params.length < stack_info.arguments.length) fn_sig.params.push(new FunctionParam());
    const n = Math.min(fn_sig.params.length, stack_info.arguments.length);
    for (let i = 0; i < n; i++) {
      const param = fn_sig.params[i];
      const arg = stack_info.arguments[i];
      param.type.unify(arg.type);
      if (!param.name) param.name = arg.format(new Formatter());
    }
  }

  resolve_types_late(stack_info);
  return new FunctionInfo(stack_info, flow_graph, return_type, fn_sym);
}

// Re-exports used by arch modules
export { compare, pyin, has, AssertionError, ArchC };
