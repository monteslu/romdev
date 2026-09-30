// Port of m2c/asm_pattern.py
/* eslint no-unused-vars: ["error", { "args": "none" }] -- keeps upstream's parameter lists */
import { Label } from "./asm_file.js";
import {
  ARM_BARREL_SHIFTER_OPS,
  AsmAddressMode,
  AsmGlobalSymbol,
  AsmInstruction,
  AsmLiteral,
  AsmState,
  BinOp,
  Macro,
  NaiveParsingArch,
  Register,
  RegisterList,
  parse_asm_instruction,
} from "./asm_instruction.js";
import { Instruction, InstructionMeta } from "./instruction.js";
import { DefaultMap, pyassert, rstrip, shl } from "./py.js";
import { print } from "./io.js";

/** Python str.isupper(). */
export function isupper(s) {
  return s !== s.toLowerCase() && s === s.toUpperCase();
}

export function make_pattern(...parts) {
  const ret = [];
  for (let part of parts) {
    const optional = part.endsWith("?");
    part = rstrip(part, "?");
    if (part === "*") ret.push([null, optional]);
    else if (part.endsWith(":")) ret.push([Label.new(part.slice(0, -1)), optional]);
    else {
      const ins = parse_asm_instruction(part, new NaiveParsingArch(), new AsmState());
      ret.push([ins, optional]);
    }
  }
  return ret;
}

export class Replacement {
  constructor(new_body, num_consumed, clobbers = null) {
    this.new_body = new_body;
    this.num_consumed = num_consumed;
    this.clobbers = clobbers;
  }
}

export class AsmMatch {
  constructor(body, wildcard_items, regs, literals, labels, asm_data) {
    this.body = body;
    this.wildcard_items = wildcard_items;
    this.regs = regs; // Map<string, Register>
    this.literals = literals; // Map<string, number>
    this.labels = labels; // Map<string, Label>
    this.asm_data = asm_data;
  }
}

export class AsmPattern {
  match(matcher) {
    throw new Error("abstract");
  }
}

export class SimpleAsmPattern extends AsmPattern {
  // subclasses define `pattern` and replace(m)
  match(matcher) {
    const m = matcher.try_match(this.pattern);
    if (!m) return null;
    return this.replace(m);
  }
}

export class TryMatchState {
  constructor() {
    this.symbolic_registers = new Map();
    this.symbolic_labels_def = new Map();
    this.symbolic_labels_uses = new DefaultMap(() => new Set());
    this.symbolic_literals = new Map();
    this.wildcard_items = [];
  }
  match_var(var_map, key, value) {
    if (var_map.has(key)) {
      if (var_map.get(key) !== value) return false;
    } else var_map.set(key, value);
    return true;
  }
  match_reg(actual, exp) {
    if (exp.register_name.length <= 1) return this.match_var(this.symbolic_registers, exp.register_name, actual);
    return exp.register_name === actual.register_name;
  }
  match_label_def(key, defn) {
    pyassert(!this.symbolic_labels_def.has(key));
    this.symbolic_labels_def.set(key, defn);
    const uses = this.symbolic_labels_uses.get(key);
    for (const u of uses) if (!defn.names.includes(u)) return false;
    return true;
  }
  match_label_use(key, use) {
    const defn = this.symbolic_labels_def.get(key) ?? null;
    if (defn !== null && !defn.names.includes(use)) return false;
    this.symbolic_labels_uses.get(key).add(use);
    return true;
  }
  eval_math(e) {
    if (e instanceof AsmLiteral) return e.value;
    if (e instanceof BinOp) {
      if (e.op === "+") return this.eval_math(e.lhs) + this.eval_math(e.rhs);
      if (e.op === "-") return this.eval_math(e.lhs) - this.eval_math(e.rhs);
      if (e.op === "<<") return shl(this.eval_math(e.lhs), this.eval_math(e.rhs));
      pyassert(false, `bad binop in math pattern: ${e}`);
    } else if (e instanceof AsmGlobalSymbol) {
      pyassert(this.symbolic_literals.has(e.symbol_name), `undefined variable in math pattern: ${e.symbol_name}`);
      return this.symbolic_literals.get(e.symbol_name);
    } else {
      pyassert(false, `bad pattern part in math pattern: ${e}`);
    }
  }
  match_arg(a, e) {
    if (e instanceof AsmLiteral) return a instanceof AsmLiteral && a.value === e.value;
    if (e instanceof Register) return a instanceof Register && this.match_reg(a, e);
    if (e instanceof AsmGlobalSymbol) {
      if (e.symbol_name.startsWith(".")) return a instanceof AsmGlobalSymbol && this.match_label_use(e.symbol_name, a.symbol_name);
      else if (isupper(e.symbol_name)) return a instanceof AsmLiteral && this.match_var(this.symbolic_literals, e.symbol_name, a.value);
      else if (e.symbol_name === "_") return true;
      else return a instanceof AsmGlobalSymbol && a.symbol_name === e.symbol_name;
    }
    if (e instanceof AsmAddressMode) {
      return a instanceof AsmAddressMode && this.match_reg(a.base, e.base) && this.match_arg(a.addend, e.addend) && a.writeback === e.writeback;
    }
    if (e instanceof BinOp) {
      if (ARM_BARREL_SHIFTER_OPS.includes(e.op)) {
        return a instanceof BinOp && a.op === e.op && this.match_arg(a.lhs, e.lhs) && this.match_arg(a.rhs, e.rhs);
      }
      return a instanceof AsmLiteral && a.value === this.eval_math(e);
    }
    if (e instanceof Macro) return a instanceof Macro && a.macro_name === e.macro_name && this.match_arg(a.argument, e.argument);
    if (e instanceof RegisterList) {
      return a instanceof RegisterList && a.regs.length === e.regs.length && a.regs.every((ar, i) => this.match_reg(ar, e.regs[i]));
    }
    pyassert(false, `bad pattern part: ${e}`);
  }
  match_one(actual, exp) {
    if (exp === null) {
      this.wildcard_items.push(actual);
      return true;
    }
    if (exp instanceof Label) {
      pyassert(exp.names.length === 1);
      return actual instanceof Label && this.match_label_def(exp.names[0], actual);
    }
    if (!(actual instanceof Instruction)) return false;
    const ins = actual;
    if (ins.mnemonic !== exp.mnemonic) return false;
    if (exp.args.length) {
      if (ins.args.length !== exp.args.length) return false;
      for (let i = 0; i < ins.args.length; i++) if (!this.match_arg(ins.args[i], exp.args[i])) return false;
    }
    return true;
  }
  match_meta(ins) {
    if (ins.mnemonic === ".eq") {
      const res = this.eval_math(ins.args[1]);
      return this.match_arg(new AsmLiteral(res), ins.args[0]);
    } else if (ins.mnemonic === ".set") {
      const sym = ins.args[0];
      pyassert(sym instanceof AsmGlobalSymbol);
      pyassert(isupper(sym.symbol_name));
      this.symbolic_literals.set(sym.symbol_name, this.eval_math(ins.args[1]));
      return true;
    } else if (ins.mnemonic === ".forget") {
      const arg = ins.args[0];
      if (arg instanceof Register) this.symbolic_registers.delete(arg.register_name);
      else pyassert(false, ".forget arg of unsupported type");
      return true;
    } else {
      pyassert(false, ins.mnemonic);
    }
  }
}

export class AsmMatcher {
  constructor(arch, asm_data, input, labels) {
    this.arch = arch;
    this.asm_data = asm_data;
    this.input = input;
    this.labels = labels;
    this.output = [];
    this.index = 0;
  }
  try_match(pattern) {
    const state = new TryMatchState();
    const start_index = this.index;
    let index = this.index;
    for (const [pat, optional] of pattern) {
      if (pat instanceof AsmInstruction && pat.mnemonic[0] === ".") {
        if (!state.match_meta(pat) && !optional) return null;
      } else if (index < this.input.length && state.match_one(this.input[index], pat)) {
        index += 1;
      } else if (!optional) return null;
    }
    return new AsmMatch(this.input.slice(start_index, index), state.wildcard_items, state.symbolic_registers, state.symbolic_literals, state.symbolic_labels_def, this.asm_data);
  }
  derived_meta() {
    for (const part of this.input.slice(this.index)) if (part instanceof Instruction) return part.meta.derived();
    return InstructionMeta.missing();
  }
  is_local_label(name) {
    return this.labels.has(name);
  }
  apply(repl, arch) {
    const repl_writes = [];
    let final_instr = null;
    for (let part of repl.new_body) {
      if (part instanceof AsmInstruction) part = arch.parse(part.mnemonic, part.args, this.derived_meta());
      if (part instanceof Instruction) {
        repl_writes.push(...part.outputs);
        repl_writes.push(...part.clobbers);
        final_instr = part;
      }
      this.output.push(part);
    }
    if (repl.clobbers === null) {
      for (const part of this.input.slice(this.index, this.index + repl.num_consumed)) {
        if (part instanceof Instruction) {
          for (const arg of [...part.outputs, ...part.clobbers]) {
            pyassert(final_instr !== null);
            if (!repl_writes.includes(arg) && !final_instr.clobbers.includes(arg)) final_instr.clobbers.push(arg);
          }
        }
      }
    } else if (repl.clobbers.length) {
      pyassert(final_instr !== null);
      final_instr.clobbers.push(...repl.clobbers);
    }
    this.index += repl.num_consumed;
  }
}

function label_names(body) {
  const s = new Set();
  for (const item of body) if (item instanceof Label) for (const name of item.names) s.add(name);
  return s;
}

/** Detect and simplify asm standard patterns emitted by known compilers. */
export function simplify_patterns(body, patterns, asm_data, arch, { debug_patterns }) {
  let labels = label_names(body);
  for (const pattern of patterns) {
    const matcher = new AsmMatcher(arch, asm_data, body, labels);
    let matched_any = false;
    while (matcher.index < matcher.input.length) {
      const m = pattern.match(matcher);
      if (m) {
        matcher.apply(m, arch);
        matched_any = true;
      } else {
        matcher.output.push(matcher.input[matcher.index]);
        matcher.index += 1;
      }
    }
    if (!matched_any) continue;
    body = matcher.output;
    labels = label_names(body);
    if (debug_patterns) {
      print(`Rewrote asm using ${pattern.constructor.name}:`);
      print();
      for (const part of body) print(String(part));
      print();
    }
  }
  return body;
}
