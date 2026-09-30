// Stopping must be measured, not counted: a still-gaining series continues, a
// series that stopped buying anything stalls, and recorded evidence closes a
// target before any attempt. Ported from the workbench's stall tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_THRESHOLD, Attempt, readSeries } from "../src/decomp/workbench/stall.js";

const A = (residual, eliminated = false) => new Attempt({ residual, eliminated });

test("monotone improvement continues", () => {
  const r = readSeries([A(692), A(619), A(538)]);
  assert.equal(r.state, "improving");
  assert.equal(r.should_continue, true);
  assert.equal(r.stalled_for, 0);
  assert.equal(r.best_residual, 538);
  assert.equal(r.last_progress, 2);
});

test("a flat series stalls at the threshold; one short still continues", () => {
  const r = readSeries([A(41), A(41), A(41), A(41)]);
  assert.equal(r.state, "stalled");
  assert.equal(r.should_continue, false);
  assert.equal(r.stalled_for, DEFAULT_THRESHOLD);
  assert.equal(r.last_progress, 0);
  const s = readSeries([A(41), A(41), A(41)]);
  assert.equal(s.state, "improving");
  assert.equal(s.stalled_for, 2);
});

test("an elimination counts as progress without moving the residual", () => {
  const r = readSeries([A(41), A(41), A(41, true), A(41)]);
  assert.equal(r.state, "improving");
  assert.equal(r.stalled_for, 1);
  assert.equal(r.last_progress, 2);
});

test("a worse attempt does not reset the stall", () => {
  const r = readSeries([A(41), A(55), A(60), A(58)]);
  assert.equal(r.state, "stalled");
  assert.equal(r.stalled_for, 3);
  assert.equal(r.best_residual, 41);
});

test("recorded evidence closes the target before any attempt, and wins over improvement", () => {
  const r = readSeries([], { closed_by_evidence: true });
  assert.equal(r.state, "closed-by-evidence");
  assert.equal(r.should_continue, false);
  assert.equal(r.best_residual, null);
  assert.equal(readSeries([A(692), A(619)], { closed_by_evidence: true }).state, "closed-by-evidence");
});

test("an empty series is not a stall; the threshold must be positive", () => {
  const r = readSeries([]);
  assert.equal(r.state, "improving");
  assert.equal(r.best_residual, null);
  assert.equal(r.last_progress, null);
  assert.throws(() => readSeries([A(1)], { threshold: 0 }), /threshold/);
});

test("a reading never claims reachability and never licenses adoption", () => {
  assert.ok(readSeries(Array(4).fill(A(9))).lines.join("\n").includes("not a reachability claim"));
  assert.ok(readSeries([A(9), A(8)]).lines.join("\n").includes("never grounds for"));
});
