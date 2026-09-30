// Shared helpers for the ported pycparser tests.
import { Node } from "../src/index.js";

function pyType(x) {
  if (x === null || x === undefined) return "NoneType";
  if (Array.isArray(x)) return "list";
  if (x instanceof Node) return "node:" + x.constructor.name;
  if (typeof x === "object") return "obj:" + x.constructor.name;
  return typeof x;
}

/** tests/test_c_generator.py compare_asts */
export function compareAsts(ast1, ast2) {
  if (pyType(ast1) !== pyType(ast2)) return false;
  if (Array.isArray(ast1)) {
    if (ast1.length !== ast2.length) return false;
    for (let i = 0; i < ast1.length; i++) if (!compareAsts(ast1[i], ast2[i])) return false;
    return true;
  }
  if (ast1 instanceof Node) {
    for (const attr of ast1.attr_names) if (!compareAsts(ast1[attr], ast2[attr])) return false;
    const c1 = ast1.children(), c2 = ast2.children();
    if (c1.length !== c2.length) return false;
    for (let i = 0; i < c1.length; i++) if (!compareAsts(c1[i], c2[i])) return false;
    return true;
  }
  if (ast1 == null) return true;
  return ast1 === ast2;
}
