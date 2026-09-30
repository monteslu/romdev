// PRE provenance names the optimization decision before allocator effects.
// Ported from the workbench's PRE tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PROFILE_SCHEMA, comparePreTraces, instrumentPreSource, parsePreTrace, preReport } from "../src/decomp/workbench/pre.js";
import { runCommand } from "../src/decomp/workbench/cli.js";

const TRACE = "noise\n[DKWB-PRE-V1] proc=2 block=7 expression=e41 decision=hoist reason=fully_available line=80 candidate=header availability=all cost=3\n"
  + "[DKWB-PRE-V1] proc=2 block=9 expression=e52 decision=reject reason=unsafe_edge line=84 candidate=preheader availability=partial\n";
const sha = (s) => createHash("sha256").update(s).digest("hex");

test("the parser keeps named decisions and ignores noise", () => {
  const [events, ignored] = parsePreTrace(TRACE);
  assert.equal(events.length, 2);
  assert.deepEqual(ignored, ["noise"]);
  assert.equal(events[0].decision, "hoist");
  assert.equal(events[0].cost, 3);
  assert.deepEqual(preReport(events, { proc: 2 }).decisions, { hoist: 1, reject: 1 });
});

test("the diff aligns by procedure, block and expression", () => {
  const [target] = parsePreTrace(TRACE);
  const [candidate] = parsePreTrace(TRACE.replace("decision=hoist reason=fully_available", "decision=reject reason=cost"));
  const report = comparePreTraces(target, candidate);
  assert.equal(report.difference_count, 1);
  assert.deepEqual(report.differences[0].changed, ["decision", "reason"]);
});

test("duplicates, unknown decisions, stray tokens, unknown fields and negatives are refused", () => {
  assert.throws(() => parsePreTrace(TRACE + TRACE.split("\n")[1] + "\n"), /repeats proc\/block\/expression/);
  assert.throws(() => parsePreTrace(TRACE.replace("decision=hoist", "decision=maybe")), /unsupported decision/);
  assert.throws(() => parsePreTrace(TRACE.replace("proc=2", "proc=2 garbage")), /malformed token/);
  assert.throws(() => parsePreTrace(TRACE.replace("proc=2", "proc=2 surprise=yes")), /unsupported field/);
  assert.throws(() => parsePreTrace(TRACE.replace("block=7", "block=-1")), /negative field/);
});

test("a profile is hash-pinned and every required field is present", () => {
  const source = "static void optimize(void) {\n    choose();\n}\n";
  const record = 'fprintf(stderr, "[DKWB-PRE-V1] proc=%d block=%d expression=%s decision=%s reason=%s line=%d\\n", proc, block, expression, decision, reason, line);\n';
  const [instrumented, report] = instrumentPreSource(source, { schema: PROFILE_SCHEMA, name: "synthetic-pre", source_sha256: sha(source),
    injections: [{ anchor: "    choose();\n", position: "before", text: record }] });
  assert.ok(instrumented.includes("[DKWB-PRE-V1]"));
  assert.equal(report.injections, 1);
  assert.ok(report.calibration_required.includes("tracing-off section identity"));
});

test("a profile refuses changed source; required tokens must come from the injection", () => {
  assert.throws(() => instrumentPreSource("void f(void) {}\n", { schema: PROFILE_SCHEMA, source_sha256: "0".repeat(64), injections: [{}] }), /SHA-256/);
  const required = ["[DKWB-PRE-V1]", "proc=", "block=", "expression=", "decision=", "reason=", "line="].join(" ");
  const source = `/* ${required} */\nvoid f(void) {}\n`;
  assert.throws(() => instrumentPreSource(source, { schema: PROFILE_SCHEMA, name: "empty-record", source_sha256: sha(source),
    injections: [{ anchor: "void f", position: "before", text: "/* no trace */\n" }] }), /does not emit required token/);
});

test("trace pre reads, diffs and gates on a selection", async () => {
  const d = mkdtempSync(path.join(os.tmpdir(), "wb-pre-"));
  try {
    const a = path.join(d, "a.trace"), b = path.join(d, "b.trace");
    writeFileSync(a, TRACE);
    writeFileSync(b, TRACE.replace("decision=hoist reason=fully_available", "decision=reject reason=cost"));
    const r = await runCommand(["trace", "pre", a]);
    assert.equal(r.code, 0);
    assert.ok(r.stdout.startsWith("PRE: 2 decision(s)"));
    const diff = await runCommand(["trace-pre", a, "--against", b, "--json"]);
    assert.equal(JSON.parse(diff.stdout).difference_count, 1);
    const none = await runCommand(["trace-pre", a, "--proc", "9", "--json"]);
    assert.equal(none.code, 1);
    assert.equal(JSON.parse(none.stdout).schema, "decomp-workbench-pre-trace-v1");
  } finally { rmSync(d, { recursive: true, force: true }); }
});
