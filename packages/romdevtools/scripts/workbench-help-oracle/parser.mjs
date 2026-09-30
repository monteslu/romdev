// Recursive-descent parser for the Python subset. AST nodes are plain objects {k: kind, ...}.
import { tokenize } from "./lexer.mjs";

export function parseModule(src, file) {
  const p = new Parser(tokenize(src, file), file);
  const body = [];
  while (!p.at("EOF")) { if (p.at("NEWLINE")) { p.next(); continue; } body.push(p.statement()); }
  return body;
}

export function parseExpression(src, file = "<fstring>") {
  const p = new Parser(tokenize(src, file), file);
  const e = p.exprList();
  return e;
}

function decodeEscapes(s) {
  return s.replace(/\\(N\{[^}]*\}|x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|[0-7]{1,3}|\n|.)/gs, (m, e) => {
    if (e === "\n") return "";
    if (e[0] === "x" || e[0] === "u" || e[0] === "U") return String.fromCodePoint(parseInt(e.slice(1), 16));
    if (/^[0-7]/.test(e)) return String.fromCharCode(parseInt(e, 8));
    const map = { n: "\n", t: "\t", r: "\r", "\\": "\\", "'": "'", '"': '"', a: "\x07", b: "\b", f: "\f", v: "\v", 0: "\0" };
    return e in map ? map[e] : "\\" + e;
  });
}

class Parser {
  constructor(toks, file) { this.t = toks; this.i = 0; this.file = file; }
  peek(o = 0) { return this.t[this.i + o]; }
  at(type, value) { const t = this.peek(); return t.type === type && (value === undefined || t.value === value); }
  atOp(v) { return this.at("OP", v); }
  atName(v) { return this.at("NAME", v); }
  next() { return this.t[this.i++]; }
  err(msg) { const t = this.peek(); throw new Error(`${this.file}:${t.line}: ${msg} (at ${t.type} ${JSON.stringify(t.value ?? t.body)})`); }
  expect(type, value) { if (!this.at(type, value)) this.err(`expected ${type} ${value ?? ""}`); return this.next(); }
  eatOp(v) { if (this.atOp(v)) { this.next(); return true; } return false; }

  block() {
    if (this.at("NEWLINE")) {
      this.next();
      this.expect("INDENT");
      const body = [];
      while (!this.at("DEDENT") && !this.at("EOF")) { if (this.at("NEWLINE")) { this.next(); continue; } body.push(this.statement()); }
      if (this.at("DEDENT")) this.next();
      return body;
    }
    // simple statements on one line
    const body = [this.simpleStatement()];
    while (this.eatOp(";")) { if (this.at("NEWLINE")) break; body.push(this.simpleStatement()); }
    if (this.at("NEWLINE")) this.next();
    return body;
  }

  statement() {
    const t = this.peek();
    if (this.atOp("@")) { const decos = []; while (this.eatOp("@")) { decos.push(this.expr()); this.expect("NEWLINE"); } const s = this.statement(); s.decorators = decos; return s; }
    if (t.type === "NAME") {
      switch (t.value) {
        case "def": return this.funcDef();
        case "async": this.next(); return this.statement();
        case "class": return this.classDef();
        case "if": return this.ifStmt();
        case "for": return this.forStmt();
        case "while": { this.next(); const test = this.expr(); this.expect("OP", ":"); const body = this.block(); let orelse = []; if (this.atName("else")) { this.next(); this.expect("OP", ":"); orelse = this.block(); } return { k: "While", test, body, orelse, line: t.line }; }
        case "try": return this.tryStmt();
        case "with": { this.next(); const items = []; const par = this.atOp("(") && this.parenWith(); if (par) this.next(); do { if (par && this.atOp(")")) break; const e = this.expr(); let as = null; if (this.atName("as")) { this.next(); as = this.target(); } items.push({ e, as }); } while (this.eatOp(",")); if (par) this.expect("OP", ")"); this.expect("OP", ":"); return { k: "With", items, body: this.block(), line: t.line }; }
        case "match": if (this.peek(1).type !== "OP" || this.peek(1).value === "(" ) { /* treat as expression name */ } break;
      }
    }
    const s = this.simpleStatement();
    const stmts = [s];
    while (this.eatOp(";")) { if (this.at("NEWLINE")) break; stmts.push(this.simpleStatement()); }
    if (this.at("NEWLINE")) this.next(); else if (!this.at("EOF") && !this.at("DEDENT")) this.err("expected newline");
    return stmts.length === 1 ? s : { k: "Suite", body: stmts };
  }

  simpleStatement() {
    const t = this.peek();
    if (t.type === "NAME") {
      switch (t.value) {
        case "pass": this.next(); return { k: "Pass" };
        case "break": this.next(); return { k: "Break" };
        case "continue": this.next(); return { k: "Continue" };
        case "return": { this.next(); const v = this.at("NEWLINE") || this.atOp(";") ? null : this.exprList(); return { k: "Return", v, line: t.line }; }
        case "raise": { this.next(); let e = null, cause = null; if (!this.at("NEWLINE")) { e = this.expr(); if (this.atName("from")) { this.next(); cause = this.expr(); } } return { k: "Raise", e, cause, line: t.line }; }
        case "global": case "nonlocal": { this.next(); const names = [this.expect("NAME").value]; while (this.eatOp(",")) names.push(this.expect("NAME").value); return { k: "Global", names }; }
        case "del": { this.next(); const targets = [this.target()]; while (this.eatOp(",")) targets.push(this.target()); return { k: "Del", targets }; }
        case "assert": { this.next(); const test = this.expr(); let msg = null; if (this.eatOp(",")) msg = this.expr(); return { k: "Assert", test, msg }; }
        case "import": { this.next(); const names = []; do { let n = this.expect("NAME").value; while (this.eatOp(".")) n += "." + this.expect("NAME").value; let as = null; if (this.atName("as")) { this.next(); as = this.expect("NAME").value; } names.push({ name: n, as }); } while (this.eatOp(",")); return { k: "Import", names }; }
        case "from": {
          this.next(); let mod = "";
          while (this.atOp(".") || this.atOp("...")) mod += this.next().value;
          if (this.at("NAME") && !this.atName("import")) { mod += this.next().value; while (this.eatOp(".")) mod += "." + this.expect("NAME").value; }
          this.expect("NAME", "import");
          const names = [];
          const paren = this.eatOp("(");
          if (this.eatOp("*")) names.push({ name: "*" });
          else do { if (paren && this.atOp(")")) break; const n = this.expect("NAME").value; let as = null; if (this.atName("as")) { this.next(); as = this.expect("NAME").value; } names.push({ name: n, as }); } while (this.eatOp(","));
          if (paren) this.expect("OP", ")");
          return { k: "ImportFrom", mod, names };
        }
      }
    }
    const e = this.exprList(true);
    if (this.atOp(":")) { this.next(); const ann = this.expr(); let v = null; if (this.eatOp("=")) v = this.exprList(true); return { k: "AnnAssign", target: e, v, line: t.line }; }
    if (this.atOp("=")) {
      const targets = [e]; let v;
      while (this.eatOp("=")) { v = this.at("NAME", "yield") ? this.yieldExpr() : this.exprList(true); targets.push(v); }
      targets.pop();
      return { k: "Assign", targets, v, line: t.line };
    }
    const aug = ["+=", "-=", "*=", "/=", "//=", "%=", "|=", "&=", "^=", "**=", "<<=", ">>="].find((o) => this.atOp(o));
    if (aug) { this.next(); return { k: "AugAssign", target: e, op: aug.slice(0, -1), v: this.exprList(true), line: t.line }; }
    return { k: "Expr", e, line: t.line };
  }

  yieldExpr() { this.next(); if (this.atName("from")) { this.next(); return { k: "Yield", from: true, v: this.expr() }; } return { k: "Yield", v: this.at("NEWLINE") || this.atOp(")") ? null : this.exprList() }; }
  parenWith() {
    // "with (" starts a parenthesized item list when a top-level "as" appears inside
    let depth = 0;
    for (let j = this.i; j < this.t.length; j++) {
      const tk = this.t[j];
      if (tk.type === "OP" && "([{".includes(tk.value)) depth++;
      else if (tk.type === "OP" && ")]}".includes(tk.value)) { depth--; if (depth === 0) return false; }
      else if (depth === 1 && tk.type === "NAME" && tk.value === "as") return true;
    }
    return false;
  }

  funcDef() {
    const line = this.next().line;
    const name = this.expect("NAME").value;
    this.expect("OP", "(");
    const params = this.params(")");
    this.expect("OP", ")");
    if (this.eatOp("->")) this.expr();
    this.expect("OP", ":");
    return { k: "FunctionDef", name, params, body: this.block(), line };
  }

  params(close) {
    const params = [];
    let kwOnly = false;
    while (!this.atOp(close)) {
      if (this.eatOp("/")) { if (!this.eatOp(",")) break; continue; }
      if (this.eatOp("**")) { params.push({ name: this.expect("NAME").value, kind: "kwargs" }); if (this.atOp(":") && close === ")") { this.next(); this.expr(); } }
      else if (this.eatOp("*")) { if (this.at("NAME")) { params.push({ name: this.next().value, kind: "varargs" }); if (this.atOp(":") && close === ")") { this.next(); this.expr(); } } kwOnly = true; }
      else {
        const name = this.expect("NAME").value;
        if (close === ")" && this.eatOp(":")) this.expr();
        let def = null;
        if (this.eatOp("=")) def = this.expr();
        params.push({ name, kind: kwOnly ? "kwonly" : "pos", def });
      }
      if (!this.eatOp(",")) break;
    }
    return params;
  }

  classDef() {
    const line = this.next().line;
    const name = this.expect("NAME").value;
    let bases = [];
    if (this.eatOp("(")) { bases = this.callArgs(); this.expect("OP", ")"); }
    this.expect("OP", ":");
    return { k: "ClassDef", name, bases, body: this.block(), line };
  }

  ifStmt() {
    const line = this.next().line;
    const test = this.namedExpr();
    this.expect("OP", ":");
    const body = this.block();
    let orelse = [];
    if (this.atName("elif")) orelse = [this.ifStmt()];
    else if (this.atName("else")) { this.next(); this.expect("OP", ":"); orelse = this.block(); }
    return { k: "If", test, body, orelse, line };
  }

  forStmt() {
    const line = this.next().line;
    const target = this.targetList();
    this.expect("NAME", "in");
    const iter = this.exprList();
    this.expect("OP", ":");
    const body = this.block();
    let orelse = [];
    if (this.atName("else")) { this.next(); this.expect("OP", ":"); orelse = this.block(); }
    return { k: "For", target, iter, body, orelse, line };
  }

  tryStmt() {
    const line = this.next().line;
    this.expect("OP", ":");
    const body = this.block();
    const handlers = []; let orelse = [], finalbody = [];
    while (this.atName("except")) {
      this.next(); this.eatOp("*");
      let type = null, as = null;
      if (!this.atOp(":")) { type = this.expr(); if (this.atName("as")) { this.next(); as = this.expect("NAME").value; } }
      this.expect("OP", ":");
      handlers.push({ type, as, body: this.block() });
    }
    if (this.atName("else")) { this.next(); this.expect("OP", ":"); orelse = this.block(); }
    if (this.atName("finally")) { this.next(); this.expect("OP", ":"); finalbody = this.block(); }
    return { k: "Try", body, handlers, orelse, finalbody, line };
  }

  target() { return this.orExpr(); }
  targetList() {
    const first = this.orExprStar();
    if (!this.atOp(",")) return first;
    const elts = [first];
    while (this.eatOp(",")) { if (this.atName("in") || this.atOp("=")) break; elts.push(this.orExprStar()); }
    return { k: "Tuple", elts };
  }
  orExprStar() { if (this.eatOp("*")) return { k: "Starred", v: this.orExpr() }; return this.orExpr(); }

  exprList(allowStar = true) {
    const first = allowStar && this.atOp("*") ? (this.next(), { k: "Starred", v: this.orExpr() }) : this.namedExpr();
    if (!this.atOp(",")) return first;
    const elts = [first];
    while (this.eatOp(",")) {
      if (this.at("NEWLINE") || this.atOp("=") || this.atOp(")") || this.atOp(":") || this.at("EOF") || this.atOp(";")) break;
      elts.push(this.atOp("*") ? (this.next(), { k: "Starred", v: this.orExpr() }) : this.namedExpr());
    }
    return { k: "Tuple", elts };
  }

  namedExpr() {
    if (this.at("NAME") && this.peek(1).type === "OP" && this.peek(1).value === ":=") {
      const name = this.next().value; this.next();
      return { k: "NamedExpr", name, v: this.expr() };
    }
    return this.expr();
  }

  expr() {
    if (this.atName("lambda")) {
      this.next();
      const params = this.params(":");
      this.expect("OP", ":");
      return { k: "Lambda", params, body: this.expr() };
    }
    const e = this.orTest();
    if (this.atName("if")) {
      this.next();
      const test = this.orTest();
      this.expect("NAME", "else");
      return { k: "IfExp", test, body: e, orelse: this.expr() };
    }
    return e;
  }
  orTest() { let e = this.andTest(); while (this.atName("or")) { this.next(); e = { k: "BoolOp", op: "or", a: e, b: this.andTest() }; } return e; }
  andTest() { let e = this.notTest(); while (this.atName("and")) { this.next(); e = { k: "BoolOp", op: "and", a: e, b: this.notTest() }; } return e; }
  notTest() { if (this.atName("not")) { this.next(); return { k: "Not", v: this.notTest() }; } return this.comparison(); }
  comparison() {
    let e = this.orExpr();
    const ops = [], comps = [];
    for (;;) {
      let op = null;
      if (["<", ">", "==", ">=", "<=", "!="].some((o) => this.atOp(o))) op = this.next().value;
      else if (this.atName("in")) { this.next(); op = "in"; }
      else if (this.atName("not") && this.peek(1).type === "NAME" && this.peek(1).value === "in") { this.next(); this.next(); op = "not in"; }
      else if (this.atName("is")) { this.next(); op = "is"; if (this.atName("not")) { this.next(); op = "is not"; } }
      if (!op) break;
      ops.push(op); comps.push(this.orExpr());
    }
    return ops.length ? { k: "Compare", left: e, ops, comps } : e;
  }
  orExpr() { let e = this.xorExpr(); while (this.atOp("|")) { this.next(); e = { k: "BinOp", op: "|", a: e, b: this.xorExpr() }; } return e; }
  xorExpr() { let e = this.andExpr(); while (this.atOp("^")) { this.next(); e = { k: "BinOp", op: "^", a: e, b: this.andExpr() }; } return e; }
  andExpr() { let e = this.shiftExpr(); while (this.atOp("&")) { this.next(); e = { k: "BinOp", op: "&", a: e, b: this.shiftExpr() }; } return e; }
  shiftExpr() { let e = this.arith(); while (this.atOp("<<") || this.atOp(">>")) { const op = this.next().value; e = { k: "BinOp", op, a: e, b: this.arith() }; } return e; }
  arith() { let e = this.term(); while (this.atOp("+") || this.atOp("-")) { const op = this.next().value; e = { k: "BinOp", op, a: e, b: this.term() }; } return e; }
  term() { let e = this.factor(); while (["*", "/", "//", "%", "@"].some((o) => this.atOp(o))) { const op = this.next().value; e = { k: "BinOp", op, a: e, b: this.factor() }; } return e; }
  factor() { if (this.atOp("-") || this.atOp("+") || this.atOp("~")) { const op = this.next().value; return { k: "Unary", op, v: this.factor() }; } return this.power(); }
  power() { if (this.atName("await")) this.next(); let e = this.primary(); if (this.atOp("**")) { this.next(); e = { k: "BinOp", op: "**", a: e, b: this.factor() }; } return e; }

  primary() {
    let e = this.atom();
    for (;;) {
      if (this.atOp(".")) { this.next(); e = { k: "Attr", v: e, name: this.expect("NAME").value }; }
      else if (this.atOp("(")) { this.next(); const args = this.callArgs(); this.expect("OP", ")"); e = { k: "Call", f: e, args, line: this.peek().line }; }
      else if (this.atOp("[")) { this.next(); const idx = this.subscript(); this.expect("OP", "]"); e = { k: "Subscript", v: e, idx }; }
      else break;
    }
    return e;
  }

  subscript() {
    const one = () => {
      if (this.atOp(":") || !this.atOp("]")) {
        let lo = null, hi = null, step = null;
        if (!this.atOp(":")) { lo = this.expr(); if (!this.atOp(":")) return lo; }
        this.next();
        if (!this.atOp("]") && !this.atOp(":") && !this.atOp(",")) hi = this.expr();
        if (this.eatOp(":")) { if (!this.atOp("]") && !this.atOp(",")) step = this.expr(); }
        return { k: "Slice", lo, hi, step };
      }
    };
    const first = one();
    if (!this.atOp(",")) return first;
    const elts = [first];
    while (this.eatOp(",")) { if (this.atOp("]")) break; elts.push(one()); }
    return { k: "Tuple", elts };
  }

  callArgs() {
    const args = [];
    while (!this.atOp(")")) {
      if (this.eatOp("**")) args.push({ kind: "kwargs", v: this.expr() });
      else if (this.eatOp("*")) args.push({ kind: "star", v: this.expr() });
      else if (this.at("NAME") && this.peek(1).type === "OP" && this.peek(1).value === "=") { const name = this.next().value; this.next(); args.push({ kind: "kw", name, v: this.expr() }); }
      else {
        const v = this.namedExpr();
        if (this.atName("for") || this.atName("async")) args.push({ kind: "pos", v: this.comprehension("GeneratorExp", v) });
        else args.push({ kind: "pos", v });
      }
      if (!this.eatOp(",")) break;
    }
    return args;
  }

  comprehension(kind, elt, value = null) {
    const gens = [];
    while (this.atName("for") || this.atName("async")) {
      if (this.atName("async")) this.next();
      this.next();
      const target = this.targetList();
      this.expect("NAME", "in");
      const iter = this.orTest();
      const ifs = [];
      while (this.atName("if")) { this.next(); ifs.push(this.orTestNoCond()); }
      gens.push({ target, iter, ifs });
    }
    return { k: kind, elt, value, gens };
  }
  orTestNoCond() { return this.orTest(); }

  atom() {
    const t = this.peek();
    if (t.type === "NAME") {
      this.next();
      if (t.value === "None") return { k: "Const", v: null };
      if (t.value === "True") return { k: "Const", v: true };
      if (t.value === "False") return { k: "Const", v: false };
      if (t.value === "yield") { this.i--; return this.yieldExpr(); }
      return { k: "Name", id: t.value, line: t.line };
    }
    if (t.type === "NUMBER") {
      this.next();
      const s = t.value.replace(/_/g, "");
      if (/^0[xX]/.test(s)) return { k: "Const", v: parseInt(s.slice(2), 16) };
      if (/^0[oO]/.test(s)) return { k: "Const", v: parseInt(s.slice(2), 8) };
      if (/^0[bB]/.test(s)) return { k: "Const", v: parseInt(s.slice(2), 2) };
      if (/[.eE]/.test(s)) return { k: "Const", v: Number(s), float: true };
      return { k: "Const", v: Number(s) };
    }
    if (t.type === "STRING") {
      const parts = [];
      while (this.at("STRING")) parts.push(this.stringPart(this.next()));
      if (parts.every((p) => p.k === "Const")) return { k: "Const", v: parts.map((p) => p.v).join("") };
      return { k: "JoinedStr", parts };
    }
    if (t.type === "OP") {
      if (t.value === "(") {
        this.next();
        if (this.eatOp(")")) return { k: "Tuple", elts: [] };
        const first = this.atOp("*") ? (this.next(), { k: "Starred", v: this.orExpr() }) : this.namedExpr();
        if (this.atName("for")) { const g = this.comprehension("GeneratorExp", first); this.expect("OP", ")"); return g; }
        if (this.atOp(",")) {
          const elts = [first];
          while (this.eatOp(",")) { if (this.atOp(")")) break; elts.push(this.atOp("*") ? (this.next(), { k: "Starred", v: this.orExpr() }) : this.namedExpr()); }
          this.expect("OP", ")");
          return { k: "Tuple", elts };
        }
        this.expect("OP", ")");
        return first;
      }
      if (t.value === "[") {
        this.next();
        if (this.eatOp("]")) return { k: "List", elts: [] };
        const first = this.atOp("*") ? (this.next(), { k: "Starred", v: this.orExpr() }) : this.namedExpr();
        if (this.atName("for")) { const g = this.comprehension("ListComp", first); this.expect("OP", "]"); return g; }
        const elts = [first];
        while (this.eatOp(",")) { if (this.atOp("]")) break; elts.push(this.atOp("*") ? (this.next(), { k: "Starred", v: this.orExpr() }) : this.namedExpr()); }
        this.expect("OP", "]");
        return { k: "List", elts };
      }
      if (t.value === "{") {
        this.next();
        if (this.eatOp("}")) return { k: "Dict", keys: [], vals: [] };
        if (this.eatOp("**")) {
          const keys = [null], vals = [this.orExpr()];
          while (this.eatOp(",")) { if (this.atOp("}")) break; if (this.eatOp("**")) { keys.push(null); vals.push(this.orExpr()); } else { keys.push(this.expr()); this.expect("OP", ":"); vals.push(this.expr()); } }
          this.expect("OP", "}");
          return { k: "Dict", keys, vals };
        }
        const first = this.atOp("*") ? (this.next(), { k: "Starred", v: this.orExpr() }) : this.namedExpr();
        if (this.eatOp(":")) {
          const v = this.expr();
          if (this.atName("for")) { const g = this.comprehension("DictComp", first, v); this.expect("OP", "}"); return g; }
          const keys = [first], vals = [v];
          while (this.eatOp(",")) { if (this.atOp("}")) break; if (this.eatOp("**")) { keys.push(null); vals.push(this.orExpr()); continue; } keys.push(this.expr()); this.expect("OP", ":"); vals.push(this.expr()); }
          this.expect("OP", "}");
          return { k: "Dict", keys, vals };
        }
        if (this.atName("for")) { const g = this.comprehension("SetComp", first); this.expect("OP", "}"); return g; }
        const elts = [first];
        while (this.eatOp(",")) { if (this.atOp("}")) break; elts.push(this.atOp("*") ? (this.next(), { k: "Starred", v: this.orExpr() }) : this.namedExpr()); }
        this.expect("OP", "}");
        return { k: "Set", elts };
      }
      if (t.value === "...") { this.next(); return { k: "Const", v: "..." }; }
    }
    this.err("unexpected token");
  }

  stringPart(tok) {
    const raw = tok.prefix.includes("r");
    const isF = tok.prefix.includes("f");
    const isB = tok.prefix.includes("b");
    if (!isF) return { k: "Const", v: raw ? tok.body : decodeEscapes(tok.body), bytes: isB };
    // f-string: split into literal and {expr!conv:spec}
    const parts = [];
    const s = tok.body;
    let i = 0, lit = "";
    const flush = () => { if (lit) { parts.push({ k: "Const", v: raw ? lit : decodeEscapes(lit) }); lit = ""; } };
    while (i < s.length) {
      if (s[i] === "{" && s[i + 1] === "{") { lit += "{"; i += 2; continue; }
      if (s[i] === "}" && s[i + 1] === "}") { lit += "}"; i += 2; continue; }
      if (s[i] === "{") {
        flush();
        // find matching close, respecting nesting and strings
        let depth = 0, j = i + 1, q = null;
        let exprEnd = -1, convAt = -1, specAt = -1;
        for (; j < s.length; j++) {
          const c = s[j];
          if (q) { if (c === "\\") { j++; continue; } if (c === q) q = null; continue; }
          if (c === "'" || c === '"') { q = c; continue; }
          if ("([{".includes(c)) depth++;
          else if (")]}".includes(c)) { if (depth === 0 && c === "}") break; depth--; }
          else if (depth === 0 && c === "!" && s[j + 1] !== "=" && convAt < 0 && specAt < 0) convAt = j;
          else if (depth === 0 && c === ":" && specAt < 0) { specAt = j; }
        }
        exprEnd = convAt >= 0 ? convAt : specAt >= 0 ? specAt : j;
        let exprText = s.slice(i + 1, exprEnd);
        let selfDoc = false;
        if (/=\s*$/.test(exprText) && !/[=!<>]=\s*$/.test(exprText)) { selfDoc = true; }
        const conv = convAt >= 0 ? s.slice(convAt + 1, specAt >= 0 ? specAt : j) : null;
        const specText = specAt >= 0 ? s.slice(specAt + 1, j) : null;
        const expr = parseExpression(selfDoc ? exprText.replace(/=\s*$/, "") : exprText);
        const spec = specText === null ? null : this.stringPart({ prefix: raw ? "rf" : "f", body: specText });
        if (selfDoc) parts.push({ k: "Const", v: exprText });
        parts.push({ k: "FormattedValue", v: expr, conv: selfDoc && !conv && !spec ? "r" : conv, spec });
        i = j + 1;
        continue;
      }
      lit += s[i]; i++;
    }
    flush();
    return { k: "JoinedStr", parts };
  }
}
