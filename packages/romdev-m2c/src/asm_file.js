// Port of m2c/asm_file.py
import fs from "node:fs";
import path from "node:path";
import { DecompFailure } from "./error.js";
import { CodingStyle } from "./options.js";
import { AsmGlobalSymbol, AsmLiteral, AsmState, RegFormatter, parse_arg, traverse_arg } from "./asm_instruction.js";
import { Instruction, InstructionMeta, parse_instruction } from "./instruction.js";
import { AssertionError, DefaultMap, IndexError, ValueError, band, format, int_, intern, isspace, pyassert, pymod, split_ws, str as pystr } from "./py.js";
import { print } from "./io.js";

const RE_COMMA_OR_STRING = /,|"(?:\\.|[^\\"])*"/g;

export class Label {
  // Various pattern matching code assumes that there cannot be consecutive
  // labels, and to deal with this we allow for consecutive labels to be
  // merged together. As a consequence, we allow a Label to have more than one
  // name. When we need a single name to refer to one, we use the first one.
  constructor(names) {
    this.names = names;
    return intern(this, [names]);
  }
  static new(name) {
    return new Label([name]);
  }
  toString() {
    return this.names[0];
  }
}

export class Function {
  constructor({ name, body = [], reg_formatter = new RegFormatter() }) {
    this.name = name;
    this.body = body;
    this.reg_formatter = reg_formatter;
  }
  new_label(name) {
    const label = Label.new(name);
    if (this.body.length && this.body[this.body.length - 1] === label) return;
    this.body.push(label);
  }
  new_instruction(instruction) {
    this.body.push(instruction);
  }
  bodyless_copy() {
    return new Function({ name: this.name, reg_formatter: this.reg_formatter });
  }
  toString() {
    const body = this.body.map((item) => (item instanceof Instruction ? String(item) : `  ${item}:`)).join("\n");
    return `glabel ${this.name}\n${body}`;
  }
}

export class AsmSymbolicData {
  constructor(data, size) {
    this.data = data;
    this.size = size;
  }
  as_symbol_without_addend() {
    if (this.data instanceof AsmGlobalSymbol && this.size === 4) return this.data.symbol_name;
    return null;
  }
}

export function concatBytes(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

export class AsmDataEntry {
  constructor(sort_order, { data = [], is_string = false, is_readonly = false, is_bss = false, is_text = false, is_jtbl = false, used_as_literal = false } = {}) {
    this.sort_order = sort_order;
    this.data = data;
    this.is_string = is_string;
    this.is_readonly = is_readonly;
    this.is_bss = is_bss;
    this.is_text = is_text;
    this.is_jtbl = is_jtbl;
    // Mutable state:
    this.used_as_literal = used_as_literal;
  }

  /** Return the range of possible sizes, if padding were stripped. */
  size_range_bytes() {
    let max_size = 0;
    for (const x of this.data) {
      if (x instanceof AsmSymbolicData) max_size += x.size;
      else max_size += x.length;
    }
    let padding_size = 0;
    if (this.data.length && this.data[this.data.length - 1] instanceof Uint8Array) {
      pyassert(this.data.length === 1 || this.data[this.data.length - 2] instanceof AsmSymbolicData);
      const last = this.data[this.data.length - 1];
      for (let i = last.length - 1; i >= 0; i--) {
        if (last[i] !== 0) break;
        padding_size += 1;
      }
    }
    padding_size = Math.min(padding_size, 15);
    pyassert(padding_size <= max_size);
    if (max_size === padding_size && max_size !== 0) return [1, max_size];
    return [max_size - padding_size, max_size];
  }

  data_at_offset(offset, size) {
    for (let data of this.data) {
      const subsize = data instanceof Uint8Array ? data.length : data.size;
      if (offset >= subsize) {
        offset -= subsize;
        continue;
      }
      if (data instanceof Uint8Array) {
        data = data.slice(offset, offset + size);
        if (data.length !== size) return null;
        return data;
      } else {
        if (data.size !== size) return null;
        return data;
      }
    }
    return null;
  }
}

export class AsmData {
  constructor({ values = new Map(), mentioned_labels = new Set() } = {}) {
    this.values = values;
    this.mentioned_labels = mentioned_labels;
  }
  merge_into(other) {
    for (const [sym, value] of this.values) other.values.set(sym, value);
    for (const label of this.mentioned_labels) other.mentioned_labels.add(label);
  }
  is_likely_char(c) {
    return (0x20 <= c && c < 0x7f) || [0, 7, 8, 9, 10, 13, 27].includes(c);
  }
  detect_heuristic_strings() {
    for (const ent of this.values.values()) {
      if (
        ent.is_readonly &&
        ent.data.length === 1 &&
        ent.data[0] instanceof Uint8Array &&
        ent.data[0].length > 1 &&
        ent.data[0][0] !== 0 &&
        [...ent.data[0]].every((x) => this.is_likely_char(x))
      ) {
        ent.is_string = true;
      }
    }
  }
}

export class AsmFile {
  constructor(filename, reg_formatter) {
    this.filename = filename;
    this.reg_formatter = reg_formatter;
    this.functions = [];
    this.asm_data = new AsmData();
    this.current_function = null;
    this.current_data = null;
  }
  new_function(name) {
    this.current_function = new Function({ name, reg_formatter: this.reg_formatter });
    this.functions.push(this.current_function);
  }
  new_instruction(instruction) {
    if (this.current_function === null) {
      if (instruction.mnemonic === "nop") return;
      throw new DecompFailure(`unsupported non-nop instruction outside of function (${instruction})`);
    }
    this.current_function.new_instruction(instruction);
    this.current_data = null;
  }
  new_label(label_name) {
    pyassert(this.current_function !== null);
    this.current_function.new_label(label_name);
  }
  new_data_label(symbol_name, { is_readonly = false, is_bss = false, is_text = false } = {}) {
    const sort_order = [this.filename, this.asm_data.values.size];
    this.current_data = new AsmDataEntry(sort_order, { is_readonly, is_bss, is_text });
    this.asm_data.values.set(symbol_name, this.current_data);
  }
  new_symbolic_data(data, size) {
    if (this.current_data !== null) this.current_data.data.push(new AsmSymbolicData(data, size));
    for (const subexpr of traverse_arg(data)) {
      if (subexpr instanceof AsmGlobalSymbol) this.asm_data.mentioned_labels.add(subexpr.symbol_name);
    }
  }
  new_data_bytes(data, { is_string }) {
    if (this.current_data === null) return;
    const d = this.current_data.data;
    if (!d.length && is_string) this.current_data.is_string = true;
    if (d.length && d[d.length - 1] instanceof Uint8Array) d[d.length - 1] = concatBytes(d[d.length - 1], data);
    else d.push(data);
  }
  toString() {
    const functions_str = this.functions.map((f) => String(f)).join("\n\n");
    return `# ${this.filename}\n${functions_str}`;
  }
}

/**
 * Split a string of comma-separated arguments, handling quotes. Mirrors
 * Python's csv.reader(delimiter=",", doublequote=False, escapechar="\\",
 * quotechar='"', skipinitialspace=True) on a single line.
 */
export function split_quotable_arg_list(args) {
  if (args === "") return [];
  const fields = [];
  let field = "";
  let state = "START_FIELD";
  for (const c of args) {
    switch (state) {
      case "START_FIELD":
        if (c === '"') state = "IN_QUOTED_FIELD";
        else if (c === "\\") state = "ESCAPED_CHAR";
        else if (c === " ") {
          /* skipinitialspace */
        } else if (c === ",") {
          fields.push(field);
          field = "";
        } else {
          field += c;
          state = "IN_FIELD";
        }
        break;
      case "ESCAPED_CHAR":
        field += c;
        state = "IN_FIELD";
        break;
      case "IN_FIELD":
        if (c === "\\") state = "ESCAPED_CHAR";
        else if (c === ",") {
          fields.push(field);
          field = "";
          state = "START_FIELD";
        } else field += c;
        break;
      case "IN_QUOTED_FIELD":
        if (c === "\\") state = "ESCAPE_IN_QUOTED_FIELD";
        else if (c === '"') state = "IN_FIELD";
        else field += c;
        break;
      case "ESCAPE_IN_QUOTED_FIELD":
        field += c;
        state = "IN_QUOTED_FIELD";
        break;
    }
  }
  fields.push(field);
  return fields.map((a) => a.trim());
}

export function split_arg_list(args) {
  if (!args.includes('"')) return args.split(",").map((a) => a.trim());
  const commas = [];
  for (const m of args.matchAll(RE_COMMA_OR_STRING)) if (m[0] === ",") commas.push(m.index);
  const starts = [-1, ...commas];
  const ends = [...commas, args.length];
  return starts.map((a, i) => args.slice(a + 1, ends[i]).trim());
}

const utf8 = new TextEncoder();

export function parse_ascii_directive(line, z) {
  // This is wrong wrt encodings; the assembler really operates on bytes and
  // not chars. But for our purposes it should be good enough.
  let in_quote = false;
  let num_parts = 0;
  const ret = [];
  const chars = [...line];
  let i = 0;
  const digits = "0123456789";
  while (i < chars.length) {
    let c = chars[i];
    i += 1;
    if (!in_quote) {
      if (c === '"') {
        in_quote = true;
        num_parts += 1;
      }
    } else {
      if (c === '"') {
        in_quote = false;
        if (z) ret.push(0);
        continue;
      }
      if (c !== "\\") {
        ret.push(...utf8.encode(c));
        continue;
      }
      if (i === chars.length) throw new DecompFailure("backslash at end of .ascii line not supported: " + line);
      c = chars[i];
      i += 1;
      const char_escapes = { b: 8, f: 12, n: 10, r: 13, t: 9, v: 11 };
      if (Object.prototype.hasOwnProperty.call(char_escapes, c)) ret.push(char_escapes[c]);
      else if (c === "x") {
        let value = 0;
        while (i < chars.length && (digits + "abcdefABCDEF").includes(chars[i])) {
          value = value * 16 + parseInt(chars[i], 16);
          i += 1;
        }
        ret.push(value % 256);
      } else if (digits.includes(c)) {
        let it = 0;
        let value = parseInt(c, 10);
        while (i < chars.length && digits.includes(chars[i]) && it < 2) {
          value = value * 8 + parseInt(chars[i], 10);
          i += 1;
          it += 1;
        }
        ret.push(value & 0xff);
      } else {
        ret.push(...utf8.encode(c));
      }
    }
  }
  if (in_quote) throw new DecompFailure("unterminated string literal: " + line);
  if (num_parts === 0) throw new DecompFailure(".ascii with no string: " + line);
  return Uint8Array.from(ret);
}

function add_warning(warnings, n) {
  if (!warnings.includes(n)) warnings.push(n);
}

function pyListRepr(arr) {
  return "[" + arr.map((s) => `'${s.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`).join(", ") + "]";
}

export function parse_incbin(args, options, warnings) {
  let filename, offset, size;
  try {
    if (args.length === 3) {
      filename = args[0];
      offset = int_(args[1], 0);
      size = int_(args[2], 0);
    } else if (args.length === 1) {
      filename = args[0];
      offset = 0;
      size = -1;
    } else throw new ValueError();
  } catch (e) {
    if (e instanceof ValueError) throw new DecompFailure(`Could not parse asm_data .incbin directive: ${pyListRepr(args)}`);
    throw e;
  }
  if (!options.incbin_dirs.length) {
    add_warning(warnings, `Skipping .incbin directive for ${filename}, pass --incbin-dir to set a search directory`);
    return null;
  }
  for (const incbin_dir of options.incbin_dirs) {
    const full_path = path.join(incbin_dir, filename);
    let data;
    try {
      const buf = fs.readFileSync(full_path);
      data = size < 0 ? buf.subarray(offset) : buf.subarray(offset, offset + size);
      data = new Uint8Array(data);
    } catch {
      continue;
    }
    if (size >= 0 && data.length !== size) {
      add_warning(warnings, `Unable to read ${size} bytes from ${full_path} at ${format(offset, "#x")} (got ${data.length} bytes)`);
      return null;
    }
    return data;
  }
  add_warning(warnings, `Unable to find ${filename} in any of ${options.incbin_dirs.length} search paths`);
  return null;
}

function check_ifdef(macro_name, asm_state, warnings, directive) {
  if (!asm_state.defines.has(macro_name)) {
    asm_state.defines.set(macro_name, null);
    add_warning(warnings, `Note: assuming ${macro_name} is unset for ${directive}, ` + `pass -D${macro_name}/-U${macro_name} to set/unset explicitly.`);
  }
  return asm_state.defines.get(macro_name) !== null;
}

function eval_cpp_if(expr, asm_state, warnings, directive) {
  const token_re = /[a-zA-Z0-9_]+|&&|\|\||./gs;
  const tokens = [...expr.matchAll(token_re)].map((m) => m[0]).filter((t) => !isspace(t));
  let i = 0;
  const tok_at = (j) => {
    if (j >= tokens.length) throw new IndexError("list index out of range");
    return tokens[j];
  };
  const parse1 = () => {
    const tok = tok_at(i);
    i += 1;
    if (tok === "!") return !parse1();
    if (tok === "(") {
      const r = parse3();
      pyassert(tok_at(i) === ")");
      i += 1;
      return r;
    }
    if (tok === "defined") {
      pyassert(tok_at(i) === "(");
      const w = tok_at(i + 1);
      pyassert(tok_at(i + 2) === ")");
      i += 3;
      return check_ifdef(w, asm_state, warnings, directive);
    }
    if (/^\p{N}/u.test(tok)) return Boolean(int_(tok, 0));
    const value = asm_state.defines.get(tok) ?? null;
    if (value === null) {
      check_ifdef(tok, asm_state, warnings, directive);
      return false;
    }
    if (!(value instanceof AsmLiteral)) throw new DecompFailure(`Unable to evaluate if condition: ${value}`);
    return Boolean(value.value);
  };
  const parse2 = () => {
    let r = parse1();
    while (i < tokens.length && tokens[i] === "&&") {
      i += 1;
      r = parse1() && r;
    }
    return r;
  };
  const parse3 = () => {
    let r = parse2();
    while (i < tokens.length && tokens[i] === "||") {
      i += 1;
      r = parse2() || r;
    }
    return r;
  };
  let ret;
  try {
    ret = parse3();
    pyassert(i === tokens.length);
  } catch (e) {
    if (e instanceof AssertionError || e instanceof IndexError || e instanceof ValueError) throw new DecompFailure(`Failed to parse #if condition: ${expr}`);
    throw e;
  }
  return ret;
}

/** Python float() on a string. */
export function py_float(s) {
  const t = s.trim().replace(/(?<=\d)_(?=\d)/g, "");
  if (/^[+-]?(inf|infinity)$/i.test(t)) return t.startsWith("-") ? -Infinity : Infinity;
  if (/^[+-]?nan$/i.test(t)) return NaN;
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t)) throw new ValueError(`could not convert string to float: '${s}'`);
  return Number(t);
}

function intToBytes(v, size, big) {
  let b = BigInt(v);
  const out = new Uint8Array(size);
  for (let k = 0; k < size; k++) {
    out[big ? size - 1 - k : k] = Number(b & 0xffn);
    b >>= 8n;
  }
  return out;
}

/** Read a text file as Python's open(..., encoding="utf-8-sig") line iterator would. */
export function read_lines(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  text = text.replace(/\r\n?/g, "\n");
  const lines = [];
  let start = 0;
  for (;;) {
    const j = text.indexOf("\n", start);
    if (j < 0) {
      if (start < text.length) lines.push(text.slice(start));
      break;
    }
    lines.push(text.slice(start, j + 1));
    start = j + 1;
  }
  return lines;
}

/**
 * @param {{name:string, text:string}} f file name and contents
 */
export function parse_file(f, arch, options) {
  const filename = path.basename(f.name);
  const reg_formatter = new RegFormatter();
  const asm_file = new AsmFile(filename, reg_formatter);
  let curr_section = ".text";
  const section_sizes = new DefaultMap(() => 0);
  const warnings = [];
  const preproc_defines = new Map();
  for (const [key, value] of options.preproc_defines) preproc_defines.set(key, value === null ? null : new AsmLiteral(value));
  // NULL is a non-standard but common asm macro that expands to 0
  preproc_defines.set("NULL", new AsmLiteral(0));
  const asm_state = new AsmState({ defines: preproc_defines, reg_formatter });

  let ifdef_level = 0;
  const ifdef_levels = [];

  const re_comment_replacer = (s) => (s[0] === '"' ? s : " ");
  const re_whitespace_or_string = /\s+|"(?:\\.|[^\\"])*"/g;
  const re_local_glabel = /^L(_.*_)?[0-9A-F]{7,8}/;
  const re_local_label = /^(?:loc_|locret_|def_|lbl_|LAB_|switchD_|jump_|LF?[0-9]+$|_[0-9A-Fa-f]{7,8}(?:_.*)?$)/;
  const re_label = /^(?:([a-zA-Z0-9_.$]+)|"([a-zA-Z0-9_.$<>@,-]+)"):/;

  const data_directives = {
    ".word": arch.asm_word_size,
    ".gpword": 4,
    ".4byte": 4,
    ".long": 4,
    ".short": 2,
    ".half": 2,
    ".2byte": 2,
    ".byte": 1,
  };
  const LabelKind = { GLOBAL: "global", LOCAL: "local", JUMP_TARGET: "jump_target" };

  let directive;
  let line;
  const fail_parse = () => {
    throw new DecompFailure(`Could not parse asm_data ${directive} in ${curr_section}: ${line}`);
  };
  const try_parse = (parser) => {
    try {
      return parser();
    } catch {
      fail_parse();
    }
  };
  const parse_int = (w) => {
    const value = try_parse(() => parse_arg(w, arch, asm_state));
    if (!(value instanceof AsmLiteral)) fail_parse();
    return value.value;
  };
  const pack = (fmt, val) => {
    const little = !options.target.is_big_endian();
    if (fmt === "f") {
      if (Number.isFinite(val) && Math.abs(val) > 3.4028235677973366e38) throw new Error("OverflowError: float too large to pack with f format");
      const dv = new DataView(new ArrayBuffer(4));
      dv.setFloat32(0, val, little);
      return new Uint8Array(dv.buffer);
    }
    const dv = new DataView(new ArrayBuffer(8));
    dv.setFloat64(0, val, little);
    return new Uint8Array(dv.buffer);
  };
  const emit_bytes = (data, { is_string = false } = {}) => {
    asm_file.new_data_bytes(data, { is_string });
    section_sizes.set(curr_section, section_sizes.get(curr_section) + data.length);
  };
  const emit_word = (w, size) => {
    const value = try_parse(() => parse_arg(w, arch, asm_state));
    if (value instanceof AsmLiteral) {
      const ival = BigInt.asUintN(size * 8, BigInt(value.value));
      emit_bytes(intToBytes(ival, size, options.target.is_big_endian()));
    } else {
      asm_file.new_symbolic_data(value, size);
      section_sizes.set(curr_section, section_sizes.get(curr_section) + size);
    }
  };

  const re_comment_or_string = new RegExp(arch.re_comment + String.raw`|/\*.*?\*/|"(?:\\.|[^\\"])*"`, "g");
  const lines = read_lines(f.text);
  for (let idx = 0; idx < lines.length; idx++) {
    const lineno = idx + 1;
    line = lines[idx];
    const emit_goto = options.goto_patterns.some((pattern) => line.includes(pattern));

    // Convert C preprocessor directives into asm ones
    let is_c_preproc_command = false;
    const ws = split_ws(line);
    if (ws.length && ["#ifdef", "#ifndef", "#else", "#if", "#elif", "#elifdef", "#elifndef", "#endif", "#define"].includes(ws[0])) {
      is_c_preproc_command = true;
      line = "." + line.slice(1);
    }

    // Strip comments and whitespace (but not within strings)
    line = line.replace(re_comment_or_string, re_comment_replacer);
    line = line.replace(re_whitespace_or_string, re_comment_replacer);
    line = line.trim();

    const process_label = (label, { kind }) => {
      if (curr_section === ".rodata") asm_file.new_data_label(label, { is_readonly: true });
      else if (curr_section === ".data") asm_file.new_data_label(label);
      else if (curr_section === ".bss") asm_file.new_data_label(label, { is_bss: true });
      else if (curr_section === ".text") {
        asm_file.new_data_label(label, { is_readonly: true, is_text: true });
        if (label.startsWith(".") || kind === LabelKind.JUMP_TARGET) {
          if (asm_file.current_function !== null) asm_file.new_label(label);
        } else if ((re_local_glabel.test(label) || (kind !== LabelKind.GLOBAL && re_local_label.test(label))) && asm_file.current_function !== null) {
          asm_file.new_label(label);
        } else {
          asm_file.new_function(label);
        }
      }
    };

    // Check for labels
    for (;;) {
      const g = re_label.exec(line);
      if (!g) break;
      const label = g[1] || g[2];
      if (ifdef_level === 0) process_label(label, { kind: LabelKind.LOCAL });
      line = line.slice(g[0].length).trim();
    }

    if (!line) continue;

    if (line.includes("=") && !is_c_preproc_command) {
      const k = line.indexOf("=");
      const key = line.slice(0, k).trim();
      const value = line.slice(k + 1);
      if (!key.includes(" ")) line = `.set ${key}, ${value}`;
    }

    directive = split_ws(line)[0];
    if (directive.startsWith(".")) {
      // Assembler directive.
      const sp = line.indexOf(" ");
      const args_str = sp < 0 ? "" : line.slice(sp + 1);
      if (is_c_preproc_command) {
        line = "#" + line.slice(1);
        directive = split_ws(line)[0];
      }
      if ([".ifdef", ".ifndef", "#ifdef", "#ifndef"].includes(directive)) {
        let active = check_ifdef(args_str, asm_state, warnings, directive);
        if (directive.slice(1) === "ifndef") active = !active;
        const level = 1 - Number(active);
        ifdef_level += level;
        ifdef_levels.push(level);
      } else if (directive === ".if") {
        const parts = split_ws(line);
        if (parts.length < 2) throw new IndexError("list index out of range");
        const macro_name = parts[1];
        let active;
        if (macro_name === "0") active = false;
        else if (macro_name === "1") active = true;
        else {
          active = true;
          add_warning(warnings, `Note: ignoring .if ${macro_name} directive`);
        }
        const level = 1 - Number(active);
        ifdef_level += level;
        ifdef_levels.push(level);
      } else if (directive === "#if") {
        const active = eval_cpp_if(args_str, asm_state, warnings, directive);
        const level = 1 - Number(active);
        ifdef_level += level;
        ifdef_levels.push(level);
      } else if (["#elif", "#elifdef", "#elifndef", "#else", ".else"].includes(directive)) {
        if (!ifdef_levels.length) throw new IndexError("pop from empty list");
        let level = ifdef_levels.pop();
        ifdef_level -= level;
        if (level === 1) {
          let active;
          if (directive === "#elifdef") active = check_ifdef(args_str, asm_state, warnings, directive);
          else if (directive === "#elifndef") active = !check_ifdef(args_str, asm_state, warnings, directive);
          else if (directive === "#elif") active = eval_cpp_if(args_str, asm_state, warnings, directive);
          else active = true;
          level = 1 - Number(active);
        } else level = 2;
        ifdef_level += level;
        ifdef_levels.push(level);
      } else if (directive === ".endif" || directive === "#endif") {
        if (!ifdef_levels.length) throw new IndexError("pop from empty list");
        ifdef_level -= ifdef_levels.pop();
      } else if (directive === ".macro") {
        ifdef_level += 1;
      } else if (directive === ".endm") {
        ifdef_level -= 1;
      } else if (directive === ".fn") {
        const args = split_quotable_arg_list(args_str);
        asm_file.new_function(args[0]);
      } else if (ifdef_level === 0) {
        if (directive === ".section") {
          curr_section = split_ws(line)[1].split(",")[0];
          if ([".rdata", ".late_rodata", ".sdata2"].includes(curr_section)) curr_section = ".rodata";
          else if (curr_section === ".sdata") curr_section = ".data";
          else if (curr_section.startsWith(".text")) curr_section = ".text";
        } else if (directive === ".rdata" || directive === ".rodata" || directive === ".late_rodata") {
          curr_section = ".rodata";
        } else if (directive === ".data") curr_section = ".data";
        else if (directive === ".bss") curr_section = ".bss";
        else if (directive === ".text") curr_section = ".text";
        else if (directive === ".set") {
          const args = split_quotable_arg_list(args_str);
          if (args.length === 1) {
            // ".set noreorder" or similar, just ignore
          } else if (args.length === 2) asm_state.defines.set(args[0], parse_arg(args[1], arch, asm_state));
          else throw new DecompFailure(`Could not parse ${directive}: ${line}`);
        } else if (directive === "#define") {
          const args = split_ws(args_str, 1);
          if (args.length === 2) asm_state.defines.set(args[0], parse_arg(args[1], arch, asm_state));
          else asm_state.defines.set(args[0], new AsmLiteral(1));
        } else if (directive === ".syntax") {
          if (args_str.trim() === "unified") asm_state.is_unified = true;
          else if (args_str.trim() === "divided") asm_state.is_unified = false;
        } else if (directive === ".thumb" || directive === ".thumb_func") asm_state.is_thumb = true;
        else if (directive === ".arm") asm_state.is_thumb = false;
        else if (directive === ".code") {
          if (args_str.trim() === "16") asm_state.is_thumb = true;
          else if (args_str.trim() === "32") asm_state.is_thumb = false;
        } else if ([".rodata", ".data", ".bss", ".text"].includes(curr_section)) {
          if (Object.prototype.hasOwnProperty.call(data_directives, directive)) {
            const size = data_directives[directive];
            const args = split_arg_list(args_str);
            for (const w of args) emit_word(w, size);
          } else if (directive === ".rel") {
            const args = split_arg_list(args_str);
            pyassert(args.length === 2);
            emit_word(args[1], 4);
          } else if (directive === ".obj") {
            const args = split_quotable_arg_list(args_str);
            pyassert(args.length === 2);
            const kind = args[1] === "local" ? LabelKind.LOCAL : LabelKind.GLOBAL;
            process_label(args[0], { kind });
          } else if (directive === ".float") {
            const args = split_arg_list(args_str);
            for (const w of args) {
              const fval = try_parse(() => py_float(w));
              emit_bytes(pack("f", fval));
            }
          } else if (directive === ".double") {
            const args = split_arg_list(args_str);
            for (const w of args) {
              const fval = try_parse(() => py_float(w));
              emit_bytes(pack("d", fval));
            }
          } else if ([".asci", ".asciz", ".ascii", ".asciiz", ".string"].includes(directive)) {
            const z = directive.endsWith("z") || directive === ".string";
            emit_bytes(parse_ascii_directive(line, z), { is_string: true });
          } else if ([".space", ".skip", ".align", ".balign", ".p2align"].includes(directive)) {
            const args = split_arg_list(args_str);
            let fill;
            if (args.length === 2) fill = band(parse_int(args[1]), 0xff);
            else if (args.length === 1) fill = 0;
            else throw new DecompFailure(`Could not parse asm_data ${directive} in ${curr_section}: ${line}`);
            let size = parse_int(args[0]);
            if (directive === ".balign") size = pymod(-section_sizes.get(curr_section), size);
            else if (directive === ".align" || directive === ".p2align") size = pymod(-section_sizes.get(curr_section), 2 ** size);
            emit_bytes(new Uint8Array(Math.max(size, 0)).fill(fill));
          } else if (directive === ".incbin") {
            const args = split_quotable_arg_list(args_str);
            const data = parse_incbin(args, options, warnings);
            if (data !== null) emit_bytes(data);
          }
        }
      }
    } else if (ifdef_level === 0) {
      if (["jlabel", "alabel", "ehlabel"].includes(directive)) {
        const sp = line.indexOf(" ");
        const args_str = sp < 0 ? "" : line.slice(sp + 1);
        const args = split_quotable_arg_list(args_str);
        if (args.length) process_label(args[0], { kind: LabelKind.JUMP_TARGET });
      } else if (
        ["glabel", "dlabel", "arm_func_start", "thumb_func_start", "non_word_aligned_thumb_func_start", "ARM_FUNC_START", "THUMB_FUNC_START", "NON_WORD_ALIGNED_THUMB_FUNC_START"].includes(directive)
      ) {
        if (directive.toLowerCase().includes("thumb")) asm_state.is_thumb = true;
        else if (directive.toLowerCase().includes("arm")) asm_state.is_thumb = false;
        const sp = line.indexOf(" ");
        const args_str = sp < 0 ? "" : line.slice(sp + 1);
        const args = split_quotable_arg_list(args_str);
        if (args.length) process_label(args[0], { kind: LabelKind.GLOBAL });
      } else if (["arm_func_end", "thumb_func_end", "ARM_FUNC_END", "THUMB_FUNC_END", "endlabel", "enddlabel", "nonmatching"].includes(directive)) {
        // pass
      } else if (curr_section === ".text") {
        const meta = new InstructionMeta({ emit_goto, filename, lineno, synthetic: false });
        const ins = parse_instruction(line, meta, arch, asm_state);
        asm_file.new_instruction(ins);
      }
    }
  }

  if (warnings.length && options.coding_style.comment_style !== CodingStyle.CommentStyle.NONE) {
    print("/*");
    print(warnings.join("\n"));
    print("*/");
  }
  return asm_file;
}

export { pystr };
