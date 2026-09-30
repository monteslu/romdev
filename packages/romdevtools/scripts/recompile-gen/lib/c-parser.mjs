// A C parser in plain JS that builds the same AST as pycparser 3 (node kinds,
// field names, field order and the same quirks: a Typename's name is None,
// a declarator's TypeDecl copies the declaration's qualifiers, integer
// constants keep their spelling and take their type from the u/l suffix).
// The recompile-gen scripts serialise this AST as committed data, so the
// shape is part of the data format: see NODE_FIELDS.
//
// It covers C99 statements and expressions and the declarations function
// bodies use. It does not do struct/union/enum bodies, bit-fields, or
// typedef names redeclared as ordinary identifiers; those raise an error
// (the caller records the function as unparsable) instead of producing a
// different tree.
//
// Exports:
//   parse(text)            FileAST node {_: "FileAST", ext: [...]}
//   NODE_FIELDS            per node kind: [attributes..., children...]
//   serialize(node, schema)  node -> [kind, field...] arrays, filling schema
//   walk(node, fn)         visit a node and its children (pycparser order)

import { lex } from "./c-preprocessor.mjs";

// pycparser's _c_ast.cfg: "name" is an attribute, "name*" a child node,
// "name**" a child list. Serialised field order is attributes first, then
// children, each in cfg order (what pycparser's attr_names + __slots__ give).
const CFG = {
  ArrayDecl: ["type*", "dim*", "dim_quals"],
  ArrayRef: ["name*", "subscript*"],
  Assignment: ["op", "lvalue*", "rvalue*"],
  Alignas: ["alignment*"],
  BinaryOp: ["op", "left*", "right*"],
  Break: [],
  Case: ["expr*", "stmts**"],
  Cast: ["to_type*", "expr*"],
  Compound: ["block_items**"],
  CompoundLiteral: ["type*", "init*"],
  Constant: ["type", "value"],
  Continue: [],
  Decl: ["name", "quals", "align", "storage", "funcspec", "type*", "init*", "bitsize*"],
  DeclList: ["decls**"],
  Default: ["stmts**"],
  DoWhile: ["cond*", "stmt*"],
  EllipsisParam: [],
  EmptyStatement: [],
  ExprList: ["exprs**"],
  FileAST: ["ext**"],
  For: ["init*", "cond*", "next*", "stmt*"],
  FuncCall: ["name*", "args*"],
  FuncDecl: ["args*", "type*"],
  FuncDef: ["decl*", "param_decls**", "body*"],
  Goto: ["name"],
  ID: ["name"],
  IdentifierType: ["names"],
  If: ["cond*", "iftrue*", "iffalse*"],
  InitList: ["exprs**"],
  Label: ["name", "stmt*"],
  NamedInitializer: ["name**", "expr*"],
  ParamList: ["params**"],
  PtrDecl: ["quals", "type*"],
  Return: ["expr*"],
  StructRef: ["name*", "type", "field*"],
  Switch: ["cond*", "stmt*"],
  TernaryOp: ["cond*", "iftrue*", "iffalse*"],
  TypeDecl: ["declname", "quals", "align", "type*"],
  Typedef: ["name", "quals", "storage", "type*"],
  Typename: ["name", "quals", "align", "type*"],
  UnaryOp: ["op", "expr*"],
  While: ["cond*", "stmt*"],
};

/** @type {Record<string, string[]>} */
export const NODE_FIELDS = {};
const CHILDREN = {};
for (const [k, fs] of Object.entries(CFG)) {
  const attrs = fs.filter((f) => !f.endsWith("*"));
  const kids = fs.filter((f) => f.endsWith("*")).map((f) => f.replace(/\*+$/, ""));
  NODE_FIELDS[k] = [...attrs, ...kids];
  CHILDREN[k] = kids;
}

const node = (kind, fields) => {
  const n = { _: kind };
  for (const f of NODE_FIELDS[kind]) n[f] = fields[f] === undefined ? null : fields[f];
  return n;
};

const KEYWORDS = new Set([
  "auto", "break", "case", "char", "const", "continue", "default", "do", "double", "else", "enum",
  "extern", "float", "for", "goto", "if", "inline", "int", "long", "register", "offsetof", "restrict",
  "return", "short", "signed", "sizeof", "static", "struct", "switch", "typedef", "union", "unsigned",
  "void", "volatile", "while", "_Bool", "_Complex", "_Alignas", "_Alignof", "_Atomic", "_Noreturn",
  "_Static_assert", "_Thread_local", "__int128",
]);
const STORAGE = new Set(["auto", "register", "static", "extern", "typedef", "_Thread_local"]);
const FUNCSPEC = new Set(["inline", "_Noreturn"]);
const QUALS = new Set(["const", "restrict", "volatile", "_Atomic"]);
const SIMPLE_TYPES = new Set(["void", "_Bool", "char", "short", "int", "long", "float", "double", "_Complex", "signed", "unsigned", "__int128"]);
const ASSIGN = new Set(["=", "^=", "*=", "/=", "%=", "+=", "-=", "<<=", ">>=", "&=", "|="]);
const BINPREC = {
  "||": 0, "&&": 1, "|": 2, "^": 3, "&": 4, "==": 5, "!=": 5, ">": 6, ">=": 6, "<": 6, "<=": 6,
  ">>": 7, "<<": 7, "+": 8, "-": 8, "*": 9, "/": 9, "%": 9,
};
const INT_RE = /^(?:0[xX][0-9a-fA-F]+|0[bB][01]+|0[0-7]*|[1-9][0-9]*)(?:[uU]ll|[uU]LL|ll[uU]?|LL[uU]?|[uU][lL]|[lL][uU]?|[uU])?$/;

class ParseError extends Error {}

class Parser {
  constructor(text) {
    this.toks = lex(text).map((k) => {
      if (k.t === "id") return { type: KEYWORDS.has(k.v) ? k.v : "ID", value: k.v };
      if (k.t === "num") {
        if (INT_RE.test(k.v)) return { type: "INT", value: k.v };
        return { type: "FLOAT", value: k.v };
      }
      if (k.t === "chr") return { type: "CHAR", value: k.v };
      if (k.t === "str") return { type: /^"/.test(k.v) ? "STRING" : "WSTRING", value: k.v };
      if (k.t === "p") return { type: k.v, value: k.v };
      throw new ParseError(`illegal character '${k.v}'`);
    });
    this.i = 0;
    this.typedefs = new Set();
  }

  // token access; an ID naming a typedef reads as TYPEID
  peekTok(k = 1) {
    const t = this.toks[this.i + k - 1];
    if (!t) return null;
    if (t.type === "ID" && this.typedefs.has(t.value)) return { type: "TYPEID", value: t.value };
    return t;
  }
  peek(k = 1) { return this.peekTok(k)?.type ?? null; }
  advance() {
    const t = this.peekTok();
    if (!t) throw new ParseError("At end of input");
    this.i++;
    return t;
  }
  accept(type) { return this.peek() === type ? this.advance() : null; }
  expect(type) {
    const t = this.advance();
    if (t.type !== type) throw new ParseError(`before: ${t.value}`);
    return t;
  }

  startsDeclaration(t = this.peek()) {
    return t !== null && (STORAGE.has(t) || FUNCSPEC.has(t) || QUALS.has(t) || SIMPLE_TYPES.has(t) ||
      ["TYPEID", "struct", "union", "enum", "_Alignas"].includes(t));
  }
  startsExpression(t = this.peek()) {
    return t !== null && ["ID", "(", "++", "--", "+", "-", "*", "&", "~", "!", "sizeof", "_Alignof",
      "offsetof", "INT", "FLOAT", "CHAR", "STRING", "WSTRING"].includes(t);
  }
  startsStatement() {
    const t = this.peek();
    if (t === null) return false;
    if (["{", "if", "switch", "while", "do", "for", "goto", "break", "continue", "return", "case",
      "default", ";", "_Static_assert"].includes(t)) return true;
    return this.startsExpression();
  }
  startsDeclarator(idOnly = false) {
    const t = this.peek();
    if (t === null) return false;
    if (t === "*" || t === "(") return true;
    return idOnly ? t === "ID" : t === "ID" || t === "TYPEID";
  }

  // ---------------------------------------------------------- declarations
  typeModifyDecl(decl, modifier) {
    let tail = modifier;
    while (tail.type) tail = tail.type;
    if (decl._ === "TypeDecl") { tail.type = decl; return modifier; }
    let dt = decl;
    while (dt.type._ !== "TypeDecl") dt = dt.type;
    tail.type = dt.type;
    dt.type = modifier;
    return decl;
  }

  fixDeclNameType(decl, typename) {
    let typ = decl;
    while (typ._ !== "TypeDecl") typ = typ.type;
    decl.name = typ.declname;
    typ.quals = [...decl.quals];
    for (const tn of typename) {
      if (tn._ !== "IdentifierType") {
        if (typename.length > 1) throw new ParseError("Invalid multiple types specified");
        typ.type = tn;
        return decl;
      }
    }
    if (!typename.length) {
      if (decl.type._ !== "FuncDecl") throw new ParseError("Missing type in declaration");
      typ.type = node("IdentifierType", { names: ["int"] });
    } else {
      typ.type = node("IdentifierType", { names: typename.flatMap((t) => t.names) });
    }
    return decl;
  }

  buildDeclarations(spec, decls, typedefNamespace = false) {
    const isTypedef = spec.storage.includes("typedef");
    const out = [];
    if (decls[0].bitsize == null) {
      if (decls[0].decl == null) throw new ParseError("Invalid declaration");
      if (!["Enum", "Struct", "Union", "IdentifierType"].includes(decls[0].decl._)) {
        let t = decls[0].decl;
        while (t._ !== "TypeDecl") t = t.type;
        if (t.declname == null) {
          t.declname = spec.type.at(-1).names[0];
          spec.type = spec.type.slice(0, -1);
        }
      }
    }
    for (const d of decls) {
      let decl;
      if (isTypedef) decl = node("Typedef", { name: null, quals: spec.qual, storage: spec.storage, type: d.decl });
      else decl = node("Decl", {
        name: null, quals: spec.qual, align: spec.alignment, storage: spec.storage,
        funcspec: spec.function, type: d.decl, init: d.init ?? null, bitsize: d.bitsize ?? null,
      });
      const fixed = ["Enum", "Struct", "Union", "IdentifierType"].includes(decl.type._)
        ? decl : this.fixDeclNameType(decl, spec.type);
      if (typedefNamespace) {
        if (isTypedef) this.typedefs.add(fixed.name);
        else if (this.typedefs.has(fixed.name)) throw new ParseError(`typedef name ${fixed.name} redeclared`);
      }
      out.push(fixed);
    }
    return out;
  }

  declSpecifiers() {
    const spec = { qual: [], storage: [], type: [], function: [], alignment: [] };
    let sawType = false, any = false;
    for (;;) {
      const t = this.peek();
      if (t === null) break;
      if (QUALS.has(t)) { spec.qual.push(this.advance().value); any = true; continue; }
      if (STORAGE.has(t)) { spec.storage.push(this.advance().value); any = true; continue; }
      if (FUNCSPEC.has(t)) { spec.function.push(this.advance().value); any = true; continue; }
      if (SIMPLE_TYPES.has(t)) {
        spec.type.push(node("IdentifierType", { names: [this.advance().value] }));
        sawType = true; any = true; continue;
      }
      if (t === "TYPEID") {
        if (sawType) break;
        spec.type.push(node("IdentifierType", { names: [this.advance().value] }));
        sawType = true; any = true; continue;
      }
      if (t === "struct" || t === "union" || t === "enum" || t === "_Alignas") {
        throw new ParseError(`${t} is not supported`);
      }
      break;
    }
    if (!any) throw new ParseError("Invalid declaration");
    return { spec, sawType };
  }

  specifierQualifierList() {
    const spec = { qual: [], storage: [], type: [], function: [], alignment: [] };
    let sawType = false;
    for (;;) {
      const t = this.peek();
      if (t === null) break;
      if (QUALS.has(t)) { spec.qual.push(this.advance().value); continue; }
      if (SIMPLE_TYPES.has(t)) { spec.type.push(node("IdentifierType", { names: [this.advance().value] })); sawType = true; continue; }
      if (t === "TYPEID") {
        if (sawType) break;
        spec.type.push(node("IdentifierType", { names: [this.advance().value] }));
        sawType = true;
        continue;
      }
      if (t === "struct" || t === "union" || t === "enum" || t === "_Alignas") throw new ParseError(`${t} is not supported`);
      break;
    }
    if (!sawType && !spec.qual.length) throw new ParseError("Invalid specifier list");
    return spec;
  }

  scanDeclaratorNameInfo() {
    let sawParen = false;
    while (this.accept("*")) while (QUALS.has(this.peek())) this.advance();
    const t = this.peekTok();
    if (!t) return [null, sawParen];
    if (t.type === "ID" || t.type === "TYPEID") { this.advance(); return [t.type, sawParen]; }
    if (t.type === "(") {
      sawParen = true;
      this.advance();
      const [tt, nested] = this.scanDeclaratorNameInfo();
      if (nested) sawParen = true;
      let depth = 1;
      for (;;) {
        const k = this.peek();
        if (k === null) return [null, sawParen];
        if (k === "(") depth++;
        else if (k === ")") { depth--; this.advance(); if (depth === 0) break; continue; }
        this.advance();
      }
      return [tt, sawParen];
    }
    return [null, sawParen];
  }
  peekDeclaratorNameInfo() {
    const m = this.i;
    const r = this.scanDeclaratorNameInfo();
    this.i = m;
    return r;
  }

  anyDeclarator(allowAbstract, typeidParenAsAbstract) {
    const [nameType, sawParen] = this.peekDeclaratorNameInfo();
    if (nameType === null || (typeidParenAsAbstract && nameType === "TYPEID" && sawParen)) {
      if (!allowAbstract) throw new ParseError("Invalid declarator");
      return [this.abstractDeclaratorOpt(), false];
    }
    if (nameType === "TYPEID") throw new ParseError("typedef name used as a declarator");
    return [this.declaratorKind(true), true];
  }

  declaratorKind(allowParen) {
    let ptr = null;
    if (this.peek() === "*") ptr = this.pointer();
    const direct = this.directDeclarator(allowParen);
    return ptr ? this.typeModifyDecl(direct, ptr) : direct;
  }

  directDeclarator(allowParen) {
    let decl;
    if (allowParen && this.accept("(")) {
      decl = this.declaratorKind(true);
      this.expect(")");
    } else {
      const t = this.expect("ID");
      decl = node("TypeDecl", { declname: t.value, quals: null, align: null, type: null });
    }
    return this.declSuffixes(decl);
  }

  declSuffixes(decl) {
    for (;;) {
      if (this.peek() === "[") { decl = this.typeModifyDecl(decl, this.arrayDecl(null)); continue; }
      if (this.peek() === "(") { decl = this.typeModifyDecl(decl, this.functionDecl()); continue; }
      return decl;
    }
  }

  arrayDecl(baseType) {
    this.expect("[");
    let dim = null;
    const dimQuals = [];
    while (QUALS.has(this.peek()) || this.peek() === "static") dimQuals.push(this.advance().value);
    if (this.peek() === "*" && this.peek(2) === "]") { this.advance(); dim = node("ID", { name: "*" }); }
    else if (this.startsExpression()) dim = this.assignmentExpression();
    this.expect("]");
    return node("ArrayDecl", { type: baseType, dim, dim_quals: dimQuals });
  }

  functionDecl() {
    this.expect("(");
    let args = null;
    if (!this.accept(")")) {
      if (this.startsDeclaration()) args = this.parameterTypeList();
      else if (this.peek() === ")") args = null;
      else {
        const first = node("ID", { name: this.expect("ID").value });
        args = node("ParamList", { params: [first] });
        while (this.accept(",")) args.params.push(node("ID", { name: this.expect("ID").value }));
      }
      this.expect(")");
    }
    return node("FuncDecl", { args, type: null });
  }

  pointer() {
    const stars = [];
    while (this.accept("*")) {
      const quals = [];
      while (QUALS.has(this.peek())) quals.push(this.advance().value);
      stars.push(quals);
    }
    let ptr = null;
    for (const quals of stars) ptr = node("PtrDecl", { quals, type: ptr });
    return ptr;
  }

  parameterTypeList() {
    const params = [this.parameterDeclaration()];
    while (this.peek() === "," && this.peek(2) !== "...") { this.advance(); params.push(this.parameterDeclaration()); }
    if (this.peek() === "," && this.peek(2) === "...") { this.advance(); this.advance(); params.push(node("EllipsisParam", {})); }
    return node("ParamList", { params });
  }

  parameterDeclaration() {
    const { spec } = this.declSpecifiers();
    if (!spec.type.length) spec.type = [node("IdentifierType", { names: ["int"] })];
    if (this.startsDeclarator()) {
      const [decl, named] = this.anyDeclarator(true, true);
      if (named) return this.buildDeclarations(spec, [{ decl, init: null, bitsize: null }])[0];
      return this.buildParameterDeclaration(spec, decl);
    }
    return this.buildParameterDeclaration(spec, this.abstractDeclaratorOpt());
  }

  buildParameterDeclaration(spec, decl) {
    const last = spec.type.at(-1);
    if (spec.type.length > 1 && last.names?.length === 1 && this.typedefs.has(last.names[0])) {
      return this.buildDeclarations(spec, [{ decl, init: null, bitsize: null }])[0];
    }
    const tn = node("Typename", {
      name: "", quals: spec.qual, align: null,
      type: decl || node("TypeDecl", { declname: null, quals: null, align: null, type: null }),
    });
    return this.fixDeclNameType(tn, spec.type);
  }

  typeName() {
    const spec = this.specifierQualifierList();
    const decl = this.abstractDeclaratorOpt();
    const tn = node("Typename", {
      name: "", quals: [...spec.qual], align: null,
      type: decl || node("TypeDecl", { declname: null, quals: null, align: null, type: null }),
    });
    return this.fixDeclNameType(tn, spec.type);
  }

  abstractDeclaratorOpt() {
    if (this.peek() === "*") {
      const ptr = this.pointer();
      const decl = this.peek() === "(" || this.peek() === "["
        ? this.directAbstractDeclarator()
        : node("TypeDecl", { declname: null, quals: null, align: null, type: null });
      return this.typeModifyDecl(decl, ptr);
    }
    if (this.peek() === "(" || this.peek() === "[") return this.directAbstractDeclarator();
    return null;
  }

  directAbstractDeclarator() {
    let decl;
    if (this.accept("(")) {
      if (this.startsDeclaration() || this.peek() === ")") {
        const params = this.peek() === ")" ? null : this.parameterTypeList();
        this.expect(")");
        decl = node("FuncDecl", { args: params, type: node("TypeDecl", { declname: null, quals: null, align: null, type: null }) });
      } else {
        decl = this.abstractDeclaratorOpt();
        this.expect(")");
      }
    } else if (this.peek() === "[") {
      decl = this.arrayDecl(node("TypeDecl", { declname: null, quals: null, align: null, type: null }));
    } else throw new ParseError("Invalid abstract declarator");
    return this.declSuffixes(decl);
  }

  initDeclaratorList(first = null, idOnly = false) {
    const decls = [first ?? this.initDeclarator(idOnly)];
    while (this.accept(",")) decls.push(this.initDeclarator(idOnly));
    return decls;
  }
  initDeclarator(idOnly) {
    const decl = idOnly ? this.declaratorKind(true) : this.anyDeclarator(false, false)[0];
    let init = null;
    if (this.accept("=")) init = this.initializer();
    return { decl, init, bitsize: null };
  }

  declBodyWithSpec(spec, sawType) {
    let decls = null;
    if (sawType) { if (this.startsDeclarator()) decls = this.initDeclaratorList(); }
    else if (this.startsDeclarator(true)) decls = this.initDeclaratorList(null, true);
    if (decls === null) throw new ParseError("Invalid declaration");
    return this.buildDeclarations(spec, decls, true);
  }

  declaration() {
    const { spec, sawType } = this.declSpecifiers();
    const decls = this.declBodyWithSpec(spec, sawType);
    this.expect(";");
    return decls;
  }

  externalDeclaration() {
    if (this.peek() === null) return [];
    if (this.accept(";")) return [];
    if (!this.startsDeclaration()) {
      const decl = this.declaratorKind(true);
      if (this.peek() !== "{") throw new ParseError("Invalid function definition");
      const spec = { qual: [], alignment: [], storage: [], type: [node("IdentifierType", { names: ["int"] })], function: [] };
      return [this.functionDefinition(spec, decl, null)];
    }
    const { spec, sawType } = this.declSpecifiers();
    const [nameType] = this.peekDeclaratorNameInfo();
    if (nameType !== "ID") {
      const decls = this.declBodyWithSpec(spec, sawType);
      this.expect(";");
      return decls;
    }
    const decl = this.declaratorKind(true);
    if (this.peek() === "{" || this.startsDeclaration()) {
      let paramDecls = null;
      if (this.startsDeclaration()) {
        paramDecls = [];
        while (this.startsDeclaration()) paramDecls.push(...this.declaration());
      }
      if (this.peek() !== "{") throw new ParseError("Invalid function definition");
      if (!spec.type.length) spec.type = [node("IdentifierType", { names: ["int"] })];
      return [this.functionDefinition(spec, decl, paramDecls)];
    }
    const first = { decl, init: null, bitsize: null };
    if (this.accept("=")) first.init = this.initializer();
    const decls = this.buildDeclarations(spec, this.initDeclaratorList(first), true);
    this.expect(";");
    return decls;
  }

  functionDefinition(spec, decl, paramDecls) {
    if (spec.storage.includes("typedef")) throw new ParseError("Invalid typedef");
    const d = this.buildDeclarations(spec, [{ decl, init: null, bitsize: null }], true)[0];
    return node("FuncDef", { decl: d, param_decls: paramDecls, body: this.compoundStatement() });
  }

  // ------------------------------------------------------------ statements
  statement() {
    const t = this.peek();
    if (t === "case" || t === "default" || (t === "ID" && this.peek(2) === ":")) return this.labeledStatement();
    if (t === "{") return this.compoundStatement();
    if (t === "if" || t === "switch") return this.selectionStatement();
    if (t === "while" || t === "do" || t === "for") return this.iterationStatement();
    if (t === "goto" || t === "break" || t === "continue" || t === "return") return this.jumpStatement();
    if (t === "_Static_assert") throw new ParseError("_Static_assert is not supported");
    return this.expressionStatement();
  }

  labeledStatement() {
    const t = this.advance();
    if (t.type === "ID") {
      this.expect(":");
      const stmt = this.startsStatement() ? this.statement() : node("EmptyStatement", {});
      return node("Label", { name: t.value, stmt });
    }
    if (t.type === "case") {
      const expr = this.conditionalExpression();
      this.expect(":");
      const stmt = this.startsStatement() ? this.statement() : node("EmptyStatement", {});
      return node("Case", { expr, stmts: [stmt] });
    }
    this.expect(":");
    const stmt = this.startsStatement() ? this.statement() : node("EmptyStatement", {});
    return node("Default", { stmts: [stmt] });
  }

  blockItem() { return this.startsDeclaration() ? this.declaration() : this.statement(); }

  compoundStatement() {
    this.expect("{");
    if (this.accept("}")) return node("Compound", { block_items: null });
    const items = [];
    while (this.peek() !== "}" && this.peek() !== null) {
      const it = this.blockItem();
      if (Array.isArray(it)) items.push(...it); else items.push(it);
    }
    this.expect("}");
    return node("Compound", { block_items: items });
  }

  selectionStatement() {
    const t = this.advance();
    this.expect("(");
    const cond = this.expression();
    this.expect(")");
    const stmt = this.statement();
    if (t.type === "if") {
      if (this.accept("else")) return node("If", { cond, iftrue: stmt, iffalse: this.statement() });
      return node("If", { cond, iftrue: stmt, iffalse: null });
    }
    return fixSwitchCases(node("Switch", { cond, stmt }));
  }

  iterationStatement() {
    const t = this.advance();
    if (t.type === "while") {
      this.expect("(");
      const cond = this.expression();
      this.expect(")");
      return node("While", { cond, stmt: this.statement() });
    }
    if (t.type === "do") {
      const stmt = this.statement();
      this.expect("while");
      this.expect("(");
      const cond = this.expression();
      this.expect(")");
      this.expect(";");
      return node("DoWhile", { cond, stmt });
    }
    this.expect("(");
    let init;
    if (this.startsDeclaration()) init = node("DeclList", { decls: this.declaration() });
    else { init = this.expressionOpt(); this.expect(";"); }
    const cond = this.expressionOpt();
    this.expect(";");
    const next = this.expressionOpt();
    this.expect(")");
    return node("For", { init, cond, next, stmt: this.statement() });
  }

  jumpStatement() {
    const t = this.advance();
    if (t.type === "goto") { const n = this.expect("ID"); this.expect(";"); return node("Goto", { name: n.value }); }
    if (t.type === "break") { this.expect(";"); return node("Break", {}); }
    if (t.type === "continue") { this.expect(";"); return node("Continue", {}); }
    if (this.accept(";")) return node("Return", { expr: null });
    const expr = this.expression();
    this.expect(";");
    return node("Return", { expr });
  }

  expressionStatement() {
    const expr = this.expressionOpt();
    this.expect(";");
    return expr === null ? node("EmptyStatement", {}) : expr;
  }

  // ----------------------------------------------------------- expressions
  expressionOpt() { return this.startsExpression() ? this.expression() : null; }

  expression() {
    const e = this.assignmentExpression();
    if (!this.accept(",")) return e;
    const exprs = [e, this.assignmentExpression()];
    while (this.accept(",")) exprs.push(this.assignmentExpression());
    return node("ExprList", { exprs });
  }

  assignmentExpression() {
    if (this.peek() === "(" && this.peek(2) === "{") throw new ParseError("statement expressions are not supported");
    const e = this.conditionalExpression();
    if (ASSIGN.has(this.peek())) {
      const op = this.advance().value;
      return node("Assignment", { op, lvalue: e, rvalue: this.assignmentExpression() });
    }
    return e;
  }

  conditionalExpression() {
    const e = this.binaryExpression(0, null);
    if (this.accept("?")) {
      const iftrue = this.expression();
      this.expect(":");
      return node("TernaryOp", { cond: e, iftrue, iffalse: this.conditionalExpression() });
    }
    return e;
  }

  binaryExpression(minPrec, lhs) {
    if (lhs === null) lhs = this.castExpression();
    for (;;) {
      const t = this.peek();
      if (t === null || !(t in BINPREC)) break;
      const prec = BINPREC[t];
      if (prec < minPrec) break;
      const op = this.advance().value;
      let rhs = this.castExpression();
      for (;;) {
        const n = this.peek();
        if (n === null || !(n in BINPREC)) break;
        if (BINPREC[n] > prec) rhs = this.binaryExpression(BINPREC[n], rhs);
        else break;
      }
      lhs = node("BinaryOp", { op, left: lhs, right: rhs });
    }
    return lhs;
  }

  tryParenTypeName() {
    const mark = this.i;
    if (!this.accept("(")) return null;
    if (!this.startsDeclaration()) { this.i = mark; return null; }
    const typ = this.typeName();
    if (!this.accept(")")) { this.i = mark; return null; }
    return { typ, mark };
  }

  castExpression() {
    const r = this.tryParenTypeName();
    if (r) {
      if (this.peek() === "{") this.i = r.mark;
      else return node("Cast", { to_type: r.typ, expr: this.castExpression() });
    }
    return this.unaryExpression();
  }

  unaryExpression() {
    const t = this.peek();
    if (t === "++" || t === "--") {
      const op = this.advance().value;
      return node("UnaryOp", { op, expr: this.unaryExpression() });
    }
    if (["&", "*", "+", "-", "~", "!"].includes(t)) {
      const op = this.advance().value;
      return node("UnaryOp", { op, expr: this.castExpression() });
    }
    if (t === "sizeof") {
      const op = this.advance().value;
      const r = this.tryParenTypeName();
      if (r) return node("UnaryOp", { op, expr: r.typ });
      return node("UnaryOp", { op, expr: this.unaryExpression() });
    }
    if (t === "_Alignof") {
      const op = this.advance().value;
      this.expect("(");
      const typ = this.typeName();
      this.expect(")");
      return node("UnaryOp", { op, expr: typ });
    }
    return this.postfixExpression();
  }

  postfixExpression() {
    const r = this.tryParenTypeName();
    if (r) {
      if (this.peek() === "{") throw new ParseError("compound literals are not supported");
      this.i = r.mark;
    }
    let e = this.primaryExpression();
    for (;;) {
      if (this.accept("[")) {
        const sub = this.expression();
        this.expect("]");
        e = node("ArrayRef", { name: e, subscript: sub });
        continue;
      }
      if (this.accept("(")) {
        let args = null;
        if (this.peek() === ")") this.advance();
        else {
          const exprs = [this.assignmentExpression()];
          while (this.accept(",")) exprs.push(this.assignmentExpression());
          args = node("ExprList", { exprs });
          this.expect(")");
        }
        e = node("FuncCall", { name: e, args });
        continue;
      }
      if (this.peek() === "." || this.peek() === "->") {
        const op = this.advance().value;
        const n = this.advance();
        if (n.type !== "ID" && n.type !== "TYPEID") throw new ParseError("Invalid struct reference");
        e = node("StructRef", { name: e, type: op, field: node("ID", { name: n.value }) });
        continue;
      }
      if (this.peek() === "++" || this.peek() === "--") {
        const op = "p" + this.advance().value;
        e = node("UnaryOp", { op, expr: e });
        continue;
      }
      return e;
    }
  }

  primaryExpression() {
    const t = this.peek();
    if (t === "ID") return node("ID", { name: this.advance().value });
    if (t === "INT" || t === "FLOAT" || t === "CHAR") return this.constant();
    if (t === "STRING") {
      const c = node("Constant", { type: "string", value: this.advance().value });
      while (this.peek() === "STRING") c.value = c.value.slice(0, -1) + this.advance().value.slice(1);
      return c;
    }
    if (t === "(") {
      this.advance();
      const e = this.expression();
      this.expect(")");
      return e;
    }
    throw new ParseError("Invalid expression");
  }

  constant() {
    const t = this.advance();
    if (t.type === "INT") {
      let u = 0, l = 0;
      for (const ch of t.value.slice(-3)) {
        if (ch === "l" || ch === "L") l++;
        else if (ch === "u" || ch === "U") u++;
      }
      if (u > 1 || l > 2) throw new ParseError("bad integer suffix");
      return node("Constant", { type: "unsigned ".repeat(u) + "long ".repeat(l) + "int", value: t.value });
    }
    if (t.type === "FLOAT") {
      const last = t.value.at(-1);
      const type = last === "f" || last === "F" ? "float" : last === "l" || last === "L" ? "long double" : "double";
      return node("Constant", { type, value: t.value });
    }
    return node("Constant", { type: "char", value: t.value });
  }

  initializer() {
    if (this.accept("{")) {
      if (this.accept("}")) return node("InitList", { exprs: [] });
      const items = [this.initializerItem()];
      while (this.accept(",")) {
        if (this.peek() === "}") break;
        items.push(this.initializerItem());
      }
      this.accept(",");
      this.expect("}");
      return node("InitList", { exprs: items });
    }
    return this.assignmentExpression();
  }

  initializerItem() {
    if (this.peek() === "[" || this.peek() === ".") throw new ParseError("designated initializers are not supported");
    return this.initializer();
  }
}

// pycparser's fix_switch_cases: statements after a case label move into it.
function fixSwitchCases(sw) {
  if (sw.stmt?._ !== "Compound") return sw;
  const items = sw.stmt.block_items || [];
  const out = [];
  let last = null;
  for (const it of items) {
    if (it._ === "Case" || it._ === "Default") {
      out.push(it);
      fixNested(it, out);
      last = out.at(-1);
    } else if (last) last.stmts.push(it);
    else out.push(it);
  }
  sw.stmt.block_items = out;
  return sw;
}
function fixNested(c, out) {
  const s = c.stmts[0];
  if (s && (s._ === "Case" || s._ === "Default")) {
    c.stmts.pop();
    out.push(s);
    fixNested(s, out);
  }
}

/**
 * Parse a translation unit.
 * @param {string} text
 */
export function parse(text) {
  const p = new Parser(text);
  const ext = [];
  while (p.peek() !== null) ext.push(...p.externalDeclaration());
  return node("FileAST", { ext });
}
export { ParseError };

/**
 * Serialise a node as [kind, field...] (NODE_FIELDS order), recording each
 * kind's field list in `schema` in first-seen order.
 */
export function serialize(n, schema) {
  if (n === null || n === undefined) return null;
  if (Array.isArray(n)) return n.map((x) => serialize(x, schema));
  if (typeof n !== "object") return n;
  const kind = n._;
  if (!(kind in schema)) schema[kind] = NODE_FIELDS[kind];
  const out = [kind];
  for (const f of NODE_FIELDS[kind]) out.push(serialize(n[f], schema));
  return out;
}

/** Visit n and every child node, parents first, children in pycparser order. */
export function walk(n, fn) {
  if (!n || typeof n !== "object") return;
  fn(n);
  for (const f of CHILDREN[n._]) {
    const v = n[f];
    if (Array.isArray(v)) for (const x of v) walk(x, fn);
    else if (v) walk(v, fn);
  }
}
