// Ported from the workbench's staleness tests: a comparison against a stale
// build reads as a match, so it is refused. Every artifact is a file in a
// temporary directory whose modification time is set explicitly.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_TOLERANCE_SECONDS, STALENESS_SCHEMA, StaleBuildError, chainReport, enforceFreshness, fileSha256, stalenessReport } from "../src/decomp/workbench/staleness.js";
import { parseArgs } from "../src/decomp/workbench/argparse.js";
import { COMMAND_SPECS as DIAGNOSE_SPECS } from "../src/decomp/workbench/diagnose-cli.js";
const DIAGNOSE_SPEC = DIAGNOSE_SPECS.find((s) => s.path[0] === "diagnose");
import { diagnoseDumpsCommand } from "../src/decomp/workbench/diagnose-cli.js";

const DUMP = "\n00000000 <animStep>:\n   0: 03e00008  jr $ra\n   4: 00000000  nop\n";
const BASE = 1_700_000_000.0;

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), "romdev-staleness-")); }
function write(file, text, age) { fs.writeFileSync(file, text); fs.utimesSync(file, BASE + age, BASE + age); return file; }

test("a build newer than its source is fresh", () => {
  const d = tmp();
  const r = stalenessReport([write(path.join(d, "track.c"), "int a;\n", 0), write(path.join(d, "game.z64"), "rom", 60)]);
  assert.equal(r.status, "fresh"); assert.ok(r.fresh); assert.ok(!r.stale); assert.deepEqual(r.violations, []);
});

test("a rom older than the edited source is stale", () => {
  const d = tmp();
  const rom = write(path.join(d, "game.z64"), "rom", 0), src = write(path.join(d, "track.c"), "int a;\n", 600);
  const r = stalenessReport([src, rom]);
  assert.equal(r.status, "stale"); assert.ok(r.stale); assert.ok(!r.fresh);
  assert.equal(r.violations.length, 1);
  assert.equal(r.violations[0].input.label, "input");
  assert.equal(r.violations[0].derived.label, "built");
  assert.ok(r.violations[0].message.includes("BEFORE"));
  assert.ok(r.violations[0].message.includes("10m"));
});

test("every earlier path is an input to every later one", () => {
  const d = tmp();
  const r = stalenessReport([write(path.join(d, "track.c"), "int a;\n", 900), write(path.join(d, "track.o"), "obj", 0),
    write(path.join(d, "game.elf"), "elf", 10), write(path.join(d, "game.z64"), "rom", 20)]);
  assert.equal(r.status, "stale");
  assert.deepEqual(new Set(r.violations.map((v) => v.derived.label)), new Set(["input2", "input3", "built"]));
});

test("one timestamp tick is not staleness", () => {
  const d = tmp();
  const src = write(path.join(d, "track.c"), "int a;\n", 1), obj = write(path.join(d, "track.o"), "obj", 0);
  assert.ok(!stalenessReport([src, obj]).stale);
  assert.ok(stalenessReport([src, obj], { tolerance_seconds: 0.0 }).stale);
  assert.equal(DEFAULT_TOLERANCE_SECONDS, 1.0);
});

test("a missing artifact is unproven, and one artifact alone proves nothing", () => {
  const d = tmp();
  const src = write(path.join(d, "track.c"), "int a;\n", 0);
  const r = stalenessReport([src, path.join(d, "never-built.z64")]);
  assert.equal(r.status, "missing"); assert.ok(!r.fresh); assert.ok(!r.stale);
  assert.equal(r.artifacts[1].built_at, "(missing)");
  assert.ok(r.message.includes("does not exist"));
  const alone = stalenessReport([src]);
  assert.equal(alone.status, "unknown"); assert.ok(!alone.fresh);
});

test("hashes are recorded only when asked", () => {
  const d = tmp();
  const src = write(path.join(d, "track.c"), "int a;\n", 0), rom = write(path.join(d, "game.z64"), "rom", 10);
  assert.equal(stalenessReport([src, rom]).artifacts[0].sha256, null);
  const hashed = stalenessReport([src, rom], { hashes: true });
  assert.equal(hashed.artifacts[0].sha256, fileSha256(src));
  assert.match(hashed.artifacts[0].sha256, /^[0-9a-f]{64}$/);
  assert.notEqual(hashed.artifacts[0].sha256, hashed.artifacts[1].sha256);
});

test("labels must correspond; provenance states every artifact and when it was built", () => {
  const d = tmp();
  const src = write(path.join(d, "track.c"), "int a;\n", 0), rom = write(path.join(d, "game.z64"), "rom", 10);
  assert.throws(() => stalenessReport([src], { labels: ["source", "rom"] }), /correspond/);
  const lines = stalenessReport([src, rom]).provenanceLines();
  assert.equal(lines.length, 2);
  assert.ok(lines[0].includes("track.c"));
  assert.ok(lines[0].includes("built 20"));
});

test("derived siblings are never stale against each other; declared inputs are a set", () => {
  const d = tmp();
  const src = write(path.join(d, "track.c"), "int a;\n", 0);
  const r = chainReport([write(path.join(d, "target.o"), "t", 10), write(path.join(d, "candidate.o"), "c", 900)], [src], { labels: ["source", "target", "candidate"] });
  assert.ok(!r.stale); assert.equal(r.artifacts[0].label, "source");
  const none = chainReport([path.join(d, "target.o"), path.join(d, "candidate.o")], [], { labels: ["target", "candidate"] });
  assert.equal(none.status, "unknown"); assert.ok(!none.fresh); assert.ok(none.message.includes("--built-from"));
  const e = tmp();
  const set = chainReport([write(path.join(e, "track.o"), "o", 1000)], [write(path.join(e, "track.c"), "int a;\n", 900), write(path.join(e, "track.h"), "int b;\n", 0)],
    { labels: ["source1", "source2", "built"] });
  assert.ok(!set.stale); assert.equal(set.status, "fresh");
});

test("enforce refuses by default and warns under allow-stale", () => {
  const d = tmp();
  const rom = write(path.join(d, "game.z64"), "rom", 0), src = write(path.join(d, "track.c"), "int a;\n", 600);
  const r = stalenessReport([src, rom]);
  assert.throws(() => enforceFreshness(r, { allow_stale: false }), StaleBuildError);
  const warnings = enforceFreshness(r, { allow_stale: true });
  assert.ok(warnings.every((w) => w.startsWith("warning:")));
  assert.ok(warnings.some((w) => w.includes("--allow-stale")));
});

// The guard where it matters: on the diagnose document.
async function diagnose(d, extra) {
  const spec = DIAGNOSE_SPEC;
  const args = parseArgs(spec, [path.join(d, "target.objdump"), path.join(d, "candidate.objdump"), ...extra]);
  const out = [], err = [];
  const io = { print: (s = "") => out.push(`${s}\n`), eprint: (s = "") => err.push(`${s}\n`) };
  const status = await diagnoseDumpsCommand(args, io, { cwd: d, env: process.env, resolve: (p) => path.resolve(d, p) });
  return [status, out.join(""), err.join("")];
}
function dumps() { const d = tmp(); write(path.join(d, "target.objdump"), DUMP, 0); write(path.join(d, "candidate.objdump"), DUMP, 0); return d; }

test("a comparison older than the source is refused, and allow-stale runs it anyway", async () => {
  const d = dumps();
  const src = write(path.join(d, "track.c"), "int a;\n", 600);
  let [status, stdout, stderr] = await diagnose(d, ["--built-from", src, "--json"]);
  assert.equal(status, 2); assert.equal(stdout, "");
  assert.ok(stderr.includes("error: ") && stderr.includes("BEFORE") && stderr.includes("--allow-stale"));
  [status, stdout] = await diagnose(d, ["--built-from", src, "--allow-stale", "--json"]);
  assert.equal(status, 0);
  assert.equal(JSON.parse(stdout).staleness.status, "stale");
});

test("json carries the freshness block without renaming its host", async () => {
  const d = dumps();
  const src = write(path.join(d, "track.c"), "int a;\n", -600);
  const [status, stdout] = await diagnose(d, ["--built-from", src, "--json"]);
  const payload = JSON.parse(stdout);
  assert.equal(status, 0);
  assert.equal(payload.schema, "decomp-workbench-diagnosis-v3");
  assert.equal(payload.staleness_schema, STALENESS_SCHEMA);
  assert.equal(payload.staleness.status, "fresh");
  assert.ok(!("schema" in payload.staleness));
  assert.deepEqual(payload.staleness.artifacts.map((a) => a.label), ["source", "target", "candidate"]);
  assert.equal(payload.staleness.artifacts[1].built_at, "2023-11-14T22:13:20Z");
});
