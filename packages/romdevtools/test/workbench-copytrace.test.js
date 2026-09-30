// IDO copy/coalescing decision traces align by stack home and assignment
// ordinal, never by trace-local bits or hash buckets. Ported from the
// workbench's copytrace tests, plus the trace-copy-decisions command.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { copyDecisionReport, parseCopyDecisions } from "../src/decomp/workbench/copytrace.js";
import { runCommand } from "../src/decomp/workbench/cli.js";

const BASELINE = "CDXW 000001 p0   d2  COPYDEC      tag=pre-reemit stmt=64    lhs=62    rhs=-1    rhsop=00 rhstable=0     rhschain=0   occ=0/0 rhsformed=-1 bbwit=-1 lhscolor=12 rhscolor=-99 lhsframe=ffffffe4 -> COALESCE\n"
  + "CDXW 000002 p0   d2  COPYDEC      tag=pre-reemit stmt=87    lhs=39    rhs=62    rhsop=00 rhstable=0     rhschain=0   occ=0/0 rhsformed=1 bbwit=0 lhscolor=8 rhscolor=12 lhsframe=fffffffa -> TEMPCOPY\n";
const CANDIDATE = "CDXW 000101 p0   d2  COPYDEC      tag=pre-reemit stmt=46    lhs=44    rhs=11    rhsop=00 rhstable=0     rhschain=0   occ=0/0 rhsformed=1 bbwit=0 lhscolor=-99 rhscolor=5 lhsframe=ffffffe4 -> TEMPCOPY\n";
const TIMELINE = "CDXW 000201 p0   d2  COPYDEC      tag=pre-makelivranges stmt=26    lhs=23    rhs=25    rhsop=01 rhstable=1465  rhschain=0   occ=0/2 rhsformed=0 bbwit=1 lhscolor=-99 rhscolor=-99 lhsframe=fffffff0 -> COALESCE\n"
  + "CDXW 000202 p0   d2  COPYDEC      tag=post-makelivranges stmt=26    lhs=23    rhs=25    rhsop=01 rhstable=1465  rhschain=0   occ=1/2 rhsformed=1 bbwit=1 lhscolor=-99 rhscolor=0 lhsframe=fffffff0 -> TEMPCOPY\n"
  + "CDXW 000203 p0   d2  COPYDEC      tag=pre-localcolor stmt=26    lhs=23    rhs=25    rhsop=01 rhstable=1465  rhschain=0   occ=1/2 rhsformed=1 bbwit=1 lhscolor=-99 rhscolor=0 lhsframe=fffffff0 -> TEMPCOPY\n";

test("parse signs the stack home and ignores other stages", () => {
  const [items, malformed] = parseCopyDecisions(BASELINE);
  assert.deepEqual(malformed, []);
  assert.equal(items.length, 2);
  assert.equal(items[0].lhs_frame, -0x1C);
  assert.equal(items[0].decision, "COALESCE");
  assert.equal(items[1].lhs_frame, -6);
});

test("the diff aligns by stack home, not trace bits", () => {
  const report = copyDecisionReport(BASELINE, { against: CANDIDATE, proc: 0 });
  assert.equal(report.summary.decision_count, 2);
  assert.equal(report.candidate_summary.decision_count, 1);
  assert.equal(report.difference_count, 2);
  const c = report.differences[0];
  assert.equal(c.alignment_key, "proc0:home-0x1c:#0");
  assert.ok(c.changed.includes("decision"));
  assert.equal(c.baseline.decision, "COALESCE");
  assert.equal(c.candidate.decision, "TEMPCOPY");
  assert.ok(report.warnings[0].includes("hash-table"));
});

test("candidate stage evidence is reported separately", () => {
  const report = copyDecisionReport("", { against: CANDIDATE, tag: "missing", proc: 0 });
  assert.equal(report.summary.decision_count, 0);
  assert.equal(report.candidate_summary.decision_count, 0);
  assert.deepEqual(report.timeline.observed_stages, []);
  assert.deepEqual(report.candidate_timeline.observed_stages, ["pre-reemit"]);
});

test("the timeline identifies a directly bracketed owner pass", () => {
  const t = copyDecisionReport(TIMELINE, { tag: "pre-localcolor", proc: 0 }).timeline;
  assert.deepEqual(t.observed_stages, ["pre-makelivranges", "post-makelivranges", "pre-localcolor"]);
  assert.equal(t.decision_transition_count, 1);
  const tr = t.transitions[0];
  assert.equal(tr.alignment_key, "proc0:home-0x10:#0");
  assert.equal(tr.before_decision, "COALESCE");
  assert.equal(tr.after_decision, "TEMPCOPY");
  assert.equal(tr.owner_pass, "makelivranges");
  assert.equal(tr.owner_claim, "directly bracketed pass");
});

test("trace-copy-decisions prints decisions, transitions and an empty-stage next step", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "romdev-wb-copy-"));
  try {
    const a = path.join(dir, "a.log"), b = path.join(dir, "b.log"), t = path.join(dir, "t.log");
    fs.writeFileSync(a, BASELINE); fs.writeFileSync(b, CANDIDATE); fs.writeFileSync(t, TIMELINE);
    const one = await runCommand(["trace", "copy-decisions", a]);
    assert.equal(one.code, 0);
    assert.ok(one.stdout.includes("copy decisions: 2 at pre-reemit; coalesced=1; temporary copies=1"));
    assert.ok(one.stdout.includes("proc0:home-0x1c:#0 COALESCE rhs_formed=-1 colors=12/-99"));
    const diff = await runCommand(["trace-copy-decisions", a, "--against", b]);
    assert.equal(diff.code, 0);
    assert.ok(diff.stdout.includes("copy decisions: 2 -> 1; coalesced=1->0; temporary copies=1->1"));
    assert.ok(diff.stdout.includes("proc0:home-0x1c:#0 COALESCE->TEMPCOPY changed=decision"));
    const tl = await runCommand(["trace-copy-decisions", t, "--stage", "pre-localcolor"]);
    assert.ok(tl.stdout.includes("transition: proc0:home-0x10:#0 COALESCE->TEMPCOPY across pre-makelivranges->post-makelivranges; owner=makelivranges"));
    const none = await runCommand(["trace-copy-decisions", t]);
    assert.equal(none.code, 1);
    assert.ok(none.stdout.includes("next: no decisions matched the selected stage; observed stages=['pre-makelivranges', 'post-makelivranges', 'pre-localcolor']"));
    const json = await runCommand(["trace-copy-decisions", a, "--json"]);
    assert.equal(JSON.parse(json.stdout).schema, "decomp-workbench-copy-decisions-v1");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
