// Port of m2c/c_types.py
// This file handles variable types, function signatures and struct layouts
// based on a C AST. Based on the pycparser library.
import fs from "node:fs";
import { c_ast as ca, CGenerator, CParser, ParseError } from "romdev-pycparser";
import { DecompFailure } from "./error.js";
import { DefaultMap, ValueError, band, bnot, bor, bxor, count, deepcopy, floordiv, hex, int_, pyassert, pymod, rstrip, shl, shr } from "./py.js";
import { print, popts } from "./io.js";

const { ArrayDecl, FuncDecl, IdentifierType, PtrDecl, TypeDecl } = ca;

/** Arch-specific information needed to extract types from C. */
export class ArchC {}
ArchC.prototype.base_struct_align = 1;

export class StructField {
  constructor(type, size, name) {
    this.type = type;
    this.size = size;
    this.name = name;
  }
}

export class BitField {
  constructor(width, name) {
    this.width = width;
    this.name = name;
  }
}

export class Struct {
  constructor({ type, fields, bitfields, has_bitfields, size, align }) {
    this.type = type;
    this.fields = fields; // Map<int, StructField[]>
    this.bitfields = bitfields; // Map<int, BitField[]>
    this.has_bitfields = has_bitfields;
    this.size = size;
    this.align = align;
  }
}

export class Array_ {
  constructor(subtype, subctype, subsize, dim) {
    this.subtype = subtype;
    this.subctype = subctype;
    this.subsize = subsize;
    this.dim = dim;
  }
}

export class Param {
  constructor(type, name) {
    this.type = type;
    this.name = name;
  }
}

export class Function {
  constructor({ type, ret_type, params, is_variadic }) {
    this.type = type;
    this.ret_type = ret_type;
    this.params = params;
    this.is_variadic = is_variadic;
  }
}

export class Enum {
  constructor(tag, names) {
    this.tag = tag;
    this.names = names; // Map<int, str>
  }
}

export class TypeMap {
  static VERSION = 10;
  constructor({ source_hash, base_struct_align, cparser_scope = null }) {
    this.source_hash = source_hash;
    this.base_struct_align = base_struct_align;
    this.cparser_scope = cparser_scope;
    this.typedefs = new Map(); // name -> [CType, align]
    this.var_types = new Map();
    this.vars_with_initializers = new Set();
    this.functions = new Map();
    this.structs = new Map(); // str | ca.Struct/Union -> Struct
    this.struct_typedefs = new Map();
    this.pragma_packs = new Map();
    this.enums = new Map();
    this.enum_values = new Map();
  }
}

export function to_c(node) {
  return new CGenerator().visit(node);
}

export function basic_type(names) {
  const idtype = new IdentifierType(names);
  return new TypeDecl(null, [], [], idtype);
}

export function pointer(type) {
  return new PtrDecl([], type);
}

export function get_align_override(decl, typemap) {
  const aligns = [];
  for (const attr of decl.gcc_attributes) {
    if (attr.name === "packed") aligns.push(1);
    if (attr.name === "aligned") {
      let align_to;
      if (!attr.args || !attr.args.length) align_to = 0x10;
      else align_to = parse_constant_int(attr.args[0], typemap);
      aligns.push(align_to);
    }
  }
  if (decl instanceof ca.Decl) {
    for (const alignas of decl.align) {
      let align_to;
      if (alignas.alignment instanceof ca.Typename) {
        const [, tp_align] = parse_struct_member(alignas.alignment.type, "referenced in _Alignas", typemap, { allow_unsized: false });
        align_to = get_align_override(alignas.alignment, typemap) || tp_align;
      } else align_to = parse_constant_int(alignas.alignment, typemap);
      aligns.push(align_to);
    }
  }
  let align = 0;
  for (const align_to of aligns) {
    if (align_to <= 0 || band(align_to, align_to - 1) !== 0) throw new DecompFailure(`Alignment ${align_to} is not a power of two`);
    align = Math.max(align, align_to);
  }
  return align;
}

export function has_128bit_attr(attrs) {
  return attrs.some((attr) => attr.name === "mode" && attr.args && attr.args.length && attr.args[0] instanceof ca.ID && attr.args[0].name === "TI");
}

export function resolve_typedefs(type, typemap) {
  if (type instanceof TypeDecl) {
    if (type.type instanceof IdentifierType && type.type.names.length === 1 && typemap.typedefs.has(type.type.names[0])) {
      const [t, align_override] = typemap.typedefs.get(type.type.names[0]);
      const [t2, base_align_override] = resolve_typedefs(t, typemap);
      return [t2, align_override || base_align_override];
    }
    if (type.type instanceof ca.Typeof) {
      const typeof_ = type.type;
      if (typeof_.expr instanceof ca.Typename) {
        return [typeof_.expr.type, get_align_override(typeof_.expr, typemap)];
      } else {
        const expr = typeof_.expr;
        if (expr instanceof ca.UnaryOp && expr.op === "sizeof") {
          const size_t = new ca.IdentifierType(["unsigned", "int"]);
          return [new TypeDecl(null, [], [], size_t), 0];
        }
        throw new DecompFailure("typeof() is not supported");
      }
    }
  }
  return [type, 0];
}

export function type_of_var_decl(decl) {
  pyassert(!(decl.type instanceof ca.Struct || decl.type instanceof ca.Union || decl.type instanceof ca.Enum), "decls that declare variables have CType types");
  return decl.type;
}

/** Get the CType of a global Decl, stripping names of function parameters. */
export function type_from_global_decl(decl) {
  const tp = type_of_var_decl(decl);
  if (!(tp instanceof ca.FuncDecl) || !tp.args) return tp;
  const anonymize_param = (param) => {
    param = deepcopy(param);
    param.name = null;
    set_decl_name(param);
    return new ca.Typename(null, param.quals, null, [], type_of_var_decl(param));
  };
  const new_params = tp.args.params.map((param) => (param instanceof ca.Decl ? anonymize_param(param) : param));
  return new ca.FuncDecl(new ca.ParamList(new_params), tp.type);
}

function namesEq(names, arr) {
  return names.length === arr.length && names.every((n, i) => n === arr[i]);
}

export function is_void(type) {
  return type instanceof ca.TypeDecl && type.type instanceof ca.IdentifierType && namesEq(type.type.names, ["void"]);
}

export function primitive_size(type) {
  if (type instanceof ca.Enum) return 4;
  const names = type.names;
  if (names.includes("double")) return 8;
  if (names.includes("float")) return 4;
  if (names.includes("__int128")) return 16;
  if (names.includes("short")) return 2;
  if (names.includes("char")) return 1;
  if (names.includes("void")) return 0;
  if (names.filter((n) => n === "long").length === 2) return 8;
  return 4;
}

/** Returns [start, stop] (Python range) or null. */
export function primitive_range(type) {
  let bits = 8 * primitive_size(type);
  let signed = true;
  if (!(type instanceof ca.Enum)) {
    const names = type.names;
    if (names.includes("double") || names.includes("float") || names.includes("void")) return null;
    if (names.includes("unsigned")) signed = false;
  }
  if (signed) {
    bits -= 1;
    return [-(2 ** bits), 2 ** bits];
  }
  return [0, 2 ** bits];
}

/** Return true if `type` represents an unknown type, or undetermined struct padding. */
export function is_unk_type(type, typemap) {
  if (type instanceof ArrayDecl && type.type instanceof TypeDecl && type.type.type instanceof IdentifierType && type.type.declname !== null && type.type.declname !== undefined && namesEq(type.type.type.names, ["char"])) {
    const declname = type.type.declname;
    if (declname.startsWith("unk_") || declname.startsWith("pad")) return true;
  }
  for (;;) {
    if (type instanceof TypeDecl && type.type instanceof IdentifierType && type.type.names.length === 1 && typemap.typedefs.has(type.type.names[0])) {
      const type_name = type.type.names[0];
      if (type_name.startsWith("UNK_") || type_name.startsWith("M2C_UNK")) return true;
      type = typemap.typedefs.get(type_name)[0];
    } else if (type instanceof PtrDecl || type instanceof ArrayDecl) type = type.type;
    else return false;
  }
}

export function parse_function(fn) {
  if (!(fn instanceof FuncDecl)) return null;
  const params = [];
  let is_variadic = false;
  let has_void = false;
  if (fn.args) {
    for (const arg of fn.args.params) {
      if (arg instanceof ca.EllipsisParam) is_variadic = true;
      else if (arg instanceof ca.Decl) params.push(new Param(type_of_var_decl(arg), arg.name));
      else if (arg instanceof ca.ID) throw new DecompFailure("K&R-style function header is not supported: " + to_c(fn));
      else {
        pyassert(arg instanceof ca.Typename);
        if (is_void(arg.type)) has_void = true;
        else params.push(new Param(arg.type, null));
      }
    }
  }
  let maybe_params = params;
  if (!params.length && !has_void && !is_variadic) maybe_params = null;
  const ret_type = is_void(fn.type) ? null : fn.type;
  return new Function({ type: fn, ret_type, params: maybe_params, is_variadic });
}

export function divmod_towards_zero(lhs, rhs, op) {
  if (rhs < 0) {
    rhs = -rhs;
    lhs = -lhs;
  }
  if (lhs < 0) return -divmod_towards_zero(-lhs, rhs, op);
  if (op === "/") return floordiv(lhs, rhs);
  return pymod(lhs, rhs);
}

export function parse_constant_int(expr, typemap) {
  if (expr instanceof ca.Constant) {
    try {
      return int_(rstrip(expr.value, "lLuU"), 0);
    } catch (e) {
      if (e instanceof ValueError) throw new DecompFailure(`Failed to parse ${to_c(expr)} as an int literal`);
      throw e;
    }
  }
  if (expr instanceof ca.ID) {
    if (typemap.enum_values.has(expr.name)) return typemap.enum_values.get(expr.name);
  }
  if (expr instanceof ca.BinaryOp) {
    const op = expr.op;
    const lhs = parse_constant_int(expr.left, typemap);
    if (op === "&&" && lhs === 0) return 0;
    if (op === "||" && lhs !== 0) return 1;
    const rhs = parse_constant_int(expr.right, typemap);
    if (op === "+") return lhs + rhs;
    if (op === "-") return lhs - rhs;
    if (op === "*") return lhs * rhs;
    if (op === "<<") return shl(lhs, rhs);
    if (op === ">>") return shr(lhs, rhs);
    if (op === "&") return band(lhs, rhs);
    if (op === "|") return bor(lhs, rhs);
    if (op === "^") return bxor(lhs, rhs);
    if (op === ">=") return lhs >= rhs ? 1 : 0;
    if (op === "<=") return lhs <= rhs ? 1 : 0;
    if (op === ">") return lhs > rhs ? 1 : 0;
    if (op === "<") return lhs < rhs ? 1 : 0;
    if (op === "==") return lhs === rhs ? 1 : 0;
    if (op === "!=") return lhs !== rhs ? 1 : 0;
    if (op === "&&" || op === "||") return rhs !== 0 ? 1 : 0;
    if (op === "/" || op === "%") {
      if (rhs === 0) throw new DecompFailure(`Division by zero when evaluating expression ${to_c(expr)}`);
      return divmod_towards_zero(lhs, rhs, op);
    }
  }
  if (expr instanceof ca.TernaryOp) {
    const cond = parse_constant_int(expr.cond, typemap) !== 0;
    return parse_constant_int(cond ? expr.iftrue : expr.iffalse, typemap);
  }
  if (expr instanceof ca.ExprList) {
    const last_expr = expr.exprs[expr.exprs.length - 1];
    if (!(last_expr instanceof ca.Typename)) return parse_constant_int(last_expr, typemap);
  }
  if (expr instanceof ca.UnaryOp && !(expr.expr instanceof ca.Typename)) {
    const sub = parse_constant_int(expr.expr, typemap);
    if (expr.op === "+") return sub;
    if (expr.op === "-") return -sub;
    if (expr.op === "~") return bnot(sub);
    if (expr.op === "!") return sub === 0 ? 1 : 1;
  }
  if (expr instanceof ca.UnaryOp && expr.expr instanceof ca.Typename) {
    const [size, align] = parse_struct_member(expr.expr.type, `referenced in ${expr.op}`, typemap, { allow_unsized: false });
    if (expr.op === "sizeof") return size;
    if (expr.op === "_Alignof") return get_align_override(expr.expr, typemap) || align;
  }
  if (expr instanceof ca.Cast) {
    const value = parse_constant_int(expr.expr, typemap);
    const [type] = resolve_typedefs(expr.to_type.type, typemap);
    if (type instanceof ca.TypeDecl && (type.type instanceof ca.Enum || type.type instanceof ca.IdentifierType)) {
      const rng = primitive_range(type.type);
      if (rng !== null) {
        const [start, stop] = rng;
        const width = stop - start;
        if (Number.isSafeInteger(width) && Number.isSafeInteger(value - start)) return start + pymod(value - start, width);
        return Number(BigInt(start) + (((BigInt(value) - BigInt(start)) % BigInt(width)) + BigInt(width)) % BigInt(width));
      }
    }
  }
  throw new DecompFailure(`Failed to evaluate expression ${to_c(expr)} at compile time; only simple arithmetic is supported for now`);
}

/** Parse an enum and compute the values of all its enumerators. */
export function parse_enum(enum_, typemap) {
  if (enum_.values === null || enum_.values === undefined) return;
  const typemap_enum = new Enum(enum_.name, new Map());
  typemap.enums.set(enum_, typemap_enum);
  if (enum_.name !== null && enum_.name !== undefined && !typemap.enums.has(enum_.name)) typemap.enums.set(enum_.name, typemap_enum);
  let next_value = 0;
  for (const enumerator of enum_.values.enumerators) {
    let value;
    if (enumerator.value) value = parse_constant_int(enumerator.value, typemap);
    else value = next_value;
    next_value = value + 1;
    typemap.enum_values.set(enumerator.name, value);
    typemap_enum.names.set(value, enumerator.name);
  }
}

export function get_struct(struct, typemap) {
  if (struct.name) return typemap.structs.get(struct.name) ?? null;
  return typemap.structs.get(struct) ?? null;
}

export class UndefinedStructError extends DecompFailure {
  constructor(message) {
    super(message);
    this.name = "UndefinedStructError";
  }
}

export function parse_struct(struct, typemap) {
  const existing = get_struct(struct, typemap);
  if (existing) return existing;
  if (struct.decls === null || struct.decls === undefined) {
    throw new UndefinedStructError(`Tried to use struct ${struct.name ?? "None"} before it is defined (does it have a definition?).`);
  }
  const ret = do_parse_struct(struct, typemap);
  if (struct.name) typemap.structs.set(struct.name, ret);
  typemap.structs.set(struct, ret);
  return ret;
}

/** Returns [size, align, DetailedStructMember]. */
export function parse_struct_member(type, field_name, typemap, { allow_unsized }) {
  let align_override;
  [type, align_override] = resolve_typedefs(type, typemap);
  if (type instanceof PtrDecl) return [4, align_override || 4, null];
  if (type instanceof ArrayDecl) {
    let dim;
    if (type.dim !== null && type.dim !== undefined) dim = parse_constant_int(type.dim, typemap);
    else dim = 1;
    const [size, align, substr] = parse_struct_member(type.type, field_name, typemap, { allow_unsized: false });
    return [size * dim, align_override || align, new Array_(substr, type.type, size, dim)];
  }
  if (type instanceof FuncDecl) {
    pyassert(allow_unsized, "Struct can not contain a function");
    return [0, 0, null];
  }
  const inner_type = type.type;
  if (inner_type instanceof ca.Struct || inner_type instanceof ca.Union) {
    const substr = parse_struct(inner_type, typemap);
    return [substr.size, align_override || substr.align, substr];
  }
  if (inner_type instanceof ca.Enum) parse_enum(inner_type, typemap);
  pyassert(!(inner_type instanceof ca.Typeof), "handled by resolve_typedefs");
  const size = primitive_size(inner_type);
  if (size === 0 && !allow_unsized) throw new DecompFailure(`Field ${field_name} cannot be void`);
  return [size, align_override || size, null];
}

function do_parse_struct(struct, typemap) {
  const is_union = struct instanceof ca.Union;
  pyassert(struct.decls !== null && struct.decls !== undefined, "enforced by caller");

  const fields = new DefaultMap(() => []);
  const bitfields = new DefaultMap(() => []);
  let union_size = 0;
  let offset = 0;
  let bit_offset = 0;
  let has_bitfields = false;
  let align = get_align_override(struct, typemap) || typemap.base_struct_align;
  const pack_struct = struct.gcc_attributes.some((attr) => attr.name === "packed");
  const pragma_pack = typemap.pragma_packs.get(struct) ?? 0;

  const flush_bitfields = () => {
    if (!is_union && bit_offset !== 0) {
      bit_offset = 0;
      offset += 1;
    }
  };

  for (const decl of struct.decls) {
    if (is_union) pyassert(offset === 0);
    if (!(decl instanceof ca.Decl)) continue;

    let pack_decl;
    if (pack_struct || decl.gcc_attributes.some((attr) => attr.name === "packed")) pack_decl = get_align_override(decl, typemap) || 1;
    else pack_decl = 0;
    if (pragma_pack && (!pack_decl || pack_decl > pragma_pack)) pack_decl = pragma_pack;

    const type = decl.type;
    if (type instanceof ca.Struct || type instanceof ca.Union) {
      if (type.decls === null || type.decls === undefined) continue;
      const substruct = parse_struct(type, typemap);
      const subalign = pack_decl || get_align_override(decl, typemap) || substruct.align;
      if (type.name !== null && type.name !== undefined) {
        // Struct defined within another; parse_struct already registered it.
      } else {
        flush_bitfields();
        align = Math.max(align, subalign);
        offset = band(offset + subalign - 1, -subalign);
        for (const [off, sfields] of substruct.fields) for (const field of sfields) fields.get(offset + off).push(field);
        if (is_union) union_size = Math.max(union_size, substruct.size);
        else offset += substruct.size;
      }
      continue;
    }

    if (type instanceof ca.Enum) {
      parse_enum(type, typemap);
      continue;
    }

    const field_name = `${struct.name ?? "None"}.${decl.name ?? "None"}`;
    if (decl.bitsize !== null && decl.bitsize !== undefined) {
      has_bitfields = true;
      const width = parse_constant_int(decl.bitsize, typemap);
      const [ssize, salign, substr] = parse_struct_member(type, field_name, typemap, { allow_unsized: false });
      if (ssize !== salign || substr !== null) throw new DecompFailure(`Bitfield ${field_name} is not of primitive type`);
      if (get_align_override(decl, typemap)) throw new DecompFailure(`Alignment directive not supported for bitfield ${field_name}`);
      align = Math.max(align, salign);
      if (width === 0) continue;
      if (width > ssize * 8) throw new DecompFailure(`Width of bitfield ${field_name} exceeds its type`);
      if (floordiv(offset, ssize) !== floordiv(offset + floordiv(bit_offset + width - 1, 8), ssize) && !pack_decl) {
        bit_offset = 0;
        offset = band(offset + ssize, -ssize);
      }
      if (decl.name !== null && decl.name !== undefined) bitfields.get(offset * 8 + bit_offset).push(new BitField(width, decl.name));
      if (is_union) union_size = Math.max(union_size, ssize);
      else {
        bit_offset += width;
        offset += floordiv(bit_offset, 8);
        bit_offset &= 7;
      }
      continue;
    }

    if (decl.name === null || decl.name === undefined) continue;

    flush_bitfields();
    let [ssize, salign] = parse_struct_member(type, field_name, typemap, { allow_unsized: false });
    salign = pack_decl || Math.max(salign, get_align_override(decl, typemap));
    align = Math.max(align, salign);
    offset = band(offset + salign - 1, -salign);
    fields.get(offset).push(new StructField(type, ssize, decl.name));
    if (is_union) union_size = Math.max(union_size, ssize);
    else offset += ssize;
  }

  flush_bitfields();

  let ctype;
  if (typemap.struct_typedefs.has(struct)) ctype = typemap.struct_typedefs.get(struct);
  else if (struct.name && typemap.struct_typedefs.has(struct.name)) ctype = typemap.struct_typedefs.get(struct.name);
  else ctype = new TypeDecl(null, [], [], struct);

  let size = is_union ? union_size : offset;
  size = band(size + align - 1, -align);
  return new Struct({ type: ctype, fields: new Map(fields), bitfields: new Map(bitfields), has_bitfields, size, align });
}

/** Add built-in typedefs to the source code. */
export function add_builtin_typedefs(source) {
  const typedefs = {
    u8: "unsigned char",
    s8: "char",
    u16: "unsigned short",
    s16: "short",
    u32: "unsigned int",
    s32: "int",
    u64: "unsigned long long",
    s64: "long long",
    f32: "float",
    f64: "double",
  };
  const line = Object.entries(typedefs)
    .map(([k, v]) => `typedef ${v} ${k};`)
    .join(" ");
  return line + "\n" + source;
}

export function strip_comments(text) {
  const pattern = /\/\/.*?$|\/\*[\s\S]*?\*\/|'(?:\\[\s\S]|[^\\'])*'|"(?:\\[\s\S]|[^\\"])*"/gm;
  return text.replace(pattern, (s) => (s.startsWith("/") ? " " + "\n".repeat(count(s, "\n")) : s));
}

export function process_ifdef(text) {
  const pattern = /^[ \t]*#if(?<neg>n?)def[ \t]+M2C\s+(?<if_body>[\s\S]*?)(?:^[ \t]*#else\s+(?<else_body>[\s\S]*?))?^[ \t]*#endif[\s\S]*?$/gm;
  return text.replace(pattern, (...args) => {
    const groups = args[args.length - 1];
    const whole = args[0];
    let ret;
    if (groups.neg === "n") ret = groups.else_body || "";
    else ret = groups.if_body;
    return ret + "\n".repeat(Math.max(0, count(whole, "\n") - count(ret, "\n")));
  });
}

/** Strip macro definitions from C source (m2c does not run the preprocessor). */
export function strip_macro_defs(text) {
  const pattern = /^[ \t]*#[ \t]*(?:define|undef)[ \t](\\\n|.)*/gm;
  return text.replace(pattern, (m) => "\n".repeat(count(m, "\n")));
}

export function remove_backslashes_at_eol(text) {
  const string_pat = /'(?:\\[\s\S]|[^\\'])*'?|"(?:\\[\s\S]|[^\\"])*"?/g;
  let continued_string_start_ind = -1;
  let continued_string_delim = "";
  return text.replace(/\\\n/gm, (match, ind) => {
    const line_start = text.lastIndexOf("\n", ind - 1) + 1;
    let prev_line = text.slice(line_start, ind);
    if (line_start === continued_string_start_ind) prev_line = continued_string_delim + prev_line;
    const strings = (prev_line + "$").match(string_pat) ?? [];
    if (strings.length && strings[strings.length - 1].endsWith("$")) {
      const delim = strings[strings.length - 1][0];
      continued_string_start_ind = ind + 2;
      continued_string_delim = delim;
      if (delim === "'") return "";
      return delim + "\n" + delim;
    }
    continued_string_start_ind = -1;
    return "\n";
  });
}

export function parse_c(source, initial_scope) {
  const c_parser = new CParser();
  c_parser.clex.filename = "<source>";
  c_parser.clex.reset_lineno();
  if (initial_scope !== null) c_parser._scope_stack = [new Map(initial_scope)];
  c_parser._last_yielded_token = null;
  let ast;
  try {
    ast = c_parser.cparser.parse(source, c_parser.clex);
  } catch (e) {
    if (e instanceof ParseError) {
      let msg = String(e.message);
      const coord = e.coord;
      const i = msg.indexOf(": ");
      msg = msg.slice(i + 2);
      let posstr;
      if (typeof coord === "string") posstr = " " + coord[0].toLowerCase() + coord.slice(1);
      else {
        const src = coord.source_line();
        posstr = ` at line ${coord.line - 1}, column ${coord.column}\n\n${src}`;
      }
      throw new DecompFailure(`Syntax error when parsing C context.\n${msg}${posstr}`);
    }
    throw e;
  }
  return [ast, new Map(c_parser._scope_stack[0])];
}

/**
 * Build the TypeMap for the given context files.
 *
 * Upstream has two caches, and neither changes the output, so the port parses
 * every time (`--no-cache` / use_cache is accepted and ignored):
 * - an lru_cache on _build_typemap keyed by (paths, arch object, use_cache).
 *   main.run() makes a fresh arch object per run, so it never hits across runs.
 * - a pickle of the finished TypeMap beside each context ("foo.c.m2c"), reused
 *   when sha256(parent hash + source) matches. A hit returns the same TypeMap a
 *   fresh parse builds (object identity inside it is preserved by pickle), and
 *   upstream's own test runner relies on this: it runs the gba cases with
 *   --no-cache and the rest with the cache, against the same expected outputs,
 *   all of which the port reproduces without a cache. The one observable side
 *   effect, a "Warning: Unable to write cache file" line when the context's
 *   directory is read-only, exists only because of the file write, so it is not
 *   reproduced. Parsing a 160 KB decomp context takes about 0.15 s in the port,
 *   and Python's .m2c pickles cannot be read from JS anyway.
 */
export function build_typemap(source_paths, arch, use_cache) {
  void use_cache;
  const sources = source_paths.map((p) => fs.readFileSync(p, "utf8"));
  return _build_typemap(source_paths, sources, arch);
}

function _build_typemap(source_paths, sources, arch) {
  const typemap = new TypeMap({ source_hash: `root:${TypeMap.VERSION},${arch.base_struct_align}`, base_struct_align: arch.base_struct_align });

  for (let source of sources) {
    if (source.charCodeAt(0) === 0xfeff) source = source.slice(1);
    source = source.replace(/\r\n?/g, "\n");
    source = add_builtin_typedefs(source);
    source = strip_comments(source);
    source = process_ifdef(source);
    source = strip_macro_defs(source);
    source = remove_backslashes_at_eol(source);

    const [ast, result_scope] = parse_c(source, typemap.cparser_scope);
    typemap.cparser_scope = result_scope;

    for (const item of ast.ext) {
      if (item instanceof ca.Typedef) {
        let [target, align] = resolve_typedefs(item.type, typemap);
        align = get_align_override(item, typemap) || align;
        if (has_128bit_attr(item.gcc_attributes) && target instanceof TypeDecl && target.type instanceof ca.IdentifierType) {
          const sign = target.type.names.includes("unsigned") ? ["unsigned"] : [];
          target = basic_type([...sign, "__int128"]);
        }
        typemap.typedefs.set(item.name, [target, align]);
        if (item.type instanceof TypeDecl && (item.type.type instanceof ca.Struct || item.type.type instanceof ca.Union) && !get_align_override(item, typemap)) {
          const typedef = basic_type([item.name]);
          if (item.type.type.name) typemap.struct_typedefs.set(item.type.type.name, typedef);
          typemap.struct_typedefs.set(item.type.type, typedef);
        }
      }
      if (item instanceof ca.FuncDef) {
        pyassert(item.decl.name !== null && item.decl.name !== undefined, "cannot define anonymous function");
        const fn = parse_function(type_of_var_decl(item.decl));
        pyassert(fn !== null);
        typemap.functions.set(item.decl.name, fn);
      }
      if (item instanceof ca.Decl && item.type instanceof FuncDecl) {
        pyassert(item.name !== null && item.name !== undefined, "cannot define anonymous function");
        const fn = parse_function(item.type);
        pyassert(fn !== null);
        typemap.functions.set(item.name, fn);
      }
    }

    let cur_pack = 0;
    const pack_stack = [];

    class Visitor extends ca.NodeVisitor {
      visit_Pragma(node) {
        const parts = node.string.split("(");
        if (parts.length >= 2 && parts[0].trim() === "pack") {
          const args = parts[1].split(")")[0].split(",");
          const arg = args[0].trim();
          if (!arg) cur_pack = 0;
          else if (args[0].trim() === "pop") {
            if (!pack_stack.length) throw new Error("IndexError: pop from empty list");
            cur_pack = pack_stack.pop();
          } else if (args[0].trim() === "push") {
            pack_stack.push(cur_pack);
            if (args.length >= 2) cur_pack = int_(args[1], 0);
          } else cur_pack = int_(args[0], 0);
        }
      }
      visit_Struct(node) {
        if (cur_pack) typemap.pragma_packs.set(node, cur_pack);
        if (node.decls !== null && node.decls !== undefined) parse_struct(node, typemap);
      }
      visit_Union(node) {
        if (cur_pack) typemap.pragma_packs.set(node, cur_pack);
        if (node.decls !== null && node.decls !== undefined) parse_struct(node, typemap);
      }
      visit_Decl(node) {
        if (node.name !== null && node.name !== undefined) {
          typemap.var_types.set(node.name, type_from_global_decl(node));
          if (node.init !== null && node.init !== undefined) typemap.vars_with_initializers.add(node.name);
        }
        if (!(node.type instanceof FuncDecl)) this.visit(node.type);
      }
      visit_Enum(node) {
        parse_enum(node, typemap);
      }
      visit_FuncDef(node) {
        if (node.decl.name !== null && node.decl.name !== undefined) typemap.var_types.set(node.decl.name, type_from_global_decl(node.decl));
      }
    }
    new Visitor().visit(ast);
  }
  void source_paths;
  return typemap;
}

export function set_decl_name(decl) {
  const name = decl.name;
  let type = type_of_var_decl(decl);
  while (!(type instanceof TypeDecl)) type = type.type;
  type.declname = name;
}

export function type_to_string(type, name = "") {
  if (type instanceof TypeDecl && (type.type instanceof ca.Struct || type.type instanceof ca.Union || type.type instanceof ca.Enum)) {
    let su;
    if (type.type instanceof ca.Struct) su = "struct";
    else su = type.type instanceof ca.Union ? "union" : "enum";
    if (type.type.name) return `${su} ${type.type.name}`;
    return `anon ${su}`;
  }
  const decl = new ca.Decl(name, [], [], [], [], [], deepcopy(type), null, null, null);
  set_decl_name(decl);
  return to_c(decl);
}

export function dump_typemap(typemap) {
  print("Variables:");
  for (const [v, type] of typemap.var_types) print(`${type_to_string(type, v)};`);
  print();
  print("Functions:");
  for (const [name, fn] of typemap.functions) print(`${type_to_string(fn.type, name)};`);
  print();
  print("Structs:");
  for (const [name_or_id, struct] of typemap.structs) {
    if (typeof name_or_id !== "string") continue;
    print(`${name_or_id}: size ${hex(struct.size)}, align ${struct.align}`);
    for (const [offset, fields] of struct.fields) {
      print(`  ${hex(offset)}:`, popts({ end: "" }));
      for (const field of fields) print(` ${field.name} (${type_to_string(field.type)})`, popts({ end: "" }));
      print();
    }
  }
  print();
  print("Enums:");
  for (const [name, value] of typemap.enum_values) print(`${name}: ${value}`);
  print();
}
