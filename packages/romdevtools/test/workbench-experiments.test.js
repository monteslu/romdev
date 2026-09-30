// Experiment sidecars make family, parameters, and invariants durable.
// Ported from the workbench's experiment tests. The campaign-driven cases
// compile with a node script standing in for the compiler and a node script
// standing in for objdump; they run once the campaign command is present.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EXPERIMENT_SCHEMA, EXPERIMENT_SCHEMA_V2, RegionConstraint, SignalSpec, expectedParameterCombinations, loadExperiment } from "../src/decomp/workbench/experiments.js";
import { evaluateSignals } from "../src/decomp/workbench/experiment-signals.js";
import { parseDisassembly } from "../src/decomp/workbench/objdump.js";
import { compareInstructions } from "../src/decomp/workbench/compare.js";
import { runCommand, runCommandIsolated, commandSpecs } from "../src/decomp/workbench/cli.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WB = path.join(HERE, "../src/decomp/workbench");
const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "romdev-wb-exp-")));
const withDir = (fn) => async () => { const d = tmp(); try { await fn(d); } finally { fs.rmSync(d, { recursive: true, force: true }); } };
const write = (p, v) => fs.writeFileSync(p, typeof v === "string" ? v : JSON.stringify(v));
const optional = async (file, name) => { if (!fs.existsSync(path.join(WB, file))) return null; try { return (await import(path.join(WB, file)))[name] ?? null; } catch { return null; } };

const regionScore = await optional("campaign.js", "regionScore");
const buildStatus = await optional("campaign-state.js", "buildStatus");
const compactParameterEvidence = (await optional("campaign-cli.js", "_compactParameterEvidence")) ?? (await optional("campaign-cli.js", "compactParameterEvidence"));
const hasCampaign = (await commandSpecs()).has("campaign");

const compare = (t, c) => compareInstructions(parseDisassembly(t), parseDisassembly(c), { target_name: "target", candidate_name: "candidate", symbol: null });
const T3 = "0: 24020001 li $v0,1\n4: 24030002 li $v1,2\n8: 03e00008 jr $ra\n";

test("v2 parses signals, controls and coverage", withDir((root) => {
  write(path.join(root, "baseline.c"), "int baseline;\n");
  const p = path.join(root, "experiment.json");
  write(p, { schema: EXPERIMENT_SCHEMA_V2, family: "controlled-family", baseline: "baseline.c", parameters: { shape: ["base"] },
    candidates: [{ source: "baseline.c", parameters: { shape: "base" } }],
    signals: [{ id: "tail", kind: "target-rows-exact", rows: [1], required: true }],
    controls: [{ id: "baseline", candidate: "baseline.c", expect: { words: 0, signals: { tail: "PASS" } } }],
    coverage: { method: "exhaustive", excluded: 0 } });
  const m = loadExperiment(p);
  assert.equal(m.schema, EXPERIMENT_SCHEMA_V2);
  assert.equal(m.signals[0].id, "tail");
  assert.equal(m.controls[0].kind, "absolute");
  assert.equal(m.coverage.method, "exhaustive");
}));

test("v1 rejects v2 fields with a migration message", withDir((root) => {
  write(path.join(root, "baseline.c"), "int baseline;\n");
  const p = path.join(root, "experiment.json");
  write(p, { schema: EXPERIMENT_SCHEMA, family: "wrong-version", baseline: "baseline.c", signals: [] });
  assert.throws(() => loadExperiment(p), new RegExp(EXPERIMENT_SCHEMA_V2));
}));

test("v2 identity tracks control source content", withDir((root) => {
  const source = path.join(root, "baseline.c");
  write(source, "int baseline = 1;\n");
  const p = path.join(root, "experiment.json");
  write(p, { schema: EXPERIMENT_SCHEMA_V2, family: "source-hash", baseline: "baseline.c", controls: [{ id: "baseline", candidate: "baseline.c", expect: { returncode: 0 } }] });
  const first = loadExperiment(p).identityReceipt();
  write(source, "int baseline = 2;\n");
  assert.notEqual(first.sha256, loadExperiment(p).identityReceipt().sha256);
}));

test("coverage refuses unexplained or impossible exclusions", withDir((root) => {
  write(path.join(root, "baseline.c"), "int baseline;\n");
  const p = path.join(root, "experiment.json");
  const base = { schema: EXPERIMENT_SCHEMA_V2, family: "coverage", baseline: "baseline.c", parameters: { shape: ["a", "b"] } };
  for (const [coverage, message] of [[{ excluded: 1 }, /exclusion_reason/], [{ excluded: 3, exclusion_reason: "impossible cells" }, /cannot exceed/]]) {
    write(p, { ...base, coverage });
    assert.throws(() => loadExperiment(p), message);
  }
}));

test("v2 coverage requires complete, disjoint candidate cells", withDir((root) => {
  for (const n of ["baseline.c", "candidate.c"]) write(path.join(root, n), "int value;\n");
  const p = path.join(root, "experiment.json");
  const base = { schema: EXPERIMENT_SCHEMA_V2, family: "coverage-cells", baseline: "baseline.c", parameters: { shape: ["a", "b"], flag: [false, true] } };
  write(p, { ...base, candidates: [{ source: "candidate.c", parameters: { shape: "a" } }] });
  assert.throws(() => loadExperiment(p), /assign every/);
  write(p, { ...base, candidates: [{ source: "candidate.c", parameters: { shape: "a", flag: false } }], coverage: { excluded: 4, exclusion_reason: "declared impossible" } });
  assert.throws(() => loadExperiment(p), /overlap or exceed/);
}));

test("coverage labels distinguish sampled, exhaustive and interrupted", { skip: !buildStatus && "campaign status is not present in this tree" }, withDir(async (root) => {
  const target = path.join(root, "target.o");
  fs.writeFileSync(target, "target");
  const report = async (status, visited) => {
    const ledger = path.join(root, `${status}-${visited.length}.jsonl`);
    fs.writeFileSync(ledger, visited.map((v) => JSON.stringify({ cache_key: v, source: `${v}.c`,
      experiment: { family: "coverage", parameters: { shape: v }, parameter_space: { shape: ["a", "b"] } },
      comparison: { candidate: v, candidate_sha256: v.repeat(64), aligned_total: 0, words: 0, verdict: "instruction-exact" } }) + "\n").join(""));
    const manifest = path.join(root, `${status}-${visited.length}.json`);
    write(manifest, { schema: "decomp-workbench-campaign-manifest-v1", identity: "identity", status,
      identity_inputs: { target: { path: target, sha256: "unused" }, symbol: "demo" }, ledger,
      sources: ["a", "b"].map((v) => ({ path: `${v}.c`, cache_key: v })),
      experiment: { schema: EXPERIMENT_SCHEMA_V2, family: "coverage", parameters: { shape: ["a", "b"] }, coverage: { method: "exhaustive", excluded: 0 } } });
    return await buildStatus(manifest);
  };
  assert.equal((await report("complete", ["a"])).conclusion_label, "sampled-over-declared-space");
  assert.equal((await report("complete", ["a", "b"])).conclusion_label, "exhaustive-over-declared-space");
  assert.equal((await report("interrupted", ["a"])).conclusion_label, "partial-interrupted");
}));

test("a target-relative signal survives an insertion before its row", () => {
  const comparison = compare(T3, "0: 00000000 nop\n4: 24020001 li $v0,1\n8: 24030002 li $v1,2\nc: 03e00008 jr $ra\n");
  const r = evaluateSignals([new SignalSpec("tail", "target-rows-exact", true, { rows: [1, 2], comparison: "raw" })], comparison);
  assert.equal(r[0].status, "PASS");
  assert.deepEqual(r[0].failed_rows, []);
});

test("a target-row signal does not pass on the same word elsewhere", () => {
  const comparison = compare(T3, "0: 24030002 li $v1,2\n4: 24020001 li $v0,1\n8: 03e00008 jr $ra\n");
  const r = evaluateSignals([new SignalSpec("row-zero", "target-rows-exact", true, { rows: [0], comparison: "raw" })], comparison)[0];
  assert.equal(r.status, "FAIL");
  assert.deepEqual(r.failed_rows, [0]);
});

const OBJDUMP_SCRIPT = "#!/usr/bin/env node\nconsole.log('00000000 <demo>:');\nconsole.log('   0: 03e00008  jr $ra');\nconsole.log('   4: 00000000  nop');\n";

async function controlledCampaign({ expectedWords, baselineFails = false }) {
  const root = tmp();
  try {
    const target = path.join(root, "target.o"), baseline = path.join(root, "baseline.c"), candidate = path.join(root, "candidate.c"), log = path.join(root, "compiled.log");
    fs.writeFileSync(target, "target");
    write(baseline, "baseline\n");
    write(candidate, "candidate\n");
    const compiler = path.join(root, "compile.mjs");
    write(compiler, "import fs from 'node:fs';\nimport path from 'node:path';\nconst [source, output, log] = process.argv.slice(2);\n"
      + "fs.appendFileSync(log, path.basename(source) + '\\n');\n"
      + (baselineFails ? "if (path.basename(source) === 'baseline.c') process.exit(9);\n" : "")
      + "fs.writeFileSync(output, fs.readFileSync(source));\n");
    const objdump = path.join(root, "objdump");
    write(objdump, OBJDUMP_SCRIPT);
    fs.chmodSync(objdump, 0o755);
    const experiment = path.join(root, "experiment.json");
    write(experiment, { schema: EXPERIMENT_SCHEMA_V2, family: "controlled", baseline: "baseline.c", parameters: { shape: ["candidate"] },
      candidates: [{ source: "candidate.c", parameters: { shape: "candidate" } }],
      signals: [{ id: "tail", kind: "target-rows-exact", rows: [1], required: true }],
      controls: [{ id: "baseline", candidate: "baseline.c", expect: { words: expectedWords, signals: { tail: "PASS" } } }] });
    const r = await runCommand(["campaign", target, candidate, "--compile-command", `${process.execPath} ${compiler} {source} {output} ${log}`,
      "--objdump", objdump, "--symbol", "demo", "--cache-dir", path.join(root, "cache"), "--state-dir", path.join(root, "state"),
      "--experiment-manifest", experiment, "--json-summary"], { cwd: root });
    return [r.code, JSON.parse(r.stdout), fs.readFileSync(log, "utf8").split("\n").filter(Boolean)];
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

const campaignSkip = !hasCampaign && "the campaign command is not present in this tree";

test("a failed control schedules zero ordinary candidates", { skip: campaignSkip }, async () => {
  const [status, payload, compiled] = await controlledCampaign({ expectedWords: 1 });
  assert.equal(status, 2);
  assert.equal(payload.status, "control-invalid");
  assert.equal(payload.unique_candidates, 0);
  assert.deepEqual(compiled, ["baseline.c"]);
});

test("a passing control precedes work and signals reach results", { skip: campaignSkip }, async () => {
  const [status, payload, compiled] = await controlledCampaign({ expectedWords: 0 });
  assert.equal(status, 0);
  assert.equal(payload.controls.status, "PASS");
  assert.deepEqual(compiled, ["baseline.c", "candidate.c"]);
  assert.equal(payload.results[0].signals[0].status, "PASS");
});

test("an unknown required control schedules zero ordinary candidates", { skip: campaignSkip }, async () => {
  const [status, payload, compiled] = await controlledCampaign({ expectedWords: 0, baselineFails: true });
  assert.equal(status, 2);
  assert.equal(payload.controls.receipts[0].status, "UNKNOWN");
  assert.deepEqual(compiled, ["baseline.c"]);
});

test("a differential control catches an ignored knob before scale", { skip: campaignSkip }, withDir(async (root) => {
  const target = path.join(root, "target.o"), candidate = path.join(root, "candidate.c"), log = path.join(root, "compiled.log");
  fs.writeFileSync(target, "target");
  for (const n of ["force-off", "force-on", "candidate"]) write(path.join(root, `${n}.c`), `${n}\n`);
  const compiler = path.join(root, "compile.mjs");
  write(compiler, "import fs from 'node:fs';\nimport path from 'node:path';\nconst [source, output, log] = process.argv.slice(2);\n"
    + "fs.appendFileSync(log, path.basename(source) + '\\n');\nfs.writeFileSync(output, 'ignored-knob');\n");
  const objdump = path.join(root, "objdump");
  write(objdump, OBJDUMP_SCRIPT);
  fs.chmodSync(objdump, 0o755);
  const experiment = path.join(root, "experiment.json");
  write(experiment, { schema: EXPERIMENT_SCHEMA_V2, family: "ignored-force", baseline: "force-off.c", parameters: { shape: ["candidate"] },
    candidates: [{ source: "candidate.c", parameters: { shape: "candidate" } }],
    controls: [{ id: "force-fired", kind: "differential", candidates: ["force-off.c", "force-on.c"], expect: { different: ["object_sha256"] } }] });
  const r = await runCommand(["campaign", target, candidate, "--compile-command", `${process.execPath} ${compiler} {source} {output} ${log}`,
    "--objdump", objdump, "--symbol", "demo", "--cache-dir", path.join(root, "cache"), "--state-dir", path.join(root, "state"),
    "--experiment-manifest", experiment, "--json-summary"], { cwd: root });
  assert.equal(r.code, 2);
  assert.equal(JSON.parse(r.stdout).controls.receipts[0].status, "FAIL");
  assert.deepEqual(fs.readFileSync(log, "utf8").split("\n").filter(Boolean), ["force-off.c", "force-on.c"]);
}));

test("homologous parameters are explicit and share choices", withDir((root) => {
  const baseline = path.join(root, "baseline.c");
  write(baseline, "int baseline;\n");
  const p = path.join(root, "experiment.json");
  write(p, { schema: EXPERIMENT_SCHEMA, family: "sibling-masks", baseline: "baseline.c",
    parameters: { first: [false, true], second: [false, true], third: [false, true] }, homologous_parameters: [["first", "second", "third"]],
    candidates: [{ source: "baseline.c", parameters: { first: false, second: false, third: false } }] });
  const m = loadExperiment(p);
  assert.deepEqual(m.homologous_parameters, [["first", "second", "third"]]);
  assert.deepEqual(m.metadataFor(baseline).homologous_parameters, [["first", "second", "third"]]);
}));

test("homology refuses an unassigned baseline", withDir((root) => {
  write(path.join(root, "baseline.c"), "int baseline;\n");
  write(path.join(root, "variant.c"), "int variant;\n");
  const p = path.join(root, "experiment.json");
  write(p, { schema: EXPERIMENT_SCHEMA, family: "sibling-masks", baseline: "baseline.c", parameters: { first: [false, true], second: [false, true] },
    homologous_parameters: [["first", "second"]], candidates: [{ source: "variant.c", parameters: { first: true, second: false } }] });
  assert.throws(() => loadExperiment(p), /baseline must appear/);
}));

test("the campaign cockpit compacts large parameter evidence", { skip: !compactParameterEvidence && "the campaign cockpit does not export its parameter-evidence compactor" }, () => {
  const tested = Array.from({ length: 64 }, (_, i) => ({ shape: String(i) }));
  const [testedText, declaredText] = compactParameterEvidence({ tested_parameters: tested, tested_parameter_sets: 375,
    declared_parameter_space: { shape: Array.from({ length: 25 }, (_, i) => String(i)), type: ["int", "s16", "s32", "u16", "u32"] } });
  assert.ok(testedText.includes("375 assignment(s)"));
  assert.ok(testedText.includes("+372 more"));
  assert.ok(!testedText.includes("'shape': '63'"));
  assert.equal(declaredText, "shape=25 choice(s), type=5 choice(s)");
});

test("the manifest resolves sources and parameter space", withDir((root) => {
  const variant = path.join(root, "variant.c");
  write(path.join(root, "baseline.c"), "int baseline;\n");
  write(variant, "int variant;\n");
  const p = path.join(root, "experiment.json");
  write(p, { schema: EXPERIMENT_SCHEMA, family: "statement-grouping", baseline: "baseline.c",
    parameters: { shape: ["split", "comma", "do-while"], site: ["pad-loop", "prefix"] },
    candidates: [{ source: "variant.c", parameters: { shape: "comma", site: "pad-loop" } }],
    selected_region: { name: "format-body", start: 1, end: 3 } });
  const m = loadExperiment(p);
  assert.equal(expectedParameterCombinations(m), 6);
  assert.equal(m.family, "statement-grouping");
  assert.deepEqual(m.region, new RegionConstraint(1, 3, "format-body"));
  assert.equal(m.metadataFor(variant).parameters.shape, "comma");
}));

test("validate explains a partial grid without compiling", withDir(async (root) => {
  write(path.join(root, "baseline.c"), "int baseline;\n");
  write(path.join(root, "candidate.c"), "int candidate;\n");
  const p = path.join(root, "experiment.json");
  write(p, { schema: EXPERIMENT_SCHEMA, family: "macro-shape", baseline: "baseline.c", parameters: { shape: ["comma", "do-while"] },
    candidates: [{ source: "candidate.c", parameters: { shape: "comma" } }] });
  const r = await runCommand(["experiment", "validate", p, "--json"], { cwd: root });
  const report = JSON.parse(r.stdout);
  assert.equal(r.code, 0);
  assert.equal(report.declared_combinations, 2);
  assert.equal(report.described_candidates, 1);
  assert.equal(report.complete_grid, false);
  const text = await runCommand(["experiment", "validate", p], { cwd: root });
  assert.equal(text.stdout, `experiment: macro-shape (${p})\nschema: ${EXPERIMENT_SCHEMA}\ncandidates: 1 described / 2 Cartesian combination(s)\ngrid: PARTIAL (explicit)\n`
    + "proof: Schema, paths, assignments, parameter membership, uniqueness, and selected-region bounds validated; no candidate was compiled.\n");
}));

test("validate summary omits the full candidate list", withDir(async (root) => {
  write(path.join(root, "baseline.c"), "int baseline;\n");
  write(path.join(root, "candidate.c"), "int candidate;\n");
  const p = path.join(root, "experiment.json");
  write(p, { schema: EXPERIMENT_SCHEMA, family: "compact-validation", baseline: "baseline.c", parameters: { shape: ["one"] },
    candidates: [{ source: "candidate.c", parameters: { shape: "one" } }] });
  const r = await runCommand(["experiment", "validate", p, "--json-summary"], { cwd: root });
  const report = JSON.parse(r.stdout);
  assert.equal(r.code, 0);
  assert.ok(!("candidates" in report));
  assert.equal(report.described_candidates, 1);
  assert.equal(report.family, "compact-validation");
  assert.equal(report.schema, EXPERIMENT_SCHEMA);
  const both = await runCommand(["experiment", "validate", p, "--json", "--json-summary"], { cwd: root });
  assert.equal(both.code, 2);
  assert.match(JSON.parse(both.stdout).error.message, /not allowed with argument --json/);
}));

test("validate reports bad manifests as input errors", withDir(async (root) => {
  const p = path.join(root, "experiment.json");
  write(p, "{ not json");
  const bad = await runCommand(["experiment", "validate", p, "--json"], { cwd: root });
  assert.equal(bad.code, 2);
  assert.match(JSON.parse(bad.stdout).error.message, /^Expecting property name enclosed in double quotes: line 1 column 3 \(char 2\)$/);
  // Run the way romdev runs it: in the project directory, so the path reads relative to it.
  const missing = await runCommandIsolated(["experiment", "validate", "absent.json"], { cwd: root });
  assert.equal(missing.code, 2);
  assert.equal(missing.stderr, "error: [Errno 2] No such file or directory: 'absent.json'\n");
  const bare = await runCommand(["experiment", "--json"], { cwd: root });
  assert.equal(bare.code, 2);
}));

test("the selected region scores inside and outside separately", { skip: !regionScore && "campaign region scoring is not present in this tree" }, () => {
  const report = regionScore(compare(T3, "0: 24020009 li $v0,9\n4: 24030002 li $v1,2\n8: 03e00008 jr $ra\n"), new RegionConstraint(1, 3, "solved"));
  assert.equal(report.exact, true);
  assert.equal(report.selected_mismatches, 0);
  assert.equal(report.outside_mismatches, 1);
});

test("an insertion before the region does not create positional phantoms", { skip: !regionScore && "campaign region scoring is not present in this tree" }, () => {
  const report = regionScore(compare(T3, "0: 00000000 nop\n4: 24020001 li $v0,1\n8: 24030002 li $v1,2\nc: 03e00008 jr $ra\n"), new RegionConstraint(1, 3, "solved"));
  assert.equal(report.exact, true);
  assert.equal(report.selected_mismatches, 0);
  assert.equal(report.outside_mismatches, 1);
});
