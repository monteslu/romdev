// `check-staleness` and its --tolerance option. Every artifact is a file whose
// modification time is set explicitly. Ported from the workbench's own
// staleness command tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, utimesSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { runCommand } from "../src/decomp/workbench/cli.js";
import { parseArgs } from "../src/decomp/workbench/argparse.js";
import { COMMAND_SPECS } from "../src/decomp/workbench/staleness-cli.js";
import { DEFAULT_TOLERANCE_SECONDS, STALENESS_SCHEMA } from "../src/decomp/workbench/staleness.js";

const BASE = 1_700_000_000;
function chain(romAge) {
  const root = mkdtempSync(path.join(os.tmpdir(), "romdev-wb-stale-"));
  const source = path.join(root, "track.c"), rom = path.join(root, "game.z64");
  writeFileSync(source, "int a;\n"); utimesSync(source, BASE, BASE);
  writeFileSync(rom, "rom"); utimesSync(rom, BASE + romAge, BASE + romAge);
  return { root, source, rom, done: () => rmSync(root, { recursive: true, force: true }) };
}

test("a fresh chain exits zero and says when it was built", async () => {
  const c = chain(60);
  const r = await runCommand(["check-staleness", c.source, c.rom]);
  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes("build freshness: fresh"));
  assert.ok(r.stdout.includes("built 20"));
  c.done();
});

test("a stale chain exits one and names the input", async () => {
  const c = chain(-600);
  const r = await runCommand(["check-staleness", c.source, c.rom]);
  assert.equal(r.code, 1);
  assert.ok(r.stdout.includes("STALE:"));
  assert.ok(r.stdout.includes("track.c"));
  c.done();
});

test("--allow-stale reports and still exits zero", async () => {
  const c = chain(-600);
  const r = await runCommand(["check-staleness", c.source, c.rom, "--allow-stale"]);
  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes("STALE:"));
  c.done();
});

test("JSON is one schema-named document", async () => {
  const c = chain(-600);
  const r = await runCommand(["check-staleness", c.source, c.rom, "--json", "--sha256"]);
  const payload = JSON.parse(r.stdout);
  assert.equal(r.code, 1);
  assert.equal(r.stderr, "");
  assert.equal(payload.schema, STALENESS_SCHEMA);
  assert.equal(payload.stale, true);
  assert.equal(payload.status, "stale");
  assert.match(payload.artifacts[0].sha256, /^[0-9a-f]{64}$/);
  assert.equal(payload.violations.length, 1);
  c.done();
});

test("one path is a usage error, not a pass", async () => {
  const c = chain(60);
  const r = await runCommand(["check-staleness", c.source]);
  assert.equal(r.code, 2);
  assert.ok(r.stderr.includes("at least two paths"));
  c.done();
});

test("labels must correspond", async () => {
  const c = chain(60);
  const r = await runCommand(["check-staleness", c.source, c.rom, "--label", "source"]);
  assert.equal(r.code, 2);
  assert.ok(r.stderr.includes("must correspond"));
  c.done();
});

test("the grouped spelling is the same command", async () => {
  const c = chain(60);
  assert.deepEqual(await runCommand(["object", "staleness", c.source, c.rom]), await runCommand(["check-staleness", c.source, c.rom]));
  c.done();
});

const spec = COMMAND_SPECS[0];
test("the --tolerance default is the shared constant", () => {
  assert.equal(parseArgs(spec, ["a.c", "a.o"]).tolerance, DEFAULT_TOLERANCE_SECONDS);
});

test("a negative tolerance is refused", async () => {
  for (const value of ["-1", "-0.5"]) {
    const r = await runCommand(["check-staleness", "a.c", "a.o", "--tolerance", value]);
    assert.equal(r.code, 2);
    assert.ok(r.stderr.includes("must not be negative"), r.stderr);
  }
});

test("zero is allowed because it is a real policy", () => {
  assert.equal(parseArgs(spec, ["a.c", "a.o", "--tolerance", "0"]).tolerance, 0);
});
