// --algorithm levenshtein: Levenshtein.opcodes as the `Levenshtein` package
// (rapidfuzz) documents it, and the scorer on top of it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { editops, opcodes } from "../src/levenshtein.js";
import { PyRandom } from "../src/pyrandom.js";

const chars = (s) => [...s];

test("Levenshtein.opcodes docstring: opcodes('spam', 'park')", () => {
  assert.deepEqual(opcodes(chars("spam"), chars("park")), [
    ["delete", 0, 1, 0, 0], ["equal", 1, 3, 0, 2], ["insert", 3, 3, 2, 3], ["replace", 3, 4, 3, 4],
  ]);
});

test("rapidfuzz Levenshtein.opcodes docstring: ('qabxcd', 'abycdf')", () => {
  assert.deepEqual(opcodes(chars("qabxcd"), chars("abycdf")), [
    ["delete", 0, 1, 0, 0], ["equal", 1, 3, 0, 2], ["replace", 3, 4, 2, 3], ["equal", 4, 6, 3, 5], ["insert", 6, 6, 5, 6],
  ]);
});

/** Plain DP edit distance, the quantity the editops must realise. */
function dp(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

test("editops are a minimal edit script and opcodes tile both sequences", () => {
  const r = new PyRandom(7);
  for (let n = 0; n < 400; n++) {
    const a = Array.from({ length: r.randrange(0, 90) }, () => r.randrange(0, 5));
    const b = Array.from({ length: r.randrange(0, 90) }, () => r.randrange(0, 5));
    const ops = editops(a, b);
    assert.equal(ops.length, dp(a, b));
    // Apply the script: the result must be b.
    const out = [];
    let i = 0;
    for (const [tag, sp, dp_] of ops) {
      while (i < sp) out.push(a[i++]);
      assert.equal(out.length, dp_);
      if (tag === "insert") out.push(b[dp_]);
      else if (tag === "replace") { out.push(b[dp_]); i++; } else i++;
    }
    while (i < a.length) out.push(a[i++]);
    assert.deepEqual(out, b);
    let si = 0, di = 0;
    for (const [tag, i1, i2, j1, j2] of opcodes(a, b)) {
      assert.equal(i1, si); assert.equal(j1, di);
      if (tag === "equal") assert.deepEqual(a.slice(i1, i2), b.slice(j1, j2));
      si = i2; di = j2;
    }
    assert.deepEqual([si, di], [a.length, b.length]);
  }
});
