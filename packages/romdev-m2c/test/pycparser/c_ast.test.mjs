// Port of m2c_pycparser/tests/test_c_ast.py and test_general.py.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import * as c_ast from "../../src/pycparser/c_ast.js";
import { CParser } from "../../src/pycparser/c_parser.js";

const M2C_DIR = process.env.M2C_SRC || path.join(os.homedir(), ".romdev", "tools", "m2c");
const C_FILES = path.join(M2C_DIR, "m2c_pycparser", "tests", "c_files");

describe("Test_c_ast", () => {
  test("test_BinaryOp", () => {
    const b1 = new c_ast.BinaryOp("+", new c_ast.Constant("int", "6"), new c_ast.ID("joe"));
    assert.ok(b1.left instanceof c_ast.Constant);
    assert.equal(b1.left.type, "int");
    assert.equal(b1.left.value, "6");
    assert.ok(b1.right instanceof c_ast.ID);
    assert.equal(b1.right.name, "joe");
  });
  test("test_weakref_works_on_nodes", { skip: "Python weakref semantics; JS has no equivalent test surface (WeakRef always works on objects)" }, () => {});
});

class ConstantVisitor extends c_ast.NodeVisitor {
  constructor() {
    super();
    this.values = [];
  }
  visit_Constant(node) {
    this.values.push(node.value);
  }
}

describe("TestNodeVisitor", () => {
  test("test_scalar_children", () => {
    const b1 = new c_ast.BinaryOp("+", new c_ast.Constant("int", "6"), new c_ast.ID("joe"));
    let cv = new ConstantVisitor();
    cv.visit(b1);
    assert.deepEqual(cv.values, ["6"]);
    const b2 = new c_ast.BinaryOp("*", new c_ast.Constant("int", "111"), b1);
    const b3 = new c_ast.BinaryOp("^", b2, b1);
    cv = new ConstantVisitor();
    cv.visit(b3);
    assert.deepEqual(cv.values, ["111", "6", "6"]);
  });

  test("tests_list_children", () => {
    const c1 = new c_ast.Constant("float", "5.6");
    const c2 = new c_ast.Constant("char", "t");
    const b1 = new c_ast.BinaryOp("+", c1, c2);
    const b2 = new c_ast.BinaryOp("-", b1, c2);
    const comp = new c_ast.Compound([b1, b2, c1, c2]);
    const cv = new ConstantVisitor();
    cv.visit(comp);
    assert.deepEqual(cv.values, ["5.6", "t", "5.6", "t", "t", "5.6", "t"]);
  });

  test("test_repr", () => {
    const c1 = new c_ast.Constant("float", "5.6");
    const c2 = new c_ast.Constant("char", "t");
    const b1 = new c_ast.BinaryOp("+", c1, c2);
    const b2 = new c_ast.BinaryOp("-", b1, c2);
    const comp = new c_ast.Compound([b1, b2, c1, c2]);
    const expected =
      "Compound(block_items=[BinaryOp(op='+',\n" +
      "                               left=Constant(type='float',\n" +
      "                                             value='5.6'\n" +
      "                                             ),\n" +
      "                               right=Constant(type='char',\n" +
      "                                              value='t'\n" +
      "                                              )\n" +
      "                               ),\n" +
      "                      BinaryOp(op='-',\n" +
      "                               left=BinaryOp(op='+',\n" +
      "                                             left=Constant(type='float',\n" +
      "                                                           value='5.6'\n" +
      "                                                           ),\n" +
      "                                             right=Constant(type='char',\n" +
      "                                                            value='t'\n" +
      "                                                            )\n" +
      "                                             ),\n" +
      "                               right=Constant(type='char',\n" +
      "                                              value='t'\n" +
      "                                              )\n" +
      "                               ),\n" +
      "                      Constant(type='float',\n" +
      "                               value='5.6'\n" +
      "                               ),\n" +
      "                      Constant(type='char',\n" +
      "                               value='t'\n" +
      "                               )\n" +
      "                     ]\n" +
      "         )";
    assert.equal(comp.__repr__(), expected);
  });
});

// test_general.py: parse_file() without cpp. The cpp-based cases need an
// external C preprocessor, which the JS port deliberately does not use.
describe("TestParsing", () => {
  const parse_file = (p) => new CParser().parse(fs.readFileSync(p, "utf8").replace(/\r\n?/g, "\n"), p);
  test("test_without_cpp", { skip: !fs.existsSync(C_FILES) && "m2c checkout with pycparser test c_files not found" }, () => {
    const ast = parse_file(path.join(C_FILES, "example_c_file.c"));
    assert.ok(ast instanceof c_ast.FileAST);
  });
  for (const name of ["test_with_cpp", "test_cpp_funkydir", "test_no_real_content_after_cpp", "test_c11_with_cpp"]) {
    test(name, { skip: "needs the external C preprocessor (cpp)" }, () => {});
  }
});
