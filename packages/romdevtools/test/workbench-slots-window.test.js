// Ported from the workbench's slots and window tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assemble } from "./fixtures/workbench/mips-asm.js";
import { parseDisassembly } from "../src/decomp/workbench/objdump.js";
import { compareInstructions } from "../src/decomp/workbench/compare.js";
import { slotReport, volatileProbeSources } from "../src/decomp/workbench/slots.js";
import { CSourceError } from "../src/decomp/workbench/csource.js";
import { parseRowRanges } from "../src/decomp/workbench/view-cli.js";
import { fakeObjdump } from "./fixtures/workbench/fake-objdump.js";
import { runCli } from "./fixtures/workbench/cli-run.js";
import { splitlines } from "../src/decomp/workbench/py.js";

const SYMBOL = "demo";
const BODY = ["addiu sp,sp,-1704", "sw ra,28(sp)", "swc1 f0,1184(sp)", "lwc1 f4,1184(sp)", "lwc1 f6,1184(sp)", "sw t0,64(sp)", "lw t1,64(sp)",
  "lh t2,64(sp)", "addiu a0,sp,96", "lw ra,28(sp)", "jr ra", "addiu sp,sp,1704"];
const SOURCE = "void demo(void) {\n    f32 sp4A0;\n    struct beam *beam_local;\n    s32 i;\n\n    sp4A0 = 0.0f;\n    for (i = 0; i < 4; i++) {\n        step(sp4A0);\n    }\n}\n";
const rows = (lines) => parseDisassembly(assemble(lines, { symbol: SYMBOL }), { symbol: SYMBOL });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "romdev-wb-slots-"));
const entries = () => Object.fromEntries(slotReport(rows(BODY), { label: "demo.o" }).slots.map((s) => [s.offset, s]));

test("loads and stores are counted apart; two widths at one offset is a pun", () => {
  const e = entries();
  assert.deepEqual([e[1184].loads, e[1184].stores], [2, 1]); assert.equal(e[1184].total, 3);
  assert.equal(e[64].punned, true); assert.deepEqual(e[64].widths, [2, 4]); assert.equal(e[1184].punned, false);
});

test("an address-take is a slot but not a touch; the frame itself is not a slot", () => {
  const e = entries();
  assert.equal(e[96].address_taken, 1); assert.equal(e[96].total, 0);
  const offsets = slotReport(rows(BODY), { label: "demo.o" }).slots.map((s) => s.offset);
  assert.ok(!offsets.includes(-1704)); assert.ok(!offsets.includes(1704));
});

test("the cheapest list ranks only touched slots; each slot carries the frame offset the trace keys it by", () => {
  const r = slotReport(rows(BODY), { label: "demo.o" });
  assert.ok(r.cheapest.every((s) => s.total > 0));
  assert.equal(r.cheapest[0].total, Math.min(...r.cheapest.map((s) => s.total)));
  assert.equal(r.frame, -1704);
  const e = Object.fromEntries(r.slots.map((s) => [s.offset, s]));
  assert.equal(e[1184].frame_offset, -520); assert.equal(e[1184].frame_offset >>> 0, 0xFFFFFDF8);
  for (const s of r.cheapest) assert.ok("frame_offset" in s);
});

test("a row range narrows the census", () => {
  const offsets = slotReport(rows(BODY), { label: "demo.o", rows: [1, 3] }).slots.map((s) => s.offset);
  assert.ok(offsets.includes(28)); assert.ok(!offsets.includes(64));
});

test("volatile probe: one variant per local, pointer types kept, unknown names refused", () => {
  const d = tmp(), source = path.join(d, "work.c");
  fs.writeFileSync(source, SOURCE);
  const report = volatileProbeSources(source, { directory: path.join(d, "v") });
  assert.deepEqual(new Set(report.variants.map((v) => v.variable)), new Set(["sp4A0", "beam_local", "i"]));
  const first = fs.readFileSync(report.variants[0].path, "utf8");
  assert.ok(first.includes("volatile f32 sp4A0;"));
  assert.equal(splitlines(first).length, splitlines(SOURCE).length);
  const one = volatileProbeSources(source, { directory: path.join(d, "v2"), variables: ["beam_local"] });
  assert.equal(one.count, 1);
  assert.ok(fs.readFileSync(one.variants[0].path, "utf8").includes("volatile struct beam *beam_local;"));
  assert.throws(() => volatileProbeSources(source, { directory: path.join(d, "v3"), variables: ["nosuch"] }), (e) => e instanceof CSourceError && e.message.includes("nosuch"));
});

function slotsObject() {
  const d = tmp(), target = path.join(d, "demo.o");
  fs.writeFileSync(target, "\x7fELF placeholder");
  return { d, target, objdump: fakeObjdump(d, { "demo.o": assemble(BODY, { symbol: SYMBOL }) }) };
}

test("slots command: the table, the pun warning and the frame offset spelled for trace-cascade", async () => {
  const { target, objdump } = slotsObject();
  const [status, out] = await runCli(["slots", target, "--objdump", objdump]);
  assert.equal(status, 0);
  for (const s of ["stack slots:", "PUN", "cheapest slots to disturb:", "does not say which C local lives at a slot", "frame=-1704", "0xfffffdf8", "--frame-offset"]) assert.ok(out.includes(s), s);
});

test("slots command: the volatile probe needs a source; JSON carries the schema; the grouped spelling reaches it", async () => {
  const { target, objdump } = slotsObject();
  let [status, out, err] = await runCli(["slots", target, "--objdump", objdump, "--volatile-probe", path.join(path.dirname(target), "v")]);
  assert.equal(status, 2); assert.ok(err.includes("--volatile-probe needs --source"));
  [status, out] = await runCli(["slots", target, "--objdump", objdump, "--json"]);
  assert.equal(status, 0);
  const payload = JSON.parse(out);
  assert.equal(payload.schema, "decomp-workbench-stack-slots-v1"); assert.ok(payload.slots.length);
  [status, out] = await runCli(["object", "slots", target, "--objdump", objdump]);
  assert.equal(status, 0); assert.ok(out.includes("stack slots:"));
});

test("slots command: an unreadable object is refused rather than traced back", async () => {
  const d = tmp(), target = path.join(d, "demo.o");
  fs.writeFileSync(target, "not an object at all");
  const objdump = fakeObjdump(d, { "demo.o": { fail: `${target}: file format not recognized` } });
  const [status, , err] = await runCli(["slots", target, "--objdump", objdump]);
  assert.equal(status, 2); assert.ok(err.startsWith("error: objdump failed for"), err); assert.ok(!err.includes("Traceback"));
});

// window

const PROLOGUE = ["addiu sp,sp,-32", "sw ra,28(sp)", "sw s0,24(sp)", "move s0,a0"];
const EPILOGUE = ["lw ra,28(sp)", "lw s0,24(sp)", "jr ra", "addiu sp,sp,32"];
const WT = [...PROLOGUE, "li v0,33", "addu v1,v0,s0", "lw t7,8(s0)", ...EPILOGUE];
const WC = [...PROLOGUE, "li v0,33", "addu v1,v0,s0", "lw t8,8(s0)", ...EPILOGUE];

test("row selectors: single rows and ranges parse; malformed or backwards ones are refused", () => {
  assert.deepEqual(parseRowRanges(["863"]), [[863, 863]]);
  assert.deepEqual(parseRowRanges(["850-875"]), [[850, 875]]);
  assert.deepEqual(parseRowRanges(["1-2", " 9 "]), [[1, 2], [9, 9]]);
  for (const v of ["", "a-b", "5-", "-3", "9-4", "1-2-3"]) assert.throws(() => parseRowRanges([v]), /row selector/, v);
});

function windowDumps() {
  const d = tmp();
  const t = path.join(d, "target.objdump"), c = path.join(d, "candidate.objdump");
  fs.writeFileSync(t, assemble(WT, { symbol: "demo" })); fs.writeFileSync(c, assemble(WC, { symbol: "demo" }));
  return [t, c];
}
async function runWindow(...flags) { const [t, c] = windowDumps(); return runCli(["window-dumps", t, c, ...flags]); }

test("window: the row numbers are the ones compare publishes", async () => {
  const item = compareInstructions(rows(WT), rows(WC), { target_name: "target.o", candidate_name: "candidate.o", symbol: "demo" });
  const aligned = item.aligned_diff_sites.map((s) => s.aligned_row);
  assert.ok(aligned.length);
  const [status, out] = await runWindow("--json", "--rows", String(aligned[0]));
  assert.equal(status, 0);
  const p = JSON.parse(out);
  assert.deepEqual(p.rows.map((r) => r.aligned_row), [aligned[0]]); assert.equal(p.differing, 1); assert.deepEqual(p.rows[0].substitutions, [["t7", "t8"]]);
});

test("window: a differing row is marked; ranges print in the order requested", async () => {
  let [status, out] = await runWindow("--rows", "0-8", "--color", "never");
  assert.equal(status, 0);
  const marked = out.split("\n").filter((l) => l.includes(" * "));
  assert.equal(marked.length, 1); for (const s of ["t7", "t8", "t7->t8"]) assert.ok(marked[0].includes(s));
  [status, out] = await runWindow("--json", "--rows", "6", "--rows", "0-1");
  const p = JSON.parse(out);
  assert.deepEqual(p.rows.map((r) => r.aligned_row), [6, 0, 1]); assert.deepEqual(p.requested_rows, [[6, 6], [0, 1]]);
});

test("window: clamping, past-the-end and the header are all said out loud", async () => {
  let [status, out] = await runWindow("--rows", "8-9999", "--color", "never");
  assert.equal(status, 0); assert.ok(out.includes("clamped to the last row"));
  [status, out] = await runWindow("--rows", "9000-9001", "--color", "never");
  assert.equal(status, 0); assert.ok(out.includes("past the end"));
  [status, out] = await runWindow("--rows", "0", "--color", "never");
  assert.equal(status, 0); assert.ok(out.split("\n")[0].includes("aligned_rows="));
});

test("window: rows are required; bad selectors and missing symbols are input errors; grouped spelling works", async () => {
  const [t, c] = windowDumps();
  let [status] = await runCli(["window-dumps", t, c]);
  assert.equal(status, 2);
  let err;
  [status, , err] = await runCli(["window-dumps", t, c, "--rows", "20-10"]);
  assert.equal(status, 2); assert.ok(err.includes("backwards"));
  [status, , err] = await runCli(["window-dumps", t, c, "--rows", "0", "--symbol", "absent"]);
  assert.equal(status, 2); assert.ok(err.includes("error:"));
  let out;
  [status, out] = await runCli(["object", "window-dumps", t, c, "--rows", "0", "--json"]);
  assert.equal(status, 0); assert.equal(JSON.parse(out).schema, "decomp-workbench-window-v1");
});
