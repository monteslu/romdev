// Port of m2c/flow_graph.py
/* eslint no-unused-vars: ["error", { "args": "none" }] -- keeps upstream's parameter lists */
import { DecompFailure } from "./error.js";
import { Target } from "./options.js";
import { AsmSymbolicData, Function, Label } from "./asm_file.js";
import { AsmAddressMode, AsmGlobalSymbol, AsmLiteral, BinOp, JumpTarget, Macro, Register } from "./asm_instruction.js";
import { ArchAsm, Instruction } from "./instruction.js";
import { simplify_patterns } from "./asm_pattern.js";
import { DefaultMap, ValueError, intern, pyassert, lstrip, sorted, compare, shallowcopy } from "./py.js";
import { print } from "./io.js";

export class ArchFlowGraph extends ArchAsm {
  process_flowgraph(asm_data, flow_graph) {}
  simplify_ir(asm_data, flow_graph, { debug_patterns }) {}
}

ArchFlowGraph.prototype.asm_patterns = [];

/** Reference acts as a pointer to either a specific Instruction, or one of the function's bounds */
export class Reference {}

/** Reference to a Location's value before the start of a function (e.g. constants, args) */
export class PrologueRef extends Reference {
  constructor(location) {
    super();
    this.location = location;
    return intern(this, [location]);
  }
}

/** Reference to return values of a function */
export class EpilogueRef extends Reference {
  constructor(location) {
    super();
    this.location = location;
    return intern(this, [location]);
  }
}

/** Pointer to an Instruction as part of a Block. */
export class InstrRef extends Reference {
  constructor(instruction, block) {
    super();
    this.instruction = instruction;
    this.block = block;
  }
  /** Add `asm` into the parent assembly before this instruction. */
  add_instruction_before(asm, arch) {
    const instr = arch.parse(asm.mnemonic, asm.args, this.instruction.meta.derived());
    const ref = new InstrRef(instr, this.block);
    const index = this.block.instruction_refs.indexOf(this);
    if (index < 0) throw new ValueError("x not in list");
    this.block.instruction_refs.splice(index, 0, ref);
    return ref;
  }
  /** Replace the existing instruction with `new_asm`. */
  replace_instruction(new_asm, arch) {
    const old_instr = this.instruction;
    const new_instr = arch.parse(new_asm.mnemonic, new_asm.args, old_instr.meta.derived());
    for (const loc of [...old_instr.outputs, ...old_instr.clobbers]) {
      if (!new_instr.clobbers.includes(loc)) new_instr.clobbers.push(loc);
    }
    this.instruction = new_instr;
  }
}

export class Block {
  constructor(index, label, approx_label_name, instruction_refs = [], is_safeguard = false, block_info = null) {
    this.index = index;
    this.label = label;
    this.approx_label_name = approx_label_name;
    this.instruction_refs = instruction_refs;
    this.is_safeguard = is_safeguard;
    // block_info is actually an Optional[BlockInfo], set by translate.js
    this.block_info = block_info;
  }
  get instructions() {
    return this.instruction_refs.map((r) => r.instruction);
  }
  add_block_info(block_info) {
    pyassert(this.block_info === null);
    this.block_info = block_info;
  }
  clone() {
    const ret = shallowcopy(this);
    ret.instruction_refs = this.instruction_refs.map((ref) => new InstrRef(ref.instruction.clone(), ret));
    return ret;
  }
  toString() {
    const name = `${this.index} (${this.approx_label_name})`;
    const inst_str = this.instructions.map((instr) => "    " + String(instr)).join("\n");
    return `# ${name}\n${inst_str}\n`;
  }
}

export class BlockBuilder {
  constructor() {
    this._curr_index = 0;
    this._curr_label = null;
    this._last_label_name = "initial";
    this._label_counter = 0;
    this._curr_instructions = [];
    this._blocks = [];
  }
  new_block() {
    if (this._curr_instructions.length === 0) return null;
    let label_name = this._last_label_name;
    if (this._label_counter > 0) label_name += `.${this._label_counter}`;
    const block = new Block(this._curr_index, this._curr_label, label_name);
    for (const i of this._curr_instructions) block.instruction_refs.push(new InstrRef(i, block));
    this._blocks.push(block);
    this._curr_index += 1;
    this._curr_label = null;
    this._label_counter += 1;
    this._curr_instructions = [];
    return block;
  }
  add_instruction(instruction) {
    this._curr_instructions.push(instruction);
  }
  set_label(label) {
    pyassert(!this._curr_label, "Cannot have two labels in a row ({label} vs {self._curr_label})");
    this._curr_label = label;
    this._last_label_name = label.names[0];
    this._label_counter = 0;
  }
  is_empty() {
    return !this._blocks.length && !this._curr_instructions.length;
  }
  get_blocks() {
    return this._blocks;
  }
}

function verify_no_trailing_delay_slot(fn) {
  let last_ins = null;
  for (const item of fn.body) if (item instanceof Instruction) last_ins = item;
  if (last_ins && last_ins.has_delay_slot) throw new DecompFailure(`Last instruction is missing a delay slot:\n${last_ins}`);
}

export function invert_mips_branch_mnemonic(mnemonic) {
  const inverses = { beq: "bne", bne: "beq", beqz: "bnez", bnez: "beqz", bgez: "bltz", bgtz: "blez", blez: "bgtz", bltz: "bgez", bc1t: "bc1f", bc1f: "bc1t" };
  if (!Object.prototype.hasOwnProperty.call(inverses, mnemonic)) throw new Error(`KeyError: '${mnemonic}'`);
  return inverses[mnemonic];
}

export function internal_label(base, related = "") {
  // (upstream computes `rel` but does not use it)
  void (related ? lstrip(related, ".") + "_" : "");
  return `._m2c_${related}${base}`;
}

function normalize_gcc_likely_branches(fn, arch) {
  const new_function = fn.bodyless_copy();
  const new_body = new_function.body;
  fn.body.forEach((item, i) => {
    if (item instanceof Instruction && item.is_branch_likely && item.jump_target instanceof JumpTarget && i + 2 < fn.body.length) {
      const ins = fn.body[i + 1];
      const label = fn.body[i + 2];
      if (ins instanceof Instruction && label instanceof Label && label.names.includes(item.jump_target.target)) {
        const mn_inverted = invert_mips_branch_mnemonic(item.mnemonic.slice(0, -1));
        new_body.push(arch.parse(mn_inverted, item.args, item.meta.derived()));
        new_body.push(arch.parse("nop", [], item.meta.derived()));
        return;
      }
    }
    new_body.push(item);
  });
  return new_function;
}

function iterOf(arr) {
  const it = arr[Symbol.iterator]();
  return {
    next_or_throw() {
      const r = it.next();
      if (r.done) throw new Error("StopIteration");
      return r.value;
    },
    *[Symbol.iterator]() {
      for (;;) {
        const r = it.next();
        if (r.done) return;
        yield r.value;
      }
    },
  };
}

function normalize_ido_likely_branches(fn, asm_data, arch) {
  const seen_instrs = new Set();
  const label_names = new Map();
  const label_prev_instr = new Map();
  const label_before_instr = new Map();
  const instr_before_instr = new Map();
  let prev_instr = null;
  let prev_label = null;
  let prev_item = null;
  for (const item of fn.body) {
    if (item instanceof Instruction) {
      pyassert(!seen_instrs.has(item));
      seen_instrs.add(item);
      if (prev_label !== null) {
        label_before_instr.set(item, prev_label.names[0]);
        prev_label = null;
      }
      if (prev_item instanceof Instruction) instr_before_instr.set(item, prev_item);
      prev_instr = item;
    } else if (item instanceof Label) {
      for (const name of item.names) {
        label_prev_instr.set(name, prev_instr);
        label_names.set(name, new Set(item.names));
      }
      prev_label = item;
      prev_instr = null;
    }
    prev_item = item;
  }

  const untouched_targets = new Set();
  const addAll = (set, other) => {
    for (const x of other ?? []) set.add(x);
  };

  const may_transform_branch = (item, next_item, before_target, pre = false) => {
    if (!item.has_delay_slot) return false;
    if (before_target === next_item) return false;
    if (String(before_target) !== String(next_item)) return false;
    const next_mn = next_item.mnemonic;
    if (!item.is_branch_likely && next_mn === "nop") return false;
    if (arch.arch === Target.ArchEnum.SH) {
      pyassert(item.jump_target instanceof JumpTarget);
      const label = item.jump_target.target;
      if (!(next_mn.startsWith("cmp/") || next_mn === "tst")) return false;
      if (untouched_targets.has(label) && !pre) return false;
    } else {
      if (!item.is_branch_likely && item.mnemonic !== "b") return false;
    }
    if (!item.is_conditional) {
      const before_before_target = instr_before_instr.get(before_target) ?? null;
      if (before_before_target !== null && before_before_target.has_delay_slot) return false;
    }
    return true;
  };

  if (arch.arch === Target.ArchEnum.SH) {
    for (const label of asm_data.mentioned_labels) addAll(untouched_targets, label_names.get(label));
    for (let i = 0; i + 1 < fn.body.length; i++) {
      const item = fn.body[i];
      const next_item = fn.body[i + 1];
      if (!(item instanceof Instruction)) continue;
      if (Array.isArray(item.jump_target)) {
        for (const target of item.jump_target) addAll(untouched_targets, label_names.get(target.target));
      } else if (item.jump_target instanceof JumpTarget) {
        const before_target = label_prev_instr.get(item.jump_target.target) ?? null;
        if (next_item instanceof Instruction && before_target !== null && may_transform_branch(item, next_item, before_target, true)) continue;
        addAll(untouched_targets, label_names.get(item.jump_target.target));
      }
    }
  }

  const insert_label_before = new Map();
  const new_body = [];
  const body_iter = iterOf(fn.body);
  for (const item of body_iter) {
    if (!(item instanceof Instruction) || !(item.jump_target instanceof JumpTarget)) {
      new_body.push([item, item]);
      continue;
    }
    const next_item = body_iter.next_or_throw();
    const before_target = label_prev_instr.get(item.jump_target.target) ?? null;
    if (next_item instanceof Instruction && before_target !== null && may_transform_branch(item, next_item, before_target)) {
      if (!label_before_instr.has(before_target)) {
        const new_label = internal_label("before", item.jump_target.target);
        label_before_instr.set(before_target, new_label);
        insert_label_before.set(before_target, new_label);
      }
      const new_target = label_before_instr.get(before_target);
      const mn = item.mnemonic;
      const mn_unlikely = item.is_branch_likely ? mn.slice(0, -1) : mn;
      const new_item = arch.parse(mn_unlikely, [...item.args.slice(0, -1), new AsmGlobalSymbol(new_target)], item.meta.derived());
      let new_next_item;
      if (item.is_conditional && !item.is_branch_likely) new_next_item = next_item;
      else new_next_item = arch.parse("nop", [], new_item.meta.derived());
      new_body.push([item, new_item]);
      new_body.push([next_item, new_next_item]);
    } else {
      new_body.push([item, item]);
      new_body.push([next_item, next_item]);
    }
  }

  const new_function = fn.bodyless_copy();
  for (const [orig_item, new_item] of new_body) {
    if (orig_item instanceof Instruction && insert_label_before.has(orig_item)) new_function.new_label(insert_label_before.get(orig_item));
    new_function.body.push(new_item);
  }
  return new_function;
}

function minimize_labels(fn, asm_data) {
  const labels_used = new Set();
  for (const label of fn.body) if (label instanceof Label) for (const name of label.names) if (asm_data.mentioned_labels.has(name)) labels_used.add(name);
  for (const item of fn.body) {
    if (item instanceof Instruction) {
      if (item.jump_target instanceof JumpTarget) labels_used.add(item.jump_target.target);
      if (item.function_target instanceof AsmGlobalSymbol) labels_used.add(item.function_target.symbol_name);
    }
  }
  const new_function = fn.bodyless_copy();
  let cur_label = [];
  for (const item of fn.body) {
    if (item instanceof Label) cur_label.push(...item.names.filter((name) => labels_used.has(name)));
    else {
      if (cur_label.length) {
        new_function.body.push(new Label(cur_label));
        cur_label = [];
      }
      new_function.body.push(item);
    }
  }
  if (cur_label.length) new_function.body.push(new Label(cur_label));
  return new_function;
}

function simplify_standard_patterns(fn, asm_data, arch, debug_patterns) {
  const new_body = simplify_patterns(fn.body, arch.asm_patterns, asm_data, arch, { debug_patterns });
  const new_function = fn.bodyless_copy();
  new_function.body.push(...new_body);
  return new_function;
}

function build_blocks(fn, asm_data, arch, { fragment, debug_patterns }) {
  if (!fragment) {
    if (arch.has_delay_slots) {
      verify_no_trailing_delay_slot(fn);
      fn = minimize_labels(fn, asm_data);
      if (arch.arch === Target.ArchEnum.MIPS) fn = normalize_gcc_likely_branches(fn, arch);
      fn = normalize_ido_likely_branches(fn, asm_data, arch);
    }
    fn = minimize_labels(fn, asm_data);
    fn = simplify_standard_patterns(fn, asm_data, arch, debug_patterns);
    fn = minimize_labels(fn, asm_data);
  }

  const block_builder = new BlockBuilder();
  const body_iter = iterOf(fn.body);
  const branch_likely_counts = new Map();
  let cond_return_target = null;

  const process_delay_slots = (item) => {
    if (item instanceof Label) {
      block_builder.new_block();
      block_builder.set_label(item);
      return;
    }
    if (!item.has_delay_slot) {
      process_no_delay_slots(item);
      return;
    }
    const process_after = [];
    let next_item = body_iter.next_or_throw();

    if (next_item instanceof Label) {
      const label = next_item;
      next_item = body_iter.next_or_throw();
      pyassert(next_item instanceof Instruction, "Cannot have two labels in a row");
      if (item.is_branch_likely || item.function_target !== null) {
        let msg = [
          `Label ${label} refers to a delay slot; this is currently not supported.`,
          "Please modify the assembly to work around it (e.g. copy the instruction",
          "to all jump sources and move the label, or add a nop to the delay slot).",
        ];
        if (label.names[0].includes("_before")) {
          msg = msg.concat([
            "",
            "This label was auto-generated as the target for a branch-likely",
            "instruction (e.g. beql); you can also try to turn that into a non-likely",
            "branch if that's equivalent in this context, i.e., if it's okay to",
            "execute its delay slot unconditionally.",
          ]);
        }
        throw new DecompFailure(msg.join("\n"));
      } else if (next_item.outputs.every((x) => !next_item.inputs.includes(x)) && !next_item.is_store) {
        process_after.push(label);
        process_after.push(next_item.clone());
      } else {
        pyassert(item.jump_target instanceof JumpTarget, "has delay slot and isn't a call");
        const target = item.jump_target.target;
        const temp_label = internal_label("skip", label.names[0]);
        const meta = item.meta.derived();
        const nop = arch.parse("nop", [], meta);
        block_builder.add_instruction(arch.parse(item.mnemonic, [...item.args.slice(0, -1), new AsmGlobalSymbol(temp_label)], item.meta));
        block_builder.add_instruction(nop);
        block_builder.new_block();
        block_builder.add_instruction(arch.parse("b", [new AsmGlobalSymbol(label.names[0])], item.meta.derived()));
        block_builder.add_instruction(nop.clone());
        block_builder.new_block();
        block_builder.set_label(Label.new(temp_label));
        block_builder.add_instruction(arch.parse("b", [new AsmGlobalSymbol(target)], item.meta.derived()));
        block_builder.add_instruction(next_item.clone());
        block_builder.new_block();
        block_builder.set_label(label);
        block_builder.add_instruction(next_item);
        return;
      }
    }

    if (next_item.has_delay_slot) throw new DecompFailure(`Two delay slot instructions in a row is not supported:\n${item}\n${next_item}`);

    if (item.is_branch_likely) {
      pyassert(item.jump_target instanceof JumpTarget);
      const target = item.jump_target.target;
      branch_likely_counts.set(target, (branch_likely_counts.get(target) ?? 0) + 1);
      const index = branch_likely_counts.get(target);
      const mn_inverted = invert_mips_branch_mnemonic(item.mnemonic.slice(0, -1));
      const temp_label = internal_label(`branchlikelyskip_${index}`, target);
      const branch_not = arch.parse(mn_inverted, [...item.args.slice(0, -1), new AsmGlobalSymbol(temp_label)], item.meta.derived());
      const nop = arch.parse("nop", [], item.meta.derived());
      block_builder.add_instruction(branch_not);
      block_builder.add_instruction(nop);
      block_builder.new_block();
      block_builder.add_instruction(next_item);
      block_builder.add_instruction(arch.parse("b", [new AsmGlobalSymbol(target)], item.meta.derived()));
      block_builder.add_instruction(nop.clone());
      block_builder.new_block();
      block_builder.set_label(Label.new(temp_label));
      block_builder.add_instruction(nop.clone());
    } else if (item.function_target !== null) {
      if (item.args.length >= 2 && (next_item.outputs.includes(item.args[1]) || next_item.clobbers.includes(item.args[1]))) {
        throw new DecompFailure(`Instruction after ${item.mnemonic} clobbers its source\n` + "register, which is currently not supported.\n\n" + "Try rewriting the assembly to avoid that.");
      }
      block_builder.add_instruction(next_item);
      block_builder.add_instruction(item);
    } else {
      block_builder.add_instruction(item);
      block_builder.add_instruction(next_item);
    }

    if (item.is_jump()) block_builder.new_block();

    for (const it of process_after) process_delay_slots(it);
  };

  const process_no_delay_slots = (item) => {
    if (item instanceof Label) {
      block_builder.new_block();
      block_builder.set_label(item);
      return;
    }
    if (item.is_conditional && Array.isArray(item.jump_target)) {
      for (let i = 0; i < item.jump_target.length; i++) {
        if (item.jump_target[i] === new JumpTarget("_m2c_ret")) {
          if (cond_return_target === null) cond_return_target = internal_label("conditionalreturn");
          item.jump_target[i] = new JumpTarget(cond_return_target);
        }
      }
    }
    if (item.is_conditional && item.is_return) {
      if (cond_return_target === null) cond_return_target = internal_label("conditionalreturn");
      pyassert(item.mnemonic.slice(-2) === "lr");
      const branch_instr = arch.parse(item.mnemonic.slice(0, -2), [new AsmGlobalSymbol(cond_return_target)], item.meta.derived());
      block_builder.add_instruction(branch_instr);
      block_builder.new_block();
      return;
    }
    block_builder.add_instruction(item);
    if (item.is_jump()) block_builder.new_block();
  };

  if (arch.has_delay_slots && !fragment) {
    for (const item of body_iter) process_delay_slots(item);
  } else {
    for (const item of body_iter) process_no_delay_slots(item);
  }

  if (block_builder.is_empty()) throw new DecompFailure(`Function ${fn.name} contains no instructions. Maybe it is rodata?`);

  if (fragment) {
    block_builder.new_block();
    return block_builder.get_blocks();
  }

  for (const instr of arch.missing_return()) block_builder.add_instruction(instr);
  const emitted_block = block_builder.new_block();
  pyassert(emitted_block !== null);
  emitted_block.is_safeguard = true;

  if (cond_return_target !== null) {
    block_builder.set_label(Label.new(cond_return_target));
    for (const instr of arch.missing_return()) block_builder.add_instruction(instr);
    block_builder.new_block();
  }
  return block_builder.get_blocks();
}

function verify_no_duplicate_instructions(blocks) {
  const seen = new Set();
  for (const block of blocks) {
    for (const instr of block.instructions) {
      pyassert(!seen.has(instr), "Instructions must be clone()ed if emitted twice");
      seen.add(instr);
    }
  }
}

export class BaseNode {
  constructor(block, emit_goto) {
    this.block = block;
    this.emit_goto = emit_goto;
    this.parents = [];
    this.dominators = new Set();
    this.immediate_dominator = null;
    this.immediately_dominates = [];
    this.postdominators = new Set();
    this.immediate_postdominator = null;
    this.immediately_postdominates = [];
    // This is only populated on the head node of the loop
    this.loop = null;
  }
  name() {
    return String(this.block.index);
  }
  children() {
    throw new Error("abstract");
  }
  __repr__() {
    return `<${this.constructor.name}: ${this.name()}>`;
  }
}

export class BasicNode extends BaseNode {
  constructor(block, emit_goto, successor, fake_successor = null) {
    super(block, emit_goto);
    this.successor = successor;
    // Optional link to the TerminalNode, used to make infinite loops reducible.
    this.fake_successor = fake_successor;
  }
  children() {
    if (this.fake_successor !== null) return [this.successor, this.fake_successor];
    return [this.successor];
  }
  toString() {
    return [`${this.block}\n`, `# ${this.name()} -> ${this.successor.name()}`, this.loop ? " (loop)" : "", this.emit_goto ? " (goto)" : ""].join("");
  }
}

export class ConditionalNode extends BaseNode {
  constructor(block, emit_goto, conditional_edge, fallthrough_edge) {
    super(block, emit_goto);
    this.conditional_edge = conditional_edge;
    this.fallthrough_edge = fallthrough_edge;
  }
  children() {
    if (this.conditional_edge === this.fallthrough_edge) return [this.conditional_edge];
    return [this.conditional_edge, this.fallthrough_edge];
  }
  toString() {
    return [
      `${this.block}\n`,
      `# ${this.name()} -> `,
      `cond: ${this.conditional_edge.name()}`,
      this.loop ? " (loop)" : "",
      ", ",
      `def: ${this.fallthrough_edge.name()}`,
      this.emit_goto ? " (goto)" : "",
    ].join("");
  }
}

export class ReturnNode extends BaseNode {
  constructor(block, emit_goto, index, terminal) {
    super(block, emit_goto);
    this.index = index;
    this.terminal = terminal;
  }
  children() {
    return [this.terminal];
  }
  name() {
    const name = super.name();
    return this.is_real() ? name : `${name}.${this.index}`;
  }
  is_real() {
    return this.index === 0;
  }
  toString() {
    return [`${this.block}\n`, `# ${this.name()} -> ret`, this.emit_goto ? " (goto)" : ""].join("");
  }
}

export class SwitchNode extends BaseNode {
  constructor(block, emit_goto, cases) {
    super(block, emit_goto);
    this.cases = cases;
  }
  children() {
    const seen = new Set();
    const children = [];
    for (const node of this.cases) {
      if (!seen.has(node)) {
        seen.add(node);
        children.push(node);
      }
    }
    return children;
  }
  toString() {
    const targets = this.cases.map((c) => c.name()).join(", ");
    return `${this.block}\n# ${this.name()} -> ${targets}`;
  }
}

/** A fictive node that acts as a common postdominator for every node in the flowgraph. */
export class TerminalNode extends BaseNode {
  static terminal() {
    return new TerminalNode(new Block(-1, null, "", []), false);
  }
  children() {
    return [];
  }
  toString() {
    return "return";
  }
}

export class NaturalLoop {
  constructor(head, nodes = new Set(), backedges = new Set()) {
    this.head = head;
    this.nodes = nodes;
    this.backedges = backedges;
  }
}

export function get_literal_pool_symbolic_data(arg, asm_data) {
  let offset = 0;
  if (arg instanceof BinOp && arg.op === "+" && arg.rhs instanceof AsmLiteral) {
    offset = arg.rhs.value;
    arg = arg.lhs;
  }
  if (!(arg instanceof AsmGlobalSymbol)) return null;
  const ent = asm_data.values.get(arg.symbol_name) ?? null;
  if (ent === null || !ent.is_text) return null;
  const data = ent.data_at_offset(offset, 4);
  if (!(data instanceof AsmSymbolicData)) return null;
  return data;
}

export function get_literal_pool_symbol(arg, asm_data) {
  const data = get_literal_pool_symbolic_data(arg, asm_data);
  if (data === null) return null;
  return data.as_symbol_without_addend();
}

export function arm_jtbl_for_ldr(arg, asm_data) {
  const jtbl_name = get_literal_pool_symbol(arg, asm_data);
  if (jtbl_name === null) return null;
  const ent = asm_data.values.get(jtbl_name) ?? null;
  if (ent === null || !ent.is_text || !ent.data.length || !(ent.data[0] instanceof AsmSymbolicData) || ent.data[0].as_symbol_without_addend() === null) return null;
  return jtbl_name;
}

function build_graph_from_block(block, blocks, parent_blocks, nodes, asm_data, arch) {
  for (const node of nodes) if (node.block === block) return node;

  let new_node;
  const dummy_node = null;
  const terminal_node = nodes[0];
  pyassert(terminal_node instanceof TerminalNode, "expected first node to be TerminalNode");

  const find_block_by_label = (label) => {
    for (const b of blocks) if (b.label && b.label.names.includes(label)) return b;
    return null;
  };
  const blockAt = (i) => {
    if (i >= blocks.length) throw new Error("IndexError: list index out of range");
    return blocks[i];
  };

  const jumps = block.instructions.filter((inst) => inst.is_jump());
  pyassert(jumps.length === 0 || jumps.length === 1, "too many jump instructions in one block");

  if (jumps.length === 0) {
    new_node = new BasicNode(block, false, dummy_node);
    nodes.push(new_node);
    const next_block = blockAt(block.index + 1);
    new_node.successor = build_graph_from_block(next_block, blocks, [...parent_blocks, block], nodes, asm_data, arch);
  } else if (jumps.length === 1) {
    const jump = jumps[0];

    if (jump.is_return) {
      new_node = new ReturnNode(block, false, 0, terminal_node);
      nodes.push(new_node);
      return new_node;
    }

    if (jump.jump_target instanceof Register) {
      new_node = new SwitchNode(block, false, []);
      nodes.push(new_node);

      const jtbl_names = new Set();
      for (const jtbl_block of [block, ...[...parent_blocks].reverse()]) {
        for (const ins of jtbl_block.instructions) {
          for (let arg of ins.args) {
            if (arg instanceof AsmAddressMode) arg = arg.addend;
            if (
              arg instanceof Macro &&
              (arg.macro_name === "lo" || arg.macro_name === "l") &&
              arg.argument instanceof AsmGlobalSymbol &&
              ["jtbl", "jpt_", "lbl_", "jumptable_"].some((prefix) => arg.argument.symbol_name.startsWith(prefix))
            ) {
              jtbl_names.add(arg.argument.symbol_name);
            }
            if (ins.arch_mnemonic(arch) === "arm:ldr") {
              const jtbl_name = arm_jtbl_for_ldr(arg, asm_data);
              if (jtbl_name !== null) jtbl_names.add(jtbl_name);
            }
          }
        }
        if (jtbl_names.size) break;
      }
      if (jtbl_names.size > 1) {
        throw new DecompFailure(
          `Unable to determine jump table for ${jump.mnemonic} instruction ${jump.meta.loc_str()}.\n\n` +
            `Found multiple candidates: ${sorted(jtbl_names).join(", ")}\n` +
            "You can help m2c's analysis by putting a copy of the jump table\n" +
            "setup instructions within the same block as the jump instruction.",
        );
      }
      if (!jtbl_names.size) {
        let help_text = "";
        if (arch.arch !== Target.ArchEnum.ARM) {
          help_text = "\n\nThere must be a read of a variable before the instruction\n" + 'which has a name starting with with "jtbl"/"jpt_"/"lbl_"/"jumptable_".';
        }
        throw new DecompFailure(`Unable to determine jump table for ${jump.mnemonic} instruction ${jump.meta.loc_str()}.${help_text}`);
      }

      const jtbl_name = [...jtbl_names][0];
      if (!asm_data.values.has(jtbl_name)) {
        throw new DecompFailure(
          `Found ${jump.mnemonic} instruction ${jump.meta.loc_str()}, but the ` +
            "corresponding jump table is not provided.\n" +
            "\n" +
            "Please include it in the input .s file(s), or in an additional file.\n",
        );
      }
      const jtbl_value = asm_data.values.get(jtbl_name);
      jtbl_value.is_jtbl = true;
      for (const entry of jtbl_value.data) {
        if (entry instanceof Uint8Array) break;
        const sym = entry.as_symbol_without_addend();
        if (sym === null) break;
        const case_block = find_block_by_label(sym);
        if (case_block === null) throw new DecompFailure(`Cannot find jtbl target ${sym}`);
        const case_node = build_graph_from_block(case_block, blocks, [...parent_blocks, block], nodes, asm_data, arch);
        new_node.cases.push(case_node);
      }
      return new_node;
    }

    if (Array.isArray(jump.jump_target)) {
      new_node = new SwitchNode(block, false, []);
      nodes.push(new_node);
      for (const jump_target of jump.jump_target) {
        const case_block = find_block_by_label(jump_target.target);
        if (case_block === null) throw new DecompFailure(`Cannot find jtbl target ${jump_target}`);
        const case_node = build_graph_from_block(case_block, blocks, [...parent_blocks, block], nodes, asm_data, arch);
        new_node.cases.push(case_node);
      }
      return new_node;
    }

    const branch_label = jump.jump_target;
    pyassert(branch_label instanceof JumpTarget);
    const branch_block = find_block_by_label(branch_label.target);
    if (branch_block === null) throw new DecompFailure(`Cannot find branch target ${branch_label.target}`);

    const emit_goto = jump.meta.emit_goto;
    if (!jump.is_conditional) {
      new_node = new BasicNode(block, emit_goto, dummy_node);
      nodes.push(new_node);
      new_node.successor = build_graph_from_block(branch_block, blocks, [...parent_blocks, block], nodes, asm_data, arch);
    } else {
      new_node = new ConditionalNode(block, emit_goto, dummy_node, dummy_node);
      nodes.push(new_node);
      const next_block = blockAt(block.index + 1);
      new_node.conditional_edge = build_graph_from_block(branch_block, blocks, [...parent_blocks, block], nodes, asm_data, arch);
      new_node.fallthrough_edge = build_graph_from_block(next_block, blocks, [...parent_blocks, block], nodes, asm_data, arch);
    }
  }
  return new_node;
}

function is_trivial_return_block(block, arch) {
  for (const instr of block.instructions) {
    if (instr.is_store || instr.function_target !== null) return false;
    if ([...instr.inputs, ...instr.outputs].some((reg) => arch.all_return_regs.includes(reg))) return false;
  }
  return true;
}

/** Return the set of nodes that can reach `end` with `without` removed. */
function inv_reachable_without(end, without) {
  const reachable = new Set();
  const stack = [end];
  while (stack.length) {
    const node = stack.pop();
    if (node === without || reachable.has(node)) continue;
    reachable.add(node);
    stack.push(...node.parents);
  }
  return reachable;
}

function build_nodes(fn, blocks, asm_data, arch, { fragment }) {
  const terminal_node = TerminalNode.terminal();
  const graph = [terminal_node];
  if (fragment) blocks.push(terminal_node.block);
  const entry_block = blocks[0];
  build_graph_from_block(entry_block, blocks, [], graph, asm_data, arch);
  const terms = graph.filter((n) => n instanceof TerminalNode);
  pyassert(terms.length === 1 && terms[0] === terminal_node);
  terminal_node.block.index = Math.max(...graph.map((n) => n.block.index)) + 1;
  graph.sort((a, b) => a.block.index - b.block.index);
  return graph;
}

function warn_on_safeguard_use(fn, nodes, arch) {
  const node = nodes.find((n) => n.block.is_safeguard) ?? null;
  if (node) {
    const label = node.block.approx_label_name;
    const return_instrs = arch.missing_return();
    print(`Warning: missing "${return_instrs[0]}" in last block of ${fn.name} (${label}).\n`);
  }
}

/** Check whether a given edge in the flow graph is an early return. */
function is_premature_return(node, edge, nodes, arch) {
  if (nodes.length < 3) return false;
  const [antepenultimate_node, final_return_node, terminal_node] = nodes.slice(-3);
  pyassert(terminal_node instanceof TerminalNode);
  if (!(edge instanceof ReturnNode) || edge !== final_return_node) return false;
  if (!is_trivial_return_block(edge.block, arch)) return false;
  if (!(node instanceof BasicNode)) return false;
  return node !== antepenultimate_node;
}

/** For each jump to an early return node, create a duplicate return node for it to jump to. */
function duplicate_premature_returns(nodes, arch) {
  const extra_nodes = [];
  let index = 0;
  for (const node of nodes) {
    if (node instanceof BasicNode && !node.emit_goto && is_premature_return(node, node.successor, nodes, arch)) {
      pyassert(node.successor instanceof ReturnNode);
      index += 1;
      const n = new ReturnNode(node.successor.block.clone(), false, index, node.successor.terminal);
      node.successor = n;
      extra_nodes.push(n);
    }
  }
  nodes.push(...extra_nodes);
  nodes.sort((a, b) => a.block.index - b.block.index);

  const queue = [nodes[0]];
  const reachable_nodes = new Set(nodes.filter((n) => n instanceof TerminalNode));
  while (queue.length) {
    const node = queue.pop();
    reachable_nodes.add(node);
    for (const c of node.children()) if (!reachable_nodes.has(c) && !queue.includes(c)) queue.push(c);
  }
  return nodes.filter((n) => reachable_nodes.has(n));
}

/** Compute dominators, postdominators, and backedges for the set of nodes. */
export function compute_relations(nodes) {
  for (const node of nodes) node.parents = [];
  for (const node of nodes) for (const child of node.children()) child.parents.push(node);

  const nnodes = nodes.length;
  const index_of = new Map(nodes.map((n, i) => [n, i]));
  const words = Math.ceil(nnodes / 32) || 1;

  const compute_dominators = (entry, parents, dominators, immediately_dominates, set_immediate_dominator) => {
    // Bitsets as Uint32Array words (Python uses big ints).
    const doms = new Map();
    nodes.forEach((n, i) => {
      const bs = new Uint32Array(words);
      if (n === entry) bs[i >>> 5] |= 1 << (i & 31);
      else {
        for (let w = 0; w < words; w++) bs[w] = 0xffffffff;
        const extra = words * 32 - nnodes;
        if (extra > 0) bs[words - 1] = 0xffffffff >>> extra;
      }
      doms.set(n, bs);
    });
    let changes = true;
    while (changes) {
      changes = false;
      nodes.forEach((node, i) => {
        if (node === entry) return;
        const nset = Uint32Array.from(doms.get(node));
        for (const parent of parents(node)) {
          const p = doms.get(parent);
          for (let w = 0; w < words; w++) nset[w] &= p[w];
        }
        nset[i >>> 5] |= 1 << (i & 31);
        const cur = doms.get(node);
        let differ = false;
        for (let w = 0; w < words; w++) if (nset[w] !== cur[w]) differ = true;
        if (differ) {
          for (let w = 0; w < words; w++) pyassert((nset[w] & cur[w]) >>> 0 === nset[w] >>> 0);
          doms.set(node, nset);
          changes = true;
        }
      });
    }
    for (const n of nodes) {
      const bitset = doms.get(n);
      const nodeset = dominators(n);
      nodeset.clear();
      for (let i = 0; i < nnodes; i++) if (bitset[i >>> 5] & (1 << (i & 31))) nodeset.add(nodes[i]);
    }
    for (const node of nodes) immediately_dominates(node).length = 0;
    for (const node of nodes) {
      const ds = [...dominators(node)].filter((d) => d !== node);
      if (ds.length) {
        let imdom = null;
        let best = null;
        for (const d of ds) {
          const key = [dominators(d).size, d.block.index];
          if (best === null || compare(key, best) > 0) {
            best = key;
            imdom = d;
          }
        }
        immediately_dominates(imdom).push(node);
        set_immediate_dominator(node, imdom);
      } else set_immediate_dominator(node, null);
    }
    for (const node of nodes) immediately_dominates(node).sort((x, y) => x.block.index - y.block.index);
  };
  void index_of;

  const entry = nodes[0];
  const terminal = nodes[nodes.length - 1];
  pyassert(terminal instanceof TerminalNode);

  compute_dominators(
    entry,
    (n) => n.parents,
    (n) => n.dominators,
    (n) => n.immediately_dominates,
    (node, imdom) => {
      node.immediate_dominator = imdom;
    },
  );
  compute_dominators(
    terminal,
    (n) => n.children(),
    (n) => n.postdominators,
    (n) => n.immediately_postdominates,
    (node, impdom) => {
      node.immediate_postdominator = impdom;
    },
  );

  for (const node of nodes) {
    for (const child of node.children()) {
      if (!node.dominators.has(child)) continue;
      if (child.loop === null) child.loop = new NaturalLoop(child);
      child.loop.nodes.add(child);
      child.loop.nodes.add(node);
      child.loop.backedges.add(node);
      for (const parent of inv_reachable_without(node, child)) child.loop.nodes.add(parent);
    }
  }
}

function reachable_backwards(start) {
  const seen = new Set();
  const queue = [start];
  while (queue.length) {
    const n = queue.pop();
    seen.add(n);
    for (const p of n.parents) if (!seen.has(p) && !queue.includes(p)) queue.push(p);
  }
  return seen;
}

function terminate_infinite_loops(nodes) {
  const terminal_node = nodes[nodes.length - 1];
  pyassert(terminal_node instanceof TerminalNode);
  for (;;) {
    const seen = reachable_backwards(terminal_node);
    const unterminated_nodes = nodes.filter((node) => !seen.has(node) && node instanceof BasicNode);
    if (!unterminated_nodes.length) return;
    unterminated_nodes[unterminated_nodes.length - 1].fake_successor = terminal_node;
    compute_relations(nodes);
  }
}

/** A set of References, backed by a list to avoid non-determinism */
export class RefSet {
  constructor(refs = []) {
    this.refs = refs;
  }
  static empty() {
    return new RefSet([]);
  }
  is_empty() {
    return this.refs.length === 0;
  }
  get length() {
    return this.refs.length;
  }
  get_unique() {
    if (this.refs.length === 1) return this.refs[0];
    return null;
  }
  add(ref) {
    if (!this.refs.includes(ref)) this.refs.push(ref);
  }
  update(other) {
    for (const ref of other.refs) this.add(ref);
  }
  remove(ref) {
    const i = this.refs.indexOf(ref);
    if (i < 0) throw new ValueError("list.remove(x): x not in list");
    this.refs.splice(i, 1);
  }
  copy() {
    return new RefSet([...this.refs]);
  }
  has(ref) {
    return this.refs.includes(ref);
  }
  [Symbol.iterator]() {
    return this.refs[Symbol.iterator]();
  }
  equals(other) {
    return this.refs.length === other.refs.length && this.refs.every((x) => other.has(x));
  }
}

/** A map from Locations to RefSets. A missing key is equivalent to an empty RefSet. */
export class LocationRefSetDict {
  constructor(refs = new Map()) {
    this.refs = refs;
  }
  get(loc) {
    return this.refs.get(loc) ?? RefSet.empty();
  }
  add(loc, ref) {
    if (!this.has(loc)) this.refs.set(loc, new RefSet([ref]));
    else this.refs.get(loc).add(ref);
  }
  remove(loc) {
    this.refs.delete(loc);
  }
  copy() {
    return new LocationRefSetDict(new Map(this.refs));
  }
  items() {
    return [...this.refs.entries()];
  }
  is_empty() {
    for (const v of this.refs.values()) if (v.refs.length) return false;
    return true;
  }
  /** Python __contains__: the location maps to a non-empty RefSet */
  has(key) {
    return this.get(key).refs.length > 0;
  }
  set(key, value) {
    this.refs.set(key, value);
  }
}

export class FlowGraph {
  constructor(nodes) {
    this.nodes = nodes;
    this.instr_inputs = new DefaultMap(() => new LocationRefSetDict());
    this.instr_uses = new DefaultMap(() => new LocationRefSetDict());
  }
  entry_node() {
    return this.nodes[0];
  }
  terminal_node() {
    const node = this.nodes[this.nodes.length - 1];
    pyassert(node instanceof TerminalNode);
    return node;
  }
  /** A control flow graph is considered reducible or "well-structured" (see upstream docs). */
  is_reducible() {
    const seen = new Set();
    const queue = [this.entry_node()];
    const incoming_edges = new Map();
    for (const n of this.nodes) {
      const s = new Set(n.parents);
      if (n.loop) for (const b of n.loop.backedges) s.delete(b);
      incoming_edges.set(n, s);
    }
    while (queue.length) {
      const n = queue.pop();
      seen.add(n);
      for (const s of n.children()) {
        if (s.loop !== null && s.loop.backedges.has(n)) continue;
        const inc = incoming_edges.get(s);
        if (!inc.has(n)) throw new Error(`KeyError: ${n.name()}`);
        inc.delete(n);
        if (!inc.size && !queue.includes(s)) queue.push(s);
      }
    }
    for (const v of incoming_edges.values()) if (v.size) return false;
    if (seen.size !== this.nodes.length) return false;
    const seen2 = reachable_backwards(this.terminal_node());
    if (seen2.size !== this.nodes.length) return false;
    return true;
  }
  reset_block_info() {
    for (const node of this.nodes) node.block.block_info = null;
  }
  /** Update instr_inputs/instr_uses that `use` depends on `loc` from `src` */
  add_instruction_use({ use, loc, src }) {
    this.instr_inputs.get(use).add(loc, src);
    this.instr_uses.get(src).add(loc, use);
  }
  /** Remove all inputs for `ref` from instr_inputs/instr_uses */
  clear_instruction_inputs(ref) {
    for (const [loc, uses] of this.instr_inputs.get(ref).items()) {
      for (const use of uses) this.instr_uses.get(use).get(loc).remove(ref);
    }
    this.instr_inputs.delete(ref);
  }
  /** Verify that the instr_inputs & instr_uses dicts are consistent */
  validate_instruction_graph() {
    const new_uses = new DefaultMap(() => new LocationRefSetDict());
    for (const [ref, inputs] of this.instr_inputs) {
      for (const [reg, deps] of inputs.items()) for (const dep of deps) new_uses.get(dep).add(reg, ref);
    }
    for (const [ref, uses] of new_uses) {
      for (const [reg, deps] of uses.items()) pyassert(deps.equals(this.instr_uses.get(ref).get(reg)));
    }
  }
}

/** Return the RefSet of all of the places `loc` is assigned to, if it is a valid phi. */
function phi_loc_sources(node, loc, imdom_srcs) {
  pyassert(node.immediate_dominator !== null);
  const seen = new Set();
  const stack = [...node.parents];
  const sources = new RefSet();
  while (stack.length) {
    const n = stack.pop();
    if (seen.has(n)) continue;
    seen.add(n);
    if (n === node.immediate_dominator) {
      if (imdom_srcs.is_empty()) return RefSet.empty();
      sources.update(imdom_srcs);
      continue;
    }
    let broke = false;
    const refs = n.block.instruction_refs;
    for (let i = refs.length - 1; i >= 0; i--) {
      const ref = refs[i];
      if (ref.instruction.outputs.includes(loc)) {
        sources.add(ref);
        broke = true;
        break;
      }
      if (ref.instruction.clobbers.includes(loc)) return RefSet.empty();
    }
    if (!broke) stack.push(...n.parents);
  }
  return sources;
}

export function locs_clobbered_until_dominator(node) {
  pyassert(node.immediate_dominator !== null);
  const seen = new Set([node.immediate_dominator]);
  const stack = [...node.parents];
  const clobbered = new Set();
  while (stack.length) {
    const n = stack.pop();
    if (seen.has(n)) continue;
    seen.add(n);
    for (const instr of n.block.instructions) {
      for (const o of instr.outputs) clobbered.add(o);
      for (const c of instr.clobbers) clobbered.add(c);
    }
    stack.push(...n.parents);
  }
  return clobbered;
}

function compute_flowgraph_inputs_uses(flow_graph, fn, arch, { print_warnings = false } = {}) {
  const missing_regs = [];

  const process_node = (node, loc_srcs) => {
    const add_use_sources = ({ use, input_loc }) => {
      const sources = loc_srcs.get(input_loc);
      for (const src of sources) flow_graph.add_instruction_use({ use, loc: input_loc, src });
      return sources;
    };

    for (const ref of node.block.instruction_refs) {
      const ir = ref.instruction;
      for (const inp of ir.inputs) {
        const sources = add_use_sources({ use: ref, input_loc: inp });
        if (inp instanceof Register && sources.is_empty() && (ir.function_target === null || !arch.argument_regs.includes(inp))) {
          missing_regs.push([inp, ref]);
        }
      }
      for (const clob of [...ir.clobbers, ...ir.outputs]) if (loc_srcs.has(clob)) loc_srcs.remove(clob);
      for (const out of ir.outputs) loc_srcs.add(out, ref);
    }

    if (node instanceof TerminalNode) {
      pyassert(!node.block.instruction_refs.length);
      for (const reg of arch.all_return_regs) add_use_sources({ use: new EpilogueRef(reg), input_loc: reg });
    }

    for (const child of node.immediately_dominates) {
      const child_loc_srcs = loc_srcs.copy();
      for (const loc of locs_clobbered_until_dominator(child)) {
        const phi_reg_srcs = phi_loc_sources(child, loc, loc_srcs.get(loc));
        if (!phi_reg_srcs.is_empty()) child_loc_srcs.set(loc, phi_reg_srcs);
        else if (child_loc_srcs.has(loc)) child_loc_srcs.remove(loc);
      }
      process_node(child, child_loc_srcs);
    }
  };

  const entry_reg_srcs = new LocationRefSetDict();
  for (const r of arch.all_regs) entry_reg_srcs.refs.set(r, new RefSet([new PrologueRef(r)]));

  const entry_node = flow_graph.entry_node();
  process_node(entry_node, entry_reg_srcs);

  if (print_warnings && missing_regs.length) {
    print("/*");
    print(`Warning: in ${fn.name}, regs were read before being written to:`);
    for (const [reg, ref] of missing_regs) print(`   ${reg} ${ref.instruction.meta.loc_str()}: ${ref.instruction}`);
    print("*/");
  }
}

/**
 * Build the FlowGraph for the given Function.
 * If `fragment` is true, do not treat the asm as a full function.
 */
export function build_flowgraph(fn, asm_data, arch, { fragment, print_warnings = false, debug_patterns = false }) {
  const blocks = build_blocks(fn, asm_data, arch, { fragment, debug_patterns });
  verify_no_duplicate_instructions(blocks);
  let nodes = build_nodes(fn, blocks, asm_data, arch, { fragment });
  warn_on_safeguard_use(fn, nodes, arch);
  if (!fragment) nodes = duplicate_premature_returns(nodes, arch);
  compute_relations(nodes);
  if (!fragment) terminate_infinite_loops(nodes);
  const flow_graph = new FlowGraph(nodes);
  if (!fragment) arch.process_flowgraph(asm_data, flow_graph);
  compute_flowgraph_inputs_uses(flow_graph, fn, arch, { print_warnings: print_warnings || fragment });
  if (!fragment) arch.simplify_ir(asm_data, flow_graph, { debug_patterns });
  return flow_graph;
}

export { Function };
