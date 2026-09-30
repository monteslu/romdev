// Port of m2c_pycparser/tests/test_c_generator.py (converted, then reviewed).
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { CParser } from "../../src/pycparser/c_parser.js";
import { CGenerator } from "../../src/pycparser/c_generator.js";
import * as c_ast from "../../src/pycparser/c_ast.js";
import { AssertionError } from "../../src/py.js";

const _c_parser = new CParser();
const assertEqual = (a, b) => assert.deepStrictEqual(a, b);
const assertTrue = (x, msg) => assert.ok(x, msg);
const count = (s, sub) => s.split(sub).length - 1;

/** Compare two ASTs recursively, just enough for testing (ignores coords). */
function compare_asts(ast1, ast2) {
  const ty = (x) => (x === null || x === undefined ? "None" : typeof x === "object" ? x.constructor : typeof x);
  if (ty(ast1) !== ty(ast2)) return false;
  if (Array.isArray(ast1)) {
    if (ast1.length !== ast2.length) return false;
    for (let i = 0; i < ast1.length; i++) if (!compare_asts(ast1[i], ast2[i])) return false;
    return true;
  }
  if (ast1 instanceof c_ast.Node) {
    for (const attr of ast1.attr_names) if (!compare_asts(ast1[attr], ast2[attr])) return false;
    const children1 = ast1.children();
    const children2 = ast2.children();
    if (children1.length !== children2.length) return false;
    for (let i = 0; i < children1.length; i++) if (!compare_asts(children1[i], children2[i])) return false;
    return true;
  }
  return ast1 === ast2;
}

function parse_to_ast(src) {
  return _c_parser.parse(src);
}

describe("TestFunctionDeclGeneration", () => {
  class _FuncDeclVisitor extends c_ast.NodeVisitor {
    constructor() {
      super();
      this.stubs = [];
    }
    visit_FuncDecl(node) {
      const gen = new CGenerator();
      this.stubs.push(gen.visit(node));
    }
  }
  test("test_partial_funcdecl_generation", () => {
    const src = String.raw`
            void noop(void);
            void *something(void *thing);
            int add(int x, int y);`;
    const ast = parse_to_ast(src);
    const v = new _FuncDeclVisitor();
    v.visit(ast);
    assertEqual(v.stubs.length, 3);
    assertTrue(v.stubs.includes("void noop(void)"));
    assertTrue(v.stubs.includes("void *something(void *thing)"));
    assertTrue(v.stubs.includes("int add(int x, int y)"));
  });
});

function _run_c_to_c(src, reduce_parentheses = false) {
  const ast = parse_to_ast(src);
  const generator = new CGenerator(reduce_parentheses);
  return generator.visit(ast);
}
function _assert_ctoc_correct(src, reduce_parentheses = false) {
  const src2 = _run_c_to_c(src, reduce_parentheses);
  assertTrue(compare_asts(parse_to_ast(src), parse_to_ast(src2)), `${JSON.stringify(src)} != ${JSON.stringify(src2)}`);
  return src2;
}

describe("TestCtoC", () => {
    test("test_trivial_decls", () => {
        _assert_ctoc_correct('int a;');
        _assert_ctoc_correct('int b, a;');
        _assert_ctoc_correct('int c, b, a;');
        _assert_ctoc_correct('auto int a;');
        _assert_ctoc_correct('register int a;');
        _assert_ctoc_correct('_Thread_local int a;');

    });
    test("test_complex_decls", () => {
        _assert_ctoc_correct('int** (*a)(void);');
        _assert_ctoc_correct('int** (*a)(void*, int);');
        _assert_ctoc_correct('int (*b)(char * restrict k, float);');
        _assert_ctoc_correct('int (*b)(char * _Atomic k, float);');
        _assert_ctoc_correct('int (*b)(char * _Atomic volatile k, float);');
        _assert_ctoc_correct('int test(const char* const* arg);');
        _assert_ctoc_correct('int test(const char** const arg);');

    });
    test("test_alignment", () => {
        _assert_ctoc_correct('_Alignas(32) int b;');
        _assert_ctoc_correct('int _Alignas(32) a;');
        _assert_ctoc_correct('_Alignas(32) _Atomic(int) b;');
        _assert_ctoc_correct('_Atomic(int) _Alignas(32) b;');
        _assert_ctoc_correct('_Alignas(long long) int a;');
        _assert_ctoc_correct('int _Alignas(long long) a;');
        _assert_ctoc_correct(String.raw`
            typedef struct node_t {
                _Alignas(64) void* next;
                int data;
            } node;
            `);
        _assert_ctoc_correct(String.raw`
            typedef struct node_t {
                void _Alignas(64) * next;
                int data;
            } node;
            `);

    });
    test("test_ternary", () => {
        _assert_ctoc_correct(`
            int main(void)
            {
                int a, b;
                (a == 0) ? (b = 1) : (b = 2);
            }`);

    });
    test("test_casts", () => {
        _assert_ctoc_correct(String.raw`
            int main() {
                int b = (int) f;
                int c = (int*) f;
            }`);
        _assert_ctoc_correct(String.raw`
            int main() {
                int a = (int) b + 8;
                int t = (int) c;
            }
        `);

    });
    test("test_initlist", () => {
        _assert_ctoc_correct('int arr[] = {1, 2, 3};');

    });
    test("test_exprs", () => {
        _assert_ctoc_correct(`
            int main(void)
            {
                int a;
                int b = a++;
                int c = ++a;
                int d = a--;
                int e = --a;
            }`);

    });
    test("test_statements", () => {

        _assert_ctoc_correct(String.raw`
            int main() {
                int a;
                a = 5;
                ;
                b = - - a;
                return a;
            }`);

    });
    test("test_struct_decl", () => {
        _assert_ctoc_correct(String.raw`
            typedef struct node_t {
                struct node_t* next;
                int data;
            } node;
            `);

    });
    test("test_krstyle", () => {
        _assert_ctoc_correct(String.raw`
            int main(argc, argv)
            int argc;
            char** argv;
            {
                return 0;
            }
        `);

    });
    test("test_switchcase", () => {
        _assert_ctoc_correct(String.raw`
        int main() {
            switch (myvar) {
            case 10:
            {
                k = 10;
                p = k + 1;
                break;
            }
            case 20:
            case 30:
                return 20;
            default:
                break;
            }
        }
        `);

    });
    test("test_nest_initializer_list", () => {
        _assert_ctoc_correct(String.raw`
        int main()
        {
           int i[1][1] = { { 1 } };
        }`);

    });
    test("test_nest_named_initializer", () => {
        _assert_ctoc_correct(String.raw`struct test
            {
                int i;
                struct test_i_t
                {
                    int k;
                } test_i;
                int j;
            };
            struct test test_var = {.i = 0, .test_i = {.k = 1}, .j = 2};
        `);

    });
    test("test_expr_list_in_initializer_list", () => {
        _assert_ctoc_correct(String.raw`
        int main()
        {
           int i[1] = { (1, 2) };
        }`);

    });
    test("test_issue36", () => {
        _assert_ctoc_correct(String.raw`
            int main() {
            }`);

    });
    test("test_issue37", () => {
        _assert_ctoc_correct(String.raw`
            int main(void)
            {
              unsigned size;
              size = sizeof(size);
              return 0;
            }`);

    });
    test("test_issue66", () => {


        _assert_ctoc_correct(String.raw`
            struct foo;
            `);


        _assert_ctoc_correct(String.raw`
            struct foo {};
            `);

    });
    test("test_issue83", () => {
        _assert_ctoc_correct(String.raw`
            void x(void) {
                int i = (9, k);
            }
            `);

    });
    test("test_issue84", () => {
        _assert_ctoc_correct(String.raw`
            void x(void) {
                for (int i = 0;;)
                    i;
            }
            `);

    });
    test("test_issue246", () => {
        _assert_ctoc_correct(String.raw`
            int array[3] = {[0] = 0, [1] = 1, [1+1] = 2};
            `);

    });
    test("test_noreturn", () => {
        _assert_ctoc_correct(String.raw`
            _Noreturn int x(void) {
                abort();
            }
            `);

    });
    test("test_exprlist_with_semi", () => {
        _assert_ctoc_correct(String.raw`
            void x() {
                if (i < j)
                    tmp = C[i], C[i] = C[j], C[j] = tmp;
                if (i <= j)
                    i++, j--;
            }
        `);

    });
    test("test_exprlist_with_compound", () => {
        _assert_ctoc_correct(String.raw`
            void test(){
                (sizeof (0), ({ if (0) ; else ; }));
            }
        `);

    });
    test("test_exprlist_with_subexprlist", () => {
        _assert_ctoc_correct(String.raw`
            void x() {
                (a = b, (b = c, c = a));
            }
        `);

    });
    test("test_comma_operator_funcarg", () => {
        _assert_ctoc_correct(String.raw`
            void f(int x) { return x; }
            int main(void) { f((1, 2)); return 0; }
        `);

    });
    test("test_comma_op_in_ternary", () => {
        _assert_ctoc_correct(String.raw`
            void f() {
                (0, 0) ? (0, 0) : (0, 0);
            }
        `);

    });
    test("test_comma_op_assignment", () => {
        _assert_ctoc_correct(String.raw`
            void f() {
                i = (a, b, c);
            }
        `);

    });
    test("test_pragma", () => {
        _assert_ctoc_correct(String.raw`
            #pragma foo
            void f() {
                #pragma bar
                i = (a, b, c);
                if (d)
                    #pragma qux
                    j = e;
                if (d)
                    #pragma qux
                    #pragma quux
                    j = e;
            }
            typedef struct s {
            #pragma baz
            } s;
        `);

    });
    test("test_compound_literal", () => {
        _assert_ctoc_correct('char **foo = (char *[]){ "x", "y", "z" };');
        _assert_ctoc_correct('int i = ++(int){ 1 };');
        _assert_ctoc_correct('struct foo_s foo = (struct foo_s){ 1, 2 };');

    });
    test("test_enum", () => {
        _assert_ctoc_correct(String.raw`
            enum e
            {
              a,
              b = 2,
              c = 3
            };
        `);
        _assert_ctoc_correct(String.raw`
            enum f
            {
                g = 4,
                h,
                i
            };
        `);

    });
    test("test_enum_typedef", () => {
        _assert_ctoc_correct('typedef enum EnumName EnumTypedefName;');

    });
    test("test_struct_union_enum_attributes", () => {
        _assert_ctoc_correct(String.raw`
            struct ForwardDeclaration __attribute__((packed));
        `);
        _assert_ctoc_correct(String.raw`
            struct StructName { int member; } __attribute__((packed));
        `);
        _assert_ctoc_correct(String.raw`
            union UnionName { int member; } __attribute__((packed));
        `);
        _assert_ctoc_correct(String.raw`
            enum EnumName { ENUM_VALUE } __attribute__((packed));
        `);

    });
    test("test_generate_struct_union_enum_exception", () => {
        const generator = new CGenerator();
        assert.throws(() => generator._generate_struct_union_enum(new c_ast.Struct("TestStruct", [], []), ""), AssertionError);
    });
    test("test_array_decl", () => {
        _assert_ctoc_correct('int g(const int a[const 20]){}');
        let ast = parse_to_ast('const int a[const 20];');
        let generator = new CGenerator();
        assertEqual(generator.visit(ast.ext[0].type),
                         'const int [const 20]');
        assertEqual(generator.visit(ast.ext[0].type.type),
                         'const int');

    });
    test("test_ptr_decl", () => {
        let src = 'const int ** const  x;';
        _assert_ctoc_correct(src);
        let ast = parse_to_ast(src);
        let generator = new CGenerator();
        assertEqual(generator.visit(ast.ext[0].type),
                         'const int ** const');
        assertEqual(generator.visit(ast.ext[0].type.type),
                         'const int *');
        assertEqual(generator.visit(ast.ext[0].type.type.type),
                         'const int');

    });
    test("test_atomic_qual", () => {
        _assert_ctoc_correct('_Atomic int x;');
        _assert_ctoc_correct('_Atomic int* x;');
        _assert_ctoc_correct('int* _Atomic x;');


        let s1 = '_Atomic(int) x;';
        let c1 = _run_c_to_c(s1);
        assertEqual(c1, '_Atomic int x;\n');
        _assert_ctoc_correct(s1);

        let s2 = '_Atomic(int*) x;';
        let c2 = _run_c_to_c(s2);
        assertEqual(c2, 'int * _Atomic x;\n');
        _assert_ctoc_correct(s2);

        let s3 = '_Atomic(_Atomic(int)*) x;';
        let c3 = _run_c_to_c(s3);
        assertEqual(c3, '_Atomic int * _Atomic x;\n');
        _assert_ctoc_correct(s3);





        let s4 = 'typedef _Atomic(int) atomic_int;';
        let c4 = _run_c_to_c(s4);
        assertEqual(c4, 'typedef _Atomic int atomic_int;\n');
        _assert_ctoc_correct(s4);

        let s5 = 'typedef _Atomic(_Atomic(_Atomic(int (*)(void)) *) *) t;';
        let c5 = _run_c_to_c(s5);
        assertEqual(c5, 'typedef int (* _Atomic * _Atomic * _Atomic t)(void);\n');
        _assert_ctoc_correct(s5);

        _assert_ctoc_correct(String.raw`
            typedef struct node_t {
                _Atomic(void*) a;
                _Atomic(void) *b;
                _Atomic void *c;
            } node;
            `);

    });
    test("test_nested_sizeof", () => {
        let src = '1';
        for (let _ = 0; _ < 30; _++) {
            src = 'sizeof(' + src + ')';
        }
        src = 'int x = ' + src + ';';
        _assert_ctoc_correct(src);

    });
    test("test_static_assert", () => {
        _assert_ctoc_correct('_Static_assert(sizeof(int) == sizeof(int), "123");');
        _assert_ctoc_correct('int main() { _Static_assert(sizeof(int) == sizeof(int), "123"); } ');
        _assert_ctoc_correct('_Static_assert(sizeof(int) == sizeof(int));');

    });
    test("test_reduce_parentheses_binaryops", () => {
        const c1 = 'int x = a + b + c + d;';
        assertEqual(_run_c_to_c(c1), 'int x = ((a + b) + c) + d;\n');
        assertEqual(_run_c_to_c(c1, true), 'int x = a + b + c + d;\n');
        const test_snippets = [
            'int x = a*b*c*d;',
            'int x = a+b*c*d;',
            'int x = a*b+c*d;',
            'int x = a*b*c+d;',
            'int x = (a+b)*c*d;',
            'int x = (a+b)*(c+d);',
            'int x = (a+b)/(c-d);',
            'int x = a+b-c-d;',
            'int x = a+(b-c)-d;'
        ];
        for (const src of test_snippets) {
            const src2 = _assert_ctoc_correct(src, true);
            assertTrue(count(src2, '(') === count(src, '('), `${src2} did not have minimum number of parenthesis, should be like ${src}.`);
        }
    });
});
describe("TestCasttoC", () => {
    test("test_to_type", () => {
        const src = 'int *x;';
        const generator = new CGenerator();
        const test_fun = new c_ast.FuncCall(new c_ast.ID('test_fun'), new c_ast.ExprList([]));
        const ast1 = parse_to_ast(src);
        const int_ptr_type = ast1.ext[0].type;
        const int_type = int_ptr_type.type;
        assertEqual(generator.visit(new c_ast.Cast(int_ptr_type, test_fun)), '(int *) test_fun()');
        assertEqual(generator.visit(new c_ast.Cast(int_type, test_fun)), '(int) test_fun()');
    });
    test("test_to_type_with_cpp", { skip: "needs the external C preprocessor (cpp); romdev's port has no cpp dependency" }, () => {});
    test("test_nested_else_if_line_breaks", () => {
        const generator = new CGenerator();
        const If = (...a) => new c_ast.If(...a);
        const Compound = (...a) => new c_ast.Compound(...a);
        const test_ast1 = If(null, null, null);
        const test_ast2 = If(null, null, If(null, null, null));
        const test_ast3 = If(null, null, If(null, null, If(null, null, null)));
        const test_ast4 = If(null, Compound([]), If(null, Compound([]), If(null, Compound([]), null)));
        assertEqual(generator.visit(test_ast1), 'if ()\n  \n');
        assertEqual(generator.visit(test_ast2), 'if ()\n  \nelse\n  if ()\n  \n');
        assertEqual(generator.visit(test_ast3), 'if ()\n  \nelse\n  if ()\n  \nelse\n  if ()\n  \n');
        assertEqual(generator.visit(test_ast4), 'if ()\n{\n}\nelse\n  if ()\n{\n}\nelse\n  if ()\n{\n}\n');
    });
});
