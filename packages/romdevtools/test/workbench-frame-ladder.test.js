// Ported from the workbench's frame-ladder tests: slot decode and temp
// classification from synthetic CDX_SYMTAB / webdetail records. The
// operation-stream report (op_report) and the trace-frame command are not
// on romdev's diagnose path and are not ported.
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
