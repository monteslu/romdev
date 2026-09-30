// Scheduler trace records, the native `as1 -R` reader and the in-process
// `trace scheduler` command. Ported from the workbench's own scheduler and
// as1-reorganize tests; the fixture is synthetic (written from the format
// strings in as1's rodata), not ROM-derived.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { PROFILE_SCHEMA, compareSchedulerTraces, instrumentSchedulerSource, parseSchedulerTrace, schedulerReport } from "../src/decomp/workbench/scheduler.js";
import { mipsMnemonic, parseAs1ReorganizeTrace, toDkwbRecords } from "../src/decomp/workbench/as1-reorganize.js";
import { runCommand, commandMapPayload, commandAcceptsFlag } from "../src/decomp/workbench/cli.js";
import { splitlines } from "../src/decomp/workbench/py.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/workbench/as1-reorganize.trace", import.meta.url));
const sha = (s) => createHash("sha256").update(s).digest("hex");
const TRACE = "[DKWB-SCHED-V1] proc=7 block=3 cycle=4 word=0x2402002d opcode=addiu line=0x30f ready=2 chosen=n18 tie=source-line\n"
  + "[DKWB-SCHED-V1] proc=7 block=3 cycle=5 word=0x2403000a opcode=addiu line=0x311 ready=1 chosen=n19 tie=only-ready\n";
const parse = () => parseAs1ReorganizeTrace(readFileSync(FIXTURE, "utf8"));
const tmp = () => mkdtempSync(path.join(os.tmpdir(), "romdev-wb-sched-"));

test("named trace reports the decisive ready-set tie", () => {
  const [events, ignored] = parseSchedulerTrace(TRACE);
  const report = schedulerReport(events, { proc: 7, block: 3 });
  assert.deepEqual(ignored, []);
  assert.equal(report.event_count, 2);
  assert.equal(report.ready_set_ties, 1);
  assert.equal(report.events[0].word, "0x2402002d");
  assert.equal(report.events[0].tie, "source-line");
});

test("diff aligns by procedure, block and cycle", () => {
  const [target] = parseSchedulerTrace(TRACE);
  const [candidate] = parseSchedulerTrace(TRACE.replace("chosen=n18", "chosen=n19").replace("tie=source-line", "tie=scan-order"));
  const report = compareSchedulerTraces(target, candidate);
  assert.equal(report.difference_count, 1);
  assert.deepEqual(report.differences[0].changed, ["chosen", "tie"]);
});

test("parser refuses missing or duplicate decisions", () => {
  assert.throws(() => parseSchedulerTrace("[DKWB-SCHED-V1] proc=1 block=1 cycle=1 word=0 opcode=nop"), /missing field/);
  assert.throws(() => parseSchedulerTrace(TRACE + TRACE), /repeats/);
  assert.throws(() => parseSchedulerTrace(TRACE.replace("proc=7", "proc=7 proc=8")), /repeats field.*proc/);
  assert.throws(() => parseSchedulerTrace(TRACE.replace("proc=7", "proc=7 garbage")), /malformed token/);
  assert.throws(() => parseSchedulerTrace(TRACE.replace("proc=7", "proc=7 surprise=yes")), /unsupported field/);
});

test("optional emit and source provenance is preserved", () => {
  const enriched = TRACE.replace("tie=source-line", "tie=source-line slot=18 file=draw.c statement=44 reason=latency ready_ids=n18,n9");
  const [events] = parseSchedulerTrace(enriched);
  const report = schedulerReport(events);
  assert.equal(report.provenance_complete, 1);
  assert.equal(report.events[0].emitted_slot, 18);
  assert.equal(report.events[0].source_file, "draw.c");
  assert.deepEqual(report.events[0].ready_ids, ["n18", "n9"]);
});

test("complete ready set is validated", () => {
  assert.throws(() => parseSchedulerTrace(TRACE.replace("tie=source-line", "tie=x ready_ids=n18")), /exactly 2 unique/);
  assert.throws(() => parseSchedulerTrace(TRACE.replace("tie=source-line", "tie=x ready_ids=n7,n9")), /chosen node is absent/);
});

test("external profile is hash and anchor guarded", () => {
  const source = "void choose(void) {\n    CHOOSE();\n}\n";
  const trace = '    LOG("[DKWB-SCHED-V1] proc=%d block=%d cycle=%d word=%x opcode=%s line=%d ready=%d chosen=%s tie=%s", proc, block, cycle, word, opcode, line, ready, chosen, tie);\n';
  const profile = { schema: PROFILE_SCHEMA, name: "synthetic-positive-control", source_sha256: sha(source),
    injections: [{ anchor: "    CHOOSE();\n", position: "after", text: trace }] };
  const [instrumented, report] = instrumentSchedulerSource(source, profile);
  assert.ok(instrumented.includes("[DKWB-SCHED-V1]"));
  assert.equal(report.injections, 1);
  assert.equal(report.calibration_required.length, 5);
  assert.throws(() => instrumentSchedulerSource(source + " ", profile), /SHA-256/);
});

test("provenance profile requires emit, source, reason and ready set", () => {
  const source = "void choose(void) {\n  pick();\n}\n";
  const profile = { schema: PROFILE_SCHEMA, name: "incomplete", source_sha256: sha(source), provenance_required: true,
    injections: [{ anchor: "  pick();\n", position: "before", text: 'emit("[DKWB-SCHED-V1] proc= block= cycle= word= opcode= line= ready= chosen= tie=");\n' }] };
  assert.throws(() => instrumentSchedulerSource(source, profile), /slot=/);
});

test("required tokens must come from the injection", () => {
  const required = ["[DKWB-SCHED-V1]", ...["proc", "block", "cycle", "word", "opcode", "line", "ready", "chosen", "tie"].map((n) => `${n}=`)].join(" ");
  const source = `/* ${required} */\nvoid choose(void) {}\n`;
  const profile = { schema: PROFILE_SCHEMA, name: "empty-record", source_sha256: sha(source),
    injections: [{ anchor: "void choose", position: "before", text: "/* no trace */\n" }] };
  assert.throws(() => instrumentSchedulerSource(source, profile), /does not emit required token/);
});

// as1 -R reader

const decided = (events) => new Map(events.map((e) => [`${e.block},${e.cycle}`, e.tie]));

test("the line-number key is named where it decides", () => {
  const [, events] = parse();
  assert.equal(decided(events).get("429,1"), "lineno");
  assert.equal(decided(events).get("131,0"), "lineno");
});

test("an earlier key wins before the line number is read", () => {
  const [, events] = parse();
  assert.equal(decided(events).get("131,1"), "start-time");
});

test("a single candidate is not a tie", () => {
  const [, events] = parse();
  assert.deepEqual(events.filter((e) => e.tie === "sole-candidate").map((e) => e.ready), [1, 1, 1]);
});

const twoNode = (a, b, pick = 0, lines = [40, 41]) => "BASIC BLOCK: 33\n"
  + `Node   0: inst 00000021, relocation 0, lineno ${lines[0]}\n`
  + `Node   1: inst 00000021, relocation 0, lineno ${lines[1]}\n`
  + "Initial nodes: 0 1\n"
  + `  node 0 (INST 1), ${a}\n  node 1 (INST 2), ${b}\n`
  + `Picking node ${pick} (INST ${pick + 1}), at 0, best_addr = 0\n`;

test("besttime outranks aftercycles", () => {
  const [, events] = parseAs1ReorganizeTrace(twoNode("time = 0, aftercycles = 0, latency = 0, besttime = 4", "time = 0, aftercycles = 1, latency = 0, besttime = 2"));
  assert.deepEqual(events.map((e) => e.tie), ["besttime"]);
});

test("besttime does not outrank readiness", () => {
  const [, events] = parseAs1ReorganizeTrace(twoNode("time = 0, aftercycles = 0, latency = 0, besttime = 1", "time = 3, aftercycles = 0, latency = 0, besttime = 9"));
  assert.deepEqual(events.map((e) => e.tie), ["start-time"]);
});

test("the shipped trace is unchanged by the new key", () => {
  const [, events] = parse();
  assert.deepEqual(events.map((e) => e.tie), ["start-time", "lineno", "sole-candidate", "sole-candidate", "lineno", "start-time", "lineno", "sole-candidate"]);
});

test("a full tie falls through to list order", () => {
  const [, events] = parseAs1ReorganizeTrace(twoNode("time = 0, aftercycles = 0, latency = 0, besttime = 0", "time = 0, aftercycles = 0, latency = 0, besttime = 0", 0, [40, 40]));
  assert.deepEqual(events.map((e) => e.tie), ["list-order"]);
});

test("a pick the chain does not explain says so", () => {
  const [, events] = parseAs1ReorganizeTrace(twoNode("time = 0, aftercycles = 0, latency = 0, besttime = 0", "time = 0, aftercycles = 0, latency = 0, besttime = 0", 1, [40, 50]));
  assert.deepEqual(events.map((e) => e.tie), ["lineno-disagrees"]);
});

test("blocks are the assembler's own ids", () => {
  const [, events] = parse();
  assert.deepEqual([...new Set(events.map((e) => e.block))].sort((a, b) => a - b), [131, 429]);
});

test("without block headers blocks are numbered by appearance", () => {
  const text = splitlines(readFileSync(FIXTURE, "utf8")).filter((l) => !l.startsWith("BASIC BLOCK:")).join("\n");
  const [, events] = parseAs1ReorganizeTrace(text);
  assert.deepEqual([...new Set(events.map((e) => e.block))].sort((a, b) => a - b), [0, 1]);
});

test("a re-entered block does not reuse a cycle key", () => {
  const text = readFileSync(FIXTURE, "utf8");
  const [, events] = parseAs1ReorganizeTrace(text + text);
  const keys = events.map((e) => `${e.proc},${e.block},${e.cycle}`);
  assert.equal(keys.length, new Set(keys).size);
});

test("the word and line come from the node dump", () => {
  const [, events] = parse();
  assert.equal(events[0].word, 0x8FA20090);
  assert.equal(events[0].opcode, "lw");
  assert.equal(events[0].line, 16404);
});

test("candidates are kept with the selection", () => {
  const [selections] = parse();
  assert.equal(selections[0].candidates.length, 3);
  assert.equal(selections[0].winner.node, 0);
});

test("unrelated assembler chatter is retained, not dropped", () => {
  const [, , ignored] = parse();
  assert.ok(ignored.some((l) => l.includes("before reorganization")));
});

test("a pick without its candidate list is not invented", () => {
  const [selections, events, ignored] = parseAs1ReorganizeTrace("Picking node 4 (INST 9), at 0, best_addr = 0\n");
  assert.deepEqual(selections, []);
  assert.deepEqual(events, []);
  assert.equal(ignored.length, 1);
});

test("known words decode; unknown words are labelled, not guessed", () => {
  assert.equal(mipsMnemonic(0x2418000A), "addiu");
  assert.equal(mipsMnemonic(0x0002CC00), "sll");
  assert.equal(mipsMnemonic(0x3C020000), "lui");
  assert.equal(mipsMnemonic(0x0324C823), "subu");
  assert.equal(mipsMnemonic(0), "nop");
  assert.ok(mipsMnemonic(0x4C000000).startsWith("op."));
});

test("emitted records parse as the shipped schema", () => {
  const [, events] = parse();
  const [reparsed, ignored] = parseSchedulerTrace(toDkwbRecords(events));
  assert.deepEqual(ignored, []);
  assert.deepEqual(reparsed.map((e) => e.asDict()), events.map((e) => e.asDict()));
});

// the in-process command

test("--from-as1-r reads the native trace", async () => {
  const r = await runCommand(["trace-scheduler", FIXTURE, "--from-as1-r"]);
  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes("block=429"));
  assert.ok(r.stdout.includes("tie=lineno"));
});

test("the proof states both gaps; grouped spelling and schema envelope", async () => {
  const r = await runCommand(["trace", "scheduler", FIXTURE, "--from-as1-r", "--json"]);
  assert.equal(r.code, 0);
  const doc = JSON.parse(r.stdout);
  assert.equal(doc.schema, "decomp-workbench-scheduler-trace-v1");
  assert.ok(doc.proof.includes("byte-identical"));
  assert.ok(doc.proof.includes("node->addr"));
  assert.ok(r.stdout.endsWith("}\n"));
});

test("--emit writes records the other commands read", async () => {
  const dir = tmp();
  try {
    const out = path.join(dir, "sched.dkwb");
    const r = await runCommand(["trace-scheduler", FIXTURE, "--from-as1-r", "--emit", out]);
    assert.equal(r.code, 0);
    const [events] = parseSchedulerTrace(readFileSync(out, "utf8"));
    assert.equal(events.length, 8);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("two native traces diff against each other", async () => {
  const r = await runCommand(["trace-scheduler", FIXTURE, "--against", FIXTURE, "--from-as1-r"]);
  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes("0 decision(s) differ"));
});

test("a capture without selections names the redirect mistake", async () => {
  const dir = tmp();
  try {
    const empty = path.join(dir, "stdout-only.log");
    writeFileSync(empty, "as1: nothing here\n");
    const r = await runCommand(["trace-scheduler", empty, "--from-as1-r"]);
    assert.equal(r.code, 2);
    assert.ok(r.stderr.includes(">sched.log 2>&1"));
    assert.ok(r.stderr.includes("writes it to stdout"));
    const j = await runCommand(["trace-scheduler", empty, "--from-as1-r", "--json"]);
    assert.equal(j.code, 2);
    assert.equal(JSON.parse(j.stdout).schema, "decomp-workbench-error-v1");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("usage errors are exit 2 documents, filters narrow to a gate result", async () => {
  const missing = await runCommand(["trace-scheduler", "--json"]);
  assert.equal(missing.code, 2);
  assert.match(JSON.parse(missing.stdout).error.message, /required: trace/);
  const bad = await runCommand(["trace-scheduler", FIXTURE, "--limit", "x", "--json"]);
  assert.equal(bad.code, 2);
  assert.match(JSON.parse(bad.stdout).error.message, /invalid int value: 'x'/);
  const none = await runCommand(["trace-scheduler", FIXTURE, "--from-as1-r", "--block", "9999", "--json"]);
  assert.equal(none.code, 1);
  assert.equal(JSON.parse(none.stdout).event_count, 0);
});

test("the catalog is the whole journey map; flags come from each command grammar", async () => {
  const map = commandMapPayload();
  assert.equal(map.schema, "decomp-workbench-command-map-v1");
  assert.equal(Object.values(map.groups).flat().length, 128);
  assert.equal(await commandAcceptsFlag(["object", "diagnose"], "--objdump"), true);
  assert.equal(await commandAcceptsFlag(["trace", "scheduler"], "--objdump"), false);
});
