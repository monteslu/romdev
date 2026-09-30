// Campaign artifacts: current and best checkpoints kept independently and
// recoverably, guarded restore, acceptance, and the append-only dossier.
// Ported from the workbench's test_candidate_lifecycle.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { archiveCandidate } from "../src/decomp/workbench/candidate-lifecycle.js";
import { readDossier } from "../src/decomp/workbench/dossier.js";
import { runCommand } from "../src/decomp/workbench/cli.js";
import { writeCompiler, template, writeObjdump } from "./fixtures/workbench/campaign-tools.js";

let root, source, manifest;
const cli = async (a) => { const r = await runCommand(a); return [r.code, r.stdout, r.stderr]; };

beforeEach(async () => {
  root = mkdtempSync(path.join(os.tmpdir(), "romdev-wb-lifecycle-"));
  const target = path.join(root, "target.o");
  source = path.join(root, "candidate.c");
  writeFileSync(target, "target");
  writeFileSync(source, "int original;\n");
  const [status, stdout, stderr] = await cli(["campaign", target, source, "--compile-command", template(writeCompiler(root, "fs.writeFileSync(out, 'object');")),
    "--objdump", writeObjdump(root), "--symbol", "demo", "--cache-dir", path.join(root, "cache"), "--state-dir", path.join(root, "state"), "--json-summary"]);
  assert.deepEqual([status, stderr], [0, ""]);
  manifest = JSON.parse(stdout).manifest;
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const cacheObject = () => { const m = JSON.parse(readFileSync(manifest, "utf8")); return path.join(m.cache_directory, `${m.sources[0].cache_key}.o`); };

test("checkpoint, restore with backup, and acceptance", async () => {
  writeFileSync(source, "int current;\n");
  let [status, stdout, stderr] = await cli(["campaign", "checkpoint", manifest, "--current-source", source, "--json"]);
  assert.deepEqual([status, stderr], [0, ""]);
  const checkpoint = JSON.parse(stdout);
  assert.notEqual(checkpoint.current.id, checkpoint.best.id);
  writeFileSync(source, "int drifted;\n");
  [status, , stderr] = await cli(["campaign", "restore-best", manifest, "--destination", source]);
  assert.equal(status, 2);
  assert.ok(stderr.includes("changed since the current checkpoint"));
  [status, stdout, stderr] = await cli(["campaign", "restore-best", manifest, "--destination", source, "--allow-drift", "--json"]);
  assert.deepEqual([status, stderr], [0, ""]);
  assert.equal(readFileSync(source, "utf8"), "int original;\n");
  assert.ok(existsSync(JSON.parse(stdout).backup.path));
  [status, stdout, stderr] = await cli(["campaign", "accept", manifest, "--json"]);
  assert.deepEqual([status, stderr], [0, ""]);
  const accepted = JSON.parse(stdout).accepted;
  assert.equal(accepted.exact, true);
  assert.equal(JSON.parse(readFileSync(manifest, "utf8")).accepted.artifact_id, accepted.artifact_id);
});

test("current may already be the ranked best", async () => {
  const [status, stdout, stderr] = await cli(["campaign", "checkpoint", manifest, "--current-source", source, "--current-object", cacheObject(), "--json"]);
  assert.deepEqual([status, stderr], [0, ""]);
  const checkpoint = JSON.parse(stdout);
  assert.equal(checkpoint.same, true);
  assert.equal(checkpoint.current.id, checkpoint.best.id);
});

test("archive identity does not depend on the origin name", async () => {
  const sourceAlias = path.join(root, "same-source.txt"), objectAlias = path.join(root, "same-object.bin");
  writeFileSync(sourceAlias, readFileSync(source));
  writeFileSync(objectAlias, readFileSync(cacheObject()));
  const first = await archiveCandidate(path.dirname(manifest), { source, object_path: cacheObject() });
  const second = await archiveCandidate(path.dirname(manifest), { source: sourceAlias, object_path: objectAlias });
  assert.deepEqual(first, second);
});

test("checkpoint refuses an object changed after measurement", async () => {
  writeFileSync(cacheObject(), "changed after the ledger measurement");
  const [status, , stderr] = await cli(["campaign", "checkpoint", manifest]);
  assert.equal(status, 2);
  assert.ok(stderr.includes("object hash disagrees with its ledger record"));
});

test("acceptance revalidates immutable archive metadata", async () => {
  let [status, stdout, stderr] = await cli(["campaign", "checkpoint", manifest, "--json"]);
  assert.deepEqual([status, stderr], [0, ""]);
  const metadata = path.join(path.dirname(manifest), "artifacts", JSON.parse(stdout).best.id, "artifact.json");
  const record = JSON.parse(readFileSync(metadata, "utf8"));
  record.id = "0".repeat(24);
  writeFileSync(metadata, JSON.stringify(record));
  [status, , stderr] = await cli(["campaign", "accept", manifest]);
  assert.equal(status, 2);
  assert.ok(stderr.includes("immutable metadata"));
});

test("the dossier is append-only, queryable and deduplicated", async () => {
  const args = ["campaign", "dossier-add", manifest, "--function", "demo", "--hypothesis", "commuting the operands changes the scheduler basin",
    "--lever", "swap the two source operands", "--result", "falsified", "--outcome", "the normalized object hash was unchanged", "--do-not-repeat",
    "--evidence", "campaign row 4", "--json"];
  let [status, stdout, stderr] = await cli(args);
  assert.deepEqual([status, stderr], [0, ""]);
  const id = JSON.parse(stdout).entry.id;
  [status, stdout, stderr] = await cli(args);
  assert.equal(status, 2);
  assert.equal(stderr, "");
  assert.ok(stdout.includes(id));
  [status, stdout, stderr] = await cli(["campaign", "dossier-list", manifest, "--function", "demo", "--result", "falsified", "--json"]);
  assert.deepEqual([status, stderr], [0, ""]);
  const report = JSON.parse(stdout);
  assert.deepEqual([report.entry_count, report.do_not_repeat], [1, 1]);
  const dossier = path.join(path.dirname(manifest), "dossier.jsonl");
  const entry = JSON.parse(readFileSync(dossier, "utf8"));
  entry.outcome = "tampered";
  writeFileSync(dossier, JSON.stringify(entry) + "\n");
  assert.throws(() => readDossier(dossier), /content does not match id/);
});

test("a complete corrupt final dossier line is not treated as torn", () => {
  const dossier = path.join(path.dirname(manifest), "dossier.jsonl");
  writeFileSync(dossier, '{"schema":\n');
  assert.throws(() => readDossier(dossier), /malformed dossier line/);
});
