// Port of m2c_pycparser/tests/test_c_parser.py (converted, then reviewed).
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { CParser, ParseError } from "../../src/pycparser/c_parser.js";
import * as c_ast from "../../src/pycparser/c_ast.js";

const {
  ArrayDecl, ArrayRef, Alignas, Assignment, BinaryOp, Case, Compound, Constant, Decl, Default, DoWhile,
  EmptyStatement, Enum, Enumerator, EnumeratorList, ExprList, FileAST, For, FuncCall, FuncDecl, FuncDef, ID,
  IdentifierType, If, InitList, Label, NamedInitializer, NodeVisitor, Pragma, PtrDecl, Return, StaticAssert,
  Struct, StructRef, Switch, TypeDecl, Typedef, Typename, UnaryOp, Union, While,
} = c_ast;

const M2C_DIR = process.env.M2C_SRC || path.join(os.homedir(), ".romdev", "tools", "m2c");
const C_FILES = path.join(M2C_DIR, "m2c_pycparser", "tests", "c_files");

const _c_parser = new CParser();
const len = (x) => x.length;
const type = (x) => x.constructor;
const assertEqual = (a, b) => assert.deepStrictEqual(a, b);
const assertIsInstance = (x, cls) => assert.ok(x instanceof cls, `${x?.constructor?.name} is not ${cls.name}`);
const assertRaises = (E, fn, ...args) => assert.throws(() => fn(...args), E);

function expand_decl(decl) {
  const typ = type(decl);
  if (typ === TypeDecl) return ["TypeDecl", expand_decl(decl.type)];
  if (typ === IdentifierType) return ["IdentifierType", decl.names];
  if (typ === ID) return ["ID", decl.name];
  if (typ === Struct || typ === Union) {
    const decls = (decl.decls || []).map((d) => expand_decl(d));
    return [typ.name, decl.name, decls];
  }
  if (typ === Enum) {
    let values;
    if (decl.values === null) values = null;
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

function expand_init(init) {
  const typ = type(init);
  if (typ === NamedInitializer) {
    const des = init.name.map((dp) => expand_init(dp));
    return [des, expand_init(init.expr)];
  }
  if (typ === InitList || typ === ExprList) return init.exprs.map((e) => expand_init(e));
  if (typ === Constant) return ["Constant", init.type, init.value];
  if (typ === ID) return ["ID", init.name];
  if (typ === Decl) return ["Decl", init.name];
  if (typ === UnaryOp) return ["UnaryOp", init.op, expand_decl(init.expr)];
  if (typ === BinaryOp) return ["BinaryOp", expand_init(init.left), init.op, expand_init(init.right)];
  if (typ === Compound) {
    let blocks = [];
    if (init.block_items && init.block_items.length) blocks = init.block_items.map((i) => expand_init(i));
    return ["Compound", blocks];
  }
  if (typ === Typename) return expand_decl(init);
  return [typ.name];
}

function parse(txt, filename = "") {
  return _c_parser.parse(txt, filename);
}
function assert_coord(node, line, column = null, file = null) {
  assertEqual(node.coord.line, line);
  if (column !== null) assertEqual(node.coord.column, column);
  if (file) assertEqual(node.coord.file, file);
}
function get_decl(txt, index = 0) {
  return expand_decl(parse(txt).ext[index]);
}
function get_decl_init(txt, index = 0) {
  return expand_init(parse(txt).ext[index].init);
}

class ConstantVisitor extends NodeVisitor {
  constructor() {
    super();
    this.values = [];
  }
  visit_Constant(node) {
    this.values.push(node.value);
  }
}
class IDNameCounter extends NodeVisitor {
  constructor(name) {
    super();
    this.name = name;
    this.nrefs = 0;
  }
  visit_ID(node) {
    if (node.name === this.name) this.nrefs += 1;
  }
}
class NodeKlassCounter extends NodeVisitor {
  constructor(node_klass) {
    super();
    this.klass = node_klass;
    this.n = 0;
  }
  generic_visit(node) {
    if (node.constructor === this.klass) this.n += 1;
    super.generic_visit(node);
  }
}
function assert_all_Constants(code, constants) {
  const parsed = typeof code === "string" ? parse(code) : code;
  const cv = new ConstantVisitor();
  cv.visit(parsed);
  assertEqual(cv.values, constants);
}
function assert_num_ID_refs(code, name, num) {
  const parsed = typeof code === "string" ? parse(code) : code;
  const iv = new IDNameCounter(name);
  iv.visit(parsed);
  assertEqual(iv.nrefs, num);
}
function assert_num_klass_nodes(code, klass, num) {
  const parsed = typeof code === "string" ? parse(code) : code;
  const cv = new NodeKlassCounter(klass);
  cv.visit(parsed);
  assertEqual(cv.n, num);
}
const at = (arr, i) => arr[i < 0 ? arr.length + i : i];

describe("TestCParser_fundamentals", () => {
    test("test_FileAST", () => {
        let t = parse('int a; char c;');
        assertIsInstance(t, FileAST);
        assertEqual(len(t.ext), 2);


        let t2 = parse('');
        assertIsInstance(t2, FileAST);
        assertEqual(len(t2.ext), 0);

    });
    test("test_empty_toplevel_decl", () => {
        let code = 'int foo;;';
        let t = parse(code);
        assertIsInstance(t, FileAST);
        assertEqual(len(t.ext), 1);
        assertEqual(get_decl(code),
            ['Decl', 'foo',
                ['TypeDecl', ['IdentifierType', ['int']]]]);

    });
    test("test_initial_semi", () => {
        let t = parse(';');
        assertEqual(len(t.ext), 0);
        t = parse(';int foo;');
        assertEqual(len(t.ext), 1);
        assertEqual(expand_decl(t.ext[0]),
            ['Decl', 'foo',
                ['TypeDecl', ['IdentifierType', ['int']]]]);

    });
    test("test_coords", () => {
        assert_coord(parse('int a;').ext[0], 1, 5);

        let t1 = `
        int a;
        int b;\n\n
        int c;
        `;
        let f1 = parse(t1, 'test.c');
        assert_coord(f1.ext[0], 2, 13, 'test.c');
        assert_coord(f1.ext[1], 3, 13, 'test.c');
        assert_coord(f1.ext[2], 6, 13, 'test.c');

        let t1_1 = `
        int main() {
            k = p;
            printf("%d", b);
            return 0;
        }`;
        let f1_1 = parse(t1_1, 'test.c');
        assert_coord(f1_1.ext[0].body.block_items[0], 3, 13, 'test.c');
        assert_coord(f1_1.ext[0].body.block_items[1], 4, 13, 'test.c');

        let t1_2 = `
        int main () {
            int p = (int) k;
        }`;
        let f1_2 = parse(t1_2, 'test.c');

        assert_coord(f1_2.ext[0].body.block_items[0].init, 3, 21, 'test.c');

        let t2 = `
        #line 99
        int c;
        `;
        assert_coord(parse(t2).ext[0], 99, 13);

        let t3 = `
        int dsf;
        char p;
        #line 3000 "in.h"
        char d;
        `;
        let f3 = parse(t3, 'test.c');
        assert_coord(f3.ext[0], 2, 13, 'test.c');
        assert_coord(f3.ext[1], 3, 14, 'test.c');
        assert_coord(f3.ext[2], 3000, 14, 'in.h');

        let t4 = `
        #line 20 "restore.h"
        int maydler(char);

        #line 30 "includes/daween.ph"
        long j, k;

        #line 50000
        char* ro;
        `;
        let f4 = parse(t4, 'myb.c');
        assert_coord(f4.ext[0], 20, 13, 'restore.h');
        assert_coord(f4.ext[1], 30, 14, 'includes/daween.ph');
        assert_coord(f4.ext[2], 30, 17, 'includes/daween.ph');
        assert_coord(f4.ext[3], 50000, 13, 'includes/daween.ph');

        let t5 = `
        int
        #line 99
        c;
        `;
        assert_coord(parse(t5).ext[0], 99, 9);


        let t6 = `
        int foo(int j,
                ...) {
        }`;
        parse(t6, 'z.c');
        assert_coord(parse(t6).ext[0].decl.type.args.params[1], 3, 17);

    });
    test("test_forloop_coord", () => {
        let t = `\
        void foo() {
            for(int z=0; z<4;
                z++){}
        }
        `;
        let s = parse(t, 'f.c');
        let forloop = s.ext[0].body.block_items[0];
        assert_coord(forloop.init, 2, 13, 'f.c');
        assert_coord(forloop.cond, 2, 26, 'f.c');
        assert_coord(forloop.next, 3, 17, 'f.c');

    });
    test("test_simple_decls", () => {
        assertEqual(get_decl('int a;'),
            ['Decl', 'a', ['TypeDecl', ['IdentifierType', ['int']]]]);

        assertEqual(get_decl('unsigned int a;'),
            ['Decl', 'a', ['TypeDecl', ['IdentifierType', ['unsigned', 'int']]]]);

        assertEqual(get_decl('_Bool a;'),
            ['Decl', 'a', ['TypeDecl', ['IdentifierType', ['_Bool']]]]);

        assertEqual(get_decl('float _Complex fcc;'),
            ['Decl', 'fcc', ['TypeDecl', ['IdentifierType', ['float', '_Complex']]]]);

        assertEqual(get_decl('char* string;'),
            ['Decl', 'string',
                ['PtrDecl', ['TypeDecl', ['IdentifierType', ['char']]]]]);

        assertEqual(get_decl('long ar[15];'),
            ['Decl', 'ar',
                ['ArrayDecl', '15', [],
                    ['TypeDecl', ['IdentifierType', ['long']]]]]);

        assertEqual(get_decl('long long ar[15];'),
            ['Decl', 'ar',
                ['ArrayDecl', '15', [],
                    ['TypeDecl', ['IdentifierType', ['long', 'long']]]]]);

        assertEqual(get_decl('unsigned ar[];'),
            ['Decl', 'ar',
                ['ArrayDecl', '', [],
                    ['TypeDecl', ['IdentifierType', ['unsigned']]]]]);

        assertEqual(get_decl('int strlen(char* s);'),
            ['Decl', 'strlen',
                ['FuncDecl',
                    [['Decl', 's',
                        ['PtrDecl',
                            ['TypeDecl', ['IdentifierType', ['char']]]]]],
                    ['TypeDecl', ['IdentifierType', ['int']]]]]);

        assertEqual(get_decl('int strcmp(char* s1, char* s2);'),
            ['Decl', 'strcmp',
                ['FuncDecl',
                    [   ['Decl', 's1',
                            ['PtrDecl', ['TypeDecl', ['IdentifierType', ['char']]]]],
                        ['Decl', 's2',
                            ['PtrDecl', ['TypeDecl', ['IdentifierType', ['char']]]]]
                    ],
                ['TypeDecl', ['IdentifierType', ['int']]]]]);


        assertEqual(get_decl('extern foobar(foo, bar);'),
            ['Decl', 'foobar',
                ['FuncDecl',
                    [   ['ID', 'foo'],
                        ['ID', 'bar']
                    ],
                ['TypeDecl', ['IdentifierType', ['int']]]]]);

    });
    test("test_int128", () => {
        assertEqual(get_decl('__int128 a;'),
            ['Decl', 'a', ['TypeDecl', ['IdentifierType', ['__int128']]]]);


    });
    test("test_nested_decls", () => {
        assertEqual(get_decl('char** ar2D;'),
            ['Decl', 'ar2D',
                ['PtrDecl', ['PtrDecl',
                    ['TypeDecl', ['IdentifierType', ['char']]]]]]);

        assertEqual(get_decl('int (*a)[1][2];'),
            ['Decl', 'a',
                ['PtrDecl',
                    ['ArrayDecl', '1', [],
                        ['ArrayDecl', '2', [],
                        ['TypeDecl', ['IdentifierType', ['int']]]]]]]);

        assertEqual(get_decl('int *a[1][2];'),
            ['Decl', 'a',
                ['ArrayDecl', '1', [],
                    ['ArrayDecl', '2', [],
                        ['PtrDecl', ['TypeDecl', ['IdentifierType', ['int']]]]]]]);

        assertEqual(get_decl('char* const* p;'),
            ['Decl', 'p',
                ['PtrDecl', ['PtrDecl', ['const'],
                    ['TypeDecl', ['IdentifierType', ['char']]]]]]);

        assertEqual(get_decl('const char* const* p;'),
            ['Decl', ['const'], 'p',
                ['PtrDecl', ['PtrDecl', ['const'],
                    ['TypeDecl', ['IdentifierType', ['char']]]]]]);

        assertEqual(get_decl('char* * const p;'),
            ['Decl', 'p',
                ['PtrDecl', ['const'], ['PtrDecl',
                    ['TypeDecl', ['IdentifierType', ['char']]]]]]);

        assertEqual(get_decl('char ***ar3D[40];'),
            ['Decl', 'ar3D',
                ['ArrayDecl', '40', [],
                    ['PtrDecl', ['PtrDecl', ['PtrDecl',
                        ['TypeDecl', ['IdentifierType', ['char']]]]]]]]);

        assertEqual(get_decl('char (***ar3D)[40];'),
            ['Decl', 'ar3D',
                ['PtrDecl', ['PtrDecl', ['PtrDecl',
                    ['ArrayDecl', '40', [], ['TypeDecl', ['IdentifierType', ['char']]]]]]]]);

        assertEqual(get_decl('int (*const*const x)(char, int);'),
         ['Decl',
          'x',
          ['PtrDecl',
           ['const'],
           ['PtrDecl',
            ['const'],
            ['FuncDecl',
             [['Typename', ['TypeDecl', ['IdentifierType', ['char']]]],
              ['Typename', ['TypeDecl', ['IdentifierType', ['int']]]]],
             ['TypeDecl', ['IdentifierType', ['int']]]]]]]);

        assertEqual(get_decl('int (*x[4])(char, int);'),
            ['Decl', 'x',
                ['ArrayDecl', '4', [],
                    ['PtrDecl',
                        ['FuncDecl',
                            [   ['Typename',  ['TypeDecl', ['IdentifierType', ['char']]]],
                                ['Typename', ['TypeDecl', ['IdentifierType', ['int']]]]],
                            ['TypeDecl', ['IdentifierType', ['int']]]]]]]);

        assertEqual(get_decl('char *(*(**foo [][8])())[];'),
            ['Decl', 'foo',
                ['ArrayDecl', '', [],
                    ['ArrayDecl', '8', [],
                        ['PtrDecl', ['PtrDecl',
                            ['FuncDecl',
                                [],
                                ['PtrDecl',
                                    ['ArrayDecl', '', [],
                                        ['PtrDecl',
                                            ['TypeDecl',
                                                ['IdentifierType', ['char']]]]]]]]]]]]);





        assertEqual(get_decl('int (*k)(int);'),
            ['Decl', 'k',
                ['PtrDecl',
                    ['FuncDecl',
                        [['Typename', ['TypeDecl', ['IdentifierType', ['int']]]]],
                        ['TypeDecl', ['IdentifierType', ['int']]]]]]);


        assertEqual(get_decl('int (*k)(const int);'),
            ['Decl', 'k',
                ['PtrDecl',
                    ['FuncDecl',
                        [['Typename', ['const'], ['TypeDecl', ['IdentifierType', ['int']]]]],
                        ['TypeDecl', ['IdentifierType', ['int']]]]]]);


        assertEqual(get_decl('int (*k)(int q);'),
            ['Decl', 'k',
                ['PtrDecl',
                    ['FuncDecl',
                        [['Decl', 'q', ['TypeDecl', ['IdentifierType', ['int']]]]],
                        ['TypeDecl', ['IdentifierType', ['int']]]]]]);


        assertEqual(get_decl('int (*k)(const volatile int q);'),
            ['Decl', 'k',
                ['PtrDecl',
                    ['FuncDecl',
                        [['Decl', ['const', 'volatile'], 'q',
                            ['TypeDecl', ['IdentifierType', ['int']]]]],
                        ['TypeDecl', ['IdentifierType', ['int']]]]]]);

        assertEqual(get_decl('int (*k)(_Atomic volatile int q);'),
            ['Decl', 'k',
                ['PtrDecl',
                    ['FuncDecl',
                        [['Decl', ['_Atomic', 'volatile'], 'q',
                            ['TypeDecl', ['IdentifierType', ['int']]]]],
                        ['TypeDecl', ['IdentifierType', ['int']]]]]]);

        assertEqual(get_decl('int (*k)(const volatile int* q);'),
            ['Decl', 'k',
                ['PtrDecl',
                    ['FuncDecl',
                        [['Decl', ['const', 'volatile'], 'q',
                            ['PtrDecl', ['TypeDecl', ['IdentifierType', ['int']]]]]],
                        ['TypeDecl', ['IdentifierType', ['int']]]]]]);


        assertEqual(get_decl('int (*k)(restrict int* q);'),
            ['Decl', 'k',
                ['PtrDecl',
                    ['FuncDecl',
                        [['Decl', ['restrict'], 'q',
                            ['PtrDecl',
                                ['TypeDecl', ['IdentifierType', ['int']]]]]],
                        ['TypeDecl', ['IdentifierType', ['int']]]]]]);

    });
    test("test_func_decls_with_array_dim_qualifiers", () => {

        assertEqual(get_decl('int zz(int p[static 10]);'),
            ['Decl', 'zz',
                ['FuncDecl',
                    [['Decl', 'p', ['ArrayDecl', '10', ['static'],
                                       ['TypeDecl', ['IdentifierType', ['int']]]]]],
                    ['TypeDecl', ['IdentifierType', ['int']]]]]);

        assertEqual(get_decl('int zz(int [static 10]);'),
            ['Decl', 'zz',
                ['FuncDecl',
                    [['Typename',
                      ['ArrayDecl', '10', ['static'],
                       ['TypeDecl', ['IdentifierType', ['int']]]]]],
                    ['TypeDecl', ['IdentifierType', ['int']]]]]);
        assertEqual(get_decl('int zz(int [static const restrict 10]);'),
            ['Decl', 'zz',
                ['FuncDecl',
                    [['Typename',
                      ['ArrayDecl', '10', ['static', 'const', 'restrict'],
                       ['TypeDecl', ['IdentifierType', ['int']]]]]],
                    ['TypeDecl', ['IdentifierType', ['int']]]]]);

        assertEqual(get_decl('int zz(int p[const 10]);'),
            ['Decl', 'zz',
                ['FuncDecl',
                    [['Decl', 'p', ['ArrayDecl', '10', ['const'],
                                       ['TypeDecl', ['IdentifierType', ['int']]]]]],
                    ['TypeDecl', ['IdentifierType', ['int']]]]]);

        assertEqual(get_decl('int zz(int p[restrict][5]);'),
            ['Decl', 'zz',
                ['FuncDecl',
                    [['Decl', 'p', ['ArrayDecl', '', ['restrict'],
                        ['ArrayDecl', '5', [],
                            ['TypeDecl', ['IdentifierType', ['int']]]]]]],
                    ['TypeDecl', ['IdentifierType', ['int']]]]]);

        assertEqual(get_decl('int zz(int p[const restrict static 10][5]);'),
            ['Decl', 'zz',
                ['FuncDecl',
                    [['Decl', 'p', ['ArrayDecl', '10', ['const', 'restrict', 'static'],
                        ['ArrayDecl', '5', [],
                            ['TypeDecl', ['IdentifierType', ['int']]]]]]],
                    ['TypeDecl', ['IdentifierType', ['int']]]]]);


        assertEqual(get_decl('int zz(int [const 10]);'),
            ['Decl', 'zz',
                ['FuncDecl',
                    [['Typename', ['ArrayDecl', '10', ['const'],
                                       ['TypeDecl', ['IdentifierType', ['int']]]]]],
                    ['TypeDecl', ['IdentifierType', ['int']]]]]);

        assertEqual(get_decl('int zz(int [restrict][5]);'),
            ['Decl', 'zz',
                ['FuncDecl',
                    [['Typename', ['ArrayDecl', '', ['restrict'],
                        ['ArrayDecl', '5', [],
                            ['TypeDecl', ['IdentifierType', ['int']]]]]]],
                    ['TypeDecl', ['IdentifierType', ['int']]]]]);

        assertEqual(get_decl('int zz(int [const restrict volatile 10][5]);'),
            ['Decl', 'zz',
                ['FuncDecl',
                    [['Typename', ['ArrayDecl', '10', ['const', 'restrict', 'volatile'],
                        ['ArrayDecl', '5', [],
                            ['TypeDecl', ['IdentifierType', ['int']]]]]]],
                    ['TypeDecl', ['IdentifierType', ['int']]]]]);

    });
    test("test_qualifiers_storage_specifiers", () => {
        function assert_qs(txt, index, quals, storage) {
            let d = parse(txt).ext[index];
            assertEqual(d.quals, quals);
            assertEqual(d.storage, storage);

        }
        assert_qs("extern int p;", 0, [], ['extern']);
        assert_qs("_Thread_local int p;", 0, [], ['_Thread_local']);
        assert_qs("const long p = 6;", 0, ['const'], []);
        assert_qs("_Atomic int p;", 0, ['_Atomic'], []);
        assert_qs("_Atomic restrict int* p;", 0, ['_Atomic', 'restrict'], []);

        let d1 = "static const int p, q, r;";
        for (let i = 0; i < 3; i++) {
            assert_qs(d1, i, ['const'], ['static']);

        }
        let d2 = "static char * const p;";
        assert_qs(d2, 0, [], ['static']);
        let pdecl = parse(d2).ext[0].type;
        assertIsInstance(pdecl, PtrDecl);
        assertEqual(pdecl.quals, ['const']);

    });
    test("test_atomic_specifier", () => {
        assertEqual(get_decl('_Atomic(int) ai;'),
             ['Decl', ['_Atomic'],
              'ai',
              ['TypeDecl', ['IdentifierType', ['int']]]]);

        assertEqual(get_decl('_Atomic(int*) ai;'),
             ['Decl',
              'ai',
              ['PtrDecl', ['_Atomic'], ['TypeDecl', ['IdentifierType', ['int']]]]]);

        assertEqual(get_decl('_Atomic(_Atomic(int)*) aai;'),
             ['Decl', ['_Atomic'],
              'aai',
              ['PtrDecl', ['_Atomic'], ['TypeDecl', ['IdentifierType', ['int']]]]]);


        let s = '_Atomic(int) foo, bar;';
        assertEqual(get_decl(s, 0),
             ['Decl', ['_Atomic'],
              'foo',
              ['TypeDecl', ['IdentifierType', ['int']]]]);
        assertEqual(get_decl(s, 1),
             ['Decl', ['_Atomic'],
              'bar',
              ['TypeDecl', ['IdentifierType', ['int']]]]);


        s = 'typedef _Atomic(int) atomic_int;';
        assertEqual(get_decl(s, 0),
            ['Typedef', 'atomic_int', ['TypeDecl', ['IdentifierType', ['int']]]]);

        s = 'typedef _Atomic(_Atomic(_Atomic(int (*)(void)) *) *) t;';
        assertEqual(get_decl(s, 0),
            ['Typedef', 't',
             ['PtrDecl', ['_Atomic'],
              ['PtrDecl', ['_Atomic'],
               ['PtrDecl', ['_Atomic'],
                ['FuncDecl', [['Typename', ['TypeDecl', ['IdentifierType', ['void']]]]],
                 ['TypeDecl', ['IdentifierType', ['int']]]]]]]]);

    });
    test("test_sizeof", () => {
        let e = `
            void foo()
            {
                int a = sizeof k;
                int b = sizeof(int);
                int c = sizeof(int**);;

                char* p = "just to make sure this parses w/o error...";
                int d = sizeof(int());
            }
        `;
        let compound = parse(e).ext[0].body;

        let s1 = compound.block_items[0].init;
        assertIsInstance(s1, UnaryOp);
        assertEqual(s1.op, 'sizeof');
        assertIsInstance(s1.expr, ID);
        assertEqual(s1.expr.name, 'k');

        let s2 = compound.block_items[1].init;
        assertEqual(expand_decl(s2.expr),
            ['Typename', ['TypeDecl', ['IdentifierType', ['int']]]]);

        let s3 = compound.block_items[2].init;
        assertEqual(expand_decl(s3.expr),
            ['Typename',
                ['PtrDecl',
                    ['PtrDecl',
                        ['TypeDecl',
                            ['IdentifierType', ['int']]]]]]);

    });
    test("test_alignof", () => {
        let r = parse('int a = _Alignof(int);');
        assertEqual(expand_decl(r.ext[0]), ['Decl', 'a', ['TypeDecl', ['IdentifierType', ['int']]]]);
        assertEqual(expand_init(r.ext[0].init), ['UnaryOp', '_Alignof',
            ['Typename', ['TypeDecl', ['IdentifierType', ['int']]]]]);

        assertEqual(expand_decl(parse('_Alignas(_Alignof(int)) char a;').ext[0]),
            ['Decl', ['Alignas',
                ['UnaryOp', '_Alignof', ['Typename', ['TypeDecl', ['IdentifierType', ['int']]]]]],
                'a', ['TypeDecl', ['IdentifierType', ['char']]]]);

        assertEqual(expand_decl(parse('_Alignas(4) char a;').ext[0]),
            ['Decl', ['Alignas',
                ['Constant', 'int', '4']],
                'a', ['TypeDecl', ['IdentifierType', ['char']]]]);

        assertEqual(expand_decl(parse('_Alignas(int) char a;').ext[0]),
            ['Decl', ['Alignas',
                ['Typename', ['TypeDecl', ['IdentifierType', ['int']]]]],
                'a', ['TypeDecl', ['IdentifierType', ['char']]]]);

    });
    test("test_offsetof", () => {
        function expand_ref(n) {
            if (n instanceof StructRef) {
                return ['StructRef', expand_ref(n.name), expand_ref(n.field)];
            } else if (n instanceof ArrayRef) {
                return ['ArrayRef', expand_ref(n.name), expand_ref(n.subscript)];
            } else if (n instanceof ID) {
                return ['ID', n.name];
            } else if (n instanceof Constant) {
                return ['Constant', n.type, n.value];
            } else {
                throw new TypeError("Unexpected type " + n.constructor.name);

            }
        }
        let e = `
            void foo() {
                int a = offsetof(struct S, p);
                a.b = offsetof(struct sockaddr, sp) + strlen(bar);
                int a = offsetof(struct S, p.q.r);
                int a = offsetof(struct S, p[5].q[4][5]);
            }
            `;
        let compound = parse(e).ext[0].body;
        let s1 = compound.block_items[0].init;
        assertIsInstance(s1, FuncCall);
        assertIsInstance(s1.name, ID);
        assertEqual(s1.name.name, 'offsetof');
        assertIsInstance(s1.args.exprs[0], Typename);
        assertIsInstance(s1.args.exprs[1], ID);
        let s3 = compound.block_items[2].init;
        assertIsInstance(s3.args.exprs[1], StructRef);
        assertEqual(expand_ref(s3.args.exprs[1]),
            ['StructRef',
                ['StructRef', ['ID', 'p'], ['ID', 'q']],
                ['ID', 'r']]);
        let s4 = compound.block_items[3].init;
        assertIsInstance(s4.args.exprs[1], ArrayRef);
        assertEqual(expand_ref(s4.args.exprs[1]),
            ['ArrayRef',
                ['ArrayRef',
                    ['StructRef',
                        ['ArrayRef', ['ID', 'p'], ['Constant', 'int', '5']],
                        ['ID', 'q']],
                    ['Constant', 'int', '4']],
                ['Constant', 'int', '5']]);

    });
    test("test_compound_statement", () => {
        let e = `
            void foo() {
            }
            `;
        let compound = parse(e).ext[0].body;
        assertIsInstance(compound, Compound);
        assert_coord(compound, 2);



    });
    test("test_compound_literals", () => {
        let ps1 = parse(String.raw`
            void foo() {
                p = (long long){k};
                tc = (struct jk){.a = {1, 2}, .b[0] = t};
            }`);

        let compound = ps1.ext[0].body.block_items[0].rvalue;
        assertEqual(expand_decl(compound.type),
            ['Typename', ['TypeDecl', ['IdentifierType', ['long', 'long']]]]);
        assertEqual(expand_init(compound.init),
            [['ID', 'k']]);

        compound = ps1.ext[0].body.block_items[1].rvalue;
        assertEqual(expand_decl(compound.type),
            ['Typename', ['TypeDecl', ['Struct', 'jk', []]]]);
        assertEqual(expand_init(compound.init),
            [
                [[['ID', 'a']], [['Constant', 'int', '1'], ['Constant', 'int', '2']]],
                [[['ID', 'b'], ['Constant', 'int', '0']], ['ID', 't']]]);

    });
    test("test_parenthesized_compounds", () => {
        let e = parse(String.raw`
        void foo() {
            int a;
            ({});
            ({ 1; });
            ({ 1; 2; });
            int b = ({ 1; });
            int c, d = ({ int x = 1; x + 2; });
            a = ({ int x = 1; 2 * x; });
        }`);
        let body = e.ext[0].body.block_items;

        assertIsInstance(body[1], Compound);
        assertEqual(body[1].block_items, null);

        assertIsInstance(body[2], Compound);
        assertEqual(len(body[2].block_items), 1);
        assertIsInstance(body[2].block_items[0], Constant);

        assertIsInstance(body[3], Compound);
        assertEqual(len(body[3].block_items), 2);
        assertIsInstance(body[3].block_items[0], Constant);
        assertIsInstance(body[3].block_items[1], Constant);

        assertIsInstance(body[4], Decl);
        assertEqual(expand_init(body[4].init),
            ['Compound', [['Constant', 'int', '1']]]);

        assertIsInstance(body[5], Decl);
        assertEqual(body[5].init, null);

        assertIsInstance(body[6], Decl);
        assertEqual(expand_init(body[6].init),
            ['Compound', [['Decl', 'x'], ['BinaryOp', ['ID', 'x'], '+', ['Constant', 'int', '2']]]]);

        assertIsInstance(body[7], Assignment);
        assertIsInstance(body[7].rvalue, Compound);
        assertEqual(expand_init(body[7].rvalue),
            ['Compound', [['Decl', 'x'], ['BinaryOp', ['Constant', 'int', '2'], '*', ['ID', 'x']]]]);

    });
    test("test_enums", () => {
        let e1 = "enum mycolor op;";
        let e1_type = parse(e1).ext[0].type.type;

        assertIsInstance(e1_type, Enum);
        assertEqual(e1_type.name, 'mycolor');
        assertEqual(e1_type.values, null);

        let e2 = "enum mysize {large=20, small, medium} shoes;";
        let e2_type = parse(e2).ext[0].type.type;

        assertIsInstance(e2_type, Enum);
        assertEqual(e2_type.name, 'mysize');

        let e2_elist = e2_type.values;
        assertIsInstance(e2_elist, EnumeratorList);

        for (const e2_eval of e2_elist.enumerators) {
            assertIsInstance(e2_eval, Enumerator);

        }
        assertEqual(e2_elist.enumerators[0].name, 'large');
        assertEqual(e2_elist.enumerators[0].value.value, '20');
        assertEqual(e2_elist.enumerators[2].name, 'medium');
        assertEqual(e2_elist.enumerators[2].value, null);


        let e3 = `
            enum
            {
                red,
                blue,
                green,
            } color;
            `;

        let e3_type = parse(e3).ext[0].type.type;
        assertIsInstance(e3_type, Enum);
        let e3_elist = e3_type.values;
        assertIsInstance(e3_elist, EnumeratorList);

        for (const e3_eval of e3_elist.enumerators) {
            assertIsInstance(e3_eval, Enumerator);

        }
        assertEqual(e3_elist.enumerators[0].name, 'red');
        assertEqual(e3_elist.enumerators[0].value, null);
        assertEqual(e3_elist.enumerators[1].name, 'blue');
        assertEqual(e3_elist.enumerators[2].name, 'green');

    });
    test("test_typedef", () => {

        let s1 = `
            node k;
        `;
        assertRaises(ParseError, parse, s1);


        let s2 = `
            typedef void* node;
            node k;
        `;
        let ps2 = parse(s2);
        assertEqual(expand_decl(ps2.ext[0]),
            ['Typedef', 'node',
                ['PtrDecl',
                    ['TypeDecl', ['IdentifierType', ['void']]]]]);

        assertEqual(expand_decl(ps2.ext[1]),
            ['Decl', 'k',
                ['TypeDecl', ['IdentifierType', ['node']]]]);

        let s3 = `
            typedef int T;
            typedef T *pT;

            pT aa, bb;
        `;
        let ps3 = parse(s3);
        assertEqual(expand_decl(ps3.ext[3]),
            ['Decl', 'bb',
                ['TypeDecl', ['IdentifierType', ['pT']]]]);

        let s4 = `
            typedef char* __builtin_va_list;
            typedef __builtin_va_list __gnuc_va_list;
        `;
        let ps4 = parse(s4);
        assertEqual(expand_decl(ps4.ext[1]),
            ['Typedef', '__gnuc_va_list',
                ['TypeDecl',
                    ['IdentifierType', ['__builtin_va_list']]]]);

        let s5 = `typedef struct tagHash Hash;`;
        let ps5 = parse(s5);
        assertEqual(expand_decl(ps5.ext[0]),
            ['Typedef', 'Hash', ['TypeDecl', ['Struct', 'tagHash', []]]]);

        let s6 = `typedef int (* const * const T)(void);`;
        let ps6 = parse(s6);
        assertEqual(expand_decl(ps6.ext[0]),
         ['Typedef',
          'T',
          ['PtrDecl',
           ['const'],
           ['PtrDecl',
            ['const'],
            ['FuncDecl',
             [['Typename', ['TypeDecl', ['IdentifierType', ['void']]]]],
             ['TypeDecl', ['IdentifierType', ['int']]]]]]]);

    });
    test("test_struct_union", () => {
        let s1 = `
            struct {
                int id;
                char* name;
            } joe;
            `;

        assertEqual(expand_decl(parse(s1).ext[0]),
            ['Decl', 'joe',
                ['TypeDecl', ['Struct', null,
                    [   ['Decl', 'id',
                            ['TypeDecl',
                                ['IdentifierType', ['int']]]],
                        ['Decl', 'name',
                            ['PtrDecl',
                                ['TypeDecl',
                                    ['IdentifierType', ['char']]]]]]]]]);

        let s2 = `
            struct node p;
        `;
        assertEqual(expand_decl(parse(s2).ext[0]),
            ['Decl', 'p',
                ['TypeDecl', ['Struct', 'node', []]]]);

        let s21 = `
            union pri ra;
        `;
        assertEqual(expand_decl(parse(s21).ext[0]),
            ['Decl', 'ra',
                ['TypeDecl', ['Union', 'pri', []]]]);

        let s3 = `
            struct node* p;
        `;
        assertEqual(expand_decl(parse(s3).ext[0]),
            ['Decl', 'p',
                ['PtrDecl',
                    ['TypeDecl', ['Struct', 'node', []]]]]);

        let s4 = `
            struct node;
        `;
        assertEqual(expand_decl(parse(s4).ext[0]),
            ['Decl', null,
                ['Struct', 'node', []]]);

        let s5 = `
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
        assertEqual(expand_decl(parse(s5).ext[0]),
            ['Decl', 'u',
                ['TypeDecl',
                    ['Union', null,
                        [['Decl', 'n',
                            ['TypeDecl',
                                ['Struct', null,
                                    [['Decl', 'type',
                                        ['TypeDecl', ['IdentifierType', ['int']]]]]]]],
                        ['Decl', 'ni',
                            ['TypeDecl',
                                ['Struct', null,
                                    [['Decl', 'type',
                                        ['TypeDecl', ['IdentifierType', ['int']]]],
                                    ['Decl', 'intnode',
                                        ['TypeDecl', ['IdentifierType', ['int']]]]]]]]]]]]);

        let s6 = `
            typedef struct foo_tag
            {
                void* data;
            } foo, *pfoo;
        `;
        let s6_ast = parse(s6);

        assertEqual(expand_decl(s6_ast.ext[0]),
            ['Typedef', 'foo',
                ['TypeDecl',
                    ['Struct', 'foo_tag',
                        [['Decl', 'data',
                            ['PtrDecl', ['TypeDecl', ['IdentifierType', ['void']]]]]]]]]);

        assertEqual(expand_decl(s6_ast.ext[1]),
            ['Typedef', 'pfoo',
                ['PtrDecl',
                    ['TypeDecl',
                        ['Struct', 'foo_tag',
                            [['Decl', 'data',
                                ['PtrDecl', ['TypeDecl', ['IdentifierType', ['void']]]]]]]]]]);

        let s7 = String.raw`
            struct _on_exit_args {
                void *  _fnargs[32];
                void *  _dso_handle[32];

                long _fntypes;
                #line 77 "D:\eli\cpp_stuff\libc_include/sys/reent.h"

                long _is_cxa;
            };
        `;

        let s7_ast = parse(s7, 'test.c');
        assert_coord(s7_ast.ext[0].type.decls[2], 6, 22, 'test.c');
        assert_coord(s7_ast.ext[0].type.decls[3], 78, 22,
            String.raw`D:\eli\cpp_stuff\libc_include/sys/reent.h`);

        let s8 = `
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
        let s8_ast = parse(s8);
        assertEqual(expand_decl(s8_ast.ext[3]),
            ['Typedef', 'Hash',
                ['TypeDecl', ['Struct', 'tagHash',
                    [['Decl', 'table_size',
                        ['TypeDecl', ['IdentifierType', ['unsigned', 'int']]]],
                    ['Decl', 'heads',
                        ['PtrDecl', ['PtrDecl', ['TypeDecl', ['IdentifierType', ['Node']]]]]]]]]]);

    });
    test("test_struct_enum", () => {
        let s1 = `
            struct Foo {
                enum Bar { A = 1 };
            };
        `;
        assertEqual(expand_decl(parse(s1).ext[0]),
            ['Decl', null,
             ['Struct', 'Foo',
              [['Decl', null,
                ['Enum', 'Bar', ['A']]]]]]);
        let s2 = `
            struct Foo {
                enum Bar { A = 1, B, C } bar;
                enum Baz { D = A } baz;
            } foo;
        `;
        assertEqual(expand_decl(parse(s2).ext[0]),
            ['Decl', 'foo',
             ['TypeDecl', ['Struct', 'Foo',
              [['Decl', 'bar',
                ['TypeDecl', ['Enum', 'Bar', ['A', 'B', 'C']]]],
               ['Decl', 'baz',
                ['TypeDecl', ['Enum', 'Baz', ['D']]]]]]]]);

    });
    test("test_struct_with_extra_semis_inside", () => {
        let s1 = `
            struct {
                int a;;
            } foo;
        `;
        let s1_ast = parse(s1);
        assertEqual(expand_decl(s1_ast.ext[0]),
            ['Decl', 'foo',
                ['TypeDecl', ['Struct', null,
                    [['Decl', 'a',
                        ['TypeDecl', ['IdentifierType', ['int']]]]]]]]);

        let s2 = `
            struct {
                int a;;;;
                float b, c;
                ;;
                char d;
            } foo;
        `;
        let s2_ast = parse(s2);
        assertEqual(expand_decl(s2_ast.ext[0]),
            ['Decl', 'foo',
                ['TypeDecl', ['Struct', null,
                   [['Decl', 'a', ['TypeDecl', ['IdentifierType', ['int']]]],
                    ['Decl', 'b', ['TypeDecl', ['IdentifierType', ['float']]]],
                    ['Decl', 'c', ['TypeDecl', ['IdentifierType', ['float']]]],
                    ['Decl', 'd',
                        ['TypeDecl', ['IdentifierType', ['char']]]]]]]]);

    });
    test("test_struct_with_initial_semi", () => {
        let s1 = `
            struct {
                ;int a;
            } foo;
        `;
        let s1_ast = parse(s1);
        assertEqual(expand_decl(s1_ast.ext[0]),
            ['Decl', 'foo',
                ['TypeDecl', ['Struct', null,
                    [['Decl', 'a',
                        ['TypeDecl', ['IdentifierType', ['int']]]]]]]]);

    });
    test("test_anonymous_struct_union", () => {
        let s1 = `
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

        assertEqual(expand_decl(parse(s1).ext[0]),
            ['Decl', 'u',
                ['TypeDecl',
                    ['Union', null,
                        [['Decl', null,
                            ['Union', null,
                                [['Decl', 'i',
                                    ['TypeDecl',
                                        ['IdentifierType', ['int']]]],
                                ['Decl', 'l',
                                    ['TypeDecl',
                                        ['IdentifierType', ['long']]]]]]],
                        ['Decl', null,
                            ['Struct', null,
                                [['Decl', 'type',
                                    ['TypeDecl',
                                        ['IdentifierType', ['int']]]],
                                ['Decl', 'intnode',
                                    ['TypeDecl',
                                        ['IdentifierType', ['int']]]]]]]]]]]);

        let s2 = `
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

        assertEqual(expand_decl(parse(s2).ext[0]),
            ['Decl', 'joe',
                ['TypeDecl',
                    ['Struct', null,
                       [['Decl', 'i',
                            ['TypeDecl',
                                ['IdentifierType', ['int']]]],
                        ['Decl', null,
                            ['Union', null,
                                [['Decl', 'id',
                                    ['TypeDecl',
                                        ['IdentifierType', ['int']]]],
                                ['Decl', 'name',
                                    ['PtrDecl',
                                        ['TypeDecl',
                                            ['IdentifierType', ['char']]]]]]]],
                        ['Decl', 'f',
                            ['TypeDecl',
                                ['IdentifierType', ['float']]]]]]]]);



        let s3 = `
            struct v {
                union {
                    struct { int i, j; };
                    struct { long k, l; } w;
                };
                int m;
            } v1;
            `;

        assertEqual(expand_decl(parse(s3).ext[0]),
            ['Decl', 'v1',
                ['TypeDecl',
                    ['Struct', 'v',
                       [['Decl', null,
                            ['Union', null,
                                [['Decl', null,
                                    ['Struct', null,
                                        [['Decl', 'i',
                                            ['TypeDecl',
                                                ['IdentifierType', ['int']]]],
                                        ['Decl', 'j',
                                            ['TypeDecl',
                                                ['IdentifierType', ['int']]]]]]],
                                ['Decl', 'w',
                                    ['TypeDecl',
                                        ['Struct', null,
                                            [['Decl', 'k',
                                                ['TypeDecl',
                                                    ['IdentifierType', ['long']]]],
                                            ['Decl', 'l',
                                                ['TypeDecl',
                                                    ['IdentifierType', ['long']]]]]]]]]]],
                        ['Decl', 'm',
                            ['TypeDecl',
                                ['IdentifierType', ['int']]]]]]]]);

        let s4 = `
            struct v {
                int i;
                float;
            } v2;`;

        parse(s4);

    });
    test("test_struct_members_namespace", () => {
        let s1 = `
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

        let s1_ast = parse(s1);
        assertEqual(expand_decl(s1_ast.ext[2]),
            ['Decl', 'sye',
                ['TypeDecl', ['Struct', null,
                    [   ['Decl', 'Name',
                            ['TypeDecl',
                                ['IdentifierType', ['Name']]]],
                        ['Decl', 'NameArray',
                            ['ArrayDecl', '3', [],
                                ['TypeDecl', ['IdentifierType', ['Name']]]]]]]]]);
        assertEqual(s1_ast.ext[3].body.block_items[0].lvalue.field.name, 'Name');

    });
    test("test_struct_bitfields", () => {

        let s1 = `
            struct {
                int k:6;
                int :2;
            } joe;
            `;

        let parsed_struct = parse(s1).ext[0];




        assertEqual(expand_decl(parsed_struct),
            ['Decl', 'joe',
                ['TypeDecl', ['Struct', null,
                    [   ['Decl', 'k',
                            ['TypeDecl',
                                ['IdentifierType', ['int']]]],
                        ['Decl', null,
                            ['TypeDecl',
                                ['IdentifierType', ['int']]]]]]]]);



        assertEqual(parsed_struct.type.type.decls[0].bitsize.value, '6');
        assertEqual(parsed_struct.type.type.decls[1].bitsize.value, '2');

    });
    test("test_struct_empty", () => {

        let s1 = `
                 struct foo { };
             `;

        let parsed_struct = parse(s1).ext[0];
        assertEqual(expand_decl(parsed_struct),
                         ['Decl', null, ['Struct', 'foo', []]]);

        let s2 = `struct { } foo;`;
        parsed_struct = parse(s2).ext[0];
        assertEqual(expand_decl(parsed_struct),
                         ['Decl', 'foo', ['TypeDecl', ['Struct', null, []]]]);

        let s3 = `union { } foo;`;
        parsed_struct = parse(s3).ext[0];
        assertEqual(expand_decl(parsed_struct),
                         ['Decl', 'foo', ['TypeDecl', ['Union', null, []]]]);

    });
    test("test_tags_namespace", () => {
        let s1 = `
                typedef int tagEntry;

                struct tagEntry
                {
                    char* key;
                    char* value;
                } Entry;
            `;

        let s1_ast = parse(s1);
        assertEqual(expand_decl(s1_ast.ext[1]),
            ['Decl', 'Entry',
                ['TypeDecl', ['Struct', 'tagEntry',
                    [['Decl', 'key',
                        ['PtrDecl', ['TypeDecl', ['IdentifierType', ['char']]]]],
                    ['Decl', 'value',
                        ['PtrDecl', ['TypeDecl', ['IdentifierType', ['char']]]]]]]]]);

        let s2 = `
                struct tagEntry;

                typedef struct tagEntry tagEntry;

                struct tagEntry
                {
                    char* key;
                    char* value;
                } Entry;
            `;

        let s2_ast = parse(s2);
        assertEqual(expand_decl(s2_ast.ext[2]),
            ['Decl', 'Entry',
                ['TypeDecl', ['Struct', 'tagEntry',
                    [['Decl', 'key',
                        ['PtrDecl', ['TypeDecl', ['IdentifierType', ['char']]]]],
                    ['Decl', 'value',
                        ['PtrDecl', ['TypeDecl', ['IdentifierType', ['char']]]]]]]]]);

        let s3 = `
                typedef int mytag;

                enum mytag {ABC, CDE};
                enum mytag joe;
            `;

        let s3_type = parse(s3).ext[1].type;

        assertIsInstance(s3_type, Enum);
        assertEqual(s3_type.name, 'mytag');

    });
    test("test_multi_decls", () => {
        let d1 = 'int a, b;';

        assertEqual(get_decl(d1, 0),
            ['Decl', 'a', ['TypeDecl', ['IdentifierType', ['int']]]]);
        assertEqual(get_decl(d1, 1),
            ['Decl', 'b', ['TypeDecl', ['IdentifierType', ['int']]]]);

        let d2 = 'char* p, notp, ar[4];';
        assertEqual(get_decl(d2, 0),
            ['Decl', 'p',
                ['PtrDecl',
                    ['TypeDecl', ['IdentifierType', ['char']]]]]);
        assertEqual(get_decl(d2, 1),
            ['Decl', 'notp', ['TypeDecl', ['IdentifierType', ['char']]]]);
        assertEqual(get_decl(d2, 2),
            ['Decl', 'ar',
                ['ArrayDecl', '4', [],
                    ['TypeDecl', ['IdentifierType', ['char']]]]]);

    });
    test("test_invalid_multiple_types_error", () => {
        let bad = [
            'int enum {ab, cd} fubr;',
            'enum kid char brbr;'];

        for (const b of bad) {
            assertRaises(ParseError, parse, b);

        }
    });
    test("test_invalid_typedef_storage_qual_error", () => {
        let bad = 'typedef const int foo(int a) { return 0; }';
        assertRaises(ParseError, parse, bad);

    });
    test("test_duplicate_typedef", () => {
        let d1 = `
            typedef int numbertype;
            typedef int numbertype;
        `;

        assertEqual(get_decl(d1, 0),
            ['Typedef', 'numbertype',
                ['TypeDecl', ['IdentifierType', ['int']]]]);
        assertEqual(get_decl(d1, 1),
            ['Typedef', 'numbertype',
                ['TypeDecl', ['IdentifierType', ['int']]]]);

        let d2 = `
            typedef int (*funcptr)(int x);
            typedef int (*funcptr)(int x);
        `;
        assertEqual(get_decl(d2, 0),
            ['Typedef', 'funcptr',
                ['PtrDecl', ['FuncDecl',
                    [['Decl', 'x', ['TypeDecl', ['IdentifierType', ['int']]]]],
                    ['TypeDecl', ['IdentifierType', ['int']]]]]]);
        assertEqual(get_decl(d2, 1),
            ['Typedef', 'funcptr',
                ['PtrDecl', ['FuncDecl',
                    [['Decl', 'x', ['TypeDecl', ['IdentifierType', ['int']]]]],
                    ['TypeDecl', ['IdentifierType', ['int']]]]]]);

        let d3 = `
            typedef int numberarray[5];
            typedef int numberarray[5];
        `;
        assertEqual(get_decl(d3, 0),
            ['Typedef', 'numberarray',
                ['ArrayDecl', '5', [],
                    ['TypeDecl', ['IdentifierType', ['int']]]]]);
        assertEqual(get_decl(d3, 1),
            ['Typedef', 'numberarray',
                ['ArrayDecl', '5', [],
                    ['TypeDecl', ['IdentifierType', ['int']]]]]);

    });
    test("test_decl_inits", () => {
        let d1 = 'int a = 16;';

        assertEqual(get_decl(d1),
            ['Decl', 'a', ['TypeDecl', ['IdentifierType', ['int']]]]);
        assertEqual(get_decl_init(d1),
            ['Constant', 'int', '16']);

        let d1_1 = 'float f = 0xEF.56p1;';
        assertEqual(get_decl_init(d1_1),
            ['Constant', 'double', '0xEF.56p1']);

        let d1_2 = 'int bitmask = 0b1001010;';
        assertEqual(get_decl_init(d1_2),
            ['Constant', 'int', '0b1001010']);

        let d2 = 'long ar[] = {7, 8, 9};';
        assertEqual(get_decl(d2),
            ['Decl', 'ar',
                ['ArrayDecl', '', [],
                    ['TypeDecl', ['IdentifierType', ['long']]]]]);
        assertEqual(get_decl_init(d2),
            [   ['Constant', 'int', '7'],
                ['Constant', 'int', '8'],
                ['Constant', 'int', '9']]);

        let d21 = 'long ar[4] = {};';
        assertEqual(get_decl_init(d21), []);

        let d3 = 'char p = j;';
        assertEqual(get_decl(d3),
            ['Decl', 'p', ['TypeDecl', ['IdentifierType', ['char']]]]);
        assertEqual(get_decl_init(d3),
            ['ID', 'j']);

        let d4 = "char x = 'c', *p = {0, 1, 2, {4, 5}, 6};";
        assertEqual(get_decl(d4, 0),
            ['Decl', 'x', ['TypeDecl', ['IdentifierType', ['char']]]]);
        assertEqual(get_decl_init(d4, 0),
            ['Constant', 'char', "'c'"]);
        assertEqual(get_decl(d4, 1),
            ['Decl', 'p',
                ['PtrDecl',
                    ['TypeDecl', ['IdentifierType', ['char']]]]]);

        assertEqual(get_decl_init(d4, 1),
            [   ['Constant', 'int', '0'],
                ['Constant', 'int', '1'],
                ['Constant', 'int', '2'],
                [['Constant', 'int', '4'],
                 ['Constant', 'int', '5']],
                ['Constant', 'int', '6']]);

        let d5 = 'float d = 1.0;';
        assertEqual(get_decl_init(d5),
            ['Constant', 'double', '1.0']);

        let d51 = 'float ld = 1.0l;';
        assertEqual(get_decl_init(d51),
            ['Constant', 'long double', '1.0l']);

        let d52 = 'float ld = 1.0L;';
        assertEqual(get_decl_init(d52),
            ['Constant', 'long double', '1.0L']);

        let d53 = 'float ld = 1.0f;';
        assertEqual(get_decl_init(d53),
            ['Constant', 'float', '1.0f']);

        let d54 = 'float ld = 1.0F;';
        assertEqual(get_decl_init(d54),
            ['Constant', 'float', '1.0F']);

        let d55 = 'float ld = 0xDE.38p0;';
        assertEqual(get_decl_init(d55),
            ['Constant', 'double', '0xDE.38p0']);

        let d56 = 'float ld = 0xDE.38p0f;';
        assertEqual(get_decl_init(d56),
            ['Constant', 'float', '0xDE.38p0f']);

        let d57 = 'float ld = 0xDE.38p0F;';
        assertEqual(get_decl_init(d57),
            ['Constant', 'float', '0xDE.38p0F']);

        let d58 = 'float ld = 0xDE.38p0l;';
        assertEqual(get_decl_init(d58),
            ['Constant', 'long double', '0xDE.38p0l']);

        let d59 = 'float ld = 0xDE.38p0L;';
        assertEqual(get_decl_init(d59),
            ['Constant', 'long double', '0xDE.38p0L']);

        let d6 = 'int i = 1;';
        assertEqual(get_decl_init(d6),
            ['Constant', 'int', '1']);

        let d61 = 'long int li = 1l;';
        assertEqual(get_decl_init(d61),
            ['Constant', 'long int', '1l']);

        let d62 = 'unsigned int ui = 1u;';
        assertEqual(get_decl_init(d62),
            ['Constant', 'unsigned int', '1u']);

        let d63 = 'unsigned long long int ulli = 1LLU;';
        assertEqual(get_decl_init(d63),
            ['Constant', 'unsigned long long int', '1LLU']);

    });
    test("test_decl_named_inits", () => {
        let d1 = 'int a = {.k = 16};';
        assertEqual(get_decl_init(d1),
            [[   [['ID', 'k']],
                 ['Constant', 'int', '16']]]);

        let d2 = 'int a = { [0].a = {1}, [1].a[0] = 2 };';
        assertEqual(get_decl_init(d2),
            [
                [[['Constant', 'int', '0'], ['ID', 'a']],
                    [['Constant', 'int', '1']]],
                [[['Constant', 'int', '1'], ['ID', 'a'], ['Constant', 'int', '0']],
                    ['Constant', 'int', '2']]]);

        let d3 = 'int a = { .a = 1, .c = 3, 4, .b = 5};';
        assertEqual(get_decl_init(d3),
            [
                [[['ID', 'a']], ['Constant', 'int', '1']],
                [[['ID', 'c']], ['Constant', 'int', '3']],
                ['Constant', 'int', '4'],
                [[['ID', 'b']], ['Constant', 'int', '5']]]);

    });
    test("test_function_definitions", () => {
        function parse_fdef(str) {
            return parse(str).ext[0];

        }
        function fdef_decl(fdef) {
            return expand_decl(fdef.decl);

        }
        let f1 = parse_fdef(`
        int factorial(int p)
        {
            return 3;
        }
        `);

        assertEqual(fdef_decl(f1),
            ['Decl', 'factorial',
                ['FuncDecl',
                    [['Decl', 'p', ['TypeDecl', ['IdentifierType', ['int']]]]],
                    ['TypeDecl', ['IdentifierType', ['int']]]]]);

        assertEqual(type(f1.body.block_items[0]), Return);

        let f2 = parse_fdef(`
        char* zzz(int p, char* c)
        {
            int a;
            char b;

            a = b + 2;
            return 3;
        }
        `);

        assertEqual(fdef_decl(f2),
            ['Decl', 'zzz',
                ['FuncDecl',
                    [   ['Decl', 'p', ['TypeDecl', ['IdentifierType', ['int']]]],
                        ['Decl', 'c', ['PtrDecl',
                                        ['TypeDecl', ['IdentifierType', ['char']]]]]],
                    ['PtrDecl', ['TypeDecl', ['IdentifierType', ['char']]]]]]);

        assertEqual(f2.body.block_items.map(type),
            [Decl, Decl, Assignment, Return]);

        let f3 = parse_fdef(`
        char* zzz(p, c)
        long p, *c;
        {
            int a;
            char b;

            a = b + 2;
            return 3;
        }
        `);

        assertEqual(fdef_decl(f3),
            ['Decl', 'zzz',
                ['FuncDecl',
                    [   ['ID', 'p'],
                        ['ID', 'c']],
                    ['PtrDecl', ['TypeDecl', ['IdentifierType', ['char']]]]]]);

        assertEqual(f3.body.block_items.map(type),
            [Decl, Decl, Assignment, Return]);

        assertEqual(expand_decl(f3.param_decls[0]),
            ['Decl', 'p', ['TypeDecl', ['IdentifierType', ['long']]]]);
        assertEqual(expand_decl(f3.param_decls[1]),
            ['Decl', 'c', ['PtrDecl', ['TypeDecl', ['IdentifierType', ['long']]]]]);


        let f4 = parse_fdef(`
        que(p)
        {
            return 3;
        }
        `);

        assertEqual(fdef_decl(f4),
            ['Decl', 'que',
                ['FuncDecl',
                    [['ID', 'p']],
                    ['TypeDecl', ['IdentifierType', ['int']]]]]);

    });
    test("test_static_assert", () => {
        let f1 = parse(`
        _Static_assert(1, "123");
        int factorial(int p)
        {
            _Static_assert(2, "456");
            _Static_assert(3);
        }
        `);

        assertEqual(expand_decl(f1.ext[0]), ['StaticAssert', '1', '"123"']);
        assertEqual(expand_decl(f1.ext[1].body.block_items[0]), ['StaticAssert', '2', '"456"']);
        assertEqual(expand_decl(f1.ext[1].body.block_items[2]), ['StaticAssert', '3']);

    });
    test("test_unified_string_literals", () => {

        let d1 = get_decl_init('char* s = "hello";');
        assertEqual(d1, ['Constant', 'string', '"hello"']);

        let d2 = get_decl_init('char* s = "hello" " world";');
        assertEqual(d2, ['Constant', 'string', '"hello world"']);


        let d3 = parse(String.raw`
            int main() {
                fprintf(stderr,
                "Wrong Params?\n"
                "Usage:\n"
                "%s <binary_file_path>\n",
                argv[0]
                );
            }
        `);

        assertEqual(
            d3.ext[0].body.block_items[0].args.exprs[1].value,
            String.raw`"Wrong Params?\nUsage:\n%s <binary_file_path>\n"`);

        let d4 = get_decl_init('char* s = "" "foobar";');
        assertEqual(d4, ['Constant', 'string', '"foobar"']);

        let d5 = get_decl_init(String.raw`char* s = "foo\"" "bar";`);
        assertEqual(d5, ['Constant', 'string', String.raw`"foo\"bar"`]);








        let d6 = get_decl_init(String.raw`char* s = "\1" "23";`);
        assertEqual(d6, ['Constant', 'string', String.raw`"\123"`]);

    });
    test("test_unified_wstring_literals", () => {
        let d1 = get_decl_init('char* s = L"hello" L"world";');
        assertEqual(d1, ['Constant', 'string', 'L"helloworld"']);

        let d2 = get_decl_init('char* s = L"hello " L"world" L" and I";');
        assertEqual(d2, ['Constant', 'string', 'L"hello world and I"']);

    });
    test("test_inline_specifier", () => {
        let ps2 = parse('static inline void inlinefoo(void);');
        assertEqual(ps2.ext[0].funcspec, ['inline']);

    });
    test("test_noreturn_specifier", () => {
        let ps2 = parse('static _Noreturn void noreturnfoo(void);');
        assertEqual(ps2.ext[0].funcspec, ['_Noreturn']);


    });
    test("test_vla", () => {
        let ps2 = parse(String.raw`
            int main() {
                int size;
                int var[size = 5];

                int var2[*];
            }
        `);
        assertIsInstance(ps2.ext[0].body.block_items[1].type.dim, Assignment);
        assertIsInstance(ps2.ext[0].body.block_items[2].type.dim, ID);

    });
    test("test_pragma", () => {
        let s1 = String.raw`
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
        let s1_ast = parse(s1);
        assertIsInstance(s1_ast.ext[0], Pragma);
        assertEqual(s1_ast.ext[0].string, 'bar');
        assertEqual(s1_ast.ext[0].coord.line, 2);

        assertIsInstance(s1_ast.ext[1].body.block_items[0], Pragma);
        assertEqual(s1_ast.ext[1].body.block_items[0].string, 'foo');
        assertEqual(s1_ast.ext[1].body.block_items[0].coord.line, 4);

        assertIsInstance(s1_ast.ext[1].body.block_items[2], Pragma);
        assertEqual(s1_ast.ext[1].body.block_items[2].string, 'baz');
        assertEqual(s1_ast.ext[1].body.block_items[2].coord.line, 6);

        assertIsInstance(s1_ast.ext[1].body.block_items[4], Pragma);
        assertEqual(s1_ast.ext[1].body.block_items[4].string, '');
        assertEqual(s1_ast.ext[1].body.block_items[4].coord.line, 10);

        assertIsInstance(s1_ast.ext[2].type.type.decls[0], Pragma);
        assertEqual(s1_ast.ext[2].type.type.decls[0].string, 'baz');
        assertEqual(s1_ast.ext[2].type.type.decls[0].coord.line, 13);

        assertIsInstance(s1_ast.ext[3], Pragma);
        assertEqual(s1_ast.ext[3].string.value, String.raw`"other \"string\""`);
        assertEqual(s1_ast.ext[3].coord.line, 15);

    });
    test("test_pragmacomp_or_statement", () => {
        let s1 = String.raw`
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
        let s1_ast = parse(s1);
        assertIsInstance(s1_ast.ext[0].body.block_items[1], For);
        assertIsInstance(s1_ast.ext[0].body.block_items[1].stmt, Compound);
        assertIsInstance(s1_ast.ext[0].body.block_items[1].stmt.block_items[0], Pragma);
        assertIsInstance(s1_ast.ext[0].body.block_items[1].stmt.block_items[1], Assignment);
        assertIsInstance(s1_ast.ext[0].body.block_items[2], While);
        assertIsInstance(s1_ast.ext[0].body.block_items[2].stmt, Compound);
        assertIsInstance(s1_ast.ext[0].body.block_items[2].stmt.block_items[0], Pragma);
        assertIsInstance(s1_ast.ext[0].body.block_items[2].stmt.block_items[1], Assignment);
        assertIsInstance(s1_ast.ext[0].body.block_items[3], Label);
        assertIsInstance(s1_ast.ext[0].body.block_items[3].stmt, Compound);
        assertIsInstance(s1_ast.ext[0].body.block_items[3].stmt.block_items[0], Pragma);
        assertIsInstance(s1_ast.ext[0].body.block_items[3].stmt.block_items[1], Assignment);
        assertIsInstance(s1_ast.ext[0].body.block_items[4], If);
        assertIsInstance(s1_ast.ext[0].body.block_items[4].iftrue, Compound);
        assertIsInstance(s1_ast.ext[0].body.block_items[4].iftrue.block_items[0], Pragma);
        assertIsInstance(s1_ast.ext[0].body.block_items[4].iftrue.block_items[1], Pragma);
        assertIsInstance(s1_ast.ext[0].body.block_items[4].iftrue.block_items[2], Assignment);
        assertIsInstance(s1_ast.ext[0].body.block_items[5], Switch);
        assertIsInstance(s1_ast.ext[0].body.block_items[5].stmt.stmts[0], Compound);
        assertIsInstance(s1_ast.ext[0].body.block_items[5].stmt.stmts[0].block_items[0],
                              Pragma);
        assertIsInstance(s1_ast.ext[0].body.block_items[5].stmt.stmts[0].block_items[1],
                              Assignment);


    });
});
describe("TestCParser_whole_code", () => {
    test("test_expressions", () => {
        let e1 = `int k = (r + 10.0) >> 6 + 8 << (3 & 0x14);`;
        assert_all_Constants(e1, ['10.0', '6', '8', '3', '0x14']);

        let e2 = String.raw`char n = '\n', *prefix = "st_";`;
        assert_all_Constants(e2, [String.raw`'\n'`, '"st_"']);

        let s1 = String.raw`int main() {
                    int i = 5, j = 6, k = 1;
                    if ((i=j && k == 1) || k > j)
                        printf("Hello, world\n");
                    return 0;
                 }`;
        let ps1 = parse(s1);
        assert_all_Constants(ps1,
            ['5', '6', '1', '1', '"Hello, world\\n"', '0']);
        assert_num_ID_refs(ps1, 'i', 1);
        assert_num_ID_refs(ps1, 'j', 2);


    });
    test("test_statements", () => {
        let s1 = String.raw`
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

        assert_all_Constants(s1,
            ['1', '0', String.raw`'-'`, '1', String.raw`'\0'`, '1', String.raw`"--"`, '0', '1']);

        let ps1 = parse(s1);
        assert_num_ID_refs(ps1, 'argv', 3);
        assert_num_ID_refs(ps1, 'optind', 5);

        assert_num_klass_nodes(ps1, If, 3);
        assert_num_klass_nodes(ps1, Return, 2);
        assert_num_klass_nodes(ps1, FuncCall, 1);
        assert_num_klass_nodes(ps1, BinaryOp, 7);





        let s2 = String.raw`
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

        let ps2 = parse(s2);
        assert_num_klass_nodes(ps2, FuncCall, 6);
        assert_num_klass_nodes(ps2, FuncDef, 1);
        assert_num_klass_nodes(ps2, For, 1);
        assert_num_klass_nodes(ps2, While, 1);
        assert_num_klass_nodes(ps2, StructRef, 10);


        assert_num_ID_refs(ps2, 'hash', 6);
        assert_num_ID_refs(ps2, 'i', 4);

        let s3 = String.raw`
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

        let ps3 = parse(s3);
        assert_num_klass_nodes(ps3, DoWhile, 1);
        assert_num_ID_refs(ps3, 'a', 4);
        assert_all_Constants(ps3, ['0', '0', '1']);

    });
    test("test_empty_statements", () => {
        let s1 = String.raw`
        void foo(void){
            ;
            return;;

            ;
        }
        `;
        let ps1 = parse(s1);
        assert_num_klass_nodes(ps1, EmptyStatement, 3);
        assert_num_klass_nodes(ps1, Return, 1);
        assert_coord(ps1.ext[0].body.block_items[0], 3);
        assert_coord(ps1.ext[0].body.block_items[1], 4);
        assert_coord(ps1.ext[0].body.block_items[2], 4);
        assert_coord(ps1.ext[0].body.block_items[3], 6);

    });
    test("test_switch_statement", () => {
        function assert_case_node(node, const_value) {
            assertIsInstance(node, Case);
            assertIsInstance(node.expr, Constant);
            assertEqual(node.expr.value, const_value);

        }
        function assert_default_node(node) {
            assertIsInstance(node, Default);

        }
        let s1 = String.raw`
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
        let ps1 = parse(s1);
        let switch_ = ps1.ext[0].body.block_items[0];

        let block = switch_.stmt.block_items;
        assertEqual(len(block), 4);
        assert_case_node(block[0], '10');
        assertEqual(len(block[0].stmts), 3);
        assert_case_node(block[1], '20');
        assertEqual(len(block[1].stmts), 0);
        assert_case_node(block[2], '30');
        assertEqual(len(block[2].stmts), 1);
        assert_default_node(block[3]);

        let s2 = String.raw`
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
        let ps2 = parse(s2);
        switch_ = ps2.ext[0].body.block_items[0];

        block = switch_.stmt.block_items;
        assertEqual(len(block), 5);
        assert_default_node(block[0]);
        assertEqual(len(block[0].stmts), 2);
        assert_case_node(block[1], '10');
        assertEqual(len(block[1].stmts), 0);
        assert_case_node(block[2], '20');
        assertEqual(len(block[1].stmts), 0);
        assert_case_node(block[3], '30');
        assertEqual(len(block[1].stmts), 0);
        assert_case_node(block[4], '40');
        assertEqual(len(block[4].stmts), 1);

        let s3 = String.raw`
        int foo(void) {
            switch (myvar) {
            }
            return 0;
        }
        `;
        let ps3 = parse(s3);
        switch_ = ps3.ext[0].body.block_items[0];

        assertEqual(switch_.stmt.block_items, []);

    });
    test("test_for_statement", () => {
        let s2 = String.raw`
        void x(void)
        {
            int i;
            for (i = 0; i < 5; ++i) {
                x = 50;
            }
        }
        `;
        let ps2 = parse(s2);
        assert_num_klass_nodes(ps2, For, 1);



        assert_num_ID_refs(ps2, 'i', 3);

        let s3 = String.raw`
        void x(void)
        {
            for (int i = 0; i < 5; ++i) {
                x = 50;
            }
        }
        `;
        let ps3 = parse(s3);
        assert_num_klass_nodes(ps3, For, 1);



        assert_num_ID_refs(ps3, 'i', 2);

        let s4 = String.raw`
        void x(void) {
            for (int i = 0;;)
                i;
        }
        `;
        let ps4 = parse(s4);
        assert_num_ID_refs(ps4, 'i', 1);

    });
    test("test_whole_file", { skip: !fs.existsSync(C_FILES) && "m2c checkout with pycparser test c_files not found" }, () => {
        const code = fs.readFileSync(path.join(C_FILES, "memmgr_with_h.c"), "utf8").replace(/\r\n?/g, "\n"); // Python text mode: universal newlines
        let p = parse(code);
        assert_num_klass_nodes(p, FuncDef, 5);
        assert_num_klass_nodes(p, FuncDecl, 9);
        assert_num_klass_nodes(p, Typedef, 4);
        assertEqual(p.ext[4].coord.line, 88);
        assertEqual(p.ext[4].coord.file, "./memmgr.h");
        assertEqual(p.ext[6].coord.line, 10);
        assertEqual(p.ext[6].coord.file, "memmgr.c");
    });
    test("test_whole_file_with_stdio", { skip: !fs.existsSync(C_FILES) && "m2c checkout with pycparser test c_files not found" }, () => {
        const code = fs.readFileSync(path.join(C_FILES, "cppd_with_stdio_h.c"), "utf8").replace(/\r\n?/g, "\n"); // Python text mode: universal newlines
        let p = parse(code);
        assertIsInstance(p.ext[0], Typedef);
        assertEqual(p.ext[0].coord.line, 213);
        assertEqual(p.ext[0].coord.file, String.raw`D:\eli\cpp_stuff\libc_include/stddef.h`);
        assertIsInstance(at(p.ext, -1), FuncDef);
        assertEqual(at(p.ext, -1).coord.line, 15);
        assertEqual(at(p.ext, -1).coord.file, "example_c_file.c");
        assertIsInstance(at(p.ext, -8), Typedef);
        assertIsInstance(at(p.ext, -8).type, TypeDecl);
        assertEqual(at(p.ext, -8).name, 'cookie_io_functions_t');
    });
});
describe("TestCParser_typenames", () => {
    test("test_innerscope_typedef", () => {

        let s1 = String.raw`
            void foo() {
              typedef char TT;
              TT x;
            }
            void bar() {
              TT y;
            }
            `;
        assertRaises(ParseError, parse, s1);


        let s2 = String.raw`
            void foo() {
              typedef char TT;
              TT x;
            }
            void bar() {
                unsigned TT;
            }
            `;
        assertIsInstance(parse(s2), FileAST);

    });
    test("test_ambiguous_parameters", () => {







        let s1 = String.raw`
        typedef char TT;
        int foo(int (aa));
        int bar(int (TT));
        `;
        let s1_ast = parse(s1);
        assertEqual(expand_decl(s1_ast.ext[1].type.args.params[0]),
            ['Decl', 'aa', ['TypeDecl', ['IdentifierType', ['int']]]]);
        assertEqual(expand_decl(s1_ast.ext[2].type.args.params[0]),
            ['Typename', ['FuncDecl',
                [['Typename', ['TypeDecl', ['IdentifierType', ['TT']]]]],
                ['TypeDecl', ['IdentifierType', ['int']]]]]);



        let s2 = String.raw`
        typedef char TT;
        int foo(int (aa (char)));
        int bar(int (TT (char)));
        `;
        let s2_ast = parse(s2);
        assertEqual(expand_decl(s2_ast.ext[1].type.args.params[0]),
            ['Decl', 'aa', ['FuncDecl',
                [['Typename', ['TypeDecl', ['IdentifierType', ['char']]]]],
                ['TypeDecl', ['IdentifierType', ['int']]]]]);
        assertEqual(expand_decl(s2_ast.ext[2].type.args.params[0]),
            ['Typename', ['FuncDecl',
                [['Typename', ['FuncDecl',
                    [['Typename', ['TypeDecl', ['IdentifierType', ['char']]]]],
                    ['TypeDecl', ['IdentifierType', ['TT']]]]]],
                ['TypeDecl', ['IdentifierType', ['int']]]]]);




        let s3 = String.raw`
        typedef char TT;
        int foo(int (aa[]));
        int bar(int (TT[]));
        `;
        let s3_ast = parse(s3);
        assertEqual(expand_decl(s3_ast.ext[1].type.args.params[0]),
            ['Decl', 'aa', ['ArrayDecl', '', [], ['TypeDecl', ['IdentifierType', ['int']]]]]);
        assertEqual(expand_decl(s3_ast.ext[2].type.args.params[0]),
            ['Typename', ['FuncDecl',
                [['Typename', ['ArrayDecl', '', [], ['TypeDecl', ['IdentifierType', ['TT']]]]]],
                ['TypeDecl', ['IdentifierType', ['int']]]]]);

    });
    test("test_innerscope_reuse_typedef_name", () => {


        let s1 = String.raw`
            typedef char TT;
            void foo(void) {
              unsigned TT;
              TT = 10;
            }
            TT x = 5;
            `;
        let s1_ast = parse(s1);
        assertEqual(expand_decl(s1_ast.ext[1].body.block_items[0]),
            ['Decl', 'TT', ['TypeDecl', ['IdentifierType', ['unsigned']]]]);
        assertEqual(expand_decl(s1_ast.ext[2]),
            ['Decl', 'x', ['TypeDecl', ['IdentifierType', ['TT']]]]);


        let s2 = String.raw`
            typedef char TT;
            void foo(void) {
              unsigned TT = 10;
            }
            `;
        let s2_ast = parse(s2);
        assertEqual(expand_decl(s2_ast.ext[1].body.block_items[0]),
            ['Decl', 'TT', ['TypeDecl', ['IdentifierType', ['unsigned']]]]);



        let s3 = String.raw`
            typedef char TT;
            void foo(void) {
              TT tt = sizeof(TT);
              unsigned TT = 10;
            }
            `;
        let s3_ast = parse(s3);
        assertEqual(expand_decl(s3_ast.ext[1].body.block_items[0]),
            ['Decl', 'tt', ['TypeDecl', ['IdentifierType', ['TT']]]]);
        assertEqual(expand_decl(s3_ast.ext[1].body.block_items[1]),
            ['Decl', 'TT', ['TypeDecl', ['IdentifierType', ['unsigned']]]]);


        let s4 = String.raw`
            typedef char TT;
            void foo(void) {
              TT TT = sizeof(TT);
              unsigned uu = TT * 2;
            }
            `;
        let s4_ast = parse(s4);
        assertEqual(expand_decl(s4_ast.ext[1].body.block_items[0]),
            ['Decl', 'TT', ['TypeDecl', ['IdentifierType', ['TT']]]]);
        assertEqual(expand_decl(s4_ast.ext[1].body.block_items[1]),
            ['Decl', 'uu', ['TypeDecl', ['IdentifierType', ['unsigned']]]]);



        let s5 = String.raw`
            typedef char TT;
            void foo(void) {
              unsigned TT = 10;
              TT erroneous = 20;
            }
            `;
        assertRaises(ParseError, parse, s5);


        let s6 = String.raw`
            typedef char TT;
            void foo(void) {
              unsigned TT, uu;
            }
            `;
        let s6_ast = parse(s6);
        let items = s6_ast.ext[1].body.block_items;
        assertEqual(expand_decl(items[0]),
            ['Decl', 'TT', ['TypeDecl', ['IdentifierType', ['unsigned']]]]);
        assertEqual(expand_decl(items[1]),
            ['Decl', 'uu', ['TypeDecl', ['IdentifierType', ['unsigned']]]]);


        let s7 = String.raw`
            typedef char TT;
            void foo(void) {
              unsigned * TT;
            }
            `;
        let s7_ast = parse(s7);
        items = s7_ast.ext[1].body.block_items;
        assertEqual(expand_decl(items[0]),
            ['Decl', 'TT', ['PtrDecl', ['TypeDecl', ['IdentifierType', ['unsigned']]]]]);


        let s8 = String.raw`
            typedef char TT;
            void foo(void) {
                int tt = sizeof(TT), TT, uu = sizeof(TT);
                int uu = sizeof(tt);
            }
            `;
        let s8_ast = parse(s8);
        items = s8_ast.ext[1].body.block_items;
        assertEqual(expand_decl(items[0]),
            ['Decl', 'tt', ['TypeDecl', ['IdentifierType', ['int']]]]);
        assertEqual(expand_decl(items[1]),
            ['Decl', 'TT', ['TypeDecl', ['IdentifierType', ['int']]]]);
        assertEqual(expand_decl(items[2]),
            ['Decl', 'uu', ['TypeDecl', ['IdentifierType', ['int']]]]);







    });
    test("test_parameter_reuse_typedef_name", () => {




        let s1 = String.raw`
            typedef char TT;
            void foo(unsigned TT, TT bar) {
              TT = 10;
            }
            TT x = 5;
            `;
        let s1_ast = parse(s1);
        assertEqual(expand_decl(s1_ast.ext[1].decl),
            ['Decl', 'foo',
                ['FuncDecl',
                    [   ['Decl', 'TT', ['TypeDecl', ['IdentifierType', ['unsigned']]]],
                        ['Decl', 'bar', ['TypeDecl', ['IdentifierType', ['TT']]]]],
                    ['TypeDecl', ['IdentifierType', ['void']]]]]);





        let s2 = String.raw`
            typedef char TT;
            void foo(unsigned TT, TT bar);
            TT x = 5;
            `;
        let s2_ast = parse(s2);
        assertEqual(expand_decl(s2_ast.ext[1]),
            ['Decl', 'foo',
                ['FuncDecl',
                    [   ['Decl', 'TT', ['TypeDecl', ['IdentifierType', ['unsigned']]]],
                        ['Decl', 'bar', ['TypeDecl', ['IdentifierType', ['TT']]]]],
                    ['TypeDecl', ['IdentifierType', ['void']]]]]);



        let s3 = String.raw`
            typedef char TT;
            void foo(unsigned TT, TT bar) {
              TT erroneous = 20;
            }
            `;
        assertRaises(ParseError, parse, s3);

    });
    test("test_nested_function_decls", () => {



        let s1 = String.raw`
            typedef char TT;
            void foo(unsigned bar(int TT)) {
              TT x = 10;
            }
            `;
        assertIsInstance(parse(s1), FileAST);

    });
    test("test_samescope_reuse_name", () => {

        let s1 = String.raw`
            typedef char TT;
            char TT = 5;
            `;
        assertRaises(ParseError, parse, s1);


        let s2 = String.raw`
            char TT = 5;
            typedef char TT;
            `;
        assertRaises(ParseError, parse, s2);

    });
    test("test_label_empty_statement", () => {

        let s1 = String.raw`
            int main() {
                int i = 0;
                label0: i++;
                label1:
            }
            `;
        let s1_ast = parse(s1);
        assertIsInstance(s1_ast.ext[0].body.block_items[1], Label);
        assertIsInstance(s1_ast.ext[0].body.block_items[1].stmt, UnaryOp);
        assertIsInstance(s1_ast.ext[0].body.block_items[2], Label);
        assertIsInstance(s1_ast.ext[0].body.block_items[2].stmt, EmptyStatement);

    });
    test("test_case_empty_statement", () => {

        let s1 = String.raw`
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
        let s2 = String.raw`
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
        let s1_ast = parse(s1);
        let s2_ast = parse(s2);
        assertIsInstance(s1_ast.ext[0].body.block_items[1], Switch);
        assertIsInstance(s1_ast.ext[0].body.block_items[1].stmt, Compound);
        assertIsInstance(s1_ast.ext[0].body.block_items[1].stmt.block_items[0], Case);
        assertIsInstance(s1_ast.ext[0].body.block_items[1].stmt.block_items[0].stmts[0], Assignment);
        assertIsInstance(s1_ast.ext[0].body.block_items[1].stmt.block_items[1], Case);
        assertIsInstance(s1_ast.ext[0].body.block_items[1].stmt.block_items[1].stmts[0], EmptyStatement);
        assertIsInstance(s2_ast.ext[0].body.block_items[1].stmt.block_items[1].stmts[0], EmptyStatement);

    });
});
