// ast_util.js - a port of decomp-permuter's src/ast_util.py.
import { c_ast as ca, CParser, CGenerator, ParseError, Node } from "romdev-pycparser";
import { CandidateConstructionFailure } from "./error.js";
import { set_decl_name } from "./ast_types.js";

/** isinstance(x, (A, B, ...)) */
export const isa = (x, ...classes) => x != null && classes.some((c) => x instanceof c);

export class AssertionError extends Error {
  constructor(message = "") { super(message); this.name = "AssertionError"; }
}
export function assert(cond, msg) { if (!cond) throw new AssertionError(msg); }

/** Python truthiness for AST field values (None, '', [], nodes). */
export const truthy = (v) => !(v == null || v === false || v === 0 || v === "" || (Array.isArray(v) && v.length === 0));

/** copy.copy of a node: same class, same field values (lists shared). */
export function shallowCopy(node) {
  const out = Object.create(Object.getPrototypeOf(node));
  for (const k of Object.keys(node)) out[k] = node[k];
  return out;
}

/** copy.deepcopy of nodes/lists/dicts, preserving sharing within the copied graph. Coords stay shared. */
export function deepcopy(x, memo = new Map()) {
  if (x == null || typeof x !== "object") return x;
  if (memo.has(x)) return memo.get(x);
  if (Array.isArray(x)) {
    const out = [];
    memo.set(x, out);
    for (const e of x) out.push(deepcopy(e, memo));
    return out;
  }
  if (x instanceof Node) {
    const out = Object.create(Object.getPrototypeOf(x));
    memo.set(x, out);
    for (const k of Object.keys(x)) out[k] = k === "coord" ? x[k] : deepcopy(x[k], memo);
    return out;
  }
  if (x instanceof Map) {
    const out = new Map();
    memo.set(x, out);
    for (const [k, v] of x) out.set(deepcopy(k, memo), deepcopy(v, memo));
    return out;
  }
  if (Object.getPrototypeOf(x) === Object.prototype) {
    const out = {};
    memo.set(x, out);
    for (const k of Object.keys(x)) out[k] = deepcopy(x[k], memo);
    return out;
  }
  return x;
}

export function to_c_raw(node) { return new CGenerator().visit(node); }

export function to_c(node, { from_import = false } = {}) {
  const source = from_import ? to_c_raw(node) : new PatchedCGenerator().visit(node);
  return process_pragmas(source);
}

export function process_pragmas(source) {
  // Support MWCC-specific "u32 var : 0x1234;" syntax encoded as standard C
  // "u32 var = FIXEDADDR(0x1234)".
  source = source.replaceAll(" = FIXEDADDR(", " : (");
  if (!source.includes("#pragma")) return source;
  const lines = source.split("\n");
  const out = [];
  let same_line = 0;
  let ignore = 0;
  for (let line of lines) {
    let stripped = line.trim();
    if (stripped.startsWith("#pragma _permuter ")) {
      line = "";
      stripped = stripped.slice("#pragma _permuter ".length);
      if (stripped === "sameline start") same_line += 1;
      else if (stripped === "sameline end") same_line -= 1;
      else if (stripped === "latedefine start") ignore += 1;
      else if (stripped === "latedefine end") {
        assert(ignore > 0, "mismatched ignore pragmas");
        ignore -= 1;
      } else if (stripped.startsWith("define ")) {
        assert(ignore > 0, "define pragma must be within latedefine block");
        line = "#" + stripped;
      } else if (stripped.startsWith("b64literal ")) {
        line = Buffer.from(stripped.split(" ").slice(1).join(" "), "base64").toString("utf8");
      }
    } else if (ignore > 0) {
      line = "";
    }
    if (!same_line) line += "\n";
    else if (line && out.length && !out[out.length - 1].endsWith("\n")) line = " " + line.replace(/^\s+/, "");
    out.push(line);
  }
  assert(same_line === 0);
  assert(ignore === 0, "unbalanced ignore pragmas");
  return out.join("").replace(/\s+$/, "") + "\n";
}

/** Like a CGenerator, except it keeps else-ifs prettier despite normalize_ast. */
export class PatchedCGenerator extends CGenerator {
  visit_If(n) {
    let n2 = n;
    if (n.iffalse && n.iffalse instanceof ca.Compound && truthy(n.iffalse.block_items)
      && n.iffalse.block_items.length === 1 && n.iffalse.block_items[0] instanceof ca.If) {
      n2 = new ca.If(n.cond, n.iftrue, n.iffalse.block_items[0]);
    }
    return super.visit_If(n2);
  }
}

export function extract_fn(ast, fn_name) {
  const ret = [];
  for (let i = 0; i < ast.ext.length; i++) {
    let node = ast.ext[i];
    if (node instanceof ca.FuncDef) {
      if (node.decl.name === fn_name) ret.push([node, i]);
      else if (!node.decl.funcspec.includes("inline")) {
        node = node.decl;
        ast.ext[i] = node;
      }
    }
    if (node instanceof ca.Decl && node.type instanceof ca.FuncDecl) {
      node.storage = node.storage.filter((st) => st !== "static");
    }
  }
  if (ret.length === 0) throw new CandidateConstructionFailure(`Function ${fn_name} not found in base.c.`);
  if (ret.length > 1) throw new CandidateConstructionFailure(`Found multiple copies of function ${fn_name} in base.c.`);
  return ret[0];
}

export function parse_c(source, { from_import = false } = {}) {
  source = source.replace(/^#ident[^\n]*/gm, "");
  try {
    const parser = new CParser();
    const ast = parser.parse(source, "<source>");
    deduplicate_typedefs(ast);
    return ast;
  } catch (e) {
    if (!(e instanceof ParseError)) throw e;
    const full = String(e.message);
    const k = full.indexOf(": ");
    const position = full.slice(0, k);
    const msg = full.slice(k + 2);
    const parts = position.split(":");
    let posstr;
    if (parts.length >= 2) {
      const lineno = pyIntStrict(parts[1]);
      posstr = ` at approximately line ${lineno}`;
      if (parts.length >= 3) posstr += `, column ${parts[2]}`;
      if (!from_import) posstr += " (after PERM expansion)";
      const lines = source.split("\n");
      const idx = lineno - 1;
      const line = idx < 0 ? lines[lines.length + idx] : lines[idx];
      if (line === undefined) posstr += "(out of bounds?)";
      else posstr += "\n\n" + line.replace(/\s+$/, "");
    } else {
      posstr = "";
    }
    throw new CandidateConstructionFailure(`Syntax error in base.c.\n${msg}${posstr}`);
  }
}

function pyIntStrict(s) {
  if (!/^\s*[+-]?\d+\s*$/.test(s)) throw new Error(`invalid literal for int() with base 10: '${s}'`);
  return parseInt(s, 10);
}

/** Node indices for "region" tests: starts/ends keyed by node identity. */
export function compute_node_indices(top_node) {
  const starts = new Map();
  const ends = new Map();
  let cur_index = 1;
  const visit = (node) => {
    assert(!starts.has(node), "nodes should only appear once in AST");
    starts.set(node, cur_index);
    cur_index += 2;
    for (const c of node) visit(c);
    ends.set(node, cur_index);
    cur_index += 2;
  };
  visit(top_node);
  return { starts, ends };
}

/**
 * Structural AST equality over constructor fields (equal_ast). `cmp` may
 * decide a pair first by returning true/false (null = undecided).
 */
export function equal_ast(a, b, cmp = null) {
  const equal = (x, y) => {
    if (cmp != null) {
      const res = cmp(x, y);
      if (res != null) return res;
    }
    if (typeOfPy(x) !== typeOfPy(y)) return false;
    if (x == null) return y == null;
    if (Array.isArray(x)) {
      if (x.length !== y.length) return false;
      for (let i = 0; i < x.length; i++) if (!equal(x[i], y[i])) return false;
      return true;
    }
    if (typeof x === "number" || typeof x === "string" || typeof x === "bigint") return x === y;
    assert(x instanceof Node);
    assert(y instanceof Node);
    for (const name of x.constructor.fields) if (!equal(x[name], y[name])) return false;
    return true;
  };
  return equal(a, b);
}

/** type(x) for equal_ast: node class, or a primitive tag. */
function typeOfPy(x) {
  if (x == null) return "None";
  if (Array.isArray(x)) return "list";
  if (x instanceof Node) return x.constructor;
  if (typeof x === "boolean") return "bool";
  if (typeof x === "number" || typeof x === "bigint") return "int";
  if (typeof x === "string") return "str";
  if (typeof x === "object" && x.constructor) return x.constructor;
  return typeof x;
}

const EXPR_CLASSES = [ca.ArrayRef, ca.Assignment, ca.BinaryOp, ca.Cast, ca.CompoundLiteral, ca.Constant,
  ca.ExprList, ca.FuncCall, ca.ID, ca.StructRef, ca.TernaryOp, ca.UnaryOp];

export function as_expr(value) { return isa(value, ...EXPR_CLASSES) ? value : null; }

export function is_lvalue(expr) {
  if (isa(expr, ca.ID, ca.StructRef, ca.ArrayRef)) return true;
  if (expr instanceof ca.UnaryOp) return expr.op === "*";
  return false;
}

export function is_effectful(expr) {
  let found = false;
  const visit = (node) => {
    if (node instanceof ca.UnaryOp) {
      if (["p++", "p--", "++", "--"].includes(node.op)) found = true;
      else generic(node.expr);
      return;
    }
    if (node instanceof ca.FuncCall || node instanceof ca.Assignment) { found = true; return; }
    generic(node);
  };
  // NodeVisitor.generic_visit(node): visit each child (the visitor above is
  // called on the UnaryOp's operand through generic_visit, as upstream does).
  const generic = (node) => { for (const c of node) visit(c); };
  visit(expr);
  return found;
}

export function get_block_stmts(block, force) {
  if (block instanceof ca.Compound) {
    const ret = block.block_items || [];
    if (force && !truthy(block.block_items)) block.block_items = ret;
    return ret;
  }
  const ret = block.stmts || [];
  if (force && !truthy(block.stmts)) block.stmts = ret;
  return ret;
}

export function make_decl(name, type, { quals = null, align = null, storage = null, funcspec = null,
  gcc_attributes = null, init = null, bitsize = null, asmlabel = null } = {}) {
  type = deepcopy(type);
  const decl = new ca.Decl({
    name,
    quals: quals || [],
    align: align || [],
    storage: storage || [],
    funcspec: funcspec || [],
    gcc_attributes: gcc_attributes || [],
    type,
    init,
    bitsize,
    asmlabel,
  });
  set_decl_name(decl);
  return decl;
}

export function insert_decl(fn, varName, type, random = null) {
  const decl = make_decl(varName, type);
  if (!truthy(fn.body.block_items)) fn.body.block_items = [];
  const items = fn.body.block_items;
  let index = items.length;
  for (let i = 0; i < items.length; i++) {
    if (!(items[i] instanceof ca.Decl)) { index = i; break; }
  }
  if (random) index = random.randint(0, index);
  items.splice(index, 0, decl);
}

export function insert_statements(block, index, stmts) {
  get_block_stmts(block, true).splice(index, 0, ...stmts);
}

export function insert_statement(block, index, stmt) { insert_statements(block, index, [stmt]); }

export function brace_nested_blocks(stmt) {
  const brace = (s) => (isa(s, ca.Compound, ca.Case, ca.Default) ? s : new ca.Compound([s]));
  if (isa(stmt, ca.For, ca.While, ca.DoWhile)) stmt.stmt = brace(stmt.stmt);
  else if (stmt instanceof ca.If) {
    stmt.iftrue = brace(stmt.iftrue);
    if (stmt.iffalse) stmt.iffalse = brace(stmt.iffalse);
  } else if (stmt instanceof ca.Switch) stmt.stmt = brace(stmt.stmt);
  else if (stmt instanceof ca.Label) brace_nested_blocks(stmt.stmt);
}

export function has_nested_block(node) {
  return isa(node, ca.Compound, ca.For, ca.While, ca.DoWhile, ca.If, ca.Switch, ca.Case, ca.Default);
}

export function for_nested_blocks(stmt, callback) {
  const invoke = (s) => {
    assert(isa(s, ca.Compound, ca.Case, ca.Default), "brace_nested_blocks should have turned nested statements into blocks");
    callback(s);
  };
  if (stmt instanceof ca.Compound) invoke(stmt);
  else if (isa(stmt, ca.For, ca.While, ca.DoWhile)) invoke(stmt.stmt);
  else if (stmt instanceof ca.If) {
    if (stmt.iftrue) invoke(stmt.iftrue);
    if (stmt.iffalse) invoke(stmt.iffalse);
  } else if (stmt instanceof ca.Switch) invoke(stmt.stmt);
  else if (isa(stmt, ca.Case, ca.Default)) invoke(stmt);
  else if (stmt instanceof ca.Label) for_nested_blocks(stmt.stmt, callback);
}

/** Add braces to all ifs/fors/etc., to make it easier to insert statements. */
export function normalize_ast(fn, ast) {
  void ast;
  const rec = (block) => {
    for (const stmt of get_block_stmts(block, false)) {
      brace_nested_blocks(stmt);
      for_nested_blocks(stmt, rec);
    }
  };
  rec(fn.body);
}

/**
 * Multi-name typedefs sharing an anonymous struct/union/enum emit a single
 * named definition instead of duplicating the body per typedef.
 */
export function deduplicate_typedefs(ast) {
  let temp_shared_id = 0;
  const seen_structs = new Set();
  const process_decl = (item) => {
    if (isa(item.type, ca.Struct, ca.Union, ca.Enum)) return;
    let tp = item.type;
    while (!(tp instanceof ca.TypeDecl)) tp = pyGetType(tp);
    const inner = tp.type;
    if (!isa(inner, ca.Struct, ca.Union, ca.Enum)) return;
    const has_body = inner instanceof ca.Enum ? inner.values != null : inner.decls != null;
    if (!has_body) return;
    if (seen_structs.has(inner)) {
      if (!truthy(inner.name)) {
        temp_shared_id += 1;
        inner.name = `_PermuterAnon${temp_shared_id}`;
      }
      const fwd = deepcopy(inner);
      if (fwd instanceof ca.Enum) fwd.values = null;
      else fwd.decls = null;
      tp.type = fwd;
    } else {
      seen_structs.add(inner);
    }
  };
  const visit = (node) => {
    if (node instanceof ca.Decl || node instanceof ca.Typedef) process_decl(node);
    for (const c of node) visit(c);
  };
  visit(ast);
}

/** `x.type` with Python attribute semantics. */
function pyGetType(x) {
  if (!(x instanceof Node) || !x.constructor.fields.includes("type")) {
    throw new Error(`AttributeError: '${x == null ? "NoneType" : x.constructor.name}' object has no attribute 'type'`);
  }
  return x.type;
}

/**
 * Prune unnecessary parts of the AST (prune_ast). Used by import tooling; the
 * permuter itself does not call it.
 */
export function prune_ast(fn, ast) {
  const edges = new Map();
  const addEdge = (name, i) => { if (!edges.has(name)) edges.set(name, []); edges.get(name).push(i); };
  const gc_roots = [];
  const can_fwd_declare_typedef = new Set();
  const can_fwd_declare_tagged = new Set();
  const add_type_edges = (tp, i) => {
    while (isa(tp, ca.PtrDecl, ca.ArrayDecl)) tp = tp.type;
    if (tp instanceof ca.FuncDecl) return;
    const inner_type = tp instanceof ca.TypeDecl ? tp.type : tp;
    if (isa(inner_type, ca.IdentifierType, ca.Typeof)) return;
    if (truthy(inner_type.name)) addEdge(inner_type.name, i);
    if (inner_type instanceof ca.Enum && inner_type.values) {
      for (const value of inner_type.values.enumerators) addEdge(value.name, i);
    }
    if (isa(inner_type, ca.Struct, ca.Union) && truthy(inner_type.decls)) {
      for (const decl of inner_type.decls) if (decl instanceof ca.Decl) add_type_edges(decl.type, i);
    }
  };
  for (let i = 0; i < ast.ext.length; i++) {
    const item = ast.ext[i];
    if (item instanceof ca.Decl && !item.init) {
      if (truthy(item.name)) addEdge(item.name, i);
      if (isa(item.type, ca.Struct, ca.Union, ca.Enum) && truthy(item.type.name)) can_fwd_declare_tagged.add(item.type.name);
      add_type_edges(item.type, i);
    } else if (item instanceof ca.Typedef) {
      addEdge(item.name, i);
      if (item.type instanceof ca.TypeDecl && isa(item.type.type, ca.Struct, ca.Union, ca.Enum)) can_fwd_declare_typedef.add(item.name);
      add_type_edges(item.type, i);
    } else if (item instanceof ca.Pragma && item.string.includes("GLOBAL_ASM")) {
      // pass
    } else if (item !== fn && item instanceof ca.FuncDef) {
      assert(item.decl.name != null);
      addEdge(item.decl.name, i);
    } else {
      gc_roots.push(i);
    }
  }
  const mentioned_ids = new Set();
  const idVisit = (node) => {
    if (node instanceof ca.Pragma) { for (const t of node.string.match(/[a-zA-Z0-9_$]+/g) ?? []) mentioned_ids.add(t); return; }
    if (node instanceof ca.ID) { mentioned_ids.add(node.name); return; }
    for (const c of node) idVisit(c);
  };
  idVisit(ast);
  const gc_todo = gc_roots;
  const need_fwd_decl_typedef = [];
  const need_fwd_decl_tagged = [];
  const add_name = (name) => {
    if (edges.has(name)) {
      gc_todo.push(...edges.get(name));
      edges.delete(name);
    }
  };
  const visit = (node) => {
    if (node instanceof ca.Pragma) { for (const t of node.string.match(/[a-zA-Z0-9_$]+/g) ?? []) add_name(t); return; }
    if (node instanceof ca.ID) { add_name(node.name); return; }
    if (node instanceof ca.IdentifierType) { for (const name of node.names) add_name(name); return; }
    if (isa(node, ca.Enum)) { if (truthy(node.name) && !node.values) add_name(node.name); }
    else if (isa(node, ca.Struct, ca.Union)) { if (truthy(node.name) && !truthy(node.decls)) add_name(node.name); }
    else if (node instanceof ca.PtrDecl) {
      if (node.type instanceof ca.TypeDecl && truthy(node.type.declname) && !mentioned_ids.has(node.type.declname)) {
        const tp = node.type.type;
        if (tp instanceof ca.IdentifierType) {
          if (tp.names.every((name) => can_fwd_declare_typedef.has(name))) {
            need_fwd_decl_typedef.push(...tp.names);
            return;
          }
        } else if (tp instanceof ca.Typeof) {
          // pass
        } else if (truthy(tp.name) && can_fwd_declare_tagged.has(tp.name)) {
          if (!truthy(tp instanceof ca.Enum ? tp.values : tp.decls)) {
            need_fwd_decl_tagged.push(tp.name);
            return;
          }
        }
      }
    } else if (node instanceof ca.TypeDecl) {
      if (truthy(node.declname)) add_name(node.declname);
    }
    for (const c of node) visit(c);
  };
  const keep_exts = new Set();
  while (gc_todo.length) {
    const i = gc_todo.pop();
    if (!keep_exts.has(i)) {
      keep_exts.add(i);
      visit(ast.ext[i]);
    }
  }
  let temp_id = 0;
  const fwd_declare = (tp) => {
    if (isa(tp, ca.Struct, ca.Union)) tp.decls = null;
    else if (tp instanceof ca.Enum) tp.values = null;
    else assert(false);
  };
  const new_ext = [];
  ast.ext.forEach((item, i) => {
    if (keep_exts.has(i)) {
      // keep
    } else if (item instanceof ca.Typedef && need_fwd_decl_typedef.includes(item.name)) {
      if (!truthy(item.type.type.name)) {
        temp_id += 1;
        item.type.type.name = `_PermuterTemp${temp_id}`;
      }
      item.type.type = deepcopy(item.type.type);
      fwd_declare(item.type.type);
    } else if (item instanceof ca.Decl && isa(item.type, ca.Struct, ca.Union, ca.Enum) && truthy(item.type.name)
      && need_fwd_decl_tagged.includes(item.type.name)) {
      fwd_declare(item.type);
    } else {
      return;
    }
    new_ext.push(item);
  });
  ast.ext = new_ext;
  return ast.ext.indexOf(fn);
}
