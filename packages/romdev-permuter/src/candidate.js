// candidate.js - decomp-permuter's src/candidate.py: an AST candidate that can
// be randomized, printed, compiled and scored.
import * as ast_util from "./ast_util.js";
import { Randomizer } from "./randomizer.js";
import { apply_ast_perms } from "./perm/ast.js";
import { tryRemove } from "./compiler.js";

/** @typedef {{score: number, hash: string|null, source: string|null, profiler?: any}} CandidateResult */

// functools.lru_cache(maxsize=16) over (source, fn_name).
const SHARED_AST_CACHE = new Map();
const CACHE_SIZE = 16;

function cachedSharedAst(source, fn_name) {
  const key = fn_name + "\u0000" + source;
  if (SHARED_AST_CACHE.has(key)) {
    const v = SHARED_AST_CACHE.get(key);
    SHARED_AST_CACHE.delete(key);
    SHARED_AST_CACHE.set(key, v);
    return v;
  }
  const ast = ast_util.parse_c(source);
  const [orig_fn, fn_index] = ast_util.extract_fn(ast, fn_name);
  ast_util.normalize_ast(orig_fn, ast);
  const v = [orig_fn, fn_index, ast];
  SHARED_AST_CACHE.set(key, v);
  if (SHARED_AST_CACHE.size > CACHE_SIZE) SHARED_AST_CACHE.delete(SHARED_AST_CACHE.keys().next().value);
  return v;
}

export class Candidate {
  constructor({ ast, fn_name, rng_seed, randomizer }) {
    this.ast = ast;
    this.fn_name = fn_name;
    this.rng_seed = rng_seed;
    this.randomizer = randomizer;
    this.score_value = null;
    this.score_hash = null;
    this._cache_source = null;
  }

  static from_source(source, eval_state, fn_name, randomization_weights, rng_seed) {
    // Share the AST between candidates of the same source, deep-copying only
    // the target function (the rest is never mutated in place).
    const [orig_fn, fn_index, shared] = cachedSharedAst(source, fn_name);
    const ast = ast_util.shallowCopy(shared);
    ast.ext = shared.ext.slice();
    const fn_copy = ast_util.deepcopy(orig_fn);
    ast.ext[fn_index] = fn_copy;
    apply_ast_perms(fn_copy, eval_state);
    return new Candidate({ ast, fn_name, rng_seed, randomizer: new Randomizer(randomization_weights, rng_seed) });
  }

  randomize_ast() {
    this.randomizer.randomize(this.ast, this.fn_name);
    this._cache_source = null;
  }

  get_source() {
    if (this._cache_source == null) this._cache_source = ast_util.to_c(this.ast);
    return this._cache_source;
  }

  compile(compiler, show_errors = false) { return compiler.compile(this.get_source(), { show_errors }); }

  /** @returns {Promise<CandidateResult>} */
  async score(scorer, o_file) {
    this.score_value = null;
    this.score_hash = null;
    try {
      [this.score_value, this.score_hash] = await scorer.score(o_file);
    } finally {
      if (o_file) tryRemove(o_file);
    }
    return { score: this.score_value, hash: this.score_hash, source: this.get_source() };
  }
}
