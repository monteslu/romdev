// A campaign directory is read, not registered. Ported from the workbench's
// test_campaign_survey.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { SURVEY_SCHEMA, surveyCampaign, surveyLines } from "../src/decomp/workbench/campaign-survey.js";
import { runCommand } from "../src/decomp/workbench/cli.js";

let root;
beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "romdev-wb-survey-"));
  writeFileSync(path.join(root, "CAMPAIGN-PLAN.md"), "plan\n");
  for (const stage of ["early", "late"]) {
    mkdirSync(path.join(root, stage, "o"), { recursive: true });
    writeFileSync(path.join(root, stage, `${stage}.c`), `/* ${stage} */\n`);
    writeFileSync(path.join(root, stage, "o", `${stage}.o`), "object");
    writeFileSync(path.join(root, stage, "RESULT.md"), "result\n");
  }
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

test("the stages are counted and ordered by recency", async () => {
  const report = await surveyCampaign(root);
  assert.equal(report.schema, SURVEY_SCHEMA);
  assert.equal(report.stage_count, 2);
  assert.deepEqual(report.stages.map((s) => s.name).sort(), ["early", "late"]);
  const stage = report.stages.find((s) => s.name === "late");
  assert.equal(stage.sources, 1);
  assert.equal(stage.objects, 1);
  assert.ok(stage.notes.includes("RESULT.md"));
});

test("nothing guesses which artifact is the base", async () => {
  const report = await surveyCampaign(root);
  assert.equal(report.base, null);
  const rendered = surveyLines(report).join("\n");
  assert.ok(rendered.includes("which may or may not be the base"));
  assert.ok(rendered.includes("Nothing is stored"));
});

test("a pinned base is hashed now rather than remembered", async () => {
  const source = path.join(root, "late", "late.c");
  const first = await surveyCampaign(root, { base: source });
  writeFileSync(source, "/* changed */\n");
  const second = await surveyCampaign(root, { base: source });
  assert.notEqual(first.base.sha256, second.base.sha256);
});

test("a truncated walk says so", async () => {
  const report = await surveyCampaign(root, { budget: 2 });
  assert.equal(report.truncated, true);
  assert.ok(surveyLines(report).join("\n").includes("TRUNCATED"));
});

test("a findings log is read through the note mechanism", async () => {
  writeFileSync(path.join(root, "WORKBENCH-IMPROVEMENTS.md"), "## WB-1 \u2014 a finding\n**Status:** LOGGED\n");
  const sidecar = path.join(root, "WORKBENCH-IMPROVEMENTS.md.notes.d");
  mkdirSync(sidecar);
  writeFileSync(path.join(sidecar, "20260809T000000-WB-2-abcd1234.json"), JSON.stringify({ schema: "decomp-workbench-note-v1", id: "WB-2", title: "pending",
    status: "LOGGED", body: "", author: null, recorded: "2026-08-09T00:00:00Z" }));
  const report = await surveyCampaign(root);
  assert.equal(report.findings_logs.length, 1);
  assert.equal(report.findings_logs[0].entries, 1);
  assert.equal(report.findings_logs[0].pending, 1);
});

test("a sweep manifest is reported with its coverage", async () => {
  const { writeFamily } = await import("../src/decomp/workbench/sweep.js");
  const { parseConstruct, removalFamily } = await import("../src/decomp/workbench/sweep-generators.js");
  const source = path.join(root, "late", "late.c");
  writeFileSync(source, "int demo(void) {\n    return 1;\n}\n");
  await writeFamily(await removalFamily(source, { constructs: [parseConstruct("2=return")] }), { directory: path.join(root, "late", "sweep") });
  const report = await surveyCampaign(root);
  assert.equal(report.sweeps.length, 1);
  assert.equal(report.sweeps[0].generator, "regress");
  assert.ok(surveyLines(report).join("\n").includes("regress"));
});

test("no gate stamp is itself the finding; a stamp is reported with its verdict", async () => {
  let rendered = surveyLines(await surveyCampaign(root)).join("\n");
  assert.ok(rendered.includes("instrument gates: none recorded"));
  mkdirSync(path.join(root, "gates"));
  writeFileSync(path.join(root, "gates", "uopt.json"), JSON.stringify({ schema: "decomp-workbench-instrument-gate-v1", profile: "uopt-cdx", pass: true, recorded: "2026-08-09T00:00:00Z" }));
  const report = await surveyCampaign(root);
  assert.equal(report.instrument_gates[0].profile, "uopt-cdx");
  rendered = surveyLines(report).join("\n");
  assert.ok(rendered.includes("PASS  uopt-cdx"));
});

test("a file is not a campaign directory, and says which command is", async () => {
  await assert.rejects(surveyCampaign(path.join(root, "CAMPAIGN-PLAN.md")), /campaign status/);
});

test("the command runs, names the root, has a JSON form, and refuses a missing directory", async () => {
  let r = await runCommand(["campaign", "survey", root]);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.stdout.includes(`campaign survey: ${root}`));
  r = await runCommand(["campaign", "survey", root, "--json"]);
  assert.equal(r.code, 0);
  assert.equal(JSON.parse(r.stdout).schema, SURVEY_SCHEMA);
  r = await runCommand(["campaign", "survey", path.join(root, "nowhere")]);
  assert.equal(r.code, 2);
  assert.ok(r.stderr.includes("is not a directory"));
  r = await runCommand(["commands", "--group", "campaign"]);
  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes("campaign status"));
  assert.ok(r.stdout.includes("campaign survey"));
});
