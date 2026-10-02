// Port of pycparser tests/test_c_generator.py.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { CParser, CGenerator, NodeVisitor, c_ast, AssertionError } from "../src/index.js";
import { compareAsts } from "./helpers.js";
import { parse_file_with_cpp, cFile, CPP_SKIP } from "./cpp.js";

const _c_parser = new CParser();
const parseToAst = (src) => _c_parser.parse(src);

describe("TestFunctionDeclGeneration", () => {
  test("partial funcdecl generation", () => {
    const src = String.raw`
            void noop(void);
            void *something(void *thing);
            int add(int x, int y);`;
    const ast = parseToAst(src);
    const stubs = [];
    class V extends NodeVisitor {
      visit_FuncDecl(node) { stubs.push(new CGenerator().visit(node)); }
    }
    new V().visit(ast);
    assert.equal(stubs.length, 3);
    assert.ok(stubs.includes("void noop(void)"));
    assert.ok(stubs.includes("void *something(void *thing)"));
    assert.ok(stubs.includes("int add(int x, int y)"));
  });
});

const runCtoC = (src, reduce_parentheses = false) => new CGenerator(reduce_parentheses).visit(parseToAst(src));

function assertCtoC(src, reduce_parentheses = false) {
  const src2 = runCtoC(src, reduce_parentheses);
  assert.ok(compareAsts(parseToAst(src), parseToAst(src2)), `${JSON.stringify(src)} != ${JSON.stringify(src2)}`);
  return src2;
}

describe("TestCtoC", () => {
  test("trivial decls", () => {
    assertCtoC("int a;");
    assertCtoC("int b, a;");
    assertCtoC("int c, b, a;");
    assertCtoC("auto int a;");
    assertCtoC("register int a;");
    assertCtoC("_Thread_local int a;");
  });

  test("complex decls", () => {
    assertCtoC("int** (*a)(void);");
    assertCtoC("int** (*a)(void*, int);");
    assertCtoC("int (*b)(char * restrict k, float);");
    assertCtoC("int (*b)(char * _Atomic k, float);");
    assertCtoC("int (*b)(char * _Atomic volatile k, float);");
    assertCtoC("int test(const char* const* arg);");
    assertCtoC("int test(const char** const arg);");
  });

  test("alignment", () => {
    assertCtoC("_Alignas(32) int b;");
    assertCtoC("int _Alignas(32) a;");
    assertCtoC("_Alignas(32) _Atomic(int) b;");
    assertCtoC("_Atomic(int) _Alignas(32) b;");
    assertCtoC("_Alignas(long long) int a;");
    assertCtoC("int _Alignas(long long) a;");
    assertCtoC(`
            typedef struct node_t {
                _Alignas(64) void* next;
                int data;
            } node;
            `);
    assertCtoC(`
            typedef struct node_t {
                void _Alignas(64) * next;
                int data;
            } node;
            `);
  });

  test("ternary", () => {
    assertCtoC(`
            int main(void)
            {
                int a, b;
                (a == 0) ? (b = 1) : (b = 2);
            }`);
  });

  test("casts", () => {
    assertCtoC(`
            int main() {
                int b = (int) f;
                int c = (int*) f;
            }`);
    assertCtoC(`
            int main() {
                int a = (int) b + 8;
                int t = (int) c;
            }
        `);
  });

  test("initlist", () => assertCtoC("int arr[] = {1, 2, 3};"));

  test("exprs", () => {
    assertCtoC(`
            int main(void)
            {
                int a;
                int b = a++;
                int c = ++a;
                int d = a--;
                int e = --a;
            }`);
  });

  test("statements", () => {
    assertCtoC(`
            int main() {
                int a;
                a = 5;
                ;
                b = - - a;
                return a;
            }`);
  });

  test("struct decl", () => {
    assertCtoC(`
            typedef struct node_t {
                struct node_t* next;
                int data;
            } node;
            `);
  });

  test("krstyle", () => {
    assertCtoC(`
            int main(argc, argv)
            int argc;
            char** argv;
            {
                return 0;
            }
        `);
  });

  test("switchcase", () => {
    assertCtoC(`
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

  test("nest initializer list", () => {
    assertCtoC(`
        int main()
        {
           int i[1][1] = { { 1 } };
        }`);
  });

  test("nest named initializer", () => {
    assertCtoC(`struct test
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

  test("expr list in initializer list", () => {
    assertCtoC(`
        int main()
        {
           int i[1] = { (1, 2) };
        }`);
  });

  test("issue36", () => {
    assertCtoC(`
            int main() {
            }`);
  });

  test("issue37", () => {
    assertCtoC(`
            int main(void)
            {
              unsigned size;
              size = sizeof(size);
              return 0;
            }`);
  });

  test("issue66", () => {
    assertCtoC(`
            struct foo;
            `);
    assertCtoC(`
            struct foo {};
            `);
  });

  test("issue83", () => {
    assertCtoC(`
            void x(void) {
                int i = (9, k);
            }
            `);
  });

  test("issue84", () => {
    assertCtoC(`
            void x(void) {
                for (int i = 0;;)
                    i;
            }
            `);
  });

  test("issue246", () => {
    assertCtoC(`
            int array[3] = {[0] = 0, [1] = 1, [1+1] = 2};
            `);
  });

  test("noreturn", () => {
    assertCtoC(`
            _Noreturn int x(void) {
                abort();
            }
            `);
  });

  test("exprlist with semi", () => {
    assertCtoC(`
            void x() {
                if (i < j)
                    tmp = C[i], C[i] = C[j], C[j] = tmp;
                if (i <= j)
                    i++, j--;
            }
        `);
  });

  test("exprlist with compound", () => {
    assertCtoC(`
            void test(){
                (sizeof (0), ({ if (0) ; else ; }));
            }
        `);
  });

  test("exprlist with subexprlist", () => {
    assertCtoC(`
            void x() {
                (a = b, (b = c, c = a));
            }
        `);
  });

  test("comma operator funcarg", () => {
    assertCtoC(`
            void f(int x) { return x; }
            int main(void) { f((1, 2)); return 0; }
        `);
  });

  test("comma op in ternary", () => {
    assertCtoC(`
            void f() {
                (0, 0) ? (0, 0) : (0, 0);
            }
        `);
  });

  test("comma op assignment", () => {
    assertCtoC(`
            void f() {
                i = (a, b, c);
            }
        `);
  });

  test("pragma", () => {
    assertCtoC(`
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

  test("compound literal", () => {
    assertCtoC("char **foo = (char *[]){ \"x\", \"y\", \"z\" };");
    assertCtoC("int i = ++(int){ 1 };");
    assertCtoC("struct foo_s foo = (struct foo_s){ 1, 2 };");
  });

  test("enum", () => {
    assertCtoC(`
            enum e
            {
              a,
              b = 2,
              c = 3
            };
        `);
    assertCtoC(`
            enum f
            {
                g = 4,
                h,
                i
            };
        `);
  });

  test("enum typedef", () => assertCtoC("typedef enum EnumName EnumTypedefName;"));

  test("struct union enum attributes", () => {
    assertCtoC(`
            struct ForwardDeclaration __attribute__((packed));
        `);
    assertCtoC(`
            struct StructName { int member; } __attribute__((packed));
        `);
    assertCtoC(`
            union UnionName { int member; } __attribute__((packed));
        `);
    assertCtoC(`
            enum EnumName { ENUM_VALUE } __attribute__((packed));
        `);
  });

  test("generate struct union enum exception", () => {
    const generator = new CGenerator();
    assert.throws(() => generator._generate_struct_union_enum(
      new c_ast.Struct({ name: "TestStruct", gcc_attributes: [], decls: [] }), ""), AssertionError);
  });

  test("array decl", () => {
    assertCtoC("int g(const int a[const 20]){}");
    const ast = parseToAst("const int a[const 20];");
    const generator = new CGenerator();
    assert.equal(generator.visit(ast.ext[0].type), "const int [const 20]");
    assert.equal(generator.visit(ast.ext[0].type.type), "const int");
  });

  test("ptr decl", () => {
    const src = "const int ** const  x;";
    assertCtoC(src);
    const ast = parseToAst(src);
    const generator = new CGenerator();
    assert.equal(generator.visit(ast.ext[0].type), "const int ** const");
    assert.equal(generator.visit(ast.ext[0].type.type), "const int *");
    assert.equal(generator.visit(ast.ext[0].type.type.type), "const int");
  });

  test("atomic qual", () => {
    assertCtoC("_Atomic int x;");
    assertCtoC("_Atomic int* x;");
    assertCtoC("int* _Atomic x;");
    const s1 = "_Atomic(int) x;";
    assert.equal(runCtoC(s1), "_Atomic int x;\n");
    assertCtoC(s1);
    const s2 = "_Atomic(int*) x;";
    assert.equal(runCtoC(s2), "int * _Atomic x;\n");
    assertCtoC(s2);
    const s3 = "_Atomic(_Atomic(int)*) x;";
    assert.equal(runCtoC(s3), "_Atomic int * _Atomic x;\n");
    assertCtoC(s3);
    const s4 = "typedef _Atomic(int) atomic_int;";
    assert.equal(runCtoC(s4), "typedef _Atomic int atomic_int;\n");
    assertCtoC(s4);
    const s5 = "typedef _Atomic(_Atomic(_Atomic(int (*)(void)) *) *) t;";
    assert.equal(runCtoC(s5), "typedef int (* _Atomic * _Atomic * _Atomic t)(void);\n");
    assertCtoC(s5);
    assertCtoC(`
            typedef struct node_t {
                _Atomic(void*) a;
                _Atomic(void) *b;
                _Atomic void *c;
            } node;
            `);
  });

  test("nested sizeof", () => {
    let src = "1";
    for (let i = 0; i < 30; i++) src = "sizeof(" + src + ")";
    assertCtoC("int x = " + src + ";");
  });

  test("static assert", () => {
    assertCtoC("_Static_assert(sizeof(int) == sizeof(int), \"123\");");
    assertCtoC("int main() { _Static_assert(sizeof(int) == sizeof(int), \"123\"); } ");
    assertCtoC("_Static_assert(sizeof(int) == sizeof(int));");
  });

  test("reduce parentheses binaryops", () => {
    const c1 = "int x = a + b + c + d;";
    assert.equal(runCtoC(c1), "int x = ((a + b) + c) + d;\n");
    assert.equal(runCtoC(c1, true), "int x = a + b + c + d;\n");
    const snippets = [
      "int x = a*b*c*d;",
      "int x = a+b*c*d;",
      "int x = a*b+c*d;",
      "int x = a*b*c+d;",
      "int x = (a+b)*c*d;",
      "int x = (a+b)*(c+d);",
      "int x = (a+b)/(c-d);",
      "int x = a+b-c-d;",
      "int x = a+(b-c)-d;",
    ];
    for (const src of snippets) {
      const src2 = assertCtoC(src, true);
      const count = (s) => s.split("(").length - 1;
      assert.equal(count(src2), count(src), `${src2} did not have minimum number of parenthesis, should be like ${src}.`);
    }
  });
});

describe("TestCasttoC", () => {
  test("to type", () => {
    const generator = new CGenerator();
    const test_fun = new c_ast.FuncCall(new c_ast.ID("test_fun"), new c_ast.ExprList([]));
    const ast1 = parseToAst("int *x;");
    const int_ptr_type = ast1.ext[0].type;
    const int_type = int_ptr_type.type;
    assert.equal(generator.visit(new c_ast.Cast(int_ptr_type, test_fun)), "(int *) test_fun()");
    assert.equal(generator.visit(new c_ast.Cast(int_type, test_fun)), "(int) test_fun()");
  });

  test("to type with cpp", { skip: CPP_SKIP }, async () => {
    const generator = new CGenerator();
    const test_fun = new c_ast.FuncCall(new c_ast.ID("test_fun"), new c_ast.ExprList([]));
    const ast2 = await parse_file_with_cpp(cFile("memmgr.h"));
    const void_ptr_type = ast2.ext.at(-3).type.type;
    const void_type = void_ptr_type.type;
    assert.equal(generator.visit(new c_ast.Cast(void_ptr_type, test_fun)), "(void *) test_fun()");
    assert.equal(generator.visit(new c_ast.Cast(void_type, test_fun)), "(void) test_fun()");
  });

  test("nested else if line breaks", () => {
    const generator = new CGenerator();
    const If = c_ast.If, C = c_ast.Compound;
    const a1 = new If(null, null, null);
    const a2 = new If(null, null, new If(null, null, null));
    const a3 = new If(null, null, new If(null, null, new If(null, null, null)));
    const a4 = new If(null, new C([]), new If(null, new C([]), new If(null, new C([]), null)));
    assert.equal(generator.visit(a1), "if ()\n  \n");
    assert.equal(generator.visit(a2), "if ()\n  \nelse\n  if ()\n  \n");
    assert.equal(generator.visit(a3), "if ()\n  \nelse\n  if ()\n  \nelse\n  if ()\n  \n");
    assert.equal(generator.visit(a4), "if ()\n{\n}\nelse\n  if ()\n{\n}\nelse\n  if ()\n{\n}\n");
  });
});
