// Ported from the workbench's ownership and routing tests that go through
// the screen and the diagnose commands: --trace makes the measured basis
// reachable (with provenance), the screen and payload agree, the schema bump
// is additive, and a relocation naming another symbol routes to the import.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assemble } from "./fixtures/workbench/mips-asm.js";
import { parseDisassembly } from "../src/decomp/workbench/objdump.js";
import { VIEW_METRICS_BY_KEY } from "../src/decomp/workbench/schema.js";
import { BASIS_HEURISTIC, BASIS_TRACE, OWNING_PASS_STACK_HOME, OWNING_PASS_UNKNOWN, OWNING_PASS_UOPT_COLOR, REACHABILITY_PASS_OWNED, REACHABILITY_SOURCE,
  REACHABILITY_UNKNOWN, ROUTING_IMPORT_FIX, PERMUTER_ROUTING_SENTENCE, buildView } from "../src/decomp/workbench/view.js";
import { DIAGNOSIS_SCHEMA, diagnoseDumps } from "../src/decomp/workbench/diagnosis.js";
import { renderView } from "../src/decomp/workbench/view-cli.js";
import { replace } from "../src/decomp/workbench/py.js";
import { runCli } from "./fixtures/workbench/cli-run.js";

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "workbench");
const PT = path.join(FIX, "phase-shift-target.objdump.txt"), PC = path.join(FIX, "phase-shift-candidate.objdump.txt");
const TRACE = path.join(FIX, "globalcolor-declined.trace");
const SYMBOL = "demo";
const PROLOGUE = ["addiu sp,sp,-32", "sw ra,28(sp)", "sw s0,24(sp)", "move s0,a0"];
const EPILOGUE = ["lw ra,28(sp)", "lw s0,24(sp)", "jr ra", "addiu sp,sp,32"];
const viewOf = (t, c) => buildView(parseDisassembly(assemble([...PROLOGUE, ...t, ...EPILOGUE], { symbol: SYMBOL }), { symbol: SYMBOL }),
  parseDisassembly(assemble([...PROLOGUE, ...c, ...EPILOGUE], { symbol: SYMBOL }), { symbol: SYMBOL }), { target_name: "target.objdump", candidate_name: "candidate.objdump", symbol: SYMBOL });
const diagnose = (...extra) => runCli(["diagnose-dumps", PT, PC, "--function", "animStep", "--terse", ...extra]);

test("without a trace the residual is a heuristic; a scoped trace makes it a measurement that names its source", async () => {
  let [status, out, err] = await diagnose();
  assert.equal(status, 0, err); assert.ok(out.includes(`ownership_basis=${BASIS_HEURISTIC}`));
  [status, out, err] = await diagnose("--trace", TRACE, "--trace-proc", "1", "--trace-web", "7");
  assert.equal(status, 0, err);
  for (const s of [`ownership_basis=${BASIS_TRACE}`, `owning_pass=${OWNING_PASS_UOPT_COLOR}`, `reachability=${REACHABILITY_PASS_OWNED}`, "globalcolor-declined.trace", "proc=1, web=7"]) assert.ok(out.includes(s), s);
});

test("a trace scoped elsewhere settles nothing and says so; a missing trace is a usage error", async () => {
  let [status, out, err] = await diagnose("--trace", TRACE, "--trace-proc", "2");
  assert.equal(status, 0, err);
  for (const s of [`ownership_basis=${BASIS_HEURISTIC}`, "holds no declined force", "--trace-proc"]) assert.ok(out.includes(s), s);
  [status, , err] = await diagnose("--trace", path.join(FIX, "absent.trace"));
  assert.equal(status, 2); assert.ok(err.includes("absent.trace"));
});

test("the measured basis reaches JSON too", async () => {
  const [status, out, err] = await runCli(["diagnose-dumps", PT, PC, "--function", "animStep", "--json", "--trace", TRACE, "--trace-proc", "1", "--trace-web", "7"]);
  assert.equal(status, 0, err);
  const p = JSON.parse(out);
  assert.equal(p.ownership_basis, BASIS_TRACE); assert.equal(p.owning_pass, OWNING_PASS_UOPT_COLOR);
  assert.ok(p.view.next.join(" ").includes("globalcolor-declined.trace"));
});

test("the screen prints all three ownership fields and the payload says the same; every key is registered", () => {
  const view = viewOf(["sw v0,24(sp)"], ["sw v0,28(sp)"]);
  const line = renderView(view).find((l) => l.startsWith("ownership: "));
  for (const s of [`owning_pass=${OWNING_PASS_STACK_HOME}`, `reachability=${REACHABILITY_SOURCE}`, `ownership_basis=${BASIS_HEURISTIC}`]) assert.ok(line.includes(s), s);
  const p = view.asDict();
  assert.equal(p.owning_pass, view.owning_pass); assert.equal(p.reachability, view.reachability); assert.equal(p.ownership_basis, view.ownership.basis);
  for (const k of ["owning_pass", "reachability", "ownership_basis"]) assert.ok(k in VIEW_METRICS_BY_KEY);
});

test("the screen names the tool beside the lever family, and the payload carries the same routing", () => {
  const view = viewOf(["lw t8,0(s0)", "sw t8,4(s0)"], ["lw t6,0(s0)", "sw t6,4(s0)"]);
  assert.ok(renderView(view).find((l) => l.startsWith("verdict:")).includes("routing=evidence-first"));
  assert.equal(view.asDict().routing, view.routing);
});

test("the diagnosis schema bump is additive and carries ownership and routing", async () => {
  const [status, out, err] = await runCli(["diagnose-dumps", PT, PC, "--function", "animStep", "--json"]);
  assert.equal(status, 0, err); assert.equal(err, "");
  const p = JSON.parse(out);
  assert.equal(p.schema, "decomp-workbench-diagnosis-v3"); assert.equal(p.schema, DIAGNOSIS_SCHEMA);
  assert.equal(p.owning_pass, OWNING_PASS_UNKNOWN); assert.equal(p.reachability, REACHABILITY_UNKNOWN); assert.equal(p.ownership_basis, BASIS_HEURISTIC);
  for (const k of ["comparison", "view", "routing"]) assert.ok(k in p, k);
  assert.equal(p.view.verdict, "register-permutation"); assert.equal(p.view.owning_pass, p.owning_pass);
  assert.equal(p.routing, "evidence-first"); assert.equal(p.view.routing, "evidence-first");
});

test("the diagnose screen carries the ownership line and routes a tie instead of ending it", async () => {
  const [status, out] = await diagnose();
  assert.equal(status, 0);
  assert.ok(out.includes(`owning_pass=${OWNING_PASS_UNKNOWN}`)); assert.ok(out.includes(`reachability=${REACHABILITY_UNKNOWN}`));
  assert.ok(!out.includes(PERMUTER_ROUTING_SENTENCE)); assert.ok(out.includes("routing=evidence-first"));
});

test("a relocation naming another symbol has no owning pass and routes to the import", () => {
  const d = diagnoseDumps(PT, PC, { symbol: "animStep" });
  assert.equal(d.routing, "evidence-first");
  const comparison = Object.assign(Object.create(Object.getPrototypeOf(d.comparison)), d.comparison, { relocation_symbol_mismatches: 1 });
  const disagreeing = replace(d, { comparison });
  assert.equal(disagreeing.ownership.owning_pass, OWNING_PASS_UNKNOWN); assert.equal(disagreeing.ownership.reachability, REACHABILITY_UNKNOWN);
  assert.equal(disagreeing.routing, ROUTING_IMPORT_FIX);
  assert.equal(disagreeing.asDict().owning_pass, OWNING_PASS_UNKNOWN); assert.equal(disagreeing.asDict().routing, ROUTING_IMPORT_FIX);
  assert.equal(disagreeing.view.owning_pass, OWNING_PASS_UNKNOWN); assert.equal(disagreeing.view.routing, "evidence-first");
});
