// Ported from the workbench's layout-verdict tests: on structure and schedule
// mismatches the shift-tolerant edit script is computed and reported beside
// the positional count; other verdicts do not pay for an alignment.
import { test } from "node:test";
import assert from "node:assert/strict";
import { assemble } from "./fixtures/workbench/mips-asm.js";
import { parseDisassembly } from "../src/decomp/workbench/objdump.js";
import { compareInstructions, layoutSummary } from "../src/decomp/workbench/compare.js";
import { layoutLines } from "../src/decomp/workbench/comparison-render.js";
import { buildShiftDiff, movedBlocks } from "../src/decomp/workbench/shift-align.js";
import { dumps } from "../src/decomp/workbench/pyjson.js";

const PROLOGUE = ["addiu sp,sp,-32", "sw ra,28(sp)"];
const BLOCK = ["addu v0,a0,a1", "or t1,v0,a2", "xor t2,t1,a3", "sltu t3,t2,t1", "nor t4,t3,t2"];
const MIDDLE = ["lw s0,0(a0)", "lhu s1,4(a0)", "mult s0,s1", "sb s1,8(a0)"];
const EPILOGUE = ["lw ra,28(sp)", "jr ra", "addiu sp,sp,32"];
const TARGET = [...PROLOGUE, ...BLOCK, ...MIDDLE, ...EPILOGUE];
const PERMUTED = [...PROLOGUE, ...MIDDLE, ...BLOCK, ...EPILOGUE];
const PERMUTED_PLUS = [...PROLOGUE, ...MIDDLE, ...BLOCK, "andi s2,s1,15", ...EPILOGUE];
const REWRITTEN = [...PROLOGUE, ...BLOCK, "sh s1,2(a0)", "lb s0,1(a0)", "multu s0,s1", "srl s1,s0,3", ...EPILOGUE];
const rows = (l) => parseDisassembly(assemble(l, { symbol: "demo" }));
const cmp = (t, c) => compareInstructions(rows(t), rows(c), { target_name: "target.o", candidate_name: "candidate.o", symbol: null });
const lay = (c) => JSON.parse(dumps({ l: c.layout })).l;

test("a relocated block is found by its content, even folded into a replace block", () => {
  let t = rows(TARGET), c = rows(PERMUTED);
  let moved = movedBlocks(buildShiftDiff(t, c, { granularity: "normalized" }), t, c);
  assert.equal(moved.length, 1); assert.equal(moved[0].rows, MIDDLE.length); assert.notEqual(moved[0].displacement, 0);
  c = rows(PERMUTED_PLUS);
  moved = movedBlocks(buildShiftDiff(t, c, { granularity: "normalized" }), t, c);
  assert.deepEqual(moved.map((b) => b.rows), [MIDDLE.length]);
});

test("different code is not a moved block; a short run is below the noise floor", () => {
  let t = rows(TARGET), c = rows(REWRITTEN);
  assert.deepEqual(movedBlocks(buildShiftDiff(t, c, { granularity: "normalized" }), t, c), []);
  t = rows([...PROLOGUE, "nop", "nop", ...BLOCK, ...EPILOGUE]); c = rows([...PROLOGUE, ...BLOCK, "nop", "nop", ...EPILOGUE]);
  assert.deepEqual(movedBlocks(buildShiftDiff(t, c, { granularity: "normalized" }), t, c), []);
});

test("the summary reports the permutation and that the shift-tolerant distance beats the positional cost", () => {
  const s = JSON.parse(dumps(layoutSummary(rows(TARGET), rows(PERMUTED))));
  assert.equal(s.moved_block_count, 1); assert.equal(s.moved_rows, MIDDLE.length);
  assert.ok(s.rows_away < s.positional_mismatches);
});

test("structure and schedule mismatches carry the layout; the guidance leads with the permutation", () => {
  const c = cmp(TARGET, PERMUTED_PLUS);
  assert.equal(c.verdict, "structure-mismatch");
  assert.equal(lay(c).moved_block_count, 1); assert.ok(lay(c).rows_away < c.word_mismatches);
  const s = cmp(TARGET, PERMUTED);
  assert.equal(s.verdict, "schedule-mismatch"); assert.equal(lay(s).moved_block_count, 1);
  assert.ok(c.guidance[0].startsWith("Layout:")); assert.ok(c.guidance[0].includes("permutation"));
});

test("the terminal prints the script beside words; a non-permutation says so and gets no Layout lead", () => {
  const c = cmp(TARGET, PERMUTED_PLUS);
  const r = layoutLines(c).join("\n");
  assert.ok(r.includes("moved blocks: 1")); assert.ok(r.includes("rows_away=")); assert.ok(r.includes(`against words=${c.word_mismatches}`));
  const w = cmp(TARGET, REWRITTEN);
  assert.equal(lay(w).moved_block_count, 0);
  assert.ok(layoutLines(w).join("\n").includes("moved blocks: none"));
  assert.ok(!w.guidance[0].startsWith("Layout:"));
});

test("other verdicts do not pay for an alignment; the layout reaches JSON", () => {
  const c = cmp(TARGET, TARGET.map((l) => l.replace("v0", "v1")));
  assert.equal(c.verdict, "allocation-mismatch"); assert.equal(c.layout, null);
  const p = JSON.parse(dumps(cmp(TARGET, PERMUTED_PLUS).asDict()));
  assert.equal(p.layout.moved_block_count, 1); assert.equal(p.layout.schema, "decomp-workbench-layout-summary-v1");
});
