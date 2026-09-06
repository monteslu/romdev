// decomp-verdict.test.js — the verifier's contract: "could not check" is never
// "exact". Tests the PRODUCTION assembler (assembleVerdictFields, the function
// compileAndCompare calls) with injected evidence, plus the cache gate.
import { test } from "node:test";
import assert from "node:assert/strict";
import { aggregateVerdict, assembleVerdictFields, rodataState, cacheUsable, VERIFIER_VERSION } from "../src/decomp/verdict.js";

const exactText = { exact: true, mismatchCount: 0, targetBytes: 28, candidateBytes: 28 };
const badText = { exact: false, mismatchCount: 3, targetBytes: 28, candidateBytes: 28 };
const romExact = { status: "exact", mismatches: 0 };
const both = (fields) => [fields.exactFunctionMatch, fields.verification.functionLocal];

test("equal text + equal referenced literals → exact in both public fields", () => {
  const f = assembleVerdictFields({ strict: exactText, rodata: { compared: true, equal: true, references: { target: 1, candidate: 1 } }, romLinked: romExact, tuStatus: "other-functions-unchanged" });
  assert.deepEqual(both(f), [true, "exact"]); assert.equal(f.textExact, true); assert.equal(f.verifierVersion, VERIFIER_VERSION);
});

test("equal text + one changed same-size literal → mismatch in BOTH public fields, textExact stays true", () => {
  const f = assembleVerdictFields({ strict: exactText, rodata: { compared: true, equal: false, items: [{ kind: "literal", equal: false }] }, romLinked: romExact });
  assert.deepEqual(both(f), [false, "mismatch"]); assert.equal(f.textExact, true); assert.equal(f.verification.rodata, "mismatch");
});

test("equal text + changed same-size jump table → mismatch in both", () => {
  const f = assembleVerdictFields({ strict: exactText, rodata: { compared: true, equal: false, items: [{ kind: "jump-table", equal: false }] }, romLinked: romExact });
  assert.deepEqual(both(f), [false, "mismatch"]);
});

test("injected rodata-comparison exception → error, never exact", () => {
  const f = assembleVerdictFields({ strict: exactText, rodata: { compared: false, error: "injected rodata-comparison failure (test hook)" }, romLinked: romExact });
  assert.deepEqual(both(f), [false, "error"]); assert.match(f.verdict.reasons.join(), /injected/);
});

test("required rodata with missing linker-map placement → unknown, never exact", () => {
  const f = assembleVerdictFields({ strict: exactText, rodata: { compared: false, reason: "the candidate references .rodata but the linker map has no .rodata placement" }, romLinked: romExact });
  assert.deepEqual(both(f), [false, "unknown"]);
});

test("missing / malformed data-comparison result → error, never exact", () => {
  assert.deepEqual(both(assembleVerdictFields({ strict: exactText, rodata: undefined, romLinked: romExact })), [false, "error"]);
  assert.deepEqual(both(assembleVerdictFields({ strict: exactText, rodata: { compared: true }, romLinked: romExact })), [false, "error"]);
  assert.deepEqual(both(assembleVerdictFields({ strict: exactText, rodata: 42, romLinked: romExact })), [false, "error"]);
  assert.deepEqual(both(assembleVerdictFields({ strict: exactText, rodata: { compared: true, equal: true }, romLinked: undefined })), [false, "error"]);
});

test("proven absence of relevant data (applicable:false) keeps exact possible", () => {
  const f = assembleVerdictFields({ strict: exactText, rodata: { compared: true, equal: true, applicable: false, references: { target: 0, candidate: 0 } }, romLinked: romExact });
  assert.deepEqual(both(f), [true, "exact"]); assert.equal(f.verification.rodata, "not-applicable");
  // `compared:false` with a reason is NOT proof of absence, even with a friendly reason.
  assert.equal(rodataState({ compared: false, reason: "no placement" }).state, "unknown");
});

test("mismatching text with equal data → mismatch; ROM-linked unknown → unknown", () => {
  assert.deepEqual(both(assembleVerdictFields({ strict: badText, rodata: { compared: true, equal: true }, romLinked: romExact })), [false, "mismatch"]);
  assert.deepEqual(both(assembleVerdictFields({ strict: exactText, rodata: { compared: true, equal: true }, romLinked: { status: "unresolved-relocations", unresolvedSymbols: ["D_x"] } })), [false, "unknown"]);
  // precedence: a mismatch anywhere beats an error elsewhere
  assert.equal(aggregateVerdict({ strict: badText, rodata: { compared: false, error: "boom" }, romLinked: romExact }).functionLocal, "mismatch");
  assert.equal(aggregateVerdict({ strict: exactText, rodata: { compared: false, error: "boom" }, romLinked: { status: "no-rom-offset" } }).functionLocal, "error");
});

test("a cached result from the old verifier is not usable as a current verdict", () => {
  assert.equal(cacheUsable({ exactFunctionMatch: true, verification: { functionLocal: "exact" } }), false, "v1 result (no verifierVersion) rejected");
  assert.equal(cacheUsable({ exactFunctionMatch: true, verifierVersion: VERIFIER_VERSION }), false, "no verdict object rejected");
  assert.equal(cacheUsable({ exactFunctionMatch: true, verifierVersion: VERIFIER_VERSION, verdict: { functionLocal: "exact" } }), true);
  assert.equal(cacheUsable({ exactFunctionMatch: true, verifierVersion: VERIFIER_VERSION - 1, verdict: { functionLocal: "exact" } }), false);
});

test("compileAndCompare consults the same assembler (source-level guard against a divergent inline expression)", async () => {
  const src = await (await import("node:fs/promises")).readFile(new URL("../src/decomp/compile.js", import.meta.url), "utf8");
  assert.ok(/assembleVerdictFields\(\{ strict, rodata, romLinked/.test(src), "compile.js assembles the verdict through verdict.js");
  assert.ok(!/exactFunctionMatch:\s*strict\.exact\s*&&/.test(src), "no inline exactness expression remains");
  assert.ok(/-v\$\{VERIFIER_VERSION\}/.test(src), "the cache key carries the verifier version");
  assert.ok(/cacheUsable\(cached\)/.test(src), "cached results are gated by cacheUsable");
});
