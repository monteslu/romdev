// eval.js - seed enumeration, a port of decomp-permuter's src/perm/eval.py.
import { EvalState } from "./perm.js";
import { globalRandom } from "../pyrandom.js";

/** All numbers 0..total_count-1 in random order, in expected O(1) time each. */
export function* _gen_all_seeds(total_count, random = globalRandom) {
  const seen = new Set();
  const half = total_count / 2n;
  while (BigInt(seen.size) < half) {
    const seed = random.randrange(total_count);
    const key = BigInt(seed);
    if (!seen.has(key)) {
      seen.add(key);
      yield key;
    }
  }
  const remaining = [];
  for (let seed = 0n; seed < total_count; seed++) if (!seen.has(seed)) remaining.push(seed);
  random.shuffle(remaining);
  yield* remaining;
}

export function* perm_gen_all_seeds(perm, random = globalRandom) {
  for (;;) {
    yield* _gen_all_seeds(perm.perm_count, random);
    if (!perm.is_random()) break;
  }
}

export function perm_evaluate_one(perm) {
  const eval_state = new EvalState();
  return [perm.evaluate(0n, eval_state), eval_state];
}
