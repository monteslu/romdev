// c_parser.js - CParser, a port of pycparser's c_parser.py (the m2c /
// decomp-permuter fork with GCC extensions) and plyparser.py.
//
// The grammar actions below are the p_* methods of the upstream CParser, one
// for one, keyed by the function names the LALR tables (tables/yacctab.json)
// refer to. Parameterized rules (p_xxx_declarator with xxx in id / typeid /
// typeid_noparen) are expanded the way plyparser.template does.
import yacctab from "./tables/yacctab.json" with { type: "json" };
import * as c_ast from "./c_ast.js";
import { CLexer } from "./c_lexer.js";
import { LRParser } from "./ply_yacc.js";
import { fix_switch_cases, fix_atomic_specifiers } from "./ast_transforms.js";

/** Coordinates of a syntactic element (plyparser.Coord). */
export class Coord {
  constructor(file, line, lexdata, lexpos) {
    this.file = file;
    this.line = line;
    this.lexdata = lexdata;
    this.lexpos = lexpos;
  }

  get column() {
    return this.lexpos - rfindNewline(this.lexdata, this.lexpos);
  }

  source_line() {
    const start = this.lexpos - this.column + 1;
    let end = this.lexdata.indexOf("\n", start);
    if (end === -1) end = this.lexdata.length;
    return this.lexdata.slice(start, end).replace(/\r+$/, "");
  }

  toString() { return `${this.file}:${this.line}:${this.column}`; }
}

export class ParseError extends Error {
  constructor(message, coord) {
    super(message);
    this.name = "ParseError";
    this.coord = coord;
  }
}

const S = (x) => (x == null ? "None" : String(x));

// Python rfind(sub, 0, end) searches s[0:end]; lastIndexOf(sub, end-1) is the
// same for a one-char needle, except that end == 0 must find nothing.
function rfindNewline(s, end) {
  if (end <= 0) return -1;
  return s.lastIndexOf("\n", end - 1);
}

const newSpec = () => ({ qual: [], storage: [], type: [], function: [], alignment: [], attr: [] });

const RULES_WITH_OPT = [
  "abstract_declarator", "assignment_expression", "declaration_list", "declaration_specifiers_no_type",
  "designation", "expression", "identifier_list", "init_declarator_list", "id_init_declarator_list",
  "initializer_list", "parameter_type_list", "block_item_list", "type_qualifier_list",
  "struct_declarator_list", "asm_label", "asm_qualifiers", "asm_operands", "asm_symbolic_name",
  "asm_string_list", "asm_goto_list", "gcc_attributes",
];

export class CParser {
  constructor() {
    this.clex = new CLexer({
      error_func: (msg, line, column) => this._lex_error_func(msg, line, column),
      on_lbrace_func: () => this._push_scope(),
      on_rbrace_func: () => this._pop_scope(),
      type_lookup_func: (name) => this._is_type_in_scope(name),
    });
    this.clex.build();
    this.tokens = this.clex.tokens;
    this.cparser = new LRParser(yacctab, this._actions(), (p) => this.p_error(p));
    this._scope_stack = [this._make_initial_scope()];
    this._last_yielded_token = null;
  }

  /** Parse C code and return a FileAST. */
  parse(text, filename = "", debug = false) {
    void debug;
    this.clex.filename = filename;
    this.clex.reset_lineno();
    this._scope_stack = [this._make_initial_scope()];
    this._last_yielded_token = null;
    return this.cparser.parse(text, this.clex);
  }

  _make_initial_scope() { return new Map([["__builtin_va_list", true]]); }

  _push_scope() { this._scope_stack.push(new Map()); }

  _pop_scope() {
    if (!(this._scope_stack.length > 1)) throw new AssertionError();
    this._scope_stack.pop();
  }

  _add_typedef_name(name, coord) {
    const top = this._scope_stack[this._scope_stack.length - 1];
    if (!(top.has(name) ? top.get(name) : true)) {
      this._parse_error(`Typedef ${pyQuote(name)} previously declared as non-typedef in this scope`, coord);
    }
    top.set(name, true);
  }

  _add_identifier(name, coord) {
    const top = this._scope_stack[this._scope_stack.length - 1];
    if (top.has(name) ? top.get(name) : false) {
      this._parse_error(`Non-typedef ${pyQuote(name)} previously declared as typedef in this scope`, coord);
    }
    top.set(name, false);
  }

  _is_type_in_scope(name) {
    for (let i = this._scope_stack.length - 1; i >= 0; i--) {
      const s = this._scope_stack[i];
      if (s.has(name)) {
        const v = s.get(name);
        if (v != null) return v;
      }
    }
    return false;
  }

  _lex_error_func(msg, line, lexpos) { this._parse_error(msg, this._coord(line, lexpos)); }

  _get_yacc_lookahead_token() { return this.clex.last_token; }

  _coord(lineno, lexpos) {
    return new Coord(this.clex.filename, lineno, this.clex.lexer.lexdata, lexpos);
  }

  _token_coord(p, token_idx) { return this._coord(p.lineno(token_idx), p.lexpos(token_idx)); }

  _parse_error(msg, coord) { throw new ParseError(`${S(coord)}: ${msg}`, coord); }

  _type_modify_decl(decl, modifier) {
    const modifier_head = modifier;
    let modifier_tail = modifier;
    while (modifier_tail.type) modifier_tail = modifier_tail.type;
    if (decl instanceof c_ast.TypeDecl) {
      modifier_tail.type = decl;
      return modifier;
    }
    let decl_tail = decl;
    while (!(decl_tail.type instanceof c_ast.TypeDecl)) decl_tail = decl_tail.type;
    modifier_tail.type = decl_tail.type;
    decl_tail.type = modifier_head;
    return decl;
  }

  _fix_decl_name_type(decl, typename) {
    let type = decl;
    while (!(type instanceof c_ast.TypeDecl)) type = type.type;
    decl.name = type.declname;
    type.quals = decl.quals.slice();
    for (const tn of typename) {
      if (!(tn instanceof c_ast.IdentifierType)) {
        if (typename.length > 1) this._parse_error("Invalid multiple types specified", tn.coord);
        else {
          type.type = tn;
          return decl;
        }
      }
    }
    if (!typename.length) {
      if (!(decl.type instanceof c_ast.FuncDecl)) this._parse_error("Missing type in declaration", decl.coord);
      type.type = new c_ast.IdentifierType(["int"], decl.coord);
    } else {
      type.type = new c_ast.IdentifierType(typename.flatMap((id) => id.names), typename[0].coord);
    }
    return decl;
  }

  _add_declaration_specifier(declspec, newspec, kind, append = false) {
    const spec = declspec || newSpec();
    if (append) spec[kind].push(newspec);
    else spec[kind].unshift(newspec);
    return spec;
  }

  _add_declaration_specifier_list(declspec, newspecs, kind, append = false) {
    const spec = declspec || newSpec();
    if (append) spec[kind].push(...newspecs);
    else spec[kind].splice(0, 0, ...newspecs);
    return spec;
  }

  _build_declarations(spec, decls, typedef_namespace = false) {
    const is_typedef = spec.storage.includes("typedef");
    const declarations = [];
    if (decls[0].bitsize != null) {
      // Bit-fields are allowed to be unnamed.
    } else if (decls[0].decl == null) {
      const ty = spec.type;
      if (ty.length < 2 || ty[ty.length - 1].names.length !== 1 || !this._is_type_in_scope(ty[ty.length - 1].names[0])) {
        let coord = "?";
        for (const t of ty) {
          if (t instanceof c_ast.Node || (t && "coord" in t)) { coord = t.coord; break; }
        }
        this._parse_error("Invalid declaration", coord);
      }
      decls[0].decl = new c_ast.TypeDecl(ty[ty.length - 1].names[0], null, null, spec.alignment, ty[ty.length - 1].coord);
      ty.splice(ty.length - 1, 1);
    } else if (!(decls[0].decl instanceof c_ast.Enum || decls[0].decl instanceof c_ast.Struct
      || decls[0].decl instanceof c_ast.Union || decls[0].decl instanceof c_ast.IdentifierType)) {
      let decls_0_tail = decls[0].decl;
      while (!(decls_0_tail instanceof c_ast.TypeDecl)) decls_0_tail = decls_0_tail.type;
      if (decls_0_tail.declname == null) {
        decls_0_tail.declname = spec.type[spec.type.length - 1].names[0];
        spec.type.splice(spec.type.length - 1, 1);
      }
    }
    for (const decl of decls) {
      if (decl.decl == null) throw new AssertionError();
      const attrs = spec.attr.concat(decl.attr || []);
      let declaration;
      if (is_typedef) {
        declaration = new c_ast.Typedef(null, spec.qual, spec.storage, attrs, decl.decl, decl.decl.coord);
      } else {
        declaration = new c_ast.Decl(null, spec.qual, spec.alignment, spec.storage, spec.function, attrs, decl.decl,
          decl.init ?? null, decl.bitsize ?? null, decl.asmlabel ?? null, decl.decl.coord);
      }
      let fixed_decl;
      const t = declaration.type;
      if (t instanceof c_ast.Enum || t instanceof c_ast.Struct || t instanceof c_ast.Union || t instanceof c_ast.IdentifierType) {
        fixed_decl = declaration;
      } else {
        fixed_decl = this._fix_decl_name_type(declaration, spec.type);
      }
      if (typedef_namespace) {
        if (is_typedef) this._add_typedef_name(fixed_decl.name, fixed_decl.coord);
        else this._add_identifier(fixed_decl.name, fixed_decl.coord);
      }
      fixed_decl = fix_atomic_specifiers(fixed_decl);
      declarations.push(fixed_decl);
    }
    return declarations;
  }

  _build_function_definition(spec, decl, param_decls, body) {
    if (spec.storage.includes("typedef")) this._parse_error("Invalid typedef", decl.coord);
    const declaration = this._build_declarations(spec, [{ decl, init: null }], true)[0];
    return new c_ast.FuncDef(declaration, param_decls, body, decl.coord);
  }

  _select_struct_union_class(token) { return token === "struct" ? c_ast.Struct : c_ast.Union; }

  p_error(p) {
    if (p) this._parse_error(`before: ${p.value}`, this._coord(p.lineno, p.lexpos));
    else this._parse_error("At end of input", this.clex.filename);
  }

  /** The grammar actions, keyed by upstream function name. */
  _actions() {
    const self = this;
    const A = {};
    for (const rule of RULES_WITH_OPT) A[`p_${rule}_opt`] = (p) => p.set(0, p.get(1));

    A.p_translation_unit_or_empty = (p) => {
      p.set(0, p.get(1) == null ? new c_ast.FileAST([]) : new c_ast.FileAST(p.get(1)));
    };
    A.p_translation_unit_1 = (p) => p.set(0, p.get(1));
    A.p_translation_unit_2 = (p) => { p.get(1).push(...p.get(2)); p.set(0, p.get(1)); };
    A.p_external_declaration_1 = (p) => p.set(0, [p.get(1)]);
    A.p_external_declaration_2 = (p) => p.set(0, p.get(1));
    A.p_external_declaration_3 = (p) => p.set(0, [p.get(1)]);
    A.p_external_declaration_4 = (p) => p.set(0, []);
    A.p_external_declaration_5 = (p) => p.set(0, p.get(1));
    A.p_external_declaration_6 = (p) => p.set(0, [p.get(1)]);
    A.p_global_asm = (p) => p.set(0, new c_ast.Asm([], p.get(3), [], [], [], [], self._token_coord(p, 1)));
    A.p_static_assert_declaration = (p) => {
      if (p.length === 5) p.set(0, [new c_ast.StaticAssert(p.get(3), null, self._token_coord(p, 1))]);
      else p.set(0, [new c_ast.StaticAssert(p.get(3), p.get(5), self._token_coord(p, 1))]);
    };
    A.p_pp_directive = (p) => self._parse_error("Directives not supported yet", self._token_coord(p, 1));
    A.p_pppragma_directive = (p) => {
      if (p.length === 5) p.set(0, new c_ast.Pragma(p.get(3), self._token_coord(p, 2)));
      else if (p.length === 3) p.set(0, new c_ast.Pragma(p.get(2), self._token_coord(p, 2)));
      else p.set(0, new c_ast.Pragma("", self._token_coord(p, 1)));
    };
    A.p_pppragma_directive_list = (p) => p.set(0, p.length === 2 ? [p.get(1)] : p.get(1).concat([p.get(2)]));
    A.p_function_definition_1 = (p) => {
      const tp = new c_ast.IdentifierType(["int"], self._token_coord(p, 1));
      const spec = self._add_declaration_specifier(null, tp, "type");
      p.set(0, self._build_function_definition(spec, p.get(1), p.get(2), p.get(3)));
    };
    A.p_function_definition_2 = (p) => {
      p.set(0, self._build_function_definition(p.get(1), p.get(2), p.get(3), p.get(4)));
    };
    A.p_statement = (p) => p.set(0, p.get(1));
    A.p_pragmacomp_or_statement = (p) => {
      if (p.length === 3) p.set(0, new c_ast.Compound(p.get(1).concat([p.get(2)]), self._token_coord(p, 1)));
      else p.set(0, p.get(1));
    };
    A.p_decl_body = (p) => {
      const spec = p.get(1);
      let decls;
      if (p.get(2) == null) {
        const ty = spec.type;
        if (ty.length === 1 && (ty[0] instanceof c_ast.Struct || ty[0] instanceof c_ast.Union || ty[0] instanceof c_ast.Enum)) {
          decls = [new c_ast.Decl(null, spec.qual, spec.alignment, spec.storage, spec.function, spec.attr, ty[0],
            null, null, null, ty[0].coord)];
        } else {
          decls = self._build_declarations(spec, [{ decl: null, init: null }], true);
        }
      } else {
        decls = self._build_declarations(spec, p.get(2), true);
      }
      p.set(0, decls);
    };
    A.p_declaration = (p) => p.set(0, p.get(1));
    A.p_declaration_list = (p) => p.set(0, p.length === 2 ? p.get(1) : p.get(1).concat(p.get(2)));
    A.p_declaration_specifiers_no_type_1 = (p) => p.set(0, self._add_declaration_specifier(p.get(2), p.get(1), "qual"));
    A.p_declaration_specifiers_no_type_2 = (p) => p.set(0, self._add_declaration_specifier(p.get(2), p.get(1), "storage"));
    A.p_declaration_specifiers_no_type_3 = (p) => p.set(0, self._add_declaration_specifier(p.get(2), p.get(1), "function"));
    A.p_declaration_specifiers_no_type_4 = (p) => p.set(0, self._add_declaration_specifier(p.get(2), p.get(1), "type"));
    A.p_declaration_specifiers_no_type_5 = (p) => p.set(0, self._add_declaration_specifier(p.get(2), p.get(1), "alignment"));
    A.p_declaration_specifiers_no_type_attrs = (p) => p.set(0, self._add_declaration_specifier_list(p.get(2), p.get(1), "attr"));
    A.p_declaration_specifiers_1 = (p) => p.set(0, self._add_declaration_specifier(p.get(1), p.get(2), "qual", true));
    A.p_declaration_specifiers_2 = (p) => p.set(0, self._add_declaration_specifier(p.get(1), p.get(2), "storage", true));
    A.p_declaration_specifiers_3 = (p) => p.set(0, self._add_declaration_specifier(p.get(1), p.get(2), "function", true));
    A.p_declaration_specifiers_4 = (p) => p.set(0, self._add_declaration_specifier(p.get(1), p.get(2), "type", true));
    A.p_declaration_specifiers_5 = (p) => p.set(0, self._add_declaration_specifier(null, p.get(1), "type"));
    A.p_declaration_specifiers_6 = (p) => p.set(0, self._add_declaration_specifier(p.get(1), p.get(2), "type", true));
    A.p_declaration_specifiers_7 = (p) => p.set(0, self._add_declaration_specifier(p.get(1), p.get(2), "alignment", true));
    A.p_declaration_specifiers_attrs = (p) => p.set(0, self._add_declaration_specifier_list(p.get(1), p.get(2), "attr", true));
    A.p_storage_class_specifier = (p) => p.set(0, p.get(1));
    A.p_function_specifier = (p) => p.set(0, p.get(1).replaceAll("__", ""));
    A.p_type_specifier_no_typeid = (p) => p.set(0, new c_ast.IdentifierType([p.get(1)], self._token_coord(p, 1)));
    A.p_type_specifier = (p) => p.set(0, p.get(1));
    A.p_type_specifier_gnu_typeof = (p) => p.set(0, new c_ast.Typeof(p.get(3), self._token_coord(p, 1)));
    A.p_atomic_specifier = (p) => {
      const typ = p.get(3);
      typ.quals.push("_Atomic");
      p.set(0, typ);
    };
    A.p_type_qualifier = (p) => p.set(0, p.get(1).replaceAll("__", ""));
    A.p_init_declarator_list = (p) => p.set(0, p.length === 4 ? p.get(1).concat([p.get(3)]) : [p.get(1)]);
    A.p_init_declarator = (p) => {
      p.set(0, { decl: p.get(1), asmlabel: p.get(2), attr: p.get(3), init: p.length > 4 && p.get(4) === "=" ? p.get(5) : null });
    };
    A.p_id_init_declarator_list = (p) => p.set(0, p.length === 4 ? p.get(1).concat([p.get(3)]) : [p.get(1)]);
    A.p_id_init_declarator = (p) => {
      p.set(0, { decl: p.get(1), asmlabel: p.get(2), attr: p.get(3), init: p.length > 4 ? p.get(5) : null });
    };
    A.p_specifier_qualifier_list_1 = (p) => p.set(0, self._add_declaration_specifier(p.get(1), p.get(2), "type", true));
    A.p_specifier_qualifier_list_2 = (p) => p.set(0, self._add_declaration_specifier(p.get(1), p.get(2), "qual", true));
    A.p_specifier_qualifier_list_3 = (p) => p.set(0, self._add_declaration_specifier(null, p.get(1), "type"));
    A.p_specifier_qualifier_list_4 = (p) => p.set(0, self._add_declaration_specifier(p.get(1), p.get(2), "type"));
    A.p_specifier_qualifier_list_5 = (p) => p.set(0, self._add_declaration_specifier(null, p.get(1), "alignment"));
    A.p_specifier_qualifier_list_6 = (p) => p.set(0, self._add_declaration_specifier(p.get(1), p.get(2), "alignment", true));
    A.p_specifier_qualifier_list_attr = (p) => p.set(0, self._add_declaration_specifier_list(p.get(1), p.get(2), "attr", true));
    A.p_struct_or_union_specifier_1 = (p) => {
      const klass = self._select_struct_union_class(p.get(1));
      p.set(0, new klass(p.get(2), [], null, self._token_coord(p, 2)));
    };
    A.p_struct_or_union_specifier_2 = (p) => {
      const klass = self._select_struct_union_class(p.get(1));
      p.set(0, new klass(null, (p.get(2) || []).concat(p.get(p.length - 1) || []), p.length === 6 ? [] : p.get(4), self._token_coord(p, 3)));
    };
    A.p_struct_or_union_specifier_3 = (p) => {
      const klass = self._select_struct_union_class(p.get(1));
      p.set(0, new klass(p.get(2)[0], p.get(2)[1].concat(p.get(p.length - 1) || []), p.length === 6 ? [] : p.get(4), p.get(2)[2]));
    };
    A.p_struct_or_union = (p) => p.set(0, p.get(1));
    A.p_struct_declaration_list = (p) => {
      if (p.length === 2) p.set(0, p.get(1) || []);
      else p.set(0, p.get(1).concat(p.get(2) || []));
    };
    A.p_struct_declaration_1 = (p) => {
      const spec = p.get(1);
      if (spec.storage.includes("typedef")) throw new AssertionError();
      let decls;
      if (p.get(2) != null) {
        decls = self._build_declarations(spec, p.get(2));
      } else if (spec.type.length === 1) {
        const node = spec.type[0];
        const decl_type = node instanceof c_ast.Node ? node : new c_ast.IdentifierType(node);
        decls = self._build_declarations(spec, [{ decl: decl_type }]);
      } else {
        decls = self._build_declarations(spec, [{ decl: null, init: null }]);
      }
      p.set(0, decls);
    };
    A.p_struct_declaration_2 = (p) => p.set(0, null);
    A.p_struct_declaration_3 = (p) => p.set(0, [p.get(1)]);
    A.p_struct_declarator_list = (p) => p.set(0, p.length === 4 ? p.get(1).concat([p.get(3)]) : [p.get(1)]);
    A.p_struct_declarator_1 = (p) => p.set(0, { decl: p.get(1), attr: p.get(2), bitsize: null });
    A.p_struct_declarator_2 = (p) => {
      if (p.length > 4) p.set(0, { decl: p.get(1), attr: p.get(2), bitsize: p.get(4) });
      else p.set(0, { decl: new c_ast.TypeDecl(null, null, null, null), attr: p.get(1), bitsize: p.get(3) });
    };
    A.p_enum_specifier_1 = (p) => p.set(0, new c_ast.Enum(p.get(2), [], null, self._token_coord(p, 1)));
    A.p_enum_specifier_2 = (p) => {
      p.set(0, new c_ast.Enum(null, (p.get(2) || []).concat(p.get(6) || []), p.get(4), self._token_coord(p, 1)));
    };
    A.p_enum_specifier_3 = (p) => {
      p.set(0, new c_ast.Enum(p.get(2)[0], p.get(2)[1].concat(p.get(6) || []), p.get(4), self._token_coord(p, 1)));
    };
    A.p_enumerator_list = (p) => {
      if (p.length === 2) p.set(0, new c_ast.EnumeratorList([p.get(1)], p.get(1).coord));
      else if (p.length === 3) p.set(0, p.get(1));
      else { p.get(1).enumerators.push(p.get(3)); p.set(0, p.get(1)); }
    };
    A.p_alignment_specifier = (p) => p.set(0, new c_ast.Alignas(p.get(3), self._token_coord(p, 1)));
    A.p_enumerator = (p) => {
      let enumerator;
      if (p.length === 3) enumerator = new c_ast.Enumerator(p.get(1), p.get(2) || [], null, self._token_coord(p, 1));
      else enumerator = new c_ast.Enumerator(p.get(1), p.get(2) || [], p.get(4), self._token_coord(p, 1));
      self._add_identifier(enumerator.name, enumerator.coord);
      p.set(0, enumerator);
    };
    A.p_declarator = (p) => p.set(0, p.get(1));

    // Parameterized declarator rules (plyparser.template expansion).
    for (const xxx of ["id", "typeid", "typeid_noparen"]) {
      A[`p_${xxx}_declarator_1`] = (p) => p.set(0, p.get(1));
      A[`p_${xxx}_declarator_2`] = (p) => p.set(0, self._type_modify_decl(p.get(2), p.get(1)));
      A[`p_direct_${xxx}_declarator_1`] = (p) => {
        p.set(0, new c_ast.TypeDecl(p.get(1), null, null, null, self._token_coord(p, 1)));
      };
      if (xxx !== "typeid_noparen") A[`p_direct_${xxx}_declarator_2`] = (p) => p.set(0, p.get(2));
      A[`p_direct_${xxx}_declarator_3`] = (p) => {
        const quals = (p.length > 5 ? p.get(3) : []) || [];
        const arr = new c_ast.ArrayDecl(null, p.length > 5 ? p.get(4) : p.get(3), quals, p.get(1).coord);
        p.set(0, self._type_modify_decl(p.get(1), arr));
      };
      A[`p_direct_${xxx}_declarator_4`] = (p) => {
        const listed = [p.get(3), p.get(4)].map((item) => (Array.isArray(item) ? item : [item]));
        const dim_quals = listed.flat().filter((q) => q != null);
        const arr = new c_ast.ArrayDecl(null, p.get(5), dim_quals, p.get(1).coord);
        p.set(0, self._type_modify_decl(p.get(1), arr));
      };
      A[`p_direct_${xxx}_declarator_5`] = (p) => {
        const arr = new c_ast.ArrayDecl(null, new c_ast.ID(p.get(4), self._token_coord(p, 4)), p.get(3) != null ? p.get(3) : [], p.get(1).coord);
        p.set(0, self._type_modify_decl(p.get(1), arr));
      };
      A[`p_direct_${xxx}_declarator_6`] = (p) => {
        const func = new c_ast.FuncDecl(p.get(3), null, p.get(1).coord);
        if (self._get_yacc_lookahead_token().type === "LBRACE") {
          if (func.args != null) {
            for (const param of func.args.params) {
              if (param instanceof c_ast.EllipsisParam) break;
              self._add_identifier(param.name, param.coord);
            }
          }
        }
        p.set(0, self._type_modify_decl(p.get(1), func));
      };
    }

    A.p_pointer = (p) => {
      const coord = self._token_coord(p, 1);
      const nested_type = new c_ast.PtrDecl(p.get(2) || [], null, coord);
      if (p.length > 3) {
        let tail_type = p.get(3);
        while (tail_type.type != null) tail_type = tail_type.type;
        tail_type.type = nested_type;
        p.set(0, p.get(3));
      } else {
        p.set(0, nested_type);
      }
    };
    A.p_type_qualifier_list = (p) => p.set(0, p.length === 2 ? [p.get(1)] : p.get(1).concat([p.get(2)]));
    A.p_type_qualifier_list_1 = (p) => p.set(0, self._add_declaration_specifier(null, p.get(1), "qual", true));
    A.p_type_qualifier_list_2 = (p) => p.set(0, self._add_declaration_specifier(p.get(1), p.get(2), "qual", true));
    A.p_type_qualifier_list_3 = (p) => p.set(0, self._add_declaration_specifier_list(null, p.get(1), "attr", true));
    A.p_type_qualifier_list_4 = (p) => p.set(0, self._add_declaration_specifier_list(p.get(1), p.get(2), "attr", true));
    A.p_parameter_type_list = (p) => {
      if (p.length > 2) p.get(1).params.push(new c_ast.EllipsisParam(self._token_coord(p, 3)));
      p.set(0, p.get(1));
    };
    A.p_parameter_list = (p) => {
      if (p.length === 2) p.set(0, new c_ast.ParamList([p.get(1)], p.get(1).coord));
      else { p.get(1).params.push(p.get(3)); p.set(0, p.get(1)); }
    };
    A.p_parameter_declaration_1 = (p) => {
      let spec = p.get(1);
      if (truthy(p.get(3))) spec = self._add_declaration_specifier_list(spec, p.get(3), "attr", true);
      if (!spec.type.length) spec.type = [new c_ast.IdentifierType(["int"], self._token_coord(p, 1))];
      p.set(0, self._build_declarations(spec, [{ decl: p.get(2) }])[0]);
    };
    A.p_parameter_declaration_2 = (p) => {
      let spec = p.get(1);
      if (truthy(p.get(3))) spec = self._add_declaration_specifier_list(spec, p.get(3), "attr", true);
      if (!spec.type.length) spec.type = [new c_ast.IdentifierType(["int"], self._token_coord(p, 1))];
      let decl;
      const ty = spec.type;
      if (ty.length > 1 && ty[ty.length - 1].names.length === 1 && self._is_type_in_scope(ty[ty.length - 1].names[0])) {
        decl = self._build_declarations(spec, [{ decl: p.get(2), init: null }])[0];
      } else {
        decl = new c_ast.Typename("", spec.qual, null, spec.attr, p.get(2) || new c_ast.TypeDecl(null, null, null, null), self._token_coord(p, 2));
        decl = self._fix_decl_name_type(decl, spec.type);
      }
      p.set(0, decl);
    };
    A.p_identifier_list = (p) => {
      if (p.length === 2) p.set(0, new c_ast.ParamList([p.get(1)], p.get(1).coord));
      else { p.get(1).params.push(p.get(3)); p.set(0, p.get(1)); }
    };
    A.p_initializer_1 = (p) => p.set(0, p.get(1));
    A.p_initializer_2 = (p) => {
      if (p.get(2) == null) p.set(0, new c_ast.InitList([], self._token_coord(p, 1)));
      else p.set(0, p.get(2));
    };
    A.p_initializer_list = (p) => {
      if (p.length === 3) {
        const init = p.get(1) == null ? p.get(2) : new c_ast.NamedInitializer(p.get(1), p.get(2));
        p.set(0, new c_ast.InitList([init], p.get(2).coord));
      } else {
        const init = p.get(3) == null ? p.get(4) : new c_ast.NamedInitializer(p.get(3), p.get(4));
        p.get(1).exprs.push(init);
        p.set(0, p.get(1));
      }
    };
    A.p_designation = (p) => p.set(0, p.get(1));
    A.p_designator_list = (p) => p.set(0, p.length === 2 ? [p.get(1)] : p.get(1).concat([p.get(2)]));
    A.p_designator = (p) => p.set(0, p.get(2));
    A.p_range_designator = (p) => p.set(0, new c_ast.Range(p.get(2), p.get(4), self._token_coord(p, 1)));
    A.p_type_name = (p) => {
      const typename = new c_ast.Typename("", p.get(1).qual.slice(), null, p.get(1).attr,
        p.get(2) || new c_ast.TypeDecl(null, null, null, null), self._token_coord(p, 2));
      p.set(0, self._fix_decl_name_type(typename, p.get(1).type));
    };
    A.p_abstract_declarator_1 = (p) => {
      const dummytype = new c_ast.TypeDecl(null, null, null, null);
      p.set(0, self._type_modify_decl(dummytype, p.get(1)));
    };
    A.p_abstract_declarator_2 = (p) => p.set(0, self._type_modify_decl(p.get(2), p.get(1)));
    A.p_abstract_declarator_3 = (p) => p.set(0, p.get(1));
    A.p_direct_abstract_declarator_1 = (p) => p.set(0, p.get(2));
    A.p_direct_abstract_declarator_2 = (p) => {
      const arr = new c_ast.ArrayDecl(null, p.get(3), [], p.get(1).coord);
      p.set(0, self._type_modify_decl(p.get(1), arr));
    };
    A.p_direct_abstract_declarator_3 = (p) => {
      const quals = (p.length > 4 ? p.get(2) : []) || [];
      p.set(0, new c_ast.ArrayDecl(new c_ast.TypeDecl(null, null, null, null), p.length > 4 ? p.get(3) : p.get(2), quals, self._token_coord(p, 1)));
    };
    A.p_direct_abstract_declarator_4 = (p) => {
      const arr = new c_ast.ArrayDecl(null, new c_ast.ID(p.get(3), self._token_coord(p, 3)), [], p.get(1).coord);
      p.set(0, self._type_modify_decl(p.get(1), arr));
    };
    A.p_direct_abstract_declarator_5 = (p) => {
      p.set(0, new c_ast.ArrayDecl(new c_ast.TypeDecl(null, null, null, null), new c_ast.ID(p.get(3), self._token_coord(p, 3)), [], self._token_coord(p, 1)));
    };
    A.p_direct_abstract_declarator_6 = (p) => {
      const func = new c_ast.FuncDecl(p.get(3), null, p.get(1).coord);
      p.set(0, self._type_modify_decl(p.get(1), func));
    };
    A.p_direct_abstract_declarator_7 = (p) => {
      p.set(0, new c_ast.FuncDecl(p.get(2), new c_ast.TypeDecl(null, null, null, null), self._token_coord(p, 1)));
    };
    A.p_direct_abstract_declarator_8 = (p) => {
      const listed = [p.get(2), p.get(3)].map((item) => (Array.isArray(item) ? item : [item]));
      const quals = listed.flat().filter((q) => q != null);
      p.set(0, new c_ast.ArrayDecl(new c_ast.TypeDecl(null, null, null, null), p.get(4), quals, self._token_coord(p, 1)));
    };
    A.p_block_item = (p) => p.set(0, Array.isArray(p.get(1)) ? p.get(1) : [p.get(1)]);
    A.p_block_item_list = (p) => {
      const v2 = p.length === 2 ? null : p.get(2);
      const isNoneList = Array.isArray(v2) && v2.length === 1 && v2[0] == null;
      p.set(0, p.length === 2 || isNoneList ? p.get(1) : p.get(1).concat(v2));
    };
    A.p_compound_statement_1 = (p) => p.set(0, new c_ast.Compound(p.get(2), self._token_coord(p, 1)));
    A.p_labeled_statement_1 = (p) => p.set(0, new c_ast.Label(p.get(1), p.get(3), self._token_coord(p, 1)));
    A.p_labeled_statement_2 = (p) => p.set(0, new c_ast.Case(p.get(2), [p.get(4)], self._token_coord(p, 1)));
    A.p_labeled_statement_range = (p) => {
      p.set(0, new c_ast.Case(new c_ast.Range(p.get(2), p.get(4), self._token_coord(p, 2)), [p.get(6)], self._token_coord(p, 1)));
    };
    A.p_labeled_statement_3 = (p) => p.set(0, new c_ast.Default([p.get(3)], self._token_coord(p, 1)));
    A.p_labeled_statement_4 = (p) => {
      p.set(0, new c_ast.Label(p.get(1), new c_ast.EmptyStatement(self._token_coord(p, 1)), self._token_coord(p, 1)));
    };
    A.p_labeled_statement_5 = (p) => {
      p.set(0, new c_ast.Case(p.get(2), [new c_ast.EmptyStatement(self._token_coord(p, 2))], self._token_coord(p, 1)));
    };
    A.p_labeled_statement_range_2 = (p) => {
      p.set(0, new c_ast.Case(new c_ast.Range(p.get(2), p.get(4), self._token_coord(p, 2)),
        [new c_ast.EmptyStatement(self._token_coord(p, 2))], self._token_coord(p, 1)));
    };
    A.p_labeled_statement_6 = (p) => {
      p.set(0, new c_ast.Default([new c_ast.EmptyStatement(self._token_coord(p, 1))], self._token_coord(p, 1)));
    };
    A.p_selection_statement_1 = (p) => p.set(0, new c_ast.If(p.get(3), p.get(5), null, self._token_coord(p, 1)));
    A.p_selection_statement_2 = (p) => p.set(0, new c_ast.If(p.get(3), p.get(5), p.get(7), self._token_coord(p, 1)));
    A.p_selection_statement_3 = (p) => p.set(0, fix_switch_cases(new c_ast.Switch(p.get(3), p.get(5), self._token_coord(p, 1))));
    A.p_iteration_statement_1 = (p) => p.set(0, new c_ast.While(p.get(3), p.get(5), self._token_coord(p, 1)));
    A.p_iteration_statement_2 = (p) => p.set(0, new c_ast.DoWhile(p.get(5), p.get(2), self._token_coord(p, 1)));
    A.p_iteration_statement_3 = (p) => p.set(0, new c_ast.For(p.get(3), p.get(5), p.get(7), p.get(9), self._token_coord(p, 1)));
    A.p_iteration_statement_4 = (p) => {
      p.set(0, new c_ast.For(new c_ast.DeclList(p.get(3), self._token_coord(p, 1)), p.get(4), p.get(6), p.get(8), self._token_coord(p, 1)));
    };
    A.p_jump_statement_1 = (p) => p.set(0, new c_ast.Goto(p.get(2), self._token_coord(p, 1)));
    A.p_jump_statement_2 = (p) => p.set(0, new c_ast.Break(self._token_coord(p, 1)));
    A.p_jump_statement_3 = (p) => p.set(0, new c_ast.Continue(self._token_coord(p, 1)));
    A.p_jump_statement_4 = (p) => p.set(0, new c_ast.Return(p.length === 4 ? p.get(2) : null, self._token_coord(p, 1)));
    A.p_expression_statement = (p) => {
      if (p.get(1) == null) p.set(0, new c_ast.EmptyStatement(self._token_coord(p, 2)));
      else p.set(0, p.get(1));
    };
    A.p_expression = (p) => {
      if (p.length === 2) p.set(0, p.get(1));
      else {
        if (!(p.get(1) instanceof c_ast.ExprList)) p.set(1, new c_ast.ExprList([p.get(1)], p.get(1).coord));
        p.get(1).exprs.push(p.get(3));
        p.set(0, p.get(1));
      }
    };
    A.p_parenthesized_compound_expression = (p) => p.set(0, p.get(2));
    A.p_typedef_name = (p) => p.set(0, new c_ast.IdentifierType([p.get(1)], self._token_coord(p, 1)));
    A.p_assignment_expression = (p) => {
      if (p.length === 2) p.set(0, p.get(1));
      else p.set(0, new c_ast.Assignment(p.get(2), p.get(1), p.get(3), p.get(1).coord));
    };
    A.p_assignment_operator = (p) => p.set(0, p.get(1));
    A.p_constant_expression = (p) => p.set(0, p.get(1));
    A.p_conditional_expression = (p) => {
      if (p.length === 2) p.set(0, p.get(1));
      else p.set(0, new c_ast.TernaryOp(p.get(1), p.get(3), p.get(5), p.get(1).coord));
    };
    A.p_binary_expression = (p) => {
      if (p.length === 2) p.set(0, p.get(1));
      else p.set(0, new c_ast.BinaryOp(p.get(2), p.get(1), p.get(3), p.get(1).coord));
    };
    A.p_cast_expression_2 = (p) => p.set(0, new c_ast.Cast(p.get(2), p.get(4), self._token_coord(p, 1)));
    A.p_unary_expression_1 = (p) => p.set(0, p.get(1));
    A.p_unary_expression_2 = (p) => p.set(0, new c_ast.UnaryOp(p.get(1), p.get(2), p.get(2).coord));
    A.p_unary_expression_3 = (p) => {
      p.set(0, new c_ast.UnaryOp(p.get(1).replaceAll("__alignof", "_Alignof").replaceAll("__", ""),
        p.length === 3 ? p.get(2) : p.get(3), self._token_coord(p, 1)));
    };
    A.p_unary_operator = (p) => p.set(0, p.get(1));
    A.p_postfix_expression_1 = (p) => p.set(0, p.get(1));
    A.p_postfix_expression_2 = (p) => p.set(0, new c_ast.ArrayRef(p.get(1), p.get(3), p.get(1).coord));
    A.p_postfix_expression_3 = (p) => p.set(0, new c_ast.FuncCall(p.get(1), p.length === 5 ? p.get(3) : null, p.get(1).coord));
    A.p_postfix_expression_4 = (p) => {
      const field = new c_ast.ID(p.get(3), self._token_coord(p, 3));
      p.set(0, new c_ast.StructRef(p.get(1), p.get(2), field, p.get(1).coord));
    };
    A.p_postfix_expression_5 = (p) => p.set(0, new c_ast.UnaryOp("p" + p.get(2), p.get(1), p.get(1).coord));
    A.p_postfix_expression_6 = (p) => p.set(0, new c_ast.CompoundLiteral(p.get(2), p.get(5)));
    A.p_primary_expression_1 = (p) => p.set(0, p.get(1));
    A.p_primary_expression_2 = (p) => p.set(0, p.get(1));
    A.p_primary_expression_3 = (p) => p.set(0, p.get(1));
    A.p_primary_expression_4 = (p) => p.set(0, p.get(2));
    A.p_primary_expression_5 = (p) => {
      const coord = self._token_coord(p, 1);
      p.set(0, new c_ast.FuncCall(new c_ast.ID(p.get(1), coord), new c_ast.ExprList([p.get(3), p.get(5)], coord), coord));
    };
    A.p_offsetof_member_designator = (p) => {
      if (p.length === 2) p.set(0, p.get(1));
      else if (p.length === 4) p.set(0, new c_ast.StructRef(p.get(1), p.get(2), p.get(3), p.get(1).coord));
      else if (p.length === 5) p.set(0, new c_ast.ArrayRef(p.get(1), p.get(3), p.get(1).coord));
      else throw new Error(`Unexpected parsing state. len(p): ${p.length}`);
    };
    A.p_argument_expression_list = (p) => {
      if (p.length === 2) p.set(0, new c_ast.ExprList([p.get(1)], p.get(1).coord));
      else { p.get(1).exprs.push(p.get(3)); p.set(0, p.get(1)); }
    };
    A.p_identifier = (p) => p.set(0, new c_ast.ID(p.get(1), self._token_coord(p, 1)));
    A.p_constant_1 = (p) => {
      let uCount = 0, lCount = 0;
      for (const x of p.get(1).slice(-3)) {
        if (x === "l" || x === "L") lCount++;
        else if (x === "u" || x === "U") uCount++;
      }
      if (uCount > 1) throw new PyValueError("Constant cannot have more than one u/U suffix.");
      if (lCount > 2) throw new PyValueError("Constant cannot have more than two l/L suffix.");
      const prefix = "unsigned ".repeat(uCount) + "long ".repeat(lCount);
      p.set(0, new c_ast.Constant(prefix + "int", p.get(1), self._token_coord(p, 1)));
    };
    A.p_constant_2 = (p) => {
      const v = p.get(1);
      const last = v[v.length - 1];
      const t = last === "f" || last === "F" ? "float" : last === "l" || last === "L" ? "long double" : "double";
      p.set(0, new c_ast.Constant(t, v, self._token_coord(p, 1)));
    };
    A.p_constant_3 = (p) => p.set(0, new c_ast.Constant("char", p.get(1), self._token_coord(p, 1)));
    A.p_unified_string_literal = (p) => {
      if (p.length === 2) p.set(0, new c_ast.Constant("string", p.get(1), self._token_coord(p, 1)));
      else {
        p.get(1).value = p.get(1).value.slice(0, -1) + p.get(2).slice(1);
        p.set(0, p.get(1));
      }
    };
    A.p_unified_wstring_literal = (p) => {
      if (p.length === 2) p.set(0, new c_ast.Constant("string", p.get(1), self._token_coord(p, 1)));
      else {
        p.get(1).value = pyRstrip(p.get(1).value).slice(0, -1) + p.get(2).slice(2);
        p.set(0, p.get(1));
      }
    };
    A.p_attrs_id_typeid = (p) => {
      if (p.length === 3) p.set(0, [p.get(2), p.get(1), self._token_coord(p, 2)]);
      else p.set(0, [p.get(1), [], self._token_coord(p, 1)]);
    };
    A.p_brace_open = (p) => { p.set(0, p.get(1)); p.set_lineno(0, p.lineno(1)); };
    A.p_brace_close = (p) => { p.set(0, p.get(1)); p.set_lineno(0, p.lineno(1)); };
    A.p_attr_stmt = (p) => p.set(0, new c_ast.GccAttributeStatement(p.get(1), self._token_coord(p, 2)));
    A.p_asm_1 = (p) => p.set(0, new c_ast.Asm(p.get(2) || [], p.get(4), [], [], [], [], self._token_coord(p, 1)));
    A.p_asm_2 = (p) => p.set(0, new c_ast.Asm(p.get(2) || [], p.get(4), p.get(6) || [], [], [], [], self._token_coord(p, 1)));
    A.p_asm_3 = (p) => p.set(0, new c_ast.Asm(p.get(2) || [], p.get(4), p.get(6) || [], p.get(8) || [], [], [], self._token_coord(p, 1)));
    A.p_asm_4 = (p) => p.set(0, new c_ast.Asm(p.get(2) || [], p.get(4), p.get(6) || [], p.get(8) || [], p.get(10) || [], [], self._token_coord(p, 1)));
    A.p_asm_5 = (p) => p.set(0, new c_ast.Asm(p.get(2) || [], p.get(4), p.get(6) || [], p.get(8) || [], p.get(10) || [], p.get(12) || [], self._token_coord(p, 1)));
    A.p_asm_operands = (p) => p.set(0, p.length === 4 ? p.get(1).concat([p.get(3)]) : [p.get(1)]);
    A.p_asm_operand = (p) => p.set(0, new c_ast.AsmOperand(p.get(1), p.get(2), p.get(4), self._token_coord(p, 3)));
    A.p_asm_string_list = (p) => p.set(0, p.length === 4 ? p.get(1).concat([p.get(3)]) : [p.get(1)]);
    A.p_asm_goto_list = (p) => p.set(0, p.length === 4 ? p.get(1).concat([p.get(3)]) : [p.get(1)]);
    A.p_asm_symbolic_name = (p) => p.set(0, p.get(2));
    A.p_asm_qualifiers = (p) => p.set(0, (p.get(1) || []).concat([p.get(2)]));
    A.p_asm_label = (p) => p.set(0, p.get(3));
    A.p_gcc_attributes = (p) => p.set(0, p.length === 3 ? p.get(1).concat(p.get(2)) : p.get(1));
    A.p_gcc_attribute = (p) => p.set(0, p.get(4) || []);
    A.p_gcc_attribute_list = (p) => p.set(0, p.length === 4 ? p.get(1).concat(p.get(3)) : p.get(1));
    A.p_gcc_attribute_item = (p) => {
      if (!p.get(1)) p.set(0, []);
      else {
        let name = p.get(1);
        if (name.length > 4 && name.startsWith("__") && name.endsWith("__")) name = name.slice(2, -2);
        let args = null;
        if (p.length > 2) args = p.get(3).exprs;
        p.set(0, [new c_ast.GccAttribute(name, args, self._token_coord(p, 1))]);
      }
    };
    A.p_empty = (p) => p.set(0, null);
    return A;
  }
}

export class AssertionError extends Error {
  constructor(message = "") {
    super(message);
    this.name = "AssertionError";
  }
}

export class PyValueError extends Error {
  constructor(message) {
    super(message);
    this.name = "ValueError";
  }
}

/** Python truthiness for values the grammar produces (None, lists, strings, nodes). */
function truthy(v) {
  if (v == null || v === false) return false;
  if (Array.isArray(v) || typeof v === "string") return v.length > 0;
  return true;
}

function pyRstrip(s) { return s.replace(/[\s]+$/, ""); }

/** Python repr() of a str, as %r formats it. */
function pyQuote(s) {
  if (s == null) return "None";
  const q = s.includes("'") && !s.includes("\"") ? "\"" : "'";
  return q + s.replaceAll("\\", "\\\\").replaceAll(q, "\\" + q) + q;
}
