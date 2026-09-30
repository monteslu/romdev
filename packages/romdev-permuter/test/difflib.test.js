// The scorer's penalties come from difflib opcodes and the output diff.txt
// from unified_diff: these are CPython's documented examples.
import { test } from "node:test";
import assert from "node:assert/strict";
import { SequenceMatcher, unified_diff } from "../src/difflib.js";

test("get_opcodes: difflib docs example", () => {
  const s = new SequenceMatcher({ autojunk: true });
  s.set_seqs([..."qabxcd"], [..."abycdf"]);
  assert.deepEqual(s.get_opcodes(), [
    ["delete", 0, 1, 0, 0], ["equal", 1, 3, 0, 2], ["replace", 3, 4, 2, 3], ["equal", 4, 6, 3, 5], ["insert", 6, 6, 5, 6],
  ]);
});

test("get_matching_blocks: difflib docs example", () => {
  const s = new SequenceMatcher();
  s.set_seqs([..."abxcd"], [..."abcd"]);
  assert.deepEqual(s.get_matching_blocks(), [[0, 0, 2], [3, 2, 2], [5, 4, 0]]);
});

test("find_longest_match: docs example (no junk)", () => {
  const s = new SequenceMatcher();
  s.set_seqs([..." abcd"], [..."abcd abcd"]);
  assert.deepEqual(s.find_longest_match(0, 5, 0, 9), [0, 4, 5]);
});

test("autojunk drops popular elements only for b with >= 200 items", () => {
  const b = Array.from({ length: 200 }, (_, i) => (i % 2 ? "x" : `u${i}`));
  const s = new SequenceMatcher({ autojunk: true });
  s.set_seqs(["x"], b);
  assert.ok(s.bpopular.has("x"));
  const t = new SequenceMatcher({ autojunk: false });
  t.set_seqs(["x"], b);
  assert.equal(t.bpopular.size, 0);
  assert.deepEqual(t.get_matching_blocks()[0], [0, 1, 1]);
});

test("unified_diff: difflib docs example", () => {
  const out = unified_diff("one two three four".split(" "), "zero one tree four".split(" "),
    { fromfile: "Original", tofile: "Current", lineterm: "" });
  assert.deepEqual(out, ["--- Original", "+++ Current", "@@ -1,4 +1,4 @@", "+zero", " one", "-two", "-three", "+tree", " four"]);
});

test("unified_diff with a key compares stripped lines but prints the originals", () => {
  const strip = (s) => s.trim();
  const out = unified_diff(["a", "  b", "c"], ["a", "b  ", "d"], { fromfile: "before", tofile: "after", lineterm: "", key: strip });
  assert.deepEqual(out, ["--- before", "+++ after", "@@ -1,3 +1,3 @@", " a", "   b", "-c", "+d"]);
});
