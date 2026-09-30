// Port of pycparser tests/test_c_parser.py (m2c / decomp-permuter fork).
// Converted mechanically from the upstream file and fixed by hand; every
// test case and expected value is upstream's. Python tuples in expected
// values are arrays here (expand_init returns an array for a
// NamedInitializer where upstream returns a 2-tuple).
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { CParser, ParseError, NodeVisitor, c_ast } from "../src/index.js";

const {
  ArrayDecl, ArrayRef, Assignment, Alignas, BinaryOp, Case, Compound, Constant, Decl, Default, DoWhile,
  EmptyStatement, Enum, Enumerator, EnumeratorList, FileAST, For, FuncCall, FuncDecl, FuncDef, ID,
  IdentifierType, If, Label, NamedInitializer, PtrDecl, Return, StaticAssert, Struct, StructRef, Switch,
  TypeDecl, Typedef, Typename, UnaryOp, Union, While, Pragma,
} = c_ast;
// Python type(x): the node class.
const type = (x) => x.constructor;

const _c_parser = new CParser();

/** Converts the declaration into a nested list. */
function expand_decl(decl) {
  const typ = decl.constructor;
  if (typ === TypeDecl) return ["TypeDecl", expand_decl(decl.type)];
  if (typ === IdentifierType) return ["IdentifierType", decl.names];
  if (typ === ID) return ["ID", decl.name];
  if (typ === Struct || typ === Union) {
    const decls = (decl.decls || []).map((d) => expand_decl(d));
    return [typ.name, decl.name, decls];
  }
  if (typ === Enum) {
    let values;
    if (decl.values == null) values = null;
    else {
      assert.ok(decl.values instanceof EnumeratorList);
      values = decl.values.enumerators.map((e) => e.name);
    }
    return ["Enum", decl.name, values];
  }
  if (typ === Alignas) return ["Alignas", expand_init(decl.alignment)];
  if (typ === StaticAssert) {
    if (decl.message) return ["StaticAssert", decl.cond.value, decl.message.value];
    return ["StaticAssert", decl.cond.value];
  }
  const nested = expand_decl(decl.type);
  if (typ === Decl) {
    const r = ["Decl"];
    if (decl.quals && decl.quals.length) r.push(decl.quals);
    if (decl.align && decl.align.length) r.push(expand_decl(decl.align[0]));
    r.push(decl.name, nested);
    return r;
  }
  if (typ === Typename) {
    if (decl.quals && decl.quals.length) return ["Typename", decl.quals, nested];
    return ["Typename", nested];
  }
  if (typ === ArrayDecl) {
    const dimval = decl.dim ? decl.dim.value : "";
    return ["ArrayDecl", dimval, decl.dim_quals, nested];
  }
  if (typ === PtrDecl) {
    if (decl.quals && decl.quals.length) return ["PtrDecl", decl.quals, nested];
    return ["PtrDecl", nested];
  }
  if (typ === Typedef) return ["Typedef", decl.name, nested];
  if (typ === FuncDecl) {
    const params = decl.args ? decl.args.params.map((p) => expand_decl(p)) : [];
    return ["FuncDecl", params, nested];
  }
  return undefined;
}

/** Converts an initialization into a nested list. */
function expand_init(init) {
  const typ = init == null ? null : init.constructor;
  if (typ === NamedInitializer) {
    const des = init.name.map((dp) => expand_init(dp));
    return [des, expand_init(init.expr)];
  }
  if (typ === c_ast.InitList || typ === c_ast.ExprList) return init.exprs.map((e) => expand_init(e));
  if (typ === Constant) return ["Constant", init.type, init.value];
  if (typ === ID) return ["ID", init.name];
  if (typ === Decl) return ["Decl", init.name];
  if (typ === UnaryOp) return ["UnaryOp", init.op, expand_decl(init.expr)];
  if (typ === BinaryOp) return ["BinaryOp", expand_init(init.left), init.op, expand_init(init.right)];
  if (typ === Compound) {
    let blocks = [];
    if (init.block_items) blocks = init.block_items.map((i) => expand_init(i));
    return ["Compound", blocks];
  }
  if (typ === Typename) return expand_decl(init);
  return [typ == null ? "NoneType" : typ.name];
}

class TestCParser_base {
  constructor() { this.cparser = _c_parser; }

  parse(txt, filename = "") { return this.cparser.parse(txt, filename); }

  assert_coord(node, line, column = null, file = null) {
    assert.equal(node.coord.line, line);
    if (column != null) assert.equal(node.coord.column, column);
    if (file) assert.equal(node.coord.file, file);
  }

  assertEqual(a, b) { assert.deepStrictEqual(a, b); }

  assertIsInstance(a, cls) { assert.ok(a instanceof cls, `${a?.constructor?.name} is not ${cls.name}`); }

  assertTrue(x) { assert.ok(x); }

  assertRaises(err, fn, ...args) { assert.throws(() => fn.apply(this, args), err); }
}



describe("TestCParser_fundamentals", () => { const self = new TestCParser_base();
    self.get_decl = (txt, index = 0) => { let t;
        ` Given a source and an index returns the expanded
            declaration at that index.

            FileAST holds a list of 'external declarations'.
            index is the offset of the desired declaration in that
            list.
        `
        t = self.parse(txt).ext[index];
        return expand_decl(t);

    };
    self.get_decl_init = (txt, index = 0) => { let t;
        ` Returns the expanded initializer of the declaration
            at index.
        `
        t = self.parse(txt).ext[index];
        return expand_init(t.init);

    };
    test("FileAST", () => { let t, t2;
        t = self.parse("int a; char c;");
        self.assertIsInstance(t, FileAST);
        self.assertEqual(t.ext.length, 2);

        // empty file
        t2 = self.parse("");
        self.assertIsInstance(t2, FileAST);
        self.assertEqual(t2.ext.length, 0);

    });
    test("empty_toplevel_decl", () => { let code, t;
        code = "int foo;;";
        t = self.parse(code);
        self.assertIsInstance(t, FileAST);
        self.assertEqual(t.ext.length, 1);
        self.assertEqual(self.get_decl(code),
            ["Decl", "foo",
                ["TypeDecl", ["IdentifierType", ["int"]]]]);

    });
    test("initial_semi", () => { let t;
        t = self.parse(";");
        self.assertEqual(t.ext.length, 0);
        t = self.parse(";int foo;");
        self.assertEqual(t.ext.length, 1);
        self.assertEqual(expand_decl(t.ext[0]),
            ["Decl", "foo",
                ["TypeDecl", ["IdentifierType", ["int"]]]]);

    });
    test("coords", () => { let t1, f1, t1_1, f1_1, t1_2, f1_2, t2, t3, f3, t4, f4, t5, t6;
        ` Tests the "coordinates" of parsed elements - file
            name, line and column numbers, with modification
            inserted by #line directives.
        `
        self.assert_coord(self.parse("int a;").ext[0], 1, 5);

        t1 = `
        int a;
        int b;\n\n
        int c;
        `;
        f1 = self.parse(t1, "test.c");
        self.assert_coord(f1.ext[0], 2, 13, "test.c");
        self.assert_coord(f1.ext[1], 3, 13, "test.c");
        self.assert_coord(f1.ext[2], 6, 13, "test.c");

        t1_1 = `
        int main() {
            k = p;
            printf("%d", b);
            return 0;
        }`;
        f1_1 = self.parse(t1_1, "test.c");
        self.assert_coord(f1_1.ext[0].body.block_items[0], 3, 13, "test.c");
        self.assert_coord(f1_1.ext[0].body.block_items[1], 4, 13, "test.c");

        t1_2 = `
        int main () {
            int p = (int) k;
        }`;
        f1_2 = self.parse(t1_2, "test.c");
        // make sure that the Cast has a coord (issue 23)
        self.assert_coord(f1_2.ext[0].body.block_items[0].init, 3, 21, "test.c");

        t2 = `
        #line 99
        int c;
        `;
        self.assert_coord(self.parse(t2).ext[0], 99, 13);

        t3 = `
        int dsf;
        char p;
        #line 3000 "in.h"
        char d;
        `;
        f3 = self.parse(t3, "test.c");
        self.assert_coord(f3.ext[0], 2, 13, "test.c");
        self.assert_coord(f3.ext[1], 3, 14, "test.c");
        self.assert_coord(f3.ext[2], 3000, 14, "in.h");

        t4 = `
        #line 20 "restore.h"
        int maydler(char);

        #line 30 "includes/daween.ph"
        long j, k;

        #line 50000
        char* ro;
        `;
        f4 = self.parse(t4, "myb.c");
        self.assert_coord(f4.ext[0], 20, 13, "restore.h");
        self.assert_coord(f4.ext[1], 30, 14, "includes/daween.ph");
        self.assert_coord(f4.ext[2], 30, 17, "includes/daween.ph");
        self.assert_coord(f4.ext[3], 50000, 13, "includes/daween.ph");

        t5 = `
        int
        #line 99
        c;
        `;
        self.assert_coord(self.parse(t5).ext[0], 99, 9);

        // coord for ellipsis
        t6 = `
        int foo(int j,
                ...) {
        }`;
        self.parse(t6, "z.c");
        self.assert_coord(self.parse(t6).ext[0].decl.type.args.params[1], 3, 17);

    });
    test("forloop_coord", () => { let t, s, forloop;
        t = `\
        void foo() {
            for(int z=0; z<4;
                z++){}
        }
        `;
        s = self.parse(t, "f.c");
        forloop = s.ext[0].body.block_items[0];
        self.assert_coord(forloop.init, 2, 13, "f.c");
        self.assert_coord(forloop.cond, 2, 26, "f.c");
        self.assert_coord(forloop.next, 3, 17, "f.c");

    });
    test("simple_decls", () => {
        self.assertEqual(self.get_decl("int a;"),
            ["Decl", "a", ["TypeDecl", ["IdentifierType", ["int"]]]]);

        self.assertEqual(self.get_decl("unsigned int a;"),
            ["Decl", "a", ["TypeDecl", ["IdentifierType", ["unsigned", "int"]]]]);

        self.assertEqual(self.get_decl("_Bool a;"),
            ["Decl", "a", ["TypeDecl", ["IdentifierType", ["_Bool"]]]]);

        self.assertEqual(self.get_decl("float _Complex fcc;"),
            ["Decl", "fcc", ["TypeDecl", ["IdentifierType", ["float", "_Complex"]]]]);

        self.assertEqual(self.get_decl("char* string;"),
            ["Decl", "string",
                ["PtrDecl", ["TypeDecl", ["IdentifierType", ["char"]]]]]);

        self.assertEqual(self.get_decl("long ar[15];"),
            ["Decl", "ar",
                ["ArrayDecl", "15", [],
                    ["TypeDecl", ["IdentifierType", ["long"]]]]]);

        self.assertEqual(self.get_decl("long long ar[15];"),
            ["Decl", "ar",
                ["ArrayDecl", "15", [],
                    ["TypeDecl", ["IdentifierType", ["long", "long"]]]]]);

        self.assertEqual(self.get_decl("unsigned ar[];"),
            ["Decl", "ar",
                ["ArrayDecl", "", [],
                    ["TypeDecl", ["IdentifierType", ["unsigned"]]]]]);

        self.assertEqual(self.get_decl("int strlen(char* s);"),
            ["Decl", "strlen",
                ["FuncDecl",
                    [["Decl", "s",
                        ["PtrDecl",
                            ["TypeDecl", ["IdentifierType", ["char"]]]]]],
                    ["TypeDecl", ["IdentifierType", ["int"]]]]]);

        self.assertEqual(self.get_decl("int strcmp(char* s1, char* s2);"),
            ["Decl", "strcmp",
                ["FuncDecl",
                    [   ["Decl", "s1",
                            ["PtrDecl", ["TypeDecl", ["IdentifierType", ["char"]]]]],
                        ["Decl", "s2",
                            ["PtrDecl", ["TypeDecl", ["IdentifierType", ["char"]]]]]
                    ],
                ["TypeDecl", ["IdentifierType", ["int"]]]]]);

        // function return values and parameters may not have type information
        self.assertEqual(self.get_decl("extern foobar(foo, bar);"),
            ["Decl", "foobar",
                ["FuncDecl",
                    [   ["ID", "foo"],
                        ["ID", "bar"]
                    ],
                ["TypeDecl", ["IdentifierType", ["int"]]]]]);

    });
    test("int128", () => {
        self.assertEqual(self.get_decl("__int128 a;"),
            ["Decl", "a", ["TypeDecl", ["IdentifierType", ["__int128"]]]]);


    });
    test("nested_decls", () => {
        self.assertEqual(self.get_decl("char** ar2D;"),
            ["Decl", "ar2D",
                ["PtrDecl", ["PtrDecl",
                    ["TypeDecl", ["IdentifierType", ["char"]]]]]]);

        self.assertEqual(self.get_decl("int (*a)[1][2];"),
            ["Decl", "a",
                ["PtrDecl",
                    ["ArrayDecl", "1", [],
                        ["ArrayDecl", "2", [],
                        ["TypeDecl", ["IdentifierType", ["int"]]]]]]]);

        self.assertEqual(self.get_decl("int *a[1][2];"),
            ["Decl", "a",
                ["ArrayDecl", "1", [],
                    ["ArrayDecl", "2", [],
                        ["PtrDecl", ["TypeDecl", ["IdentifierType", ["int"]]]]]]]);

        self.assertEqual(self.get_decl("char* const* p;"),
            ["Decl", "p",
                ["PtrDecl", ["PtrDecl", ["const"],
                    ["TypeDecl", ["IdentifierType", ["char"]]]]]]);

        self.assertEqual(self.get_decl("const char* const* p;"),
            ["Decl", ["const"], "p",
                ["PtrDecl", ["PtrDecl", ["const"],
                    ["TypeDecl", ["IdentifierType", ["char"]]]]]]);

        self.assertEqual(self.get_decl("char* * const p;"),
            ["Decl", "p",
                ["PtrDecl", ["const"], ["PtrDecl",
                    ["TypeDecl", ["IdentifierType", ["char"]]]]]]);

        self.assertEqual(self.get_decl("char ***ar3D[40];"),
            ["Decl", "ar3D",
                ["ArrayDecl", "40", [],
                    ["PtrDecl", ["PtrDecl", ["PtrDecl",
                        ["TypeDecl", ["IdentifierType", ["char"]]]]]]]]);

        self.assertEqual(self.get_decl("char (***ar3D)[40];"),
            ["Decl", "ar3D",
                ["PtrDecl", ["PtrDecl", ["PtrDecl",
                    ["ArrayDecl", "40", [], ["TypeDecl", ["IdentifierType", ["char"]]]]]]]]);

        self.assertEqual(self.get_decl("int (*const*const x)(char, int);"),
         ["Decl",
          "x",
          ["PtrDecl",
           ["const"],
           ["PtrDecl",
            ["const"],
            ["FuncDecl",
             [["Typename", ["TypeDecl", ["IdentifierType", ["char"]]]],
              ["Typename", ["TypeDecl", ["IdentifierType", ["int"]]]]],
             ["TypeDecl", ["IdentifierType", ["int"]]]]]]]);

        self.assertEqual(self.get_decl("int (*x[4])(char, int);"),
            ["Decl", "x",
                ["ArrayDecl", "4", [],
                    ["PtrDecl",
                        ["FuncDecl",
                            [   ["Typename",  ["TypeDecl", ["IdentifierType", ["char"]]]],
                                ["Typename", ["TypeDecl", ["IdentifierType", ["int"]]]]],
                            ["TypeDecl", ["IdentifierType", ["int"]]]]]]]);

        self.assertEqual(self.get_decl("char *(*(**foo [][8])())[];"),
            ["Decl", "foo",
                ["ArrayDecl", "", [],
                    ["ArrayDecl", "8", [],
                        ["PtrDecl", ["PtrDecl",
                            ["FuncDecl",
                                [],
                                ["PtrDecl",
                                    ["ArrayDecl", "", [],
                                        ["PtrDecl",
                                            ["TypeDecl",
                                                ["IdentifierType", ["char"]]]]]]]]]]]]);

        // explore named and unnamed function pointer parameters,
        // with and without qualifiers

        // unnamed w/o quals
        self.assertEqual(self.get_decl("int (*k)(int);"),
            ["Decl", "k",
                ["PtrDecl",
                    ["FuncDecl",
                        [["Typename", ["TypeDecl", ["IdentifierType", ["int"]]]]],
                        ["TypeDecl", ["IdentifierType", ["int"]]]]]]);

        // unnamed w/ quals
        self.assertEqual(self.get_decl("int (*k)(const int);"),
            ["Decl", "k",
                ["PtrDecl",
                    ["FuncDecl",
                        [["Typename", ["const"], ["TypeDecl", ["IdentifierType", ["int"]]]]],
                        ["TypeDecl", ["IdentifierType", ["int"]]]]]]);

        // named w/o quals
        self.assertEqual(self.get_decl("int (*k)(int q);"),
            ["Decl", "k",
                ["PtrDecl",
                    ["FuncDecl",
                        [["Decl", "q", ["TypeDecl", ["IdentifierType", ["int"]]]]],
                        ["TypeDecl", ["IdentifierType", ["int"]]]]]]);

        // named w/ quals
        self.assertEqual(self.get_decl("int (*k)(const volatile int q);"),
            ["Decl", "k",
                ["PtrDecl",
                    ["FuncDecl",
                        [["Decl", ["const", "volatile"], "q",
                            ["TypeDecl", ["IdentifierType", ["int"]]]]],
                        ["TypeDecl", ["IdentifierType", ["int"]]]]]]);

        self.assertEqual(self.get_decl("int (*k)(_Atomic volatile int q);"),
            ["Decl", "k",
                ["PtrDecl",
                    ["FuncDecl",
                        [["Decl", ["_Atomic", "volatile"], "q",
                            ["TypeDecl", ["IdentifierType", ["int"]]]]],
                        ["TypeDecl", ["IdentifierType", ["int"]]]]]]);

        self.assertEqual(self.get_decl("int (*k)(const volatile int* q);"),
            ["Decl", "k",
                ["PtrDecl",
                    ["FuncDecl",
                        [["Decl", ["const", "volatile"], "q",
                            ["PtrDecl", ["TypeDecl", ["IdentifierType", ["int"]]]]]],
                        ["TypeDecl", ["IdentifierType", ["int"]]]]]]);

        // restrict qualifier
        self.assertEqual(self.get_decl("int (*k)(restrict int* q);"),
            ["Decl", "k",
                ["PtrDecl",
                    ["FuncDecl",
                        [["Decl", ["restrict"], "q",
                            ["PtrDecl",
                                ["TypeDecl", ["IdentifierType", ["int"]]]]]],
                        ["TypeDecl", ["IdentifierType", ["int"]]]]]]);

    });
    test("func_decls_with_array_dim_qualifiers", () => {
        // named function parameter
        self.assertEqual(self.get_decl("int zz(int p[static 10]);"),
            ["Decl", "zz",
                ["FuncDecl",
                    [["Decl", "p", ["ArrayDecl", "10", ["static"],
                                       ["TypeDecl", ["IdentifierType", ["int"]]]]]],
                    ["TypeDecl", ["IdentifierType", ["int"]]]]]);
        // anonymous function parameter
        self.assertEqual(self.get_decl("int zz(int [static 10]);"),
            ["Decl", "zz",
                ["FuncDecl",
                    [["Typename",
                      ["ArrayDecl", "10", ["static"],
                       ["TypeDecl", ["IdentifierType", ["int"]]]]]],
                    ["TypeDecl", ["IdentifierType", ["int"]]]]]);
        self.assertEqual(self.get_decl("int zz(int [static const restrict 10]);"),
            ["Decl", "zz",
                ["FuncDecl",
                    [["Typename",
                      ["ArrayDecl", "10", ["static", "const", "restrict"],
                       ["TypeDecl", ["IdentifierType", ["int"]]]]]],
                    ["TypeDecl", ["IdentifierType", ["int"]]]]]);

        self.assertEqual(self.get_decl("int zz(int p[const 10]);"),
            ["Decl", "zz",
                ["FuncDecl",
                    [["Decl", "p", ["ArrayDecl", "10", ["const"],
                                       ["TypeDecl", ["IdentifierType", ["int"]]]]]],
                    ["TypeDecl", ["IdentifierType", ["int"]]]]]);

        self.assertEqual(self.get_decl("int zz(int p[restrict][5]);"),
            ["Decl", "zz",
                ["FuncDecl",
                    [["Decl", "p", ["ArrayDecl", "", ["restrict"],
                        ["ArrayDecl", "5", [],
                            ["TypeDecl", ["IdentifierType", ["int"]]]]]]],
                    ["TypeDecl", ["IdentifierType", ["int"]]]]]);

        self.assertEqual(self.get_decl("int zz(int p[const restrict static 10][5]);"),
            ["Decl", "zz",
                ["FuncDecl",
                    [["Decl", "p", ["ArrayDecl", "10", ["const", "restrict", "static"],
                        ["ArrayDecl", "5", [],
                            ["TypeDecl", ["IdentifierType", ["int"]]]]]]],
                    ["TypeDecl", ["IdentifierType", ["int"]]]]]);

        // unnamed function parameter
        self.assertEqual(self.get_decl("int zz(int [const 10]);"),
            ["Decl", "zz",
                ["FuncDecl",
                    [["Typename", ["ArrayDecl", "10", ["const"],
                                       ["TypeDecl", ["IdentifierType", ["int"]]]]]],
                    ["TypeDecl", ["IdentifierType", ["int"]]]]]);

        self.assertEqual(self.get_decl("int zz(int [restrict][5]);"),
            ["Decl", "zz",
                ["FuncDecl",
                    [["Typename", ["ArrayDecl", "", ["restrict"],
                        ["ArrayDecl", "5", [],
                            ["TypeDecl", ["IdentifierType", ["int"]]]]]]],
                    ["TypeDecl", ["IdentifierType", ["int"]]]]]);

        self.assertEqual(self.get_decl("int zz(int [const restrict volatile 10][5]);"),
            ["Decl", "zz",
                ["FuncDecl",
                    [["Typename", ["ArrayDecl", "10", ["const", "restrict", "volatile"],
                        ["ArrayDecl", "5", [],
                            ["TypeDecl", ["IdentifierType", ["int"]]]]]]],
                    ["TypeDecl", ["IdentifierType", ["int"]]]]]);

    });
    test("qualifiers_storage_specifiers", () => { let d1, d2, pdecl;
        const assert_qs = (txt, index, quals, storage) => { let d;
            d = self.parse(txt).ext[index];
            self.assertEqual(d.quals, quals);
            self.assertEqual(d.storage, storage);

        };
        assert_qs("extern int p;", 0, [], ["extern"]);
        assert_qs("_Thread_local int p;", 0, [], ["_Thread_local"]);
        assert_qs("const long p = 6;", 0, ["const"], []);
        assert_qs("_Atomic int p;", 0, ["_Atomic"], []);
        assert_qs("_Atomic restrict int* p;", 0, ["_Atomic", "restrict"], []);

        d1 = "static const int p, q, r;";
        for (let i = 0; i < 3; i++) {
            assert_qs(d1, i, ["const"], ["static"]);

        }
        d2 = "static char * const p;";
        assert_qs(d2, 0, [], ["static"]);
        pdecl = self.parse(d2).ext[0].type;
        self.assertIsInstance(pdecl, PtrDecl);
        self.assertEqual(pdecl.quals, ["const"]);

    });
    test("atomic_specifier", () => { let s;
        self.assertEqual(self.get_decl("_Atomic(int) ai;"),
             ["Decl", ["_Atomic"],
              "ai",
              ["TypeDecl", ["IdentifierType", ["int"]]]]);

        self.assertEqual(self.get_decl("_Atomic(int*) ai;"),
             ["Decl",
              "ai",
              ["PtrDecl", ["_Atomic"], ["TypeDecl", ["IdentifierType", ["int"]]]]]);

        self.assertEqual(self.get_decl("_Atomic(_Atomic(int)*) aai;"),
             ["Decl", ["_Atomic"],
              "aai",
              ["PtrDecl", ["_Atomic"], ["TypeDecl", ["IdentifierType", ["int"]]]]]);

        // Multiple declarations with _Atomic(...)
        s = "_Atomic(int) foo, bar;";
        self.assertEqual(self.get_decl(s, 0),
             ["Decl", ["_Atomic"],
              "foo",
              ["TypeDecl", ["IdentifierType", ["int"]]]]);
        self.assertEqual(self.get_decl(s, 1),
             ["Decl", ["_Atomic"],
              "bar",
              ["TypeDecl", ["IdentifierType", ["int"]]]]);

        // typedefs with _Atomic specifiers.
        s = "typedef _Atomic(int) atomic_int;";
        self.assertEqual(self.get_decl(s, 0),
            ["Typedef", "atomic_int", ["TypeDecl", ["IdentifierType", ["int"]]]]);

        s = "typedef _Atomic(_Atomic(_Atomic(int (*)(void)) *) *) t;";
        self.assertEqual(self.get_decl(s, 0),
            ["Typedef", "t",
             ["PtrDecl", ["_Atomic"],
              ["PtrDecl", ["_Atomic"],
               ["PtrDecl", ["_Atomic"],
                ["FuncDecl", [["Typename", ["TypeDecl", ["IdentifierType", ["void"]]]]],
                 ["TypeDecl", ["IdentifierType", ["int"]]]]]]]]);

    });
    test("sizeof", () => { let e, compound, s1, s2, s3;
        e = `
            void foo()
            {
                int a = sizeof k;
                int b = sizeof(int);
                int c = sizeof(int**);;

                char* p = "just to make sure this parses w/o error...";
                int d = sizeof(int());
            }
        `;
        compound = self.parse(e).ext[0].body;

        s1 = compound.block_items[0].init;
        self.assertIsInstance(s1, UnaryOp);
        self.assertEqual(s1.op, "sizeof");
        self.assertIsInstance(s1.expr, ID);
        self.assertEqual(s1.expr.name, "k");

        s2 = compound.block_items[1].init;
        self.assertEqual(expand_decl(s2.expr),
            ["Typename", ["TypeDecl", ["IdentifierType", ["int"]]]]);

        s3 = compound.block_items[2].init;
        self.assertEqual(expand_decl(s3.expr),
            ["Typename",
                ["PtrDecl",
                    ["PtrDecl",
                        ["TypeDecl",
                            ["IdentifierType", ["int"]]]]]]);

    });
    test("alignof", () => { let r;
        r = self.parse("int a = _Alignof(int);");
        self.assertEqual(expand_decl(r.ext[0]), ["Decl", "a", ["TypeDecl", ["IdentifierType", ["int"]]]]);
        self.assertEqual(expand_init(r.ext[0].init), ["UnaryOp", "_Alignof",
            ["Typename", ["TypeDecl", ["IdentifierType", ["int"]]]]]);

        self.assertEqual(expand_decl(self.parse("_Alignas(_Alignof(int)) char a;").ext[0]),
            ["Decl", ["Alignas",
                ["UnaryOp", "_Alignof", ["Typename", ["TypeDecl", ["IdentifierType", ["int"]]]]]],
                "a", ["TypeDecl", ["IdentifierType", ["char"]]]]);

        self.assertEqual(expand_decl(self.parse("_Alignas(4) char a;").ext[0]),
            ["Decl", ["Alignas",
                ["Constant", "int", "4"]],
                "a", ["TypeDecl", ["IdentifierType", ["char"]]]]);

        self.assertEqual(expand_decl(self.parse("_Alignas(int) char a;").ext[0]),
            ["Decl", ["Alignas",
                ["Typename", ["TypeDecl", ["IdentifierType", ["int"]]]]],
                "a", ["TypeDecl", ["IdentifierType", ["char"]]]]);

    });
    test("offsetof", () => { let e, compound, s1, s3, s4;
        const expand_ref = (n) => {
            if ((n instanceof StructRef)) {
                return ["StructRef", expand_ref(n.name), expand_ref(n.field)];
            }
            else if ((n instanceof ArrayRef)) {
                return ["ArrayRef", expand_ref(n.name), expand_ref(n.subscript)];
            }
            else if ((n instanceof ID)) {
                return ["ID", n.name];
            }
            else if ((n instanceof Constant)) {
                return ["Constant", n.type, n.value];
            }
            else {
                throw new Error("Unexpected type " + n.constructor.name);

            }
        };
        e = `
            void foo() {
                int a = offsetof(struct S, p);
                a.b = offsetof(struct sockaddr, sp) + strlen(bar);
                int a = offsetof(struct S, p.q.r);
                int a = offsetof(struct S, p[5].q[4][5]);
            }
            `;
        compound = self.parse(e).ext[0].body;
        s1 = compound.block_items[0].init;
        self.assertIsInstance(s1, FuncCall);
        self.assertIsInstance(s1.name, ID);
        self.assertEqual(s1.name.name, "offsetof");
        self.assertIsInstance(s1.args.exprs[0], Typename);
        self.assertIsInstance(s1.args.exprs[1], ID);
        s3 = compound.block_items[2].init;
        self.assertIsInstance(s3.args.exprs[1], StructRef);
        self.assertEqual(expand_ref(s3.args.exprs[1]),
            ["StructRef",
                ["StructRef", ["ID", "p"], ["ID", "q"]],
                ["ID", "r"]]);
        s4 = compound.block_items[3].init;
        self.assertIsInstance(s4.args.exprs[1], ArrayRef);
        self.assertEqual(expand_ref(s4.args.exprs[1]),
            ["ArrayRef",
                ["ArrayRef",
                    ["StructRef",
                        ["ArrayRef", ["ID", "p"], ["Constant", "int", "5"]],
                        ["ID", "q"]],
                    ["Constant", "int", "4"]],
                ["Constant", "int", "5"]]);

    });
    test("compound_statement", () => { let e, compound;
        e = `
            void foo() {
            }
            `;
        compound = self.parse(e).ext[0].body;
        self.assertIsInstance(compound, Compound);
        self.assert_coord(compound, 2);

    // The C99 compound literal feature
    //
    });
    test("compound_literals", () => { let ps1, compound;
        ps1 = self.parse(String.raw`
            void foo() {
                p = (long long){k};
                tc = (struct jk){.a = {1, 2}, .b[0] = t};
            }`);

        compound = ps1.ext[0].body.block_items[0].rvalue;
        self.assertEqual(expand_decl(compound.type),
            ["Typename", ["TypeDecl", ["IdentifierType", ["long", "long"]]]]);
        self.assertEqual(expand_init(compound.init),
            [["ID", "k"]]);

        compound = ps1.ext[0].body.block_items[1].rvalue;
        self.assertEqual(expand_decl(compound.type),
            ["Typename", ["TypeDecl", ["Struct", "jk", []]]]);
        self.assertEqual(expand_init(compound.init),
            [
                [[["ID", "a"]], [["Constant", "int", "1"], ["Constant", "int", "2"]]],
                [[["ID", "b"], ["Constant", "int", "0"]], ["ID", "t"]]]);

    });
    test("parenthesized_compounds", () => { let e, body;
        e = self.parse(String.raw`
        void foo() {
            int a;
            ({});
            ({ 1; });
            ({ 1; 2; });
            int b = ({ 1; });
            int c, d = ({ int x = 1; x + 2; });
            a = ({ int x = 1; 2 * x; });
        }`);
        body = e.ext[0].body.block_items;

        self.assertIsInstance(body[1], Compound);
        self.assertEqual(body[1].block_items, null);

        self.assertIsInstance(body[2], Compound);
        self.assertEqual(body[2].block_items.length, 1);
        self.assertIsInstance(body[2].block_items[0], Constant);

        self.assertIsInstance(body[3], Compound);
        self.assertEqual(body[3].block_items.length, 2);
        self.assertIsInstance(body[3].block_items[0], Constant);
        self.assertIsInstance(body[3].block_items[1], Constant);

        self.assertIsInstance(body[4], Decl);
        self.assertEqual(expand_init(body[4].init),
            ["Compound", [["Constant", "int", "1"]]]);

        self.assertIsInstance(body[5], Decl);
        self.assertEqual(body[5].init, null);

        self.assertIsInstance(body[6], Decl);
        self.assertEqual(expand_init(body[6].init),
            ["Compound", [["Decl", "x"], ["BinaryOp", ["ID", "x"], "+", ["Constant", "int", "2"]]]]);

        self.assertIsInstance(body[7], Assignment);
        self.assertIsInstance(body[7].rvalue, Compound);
        self.assertEqual(expand_init(body[7].rvalue),
            ["Compound", [["Decl", "x"], ["BinaryOp", ["Constant", "int", "2"], "*", ["ID", "x"]]]]);

    });
    test("enums", () => { let e1, e1_type, e2, e2_type, e2_elist, e3, e3_type, e3_elist;
        e1 = "enum mycolor op;";
        e1_type = self.parse(e1).ext[0].type.type;

        self.assertIsInstance(e1_type, Enum);
        self.assertEqual(e1_type.name, "mycolor");
        self.assertEqual(e1_type.values, null);

        e2 = "enum mysize {large=20, small, medium} shoes;";
        e2_type = self.parse(e2).ext[0].type.type;

        self.assertIsInstance(e2_type, Enum);
        self.assertEqual(e2_type.name, "mysize");

        e2_elist = e2_type.values;
        self.assertIsInstance(e2_elist, EnumeratorList);

        for (const e2_eval of e2_elist.enumerators) {
            self.assertIsInstance(e2_eval, Enumerator);

        }
        self.assertEqual(e2_elist.enumerators[0].name, "large");
        self.assertEqual(e2_elist.enumerators[0].value.value, "20");
        self.assertEqual(e2_elist.enumerators[2].name, "medium");
        self.assertEqual(e2_elist.enumerators[2].value, null);

        // enum with trailing comma (C99 feature)
        e3 = `
            enum
            {
                red,
                blue,
                green,
            } color;
            `;

        e3_type = self.parse(e3).ext[0].type.type;
        self.assertIsInstance(e3_type, Enum);
        e3_elist = e3_type.values;
        self.assertIsInstance(e3_elist, EnumeratorList);

        for (const e3_eval of e3_elist.enumerators) {
            self.assertIsInstance(e3_eval, Enumerator);

        }
        self.assertEqual(e3_elist.enumerators[0].name, "red");
        self.assertEqual(e3_elist.enumerators[0].value, null);
        self.assertEqual(e3_elist.enumerators[1].name, "blue");
        self.assertEqual(e3_elist.enumerators[2].name, "green");

    });
    test("typedef", () => { let s1, s2, ps2, s3, ps3, s4, ps4, s5, ps5, s6, ps6;
        // without typedef, error
        s1 = `
            node k;
        `;
        self.assertRaises(ParseError, self.parse, s1);

        // now with typedef, works
        s2 = `
            typedef void* node;
            node k;
        `;
        ps2 = self.parse(s2);
        self.assertEqual(expand_decl(ps2.ext[0]),
            ["Typedef", "node",
                ["PtrDecl",
                    ["TypeDecl", ["IdentifierType", ["void"]]]]]);

        self.assertEqual(expand_decl(ps2.ext[1]),
            ["Decl", "k",
                ["TypeDecl", ["IdentifierType", ["node"]]]]);

        s3 = `
            typedef int T;
            typedef T *pT;

            pT aa, bb;
        `;
        ps3 = self.parse(s3);
        self.assertEqual(expand_decl(ps3.ext[3]),
            ["Decl", "bb",
                ["TypeDecl", ["IdentifierType", ["pT"]]]]);

        s4 = `
            typedef char* __builtin_va_list;
            typedef __builtin_va_list __gnuc_va_list;
        `;
        ps4 = self.parse(s4);
        self.assertEqual(expand_decl(ps4.ext[1]),
            ["Typedef", "__gnuc_va_list",
                ["TypeDecl",
                    ["IdentifierType", ["__builtin_va_list"]]]]);

        s5 = `typedef struct tagHash Hash;`;
        ps5 = self.parse(s5);
        self.assertEqual(expand_decl(ps5.ext[0]),
            ["Typedef", "Hash", ["TypeDecl", ["Struct", "tagHash", []]]]);

        s6 = `typedef int (* const * const T)(void);`;
        ps6 = self.parse(s6);
        self.assertEqual(expand_decl(ps6.ext[0]),
         ["Typedef",
          "T",
          ["PtrDecl",
           ["const"],
           ["PtrDecl",
            ["const"],
            ["FuncDecl",
             [["Typename", ["TypeDecl", ["IdentifierType", ["void"]]]]],
             ["TypeDecl", ["IdentifierType", ["int"]]]]]]]);

    });
    test("struct_union", () => { let s1, s2, s21, s3, s4, s5, s6, s6_ast, s7, s7_ast, s8, s8_ast;
        s1 = `
            struct {
                int id;
                char* name;
            } joe;
            `;

        self.assertEqual(expand_decl(self.parse(s1).ext[0]),
            ["Decl", "joe",
                ["TypeDecl", ["Struct", null,
                    [   ["Decl", "id",
                            ["TypeDecl",
                                ["IdentifierType", ["int"]]]],
                        ["Decl", "name",
                            ["PtrDecl",
                                ["TypeDecl",
                                    ["IdentifierType", ["char"]]]]]]]]]);

        s2 = `
            struct node p;
        `;
        self.assertEqual(expand_decl(self.parse(s2).ext[0]),
            ["Decl", "p",
                ["TypeDecl", ["Struct", "node", []]]]);

        s21 = `
            union pri ra;
        `;
        self.assertEqual(expand_decl(self.parse(s21).ext[0]),
            ["Decl", "ra",
                ["TypeDecl", ["Union", "pri", []]]]);

        s3 = `
            struct node* p;
        `;
        self.assertEqual(expand_decl(self.parse(s3).ext[0]),
            ["Decl", "p",
                ["PtrDecl",
                    ["TypeDecl", ["Struct", "node", []]]]]);

        s4 = `
            struct node;
        `;
        self.assertEqual(expand_decl(self.parse(s4).ext[0]),
            ["Decl", null,
                ["Struct", "node", []]]);

        s5 = `
            union
            {
                struct
                {
                    int type;
                } n;

                struct
                {
                    int type;
                    int intnode;
                } ni;
            } u;
        `;
        self.assertEqual(expand_decl(self.parse(s5).ext[0]),
            ["Decl", "u",
                ["TypeDecl",
                    ["Union", null,
                        [["Decl", "n",
                            ["TypeDecl",
                                ["Struct", null,
                                    [["Decl", "type",
                                        ["TypeDecl", ["IdentifierType", ["int"]]]]]]]],
                        ["Decl", "ni",
                            ["TypeDecl",
                                ["Struct", null,
                                    [["Decl", "type",
                                        ["TypeDecl", ["IdentifierType", ["int"]]]],
                                    ["Decl", "intnode",
                                        ["TypeDecl", ["IdentifierType", ["int"]]]]]]]]]]]]);

        s6 = `
            typedef struct foo_tag
            {
                void* data;
            } foo, *pfoo;
        `;
        s6_ast = self.parse(s6);

        self.assertEqual(expand_decl(s6_ast.ext[0]),
            ["Typedef", "foo",
                ["TypeDecl",
                    ["Struct", "foo_tag",
                        [["Decl", "data",
                            ["PtrDecl", ["TypeDecl", ["IdentifierType", ["void"]]]]]]]]]);

        self.assertEqual(expand_decl(s6_ast.ext[1]),
            ["Typedef", "pfoo",
                ["PtrDecl",
                    ["TypeDecl",
                        ["Struct", "foo_tag",
                            [["Decl", "data",
                                ["PtrDecl", ["TypeDecl", ["IdentifierType", ["void"]]]]]]]]]]);

        s7 = String.raw`
            struct _on_exit_args {
                void *  _fnargs[32];
                void *  _dso_handle[32];

                long _fntypes;
                #line 77 "D:\eli\cpp_stuff\libc_include/sys/reent.h"

                long _is_cxa;
            };
        `;

        s7_ast = self.parse(s7, "test.c");
        self.assert_coord(s7_ast.ext[0].type.decls[2], 6, 22, "test.c");
        self.assert_coord(s7_ast.ext[0].type.decls[3], 78, 22,
            String.raw`D:\eli\cpp_stuff\libc_include/sys/reent.h`);

        s8 = `
            typedef enum tagReturnCode {SUCCESS, FAIL} ReturnCode;

            typedef struct tagEntry
            {
                char* key;
                char* value;
            } Entry;


            typedef struct tagNode
            {
                Entry* entry;

                struct tagNode* next;
            } Node;

            typedef struct tagHash
            {
                unsigned int table_size;

                Node** heads;

            } Hash;
        `;
        s8_ast = self.parse(s8);
        self.assertEqual(expand_decl(s8_ast.ext[3]),
            ["Typedef", "Hash",
                ["TypeDecl", ["Struct", "tagHash",
                    [["Decl", "table_size",
                        ["TypeDecl", ["IdentifierType", ["unsigned", "int"]]]],
                    ["Decl", "heads",
                        ["PtrDecl", ["PtrDecl", ["TypeDecl", ["IdentifierType", ["Node"]]]]]]]]]]);

    });
    test("struct_enum", () => { let s1, s2;
        s1 = `
            struct Foo {
                enum Bar { A = 1 };
            };
        `;
        self.assertEqual(expand_decl(self.parse(s1).ext[0]),
            ["Decl", null,
             ["Struct", "Foo",
              [["Decl", null,
                ["Enum", "Bar", ["A"]]]]]]);
        s2 = `
            struct Foo {
                enum Bar { A = 1, B, C } bar;
                enum Baz { D = A } baz;
            } foo;
        `;
        self.assertEqual(expand_decl(self.parse(s2).ext[0]),
            ["Decl", "foo",
             ["TypeDecl", ["Struct", "Foo",
              [["Decl", "bar",
                ["TypeDecl", ["Enum", "Bar", ["A", "B", "C"]]]],
               ["Decl", "baz",
                ["TypeDecl", ["Enum", "Baz", ["D"]]]]]]]]);

    });
    test("struct_with_extra_semis_inside", () => { let s1, s1_ast, s2, s2_ast;
        s1 = `
            struct {
                int a;;
            } foo;
        `;
        s1_ast = self.parse(s1);
        self.assertEqual(expand_decl(s1_ast.ext[0]),
            ["Decl", "foo",
                ["TypeDecl", ["Struct", null,
                    [["Decl", "a",
                        ["TypeDecl", ["IdentifierType", ["int"]]]]]]]]);

        s2 = `
            struct {
                int a;;;;
                float b, c;
                ;;
                char d;
            } foo;
        `;
        s2_ast = self.parse(s2);
        self.assertEqual(expand_decl(s2_ast.ext[0]),
            ["Decl", "foo",
                ["TypeDecl", ["Struct", null,
                   [["Decl", "a", ["TypeDecl", ["IdentifierType", ["int"]]]],
                    ["Decl", "b", ["TypeDecl", ["IdentifierType", ["float"]]]],
                    ["Decl", "c", ["TypeDecl", ["IdentifierType", ["float"]]]],
                    ["Decl", "d",
                        ["TypeDecl", ["IdentifierType", ["char"]]]]]]]]);

    });
    test("struct_with_initial_semi", () => { let s1, s1_ast;
        s1 = `
            struct {
                ;int a;
            } foo;
        `;
        s1_ast = self.parse(s1);
        self.assertEqual(expand_decl(s1_ast.ext[0]),
            ["Decl", "foo",
                ["TypeDecl", ["Struct", null,
                    [["Decl", "a",
                        ["TypeDecl", ["IdentifierType", ["int"]]]]]]]]);

    });
    test("anonymous_struct_union", () => { let s1, s2, s3, s4;
        s1 = `
            union
            {
                union
                {
                    int i;
                    long l;
                };

                struct
                {
                    int type;
                    int intnode;
                };
            } u;
        `;

        self.assertEqual(expand_decl(self.parse(s1).ext[0]),
            ["Decl", "u",
                ["TypeDecl",
                    ["Union", null,
                        [["Decl", null,
                            ["Union", null,
                                [["Decl", "i",
                                    ["TypeDecl",
                                        ["IdentifierType", ["int"]]]],
                                ["Decl", "l",
                                    ["TypeDecl",
                                        ["IdentifierType", ["long"]]]]]]],
                        ["Decl", null,
                            ["Struct", null,
                                [["Decl", "type",
                                    ["TypeDecl",
                                        ["IdentifierType", ["int"]]]],
                                ["Decl", "intnode",
                                    ["TypeDecl",
                                        ["IdentifierType", ["int"]]]]]]]]]]]);

        s2 = `
            struct
            {
                int i;
                union
                {
                    int id;
                    char* name;
                };
                float f;
            } joe;
            `;

        self.assertEqual(expand_decl(self.parse(s2).ext[0]),
            ["Decl", "joe",
                ["TypeDecl",
                    ["Struct", null,
                       [["Decl", "i",
                            ["TypeDecl",
                                ["IdentifierType", ["int"]]]],
                        ["Decl", null,
                            ["Union", null,
                                [["Decl", "id",
                                    ["TypeDecl",
                                        ["IdentifierType", ["int"]]]],
                                ["Decl", "name",
                                    ["PtrDecl",
                                        ["TypeDecl",
                                            ["IdentifierType", ["char"]]]]]]]],
                        ["Decl", "f",
                            ["TypeDecl",
                                ["IdentifierType", ["float"]]]]]]]]);

        // ISO/IEC 9899:201x Committee Draft 2010-11-16, N1539
        // section 6.7.2.1, par. 19, example 1
        s3 = `
            struct v {
                union {
                    struct { int i, j; };
                    struct { long k, l; } w;
                };
                int m;
            } v1;
            `;

        self.assertEqual(expand_decl(self.parse(s3).ext[0]),
            ["Decl", "v1",
                ["TypeDecl",
                    ["Struct", "v",
                       [["Decl", null,
                            ["Union", null,
                                [["Decl", null,
                                    ["Struct", null,
                                        [["Decl", "i",
                                            ["TypeDecl",
                                                ["IdentifierType", ["int"]]]],
                                        ["Decl", "j",
                                            ["TypeDecl",
                                                ["IdentifierType", ["int"]]]]]]],
                                ["Decl", "w",
                                    ["TypeDecl",
                                        ["Struct", null,
                                            [["Decl", "k",
                                                ["TypeDecl",
                                                    ["IdentifierType", ["long"]]]],
                                            ["Decl", "l",
                                                ["TypeDecl",
                                                    ["IdentifierType", ["long"]]]]]]]]]]],
                        ["Decl", "m",
                            ["TypeDecl",
                                ["IdentifierType", ["int"]]]]]]]]);

        s4 = `
            struct v {
                int i;
                float;
            } v2;`;
        // just make sure this doesn't raise ParseError
        self.parse(s4);

    });
    test("struct_members_namespace", () => { let s1, s1_ast;
        ` Tests that structure/union member names reside in a separate
            namespace and can be named after existing types.
        `
        s1 = `
                typedef int Name;
                typedef Name NameArray[10];

                struct {
                    Name Name;
                    Name NameArray[3];
                } sye;

                void main(void)
                {
                    sye.Name = 1;
                }
            `;

        s1_ast = self.parse(s1);
        self.assertEqual(expand_decl(s1_ast.ext[2]),
            ["Decl", "sye",
                ["TypeDecl", ["Struct", null,
                    [   ["Decl", "Name",
                            ["TypeDecl",
                                ["IdentifierType", ["Name"]]]],
                        ["Decl", "NameArray",
                            ["ArrayDecl", "3", [],
                                ["TypeDecl", ["IdentifierType", ["Name"]]]]]]]]]);
        self.assertEqual(s1_ast.ext[3].body.block_items[0].lvalue.field.name, "Name");

    });
    test("struct_bitfields", () => { let s1, parsed_struct;
        // a struct with two bitfields, one unnamed
        s1 = `
            struct {
                int k:6;
                int :2;
            } joe;
            `;

        parsed_struct = self.parse(s1).ext[0];

        // We can see here the name of the decl for the unnamed bitfield is
        // None, but expand_decl doesn't show bitfield widths
        // ...
        self.assertEqual(expand_decl(parsed_struct),
            ["Decl", "joe",
                ["TypeDecl", ["Struct", null,
                    [   ["Decl", "k",
                            ["TypeDecl",
                                ["IdentifierType", ["int"]]]],
                        ["Decl", null,
                            ["TypeDecl",
                                ["IdentifierType", ["int"]]]]]]]]);

        // ...
        // so we test them manually
        self.assertEqual(parsed_struct.type.type.decls[0].bitsize.value, "6");
        self.assertEqual(parsed_struct.type.type.decls[1].bitsize.value, "2");

    });
    test("struct_empty", () => { let s1, parsed_struct, s2, s3;
        `
        Tests that parsing an empty struct works.

        Empty structs do NOT follow C99 (See 6.2.5-20 of the C99 standard).
        This is nevertheless supported by some compilers (clang, gcc),
        especially when using FORTIFY code.
        Some compilers (visual) will fail to compile with an error.
        `
        // an empty struct. This is NOT C99 compliant
        s1 = `
                 struct foo { };
             `;

        parsed_struct = self.parse(s1).ext[0];
        self.assertEqual(expand_decl(parsed_struct),
                         ["Decl", null, ["Struct", "foo", []]]);

        s2 = `struct { } foo;`;
        parsed_struct = self.parse(s2).ext[0];
        self.assertEqual(expand_decl(parsed_struct),
                         ["Decl", "foo", ["TypeDecl", ["Struct", null, []]]]);

        s3 = `union { } foo;`;
        parsed_struct = self.parse(s3).ext[0];
        self.assertEqual(expand_decl(parsed_struct),
                         ["Decl", "foo", ["TypeDecl", ["Union", null, []]]]);

    });
    test("tags_namespace", () => { let s1, s1_ast, s2, s2_ast, s3, s3_type;
        ` Tests that the tags of structs/unions/enums reside in a separate namespace and
            can be named after existing types.
        `
        s1 = `
                typedef int tagEntry;

                struct tagEntry
                {
                    char* key;
                    char* value;
                } Entry;
            `;

        s1_ast = self.parse(s1);
        self.assertEqual(expand_decl(s1_ast.ext[1]),
            ["Decl", "Entry",
                ["TypeDecl", ["Struct", "tagEntry",
                    [["Decl", "key",
                        ["PtrDecl", ["TypeDecl", ["IdentifierType", ["char"]]]]],
                    ["Decl", "value",
                        ["PtrDecl", ["TypeDecl", ["IdentifierType", ["char"]]]]]]]]]);

        s2 = `
                struct tagEntry;

                typedef struct tagEntry tagEntry;

                struct tagEntry
                {
                    char* key;
                    char* value;
                } Entry;
            `;

        s2_ast = self.parse(s2);
        self.assertEqual(expand_decl(s2_ast.ext[2]),
            ["Decl", "Entry",
                ["TypeDecl", ["Struct", "tagEntry",
                    [["Decl", "key",
                        ["PtrDecl", ["TypeDecl", ["IdentifierType", ["char"]]]]],
                    ["Decl", "value",
                        ["PtrDecl", ["TypeDecl", ["IdentifierType", ["char"]]]]]]]]]);

        s3 = `
                typedef int mytag;

                enum mytag {ABC, CDE};
                enum mytag joe;
            `;

        s3_type = self.parse(s3).ext[1].type;

        self.assertIsInstance(s3_type, Enum);
        self.assertEqual(s3_type.name, "mytag");

    });
    test("multi_decls", () => { let d1, d2;
        d1 = "int a, b;";

        self.assertEqual(self.get_decl(d1, 0),
            ["Decl", "a", ["TypeDecl", ["IdentifierType", ["int"]]]]);
        self.assertEqual(self.get_decl(d1, 1),
            ["Decl", "b", ["TypeDecl", ["IdentifierType", ["int"]]]]);

        d2 = "char* p, notp, ar[4];";
        self.assertEqual(self.get_decl(d2, 0),
            ["Decl", "p",
                ["PtrDecl",
                    ["TypeDecl", ["IdentifierType", ["char"]]]]]);
        self.assertEqual(self.get_decl(d2, 1),
            ["Decl", "notp", ["TypeDecl", ["IdentifierType", ["char"]]]]);
        self.assertEqual(self.get_decl(d2, 2),
            ["Decl", "ar",
                ["ArrayDecl", "4", [],
                    ["TypeDecl", ["IdentifierType", ["char"]]]]]);

    });
    test("invalid_multiple_types_error", () => { let bad;
        bad = [
            "int enum {ab, cd} fubr;",
            "enum kid char brbr;"];

        for (const b of bad) {
            self.assertRaises(ParseError, self.parse, b);

        }
    });
    test("invalid_typedef_storage_qual_error", () => { let bad;
        ` Tests that using typedef as a storage qualifier is correctly flagged
            as an error.
        `
        bad = "typedef const int foo(int a) { return 0; }";
        self.assertRaises(ParseError, self.parse, bad);

    });
    test("duplicate_typedef", () => { let d1, d2, d3;
        ` Tests that redeclarations of existing types are parsed correctly.
            This is non-standard, but allowed by many compilers.
        `
        d1 = `
            typedef int numbertype;
            typedef int numbertype;
        `;

        self.assertEqual(self.get_decl(d1, 0),
            ["Typedef", "numbertype",
                ["TypeDecl", ["IdentifierType", ["int"]]]]);
        self.assertEqual(self.get_decl(d1, 1),
            ["Typedef", "numbertype",
                ["TypeDecl", ["IdentifierType", ["int"]]]]);

        d2 = `
            typedef int (*funcptr)(int x);
            typedef int (*funcptr)(int x);
        `;
        self.assertEqual(self.get_decl(d2, 0),
            ["Typedef", "funcptr",
                ["PtrDecl", ["FuncDecl",
                    [["Decl", "x", ["TypeDecl", ["IdentifierType", ["int"]]]]],
                    ["TypeDecl", ["IdentifierType", ["int"]]]]]]);
        self.assertEqual(self.get_decl(d2, 1),
            ["Typedef", "funcptr",
                ["PtrDecl", ["FuncDecl",
                    [["Decl", "x", ["TypeDecl", ["IdentifierType", ["int"]]]]],
                    ["TypeDecl", ["IdentifierType", ["int"]]]]]]);

        d3 = `
            typedef int numberarray[5];
            typedef int numberarray[5];
        `;
        self.assertEqual(self.get_decl(d3, 0),
            ["Typedef", "numberarray",
                ["ArrayDecl", "5", [],
                    ["TypeDecl", ["IdentifierType", ["int"]]]]]);
        self.assertEqual(self.get_decl(d3, 1),
            ["Typedef", "numberarray",
                ["ArrayDecl", "5", [],
                    ["TypeDecl", ["IdentifierType", ["int"]]]]]);

    });
    test("decl_inits", () => { let d1, d1_1, d1_2, d2, d21, d3, d4, d5, d51, d52, d53, d54, d55, d56, d57, d58, d59, d6, d61, d62, d63;
        d1 = "int a = 16;";
        //~ self.parse(d1).show()
        self.assertEqual(self.get_decl(d1),
            ["Decl", "a", ["TypeDecl", ["IdentifierType", ["int"]]]]);
        self.assertEqual(self.get_decl_init(d1),
            ["Constant", "int", "16"]);

        d1_1 = "float f = 0xEF.56p1;";
        self.assertEqual(self.get_decl_init(d1_1),
            ["Constant", "double", "0xEF.56p1"]);

        d1_2 = "int bitmask = 0b1001010;";
        self.assertEqual(self.get_decl_init(d1_2),
            ["Constant", "int", "0b1001010"]);

        d2 = "long ar[] = {7, 8, 9};";
        self.assertEqual(self.get_decl(d2),
            ["Decl", "ar",
                ["ArrayDecl", "", [],
                    ["TypeDecl", ["IdentifierType", ["long"]]]]]);
        self.assertEqual(self.get_decl_init(d2),
            [   ["Constant", "int", "7"],
                ["Constant", "int", "8"],
                ["Constant", "int", "9"]]);

        d21 = "long ar[4] = {};";
        self.assertEqual(self.get_decl_init(d21), []);

        d3 = "char p = j;";
        self.assertEqual(self.get_decl(d3),
            ["Decl", "p", ["TypeDecl", ["IdentifierType", ["char"]]]]);
        self.assertEqual(self.get_decl_init(d3),
            ["ID", "j"]);

        d4 = "char x = 'c', *p = {0, 1, 2, {4, 5}, 6};";
        self.assertEqual(self.get_decl(d4, 0),
            ["Decl", "x", ["TypeDecl", ["IdentifierType", ["char"]]]]);
        self.assertEqual(self.get_decl_init(d4, 0),
            ["Constant", "char", "'c'"]);
        self.assertEqual(self.get_decl(d4, 1),
            ["Decl", "p",
                ["PtrDecl",
                    ["TypeDecl", ["IdentifierType", ["char"]]]]]);

        self.assertEqual(self.get_decl_init(d4, 1),
            [   ["Constant", "int", "0"],
                ["Constant", "int", "1"],
                ["Constant", "int", "2"],
                [["Constant", "int", "4"],
                 ["Constant", "int", "5"]],
                ["Constant", "int", "6"]]);

        d5 = "float d = 1.0;";
        self.assertEqual(self.get_decl_init(d5),
            ["Constant", "double", "1.0"]);

        d51 = "float ld = 1.0l;";
        self.assertEqual(self.get_decl_init(d51),
            ["Constant", "long double", "1.0l"]);

        d52 = "float ld = 1.0L;";
        self.assertEqual(self.get_decl_init(d52),
            ["Constant", "long double", "1.0L"]);

        d53 = "float ld = 1.0f;";
        self.assertEqual(self.get_decl_init(d53),
            ["Constant", "float", "1.0f"]);

        d54 = "float ld = 1.0F;";
        self.assertEqual(self.get_decl_init(d54),
            ["Constant", "float", "1.0F"]);

        d55 = "float ld = 0xDE.38p0;";
        self.assertEqual(self.get_decl_init(d55),
            ["Constant", "double", "0xDE.38p0"]);

        d56 = "float ld = 0xDE.38p0f;";
        self.assertEqual(self.get_decl_init(d56),
            ["Constant", "float", "0xDE.38p0f"]);

        d57 = "float ld = 0xDE.38p0F;";
        self.assertEqual(self.get_decl_init(d57),
            ["Constant", "float", "0xDE.38p0F"]);

        d58 = "float ld = 0xDE.38p0l;";
        self.assertEqual(self.get_decl_init(d58),
            ["Constant", "long double", "0xDE.38p0l"]);

        d59 = "float ld = 0xDE.38p0L;";
        self.assertEqual(self.get_decl_init(d59),
            ["Constant", "long double", "0xDE.38p0L"]);

        d6 = "int i = 1;";
        self.assertEqual(self.get_decl_init(d6),
            ["Constant", "int", "1"]);

        d61 = "long int li = 1l;";
        self.assertEqual(self.get_decl_init(d61),
            ["Constant", "long int", "1l"]);

        d62 = "unsigned int ui = 1u;";
        self.assertEqual(self.get_decl_init(d62),
            ["Constant", "unsigned int", "1u"]);

        d63 = "unsigned long long int ulli = 1LLU;";
        self.assertEqual(self.get_decl_init(d63),
            ["Constant", "unsigned long long int", "1LLU"]);

    });
    test("decl_named_inits", () => { let d1, d2, d3;
        d1 = "int a = {.k = 16};";
        self.assertEqual(self.get_decl_init(d1),
            [[   [["ID", "k"]],
                 ["Constant", "int", "16"]]]);

        d2 = "int a = { [0].a = {1}, [1].a[0] = 2 };";
        self.assertEqual(self.get_decl_init(d2),
            [
                [[["Constant", "int", "0"], ["ID", "a"]],
                    [["Constant", "int", "1"]]],
                [[["Constant", "int", "1"], ["ID", "a"], ["Constant", "int", "0"]],
                    ["Constant", "int", "2"]]]);

        d3 = "int a = { .a = 1, .c = 3, 4, .b = 5};";
        self.assertEqual(self.get_decl_init(d3),
            [
                [[["ID", "a"]], ["Constant", "int", "1"]],
                [[["ID", "c"]], ["Constant", "int", "3"]],
                ["Constant", "int", "4"],
                [[["ID", "b"]], ["Constant", "int", "5"]]]);

    });
    test("function_definitions", () => { let f1, f2, f3, f4;
        const parse_fdef = (str) => {
            return self.parse(str).ext[0];

        };
        const fdef_decl = (fdef) => {
            return expand_decl(fdef.decl);

        };
        f1 = parse_fdef(`
        int factorial(int p)
        {
            return 3;
        }
        `);

        self.assertEqual(fdef_decl(f1),
            ["Decl", "factorial",
                ["FuncDecl",
                    [["Decl", "p", ["TypeDecl", ["IdentifierType", ["int"]]]]],
                    ["TypeDecl", ["IdentifierType", ["int"]]]]]);

        self.assertEqual(type(f1.body.block_items[0]), Return);

        f2 = parse_fdef(`
        char* zzz(int p, char* c)
        {
            int a;
            char b;

            a = b + 2;
            return 3;
        }
        `);

        self.assertEqual(fdef_decl(f2),
            ["Decl", "zzz",
                ["FuncDecl",
                    [   ["Decl", "p", ["TypeDecl", ["IdentifierType", ["int"]]]],
                        ["Decl", "c", ["PtrDecl",
                                        ["TypeDecl", ["IdentifierType", ["char"]]]]]],
                    ["PtrDecl", ["TypeDecl", ["IdentifierType", ["char"]]]]]]);

        self.assertEqual(f2.body.block_items.map(type),
            [Decl, Decl, Assignment, Return]);

        f3 = parse_fdef(`
        char* zzz(p, c)
        long p, *c;
        {
            int a;
            char b;

            a = b + 2;
            return 3;
        }
        `);

        self.assertEqual(fdef_decl(f3),
            ["Decl", "zzz",
                ["FuncDecl",
                    [   ["ID", "p"],
                        ["ID", "c"]],
                    ["PtrDecl", ["TypeDecl", ["IdentifierType", ["char"]]]]]]);

        self.assertEqual(f3.body.block_items.map(type),
            [Decl, Decl, Assignment, Return]);

        self.assertEqual(expand_decl(f3.param_decls[0]),
            ["Decl", "p", ["TypeDecl", ["IdentifierType", ["long"]]]]);
        self.assertEqual(expand_decl(f3.param_decls[1]),
            ["Decl", "c", ["PtrDecl", ["TypeDecl", ["IdentifierType", ["long"]]]]]);

        // function return values and parameters may not have type information
        f4 = parse_fdef(`
        que(p)
        {
            return 3;
        }
        `);

        self.assertEqual(fdef_decl(f4),
            ["Decl", "que",
                ["FuncDecl",
                    [["ID", "p"]],
                    ["TypeDecl", ["IdentifierType", ["int"]]]]]);

    });
    test("static_assert", () => { let f1;
        f1 = self.parse(`
        _Static_assert(1, "123");
        int factorial(int p)
        {
            _Static_assert(2, "456");
            _Static_assert(3);
        }
        `);

        self.assertEqual(expand_decl(f1.ext[0]), ["StaticAssert", "1", "\"123\""]);
        self.assertEqual(expand_decl(f1.ext[1].body.block_items[0]), ["StaticAssert", "2", "\"456\""]);
        self.assertEqual(expand_decl(f1.ext[1].body.block_items[2]), ["StaticAssert", "3"]);

    });
    test("unified_string_literals", () => { let d1, d2, d3, d4, d5, d6;
        // simple string, for reference
        d1 = self.get_decl_init("char* s = \"hello\";");
        self.assertEqual(d1, ["Constant", "string", "\"hello\""]);

        d2 = self.get_decl_init("char* s = \"hello\" \" world\";");
        self.assertEqual(d2, ["Constant", "string", "\"hello world\""]);

        // the test case from issue 6
        d3 = self.parse(String.raw`
            int main() {
                fprintf(stderr,
                "Wrong Params?\n"
                "Usage:\n"
                "%s <binary_file_path>\n",
                argv[0]
                );
            }
        `);

        self.assertEqual(
            d3.ext[0].body.block_items[0].args.exprs[1].value,
            String.raw`"Wrong Params?\nUsage:\n%s <binary_file_path>\n"`);

        d4 = self.get_decl_init("char* s = \"\" \"foobar\";");
        self.assertEqual(d4, ["Constant", "string", "\"foobar\""]);

        d5 = self.get_decl_init(String.raw`char* s = "foo\"" "bar";`);
        self.assertEqual(d5, ["Constant", "string", String.raw`"foo\"bar"`]);

        // This is not correct based on the the C spec, but testing it here to
        // see the behavior in action. Will have to fix this
        // for https://github.com/eliben/pycparser/issues/392
        //
        // The spec says in section 6.4.5 that "escape sequences are converted
        // into single members of the execution character set just prior to
        // adjacent string literal concatenation".
        d6 = self.get_decl_init(String.raw`char* s = "\1" "23";`);
        self.assertEqual(d6, ["Constant", "string", String.raw`"\123"`]);

    });
    test("unified_wstring_literals", () => { let d1, d2;
        d1 = self.get_decl_init("char* s = L\"hello\" L\"world\";");
        self.assertEqual(d1, ["Constant", "string", "L\"helloworld\""]);

        d2 = self.get_decl_init("char* s = L\"hello \" L\"world\" L\" and I\";");
        self.assertEqual(d2, ["Constant", "string", "L\"hello world and I\""]);

    });
    test("inline_specifier", () => { let ps2;
        ps2 = self.parse("static inline void inlinefoo(void);");
        self.assertEqual(ps2.ext[0].funcspec, ["inline"]);

    });
    test("noreturn_specifier", () => { let ps2;
        ps2 = self.parse("static _Noreturn void noreturnfoo(void);");
        self.assertEqual(ps2.ext[0].funcspec, ["_Noreturn"]);

    // variable length array
    });
    test("vla", () => { let ps2;
        ps2 = self.parse(String.raw`
            int main() {
                int size;
                int var[size = 5];

                int var2[*];
            }
        `);
        self.assertIsInstance(ps2.ext[0].body.block_items[1].type.dim, Assignment);
        self.assertIsInstance(ps2.ext[0].body.block_items[2].type.dim, ID);

    });
    test("pragma", () => { let s1, s1_ast;
        s1 = String.raw`
            #pragma bar
            void main() {
                #pragma foo
                for(;;) {}
                #pragma baz
                {
                    int i = 0;
                }
                #pragma
            }
            struct s {
            #pragma baz
            } s;
            _Pragma("other \"string\"")
            `;
        s1_ast = self.parse(s1);
        self.assertIsInstance(s1_ast.ext[0], Pragma);
        self.assertEqual(s1_ast.ext[0].string, "bar");
        self.assertEqual(s1_ast.ext[0].coord.line, 2);

        self.assertIsInstance(s1_ast.ext[1].body.block_items[0], Pragma);
        self.assertEqual(s1_ast.ext[1].body.block_items[0].string, "foo");
        self.assertEqual(s1_ast.ext[1].body.block_items[0].coord.line, 4);

        self.assertIsInstance(s1_ast.ext[1].body.block_items[2], Pragma);
        self.assertEqual(s1_ast.ext[1].body.block_items[2].string, "baz");
        self.assertEqual(s1_ast.ext[1].body.block_items[2].coord.line, 6);

        self.assertIsInstance(s1_ast.ext[1].body.block_items[4], Pragma);
        self.assertEqual(s1_ast.ext[1].body.block_items[4].string, "");
        self.assertEqual(s1_ast.ext[1].body.block_items[4].coord.line, 10);

        self.assertIsInstance(s1_ast.ext[2].type.type.decls[0], Pragma);
        self.assertEqual(s1_ast.ext[2].type.type.decls[0].string, "baz");
        self.assertEqual(s1_ast.ext[2].type.type.decls[0].coord.line, 13);

        self.assertIsInstance(s1_ast.ext[3], Pragma);
        self.assertEqual(s1_ast.ext[3].string.value, String.raw`"other \"string\""`);
        self.assertEqual(s1_ast.ext[3].coord.line, 15);

    });
    test("pragmacomp_or_statement", () => { let s1, s1_ast;
        s1 = String.raw`
            void main() {
                int sum = 0;
                for (int i; i < 3; i++)
                    #pragma omp critical
                    sum += 1;

                while(sum < 10)
                    #pragma omp critical
                    sum += 1;

                mylabel:
                    #pragma foo
                    sum += 10;

                if (sum > 10)
                    #pragma bar
                    #pragma baz
                    sum = 10;

                switch (sum)
                case 10:
                    #pragma foo
                    sum = 20;
            }
        `;
        s1_ast = self.parse(s1);
        self.assertIsInstance(s1_ast.ext[0].body.block_items[1], For);
        self.assertIsInstance(s1_ast.ext[0].body.block_items[1].stmt, Compound);
        self.assertIsInstance(s1_ast.ext[0].body.block_items[1].stmt.block_items[0], Pragma);
        self.assertIsInstance(s1_ast.ext[0].body.block_items[1].stmt.block_items[1], Assignment);
        self.assertIsInstance(s1_ast.ext[0].body.block_items[2], While);
        self.assertIsInstance(s1_ast.ext[0].body.block_items[2].stmt, Compound);
        self.assertIsInstance(s1_ast.ext[0].body.block_items[2].stmt.block_items[0], Pragma);
        self.assertIsInstance(s1_ast.ext[0].body.block_items[2].stmt.block_items[1], Assignment);
        self.assertIsInstance(s1_ast.ext[0].body.block_items[3], Label);
        self.assertIsInstance(s1_ast.ext[0].body.block_items[3].stmt, Compound);
        self.assertIsInstance(s1_ast.ext[0].body.block_items[3].stmt.block_items[0], Pragma);
        self.assertIsInstance(s1_ast.ext[0].body.block_items[3].stmt.block_items[1], Assignment);
        self.assertIsInstance(s1_ast.ext[0].body.block_items[4], If);
        self.assertIsInstance(s1_ast.ext[0].body.block_items[4].iftrue, Compound);
        self.assertIsInstance(s1_ast.ext[0].body.block_items[4].iftrue.block_items[0], Pragma);
        self.assertIsInstance(s1_ast.ext[0].body.block_items[4].iftrue.block_items[1], Pragma);
        self.assertIsInstance(s1_ast.ext[0].body.block_items[4].iftrue.block_items[2], Assignment);
        self.assertIsInstance(s1_ast.ext[0].body.block_items[5], Switch);
        self.assertIsInstance(s1_ast.ext[0].body.block_items[5].stmt.stmts[0], Compound);
        self.assertIsInstance(s1_ast.ext[0].body.block_items[5].stmt.stmts[0].block_items[0],
                              Pragma);
        self.assertIsInstance(s1_ast.ext[0].body.block_items[5].stmt.stmts[0].block_items[1],
                              Assignment);


    });
});
describe("TestCParser_whole_code", () => { const self = new TestCParser_base();
    // Testing of parsing whole chunks of code. Since upstream does not want
    // to rely on the structure of ASTs too much, most of these tests are
    // implemented with visitors.

    // A simple helper visitor that lists the values of all the
    // Constant nodes it sees.
    class ConstantVisitor extends NodeVisitor {
        constructor() { super(); this.values = []; }
        visit_Constant(node) { this.values.push(node.value); }
    }

    // This visitor counts the amount of references to the ID
    // with the name provided to it in the constructor.
    class IDNameCounter extends NodeVisitor {
        constructor(name) { super(); this.name = name; this.nrefs = 0; }
        visit_ID(node) { if (node.name == this.name) this.nrefs += 1; }
    }

    // Counts the amount of nodes of a given class
    class NodeKlassCounter extends NodeVisitor {
        constructor(node_klass) { super(); this.klass = node_klass; this.n = 0; }
        generic_visit(node) {
            if (node.constructor === this.klass) this.n += 1;
            NodeVisitor.prototype.generic_visit.call(this, node);
        }
    }

    const parsedOf = (code) => (typeof code === "string" ? self.parse(code) : code);

    self.assert_all_Constants = (code, constants) => {
        const cv = new ConstantVisitor();
        cv.visit(parsedOf(code));
        self.assertEqual(cv.values, constants);
    };

    self.assert_num_ID_refs = (code, name, num) => {
        const iv = new IDNameCounter(name);
        iv.visit(parsedOf(code));
        self.assertEqual(iv.nrefs, num);
    };

    self.assert_num_klass_nodes = (code, klass, num) => {
        const cv = new NodeKlassCounter(klass);
        cv.visit(parsedOf(code));
        self.assertEqual(cv.n, num);
    };

    test("expressions", () => { let e1, e2, s1, ps1;
        e1 = `int k = (r + 10.0) >> 6 + 8 << (3 & 0x14);`;
        self.assert_all_Constants(e1, ["10.0", "6", "8", "3", "0x14"]);

        e2 = String.raw`char n = '\n', *prefix = "st_";`;
        self.assert_all_Constants(e2, [String.raw`'\n'`, "\"st_\""]);

        s1 = String.raw`int main() {
                    int i = 5, j = 6, k = 1;
                    if ((i=j && k == 1) || k > j)
                        printf("Hello, world\n");
                    return 0;
                 }`;
        ps1 = self.parse(s1);
        self.assert_all_Constants(ps1,
            ["5", "6", "1", "1", "\"Hello, world\\n\"", "0"]);
        self.assert_num_ID_refs(ps1, "i", 1);
        self.assert_num_ID_refs(ps1, "j", 2);


    });
    test("statements", () => { let s1, ps1, s2, ps2, s3, ps3;
        s1 = String.raw`
            void foo(){
            if (sp == 1)
                if (optind >= argc ||
                    argv[optind][0] != '-' || argv[optind][1] == '\0')
                        return -1;
                else if (strcmp(argv[optind], "--") == 0) {
                    optind++;
                    return -1;
                }
            }
        `;

        self.assert_all_Constants(s1,
            ["1", "0", String.raw`'-'`, "1", String.raw`'\0'`, "1", String.raw`"--"`, "0", "1"]);

        ps1 = self.parse(s1);
        self.assert_num_ID_refs(ps1, "argv", 3);
        self.assert_num_ID_refs(ps1, "optind", 5);

        self.assert_num_klass_nodes(ps1, If, 3);
        self.assert_num_klass_nodes(ps1, Return, 2);
        self.assert_num_klass_nodes(ps1, FuncCall, 1); // strcmp
        self.assert_num_klass_nodes(ps1, BinaryOp, 7);

        // In the following code, Hash and Node were defined as
        // int to pacify the parser that sees they're used as
        // types
        //
        s2 = String.raw`
        typedef int Hash, Node;

        void HashDestroy(Hash* hash)
        {
            unsigned int i;

            if (hash == NULL)
                return;

            for (i = 0; i < hash->table_size; ++i)
            {
                Node* temp = hash->heads[i];

                while (temp != NULL)
                {
                    Node* temp2 = temp;

                    free(temp->entry->key);
                    free(temp->entry->value);
                    free(temp->entry);

                    temp = temp->next;

                    free(temp2);
                }
            }

            free(hash->heads);
            hash->heads = NULL;

            free(hash);
        }
        `;

        ps2 = self.parse(s2);
        self.assert_num_klass_nodes(ps2, FuncCall, 6);
        self.assert_num_klass_nodes(ps2, FuncDef, 1);
        self.assert_num_klass_nodes(ps2, For, 1);
        self.assert_num_klass_nodes(ps2, While, 1);
        self.assert_num_klass_nodes(ps2, StructRef, 10);

        // declarations don't count
        self.assert_num_ID_refs(ps2, "hash", 6);
        self.assert_num_ID_refs(ps2, "i", 4);

        s3 = String.raw`
        void x(void) {
          int a, b;
          if (a < b)
            do {
              a = 0;
            } while (0);
          else if (a == b) {
            a = 1;
          }
        }
        `;

        ps3 = self.parse(s3);
        self.assert_num_klass_nodes(ps3, DoWhile, 1);
        self.assert_num_ID_refs(ps3, "a", 4);
        self.assert_all_Constants(ps3, ["0", "0", "1"]);

    });
    test("empty_statements", () => { let s1, ps1;
        s1 = String.raw`
        void foo(void){
            ;
            return;;

            ;
        }
        `;
        ps1 = self.parse(s1);
        self.assert_num_klass_nodes(ps1, EmptyStatement, 3);
        self.assert_num_klass_nodes(ps1, Return, 1);
        self.assert_coord(ps1.ext[0].body.block_items[0], 3);
        self.assert_coord(ps1.ext[0].body.block_items[1], 4);
        self.assert_coord(ps1.ext[0].body.block_items[2], 4);
        self.assert_coord(ps1.ext[0].body.block_items[3], 6);

    });
    test("switch_statement", () => { let s1, ps1, switch_, block, s2, ps2, s3, ps3;
        const assert_case_node = (node, const_value) => {
            self.assertIsInstance(node, Case);
            self.assertIsInstance(node.expr, Constant);
            self.assertEqual(node.expr.value, const_value);

        };
        const assert_default_node = (node) => {
            self.assertIsInstance(node, Default);

        };
        s1 = String.raw`
        int foo(void) {
            switch (myvar) {
                case 10:
                    k = 10;
                    p = k + 1;
                    return 10;
                case 20:
                case 30:
                    return 20;
                default:
                    break;
            }
            return 0;
        }
        `;
        ps1 = self.parse(s1);
        switch_ = ps1.ext[0].body.block_items[0];

        block = switch_.stmt.block_items;
        self.assertEqual(block.length, 4);
        assert_case_node(block[0], "10");
        self.assertEqual(block[0].stmts.length, 3);
        assert_case_node(block[1], "20");
        self.assertEqual(block[1].stmts.length, 0);
        assert_case_node(block[2], "30");
        self.assertEqual(block[2].stmts.length, 1);
        assert_default_node(block[3]);

        s2 = String.raw`
        int foo(void) {
            switch (myvar) {
                default:
                    joe = moe;
                    return 10;
                case 10:
                case 20:
                case 30:
                case 40:
                    break;
            }
            return 0;
        }
        `;
        ps2 = self.parse(s2);
        switch_ = ps2.ext[0].body.block_items[0];

        block = switch_.stmt.block_items;
        self.assertEqual(block.length, 5);
        assert_default_node(block[0]);
        self.assertEqual(block[0].stmts.length, 2);
        assert_case_node(block[1], "10");
        self.assertEqual(block[1].stmts.length, 0);
        assert_case_node(block[2], "20");
        self.assertEqual(block[1].stmts.length, 0);
        assert_case_node(block[3], "30");
        self.assertEqual(block[1].stmts.length, 0);
        assert_case_node(block[4], "40");
        self.assertEqual(block[4].stmts.length, 1);

        s3 = String.raw`
        int foo(void) {
            switch (myvar) {
            }
            return 0;
        }
        `;
        ps3 = self.parse(s3);
        switch_ = ps3.ext[0].body.block_items[0];

        self.assertEqual(switch_.stmt.block_items, []);

    });
    test("for_statement", () => { let s2, ps2, s3, ps3, s4, ps4;
        s2 = String.raw`
        void x(void)
        {
            int i;
            for (i = 0; i < 5; ++i) {
                x = 50;
            }
        }
        `;
        ps2 = self.parse(s2);
        self.assert_num_klass_nodes(ps2, For, 1);
        // here there are 3 refs to 'i' since the declaration doesn't count as
        // a ref in the visitor
        //
        self.assert_num_ID_refs(ps2, "i", 3);

        s3 = String.raw`
        void x(void)
        {
            for (int i = 0; i < 5; ++i) {
                x = 50;
            }
        }
        `;
        ps3 = self.parse(s3);
        self.assert_num_klass_nodes(ps3, For, 1);
        // here there are 2 refs to 'i' since the declaration doesn't count as
        // a ref in the visitor
        //
        self.assert_num_ID_refs(ps3, "i", 2);

        s4 = String.raw`
        void x(void) {
            for (int i = 0;;)
                i;
        }
        `;
        ps4 = self.parse(s4);
        self.assert_num_ID_refs(ps4, "i", 1);

    });
    // Upstream reads these from tests/c_files (copied under fixtures/ from
    // pycparser b5c6024) with open() in text mode, i.e. universal newlines.
    const cFile = (name) => new URL("./fixtures/c_files/" + name, import.meta.url);
    const noFile = (name) => (existsSync(cFile(name)) ? false : `upstream fixture c_files/${name} is not shipped with the vendored fork`);

    test("whole_file", { skip: noFile("memmgr_with_h.c") }, () => {
        // See how pycparser handles a whole, real C file.
        const code = readFileSync(cFile("memmgr_with_h.c"), "utf8").replace(/\r\n?/g, "\n");
        const p = self.parse(code);

        self.assert_num_klass_nodes(p, FuncDef, 5);

        // each FuncDef also has a FuncDecl. 4 declarations
        // + 5 definitions, overall 9
        self.assert_num_klass_nodes(p, FuncDecl, 9);

        self.assert_num_klass_nodes(p, Typedef, 4);

        self.assertEqual(p.ext[4].coord.line, 88);
        self.assertEqual(p.ext[4].coord.file, "./memmgr.h");

        self.assertEqual(p.ext[6].coord.line, 10);
        self.assertEqual(p.ext[6].coord.file, "memmgr.c");
    });

    test("whole_file_with_stdio", { skip: noFile("cppd_with_stdio_h.c") }, () => {
        // Parse a whole file with stdio.h included by cpp
        const code = readFileSync(cFile("cppd_with_stdio_h.c"), "utf8").replace(/\r\n?/g, "\n");
        const p = self.parse(code);

        self.assertIsInstance(p.ext[0], Typedef);
        self.assertEqual(p.ext[0].coord.line, 213);
        self.assertEqual(p.ext[0].coord.file, String.raw`D:\eli\cpp_stuff\libc_include/stddef.h`);

        self.assertIsInstance(p.ext.at(-1), FuncDef);
        self.assertEqual(p.ext.at(-1).coord.line, 15);
        self.assertEqual(p.ext.at(-1).coord.file, "example_c_file.c");

        self.assertIsInstance(p.ext.at(-8), Typedef);
        self.assertIsInstance(p.ext.at(-8).type, TypeDecl);
        self.assertEqual(p.ext.at(-8).name, "cookie_io_functions_t");
    });
});
describe("TestCParser_typenames", () => { const self = new TestCParser_base();
    ` Test issues related to the typedef-name problem.
    `
    test("innerscope_typedef", () => { let s1, s2;
        // should fail since TT is not a type in bar
        s1 = String.raw`
            void foo() {
              typedef char TT;
              TT x;
            }
            void bar() {
              TT y;
            }
            `;
        self.assertRaises(ParseError, self.parse, s1);

        // should succeed since TT is not a type in bar
        s2 = String.raw`
            void foo() {
              typedef char TT;
              TT x;
            }
            void bar() {
                unsigned TT;
            }
            `;
        self.assertIsInstance(self.parse(s2), FileAST);

    });
    test("ambiguous_parameters", () => { let s1, s1_ast, s2, s2_ast, s3, s3_ast;
        // From ISO/IEC 9899:TC2, 6.7.5.3.11:
        // "If, in a parameter declaration, an identifier can be treated either
        //  as a typedef name or as a parameter name, it shall be taken as a
        //  typedef name."

        // foo takes an int named aa
        // bar takes a function taking a TT
        s1 = String.raw`
        typedef char TT;
        int foo(int (aa));
        int bar(int (TT));
        `;
        s1_ast = self.parse(s1);
        self.assertEqual(expand_decl(s1_ast.ext[1].type.args.params[0]),
            ["Decl", "aa", ["TypeDecl", ["IdentifierType", ["int"]]]]);
        self.assertEqual(expand_decl(s1_ast.ext[2].type.args.params[0]),
            ["Typename", ["FuncDecl",
                [["Typename", ["TypeDecl", ["IdentifierType", ["TT"]]]]],
                ["TypeDecl", ["IdentifierType", ["int"]]]]]);

        // foo takes a function taking a char
        // bar takes a function taking a function taking a char
        s2 = String.raw`
        typedef char TT;
        int foo(int (aa (char)));
        int bar(int (TT (char)));
        `;
        s2_ast = self.parse(s2);
        self.assertEqual(expand_decl(s2_ast.ext[1].type.args.params[0]),
            ["Decl", "aa", ["FuncDecl",
                [["Typename", ["TypeDecl", ["IdentifierType", ["char"]]]]],
                ["TypeDecl", ["IdentifierType", ["int"]]]]]);
        self.assertEqual(expand_decl(s2_ast.ext[2].type.args.params[0]),
            ["Typename", ["FuncDecl",
                [["Typename", ["FuncDecl",
                    [["Typename", ["TypeDecl", ["IdentifierType", ["char"]]]]],
                    ["TypeDecl", ["IdentifierType", ["TT"]]]]]],
                ["TypeDecl", ["IdentifierType", ["int"]]]]]);


        // foo takes an int array named aa
        // bar takes a function taking a TT array
        s3 = String.raw`
        typedef char TT;
        int foo(int (aa[]));
        int bar(int (TT[]));
        `;
        s3_ast = self.parse(s3);
        self.assertEqual(expand_decl(s3_ast.ext[1].type.args.params[0]),
            ["Decl", "aa", ["ArrayDecl", "", [], ["TypeDecl", ["IdentifierType", ["int"]]]]]);
        self.assertEqual(expand_decl(s3_ast.ext[2].type.args.params[0]),
            ["Typename", ["FuncDecl",
                [["Typename", ["ArrayDecl", "", [], ["TypeDecl", ["IdentifierType", ["TT"]]]]]],
                ["TypeDecl", ["IdentifierType", ["int"]]]]]);

    });
    test("innerscope_reuse_typedef_name", () => { let s1, s1_ast, s2, s2_ast, s3, s3_ast, s4, s4_ast, s5, s6, s6_ast, items, s7, s7_ast, s8, s8_ast;
        // identifiers can be reused in inner scopes; the original should be
        // restored at the end of the block
        s1 = String.raw`
            typedef char TT;
            void foo(void) {
              unsigned TT;
              TT = 10;
            }
            TT x = 5;
            `;
        s1_ast = self.parse(s1);
        self.assertEqual(expand_decl(s1_ast.ext[1].body.block_items[0]),
            ["Decl", "TT", ["TypeDecl", ["IdentifierType", ["unsigned"]]]]);
        self.assertEqual(expand_decl(s1_ast.ext[2]),
            ["Decl", "x", ["TypeDecl", ["IdentifierType", ["TT"]]]]);

        // this should be recognized even with an initializer
        s2 = String.raw`
            typedef char TT;
            void foo(void) {
              unsigned TT = 10;
            }
            `;
        s2_ast = self.parse(s2);
        self.assertEqual(expand_decl(s2_ast.ext[1].body.block_items[0]),
            ["Decl", "TT", ["TypeDecl", ["IdentifierType", ["unsigned"]]]]);

        // before the second local variable, TT is a type; after, it's a
        // variable
        s3 = String.raw`
            typedef char TT;
            void foo(void) {
              TT tt = sizeof(TT);
              unsigned TT = 10;
            }
            `;
        s3_ast = self.parse(s3);
        self.assertEqual(expand_decl(s3_ast.ext[1].body.block_items[0]),
            ["Decl", "tt", ["TypeDecl", ["IdentifierType", ["TT"]]]]);
        self.assertEqual(expand_decl(s3_ast.ext[1].body.block_items[1]),
            ["Decl", "TT", ["TypeDecl", ["IdentifierType", ["unsigned"]]]]);

        // a variable and its type can even share the same name
        s4 = String.raw`
            typedef char TT;
            void foo(void) {
              TT TT = sizeof(TT);
              unsigned uu = TT * 2;
            }
            `;
        s4_ast = self.parse(s4);
        self.assertEqual(expand_decl(s4_ast.ext[1].body.block_items[0]),
            ["Decl", "TT", ["TypeDecl", ["IdentifierType", ["TT"]]]]);
        self.assertEqual(expand_decl(s4_ast.ext[1].body.block_items[1]),
            ["Decl", "uu", ["TypeDecl", ["IdentifierType", ["unsigned"]]]]);

        // ensure an error is raised if a type, redeclared as a variable, is
        // used as a type
        s5 = String.raw`
            typedef char TT;
            void foo(void) {
              unsigned TT = 10;
              TT erroneous = 20;
            }
            `;
        self.assertRaises(ParseError, self.parse, s5);

        // reusing a type name should work with multiple declarators
        s6 = String.raw`
            typedef char TT;
            void foo(void) {
              unsigned TT, uu;
            }
            `;
        s6_ast = self.parse(s6);
        items = s6_ast.ext[1].body.block_items;
        self.assertEqual(expand_decl(items[0]),
            ["Decl", "TT", ["TypeDecl", ["IdentifierType", ["unsigned"]]]]);
        self.assertEqual(expand_decl(items[1]),
            ["Decl", "uu", ["TypeDecl", ["IdentifierType", ["unsigned"]]]]);

        // reusing a type name should work after a pointer
        s7 = String.raw`
            typedef char TT;
            void foo(void) {
              unsigned * TT;
            }
            `;
        s7_ast = self.parse(s7);
        items = s7_ast.ext[1].body.block_items;
        self.assertEqual(expand_decl(items[0]),
            ["Decl", "TT", ["PtrDecl", ["TypeDecl", ["IdentifierType", ["unsigned"]]]]]);

        // redefine a name in the middle of a multi-declarator declaration
        s8 = String.raw`
            typedef char TT;
            void foo(void) {
                int tt = sizeof(TT), TT, uu = sizeof(TT);
                int uu = sizeof(tt);
            }
            `;
        s8_ast = self.parse(s8);
        items = s8_ast.ext[1].body.block_items;
        self.assertEqual(expand_decl(items[0]),
            ["Decl", "tt", ["TypeDecl", ["IdentifierType", ["int"]]]]);
        self.assertEqual(expand_decl(items[1]),
            ["Decl", "TT", ["TypeDecl", ["IdentifierType", ["int"]]]]);
        self.assertEqual(expand_decl(items[2]),
            ["Decl", "uu", ["TypeDecl", ["IdentifierType", ["int"]]]]);

        // Don't test this until we have support for it
        // self.assertEqual(expand_init(items[0].init),
        //     ['UnaryOp', 'sizeof', ['Typename', ['TypeDecl', ['IdentifierType', ['TT']]]]])
        // self.assertEqual(expand_init(items[2].init),
        //     ['UnaryOp', 'sizeof', ['ID', 'TT']])

    });
    test("parameter_reuse_typedef_name", () => { let s1, s1_ast, s2, s2_ast, s3;
        // identifiers can be reused as parameter names; parameter name scope
        // begins and ends with the function body; it's important that TT is
        // used immediately before the LBRACE or after the RBRACE, to test
        // a corner case
        s1 = String.raw`
            typedef char TT;
            void foo(unsigned TT, TT bar) {
              TT = 10;
            }
            TT x = 5;
            `;
        s1_ast = self.parse(s1);
        self.assertEqual(expand_decl(s1_ast.ext[1].decl),
            ["Decl", "foo",
                ["FuncDecl",
                    [   ["Decl", "TT", ["TypeDecl", ["IdentifierType", ["unsigned"]]]],
                        ["Decl", "bar", ["TypeDecl", ["IdentifierType", ["TT"]]]]],
                    ["TypeDecl", ["IdentifierType", ["void"]]]]]);

        // the scope of a parameter name in a function declaration ends at the
        // end of the declaration...so it is effectively never used; it's
        // important that TT is used immediately after the declaration, to
        // test a corner case
        s2 = String.raw`
            typedef char TT;
            void foo(unsigned TT, TT bar);
            TT x = 5;
            `;
        s2_ast = self.parse(s2);
        self.assertEqual(expand_decl(s2_ast.ext[1]),
            ["Decl", "foo",
                ["FuncDecl",
                    [   ["Decl", "TT", ["TypeDecl", ["IdentifierType", ["unsigned"]]]],
                        ["Decl", "bar", ["TypeDecl", ["IdentifierType", ["TT"]]]]],
                    ["TypeDecl", ["IdentifierType", ["void"]]]]]);

        // ensure an error is raised if a type, redeclared as a parameter, is
        // used as a type
        s3 = String.raw`
            typedef char TT;
            void foo(unsigned TT, TT bar) {
              TT erroneous = 20;
            }
            `;
        self.assertRaises(ParseError, self.parse, s3);

    });
    test("nested_function_decls", () => { let s1;
        // parameter names of nested function declarations must not escape into
        // the top-level function _definition's_ scope; the following must
        // succeed because TT is still a typedef inside foo's body
        s1 = String.raw`
            typedef char TT;
            void foo(unsigned bar(int TT)) {
              TT x = 10;
            }
            `;
        self.assertIsInstance(self.parse(s1), FileAST);

    });
    test("samescope_reuse_name", () => { let s1, s2;
        // a typedef name cannot be reused as an object name in the same scope
        s1 = String.raw`
            typedef char TT;
            char TT = 5;
            `;
        self.assertRaises(ParseError, self.parse, s1);

        // ...and vice-versa
        s2 = String.raw`
            char TT = 5;
            typedef char TT;
            `;
        self.assertRaises(ParseError, self.parse, s2);

    });
    test("label_empty_statement", () => { let s1, s1_ast;
        // Labels with empty statements and no semicolon should be parsed correctly
        s1 = String.raw`
            int main() {
                int i = 0;
                label0: i++;
                label1:
            }
            `;
        s1_ast = self.parse(s1);
        self.assertIsInstance(s1_ast.ext[0].body.block_items[1], Label);
        self.assertIsInstance(s1_ast.ext[0].body.block_items[1].stmt, UnaryOp);
        self.assertIsInstance(s1_ast.ext[0].body.block_items[2], Label);
        self.assertIsInstance(s1_ast.ext[0].body.block_items[2].stmt, EmptyStatement);

    });
    test("case_empty_statement", () => { let s1, s2, s1_ast, s2_ast;
        // Labels with empty statements and no semicolon should be parsed correctly
        s1 = String.raw`
            int main() {
                int i = 0;
                switch (i) {
                    case 0:
                        i = 1;
                    case 1:
                }
                return i;
            }
            `;
        s2 = String.raw`
            int main() {
                int i = 0;
                switch (i) {
                    case 0:
                        i = 1;
                    default:
                }
                return i;
            }
            `;
        s1_ast = self.parse(s1);
        s2_ast = self.parse(s2);
        self.assertIsInstance(s1_ast.ext[0].body.block_items[1], Switch);
        self.assertIsInstance(s1_ast.ext[0].body.block_items[1].stmt, Compound);
        self.assertIsInstance(s1_ast.ext[0].body.block_items[1].stmt.block_items[0], Case);
        self.assertIsInstance(s1_ast.ext[0].body.block_items[1].stmt.block_items[0].stmts[0], Assignment);
        self.assertIsInstance(s1_ast.ext[0].body.block_items[1].stmt.block_items[1], Case);
        self.assertIsInstance(s1_ast.ext[0].body.block_items[1].stmt.block_items[1].stmts[0], EmptyStatement);
        self.assertIsInstance(s2_ast.ext[0].body.block_items[1].stmt.block_items[1].stmts[0], EmptyStatement);

    });
});
