// randomizer.js - the randomization passes, a port of decomp-permuter's
// src/randomizer.py. Every pass draws from the same PyRandom in the same
// order as upstream, so a given rng seed replays the same edits.
import { c_ast as ca, Node } from "romdev-pycparser";
import * as ast_util from "./ast_util.js";
import { isa, truthy, deepcopy, shallowCopy, AssertionError, to_c_raw } from "./ast_util.js";
import {
  allowed_basic_type, build_typemap, is_local_var, decayed_expr_type, get_decl_type, resolve_typedefs,
  same_type, set_decl_name, pointer_decay, AssertionError as TypesAssertionError,
} from "./ast_types.js";
import { PyRandom } from "./pyrandom.js";
import { powNeg15 as libmPowNeg15 } from "./pow.js";

// Randomize the type of introduced temporary variable with this probability
const PROB_RANDOMIZE_TYPE = 0.3;
// Reuse an existing var instead of introducing a new temporary one with this probability
const PROB_REUSE_VAR = 0.5;
// When wrapping statements in a new block, use a same-line `do { ... } while(0);`
const PROB_INS_BLOCK_DOWHILE = 0.5;
// Make a pointer to a temporary expression, rather than copy it by value
const PROB_TEMP_PTR = 0.05;
// Assign the temporary within the first expression it's used in
const PROB_TEMP_ASSIGN_AT_FIRST_USE = 0.1;
// Use the temporary for all equal expressions
const PROB_TEMP_REPLACE_ALL = 0.2;
// Use the temporary for an interval with maximal endpoint
const PROB_TEMP_REPLACE_MOST = 0.2;
// When substituting a variable by its value, substitute all instances
const PROB_EXPAND_REPLACE_ALL = 0.3;
// When substituting a variable by its value, keep the variable assignment
const PROB_KEEP_REPLACED_VAR = 0.2;
// Change the return type of an external function to void
const PROB_RET_VOID = 0.2;
// `if (variable1 || variable2)` in perm_var_cond_block
const PROB_VAR_COND_BLOCK_OR = 0.25;
// Number larger than any node index.
const MAX_INDEX = 10 ** 9;

export class RandomizationFailure extends Error {
  constructor() { super("RandomizationFailure"); this.name = "RandomizationFailure"; }
}

/** Abort the pass if `condition` is false (never after modifying the AST). */
function ensure(condition) {
  if (!truthy(condition)) throw new RandomizationFailure();
}

function assert(cond, msg) { if (!cond) throw new AssertionError(msg); }

const isAssertion = (e) => e instanceof AssertionError || e instanceof TypesAssertionError;

/** Remove duplicates, keeping the first instance (dict.fromkeys order). */
function dedup(li) { return [...new Set(li)]; }

/** bisect.bisect_left */
function bisect_left(a, x) {
  let lo = 0, hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (a[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Python's (x) ** -1.5: the C library pow CPython calls (see pow.js). */
const powNeg15 = (x) => libmPowNeg15(x);

class Region {
  constructor(start, end, indices) {
    this.start = start;
    this.end = end;
    this.indices = indices;
  }

  static unbounded() { return new Region(-1, MAX_INDEX, null); }

  is_unbounded() { return this.indices == null; }

  contains_node(node) {
    if (this.indices == null) return true;
    return this.start < this.indices.starts.get(node) && this.indices.ends.get(node) < this.end;
  }

  contains_pre(node) {
    if (this.indices == null) return true;
    const s = this.indices.starts.get(node);
    return this.start < s && s < this.end;
  }

  contains_pre_index(index) {
    if (this.indices == null) return true;
    return this.start < index && index < this.end;
  }
}

function reverse_start_indices(indices) {
  const ret = new Map();
  for (const [k, v] of indices.starts) ret.set(v, k);
  return ret;
}

function get_randomization_region(top_node, indices, random) {
  const ret = [];
  let cur_start = null;
  const visit = (node) => {
    if (node instanceof ca.Pragma) {
      if (node.string === "_permuter randomizer start") {
        if (cur_start != null) throw new Error("nested PERM_RANDOMIZE not supported");
        cur_start = indices.ends.get(node);
      }
      if (node.string === "_permuter randomizer end") {
        assert(cur_start != null, "randomizer end without start");
        ret.push(new Region(cur_start + 1, indices.starts.get(node) - 1, indices));
        cur_start = null;
      }
      return;
    }
    for (const c of node) visit(c);
  };
  visit(top_node);
  assert(cur_start == null, "randomizer start without end");
  if (!ret.length) return Region.unbounded();
  return random.choice(ret);
}

/** All expressions within a block that are also within a region. */
function get_block_expressions(block, region) {
  const exprs = [];
  replace_subexprs(block, (expr) => {
    if (region.contains_node(expr)) exprs.push(expr);
    return null;
  });
  return exprs;
}

function compute_write_locations(top_node, indices) {
  const writes = new Map();
  const add_write = (var_name, loc) => {
    if (!writes.has(var_name)) writes.set(var_name, []);
    else {
      const w = writes.get(var_name);
      assert(loc > w[w.length - 1], "consistent traversal order should guarantee monotonicity here");
    }
    writes.get(var_name).push(loc);
  };
  const visit = (node) => {
    if (node instanceof ca.Decl) {
      if (truthy(node.name)) add_write(node.name, indices.starts.get(node));
    } else if (node instanceof ca.UnaryOp) {
      if (["p++", "p--", "++", "--"].includes(node.op) && node.expr instanceof ca.ID) add_write(node.expr.name, indices.starts.get(node));
    } else if (node instanceof ca.Assignment) {
      if (node.lvalue instanceof ca.ID) add_write(node.lvalue.name, indices.starts.get(node));
    }
    for (const c of node) visit(c);
  };
  visit(top_node);
  return writes;
}

function compute_read_locations(top_node, indices) {
  const reads = new Map();
  for (const node of find_var_reads(top_node)) {
    const var_name = node.name;
    const loc = indices.starts.get(node);
    if (!reads.has(var_name)) reads.set(var_name, []);
    else {
      const r = reads.get(var_name);
      assert(loc > r[r.length - 1], "consistent traversal order should guarantee monotonicity here");
    }
    reads.get(var_name).push(loc);
  }
  return reads;
}

function find_var_reads(top_node) {
  const ret = [];
  const visit = (node) => {
    if (node instanceof ca.Decl) {
      if (node.init) visit(node.init);
      return;
    }
    if (node instanceof ca.ID) { ret.push(node); return; }
    if (node instanceof ca.UnaryOp) {
      if (node.op === "&" && node.expr instanceof ca.ID) return;
    } else if (node instanceof ca.StructRef) {
      visit(node.name);
      return;
    } else if (node instanceof ca.Assignment) {
      if (node.lvalue instanceof ca.ID) return;
    }
    for (const c of node) visit(c);
  };
  visit(top_node);
  return ret;
}

function get_mentioned_names(fn, region) {
  const names = [];
  const visit = (node) => {
    if (node instanceof ca.ID) {
      if (region.contains_node(node)) names.push(node.name);
      return;
    }
    if (node instanceof ca.StructRef) { visit(node.name); return; }
    for (const c of node) visit(c);
  };
  visit(fn);
  return names;
}

const PASSIVE_NODES = [
  ca.TypeDecl, ca.PtrDecl, ca.ArrayDecl, ca.Typename, ca.IdentifierType, ca.Typeof, ca.Struct, ca.Union,
  ca.Enum, ca.EmptyStatement, ca.Pragma, ca.Break, ca.Continue, ca.Goto, ca.CompoundLiteral, ca.Typedef,
  ca.FuncDecl, ca.FuncDef, ca.EllipsisParam, ca.Enumerator, ca.EnumeratorList, ca.FileAST, ca.InitList,
  ca.NamedInitializer, ca.ParamList, ca.GccAttribute, ca.GccAttributeStatement, ca.Asm, ca.AsmOperand, ca.Range,
];

/**
 * Walk statements/expressions in evaluation-ish order, letting `callback`
 * replace nodes. callback(node, is_expr) returns a replacement or null.
 */
function visit_replace(top_node, callback) {
  const empty_statement_to_none = (node) => (node instanceof ca.EmptyStatement ? null : node);
  const rec = (node, toplevel = false, lvalue = false) => {
    const repl = callback(node, !toplevel && !lvalue);
    if (repl) return repl;
    if (node instanceof ca.Assignment) {
      node.lvalue = rec(node.lvalue, false, true);
      node.rvalue = rec(node.rvalue);
    } else if (node instanceof ca.StructRef) {
      node.name = rec(node.name, false, lvalue && node.type === ".");
    } else if (node instanceof ca.Cast) {
      if (node.expr) node.expr = rec(node.expr);
    } else if (isa(node, ca.Constant, ca.ID)) {
      // pass
    } else if (node instanceof ca.UnaryOp) {
      if (["p++", "p--", "++", "--", "&"].includes(node.op)) node.expr = rec(node.expr, false, true);
      else if (node.op !== "sizeof") node.expr = rec(node.expr);
    } else if (node instanceof ca.BinaryOp) {
      node.left = rec(node.left);
      node.right = rec(node.right);
    } else if (node instanceof ca.FuncCall) {
      if (!(node.name instanceof ca.ID)) node.name = rec(node.name);
      if (node.args) rec(node.args, true);
    } else if (node instanceof ca.ExprList) {
      for (let i = 0; i < node.exprs.length; i++) {
        if (!(node.exprs[i] instanceof ca.Typename)) node.exprs[i] = rec(node.exprs[i]);
      }
    } else if (node instanceof ca.ArrayRef) {
      node.name = rec(node.name, false, lvalue);
      node.subscript = rec(node.subscript);
    } else if (node instanceof ca.TernaryOp) {
      node.cond = rec(node.cond);
      node.iftrue = rec(node.iftrue, true);
      node.iffalse = rec(node.iffalse, true);
    } else if (node instanceof ca.Return) {
      if (node.expr) node.expr = rec(node.expr);
    } else if (node instanceof ca.Decl) {
      if (node.init) node.init = rec(node.init, node.init instanceof ca.InitList);
    } else if (node instanceof ca.For) {
      if (node.init) node.init = empty_statement_to_none(rec(node.init, true));
      if (node.cond) node.cond = rec(node.cond);
      if (node.next) node.next = empty_statement_to_none(rec(node.next, true));
      node.stmt = rec(node.stmt, true);
    } else if (node instanceof ca.Compound) {
      if (truthy(node.block_items)) {
        node.block_items.forEach((sub, i) => { node.block_items[i] = rec(sub, true); });
      }
    } else if (isa(node, ca.Case, ca.Default)) {
      if (truthy(node.stmts)) node.stmts.forEach((sub, i) => { node.stmts[i] = rec(sub, true); });
    } else if (node instanceof ca.While) {
      node.cond = rec(node.cond);
      node.stmt = rec(node.stmt, true);
    } else if (node instanceof ca.DoWhile) {
      node.stmt = rec(node.stmt, true);
      node.cond = rec(node.cond);
    } else if (node instanceof ca.Switch) {
      node.cond = rec(node.cond);
      node.stmt = rec(node.stmt, true);
    } else if (node instanceof ca.Label) {
      node.stmt = rec(node.stmt, true);
    } else if (node instanceof ca.If) {
      node.cond = rec(node.cond);
      node.iftrue = rec(node.iftrue, true);
      if (node.iffalse) node.iffalse = rec(node.iffalse, true);
    } else if (isa(node, ...PASSIVE_NODES)) {
      // pass
    } else {
      assert(false, `Node with unknown type: ${node?.constructor?.name}`);
    }
    return node;
  };
  rec(top_node, true);
}

function replace_subexprs(top_node, callback) {
  visit_replace(top_node, (node, is_expr) => (is_expr ? callback(node) : null));
}

function replace_node(top_node, old, neu) {
  visit_replace(top_node, (node) => (node === old ? neu : null));
}

function random_bool(random, prob) { return random.random() < prob; }

function random_weighted(random, values) {
  let sumprob = 0.0;
  for (const [, prob] of values) {
    assert(prob >= 0, "Probabilities must be non-negative");
    sumprob += prob;
  }
  assert(sumprob > 0, "Cannot pick randomly from empty set");
  const targetprob = random.uniform(0, sumprob);
  sumprob = 0.0;
  for (const [val, prob] of values) {
    sumprob += prob;
    if (sumprob > targetprob) return val;
  }
  // Float imprecision
  for (const [val, prob] of values) if (prob > 0) return val;
  assert(false, "unreachable");
}

function random_type(random) {
  const new_names = [];
  if (random_bool(random, 0.5)) new_names.push("unsigned");
  new_names.push(...random_weighted(random, [
    [["char"], 1], [["short"], 1], [["int"], 2], [["long"], 0.5], [["long", "long"], 0.5],
  ]));
  const idtype = new ca.IdentifierType({ names: new_names });
  let quals = [];
  if (random_bool(random, 0.5)) quals = ["volatile"];
  return new ca.TypeDecl({ declname: null, quals, align: [], type: idtype });
}

function randomize_type(type, typemap, random, { ensure_changed = false } = {}) {
  if (allowed_basic_type(type, typemap, ["int", "char", "long", "short", "signed", "unsigned"])) return random_type(random);
  if (ensure_changed) throw new RandomizationFailure();
  return type;
}

function randomize_innermost_type(type, typemap, random, { ensure_changed = false } = {}) {
  if (type instanceof ca.TypeDecl) return randomize_type(type, typemap, random, { ensure_changed });
  const new_type = shallowCopy(type);
  new_type.type = randomize_innermost_type(type.type, typemap, random, { ensure_changed });
  return new_type;
}

function ensure_arithmetic_type(expr, typemap) {
  const type = decayed_expr_type(expr, typemap);
  ensure(allowed_basic_type(type, typemap, ["int", "char", "long", "short", "signed", "unsigned", "float", "double"]));
}

/** int(const.value.strip("uU"), 0), failing the pass on a ValueError. */
function get_constant_int_value(konst) {
  const s = konst.value.replace(/^[uU]+|[uU]+$/g, "");
  const m = /^\s*([+-]?)(0[xX][0-9a-fA-F]+|0[oO][0-7]+|0[bB][01]+|[1-9][0-9]*|0+)\s*$/.exec(s.replaceAll(/(?<=[0-9a-fA-F])_(?=[0-9a-fA-F])/g, ""));
  if (!m) throw new RandomizationFailure();
  const body = m[2];
  let v;
  if (/^0[xX]/.test(body)) v = BigInt(body);
  else if (/^0[oO]/.test(body)) v = BigInt("0o" + body.slice(2));
  else if (/^0[bB]/.test(body)) v = BigInt("0b" + body.slice(2));
  else v = BigInt(body);
  return m[1] === "-" ? -v : v;
}

function get_insertion_points(fn, region, { allow_within_decl = false } = {}) {
  let cands = [];
  const rec = (block) => {
    const stmts = ast_util.get_block_stmts(block, false);
    let last_node = null;
    stmts.forEach((stmt, i) => {
      if (region.contains_pre(stmt)) cands.push([block, i, last_node, stmt]);
      ast_util.for_nested_blocks(stmt, rec);
      last_node = stmt;
    });
    if (region.contains_node(last_node || block)) cands.push([block, stmts.length, last_node, null]);
  };
  rec(fn.body);
  if (!allow_within_decl) cands = cands.filter((c) => !(c[3] instanceof ca.Decl));
  return cands;
}

function get_noncolliding_name(ast, name) {
  const used_names = new Set();
  for (const item of ast.ext) {
    if (item instanceof ca.Decl && truthy(item.name)) used_names.add(item.name);
    if (item instanceof ca.FuncDef && truthy(item.decl.name)) used_names.add(item.decl.name);
  }
  let new_name = name;
  let counter = 1;
  while (used_names.has(new_name)) {
    counter += 1;
    new_name = `${new_name}${counter}`;
  }
  return new_name;
}

function maybe_reuse_var(varName, assign_before, orig_expr, type, reads, writes, indices, typemap, random) {
  if (!random_bool(random, PROB_REUSE_VAR) || varName == null) return null;
  const var_type = decayed_expr_type(new ca.ID(varName), typemap);
  if (!same_type(var_type, type, typemap, true)) return null;
  const find_next = (lst, value) => {
    const ind = bisect_left(lst, value);
    return ind < lst.length ? lst[ind] : null;
  };
  const assignment_ind = indices.starts.get(assign_before);
  const expr_ind = indices.starts.get(orig_expr);
  const write = find_next(writes.get(varName) ?? [], assignment_ind);
  const read = find_next(reads.get(varName) ?? [], assignment_ind);
  if (read != null && (write == null || write >= read)) return null;
  if (write != null && write < expr_ind) return null;
  return varName;
}

function pick_random_subset(random, cands, mid) {
  const all_before = cands.slice(0, mid);
  const all_after = cands.slice(mid + 1);
  const prob = random_bool(random, 0.5) ? 0.5 : 0;
  let before = all_before.filter(() => random_bool(random, prob));
  let after = all_after.filter(() => random_bool(random, prob));
  if (random_bool(random, PROB_TEMP_REPLACE_ALL)) {
    before = all_before;
    after = all_after;
  } else if (random_bool(random, PROB_TEMP_REPLACE_MOST)) {
    if (random_bool(random, 0.5)) before = all_before;
    else after = all_after;
  }
  return [...before, cands[mid], ...after];
}

// ---------------------------------------------------------------------------
// Randomization passes. Each takes (fn, ast, indices, region, random).

/**
 * Create a temporary variable for a random expression. The variable will be
 * assigned at another random point (nearer the expression being more likely),
 * possibly reuse an existing variable, possibly be of a different
 * size/signedness, and possibly be used for other identical expressions as
 * well. Only expressions within the given region may be chosen for
 * replacement, but the assignment and the affected identical expressions may
 * be outside of it.
 */
function perm_temp_for_expr(fn, ast, indices, region, random) {
  const einds = new Map();
  const writes = compute_write_locations(fn, indices);
  const reads = compute_read_locations(fn, indices);
  const typemap = build_typemap(ast, fn);
  const candidates = [];
  let should_make_ptr = random_bool(random, PROB_TEMP_PTR);

  const surrounding_writes = (expr, base) => {
    const sub_reads = find_var_reads(expr);
    let prev_write = -1;
    let next_write = MAX_INDEX;
    const base_index = indices.starts.get(base);
    for (const sub_read of sub_reads) {
      const var_name = sub_read.name;
      if (!writes.has(var_name)) continue;
      const wr = writes.get(var_name);
      const ind = bisect_left(wr, base_index);
      if (ind > 0) prev_write = Math.max(prev_write, wr[ind - 1]);
      if (ind < wr.length) next_write = Math.min(next_write, wr[ind]);
    }
    return [prev_write, next_write];
  };

  const rec = (block, reuse_cands_in) => {
    const stmts = ast_util.get_block_stmts(block, false);
    const reuse_cands = reuse_cands_in.slice();
    const assignment_cands = [];
    let past_decls = false;
    stmts.forEach((stmt, index) => {
      if (stmt instanceof ca.Decl) {
        assert(truthy(stmt.name), "Anonymous declarations cannot happen in functions");
        if (!(stmt.type instanceof ca.ArrayDecl)) {
          reuse_cands.push(stmt.name);
          if (!(stmt.type instanceof ca.PtrDecl)) reuse_cands.push(stmt.name);
        }
      } else if (!(stmt instanceof ca.Pragma)) {
        past_decls = true;
      }
      if (past_decls) assignment_cands.push([block, index, stmt]);
      ast_util.for_nested_blocks(stmt, (b) => rec(b, reuse_cands));
      const visitor = (expr0) => {
        if (!region.contains_node(expr0)) return null;
        let expr = expr0;
        const orig_expr = expr0;
        if (should_make_ptr) {
          if (!ast_util.is_lvalue(expr)) return null;
          expr = new ca.UnaryOp("&", expr);
        }
        let eind = einds.get(expr) ?? 0;
        const [prev_write] = surrounding_writes(expr, orig_expr);
        for (let k = assignment_cands.length - 1; k >= 0; k--) {
          const place = assignment_cands[k];
          if (indices.starts.get(place[2]) <= prev_write) break;
          eind += 1;
          let prob = 1 / eind;
          if (isa(orig_expr, ca.ID, ca.Constant)) prob *= should_make_ptr ? 0.15 : 0.5;
          const reuse_cand = reuse_cands.length ? random.choice(reuse_cands) : null;
          candidates.push([[place, expr, reuse_cand], prob]);
        }
        einds.set(expr, eind);
        return null;
      };
      replace_subexprs(stmt, visitor);
    });
  };
  rec(fn.body, []);

  ensure(candidates);
  let [place, expr, reuse_cand] = random_weighted(random, candidates);
  if (random_bool(random, PROB_TEMP_ASSIGN_AT_FIRST_USE)) place = null;
  let type = decayed_expr_type(expr, typemap);
  if (!should_make_ptr && type instanceof ca.TypeDecl && isa(type.type, ca.Struct, ca.Union) && ast_util.is_lvalue(expr)) {
    should_make_ptr = true;
    expr = new ca.UnaryOp("&", expr);
    type = decayed_expr_type(expr, typemap);
  }
  let orig_expr;
  if (should_make_ptr) {
    assert(expr instanceof ca.UnaryOp);
    assert(!(expr.expr instanceof ca.Typename));
    orig_expr = expr.expr;
  } else {
    orig_expr = expr;
  }
  const assign_before = place != null ? place[2] : orig_expr;
  const reused_var = maybe_reuse_var(reuse_cand, assign_before, orig_expr, type, reads, writes, indices, typemap, random);
  let reused, varName;
  if (reused_var != null) {
    reused = true;
    varName = reused_var;
  } else {
    reused = false;
    varName = "new_var";
    let counter = 1;
    while (writes.has(varName)) {
      counter += 1;
      varName = `new_var${counter}`;
    }
  }
  let [prev_write, next_write] = surrounding_writes(expr, orig_expr);
  prev_write = Math.max(prev_write, indices.starts.get(assign_before) - 1);
  let replace_cands = [];
  const find_duplicates = (e) => {
    const s = indices.starts.get(e);
    if (prev_write < s && s <= next_write && ast_util.equal_ast(e, orig_expr)) replace_cands.push(e);
    return null;
  };
  if (ast_util.is_effectful(expr)) replace_cands = [orig_expr];
  else replace_subexprs(fn.body, find_duplicates);
  assert(replace_cands.includes(orig_expr));
  const replace_cand_set = new Set(pick_random_subset(random, replace_cands, replace_cands.indexOf(orig_expr)));
  const replacer = (e) => {
    if (replace_cand_set.has(e)) {
      let ret = new ca.ID(varName);
      if (place == null && e === orig_expr) ret = new ca.Assignment("=", ret, expr);
      if (should_make_ptr) ret = new ca.UnaryOp("*", ret);
      return ret;
    }
    return null;
  };
  replace_subexprs(fn.body, replacer);
  if (place != null) {
    const [block, index] = place;
    const assignment = new ca.Assignment("=", new ca.ID(varName), expr);
    ast_util.insert_statement(block, index, assignment);
  }
  if (!reused) {
    if (random_bool(random, PROB_RANDOMIZE_TYPE)) type = randomize_type(type, typemap, random);
    ast_util.insert_decl(fn, varName, type, random);
  }
}

/** Replace a random variable by its contents. */
function perm_expand_expr(fn, ast, indices, region, random) {
  const all_writes = compute_write_locations(fn, indices);
  const all_reads = compute_read_locations(fn, indices);
  const rev = new Map();
  for (const [v, locs] of all_reads) {
    for (const index of locs) if (region.contains_pre_index(index)) rev.set(index, v);
  }
  ensure(rev.size);
  const index = random.choice([...rev.keys()]);
  const varName = rev.get(index);
  const reads = all_reads.get(varName);
  const writes = all_writes.get(varName) ?? [];
  const i = bisect_left(writes, index);
  ensure(i > 0);
  const before = writes[i - 1];
  const after = i === writes.length ? MAX_INDEX : writes[i];
  const rev_indices = reverse_start_indices(indices);
  const write = rev_indices.get(before);
  let repl_expr;
  if (write instanceof ca.Decl && write.init && !(write.init instanceof ca.InitList)) repl_expr = write.init;
  else if (write instanceof ca.Assignment && write.op === "=") repl_expr = write.rvalue;
  else throw new RandomizationFailure();
  let repl_cands = reads.filter((j) => before < j && j < after && region.contains_pre_index(j));
  assert(repl_cands.length, "index is always in repl_cands");
  const myi = repl_cands.indexOf(index);
  let keep_var;
  if (!random_bool(random, PROB_EXPAND_REPLACE_ALL) && repl_cands.length > 1) {
    const side = random.randrange(3);
    const H = repl_cands.length;
    let loi = side === 0 ? 0 : random.randint(0, myi);
    let hii = side === 1 ? H : random.randint(myi + 1, H);
    if (loi === 0 && hii === H) { loi = myi; hii = myi + 1; }
    repl_cands = repl_cands.slice(0, loi).concat(repl_cands.slice(hii));
    keep_var = true;
  } else {
    keep_var = random_bool(random, PROB_KEEP_REPLACED_VAR);
  }
  const repl_cands_set = new Set(repl_cands);
  if (ast_util.is_effectful(repl_expr)) ensure(repl_cands.length === 1 && !keep_var);
  const callback = (expr, is_expr) => {
    if (repl_cands_set.has(indices.starts.get(expr))) return deepcopy(repl_expr);
    if (expr === write && write instanceof ca.Assignment && !keep_var) {
      return is_expr ? write.lvalue : new ca.EmptyStatement();
    }
    return null;
  };
  visit_replace(fn.body, callback);
  if (!keep_var && write instanceof ca.Decl) write.init = null;
}

/**
 * Randomize types of pre-existing local variables. Function parameters are
 * not included -- those are handled by perm_randomize_function_type. Only
 * variables mentioned within the given region are affected.
 */
function perm_randomize_internal_type(fn, ast, indices, region, random) {
  const names = new Set(get_mentioned_names(fn, region));
  const typemap = build_typemap(ast, fn);
  const decls = [];
  const visit = (node) => {
    if (node instanceof ca.Decl) {
      if (node.type instanceof ca.TypeDecl && truthy(node.name) && names.has(node.name)) decls.push(node);
    }
    for (const c of node) visit(c);
  };
  visit(fn);
  ensure(decls);
  const decl = random.choice(decls);
  assert(decl.type instanceof ca.TypeDecl, "checked above");
  decl.type = randomize_type(decl.type, typemap, random, { ensure_changed: true });
  set_decl_name(decl);
}

/** Randomize types of global variables. Only variables mentioned within the given region are affected. */
function perm_randomize_external_type(fn, ast, indices, region, random) {
  const names = get_mentioned_names(fn, region);
  ensure(names);
  const name = random.choice(dedup(names));
  const decls = [];
  for (let i = 0; i < ast.ext.length; i++) {
    const item = ast.ext[i];
    if (item instanceof ca.Decl && item.name === name) decls.push([shallowCopy(item), i]);
  }
  ensure(decls);
  const decl0 = random.choice(decls)[0];
  const decl_type = get_decl_type(decl0);
  const typemap = build_typemap(ast, fn);
  const new_type = randomize_innermost_type(decl_type, typemap, random, { ensure_changed: true });
  for (const [decl, i] of decls) {
    decl.type = deepcopy(new_type);
    ast.ext[i] = decl;
    set_decl_name(decl);
  }
}

/**
 * Randomize types of function parameters and returns. Only functions called
 * within the given region are affected, plus the current function.
 */
function perm_randomize_function_type(fn, ast, indices, region, random) {
  assert(fn.decl.name != null, "function definitions have names");
  const names = [fn.decl.name];
  const visit = (node) => {
    if (node instanceof ca.FuncCall) {
      if (region.contains_node(node) && node.name instanceof ca.ID) names.push(node.name.name);
    }
    for (const c of node) visit(c);
  };
  visit(fn);
  const name = random.choice(dedup(names));
  const all_decls = [];
  let main_decl = null;
  for (let i = 0; i < ast.ext.length; i++) {
    const item = ast.ext[i];
    if (item instanceof ca.Decl && item.type instanceof ca.FuncDecl && item.name === name) {
      const new_decl = shallowCopy(item);
      all_decls.push([new_decl, i, new_decl]);
    }
    if (item instanceof ca.FuncDef && item.decl.name === name) {
      assert(item.decl.type instanceof ca.FuncDecl, "function definitions have function types");
      const new_fndef = shallowCopy(item);
      const new_decl = shallowCopy(item.decl);
      new_fndef.decl = new_decl;
      all_decls.push([new_decl, i, new_fndef]);
      main_decl = new_decl;
    }
  }
  ensure(all_decls);
  if (!main_decl) main_decl = random.choice(all_decls)[0];
  const typemap = build_typemap(ast, fn);
  const main_fndecl = deepcopy(main_decl.type);
  assert(main_fndecl instanceof ca.FuncDecl, "checked above");
  main_decl.type = main_fndecl;
  if (random_bool(random, 0.5)) {
    const type = pointer_decay(main_fndecl.type, typemap);
    if (allowed_basic_type(type, typemap, ["void"])) main_fndecl.type = random_type(random);
    else if (random_bool(random, PROB_RET_VOID)) {
      const idtype = new ca.IdentifierType({ names: ["void"] });
      main_fndecl.type = new ca.TypeDecl({ declname: null, quals: [], align: [], type: idtype });
    } else {
      main_fndecl.type = randomize_type(type, typemap, random, { ensure_changed: true });
    }
    set_decl_name(main_decl);
  } else {
    if (!main_fndecl.args) throw new RandomizationFailure();
    ensure(main_fndecl.args.params);
    const ind = random.randrange(main_fndecl.args.params.length);
    const arg = main_fndecl.args.params[ind];
    if (isa(arg, ca.ID, ca.EllipsisParam)) throw new RandomizationFailure();
    const arg_type = arg instanceof ca.Typename ? arg.type : get_decl_type(arg);
    const type = pointer_decay(arg_type, typemap);
    arg.type = randomize_type(type, typemap, random, { ensure_changed: true });
    if (arg instanceof ca.Decl) set_decl_name(arg);
  }
  for (const [decl, ind, new_node] of all_decls) {
    ast.ext[ind] = new_node;
    if (decl !== main_decl) decl.type = deepcopy(main_decl.type);
  }
}

/**
 * Add `if (variable) {}` or `if (struct.member) {}` in a random place. This
 * will get optimized away but may affect regalloc.
 */
function perm_refer_to_var(fn, ast, indices, region, random) {
  const cands = get_block_expressions(fn.body, region).filter((expr) => isa(expr, ca.StructRef, ca.ID));
  ensure(cands);
  let expr = random.choice(cands);
  ensure(!ast_util.is_effectful(expr));
  const typemap = build_typemap(ast, fn);
  const type = resolve_typedefs(decayed_expr_type(expr, typemap), typemap);
  if (type instanceof ca.TypeDecl && isa(type.type, ca.Struct, ca.Union)) expr = new ca.UnaryOp("&", expr);
  if (random_bool(random, 0.5)) expr = new ca.UnaryOp("!", expr);
  const ins_cands = get_insertion_points(fn, Region.unbounded());
  ensure(ins_cands);
  let cond = deepcopy(expr);
  const reps = random.choice([0, 0, 0, 0, 0, 1, 2, 2]);
  for (let i = 0; i < reps; i++) cond = new ca.BinaryOp("&&", cond, deepcopy(expr));
  const stmt = new ca.If({ cond, iftrue: new ca.Compound({ block_items: [] }), iffalse: null });
  const [tob, toi] = random.choice(ins_cands);
  ast_util.insert_statement(tob, toi, stmt);
}

/**
 * Wrap a random range of statements within `if (1) { ... }` or
 * `do { ... } while(0)`. Control flow can have remote effects, so this mostly
 * ignores the region restriction.
 */
function perm_ins_block(fn, ast, indices, region, random) {
  const cands = [];
  const rec = (block) => {
    cands.push(block);
    for (const stmt of ast_util.get_block_stmts(block, false)) ast_util.for_nested_blocks(stmt, rec);
  };
  rec(fn.body);
  const block = random.choice(cands);
  const stmts = ast_util.get_block_stmts(block, true);
  let decl_count = 0;
  for (const stmt of stmts) {
    if (isa(stmt, ca.Decl, ca.Pragma)) decl_count += 1;
    else break;
  }
  let lo = random.randrange(decl_count, stmts.length + 1);
  let hi = random.randrange(decl_count, stmts.length + 1);
  if (hi < lo) [lo, hi] = [hi, lo];
  const new_block = new ca.Compound({ block_items: stmts.slice(lo, hi) });
  if (random_bool(random, PROB_INS_BLOCK_DOWHILE) && stmts.slice(lo, hi).every((n) => region.contains_node(n))) {
    const cond = new ca.Constant({ type: "int", value: "0" });
    stmts.splice(lo, hi - lo,
      new ca.Pragma("_permuter sameline start"),
      new ca.DoWhile({ cond, stmt: new_block }),
      new ca.Pragma("_permuter sameline end"));
  } else {
    const cond = new ca.Constant({ type: "int", value: "1" });
    stmts.splice(lo, hi - lo, new ca.If({ cond, iftrue: new_block, iffalse: null }));
  }
}

/**
 * Inserts a no-op statement, one of:
 * - if (1) {} (sometimes multiple of them)
 * - if (0) {}
 * - do {} while (0);
 * - label:
 * - goto label; label:;
 * - ;
 * Control flow can have remote effects, so this ignores the region restriction.
 */
function perm_empty_stmt(fn, ast, indices, region, random) {
  const cands = get_insertion_points(fn, Region.unbounded());
  ensure(cands);
  const label_name = `dummy_label_${random.randint(1, 10 ** 6)}`;
  let stmts = [];
  const kind = random.randrange(6);
  if (kind === 0) {
    const count = random.choice([1, random.randint(2, 6)]);
    for (let k = 0; k < count; k++) {
      const cond = new ca.Constant({ type: "int", value: "1" });
      stmts.push(new ca.If({ cond, iftrue: new ca.Compound([]), iffalse: null }));
    }
  } else if (kind === 1) {
    const cond = new ca.Constant({ type: "int", value: "0" });
    stmts = [new ca.If({ cond, iftrue: new ca.Compound([]), iffalse: null })];
  } else if (kind === 2) {
    const cond = new ca.Constant({ type: "int", value: "0" });
    stmts = [new ca.DoWhile({ stmt: new ca.Compound([]), cond })];
  } else if (kind === 3) {
    stmts = [new ca.Label(label_name, new ca.EmptyStatement())];
  } else if (kind === 4) {
    stmts = [new ca.Goto(label_name), new ca.Label(label_name, new ca.EmptyStatement())];
  } else if (kind === 5) {
    stmts = [new ca.EmptyStatement()];
  }
  const [tob, toi] = random.choice(cands);
  stmts.unshift(new ca.Pragma("_permuter sameline start"));
  stmts.push(new ca.Pragma("_permuter sameline end"));
  for (let k = stmts.length - 1; k >= 0; k--) ast_util.insert_statement(tob, toi, stmts[k]);
}

/** Put all statements within a random interval on the same line. */
function perm_sameline(fn, ast, indices, region, random) {
  const cands = get_insertion_points(fn, region);
  const n = cands.length;
  ensure(n >= 3);
  let lef = n - 2;
  for (let i = 0; i < 4; i++) lef *= random.uniform(0, 1);
  const le = Math.trunc(lef) + 2;
  const i = random.randrange(n - le);
  const j = i + le;
  ast_util.insert_statement(cands[j][0], cands[j][1], new ca.Pragma("_permuter sameline end"));
  ast_util.insert_statement(cands[i][0], cands[i][1], new ca.Pragma("_permuter sameline start"));
}

/** Change a+b into b+a, or similar for other commutative operations. */
function perm_commutative(fn, ast, indices, region, random) {
  const cands = [];
  const commutative_ops = [..."+*|&^<>", "<=", ">=", "==", "!="];
  const visit = (node) => {
    if (node instanceof ca.BinaryOp) {
      if (commutative_ops.includes(node.op) && region.contains_node(node)) cands.push(node);
    }
    for (const c of node) visit(c);
  };
  visit(fn.body);
  ensure(cands);
  const node = random.choice(cands);
  [node.left, node.right] = [node.right, node.left];
  if (node.op[0] === "<") node.op = ">" + node.op.slice(1);
  else if (node.op[0] === ">") node.op = "<" + node.op.slice(1);
}

/** Change a-b into a+(-b), or a+b into a-(-b). */
function perm_add_sub(fn, ast, indices, region, random) {
  const cands = [];
  const visit = (node) => {
    if (node instanceof ca.BinaryOp) {
      if ((node.op === "+" || node.op === "-") && region.contains_node(node)) cands.push(node);
    }
    for (const c of node) visit(c);
  };
  visit(fn.body);
  ensure(cands);
  const node = random.choice(cands);
  if (node.right instanceof ca.Constant) {
    const val = node.right.value;
    node.right.value = val.startsWith("-") ? val.slice(1) : "-" + val;
  } else if (node.right instanceof ca.UnaryOp && node.right.op === "-") {
    assert(!(node.right.expr instanceof ca.Typename));
    node.right = node.right.expr;
  } else {
    const typemap = build_typemap(ast, fn);
    const type = resolve_typedefs(decayed_expr_type(node, typemap), typemap);
    ensure(!(type instanceof ca.TypeDecl));
    node.right = new ca.UnaryOp("-", node.right);
  }
  node.op = node.op === "-" ? "+" : "-";
}

/** Change if(x) into if(x != 0), or vice versa. Also handles for/while/do-while. */
function perm_condition(fn, ast, indices, region, random) {
  const cands = [];
  const visit = (node) => {
    if (isa(node, ca.If, ca.While, ca.DoWhile, ca.For)) cands.push(node);
    for (const c of node) visit(c);
  };
  visit(fn.body);
  ensure(cands);
  const node = random.choice(cands);
  if (!node.cond) throw new RandomizationFailure();
  if (node.cond instanceof ca.BinaryOp && ["==", "!=", "<", ">", "<=", ">="].includes(node.cond.op) && random_bool(random, 0.9)) {
    ensure(node.cond.op === "==" || node.cond.op === "!=");
    ensure(node.cond.right instanceof ca.Constant && ["0", "0U", "0.0", "0.0f"].includes(node.cond.right.value));
    if (node.cond.op === "==") node.cond = new ca.UnaryOp("!", node.cond.left);
    else node.cond = node.cond.left;
  } else {
    let expr = node.cond;
    let op = "!=";
    if (expr instanceof ca.UnaryOp && expr.op === "!" && random_bool(random, 0.9)) {
      assert(!(expr.expr instanceof ca.Typename));
      expr = expr.expr;
      op = "==";
    }
    const zero = random_weighted(random, [
      [new ca.Constant("int", "0"), 0.8],
      [new ca.Constant("unsigned int", "0U"), 0.2],
      [new ca.Constant("float", "0.0f"), 0.05],
    ]);
    node.cond = new ca.BinaryOp(op, expr, zero);
  }
}

/** Introduce a "x = x;", "x += 0;" or "x++; x--;" somewhere. */
function perm_add_self_assignment(fn, ast, indices, region, random) {
  const cands = [];
  const seen_keys = new Set();
  for (const expr of get_block_expressions(fn.body, region)) {
    if (!isa(expr, ca.ID, ca.StructRef)) continue;
    const key = to_c_raw(expr);
    if (!seen_keys.has(key)) {
      seen_keys.add(key);
      cands.push(expr);
    }
  }
  ensure(cands);
  const expr = random.choice(cands);
  ensure(!ast_util.is_effectful(expr));
  const ins_cands = get_insertion_points(fn, region);
  ensure(ins_cands);
  const where = random.choice(ins_cands);
  const kind = random.randrange(3);
  let stmts;
  if (kind === 0) stmts = [new ca.Assignment("=", deepcopy(expr), deepcopy(expr))];
  else if (kind === 1) stmts = [new ca.Assignment("+=", deepcopy(expr), new ca.Constant("int", "0"))];
  else stmts = [new ca.UnaryOp("p++", deepcopy(expr)), new ca.UnaryOp("p--", deepcopy(expr))];
  ast_util.insert_statements(where[0], where[1], stmts);
}

/** Change x into (0, x) for a random expression x. */
function perm_dummy_comma_expr(fn, ast, indices, region, random) {
  const cands = get_block_expressions(fn.body, region);
  ensure(cands);
  const expr = random.choice(cands);
  const new_expr = new ca.ExprList([new ca.Constant("int", "0"), expr]);
  replace_node(fn.body, expr, new_expr);
}

/** Move a statement to another random place. */
function perm_reorder_stmts(fn, ast, indices, region, random) {
  let cands = get_insertion_points(fn, region, { allow_within_decl: true });
  cands = cands.filter(([, , , node]) => !(node instanceof ca.Decl)
    || (node.name != null && node.init != null && !(node.init instanceof ca.InitList)));
  const source_inds = [];
  cands.forEach((c, i) => {
    const stmt = c[3];
    if (stmt != null && !(stmt instanceof ca.Pragma) && !ast_util.has_nested_block(stmt)) source_inds.push(i);
  });
  ensure(source_inds);
  const sourcei = random.choice(source_inds);
  const [fromb, fromi, , from_stmt] = cands[sourcei];
  let sourcei_after = sourcei + 1;
  if (from_stmt instanceof ca.Decl || sourcei_after === cands.length || cands[sourcei_after][2] !== from_stmt) sourcei_after -= 1;
  const weighted_cands = [];
  for (let i = 0; i < cands.length; i++) {
    const dist = Math.max(sourcei - i, i - sourcei_after);
    if (dist === 0) continue;
    if (cands[i][3] instanceof ca.Decl) continue;
    const prob = powNeg15(dist + 1) + 0.5 / cands.length;
    weighted_cands.push([i, prob]);
  }
  ensure(weighted_cands);
  const pick = random_weighted(random, weighted_cands);
  let [tob, toi] = cands[pick];
  if (fromb === tob) ensure(toi !== fromi && toi !== fromi + 1);
  if (from_stmt instanceof ca.Decl) {
    assert(truthy(from_stmt.name));
    assert(from_stmt.init != null);
    assert(!(from_stmt.init instanceof ca.InitList));
    const assignment = new ca.Assignment("=", new ca.ID(from_stmt.name), from_stmt.init);
    ast_util.insert_statement(tob, toi, assignment);
    from_stmt.init = null;
  } else {
    if (fromb === tob && fromi < toi) toi -= 1;
    const stmt = ast_util.get_block_stmts(fromb, true).splice(fromi, 1)[0];
    ast_util.insert_statement(tob, toi, stmt);
  }
}

/** Move a declaration to another random place. */
function perm_reorder_decls(fn, ast, indices, region, random) {
  let cands = get_insertion_points(fn, region, { allow_within_decl: true });
  cands = cands.filter(([, i, before, after]) => i === 0 || before instanceof ca.Decl || after instanceof ca.Decl);
  const source_inds = [];
  cands.forEach((c, i) => { if (c[3] instanceof ca.Decl) source_inds.push(i); });
  ensure(source_inds);
  const sourcei = random.choice(source_inds);
  const weighted_cands = [];
  for (let i = 0; i < cands.length; i++) {
    const dist = Math.max(sourcei - i, i - (sourcei + 1));
    if (dist === 0) continue;
    const prob = powNeg15(dist + 1) + 1 / cands.length;
    weighted_cands.push([i, prob]);
  }
  ensure(weighted_cands);
  const desti = random_weighted(random, weighted_cands);
  const [fromb, fromi, , from_stmt] = cands[sourcei];
  let [tob, toi, , to_stmt] = cands[desti];
  if (fromb === tob) {
    assert(toi !== fromi);
    assert(toi !== fromi + 1);
  }
  assert(from_stmt instanceof ca.Decl);
  ensure(from_stmt.name);
  const var_name = from_stmt.name;
  const to_index = to_stmt ? indices.starts.get(to_stmt) : indices.ends.get(fromb);
  let uses = 0;
  const visit = (node) => {
    if (node instanceof ca.ID) {
      if (node.name === var_name && indices.starts.get(node) < to_index) uses += 1;
      return;
    }
    if (node instanceof ca.TypeDecl) {
      if (node.declname === var_name && indices.starts.get(node) < to_index) uses += 1;
      return;
    }
    for (const c of node) visit(c);
  };
  visit(fn.body);
  ensure(uses <= 1);
  if (fromb === tob && fromi < toi) toi -= 1;
  const stmt = ast_util.get_block_stmts(fromb, true).splice(fromi, 1)[0];
  ast_util.insert_statement(tob, toi, stmt);
}

/** Convert a statement of the form `x = x op y` to `x op= y`, or vice versa. */
function perm_compound_assignment(fn, ast, indices, region, random) {
  const cands = [];
  const operators = ["+", "-", "*", "/", "<<", ">>", "^", "|", "&"];
  const visit = (node) => {
    if (node instanceof ca.Assignment) {
      if (region.contains_node(node)) {
        if (node.op !== "=" || (node.rvalue instanceof ca.BinaryOp && ast_util.equal_ast(node.lvalue, node.rvalue.left)
          && operators.includes(node.rvalue.op))) cands.push(node);
      }
    }
    for (const c of node) visit(c);
  };
  visit(fn.body);
  ensure(cands);
  const node = random.choice(cands);
  if (node.op === "=") {
    assert(node.rvalue instanceof ca.BinaryOp);
    node.op = node.rvalue.op + node.op;
    node.rvalue = node.rvalue.right;
  } else {
    const operator = node.op.slice(0, -1);
    node.op = "=";
    node.rvalue = new ca.BinaryOp(operator, deepcopy(node.lvalue), node.rvalue);
  }
}

/**
 * Adjusts inequalities to equivalent versions that sometimes produce different
 * code. For example, a > b and a >= b + 1, a < b to a <= b - 1 (and vice versa)
 */
function perm_inequalities(fn, ast, indices, region, random) {
  const cands = [];
  const inequalities = ["<", ">", "<=", ">="];
  const visit = (node) => {
    if (node instanceof ca.BinaryOp) {
      if (inequalities.includes(node.op) && region.contains_node(node)) cands.push(node);
    }
    for (const c of node) visit(c);
  };
  visit(fn.body);
  ensure(cands);
  const node = random.choice(cands);
  const plus1 = (n) => new ca.BinaryOp("+", n, new ca.Constant("int", "1"));
  const minus1 = (n) => new ca.BinaryOp("-", n, new ca.Constant("int", "1"));
  if (random.random() < 0.25) {
    const change = random.choice([plus1, minus1]);
    node.left = change(node.left);
    node.right = change(node.right);
  } else if (node.op === "<" || node.op === ">=") {
    node.op = { "<": "<=", ">=": ">" }[node.op];
    if (random_bool(random, 0.5)) node.left = plus1(node.left);
    else node.right = minus1(node.right);
  } else {
    node.op = { ">": ">=", "<=": "<" }[node.op];
    if (random_bool(random, 0.5)) node.left = minus1(node.left);
    else node.right = plus1(node.right);
  }
}

/**
 * Add a random amount of masks of 0xFF[FFFFFFFFFFFFFF] to a random expression
 * of integer type. For IDO these masks may get optimized out while still
 * affecting regalloc. The regalloc change seems to cycle with slight
 * differences every n masks.
 */
function perm_add_mask(fn, ast, indices, region, random) {
  const typemap = build_typemap(ast, fn);
  const cands = get_block_expressions(fn.body, region);
  ensure(cands);
  const expr = random.choice(cands);
  const type = decayed_expr_type(expr, typemap);
  ensure(allowed_basic_type(type, typemap, ["int", "char", "long", "short", "signed", "unsigned"]));
  const masks = ["0xFF", "0xFFFF", "0xFFFFFFFF", "0xFFFFFFFFFFFFFFFF"];
  const mask = random.choice(masks) + random.choice(["", "u"]);
  let new_expr = new ca.BinaryOp("&", expr, new ca.Constant("int", mask));
  if (random_bool(random, 0.3)) {
    const reps = random.randrange(12);
    for (let k = 0; k < reps; k++) new_expr = new ca.BinaryOp("&", new_expr, new ca.Constant("int", mask));
  }
  replace_node(fn.body, expr, new_expr);
}

/** Add ^0 to a random expression of integer type, or *1 to floats. */
function perm_xor_zero(fn, ast, indices, region, random) {
  const typemap = build_typemap(ast, fn);
  const cands = get_block_expressions(fn.body, region);
  ensure(cands);
  const expr = random.choice(cands);
  const type = decayed_expr_type(expr, typemap);
  const int_types = ["int", "char", "long", "short", "signed", "unsigned"];
  let new_expr;
  if (allowed_basic_type(type, typemap, int_types)) new_expr = new ca.BinaryOp("^", expr, new ca.Constant("int", "0"));
  else if (allowed_basic_type(type, typemap, ["float"])) new_expr = new ca.BinaryOp("*", expr, new ca.Constant("float", "1.0f"));
  else if (allowed_basic_type(type, typemap, ["double"])) new_expr = new ca.BinaryOp("*", expr, new ca.Constant("double", "1.0"));
  else throw new RandomizationFailure();
  replace_node(fn.body, expr, new_expr);
}

/** Convert 0 to x*0 for some randomly chosen x. */
function perm_mult_zero(fn, ast, indices, region, random) {
  const typemap = build_typemap(ast, fn);
  const cands = get_block_expressions(fn.body, region);
  ensure(cands);
  const expr = random.choice(cands);
  ensure_arithmetic_type(expr, typemap);
  ensure(!ast_util.is_effectful(expr));
  const zeroes = cands.filter((e) => e instanceof ca.Constant && ["0", "0.0", "0.0f"].includes(e.value));
  ensure(zeroes);
  const zero = random.choice(zeroes);
  const new_expr = new ca.BinaryOp("*", deepcopy(expr), zero);
  replace_node(fn.body, zero, new_expr);
}

/** Convert a * b to a * x * (b / x). */
function perm_factor_mult(fn, ast, indices, region, random) {
  const cands = get_block_expressions(fn.body, region).filter((e) => e instanceof ca.BinaryOp && e.op === "*"
    && (e.left instanceof ca.Constant || e.right instanceof ca.Constant));
  ensure(cands);
  const expr = random.choice(cands);
  let scale, expr0;
  if (expr.left instanceof ca.Constant) {
    scale = expr.left;
    expr0 = expr.right;
  } else {
    assert(expr.right instanceof ca.Constant);
    scale = expr.right;
    expr0 = expr.left;
  }
  const val = get_constant_int_value(scale);
  const absval = val < 0n ? -val : val;
  ensure(absval >= 2n);
  const factor_set = new Set();
  const lim = absval < 21n ? absval : 21n;
  for (let i = 2n; i < lim; i++) {
    if (pyMod(val, i) === 0n) {
      factor_set.add(i);
      factor_set.add(pyFloorDiv(val, i));
    }
  }
  let factors = [...factor_set].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (val < 0n) factors = factors.concat(factors.map((f) => -f));
  ensure(factors);
  const val1 = random.choice(factors);
  const val2 = pyFloorDiv(val, val1);
  const expr1 = new ca.BinaryOp("*", expr0, new ca.Constant("int", String(val1)));
  const expr2 = new ca.BinaryOp("*", expr1, new ca.Constant("int", String(val2)));
  for (const e of [expr1, expr2]) {
    if (random.randrange(2)) [e.left, e.right] = [e.right, e.left];
  }
  replace_node(fn.body, expr, expr2);
}

/** Python % on BigInts (result has the divisor's sign). */
function pyMod(a, b) { const r = a % b; return r !== 0n && (r < 0n) !== (b < 0n) ? r + b : r; }
/** Python // on BigInts. */
function pyFloorDiv(a, b) { return (a - pyMod(a, b)) / b; }

/** Convert a >> b to a >> x >> (b - x), or similar with <<. */
function perm_factor_shift(fn, ast, indices, region, random) {
  const cands = get_block_expressions(fn.body, region).filter((e) => e instanceof ca.BinaryOp
    && (e.op === "<<" || e.op === ">>") && e.right instanceof ca.Constant);
  ensure(cands);
  const expr = random.choice(cands);
  assert(expr.right instanceof ca.Constant);
  const lhs = expr.left;
  const rhs = get_constant_int_value(expr.right);
  ensure(rhs >= 2n);
  const val1 = BigInt(random.randint(1n, rhs - 1n));
  const val2 = rhs - val1;
  const expr1 = new ca.BinaryOp(expr.op, lhs, new ca.Constant("int", String(val1)));
  const expr2 = new ca.BinaryOp(expr.op, expr1, new ca.Constant("int", String(val2)));
  replace_node(fn.body, expr, expr2);
}

/** Converts a Float Literal */
function perm_float_literal(fn, ast, indices, region, random) {
  const cands = [];
  const visit = (node) => {
    if (node instanceof ca.Constant) {
      if (node.type === "float" && region.contains_node(node)) cands.push(node);
      return;
    }
    for (const c of node) visit(c);
  };
  visit(fn.body);
  ensure(cands);
  const node = random.choice(cands);
  let value = node.value.toLowerCase();
  const choices = [value.slice(0, -1)];
  if (value.endsWith(".0f")) choices.push(value.slice(0, -3) || "0");
  else if (value.endsWith(".f")) choices.push(value.slice(0, -2) || "0");
  if (value.startsWith("0.")) choices.push("." + (value.slice(2) || "0"));
  else if (value.startsWith(".")) choices.push("0" + value);
  if (value.endsWith(".0f")) choices.push((value.slice(0, -3) || "0") + ".f");
  else choices.push(value.slice(0, -1) + "0f");
  ensure(choices);
  value = random.choice(choices);
  let type;
  if (value.endsWith("f")) type = "float";
  else if (value.includes(".")) type = "double";
  else type = "int";
  replace_node(fn.body, node, new ca.Constant(type, value));
}

/** Cast a random expression to a simple type (integral or floating point only). */
function perm_cast_simple(fn, ast, indices, region, random) {
  const typemap = build_typemap(ast, fn);
  const cands = get_block_expressions(fn.body, region);
  ensure(cands);
  const expr = random.choice(cands);
  ensure_arithmetic_type(expr, typemap);
  const integral_type = [["int"], ["char"], ["long"], ["short"], ["long", "long"]];
  const floating_type = [["float"], ["double"]];
  let new_type;
  if (random_bool(random, 0.5)) {
    const sign = random.choice([[], ["unsigned"]]);
    new_type = sign.concat(random.choice(integral_type));
  } else {
    new_type = random.choice(floating_type);
  }
  const typedecl = new ca.TypeDecl(null, [], [], new ca.IdentifierType(new_type));
  const new_expr = new ca.Cast(new ca.Typename(null, [], null, [], typedecl), expr);
  replace_node(fn.body, expr, new_expr);
}

/** Permute struct references: (a + b)->c, and (*(a + b)).c, a[b].c, (&a[b])->c */
function perm_struct_ref(fn, ast, indices, region, random) {
  const cands = [];
  const visit = (node) => {
    if (node instanceof ca.StructRef) {
      if (region.contains_node(node)) cands.push(node);
    }
    for (const c of node) visit(c);
  };
  visit(fn.body);
  ensure(cands);

  const randomize_associative_binop = (left, right) => {
    if (random_bool(random, 0.5) && (right.op === "+" || right.op === "-")) {
      return new ca.BinaryOp(right.op, new ca.BinaryOp("+", left, right.left), right.right);
    }
    return new ca.BinaryOp("+", left, right);
  };
  const to_array = (node) => {
    if (node.op === "-") node.right = new ca.UnaryOp("-", node.right);
    return new ca.ArrayRef(node.left, node.right);
  };
  const to_binop = (node) => {
    if (node.subscript instanceof ca.BinaryOp) return randomize_associative_binop(node.name, node.subscript);
    return new ca.BinaryOp("+", node.name, node.subscript);
  };
  const deref = (node) => {
    if (node instanceof ca.UnaryOp && node.op === "&") {
      assert(!(node.expr instanceof ca.Typename));
      return node.expr;
    }
    return new ca.UnaryOp("*", node);
  };
  const addr = (node) => {
    if (node instanceof ca.UnaryOp && node.op === "*") {
      assert(!(node.expr instanceof ca.Typename));
      return node.expr;
    }
    return new ca.UnaryOp("&", node);
  };
  const rec = (node) => {
    if (node instanceof ca.UnaryOp) {
      ensure(node.op === "&" || node.op === "*");
      return rec(node.expr) || node;
    }
    if (node instanceof ca.StructRef) return rec(node.name) || node;
    return null;
  };
  const apply_child = (parent, func) => {
    if (parent instanceof ca.StructRef) parent.name = func(parent.name);
    else if (parent instanceof ca.UnaryOp) parent.expr = func(parent.expr);
  };
  const get_child = (parent) => {
    if (parent instanceof ca.StructRef) return parent.name;
    if (parent instanceof ca.UnaryOp) return parent.expr;
    return null;
  };

  const struct_ref = random.choice(cands);
  let parent = rec(struct_ref);
  let changed = false;
  if (struct_ref.type === "->") {
    struct_ref.type = ".";
    if (parent === struct_ref.name && parent instanceof ca.UnaryOp && parent.op === "&") {
      struct_ref.name = deref(struct_ref.name);
      parent = struct_ref;
    } else {
      struct_ref.name = deref(struct_ref.name);
      if (parent === struct_ref && struct_ref.name instanceof ca.UnaryOp) parent = struct_ref.name;
    }
    changed = true;
  }
  if (isa(get_child(parent), ca.ArrayRef, ca.BinaryOp)) {
    if (get_child(parent) instanceof ca.ArrayRef) {
      apply_child(parent, to_binop);
      apply_child(parent, deref);
      parent = get_child(parent);
      changed = true;
    }
    if (random_bool(random, 0.5)) {
      if (parent instanceof ca.UnaryOp && parent.op === "*") {
        apply_child(parent, to_array);
        apply_child(parent, addr);
        changed = true;
      }
    }
  }
  if (random_bool(random, 0.5)) {
    struct_ref.name = addr(struct_ref.name);
    struct_ref.type = "->";
    changed = true;
  }
  ensure(changed);
}

/**
 * Split assignments of the form `a = b . c . d ...;` into
 * `a = b; a = a . c . d ...;` or `a = c . d ...; a = b . a;` or similar.
 */
function perm_split_assignment(fn, ast, indices, region, random) {
  const cands = [];
  const visit = (node) => {
    if (node instanceof ca.Assignment) {
      if (node.op === "=" && node.rvalue instanceof ca.BinaryOp && region.contains_node(node)) cands.push(node);
    }
    for (const c of node) visit(c);
  };
  visit(fn.body);
  ensure(cands);
  const assign = random.choice(cands);
  const v = assign.lvalue;
  const ins_cands = get_insertion_points(fn, region);
  let ins_block, ins_index, found = false;
  for (const [b, idx, , node] of ins_cands) {
    ins_block = b; ins_index = idx;
    if (node === assign) { found = true; break; }
  }
  if (!found) throw new RandomizationFailure();
  const binops = [];
  const collect_binops = (node) => {
    if (node.left instanceof ca.BinaryOp) collect_binops(node.left);
    binops.push(node);
    if (node.right instanceof ca.BinaryOp) collect_binops(node.right);
  };
  collect_binops(assign.rvalue);
  const split = random.choice(binops);
  const typemap = build_typemap(ast, fn);
  const vartype = decayed_expr_type(v, typemap);
  let side;
  if (random_bool(random, 0.5)) {
    side = split.left;
    const sidetype = decayed_expr_type(side, typemap);
    ensure(same_type(vartype, sidetype, typemap, true));
    split.left = deepcopy(v);
  } else {
    side = split.right;
    const sidetype = decayed_expr_type(side, typemap);
    ensure(same_type(vartype, sidetype, typemap, true));
    split.right = deepcopy(v);
  }
  const new_assign = new ca.Assignment("=", deepcopy(v), side);
  ast_util.insert_statement(ins_block, ins_index, new_assign);
}

/** Delete parts of the function that might be unnecessary (mistakes or unnecessary changes from an improved base.c). */
function perm_remove_ast(fn, ast, indices, region, random) {
  const cands = [];
  const visit = (node) => {
    if (node instanceof ca.Cast) {
      if (region.contains_node(node)) cands.push([node, node.expr]);
    } else if (node instanceof ca.BinaryOp) {
      if (region.contains_node(node) && node.op === "&") {
        if (node.left instanceof ca.Constant) cands.push([node, node.right]);
        if (node.right instanceof ca.Constant) cands.push([node, node.left]);
      }
    } else if (node instanceof ca.If) {
      if (!node.iffalse && region.contains_node(node)) cands.push([node, node.iftrue]);
    } else if (node instanceof ca.While || node instanceof ca.DoWhile) {
      if (region.contains_node(node)) cands.push([node, node.stmt]);
    }
    for (const c of node) visit(c);
  };
  visit(fn.body);
  ensure(cands);
  const [cand, expr] = random.choice(cands);
  replace_node(fn.body, cand, expr);
}

/** Duplicate an assignment, sometimes forcing IDO to reuse a register. */
function perm_duplicate_assignment(fn, ast, indices, region, random) {
  const cands = [];
  const visit = (node) => {
    if (node instanceof ca.Assignment) {
      if (region.contains_node(node) && node.op === "=") cands.push(node);
    }
    for (const c of node) visit(c);
  };
  visit(fn.body);
  ensure(cands);
  const cand = random.choice(cands);
  const ins_cands = get_insertion_points(fn, Region.unbounded());
  ensure(ins_cands);
  const dup = deepcopy(cand);
  const [tob, toi] = random.choice(ins_cands);
  ast_util.insert_statement(tob, toi, dup);
}

/** Combine two assignments into one chain assignment. */
function perm_chain_assignment(fn, ast, indices, region, random) {
  const cands = [];
  const rec = (block) => {
    const statements = ast_util.get_block_stmts(block, false);
    statements.forEach((stmt, i) => {
      if (!(stmt instanceof ca.Assignment) || !region.contains_node(stmt)) return;
      statements.slice(i + 1, i + 5).forEach((next_stmt, k) => {
        const j = i + 1 + k;
        if (region.contains_node(next_stmt) && next_stmt instanceof ca.Assignment
          && (ast_util.equal_ast(stmt.lvalue, next_stmt.rvalue) || ast_util.equal_ast(stmt.rvalue, next_stmt.rvalue))
          && !ast_util.is_effectful(next_stmt.rvalue)) cands.push([i, j, block]);
      });
    });
    for (const stmt of statements) ast_util.for_nested_blocks(stmt, rec);
  };
  rec(fn.body);
  ensure(cands);
  const [chosen_assignment_idx, next_stmt_idx, block] = random.choice(cands);
  const statements = ast_util.get_block_stmts(block, true);
  const stmt = statements[chosen_assignment_idx];
  const next_stmt = statements[next_stmt_idx];
  assert(stmt instanceof ca.Assignment);
  assert(next_stmt instanceof ca.Assignment);
  let new_lvalue, new_rvalue;
  if (random_bool(random, 0.5)) {
    new_lvalue = next_stmt.lvalue;
    new_rvalue = stmt;
  } else {
    new_lvalue = stmt.lvalue;
    new_rvalue = new ca.Assignment("=", next_stmt.lvalue, stmt.rvalue);
  }
  statements[chosen_assignment_idx] = new ca.Assignment("=", new_lvalue, new_rvalue);
  statements.splice(next_stmt_idx, 1);
}

/** Create a long chain assignment out of 3 or more consecutive assignments with equal rvalue */
function perm_long_chain_assignment(fn, ast, indices, region, random) {
  const cands = [];
  const rec = (block) => {
    const statements = ast_util.get_block_stmts(block, false);
    let i = 0;
    while (statements.length > i) {
      let j = i + 1;
      const stmt = statements[i];
      if (stmt instanceof ca.Assignment && region.contains_node(stmt) && !ast_util.is_effectful(stmt.rvalue)) {
        while (statements.length > j) {
          const additional_stmt = statements[j];
          if (additional_stmt instanceof ca.Assignment && ast_util.equal_ast(stmt.rvalue, additional_stmt.rvalue)
            && region.contains_node(additional_stmt)) j += 1;
          else break;
        }
        if (j > i + 2) cands.push([i, j, block]);
      }
      i = j;
    }
    for (const s of statements) ast_util.for_nested_blocks(s, rec);
  };
  rec(fn.body);
  ensure(cands);
  let [start_idx, end_idx, block] = random.choice(cands);
  const a = random.randint(start_idx, end_idx);
  const b = random.randint(start_idx, end_idx);
  if (a + 3 <= b) { start_idx = a; end_idx = b; }
  const statements = ast_util.get_block_stmts(block, true);
  const stmt = statements[start_idx];
  assert(stmt instanceof ca.Assignment);
  for (let i = start_idx + 1; i < end_idx; i++) {
    const additional_stmt = statements[i];
    assert(additional_stmt instanceof ca.Assignment);
    const new_lvalue = additional_stmt.lvalue;
    stmt.rvalue = deepcopy(stmt);
    stmt.lvalue = new_lvalue;
  }
  statements.splice(start_idx + 1, end_idx - (start_idx + 1));
}

/** Inserts an unused variable to adjust stack offsets. Probably only useful with --stack-diffs enabled. */
function perm_pad_var_decl(fn, ast, indices, region, random) {
  const vars = [];
  const visit = (node) => {
    if (node instanceof ca.Decl && truthy(node.name)) vars.push(node.name);
    for (const c of node) visit(c);
  };
  visit(fn.body);
  let varName = "pad";
  let counter = 1;
  while (vars.includes(varName)) {
    counter += 1;
    varName = `pad${counter}`;
  }
  const type = random_type(random);
  ast_util.insert_decl(fn, varName, type, random);
}

function cut_ast(expr, cut_prob, typemap, random) {
  const cut_types = new Map();
  const callback = (node, is_expr, prob = cut_prob) => {
    let cut;
    if (node instanceof ca.ID && is_local_var(node.name, typemap)) {
      ensure(is_expr);
      cut = true;
    } else {
      cut = is_expr && random_bool(random, prob);
    }
    if (cut) {
      const tp = decayed_expr_type(node, typemap);
      const new_expr = new ca.ID("");
      cut_types.set(new_expr, tp);
      return new_expr;
    }
    return null;
  };
  expr = deepcopy(expr);
  const toplevel_expr = callback(expr, true, 0.05);
  if (toplevel_expr) return [toplevel_expr, cut_types];
  visit_replace(expr, (node, is_expr) => callback(node, is_expr));
  return [expr, cut_types];
}

function match_cut(node, cut_node, cut_types, out_exprs, typemap) {
  const cmp = (n, cn) => {
    if (!(cn instanceof ca.ID)) return null;
    const cut_tp = cut_types.get(cn);
    if (cut_tp == null) return null;
    const expr = ast_util.as_expr(n);
    if (expr == null) return null;
    const tp = decayed_expr_type(expr, typemap);
    if (!same_type(tp, cut_types.get(cn), typemap, true)) return false;
    out_exprs.push(expr);
    return true;
  };
  return ast_util.equal_ast(node, cut_node, cmp);
}

/** Creates an inline function for a random expression, possibly occurring in multiple places. */
function perm_inline(fn, ast, indices, region, random) {
  const typemap = build_typemap(ast, fn);
  const cands = [];
  for (const cand of get_block_expressions(fn.body, region)) {
    let prob;
    if (cand instanceof ca.ID) prob = 0.05;
    else if (cand instanceof ca.Constant) prob = 0.01;
    else prob = 1.0;
    cands.push([cand, prob]);
  }
  ensure(cands);
  const chosen_cand = random_weighted(random, cands);
  const ret_type = decayed_expr_type(chosen_cand, typemap);
  const new_fn_name = get_noncolliding_name(ast, "inline_fn");
  const cut_prob = random.uniform(0, 1) * random.uniform(0, 1);
  const [cut_expr, cut_types] = cut_ast(chosen_cand, cut_prob, typemap, random);
  if (!cut_types.size && random_bool(random, 0.5)) throw new RandomizationFailure();
  let cands2 = [];
  if (cut_types.has(cut_expr)) cands2 = [chosen_cand];
  else {
    for (const [cand2] of cands) if (match_cut(cand2, cut_expr, cut_types, [], typemap)) cands2.push(cand2);
  }
  assert(cands2.includes(chosen_cand));
  const subset = pick_random_subset(random, cands2, cands2.indexOf(chosen_cand));
  for (const expr of subset) {
    const args = [];
    if (!match_cut(expr, cut_expr, cut_types, args, typemap)) continue;
    const fn_call = new ca.FuncCall(new ca.ID(new_fn_name), new ca.ExprList(args.slice()));
    replace_node(fn.body, expr, fn_call);
  }
  const params = [];
  let i = 0;
  for (const [cut, tp] of cut_types) {
    cut.name = `arg${i}`;
    params.push(ast_util.make_decl(cut.name, tp));
    i++;
  }
  const return_expr = cut_expr;
  const fn_def = new ca.FuncDef({
    decl: ast_util.make_decl(new_fn_name, new ca.FuncDecl({ args: new ca.ParamList(params.slice()), type: deepcopy(ret_type) }),
      { funcspec: ["inline"] }),
    param_decls: [],
    body: new ca.Compound({ block_items: [new ca.Return(return_expr)] }),
  });
  ast.ext.splice(ast.ext.indexOf(fn), 0, fn_def);
}

/**
 * Wrap a random range of statements within `if (variable) { ... }` or
 * `if (struct.member)` and duplicate them in the else block. This can force
 * the compiler to emit a useless move. Control flow can have remote effects,
 * so this mostly ignores the region restriction.
 */
function perm_var_cond_block(fn, ast, indices, region, random) {
  const cands = [];
  const rec = (block) => {
    cands.push(block);
    for (const stmt of ast_util.get_block_stmts(block, false)) ast_util.for_nested_blocks(stmt, rec);
  };
  rec(fn.body);
  const block = random.choice(cands);
  const stmts = ast_util.get_block_stmts(block, true);
  let streaks = [];
  let streak_start = 0;
  stmts.forEach((stmt, i) => {
    if (isa(stmt, ca.If, ca.For, ca.While, ca.DoWhile, ca.Switch, ca.Label, ca.Case, ca.Default, ca.Compound,
      ca.Decl, ca.Typedef, ca.Pragma)) {
      streaks.push([streak_start, i]);
      streak_start = i + 1;
    }
  });
  streaks.push([streak_start, stmts.length]);
  streaks = streaks.filter(([i, j]) => i !== j);
  ensure(streaks);
  const [lo, hi] = random.choice(streaks);
  const new_block = new ca.Compound({ block_items: stmts.slice(lo, hi) });
  let cand_exprs = get_block_expressions(fn.body, region).filter((expr) => isa(expr, ca.StructRef, ca.ID));
  ensure(cand_exprs);
  const expr = random.choice(cand_exprs);
  ensure(!ast_util.is_effectful(expr));
  const typemap = build_typemap(ast, fn);
  const make_cond = (e) => {
    const type = resolve_typedefs(decayed_expr_type(e, typemap), typemap);
    if (type instanceof ca.TypeDecl && isa(type.type, ca.Struct, ca.Union)) e = new ca.UnaryOp("&", e);
    return deepcopy(e);
  };
  let cond = make_cond(expr);
  if (random_bool(random, PROB_VAR_COND_BLOCK_OR)) {
    cand_exprs = cand_exprs.filter((e) => !ast_util.equal_ast(e, expr));
    ensure(cand_exprs);
    const expr2 = random.choice(cand_exprs);
    if (!ast_util.is_effectful(expr2)) cond = new ca.BinaryOp("||", cond, make_cond(expr2));
  }
  stmts.splice(lo, hi - lo, new ca.If({ cond, iftrue: new_block, iffalse: deepcopy(new_block) }));
}

/** Replace two same-type variables by an array. */
function perm_alias_array(fn, ast, indices, region, random) {
  const mentioned_names = new Set(get_mentioned_names(fn, region));
  const typemap = build_typemap(ast, fn);
  const cands_by_type = [];
  const all_names = new Set();
  const stmts = ast_util.get_block_stmts(fn.body, false);
  stmts.forEach((decl, i) => {
    if (!(decl instanceof ca.Decl) || !truthy(decl.name)) return;
    all_names.add(decl.name);
    if (decl.init || !mentioned_names.has(decl.name)) return;
    const tp = get_decl_type(decl);
    const real_type = resolve_typedefs(tp, typemap);
    if (real_type instanceof ca.ArrayDecl) return;
    let arr = null;
    for (const [t, a] of cands_by_type) {
      if (same_type(t, tp, typemap, true)) { arr = a; break; }
    }
    if (arr == null) {
      arr = [];
      cands_by_type.push([tp, arr]);
    }
    arr.push([i, decl]);
  });
  const cands = cands_by_type.filter(([, decls]) => decls.length >= 2);
  ensure(cands);
  const [tp, decls] = random.choice(cands);
  const [[i1, decl1], [i2, decl2]] = random.sample(decls, 2);
  assert(truthy(decl1.name));
  assert(truthy(decl2.name));
  const array_ind = new Map([[decl1.name, 0], [decl2.name, 1]]);
  let varName = "new_var";
  let counter = 1;
  while (all_names.has(varName)) {
    counter += 1;
    varName = `new_var${counter}`;
  }
  const arr_tp = new ca.ArrayDecl(tp, new ca.Constant("int", "2"), []);
  stmts[Math.min(i1, i2)] = ast_util.make_decl(varName, arr_tp);
  stmts.splice(Math.max(i1, i2), 1);
  const callback = (node) => {
    if (!(node instanceof ca.ID) || !array_ind.has(node.name)) return null;
    return new ca.ArrayRef(new ca.ID(varName), new ca.Constant("int", String(array_ind.get(node.name))));
  };
  visit_replace(fn.body, callback);
}

export const RANDOMIZATION_PASSES = [
  perm_temp_for_expr,
  perm_expand_expr,
  perm_reorder_stmts,
  perm_reorder_decls,
  perm_add_mask,
  perm_xor_zero,
  perm_cast_simple,
  perm_refer_to_var,
  perm_float_literal,
  perm_randomize_internal_type,
  perm_randomize_external_type,
  perm_randomize_function_type,
  perm_split_assignment,
  perm_sameline,
  perm_ins_block,
  perm_struct_ref,
  perm_empty_stmt,
  perm_condition,
  perm_mult_zero,
  perm_factor_mult,
  perm_factor_shift,
  perm_dummy_comma_expr,
  perm_add_self_assignment,
  perm_commutative,
  perm_add_sub,
  perm_inequalities,
  perm_compound_assignment,
  perm_remove_ast,
  perm_duplicate_assignment,
  perm_chain_assignment,
  perm_long_chain_assignment,
  perm_pad_var_decl,
  perm_inline,
  perm_var_cond_block,
  perm_alias_array,
];

/** One-line docs per pass (upstream's docstrings, for --help=randomization-passes). */
export const PASS_DOCS = {
  perm_temp_for_expr: "Create a temporary variable for a random expression. The variable will be assigned at another random point (nearer the expression being more likely), possibly reuse an existing variable, possibly be of a different size/signedness, and possibly be used for other identical expressions as well. Only expressions within the given region may be chosen for replacement, but the assignment and the affected identical expressions may be outside of it.",
  perm_expand_expr: "Replace a random variable by its contents.",
  perm_reorder_stmts: "Move a statement to another random place.",
  perm_reorder_decls: "Move a declaration to another random place.",
  perm_add_mask: "Add a random amount of masks of 0xFF[FFFFFFFFFFFFFF] to a random expression of integer type. For IDO these masks may get optimized out while still affecting regalloc. The regalloc change seems to cycle with slight differences every n masks.",
  perm_xor_zero: "Add ^0 to a random expression of integer type, or *1 to floats.",
  perm_cast_simple: "Cast a random expression to a simple type (integral or floating point only).",
  perm_refer_to_var: "Add `if (variable) {}` or `if (struct.member) {}` in a random place. This will get optimized away but may affect regalloc.",
  perm_float_literal: "Converts a Float Literal",
  perm_randomize_internal_type: "Randomize types of pre-existing local variables. Function parameters are not included -- those are handled by perm_randomize_function_type. Only variables mentioned within the given region are affected.",
  perm_randomize_external_type: "Randomize types of global variables. Only variables mentioned within the given region are affected.",
  perm_randomize_function_type: "Randomize types of function parameters and returns. Only functions called within the given region are affected, plus the current function.",
  perm_split_assignment: "Split assignments of the form `a = b . c . d ...;` into `a = b; a = a . c . d ...;` or `a = c . d ...; a = b . a;` or similar.",
  perm_sameline: "Put all statements within a random interval on the same line.",
  perm_ins_block: "Wrap a random range of statements within `if (1) { ... }` or `do { ... } while(0)`. Control flow can have remote effects, so this mostly ignores the region restriction.",
  perm_struct_ref: "Permute struct references: (a + b)->c, and (*(a + b)).c, a[b].c, (&a[b])->c",
  perm_empty_stmt: "Inserts a no-op statement, one of: if (1) {} (sometimes multiple of them); if (0) {}; do {} while (0); label:; goto label; label:;; ;. Control flow can have remote effects, so this ignores the region restriction.",
  perm_condition: "Change if(x) into if(x != 0), or vice versa. Also handles for/while/do-while.",
  perm_mult_zero: "Convert 0 to x*0 for some randomly chosen x.",
  perm_factor_mult: "Convert a * b to a * x * (b / x).",
  perm_factor_shift: "Convert a >> b to a >> x >> (b - x), or similar with <<.",
  perm_dummy_comma_expr: "Change x into (0, x) for a random expression x.",
  perm_add_self_assignment: "Introduce a \"x = x;\", \"x += 0;\" or \"x++; x--;\" somewhere.",
  perm_commutative: "Change a+b into b+a, or similar for other commutative operations.",
  perm_add_sub: "Change a-b into a+(-b), or a+b into a-(-b).",
  perm_inequalities: "Adjusts inequalities to equivalent versions that sometimes produce different code. For example, a > b and a >= b + 1, a < b to a <= b - 1 (and vice versa)",
  perm_compound_assignment: "Convert a statement of the form `x = x op y` to `x op= y`, or vice versa.",
  perm_remove_ast: "Delete parts of the function that might be unnecessary (mistakes or unnecessary changes from an improved base.c).",
  perm_duplicate_assignment: "Duplicate an assignment, sometimes forcing IDO to reuse a register.",
  perm_chain_assignment: "Combine two assignments into one chain assignment.",
  perm_long_chain_assignment: "Create a long chain assignment out of 3 or more consecutive assignments with equal rvalue",
  perm_pad_var_decl: "Inserts an unused variable to adjust stack offsets. Probably only useful with --stack-diffs enabled.",
  perm_inline: "Creates an inline function for a random expression, possibly occurring in multiple places.",
  perm_var_cond_block: "Wrap a random range of statements within `if (variable) { ... }` or `if (struct.member)` and duplicate them in the else block. This can force the compiler to emit a useless move. Control flow can have remote effects, so this mostly ignores the region restriction.",
  perm_alias_array: "Replace two same-type variables by an array.",
};

export class Randomizer {
  /**
   * @param {Record<string, number>|Map<string, number>} randomization_weights
   * @param {number|bigint} rng_seed
   */
  constructor(randomization_weights, rng_seed) {
    this.random = new PyRandom(rng_seed);
    const w = randomization_weights instanceof Map ? randomization_weights : new Map(Object.entries(randomization_weights));
    for (const method of RANDOMIZATION_PASSES) {
      if (!w.has(method.name)) throw new Error(`Error: missing value for ${method.name} in default_weights.toml`);
    }
    this.methods = RANDOMIZATION_PASSES.map((method) => [method, w.get(method.name)]);
  }

  randomize(ast, fn_name) {
    const fn = ast_util.extract_fn(ast, fn_name)[0];
    const indices = ast_util.compute_node_indices(fn);
    const region = get_randomization_region(fn, indices, this.random);
    for (;;) {
      const method = random_weighted(this.random, this.methods);
      try {
        method(fn, ast, indices, region, this.random);
        this.lastPass = method.name;
        break;
      } catch (e) {
        if (!(e instanceof RandomizationFailure)) throw e;
      }
    }
  }
}

// Internals exported for the per-pass tests.
export const _internal = {
  Region, get_randomization_region, visit_replace, replace_subexprs, get_insertion_points, get_block_expressions, random_weighted,
  compute_write_locations, compute_read_locations, find_var_reads, isAssertion, Node,
};
