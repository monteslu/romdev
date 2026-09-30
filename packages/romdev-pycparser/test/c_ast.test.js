// Port of pycparser tests/test_c_ast.py.
import { test } from "node:test";
import assert from "node:assert/strict";
import { c_ast, NodeVisitor, nodeRepr } from "../src/index.js";

test("BinaryOp", () => {
  const b1 = new c_ast.BinaryOp({ op: "+", left: new c_ast.Constant({ type: "int", value: "6" }), right: new c_ast.ID({ name: "joe" }) });
  assert.ok(b1.left instanceof c_ast.Constant);
  assert.equal(b1.left.type, "int");
  assert.equal(b1.left.value, "6");
  assert.ok(b1.right instanceof c_ast.ID);
  assert.equal(b1.right.name, "joe");
});

test("weakref works on nodes", () => {
  // Python also checks weakref.getweakrefcount; JS has no such counter, so
  // only the dereference half of the upstream test is portable.
  const c1 = new c_ast.Constant({ type: "float", value: "3.14" });
  const wr = new WeakRef(c1);
  assert.equal(wr.deref().type, "float");
});

class ConstantVisitor extends NodeVisitor {
  constructor() { super(); this.values = []; }
  visit_Constant(node) { this.values.push(node.value); }
}

test("NodeVisitor scalar children", () => {
  const b1 = new c_ast.BinaryOp({ op: "+", left: new c_ast.Constant({ type: "int", value: "6" }), right: new c_ast.ID({ name: "joe" }) });
  let cv = new ConstantVisitor();
  cv.visit(b1);
  assert.deepEqual(cv.values, ["6"]);
  const b2 = new c_ast.BinaryOp({ op: "*", left: new c_ast.Constant({ type: "int", value: "111" }), right: b1 });
  const b3 = new c_ast.BinaryOp({ op: "^", left: b2, right: b1 });
  cv = new ConstantVisitor();
  cv.visit(b3);
  assert.deepEqual(cv.values, ["111", "6", "6"]);
});

function listTree() {
  const c1 = new c_ast.Constant({ type: "float", value: "5.6" });
  const c2 = new c_ast.Constant({ type: "char", value: "t" });
  const b1 = new c_ast.BinaryOp({ op: "+", left: c1, right: c2 });
  const b2 = new c_ast.BinaryOp({ op: "-", left: b1, right: c2 });
  return new c_ast.Compound({ block_items: [b1, b2, c1, c2] });
}

test("NodeVisitor list children", () => {
  const cv = new ConstantVisitor();
  cv.visit(listTree());
  assert.deepEqual(cv.values, ["5.6", "t", "5.6", "t", "t", "5.6", "t"]);
});

test("repr", () => {
  const expected = "Compound(block_items=[BinaryOp(op='+',\n"
    + "                               left=Constant(type='float',\n"
    + "                                             value='5.6'\n"
    + "                                             ),\n"
    + "                               right=Constant(type='char',\n"
    + "                                              value='t'\n"
    + "                                              )\n"
    + "                               ),\n"
    + "                      BinaryOp(op='-',\n"
    + "                               left=BinaryOp(op='+',\n"
    + "                                             left=Constant(type='float',\n"
    + "                                                           value='5.6'\n"
    + "                                                           ),\n"
    + "                                             right=Constant(type='char',\n"
    + "                                                            value='t'\n"
    + "                                                            )\n"
    + "                                             ),\n"
    + "                               right=Constant(type='char',\n"
    + "                                              value='t'\n"
    + "                                              )\n"
    + "                               ),\n"
    + "                      Constant(type='float',\n"
    + "                               value='5.6'\n"
    + "                               ),\n"
    + "                      Constant(type='char',\n"
    + "                               value='t'\n"
    + "                               )\n"
    + "                     ]\n"
    + "         )";
  assert.equal(nodeRepr(listTree()), expected);
});
