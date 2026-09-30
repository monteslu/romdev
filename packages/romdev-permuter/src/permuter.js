// permuter.js - decomp-permuter's src/permuter.py: one source from which
// candidates are generated, tracking the best scores seen so far.
import { createHash } from "node:crypto";
import { Candidate } from "./candidate.js";
import { CandidateConstructionFailure } from "./error.js";
import { EvalState } from "./perm/perm.js";
import { perm_evaluate_one, perm_gen_all_seeds } from "./perm/eval.js";
import { perm_parse } from "./perm/parse.js";
import { trim_source } from "./helpers.js";
import { unified_diff } from "./difflib.js";
import { globalRandom } from "./pyrandom.js";
import { PENALTY_INF } from "./scorer.js";

/** @typedef {{exc_str: string|null, seed: [bigint, bigint]|null, isEvalError: true}} EvalError */

class CompileFailure extends Error {}

/** Python str.strip() for the whitespace-insensitive diff. */
const strip = (s) => s.replace(/^\s+|\s+$/g, "");

export class Permuter {
  /**
   * Use Permuter.create(): scoring the base is asynchronous.
   * @param {object} a
   */
  constructor({ dir, fn_name, compiler, scorer, source_file, source, randomization_weights, force_seed = null,
    force_rng_seed = null, keep_prob, need_profiler = false, need_all_sources = false, show_errors = false,
    best_only = false, better_only = false, score_threshold = null, debug_mode = false, speed = 100,
    log = (s) => console.log(s), random = globalRandom }) {
    this.dir = dir;
    this.compiler = compiler;
    this.scorer = scorer;
    this.source_file = source_file;
    this.source = source;
    this.randomization_weights = randomization_weights;
    this.log = log;
    this.random = random;
    if (fn_name == null) {
      const fns = _find_fns(source);
      if (fns.length === 0) throw new Error(`${this.source_file} does not contain any function!`);
      this.fn_name = fns[fns.length - 1];
      log(`Defaulting to function: ${this.fn_name}`);
    } else {
      this.fn_name = fn_name;
    }
    this.unique_name = this.fn_name;
    this._permutations = perm_parse(source, log);
    this._force_seed = force_seed;
    this._force_rng_seed = force_rng_seed;
    this._cur_seed = null;
    this.keep_prob = keep_prob;
    this.need_profiler = need_profiler;
    this._need_all_sources = need_all_sources;
    this._show_errors = show_errors;
    this._best_only = best_only;
    this._better_only = better_only;
    this._score_threshold = score_threshold;
    this._debug_mode = debug_mode;
    this._cur_cand = null;
    this._last_score = null;
    /** @type {Map<string, number>} */
    this._score_for_source = new Map();
    this.speed = speed;
  }

  /**
   * Build a permuter and score its base (compiling it). `base` may carry an
   * already-computed {score, hash, source} (worker threads reuse the parent's).
   */
  static async create(opts, base = null) {
    const p = new Permuter(opts);
    if (base) [p.base_score, p.base_hash, p.base_source] = [base.score, base.hash, base.source];
    else [p.base_score, p.base_hash, p.base_source] = await p._create_and_score_base();
    p.best_score = p.base_score;
    p.hashes = new Set([p.base_hash]);
    return p;
  }

  async _create_and_score_base() {
    const [base_source, eval_state] = perm_evaluate_one(this._permutations);
    const base_cand = Candidate.from_source(base_source, eval_state, this.fn_name, this.randomization_weights, 0);
    if (this._debug_mode) this.log(trim_source(base_cand.get_source(), this.fn_name));
    const o_file = await base_cand.compile(this.compiler, true);
    if (!o_file) throw new CandidateConstructionFailure(`Unable to compile ${this.source_file}`);
    const base_result = await base_cand.score(this.scorer, o_file);
    if (base_result.hash == null) throw new Error("AssertionError: base hash");
    return [base_result.score, base_result.hash, base_cand.get_source()];
  }

  _need_to_send_source(result) { return this._need_all_sources || this.should_output(result); }

  async _eval_candidate(seed) {
    const timings = { perm: 0, stringify: 0, compile: 0, score: 0 };
    let t = performance.now();
    const tick = () => { const now = performance.now(); const d = (now - t) / 1000; t = now; return d; };
    // Keep the previous candidate with probability keep_prob (never a zero or
    // failed one: those only breed worse zeroes / more failures).
    const keep = (this._permutations.is_random() && this.random.uniform(0, 1) < this.keep_prob
      && this._last_score !== 0 && this._last_score !== PENALTY_INF) || !!this._force_rng_seed;
    this._last_score = null;
    if (!this._cur_cand || !keep) {
      const eval_state = new EvalState();
      const cand_c = this._permutations.evaluate(BigInt(seed), eval_state);
      const rng_seed = this._force_rng_seed ? this._force_rng_seed : this.random.randrange(1n, 10n ** 20n);
      this._cur_seed = [BigInt(seed), BigInt(rng_seed)];
      this._cur_cand = Candidate.from_source(cand_c, eval_state, this.fn_name, this.randomization_weights, rng_seed);
    }
    if (this._permutations.is_random()) this._cur_cand.randomize_ast();
    timings.perm += tick();
    const cand_source = this._cur_cand.get_source();
    const source_hash = createHash("sha256").update(cand_source, "utf8").digest("hex");
    timings.stringify += tick();
    const old_score = this._score_for_source.get(source_hash);
    let result;
    if (old_score !== undefined) {
      result = { score: old_score, hash: null, source: cand_source };
    } else {
      const o_file = await this._cur_cand.compile(this.compiler);
      if (!o_file && this._show_errors) throw new CompileFailure();
      timings.compile += tick();
      result = await this._cur_cand.score(this.scorer, o_file);
      timings.score += tick();
      if (this._score_for_source.size < 100000) this._score_for_source.set(source_hash, result.score);
    }
    if (this.need_profiler) result.profiler = timings;
    result.pass = this._cur_cand.randomizer.lastPass ?? null;
    this._last_score = result.score;
    if (!this._need_to_send_source(result)) {
      result.source = null;
      result.hash = null;
    }
    return result;
  }

  /** Whether a result should be written out (more liberal in workers than in the parent). */
  should_output(result) {
    return result.score <= this.base_score
      && result.hash != null
      && result.source != null
      && !(result.score > this.best_score && this._best_only)
      && (result.score < this.base_score || (result.score === this.base_score && !this._better_only))
      && (this._score_threshold == null || result.score < this._score_threshold)
      && !this.hashes.has(result.hash);
  }

  /** Record a result: best score, and its hash (except zeroes: every zero is interesting). */
  record_result(result) {
    this.best_score = Math.min(this.best_score, result.score);
    if (result.score !== 0 && result.hash != null) this.hashes.add(result.hash);
  }

  /** Seeds for this permuter: infinite when randomizing. */
  *seed_iterator() {
    if (this._force_seed == null) {
      yield* perm_gen_all_seeds(this._permutations, this.random);
      return;
    }
    if (this._permutations.is_random()) {
      for (;;) yield BigInt(this._force_seed);
    }
    yield BigInt(this._force_seed);
  }

  /** @returns {Promise<import("./candidate.js").CandidateResult | EvalError>} */
  async try_eval_candidate(seed) {
    try {
      return await this._eval_candidate(seed);
    } catch (e) {
      if (e instanceof CompileFailure) return { isEvalError: true, exc_str: null, seed: this._cur_seed };
      return { isEvalError: true, exc_str: formatException(e), seed: this._cur_seed };
    }
  }

  /** Unified, whitespace-insensitive diff of the base source against another source. */
  diff(other_source) {
    const a = this.base_source.split("\n");
    const b = other_source.split("\n");
    return unified_diff(a, b, { fromfile: "before", tofile: "after", lineterm: "", key: strip }).join("\n");
  }
}

export function formatException(e) {
  if (e && e.stack) return String(e.stack);
  return String(e);
}

function _find_fns(source) {
  const fns = [...source.matchAll(/(\w+)\([^()\n]*\)\s*?{/g)].map((m) => m[1]);
  return fns.filter((fn) => !fn.startsWith("PERM") && !["if", "for", "switch", "while"].includes(fn));
}
