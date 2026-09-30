// c_lexer.js - the C lexer, a port of pycparser's c_lexer.py running on a port
// of PLY's lex engine (ply/lex.py, optimized-table mode).
//
// Upstream builds its lexer with optimize=True, which loads the master regexes
// from the committed lextab.py. tables/lextab.json is that file as data; the
// patterns are Python regexes (compiled with re.VERBOSE), translated to JS
// once at load time by pyRegexToJs().
import lextab from "./tables/lextab.json" with { type: "json" };

export class LexToken {
  constructor() {
    this.type = null;
    this.value = null;
    this.lineno = 0;
    this.lexpos = 0;
  }

  toString() { return `LexToken(${this.type},${JSON.stringify(this.value)},${this.lineno},${this.lexpos})`; }
}

export class LexError extends Error {
  constructor(message, text) {
    super(message);
    this.text = text;
  }
}

/**
 * Translate a Python (re.VERBOSE when `verbose`) pattern to a JS RegExp source.
 * Handles the constructs the pycparser lexer uses: named groups, `.` (no
 * DOTALL: every char but \n), `$` (end, or before a final \n), and verbose
 * whitespace/comments outside character classes.
 */
export function pyRegexToJs(pat, verbose) {
  let out = "";
  let inClass = false;
  for (let i = 0; i < pat.length; i++) {
    const c = pat[i];
    if (c === "\\") {
      out += c + (pat[i + 1] ?? "");
      i++;
      continue;
    }
    if (inClass) {
      if (c === "]" && !(out.endsWith("[") || out.endsWith("[^"))) inClass = false;
      out += c;
      continue;
    }
    if (c === "[") { inClass = true; out += c; continue; }
    if (verbose && /\s/.test(c)) continue;
    if (verbose && c === "#") {
      while (i < pat.length && pat[i] !== "\n") i++;
      continue;
    }
    if (c === "(" && pat.startsWith("(?P<", i)) { out += "(?<"; i += 3; continue; }
    if (c === ".") { out += "[^\\n]"; continue; }
    if (c === "$") { out += "(?=\\n?$)"; continue; }
    out += c;
  }
  return out;
}

const VERBOSE = 64;

/** Compiled per-state tables: [{re, names:[[func|null, type]|null,...], groups:[{name, idx}]}] */
function compileStates() {
  const states = {};
  for (const [state, list] of Object.entries(lextab.statere)) {
    states[state] = list.map(({ pattern, names }) => {
      const src = pyRegexToJs(pattern, (lextab.reflags & VERBOSE) !== 0);
      const re = new RegExp(src, "y");
      // Top-level alternatives are named groups; map each name to its entry.
      const alts = [];
      names.forEach((entry, idx) => {
        if (entry) alts.push({ group: groupNameFor(pattern, idx), func: entry[0], type: entry[1] });
      });
      return { re, alts };
    });
  }
  return states;
}

// PLY names each alternative's group after its rule function or token name
// (t_NAME). Recover the group name at a given group index from the pattern.
function groupNameFor(pattern, index) {
  let idx = 0;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "\\") { i++; continue; }
    if (c === "[") {
      // skip the class
      i++;
      if (pattern[i] === "^") i++;
      if (pattern[i] === "]") i++;
      while (i < pattern.length && pattern[i] !== "]") { if (pattern[i] === "\\") i++; i++; }
      continue;
    }
    if (c === "(") {
      if (pattern[i + 1] === "?") {
        if (pattern.startsWith("(?P<", i)) {
          idx++;
          if (idx === index) return /^\(\?P<(\w+)>/.exec(pattern.slice(i))[1];
        }
        continue;
      }
      idx++;
      if (idx === index) throw new Error(`group ${index} is unnamed`);
    }
  }
  throw new Error(`no group ${index}`);
}

const STATES = compileStates();

/** PLY's Lexer object (the subset upstream uses), driving CLexer's rule methods. */
class PlyLexer {
  constructor(owner) {
    this.owner = owner;
    this.lexdata = null;
    this.lexpos = 0;
    this.lexlen = 0;
    this.lineno = 1;
    this.begin("INITIAL");
  }

  input(s) {
    if (typeof s !== "string") throw new TypeError("Expected a string");
    this.lexdata = s;
    this.lexpos = 0;
    this.lexlen = s.length;
  }

  begin(state) {
    if (!(state in STATES)) throw new Error("Undefined state");
    this.lexre = STATES[state];
    this.lexignore = lextab.stateignore[state] ?? "";
    this.lexerrorf = lextab.stateerrorf[state] ?? null;
    this.lexeoff = lextab.stateeoff[state] ?? null;
    this.lexstate = state;
  }

  skip(n) { this.lexpos += n; }

  token() {
    let lexpos = this.lexpos;
    const lexlen = this.lexlen;
    let lexignore = this.lexignore;
    const lexdata = this.lexdata;
    const owner = this.owner;
    outer:
    while (lexpos < lexlen) {
      if (lexignore.includes(lexdata[lexpos])) { lexpos++; continue; }
      for (const { re, alts } of this.lexre) {
        re.lastIndex = lexpos;
        const m = re.exec(lexdata);
        if (!m) continue;
        const tok = new LexToken();
        tok.value = m[0];
        tok.lineno = this.lineno;
        tok.lexpos = lexpos;
        let alt = null;
        for (const a of alts) if (m.groups[a.group] !== undefined) { alt = a; break; }
        tok.type = alt.type;
        const end = lexpos + m[0].length;
        if (!alt.func) {
          if (tok.type) { this.lexpos = end; return tok; }
          lexpos = end;
          continue outer;
        }
        lexpos = end;
        tok.lexer = this;
        this.lexmatch = m;
        this.lexpos = lexpos;
        const newtok = owner[alt.func](tok);
        if (!newtok) {
          lexpos = this.lexpos;
          lexignore = this.lexignore;
          continue outer;
        }
        return newtok;
      }
      // No match: literals (none in this grammar), then the error rule.
      if (lextab.literals.includes(lexdata[lexpos])) {
        const tok = new LexToken();
        tok.value = lexdata[lexpos];
        tok.lineno = this.lineno;
        tok.type = tok.value;
        tok.lexpos = lexpos;
        this.lexpos = lexpos + 1;
        return tok;
      }
      if (this.lexerrorf) {
        const tok = new LexToken();
        tok.value = lexdata.slice(lexpos);
        tok.lineno = this.lineno;
        tok.type = "error";
        tok.lexer = this;
        tok.lexpos = lexpos;
        this.lexpos = lexpos;
        const newtok = owner[this.lexerrorf](tok);
        if (lexpos === this.lexpos) {
          throw new LexError(`Scanning error. Illegal character '${lexdata[lexpos]}'`, lexdata.slice(lexpos));
        }
        lexpos = this.lexpos;
        if (!newtok) continue;
        return newtok;
      }
      this.lexpos = lexpos;
      throw new LexError(`Illegal character '${lexdata[lexpos]}' at index ${lexpos}`, lexdata.slice(lexpos));
    }
    this.lexpos = lexpos + 1;
    if (this.lexdata == null) throw new Error("No input string given with input()");
    return null;
  }
}

const keywords = [
  "AUTO", "BREAK", "CASE", "CHAR", "CONST",
  "CONTINUE", "DEFAULT", "DO", "DOUBLE", "ELSE", "ENUM", "EXTERN",
  "FLOAT", "FOR", "GOTO", "IF", "INLINE", "INT", "LONG",
  "REGISTER", "OFFSETOF",
  "RESTRICT", "RETURN", "SHORT", "SIGNED", "SIZEOF", "STATIC", "STRUCT",
  "SWITCH", "TYPEDEF", "UNION", "UNSIGNED", "VOID",
  "VOLATILE", "WHILE", "__INT128",
  "TYPEOF",
  "__ATTRIBUTE__", "ASM",
];
const keywordsNew = [
  "_BOOL", "_COMPLEX",
  "_NORETURN", "_THREAD_LOCAL", "_STATIC_ASSERT",
  "_ATOMIC", "_ALIGNOF", "_ALIGNAS",
  "_PRAGMA",
];

/** @type {Map<string,string>} */
const keywordMap = new Map();
for (const k of keywords) keywordMap.set(k.toLowerCase(), k);
for (const k of keywordsNew) keywordMap.set(k.slice(0, 2).toUpperCase() + k.slice(2).toLowerCase(), k);
// GNU extensions
for (const [k, v] of [
  ["typeof", "TYPEOF"], ["__typeof", "TYPEOF"], ["__typeof__", "TYPEOF"],
  ["__alignof", "_ALIGNOF"], ["__alignof__", "_ALIGNOF"],
  ["__attribute", "__ATTRIBUTE__"], ["__attribute__", "__ATTRIBUTE__"],
  ["asm", "ASM"], ["__asm", "ASM"], ["__asm__", "ASM"],
  ["__const", "CONST"], ["__const__", "CONST"],
  ["__restrict", "RESTRICT"], ["__restrict__", "RESTRICT"],
  ["__signed", "SIGNED"], ["__signed__", "SIGNED"],
  ["__inline", "INLINE"], ["__inline__", "INLINE"],
  ["__volatile", "VOLATILE"], ["__volatile__", "VOLATILE"],
  ["__extension__", ""],
]) keywordMap.set(k, v);

export const tokens = [...keywords, ...keywordsNew,
  "ID", "TYPEID",
  "INT_CONST_DEC", "INT_CONST_OCT", "INT_CONST_HEX", "INT_CONST_BIN", "INT_CONST_CHAR",
  "FLOAT_CONST", "HEX_FLOAT_CONST",
  "CHAR_CONST", "WCHAR_CONST", "U8CHAR_CONST", "U16CHAR_CONST", "U32CHAR_CONST",
  "STRING_LITERAL", "WSTRING_LITERAL", "U8STRING_LITERAL", "U16STRING_LITERAL", "U32STRING_LITERAL",
  "PLUS", "MINUS", "TIMES", "DIVIDE", "MOD",
  "OR", "AND", "NOT", "XOR", "LSHIFT", "RSHIFT",
  "LOR", "LAND", "LNOT",
  "LT", "LE", "GT", "GE", "EQ", "NE",
  "EQUALS", "TIMESEQUAL", "DIVEQUAL", "MODEQUAL",
  "PLUSEQUAL", "MINUSEQUAL",
  "LSHIFTEQUAL", "RSHIFTEQUAL", "ANDEQUAL", "XOREQUAL",
  "OREQUAL",
  "PLUSPLUS", "MINUSMINUS",
  "ARROW",
  "CONDOP",
  "LPAREN", "RPAREN",
  "LBRACKET", "RBRACKET",
  "LBRACE", "RBRACE",
  "COMMA", "PERIOD",
  "SEMI", "COLON",
  "ELLIPSIS",
  "PPHASH",
  "PPPRAGMA",
  "PPPRAGMASTR",
];

// Allow either "# line" or "# <num>" to support GCC's cpp output
const linePattern = /([ \t]*line\W)|([ \t]*\d+)/y;
const pragmaPattern = /[ \t]*pragma\W/y;

/**
 * A lexer for the C language (pycparser's CLexer). After build(), set the
 * input with input() and call token() for tokens.
 */
export class CLexer {
  constructor({ error_func, on_lbrace_func, on_rbrace_func, type_lookup_func }) {
    this.error_func = error_func;
    this.on_lbrace_func = on_lbrace_func;
    this.on_rbrace_func = on_rbrace_func;
    this.type_lookup_func = type_lookup_func;
    this.filename = "";
    this.last_token = null;
    this.pp_line = null;
    this.pp_filename = null;
  }

  build() {
    this.lexer = new PlyLexer(this);
    this.tokens = tokens;
  }

  reset_lineno() { this.lexer.lineno = 1; }

  input(text) { this.lexer.input(text); }

  token() {
    this.last_token = this.lexer.token();
    return this.last_token;
  }

  _error(msg, token) {
    this.error_func(msg, token.lineno, token.lexpos);
    this.lexer.skip(1);
  }

  t_PPHASH(t) {
    const lx = t.lexer;
    linePattern.lastIndex = lx.lexpos;
    pragmaPattern.lastIndex = lx.lexpos;
    if (linePattern.test(lx.lexdata)) {
      lx.begin("ppline");
      this.pp_line = this.pp_filename = null;
    } else if (pragmaPattern.test(lx.lexdata)) {
      lx.begin("pppragma");
    } else {
      t.type = "PPHASH";
      return t;
    }
    return null;
  }

  t_ppline_FILENAME(t) {
    if (this.pp_line == null) this._error("filename before line number in #line", t);
    else this.pp_filename = t.value.replace(/^"+/, "").replace(/"+$/, "");
    return null;
  }

  t_ppline_LINE_NUMBER(t) {
    if (this.pp_line == null) this.pp_line = t.value;
    // else: GCC's cpp sometimes inserts a numeric flag after the file name
    return null;
  }

  t_ppline_NEWLINE(t) {
    if (this.pp_line == null) this._error("line number missing in #line", t);
    else {
      this.lexer.lineno = pyInt(this.pp_line);
      if (this.pp_filename != null) this.filename = this.pp_filename;
    }
    t.lexer.begin("INITIAL");
    return null;
  }

  t_ppline_PPLINE() { return null; }

  t_ppline_error(t) { this._error("invalid #line directive", t); return null; }

  t_pppragma_NEWLINE(t) {
    t.lexer.lineno += 1;
    t.lexer.begin("INITIAL");
    return null;
  }

  t_pppragma_PPPRAGMA(t) { return t; }

  t_pppragma_STR(t) {
    t.type = "PPPRAGMASTR";
    return t;
  }

  t_pppragma_error(t) { this._error("invalid #pragma directive", t); return null; }

  t_NEWLINE(t) {
    t.lexer.lineno += t.value.split("\n").length - 1;
    return null;
  }

  t_LBRACE(t) { this.on_lbrace_func(); return t; }
  t_RBRACE(t) { this.on_rbrace_func(); return t; }

  t_FLOAT_CONST(t) { return t; }
  t_HEX_FLOAT_CONST(t) { return t; }
  t_INT_CONST_HEX(t) { return t; }
  t_INT_CONST_BIN(t) { return t; }
  t_BAD_CONST_OCT(t) { this._error("Invalid octal constant", t); return null; }
  t_UNSUPPORTED_C_STYLE_COMMENT(t) { this._error("Comments are not supported, see https://github.com/eliben/pycparser#3using.", t); return null; }
  t_UNSUPPORTED_CXX_STYLE_COMMENT(t) { this._error("Comments are not supported, see https://github.com/eliben/pycparser#3using.", t); return null; }
  t_INT_CONST_OCT(t) { return t; }
  t_INT_CONST_DEC(t) { return t; }
  t_INT_CONST_CHAR(t) { return t; }
  t_CHAR_CONST(t) { return t; }
  t_WCHAR_CONST(t) { return t; }
  t_U8CHAR_CONST(t) { return t; }
  t_U16CHAR_CONST(t) { return t; }
  t_U32CHAR_CONST(t) { return t; }
  t_UNMATCHED_QUOTE(t) { this._error("Unmatched '", t); return null; }
  t_BAD_CHAR_CONST(t) { this._error(`Invalid char constant ${t.value}`, t); return null; }
  t_WSTRING_LITERAL(t) { return t; }
  t_U8STRING_LITERAL(t) { return t; }
  t_U16STRING_LITERAL(t) { return t; }
  t_U32STRING_LITERAL(t) { return t; }
  t_BAD_STRING_LITERAL(t) { this._error("String contains invalid escape code", t); return null; }

  t_ID(t) {
    let tp = keywordMap.has(t.value) ? keywordMap.get(t.value) : "ID";
    if (!tp) return null;
    if (tp === "ID" && this.type_lookup_func(t.value)) tp = "TYPEID";
    t.type = tp;
    return t;
  }

  t_error(t) {
    this._error(`Illegal character ${pyCharRepr(t.value[0])}`, t);
    return null;
  }
}

/** int() of a decimal-constant spelling (the #line rule only matches decimals). */
function pyInt(s) {
  const m = /^\d+/.exec(s);
  if (!m || m[0].length !== s.length) throw new Error(`invalid literal for int() with base 10: '${s}'`);
  return Number(s);
}

function pyCharRepr(ch) {
  if (ch === "'") return "\"'\"";
  if (ch === "\\") return "'\\\\'";
  if (ch === "\n") return "'\\n'";
  if (ch === "\t") return "'\\t'";
  if (ch === "\r") return "'\\r'";
  const code = ch.charCodeAt(0);
  if (code < 0x20 || code === 0x7f) return `'\\x${code.toString(16).padStart(2, "0")}'`;
  return `'${ch}'`;
}
