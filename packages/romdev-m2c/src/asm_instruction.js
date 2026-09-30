// Port of m2c/asm_instruction.py
/* eslint no-unused-vars: ["error", { "args": "none" }] -- keeps upstream's parameter lists */
// Functions and classes useful for parsing an arbitrary assembly instruction.
import { DecompFailure, assert_never } from "./error.js";
import { IndexError, band, bor, bxor, hex, int_, intern, isspace, pyassert, shl, shr, compare, repr } from "./py.js";
import { PyEnum } from "./options.js";

export const ARM_BARREL_SHIFTER_OPS = ["lsl", "lsr", "asr", "ror", "rrx"];
export const OP_PRECEDENCE = { "*": 0, "+": 1, "-": 1, "<<": 2, ">>": 2, "&": 3, "^": 4, "|": 5 };
export const MAX_PRECEDENCE = 6;

export class Register {
  constructor(register_name) {
    this.register_name = register_name;
    return intern(this, [register_name]);
  }
  is_float() {
    const name = this.register_name;
    return Boolean(name) && name[0] === "f" && name !== "fp";
  }
  arm_regtype_index() {
    const index = { sp: 13, lr: 14, pc: 15 }[this.register_name];
    if (index !== undefined) return ["r", index];
    pyassert("rsdq".includes(this.register_name[0]), this.register_name);
    return [this.register_name[0], int_(this.register_name.slice(1))];
  }
  static fictive(name, suffix = "") {
    return new Register(`${name}_fictive_${suffix}`);
  }
  toString() {
    return `$${this.register_name}`;
  }
  __repr__() {
    return `Register(register_name=${repr(this.register_name)})`;
  }
}

export class RegisterList {
  constructor(regs) {
    this.regs = regs;
    return intern(this, [regs]);
  }
  toString() {
    return "{" + this.regs.map((r) => String(r)).join(",") + "}";
  }
}

export class AsmGlobalSymbol {
  constructor(symbol_name) {
    this.symbol_name = symbol_name;
    if (new.target === AsmGlobalSymbol) return intern(this, [symbol_name]);
  }
  toString() {
    return this.symbol_name;
  }
}

export class AsmSectionGlobalSymbol extends AsmGlobalSymbol {
  constructor(symbol_name, section_name, addend) {
    super(symbol_name);
    this.section_name = section_name;
    this.addend = addend;
    return intern(this, [symbol_name, section_name, addend]);
  }
}

export function asm_section_global_symbol(section_name, addend) {
  return new AsmSectionGlobalSymbol(`__${section_name}${hex(addend).slice(2).toUpperCase()}`, section_name, addend);
}

export class Macro {
  constructor(macro_name, argument) {
    this.macro_name = macro_name;
    this.argument = argument;
    return intern(this, [macro_name, argument]);
  }
  toString() {
    if (this.macro_name === "eqsign") return `=${this.argument}`;
    return `%${this.macro_name}(${this.argument})`;
  }
}

export class AsmLiteral {
  constructor(value) {
    this.value = value;
    return intern(this, [value]);
  }
  as_s16() {
    return band(this.value + 0x8000, 0xffff) - 0x8000;
  }
  as_s8() {
    return band(this.value + 0x80, 0xff) - 0x80;
  }
  toString() {
    return hex(this.value);
  }
}

export class Writeback extends PyEnum {}
PyEnum.define(Writeback, { PRE: "pre", POST: "post" });

export class AsmAddressMode {
  constructor(base, addend, writeback) {
    this.base = base;
    this.addend = addend;
    this.writeback = writeback;
    return intern(this, [base, addend, writeback]);
  }
  addend_as_literal() {
    pyassert(this.addend instanceof AsmLiteral);
    return this.addend.value;
  }
  toString() {
    if (this.writeback !== null && this.writeback !== undefined) {
      // (upstream bug preserved: the addend is not interpolated)
      const add_str = this.addend !== new AsmLiteral(0) ? ", {self.addend}" : "";
      if (this.writeback === Writeback.PRE) return `[${this.base}${add_str}]!`;
      return `[${this.base}]${add_str}`;
    }
    if (this.addend === new AsmLiteral(0)) return `(${this.base})`;
    return `${this.addend}(${this.base})`;
  }
}

export class BinOp {
  constructor(op, lhs, rhs) {
    this.op = op;
    this.lhs = lhs;
    this.rhs = rhs;
    return intern(this, [op, lhs, rhs]);
  }
  toString() {
    return `${this.lhs} ${this.op} ${this.rhs}`;
  }
}

export class JumpTarget {
  constructor(target) {
    this.target = target;
    return intern(this, [target]);
  }
  toString() {
    return this.target;
  }
}

export class AsmInstruction {
  constructor(mnemonic, args) {
    this.mnemonic = mnemonic;
    this.args = args;
    return intern(this, [mnemonic, args]);
  }
  toString() {
    if (!this.args.length) return this.mnemonic;
    return `${this.mnemonic} ${this.args.map((a) => String(a)).join(", ")}`;
  }
}

/** Arch-specific information needed to parse asm. */
export class ArchAsmParsing {
  normalize_instruction(instr, asm_state) {
    throw new Error("abstract");
  }
}
ArchAsmParsing.prototype.supports_at_addressing = false;
ArchAsmParsing.prototype.has_delay_slots = false;

/** A fake arch that can parse asm in a naive fashion. */
export class NaiveParsingArch extends ArchAsmParsing {
  constructor() {
    super();
    this.all_regs = [];
    this.aliased_regs = {};
    this.supports_dollar_regs = true;
    this.supports_at_addressing = true;
  }
  normalize_instruction(instr, asm_state) {
    return instr;
  }
}

function aliased(arch, name) {
  return Object.prototype.hasOwnProperty.call(arch.aliased_regs, name) ? arch.aliased_regs[name] : undefined;
}

/** Converts register names used in input assembly to the internal register representation. */
export class RegFormatter {
  constructor() {
    this.used_names = new Map();
  }
  parse(reg_name, arch) {
    return aliased(arch, reg_name) ?? new Register(reg_name);
  }
  parse_and_store(reg_name, arch) {
    reg_name = reg_name.toLowerCase();
    const internal_reg = aliased(arch, reg_name) ?? new Register(reg_name);
    const existing_reg_name = this.used_names.get(internal_reg);
    if (existing_reg_name === undefined) this.used_names.set(internal_reg, reg_name);
    else if (existing_reg_name !== reg_name) {
      throw new DecompFailure(`Source uses multiple names for ${internal_reg} (${existing_reg_name}, ${reg_name})`);
    }
    return internal_reg;
  }
  format(reg) {
    return this.used_names.get(reg) ?? reg.register_name;
  }
}

export class AsmState {
  constructor({ defines = new Map(), reg_formatter = new RegFormatter(), is_thumb = false, is_unified = false, is_pattern = false } = {}) {
    // null means "explicitly undefined"
    this.defines = defines;
    this.reg_formatter = reg_formatter;
    this.is_thumb = is_thumb;
    this.is_unified = is_unified;
    this.is_pattern = is_pattern;
  }
}

const ASCII_LETTERS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
const DIGITS = "0123456789";
export const valid_word = ASCII_LETTERS + DIGITS + "_$.";

const inStr = (c, s) => c !== undefined && s.includes(c);

export function parse_word(elems, valid = valid_word) {
  let ret = "";
  while (elems.length && inStr(elems[0], valid)) ret += elems.shift();
  return ret;
}

export function parse_quoted(elems, quote_char) {
  let ret = "";
  while (elems.length && elems[0] !== quote_char) {
    if (elems[0] === "\\") {
      elems.shift();
      if (!elems.length) break;
    }
    ret += elems.shift();
  }
  return ret;
}

export function parse_number(number_str) {
  if (number_str[0] === "0") pyassert(number_str.length === 1 || "xX".includes(number_str[1]));
  return int_(number_str, 0);
}

export function constant_fold(arg, asm_state) {
  if (arg instanceof AsmGlobalSymbol) {
    const value = asm_state.defines.get(arg.symbol_name);
    if (value !== undefined && value !== null) return constant_fold(value, asm_state);
  }
  if (!(arg instanceof BinOp)) return arg;
  const lhs = constant_fold(arg.lhs, asm_state);
  const rhs = constant_fold(arg.rhs, asm_state);
  if (lhs instanceof AsmLiteral && rhs instanceof AsmLiteral) {
    switch (arg.op) {
      case "+": return new AsmLiteral(lhs.value + rhs.value);
      case "-": return new AsmLiteral(lhs.value - rhs.value);
      case "*": return new AsmLiteral(lhs.value * rhs.value);
      case ">>": return new AsmLiteral(shr(lhs.value, rhs.value));
      case "<<": return new AsmLiteral(shl(lhs.value, rhs.value));
      case "&": return new AsmLiteral(band(lhs.value, rhs.value));
      case "|": return new AsmLiteral(bor(lhs.value, rhs.value));
      case "^": return new AsmLiteral(bxor(lhs.value, rhs.value));
    }
  }
  return new BinOp(arg.op, lhs, rhs);
}

/** If `arg` is an AsmGlobalSymbol whose name matches a known or aliased register, convert it. */
export function replace_bare_reg(arg, arch, asm_state) {
  if (arg instanceof AsmGlobalSymbol) {
    const reg_name = arg.symbol_name.toLowerCase();
    if (arch.all_regs.includes(new Register(reg_name)) || aliased(arch, reg_name) !== undefined) {
      return asm_state.reg_formatter.parse_and_store(reg_name, arch);
    }
  }
  return arg;
}

export function get_jump_target(label) {
  pyassert(label instanceof AsmGlobalSymbol, "invalid branch target");
  return new JumpTarget(label.symbol_name);
}

// Main parser.
export function parse_arg_elems(arg_elems, arch, asm_state, { top_level, do_constant_fold = true, do_replace_bare_reg = true, precedence_cap = MAX_PRECEDENCE }) {
  let value = null;
  const supports_dollar_regs = arch.supports_dollar_regs || asm_state.is_pattern;

  const consume_ws = () => {
    while (arg_elems.length && isspace(arg_elems[0])) arg_elems.shift();
  };
  const expect = (n) => {
    pyassert(arg_elems.length, `Expected one of ${repr([...n])}, but reached end of string`);
    const g = arg_elems.shift();
    pyassert(n.includes(g), `Expected one of ${repr([...n])}, got ${g} (rest: ${repr(arg_elems)})`);
    return g;
  };
  const parse_sh_register = () => {
    const word = parse_word(arg_elems);
    if (word.startsWith("$") && supports_dollar_regs) return asm_state.reg_formatter.parse_and_store(word.slice(1), arch);
    const reg = replace_bare_reg(new AsmGlobalSymbol(word), arch, asm_state);
    pyassert(reg instanceof Register);
    return reg;
  };

  for (;;) {
    consume_ws();
    if (!arg_elems.length) break;
    const tok = arg_elems[0];
    if (tok === ",") {
      break;
    } else if (tok === "$" && supports_dollar_regs) {
      // Register.
      pyassert(value === null);
      const word = parse_word(arg_elems);
      const reg = word.slice(1);
      if (reg.includes("$")) value = new AsmGlobalSymbol(word);
      else value = asm_state.reg_formatter.parse_and_store(reg, arch);
    } else if (tok === "#") {
      // ARM immediate.
      pyassert(value === null);
      expect("#");
    } else if (tok === "{") {
      // ARM register list.
      pyassert(value === null);
      arg_elems.shift();
      const li = [];
      for (;;) {
        consume_ws();
        if (li.length) {
          if (expect(",}") === "}") break;
          consume_ws();
        }
        let word = parse_word(arg_elems);
        const reg1 = asm_state.reg_formatter.parse_and_store(word, arch);
        consume_ws();
        if (arg_elems[0] !== "-") {
          if (arg_elems.length === 0) throw new IndexError("list index out of range");
          li.push(reg1);
          continue;
        }
        arg_elems.shift();
        consume_ws();
        word = parse_word(arg_elems);
        const reg2 = asm_state.reg_formatter.parse_and_store(word, arch);
        const [tp1, ind1] = reg1.arm_regtype_index();
        const [tp2, ind2] = reg2.arm_regtype_index();
        pyassert(tp1 === tp2);
        for (let i = ind1; i < ind2 + 1; i++) li.push(asm_state.reg_formatter.parse(`${tp1}${i}`, arch));
      }
      consume_ws();
      if (arg_elems.length && arg_elems[0] === "^") expect("^");
      if (li.length > 1) {
        const keyed = li.map((r, i) => [r.arm_regtype_index(), i, r]);
        keyed.sort((a, b) => compare(a[0], b[0]) || a[1] - b[1]);
        li.splice(0, li.length, ...keyed.map((k) => k[2]));
      }
      value = new RegisterList(li);
    } else if (tok === ".") {
      // Either a jump target (i.e. a label), or a section reference.
      pyassert(value === null);
      arg_elems.shift();
      const word = parse_word(arg_elems);
      if (["data", "sdata", "rodata", "rdata", "bss", "sbss", "text"].includes(word)) value = asm_section_global_symbol(word, 0);
      else value = new AsmGlobalSymbol("." + word);
    } else if (tok === "%") {
      // A MIPS reloc macro, e.g. %hi(...) or %lo(...).
      pyassert(value === null);
      arg_elems.shift();
      const macro_name = parse_word(arg_elems);
      pyassert(macro_name);
      expect("(");
      const m = parse_arg_elems(arg_elems, arch, asm_state, { top_level: false, do_replace_bare_reg: false });
      expect(")");
      value = new Macro(macro_name, m);
    } else if (tok === ")" || tok === "]") {
      break;
    } else if (DIGITS.includes(tok)) {
      // Try a number.
      pyassert(value === null);
      const word = parse_word(arg_elems, valid_word);
      value = new AsmLiteral(parse_number(word));
    } else if (tok === "-" && value === null) {
      // Negated number, or ARM negated register.
      expect("-");
      consume_ws();
      const word = parse_word(arg_elems, valid_word);
      pyassert(word);
      if (DIGITS.includes(word[0])) value = new AsmLiteral(-parse_number(word));
      else {
        const val = replace_bare_reg(new AsmGlobalSymbol(word), arch, asm_state);
        value = new BinOp("-", new AsmLiteral(0), val);
      }
    } else if (tok === "(") {
      if (value !== null && !top_level) break;
      // Address mode or binary operation.
      expect("(");
      let rhs = parse_arg_elems(arg_elems, arch, asm_state, { top_level: false, do_constant_fold: false });
      expect(")");
      if (rhs instanceof BinOp) {
        pyassert(value === null);
        value = constant_fold(rhs, asm_state);
      } else {
        if (rhs === new AsmLiteral(0)) rhs = new Register("zero");
        if (rhs instanceof AsmGlobalSymbol) {
          pyassert(value === null);
          value = constant_fold(rhs, asm_state);
        } else {
          pyassert(top_level);
          pyassert(rhs instanceof Register);
          value = constant_fold(value || new AsmLiteral(0), asm_state);
          value = new AsmAddressMode(rhs, value, null);
        }
      }
    } else if (tok === "[") {
      // ARM address mode
      pyassert(value === null);
      expect("[");
      const val = parse_arg_elems(arg_elems, arch, asm_state, { top_level: false });
      pyassert(val instanceof Register);
      let addend = null;
      if (expect(",]") === ",") {
        addend = parse_arg_elems(arg_elems, arch, asm_state, { top_level: false });
        if (expect(",]") === ",") {
          consume_ws();
          const op = parse_word(arg_elems).toLowerCase();
          pyassert(ARM_BARREL_SHIFTER_OPS.includes(op));
          let shift;
          if (op === "rrx") shift = new AsmLiteral(1);
          else shift = parse_arg_elems(arg_elems, arch, asm_state, { top_level: false });
          addend = new BinOp(op, addend, constant_fold(shift, asm_state));
          expect("]");
        }
      }
      consume_ws();
      let writeback = null;
      if (arg_elems.length && arg_elems[0] === "!") {
        expect("!");
        writeback = Writeback.PRE;
      } else if (arg_elems.length && arg_elems[0] === ",") {
        expect(",");
        pyassert(addend === null);
        addend = parse_arg_elems(arg_elems, arch, asm_state, { top_level: false });
        writeback = Writeback.POST;
      }
      if (addend === null) addend = new AsmLiteral(0);
      value = new AsmAddressMode(val, addend, writeback);
    } else if (tok === "!") {
      // ARM writeback indicator
      expect("!");
      if (value !== null) value = replace_bare_reg(value, arch, asm_state);
      pyassert(value instanceof Register);
      value = new AsmAddressMode(value, new AsmLiteral(0), Writeback.PRE);
    } else if (tok === '"') {
      // Quoted global symbol.
      expect('"');
      pyassert(value === null);
      const word = parse_quoted(arg_elems, '"');
      value = new AsmGlobalSymbol(word);
      expect('"');
    } else if (valid_word.includes(tok)) {
      // Global symbol.
      pyassert(value === null);
      const word = parse_word(arg_elems);
      value = new AsmGlobalSymbol(word);

      const op = word.toLowerCase();
      if (top_level && ARM_BARREL_SHIFTER_OPS.includes(op)) {
        consume_ws();
        if (arg_elems.length && !",)@".includes(arg_elems[0])) {
          const shift = parse_arg_elems(arg_elems, arch, asm_state, { top_level: false });
          value = new BinOp(op, new AsmLiteral(0), shift);
          pyassert(!arg_elems.length);
        } else if (op === "rrx") {
          value = new BinOp(op, new AsmLiteral(0), new AsmLiteral(1));
          pyassert(!arg_elems.length);
        }
      }
    } else if ("<>+-*&|^".includes(tok)) {
      // Binary operators
      pyassert(value instanceof AsmLiteral || value instanceof AsmGlobalSymbol || value instanceof BinOp);
      const op = "<>".includes(tok) ? tok + tok : tok;
      const precedence = OP_PRECEDENCE[op];
      if (precedence >= precedence_cap) break;
      for (const c of op) expect(c);
      if (op === "-" && arg_elems[0] === "_") {
        const reloc_name = parse_word(arg_elems);
        if (reloc_name !== "_SDA_BASE_" && reloc_name !== "_SDA2_BASE_") {
          throw new DecompFailure(`Unexpected symbol ${reloc_name} in subtraction expression`);
        }
        value = new Macro("sda21", value);
      } else {
        const rhs = parse_arg_elems(arg_elems, arch, asm_state, { top_level: false, do_replace_bare_reg: false, precedence_cap: precedence });
        if (op === "+" && rhs instanceof AsmLiteral && value instanceof AsmSectionGlobalSymbol) {
          value = asm_section_global_symbol(value.section_name, value.addend + rhs.value);
        } else {
          value = new BinOp(op, value, rhs);
        }
      }
    } else if (tok === "@") {
      if (value === null && arch.supports_at_addressing) {
        // SuperH indirect addressing: @Rn, @-Rn, @Rn+, and @(disp,Rn).
        expect("@");
        if (arg_elems.length && arg_elems[0] === "(") {
          expect("(");
          const addend = parse_arg_elems(arg_elems, arch, asm_state, { top_level: false });
          expect(",");
          consume_ws();
          const base = parse_sh_register();
          expect(")");
          value = new AsmAddressMode(base, addend, null);
          continue;
        }
        let sh_writeback = null;
        if (arg_elems.length && arg_elems[0] === "-") {
          expect("-");
          sh_writeback = Writeback.PRE;
        }
        const base = parse_sh_register();
        if (arg_elems.length && arg_elems[0] === "+") {
          pyassert(sh_writeback === null);
          expect("+");
          sh_writeback = Writeback.POST;
        }
        value = new AsmAddressMode(base, new AsmLiteral(0), sh_writeback);
      } else {
        // A relocation (e.g. (...)@ha or (...)@l).
        if (!top_level) break;
        arg_elems.shift();
        const reloc_name = parse_word(arg_elems);
        pyassert(["h", "ha", "l", "sda2", "sda21"].includes(reloc_name));
        pyassert(value);
        value = new Macro(reloc_name, value);
      }
    } else if (tok === "=") {
      // ARM reference to symbol
      pyassert(top_level);
      pyassert(!value);
      expect("=");
      const ref = parse_arg_elems(arg_elems, arch, asm_state, { top_level: false, do_constant_fold: true });
      value = new Macro("eqsign", ref);
    } else {
      pyassert(false, `Unknown token ${tok} in ${repr(arg_elems)}`);
    }
  }

  pyassert(value !== null);
  if (do_constant_fold) value = constant_fold(value, asm_state);
  if (do_replace_bare_reg) value = replace_bare_reg(value, arch, asm_state);
  return value;
}

export function parse_args(args, arch, asm_state) {
  const arg_elems = [...args.trim()];
  const output = [];
  while (arg_elems.length) {
    const ret = parse_arg_elems(arg_elems, arch, asm_state, { top_level: true });
    if (ret instanceof BinOp && ARM_BARREL_SHIFTER_OPS.includes(ret.op)) {
      pyassert(output.length);
      output[output.length - 1] = new BinOp(ret.op, output[output.length - 1], ret.rhs);
      continue;
    }
    output.push(ret);
    if (arg_elems.length) {
      const comma = arg_elems.shift();
      pyassert(comma === ",");
    }
  }
  return output;
}

export function parse_arg(arg, arch, asm_state) {
  const chars = [...arg];
  const value = parse_arg_elems(chars, arch, asm_state, { top_level: false, do_replace_bare_reg: false });
  if (chars.length) throw new Error(`Failed to parse value: ${arg}`);
  return value;
}

export function parse_asm_instruction(line, arch, asm_state) {
  line = line.trim();
  const i = line.indexOf(" ");
  const mnemonic = i < 0 ? line : line.slice(0, i);
  const args_str = i < 0 ? "" : line.slice(i + 1);
  const args = parse_args(args_str, arch, asm_state);
  const instr = new AsmInstruction(mnemonic.toLowerCase(), args);
  return arch.normalize_instruction(instr, asm_state);
}

export function* traverse_arg(arg) {
  yield arg;
  if (arg instanceof Register || arg instanceof AsmLiteral || arg instanceof AsmGlobalSymbol) {
    // pass
  } else if (arg instanceof RegisterList) {
    for (const reg of arg.regs) yield reg;
  } else if (arg instanceof AsmAddressMode) {
    yield arg.base;
    yield* traverse_arg(arg.addend);
  } else if (arg instanceof Macro) {
    yield* traverse_arg(arg.argument);
  } else if (arg instanceof BinOp) {
    yield* traverse_arg(arg.lhs);
    yield* traverse_arg(arg.rhs);
  } else {
    assert_never(arg);
  }
}
