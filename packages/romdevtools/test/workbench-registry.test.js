// Every command the journey map catalogues, and every flat spelling it keeps
// parseable, is implemented in process; nothing in the map is a dead entry.
import { test } from "node:test";
import assert from "node:assert/strict";
import { COMMAND_MAP, GROUP_ALIASES, HIDDEN_FLAT_COMMANDS } from "../src/decomp/workbench/discovery.js";
import { commandRegistryErrors } from "../src/decomp/workbench/discovery-cli.js";
import { commandSpecs, runCommand, runCommandIsolated } from "../src/decomp/workbench/cli.js";

test("the registry has no missing command", async () => {
  assert.deepEqual(await commandRegistryErrors(), []);
});

test("every catalogued command answers --help by both spellings", async () => {
  const specs = await commandSpecs();
  let checked = 0;
  for (const [group, entries] of Object.entries(COMMAND_MAP)) {
    for (const [op] of entries) {
      const r = await runCommand([group, op, "--help"]);
      assert.equal(r.code, 0, `${group} ${op}: ${r.stderr}`);
      assert.match(r.stdout, /^usage: decomp-workbench /, `${group} ${op}`);
      const flat = GROUP_ALIASES[`${group} ${op}`];
      if (flat) assert.ok(specs.has(flat), flat);
      checked++;
    }
  }
  assert.equal(checked, 128);
});

test("hidden flat spellings stay parseable", async () => {
  const specs = await commandSpecs();
  for (const name of HIDDEN_FLAT_COMMANDS) assert.ok(specs.has(name), name);
});

test("an isolated command is killed at its timeout and says so", async () => {
  const r = await runCommandIsolated(["commands", "--json"], { timeoutMs: 1 });
  assert.equal(r.code, 2);
  assert.equal(r.timedOut, true);
  assert.match(JSON.parse(r.stdout).error.message, /timeout/);
  assert.equal(JSON.parse(r.stdout).error.kind, "timeout");
});

test("an isolated command reports missing files relative to its working directory", async () => {
  const r = await runCommandIsolated(["trace", "scheduler", "missing/sched.trace", "--json"], { cwd: process.cwd() });
  assert.equal(r.code, 2);
  assert.match(JSON.parse(r.stdout).error.message, /No such file or directory: 'missing\/sched.trace'/);
});
