// Real N64 decomp field regressions; requires the checkpoint-312 artifacts.
// ROMDEV_AUDIT_URL=http://127.0.0.1:7332 node --test test/decomp-field-live.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
const url = process.env.ROMDEV_AUDIT_URL;
const project = "wr64-us-rev1";
const workspace = path.join(os.homedir(), ".romdev/decomp", project);
async function call(args) {
  const response = await fetch(`${url}/tool/decomp`, { method: "POST",
    headers: { "Content-Type": "application/json", "x-romdev-session": "field-regression-tests" },
    body: JSON.stringify({ project, symbol: "func_801EB4F4", ...args }) });
  const result = await response.json();
  assert.equal(response.ok, true, JSON.stringify(result));
  return result;
}

test("HTTP actual compiler resolves the registered project alias without accepting a wrong or unknown address", { skip: !url }, async () => {
  const status = await call({ op: "status" });
  const text = await readFile(path.join(status.root, "docs/research/tooling-spin-312/race-setup.c"), "utf8");
  const compare = candidateText => call({ op: "compare", candidateText, detail: true, noCache: true });
  const good = await compare(text);
  assert.equal(good.compileSucceeded, true);
  assert.equal(good.measurementValidity.state, "valid");
  assert.equal(good.romLinked.status, "exact");
  assert.equal(good.romLinked.mismatches, 0);
  // Raw relocation spelling remains a separate strict check, not silently
  // relaxed: textExact follows the strict count, and a function with
  // spelling differences is exact only as "resolved-relocations" (both
  // spellings link to the ROM's own words).
  assert.equal(good.strictMismatches, 2);
  assert.equal(good.textExact, false);
  assert.equal(good.verdict.checks.text.equivalence, "resolved-relocations");
  assert.equal(good.exactFunctionMatch, true);
  const wrong = await compare(text.replaceAll("D_801CE704", "D_801CE6F8"));
  assert.equal(wrong.compileSucceeded, true);
  assert.equal(wrong.romLinked.status, "mismatch");
  assert.ok(wrong.romLinked.mismatches > 0);
  const missing = await compare("extern s32 romdev_field_unknown_alias;\n" + text.replaceAll("D_801CE704", "romdev_field_unknown_alias"));
  assert.equal(missing.compileSucceeded, true);
  assert.equal(missing.romLinked.status, "unresolved-relocations");
  assert.equal(missing.romLinked.mismatches, null);
  assert.ok(missing.romLinked.uncheckableWords > 0);
  assert.equal(missing.exactFunctionMatch, false);
});

test("HTTP original ten-word residue diagnoses five scheduling swaps", { skip: !url }, async () => {
  const artifactId = path.join(workspace, "candidates/func_801EB4F4",
    "046c2b559c23814df370-830f8f2afd221857-iaf79b59dd871508c02c4-qe56f57fdd01e0dca-v2-r43f63c81-ed79-4c8c-9e01-0b17daf839ac.diff.json");
  const result = await call({ op: "diagnose", artifactId });
  assert.deepEqual(result.groups.map(g => g.instructions.indices), [[96, 97], [109, 110], [148, 149], [158, 159], [171, 172]]);
  assert.ok(result.groups.every(g => g.mechanism === "scheduling-permutation"));
});

test("HTTP original stopped search reports no progress, not backend failure", { skip: !url }, async () => {
  const result = await call({ op: "job", jobId: "search-func_8004C998-mu3r95jb1", action: "report" });
  assert.equal(result.status, "complete-no-progress");
  assert.equal(result.accounting.terminationReason, "no-improvement-budget");
});
