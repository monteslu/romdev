// perm.js - PERM macro evaluation, a port of decomp-permuter's src/perm/perm.py.
//
// Seeds and permutation counts are BigInts: a PERM_LINESWAP of n lines has n!
// variants, which leaves Number's exact range quickly (Python ints are exact).
import { c_ast as ca } from "romdev-pycparser";

export class PreprocessState {
  constructor() {
    /** @type {Map<string, Perm[]>} (a defaultdict(list) in upstream) */
    this.once_options = new Map();
  }
}

export class EvalState {
  constructor() {
    /** @type {Map<string, string>} */
    this.vars = new Map();
    /** @type {Map<string, Perm>} */
    this.once_choices = new Map();
    /** @type {[Perm, bigint][]} */
    this.ast_perms = [];
  }

  register_ast_perm(perm, seed) {
    const ret = this.ast_perms.length;
    this.ast_perms.push([perm, seed]);
    return ret;
  }

  gen_ast_statement_perm(perm, seed, { statements }) {
    const perm_id = this.register_ast_perm(perm, seed);
    return ["{", `#pragma _permuter ast_perm ${perm_id}`, ...statements.map((s) => "{" + s + "}"), "}"].join("\n");
  }
}

class PermAssertionError extends Error {
  constructor(message = "") { super(message); this.name = "AssertionError"; }
}

export class Perm {
  constructor() {
    /** @type {bigint} */
    this.perm_count = 1n;
    /** @type {Perm[]} */
    this.children = [];
  }

  // eslint-disable-next-line no-unused-vars
  evaluate(seed, state) { return ""; }

  // eslint-disable-next-line no-unused-vars
  eval_statement_ast(args, seed) { throw new Error("NotImplementedError"); }

  preprocess(state) { for (const p of this.children) p.preprocess(state); }

  is_random() { return this.children.some((p) => p.is_random()); }
}

/** divmod for BigInts (both operands non-negative here). */
const divmod = (a, b) => [a / b, a % b];

function _eval_all(seed, perms, state) {
  const ret = [];
  for (const p of perms) {
    let sub_seed;
    [seed, sub_seed] = divmod(seed, p.perm_count);
    ret.push(p.evaluate(sub_seed, state));
  }
  if (seed !== 0n) throw new PermAssertionError("seed must be in [0, prod(counts))");
  return ret;
}

function _count_all(perms) {
  let res = 1n;
  for (const p of perms) res *= p.perm_count;
  return res;
}

function _eval_either(seed, perms, state) {
  for (const p of perms) {
    if (seed < p.perm_count) return p.evaluate(seed, state);
    seed -= p.perm_count;
  }
  throw new PermAssertionError("seed must be in [0, sum(counts))");
}

function _count_either(perms) {
  let s = 0n;
  for (const p of perms) s += p.perm_count;
  return s;
}

export function _shuffle(items, seed) {
  items = items.slice();
  const output = [];
  while (items.length) {
    const len = BigInt(items.length);
    const ind = Number(seed % len);
    seed /= len;
    output.push(items[ind]);
    items.splice(ind, 1);
  }
  return output;
}

function factorial(n) {
  let r = 1n;
  for (let i = 2n; i <= BigInt(n); i++) r *= i;
  return r;
}

export class RootPerm extends Perm {
  constructor(inner) {
    super();
    this.children = [inner];
    this.perm_count = inner.perm_count;
    this.preprocess_state = new PreprocessState();
    this.preprocess(this.preprocess_state);
    for (const [key, options] of this.preprocess_state.once_options) {
      if (options.length === 1) throw new Error(`PERM_ONCE(${key}) occurs only once, possible error?`);
      this.perm_count *= BigInt(options.length);
    }
  }

  evaluate(seed, state) {
    for (const [key, options] of this.preprocess_state.once_options) {
      let choice;
      [seed, choice] = divmod(seed, BigInt(options.length));
      state.once_choices.set(key, options[Number(choice)]);
    }
    return this.children[0].evaluate(seed, state);
  }
}

export class TextPerm extends Perm {
  constructor(text) {
    super();
    // Comma escape sequence
    this.text = text.replaceAll("(,)", ",");
    this.children = [];
    this.perm_count = 1n;
  }

  evaluate() { return this.text; }
}

export class IgnorePerm extends Perm {
  constructor(inner) {
    super();
    this.children = [inner];
    this.perm_count = inner.perm_count;
  }

  evaluate(seed, state) {
    const text = this.children[0].evaluate(seed, state);
    if (!text) return "";
    const encoded = Buffer.from(text, "utf8").toString("base64");
    return `\n#pragma _permuter b64literal ${encoded}\n`;
  }
}

export class PretendPerm extends Perm {
  constructor(inner) {
    super();
    this.children = [inner];
    this.perm_count = inner.perm_count;
  }

  evaluate(seed, state) {
    const text = this.children[0].evaluate(seed, state);
    return ["", "#pragma _permuter latedefine start", text, "#pragma _permuter latedefine end", ""].join("\n");
  }
}

export class CombinePerm extends Perm {
  constructor(parts) {
    super();
    this.children = parts;
    this.perm_count = _count_all(parts);
  }

  evaluate(seed, state) { return _eval_all(seed, this.children, state).join(""); }
}

export class RandomizerPerm extends Perm {
  constructor(inner) {
    super();
    this.children = [inner];
    this.perm_count = inner.perm_count;
  }

  evaluate(seed, state) {
    const text = this.children[0].evaluate(seed, state);
    return ["", "#pragma _permuter randomizer start", text, "#pragma _permuter randomizer end", ""].join("\n");
  }

  is_random() { return true; }
}

export class ForceSamelinePerm extends Perm {
  constructor(inner) {
    super();
    this.children = [inner];
    this.perm_count = inner.perm_count;
  }

  evaluate(seed, state) {
    const text = this.children[0].evaluate(seed, state);
    return ["", "#pragma _permuter sameline start", text, "#pragma _permuter sameline end", ""].join("\n");
  }
}

export class GeneralPerm extends Perm {
  constructor(candidates) {
    super();
    this.perm_count = _count_either(candidates);
    this.children = candidates;
  }

  evaluate(seed, state) { return _eval_either(seed, this.children, state); }
}

export class OncePerm extends Perm {
  constructor(key, inner) {
    super();
    this.key = key;
    this.children = [inner];
    this.perm_count = inner.perm_count;
  }

  preprocess(state) {
    if (!state.once_options.has(this.key)) state.once_options.set(this.key, []);
    state.once_options.get(this.key).push(this);
    super.preprocess(state);
  }

  evaluate(seed, state) {
    if (!state.once_choices.has(this.key)) throw new Error(`KeyError: ${this.key}`);
    if (state.once_choices.get(this.key) === this) return this.children[0].evaluate(seed, state);
    return "";
  }
}

export class VarPerm extends Perm {
  constructor(var_name, expansion) {
    super();
    this.children = expansion ? [var_name, expansion] : [var_name];
    this.perm_count = _count_all(this.children);
  }

  evaluate(seed, state) {
    const var_name_perm = this.children[0];
    let sub_seed;
    [seed, sub_seed] = divmod(seed, var_name_perm.perm_count);
    const var_name = var_name_perm.evaluate(sub_seed, state).trim();
    if (this.children.length > 1) {
      const ret = this.children[1].evaluate(seed, state);
      state.vars.set(var_name, ret);
      return "";
    }
    if (!state.vars.has(var_name)) throw new Error(`Tried to read undefined PERM_VAR ${var_name}`);
    return state.vars.get(var_name);
  }
}

export class LineSwapPerm extends Perm {
  constructor(lines) {
    super();
    this.children = lines;
    this.own_count = factorial(lines.length);
    this.perm_count = this.own_count * _count_all(this.children);
  }

  evaluate(seed, state) {
    const [sub_seed, variation] = divmod(seed, this.own_count);
    const texts = _eval_all(sub_seed, this.children, state);
    return _shuffle(texts, variation).join("\n");
  }
}

export class LineSwapAstPerm extends Perm {
  constructor(lines) {
    super();
    this.children = lines;
    this.own_count = factorial(lines.length);
    this.perm_count = this.own_count * _count_all(this.children);
  }

  evaluate(seed, state) {
    const [sub_seed, variation] = divmod(seed, this.own_count);
    const texts = _eval_all(sub_seed, this.children, state);
    return state.gen_ast_statement_perm(this, variation, { statements: texts });
  }

  eval_statement_ast(args, seed) {
    const ret = [];
    for (const item of _shuffle(args, seed)) {
      if (!(item instanceof ca.Compound)) throw new PermAssertionError();
      ret.push(...(item.block_items || []));
    }
    return ret;
  }
}

export class IntPerm extends Perm {
  constructor(low, high) {
    super();
    if (!(low <= high)) throw new PermAssertionError();
    this.low = low;
    this.children = [];
    this.perm_count = high - low + 1n;
  }

  evaluate(seed) { return String(this.low + seed); }
}
