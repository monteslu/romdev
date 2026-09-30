// Ported from the workbench's alignment-integrity tests: aligned counts are
// never read across candidates without a caution, and every scoring surface
// carries words, raw, opcodes and gaps.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assemble } from "./fixtures/workbench/mips-asm.js";
import { parseDisassembly } from "../src/decomp/workbench/objdump.js";
import { MIXED_ALIGNMENT_CAUTION, compareInstructions, rankComparisons } from "../src/decomp/workbench/compare.js";
// Comparison is a mutable record, as in the original; copy without freezing.
const replace = (c, changes) => Object.assign(Object.create(Object.getPrototypeOf(c)), c, changes);
import { fakeObjdump } from "./fixtures/workbench/fake-objdump.js";
import { runCli } from "./fixtures/workbench/cli-run.js";

const TARGET = ["addiu sp,sp,-32", "sw ra,28(sp)", "sw s0,24(sp)", "lw t0,0(a0)", "lw t1,4(a0)", "addu t2,t0,t1", "sw t2,8(a0)", "lw t3,12(a0)", "lw t4,16(a0)",
  "addu t5,t3,t4", "sw t5,20(a0)", "lw t6,24(a0)", "lw t7,28(a0)", "addu t8,t6,t7", "sw t8,32(a0)", "lw s0,24(sp)", "lw ra,28(sp)", "jr ra", "addiu sp,sp,32"];
const RENAMED = TARGET.map((l, i) => (i >= 3 && i < 11 ? l.replace("t0", "v0").replace("t1", "v1").replace("t2", "a1").replace("t3", "a2").replace("t4", "a3").replace("t5", "s2") : l));
const PERTURBED = [...TARGET.slice(0, 3), ...TARGET.slice(4, 15), TARGET[3], ...TARGET.slice(15)];
const cmp = (c, name) => compareInstructions(parseDisassembly(assemble(TARGET, { symbol: "demo" }), { symbol: "demo" }), parseDisassembly(assemble(c, { symbol: "demo" }), { symbol: "demo" }),
  { target_name: "target.o", candidate_name: name, symbol: "demo" });
const renamed = () => cmp(RENAMED, "renamed.o"), perturbed = () => cmp(PERTURBED, "perturbed.o");

test("a renaming has no gaps and no caution", () => {
  const i = renamed();
  assert.deepEqual([i.aligned_insertions, i.aligned_deletions, i.aligned_gaps, i.opcode_mismatches], [0, 0, 0, 0]);
  assert.equal(i.aligned_total, i.word_mismatches); assert.equal(i.alignment_comparable, true); assert.equal(i.alignment_caution, null);
});

test("a perturbed schedule reports gaps and cautions; the aligned total inverts the honest order", () => {
  const i = perturbed();
  assert.deepEqual([i.aligned_insertions, i.aligned_deletions, i.aligned_gaps], [1, 1, 2]); assert.equal(i.alignment_comparable, false);
  assert.equal(i.alignment_caution, "caution: alignment inserted 2 gaps (9 opcode mismatches) -- compare candidates on positional words (words=), not aligned rows");
  const b = renamed();
  assert.ok(i.aligned_total < b.aligned_total); assert.ok(i.word_mismatches > b.word_mismatches); assert.ok(i.opcode_mismatches > b.opcode_mismatches);
});

test("ranking: a mixed set orders on words; a uniform set keeps the aligned ordering; two gapped candidates rank on words", () => {
  let [ordered, mixed] = rankComparisons([perturbed(), renamed()]);
  assert.equal(mixed, true); assert.deepEqual(ordered.map((c) => c.candidate), ["renamed.o", "perturbed.o"]);
  const near = cmp(RENAMED, "near.o"), base = cmp(RENAMED, "far.o");
  const far = replace(base, { aligned_total: base.aligned_total + 1, word_mismatches: base.word_mismatches - 1 });
  [ordered, mixed] = rankComparisons([far, near]);
  assert.equal(mixed, false); assert.deepEqual(ordered.map((c) => c.candidate), ["near.o", "far.o"]);
  const a = replace(perturbed(), { candidate: "aligned-looks-near.o", aligned_total: 1, word_mismatches: 20 });
  const b = replace(perturbed(), { candidate: "positional-near.o", aligned_total: 5, word_mismatches: 10 });
  [ordered, mixed] = rankComparisons([a, b]);
  assert.equal(mixed, true); assert.deepEqual(ordered.map((c) => c.candidate), ["positional-near.o", "aligned-looks-near.o"]);
});

function dumps() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "romdev-wb-align-int-"));
  const out = { dir: d };
  for (const [name, lines] of [["target", TARGET], ["renamed", RENAMED], ["perturbed", PERTURBED]]) {
    out[name] = path.join(d, `${name}.objdump`);
    fs.writeFileSync(out[name], assemble(lines, { symbol: "demo" }));
  }
  return out;
}

test("the summary line always carries raw, opcodes and gaps; compare prints the caution first and stays quiet on a renaming", async () => {
  const p = dumps();
  for (const c of ["renamed", "perturbed"]) {
    const [, out] = await runCli(["compare-dumps", p.target, p[c], "--symbol", "demo"]);
    const summary = out.split("\n").find((l) => l.includes("verdict="));
    for (const k of ["words=", "raw=", "opcodes=", "gaps="]) assert.ok(summary.includes(k), `${c} ${k}`);
  }
  let [, out] = await runCli(["compare-dumps", p.target, p.perturbed, "--symbol", "demo"]);
  assert.ok(out.includes("caution: alignment inserted 2 gaps")); assert.ok(out.indexOf("caution:") < out.indexOf("verdict="));
  assert.ok(out.includes("alignment gaps: insertions=1 deletions=1"));
  [, out] = await runCli(["compare-dumps", p.target, p.renamed, "--symbol", "demo"]);
  assert.ok(!out.includes("caution:"));
});

test("the JSON carries the new fields beside the old ones; diagnose prints the caution too", async () => {
  const p = dumps();
  let [, out] = await runCli(["compare-dumps", p.target, p.perturbed, "--symbol", "demo", "--json"]);
  const j = JSON.parse(out);
  for (const k of ["aligned_diff_sites", "aligned_total", "diff_site_classes"]) assert.ok(k in j, k);
  assert.equal(j.aligned_insertions, 1); assert.equal(j.aligned_deletions, 1); assert.equal(j.gaps, 2); assert.equal(j.aligned_gaps, 2);
  assert.equal(j.opcodes, j.opcode_mismatches); assert.equal(j.alignment_comparable, false);
  assert.ok(j.alignment_caution.includes("compare candidates on positional words (words=)"));
  [, out] = await runCli(["diagnose-dumps", p.target, p.perturbed, "--symbol", "demo", "--width", "200"]);
  assert.ok(out.includes("caution: alignment inserted 2 gaps")); assert.ok(out.indexOf("caution:") < out.indexOf("verdict="));
});

test("rank says it reordered a mixed set, and JSON names the metric it ordered on", async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "romdev-wb-align-rank-"));
  for (const f of ["target.o", "perturbed.o", "renamed.o"]) fs.writeFileSync(path.join(d, f), "x");
  const objdump = fakeObjdump(d, { "target.o": assemble(TARGET, { symbol: "demo" }), "perturbed.o": assemble(PERTURBED, { symbol: "demo" }), "renamed.o": assemble(RENAMED, { symbol: "demo" }) });
  let [status, out] = await runCli(["rank", "target.o", "perturbed.o", "renamed.o", "--symbol", "demo", "--objdump", objdump], { cwd: d });
  assert.equal(status, 0); assert.equal(out.indexOf(MIXED_ALIGNMENT_CAUTION), 0); assert.ok(out.indexOf("renamed.o") < out.indexOf("perturbed.o"));
  [, out] = await runCli(["rank", "target.o", "perturbed.o", "renamed.o", "--symbol", "demo", "--objdump", objdump, "--json"], { cwd: d });
  const j = JSON.parse(out);
  assert.equal(j.mixed_alignment, true); assert.equal(j.ranked_by, "geometry-pareto"); assert.equal(j.alignment_ranking_unsafe, true);
  assert.equal(j.results[0].candidate, "renamed.o");
});
