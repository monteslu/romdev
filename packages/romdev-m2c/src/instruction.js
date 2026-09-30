// Port of m2c/instruction.py
/* eslint no-unused-vars: ["error", { "args": "none" }] -- keeps upstream's parameter lists */
import { DecompFailure } from "./error.js";
import { AsmGlobalSymbol, AsmLiteral, BinOp, ArchAsmParsing, parse_asm_instruction } from "./asm_instruction.js";
import { band, intern, shallowcopy } from "./py.js";

/**
 * Represents a word on the stack. Currently only used for pattern matching.
 * `symbolic_offset` represents a label offset that is only used in patterns.
 */
export class StackLocation {
  constructor(offset, symbolic_offset) {
    this.offset = offset;
    this.symbolic_offset = symbolic_offset;
    return intern(this, [offset, symbolic_offset]);
  }
  toString() {
    const prefix = this.symbolic_offset === null ? "" : `${this.symbolic_offset}+`;
    return `${prefix}${this.offset}($sp)`;
  }
  offset_as_arg() {
    if (this.symbolic_offset === null) return new AsmLiteral(this.offset);
    if (this.offset === 0) return new AsmGlobalSymbol(this.symbolic_offset);
    return new BinOp("+", new AsmGlobalSymbol(this.symbolic_offset), new AsmLiteral(this.offset));
  }
  static from_offset(offset) {
    const align = (x) => band(x, ~3);
    if (offset instanceof AsmLiteral) return new StackLocation(align(offset.value), null);
    if (offset instanceof AsmGlobalSymbol) return new StackLocation(0, offset.symbol_name);
    if (offset instanceof BinOp && (offset.op === "+" || offset.op === "-") && offset.lhs instanceof AsmGlobalSymbol && offset.rhs instanceof AsmLiteral) {
      let base = offset.rhs.value;
      if (offset.op === "-") base = -base;
      return new StackLocation(align(base), offset.lhs.symbol_name);
    }
    return null;
  }
}

export class InstructionMeta {
  constructor({ emit_goto, filename, lineno, synthetic }) {
    // True if the original asm line was marked with a goto pattern
    this.emit_goto = emit_goto;
    // Asm source filename & line number
    this.filename = filename;
    this.lineno = lineno;
    // True if the Instruction is not directly from the source asm
    this.synthetic = synthetic;
    return intern(this, [emit_goto, filename, lineno, synthetic]);
  }
  static missing() {
    return new InstructionMeta({ emit_goto: false, filename: "<unknown>", lineno: 0, synthetic: true });
  }
  derived() {
    return new InstructionMeta({ emit_goto: this.emit_goto, filename: this.filename, lineno: this.lineno, synthetic: true });
  }
  loc_str() {
    const adj = this.synthetic ? "near" : "at";
    return `${adj} ${this.filename} line ${this.lineno}`;
  }
}

const INSTRUCTION_DEFAULTS = {
  jump_target: null,
  function_target: null,
  is_conditional: false,
  is_return: false,
  is_load: false,
  is_store: false,
  is_effectful: true,
  has_delay_slot: false,
  is_branch_likely: false,
  in_pattern: false,
};

export class Instruction {
  /**
   * @param {object} f fields: mnemonic, args, meta, inputs, clobbers, outputs, eval_fn,
   *   and optional jump_target, function_target, is_conditional, is_return, is_load,
   *   is_store, is_effectful, has_delay_slot, is_branch_likely, in_pattern
   */
  constructor(f) {
    this.mnemonic = f.mnemonic;
    this.args = f.args;
    this.meta = f.meta;
    this.inputs = f.inputs;
    this.clobbers = f.clobbers;
    this.outputs = f.outputs;
    this.eval_fn = f.eval_fn;
    for (const [k, v] of Object.entries(INSTRUCTION_DEFAULTS)) this[k] = f[k] === undefined ? v : f[k];
  }
  is_jump() {
    return this.jump_target !== null || this.is_return;
  }
  toString() {
    if (!this.args.length) return this.mnemonic;
    return `${this.mnemonic} ${this.args.map((a) => String(a)).join(", ")}`;
  }
  arch_mnemonic(arch) {
    return `${arch.arch}:${this.mnemonic}`;
  }
  clone() {
    return this.replace({ meta: this.meta.derived() });
  }
  /** dataclasses.replace */
  replace(changes) {
    const out = shallowcopy(this);
    Object.assign(out, changes);
    return out;
  }
}

/** Arch-specific information that relates to the asm level. Extends ArchAsmParsing. */
export class ArchAsm extends ArchAsmParsing {
  missing_return() {
    throw new Error("abstract");
  }
  parse(mnemonic, args, meta) {
    throw new Error("abstract");
  }
}

ArchAsm.prototype.asm_word_size = 4;

export function parse_instruction(line, meta, arch, asm_state) {
  try {
    const base = parse_asm_instruction(line, arch, asm_state);
    return arch.parse(base.mnemonic, base.args, meta);
  } catch (e) {
    let msg = `Failed to parse instruction ${meta.loc_str()}: ${line}`;
    if (e instanceof DecompFailure) msg += "\n\n" + e.message;
    throw new DecompFailure(msg);
  }
}

export class InstrProcessingFailure extends Error {
  constructor(instr, cause) {
    super(`Error while processing instruction:\n${instr}`, cause ? { cause } : undefined);
    this.name = "InstrProcessingFailure";
    this.instr = instr;
  }
  __str__() {
    return `Error while processing instruction:\n${this.instr}`;
  }
}

/** Mark an instruction as being the one currently processed, for error messages. */
export function set_current_instr(instr, fn) {
  try {
    return fn();
  } catch (e) {
    throw new InstrProcessingFailure(instr, e);
  }
}
