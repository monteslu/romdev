// Literal-pool resolution: a target naming one symbol per literal against a
// candidate with one dense section pool must not read as difference, and the
// cases that ARE differences must survive. Synthetic assembly only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { assemble } from "./fixtures/workbench/mips-asm.js";
import { compareInstructions } from "../src/decomp/workbench/compare.js";
import { ABSOLUTE, CORRESPONDENCE, poolAccesses } from "../src/decomp/workbench/literal-pool.js";
import { parseDisassembly } from "../src/decomp/workbench/objdump.js";
import { buildView } from "../src/decomp/workbench/view.js";

function body(offsets) {
  const lines = [];
  ["v0", "v1", "a0"].forEach((reg, i) => { lines.push("lui at,0x0"); lines.push(`lw ${reg},${offsets[i]}(at)`); });
  return [...lines, "jr ra", "nop"];
}
function named(symbols) {
  const r = {};
  symbols.forEach((s, slot) => { r[slot * 2] = `R_MIPS_HI16 ${s}`; r[slot * 2 + 1] = `R_MIPS_LO16 ${s}`; });
  return r;
}
const dense = (count, symbol = ".rodata") => named(Array(count).fill(symbol));
const parse = (lines, relocations) => parseDisassembly(assemble(lines, { symbol: "demo", relocations }), { symbol: "demo" });
const viewOf = (t, c, { relocations, candidate_relocations }) => buildView(parse(t, relocations), parse(c, candidate_relocations),
  { target_name: "target.o", candidate_name: "candidate.o", symbol: "demo" });
const SPARSE = ["D_80052AA8", "D_80052AB4", "D_80052AC8"];
const sparseVersusDense = (offsets) => viewOf(body([0, 0, 0]), body(offsets), { relocations: named(SPARSE), candidate_relocations: dense(3) });
const n = (view, k) => view.counts[k] ?? 0;

test("every row resolves to the same slot; rows stop being reported", () => {
  const v = sparseVersusDense([0, 4, 8]);
  assert.equal(v.pool.resolution, CORRESPONDENCE);
  assert.deepEqual([n(v, "pool"), n(v, "pool_layout"), n(v, "relocation"), n(v, "constant")], [6, 0, 0, 0]);
  assert.deepEqual(v.rows.filter((r) => r.reported), []);
  assert.equal(v.verdict, "words-identical");
  assert.equal(v.hunks.length, 0);
  assert.deepEqual([v.pool.target_slots, v.pool.candidate_slots, v.pool.slots_differ], [3, 3, false]);
});

test("a reordered pool is still one to one", () => {
  const v = sparseVersusDense([8, 0, 4]);
  assert.deepEqual([n(v, "pool"), n(v, "pool_layout")], [6, 0]);
});

test("folding two slots into one breaks the correspondence", () => {
  const v = sparseVersusDense([0, 0, 8]);
  assert.equal(n(v, "pool_layout"), 2);
  assert.equal(v.verdict, "pool-layout");
  assert.ok(v.guidance[0].includes("literal-pool access"));
});

test("an inconsistent displacement is reported", () => {
  const v = viewOf(body([0, 4, 8]), body([0, 8, 16]), { relocations: named(["pool", "pool", "pool"]), candidate_relocations: dense(3) });
  assert.ok(n(v, "pool_layout") > 0);
});

test("dense against dense resolves absolutely", () => {
  const same = viewOf(body([0, 4, 8]), body([0, 4, 8]), { relocations: dense(3), candidate_relocations: dense(3, ".rdata") });
  assert.equal(same.pool.resolution, ABSOLUTE);
  assert.deepEqual([n(same, "pool"), n(same, "pool_layout")], [6, 0]);
  const moved = viewOf(body([0, 4, 8]), body([0, 4, 12]), { relocations: dense(3), candidate_relocations: dense(3) });
  assert.equal(moved.pool.resolution, ABSOLUTE);
  assert.equal(n(moved, "pool_layout"), 1);
  assert.equal(moved.verdict, "pool-layout");
});

test("one symbol with two addends is a real difference", () => {
  const v = viewOf(body([0, 0, 0]), body([0, 20, 0]), { relocations: named(Array(3).fill("jump_table")), candidate_relocations: named(Array(3).fill("jump_table")) });
  assert.deepEqual([n(v, "pool_layout"), n(v, "match"), n(v, "pool")], [1, 7, 0]);
});

test("an unpaired anchor naming one symbol stays relocation", () => {
  const t = parseDisassembly("00000000 <demo>:\n   0: 3c010123  lui $at,0x123\n                        0: R_MIPS_HI16 global\n   4: 03e00008  jr $ra\n   8: 00000000  nop\n", { symbol: "demo" });
  const c = parseDisassembly("00000000 <demo>:\n   0: 3c010000  lui $at,0x0\n                        0: R_MIPS_HI16 global\n   4: 03e00008  jr $ra\n   8: 00000000  nop\n", { symbol: "demo" });
  const v = buildView(t, c, { target_name: "t", candidate_name: "c", symbol: "demo" });
  assert.deepEqual([n(v, "relocation"), n(v, "pool"), n(v, "pool_layout")], [1, 0, 0]);
});

test("a row that also moved a register is not a pool row; unrelocated immediates stay constants", () => {
  const cand = body([0, 4, 8]);
  cand[3] = "lw t8,4(at)";
  const v = viewOf(body([0, 0, 0]), cand, { relocations: named(SPARSE), candidate_relocations: dense(3) });
  assert.deepEqual([n(v, "register"), n(v, "pool")], [1, 5]);
  const k = viewOf(["li v0,33", "jr ra", "nop"], ["li v0,49", "jr ra", "nop"], { relocations: {}, candidate_relocations: {} });
  assert.deepEqual([n(k, "constant"), n(k, "pool")], [1, 0]);
  assert.equal(k.pool, null);
});

test("an anchor carries no slot and a load does; negative addends are signed", () => {
  const a = poolAccesses(parse(body([0, 4, 8]), dense(3)));
  assert.deepEqual([...a.values()].slice(0, 2).map((x) => x.role), ["anchor", "access"]);
  assert.deepEqual([1, 3, 5].map((i) => a.get(i).offset), [0, 4, 8]);
  assert.deepEqual([1, 3, 5].map((i) => a.get(i).width), [4, 4, 4]);
  assert.equal(a.get(0).section, "rodata");
  assert.equal(poolAccesses(parse(body([0, -4, 8]), dense(3))).get(3).offset, -4);
});

const comparison = () => compareInstructions(parse(body([0, 0, 0]), named(SPARSE)), parse(body([0, 4, 8]), dense(3)),
  { target_name: "target.o", candidate_name: "candidate.o", symbol: "demo" });

test("the comparison loses the phantom rows and reports the reading", () => {
  const item = comparison();
  assert.deepEqual(item.aligned_diff_sites, []);
  assert.equal(item.aligned_total, 0);
  const p = item.asDict();
  assert.deepEqual([p.pool_resolution, p.pool_matches, p.pool_layout_mismatches, p.target_pool_slots, p.candidate_pool_slots], [CORRESPONDENCE, 6, 0, 3, 3]);
  assert.equal(item.word_mismatches, 0);
  assert.equal(item.raw_word_mismatches - item.word_mismatches, item.raw_difference_breakdown.relocation_controlled);
});

test("a pair with no relocated data reports no pool reading", () => {
  const p = compareInstructions(parseDisassembly(assemble(["li v0,33", "jr ra", "nop"]), { symbol: "demo" }),
    parseDisassembly(assemble(["li v0,49", "jr ra", "nop"]), { symbol: "demo" }), { target_name: "target.o", candidate_name: "candidate.o", symbol: "demo" });
  assert.equal(p.asDict().pool_resolution, null);
  assert.equal(p.asDict().pool_matches, 0);
  assert.equal(p.raw_word_mismatches, p.word_mismatches);
});
