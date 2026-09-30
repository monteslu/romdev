// A C preprocessor in plain JS for the recompile-gen scripts, which turn
// emulator core sources into committed data at development time.
//
// It follows GCC's cpp closely enough that its output can stand in for
// `cpp -P`: object- and function-like macros (variadic, # and ##, the GNU
// `, ## __VA_ARGS__` comma), rescanning with GCC's per-macro disabling, the
// conditional directives with a 64-bit #if evaluator (defined, __has_include),
// #include with -I search paths, and GCC's output spacing (a space is written
// where the source had whitespace, or where two tokens would otherwise lex
// as one; padding around macro expansions and arguments decides which source
// token's whitespace counts). Headers not found on the search paths are
// "system" headers: they are not read, and the caller supplies the macros it
// needs from them as predefines.
//
// Exports:
//   lex(src)                      preprocessing tokens {t, v, ws, bol}
//   expandTokens(toks, macros)    macro-expand a token list in isolation
//   parseDefine(toks)             a #define body -> macro
//   Preprocessor                  whole translation units -> text

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

const PUNCT = [
  "%:%:", "...", "<<=", ">>=",
  "->", "++", "--", "<<", ">>", "<=", ">=", "==", "!=", "&&", "||", "*=", "/=", "%=", "+=", "-=",
  "&=", "^=", "|=", "##", "<:", ":>", "<%", "%>", "%:",
  "[", "]", "(", ")", "{", "}", ".", "&", "*", "+", "-", "~", "!", "/", "%", "<", ">", "^", "|",
  "?", ":", ";", "=", ",", "#",
];
const DIGRAPH = { "<:": "[", ":>": "]", "<%": "{", "%>": "}", "%:": "#", "%:%:": "##" };

const isIdStart = (c) => (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_" || c === "$";
const isIdChar = (c) => isIdStart(c) || (c >= "0" && c <= "9");
const isDigit = (c) => c >= "0" && c <= "9";

/**
 * Split C source into preprocessing tokens. Every token carries
 * `ws` (whitespace or a comment precedes it on its line) and `bol` (it is the
 * first token of a logical line; a newline inside a block comment does not
 * start a new line, as in GCC). Line splices are removed first.
 * @param {string} src
 * @returns {{t: string, v: string, ws: boolean, bol: boolean}[]}
 */
export function lex(src) {
  src = src.replace(/\r\n?/g, "\n").replace(/\\[ \t]*\n/g, "");
  const toks = [];
  let i = 0, ws = false, bol = true;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === "\n") { i++; ws = false; bol = true; continue; }
    if (c === " " || c === "\t" || c === "\f" || c === "\v") { i++; ws = true; continue; }
    if (c === "/" && src[i + 1] === "*") {
      const e = src.indexOf("*/", i + 2);
      if (e < 0) throw new Error("cpp: unterminated comment");
      i = e + 2; ws = true; continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      while (i < n && src[i] !== "\n") i++;
      ws = true; continue;
    }
    let j = i, t;
    // string / char literals, with an optional encoding prefix
    const pre = /^(?:u8|u|U|L)?(["'])/.exec(src.slice(i, i + 3));
    if (pre) {
      const q = pre[1];
      j = i + pre[0].length;
      while (j < n && src[j] !== q) {
        if (src[j] === "\\") j++;
        if (src[j] === "\n") break;
        j++;
      }
      j++;
      t = q === '"' ? "str" : "chr";
    } else if (isDigit(c) || (c === "." && isDigit(src[i + 1] ?? ""))) {
      j = i + 1;
      while (j < n) {
        const d = src[j];
        if ((d === "+" || d === "-") && /[eEpP]/.test(src[j - 1])) { j++; continue; }
        if (isIdChar(d) || d === ".") { j++; continue; }
        break;
      }
      t = "num";
    } else if (isIdStart(c)) {
      j = i + 1;
      while (j < n && isIdChar(src[j])) j++;
      t = "id";
    } else {
      const p = PUNCT.find((q) => src.startsWith(q, i));
      if (p) { j = i + p.length; t = "p"; } else { j = i + 1; t = "other"; }
    }
    let v = src.slice(i, j);
    if (t === "p" && DIGRAPH[v]) v = DIGRAPH[v];
    toks.push({ t, v, ws, bol });
    ws = false; bol = false;
    i = j;
  }
  return toks;
}

// ------------------------------------------------------------------ macros

/**
 * Would writing b straight after a make a different token sequence?
 * (GCC's cpp_avoid_paste.)
 */
function avoidPaste(a, b) {
  const c = b.t === "p" ? b.v[0] : "";
  if (a.t === "p") {
    const x = a.v;
    if (c === "=" && ["=", "!", ">", "<", "+", "-", "*", "/", "%", "&", "|", "^", ">>", "<<"].includes(x)) return true;
    switch (x) {
      case ">": return c === ">";
      case "<": return c === "<" || c === "%" || c === ":";
      case "+": return c === "+";
      case "-": return c === "-" || c === ">";
      case "/": return c === "/" || c === "*";
      case "%": return c === ":" || c === "%";
      case "&": return c === "&";
      case "|": return c === "|";
      case ":": return c === ":" || c === ">";
      case "->": return c === "*";
      case ".": return c === "." || c === "%" || b.t === "num";
      case "#": return c === "#" || c === "%";
      default: return false;
    }
  }
  if (a.t === "id") return b.t === "num" || b.t === "id" || b.t === "chr" || b.t === "str";
  if (a.t === "num") return b.t === "num" || b.t === "id" || b.t === "chr" || c === "." || c === "+" || c === "-";
  return false;
}

/**
 * Parse the tokens after `#define` into a macro.
 * Body entries are tokens, or {t:"param", i, ws, str} for a parameter
 * (str: preceded by #). `paste` on an entry means ## follows it.
 */
export function parseDefine(toks, where = "") {
  const name = toks[0];
  if (!name || name.t !== "id") throw new Error(`cpp: bad #define ${where}`);
  let i = 1, params = null, variadic = false;
  if (toks[1] && toks[1].v === "(" && !toks[1].ws) {
    params = [];
    i = 2;
    for (;;) {
      const k = toks[i++];
      if (!k) throw new Error(`cpp: unterminated parameter list of ${name.v} ${where}`);
      if (k.v === ")") break;
      if (k.v === ",") continue;
      if (k.v === "...") { params.push("__VA_ARGS__"); variadic = true; continue; }
      if (k.t !== "id") throw new Error(`cpp: bad parameter '${k.v}' of ${name.v} ${where}`);
      if (toks[i] && toks[i].v === "...") { i++; variadic = true; }
      params.push(k.v);
    }
  }
  const raw = toks.slice(i);
  const body = [];
  for (let k = 0; k < raw.length; k++) {
    const x = raw[k];
    if (x.t === "p" && x.v === "##") {
      if (!body.length || k === raw.length - 1) throw new Error(`cpp: ## at the edge of ${name.v} ${where}`);
      body[body.length - 1] = { ...body[body.length - 1], paste: true };
      continue;
    }
    if (params && x.t === "p" && x.v === "#" && raw[k + 1]?.t === "id" && params.includes(raw[k + 1].v)) {
      body.push({ t: "param", i: params.indexOf(raw[k + 1].v), ws: x.ws, str: true });
      k++;
      continue;
    }
    if (params && x.t === "id" && params.includes(x.v)) {
      body.push({ t: "param", i: params.indexOf(x.v), ws: x.ws, str: false });
      continue;
    }
    body.push({ t: x.t, v: x.v, ws: x.ws });
  }
  if (body.length) body[0] = { ...body[0], ws: false };
  return { name: name.v, params, variadic, body };
}

const PAD_END = Object.freeze({ t: "pad", src: null });
const EOF = Object.freeze({ t: "eof", v: "" });

function stringify(arg) {
  let s = "", source = null, first = true;
  for (const k of arg) {
    if (k.t === "pad") {
      if (source === null || (!source.ws && k.src === null)) source = k.src;
      continue;
    }
    if (!first) { if (source === null) source = k; if (source.ws) s += " "; }
    source = null;
    first = false;
    s += k.t === "str" || k.t === "chr" ? k.v.replace(/[\\"]/g, "\\$&") : k.v;
  }
  return { t: "str", v: `"${s}"`, ws: false };
}

/**
 * The expansion engine: GCC's cpp_get_token over a stack of token contexts
 * above a base reader. It returns real tokens and padding tokens
 * ({t:"pad", src}) exactly where GCC does, so a printer can reproduce GCC's
 * spacing.
 */
class Engine {
  /**
   * @param {Map<string, any>} macros
   * @param {{next(): any, back(): void}} base  next() returns a token or EOF
   */
  constructor(macros, base) {
    this.macros = macros;
    this.base = base;
    this.ctx = []; // {toks, i, macro}
    this.prevent = 0;
    this.parsingArgs = 0;
    this.disabled = new Set();
  }

  raw() {
    for (;;) {
      const c = this.ctx.at(-1);
      if (!c) return { tok: this.base.next(), fromBase: true };
      if (c.i < c.toks.length) return { tok: c.toks[c.i++], fromBase: false };
      if (c.stop) return { tok: EOF, fromBase: false };
      this.ctx.pop();
      if (c.macro) this.disabled.delete(c.macro);
      return { tok: PAD_END, fromBase: false };
    }
  }

  back(fromBase) {
    if (fromBase) this.base.back();
    else this.ctx.at(-1).i--;
  }

  push(toks, macro = null) { this.ctx.push({ toks, i: 0, macro }); }

  next() {
    for (;;) {
      const { tok } = this.raw();
      if (tok.t !== "id" || tok.noexp) return tok;
      const m = this.macros.get(tok.v);
      if (!m) return tok;
      if (this.disabled.has(tok.v)) return { ...tok, noexp: true };
      if (this.prevent) return tok;
      const r = this.enter(m, tok);
      if (r) return { t: "pad", src: tok };
      return tok;
    }
  }

  /** Expand macro m named by token nameTok; false if it was not invoked. */
  enter(m, nameTok) {
    let args = null;
    if (m.params) {
      this.prevent++;
      this.parsingArgs = 1;
      let padding = null, tok, fromBase;
      for (;;) {
        ({ tok, fromBase } = this.raw());
        if (tok.t !== "pad") break;
        if (padding === null || (!padding.ws && tok.src === null)) padding = tok;
      }
      if (tok.v === "(" && tok.t === "p") {
        this.parsingArgs = 2;
        args = this.collectArgs(m, nameTok);
      } else {
        if (tok !== EOF) this.back(fromBase);
        if (padding) this.push([padding]);
      }
      this.parsingArgs = 0;
      this.prevent--;
      if (!args) return false;
    }
    this.push(m.params ? this.replaceArgs(m, args) : m.body.map((x) => ({ ...x })), m.name);
    this.disabled.add(m.name);
    return true;
  }

  collectArgs(m, nameTok) {
    const args = [[]];
    let depth = 0;
    for (;;) {
      let { tok } = this.raw();
      if (tok.t === "id" && !tok.noexp && this.macros.has(tok.v) && this.disabled.has(tok.v)) tok = { ...tok, noexp: true };
      if (tok === EOF || tok.t === "eof") throw new Error(`cpp: unterminated call of ${nameTok.v}`);
      const cur = args[args.length - 1];
      if (tok.t === "pad") { if (cur.length) cur.push(tok); continue; }
      if (tok.t === "p" && tok.v === "(") depth++;
      else if (tok.t === "p" && tok.v === ")") { if (depth === 0) break; depth--; }
      else if (tok.t === "p" && tok.v === "," && depth === 0 && !(m.variadic && args.length === m.params.length)) {
        args.push([]);
        continue;
      }
      cur.push({ ...tok, bol: false });
    }
    // drop trailing padding
    for (const a of args) while (a.length && a[a.length - 1].t === "pad") a.pop();
    if (args.length === 1 && args[0].length === 0 && m.params.length === 0) args.length = 0;
    if (m.variadic && args.length === m.params.length - 1) args.push([]);
    if (args.length !== m.params.length) {
      throw new Error(`cpp: macro ${m.name} takes ${m.params.length} arguments, got ${args.length}`);
    }
    return args;
  }

  expandArg(arg) {
    this.ctx.push({ toks: arg, i: 0, macro: null, stop: true });
    const depth = this.ctx.length;
    const out = [];
    for (;;) {
      const k = this.next();
      if (k === EOF && this.ctx.length === depth) break;
      out.push(k);
    }
    this.ctx.pop();
    return out;
  }

  replaceArgs(m, args) {
    const expanded = new Map();
    const exp = (i) => {
      if (!expanded.has(i)) expanded.set(i, this.expandArg(args[i]));
      return expanded.get(i);
    };
    const out = [];
    const b = m.body;
    for (let k = 0; k < b.length; k++) {
      const x = b[k];
      if (x.t !== "param") { out.push({ ...x }); continue; }
      if (x.str) {
        const s = stringify(args[x.i]);
        s.ws = x.ws;
        if (x.paste) s.paste = true;
        out.push(s);
        continue;
      }
      const prevPaste = k > 0 && b[k - 1].paste;
      const isVa = m.variadic && x.i === m.params.length - 1;
      if (prevPaste && isVa && args[x.i].length === 0) {
        // GNU: , ## __VA_ARGS__ with no variadic arguments drops the comma
        const last = out[out.length - 1];
        if (last && last.t === "p" && last.v === ",") { out.pop(); continue; }
      }
      const toks = x.paste || prevPaste ? args[x.i] : exp(x.i);
      if (k > 0 && !prevPaste) out.push({ t: "pad", src: x });
      if (toks.length) {
        for (const t of toks) out.push({ ...t });
        if (x.paste) out[out.length - 1] = { ...out[out.length - 1], paste: true };
        else if (prevPaste) out[out.length - 1] = { ...out[out.length - 1], paste: false };
      } else if (prevPaste) {
        // a placemarker on the right of ##: the left token is not pasted
        const last = out[out.length - 1];
        if (last) out[out.length - 1] = { ...last, paste: x.paste };
      }
      if (!x.paste) out.push(PAD_END);
    }
    return this.pasteAll(out, m.name);
  }

  /** Apply ## (GCC pastes when the pasted-left token is read). */
  pasteAll(toks, name) {
    const out = [];
    for (let k = 0; k < toks.length; k++) {
      let x = toks[k];
      if (!x.paste) { out.push(x); continue; }
      let s = x.v, ws = x.ws;
      while (x.paste) {
        let r = toks[++k];
        while (r && r.t === "pad") r = toks[++k];
        if (!r) break;
        s += r.v;
        x = r;
      }
      const lt = lex(s);
      if (lt.length !== 1) throw new Error(`cpp: ## in ${name} made '${s}', not one token`);
      out.push({ t: lt[0].t, v: lt[0].v, ws });
    }
    return out;
  }
}

/**
 * Macro-expand a token list on its own (no directives, no input beyond it).
 * @param {any[]} toks
 * @param {Map<string, any>} macros
 */
export function expandTokens(toks, macros) {
  let i = 0;
  const base = { next: () => (i < toks.length ? toks[i++] : EOF), back: () => { i--; } };
  const e = new Engine(macros, base);
  const out = [];
  for (;;) {
    const k = e.next();
    if (k === EOF) break;
    if (k.t !== "pad") out.push(k);
  }
  return out;
}

// ------------------------------------------------------------------ #if

function ifValue(toks, where) {
  let i = 0;
  const U64 = (1n << 64n) - 1n;
  const norm = (v, u) => {
    v &= U64;
    if (!u && v >= 1n << 63n) v -= 1n << 64n;
    return { v, u };
  };
  const peek = () => toks[i];
  const eat = (v) => {
    const k = toks[i++];
    if (!k || k.v !== v) throw new Error(`cpp: #if ${where}: expected '${v}'`);
  };
  const num = (k) => {
    if (k.t === "chr") {
      const body = k.v.replace(/^[uUL8]*'|'$/g, "");
      const esc = { n: 10, t: 9, r: 13, 0: 0, "\\": 92, "'": 39, '"': 34 };
      const c = body[0] === "\\" ? BigInt(esc[body[1]] ?? body.charCodeAt(1)) : BigInt(body.charCodeAt(0));
      return norm(c, false);
    }
    const m = /^(0[xX][0-9a-fA-F]+|0[bB][01]+|0[0-7]*|[1-9][0-9]*)([uUlL]*)$/.exec(k.v);
    if (!m) throw new Error(`cpp: #if ${where}: bad number ${k.v}`);
    let d = m[1];
    if (/^0[0-7]+$/.test(d)) d = "0o" + d.slice(1);
    const v = BigInt(d);
    const u = /[uU]/.test(m[2]) || v > (1n << 63n) - 1n;
    return norm(v, u);
  };
  const bin = {
    "*": [10, (a, b) => a * b], "/": [10, (a, b) => a / b], "%": [10, (a, b) => a % b],
    "+": [9, (a, b) => a + b], "-": [9, (a, b) => a - b],
    "<<": [8, (a, b) => a << b], ">>": [8, (a, b) => a >> b],
    "<": [7], ">": [7], "<=": [7], ">=": [7], "==": [6], "!=": [6],
    "&": [5, (a, b) => a & b], "^": [4, (a, b) => a ^ b], "|": [3, (a, b) => a | b],
    "&&": [2], "||": [1],
  };
  const unary = () => {
    const k = toks[i++];
    if (!k) throw new Error(`cpp: #if ${where}: unexpected end`);
    if (k.t === "p") {
      if (k.v === "(") { const v = expr(0); eat(")"); return v; }
      if (k.v === "+") return unary();
      if (k.v === "-") { const a = unary(); return norm(-a.v, a.u); }
      if (k.v === "~") { const a = unary(); return norm(~a.v, a.u); }
      if (k.v === "!") { const a = unary(); return norm(a.v === 0n ? 1n : 0n, false); }
    }
    if (k.t === "num" || k.t === "chr") return num(k);
    if (k.t === "id") return norm(0n, false);
    throw new Error(`cpp: #if ${where}: unexpected '${k.v}'`);
  };
  const expr = (minPrec) => {
    let a = unary();
    for (;;) {
      const k = peek();
      if (!k) return a;
      if (k.v === "?" && minPrec === 0) {
        i++;
        const t = expr(0); eat(":"); const f = expr(0);
        const u = t.u || f.u;
        a = a.v !== 0n ? norm(t.v, u) : norm(f.v, u);
        continue;
      }
      const op = k.t === "p" ? bin[k.v] : null;
      if (!op || op[0] < minPrec) return a;
      i++;
      const b = expr(op[0] + 1);
      if (k.v === "&&") { a = norm(a.v !== 0n && b.v !== 0n ? 1n : 0n, false); continue; }
      if (k.v === "||") { a = norm(a.v !== 0n || b.v !== 0n ? 1n : 0n, false); continue; }
      const u = a.u || b.u;
      const x = norm(a.v, u).v, y = norm(b.v, u).v;
      if (op[1]) {
        if ((k.v === "/" || k.v === "%") && y === 0n) throw new Error(`cpp: #if ${where}: division by zero`);
        const r = k.v === "<<" || k.v === ">>" ? op[1](x, b.v) : op[1](x, y);
        a = norm(r, k.v === "<<" || k.v === ">>" ? a.u : u);
      } else {
        const r = { "<": x < y, ">": x > y, "<=": x <= y, ">=": x >= y, "==": x === y, "!=": x !== y }[k.v];
        a = norm(r ? 1n : 0n, false);
      }
    }
  };
  const v = expr(0);
  if (i !== toks.length) throw new Error(`cpp: #if ${where}: trailing '${toks[i].v}'`);
  return v.v !== 0n;
}

// ------------------------------------------------------------------ files

/**
 * Preprocess translation units the way `cpp -P <defines> -I... file` does.
 *
 * options:
 *   includePaths  -I directories, in order
 *   defines       -D definitions: {NAME: "body"} (body "" defines it empty)
 *   predefined    source text run before the file (compiler predefines and
 *                 the system-header macros the sources rely on)
 */
export class Preprocessor {
  constructor({ includePaths = [], defines = {}, predefined = "" } = {}) {
    this.includePaths = includePaths;
    /** @type {Map<string, any>} */
    this.macros = new Map();
    this.once = new Set();
    this.systemIncludes = new Set();
    this.files = [];
    if (predefined) this.defineText(predefined);
    for (const [k, v] of Object.entries(defines)) this.defineText(`#define ${k} ${v}`);
  }

  defineText(text) {
    for (const line of text.split("\n")) {
      const t = lex(line);
      if (!t.length) continue;
      if (t[0].v !== "#" || t[1]?.v !== "define") throw new Error(`cpp: predefine is not a #define: ${line}`);
      const m = parseDefine(t.slice(2), "(predefined)");
      this.macros.set(m.name, m);
    }
  }

  resolve(name, angled, fromDir) {
    const dirs = angled ? this.includePaths : [fromDir, ...this.includePaths];
    for (const d of dirs) {
      const p = path.join(d, name);
      if (existsSync(p)) return p;
    }
    return null;
  }

  /**
   * Preprocess a file (or {name, text}) and return GCC -P style text.
   * @param {string | {name: string, text: string}} file
   */
  run(file) {
    const out = [];
    let line = "";
    let printed = false;
    const pr = { source: null, prev: null };
    let avoid = false;
    // GCC's cb_line_change: a new source line starts a new output line
    const lineChange = () => {
      if (printed) { out.push(line); line = ""; }
      printed = true;
      pr.source = null; pr.prev = null;
    };
    const stack = [];
    const self = this;
    const openFile = (p, text) => {
      stack.push({ path: p, dir: path.dirname(p), toks: lex(text), i: 0, cond: [] });
      this.files.push(p);
    };
    if (typeof file === "string") openFile(file, readFileSync(file, "utf8"));
    else openFile(file.name, file.text);

    const engine = new Engine(this.macros, null);
    const base = {
      next() {
        for (;;) {
          const f = stack[stack.length - 1];
          if (!f) return EOF;
          if (f.i >= f.toks.length) {
            if (f.cond.length) throw new Error(`cpp: unterminated #if in ${f.path}`);
            stack.pop();
            continue;
          }
          const tok = f.toks[f.i];
          if (tok.bol && tok.t === "p" && tok.v === "#" && engine.parsingArgs !== 1) {
            let j = f.i + 1;
            while (j < f.toks.length && !f.toks[j].bol) j++;
            const dir = f.toks.slice(f.i + 1, j);
            f.i = j;
            self.directive(dir, f, stack, openFile);
            continue;
          }
          if (f.cond.some((c) => !c.active)) { f.i++; continue; }
          f.i++;
          if (tok.bol && !engine.parsingArgs) lineChange();
          return tok;
        }
      },
      back() {
        stack[stack.length - 1].i--;
      },
    };
    engine.base = base;
    this.engine = engine;

    for (;;) {
      const k = engine.next();
      if (k === EOF) break;
      if (k.t === "pad") {
        avoid = true;
        if (pr.source === null || (!pr.source.ws && k.src === null)) pr.source = k.src;
        continue;
      }
      let space = false;
      if (avoid) {
        if (pr.source === null) pr.source = k;
        space = pr.source.ws || (pr.prev !== null && avoidPaste(pr.prev, k));
      } else space = !!k.ws;
      if (space) line += " ";
      avoid = false;
      pr.source = null;
      pr.prev = k;
      line += k.v;
    }
    if (printed) out.push(line);
    return out.join("\n") + "\n";
  }

  directive(dir, f, stack, openFile) {
    const where = `in ${f.path}`;
    if (!dir.length) return;
    const d = dir[0].v;
    const rest = dir.slice(1);
    const cond = f.cond;
    const active = cond.every((c) => c.active);
    switch (d) {
      case "ifdef":
      case "ifndef": {
        if (!active) { cond.push({ active: false, taken: true }); return; }
        const def = this.macros.has(rest[0]?.v);
        const on = d === "ifdef" ? def : !def;
        cond.push({ active: on, taken: on });
        return;
      }
      case "if": {
        if (!active) { cond.push({ active: false, taken: true }); return; }
        const on = this.evalIf(rest, f, where);
        cond.push({ active: on, taken: on });
        return;
      }
      case "elif": {
        const c = cond[cond.length - 1];
        if (!c) throw new Error(`cpp: #elif without #if ${where}`);
        const outer = cond.slice(0, -1).every((x) => x.active);
        if (c.taken || !outer) { c.active = false; return; }
        c.active = this.evalIf(rest, f, where);
        c.taken = c.active;
        return;
      }
      case "else": {
        const c = cond[cond.length - 1];
        if (!c) throw new Error(`cpp: #else without #if ${where}`);
        c.active = !c.taken;
        c.taken = true;
        return;
      }
      case "endif":
        if (!cond.pop()) throw new Error(`cpp: #endif without #if ${where}`);
        return;
    }
    if (!active) return;
    switch (d) {
      case "define": {
        const m = parseDefine(rest, where);
        this.macros.set(m.name, m);
        return;
      }
      case "undef":
        this.macros.delete(rest[0]?.v);
        return;
      case "include":
      case "include_next": {
        let toks = rest;
        if (toks[0]?.t !== "str" && toks[0]?.v !== "<") toks = expandTokens(toks, this.macros);
        let name, angled;
        if (toks[0]?.t === "str") { name = toks[0].v.slice(1, -1); angled = false; }
        else if (toks[0]?.v === "<") {
          const e = toks.findIndex((k) => k.v === ">");
          name = toks.slice(1, e).map((k, i) => (i && k.ws ? " " : "") + k.v).join("");
          angled = true;
        } else throw new Error(`cpp: bad #include ${where}`);
        const p = d === "include" ? this.resolve(name, angled, f.dir) : null;
        if (!p) { this.systemIncludes.add(name); return; }
        if (this.once.has(p)) return;
        openFile(p, readFileSync(p, "utf8"));
        return;
      }
      case "pragma":
        if (rest[0]?.v === "once") this.once.add(f.path);
        return;
      case "error":
        throw new Error(`cpp: #error ${rest.map((k) => k.v).join(" ")} ${where}`);
      case "warning":
      case "line":
      case "ident":
        return;
      default:
        throw new Error(`cpp: unknown directive #${d} ${where}`);
    }
  }

  evalIf(toks, f, where) {
    const pre = [];
    for (let i = 0; i < toks.length; i++) {
      const k = toks[i];
      if (k.t === "id" && (k.v === "defined" || k.v === "__has_include" || k.v === "__has_include_next")) {
        let j = i + 1, paren = false;
        if (toks[j]?.v === "(") { paren = true; j++; }
        let val;
        if (k.v === "defined") {
          val = this.macros.has(toks[j].v) || ["__has_include", "__has_include_next"].includes(toks[j].v);
          j++;
        } else {
          let name, angled;
          if (toks[j].t === "str") { name = toks[j].v.slice(1, -1); angled = false; j++; }
          else {
            const e = toks.findIndex((x, q) => q > j && x.v === ">");
            name = toks.slice(j + 1, e).map((x) => x.v).join("");
            angled = true;
            j = e + 1;
          }
          val = k.v === "__has_include" && this.resolve(name, angled, f.dir) !== null;
        }
        if (paren) { if (toks[j]?.v !== ")") throw new Error(`cpp: bad ${k.v} ${where}`); j++; }
        pre.push({ t: "num", v: val ? "1" : "0", ws: k.ws });
        i = j - 1;
        continue;
      }
      pre.push(k);
    }
    return ifValue(expandTokens(pre, this.macros), where);
  }
}
