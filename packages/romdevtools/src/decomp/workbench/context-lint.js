// context-lint.js - preprocessor-conditional audit: undefined-identifier
// collapse in `#if`/`#elif`. When every identifier in a guard is undefined,
// the preprocessor substitutes 0 for each, and `A >= B` or `A == B` quietly
// becomes true: a region the author meant to exclude compiles in. This scans
// C sources for exactly that shape, given the macros a caller says are
// defined plus whatever the scanned files `#define` along the way.
//
// Single forward pass, stdlib-style approximation: every `#define` met is
// recorded regardless of branch; a bare define counts as 1; a macro whose
// value is not a constant expression is "defined, value unknown" (also 1);
// function-like invocations are skipped, not expanded; only #if/#elif are
// evaluated. Values are exact (arbitrary-precision integers).
//
// Plain JS ESM + JSDoc.

import fs from "node:fs";
import { ValueError, sorted, strRepr, splitlines } from "./py.js";

export const CONTEXT_LINT_SCHEMA = "decomp-workbench-context-lint-v1";
const SEVERITY_ORDER = { high: 0, medium: 1, info: 2, note: 3 };

/** `//` and block-comment content replaced by spaces; newlines kept. */
export function stripComments(text) {
  const out = [];
  let i = 0;
  const n = text.length;
  let lineC = false, blockC = false, str = false, chr = false;
  while (i < n) {
    const ch = text[i];
    const two = text.slice(i, i + 2);
    if (lineC) { if (ch === "\n") { lineC = false; out.push(ch); } else out.push(" "); i += 1; continue; }
    if (blockC) {
      if (two === "*/") { out.push("  "); blockC = false; i += 2; continue; }
      out.push(ch === "\n" ? ch : " "); i += 1; continue;
    }
    if (str) {
      out.push(ch);
      if (ch === "\\" && i + 1 < n) { out.push(text[i + 1]); i += 2; continue; }
      if (ch === '"') str = false;
      i += 1; continue;
    }
    if (chr) {
      out.push(ch);
      if (ch === "\\" && i + 1 < n) { out.push(text[i + 1]); i += 2; continue; }
      if (ch === "'") chr = false;
      i += 1; continue;
    }
    if (two === "//") { lineC = true; out.push("  "); i += 2; continue; }
    if (two === "/*") { blockC = true; out.push("  "); i += 2; continue; }
    if (ch === '"') { str = true; out.push(ch); i += 1; continue; }
    if (ch === "'") { chr = true; out.push(ch); i += 1; continue; }
    out.push(ch); i += 1;
  }
  return out.join("");
}

const rstrip = (s) => s.replace(/[\s]+$/, "");

function logicalLines(text) {
  const physical = text.split("\n");
  const result = [];
  let i = 0;
  const n = physical.length;
  while (i < n) {
    const start = i + 1;
    const parts = [physical[i]];
    while (rstrip(parts.at(-1)).endsWith("\\") && i + 1 < n) {
      parts[parts.length - 1] = rstrip(parts.at(-1)).slice(0, -1);
      i += 1;
      parts.push(physical[i]);
    }
    result.push({ text: parts.join("\n"), start, end: i + 1 });
    i += 1;
  }
  return result;
}

/** A `#if`/`#elif` expression this evaluator's cpp subset cannot parse. */
export class ExpressionError extends ValueError { constructor(m) { super(m); this.name = "ValueError"; this.expressionError = true; } }

const NUMBER_RE = /0[xX][0-9a-fA-F]+|0[0-7]*|[1-9][0-9]*/y;
const SUFFIX_RE = /[uUlL]*/y;
const IDENT_RE = /[A-Za-z_]\w*/y;
const CHAR_RE = /'(?:\\.|[^'\\])+'/y;
const TWO_CHAR_OPS = new Set(["<<", ">>", "<=", ">=", "==", "!=", "&&", "||"]);
const ONE_CHAR_OPS = new Set("()!~-+*/%<>^&|?:,");
const CHAR_ESCAPES = { n: 10, t: 9, r: 13, 0: 0, a: 7, b: 8, f: 12, v: 11, "\\": 92, "'": 39, '"': 34 };

const at = (re, s, i) => { re.lastIndex = i; return re.exec(s); };

function intLiteral(lit) {
  if (lit.startsWith("0x") || lit.startsWith("0X")) return BigInt(lit);
  if (lit.length > 1 && lit[0] === "0") return BigInt("0o" + lit.slice(1));
  return BigInt(lit);
}

function charLiteral(lit) {
  const body = lit.slice(1, -1);
  if (body.startsWith("\\") && body.length > 1) {
    const esc = body[1];
    if (esc === "x") return BigInt("0x" + (body.slice(2) || "0"));
    if (esc in CHAR_ESCAPES) return BigInt(CHAR_ESCAPES[esc]);
    if (/[0-9]/.test(esc)) return BigInt("0o" + body.slice(1));
    return BigInt(esc.codePointAt(0));
  }
  return body ? BigInt(body.codePointAt(0)) : 0n;
}

function tokenize(expr) {
  const tokens = [];
  let i = 0;
  const n = expr.length;
  while (i < n) {
    const ch = expr[i];
    if (/\s/.test(ch)) { i += 1; continue; }
    if (ch === "'") {
      const m = at(CHAR_RE, expr, i);
      if (!m) throw new ExpressionError(`unterminated character constant near ${strRepr(expr.slice(i, i + 12))}`);
      tokens.push({ kind: "NUMBER", value: charLiteral(m[0]) });
      i = m.index + m[0].length;
      continue;
    }
    let m = at(NUMBER_RE, expr, i);
    if (m) {
      let end = m.index + m[0].length;
      const s = at(SUFFIX_RE, expr, end);
      if (s) end = s.index + s[0].length;
      tokens.push({ kind: "NUMBER", value: intLiteral(m[0]) });
      i = end;
      continue;
    }
    m = at(IDENT_RE, expr, i);
    if (m) { tokens.push({ kind: "IDENT", value: m[0] }); i = m.index + m[0].length; continue; }
    const two = expr.slice(i, i + 2);
    if (TWO_CHAR_OPS.has(two)) { tokens.push({ kind: "OP", value: two }); i += 2; continue; }
    if (ONE_CHAR_OPS.has(ch)) { tokens.push({ kind: "OP", value: ch }); i += 1; continue; }
    throw new ExpressionError(`unexpected character ${strRepr(ch)} in preprocessor expression`);
  }
  tokens.push({ kind: "EOF", value: null });
  return tokens;
}

const tokRepr = (v) => (v === null ? "None" : typeof v === "bigint" ? String(v) : strRepr(v));
const abs = (x) => (x < 0n ? -x : x);
function cDiv(a, b) {
  if (b === 0n) throw new ExpressionError("division by zero in preprocessor expression");
  const q = abs(a) / abs(b);
  return (a < 0n) !== (b < 0n) ? -q : q;
}
function cMod(a, b) {
  if (b === 0n) throw new ExpressionError("modulo by zero in preprocessor expression");
  return a - cDiv(a, b) * b;
}
const b01 = (c) => (c ? 1n : 0n);

class Parser {
  constructor(tokens, context) { this.t = tokens; this.p = 0; this.c = context; }
  parse() {
    const v = this.conditional();
    if (this.peek().kind !== "EOF") throw new ExpressionError(`unexpected trailing token ${tokRepr(this.peek().value)}`);
    return v;
  }
  peek() { return this.t[this.p]; }
  advance() { return this.t[this.p++]; }
  expectOp(text) { const tk = this.advance(); if (tk.kind !== "OP" || tk.value !== text) throw new ExpressionError(`expected ${strRepr(text)}, found ${tokRepr(tk.value)}`); }
  isOp(...vals) { const tk = this.peek(); return tk.kind === "OP" && vals.includes(tk.value); }
  conditional() {
    const cond = this.logicalOr();
    if (this.isOp("?")) {
      this.advance();
      const t = this.conditional();
      this.expectOp(":");
      const f = this.conditional();
      return cond !== 0n ? t : f;
    }
    return cond;
  }
  logicalOr() { let v = this.logicalAnd(); while (this.isOp("||")) { this.advance(); const r = this.logicalAnd(); v = b01(v !== 0n || r !== 0n); } return v; }
  logicalAnd() { let v = this.bitor(); while (this.isOp("&&")) { this.advance(); const r = this.bitor(); v = b01(v !== 0n && r !== 0n); } return v; }
  bitor() { let v = this.bitxor(); while (this.isOp("|")) { this.advance(); v |= this.bitxor(); } return v; }
  bitxor() { let v = this.bitand(); while (this.isOp("^")) { this.advance(); v ^= this.bitand(); } return v; }
  bitand() { let v = this.equality(); while (this.isOp("&")) { this.advance(); v &= this.equality(); } return v; }
  equality() {
    let v = this.relational();
    while (this.isOp("==", "!=")) { const op = this.advance().value; const r = this.relational(); v = b01((v === r) === (op === "==")); }
    return v;
  }
  relational() {
    let v = this.shift();
    while (this.isOp("<", ">", "<=", ">=")) {
      const op = this.advance().value; const r = this.shift();
      v = b01(op === "<" ? v < r : op === ">" ? v > r : op === "<=" ? v <= r : v >= r);
    }
    return v;
  }
  shift() {
    let v = this.additive();
    while (this.isOp("<<", ">>")) {
      const op = this.advance().value; const r = this.additive();
      if (r < 0n) throw new ValueError("negative shift count");
      v = op === "<<" ? v << r : v >> r;
    }
    return v;
  }
  additive() { let v = this.multiplicative(); while (this.isOp("+", "-")) { const op = this.advance().value; const r = this.multiplicative(); v = op === "+" ? v + r : v - r; } return v; }
  multiplicative() {
    let v = this.unary();
    while (this.isOp("*", "/", "%")) { const op = this.advance().value; const r = this.unary(); v = op === "*" ? v * r : op === "/" ? cDiv(v, r) : cMod(v, r); }
    return v;
  }
  unary() {
    if (this.isOp("!", "~", "-", "+")) {
      const op = this.advance().value; const o = this.unary();
      return op === "!" ? b01(o === 0n) : op === "~" ? ~o : op === "-" ? -o : o;
    }
    return this.primary();
  }
  primary() {
    const tk = this.peek();
    if (tk.kind === "NUMBER") { this.advance(); return tk.value; }
    if (tk.kind === "IDENT") return tk.value === "defined" ? this.defined() : this.identifier();
    if (this.isOp("(")) { this.advance(); const v = this.conditional(); this.expectOp(")"); return v; }
    if (tk.kind === "EOF") throw new ExpressionError("unexpected end of preprocessor expression");
    throw new ExpressionError(`unexpected token ${tokRepr(tk.value)}`);
  }
  defined() {
    this.advance();
    const paren = this.isOp("(");
    if (paren) this.advance();
    const name = this.advance();
    if (name.kind !== "IDENT") throw new ExpressionError("defined() expects a macro name");
    if (paren) this.expectOp(")");
    this.c.defined_operand_identifiers.add(name.value);
    return b01(this.c.defines.has(name.value));
  }
  identifier() {
    const name = this.advance().value;
    this.c.value_identifiers.add(name);
    if (this.isOp("(")) {
      this.advance();
      if (!this.isOp(")")) { this.conditional(); while (this.isOp(",")) { this.advance(); this.conditional(); } }
      this.expectOp(")");
    }
    if (!this.c.defines.has(name)) return 0n;
    const v = this.c.defines.get(name);
    return v !== null && v !== undefined ? v : 1n;
  }
}

/** The result of parsing and evaluating one `#if`/`#elif` expression. */
export class ExpressionAnalysis {
  constructor(f) { Object.assign(this, f); Object.freeze(this); }
}

const asMap = (d) => (d instanceof Map ? d : new Map(Object.entries(d ?? {})));

/** Parse and evaluate one constant expression against a macro table. */
export function analyzeExpression(expression, defines) {
  const table = asMap(defines);
  const stripped = expression.trim();
  const context = { defines: table, value_identifiers: new Set(), defined_operand_identifiers: new Set() };
  let value;
  try { value = new Parser(tokenize(stripped), context).parse(); } catch (e) {
    if (!e.expressionError) throw e;
    return new ExpressionAnalysis({ expression: stripped, ok: false, error: e.message, value: null, value_identifiers: [], undefined_identifiers: [], defined_identifiers: [] });
  }
  const valueIds = sorted([...context.value_identifiers]);
  return new ExpressionAnalysis({ expression: stripped, ok: true, error: null, value, value_identifiers: valueIds,
    undefined_identifiers: valueIds.filter((n) => !table.has(n)), defined_identifiers: valueIds.filter((n) => table.has(n)) });
}

const DEFINE_NAME_RE = /\s*([A-Za-z_]\w*)(\()?/y;
const UNDEF_NAME_RE = /\s*([A-Za-z_]\w*)/y;
const DEFINE_ENTRY_NAME_RE = /^[A-Za-z_]\w*$/;

/** Parse repeatable `--define NAME[=VALUE]` entries in order (later may use earlier). */
export function parseDefines(values) {
  const result = new Map();
  for (const raw of values) {
    const eq = raw.indexOf("=");
    const name = (eq < 0 ? raw : raw.slice(0, eq)).trim();
    if (!name || !DEFINE_ENTRY_NAME_RE.test(name)) throw new ValueError(`invalid --define entry: ${strRepr(raw)}`);
    if (eq < 0) { result.set(name, null); continue; }
    const value = raw.slice(eq + 1).trim();
    if (!value) { result.set(name, null); continue; }
    const a = analyzeExpression(value, result);
    result.set(name, a.ok ? a.value : null);
  }
  return result;
}

function accumulateDefine(rest, defines) {
  const m = at(DEFINE_NAME_RE, rest, 0);
  if (!m) return;
  const name = m[1];
  if (m[2]) { defines.set(name, null); return; }
  const remainder = rest.slice(m.index + m[0].length).trim();
  if (!remainder) { defines.set(name, null); return; }
  const a = analyzeExpression(remainder, defines);
  defines.set(name, a.ok ? a.value : null);
}

function accumulateUndef(rest, defines) {
  const m = at(UNDEF_NAME_RE, rest, 0);
  if (m) defines.delete(m[1]);
}

const ACTIONS = {
  "always-true-by-absence": "define {undefined} explicitly (--define or an earlier #define), include the header that defines it, or delete this guard if the region should always compile in",
  "always-false-by-absence": "if this region should ever compile in, define {undefined} (or include its header); otherwise this guard is dead and the region can be deleted",
  "mixed-defined-undefined": "{undefined} is undefined here while {defined} is defined; define {undefined} explicitly or confirm the guard is meant to depend on partial definition",
  "unparseable-expression": "audit this guard by hand; the scanner could not parse its expression ({error})",
};
const SEVERITY_FOR_KIND = { "always-true-by-absence": "high", "mixed-defined-undefined": "medium", "always-false-by-absence": "info", "unparseable-expression": "note" };
const joinNames = (names) => (names.length ? names.join(", ") : "(none)");
const actionFor = (kind, a) => ACTIONS[kind].replaceAll("{undefined}", joinNames(a.undefined_identifiers)).replaceAll("{defined}", joinNames(a.defined_identifiers)).replaceAll("{error}", a.error || "unknown error");

/** One `#if`/`#elif` whose truth was decided by an absent identifier. */
export class Finding {
  constructor(f) { Object.assign(this, { error: null, ...f }); Object.freeze(this); }
  asDict() {
    return {
      kind: this.kind, severity: this.severity, source: this.source, directive: this.directive, line: this.line,
      expression: this.expression, value: this.value, undefined_identifiers: [...this.undefined_identifiers],
      defined_identifiers: [...this.defined_identifiers],
      region: { first_line: this.region_first_line, last_line: this.region_last_line, line_count: this.region_line_count, first_source_line: this.region_first_source_line },
      action: this.action, error: this.error,
    };
  }
}

function classify(a) {
  if (!a.ok) return "unparseable-expression";
  if (!a.value_identifiers.length) return null;
  if (a.undefined_identifiers.length === a.value_identifiers.length) return a.value !== 0n ? "always-true-by-absence" : "always-false-by-absence";
  if (a.undefined_identifiers.length) return "mixed-defined-undefined";
  return null;
}

const DIRECTIVE_RE = /^[ \t]*#[ \t]*([A-Za-z_]+)([\s\S]*)$/;

/** Scan one file's `#if`/`#elif` guards, folding its `#define`s into `defines`. */
export function scanConditionals(text, source, defines) {
  const originalLines = text.split("\n");
  const logical = logicalLines(stripComments(text));
  const stack = [];
  const findings = [];
  const close = (frame, endLine) => {
    const pending = frame.pending;
    if (!pending) return;
    const regionLast = Math.max(endLine - 1, pending.region_start - 1);
    const lineCount = Math.max(0, regionLast - pending.region_start + 1);
    let firstSource = "";
    if (lineCount > 0) {
      const index = pending.region_start - 1;
      if (index >= 0 && index < originalLines.length) firstSource = originalLines[index].trim();
    }
    const a = analyzeExpression(pending.expression, defines);
    const kind = classify(a);
    if (kind) {
      findings.push(new Finding({ kind, severity: SEVERITY_FOR_KIND[kind], source, directive: pending.directive, line: pending.line,
        expression: a.expression, value: a.value, undefined_identifiers: a.undefined_identifiers, defined_identifiers: a.defined_identifiers,
        region_first_line: pending.region_start, region_last_line: regionLast, region_line_count: lineCount,
        region_first_source_line: firstSource, action: actionFor(kind, a), error: a.error }));
    }
    frame.pending = null;
  };
  for (const line of logical) {
    const m = DIRECTIVE_RE.exec(line.text);
    if (!m) continue;
    const keyword = m[1].trim().toLowerCase();
    const rest = m[2];
    if (keyword === "if") stack.push({ pending: { directive: "if", expression: rest, line: line.start, region_start: line.end + 1 } });
    else if (keyword === "ifdef" || keyword === "ifndef") stack.push({ pending: null });
    else if (keyword === "elif") {
      if (!stack.length) continue;
      const frame = stack.at(-1);
      close(frame, line.start);
      frame.pending = { directive: "elif", expression: rest, line: line.start, region_start: line.end + 1 };
    } else if (keyword === "else") { if (stack.length) close(stack.at(-1), line.start); }
    else if (keyword === "endif") { if (stack.length) { close(stack.at(-1), line.start); stack.pop(); } }
    else if (keyword === "define") accumulateDefine(rest, defines);
    else if (keyword === "undef") accumulateUndef(rest, defines);
  }
  const eofLine = originalLines.length + 1;
  while (stack.length) close(stack.pop(), eofLine);
  return findings;
}

/** Findings for one lint run, plus the macro table it ended with. */
export class LintReport {
  constructor({ files, findings, defines }) { Object.assign(this, { files, findings, defines }); Object.freeze(this); }
  asDict() { return { schema: CONTEXT_LINT_SCHEMA, files: [...this.files], findings: this.findings.map((f) => f.asDict()), defines: Object.fromEntries(this.defines) }; }
}

/** Scan `[label, text]` pairs in order, accumulating macros across them. */
export function lintSources(sources, defines = null) {
  const table = new Map(asMap(defines ?? {}));
  let findings = [];
  for (const [name, text] of sources) findings.push(...scanConditionals(text, name, table));
  findings = sorted(findings, (f) => [SEVERITY_ORDER[f.severity], f.source, f.line]);
  return new LintReport({ files: sources.map(([n]) => n), findings, defines: table });
}

/** Read and scan files from disk in the order given. */
export function lintFiles(paths, defines = null, { cwd = process.cwd() } = {}) {
  const sources = paths.map((p) => [String(p), fs.readFileSync(p.startsWith("/") ? p : `${cwd}/${p}`, "utf8")]);
  return lintSources(sources, defines);
}

// File-scope definitions (the duplicate-symbol pass of scratch checks).

const DECL_KEYWORDS = new Set(["if", "for", "while", "switch", "return", "sizeof", "do", "else", "goto", "case", "default", "break", "continue",
  "struct", "union", "enum", "void", "static", "const", "volatile", "extern", "register", "unsigned", "signed", "inline", "auto", "typedef"]);
const ARRAY_RE = /\[[^\]]*\]/g;
const IDENT_ALL = /[A-Za-z_]\w*/g;

function lineBraceDelta(line) {
  let delta = 0, str = false, chr = false, i = 0;
  const n = line.length;
  while (i < n) {
    const ch = line[i];
    if (str) { if (ch === "\\") { i += 2; continue; } if (ch === '"') str = false; i += 1; continue; }
    if (chr) { if (ch === "\\") { i += 2; continue; } if (ch === "'") chr = false; i += 1; continue; }
    if (ch === '"') str = true; else if (ch === "'") chr = true; else if (ch === "{") delta += 1; else if (ch === "}") delta -= 1;
    i += 1;
  }
  return delta;
}

function extractDeclarationName(statement) {
  statement = statement.trim();
  if (!statement) return null;
  if (statement.startsWith("typedef")) {
    const ids = (statement.match(IDENT_ALL) ?? []).filter((t) => !DECL_KEYWORDS.has(t));
    return ids.length ? ids.at(-1) : null;
  }
  let head = statement.split("=")[0];
  head = head.replace(ARRAY_RE, " ");
  if (head.includes("(")) return null;
  const ids = (head.match(IDENT_ALL) ?? []).filter((t) => !DECL_KEYWORDS.has(t));
  if (ids.length < 2) return null;
  return ids.at(-1);
}

function extractFunctionName(signature) {
  signature = signature.trim();
  if (!signature.includes("(")) return null;
  const m = /^[^()]*?([A-Za-z_]\w*)\s*\(/.exec(signature);
  if (!m) return null;
  return DECL_KEYWORDS.has(m[1]) ? null : m[1];
}

/** Best-effort map of file-scope symbol name to its first defining line. */
export function fileScopeDefinitions(text) {
  const names = new Map();
  let depth = 0;
  splitlines(stripComments(text)).forEach((raw, i) => {
    const lineno = i + 1;
    const line = raw.trim();
    const startDepth = depth;
    depth = Math.max(0, depth + lineBraceDelta(raw));
    if (startDepth !== 0 || !line || line.startsWith("#")) return;
    if (line.startsWith("extern")) return;
    if (line.endsWith("{") && depth > startDepth) {
      const name = extractFunctionName(line);
      if (name !== null && !names.has(name)) names.set(name, lineno);
      return;
    }
    if (line.endsWith(";") && depth === startDepth) {
      const name = extractDeclarationName(line.slice(0, -1));
      if (name !== null && !names.has(name)) names.set(name, lineno);
    }
  });
  return names;
}

/** File-scope definitions repeated across at least two sources. */
export function duplicateFileScopeDefinitions(sources) {
  const occurrences = new Map();
  for (const [source, text] of sources) {
    for (const [symbol, line] of fileScopeDefinitions(text)) {
      if (!occurrences.has(symbol)) occurrences.set(symbol, []);
      occurrences.get(symbol).push({ source, line });
    }
  }
  return sorted([...occurrences.entries()], (e) => e[0]).filter(([, items]) => items.length > 1).map(([symbol, items]) => ({ symbol, occurrences: items }));
}

/** The report lines the CLI and scratch-check embedding print. */
export function renderReport(report) {
  const lines = [`context lint: ${report.findings.length} finding(s) across ${report.files.length} file(s)`];
  if (!report.findings.length) { lines.push("no undefined-identifier collapse found in #if/#elif guards"); return lines; }
  for (const f of report.findings) {
    lines.push(`[${f.severity.toUpperCase()}] ${f.kind}  ${f.source}:${f.line}  #${f.directive} ${f.expression}`);
    if (f.region_line_count > 0) {
      lines.push(`  guarded region: lines ${f.region_first_line}-${f.region_last_line} (${f.region_line_count} line(s)), first line: ${strRepr(f.region_first_source_line)}`);
    } else lines.push("  guarded region: empty");
    if (f.undefined_identifiers.length) lines.push(`  undefined: ${f.undefined_identifiers.join(", ")}`);
    if (f.defined_identifiers.length) lines.push(`  defined: ${f.defined_identifiers.join(", ")}`);
    lines.push(`  do: ${f.action}`);
  }
  return lines;
}
export { tokenize as _tokenize };
