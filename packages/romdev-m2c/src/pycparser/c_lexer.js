// pycparser: c_lexer.js - lexer for the C language (port of
// m2c_pycparser/c_lexer.py plus the parts of ply.lex it runs on, driven by
// the tables in lextab.js). Copyright (c) 2008-2022 Eli Bendersky, BSD
// licence; PLY Copyright (c) 2001-2017 David M. Beazley, BSD licence (see
// NOTICE).
import lextab from "./lextab.js";
import { repr } from "../py.js";

/** A token as produced by ply.lex. */
export class LexToken {
  __str__() {
    return `LexToken(${this.type},${repr(this.value)},${this.lineno},${this.lexpos})`;
  }
  toString() {
    return this.__str__();
  }
}

export class LexError extends Error {
  constructor(message, s) {
    super(message);
    this.name = "LexError";
    this.text = s;
  }
}

/** The ply.lex Lexer engine, bound to a CLexer's rule methods. */
class PlyLexer {
  constructor(owner) {
    this.owner = owner;
    this.lexdata = null;
    this.lexpos = 0;
    this.lexlen = 0;
    this.lineno = 1;
    this.lexstatere = {};
    for (const [state, list] of Object.entries(lextab.statere)) {
      this.lexstatere[state] = list.map(({ re, index }) => {
        const funcs = index.map((e) => (e === null ? null : [e[0] === null ? null : e[0], e[1]]));
        const tops = [];
        funcs.forEach((f, i) => { if (f) tops.push(i); });
        return { re: new RegExp(re, "y"), funcs, tops };
      });
    }
    this.begin("INITIAL");
  }
  input(s) {
    if (typeof s !== "string") throw new Error("Expected a string");
    this.lexdata = s;
    this.lexpos = 0;
    this.lexlen = s.length;
  }
  begin(state) {
    if (!(state in this.lexstatere)) throw new Error("Undefined state");
    this.lexre = this.lexstatere[state];
    this.lexignore = lextab.stateignore[state] ?? "";
    this.lexerrorf = lextab.stateerrorf[state] ?? null;
    this.lexstate = state;
  }
  skip(n) {
    this.lexpos += n;
  }
  token() {
    let lexpos = this.lexpos;
    const lexlen = this.lexlen;
    let lexignore = this.lexignore;
    const lexdata = this.lexdata;
    outer: while (lexpos < lexlen) {
      if (lexignore.includes(lexdata[lexpos])) {
        lexpos += 1;
        continue;
      }
      for (const { re, funcs, tops } of this.lexre) {
        re.lastIndex = lexpos;
        const m = re.exec(lexdata);
        if (!m) continue;
        const tok = new LexToken();
        tok.value = m[0];
        tok.lineno = this.lineno;
        tok.lexpos = lexpos;
        let i = tops.find((j) => m[j] !== undefined);
        const [func, type] = funcs[i];
        tok.type = type;
        const end = lexpos + m[0].length;
        if (!func) {
          if (tok.type) {
            this.lexpos = end;
            return tok;
          }
          lexpos = end;
          continue outer;
        }
        lexpos = end;
        tok.lexer = this;
        this.lexmatch = m;
        this.lexpos = lexpos;
        const newtok = this.owner[func](tok);
        if (!newtok) {
          lexpos = this.lexpos;
          lexignore = this.lexignore;
          continue outer;
        }
        return newtok;
      }
      // No match (no literals in this lexer). Call the state's error rule.
      if (this.lexerrorf) {
        const tok = new LexToken();
        tok.value = this.lexdata.slice(lexpos);
        tok.lineno = this.lineno;
        tok.type = "error";
        tok.lexer = this;
        tok.lexpos = lexpos;
        this.lexpos = lexpos;
        const newtok = this.owner[this.lexerrorf](tok);
        if (lexpos === this.lexpos) throw new LexError(`Scanning error. Illegal character '${lexdata[lexpos]}'`, lexdata.slice(lexpos));
        lexpos = this.lexpos;
        if (!newtok) continue;
        return newtok;
      }
      this.lexpos = lexpos;
      throw new LexError(`Illegal character '${lexdata[lexpos]}' at index ${lexpos}`, lexdata.slice(lexpos));
    }
    this.lexpos = lexpos + 1;
    if (this.lexdata === null) throw new Error("No input string given with input()");
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
const keywords_new = [
  "_BOOL", "_COMPLEX",
  "_NORETURN", "_THREAD_LOCAL", "_STATIC_ASSERT",
  "_ATOMIC", "_ALIGNOF", "_ALIGNAS",
  "_PRAGMA",
];
const keyword_map = new Map();
for (const k of keywords) keyword_map.set(k.toLowerCase(), k);
for (const k of keywords_new) keyword_map.set(k.slice(0, 2).toUpperCase() + k.slice(2).toLowerCase(), k);
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
]) keyword_map.set(k, v);

const tokens = [
  ...keywords, ...keywords_new,
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
  "PPHASH", "PPPRAGMA", "PPPRAGMASTR",
];

// Python re.match semantics at a position (anchored, not fullmatch).
const line_pattern = /([ \t]*line\W)|([ \t]*\d+)/y;
const pragma_pattern = /[ \t]*pragma\W/y;
function matchAt(re, s, pos) {
  re.lastIndex = pos;
  return re.exec(s);
}

/**
 * A lexer for the C language. After building it, set the input text with
 * input(), and call token() to get new tokens.
 */
export class CLexer {
  constructor(error_func, on_lbrace_func, on_rbrace_func, type_lookup_func) {
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
  }
  reset_lineno() {
    this.lexer.lineno = 1;
  }
  input(text) {
    this.lexer.input(text);
  }
  token() {
    this.last_token = this.lexer.token();
    return this.last_token;
  }

  _error(msg, token) {
    this.error_func(msg, token.lineno, token.lexpos);
    this.lexer.skip(1);
  }

  t_PPHASH(t) {
    if (matchAt(line_pattern, t.lexer.lexdata, t.lexer.lexpos)) {
      t.lexer.begin("ppline");
      this.pp_line = this.pp_filename = null;
    } else if (matchAt(pragma_pattern, t.lexer.lexdata, t.lexer.lexpos)) {
      t.lexer.begin("pppragma");
    } else {
      t.type = "PPHASH";
      return t;
    }
    return null;
  }
  t_ppline_FILENAME(t) {
    if (this.pp_line === null) this._error("filename before line number in #line", t);
    else this.pp_filename = t.value.replace(/^"+/, "").replace(/"+$/, "");
    return null;
  }
  t_ppline_LINE_NUMBER(t) {
    if (this.pp_line === null) this.pp_line = t.value;
    return null;
  }
  t_ppline_NEWLINE(t) {
    if (this.pp_line === null) {
      this._error("line number missing in #line", t);
    } else {
      this.lexer.lineno = pyIntDecimal(this.pp_line);
      if (this.pp_filename !== null) this.filename = this.pp_filename;
    }
    t.lexer.begin("INITIAL");
    return null;
  }
  t_ppline_PPLINE() {
    return null;
  }
  t_ppline_error(t) {
    this._error("invalid #line directive", t);
    return null;
  }
  t_pppragma_NEWLINE(t) {
    t.lexer.lineno += 1;
    t.lexer.begin("INITIAL");
    return null;
  }
  t_pppragma_PPPRAGMA(t) {
    return t;
  }
  t_pppragma_STR(t) {
    t.type = "PPPRAGMASTR";
    return t;
  }
  t_pppragma_error(t) {
    this._error("invalid #pragma directive", t);
    return null;
  }
  t_NEWLINE(t) {
    t.lexer.lineno += t.value.split("\n").length - 1;
    return null;
  }
  t_LBRACE(t) {
    this.on_lbrace_func();
    return t;
  }
  t_RBRACE(t) {
    this.on_rbrace_func();
    return t;
  }
  t_FLOAT_CONST(t) { return t; }
  t_HEX_FLOAT_CONST(t) { return t; }
  t_INT_CONST_HEX(t) { return t; }
  t_INT_CONST_BIN(t) { return t; }
  t_BAD_CONST_OCT(t) {
    this._error("Invalid octal constant", t);
    return null;
  }
  t_UNSUPPORTED_C_STYLE_COMMENT(t) {
    this._error("Comments are not supported, see https://github.com/eliben/pycparser#3using.", t);
    return null;
  }
  t_UNSUPPORTED_CXX_STYLE_COMMENT(t) {
    this._error("Comments are not supported, see https://github.com/eliben/pycparser#3using.", t);
    return null;
  }
  t_INT_CONST_OCT(t) { return t; }
  t_INT_CONST_DEC(t) { return t; }
  t_INT_CONST_CHAR(t) { return t; }
  t_CHAR_CONST(t) { return t; }
  t_WCHAR_CONST(t) { return t; }
  t_U8CHAR_CONST(t) { return t; }
  t_U16CHAR_CONST(t) { return t; }
  t_U32CHAR_CONST(t) { return t; }
  t_UNMATCHED_QUOTE(t) {
    this._error("Unmatched '", t);
    return null;
  }
  t_BAD_CHAR_CONST(t) {
    this._error(`Invalid char constant ${t.value}`, t);
    return null;
  }
  t_WSTRING_LITERAL(t) { return t; }
  t_U8STRING_LITERAL(t) { return t; }
  t_U16STRING_LITERAL(t) { return t; }
  t_U32STRING_LITERAL(t) { return t; }
  t_BAD_STRING_LITERAL(t) {
    this._error("String contains invalid escape code", t);
    return null;
  }
  t_ID(t) {
    let tp = keyword_map.has(t.value) ? keyword_map.get(t.value) : "ID";
    if (!tp) return null;
    if (tp === "ID" && this.type_lookup_func(t.value)) tp = "TYPEID";
    t.type = tp;
    return t;
  }
  t_error(t) {
    this._error(`Illegal character ${repr(t.value[0])}`, t);
    return null;
  }
}
CLexer.keywords = keywords;
CLexer.keywords_new = keywords_new;
CLexer.keyword_map = keyword_map;
CLexer.tokens = tokens;
CLexer.prototype.tokens = tokens;

// int(s) for a decimal constant with an optional integer suffix, as Python
// int() would see it (the suffix makes Python raise ValueError).
function pyIntDecimal(s) {
  if (!/^[0-9]+$/.test(s)) throw new Error(`ValueError: invalid literal for int() with base 10: '${s}'`);
  return parseInt(s, 10);
}
