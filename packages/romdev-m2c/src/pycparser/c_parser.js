// pycparser: c_parser.js - parser and AST builder for the C language (port
// of m2c_pycparser/c_parser.py plus the LR driver from ply.yacc
// parseopt_notrack, running on the precomputed LALR tables in yacctab.js).
// Copyright (c) 2008-2022 Eli Bendersky, BSD licence; PLY Copyright (c)
// 2001-2017 David M. Beazley, BSD licence (see NOTICE).
//
// Grammar actions keep the Python names (p_*). Each receives `p`, an array
// of the production's symbol values (p[0] is the result slot; p.length is
// Python's len(p)); token positions come from the current slice via
// this._token_coord(p, i).
import * as c_ast from "./c_ast.js";
import { CLexer } from "./c_lexer.js";
import { PLYParser, ParseError } from "./plyparser.js";
import { fix_switch_cases, fix_atomic_specifiers } from "./ast_transforms.js";
import yacctab from "./yacctab.js";
import { ValueError, pyassert } from "../py.js";

const isList = Array.isArray;
// Python truthiness for the values grammar actions test (lists, strings, nodes, None).
const truthy = (x) => (isList(x) ? x.length > 0 : x !== null && x !== undefined && x !== "" && x !== false && x !== 0);
const newSpec = () => ({ qual: [], storage: [], type: [], function: [], alignment: [], attr: [] });

class YaccSymbol {
  constructor(type) {
    this.type = type;
    this.value = null;
  }
  toString() {
    return this.type;
  }
}

/** The ply.yacc LRParser engine (parseopt_notrack), bound to a CParser. */
class LRParser {
  constructor(owner) {
    this.owner = owner;
    this.productions = yacctab.productions.map(([str, name, len, func]) => ({ str, name, len, func }));
    this.action = yacctab.action;
    this.goto = yacctab.goto;
    this.defaulted_states = new Map();
    for (const [state, actions] of Object.entries(this.action)) {
      const rules = Object.values(actions);
      if (rules.length === 1 && rules[0] < 0) this.defaulted_states.set(Number(state), rules[0]);
    }
    for (const p of this.productions) {
      if (p.func && typeof owner[p.func] !== "function") throw new Error(`pycparser: missing grammar action ${p.func}`);
    }
  }

  parse({ input = null, lexer }) {
    const owner = this.owner;
    let lookahead = null;
    const lookaheadstack = [];
    const actions = this.action;
    const goto = this.goto;
    const prod = this.productions;
    const defaulted_states = this.defaulted_states;
    if (input !== null) lexer.input(input);
    const get_token = () => lexer.token();
    const statestack = [];
    const symstack = [];
    statestack.push(0);
    symstack.push(new YaccSymbol("$end"));
    let state = 0;
    let errorcount = 0;
    for (;;) {
      let t;
      if (!defaulted_states.has(state)) {
        if (!lookahead) {
          lookahead = lookaheadstack.length ? lookaheadstack.pop() : get_token();
          if (!lookahead) lookahead = new YaccSymbol("$end");
        }
        const ltype = lookahead.type;
        const row = actions[state];
        t = row && Object.prototype.hasOwnProperty.call(row, ltype) ? row[ltype] : undefined;
      } else {
        t = defaulted_states.get(state);
      }

      if (t !== undefined) {
        if (t > 0) {
          statestack.push(t);
          state = t;
          symstack.push(lookahead);
          lookahead = null;
          if (errorcount) errorcount -= 1;
          continue;
        }
        if (t < 0) {
          const p = prod[-t];
          const pname = p.name;
          const plen = p.len;
          const sym = new YaccSymbol(pname);
          let targ;
          if (plen) {
            targ = symstack.slice(symstack.length - plen - 1);
            targ[0] = sym;
            symstack.length -= plen;
          } else {
            targ = [sym];
          }
          const vals = targ.map((s) => (s === sym ? null : s.value));
          owner._slice = targ;
          owner[p.func](vals);
          sym.value = vals[0];
          if (plen) statestack.length -= plen;
          symstack.push(sym);
          state = goto[statestack[statestack.length - 1]][pname];
          statestack.push(state);
          continue;
        }
        if (t === 0) {
          const n = symstack[symstack.length - 1];
          return n.value === undefined ? null : n.value;
        }
      }

      // Syntax error: pycparser's p_error always raises.
      if (errorcount === 0) {
        let errtoken = lookahead;
        if (errtoken.type === "$end") errtoken = null;
        owner.p_error(errtoken);
      }
      throw new Error("yacc: internal parser error!!!\n");
    }
  }
}

const RULES_WITH_OPT = [
  "abstract_declarator",
  "assignment_expression",
  "declaration_list",
  "declaration_specifiers_no_type",
  "designation",
  "expression",
  "identifier_list",
  "init_declarator_list",
  "id_init_declarator_list",
  "initializer_list",
  "parameter_type_list",
  "block_item_list",
  "type_qualifier_list",
  "struct_declarator_list",
  "asm_label",
  "asm_qualifiers",
  "asm_operands",
  "asm_symbolic_name",
  "asm_string_list",
  "asm_goto_list",
  "gcc_attributes",
];

export class CParser extends PLYParser {
  constructor() {
    super();
    this.clex = new CLexer(
      (msg, line, lexpos) => this._lex_error_func(msg, line, lexpos),
      () => this._lex_on_lbrace_func(),
      () => this._lex_on_rbrace_func(),
      (name) => this._lex_type_lookup_func(name),
    );
    this.clex.build();
    this.tokens = CLexer.tokens;
    this.cparser = new LRParser(this);
    this._scope_stack = [this._make_initial_scope()];
    this._last_yielded_token = null;
    this._slice = null;
  }

  /** Parse C code and return a FileAST. */
  parse(text, filename = "") {
    this.clex.filename = filename;
    this.clex.reset_lineno();
    this._scope_stack = [this._make_initial_scope()];
    this._last_yielded_token = null;
    return this.cparser.parse({ input: text, lexer: this.clex });
  }

  _make_initial_scope() {
    return new Map([["__builtin_va_list", true]]);
  }
  _push_scope() {
    this._scope_stack.push(new Map());
  }
  _pop_scope() {
    pyassert(this._scope_stack.length > 1);
    this._scope_stack.pop();
  }
  _add_typedef_name(name, coord) {
    const scope = this._scope_stack[this._scope_stack.length - 1];
    if (!(scope.has(name) ? scope.get(name) : true)) {
      this._parse_error(`Typedef ${pyRepr(name)} previously declared as non-typedef in this scope`, coord);
    }
    scope.set(name, true);
  }
  _add_identifier(name, coord) {
    const scope = this._scope_stack[this._scope_stack.length - 1];
    if (scope.has(name) ? scope.get(name) : false) {
      this._parse_error(`Non-typedef ${pyRepr(name)} previously declared as typedef in this scope`, coord);
    }
    scope.set(name, false);
  }
  _is_type_in_scope(name) {
    for (let i = this._scope_stack.length - 1; i >= 0; i--) {
      const scope = this._scope_stack[i];
      if (scope.has(name)) {
        const v = scope.get(name);
        if (v !== null && v !== undefined) return v;
      }
    }
    return false;
  }
  _lex_error_func(msg, line, lexpos) {
    this._parse_error(msg, this._coord(line, lexpos));
  }
  _lex_on_lbrace_func() {
    this._push_scope();
  }
  _lex_on_rbrace_func() {
    this._pop_scope();
  }
  _lex_type_lookup_func(name) {
    return this._is_type_in_scope(name);
  }
  _get_yacc_lookahead_token() {
    return this.clex.last_token;
  }

  // YaccProduction.lineno / lexpos on the current slice.
  _p_lineno(n) {
    const s = this._slice[n];
    return s.lineno === undefined ? 0 : s.lineno;
  }
  _p_lexpos(n) {
    const s = this._slice[n];
    return s.lexpos === undefined ? 0 : s.lexpos;
  }
  _token_coord(p, token_idx) {
    return this._coord(this._p_lineno(token_idx), this._p_lexpos(token_idx));
  }

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
    else spec[kind].unshift(...newspecs);
    return spec;
  }

  _build_declarations(spec, decls, typedef_namespace = false) {
    const is_typedef = spec.storage.includes("typedef");
    const declarations = [];
    const d0 = decls[0];
    if (d0.bitsize !== undefined && d0.bitsize !== null) {
      // Bit-fields are allowed to be unnamed.
    } else if (d0.decl === null || d0.decl === undefined) {
      const ty = spec.type;
      if (ty.length < 2 || ty[ty.length - 1].names.length !== 1 || !this._is_type_in_scope(ty[ty.length - 1].names[0])) {
        let coord = "?";
        for (const t of ty) {
          if (t && typeof t === "object" && "coord" in t) {
            coord = t.coord;
            break;
          }
        }
        this._parse_error("Invalid declaration", coord);
      }
      d0.decl = new c_ast.TypeDecl(ty[ty.length - 1].names[0], null, spec.alignment, null, ty[ty.length - 1].coord);
      ty.pop();
    } else if (!(d0.decl instanceof c_ast.Enum || d0.decl instanceof c_ast.Struct || d0.decl instanceof c_ast.Union || d0.decl instanceof c_ast.IdentifierType)) {
      let decls_0_tail = d0.decl;
      while (!(decls_0_tail instanceof c_ast.TypeDecl)) decls_0_tail = decls_0_tail.type;
      if (decls_0_tail.declname === null || decls_0_tail.declname === undefined) {
        decls_0_tail.declname = spec.type[spec.type.length - 1].names[0];
        spec.type.pop();
      }
    }

    for (const decl of decls) {
      pyassert(decl.decl !== null && decl.decl !== undefined);
      const attrs = spec.attr.concat(decl.attr || []);
      let declaration;
      if (is_typedef) {
        declaration = new c_ast.Typedef(null, spec.qual, spec.storage, attrs, decl.decl, decl.decl.coord);
      } else {
        declaration = new c_ast.Decl(
          null, spec.qual, spec.alignment, spec.storage, spec.function, attrs, decl.decl,
          decl.init ?? null, decl.bitsize ?? null, decl.asmlabel ?? null, decl.decl.coord,
        );
      }
      let fixed_decl;
      const dt = declaration.type;
      if (dt instanceof c_ast.Enum || dt instanceof c_ast.Struct || dt instanceof c_ast.Union || dt instanceof c_ast.IdentifierType) {
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

  _select_struct_union_class(token) {
    return token === "struct" ? c_ast.Struct : c_ast.Union;
  }

  // ---------------------------------------------------------------- grammar actions

  p_translation_unit_or_empty(p) {
    p[0] = p[1] === null ? new c_ast.FileAST([]) : new c_ast.FileAST(p[1]);
  }
  p_translation_unit_1(p) {
    p[0] = p[1];
  }
  p_translation_unit_2(p) {
    p[1].push(...p[2]);
    p[0] = p[1];
  }
  p_external_declaration_1(p) {
    p[0] = [p[1]];
  }
  p_external_declaration_2(p) {
    p[0] = p[1];
  }
  p_external_declaration_3(p) {
    p[0] = [p[1]];
  }
  p_external_declaration_4(p) {
    p[0] = [];
  }
  p_external_declaration_5(p) {
    p[0] = p[1];
  }
  p_external_declaration_6(p) {
    p[0] = [p[1]];
  }
  p_global_asm(p) {
    p[0] = new c_ast.Asm([], p[3], [], [], [], [], this._token_coord(p, 1));
  }
  p_static_assert_declaration(p) {
    if (p.length === 5) p[0] = [new c_ast.StaticAssert(p[3], null, this._token_coord(p, 1))];
    else p[0] = [new c_ast.StaticAssert(p[3], p[5], this._token_coord(p, 1))];
  }
  p_pp_directive(p) {
    this._parse_error("Directives not supported yet", this._token_coord(p, 1));
  }
  p_pppragma_directive(p) {
    if (p.length === 5) p[0] = new c_ast.Pragma(p[3], this._token_coord(p, 2));
    else if (p.length === 3) p[0] = new c_ast.Pragma(p[2], this._token_coord(p, 2));
    else p[0] = new c_ast.Pragma("", this._token_coord(p, 1));
  }
  p_pppragma_directive_list(p) {
    p[0] = p.length === 2 ? [p[1]] : p[1].concat([p[2]]);
  }
  p_function_definition_1(p) {
    const tp = new c_ast.IdentifierType(["int"], this._token_coord(p, 1));
    const spec = this._add_declaration_specifier(null, tp, "type");
    p[0] = this._build_function_definition(spec, p[1], p[2], p[3]);
  }
  p_function_definition_2(p) {
    p[0] = this._build_function_definition(p[1], p[2], p[3], p[4]);
  }
  p_statement(p) {
    p[0] = p[1];
  }
  p_pragmacomp_or_statement(p) {
    if (p.length === 3) p[0] = new c_ast.Compound(p[1].concat([p[2]]), this._token_coord(p, 1));
    else p[0] = p[1];
  }
  p_decl_body(p) {
    const spec = p[1];
    let decls;
    if (p[2] === null) {
      const ty = spec.type;
      if (ty.length === 1 && (ty[0] instanceof c_ast.Struct || ty[0] instanceof c_ast.Union || ty[0] instanceof c_ast.Enum)) {
        decls = [new c_ast.Decl(null, spec.qual, spec.alignment, spec.storage, spec.function, spec.attr, ty[0], null, null, null, ty[0].coord)];
      } else {
        decls = this._build_declarations(spec, [{ decl: null, init: null }], true);
      }
    } else {
      decls = this._build_declarations(spec, p[2], true);
    }
    p[0] = decls;
  }
  p_declaration(p) {
    p[0] = p[1];
  }
  p_declaration_list(p) {
    p[0] = p.length === 2 ? p[1] : p[1].concat(p[2]);
  }
  p_declaration_specifiers_no_type_1(p) {
    p[0] = this._add_declaration_specifier(p[2], p[1], "qual");
  }
  p_declaration_specifiers_no_type_2(p) {
    p[0] = this._add_declaration_specifier(p[2], p[1], "storage");
  }
  p_declaration_specifiers_no_type_3(p) {
    p[0] = this._add_declaration_specifier(p[2], p[1], "function");
  }
  p_declaration_specifiers_no_type_4(p) {
    p[0] = this._add_declaration_specifier(p[2], p[1], "type");
  }
  p_declaration_specifiers_no_type_5(p) {
    p[0] = this._add_declaration_specifier(p[2], p[1], "alignment");
  }
  p_declaration_specifiers_no_type_attrs(p) {
    p[0] = this._add_declaration_specifier_list(p[2], p[1], "attr");
  }
  p_declaration_specifiers_1(p) {
    p[0] = this._add_declaration_specifier(p[1], p[2], "qual", true);
  }
  p_declaration_specifiers_2(p) {
    p[0] = this._add_declaration_specifier(p[1], p[2], "storage", true);
  }
  p_declaration_specifiers_3(p) {
    p[0] = this._add_declaration_specifier(p[1], p[2], "function", true);
  }
  p_declaration_specifiers_4(p) {
    p[0] = this._add_declaration_specifier(p[1], p[2], "type", true);
  }
  p_declaration_specifiers_5(p) {
    p[0] = this._add_declaration_specifier(null, p[1], "type");
  }
  p_declaration_specifiers_6(p) {
    p[0] = this._add_declaration_specifier(p[1], p[2], "type", true);
  }
  p_declaration_specifiers_7(p) {
    p[0] = this._add_declaration_specifier(p[1], p[2], "alignment", true);
  }
  p_declaration_specifiers_attrs(p) {
    p[0] = this._add_declaration_specifier_list(p[1], p[2], "attr", true);
  }
  p_storage_class_specifier(p) {
    p[0] = p[1];
  }
  p_function_specifier(p) {
    p[0] = p[1].replaceAll("__", "");
  }
  p_type_specifier_no_typeid(p) {
    p[0] = new c_ast.IdentifierType([p[1]], this._token_coord(p, 1));
  }
  p_type_specifier(p) {
    p[0] = p[1];
  }
  p_type_specifier_gnu_typeof(p) {
    p[0] = new c_ast.Typeof(p[3], this._token_coord(p, 1));
  }
  p_atomic_specifier(p) {
    const typ = p[3];
    typ.quals.push("_Atomic");
    p[0] = typ;
  }
  p_type_qualifier(p) {
    p[0] = p[1].replaceAll("__", "");
  }
  p_init_declarator_list(p) {
    p[0] = p.length === 4 ? p[1].concat([p[3]]) : [p[1]];
  }
  p_init_declarator(p) {
    p[0] = { decl: p[1], asmlabel: p[2], attr: p[3], init: p.length > 4 && p[4] === "=" ? p[5] : null };
  }
  p_id_init_declarator_list(p) {
    p[0] = p.length === 4 ? p[1].concat([p[3]]) : [p[1]];
  }
  p_id_init_declarator(p) {
    p[0] = { decl: p[1], asmlabel: p[2], attr: p[3], init: p.length > 4 ? p[5] : null };
  }
  p_specifier_qualifier_list_1(p) {
    p[0] = this._add_declaration_specifier(p[1], p[2], "type", true);
  }
  p_specifier_qualifier_list_2(p) {
    p[0] = this._add_declaration_specifier(p[1], p[2], "qual", true);
  }
  p_specifier_qualifier_list_3(p) {
    p[0] = this._add_declaration_specifier(null, p[1], "type");
  }
  p_specifier_qualifier_list_4(p) {
    p[0] = this._add_declaration_specifier(p[1], p[2], "type");
  }
  p_specifier_qualifier_list_5(p) {
    p[0] = this._add_declaration_specifier(null, p[1], "alignment");
  }
  p_specifier_qualifier_list_6(p) {
    p[0] = this._add_declaration_specifier(p[1], p[2], "alignment", true);
  }
  p_specifier_qualifier_list_attr(p) {
    p[0] = this._add_declaration_specifier_list(p[1], p[2], "attr", true);
  }
  p_struct_or_union_specifier_1(p) {
    const klass = this._select_struct_union_class(p[1]);
    p[0] = new klass(p[2], [], null, this._token_coord(p, 2));
  }
  p_struct_or_union_specifier_2(p) {
    const klass = this._select_struct_union_class(p[1]);
    p[0] = new klass(null, (p[2] || []).concat(p[p.length - 1] || []), p.length === 6 ? [] : p[4], this._token_coord(p, 3));
  }
  p_struct_or_union_specifier_3(p) {
    const klass = this._select_struct_union_class(p[1]);
    p[0] = new klass(p[2][0], p[2][1].concat(p[p.length - 1] || []), p.length === 6 ? [] : p[4], p[2][2]);
  }
  p_struct_or_union(p) {
    p[0] = p[1];
  }
  p_struct_declaration_list(p) {
    if (p.length === 2) p[0] = p[1] || [];
    else p[0] = p[1].concat(p[2] || []);
  }
  p_struct_declaration_1(p) {
    const spec = p[1];
    pyassert(!spec.storage.includes("typedef"));
    let decls;
    if (p[2] !== null) {
      decls = this._build_declarations(spec, p[2]);
    } else if (spec.type.length === 1) {
      const node = spec.type[0];
      const decl_type = node instanceof c_ast.Node ? node : new c_ast.IdentifierType(node);
      decls = this._build_declarations(spec, [{ decl: decl_type }]);
    } else {
      decls = this._build_declarations(spec, [{ decl: null, init: null }]);
    }
    p[0] = decls;
  }
  p_struct_declaration_2(p) {
    p[0] = null;
  }
  p_struct_declaration_3(p) {
    p[0] = [p[1]];
  }
  p_struct_declarator_list(p) {
    p[0] = p.length === 4 ? p[1].concat([p[3]]) : [p[1]];
  }
  p_struct_declarator_1(p) {
    p[0] = { decl: p[1], attr: p[2], bitsize: null };
  }
  p_struct_declarator_2(p) {
    if (p.length > 4) p[0] = { decl: p[1], attr: p[2], bitsize: p[4] };
    else p[0] = { decl: new c_ast.TypeDecl(null, null, null, null), attr: p[1], bitsize: p[3] };
  }
  p_enum_specifier_1(p) {
    p[0] = new c_ast.Enum(p[2], [], null, this._token_coord(p, 1));
  }
  p_enum_specifier_2(p) {
    p[0] = new c_ast.Enum(null, (p[2] || []).concat(p[6] || []), p[4], this._token_coord(p, 1));
  }
  p_enum_specifier_3(p) {
    p[0] = new c_ast.Enum(p[2][0], p[2][1].concat(p[6] || []), p[4], this._token_coord(p, 1));
  }
  p_enumerator_list(p) {
    if (p.length === 2) p[0] = new c_ast.EnumeratorList([p[1]], p[1].coord);
    else if (p.length === 3) p[0] = p[1];
    else {
      p[1].enumerators.push(p[3]);
      p[0] = p[1];
    }
  }
  p_alignment_specifier(p) {
    p[0] = new c_ast.Alignas(p[3], this._token_coord(p, 1));
  }
  p_enumerator(p) {
    let enumerator;
    if (p.length === 3) enumerator = new c_ast.Enumerator(p[1], p[2] || [], null, this._token_coord(p, 1));
    else enumerator = new c_ast.Enumerator(p[1], p[2] || [], p[4], this._token_coord(p, 1));
    this._add_identifier(enumerator.name, enumerator.coord);
    p[0] = enumerator;
  }
  p_declarator(p) {
    p[0] = p[1];
  }

  // Parameterized declarator rules (xxx = id / typeid / typeid_noparen).
  _p_xxx_declarator_1(p) {
    p[0] = p[1];
  }
  _p_xxx_declarator_2(p) {
    p[0] = this._type_modify_decl(p[2], p[1]);
  }
  _p_direct_xxx_declarator_1(p) {
    p[0] = new c_ast.TypeDecl(p[1], null, null, null, this._token_coord(p, 1));
  }
  _p_direct_xxx_declarator_2(p) {
    p[0] = p[2];
  }
  _p_direct_xxx_declarator_3(p) {
    const quals = (p.length > 5 ? p[3] : []) || [];
    const arr = new c_ast.ArrayDecl(null, p.length > 5 ? p[4] : p[3], quals, p[1].coord);
    p[0] = this._type_modify_decl(p[1], arr);
  }
  _p_direct_xxx_declarator_4(p) {
    const listed_quals = [p[3], p[4]].map((item) => (isList(item) ? item : [item]));
    const dim_quals = listed_quals.flat().filter((q) => q !== null && q !== undefined);
    const arr = new c_ast.ArrayDecl(null, p[5], dim_quals, p[1].coord);
    p[0] = this._type_modify_decl(p[1], arr);
  }
  _p_direct_xxx_declarator_5(p) {
    const arr = new c_ast.ArrayDecl(null, new c_ast.ID(p[4], this._token_coord(p, 4)), p[3] !== null ? p[3] : [], p[1].coord);
    p[0] = this._type_modify_decl(p[1], arr);
  }
  _p_direct_xxx_declarator_6(p) {
    const func = new c_ast.FuncDecl(p[3], null, p[1].coord);
    if (this._get_yacc_lookahead_token().type === "LBRACE") {
      if (func.args !== null) {
        for (const param of func.args.params) {
          if (param instanceof c_ast.EllipsisParam) break;
          this._add_identifier(param.name, param.coord);
        }
      }
    }
    p[0] = this._type_modify_decl(p[1], func);
  }

  p_pointer(p) {
    const coord = this._token_coord(p, 1);
    const nested_type = new c_ast.PtrDecl(p[2] || [], null, coord);
    if (p.length > 3) {
      let tail_type = p[3];
      while (tail_type.type !== null) tail_type = tail_type.type;
      tail_type.type = nested_type;
      p[0] = p[3];
    } else {
      p[0] = nested_type;
    }
  }
  p_type_qualifier_list(p) {
    p[0] = p.length === 2 ? [p[1]] : p[1].concat([p[2]]);
  }
  p_type_qualifier_list_1(p) {
    p[0] = this._add_declaration_specifier(null, p[1], "qual", true);
  }
  p_type_qualifier_list_2(p) {
    p[0] = this._add_declaration_specifier(p[1], p[2], "qual", true);
  }
  p_type_qualifier_list_3(p) {
    p[0] = this._add_declaration_specifier_list(null, p[1], "attr", true);
  }
  p_type_qualifier_list_4(p) {
    p[0] = this._add_declaration_specifier_list(p[1], p[2], "attr", true);
  }
  p_parameter_type_list(p) {
    if (p.length > 2) p[1].params.push(new c_ast.EllipsisParam(this._token_coord(p, 3)));
    p[0] = p[1];
  }
  p_parameter_list(p) {
    if (p.length === 2) p[0] = new c_ast.ParamList([p[1]], p[1].coord);
    else {
      p[1].params.push(p[3]);
      p[0] = p[1];
    }
  }
  p_parameter_declaration_1(p) {
    let spec = p[1];
    if (truthy(p[3])) spec = this._add_declaration_specifier_list(spec, p[3], "attr", true);
    if (!spec.type.length) spec.type = [new c_ast.IdentifierType(["int"], this._token_coord(p, 1))];
    p[0] = this._build_declarations(spec, [{ decl: p[2] }])[0];
  }
  p_parameter_declaration_2(p) {
    let spec = p[1];
    if (truthy(p[3])) spec = this._add_declaration_specifier_list(spec, p[3], "attr", true);
    if (!spec.type.length) spec.type = [new c_ast.IdentifierType(["int"], this._token_coord(p, 1))];
    let decl;
    const ty = spec.type;
    if (ty.length > 1 && ty[ty.length - 1].names.length === 1 && this._is_type_in_scope(ty[ty.length - 1].names[0])) {
      decl = this._build_declarations(spec, [{ decl: p[2], init: null }])[0];
    } else {
      decl = new c_ast.Typename("", spec.qual, null, spec.attr, p[2] || new c_ast.TypeDecl(null, null, null, null), this._token_coord(p, 2));
      decl = this._fix_decl_name_type(decl, spec.type);
    }
    p[0] = decl;
  }
  p_identifier_list(p) {
    if (p.length === 2) p[0] = new c_ast.ParamList([p[1]], p[1].coord);
    else {
      p[1].params.push(p[3]);
      p[0] = p[1];
    }
  }
  p_initializer_1(p) {
    p[0] = p[1];
  }
  p_initializer_2(p) {
    if (p[2] === null) p[0] = new c_ast.InitList([], this._token_coord(p, 1));
    else p[0] = p[2];
  }
  p_initializer_list(p) {
    if (p.length === 3) {
      const init = p[1] === null ? p[2] : new c_ast.NamedInitializer(p[1], p[2]);
      p[0] = new c_ast.InitList([init], p[2].coord);
    } else {
      const init = p[3] === null ? p[4] : new c_ast.NamedInitializer(p[3], p[4]);
      p[1].exprs.push(init);
      p[0] = p[1];
    }
  }
  p_designation(p) {
    p[0] = p[1];
  }
  p_designator_list(p) {
    p[0] = p.length === 2 ? [p[1]] : p[1].concat([p[2]]);
  }
  p_designator(p) {
    p[0] = p[2];
  }
  p_range_designator(p) {
    p[0] = new c_ast.Range(p[2], p[4], this._token_coord(p, 1));
  }
  p_type_name(p) {
    const typename = new c_ast.Typename("", p[1].qual.slice(), null, p[1].attr, p[2] || new c_ast.TypeDecl(null, null, null, null), this._token_coord(p, 2));
    p[0] = this._fix_decl_name_type(typename, p[1].type);
  }
  p_abstract_declarator_1(p) {
    const dummytype = new c_ast.TypeDecl(null, null, null, null);
    p[0] = this._type_modify_decl(dummytype, p[1]);
  }
  p_abstract_declarator_2(p) {
    p[0] = this._type_modify_decl(p[2], p[1]);
  }
  p_abstract_declarator_3(p) {
    p[0] = p[1];
  }
  p_direct_abstract_declarator_1(p) {
    p[0] = p[2];
  }
  p_direct_abstract_declarator_2(p) {
    const arr = new c_ast.ArrayDecl(null, p[3], [], p[1].coord);
    p[0] = this._type_modify_decl(p[1], arr);
  }
  p_direct_abstract_declarator_3(p) {
    const quals = (p.length > 4 ? p[2] : []) || [];
    p[0] = new c_ast.ArrayDecl(new c_ast.TypeDecl(null, null, null, null), p.length > 4 ? p[3] : p[2], quals, this._token_coord(p, 1));
  }
  p_direct_abstract_declarator_4(p) {
    const arr = new c_ast.ArrayDecl(null, new c_ast.ID(p[3], this._token_coord(p, 3)), [], p[1].coord);
    p[0] = this._type_modify_decl(p[1], arr);
  }
  p_direct_abstract_declarator_5(p) {
    p[0] = new c_ast.ArrayDecl(new c_ast.TypeDecl(null, null, null, null), new c_ast.ID(p[3], this._token_coord(p, 3)), [], this._token_coord(p, 1));
  }
  p_direct_abstract_declarator_6(p) {
    const func = new c_ast.FuncDecl(p[3], null, p[1].coord);
    p[0] = this._type_modify_decl(p[1], func);
  }
  p_direct_abstract_declarator_7(p) {
    p[0] = new c_ast.FuncDecl(p[2], new c_ast.TypeDecl(null, null, null, null), this._token_coord(p, 1));
  }
  p_direct_abstract_declarator_8(p) {
    const listed_quals = [p[2], p[3]].map((item) => (isList(item) ? item : [item]));
    const quals = listed_quals.flat().filter((q) => q !== null && q !== undefined);
    p[0] = new c_ast.ArrayDecl(new c_ast.TypeDecl(null, null, null, null), p[4], quals, this._token_coord(p, 1));
  }
  p_block_item(p) {
    p[0] = isList(p[1]) ? p[1] : [p[1]];
  }
  p_block_item_list(p) {
    const empty = isList(p[2]) && p[2].length === 1 && p[2][0] === null;
    p[0] = p.length === 2 || empty ? p[1] : p[1].concat(p[2]);
  }
  p_compound_statement_1(p) {
    p[0] = new c_ast.Compound(p[2], this._token_coord(p, 1));
  }
  p_labeled_statement_1(p) {
    p[0] = new c_ast.Label(p[1], p[3], this._token_coord(p, 1));
  }
  p_labeled_statement_2(p) {
    p[0] = new c_ast.Case(p[2], [p[4]], this._token_coord(p, 1));
  }
  p_labeled_statement_range(p) {
    p[0] = new c_ast.Case(new c_ast.Range(p[2], p[4], this._token_coord(p, 2)), [p[6]], this._token_coord(p, 1));
  }
  p_labeled_statement_3(p) {
    p[0] = new c_ast.Default([p[3]], this._token_coord(p, 1));
  }
  p_labeled_statement_4(p) {
    p[0] = new c_ast.Label(p[1], new c_ast.EmptyStatement(this._token_coord(p, 1)), this._token_coord(p, 1));
  }
  p_labeled_statement_5(p) {
    p[0] = new c_ast.Case(p[2], [new c_ast.EmptyStatement(this._token_coord(p, 2))], this._token_coord(p, 1));
  }
  p_labeled_statement_range_2(p) {
    p[0] = new c_ast.Case(new c_ast.Range(p[2], p[4], this._token_coord(p, 2)), [new c_ast.EmptyStatement(this._token_coord(p, 2))], this._token_coord(p, 1));
  }
  p_labeled_statement_6(p) {
    p[0] = new c_ast.Default([new c_ast.EmptyStatement(this._token_coord(p, 1))], this._token_coord(p, 1));
  }
  p_selection_statement_1(p) {
    p[0] = new c_ast.If(p[3], p[5], null, this._token_coord(p, 1));
  }
  p_selection_statement_2(p) {
    p[0] = new c_ast.If(p[3], p[5], p[7], this._token_coord(p, 1));
  }
  p_selection_statement_3(p) {
    p[0] = fix_switch_cases(new c_ast.Switch(p[3], p[5], this._token_coord(p, 1)));
  }
  p_iteration_statement_1(p) {
    p[0] = new c_ast.While(p[3], p[5], this._token_coord(p, 1));
  }
  p_iteration_statement_2(p) {
    p[0] = new c_ast.DoWhile(p[5], p[2], this._token_coord(p, 1));
  }
  p_iteration_statement_3(p) {
    p[0] = new c_ast.For(p[3], p[5], p[7], p[9], this._token_coord(p, 1));
  }
  p_iteration_statement_4(p) {
    p[0] = new c_ast.For(new c_ast.DeclList(p[3], this._token_coord(p, 1)), p[4], p[6], p[8], this._token_coord(p, 1));
  }
  p_jump_statement_1(p) {
    p[0] = new c_ast.Goto(p[2], this._token_coord(p, 1));
  }
  p_jump_statement_2(p) {
    p[0] = new c_ast.Break(this._token_coord(p, 1));
  }
  p_jump_statement_3(p) {
    p[0] = new c_ast.Continue(this._token_coord(p, 1));
  }
  p_jump_statement_4(p) {
    p[0] = new c_ast.Return(p.length === 4 ? p[2] : null, this._token_coord(p, 1));
  }
  p_expression_statement(p) {
    if (p[1] === null) p[0] = new c_ast.EmptyStatement(this._token_coord(p, 2));
    else p[0] = p[1];
  }
  p_expression(p) {
    if (p.length === 2) p[0] = p[1];
    else {
      if (!(p[1] instanceof c_ast.ExprList)) p[1] = new c_ast.ExprList([p[1]], p[1].coord);
      p[1].exprs.push(p[3]);
      p[0] = p[1];
    }
  }
  p_parenthesized_compound_expression(p) {
    p[0] = p[2];
  }
  p_typedef_name(p) {
    p[0] = new c_ast.IdentifierType([p[1]], this._token_coord(p, 1));
  }
  p_assignment_expression(p) {
    if (p.length === 2) p[0] = p[1];
    else p[0] = new c_ast.Assignment(p[2], p[1], p[3], p[1].coord);
  }
  p_assignment_operator(p) {
    p[0] = p[1];
  }
  p_constant_expression(p) {
    p[0] = p[1];
  }
  p_conditional_expression(p) {
    if (p.length === 2) p[0] = p[1];
    else p[0] = new c_ast.TernaryOp(p[1], p[3], p[5], p[1].coord);
  }
  p_binary_expression(p) {
    if (p.length === 2) p[0] = p[1];
    else p[0] = new c_ast.BinaryOp(p[2], p[1], p[3], p[1].coord);
  }
  p_cast_expression_2(p) {
    p[0] = new c_ast.Cast(p[2], p[4], this._token_coord(p, 1));
  }
  p_unary_expression_1(p) {
    p[0] = p[1];
  }
  p_unary_expression_2(p) {
    p[0] = new c_ast.UnaryOp(p[1], p[2], p[2].coord);
  }
  p_unary_expression_3(p) {
    p[0] = new c_ast.UnaryOp(p[1].replaceAll("__alignof", "_Alignof").replaceAll("__", ""), p.length === 3 ? p[2] : p[3], this._token_coord(p, 1));
  }
  p_unary_operator(p) {
    p[0] = p[1];
  }
  p_postfix_expression_1(p) {
    p[0] = p[1];
  }
  p_postfix_expression_2(p) {
    p[0] = new c_ast.ArrayRef(p[1], p[3], p[1].coord);
  }
  p_postfix_expression_3(p) {
    p[0] = new c_ast.FuncCall(p[1], p.length === 5 ? p[3] : null, p[1].coord);
  }
  p_postfix_expression_4(p) {
    const field = new c_ast.ID(p[3], this._token_coord(p, 3));
    p[0] = new c_ast.StructRef(p[1], p[2], field, p[1].coord);
  }
  p_postfix_expression_5(p) {
    p[0] = new c_ast.UnaryOp("p" + p[2], p[1], p[1].coord);
  }
  p_postfix_expression_6(p) {
    p[0] = new c_ast.CompoundLiteral(p[2], p[5]);
  }
  p_primary_expression_1(p) {
    p[0] = p[1];
  }
  p_primary_expression_2(p) {
    p[0] = p[1];
  }
  p_primary_expression_3(p) {
    p[0] = p[1];
  }
  p_primary_expression_4(p) {
    p[0] = p[2];
  }
  p_primary_expression_5(p) {
    const coord = this._token_coord(p, 1);
    p[0] = new c_ast.FuncCall(new c_ast.ID(p[1], coord), new c_ast.ExprList([p[3], p[5]], coord), coord);
  }
  p_offsetof_member_designator(p) {
    if (p.length === 2) p[0] = p[1];
    else if (p.length === 4) p[0] = new c_ast.StructRef(p[1], p[2], p[3], p[1].coord);
    else if (p.length === 5) p[0] = new c_ast.ArrayRef(p[1], p[3], p[1].coord);
    else throw new Error(`NotImplementedError: Unexpected parsing state. len(p): ${p.length}`);
  }
  p_argument_expression_list(p) {
    if (p.length === 2) p[0] = new c_ast.ExprList([p[1]], p[1].coord);
    else {
      p[1].exprs.push(p[3]);
      p[0] = p[1];
    }
  }
  p_identifier(p) {
    p[0] = new c_ast.ID(p[1], this._token_coord(p, 1));
  }
  p_constant_1(p) {
    let uCount = 0;
    let lCount = 0;
    for (const x of p[1].slice(-3)) {
      if (x === "l" || x === "L") lCount += 1;
      else if (x === "u" || x === "U") uCount += 1;
    }
    if (uCount > 1) throw new ValueError("Constant cannot have more than one u/U suffix.");
    else if (lCount > 2) throw new ValueError("Constant cannot have more than two l/L suffix.");
    const prefix = "unsigned ".repeat(uCount) + "long ".repeat(lCount);
    p[0] = new c_ast.Constant(prefix + "int", p[1], this._token_coord(p, 1));
  }
  p_constant_2(p) {
    const last = p[1][p[1].length - 1];
    let t;
    if (last === "f" || last === "F") t = "float";
    else if (last === "l" || last === "L") t = "long double";
    else t = "double";
    p[0] = new c_ast.Constant(t, p[1], this._token_coord(p, 1));
  }
  p_constant_3(p) {
    p[0] = new c_ast.Constant("char", p[1], this._token_coord(p, 1));
  }
  p_unified_string_literal(p) {
    if (p.length === 2) p[0] = new c_ast.Constant("string", p[1], this._token_coord(p, 1));
    else {
      p[1].value = p[1].value.slice(0, -1) + p[2].slice(1);
      p[0] = p[1];
    }
  }
  p_unified_wstring_literal(p) {
    if (p.length === 2) p[0] = new c_ast.Constant("string", p[1], this._token_coord(p, 1));
    else {
      p[1].value = rstripWs(p[1].value).slice(0, -1) + p[2].slice(2);
      p[0] = p[1];
    }
  }
  p_attrs_id_typeid(p) {
    if (p.length === 3) p[0] = [p[2], p[1], this._token_coord(p, 2)];
    else p[0] = [p[1], [], this._token_coord(p, 1)];
  }
  p_brace_open(p) {
    p[0] = p[1];
    this._slice[0].lineno = this._p_lineno(1);
  }
  p_brace_close(p) {
    p[0] = p[1];
    this._slice[0].lineno = this._p_lineno(1);
  }
  p_attr_stmt(p) {
    p[0] = new c_ast.GccAttributeStatement(p[1], this._token_coord(p, 2));
  }
  p_asm_1(p) {
    p[0] = new c_ast.Asm(p[2] || [], p[4], [], [], [], [], this._token_coord(p, 1));
  }
  p_asm_2(p) {
    p[0] = new c_ast.Asm(p[2] || [], p[4], p[6] || [], [], [], [], this._token_coord(p, 1));
  }
  p_asm_3(p) {
    p[0] = new c_ast.Asm(p[2] || [], p[4], p[6] || [], p[8] || [], [], [], this._token_coord(p, 1));
  }
  p_asm_4(p) {
    p[0] = new c_ast.Asm(p[2] || [], p[4], p[6] || [], p[8] || [], p[10] || [], [], this._token_coord(p, 1));
  }
  p_asm_5(p) {
    p[0] = new c_ast.Asm(p[2] || [], p[4], p[6] || [], p[8] || [], p[10] || [], p[12] || [], this._token_coord(p, 1));
  }
  p_asm_operands(p) {
    p[0] = p.length === 4 ? p[1].concat([p[3]]) : [p[1]];
  }
  p_asm_operand(p) {
    p[0] = new c_ast.AsmOperand(p[1], p[2], p[4], this._token_coord(p, 3));
  }
  p_asm_string_list(p) {
    p[0] = p.length === 4 ? p[1].concat([p[3]]) : [p[1]];
  }
  p_asm_goto_list(p) {
    p[0] = p.length === 4 ? p[1].concat([p[3]]) : [p[1]];
  }
  p_asm_symbolic_name(p) {
    p[0] = p[2];
  }
  p_asm_qualifiers(p) {
    p[0] = (p[1] || []).concat([p[2]]);
  }
  p_asm_label(p) {
    p[0] = p[3];
  }
  p_gcc_attributes(p) {
    p[0] = p.length === 3 ? p[1].concat(p[2]) : p[1];
  }
  p_gcc_attribute(p) {
    p[0] = p[4] || [];
  }
  p_gcc_attribute_list(p) {
    p[0] = p.length === 4 ? p[1].concat(p[3]) : p[1];
  }
  p_gcc_attribute_item(p) {
    if (!truthy(p[1])) p[0] = [];
    else {
      let name = p[1];
      if (name.length > 4 && name.startsWith("__") && name.endsWith("__")) name = name.slice(2, -2);
      let args = null;
      if (p.length > 2) args = p[3].exprs;
      p[0] = [new c_ast.GccAttribute(name, args, this._token_coord(p, 1))];
    }
  }
  p_empty(p) {
    p[0] = null;
  }
  p_error(p) {
    if (p) this._parse_error(`before: ${p.value}`, this._coord(p.lineno, p.lexpos));
    else this._parse_error("At end of input", this.clex.filename);
  }
}

// <rule>_opt : empty | <rule>
for (const rule of RULES_WITH_OPT) {
  CParser.prototype[`p_${rule}_opt`] = function (p) {
    p[0] = p[1];
  };
}

// Parameterized rules, as plyparser.template() generates them.
const PARAMS = {
  xxx_declarator_1: ["id", "typeid", "typeid_noparen"],
  xxx_declarator_2: ["id", "typeid", "typeid_noparen"],
  direct_xxx_declarator_1: ["id", "typeid", "typeid_noparen"],
  direct_xxx_declarator_2: ["id", "typeid"],
  direct_xxx_declarator_3: ["id", "typeid", "typeid_noparen"],
  direct_xxx_declarator_4: ["id", "typeid", "typeid_noparen"],
  direct_xxx_declarator_5: ["id", "typeid", "typeid_noparen"],
  direct_xxx_declarator_6: ["id", "typeid", "typeid_noparen"],
};
for (const [tmpl, xs] of Object.entries(PARAMS)) {
  for (const xxx of xs) CParser.prototype["p_" + tmpl.replace("xxx", xxx)] = CParser.prototype["_p_" + tmpl];
}

function rstripWs(s) {
  return s.replace(/[ \t\n\r\x0b\x0c]+$/, "");
}

function pyRepr(s) {
  if (typeof s !== "string") return s === null || s === undefined ? "None" : String(s);
  const q = s.includes("'") && !s.includes('"') ? '"' : "'";
  return q + s.replaceAll("\\", "\\\\").replaceAll(q, "\\" + q) + q;
}

export { ParseError };
