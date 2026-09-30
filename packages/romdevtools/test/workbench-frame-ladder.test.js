// Ported from the workbench's frame-ladder tests: slot decode and temp
// classification from synthetic CDX_SYMTAB / webdetail records, the itable
// operation stream, the trace-frame command, and the symtab patch grammar.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CascadeError, CdxLog } from "../src/decomp/workbench/cascade.js";
import { frameLadder, parseSlotNames, LADDER_SCHEMA } from "../src/decomp/workbench/frame-ladder.js";

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "workbench");
const TEXT = fs.readFileSync(path.join(FIX, "frame-ladder.trace"), "utf8");
const NAMES = fs.readFileSync(path.join(FIX, "frame-names.txt"), "utf8");
const readLog = () => new CdxLog(TEXT, { name: "frame-ladder.log" });
const websOnly = () => new CdxLog(TEXT.split("\n").filter((l) => !l.includes("] symtab")).join("\n"), { name: "webs-only.log" });
const byOffset = (ladder) => new Map(ladder.slots.map((s) => [s.offset, s]));

test("home is the offset minus the signed frame; no frame, no home", () => {
  const slots = byOffset(frameLadder(readLog(), { frame: -216 }));
  assert.equal(slots.get(-140).home, 76);
  assert.equal(slots.get(-144).home, 72);
  assert.equal(slots.get(0).home, 216);
  assert.ok(frameLadder(readLog()).slots.every((s) => s.home === null));
});

test("slots carry size, class and the first index", () => {
  const slots = byOffset(frameLadder(readLog(), { frame: -216 }));
  assert.equal(slots.get(-132).size, 2);
  assert.equal(slots.get(-132).storage_class_name, "M");
  assert.equal(slots.get(0).storage_class_name, "P");
  assert.equal(slots.get(2).storage_class_name, "R");
  assert.equal(slots.get(-140).index, 72);
});

test("webs join to the slot by frame offset", () => {
  const slots = byOffset(frameLadder(readLog(), { frame: -216 }));
  assert.deepEqual(slots.get(-136).webs, [80, 181]);
  assert.deepEqual(slots.get(-136).sources, ["symtab", "webdetail"]);
  assert.deepEqual(slots.get(-124).webs, []);
});

test("unnamed slots below the lowest named one are temps; no names, no claim", () => {
  const names = parseSlotNames(NAMES, { frame: -216 });
  const ladder = frameLadder(readLog(), { frame: -216, names });
  assert.equal(ladder.lowest_named_offset, -136);
  assert.deepEqual(ladder.below_named.map((s) => s.offset), [-144, -140]);
  assert.equal(ladder.named.length, 8);
  assert.deepEqual(frameLadder(readLog(), { frame: -216 }).below_named, []);
});

test("a name for an absent slot is a warning, not a row", () => {
  const ladder = frameLadder(readLog(), { frame: -216, names: new Map([[-999, "ghost"]]) });
  assert.equal(ladder.warnings.length, 1);
  assert.ok(ladder.warnings[0].includes("-999"));
  assert.ok(!ladder.slots.some((s) => s.offset === -999));
});

test("a webdetail-only log says the ladder is a subset, with sizes from raw18", () => {
  const ladder = frameLadder(websOnly(), { frame: -216 });
  assert.deepEqual(ladder.sources, ["webdetail"]);
  assert.deepEqual(ladder.slots.map((s) => s.offset), [-136, -132]);
  assert.ok(ladder.warnings.some((w) => w.includes("subset of the frame")));
  const slots = byOffset(frameLadder(websOnly()));
  assert.equal(slots.get(-136).size, 4);
  assert.equal(slots.get(-132).size, 2);
});

test("a log with no frame evidence names both instruments", () => {
  assert.throws(() => frameLadder(new CdxLog("[CDX] globalcolor proc=0\n", { name: "bare.log" })),
    (e) => e instanceof CascadeError && e.message.includes("CDX_SYMTAB=1") && e.message.includes("CDX_LOG=1"));
});

test("the ladder document carries the schema and the slots, lowest first", () => {
  const doc = frameLadder(readLog(), { frame: -216 }).asDict();
  assert.equal(doc.schema, LADDER_SCHEMA);
  assert.equal(doc.slot_count, 12);
  assert.equal(doc.slots[0].offset, -144);
  const offsets = doc.slots.map((s) => s.offset);
  assert.deepEqual(offsets, [...offsets].sort((a, b) => a - b));
});

test("slot name maps: both spellings, hex, comments, and refusals", () => {
  assert.deepEqual(parseSlotNames("-140 temp\n", { frame: -216 }), parseSlotNames("sp:76 temp\n", { frame: -216 }));
  assert.deepEqual([...parseSlotNames("0xffffff74 temp\n")], [[-140, "temp"]]);
  assert.throws(() => parseSlotNames("sp:76 temp\n"), (e) => e instanceof CascadeError && /needs --frame/.test(e.message));
  assert.deepEqual([...parseSlotNames("# note\n\n-140 temp\n")], [[-140, "temp"]]);
  assert.throws(() => parseSlotNames("-140 temp\nnonsense\n"), /names line 2/);
});

test("a CDX log file without records fails loudly", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "romdev-cdx-"));
  fs.writeFileSync(path.join(d, "nothing.log"), "no records here\n");
  assert.throws(() => CdxLog.read(path.join(d, "nothing.log")), /\[CDX\]/);
  assert.throws(() => CdxLog.read(path.join(d, "absent.log")), /cannot read/);
});

// -- the operation stream, the trace-frame command, and the patch grammar --

import { opReport, SYMTAB_RECORD_GRAMMAR } from "../src/decomp/workbench/frame-ladder.js";
import { runCommand } from "../src/decomp/workbench/cli.js";

const TRACE_FILE = path.join(FIX, "frame-ladder.trace");
const NAMES_FILE = path.join(FIX, "frame-names.txt");
const PATCHES = fileURLToPath(new URL("../src/decomp/workbench/data/patches/", import.meta.url));

test("operands resolve to supplied names; unnamed operands fall back to class and offset", () => {
  const names = parseSlotNames(NAMES, { frame: -216 });
  const named = new Map(opReport(frameLadder(readLog(), { frame: -216, names }), { names }).operations.map((r) => [r.index, r]));
  assert.equal(named.get(71).left_name, "viewx(69)");
  assert.equal(named.get(410).opcode_name, "usub");
  const bare = new Map(opReport(frameLadder(readLog(), { frame: -216 })).operations.map((r) => [r.index, r]));
  assert.equal(bare.get(74).left_name, "M-140(72)");
});

test("offsets filter the stream to one slot", () => {
  assert.deepEqual(opReport(frameLadder(readLog(), { frame: -216 }), { offsets: [-140] }).operations.map((r) => r.index), [74]);
});

test("no symtab records is an error naming the instrument", () => {
  assert.throws(() => opReport(frameLadder(websOnly())), (e) => e instanceof CascadeError && e.message.includes("CDX_SYMTAB=1"));
});

test("the ladder prints lowest slot first", async () => {
  const r = await runCommand(["trace-frame", TRACE_FILE, "--frame", "-216", "--pager", "never"]);
  assert.equal(r.code, 0);
  const offsets = r.stdout.split("\n").filter((l) => l.startsWith("    -") || l.startsWith("       ")).map((l) => parseInt(l.trim().split(/\s+/)[0], 10));
  assert.deepEqual(offsets, [...offsets].sort((a, b) => a - b));
  assert.ok(r.stdout.includes("76(sp)"));
});

test("summary is one sweep column", async () => {
  const r = await runCommand(["trace-frame", TRACE_FILE, "--frame", "-216", "--names", NAMES_FILE, "--summary", "--pager", "never"]);
  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes("named=8"));
  assert.ok(r.stdout.includes("temps below it 2"));
});

test("trace-frame JSON carries the schema and the slots", async () => {
  const r = await runCommand(["trace-frame", TRACE_FILE, "--frame", "-216", "--json"]);
  assert.equal(r.code, 0);
  const doc = JSON.parse(r.stdout);
  assert.equal(doc.schema, "decomp-workbench-frame-ladder-v1");
  assert.equal(doc.slot_count, 12);
  assert.equal(doc.slots[0].offset, -144);
});

test("a log without CDX records, or an unreadable names file, fails loudly", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "romdev-wb-frame-"));
  try {
    const empty = path.join(dir, "nothing.log");
    fs.writeFileSync(empty, "no records here\n");
    const r = await runCommand(["trace-frame", empty]);
    assert.equal(r.code, 2);
    assert.ok(r.stderr.includes("[CDX]"));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  const n = await runCommand(["trace-frame", TRACE_FILE, "--names", "/nonexistent/names.txt"]);
  assert.equal(n.code, 2);
  assert.ok(n.stderr.includes("cannot read"));
});

test("the grammar action lists the symtab records and exits", async () => {
  const r = await runCommand(["trace-cascade", TRACE_FILE, "--grammar"]);
  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes("[CDX] symtab"));
});

test("every field the reader reads is in the patch", () => {
  const patch = fs.readFileSync(path.join(PATCHES, "uopt-5.3-cdx-symtab.patch"), "utf8");
  for (const f of ["idx", "kind", "dtype", "selfidx", "ver", "off", "tag", "class", "b24", "vreg", "op"]) assert.ok(patch.includes(`${f}=%`), f);
});

test("the patch records the base it applies to, and is a unified diff against one file", () => {
  const readme = fs.readFileSync(path.join(PATCHES, "README.md"), "utf8");
  assert.ok(readme.includes("e465eb4b76ac001d1c94ff8bf74c378217b6ed2e674a6b73c6722edc01baf5ca"));
  assert.ok(readme.includes("CDX_SYMTAB"));
  const lines = fs.readFileSync(path.join(PATCHES, "uopt-5.3-cdx-symtab.patch"), "utf8").split("\n");
  assert.ok(lines[0].startsWith("--- a/build/5.3/uopt.c"));
  assert.ok(lines[1].startsWith("+++ b/build/5.3/uopt.c"));
  assert.ok(lines.some((l) => l.startsWith("@@")));
});

test("both records are documented in the grammar table", () => {
  assert.deepEqual(Object.keys(SYMTAB_RECORD_GRAMMAR).sort(), ["symtab", "symtabcount"]);
  for (const d of Object.values(SYMTAB_RECORD_GRAMMAR)) assert.ok(d.includes("CAMPAIGN-LOCAL"));
});
