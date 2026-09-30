// Ported from the workbench's watch-row tests: the watchlist grammar, the
// healed/broken/out-of-range columns, and `compare-dumps --watch-rows`.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assemble } from "./fixtures/workbench/mips-asm.js";
import { parseDisassembly } from "../src/decomp/workbench/objdump.js";
import { compareInstructions } from "../src/decomp/workbench/compare.js";
import { BROKEN, HEALED, OUT_OF_RANGE, WATCH_ROWS_SCHEMA, WatchRow, WatchRowError, evaluateWatchRows, parseWatchRows, watchRowLines,
  watchRowPayload, watchSignature } from "../src/decomp/workbench/watch-rows.js";
import { runCli } from "./fixtures/workbench/cli-run.js";

const TARGET = ["addiu sp,sp,-16", "addu v0,a0,a1", "addiu t0,v0,4", "or t1,t0,a2", "jr ra", "addiu sp,sp,16"];
const CANDIDATE = ["addiu sp,sp,-16", "addu v1,a0,a1", "addiu t0,v0,4", "or t1,t0,a3", "jr ra", "addiu sp,sp,16"];
const comparison = () => compareInstructions(parseDisassembly(assemble(TARGET, { symbol: "demo" })), parseDisassembly(assemble(CANDIDATE, { symbol: "demo" })),
  { target_name: "target.o", candidate_name: "candidate.o", symbol: null });
const plain = (rows) => rows.map((r) => ({ row: r.row, label: r.label }));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "romdev-wb-watch-"));

test("bare rows label themselves; named columns; a repeated row and a non-row token are errors; no specification is no rows", () => {
  assert.deepEqual(plain(parseWatchRows("49,1620,1677")), [{ row: 49, label: "49" }, { row: 1620, label: "1620" }, { row: 1677, label: "1677" }]);
  assert.deepEqual(plain(parseWatchRows("r49=49, cx2=1620")), [{ row: 49, label: "r49" }, { row: 1620, label: "cx2" }]);
  assert.throws(() => parseWatchRows("a=7,b=7"), (e) => e instanceof WatchRowError && e.message.includes("watched twice"));
  assert.throws(() => parseWatchRows("cx2"), /LABEL=ROW/);
  assert.deepEqual(parseWatchRows(null), []);
});

test("the file form accepts a list of objects and a bare label mapping; a missing file says so", () => {
  const d = tmp(), p = path.join(d, "probes.json");
  fs.writeFileSync(p, JSON.stringify({ name: "fp-tail", rows: [{ row: 49, label: "r49" }, { row: 1620, label: "cx2" }] }));
  assert.deepEqual(plain(parseWatchRows(`@${p}`)), [{ row: 49, label: "r49" }, { row: 1620, label: "cx2" }]);
  fs.writeFileSync(p, JSON.stringify({ r49: 49 }));
  assert.deepEqual(plain(parseWatchRows(`@${p}`)), [{ row: 49, label: "r49" }]);
  assert.throws(() => parseWatchRows("@/nonexistent/probes.json"), /cannot read/);
});

test("healed and broken columns; a broken row carries its class and both sides; a row past the end is not healed", () => {
  const c = comparison();
  assert.equal(watchSignature(evaluateWatchRows(parseWatchRows("a=0,b=1,c=2,d=3"), { diff_sites: c.diff_sites, compared_rows: TARGET.length })), `${HEALED}${BROKEN}${HEALED}${BROKEN}`);
  const [r] = evaluateWatchRows([new WatchRow({ row: 1, label: "b" })], { diff_sites: c.diff_sites, compared_rows: TARGET.length });
  assert.equal(r.healed, false); assert.equal(r.difference, "register"); assert.ok(r.target.includes("v0")); assert.ok(r.candidate.includes("v1"));
  const [tail] = evaluateWatchRows([new WatchRow({ row: 9000, label: "tail" })], { diff_sites: c.diff_sites, compared_rows: TARGET.length });
  assert.equal(tail.healed, null); assert.equal(tail.column, OUT_OF_RANGE);
});

test("the payload tallies every state and every key is namespaced; the terminal block quotes only broken rows", () => {
  const c = comparison();
  const p = watchRowPayload(evaluateWatchRows(parseWatchRows("a=0,b=1,tail=9000"), { diff_sites: c.diff_sites, compared_rows: TARGET.length }));
  assert.equal(p.watch_signature, `${HEALED}${BROKEN}${OUT_OF_RANGE}`);
  assert.equal(p.watch_healed, 1); assert.equal(p.watch_broken, 1); assert.equal(p.watch_out_of_range, 1);
  assert.ok(!("schema" in p)); assert.equal(p.watch_schema, WATCH_ROWS_SCHEMA); assert.ok(Object.keys(p).every((k) => k.startsWith("watch_")));
  const text = watchRowLines(evaluateWatchRows(parseWatchRows("a=0,b=1"), { diff_sites: c.diff_sites, compared_rows: TARGET.length })).join("\n");
  assert.ok(text.includes("signature=.X")); assert.ok(text.includes("[    1] b: register")); assert.ok(!text.includes("[    0]"));
});

async function runCompare(extra = [], watch = "a=0,b=1,c=3") {
  const d = tmp(), t = path.join(d, "target.txt"), c = path.join(d, "candidate.txt");
  fs.writeFileSync(t, assemble(TARGET, { symbol: "demo" })); fs.writeFileSync(c, assemble(CANDIDATE, { symbol: "demo" }));
  return runCli(["compare-dumps", t, c, "--color", "never", "--watch-rows", watch, ...extra]);
}

test("compare-dumps --watch-rows: the signature prints under the verdict; the JSON stays a comparison; a bad spec exits two", async () => {
  let [, out] = await runCompare();
  assert.ok(out.includes("signature=.XX"));
  const [status, json] = await runCompare(["--json"]);
  assert.equal(status, 0);
  const p = JSON.parse(json);
  assert.equal(p.schema, "decomp-workbench-comparison-v1");
  assert.equal(p.watch_schema, WATCH_ROWS_SCHEMA); assert.equal(p.watch_signature, ".XX");
  assert.deepEqual(p.watch_rows.map((r) => r.label), ["a", "b", "c"]);
  assert.equal(p.watch_rows[0].healed, true); assert.equal(p.watch_rows[1].class, "register");
  const [bad] = await runCompare([], "not-a-row");
  assert.equal(bad, 2);
});
