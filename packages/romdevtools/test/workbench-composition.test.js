// Bounded source-mechanism composition, the cleanup inventory, and the
// mutation review. Ported from the workbench's composition and
// mutation-review tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { composeSources, inspectSource, loadComposition, reviewMutation } from "../src/decomp/workbench/composition.js";
import { loadExperiment } from "../src/decomp/workbench/experiments.js";
import { runCommand } from "../src/decomp/workbench/cli.js";

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "romdev-wb-composition-")));
const withDir = (fn) => async () => { const d = tmp(); try { await fn(d); } finally { fs.rmSync(d, { recursive: true, force: true }); } };

function makeSpec(root) {
  fs.writeFileSync(path.join(root, "base.c"), "int f(void) { return A + B; }\n");
  const spec = path.join(root, "composition.json");
  fs.writeFileSync(spec, JSON.stringify({ schema: "decomp-workbench-composition-v1", baseline: "base.c", max_order: 2, transformations: [
    { id: "left", family: "operand", edits: [{ find: "A", replace: "X" }] },
    { id: "right", family: "carrier", edits: [{ find: "B", replace: "Y" }] },
  ] }) + "\n");
  return spec;
}

test("generates singletons, the cross-family pair, and a valid experiment", withDir((root) => {
  const spec = loadComposition(makeSpec(root));
  const output = path.join(root, "generated");
  const report = composeSources(spec, output);
  const experiment = loadExperiment(path.join(output, "experiment.json"));
  const composed = fs.readFileSync(path.join(output, "003-left+right.c"), "utf8");
  assert.equal(report.generated_candidates, 3);
  assert.equal(report.cross_family_candidates, 1);
  assert.equal(report.candidates[2].line_delta, 0);
  assert.equal(report.candidates[2].byte_delta, 0);
  assert.equal(experiment.candidates.size, 3);
  assert.ok(composed.includes("X + Y"));
  assert.ok(report.next_steps[0].includes(path.join(output, "experiment.json")));
}));

test("dry run does not create output", withDir((root) => {
  const output = path.join(root, "generated");
  const report = composeSources(loadComposition(makeSpec(root)), output, { write: false });
  assert.equal(fs.existsSync(output), false);
  assert.equal(report.output, null);
}));

test("generation preserves CRLF line endings", withDir((root) => {
  const spec = makeSpec(root);
  fs.writeFileSync(path.join(root, "base.c"), Buffer.from("int f(void) {\r\n return A + B;\r\n}\r\n"));
  composeSources(loadComposition(spec), path.join(root, "generated"), { max_order: 1 });
  assert.deepEqual(fs.readFileSync(path.join(root, "generated", "001-left.c")), Buffer.from("int f(void) {\r\n return X + B;\r\n}\r\n"));
}));

test("candidate cap stops accidental combinatorial growth", withDir((root) => {
  assert.throws(() => composeSources(loadComposition(makeSpec(root)), path.join(root, "generated"), { max_candidates: 2 }), /above cap 2/);
}));

test("constraints that eliminate every candidate fail before writing", withDir((root) => {
  const p = makeSpec(root);
  const value = JSON.parse(fs.readFileSync(p, "utf8"));
  value.max_order = 1;
  value.transformations[0].requires = ["right"];
  value.transformations[1].requires = ["left"];
  fs.writeFileSync(p, JSON.stringify(value) + "\n");
  const output = path.join(root, "generated");
  assert.throws(() => composeSources(loadComposition(p), output), /no valid candidates/);
  assert.equal(fs.existsSync(output), false);
}));

test("source inspection is explicitly syntactic", withDir((root) => {
  const source = path.join(root, "candidate.c");
  fs.writeFileSync(source, "void f(void) {\n    static int carrier;\n    if (width == height) {}\n    if (width == height) {}\n    value += carrier * 0;\n}\n");
  const report = inspectSource(source);
  assert.equal(report.finding_count, 4);
  assert.equal(report.duplicate_empty_controls[0].count, 2);
  assert.equal(report.inventory_by_kind["empty-control"], 2);
  assert.ok(report.findings.every((f) => !f.safe_automatic_removal));
  assert.ok(report.findings.every((f) => f.review_question));
  assert.ok(report.cleanup_gates.at(-1).includes("object collateral"));
  assert.ok(report.proof.includes("syntax inventory only"));
}));

test("compose and inspect-source through the grouped commands", withDir(async (root) => {
  const spec = makeSpec(root);
  const r = await runCommand(["experiment", "compose", spec, path.join(root, "gen"), "--json"], { cwd: root });
  assert.equal(r.code, 0, r.stdout);
  assert.equal(JSON.parse(r.stdout).schema, "decomp-workbench-composition-v1");
  const t = await runCommand(["experiment", "compose", spec, path.join(root, "gen2"), "--dry-run"], { cwd: root });
  assert.equal(t.code, 0);
  assert.match(t.stdout, /^composition: 3 candidate\(s\) planned; cross-family=1 rejected=0\ncoverage: swept-exhaustively -- 3 of 3 point\(s\) \(subsets of 2 transformation\(s\) up to order 2\); a negative result here is a proof about this space\n/);
  const busy = await runCommand(["experiment", "compose", spec, path.join(root, "gen"), "--json"], { cwd: root });
  assert.equal(busy.code, 2);
  assert.match(JSON.parse(busy.stdout).error.message, /^composition output is not empty: /);
  const src = path.join(root, "base.c");
  const i = await runCommand(["experiment", "inspect-source", src], { cwd: root });
  assert.equal(i.code, 0);
  assert.ok(i.stdout.startsWith("source inspection: 0 candidate construct(s)\nproof: "));
}));

// mutation review

const BASELINE = "void demo(s32 arg0) {\n    f32 sp4A0;\n    f32 dead;\n    s32 count;\n\n    sp4A0 = compute(arg0);\n    count = 0;\n    while (count < 4) {\n        count += 1;\n    }\n    use(sp4A0);\n    use(sp4A0 + 1.0f);\n}\n";

function review(variant, baseline = BASELINE) {
  const root = tmp();
  try {
    fs.writeFileSync(path.join(root, "base.c"), baseline);
    fs.writeFileSync(path.join(root, "variant.c"), variant);
    return reviewMutation(path.join(root, "base.c"), path.join(root, "variant.c"));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
const codes = (r) => new Set(r.findings.map((f) => String(f.code)));

test("a read group re-hosted on a dead local is an error", () => {
  const report = review(BASELINE.replace("use(sp4A0)", "use(dead)"));
  assert.ok(codes(report).has("read-before-definition"));
  assert.equal(report.errors, 1);
  assert.equal(report.reviewed, false);
  const f = report.findings.find((x) => x.code === "read-before-definition");
  assert.equal(f.identifier, "dead");
  assert.ok(f.message.includes("never used it"));
});

test("deleting the only write before a read is an error", () => {
  const report = review(BASELINE.replace("    count = 0;\n", ""));
  assert.ok(codes(report).has("definition-removed"));
  assert.deepEqual(report.findings.filter((f) => f.line).map((f) => f.identifier), ["count"]);
});

test("deleting one of several writes is a warning, not a claim", () => {
  const baseline = BASELINE.replace("    use(sp4A0);", "    if (arg0) {\n        sp4A0 = 2.0f;\n    }\n    use(sp4A0);");
  const report = review(baseline.replace("sp4A0 = compute(arg0);", "dead = compute(arg0);"), baseline);
  assert.ok(codes(report).has("write-removed"));
  const f = report.findings.find((x) => x.code === "write-removed");
  assert.equal(f.severity, "warning");
  assert.equal(f.identifier, "sp4A0");
  assert.ok(f.message.includes("control-flow question"));
  assert.equal(report.errors, 0);
});

test("a pure rename of a whole local is clean", () => {
  const report = review(BASELINE.replaceAll("sp4A0", "spare"));
  assert.deepEqual(report.findings, []);
  assert.equal(report.reviewed, true);
  assert.deepEqual(report.identifiers_introduced, ["spare"]);
  assert.deepEqual(report.identifiers_withdrawn, ["sp4A0"]);
});

test("an unchanged variant reports nothing", () => {
  const report = review(BASELINE);
  assert.deepEqual(report.findings, []);
  assert.equal(report.changed_lines_added, 0);
  assert.equal(report.changed_lines_removed, 0);
});

test("an external call is not an undefined local", () => {
  assert.deepEqual(review(BASELINE.replace("use(sp4A0);", "publish(sp4A0);")).findings, []);
});

test("a member name is not a local", () => {
  assert.ok(!codes(review(BASELINE.replace("use(sp4A0);", "use(arg0->count);"))).has("read-before-definition"));
});

test("a baseline that already reads early is not this mutation's doing", () => {
  const baseline = BASELINE.replace("    use(sp4A0);", "    use(dead);");
  assert.equal(review(baseline.replace("use(dead)", "use(dead + 0.0f)"), baseline).errors, 0);
});

test("the diff is part of the report", () => {
  const report = review(BASELINE.replace("use(sp4A0)", "use(dead)"));
  assert.ok(report.diff.some((l) => l.startsWith("-")));
  assert.ok(report.diff.some((l) => l.startsWith("+")));
});

test("a line-count change is a warning to read the diff", () => {
  assert.ok(codes(review(BASELINE.replace("    use(sp4A0);\n", ""))).has("statement-count-changed"));
});

test("the report never claims validity", () => {
  const report = review(BASELINE.replaceAll("sp4A0", "spare"));
  assert.ok(report.proof.includes("cannot certify"));
  assert.ok(report.next_gate.includes("justify every changed line"));
});

test("a negative context is rejected", withDir((root) => {
  fs.writeFileSync(path.join(root, "base.c"), BASELINE);
  fs.writeFileSync(path.join(root, "variant.c"), BASELINE);
  assert.throws(() => reviewMutation(path.join(root, "base.c"), path.join(root, "variant.c"), { context: -1 }), { name: "ValueError" });
}));

async function runReview(variant, ...flags) {
  const root = tmp();
  try {
    fs.writeFileSync(path.join(root, "base.c"), BASELINE);
    fs.writeFileSync(path.join(root, "variant.c"), variant);
    return await runCommand(["experiment", "review-mutation", path.join(root, "base.c"), path.join(root, "variant.c"), ...flags], { cwd: root });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test("an invalid shape exits one and prints the diff", async () => {
  const r = await runReview(BASELINE.replace("use(sp4A0)", "use(dead)"));
  assert.equal(r.code, 1);
  assert.ok(r.stdout.includes("read-before-definition"));
  assert.ok(r.stdout.includes("--- "));
});

test("a clean variant exits zero", async () => {
  const r = await runReview(BASELINE.replaceAll("sp4A0", "spare"));
  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes("NO KNOWN INVALID SHAPE"));
});

test("a warning is fatal only on request", async () => {
  const variant = BASELINE.replace("    use(sp4A0);\n", "");
  assert.equal((await runReview(variant)).code, 0);
  assert.equal((await runReview(variant, "--fail-on-warning")).code, 1);
});

test("JSON carries the schema", async () => {
  const r = await runReview(BASELINE, "--json");
  assert.equal(r.code, 0);
  assert.equal(JSON.parse(r.stdout).schema, "decomp-workbench-mutation-review-v1");
});

test("a missing input is an input error", withDir(async (root) => {
  fs.writeFileSync(path.join(root, "base.c"), BASELINE);
  const r = await runCommand(["experiment", "review-mutation", path.join(root, "base.c"), path.join(root, "absent.c")], { cwd: root });
  assert.equal(r.code, 2);
  assert.ok(r.stderr.includes("error:"));
}));

test("the unified diff matches the standard format for a small change", () => {
  const report = review(BASELINE.replace("use(sp4A0)", "use(dead)"));
  const hunk = report.diff.slice(2);
  assert.deepEqual(hunk, ["@@ -8,6 +8,6 @@", "     while (count < 4) {", "         count += 1;", "     }", "-    use(sp4A0);", "+    use(dead);", "     use(sp4A0 + 1.0f);", " }"]);
  assert.ok(report.diff[0].startsWith("--- /") && report.diff[1].startsWith("+++ /"));
});

// The adoption rule is also stated in the skill and the field guide the
// workbench ships; those documents belong to the data port and are checked
// here only when they are present.
const DATA = fileURLToPath(new URL("../src/decomp/workbench/data/", import.meta.url));
const skillPath = path.join(DATA, "skills/n64-decomp-campaign/SKILL.md");
test("the skill states the adoption rule", { skip: !fs.existsSync(skillPath) && "skill data not present in this tree" }, () => {
  const skill = fs.readFileSync(skillPath, "utf8");
  assert.ok(skill.includes("never adopted on its score"));
  assert.ok(skill.includes("experiment review-mutation"));
});
const guidePath = path.join(DATA, "docs/field-guide.md");
test("the field guide states the adoption rule", { skip: !fs.existsSync(guidePath) && "field guide data not present in this tree" }, () => {
  const guide = fs.readFileSync(guidePath, "utf8");
  assert.ok(guide.includes("A sweep winner is a hypothesis, not an edit"));
  assert.ok(guide.includes("experiment review-mutation"));
});
