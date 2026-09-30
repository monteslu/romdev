// Port of m2c/options.py
import { assert_never } from "./error.js";
import { ValueError, format } from "./py.js";

let enumSeq = 0;
/** Minimal Python enum.Enum replacement: members are singletons with .name/.value. */
export class PyEnum {
  constructor(name, value) {
    this.name = name;
    this.value = value;
    Object.defineProperty(this, "__enum_key", { value: `${new.target.name}.${name}.${++enumSeq}`, enumerable: false });
  }
  __str__() {
    return String(this.value);
  }
  toString() {
    return String(this.value);
  }
  static define(cls, members) {
    cls.members = [];
    for (const [name, value] of Object.entries(members)) {
      const m = new cls(name, value);
      cls[name] = m;
      cls.members.push(m);
    }
    return cls;
  }
  /** `EnumCls(value)` lookup; raises ValueError like Python. */
  static of(value) {
    for (const m of this.members) if (m.value === value) return m;
    throw new ValueError(`'${value}' is not a valid ${this.name}`);
  }
}

export class CommentStyle extends PyEnum {}
PyEnum.define(CommentStyle, { MULTILINE: "multiline", ONELINE: "oneline", NONE: "none" });

export class CodingStyle {
  static CommentStyle = CommentStyle;
  constructor({
    newline_after_function,
    newline_after_if,
    newline_before_else,
    switch_indent_level,
    pointer_style_left,
    unknown_underscore,
    hex_case,
    comment_style,
    comment_column,
  }) {
    this.newline_after_function = newline_after_function;
    this.newline_after_if = newline_after_if;
    this.newline_before_else = newline_before_else;
    this.switch_indent_level = switch_indent_level;
    this.pointer_style_left = pointer_style_left;
    this.unknown_underscore = unknown_underscore;
    this.hex_case = hex_case;
    this.comment_style = comment_style;
    this.comment_column = comment_column;
    Object.freeze(this);
  }
}

class PlatformEnum extends PyEnum {
  get arch() {
    if (this === PlatformEnum.MIPS) return ArchEnum.MIPS;
    else if (this === PlatformEnum.MIPSEL) return ArchEnum.MIPS;
    else if (this === PlatformEnum.MIPSEE) return ArchEnum.MIPS;
    else if (this === PlatformEnum.PPC) return ArchEnum.PPC;
    else if (this === PlatformEnum.ARM) return ArchEnum.ARM;
    else if (this === PlatformEnum.GBA) return ArchEnum.ARM;
    else if (this === PlatformEnum.SH2 || this === PlatformEnum.SH4) return ArchEnum.SH;
    else return assert_never(this);
  }
}
PyEnum.define(PlatformEnum, { MIPS: "mips", MIPSEL: "mipsel", MIPSEE: "mipsee", PPC: "ppc", ARM: "arm", GBA: "gba", SH2: "sh2", SH4: "sh4" });
class ArchEnum extends PyEnum {}
PyEnum.define(ArchEnum, { MIPS: "mips", PPC: "ppc", ARM: "arm", SH: "sh" });
class EndianEnum extends PyEnum {}
PyEnum.define(EndianEnum, { LITTLE: "little", BIG: "big" });
class CompilerEnum extends PyEnum {}
PyEnum.define(CompilerEnum, { IDO: "ido", GCC: "gcc", MWCC: "mwcc", SHC: "shc" });
class LanguageEnum extends PyEnum {}
PyEnum.define(LanguageEnum, { C: "c", CXX: "c++" });

export class Target {
  static PlatformEnum = PlatformEnum;
  static ArchEnum = ArchEnum;
  static EndianEnum = EndianEnum;
  static CompilerEnum = CompilerEnum;
  static LanguageEnum = LanguageEnum;

  constructor({ platform, arch, endian, compiler, language }) {
    this.platform = platform;
    this.arch = arch;
    this.endian = endian;
    this.compiler = compiler;
    this.language = language;
  }

  is_big_endian() {
    return this.endian === EndianEnum.BIG;
  }

  /**
   * Parse an `platform-compiler-language` triple.
   * If `-language` is missing, use the default for the compiler.
   * If `-compiler` is missing, use the default for the platform.
   */
  static parse(name) {
    let endian = EndianEnum.BIG;
    const terms = name.split("-");
    let platform, arch, compiler, language;
    try {
      platform = PlatformEnum.of(terms[0]);
      if ([PlatformEnum.MIPSEL, PlatformEnum.MIPSEE, PlatformEnum.ARM, PlatformEnum.GBA, PlatformEnum.SH4].includes(platform)) {
        endian = EndianEnum.LITTLE;
      }
      arch = platform.arch;

      if (terms.length >= 2) compiler = CompilerEnum.of(terms[1]);
      else if (platform === PlatformEnum.SH4) compiler = CompilerEnum.SHC;
      else if (arch === ArchEnum.PPC) compiler = CompilerEnum.MWCC;
      else if (arch === ArchEnum.MIPS && endian === EndianEnum.BIG) compiler = CompilerEnum.IDO;
      else compiler = CompilerEnum.GCC;

      if (terms.length >= 3) language = LanguageEnum.of(terms[2]);
      else if (compiler === CompilerEnum.MWCC) language = LanguageEnum.CXX;
      else language = LanguageEnum.C;
    } catch (e) {
      if (e instanceof ValueError) throw new ValueError(`Unable to parse Target '${name}' (${e.message})`);
      throw e;
    }
    return new Target({ platform, arch, endian, compiler, language });
  }
}

class GlobalDeclsEnum extends PyEnum {}
PyEnum.define(GlobalDeclsEnum, { ALL: "all", USED: "used", NONE: "none" });
class VisualizeTypeEnum extends PyEnum {}
PyEnum.define(VisualizeTypeEnum, { ASM: "asm", C: "c" });
class VisualizeFormatEnum extends PyEnum {}
PyEnum.define(VisualizeFormatEnum, { DOT: "dot", SVG: "svg" });

export class Options {
  static GlobalDeclsEnum = GlobalDeclsEnum;
  static VisualizeTypeEnum = VisualizeTypeEnum;
  static VisualizeFormatEnum = VisualizeFormatEnum;

  constructor(fields) {
    Object.assign(this, fields);
  }

  formatter() {
    return new Formatter({
      coding_style: this.coding_style,
      skip_casts: this.skip_casts,
      zfill_constants: this.zfill_constants,
      force_decimal: this.force_decimal,
      valid_syntax: this.valid_syntax,
      descending_regs: this.descending_regs,
      backwards_bss: this.backwards_bss,
    });
  }
}

export const DEFAULT_CODING_STYLE = new CodingStyle({
  newline_after_function: false,
  newline_after_if: false,
  newline_before_else: false,
  switch_indent_level: 1,
  pointer_style_left: false,
  unknown_underscore: false,
  hex_case: false,
  comment_style: CommentStyle.MULTILINE,
  comment_column: 52,
});

/** Python len() of a str (code points). */
function pylen(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0xd800 || c > 0xdbff) n++;
  }
  return n;
}

export class Formatter {
  constructor({
    coding_style = DEFAULT_CODING_STYLE,
    indent_step = " ".repeat(4),
    skip_casts = false,
    extra_indent = 0,
    debug = false,
    valid_syntax = false,
    line_length = 80,
    zfill_constants = false,
    force_decimal = false,
    descending_regs = false,
    backwards_bss = false,
  } = {}) {
    this.coding_style = coding_style;
    this.indent_step = indent_step;
    this.skip_casts = skip_casts;
    this.extra_indent = extra_indent;
    this.debug = debug;
    this.valid_syntax = valid_syntax;
    this.line_length = line_length;
    this.zfill_constants = zfill_constants;
    this.force_decimal = force_decimal;
    this.descending_regs = descending_regs;
    this.backwards_bss = backwards_bss;
  }

  indent(line, indent = 0) {
    return this.indent_step.repeat(Math.max(indent + this.extra_indent, 0)) + line;
  }

  /** Python `with fmt.indented(amt):` - runs fn with extra indentation. */
  indented(amt, fn) {
    if (typeof amt === "function") {
      fn = amt;
      amt = 1;
    }
    try {
      this.extra_indent += amt;
      return fn();
    } finally {
      this.extra_indent -= amt;
    }
  }

  format_array(elements) {
    if (!elements.some((el) => el.includes("\n") || pylen(el) > this.line_length)) {
      const output = `{ ${elements.join(", ")} }`;
      if (pylen(output) < this.line_length) return output;
    }
    let output = "{\n";
    for (let el of elements) {
      el = el.replaceAll("\n", "\n" + this.indent_step);
      output += this.indent(`${el},\n`, 1);
    }
    output += "}";
    return output;
  }

  /** Indent `line` and append a list of `comments` joined with ';' */
  with_comments(line, comments, { indent = 0 } = {}) {
    const base = this.indent(line, indent);
    if (!comments.length || this.coding_style.comment_style === CommentStyle.NONE) return base;
    let padding = "";
    if (line) padding = " ".repeat(Math.max(1, this.coding_style.comment_column - pylen(base)));
    const comment_str = comments.join("; ");
    let start, mid, end;
    if (this.coding_style.comment_style === CommentStyle.ONELINE) {
      start = "// ";
      mid = "// ";
      end = "";
    } else {
      start = "/* ";
      mid = " * ";
      end = " */";
    }
    const lines = comment_str.split("\n");
    let ret = `${base}${padding}${start}${lines[0]}`;
    for (const cline of lines.slice(1)) {
      const new_base = this.indent("", indent) + " ".repeat(pylen(line));
      ret += `\n${new_base}${padding}${mid}${cline}`;
    }
    return ret + end;
  }

  format_hex(val) {
    return format(val, "x").toUpperCase();
  }

  format_int(val, size_bits = null) {
    if (Math.abs(val) < 10 || this.force_decimal) return String(val);
    let hex_digits;
    if (this.zfill_constants && size_bits !== null && size_bits !== undefined) hex_digits = format(Math.abs(val), `0${Math.floor(size_bits / 4)}X`);
    else hex_digits = format(Math.abs(val), "X");
    if (hex_digits.length === 7) hex_digits = `0${hex_digits}`;
    if (val < 0) return `-0x${hex_digits}`;
    else return `0x${hex_digits}`;
  }
}
