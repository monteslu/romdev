// ast_transforms.js - a port of pycparser's ast_transforms.py.
import * as c_ast from "./c_ast.js";

/**
 * Case statements come out of parsing with one child node, with the following
 * statements tucked into the parent Compound (and fall-through cases nested).
 * Regroup them so each Case/Default owns its statements.
 */
export function fix_switch_cases(switch_node) {
  if (!(switch_node instanceof c_ast.Switch)) throw new Error("AssertionError");
  if (!(switch_node.stmt instanceof c_ast.Compound)) return switch_node;
  const new_compound = new c_ast.Compound([], switch_node.stmt.coord);
  let last_case = null;
  for (const child of switch_node.stmt.block_items || []) {
    if (child instanceof c_ast.Case || child instanceof c_ast.Default) {
      new_compound.block_items.push(child);
      _extract_nested_case(child, new_compound.block_items);
      last_case = new_compound.block_items[new_compound.block_items.length - 1];
    } else if (last_case == null) {
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

class PyAttributeError extends Error {
  constructor(message) { super(message); this.name = "AttributeError"; }
}

/** `x.type` with Python semantics: AttributeError unless x is a node with a `type` field. */
function typeOf(x) {
  if (!c_ast.hasField(x, "type")) throw new PyAttributeError(`'${x == null ? "NoneType" : x.constructor.name}' object has no attribute 'type'`);
  return x.type;
}

/**
 * Fix a decl with _Atomic(type) specifiers: drop the spurious
 * Typename->TypeDecl pairs and attach the _Atomic qualifier in the right place.
 */
export function fix_atomic_specifiers(decl) {
  for (;;) {
    const [d, found] = _fix_atomic_specifiers_once(decl);
    decl = d;
    if (!found) break;
  }
  let typ = decl;
  while (!(typ instanceof c_ast.TypeDecl)) {
    try {
      typ = typeOf(typ);
    } catch (e) {
      if (e instanceof PyAttributeError) return decl;
      throw e;
    }
  }
  if (typ.quals.includes("_Atomic") && !decl.quals.includes("_Atomic")) decl.quals.push("_Atomic");
  if (typ.declname == null) typ.declname = decl.name;
  return decl;
}

function _fix_atomic_specifiers_once(decl) {
  let parent = decl;
  let grandparent = null;
  let node = decl.type;
  while (node != null) {
    if (node instanceof c_ast.Typename && node.quals.includes("_Atomic")) break;
    try {
      grandparent = parent;
      parent = node;
      node = typeOf(node);
    } catch (e) {
      if (e instanceof PyAttributeError) return [decl, false];
      throw e;
    }
  }
  if (!(parent instanceof c_ast.TypeDecl)) throw new Error("AssertionError");
  grandparent.type = typeOf(node);
  if (!node.type.quals.includes("_Atomic")) node.type.quals.push("_Atomic");
  return [decl, true];
}
