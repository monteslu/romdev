// Report 2026-09-15 §4.3: descriptive seed `i5-schedule-rodata-297` passed
// validation, then the permuter crashed in `map(int, force_seed.split(','))`.
// Numeric `297` worked. Acceptance: "invalid seed fails synchronously with an
// actionable error and no orphan job" and "deterministically map friendly
// strings to backend seeds and return the mapping."
//
// The backend grammar, read from src/main.py of decomp-permuter:
//   parser.add_argument("--seed", dest="force_seed", type=str, ...)
//   seed_parts = list(map(int, options.force_seed.split(",")))
// so: int, or int,int -- nothing else.
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveSeed } from "../src/decomp/jobs.js";

test("a plain integer seed passes through untouched", () => {
  const r = resolveSeed("297");
  assert.equal(r.seed, "297");
  assert.equal(r.from, "numeric");
  assert.equal(r.mapping, null);
});

test("the backend's two-part form is accepted", () => {
  assert.equal(resolveSeed("0,297").seed, "0,297");
});

test("the reported descriptive seed is mapped, not crashed on", () => {
  const r = resolveSeed("i5-schedule-rodata-297");
  assert.equal(r.from, "label");
  assert.match(r.seed, /^\d+$/, "a label must resolve to something the backend can parse");
  assert.ok(Number(r.seed) >= 0 && Number(r.seed) <= 0xffffffff);
  assert.match(r.mapping, /i5-schedule-rodata-297/, "the mapping must be reported so the run is reproducible");
});

test("label mapping is deterministic", () => {
  assert.equal(resolveSeed("i5-schedule-rodata-297").seed, resolveSeed("i5-schedule-rodata-297").seed);
  assert.notEqual(resolveSeed("alpha").seed, resolveSeed("beta").seed);
});

test("a mapped label survives the backend's own parser", () => {
  // The exact expression that crashed: map(int, s.split(",")).
  for (const label of ["i5-schedule-rodata-297", "a", "x.y-z_1"]) {
    for (const part of resolveSeed(label).seed.split(",")) {
      assert.match(part, /^\d+$/, `part '${part}' would crash map(int, ...)`);
    }
  }
});

test("an unusable seed is refused synchronously with an actionable message", () => {
  for (const bad of ["12 34", "a,b", "-5", "1,2,3", "seed;rm -rf /", "é"]) {
    assert.throws(() => resolveSeed(bad), (e) => {
      assert.equal(e.code, "BAD_ARGS", `'${bad}' must be a BAD_ARGS refusal`);
      assert.match(e.message, /integer|usable|0\.\.4294967295/i, `'${bad}' needs an actionable message`);
      return true;
    }, `seed '${bad}' was accepted`);
  }
});

test("out-of-range integers are refused rather than silently truncated", () => {
  assert.throws(() => resolveSeed("4294967296"), /0\.\.4294967295/);
});

test("no seed is not an error", () => {
  assert.equal(resolveSeed(undefined).seed, null);
  assert.equal(resolveSeed("").seed, null);
});

test("validation happens before any job directory is created", async () => {
  // The orphan-job requirement: resolveSeed is called at the top of
  // startSearch, before mkdir and before spawn.
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("../src/decomp/jobs.js", import.meta.url), "utf8");
  // The whole startSearch body: the search now runs in-process and starts at launchSearch(.
  const body = src.match(/export async function startSearch\([\s\S]*?\n\}\n/)?.[0] ?? "";
  const iSeed = body.indexOf("resolveSeed(seed)");
  const iMkdir = body.indexOf("mkdir(jobDir");
  const iSpawn = body.indexOf("launchSearch(");
  assert.ok(iSpawn >= 0, "startSearch no longer starts the search through launchSearch");
  assert.ok(iSeed >= 0, "startSearch does not validate the seed");
  assert.ok(iSeed < iMkdir, "the job directory is created before the seed is validated");
  assert.ok(iSeed < iSpawn, "the search is launched before the seed is validated");
});
