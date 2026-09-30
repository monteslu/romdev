// The compact IDO 7.1 `[A71]` final-colour trace: strict record
// validation, priority-bit decoding, the run-local phase/web diff, and the
// trace-a71 command. The workbench ships no dedicated A71 tests; these are
// written against its parser's documented contract (synthetic records).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { A71_COLOR_REGISTERS, compareA71Traces, parseA71Trace, priorityFromBits } from "../src/decomp/workbench/a71.js";
import { runCommand } from "../src/decomp/workbench/cli.js";

const rec = (phase, web, { sym = 5, cls = 1, color = 3, bits = "0x3fc00000", f0 = "0x00000000", f1 = "0x0", extra = "" } = {}) =>
  `[A71] phase=${phase} web=${web} sym=${sym} class=${cls} color=${color} savebits=${bits} forbidden0=${f0} forbidden1=${f1}${extra}`;
const BASE = ["cc1: note: unrelated diagnostic", rec(1, 10), rec(1, 11, { cls: 2, color: 25, bits: "40000000", f0: "0x03000000" }), rec(2, 10, { color: 4, extra: " refs=7 defs=2" })].join("\n") + "\n";

test("records parse with decoded priority, registers and forbidden colours", () => {
  const trace = parseA71Trace(BASE);
  assert.equal(trace.records.length, 3);
  assert.equal(trace.ignored_diagnostic_lines, 1);
  assert.deepEqual(trace.unverified_fields_seen, ["defs", "refs"]);
  const [a, b] = trace.records;
  assert.equal(a.priority, 1.5);
  assert.equal(a.register, "a0");
  assert.equal(b.priority, 2.0);
  assert.equal(b.register, "$f2");
  assert.deepEqual(b.forbidden_colors, [6, 7]);
  assert.equal(b.asDict().priority_bits, "0x40000000");
  assert.equal(b.asDict().trace_line, 3);
  assert.ok(Number.isNaN(priorityFromBits(0x7fc00000)));
  assert.equal(parseA71Trace(rec(1, 1, { bits: "7fc00000" })).records[0].asDict().priority, "nan");
  assert.equal(A71_COLOR_REGISTERS.get(29), "$f18");
});

test("the summary counts phases and classes; selection filters", () => {
  const trace = parseA71Trace(BASE);
  const s = trace.summary();
  assert.deepEqual([...s.phase_counts.entries()], [[1, 2], [2, 1]]);
  assert.deepEqual([...s.class_counts.entries()], [[1, 2], [2, 1]]);
  assert.equal(trace.selected({ phase: 1, register_class: 2 }).length, 1);
});

test("a line claiming the prefix is validated strictly", () => {
  assert.throws(() => parseA71Trace("[A71] phase=1 web=2\n"), /line 1: malformed A71 record; missing class, color, forbidden0, forbidden1, savebits, sym/);
  assert.throws(() => parseA71Trace(rec(1, 1, { sym: "x" })), /A71 field sym is not decimal: 'x'/);
  assert.throws(() => parseA71Trace(rec(1, 1, { bits: "0x1234567890" })), /not a 32-bit hex word/);
  assert.throws(() => parseA71Trace(rec(1, 1) + "\n" + rec(1, 1)), /line 2: duplicate A71 phase\/web key \(1, 1\)/);
  assert.throws(() => parseA71Trace("nothing\n"), /trace contains no \[A71\] records/);
});

test("the diff aligns run-local phase/web keys and names changed fields", () => {
  const baseline = parseA71Trace(BASE);
  const candidate = parseA71Trace([rec(1, 10, { color: 5 }), rec(1, 11, { cls: 2, color: 25, bits: "40000000", f0: "0x03000000" }), rec(2, 12)].join("\n"));
  const report = compareA71Traces(baseline, candidate);
  assert.equal(report.difference_count, 3);
  assert.deepEqual(report.changes.map((c) => [c.status, c.phase, c.web]), [["changed", 1, 10], ["removed", 2, 10], ["added", 2, 12]]);
  assert.deepEqual(report.changes[0].changed_fields, ["color"]);
  assert.equal(report.alignment_scope, "run-local-phase-web");
  assert.equal(compareA71Traces(baseline, candidate, { phase: 1, web: 11 }).difference_count, 0);
});

test("trace-a71 prints records, diffs, and JSON; exits 1 on an empty selection", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "romdev-wb-a71-"));
  try {
    const a = path.join(dir, "a.a71"), b = path.join(dir, "b.a71");
    fs.writeFileSync(a, BASE);
    fs.writeFileSync(b, [rec(1, 10, { bits: "3fe00000" }), rec(1, 11, { cls: 2, color: 25, bits: "40000000", f0: "0x03000000" })].join("\n"));
    const one = await runCommand(["trace-a71", a]);
    assert.equal(one.code, 0);
    assert.ok(one.stdout.includes("A71: 3 final-color record(s); phases={1: 2, 2: 1} classes={1: 2, 2: 1}"));
    assert.ok(one.stdout.includes("  p1 w11 sym=5 class=2 priority=2 [40000000] color=c25 ($f2) forbidden=c6,c7"));
    const diff = await runCommand(["trace", "a71", a, "--against", b]);
    assert.equal(diff.code, 0);
    assert.ok(diff.stdout.includes("A71 diff: baseline=3 candidate=2 changed_phase_webs=2"));
    assert.ok(diff.stdout.includes("~ p1 w10 priority:1.5->1.75"));
    assert.ok(diff.stdout.includes("- p2 w10 sym=5"));
    const empty = await runCommand(["trace-a71", a, "--web", "99", "--json"]);
    assert.equal(empty.code, 1);
    assert.equal(JSON.parse(empty.stdout).schema, "decomp-workbench-trace-a71-v1");
    const bad = await runCommand(["trace-a71", a, "--phase", "3"]);
    assert.equal(bad.code, 2);
    assert.ok(bad.stderr.includes("invalid choice: 3"));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
