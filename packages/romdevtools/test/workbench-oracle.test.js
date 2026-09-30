// Oracle plans are phase-complete, measured, and explicitly diagnostic.
// Ported from the workbench's oracle tests; the compiler and objdump stand-ins
// are node scripts the test writes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, chmodSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { compareInstructions } from "../src/decomp/workbench/compare.js";
import { parseGlobalcolorTrace } from "../src/decomp/workbench/globalcolor.js";
import { CompileResult, Instruction } from "../src/decomp/workbench/model.js";
import { oracleDiff, oraclePlan, runOracleCampaign } from "../src/decomp/workbench/oracle.js";
import { planForCompile, renderOracleHtml } from "../src/decomp/workbench/oracle-cli.js";
import { runCommand } from "../src/decomp/workbench/cli.js";
import { splitlines } from "../src/decomp/workbench/py.js";

const TRACE = `
[CDX] webdetail proc=7 web=9 role=target dtype=13 bb=4 defbb=4 usebbs=5 line=20
[CDX] p1cost phase=p1 proc=7 web=9 color=1 cost=1
[CDX] p1cost phase=p1 proc=7 web=9 color=2 cost=2
[CDX] p1dec phase=p1 proc=7 web=9 bestcolor=1 forbidden0=0x40000000 forbidden1=0
[CDX] webdetail proc=7 web=55 role=target dtype=13 bb=8 defbb=8 usebbs=9 line=40
[CDX] p2cost phase=p2 proc=7 web=55 color=1 cost=1
[CDX] p2cost phase=p2 proc=7 web=55 color=2 cost=2
[CDX] p2dec phase=p2 proc=7 web=55 bestcolor=2 forbidden0=0 forbidden1=0
`;

const withDir = async (fn) => {
  const d = mkdtempSync(path.join(os.tmpdir(), "romdev-wb-oracle-"));
  try { return await fn(d); } finally { rmSync(d, { recursive: true, force: true }); }
};

test("plan reports both phases and omits forbidden colors", () => {
  const report = oraclePlan(parseGlobalcolorTrace(TRACE));
  const forces = new Set(report.forces.map((f) => f.force));
  assert.equal(report.both_phases_reported, true);
  assert.equal(report.coverage.p1.webs, 1);
  assert.equal(report.coverage.p2.webs, 1);
  assert.ok(!forces.has("p1:w9=c1"));
  for (const f of ["p1:w9=c2", "p1:w9=s", "p2:w55=c1"]) assert.ok(forces.has(f), f);
});

test("an absent phase is visible instead of silently exonerated", () => {
  const report = oraclePlan(parseGlobalcolorTrace("[CDX] p1cost proc=3 web=9 color=1 cost=1\n[CDX] p1dec proc=3 web=9 bestcolor=1 forbidden0=0 forbidden1=0\n"));
  assert.equal(report.coverage.p2.webs, 0);
  assert.ok(report.warnings.includes("p2: 0 allocator webs recorded"));
});

test("a plan with only run-local trace evidence withholds source advice", () => {
  const a = oraclePlan(parseGlobalcolorTrace(TRACE)).source_attribution;
  assert.equal(a.classification, "run-local-unattributed");
  assert.deepEqual(a.source_experiment_recommendations, []);
  assert.ok(a.next_gate.includes("source_semantic"));
  assert.ok(oraclePlan(parseGlobalcolorTrace(TRACE)).forces.every((r) => r.source_attribution.classification === "run-local-unattributed"));
});

test("a plan recommends a source experiment only for a direct semantic", () => {
  const trace = parseGlobalcolorTrace("[CDX] provenance_web proc=7 phase=p1 web=9 snapshot=preselect source_semantic=local:flag semantic_reason=ir-local\n"
    + "[CDX] provenance_web proc=7 phase=p1 web=9 snapshot=postselect source_semantic=local:flag semantic_reason=ir-local\n" + TRACE);
  const recs = oraclePlan(trace).source_attribution.source_experiment_recommendations;
  assert.equal(recs.length, 1);
  assert.equal(recs[0].source_semantic, "local:flag");
});

test("the semantic diff does not align on the numeric web id", () => {
  const target = parseGlobalcolorTrace(TRACE);
  const candidate = parseGlobalcolorTrace(TRACE.replaceAll("web=55", "web=155").replace("bestcolor=2 forbidden0=0", "bestcolor=1 forbidden0=0"));
  const report = oracleDiff(target, candidate, { proc: 7 });
  assert.equal(report.difference_count, 1);
  const row = report.semantic.differences[0];
  assert.ok(row.changed.includes("assigned_color"));
  assert.notEqual(row.target.numeric_web, row.candidate.numeric_web);
});

test("a sweep reuses campaign truth and labels force-exact as evidence", () => withDir(async (root) => {
  const source = path.join(root, "candidate.c"), target = path.join(root, "target.o");
  writeFileSync(source, "int demo;\n");
  writeFileSync(target, "target");
  const compiler = path.join(root, "compile.mjs");
  writeFileSync(compiler, `import fs from "node:fs";\nfs.writeFileSync(process.argv[3], process.env.CDX_FORCE === "p2:w55=c2" ? "exact" : "baseline");\n`);
  const objdump = path.join(root, "objdump");
  writeFileSync(objdump, `#!${process.execPath}
const fs = require("fs");
const obj = process.argv.slice(2).find((a) => a.endsWith(".o"));
const value = fs.readFileSync(obj, "utf8");
console.log("00000000 <demo>:");
if (value === "target" || value === "exact") console.log("   0: 03e00008  jr $ra");
else console.log("   0: 00001021  move $v0,$zero");
console.log("   4: 00000000  nop");
`);
  chmodSync(objdump, 0o755);
  const plan = { ...oraclePlan(parseGlobalcolorTrace(TRACE)), forces: [
    { force: "p1:w9=c2", phase: "p1", web: 9, color: 2, register: "v1" },
    { force: "p2:w55=c2", phase: "p2", web: 55, color: 2, register: "v1" },
  ] };
  const opts = { source, target, template: `${process.execPath} ${compiler} {source} {output}`, environment: {}, cache_dir: path.join(root, "cache"),
    ledger: path.join(root, "oracle.jsonl"), jobs: 2, objdump, symbol: "demo", keep_objects: path.join(root, "objects") };
  const report = await runOracleCampaign(plan, opts);
  const cached = await runOracleCampaign(plan, opts);
  const ledger = splitlines(readFileSync(path.join(root, "oracle.jsonl"), "utf8"));
  assert.deepEqual(report.exact_forces, ["p2:w55=c2"]);
  assert.equal(report.minimum_forces_to_exact, 1);
  assert.equal(report.signature, "one-force-exact(p2:w55=c2)");
  assert.ok(report.proof.includes("never an acceptable source match"));
  const exactRow = report.results.find((r) => r.force === "p2:w55=c2");
  assert.equal(exactRow.emitted_effect.available, true);
  assert.equal(exactRow.emitted_effect.changed_site_count, 1);
  assert.ok(exactRow.emitted_effect.proof_boundary.includes("not source_semantic"));
  assert.ok(cached.results.every((r) => r.cached));
  assert.equal(cached.baseline.cached, true);
  assert.equal(ledger.length, 3);
}));

const plan7 = (force, extra = {}) => ({ schema: "decomp-workbench-oracle-plan-v1", procedure: 7, coverage: {}, forces: [{ force, ...extra }] });

test("an exact force is withheld without a non-exact control", async () => {
  const ins = new Instruction({ address: 0, word: "03e00008", assembly: "jr $ra" });
  const exact = compareInstructions([ins], [ins], { target_name: "target", candidate_name: "forced", symbol: null });
  const baseline = new CompileResult({ source: "candidate.c", command: [], returncode: 1, stdout: "", stderr: "baseline failed", object_path: null,
    comparison: null, experiment: { baseline: true, force: null } });
  const forced = new CompileResult({ source: "candidate.c", command: [], returncode: 0, stdout: "", stderr: "", object_path: "forced.o", comparison: exact,
    experiment: { baseline: false, force: "p2:w55=c2", phase: "p2", web: 55, color: 2, register: "v1" } });
  const report = await runOracleCampaign(plan7("p2:w55=c2", { phase: "p2", web: 55, color: 2, register: "v1" }), {
    source: "candidate.c", target: "target.o", template: "compiler {source} {output}", environment: {}, cache_dir: "cache", campaign: async () => [baseline, forced] });
  assert.equal(report.control_valid, false);
  assert.deepEqual(report.observed_exact_forces, ["p2:w55=c2"]);
  assert.deepEqual(report.exact_forces, []);
  assert.equal(report.signature, null);
  assert.ok(report.warnings[0].includes("not causal"));
});

test("an exact force set reports its actual cardinality", async () => {
  const t = new Instruction({ address: 0, word: "03e00008", assembly: "jr $ra" });
  const m = new Instruction({ address: 0, word: "00001021", assembly: "move $v0,$zero" });
  const baseComparison = compareInstructions([t], [m], { target_name: "target", candidate_name: "baseline", symbol: null });
  const exactComparison = compareInstructions([t], [t], { target_name: "target", candidate_name: "forced", symbol: null });
  const components = [{ force: "p1:w9=c2", phase: "p1", web: 9, color: 2 }, { force: "p2:w55=c1", phase: "p2", web: 55, color: 1 }];
  const baseline = new CompileResult({ source: "candidate.c", command: [], returncode: 0, stdout: "", stderr: "", object_path: null, comparison: baseComparison,
    experiment: { baseline: true, force: null } });
  const forced = new CompileResult({ source: "candidate.c", command: [], returncode: 0, stdout: "", stderr: "", object_path: null, comparison: exactComparison,
    experiment: { baseline: false, force: "p1:w9=c2,p2:w55=c1", phase: "combined", components } });
  const report = await runOracleCampaign(plan7("p1:w9=c2,p2:w55=c1", { phase: "combined", web: null, color: null, register: "v1,v0", components }), {
    source: "candidate.c", target: "target.o", template: "compiler {source} {output}", environment: {}, cache_dir: "cache", campaign: async () => [baseline, forced] });
  assert.equal(report.minimum_forces_to_exact, 2);
  assert.equal(report.signature, "force-set-exact(p1:w9=c2,p2:w55=c1)");
});

const planArgs = (force) => ({ trace: "trace.log", proc: null, colors_p1: null, colors_p2: null, no_split: false, force });
const loader = () => parseGlobalcolorTrace(TRACE);

test("the force command accepts a validated multi-web interaction", () => {
  const selected = planForCompile(planArgs("p1:w9=c2,p2:w55=c1"), null, null, { loader });
  assert.equal(selected.force_count, 1);
  const row = selected.forces[0];
  assert.equal(row.phase, "combined");
  assert.equal(row.components.length, 2);
  assert.equal(row.force, "p1:w9=c2,p2:w55=c1");
});

test("the force command rejects a duplicate phase/web in an interaction", () => {
  assert.throws(() => planForCompile(planArgs("p1:w9=c2,p1:w9=s"), null, null, { loader }), /same phase\/web/);
});

test("persisted status and exclusive HTML export need no toolchain", () => withDir(async (root) => {
  const report = {
    schema: "decomp-workbench-oracle-sweep-v1", completed_forces: 1, planned_forces: 1, baseline: { comparison: { words: 2 } },
    results: [{ force: "p2:w55=c2", register: "v1", returncode: 0, comparison: { exact: true, words: 0, aligned_total: 0 } }],
    signature: "one-force-exact(p2:w55=c2)", proof: "Forced compiler output is causal evidence only.",
    state: { directory: "/state/oracle/demo", ledger: "/state/oracle/demo/ledger.jsonl" },
  };
  const state = path.join(root, "oracle-state");
  mkdirSync(state);
  writeFileSync(path.join(state, "report.json"), JSON.stringify(report));
  const status = await runCommand(["oracle", "status", state, "--json"]);
  const output = path.join(root, "oracle.html");
  const exported = await runCommand(["oracle", "export", state, "--output", output]);
  const document = readFileSync(output, "utf8");
  const repeated = await runCommand(["oracle", "export", state, "--output", output]);
  assert.equal(status.code, 0);
  assert.equal(status.stderr, "");
  assert.equal(JSON.parse(status.stdout).signature, "one-force-exact(p2:w55=c2)");
  assert.equal(exported.code, 0);
  assert.equal(exported.stderr, "");
  for (const s of ["<!doctype html>", "Machine-readable evidence", '<a class="skip-link" href="#main-content">', '<main id="main-content">', "<details open>", "<caption>"]) {
    assert.ok(document.includes(s), s);
  }
  assert.ok(!document.includes("https://"));
  assert.equal(repeated.code, 2);
  assert.ok(repeated.stderr.includes("refusing to overwrite"));
  const text = await runCommand(["oracle", "status", state]);
  assert.equal(text.code, 0);
  assert.ok(text.stdout.includes("EXACT; NOT CAUSAL WITHOUT A NON-EXACT CONTROL"));
  assert.ok(renderOracleHtml(report).includes("exact; control unavailable or already exact"));
}));

test("plan and diff run through the command surface", () => withDir(async (root) => {
  const p = path.join(root, "trace.txt");
  writeFileSync(p, TRACE);
  const plan = await runCommand(["oracle", "plan", p, "--json"]);
  assert.equal(plan.code, 0, plan.stderr);
  assert.equal(JSON.parse(plan.stdout).schema, "decomp-workbench-oracle-plan-v1");
  const text = await runCommand(["oracle", "plan", p, "--colors-p1", "c2,3"]);
  assert.equal(text.code, 0);
  assert.ok(text.stdout.startsWith("oracle plan: p1 1 web(s)"));
  const bad = await runCommand(["oracle", "plan", p, "--colors-p1", "c99", "--json"]);
  assert.equal(bad.code, 2);
  assert.match(JSON.parse(bad.stdout).error.message, /colors must be in c0\.\.c63/);
  const diff = await runCommand(["oracle", "diff", p, p, "--json"]);
  assert.equal(diff.code, 1);
  assert.equal(JSON.parse(diff.stdout).difference_count, 0);
  const missing = await runCommand(["oracle", "status", "--state-dir", path.join(root, "none")]);
  assert.equal(missing.code, 2);
  assert.ok(missing.stderr.includes("no oracle report found"));
}));
