// Synthetic free-list initialization transitions versus conditional entry
// requests. Ported from the workbench's trace-reservations tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { TraceEvent, inferInitialQueue, parseTrace, replayFifo } from "../src/decomp/workbench/trace.js";
import { replace } from "../src/decomp/workbench/py.js";

const events = (lines) => parseTrace(lines.map((l) => "DKWB-FREELIST " + l).join("\n"));

test("an initial remove, absent remove and re-add are ordered", () => {
  const trace = events(["ADD proc=1 reg=14", "ADD proc=1 reg=15", "ADD proc=1 reg=13", "REMOVE proc=1 reg=2", "REMOVE proc=1 reg=13", "REMOVE proc=1 reg=13",
    "ADD proc=1 reg=13", "REMOVE proc=1 reg=15", "ALLOC_GP_RESULT proc=1 reg=14", "ALLOC_GP_RESULT proc=1 reg=13"]);
  assert.deepEqual(inferInitialQueue(trace), [14, 13]);
  const report = replayFifo(trace);
  assert.ok(report.valid, report.violations.join("; "));
  assert.deepEqual(report.initial_queue, [14, 13]);
  assert.deepEqual(report.allocations, [14, 13]);
});

test("a reserved unallocated member is retained in prefix evidence", () => {
  assert.deepEqual(replayFifo(events(["ADD proc=1 reg=14", "ADD proc=1 reg=13", "REMOVE proc=1 reg=13", "ALLOC_GP_RESULT proc=1 reg=14"])).initial_queue, [14]);
});

test("incomplete or duplicate initialization is not valid", () => {
  for (const control of ["ADD proc=1 reg=14", "REMOVE proc=1", "FREE proc=1"]) {
    assert.equal(replayFifo(events(["ADD proc=1 reg=14", control, "ALLOC_GP_RESULT proc=1 reg=14"])).valid, false, control);
  }
});

test("a runtime remove and explicit add are not dropped", () => {
  const report = replayFifo(events(["ADD proc=1 reg=14", "ADD proc=1 reg=15", "ALLOC_GP_RESULT proc=1 reg=14", "REMOVE proc=1 reg=15", "ADD proc=1 reg=15", "ALLOC_GP_RESULT proc=1 reg=15"]));
  assert.ok(report.valid, report.violations.join("; "));
  assert.ok(report.logical_events.map((e) => e.action).includes("remove"));
});

test("modern free requests do not manufacture appends", () => {
  for (const event of ["FREE", "FORCE_FREE"]) {
    const report = replayFifo(events(["ADD proc=1 reg=14", "ALLOC_GP_RESULT proc=1 reg=14", `${event} proc=1 reg=14`]));
    assert.equal(report.valid, false);
    assert.deepEqual(report.final_queue, []);
    assert.equal(report.unresolved_free_requests, 1);
    assert.ok(report.violations.join(" ").includes("requires transition evidence"));
  }
});

test("an unknown pre-allocation free is not complete initial state", () => {
  const report = replayFifo(events(["ADD proc=1 reg=14", "FREE proc=1 reg=13", "ALLOC_GP_RESULT proc=1 reg=14"]));
  assert.equal(report.valid, false);
  assert.equal(report.initialization_basis, "unresolved-prefix");
});

test("a wrong or mixed procedure is rejected", () => {
  const trace = events(["ADD proc=1 reg=14", "REMOVE proc=2 reg=14", "ALLOC_GP_RESULT proc=1 reg=14"]);
  assert.throws(() => replayFifo(trace));
  assert.throws(() => replayFifo(trace, { procedure: 3 }));
});

test("an unknown queue control is not silent", () => {
  const trace = events(["ADD proc=1 reg=14", "MOVE_END proc=1 reg=14", "ALLOC_GP_RESULT proc=1 reg=14"]);
  trace[1] = replace(trace[1], { action: "move-end" });
  assert.ok(trace[1] instanceof TraceEvent);
  assert.equal(replayFifo(trace).valid, false);
});

test("a known used-list request leaves the free FIFO unchanged", () => {
  for (const scope of ["proc=1", "proc=2", ""]) {
    const trace = parseTrace(`CODEX-UGEN-APPEND proc=1 reg=14\nCODEX-UGEN-ALLOC proc=1 reg=14\nDKWB-FREELIST MOVE_END ${scope} reg=14\nCODEX-UGEN-APPEND proc=1 reg=14\n`);
    const report = replayFifo(trace, { procedure: 1 });
    assert.ok(report.valid, `${scope}: ${report.violations.join("; ")}`);
    assert.deepEqual(report.initial_queue, [14]);
    assert.deepEqual(report.final_queue, [14]);
    assert.deepEqual(report.allocations, [14]);
    assert.equal(trace[2].action, "used-list-request");
    assert.throws(() => replayFifo(trace, { procedure: 2 }));
  }
});

test("an explicit procedure does not discard unscoped controls", () => {
  for (const control of ["REMOVE", "FREE", "FORCE_FREE"]) {
    assert.throws(() => replayFifo(events(["ADD proc=0 reg=14", `${control} reg=14`, "ALLOC_GP_RESULT proc=0 reg=14"]), { procedure: 0 }), undefined, control);
  }
});
