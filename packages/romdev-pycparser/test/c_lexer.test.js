// Port of pycparser tests/test_c_lexer.py.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { CLexer } from "../src/index.js";

function tokenList(clex) {
  const out = [];
  for (;;) {
    const t = clex.token();
    if (t == null) return out;
    out.push(t);
  }
}
const tokenTypes = (clex) => tokenList(clex).map((t) => t.type);

describe("TestCLexerNoErrors", () => {
  const makeLexer = (on_lbrace_func = () => {}, on_rbrace_func = () => {}) => {
    const clex = new CLexer({
      error_func: (msg) => assert.fail(msg),
      on_lbrace_func,
      on_rbrace_func,
      type_lookup_func: (typ) => typ.startsWith("mytype"),
    });
    clex.build();
    return clex;
  };
  const assertTokensTypes = (str, types) => {
    const clex = makeLexer();
    clex.input(str);
    assert.deepEqual(tokenTypes(clex), types);
  };

  test("trivial tokens", () => {
    assertTokensTypes("1", ["INT_CONST_DEC"]);
    assertTokensTypes("-", ["MINUS"]);
    assertTokensTypes("volatile", ["VOLATILE"]);
    assertTokensTypes("...", ["ELLIPSIS"]);
    assertTokensTypes("++", ["PLUSPLUS"]);
    assertTokensTypes("case int", ["CASE", "INT"]);
    assertTokensTypes("caseint", ["ID"]);
    assertTokensTypes("$dollar cent$", ["ID", "ID"]);
    assertTokensTypes("i ^= 1;", ["ID", "XOREQUAL", "INT_CONST_DEC", "SEMI"]);
  });

  test("id typeid", () => {
    assertTokensTypes("myt", ["ID"]);
    assertTokensTypes("mytype", ["TYPEID"]);
    assertTokensTypes("mytype6 var", ["TYPEID", "ID"]);
  });

  test("integer constants", () => {
    assertTokensTypes("12", ["INT_CONST_DEC"]);
    assertTokensTypes("12u", ["INT_CONST_DEC"]);
    assertTokensTypes("12l", ["INT_CONST_DEC"]);
    assertTokensTypes("199872Ul", ["INT_CONST_DEC"]);
    assertTokensTypes("199872lU", ["INT_CONST_DEC"]);
    assertTokensTypes("199872LL", ["INT_CONST_DEC"]);
    assertTokensTypes("199872ull", ["INT_CONST_DEC"]);
    assertTokensTypes("199872llu", ["INT_CONST_DEC"]);
    assertTokensTypes("1009843200000uLL", ["INT_CONST_DEC"]);
    assertTokensTypes("1009843200000LLu", ["INT_CONST_DEC"]);
    assertTokensTypes("077", ["INT_CONST_OCT"]);
    assertTokensTypes("0123456L", ["INT_CONST_OCT"]);
    assertTokensTypes("0xf7", ["INT_CONST_HEX"]);
    assertTokensTypes("0b110", ["INT_CONST_BIN"]);
    assertTokensTypes("0x01202AAbbf7Ul", ["INT_CONST_HEX"]);
    assertTokensTypes("'12'", ["INT_CONST_CHAR"]);
    assertTokensTypes("'123'", ["INT_CONST_CHAR"]);
    assertTokensTypes("'1AB4'", ["INT_CONST_CHAR"]);
    assertTokensTypes(String.raw`'1A\n4'`, ["INT_CONST_CHAR"]);
    assertTokensTypes("xf7", ["ID"]);
    assertTokensTypes("-1", ["MINUS", "INT_CONST_DEC"]);
  });

  test("special names", () => {
    assertTokensTypes("sizeof offsetof", ["SIZEOF", "OFFSETOF"]);
  });

  test("new keywords", () => {
    assertTokensTypes("_Bool", ["_BOOL"]);
    assertTokensTypes("_Atomic", ["_ATOMIC"]);
    assertTokensTypes("_Alignas _Alignof", ["_ALIGNAS", "_ALIGNOF"]);
  });

  test("floating constants", () => {
    assertTokensTypes("1.5f", ["FLOAT_CONST"]);
    assertTokensTypes("01.5", ["FLOAT_CONST"]);
    assertTokensTypes(".15L", ["FLOAT_CONST"]);
    assertTokensTypes("0.", ["FLOAT_CONST"]);
    assertTokensTypes(".", ["PERIOD"]);
    assertTokensTypes("3.3e-3", ["FLOAT_CONST"]);
    assertTokensTypes(".7e25L", ["FLOAT_CONST"]);
    assertTokensTypes("6.e+125f", ["FLOAT_CONST"]);
    assertTokensTypes("666e666", ["FLOAT_CONST"]);
    assertTokensTypes("00666e+3", ["FLOAT_CONST"]);
    assertTokensTypes("0x0666e+3", ["INT_CONST_HEX", "PLUS", "INT_CONST_DEC"]);
  });

  test("hexadecimal floating constants", () => {
    assertTokensTypes("0xDE.488641p0", ["HEX_FLOAT_CONST"]);
    assertTokensTypes("0x.488641p0", ["HEX_FLOAT_CONST"]);
    assertTokensTypes("0X12.P0", ["HEX_FLOAT_CONST"]);
  });

  test("char constants", () => {
    assertTokensTypes(String.raw`'x'`, ["CHAR_CONST"]);
    assertTokensTypes(String.raw`L'x'`, ["WCHAR_CONST"]);
    assertTokensTypes(String.raw`u8'x'`, ["U8CHAR_CONST"]);
    assertTokensTypes(String.raw`u'x'`, ["U16CHAR_CONST"]);
    assertTokensTypes(String.raw`U'x'`, ["U32CHAR_CONST"]);
    assertTokensTypes(String.raw`'\t'`, ["CHAR_CONST"]);
    assertTokensTypes(String.raw`'\''`, ["CHAR_CONST"]);
    assertTokensTypes(String.raw`'\?'`, ["CHAR_CONST"]);
    assertTokensTypes(String.raw`'\0'`, ["CHAR_CONST"]);
    assertTokensTypes(String.raw`'\012'`, ["CHAR_CONST"]);
    assertTokensTypes(String.raw`'\x2f'`, ["CHAR_CONST"]);
    assertTokensTypes(String.raw`'\x2f12'`, ["CHAR_CONST"]);
    assertTokensTypes(String.raw`L'\xaf'`, ["WCHAR_CONST"]);
  });

  test("on rbrace lbrace", () => {
    const braces = [];
    const clex = makeLexer(() => braces.push("{"), () => braces.push("}"));
    clex.input("hello { there } } and again }}{");
    tokenList(clex);
    assert.deepEqual(braces, ["{", "}", "}", "}", "}", "{"]);
  });

  test("string literal", () => {
    assertTokensTypes("\"a string\"", ["STRING_LITERAL"]);
    assertTokensTypes("L\"ing\"", ["WSTRING_LITERAL"]);
    assertTokensTypes("u8\"ing\"", ["U8STRING_LITERAL"]);
    assertTokensTypes("u\"ing\"", ["U16STRING_LITERAL"]);
    assertTokensTypes("U\"ing\"", ["U32STRING_LITERAL"]);
    assertTokensTypes("\"i am a string too \t\"", ["STRING_LITERAL"]);
    assertTokensTypes(String.raw`"esc\ape \"\'\? \0234 chars \rule"`, ["STRING_LITERAL"]);
    assertTokensTypes(String.raw`"hello 'joe' wanna give it a \"go\"?"`, ["STRING_LITERAL"]);
    // Python non-raw '\123' is the octal escape for 'S'.
    assertTokensTypes("\"" + "S".repeat(16) + "\"", ["STRING_LITERAL"]);
    assertTokensTypes(String.raw`"\x"`, ["STRING_LITERAL"]);
    assertTokensTypes(String.raw`"\a\b\c\d\e\f\g\h\i\j\k\l\m\n\o\p\q\r\s\t\u\v\w\x\y\z\A\B\C\D\E\F\G\H\I\J\K\L\M\N\O\P\Q\R\S\T\U\V\W\X\Y\Z"`, ["STRING_LITERAL"]);
    assertTokensTypes(String.raw`"C:\x\fa\x1e\xited"`, ["STRING_LITERAL"]);
    assertTokensTypes(String.raw`"jx\9"`, ["STRING_LITERAL"]);
    assertTokensTypes(String.raw`"fo\9999999"`, ["STRING_LITERAL"]);
  });

  test("mess", () => {
    assertTokensTypes(String.raw`[{}]()`, ["LBRACKET", "LBRACE", "RBRACE", "RBRACKET", "LPAREN", "RPAREN"]);
    assertTokensTypes(String.raw`()||!C&~Z?J`, ["LPAREN", "RPAREN", "LOR", "LNOT", "ID", "AND", "NOT", "ID", "CONDOP", "ID"]);
    assertTokensTypes(String.raw`+-*/%|||&&&^><>=<===!=`, ["PLUS", "MINUS", "TIMES", "DIVIDE", "MOD",
      "LOR", "OR", "LAND", "AND", "XOR", "GT", "LT", "GE", "LE", "EQ", "NE"]);
    assertTokensTypes(String.raw`++--->?.,;:`, ["PLUSPLUS", "MINUSMINUS", "ARROW", "CONDOP", "PERIOD", "COMMA", "SEMI", "COLON"]);
  });

  test("exprs", () => {
    assertTokensTypes("bb-cc", ["ID", "MINUS", "ID"]);
    assertTokensTypes("foo & 0xFF", ["ID", "AND", "INT_CONST_HEX"]);
    assertTokensTypes("(2+k) * 62", ["LPAREN", "INT_CONST_DEC", "PLUS", "ID", "RPAREN", "TIMES", "INT_CONST_DEC"]);
    assertTokensTypes("x | y >> z", ["ID", "OR", "ID", "RSHIFT", "ID"]);
    assertTokensTypes("x <<= z << 5", ["ID", "LSHIFTEQUAL", "ID", "LSHIFT", "INT_CONST_DEC"]);
    assertTokensTypes("x = y > 0 ? y : -6", ["ID", "EQUALS", "ID", "GT", "INT_CONST_OCT", "CONDOP", "ID", "COLON", "MINUS", "INT_CONST_DEC"]);
    assertTokensTypes("a+++b", ["ID", "PLUSPLUS", "PLUS", "ID"]);
  });

  test("statements", () => {
    assertTokensTypes("for (int i = 0; i < n; ++i)", ["FOR", "LPAREN", "INT", "ID", "EQUALS", "INT_CONST_OCT", "SEMI",
      "ID", "LT", "ID", "SEMI", "PLUSPLUS", "ID", "RPAREN"]);
    assertTokensTypes("self: goto self;", ["ID", "COLON", "GOTO", "ID", "SEMI"]);
    assertTokensTypes(` switch (typ)
                {
                    case TYPE_ID:
                        m = 5;
                        break;
                    default:
                        m = 8;
                }`, ["SWITCH", "LPAREN", "ID", "RPAREN", "LBRACE", "CASE", "ID", "COLON", "ID", "EQUALS", "INT_CONST_DEC", "SEMI",
      "BREAK", "SEMI", "DEFAULT", "COLON", "ID", "EQUALS", "INT_CONST_DEC", "SEMI", "RBRACE"]);
  });

  test("preprocessor line", () => {
    assertTokensTypes("#abracadabra", ["PPHASH", "ID"]);
    const str = String.raw`
        546
        #line 66 "kwas\df.h"
        id 4
        dsf
        # 9
        armo
        #line 10 "..\~..\test.h"
        tok1
        #line 99999 "include/me.h"
        tok2
        `;
    const clex = makeLexer();
    clex.input(str);
    clex.reset_lineno();
    const t1 = clex.token();
    assert.equal(t1.type, "INT_CONST_DEC");
    assert.equal(t1.lineno, 2);
    const t2 = clex.token();
    assert.equal(t2.type, "ID");
    assert.equal(t2.value, "id");
    assert.equal(t2.lineno, 66);
    assert.equal(clex.filename, String.raw`kwas\df.h`);
    let t;
    for (let i = 0; i < 3; i++) t = clex.token();
    assert.equal(t.type, "ID");
    assert.equal(t.value, "armo");
    assert.equal(t.lineno, 9);
    assert.equal(clex.filename, String.raw`kwas\df.h`);
    const t4 = clex.token();
    assert.equal(t4.type, "ID");
    assert.equal(t4.value, "tok1");
    assert.equal(t4.lineno, 10);
    assert.equal(clex.filename, String.raw`..\~..\test.h`);
    const t5 = clex.token();
    assert.equal(t5.type, "ID");
    assert.equal(t5.value, "tok2");
    assert.equal(t5.lineno, 99999);
    assert.equal(clex.filename, "include/me.h");
  });

  test("preprocessor line funny", () => {
    const str = String.raw`
        #line 10 "..\6\joe.h"
        10
        `;
    const clex = makeLexer();
    clex.input(str);
    clex.reset_lineno();
    const t1 = clex.token();
    assert.equal(t1.type, "INT_CONST_DEC");
    assert.equal(t1.lineno, 10);
    assert.equal(clex.filename, String.raw`..\6\joe.h`);
  });

  test("preprocessor pragma", () => {
    const str = `
        42
        #pragma
        #pragma helo me
        #pragma once
        # pragma omp parallel private(th_id)
        #\tpragma {pack: 2, smack: 3}
        #pragma <includeme.h> "nowit.h"
        #pragma "string"
        #pragma somestring="some_other_string"
        #pragma id 124124 and numbers 0235495
        _Pragma("something else")
        59
        `;
    const clex = makeLexer();
    clex.input(str);
    clex.reset_lineno();
    assert.equal(clex.token().type, "INT_CONST_DEC");
    assert.equal(clex.token().type, "PPPRAGMA");
    assert.equal(clex.token().type, "PPPRAGMA");
    const t4 = clex.token();
    assert.equal(t4.type, "PPPRAGMASTR");
    assert.equal(t4.value, "helo me");
    for (let i = 0; i < 3; i++) clex.token();
    const t5 = clex.token();
    assert.equal(t5.type, "PPPRAGMASTR");
    assert.equal(t5.value, "omp parallel private(th_id)");
    for (let i = 0; i < 5; i++) {
      assert.equal(clex.token().type, "PPPRAGMA");
      assert.equal(clex.token().type, "PPPRAGMASTR");
    }
    const t6a = clex.token(), t6l = clex.token(), t6b = clex.token(), t6r = clex.token();
    assert.equal(t6a.type, "_PRAGMA");
    assert.equal(t6l.type, "LPAREN");
    assert.equal(t6b.type, "STRING_LITERAL");
    assert.equal(t6b.value, "\"something else\"");
    assert.equal(t6r.type, "RPAREN");
    const t7 = clex.token();
    assert.equal(t7.type, "INT_CONST_DEC");
    assert.equal(t7.lineno, 13);
  });
});

const ERR_ILLEGAL_CHAR = "Illegal character";
const ERR_OCTAL = "Invalid octal constant";
const ERR_UNMATCHED_QUOTE = "Unmatched '";
const ERR_INVALID_CCONST = "Invalid char constant";
const ERR_STRING_ESCAPE = "String contains invalid escape";
const ERR_FILENAME_BEFORE_LINE = "filename before line";
const ERR_LINENUM_MISSING = "line number missing";
const ERR_INVALID_LINE_DIRECTIVE = "invalid #line directive";
const ERR_COMMENT = "Comments are not supported";

describe("TestCLexerErrors", () => {
  const assertLexerError = (str, errorLike) => {
    let error = "";
    const clex = new CLexer({
      error_func: (msg) => { error = msg; },
      on_lbrace_func: () => {},
      on_rbrace_func: () => {},
      type_lookup_func: () => false,
    });
    clex.build();
    clex.input(str);
    tokenTypes(clex);
    assert.ok(new RegExp(errorLike).test(error), `\nExpected error matching: ${errorLike}\nGot: ${error}`);
  };

  test("trivial tokens", () => {
    assertLexerError("@", ERR_ILLEGAL_CHAR);
    assertLexerError("`", ERR_ILLEGAL_CHAR);
    assertLexerError("\\", ERR_ILLEGAL_CHAR);
  });

  test("integer constants", () => {
    assertLexerError("029", ERR_OCTAL);
    assertLexerError("012345678", ERR_OCTAL);
  });

  test("char constants", () => {
    assertLexerError("'", ERR_UNMATCHED_QUOTE);
    assertLexerError("'b\n", ERR_UNMATCHED_QUOTE);
    assertLexerError("'\\xaa\n'", ERR_UNMATCHED_QUOTE);
    assertLexerError(String.raw`'123\12a'`, ERR_INVALID_CCONST);
    assertLexerError(String.raw`'123\xabg'`, ERR_INVALID_CCONST);
    assertLexerError("''", ERR_INVALID_CCONST);
    assertLexerError("'abcjx'", ERR_INVALID_CCONST);
    assertLexerError(String.raw`'\*'`, ERR_INVALID_CCONST);
  });

  test("string literals", () => {
    assertLexerError("\"jx\\`\"", ERR_STRING_ESCAPE);
    assertLexerError(String.raw`"hekllo\* on ix"`, ERR_STRING_ESCAPE);
    assertLexerError(String.raw`L"hekllo\* on ix"`, ERR_STRING_ESCAPE);
    const o = String.raw`\123`, x = String.raw`\xf1\x23`, bt = "\\`";
    assertLexerError("\"" + o.repeat(19) + bt + o.repeat(20) + "\"", ERR_STRING_ESCAPE);
    assertLexerError("\"" + x.repeat(9) + String.raw`\x23` + bt + x.repeat(10) + "\"", ERR_STRING_ESCAPE);
    assertLexerError("\"" + o.repeat(15) + bt + o.repeat(18) + String.raw`\12\123456`, ERR_ILLEGAL_CHAR);
    const h = String.raw`\x23`;
    assertLexerError("\"" + h.repeat(15) + bt + h.repeat(18) + String.raw`\x2\x23456`, ERR_ILLEGAL_CHAR);
  });

  test("preprocessor", () => {
    assertLexerError("#line \"ka\"", ERR_FILENAME_BEFORE_LINE);
    assertLexerError("#line df", ERR_INVALID_LINE_DIRECTIVE);
    assertLexerError("#line \n", ERR_LINENUM_MISSING);
    assertLexerError("//", ERR_COMMENT);
    assertLexerError("/*", ERR_COMMENT);
  });
});
