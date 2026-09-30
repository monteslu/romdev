// Project/scratch truth and the evidence-gated call-contract probe. Ported
// from the workbench's context-truth tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { compareInstructions } from "../src/decomp/workbench/compare.js";
import { buildTruthStack, callContractHypotheses, truthStackLines } from "../src/decomp/workbench/context-truth.js";
import { parseDisassembly } from "../src/decomp/workbench/objdump.js";
import { ScratchPackage } from "../src/decomp/workbench/scratch-check.js";
import { buildView } from "../src/decomp/workbench/view.js";

const TARGET = "0: 27bdffe0 addiu $sp,$sp,-32\n4: 00000000 nop\n8: 00000000 nop\nc: 00000000 nop\n10: 00000000 nop\n14: 0c000000 jal 0 <helper>\n18: 00000000 nop\n1c: 8c430000 lw $v1,0($v0)\n20: 00631821 addu $v1,$v1,$v1\n24: ac430004 sw $v1,4($v0)\n";
const CANDIDATE = "0: 27bdffe0 addiu $sp,$sp,-32\n4: 00000000 nop\n8: 00000000 nop\nc: 00000000 nop\n10: 00000000 nop\n14: 0c000000 jal 0 <helper>\n18: 00000000 nop\n1c: 8c420000 lw $v0,0($v0)\n20: 00421021 addu $v0,$v0,$v0\n24: ac420004 sw $v0,4($v0)\n";

const target = parseDisassembly(TARGET), candidate = parseDisassembly(CANDIDATE);
const scratch = compareInstructions(target, candidate, { target_name: "target", candidate_name: "scratch", symbol: "demo" });
const project = compareInstructions(target, target, { target_name: "target", candidate_name: "project", symbol: "demo" });
const view = buildView(target, candidate, { target_name: "target", candidate_name: "scratch", symbol: "demo" });
const pkg = (files) => new ScratchPackage({ path: "scratch.zip", kind: "decomp.me-export", files: new Map(Object.entries(files).map(([k, v]) => [k, Buffer.from(v)])), metadata: {}, checksums_valid: null });
const PACKAGE = pkg({ "ctx.c": "void helper();\n", "code.c": "int demo(void) { helper(); return 0; }\n" });

test("project exact and scratch mismatch are context-only", () => {
  const report = buildTruthStack({ external_score: { score: 3, max_score: 1000 }, scratch, project, hypotheses: [] });
  assert.equal(report.classification, "context-only");
  assert.equal(report.layers[1].status, "FAIL");
  assert.equal(report.layers[2].status, "PASS");
  assert.deepEqual(truthStackLines(report).slice(0, 2), ["truth: context-only", "  site metadata   CONTEXT score=3/1000"]);
});

test("a measured v0/v1 tail web routes to one int probe", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "romdev-wb-truth-"));
  try {
    const src = path.join(dir, "module.c");
    fs.writeFileSync(src, "int demo(void) { helper(); return 0; }\n");
    const h = callContractHypotheses({ package: PACKAGE, scratch, view, project, project_source: src, frontend: { language: "C", frontend: "cfe C" } });
    assert.equal(h.length, 1);
    assert.equal(h[0].callee, "helper");
    assert.ok(h[0].action.includes("int helper();"));
    assert.equal(h[0].project_return_category, "not-visible");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("C++ and non-C89 dialects suppress implicit-int advice", () => {
  assert.deepEqual(callContractHypotheses({ package: PACKAGE, scratch, view, project, project_source: null, frontend: { language: "C++", frontend: "EDG C++" } }), []);
  assert.deepEqual(callContractHypotheses({ package: PACKAGE, scratch, view, project, project_source: null, frontend: { language: "C99", frontend: "modern C" } }), []);
});

test("a generic post-call register swap without a void declaration is suppressed", () => {
  const p = pkg({ "ctx.c": "int helper();\n", "code.c": "int demo(void);\n" });
  assert.deepEqual(callContractHypotheses({ package: p, scratch, view, project, project_source: null, frontend: { language: "C", frontend: "cfe C" } }), []);
});
