// pycparser: ast_transforms.js - AST fixups applied while parsing (port of
// m2c_pycparser/ast_transforms.py). Copyright (c) 2008-2022 Eli Bendersky,
// BSD licence (see NOTICE).
import * as c_ast from "./c_ast.js";
import { pyassert } from "../py.js";

/**
 * Regroup the statements under a switch so each Case/Default owns the
 * statements that follow it, and flatten nested fall-through cases.
 */
export function fix_switch_cases(switch_node) {
  pyassert(switch_node instanceof c_ast.Switch);
  if (!(switch_node.stmt instanceof c_ast.Compound)) return switch_node;

  const new_compound = new c_ast.Compound([], switch_node.stmt.coord);
  let last_case = null;
  for (const child of switch_node.stmt.block_items || []) {
    if (child instanceof c_ast.Case || child instanceof c_ast.Default) {
      new_compound.block_items.push(child);
      _extract_nested_case(child, new_compound.block_items);
      last_case = new_compound.block_items[new_compound.block_items.length - 1];
    } else if (last_case === null) {
      new_compound.block_items.push(child);
    } else {
      last_case.stmts.push(child);
    }
  }
  switch_node.stmt = new_compound;
  return switch_node;
}

function _extract_nested_case(case_node, stmts_list) {
  const first = case_node.stmts[0];
  if (first instanceof c_ast.Case || first instanceof c_ast.Default) {
    stmts_list.push(case_node.stmts.pop());
    _extract_nested_case(stmts_list[stmts_list.length - 1], stmts_list);
  }
}

const hasType = (n) => n !== null && n !== undefined && typeof n === "object" && Object.prototype.hasOwnProperty.call(n, "type");

/** Move _Atomic(type) qualifiers onto the right node. */
export function fix_atomic_specifiers(decl) {
  for (;;) {
    let found;
    [decl, found] = _fix_atomic_specifiers_once(decl);
    if (!found) break;
  }
  let typ = decl;
  while (!(typ instanceof c_ast.TypeDecl)) {
    if (!hasType(typ)) return decl;
    typ = typ.type;
  }
  if (typ.quals.includes("_Atomic") && !decl.quals.includes("_Atomic")) decl.quals.push("_Atomic");
  if (typ.declname === null || typ.declname === undefined) typ.declname = decl.name;
  return decl;
}

function _fix_atomic_specifiers_once(decl) {
  let parent = decl;
  let grandparent = null;
  let node = decl.type;
  while (node !== null && node !== undefined) {
    if (node instanceof c_ast.Typename && node.quals.includes("_Atomic")) break;
    if (!hasType(node)) return [decl, false];
    grandparent = parent;
    parent = node;
    node = node.type;
  }
  pyassert(parent instanceof c_ast.TypeDecl);
  if (node === null || node === undefined) throw new TypeError("'NoneType' object has no attribute 'type'");
  grandparent.type = node.type;
  if (!node.type.quals.includes("_Atomic")) node.type.quals.push("_Atomic");
  return [decl, true];
}
