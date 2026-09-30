// Ported from the workbench's census tests: the `--census` predicate parser,
// its value matching, and the exit-code contract on the diagnose document.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CENSUS_FAILURE_EXIT, evaluateCensus, matches, parseCensus } from "../src/decomp/workbench/census.js";
import { COMPARISON_CENSUS_KEYS, SHIFT_CENSUS_KEYS, VIEW_CENSUS_KEYS } from "../src/decomp/workbench/schema.js";
import { parseArgs } from "../src/decomp/workbench/argparse.js";
import { COMMAND_SPECS as DIAGNOSE_SPECS } from "../src/decomp/workbench/diagnose-cli.js";
const DIAGNOSE_SPEC = DIAGNOSE_SPECS.find((s) => s.path[0] === "diagnose");
import { diagnoseDumpsCommand } from "../src/decomp/workbench/diagnose-cli.js";

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "workbench");
const TARGET = path.join(FIX, "target.objdump.txt");
const REGISTER_MISMATCH = path.join(FIX, "register-mismatch.objdump.txt");
const RELOCATED_MATCH = path.join(FIX, "relocated-match.objdump.txt");

test("entries are comma separated and the option is repeatable", () => {
  assert.deepEqual(parseCensus(["words=0,frame=-32"], { allowed: COMPARISON_CENSUS_KEYS }).map((p) => [p.key, p.expected]), [["words", "0"], ["frame", "-32"]]);
  assert.deepEqual(parseCensus(["words=0", "frame=-32"], { allowed: COMPARISON_CENSUS_KEYS }).map((p) => p.key), ["words", "frame"]);
});

test("a comma inside a value is not a separator", () => {
  const p = parseCensus(["verdict=mixed(constant:1, register:2)"], { allowed: VIEW_CENSUS_KEYS });
  assert.equal(p.length, 1);
  assert.equal(p[0].expected, "mixed(constant:1, register:2)");
});

test("a deprecated spelling still answers", () => {
  const p = parseCensus(["candidate_frame_size=-128"], { allowed: COMPARISON_CENSUS_KEYS })[0];
  assert.equal(p.key, "candidate_frame_size");
  assert.equal(p.metric, "frame");
});

test("malformed and unknown entries are refused", () => {
  assert.throws(() => parseCensus(["words"], { allowed: COMPARISON_CENSUS_KEYS }), /not KEY=VALUE/);
  assert.throws(() => parseCensus(["=0"], { allowed: COMPARISON_CENSUS_KEYS }), /not KEY=VALUE/);
  assert.throws(() => parseCensus(["wrds=0"], { allowed: COMPARISON_CENSUS_KEYS }), /unknown census key/);
  assert.throws(() => parseCensus(["aligned_rows=8"], { allowed: COMPARISON_CENSUS_KEYS }), /unknown census key/);
});

test("an unknown key near a registered one offers it; a unique prefix too", () => {
  assert.throws(() => parseCensus(["pins_shadowingg=0"], { allowed: SHIFT_CENSUS_KEYS }), /unknown census key 'pins_shadowingg'.*did you mean 'pins_shadowing'\?$/);
  assert.throws(() => parseCensus(["pins_sha=0"], { allowed: SHIFT_CENSUS_KEYS }), /did you mean 'pins_shadowing'\?$/);
});

test("an unrelated or ambiguous typo offers nothing", () => {
  assert.throws(() => parseCensus(["totally_unrelated_garbage=0"], { allowed: SHIFT_CENSUS_KEYS }), (e) => /unknown census key/.test(e.message) && !e.message.includes("did you mean"));
  assert.throws(() => parseCensus(["wordz=0"], { allowed: { words: "words", wordy: "wordy" } }), (e) => /unknown census key/.test(e.message) && !e.message.includes("did you mean"));
});

test("values compare by the reported type", () => {
  assert.ok(matches(-128, "-128"));
  assert.ok(matches(-128, "-0x80"));
  assert.ok(matches(true, "true"));
  assert.ok(!matches(true, "false"));
  assert.ok(matches(false, "0"));
  assert.ok(matches(null, "none"));
  assert.ok(matches("allocation-mismatch", "allocation-mismatch"));
  assert.ok(!matches("allocation", "allocation-mismatch"));
  assert.throws(() => matches(4, "four"), /not an integer/);
  assert.throws(() => matches(true, "maybe"), /not true or false/);
});

test("a list key and a key the report did not carry are refused", () => {
  const lists = parseCensus(["diff_sites=1"], { allowed: COMPARISON_CENSUS_KEYS });
  assert.throws(() => evaluateCensus(lists, { diff_sites: [{ index: 0 }] }), /not a single value/);
  const p = parseCensus(["symbol=none"], { allowed: COMPARISON_CENSUS_KEYS });
  assert.ok(evaluateCensus(p, { symbol: null })[0].passed);
  assert.throws(() => evaluateCensus(p, { words: 0 }), /not in this report/);
});

// The command half, on the diagnose document (the command romdev drives).
async function run(argv) {
  const spec = DIAGNOSE_SPEC;
  const args = parseArgs(spec, [...argv, "--json"]);
  const out = [], err = [];
  const io = { print: (s = "") => out.push(`${s}\n`), eprint: (s = "") => err.push(`${s}\n`) };
  const status = await diagnoseDumpsCommand(args, io, { cwd: FIX, env: process.env, resolve: (p) => path.resolve(FIX, p) });
  return [status, out.join(""), err.join("")];
}

test("every predicate holding is exit zero; a failing one is exit three", async () => {
  let [status, stdout] = await run([TARGET, REGISTER_MISMATCH, "--census", "aligned_register=1,frame=-32,exact=false"]);
  assert.equal(status, 0);
  assert.ok(JSON.parse(stdout).comparison.census.every((c) => c.pass));
  [status, stdout] = await run([TARGET, REGISTER_MISMATCH, "--census", "aligned_register=0"]);
  assert.equal(status, CENSUS_FAILURE_EXIT);
  assert.deepEqual(JSON.parse(stdout).comparison.census, [{ key: "aligned_register", expected: "0", actual: 1, pass: false }]);
});

test("census failure is distinct from a mismatch", async () => {
  assert.equal((await run([TARGET, REGISTER_MISMATCH, "--fail-on-mismatch"]))[0], 1);
  assert.equal((await run([TARGET, REGISTER_MISMATCH, "--fail-on-mismatch", "--census", "aligned_register=1"]))[0], 1);
  assert.equal((await run([TARGET, REGISTER_MISMATCH, "--fail-on-mismatch", "--census", "aligned_register=0"]))[0], 3);
});

test("an exact candidate can be filtered too, and no predicate means no key", async () => {
  const [status] = await run([TARGET, RELOCATED_MATCH, "--census", "exact=true,words=0"]);
  assert.equal(status, 0);
  const [, stdout] = await run([TARGET, REGISTER_MISMATCH]);
  assert.ok(!("census" in JSON.parse(stdout).comparison));
});

test("an unusable predicate is a usage error, before the inputs are read", async () => {
  for (const [expression, message] of [["bogus=1", "unknown census key"], ["words", "not KEY=VALUE"], ["diff_sites=1", "not a single value"],
    ["words=many", "not an integer"], ["exact=maybe", "not true or false"]]) {
    const [status, , stderr] = await run([TARGET, REGISTER_MISMATCH, "--census", expression]);
    assert.equal(status, 2, expression);
    assert.ok(stderr.includes(message), stderr);
  }
  const [status, , stderr] = await run(["missing.objdump", "gone.objdump", "--census", "bogus=1"]);
  assert.equal(status, 2);
  assert.ok(stderr.includes("unknown census key"));
});
