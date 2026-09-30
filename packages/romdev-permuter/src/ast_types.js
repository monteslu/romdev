// ast_types.js - a port of decomp-permuter's src/ast_types.py: expression
// typing over the C AST, with the upstream simplifications (const/volatile
// ignored, int-like arithmetic promotes to int, one namespace for variables).
import { c_ast as ca, Node } from "romdev-pycparser";

const isa = (x, ...classes) => x != null && classes.some((c) => x instanceof c);

export class AssertionError extends Error {
  constructor(message = "") { super(message); this.name = "AssertionError"; }
}
function assert(cond, msg) { if (!cond) throw new AssertionError(msg); }

export class KeyError extends Error {
  constructor(key) { super(String(key)); this.name = "KeyError"; }
}

/** @typedef {{typedefs: Map<string, any>, var_types: Map<string, any>, local_vars: Set<string>, struct_defs: Map<string, any>}} TypeMap */

/** @returns {TypeMap} */
export function newTypeMap() {
  return { typedefs: new Map(), var_types: new Map(), local_vars: new Set(), struct_defs: new Map() };
}

export function is_local_var(name, typemap) { return typemap.local_vars.has(name); }

export function basic_type(name) {
  const names = typeof name === "string" ? [name] : name;
  const idtype = new ca.IdentifierType({ names });
  return new ca.TypeDecl({ declname: null, quals: [], align: [], type: idtype });
}

export function pointer(type) { return new ca.PtrDecl({ quals: [], type }); }

export function resolve_typedefs(type, typemap) {
  while (type instanceof ca.TypeDecl && type.type instanceof ca.IdentifierType && type.type.names.length === 1
    && typemap.typedefs.has(type.type.names[0])) {
    type = typemap.typedefs.get(type.type.names[0]);
  }
  return type;
}

export function pointer_decay(type, typemap) {
  const real_type = resolve_typedefs(type, typemap);
  if (real_type instanceof ca.ArrayDecl) return pointer(real_type.type);
  if (real_type instanceof ca.FuncDecl) return pointer(type);
  if (real_type instanceof ca.TypeDecl && real_type.type instanceof ca.Enum) return basic_type("int");
  assert(!isa(type, ca.ArrayDecl, ca.FuncDecl), "resolve_typedefs can't hide arrays/functions");
  return type;
}

export function get_decl_type(decl) {
  assert(decl.name != null);
  assert(isa(decl.type, ca.PtrDecl, ca.ArrayDecl, ca.FuncDecl, ca.TypeDecl));
  return decl.type;
}

export function deref_type(type, typemap) {
  type = resolve_typedefs(type, typemap);
  assert(isa(type, ca.ArrayDecl, ca.PtrDecl), "dereferencing non-pointer");
  return type.type;
}

export function struct_member_type(struct, field_name, typemap) {
  if (!truthy(struct.decls)) {
    assert(typemap.struct_defs.has(struct.name), `Accessing field ${field_name} of undefined struct ${struct.name}`);
    struct = typemap.struct_defs.get(struct.name);
  }
  assert(truthy(struct.decls), "struct_defs never points to an incomplete type");
  for (const decl of struct.decls) {
    if (decl instanceof ca.Decl) {
      if (decl.name === field_name) return get_decl_type(decl);
      if (decl.name == null && isa(decl.type, ca.Struct, ca.Union)) {
        try {
          return struct_member_type(decl.type, field_name, typemap);
        } catch (e) {
          if (!(e instanceof AssertionError)) throw e;
        }
      }
    }
  }
  assert(false, `No field ${field_name} in struct ${struct.name}`);
}

const truthy = (v) => !(v == null || v === false || v === "" || (Array.isArray(v) && v.length === 0));

function varType(typemap, name) {
  if (!typemap.var_types.has(name)) throw new KeyError(name);
  return typemap.var_types.get(name);
}

export function expr_type(node, typemap) {
  const rec = (sub) => expr_type(sub, typemap);
  if (node instanceof ca.Assignment) return rec(node.lvalue);
  if (node instanceof ca.StructRef) {
    let lhs_type = rec(node.name);
    if (node.type === "->") lhs_type = deref_type(lhs_type, typemap);
    const struct_type = resolve_typedefs(lhs_type, typemap);
    assert(struct_type instanceof ca.TypeDecl);
    assert(isa(struct_type.type, ca.Struct, ca.Union), `struct deref of non-struct ${struct_type.declname}`);
    return struct_member_type(struct_type.type, node.field.name, typemap);
  }
  if (node instanceof ca.Cast) return node.to_type.type;
  if (node instanceof ca.Constant) {
    if (node.type === "string") return pointer(basic_type("char"));
    if (node.type === "char") return basic_type("int");
    return basic_type(node.type.split(" "));
  }
  if (node instanceof ca.ID) return varType(typemap, node.name);
  if (node instanceof ca.UnaryOp) {
    if (["p++", "p--", "++", "--"].includes(node.op)) return rec(node.expr);
    if (node.op === "&") return pointer(rec(node.expr));
    if (node.op === "*") return deref_type(rec(node.expr), typemap);
    if (node.op === "-" || node.op === "+") {
      const subtype = pointer_decay(rec(node.expr), typemap);
      if (allowed_basic_type(subtype, typemap, ["double"])) return basic_type("double");
      if (allowed_basic_type(subtype, typemap, ["float"])) return basic_type("float");
    }
    if (["sizeof", "-", "+", "~", "!"].includes(node.op)) return basic_type("int");
    assert(false, `unknown unary op ${node.op}`);
  }
  if (node instanceof ca.BinaryOp) {
    const lhs_type = pointer_decay(rec(node.left), typemap);
    const rhs_type = pointer_decay(rec(node.right), typemap);
    if (node.op === ">>" || node.op === "<<") return lhs_type;
    if (["<", "<=", ">", ">=", "==", "!=", "&&", "||"].includes(node.op)) return basic_type("int");
    if ("&|^%".includes(node.op)) return basic_type("int");
    const real_lhs = resolve_typedefs(lhs_type, typemap);
    const real_rhs = resolve_typedefs(rhs_type, typemap);
    if ("+-".includes(node.op)) {
      const lptr = real_lhs instanceof ca.PtrDecl;
      const rptr = real_rhs instanceof ca.PtrDecl;
      if (lptr || rptr) {
        if (lptr && rptr) {
          assert(node.op !== "+", "pointer + pointer");
          return basic_type("int");
        }
        if (lptr) return lhs_type;
        assert(node.op === "+", "int - pointer");
        return rhs_type;
      }
    }
    if ("*/+-".includes(node.op)) {
      assert(real_lhs instanceof ca.TypeDecl);
      assert(real_rhs instanceof ca.TypeDecl);
      assert(real_lhs.type instanceof ca.IdentifierType);
      assert(real_rhs.type instanceof ca.IdentifierType);
      const names = real_lhs.type.names.concat(real_rhs.type.names);
      if (names.includes("double")) return basic_type("double");
      if (names.includes("float")) return basic_type("float");
      return basic_type("int");
    }
  }
  if (node instanceof ca.FuncCall) {
    let fptr_type = resolve_typedefs(rec(node.name), typemap);
    if (fptr_type instanceof ca.PtrDecl) fptr_type = fptr_type.type;
    fptr_type = resolve_typedefs(fptr_type, typemap);
    assert(fptr_type instanceof ca.FuncDecl, "call to non-function");
    return fptr_type.type;
  }
  if (node instanceof ca.ExprList) return rec(node.exprs[node.exprs.length - 1]);
  if (node instanceof ca.ArrayRef) return deref_type(rec(node.name), typemap);
  if (node instanceof ca.TernaryOp) return rec(node.iftrue);
  assert(false, `Unknown expression node type: ${node?.constructor?.name}`);
}

export function decayed_expr_type(expr, typemap) { return pointer_decay(expr_type(expr, typemap), typemap); }

function _same_param_type(p1, p2, typemap) {
  if (p1 instanceof ca.EllipsisParam && p2 instanceof ca.EllipsisParam) return true;
  if (p1 instanceof ca.ID && p2 instanceof ca.ID) return p1.name === p2.name;
  if (isa(p1, ca.Typename, ca.Decl) && isa(p2, ca.Typename, ca.Decl)
    && isa(p1.type, ca.PtrDecl, ca.ArrayDecl, ca.TypeDecl, ca.FuncDecl)
    && isa(p2.type, ca.PtrDecl, ca.ArrayDecl, ca.TypeDecl, ca.FuncDecl)
    && same_type(p1.type, p2.type, typemap)) return true;
  return false;
}

export function same_type(type1, type2, typemap, allow_similar = false) {
  for (;;) {
    type1 = resolve_typedefs(type1, typemap);
    type2 = resolve_typedefs(type2, typemap);
    if (type1 instanceof ca.ArrayDecl && type2 instanceof ca.ArrayDecl) { type1 = type1.type; type2 = type2.type; continue; }
    if (type1 instanceof ca.PtrDecl && type2 instanceof ca.PtrDecl) { type1 = type1.type; type2 = type2.type; continue; }
    if (type1 instanceof ca.TypeDecl && type2 instanceof ca.TypeDecl) {
      const sub1 = type1.type, sub2 = type2.type;
      if (sub1 instanceof ca.Struct && sub2 instanceof ca.Struct) return sub1.name === sub2.name;
      if (sub1 instanceof ca.Union && sub2 instanceof ca.Union) return sub1.name === sub2.name;
      if (allow_similar && isa(sub1, ca.IdentifierType, ca.Enum) && isa(sub2, ca.IdentifierType, ca.Enum)) return true;
      if (sub1 instanceof ca.Enum && sub2 instanceof ca.Enum) return sub1.name === sub2.name;
      if (sub1 instanceof ca.IdentifierType && sub2 instanceof ca.IdentifierType) {
        const a = sub1.names.slice().sort(), b = sub2.names.slice().sort();
        return a.length === b.length && a.every((x, i) => x === b[i]);
      }
    }
    if (type1 instanceof ca.FuncDecl && type2 instanceof ca.FuncDecl) {
      const params1 = type1.args ? type1.args.params : [];
      const params2 = type2.args ? type2.args.params : [];
      if (params1.length !== params2.length) return false;
      for (let i = 0; i < params1.length; i++) if (!_same_param_type(params1[i], params2[i], typemap)) return false;
      type1 = type1.type;
      type2 = type2.type;
      allow_similar = false;
      continue;
    }
    return false;
  }
}

/** Does a type resolve to a basic type with one of the allowed keywords in it? */
export function allowed_basic_type(type, typemap, allowed_types) {
  const base_type = resolve_typedefs(type, typemap);
  if (!(base_type instanceof ca.TypeDecl)) return false;
  if (!(base_type.type instanceof ca.IdentifierType)) return false;
  if (allowed_types.every((x) => !base_type.type.names.includes(x))) return false;
  return true;
}

export function build_typemap(ast, target_fn) {
  const ret = newTypeMap();
  for (const item of ast.ext) if (item instanceof ca.Typedef) ret.typedefs.set(item.name, item.type);
  let within_fn = false;
  const visit = (node) => {
    if (node instanceof ca.Struct || node instanceof ca.Union) {
      if (truthy(node.decls) && node.name != null) ret.struct_defs.set(node.name, node);
      return;
    }
    if (node instanceof ca.FuncDecl) { visit(node.type); return; }
    if (node instanceof ca.Decl) {
      if (node.name != null) {
        ret.var_types.set(node.name, get_decl_type(node));
        if (within_fn) ret.local_vars.add(node.name);
      }
      visit(node.type);
      return;
    }
    if (node instanceof ca.Enumerator) { ret.var_types.set(node.name, basic_type("int")); return; }
    if (node instanceof ca.FuncDef) {
      assert(node.decl.type instanceof ca.FuncDecl);
      if (node.decl.name == null) return;
      ret.var_types.set(node.decl.name, get_decl_type(node.decl));
      if (node === target_fn) {
        within_fn = true;
        if (node.decl.type.args) visit(node.decl.type.args);
        visit(node.body);
        within_fn = false;
      }
      return;
    }
    for (const c of node) visit(c);
  };
  visit(ast);
  return ret;
}

export function set_decl_name(decl) {
  const name = decl.name;
  assert(name != null);
  let type = get_decl_type(decl);
  while (!(type instanceof ca.TypeDecl)) type = type.type;
  type.declname = name;
}

export { Node };
