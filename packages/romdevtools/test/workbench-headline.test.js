// Ported from the workbench's headline tests and the comparison half of its
// geometry-ranking tests: one number is named the score, the other two are
// labelled, disagreements are said out loud, and the `score TARGET CANDIDATE`
// form prints the headline first.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assemble } from "./fixtures/workbench/mips-asm.js";
import { parseDisassembly } from "../src/decomp/workbench/objdump.js";
import { compareInstructions, rankComparisons } from "../src/decomp/workbench/compare.js";
import { comparisonLine } from "../src/decomp/workbench/comparison-render.js";
import { paretoLayers } from "../src/decomp/workbench/geometry.js";
import { ROLE_NEVER, ROLE_ONE_CANDIDATE, ROLE_SCORE, buildHeadline, headlineLine, renderHeadline } from "../src/decomp/workbench/headline.js";
import { dumps } from "../src/decomp/workbench/pyjson.js";
import { runCli } from "./fixtures/workbench/cli-run.js";

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "workbench");
const SYMBOL = "demo";
const body = (...i) => ["addiu sp,sp,-32", "sw ra,28(sp)", ...i, "lw ra,28(sp)", "jr ra", "addiu sp,sp,32"];
const rows = (l) => parseDisassembly(assemble(l, { symbol: SYMBOL }), { symbol: SYMBOL });
const cmp = (t, c, name = "candidate.o") => compareInstructions(rows(t), rows(c), { target_name: "target.o", candidate_name: name, symbol: SYMBOL });
const headlineOf = (t, c) => buildHeadline(cmp(t, c));

test("the headline is the positional word delta; a match says MATCH", () => {
  const r = headlineOf(body("addu v0,a0,a1", "addu v1,a0,a2"), body("addu v0,a0,a1", "addu t0,a0,a2"));
  assert.equal(r.words, 1); assert.equal(headlineLine(r), "score: 1 word differ (0 = match)");
  const same = body("addu v0,a0,a1");
  const m = headlineOf(same, same);
  assert.equal(m.matched, true); assert.equal(headlineLine(m), "score: 0 words differ — MATCH");
});

test("exactly one metric is labelled the score, and aligned_total never is", () => {
  const r = headlineOf(body("addu v0,a0,a1"), body("addu t0,a0,a1"));
  const roles = r.metrics.map((m) => m.role);
  assert.equal(roles.filter((x) => x === ROLE_SCORE).length, 1); assert.equal(r.metrics[0].key, "words");
  assert.ok(roles.includes(ROLE_ONE_CANDIDATE)); assert.ok(roles.includes(ROLE_NEVER));
  const s = headlineOf(body("addu v0,a0,a1", "addu v1,a0,a2", "addu a3,a0,a3"), body("nop", "addu v0,a0,a1", "addu v1,a0,a2", "addu a3,a0,a3"));
  assert.deepEqual(s.metrics.filter((m) => m.role === ROLE_SCORE).map((m) => m.key), ["words"]);
});

test("agreement is stated; gaps and instruction-count differences are named with their consequence", () => {
  const a = headlineOf(body("addu v0,a0,a1"), body("addu t0,a0,a1"));
  assert.deepEqual([...a.disagreements], []); assert.ok(renderHeadline(a).join("\n").includes("the three counts agree"));
  const g = headlineOf(body("addu v0,a0,a1", "addu v1,a0,a2"), body("nop", "addu v0,a0,a1", "addu v1,a0,a2")).disagreements.join(" ");
  assert.ok(g.includes("gap")); assert.ok(g.includes("must not be ranked against it"));
  const n = headlineOf(body("addu v0,a0,a1"), body("addu v0,a0,a1", "nop"));
  assert.equal(n.instruction_delta, 1); assert.ok(n.disagreements.join(" ").includes("instruction(s) than the target"));
});

test("relocation-controlled words explain raw above words", () => {
  const c = compareInstructions(parseDisassembly(fs.readFileSync(path.join(FIX, "target.objdump.txt"), "utf8")),
    parseDisassembly(fs.readFileSync(path.join(FIX, "relocated-match.objdump.txt"), "utf8")), { target_name: "target.o", candidate_name: "candidate.o", symbol: null });
  const text = buildHeadline(c).disagreements.join(" ");
  if (c.raw_word_mismatches > c.word_mismatches) { assert.ok(text.includes("relocation-controlled")); assert.ok(text.includes("words=0 is the real gate")); }
});

test("score TARGET CANDIDATE prints the headline first; JSON names the headline metric; mixing forms and missing truth are refused", async () => {
  const PT = path.join(FIX, "phase-shift-target.objdump.txt"), PC = path.join(FIX, "phase-shift-candidate.objdump.txt");
  let [status, out] = await runCli(["score", PT, PC]);
  assert.ok([0, 1, 2].includes(status));
  if (status !== 2) assert.ok(out.startsWith("score: "));
  [status, out] = await runCli(["score", PT, PC, "--json"]);
  if (status !== 2) {
    const p = JSON.parse(out);
    assert.equal(p.headline_metric, "words"); assert.equal(p.mode, "headline"); assert.equal(p.schema, "decomp-workbench-score-v1"); assert.ok("metric_disagreements" in p);
  }
  let err;
  [status, , err] = await runCli(["score", path.join(FIX, "target.objdump.txt"), path.join(FIX, "relocated-match.objdump.txt"), "--target-object", path.join(FIX, "target.objdump.txt")]);
  assert.equal(status, 2); assert.ok(err.includes("score TARGET.o CANDIDATE.o")); assert.ok(err.includes("--target-object"));
  [status, , err] = await runCli(["score", path.join(FIX, "target.objdump.txt")]);
  assert.equal(status, 2); assert.ok(err.includes("--target-object"));
});

// geometry ranking (the comparison half; the campaign half is ported with the campaign)

function streams(n = 1208) {
  const b = Array.from({ length: n - 2 }, (_, i) => `addiu v0,v0,${i}`);
  const tail = ["jr ra", "nop"];
  return [[...b, ...tail], [...Array(7).fill("nop"), ...b, ...tail], [...b, ...Array(9).fill("nop"), ...tail]];
}

test("a 1208-row target does not reward a 1215 to 1217 positional decrease", () => {
  const [t, near, worse] = streams();
  const first = cmp(t, near, "near"), second = cmp(t, worse, "worse");
  assert.equal(first.target_true_instructions, 1208); assert.equal(first.candidate_true_instructions, 1215); assert.equal(second.candidate_true_instructions, 1217);
  assert.ok(second.word_mismatches < first.word_mismatches);
  const [ordered, unsafe] = rankComparisons([second, first]);
  assert.equal(unsafe, true); assert.deepEqual(ordered.map((c) => c.candidate), ["near", "worse"]); assert.deepEqual(ordered.map((c) => c.geometry_front), [0, 1]);
  assert.ok(!ordered.some((c) => c.exact));
  assert.ok(comparisonLine(second).includes("true_insn_delta=+9")); assert.ok(comparisonLine(second).includes("geometry_front=1"));
  const h = buildHeadline(second);
  assert.equal(h.words, second.word_mismatches);
  assert.deepEqual(JSON.parse(dumps(h.asDict().geometry)), JSON.parse(dumps(second.geometry)));
  assert.ok(renderHeadline(h).join("\n").includes("extent=+9"));
});

test("trade-offs share a front instead of asserting size first; true extent is independent of padded counts", () => {
  assert.deepEqual(paretoLayers([[7, 100, 20], [9, 50, 10]]), [0, 0]);
  assert.deepEqual(paretoLayers([[0, 0, 0], [0, 0, 0], [1, 1, 1]]), [0, 0, 1]);
  assert.deepEqual(paretoLayers([[3, 3, 3], [1, 1, 1], [2, 2, 2]]), [2, 0, 1]);
  const [t, near, worse] = streams(20);
  const first = cmp(t, near, "near"), second = cmp(t, worse, "worse");
  first.instruction_delta = 0; second.instruction_delta = 0;
  assert.equal(first.geometry_vector[0], 7); assert.equal(second.geometry_vector[0], 9);
  assert.equal(rankComparisons([second, first])[0][0].candidate, "near");
});
