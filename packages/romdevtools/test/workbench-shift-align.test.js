// Shift-tolerant alignment: an inserted instruction costs one row, not a
// cascade; the cut list is derived; relocation rows are masked per side.
import { test } from "node:test";
import assert from "node:assert/strict";
import { assemble } from "./fixtures/workbench/mips-asm.js";
import { parseDisassembly } from "../src/decomp/workbench/objdump.js";
import { buildShiftDiff, comparableText, relocationRows, shiftDiffLines } from "../src/decomp/workbench/shift-align.js";

const PROLOGUE = ["addiu sp,sp,-32", "sw ra,28(sp)"], EPILOGUE = ["lw ra,28(sp)", "jr ra", "addiu sp,sp,32"];
const FORMS = ["addiu t0,t0,{n}", "or t1,t2,t3", "lw t4,{m}(sp)", "sll t5,t6,{s}", "and t7,t8,t9", "xor s0,s1,s2", "sw t3,{m}(sp)",
  "subu s3,s4,s5", "slt s6,s7,t0", "nor v0,v1,a0", "andi t9,t9,{n}", "addu s0,s1,s2", "sltu t2,t3,t4"];
const stream = (count) => Array.from({ length: count }, (_, i) => FORMS[i % FORMS.length].replaceAll("{n}", String(i % 100)).replaceAll("{m}", String((i % 20) * 4)).replaceAll("{s}", String(i % 31)));
const body = (...ins) => [...PROLOGUE, ...ins, ...EPILOGUE];
const rows = (lines, relocations = null) => parseDisassembly(assemble(lines, { symbol: "demo", relocations }), { symbol: "demo" });

test("one inserted instruction reads as one instruction away", () => {
  const lines = body(...stream(40)), shifted = [...lines];
  shifted.splice(20, 0, "nop");
  const d = buildShiftDiff(rows(lines), rows(shifted));
  assert.deepEqual([d.replaced, d.inserted, d.deleted], [0, 1, 0]);
  assert.equal(d.rows_away, 1);
  assert.equal(d.insertion_only, true);
  assert.ok(d.positional_mismatches > 20);
});

test("the cut list comes from the alignment", () => {
  const lines = body(...stream(20)), shifted = [...lines];
  shifted.splice(9, 0, "nop");
  const d = buildShiftDiff(rows(lines), rows(shifted));
  assert.deepEqual(d.cuts, [9]);
  assert.equal(d.pairing.candidateRow(8), 8);
  assert.equal(d.pairing.candidateRow(9), 10);
});

test("a deleted instruction is not the compensable shape", () => {
  const lines = body(...stream(20));
  const d = buildShiftDiff(rows(lines), rows(lines.filter((_, i) => i !== 9)));
  assert.equal(d.deleted, 1);
  assert.equal(d.insertion_only, false);
});

test("a branch over an insertion is not a mismatch", () => {
  const lines = body("beq t0,t1,@9", ...stream(10)), shifted = [...lines];
  shifted.splice(5, 0, "nop");
  shifted[2] = "beq t0,t1,@10";
  const d = buildShiftDiff(rows(lines), rows(shifted));
  assert.equal(d.paired_mismatches, 0);
  assert.equal(d.rows_away, 1);
});

test("relocation masking keeps the two row spaces apart", () => {
  const lines = body(...stream(20));
  const reloc = 8;
  const target = rows(lines, { [reloc]: "R_MIPS_LO16" });
  const shifted = [...lines];
  shifted.splice(4, 0, "nop");
  const broken = reloc + 1;
  shifted[broken + 1] = "addiu t1,t1,999";
  const candidate = rows(shifted, { [reloc + 1]: "R_MIPS_LO16" });
  assert.ok(new Set([...relocationRows(target), ...relocationRows(candidate)]).has(broken));
  const d = buildShiftDiff(target, candidate);
  assert.ok(d.paired_mismatch_rows.includes(broken));
  assert.equal(d.relocation_masked, 1);
});

test("comparable text leaves a hexadecimal immediate alone", () => {
  const [ins] = parseDisassembly(assemble(["ori v0,v0,0x1234"], { symbol: "demo" }), { symbol: "demo" });
  assert.equal(comparableText(ins), ins.assembly);
});

test("the report states the positional reading it replaces", () => {
  const lines = body(...stream(30)), shifted = [...lines];
  shifted.splice(15, 0, "nop");
  const text = shiftDiffLines(buildShiftDiff(rows(lines), rows(shifted))).join("\n");
  for (const s of ["1 instruction(s) away", "position-indexed comparison charges", "insertion-only"]) assert.ok(text.includes(s), s);
});

test("a long deleted block marks its hidden rows; a short one does not", () => {
  const lines = body(...stream(30));
  const long = shiftDiffLines(buildShiftDiff(rows(lines), rows([...lines.slice(0, 12), ...lines.slice(24)]), { context: 3 }), { blocks: 50 }).join("\n");
  assert.ok(long.includes("more row(s) in this block") && long.includes("--context-rows"));
  const short = shiftDiffLines(buildShiftDiff(rows(lines), rows([...lines.slice(0, 12), ...lines.slice(14)]), { context: 3 }), { blocks: 50 }).join("\n");
  assert.ok(!short.includes("more row(s) in this block"));
});
