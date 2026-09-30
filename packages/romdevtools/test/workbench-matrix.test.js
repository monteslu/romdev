// Ported from the workbench's matrix tests: spec loading, attractor
// clustering and real variant subprocesses (the variant helpers are node
// scripts; objects are raw words rendered by a stand-in objdump).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { clusterAttractors, loadMatrixSpec, runMatrix, VariantResult, ALL_COLLAPSED_CAUTION } from "../src/decomp/workbench/matrix.js";
import { ScoreError, ScoreReport, WordScore } from "../src/decomp/workbench/score.js";
import { runCli } from "./fixtures/workbench/cli-run.js";
import { shellQuote } from "../src/decomp/workbench/whats-next.js";

const TARGET = "0102030405060708090a0b0c0d0e0f10";
const DIFFERENT = "ffffffff05060708090a0b0c0d0e0f10";
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "romdev-wb-matrix-"));

/** An objdump stand-in that renders a raw word file as one function `fn`. */
function rawObjdump(root) {
  const exe = path.join(root, "objdump");
  fs.writeFileSync(exe, `#!${process.execPath}
const fs = require("fs");
const file = process.argv.slice(2).filter((a) => !a.startsWith("-")).pop();
const data = fs.readFileSync(file);
const lines = ["", "00000000 <fn>:"];
for (let i = 0; i + 4 <= data.length; i += 4) lines.push("   " + i.toString(16) + ": " + data.subarray(i, i + 4).toString("hex") + "  nop");
process.stdout.write(lines.join("\\n") + "\\n");
`, { mode: 0o755 });
  return exe;
}

function helper(root, name, body) { const p = path.join(root, name); fs.writeFileSync(p, body); return p; }
const writer = (hex) => `require("fs").writeFileSync(process.argv[2], Buffer.from(${JSON.stringify(hex)}, "hex"));\n`;
const commandFor = (h) => `${shellQuote(process.execPath)} ${shellQuote(h)} $OUTPUT`;

function specFile(root, variants, rom, objdump = null) {
  const p = path.join(root, "spec.json");
  fs.writeFileSync(p, JSON.stringify({ variants, score: { function: "fn", rom, rom_offset: 0, ...(objdump ? { objdump } : {}) } }));
  return p;
}

test("a spec needs variants and a score; labels are unique; a complete file parses; bad JSON names the fix", () => {
  const d = tmp(), p = path.join(d, "spec.json");
  fs.writeFileSync(p, JSON.stringify({ variants: [] }));
  assert.throws(() => loadMatrixSpec(p), ScoreError);
  fs.writeFileSync(p, JSON.stringify({ variants: [{ label: "a", command: "true $OUTPUT" }, { label: "a", command: "true $OUTPUT" }], score: { function: "fn", rom: "r.z64", rom_offset: "0x0" } }));
  assert.throws(() => loadMatrixSpec(p), /duplicate/);
  fs.writeFileSync(p, JSON.stringify({ variants: [{ label: "as1", command: "true $OUTPUT" }], score: { function: "fn", rom: "r.z64", rom_offset: "0x10" } }));
  const [variants, spec] = loadMatrixSpec(p);
  assert.equal(variants[0].label, "as1"); assert.equal(spec.target.rom_offset, 0x10);
  fs.writeFileSync(p, "{not json");
  assert.throws(() => loadMatrixSpec(p), /not valid JSON/);
});

test("attractors are ordered by best score", () => {
  const make = (label, digest, diff) => new VariantResult({ label, command: "", returncode: 0, stdout: "", stderr: "", output_path: null, output_exists: true,
    duration_seconds: 0, error: null, candidate_sha256: digest, stderr_warning: null, stdout_log: "", stderr_log: "",
    score: new ScoreReport({ candidate: label, target_description: "test", controls: [], controls_broken: false, matched: diff === 0,
      function: new WordScore({ label: "fn", mode: "function", note: null, candidate_size: 16, target_size: 16, diff_words: diff, relocation_floor: 0,
        diff_positions: [], candidate_sha256: digest, matched: diff === 0 }) }) });
  const a = clusterAttractors([make("worse", "hash-worse", 5), make("best-a", "hash-best", 0), make("best-b", "hash-best", 0)]);
  assert.equal(a[0].letter, "A"); assert.equal(a[0].diff_words, 0); assert.deepEqual(new Set(a[0].members), new Set(["best-a", "best-b"]));
  assert.equal(a[1].letter, "B"); assert.deepEqual(a[1].members, ["worse"]);
});

test("two variants agree and one differs; logs are never discarded", async () => {
  const root = tmp(), rom = path.join(root, "baserom.z64");
  fs.writeFileSync(rom, Buffer.from(TARGET, "hex"));
  const objdump = rawObjdump(root);
  const variants = [["match-a", TARGET], ["match-b", TARGET], ["different", DIFFERENT]].map(([label, hex]) => ({ label, command: commandFor(helper(root, `${label}.js`, writer(hex))) }));
  const report = await runMatrix(specFile(root, variants, rom, objdump), { run_dir: path.join(root, "run"), timeout: 30, cwd: root });
  assert.equal(report.attractors.length, 2);
  assert.equal(report.attractors[0].diff_words, 0);
  assert.deepEqual(new Set(report.attractors[0].members), new Set(["match-a", "match-b"]));
  assert.equal(report.collapsed_attractors.length, 1); assert.equal(report.all_collapsed, false); assert.equal(report.caution, null);
  for (const v of report.variants) { assert.ok(fs.statSync(v.stdout_log).isFile()); assert.ok(fs.statSync(v.stderr_log).isFile()); }
});

test("every variant collapsing into one attractor triggers the caution", async () => {
  const root = tmp(), rom = path.join(root, "baserom.z64");
  fs.writeFileSync(rom, Buffer.from(TARGET, "hex"));
  const objdump = rawObjdump(root);
  const variants = ["v1", "v2", "v3"].map((label) => ({ label, command: commandFor(helper(root, `${label}.js`, writer(DIFFERENT))) }));
  const report = await runMatrix(specFile(root, variants, rom, objdump), { run_dir: path.join(root, "run"), timeout: 30, cwd: root });
  assert.equal(report.attractors.length, 1); assert.equal(report.all_collapsed, true);
  assert.equal(report.caution, ALL_COLLAPSED_CAUTION);
  assert.ok(report.caution.includes("the reference campaign"));
});

test("a stderr warning is surfaced next to its label", async () => {
  const root = tmp(), rom = path.join(root, "baserom.z64");
  fs.writeFileSync(rom, Buffer.from(TARGET, "hex"));
  const objdump = rawObjdump(root);
  const warns = helper(root, "warns.js", `process.stderr.write("warning: unknown option --fancy-flag, ignored\\n");\n` + writer(DIFFERENT));
  const report = await runMatrix(specFile(root, [{ label: "warns", command: commandFor(warns) }], rom, objdump), { run_dir: path.join(root, "run"), timeout: 30, cwd: root });
  assert.equal(report.silent_fallback_warnings.length, 1);
  const [label, line] = report.silent_fallback_warnings[0];
  assert.equal(label, "warns"); assert.ok(line.includes("unknown option"));
});

test("no placeholder, no output, and a failing command are clean errors", async () => {
  const root = tmp(), rom = path.join(root, "baserom.z64");
  fs.writeFileSync(rom, Buffer.from(TARGET, "hex"));
  let r = await runMatrix(specFile(root, [{ label: "bad", command: "true" }], rom), { run_dir: path.join(root, "run"), timeout: 30, cwd: root });
  assert.equal(r.variants[0].score, null); assert.ok(r.variants[0].error.includes("$OUTPUT"));
  r = await runMatrix(specFile(root, [{ label: "noop", command: commandFor(helper(root, "noop.js", "")) }], rom), { run_dir: path.join(root, "run"), timeout: 30, cwd: root });
  assert.equal(r.variants[0].score, null); assert.ok(r.variants[0].error.includes("no output object"));
  r = await runMatrix(specFile(root, [{ label: "fails", command: commandFor(helper(root, "fails.js", "process.exit(3);\n")) }], rom), { run_dir: path.join(root, "run"), timeout: 30, cwd: root });
  assert.equal(r.variants[0].score, null); assert.equal(r.variants[0].returncode, 3); assert.ok(r.variants[0].error.includes("exited 3"));
});

test("matrix command: attractors and the logs path, JSON schema, clean errors, exit one when nothing scores", async () => {
  const root = tmp(), rom = path.join(root, "baserom.z64");
  fs.writeFileSync(rom, Buffer.from(TARGET, "hex"));
  const objdump = rawObjdump(root);
  const spec = specFile(root, [{ label: "match", command: commandFor(helper(root, "match.js", writer(TARGET))) }], rom, objdump);
  const run = path.join(root, "run");
  let [status, stdout, stderr] = await runCli(["matrix", spec, "--run-dir", run], { cwd: root });
  assert.equal(status, 0, stderr); assert.equal(stderr, "");
  assert.ok(stdout.includes(run)); assert.ok(stdout.includes("ATTR")); assert.ok(stdout.includes("next:"));
  assert.ok(!stdout.includes("<best-variant>")); assert.ok(!stdout.includes("<verdict>"));
  [status, stdout] = await runCli(["matrix", spec, "--run-dir", run, "--json"], { cwd: root });
  const payload = JSON.parse(stdout);
  assert.equal(status, 0); assert.equal(payload.schema, "decomp-workbench-matrix-v1"); assert.equal(payload.attractors.length, 1);
  [status, stdout, stderr] = await runCli(["matrix", "/no/such/spec.json"]);
  assert.equal(status, 2); assert.equal(stdout, ""); assert.ok(stderr.includes("does not exist"));
  const bad = specFile(root, [{ label: "bad", command: "true" }], rom);
  [status, stdout] = await runCli(["matrix", bad, "--run-dir", run], { cwd: root });
  assert.equal(status, 1); assert.ok(stdout.includes("no scorable object"));
});
