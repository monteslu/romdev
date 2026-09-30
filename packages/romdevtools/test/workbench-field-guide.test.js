// The field guide's verdict-to-lever index and on-ramps, as the comparison
// and the aligned view print them. The guide document itself (`guide`
// command) is not part of romdev; only the data every footer is built from.
import { test } from "node:test";
import assert from "node:assert/strict";
import { assemble } from "./fixtures/workbench/mips-asm.js";
import * as FG from "../src/decomp/workbench/field-guide.js";
import { compareInstructions } from "../src/decomp/workbench/compare.js";
import { parseDisassembly } from "../src/decomp/workbench/objdump.js";
import { buildView } from "../src/decomp/workbench/view.js";

const SYMBOL = "demo";
const PERMUTATION_TARGET = ["lw s3,0(s0)", "addu s3,s3,s3", "sw s3,4(s0)"];
const PERMUTATION_CANDIDATE = ["lw s1,0(s0)", "addu s1,s1,s1", "sw s1,4(s0)"];
const ins = (lines) => parseDisassembly(assemble(lines, { symbol: SYMBOL }), { symbol: SYMBOL });
const names = { target_name: "target", candidate_name: "candidate", symbol: SYMBOL };

test("lever 24: one-line action, routed from structure and schedule playbooks", () => {
  assert.ok(!FG.LEVER_ACTIONS[24].includes("\n") && FG.LEVER_ACTIONS[24].includes("context lint"));
  assert.ok(FG.PLAYBOOK_LEVERS["structure-buckets"].includes(24) && FG.PLAYBOOK_LEVERS["g0-schedule-probe"].includes(24));
  assert.ok(23 in FG.LEVER_ACTIONS && 24 in FG.LEVER_ACTIONS);
  for (const p of ["structure-buckets", "g0-schedule-probe"]) assert.ok(FG.nextSteps(p).join("\n").includes("lever 24:"));
});

test("stack frame recovery: compare names the frame pair, view routes to the playbook", () => {
  const T = ["addiu sp,sp,-40", "sw ra,36(sp)", "lw ra,36(sp)", "addiu sp,sp,40", "jr ra", "nop"];
  const C = ["addiu sp,sp,-56", "sw ra,36(sp)", "lw ra,36(sp)", "addiu sp,sp,56", "jr ra", "nop"];
  const r = compareInstructions(ins(T), ins(C), names);
  assert.equal(r.verdict, "frame-layout-mismatch");
  const g = r.guidance.join("\n");
  assert.ok(g.includes("stack-home/layout") && !g.includes("flag, enum") && g.includes("lever 26:"));
  const v = buildView(ins(T), ins(C), names);
  assert.equal(v.verdict, "frame-layout");
  assert.equal(v.playbook, "stack-frame-recovery");
  assert.ok(v.guidance.join("\n").includes("allocator-winning live ranges") && v.guidance.join("\n").includes("lever 26:"));
  assert.equal(FG.PLAYBOOK_LEVERS["stack-frame-recovery"][0], 26);
  assert.equal(FG.VERDICT_PLAYBOOKS["frame-layout-mismatch"], "stack-frame-recovery");
});

test("post-match cleanup playbook names its workflow", () => {
  assert.deepEqual(FG.PLAYBOOK_LEVERS["post-match-cleanup"], [27]);
  const s = FG.nextSteps("post-match-cleanup").join("\n");
  for (const x of ["experiment inspect-source", "experiment compose", "object collateral"]) assert.ok(s.includes(x), x);
});

test("every playbook lever has a one-line action", () => {
  for (const levers of Object.values(FG.PLAYBOOK_LEVERS)) for (const n of levers) { assert.ok(FG.LEVER_ACTIONS[n]); assert.ok(!FG.LEVER_ACTIONS[n].includes("\n")); }
});

test("the forced-color playbook names levers, a command and both branches", () => {
  const t = FG.nextSteps("forced-color-oracle").join("\n");
  for (const x of ["lever 17:", "lever 18:", "lever 19:", "decision-trace order", "decomp-workbench guide forced-color-oracle", "have an instrumented toolchain?", "don't have one?", "docs/compiler-instrumentation.md"]) assert.ok(t.includes(x), x);
  for (const p of ["forced-color-oracle", "pool-position", "temp-fifo-phase"]) {
    assert.ok(FG.PLAYBOOK_ONRAMPS[p].some((s) => s.startsWith("have")));
    assert.ok(FG.PLAYBOOK_ONRAMPS[p].some((s) => s.startsWith("don't have")));
  }
  for (const p of ["pool-position", "temp-fifo-phase"]) assert.ok(FG.PLAYBOOK_ONRAMPS[p][0].startsWith("don't have"));
  assert.ok(FG.PLAYBOOK_ONRAMPS["forced-color-oracle"][0].startsWith("have an instrumented toolchain?"));
  assert.ok(FG.PLAYBOOK_CAVEATS["pool-position"].includes("three unresolved allocation families"));
});

test("register permutation view carries the on-ramp; the named mechanism keeps its levers", () => {
  const v = buildView(ins(PERMUTATION_TARGET), ins(PERMUTATION_CANDIDATE), names);
  assert.equal(v.verdict, "register-permutation");
  const g = v.guidance.join("\n");
  for (const x of ["one bijection", "forced color probe", "lever 17:", "decomp-workbench guide forced-color-oracle", "don't have one?",
    "field guide levers for playbook=forced-color-oracle", "lever 19:"]) assert.ok(g.includes(x), x);
});

test("a coarse verdict names three families and picks none", () => {
  const r = compareInstructions(ins(PERMUTATION_TARGET), ins(PERMUTATION_CANDIDATE), names);
  assert.equal(r.verdict, "allocation-mismatch");
  const g = r.guidance.join("\n");
  for (const p of ["temp-fifo-phase", "pool-position", "forced-color-oracle"]) assert.ok(g.includes(`decomp-workbench guide ${p}`));
  assert.ok(!g.includes("lever 7:") && !g.includes("field guide levers for playbook="));
  assert.ok(g.includes("compare cannot see which of the three it is"));
});

test("no coarse verdict can borrow one family's levers", () => {
  for (const coarse of ["allocation", "allocation-mismatch"]) assert.ok(FG.VERDICT_PLAYBOOKS[coarse] in FG.AMBIGUOUS_PLAYBOOK_FAMILIES);
  for (const [, playbook] of Object.entries(FG.VERDICT_PLAYBOOKS)) {
    if (!(playbook in FG.AMBIGUOUS_PLAYBOOK_FAMILIES)) continue;
    const lines = FG.nextSteps(playbook).join("\n");
    assert.ok(!lines.includes("field guide levers for playbook="));
    for (const f of ["temp-fifo-phase", "pool-position", "forced-color-oracle"]) assert.ok(lines.includes(`decomp-workbench guide ${f}`));
  }
  for (const v of ["allocation", "commutative-order", "constant", "phase-shift", "register-permutation", "schedule", "structure"]) assert.ok(FG.nextSteps(FG.VERDICT_PLAYBOOKS[v]).length);
});

test("lever 28 reaches the ambiguous allocation footer and the pool page", () => {
  assert.ok(FG.PLAYBOOK_LEVERS["pool-position"].includes(28));
  const s = FG.nextSteps("pool-position").join("\n");
  assert.ok(s.includes("regsleft") && s.includes("guide 28"));
  const o = FG.PLAYBOOK_ONRAMPS["pool-position"].join("\n");
  assert.ok(o.includes("TAKEN") && o.includes("lever 28"));
});

test("line-assignment routing names the probe and the tie flag", () => {
  const s = FG.nextSteps("line-assignment-probe").join("\n");
  assert.ok(s.includes("decomp-workbench probe-lines") && s.includes("--tie STATEMENT=LINE"));
  assert.ok(FG.nextSteps("g0-schedule-probe").join("\n").includes("probe-lines"));
});

test("pass laws cite era and law; playbook laws are deduplicated", () => {
  const steps = FG.passLawSteps("uopt-globalcolor");
  assert.ok(steps.length >= 5 && steps.every((l) => /^law L\d+: .* -- decomp-workbench guide laws ido53 L\d+$/.test(l)));
  const both = FG.playbookLawSteps("constant-audit");
  assert.equal(new Set(both).size, both.length);
  assert.deepEqual(FG.passLawSteps("no-such-pass"), []);
});
