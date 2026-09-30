// Port of m2c/ir_pattern.py
/* eslint no-unused-vars: ["error", { "args": "none" }] -- keeps upstream's parameter lists */
import { assert_never } from "./error.js";
import { BaseNode, InstrRef, RefSet, TerminalNode, build_flowgraph } from "./flow_graph.js";
import { AsmData, Function } from "./asm_file.js";
import { AsmAddressMode, AsmGlobalSymbol, AsmInstruction, AsmLiteral, AsmState, BinOp, Register, RegisterList } from "./asm_instruction.js";
import { Instruction, InstructionMeta, StackLocation, parse_instruction } from "./instruction.js";
import { DefaultMap, pyassert, shl } from "./py.js";
import { isupper } from "./asm_pattern.js";
import { print } from "./io.js";

/**
 * Template for defining "IR" patterns that can match against input asm.
 * Subclasses define static-ish instance fields `parts` (string[]) and `replacement` (string),
 * and can optionally implement `check()`.
 */
export class IrPattern {
  check(m, arch, flow_graph) {
    return true;
  }
  compile(arch) {
    const missing_meta = InstructionMeta.missing();
    const asm_state = new AsmState({ is_pattern: true });
    const replacement_instr = parse_instruction(this.replacement, missing_meta, arch, asm_state);

    const name = `__pattern_${this.constructor.name}`;
    const func = new Function({ name });
    pyassert(replacement_instr.inputs.length === new Set(replacement_instr.inputs).size, "pattern inputs must be unique");
    for (const inp of replacement_instr.inputs) {
      func.new_instruction(new Instruction({ mnemonic: "in.fictive", args: [], meta: missing_meta, inputs: [], clobbers: [], outputs: [inp], eval_fn: null }));
    }
    for (const part of this.parts) func.new_instruction(parse_instruction(part, missing_meta, arch, asm_state));

    const asm_data = new AsmData();
    const flow_graph = build_flowgraph(func, asm_data, arch, { fragment: true });
    return new CompiledIrPattern(this, flow_graph, replacement_instr);
  }
}

export class CompiledIrPattern {
  constructor(source, flow_graph, replacement_instr) {
    this.source = source;
    this.flow_graph = flow_graph;
    this.replacement_instr = replacement_instr;
  }
}

/** IrMatch represents the matched state of an IrPattern. */
export class IrMatch {
  constructor({ asm_data, symbolic_registers = new Map(), symbolic_args = new Map(), ref_map = new Map(), body = [] }) {
    this.asm_data = asm_data;
    this.symbolic_registers = symbolic_registers;
    this.symbolic_args = symbolic_args;
    this.ref_map = ref_map;
    this.body = body;
  }
  static _is_symbolic_reg(arg) {
    return arg.register_name.length <= 1;
  }
  static _is_symbolic_sym(arg) {
    return isupper(arg.symbol_name);
  }
  static _is_label_sym(arg) {
    return arg.symbol_name.startsWith(".");
  }
  eval_math(pat) {
    if (pat instanceof AsmLiteral) return pat;
    if (pat instanceof BinOp) {
      const lhs = this.eval_math(pat.lhs);
      const rhs = this.eval_math(pat.rhs);
      if (lhs instanceof AsmLiteral && rhs instanceof AsmLiteral) {
        if (pat.op === "+") return new AsmLiteral(lhs.value + rhs.value);
        if (pat.op === "-") return new AsmLiteral(lhs.value - rhs.value);
        if (pat.op === "<<") return new AsmLiteral(shl(lhs.value, rhs.value));
      }
      return new BinOp(pat.op, lhs, rhs);
    } else if (pat instanceof AsmGlobalSymbol) {
      pyassert(this.symbolic_args.has(pat.symbol_name), `undefined variable in math pattern: ${pat.symbol_name}`);
      return this.symbolic_args.get(pat.symbol_name);
    } else {
      pyassert(false, `bad pattern expr: ${pat}`);
    }
  }
  map_reg(key) {
    const ret = this.symbolic_registers.get(key.register_name);
    if (ret !== undefined && ret !== null) return ret;
    pyassert(!IrMatch._is_symbolic_reg(key));
    return key;
  }
  map_arg(key) {
    if (key instanceof AsmLiteral) return key;
    if (key instanceof Register) return this.map_reg(key);
    if (key instanceof AsmGlobalSymbol) {
      pyassert(!IrMatch._is_label_sym(key), "not supported yet");
      if (IrMatch._is_symbolic_sym(key)) {
        if (!this.symbolic_args.has(key.symbol_name)) throw new Error(`KeyError: '${key.symbol_name}'`);
        return this.symbolic_args.get(key.symbol_name);
      }
      return key;
    }
    if (key instanceof AsmAddressMode) return new AsmAddressMode(this.map_reg(key.base), this.map_arg(key.addend), key.writeback);
    if (key instanceof BinOp) return this.eval_math(key);
    pyassert(false, `bad pattern part: ${key}`);
  }
  map_ref(key) {
    const refset = this.ref_map.get(key);
    if (refset === undefined) throw new Error("KeyError: ref");
    const value = refset.get_unique();
    pyassert(value instanceof InstrRef);
    return value;
  }
  try_map_ref(key) {
    const refset = this.ref_map.get(key);
    if (refset === undefined) return null;
    return refset.get_unique();
  }
  map_location(key) {
    if (key instanceof Register) return this.map_reg(key);
    if (key instanceof StackLocation) {
      const loc = StackLocation.from_offset(this.map_arg(key.offset_as_arg()));
      pyassert(loc !== null);
      return loc;
    }
    assert_never(key);
  }
  map_asm(key) {
    return new AsmInstruction(
      key.mnemonic,
      key.args.map((a) => this.map_arg(a)),
    );
  }
}

/** Partial (in-progress) match state of an IrPattern. */
export class TryIrMatch extends IrMatch {
  _match_var(var_map, key, value, eq = (a, b) => a === b) {
    if (var_map.has(key)) {
      if (!eq(var_map.get(key), value)) return false;
    } else var_map.set(key, value);
    return true;
  }
  match_arg(pat, cand) {
    if (pat instanceof AsmLiteral) return pat === cand;
    if (pat instanceof Register) {
      if (!IrMatch._is_symbolic_reg(pat)) return pat === cand;
      if (!(cand instanceof Register)) return false;
      return this._match_var(this.symbolic_registers, pat.register_name, cand);
    }
    if (pat instanceof AsmGlobalSymbol) {
      pyassert(!IrMatch._is_label_sym(pat), "not supported yet");
      if (IrMatch._is_symbolic_sym(pat)) return this._match_var(this.symbolic_args, pat.symbol_name, cand);
      return pat === cand;
    }
    if (pat instanceof AsmAddressMode) {
      return cand instanceof AsmAddressMode && this.match_arg(pat.base, cand.base) && this.match_arg(pat.addend, cand.addend) && pat.writeback === cand.writeback;
    }
    if (pat instanceof BinOp) return this.eval_math(pat) === cand;
    if (pat instanceof RegisterList) {
      return cand instanceof RegisterList && cand.regs.length === pat.regs.length && cand.regs.every((cr, i) => this.match_arg(cr, pat.regs[i]));
    }
    pyassert(false, `bad pattern arg: ${pat}`);
  }
  match_instr(pat, cand) {
    if (pat.mnemonic !== cand.mnemonic || pat.args.length !== cand.args.length) return false;
    return pat.args.every((a, i) => this.match_arg(a, cand.args[i]));
  }
  match_refset(pat, cand_set) {
    return this._match_var(this.ref_map, pat, cand_set.copy(), (a, b) => a.equals(b));
  }
  match_inputrefs(pat, cand) {
    for (const [pat_loc, pat_refs] of pat.items()) {
      const cand_loc = this.map_location(pat_loc);
      const cand_refs = cand.get(cand_loc);
      const pat_ref = pat_refs.get_unique();
      pyassert(pat_ref !== null, "patterns can not have phis");
      if (!this.match_refset(pat_ref, cand_refs)) return false;
    }
    return true;
  }
  rename_reg(pat, new_reg) {
    this.symbolic_registers.set(pat.register_name, new_reg);
  }
}

export function simplify_ir_patterns(arch, asm_data, flow_graph, patterns, { debug_patterns }) {
  const refs_by_mnemonic = new DefaultMap(() => []);
  for (const node of flow_graph.nodes) for (const ref of node.block.instruction_refs) refs_by_mnemonic.get(ref.instruction.mnemonic).push(ref);

  let fictive_reg_index = 0;

  for (const pattern_base of patterns) {
    const pattern = pattern_base.compile(arch);
    pyassert(pattern.flow_graph.nodes.length === 2, "branching patterns not yet supported");
    pyassert(pattern.flow_graph.nodes[0] instanceof BaseNode);
    pyassert(pattern.flow_graph.nodes[1] instanceof TerminalNode);
    const pattern_node = pattern.flow_graph.nodes[0];
    const pattern_refs = pattern_node.block.instruction_refs;

    const n_inputs = pattern.replacement_instr.inputs.length;
    const input_refs = pattern_refs.slice(0, n_inputs);
    const body_refs = pattern_refs.slice(n_inputs, -1);
    const tail_ref = pattern_refs[pattern_refs.length - 1];
    pyassert(input_refs.every((r) => r.instruction.mnemonic === "in.fictive"));
    pyassert(body_refs.every((r) => r.instruction.mnemonic !== "in.fictive"));
    pyassert(pattern.replacement_instr.inputs.every((inp) => inp instanceof Register));
    const ro = pattern.replacement_instr.outputs;
    const to = tail_ref.instruction.outputs;
    pyassert(ro.length === to.length && ro.every((x, i) => x === to[i]), `${ro} ${to}`);

    const cands = refs_by_mnemonic.has(tail_ref.instruction.mnemonic) ? refs_by_mnemonic.get(tail_ref.instruction.mnemonic) : [];
    for (const cand_tail_ref of cands) {
      const state = new TryIrMatch({ asm_data });
      if (!state.match_refset(tail_ref, new RefSet([cand_tail_ref]))) continue;

      let is_match = true;
      for (const pat_ref of [tail_ref, ...[...body_refs].reverse()]) {
        const cand = state.try_map_ref(pat_ref);
        const pat_inputs = pattern.flow_graph.instr_inputs.get(pat_ref);
        if (!(cand instanceof InstrRef && state.match_instr(pat_ref.instruction, cand.instruction) && state.match_inputrefs(pat_inputs, flow_graph.instr_inputs.get(cand)))) {
          is_match = false;
          break;
        }
      }
      if (!is_match) continue;

      for (const pat_ref of [...body_refs, tail_ref]) state.body.push(state.map_ref(pat_ref));

      if (!pattern.source.check(state, arch, flow_graph)) continue;

      const temp_reg_refs = new Map();
      for (const pat_ref of input_refs) {
        pyassert(pat_ref.instruction.outputs.length === 1);
        const input_reg = pat_ref.instruction.outputs[0];
        pyassert(input_reg instanceof Register);
        const input_uses = pattern.flow_graph.instr_uses.get(pat_ref).get(input_reg);
        const input_use_ref = state.map_ref(input_uses.refs[0]);
        const original_reg = state.map_reg(input_reg);
        const temp_reg = Register.fictive(original_reg.register_name, String(fictive_reg_index));
        fictive_reg_index += 1;
        state.rename_reg(input_reg, temp_reg);

        const move_asm = new AsmInstruction("move.fictive", [temp_reg, original_reg]);
        const move_ref = input_use_ref.add_instruction_before(move_asm, arch);
        temp_reg_refs.set(temp_reg, move_ref);

        for (const src_ref of flow_graph.instr_inputs.get(input_use_ref).get(original_reg)) {
          flow_graph.add_instruction_use({ use: move_ref, loc: original_reg, src: src_ref });
        }
      }

      const repl_ref = state.map_ref(tail_ref);
      const repl_asm = state.map_asm(pattern.replacement_instr);
      repl_ref.replace_instruction(repl_asm, arch);

      flow_graph.clear_instruction_inputs(repl_ref);
      for (const [temp_reg, temp_ref] of temp_reg_refs) flow_graph.add_instruction_use({ use: repl_ref, loc: temp_reg, src: temp_ref });

      for (const pat_ref of [...body_refs].reverse()) {
        const cand_ref = state.map_ref(pat_ref);
        if (flow_graph.instr_uses.get(cand_ref).is_empty()) {
          const nop_asm = new AsmInstruction("nop", []);
          cand_ref.replace_instruction(nop_asm, arch);
          flow_graph.clear_instruction_inputs(cand_ref);
        } else if (!cand_ref.instruction.in_pattern) {
          cand_ref.instruction = cand_ref.instruction.replace({ in_pattern: true });
        }
      }

      if (debug_patterns) {
        print(`Rewrote asm using ${pattern.constructor.name}:`);
        print();
        for (const node of flow_graph.nodes) {
          const instrs = node.block.instructions;
          if (instrs.length) {
            print(`${node.block.approx_label_name}:`);
            for (const ins of node.block.instructions) print(String(ins));
          }
        }
        print();
      }
    }
  }
  flow_graph.validate_instruction_graph();
}
