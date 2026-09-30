// Port of m2c/types.py
import { c_ast as ca } from "romdev-pycparser";
import { UndefinedStructError, is_unk_type, parse_constant_int, parse_function, parse_struct, primitive_size, resolve_typedefs, set_decl_name, to_c } from "./c_types.js";
import { CxxSymbol, CxxTerm } from "./demangle_codewarrior.js";
import { DecompFailure, assert_never } from "./error.js";
import { Formatter } from "./options.js";
import { bnot, compare, floordiv, format, pymod, pyassert, sorted } from "./py.js";

/** Mutable shared state for Types, maintaining the set of available struct types. */
export class TypePool {
  constructor({ unknown_field_prefix, unk_inference, union_field_overrides = new Map() }) {
    this.unknown_field_prefix = unknown_field_prefix;
    this.unk_inference = unk_inference;
    this.structs = new Set();
    this.structs_by_tag_name = new Map();
    this.structs_by_ctype = new Map();
    this.unknown_decls = new Map();
    this.warnings = [];
    this.union_field_overrides = union_field_overrides;
  }

  /** Return the StructDeclaration for a given ctype struct, if known */
  get_struct_for_ctype(ctype) {
    const struct = this.structs_by_ctype.get(ctype);
    if (struct !== undefined) return struct;
    if (ctype.name !== null && ctype.name !== undefined) return this.structs_by_tag_name.get(ctype.name) ?? null;
    return null;
  }

  get_or_create_struct_by_tag_name(tag_name, typemap, { size = null, with_typedef = false } = {}) {
    let struct = this.get_struct_by_tag_name(tag_name, typemap);
    if (struct !== null) return struct;
    struct = StructDeclaration.unknown(this, size, tag_name, 4);
    if (with_typedef) struct.typedef_name = tag_name;
    return struct;
  }

  get_struct_by_tag_name(tag_name, typemap) {
    const struct = this.structs_by_tag_name.get(tag_name);
    if (struct !== undefined) return struct;
    if (typemap !== null && typemap !== undefined) {
      const cstruct = typemap.structs.get(tag_name);
      if (cstruct !== undefined) {
        const type = Type.ctype(cstruct.type, typemap, this);
        return type.get_struct_declaration();
      }
    }
    return null;
  }

  /** Add the struct declaration to the set of known structs for later access */
  add_struct(struct, ctype_or_tag_name) {
    this.structs.add(struct);
    let tag_name;
    if (typeof ctype_or_tag_name === "string") tag_name = ctype_or_tag_name;
    else {
      const ctype = ctype_or_tag_name;
      tag_name = ctype.name ?? null;
      this.structs_by_ctype.set(ctype, struct);
    }
    if (tag_name !== null) {
      pyassert(!this.structs_by_tag_name.has(tag_name), `Duplicate tag: ${tag_name}`);
      this.structs_by_tag_name.set(tag_name, struct);
    }
  }

  format_type_declarations(fmt, stack_structs) {
    const decls = [];
    for (const struct of sorted(this.structs, (s) => s.tag_name || s.typedef_name || "")) {
      if (!stack_structs && struct.is_stack) continue;
      if (struct.fields.some((f) => !f.known) || struct.is_stack) decls.push(struct.format(fmt) + "\n");
    }
    return decls.join("\n");
  }

  /** Remove overlapping fields from all known structs */
  prune_structs() {
    for (const struct of this.structs) {
      struct.prune_overlapping_fields();
      struct.rename_inferred_vtables();
    }
  }
}

export class TypeData {
  static K_INT = 1 << 0;
  static K_PTR = 1 << 1;
  static K_FLOAT = 1 << 2;
  static K_FN = 1 << 3;
  static K_VOID = 1 << 4;
  static K_ARRAY = 1 << 5;
  static K_STRUCT = 1 << 6;
  static K_INTPTR = TypeData.K_INT | TypeData.K_PTR;
  static K_ANYREG = TypeData.K_INT | TypeData.K_PTR | TypeData.K_FLOAT;
  static K_ANY = TypeData.K_INT | TypeData.K_PTR | TypeData.K_FLOAT | TypeData.K_FN | TypeData.K_VOID | TypeData.K_ARRAY | TypeData.K_STRUCT;
  static SIGNED = 1;
  static UNSIGNED = 2;
  static ANY_SIGN = 3;

  constructor({
    kind = TypeData.K_ANY,
    likely_kind = TypeData.K_ANY,
    size_bits = null,
    uf_parent = null,
    sign = TypeData.ANY_SIGN,
    ptr_to = null,
    fn_sig = null,
    array_dim = null,
    struct = null,
    enum: enum_ = null,
    new_field_within = new Set(),
  } = {}) {
    this.kind = kind;
    this.likely_kind = likely_kind;
    this.size_bits = size_bits;
    this.uf_parent = uf_parent;
    this.sign = sign;
    this.ptr_to = ptr_to;
    this.fn_sig = fn_sig;
    this.array_dim = array_dim;
    this.struct = struct;
    this.enum = enum_;
    this.new_field_within = new_field_within;
    pyassert(this.kind);
    this.likely_kind &= this.kind;
  }

  get_representative() {
    const equivalent_typedatas = new Set();
    let root = this;
    while (root.uf_parent !== null) {
      pyassert(!equivalent_typedatas.has(root), "TypeData cycle detected");
      equivalent_typedatas.add(root);
      root = root.uf_parent;
    }
    for (const td of equivalent_typedatas) td.uf_parent = root;
    return root;
  }
}

const DEBUG_REPR_IDS = new Map();

/**
 * Type information for an expression, which may improve over time.
 */
export class Type {
  constructor(_data) {
    this._data = _data;
  }

  /** Try to set this type equal to another. Returns true on success. */
  unify(other, { seen = null } = {}) {
    const x = this.data();
    const y = other.data();
    if (x === y) return true;

    if (seen === null) seen = new Set([x, y]);
    else if (seen.has(x) || seen.has(y)) return false;
    else seen = new Set([...seen, x, y]);

    if (x.size_bits !== null && y.size_bits !== null && x.size_bits !== y.size_bits) return false;

    let kind = x.kind & y.kind;
    let likely_kind = x.likely_kind & y.likely_kind;
    let size_bits = x.size_bits !== null ? x.size_bits : y.size_bits;
    const ptr_to = x.ptr_to !== null ? x.ptr_to : y.ptr_to;
    const fn_sig = x.fn_sig !== null ? x.fn_sig : y.fn_sig;
    let array_dim = x.array_dim !== null ? x.array_dim : y.array_dim;
    const struct = x.struct !== null ? x.struct : y.struct;
    const enum_ = x.enum !== null ? x.enum : y.enum;
    const sign = x.sign & y.sign;
    if (![null, 32, 64].includes(size_bits)) kind &= ~TypeData.K_FLOAT;
    if (![null, 32].includes(size_bits)) kind &= ~TypeData.K_PTR;
    if (![null].includes(size_bits)) kind &= ~TypeData.K_FN;
    if (![null, 0].includes(size_bits)) kind &= ~TypeData.K_VOID;
    likely_kind &= kind;
    if (kind === 0 || sign === 0) return false;
    if (kind === TypeData.K_PTR) size_bits = 32;
    if (sign !== TypeData.ANY_SIGN) pyassert(kind & TypeData.K_INTPTR);
    if (enum_ !== null) pyassert(kind === TypeData.K_INT);
    if (x.ptr_to !== null && y.ptr_to !== null) {
      if (!x.ptr_to.unify(y.ptr_to, { seen })) return false;
    }
    if (x.fn_sig !== null && y.fn_sig !== null) {
      if (!x.fn_sig.unify(y.fn_sig, { seen })) return false;
    }
    if (x.array_dim !== null && y.array_dim !== null) {
      if (kind === TypeData.K_ARRAY) {
        if (x.array_dim !== y.array_dim) return false;
      } else {
        pyassert(kind === TypeData.K_PTR);
        if (x.array_dim !== y.array_dim) array_dim = 0;
      }
    }
    if (x.struct !== null && y.struct !== null) {
      if (!x.struct.unify(y.struct, { seen })) return false;
    }
    if (x.enum !== null && y.enum !== null) {
      if (x.enum !== y.enum) return false;
    }
    if (x.new_field_within.has(y.struct) || y.new_field_within.has(x.struct)) return false;
    x.kind = kind;
    x.likely_kind = likely_kind;
    x.size_bits = size_bits;
    x.sign = sign;
    x.ptr_to = ptr_to;
    x.fn_sig = fn_sig;
    x.array_dim = array_dim;
    x.struct = struct;
    x.enum = enum_;
    for (const s of y.new_field_within) x.new_field_within.add(s);
    y.uf_parent = x;
    return true;
  }

  data() {
    if (this._data.uf_parent === null) return this._data;
    this._data = this._data.get_representative();
    return this._data;
  }

  is_float() {
    return this.data().kind === TypeData.K_FLOAT;
  }
  is_likely_float() {
    const data = this.data();
    return data.kind === TypeData.K_FLOAT || data.likely_kind === TypeData.K_FLOAT;
  }
  is_pointer() {
    return this.data().kind === TypeData.K_PTR;
  }
  is_pointer_or_array() {
    const k = this.data().kind;
    return k === TypeData.K_PTR || k === TypeData.K_ARRAY;
  }
  is_int() {
    return this.data().kind === TypeData.K_INT;
  }
  is_reg() {
    return (this.data().kind & ~TypeData.K_ANYREG) === 0;
  }
  is_function() {
    return this.data().kind === TypeData.K_FN;
  }
  is_void() {
    return this.data().kind === TypeData.K_VOID;
  }
  is_array() {
    return this.data().kind === TypeData.K_ARRAY;
  }
  is_struct() {
    return this.data().kind === TypeData.K_STRUCT;
  }
  is_signed() {
    return this.data().sign === TypeData.SIGNED;
  }
  is_unsigned() {
    return this.data().sign === TypeData.UNSIGNED;
  }
  get_enum_name(value) {
    const data = this.data();
    if (data.enum === null) return null;
    return data.enum.names.get(value) ?? null;
  }
  get_size_bits() {
    return this.data().size_bits;
  }
  get_size_bytes() {
    const size_bits = this.get_size_bits();
    return size_bits === null ? null : floordiv(size_bits, 8);
  }

  /** Return the size & alignment of self when used as a function argument */
  get_parameter_size_align_bytes() {
    const data = this.data();
    if (this.is_struct()) {
      pyassert(data.struct !== null);
      if (data.struct.size === null) throw new DecompFailure(`Cannot use incomplete type ${this} as parameter`);
      return [data.struct.size, data.struct.align];
    }
    const size = floordiv(this.get_size_bits() || 32, 8);
    return [size, size];
  }

  /** If self is a pointer-to-a-Type, return the Type */
  get_pointer_target() {
    const data = this.data();
    if (this.is_pointer() && data.ptr_to !== null) return data.ptr_to;
    return null;
  }

  /** Return a pointer to self. If self is an array, decay the type to a pointer */
  reference() {
    if (this.is_array()) {
      const data = this.data();
      pyassert(data.ptr_to !== null);
      return Type.ptr(data.ptr_to, { array_dim: data.array_dim });
    }
    return Type.ptr(this);
  }

  /** If self is an array, return a pointer to the element type. Otherwise, return self. */
  decay() {
    if (this.is_array()) {
      const data = this.data();
      pyassert(data.ptr_to !== null);
      return Type.ptr(data.ptr_to, { array_dim: data.array_dim });
    }
    return this;
  }

  /** If self is an explicit `void *`, return `Type.ptr()` without an target type. */
  weaken_void_ptr() {
    const target = this.get_pointer_target();
    if (target !== null && target.is_void()) return Type.ptr();
    return this;
  }

  /** If self is an array, return [inner Type, array dimension] */
  get_array() {
    if (!this.is_array()) return [null, null];
    const data = this.data();
    pyassert(data.ptr_to !== null);
    return [data.ptr_to, data.array_dim];
  }

  /** If self is a function pointer, return the FunctionSignature */
  get_function_pointer_signature() {
    const data = this.data();
    if (this.is_pointer() && data.ptr_to !== null) {
      const ptr_to = data.ptr_to.data();
      if (ptr_to.kind === TypeData.K_FN) return ptr_to.fn_sig;
    }
    return null;
  }

  /** If self is a struct, return the StructDeclaration */
  get_struct_declaration() {
    if (this.is_struct()) {
      const data = this.data();
      pyassert(data.struct !== null);
      return data.struct;
    }
    return null;
  }

  clone_literal_type() {
    const data = this.data();
    const size_bits = data.size_bits === 64 ? 64 : null;
    return new Type(new TypeData({ kind: TypeData.K_ANYREG, likely_kind: data.likely_kind, size_bits }));
  }

  static _no_matching_field() {
    return [null, Type.any(), 0];
  }

  /**
   * Locate the field in self at the appropriate offset, and optionally with an exact
   * target size (both values in bytes). Returns [field_path, field_type, remaining_offset].
   */
  get_field(offset, { target_size, exact = true }) {
    if (offset < 0) return Type._no_matching_field();

    if (this.is_array()) {
      const data = this.data();
      pyassert(data.ptr_to !== null);
      const size = data.ptr_to.get_size_bytes();
      pyassert(size !== null);
      const index = floordiv(offset, size);
      const remaining_offset = pymod(offset, size);
      if (data.array_dim !== null && index >= data.array_dim) return Type._no_matching_field();
      pyassert(index >= 0 && remaining_offset >= 0);
      const [subpath, subtype, sub_remaining_offset] = data.ptr_to.get_field(remaining_offset, { target_size, exact });
      if (subpath !== null) {
        subpath.unshift(index);
        return [subpath, subtype, sub_remaining_offset];
      }
      return Type._no_matching_field();
    }

    if (this.is_struct()) {
      const data = this.data();
      pyassert(data.struct !== null);
      if (data.struct.size !== null && offset >= data.struct.size) return Type._no_matching_field();

      let possible_fields = data.struct.fields_containing_offset(offset);
      if (!possible_fields.length && data.struct.has_bitfields) return Type._no_matching_field();

      const possible_results = [];
      if (!data.struct.is_stack && (target_size === null || target_size === this.get_size_bytes())) possible_results.push([[], this, offset]);

      if (data.struct.is_union && data.struct.preferred_union_field) {
        possible_fields = possible_fields.filter((field) => field.name === data.struct.preferred_union_field);
      }

      for (const field of possible_fields) {
        const inner_offset_bits = offset - field.offset;
        const [subpath, subtype, sub_remaining_offset] = field.type.get_field(inner_offset_bits, { target_size, exact });
        if (subpath === null) continue;
        subpath.unshift(field.name);
        possible_results.push([subpath, subtype, sub_remaining_offset]);
        if (target_size !== null && target_size === subtype.get_size_bytes() && sub_remaining_offset === 0) return possible_results[possible_results.length - 1];
      }

      const zero_offset_results = possible_results.filter((r) => r[2] === 0);
      if (zero_offset_results.length) return zero_offset_results[0];
      else if (exact) {
        const field_type = Type.any_field({ new_within: data.struct });
        const field_name = `${data.struct.new_field_prefix}${format(offset, "X")}`;
        const new_field = data.struct.try_add_field(field_type, offset, field_name, target_size);
        if (new_field !== null) return [[field_name], field_type, 0];
      } else if (possible_results.length) return possible_results[0];
    }

    if ((target_size === null || target_size === this.get_size_bytes()) && offset === 0) return [[], this, offset];

    return Type._no_matching_field();
  }

  /** Similar to `.get_field()`, but treat self as a pointer and find the field in the pointer's target. */
  get_deref_field(offset, { target_size, exact = true }) {
    const target = this.get_pointer_target();
    if (target === null) return Type._no_matching_field();

    const size = target.get_size_bytes();
    let array_index;
    if (size !== null && size !== 0) {
      array_index = floordiv(offset, size);
      offset = pymod(offset, size);
    } else array_index = 0;

    if (array_index !== 0) {
      const known_array_size = this.data().array_dim;
      if (known_array_size === null || array_index < 0 || array_index >= known_array_size) return Type._no_matching_field();
    }

    const [field_path, field_type, remaining_offset] = target.get_field(offset, { target_size, exact });
    if (field_path !== null) field_path.unshift(array_index);
    return [field_path, field_type, remaining_offset];
  }

  /**
   * If self is a struct or array, return a list of fields suitable for creating an
   * initializer; padding is represented by an int.
   */
  get_initializer_fields() {
    const data = this.data();
    if (this.is_array()) {
      pyassert(data.ptr_to !== null);
      if (data.array_dim === null) return null;
      return new Array(Math.max(0, data.array_dim)).fill(data.ptr_to);
    }
    if (this.is_struct()) {
      pyassert(data.struct !== null);
      if (data.struct.has_bitfields) return null;
      const output = [];
      let position = 0;
      const add_padding = (upto) => {
        pyassert(upto >= position);
        if (upto > position) output.push(upto - position);
      };
      for (const field of data.struct.fields) {
        if (field.offset < position) return null;
        add_padding(field.offset);
        const field_size = field.type.get_size_bytes();
        if (field_size === null) return null;
        output.push(field.type);
        position = field.offset + field_size;
        if (data.struct.is_union) break;
      }
      if (data.struct.size !== null && position > data.struct.size) return null;
      add_padding(data.struct.min_size());
      return output;
    }
    return null;
  }

  to_decl(name, fmt) {
    const decl = new ca.Decl(name, [], [], [], [], [], this._to_ctype(new Set(), fmt), null, null, null);
    set_decl_name(decl);
    let ret = to_c(decl);
    if (fmt.coding_style.pointer_style_left) {
      for (;;) {
        const replaced = ret.replaceAll(" *", "* ").replaceAll("* )", "*)").replaceAll("* ,", "*,");
        if (replaced === ret) break;
        ret = replaced;
      }
    }
    return ret;
  }

  _to_ctype(seen, fmt) {
    const simple_ctype = (typename) => new ca.TypeDecl(null, [], [], new ca.IdentifierType([typename]));
    const unk_symbol = fmt.valid_syntax ? "M2C_UNK" : "?";

    const data = this.data();
    if (seen.has(data)) return simple_ctype(unk_symbol);
    seen.add(data);
    const size_bits = data.size_bits || 32;
    const sign = data.sign & TypeData.SIGNED ? "s" : "u";

    if (data.enum !== null && data.enum.tag !== null && data.enum.tag !== undefined) {
      pyassert(data.kind === TypeData.K_INT);
      return new ca.TypeDecl(null, [], [], new ca.Enum(data.enum.tag, [], null));
    }

    const lk = data.likely_kind & (TypeData.K_INT | TypeData.K_FLOAT);
    if ((data.kind & TypeData.K_ANYREG) === TypeData.K_ANYREG && lk !== TypeData.K_INT && lk !== TypeData.K_FLOAT) {
      if (data.size_bits !== null) return simple_ctype(`${unk_symbol}${size_bits}`);
      return simple_ctype(unk_symbol);
    }

    if (data.kind === TypeData.K_FLOAT || (data.likely_kind & (TypeData.K_FLOAT | TypeData.K_INT)) === TypeData.K_FLOAT) return simple_ctype(`f${size_bits}`);

    if (data.kind === TypeData.K_PTR) {
      let target_ctype;
      if (data.ptr_to === null) target_ctype = simple_ctype("void");
      else target_ctype = data.ptr_to._to_ctype(new Set(seen), fmt);
      if (target_ctype instanceof ca.FuncDecl && target_ctype.args) {
        for (const arg of target_ctype.args.params) {
          if (arg instanceof ca.Decl) {
            arg.name = null;
            set_decl_name(arg);
          }
        }
      }
      return new ca.PtrDecl([], target_ctype);
    }

    if (data.kind === TypeData.K_FN) {
      pyassert(data.fn_sig !== null);
      const return_ctype = data.fn_sig.return_type._to_ctype(new Set(seen), fmt);
      const params = [];
      for (const param of data.fn_sig.params) {
        const decl = new ca.Decl(param.name, [], [], [], [], [], param.type._to_ctype(new Set(seen), fmt), null, null, null);
        set_decl_name(decl);
        params.push(decl);
      }
      if (data.fn_sig.is_variadic) params.push(new ca.EllipsisParam());
      return new ca.FuncDecl(new ca.ParamList(params), return_ctype);
    }

    if (data.kind === TypeData.K_VOID) return simple_ctype("void");

    if (data.kind === TypeData.K_ARRAY) {
      pyassert(data.ptr_to !== null);
      let dim = null;
      if (data.array_dim !== null) dim = new ca.Constant("", fmt.format_int(data.array_dim));
      return new ca.ArrayDecl(data.ptr_to._to_ctype(new Set(seen), fmt), dim, []);
    }

    if (data.kind === TypeData.K_STRUCT) {
      pyassert(data.struct !== null);
      if (data.struct.typedef_name) return simple_ctype(data.struct.typedef_name);
      const name = data.struct.tag_name || "_anonymous";
      const type = data.struct.is_union ? new ca.Union(name, [], null) : new ca.Struct(name, [], null);
      return new ca.TypeDecl(name, [], [], type);
    }

    return simple_ctype(`${sign}${size_bits}`);
  }

  format(fmt) {
    return this.to_decl("", fmt);
  }
  toString() {
    return this.format(new Formatter({ debug: true }));
  }
  __repr__() {
    const data = this.data();
    const signstr = (data.sign & TypeData.SIGNED ? "+" : "") + (data.sign & TypeData.UNSIGNED ? "-" : "");
    const kindstr =
      (data.kind & TypeData.K_INT ? "I" : "") +
      (data.kind & TypeData.K_PTR ? "P" : "") +
      (data.kind & TypeData.K_FLOAT ? "F" : "") +
      (data.kind & TypeData.K_FN ? "N" : "") +
      (data.kind & TypeData.K_VOID ? "V" : "") +
      (data.kind & TypeData.K_ARRAY ? "A" : "") +
      (data.kind & TypeData.K_STRUCT ? "S" : "");
    const sizestr = data.size_bits !== null ? String(data.size_bits) : "?";
    if (!DEBUG_REPR_IDS.has(data)) DEBUG_REPR_IDS.set(data, DEBUG_REPR_IDS.size);
    return `Type(${signstr + kindstr + sizestr})@${DEBUG_REPR_IDS.get(data)}`;
  }

  static any() {
    return new Type(new TypeData());
  }
  static any_reg() {
    return new Type(new TypeData({ kind: TypeData.K_ANYREG }));
  }
  static any_field({ new_within = null } = {}) {
    return new Type(new TypeData({ kind: TypeData.K_ANY & ~TypeData.K_VOID, new_field_within: new_within ? new Set([new_within]) : new Set() }));
  }
  static intish() {
    return new Type(new TypeData({ kind: TypeData.K_INT }));
  }
  static uintish() {
    return new Type(new TypeData({ kind: TypeData.K_INT, sign: TypeData.UNSIGNED }));
  }
  static sintish() {
    return new Type(new TypeData({ kind: TypeData.K_INT, sign: TypeData.SIGNED }));
  }
  static intptr() {
    return new Type(new TypeData({ kind: TypeData.K_INTPTR }));
  }
  static uintptr() {
    return new Type(new TypeData({ kind: TypeData.K_INTPTR, sign: TypeData.UNSIGNED }));
  }
  static sintptr() {
    return new Type(new TypeData({ kind: TypeData.K_INTPTR, sign: TypeData.SIGNED }));
  }
  static ptr(type = null, { array_dim = null } = {}) {
    return new Type(new TypeData({ kind: TypeData.K_PTR, size_bits: 32, array_dim, ptr_to: type }));
  }
  static function(fn_sig = null) {
    if (fn_sig === null) fn_sig = new FunctionSignature();
    return new Type(new TypeData({ kind: TypeData.K_FN, fn_sig }));
  }
  static f32() {
    return new Type(new TypeData({ kind: TypeData.K_FLOAT, size_bits: 32 }));
  }
  static floatish() {
    return new Type(new TypeData({ kind: TypeData.K_FLOAT }));
  }
  static f64() {
    return new Type(new TypeData({ kind: TypeData.K_FLOAT, size_bits: 64 }));
  }
  static f128() {
    return new Type(new TypeData({ kind: TypeData.K_FLOAT, size_bits: 128 }));
  }
  static s8() {
    return new Type(new TypeData({ kind: TypeData.K_INT, size_bits: 8, sign: TypeData.SIGNED }));
  }
  static u8() {
    return new Type(new TypeData({ kind: TypeData.K_INT, size_bits: 8, sign: TypeData.UNSIGNED }));
  }
  static s16() {
    return new Type(new TypeData({ kind: TypeData.K_INT, size_bits: 16, sign: TypeData.SIGNED }));
  }
  static u16() {
    return new Type(new TypeData({ kind: TypeData.K_INT, size_bits: 16, sign: TypeData.UNSIGNED }));
  }
  static s32() {
    return new Type(new TypeData({ kind: TypeData.K_INT, size_bits: 32, sign: TypeData.SIGNED }));
  }
  static u32() {
    return new Type(new TypeData({ kind: TypeData.K_INT, size_bits: 32, sign: TypeData.UNSIGNED }));
  }
  static s64() {
    return new Type(new TypeData({ kind: TypeData.K_INT, size_bits: 64, sign: TypeData.SIGNED }));
  }
  static u64() {
    return new Type(new TypeData({ kind: TypeData.K_INT, size_bits: 64, sign: TypeData.UNSIGNED }));
  }
  static int64() {
    return new Type(new TypeData({ kind: TypeData.K_INT, size_bits: 64 }));
  }
  static int_of_size(size_bits) {
    return new Type(new TypeData({ kind: TypeData.K_INT, size_bits }));
  }
  static reg32({ likely_float }) {
    const likely = likely_float ? TypeData.K_FLOAT : TypeData.K_INTPTR;
    return new Type(new TypeData({ kind: TypeData.K_ANYREG, likely_kind: likely, size_bits: 32 }));
  }
  static reg64({ likely_float }) {
    const kind = TypeData.K_FLOAT | TypeData.K_INT;
    const likely = likely_float ? TypeData.K_FLOAT : TypeData.K_INT;
    return new Type(new TypeData({ kind, likely_kind: likely, size_bits: 64 }));
  }
  static reg128() {
    return new Type(new TypeData({ kind: TypeData.K_INT, size_bits: 128 }));
  }
  static boolean() {
    return Type.intish();
  }
  static void() {
    return new Type(new TypeData({ kind: TypeData.K_VOID, size_bits: 0 }));
  }
  static array(type, dim) {
    const el_size = type.get_size_bits();
    pyassert(el_size !== null);
    const size_bits = dim === null ? null : el_size * dim;
    return new Type(new TypeData({ kind: TypeData.K_ARRAY, size_bits, ptr_to: type, array_dim: dim }));
  }
  static struct(st) {
    const size_bits = st.size !== null ? st.size * 8 : null;
    return new Type(new TypeData({ kind: TypeData.K_STRUCT, size_bits, struct: st }));
  }

  static gsym_unk_ctype(ctype, typemap, typepool) {
    const [real_ctype] = resolve_typedefs(ctype, typemap);
    let type = Type.any();
    if (real_ctype instanceof ca.TypeDecl && real_ctype.type instanceof ca.IdentifierType) {
      const size_bits = primitive_size(real_ctype.type) * 8;
      if (size_bits < 32) type = Type.int_of_size(size_bits);
    }
    if (ctype instanceof ca.TypeDecl && ctype.declname) {
      if (typepool.unknown_decls.has(ctype.declname)) return typepool.unknown_decls.get(ctype.declname);
      typepool.unknown_decls.set(ctype.declname, type);
    }
    return type;
  }

  static ctype(ctype, typemap, typepool, { in_struct = false } = {}) {
    const [real_ctype] = resolve_typedefs(ctype, typemap);

    if (real_ctype instanceof ca.ArrayDecl) {
      let dim = null;
      try {
        if (real_ctype.dim !== null && real_ctype.dim !== undefined) dim = parse_constant_int(real_ctype.dim, typemap);
        else if (in_struct) dim = 1;
      } catch (e) {
        if (!(e instanceof DecompFailure)) throw e;
      }
      const elem_type = Type.ctype(real_ctype.type, typemap, typepool);
      return Type.array(elem_type, dim);
    }
    if (real_ctype instanceof ca.PtrDecl) return Type.ptr(Type.ctype(real_ctype.type, typemap, typepool));
    if (real_ctype instanceof ca.FuncDecl) {
      const fn = parse_function(real_ctype);
      pyassert(fn !== null);
      const fn_sig = new FunctionSignature({ return_type: Type.void(), is_variadic: fn.is_variadic });
      if (fn.ret_type !== null) fn_sig.return_type = Type.ctype(fn.ret_type, typemap, typepool);
      if (fn.params !== null) {
        fn_sig.params = fn.params.map((param) => new FunctionParam({ name: param.name || "", type: Type.ctype(param.type, typemap, typepool) }));
        fn_sig.params_known = true;
      }
      return Type.function(fn_sig);
    }
    if (real_ctype instanceof ca.TypeDecl) {
      const inner_type = real_ctype.type;
      if (inner_type instanceof ca.Struct || inner_type instanceof ca.Union) return Type.struct(StructDeclaration.from_ctype(inner_type, typemap, typepool));
      if (inner_type instanceof ca.Enum) {
        let enum_ = null;
        if (inner_type.name !== null && inner_type.name !== undefined) enum_ = typemap.enums.get(inner_type.name) ?? null;
        if (enum_ === null) enum_ = typemap.enums.get(inner_type) ?? null;
        return new Type(new TypeData({ kind: TypeData.K_INT, size_bits: 32, sign: TypeData.SIGNED, enum: enum_ }));
      }
      pyassert(!(inner_type instanceof ca.Typeof), "handled by resolve_typedefs");
      const names = inner_type.names;
      if (names.includes("double")) return Type.f64();
      if (names.includes("float")) return Type.f32();
      if (names.includes("void")) return Type.void();
      const size_bits = 8 * primitive_size(inner_type);
      pyassert(size_bits > 0);
      const sign = names.includes("unsigned") ? TypeData.UNSIGNED : TypeData.SIGNED;
      return new Type(new TypeData({ kind: TypeData.K_INT, size_bits, sign }));
    }
    assert_never(real_ctype);
  }

  static demangled_symbol(typemap, typepool, sym) {
    return Type.demangled_type(typemap, typepool, sym.type, sym.name);
  }

  static demangled_type(typemap, typepool, sym_type, sym_name = null) {
    const type_for_class = (qualified_name) => {
      const class_name = qualified_name.map((n) => String(n)).join("::");
      const class_struct = typepool.get_or_create_struct_by_tag_name(class_name, typemap, { size: null, with_typedef: true });
      return Type.struct(class_struct);
    };

    let final_name = null;
    if (sym_name !== null && sym_name !== undefined) {
      pyassert(sym_name.kind === CxxTerm.Kind.QUALIFIED);
      pyassert(sym_name.qualified_name !== null && sym_name.qualified_name !== undefined);
      pyassert(sym_name.qualified_name.length >= 1);
      const parts = String(sym_name.qualified_name[sym_name.qualified_name.length - 1]).split("@");
      final_name = parts[parts.length - 1];
    }

    if (final_name === "__vt") return Type.any();
    if (final_name === "__RTTI") return Type.struct(typepool.get_or_create_struct_by_tag_name("RTTI", typemap, { size: 8 }));

    let type = Type.any();
    const K = CxxTerm.Kind;
    for (const term of [...sym_type.terms].reverse()) {
      if (term.kind === K.CONST) {
        // pass
      } else if (term.kind === K.POINTER || term.kind === K.REFERENCE) type = Type.ptr(type);
      else if (term.kind === K.BOOL) type = Type.boolean();
      else if (term.kind === K.CHAR) type = Type.int_of_size(8);
      else if (term.kind === K.SHORT || term.kind === K.WIDE_CHAR) type = Type.int_of_size(16);
      else if (term.kind === K.INT || term.kind === K.LONG) type = Type.int_of_size(32);
      else if (term.kind === K.LONG_LONG) type = Type.int_of_size(64);
      else if (term.kind === K.FLOAT) type = Type.f32();
      else if (term.kind === K.DOUBLE) type = Type.f64();
      else if (term.kind === K.LONG_DOUBLE) type = Type.f128();
      else if (term.kind === K.SIGNED) type.unify(new Type(new TypeData({ kind: TypeData.K_INT, sign: TypeData.SIGNED })));
      else if (term.kind === K.UNSIGNED) type.unify(new Type(new TypeData({ kind: TypeData.K_INT, sign: TypeData.UNSIGNED })));
      else if (term.kind === K.ARRAY) {
        pyassert(term.array_dim !== null && term.array_dim !== undefined, "array CxxTerms must have array_dim");
        type = Type.array(type, term.array_dim);
      } else if (term.kind === K.FUNCTION) {
        pyassert(term.function_params !== null && term.function_params !== undefined);
        const params = [];
        if (sym_name !== null && sym_name !== undefined && sym_name.qualified_name !== null && sym_name.qualified_name !== undefined && sym_name.qualified_name.length > 1 && !CxxSymbol.STATIC_FUNCTIONS.has(final_name)) {
          const class_type = type_for_class(sym_name.qualified_name.slice(0, -1));
          params.push(new FunctionParam({ type: Type.ptr(class_type), name: "this" }));
        }
        if (final_name === "__dt") params.push(new FunctionParam({ type: Type.s16(), name: "destroyFlag" }));
        let is_variadic = false;
        term.function_params.forEach((param_type, i) => {
          const name = `arg${i}`;
          if (param_type.terms[0].kind === K.VOID) pyassert(term.function_params.length === 1);
          else if (param_type.terms[0].kind === K.ELLIPSIS) {
            pyassert(i === term.function_params.length - 1);
            is_variadic = true;
          } else params.push(new FunctionParam({ type: Type.demangled_type(typemap, typepool, param_type), name }));
        });
        let return_type = Type.any();
        if (term.function_return !== null && term.function_return !== undefined) return_type = Type.demangled_type(typemap, typepool, term.function_return);
        else if (final_name === "__ct" || final_name === "__dt") return_type = Type.ptr();
        type = Type.function(new FunctionSignature({ params, params_known: true, is_variadic, return_type }));
      } else if (term.kind === K.QUALIFIED) {
        pyassert(term.qualified_name !== null && term.qualified_name !== undefined);
        type = type_for_class(term.qualified_name);
      } else if (term.kind === K.VOID) type = Type.void();
      else if (term.kind === K.ELLIPSIS) pyassert(false, String(term.kind));
      else pyassert(false, String(term.kind));
    }
    return type;
  }
}

export class FunctionParam {
  constructor({ type = Type.any(), name = "" } = {}) {
    this.type = type;
    this.name = name;
  }
}

export class FunctionSignature {
  constructor({ return_type = Type.any(), params = [], params_known = false, is_variadic = false } = {}) {
    this.return_type = return_type;
    this.params = params;
    this.params_known = params_known;
    this.is_variadic = is_variadic;
  }

  unify(other, { seen }) {
    if (this.params_known && other.params_known) {
      if (this.is_variadic !== other.is_variadic) return false;
      if (this.params.length !== other.params.length) return false;
    }
    let can_unify = this.return_type.unify(other.return_type, { seen });
    const n = Math.min(this.params.length, other.params.length);
    for (let i = 0; i < n; i++) can_unify = this.params[i].type.unify(other.params[i].type, { seen }) && can_unify;
    if (!can_unify) return false;

    if (!this.params_known) {
      this.is_variadic = this.is_variadic || other.is_variadic;
      this.params_known = this.params_known || other.params_known;
      while (other.params.length > this.params.length) this.params.push(other.params[this.params.length]);
    }
    if (!other.params_known) {
      other.is_variadic = other.is_variadic || this.is_variadic;
      other.params_known = other.params_known || this.params_known;
      while (this.params.length > other.params.length) other.params.push(this.params[other.params.length]);
    }

    const m = Math.min(this.params.length, other.params.length);
    for (let i = 0; i < m; i++) {
      const x = this.params[i];
      const y = other.params[i];
      if (!x.name && y.name) x.name = y.name;
      else if (!y.name && x.name) y.name = x.name;
    }
    return true;
  }

  /** Unify a function's signature with a list of argument types (at a callsite). */
  unify_with_args(concrete) {
    if (this.params.length > concrete.params.length) return false;
    if (!this.is_variadic && this.params.length !== concrete.params.length) return false;
    let can_unify = true;
    const n = Math.min(this.params.length, concrete.params.length);
    for (let i = 0; i < n; i++) can_unify = this.params[i].type.unify(concrete.params[i].type) && can_unify;
    return can_unify;
  }
}

class StructField {
  constructor({ type, offset, name, known }) {
    this.type = type;
    this.offset = offset;
    this.name = name;
    this.known = known;
  }
}

class BitField {
  constructor({ bit_offset, bit_width, name }) {
    this.bit_offset = bit_offset;
    this.bit_width = bit_width;
    this.name = name;
  }
}

/** Representation of a C struct or union */
export class StructDeclaration {
  static StructField = StructField;
  static BitField = BitField;

  constructor({
    size,
    align,
    new_field_prefix,
    tag_name = null,
    typedef_name = null,
    fields = [],
    bitfields = [],
    has_bitfields = false,
    is_union = false,
    is_stack = false,
    preferred_union_field = null,
  }) {
    this.size = size;
    this.align = align;
    this.new_field_prefix = new_field_prefix;
    this.tag_name = tag_name;
    this.typedef_name = typedef_name;
    this.fields = fields; // sorted by `.offset`
    this.bitfields = bitfields; // sorted by `.bit_offset`
    this.has_bitfields = has_bitfields;
    this.is_union = is_union;
    this.is_stack = is_stack;
    this.preferred_union_field = preferred_union_field;
  }

  StructField(f) {
    return new StructField(f);
  }

  min_size() {
    if (this.size !== null) return this.size;
    let m = 0;
    for (const field of this.fields) m = Math.max(m, field.offset + (field.type.get_size_bytes() || 1));
    return m;
  }

  unify(other, { seen = null } = {}) {
    void seen;
    return this === other;
  }

  /** Return the list of StructFields which contain the given offset (in bytes) */
  fields_containing_offset(offset) {
    const fields = [];
    for (const field of this.fields) {
      if (field.offset > offset) break;
      const field_size = field.type.get_size_bytes() || 1;
      if (field.offset + field_size <= offset) continue;
      fields.push(field);
    }
    return fields;
  }

  /** Try to add a field into the struct, and return it if successful. */
  try_add_field(type, offset, name, size) {
    if (this.is_union) return null;
    if (this.size !== null && !(0 <= offset && offset < this.size)) return null;
    size = size || 1;
    for (const field of this.fields) {
      const field_size = field.type.get_size_bytes() || 1;
      if (offset <= field.offset && field.offset < offset + size) return null;
      if (field.offset <= offset && offset < field.offset + field_size) return null;
    }
    const field = new StructField({ type, offset, name, known: false });
    this.fields.push(field);
    this.fields = sorted(this.fields, (f) => f.offset);
    return field;
  }

  /** Remove overlapping fields with `known=False` from the struct */
  prune_overlapping_fields() {
    if (this.is_union) return null;
    this.fields = sorted(this.fields, (f) => [f.offset, -(f.type.get_size_bytes() || 0)]);

    let end_pseudofield;
    if (this.size !== null) end_pseudofield = [new StructField({ offset: this.size, type: Type.void(), known: true, name: "" })];
    else end_pseudofield = [];

    const fields_to_remove = new Set();
    this.fields.forEach((field, i) => {
      if (field.known || fields_to_remove.has(field)) return;
      const field_size = field.type.get_size_bytes() || 1;
      let conflicting_fields = [];
      for (const f2 of [...this.fields.slice(i + 1), ...end_pseudofield]) {
        pyassert(f2.offset >= field.offset);
        if (f2.offset >= field.offset + field_size) break;
        if (fields_to_remove.has(f2)) continue;
        let offset = f2.offset - field.offset;
        const [sub_path, sub_type] = field.type.get_field(offset, { target_size: f2.type.get_size_bytes() });
        if (sub_path !== null && sub_type.unify(f2.type)) {
          conflicting_fields.push(f2);
        } else if (!f2.known && f2.type.is_int() && field.type.is_int()) {
          // pass
        } else {
          if (conflicting_fields.length) {
            offset = conflicting_fields[0].offset - field.offset;
            conflicting_fields = [];
          }
          if (offset === 0) conflicting_fields = [field];
          if (offset >= 4) field.type = Type.any_reg();
          else field.type = Type.int_of_size(offset * 8);
          break;
        }
      }
      for (const f of conflicting_fields) fields_to_remove.add(f);
    });
    this.fields = this.fields.filter((f) => !fields_to_remove.has(f));
  }

  /** Rename inferred fields that are pointers to vtables */
  rename_inferred_vtables() {
    const sep = this.new_field_prefix.endsWith("_") ? "_" : "";
    for (const field of this.fields) {
      if (field.known || !field.name.startsWith(this.new_field_prefix)) continue;
      const type_ptr = field.type.get_pointer_target();
      if (type_ptr === null) continue;
      const struct = type_ptr.get_struct_declaration();
      if (struct === null || struct.tag_name === null) continue;
      if (struct.tag_name.startsWith("__vt__")) {
        const name = field.name.replace(this.new_field_prefix, `vtable${sep}`);
        if (!this.fields.some((f) => f.name === name)) field.name = name;
      }
    }
  }

  /** Return the C representation of the struct/union. */
  format(fmt) {
    const keyword = this.is_union ? "union" : "struct";
    const decl = this.tag_name ? `${keyword} ${this.tag_name}` : `${keyword}`;
    const head = this.typedef_name ? `typedef ${decl} {` : `${decl} {`;
    const tail = this.typedef_name ? `} ${this.typedef_name};` : "};";

    if (this.size === 0 && !this.fields.length) return fmt.with_comments(head + tail, ["size 0x0"]);

    const lines = [];
    lines.push(fmt.indent(head));
    let position = 0;
    fmt.indented(() => {
      const offset_str_digits = fmt.format_hex(this.min_size()).length;
      const offset_comment = (offset) => `/* 0x${fmt.format_hex(offset).padStart(offset_str_digits, "0")} */`;
      let prev_field = null;

      const pad_to = (offset, is_final) => {
        if (position < offset) {
          const underscore = fmt.coding_style.unknown_underscore ? "_" : "";
          const name = `pad${underscore}${fmt.format_hex(position)}`;
          const padding_size = offset - position;
          const comments = [];
          if (prev_field !== null && !(is_final && this.is_stack)) {
            const last_size = prev_field.type.get_size_bytes();
            if (last_size && padding_size > last_size) {
              const array_dim_str = fmt.format_int(floordiv(padding_size, last_size) + 1);
              comments.push(`maybe part of ${prev_field.name}[${array_dim_str}]?`);
            }
          }
          lines.push(fmt.with_comments(`${offset_comment(position)} char ${name}[${fmt.format_int(padding_size)}];`, comments));
          position = offset;
        }
      };

      for (const field of this.fields) {
        pad_to(field.offset, false);
        const field_decl = `${offset_comment(field.offset)} ${field.type.to_decl(field.name, fmt)};`;
        const comments = [];
        if (!this.is_union && position > field.offset) comments.push("overlap");
        if (this.is_union && field.offset !== 0) comments.push("offset");
        if (!field.known) comments.push("inferred");
        lines.push(fmt.with_comments(field_decl, comments));
        const s = field.type.get_struct_declaration();
        if (s !== null) field.type.unify(Type.struct(s));
        position = Math.max(position, field.offset + (field.type.get_size_bytes() || 0));
        prev_field = field;
      }
      pad_to(this.min_size(), true);
    });
    const cmp = this.size === null ? ">=" : "=";
    lines.push(fmt.with_comments(tail, [`size ${cmp} 0x${fmt.format_hex(position)}`]));
    return lines.join("\n");
  }

  /** Return an StructDeclaration without any known fields */
  static unknown(typepool, size, tag_name, align = 1) {
    const preferred_field = typepool.union_field_overrides.get(tag_name) ?? null;
    const decl = new StructDeclaration({ size, align, tag_name, new_field_prefix: typepool.unknown_field_prefix, preferred_union_field: preferred_field });
    typepool.add_struct(decl, tag_name);
    return decl;
  }

  /** Return StructDeclaration for a given ctype struct or union, registering it if needed. */
  static from_ctype(ctype, typemap, typepool) {
    const existing_struct = typepool.get_struct_for_ctype(ctype);
    if (existing_struct) return existing_struct;

    let typedef_name = null;
    if (typemap.struct_typedefs.has(ctype)) {
      const typedef = typemap.struct_typedefs.get(ctype);
      pyassert(typedef.type instanceof ca.IdentifierType);
      typedef_name = typedef.type.names[0];
    } else if (ctype.name && typemap.struct_typedefs.has(ctype.name)) {
      const typedef = typemap.struct_typedefs.get(ctype.name);
      pyassert(typedef.type instanceof ca.IdentifierType);
      typedef_name = typedef.type.names[0];
    }

    let struct_fields, struct_bitfields, struct_has_bitfields, struct_size, struct_align;
    try {
      const struct = parse_struct(ctype, typemap);
      struct_fields = struct.fields;
      struct_bitfields = struct.bitfields;
      struct_has_bitfields = struct.has_bitfields;
      struct_size = struct.size;
      struct_align = struct.align;
    } catch (e) {
      if (!(e instanceof UndefinedStructError)) throw e;
      struct_fields = new Map();
      struct_bitfields = new Map();
      struct_has_bitfields = false;
      struct_size = 0;
      struct_align = 1;
      typepool.warnings.push(`Warning: struct ${typedef_name || ctype.name || "None"} is not defined (only forward-declared)`);
    }

    pyassert(pymod(struct_size, struct_align) === 0, "struct size must be a multiple of its alignment");

    const struct_name = typedef_name || ctype.name;
    const preferred_field = struct_name ? (typepool.union_field_overrides.get(struct_name) ?? null) : null;

    const decl = new StructDeclaration({
      size: struct_size,
      align: struct_align,
      tag_name: ctype.name ?? null,
      typedef_name,
      fields: [],
      bitfields: [],
      has_bitfields: struct_has_bitfields,
      is_union: ctype instanceof ca.Union,
      new_field_prefix: typepool.unknown_field_prefix,
      preferred_union_field: preferred_field,
    });
    typepool.add_struct(decl, ctype);

    for (const [bit_offset, bit_fields] of sorted(struct_bitfields.entries(), (e) => e[0])) {
      for (const bit_field of bit_fields) decl.bitfields.push(new BitField({ bit_offset, bit_width: bit_field.width, name: bit_field.name }));
    }

    for (const [offset, fields] of sorted(struct_fields.entries(), (e) => e[0])) {
      for (const field of fields) {
        if (typepool.unk_inference && is_unk_type(field.type, typemap)) continue;
        const field_type = Type.ctype(field.type, typemap, typepool, { in_struct: true });
        pyassert(field.size === field_type.get_size_bytes(), `(${field.size}, ${field_type.get_size_bytes()}, '${field.name}', ${field_type})`);
        decl.fields.push(new StructField({ type: field_type, offset, name: field.name, known: true }));
      }
    }
    for (let i = 1; i < decl.fields.length; i++) pyassert(decl.fields[i - 1].offset <= decl.fields[i].offset);
    return decl;
  }
}

export { compare, bnot, to_c };
