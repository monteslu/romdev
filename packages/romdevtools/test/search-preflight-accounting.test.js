// Report 2026-09-15 §9: "the i5 search ran with a 300-second budget and eight
// threads, returned no improvement, and consumed roughly 317 seconds. A failed
// descriptive-seed job preceded it. A search that terminates correctly is
// useful infrastructure, but that result did not advance the candidate."
//
// Two asks: run a preflight BEFORE spending search budget, and report what the
// budget bought (effective compilations, duplicates, failures, mutation
// families, elapsed time, termination reason) instead of only a final score.
import { test } from "node:test";
import assert from "node:assert/strict";
import { startSearch } from "../src/decomp/jobs.js";

const fn = { symbol: "f", segment: "seg", vaHex: "0x80000000" };

test("a base that does not compile is refused before any budget is spent", async () => {
  await assert.rejects(
    () => startSearch({ project: {}, fn, baseCandidateText: "void f(){}",
      preflight: { compileSucceeded: false, firstDiagnostic: "cfe: Error: undefined symbol" } }),
    (e) => {
      assert.equal(e.code, "PREFLIGHT_FAILED");
      assert.match(e.message, /cannot permute a candidate the compiler rejects/i);
      assert.match(e.message, /undefined symbol/, "the compiler's own error should be carried through");
      return true;
    });
});

test("a base that is already exact is refused rather than searched", async () => {
  await assert.rejects(
    () => startSearch({ project: {}, fn, baseCandidateText: "void f(){}",
      preflight: { compileSucceeded: true, exactFunctionMatch: true } }),
    (e) => {
      assert.equal(e.code, "PREFLIGHT_ALREADY_EXACT");
      assert.match(e.message, /nothing to search for/i);
      return true;
    });
});

test("the preflight refusal happens before the job directory exists", async () => {
  // Same requirement as the seed check: an up-front refusal must not leave a
  // directory or a process behind.
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("../src/decomp/jobs.js", import.meta.url), "utf8");
  // The whole startSearch body: the search now runs in-process and starts at launchSearch(.
  const body = src.match(/export async function startSearch\([\s\S]*?\n\}\n/)?.[0] ?? "";
  const iPre = body.indexOf("PREFLIGHT_FAILED");
  const iMkdir = body.indexOf("mkdir(jobDir");
  const iSpawn = body.indexOf("launchSearch(");
  assert.ok(iSpawn >= 0, "startSearch no longer starts the search through launchSearch");
  assert.ok(iPre >= 0 && iPre < iMkdir, "the job directory is created before the preflight check");
  assert.ok(iPre < iSpawn, "the search is launched before the preflight check");
});

test("the report accounts for what the budget bought", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("../src/decomp/jobs.js", import.meta.url), "utf8");
  const block = src.match(/const accounting = \{[\s\S]*?\n  \};/)?.[0] ?? "";
  assert.ok(block, "no accounting block");
  for (const field of ["elapsedS", "threads", "candidatesWritten", "improvements", "terminationReason", "mutationFamilies"]) {
    assert.match(block, new RegExp(field), `accounting omits '${field}'`);
  }
});

test("counts the backend does not report are null, not invented", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("../src/decomp/jobs.js", import.meta.url), "utf8");
  assert.match(src, /iterationsReported: Number\.isFinite\(iterations\) \? iterations : null/,
    "an unreported iteration count must be null");
  assert.match(src, /null rather than guessed/i,
    "the response should say why the field is absent");
});

test("an exhausted search with no improvement recommends switching mechanism", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("../src/decomp/jobs.js", import.meta.url), "utf8");
  const rec = src.match(/recommendation: `[\s\S]*?` \} : \{\}\)/)?.[0] ?? "";
  assert.ok(rec, "no recommendation for an exhausted no-improvement search");
  assert.match(rec, /Switch mechanism/i);
  assert.match(rec, /explores the same space again/i,
    "re-running an undirected search with a bigger budget should be discouraged explicitly");
});

test("a permuter score is never presented as exactness", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("../src/decomp/jobs.js", import.meta.url), "utf8");
  assert.match(src, /the permuter's score is not the strict test/i);
  assert.match(src, /budget exhausted - best is the closest candidate, not a match/i);
});
