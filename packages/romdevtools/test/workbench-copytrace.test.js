// COPYDEC copy/coalescing decision traces align by stack home, not by
// trace-local numbers. Ported from the workbench's copytrace tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { copyDecisionReport, parseCopyDecisions } from "../src/decomp/workbench/copytrace.js";

const BASELINE = `CDXW 000001 p0   d2  COPYDEC      tag=pre-reemit stmt=64    lhs=62    rhs=-1    rhsop=00 rhstable=0     rhschain=0   occ=0/0 rhsformed=-1 bbwit=-1 lhscolor=12 rhscolor=-99 lhsframe=ffffffe4 -> COALESCE
CDXW 000002 p0   d2  COPYDEC      tag=pre-reemit stmt=87    lhs=39    rhs=62    rhsop=00 rhstable=0     rhschain=0   occ=0/0 rhsformed=1 bbwit=0 lhscolor=8 rhscolor=12 lhsframe=fffffffa -> TEMPCOPY
`;
const CANDIDATE = `CDXW 000101 p0   d2  COPYDEC      tag=pre-reemit stmt=46    lhs=44    rhs=11    rhsop=00 rhstable=0     rhschain=0   occ=0/0 rhsformed=1 bbwit=0 lhscolor=-99 rhscolor=5 lhsframe=ffffffe4 -> TEMPCOPY
`;
const TIMELINE = `CDXW 000201 p0   d2  COPYDEC      tag=pre-makelivranges stmt=26    lhs=23    rhs=25    rhsop=01 rhstable=1465  rhschain=0   occ=0/2 rhsformed=0 bbwit=1 lhscolor=-99 rhscolor=-99 lhsframe=fffffff0 -> COALESCE
CDXW 000202 p0   d2  COPYDEC      tag=post-makelivranges stmt=26    lhs=23    rhs=25    rhsop=01 rhstable=1465  rhschain=0   occ=1/2 rhsformed=1 bbwit=1 lhscolor=-99 rhscolor=0 lhsframe=fffffff0 -> TEMPCOPY
CDXW 000203 p0   d2  COPYDEC      tag=pre-localcolor stmt=26    lhs=23    rhs=25    rhsop=01 rhstable=1465  rhschain=0   occ=1/2 rhsformed=1 bbwit=1 lhscolor=-99 rhscolor=0 lhsframe=fffffff0 -> TEMPCOPY
`;

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
  const changed = report.differences[0];
  assert.equal(changed.alignment_key, "proc0:home-0x1c:#0");
  assert.ok(changed.changed.includes("decision"));
  assert.equal(changed.baseline.decision, "COALESCE");
  assert.equal(changed.candidate.decision, "TEMPCOPY");
  assert.ok(report.warnings[0].includes("hash-table"));
});

test("the diff reports candidate stage evidence separately", () => {
  const report = copyDecisionReport("", { against: CANDIDATE, tag: "missing", proc: 0 });
  assert.equal(report.summary.decision_count, 0);
  assert.equal(report.candidate_summary.decision_count, 0);
  assert.deepEqual(report.timeline.observed_stages, []);
  assert.deepEqual(report.candidate_timeline.observed_stages, ["pre-reemit"]);
});

test("the timeline identifies a directly bracketed owner pass", () => {
  const timeline = copyDecisionReport(TIMELINE, { tag: "pre-localcolor", proc: 0 }).timeline;
  assert.deepEqual(timeline.observed_stages, ["pre-makelivranges", "post-makelivranges", "pre-localcolor"]);
  assert.equal(timeline.decision_transition_count, 1);
  const t = timeline.transitions[0];
  assert.equal(t.alignment_key, "proc0:home-0x10:#0");
  assert.equal(t.before_decision, "COALESCE");
  assert.equal(t.after_decision, "TEMPCOPY");
  assert.equal(t.owner_pass, "makelivranges");
  assert.equal(t.owner_claim, "directly bracketed pass");
});
