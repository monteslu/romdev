// ast.js - late (AST-level) PERM macros, a port of decomp-permuter's src/perm/ast.py.
import { c_ast as ca } from "romdev-pycparser";
import * as ast_util from "../ast_util.js";
import { CandidateConstructionFailure } from "../error.js";

class Done extends Error {}

/** Find and apply a single late perm macro in the AST. */
function _apply_perm(fn, perm_id, perm, seed) {
  const wanted_pragma = `_permuter ast_perm ${perm_id}`;
  const try_handle_block = (block, where) => {
    if (!(block instanceof ca.Compound) || !ast_util.truthy(block.block_items)) return;
    const pragma = block.block_items[0];
    if (!(pragma instanceof ca.Pragma) || pragma.string !== wanted_pragma) return;
    const args = block.block_items.slice(1);
    const stmts = perm.eval_statement_ast(args, seed);
    if (where) where[0].splice(where[1], 1, ...stmts);
    else block.block_items = stmts;
    throw new Done();
  };
  const rec = (block) => {
    try_handle_block(block, null);
    const stmts = ast_util.get_block_stmts(block, false);
    stmts.forEach((stmt, i) => {
      try_handle_block(stmt, [stmts, i]);
      ast_util.for_nested_blocks(stmt, rec);
    });
  };
  try {
    rec(fn.body);
    throw new CandidateConstructionFailure("Failed to find PERM macro in AST.");
  } catch (e) {
    if (!(e instanceof Done)) throw e;
  }
}

/** Find all late perm macros in the AST and apply them (lowest id first). */
export function apply_ast_perms(fn, eval_state) {
  eval_state.ast_perms.forEach(([perm, seed], perm_id) => _apply_perm(fn, perm_id, perm, seed));
}
