// Commutative operand findings: a swapped pair on the arithmetic row, and a
// clean arithmetic row whose two operand loads are crossed. Synthetic assembly.
import { test } from "node:test";
import assert from "node:assert/strict";
import { assemble } from "./fixtures/workbench/mips-asm.js";
import { compareInstructions } from "../src/decomp/workbench/compare.js";
import { parseDisassembly } from "../src/decomp/workbench/objdump.js";
import { dumps } from "../src/decomp/workbench/pyjson.js";

const PROLOGUE = ["addiu sp,sp,-32", "sw ra,28(sp)"], EPILOGUE = ["lw ra,28(sp)", "jr ra", "addiu sp,sp,32"];
const body = (...ins) => [...PROLOGUE, ...ins, ...EPILOGUE];
const rows = (lines) => parseDisassembly(assemble(lines, { symbol: "demo" }), { symbol: "demo" });
const comparison = (t, c) => compareInstructions(rows(t), rows(c), { target_name: "target", candidate_name: "candidate", symbol: "demo" });

test("a swapped pair names the operands and the edit", () => {
  const [f] = comparison(body("or t2,t0,t1"), body("or t2,t1,t0")).commutative_findings;
  assert.equal(f.kind, "operand-order");
  assert.deepEqual(f.sources, ["t0", "t1"]);
  assert.ok(f.lever.includes("expression shape") && f.lever.includes("not register"));
});

test("a clean arithmetic row with crossed loads is found", () => {
  const item = comparison(body("lw t0,8(sp)", "lw t1,12(sp)", "or t2,t0,t1"), body("lw t1,8(sp)", "lw t0,12(sp)", "or t2,t0,t1"));
  assert.equal(item.commutative_findings.length, 1);
  const [f] = item.commutative_findings;
  assert.equal(f.kind, "operand-load");
  assert.equal(f.target, f.candidate);
  assert.deepEqual(f.definitions.map((d) => d.register), ["t0", "t1"]);
  assert.ok(f.lever.includes("operand loads") && f.lever.includes("wrong repair"));
});

test("unrelated register differences, matching pairs and non-commutative opcodes produce nothing", () => {
  const t = body("lw t0,8(sp)", "lw t1,12(sp)", "or t2,t0,t1");
  assert.deepEqual(comparison(t, body("lw t0,8(sp)", "lw t1,16(sp)", "or t2,t0,t1")).commutative_findings, []);
  assert.deepEqual(comparison(t, t).commutative_findings, []);
  assert.deepEqual(comparison(body("lw t0,8(sp)", "lw t1,12(sp)", "subu t2,t0,t1"), body("lw t1,8(sp)", "lw t0,12(sp)", "subu t2,t0,t1")).commutative_findings, []);
});

test("the findings are machine readable in the comparison document", () => {
  const payload = JSON.parse(dumps(comparison(body("or t2,t0,t1"), body("or t2,t1,t0")).asDict()));
  assert.equal(payload.commutative_findings.length, 1);
  assert.equal(payload.commutative_findings[0].kind, "operand-order");
});
