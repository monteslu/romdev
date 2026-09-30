// Record-level windows, diffs, and surgery on synthesized phase streams.
// Ported from the workbench's own stream tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { binasmLiteralStream, binasmStream, ucodeStream, urecord } from "./fixtures/workbench/phase-streams.js";
import { allocateFreshLabels, decodeStream, detectFormat, diffStreams, maxLabel, parseRecordSpec, patchStream, streamWindow } from "../src/decomp/workbench/streams.js";
import { parseUcode } from "../src/decomp/workbench/ucode.js";
import { runCommand } from "../src/decomp/workbench/cli.js";
import { pyEq } from "../src/decomp/workbench/py.js";

const tmp = () => mkdtempSync(path.join(os.tmpdir(), "wb-streams-"));
const replaceBytes = (buf, a, b) => { const i = buf.indexOf(a); return Buffer.concat([buf.subarray(0, i), b, buf.subarray(i + a.length)]); };

test("each stream is detected from its own framing", () => {
  assert.equal(detectFormat(ucodeStream()), "ucode");
  assert.equal(detectFormat(binasmStream()), "binasm");
});

test("an empty or ragged stream says why", () => {
  assert.throws(() => detectFormat(Buffer.alloc(0)), /empty/);
  assert.throws(() => detectFormat(Buffer.alloc(3)), /32-bit words/);
});

test("a zero-padded ucode stream is not read as binasm", () => {
  const padded = Buffer.concat([urecord("ret"), Buffer.alloc(24)]);
  assert.equal(padded.length % 16, 0);
  assert.equal(detectFormat(padded), "ucode");
});

test("a decoder accepts bytes and paths alike", () => {
  const dir = tmp();
  try {
    const p = path.join(dir, "unit.U");
    writeFileSync(p, ucodeStream());
    assert.ok(pyEq(decodeStream(p)[2], decodeStream(ucodeStream())[2]));
    assert.ok(pyEq(parseUcode(p), parseUcode(ucodeStream())));
    assert.equal(parseUcode(String(p))[0].name, "lab");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a record index and its byte offset select the same record", () => {
  const byIndex = streamWindow(ucodeStream(), { at: "#2", radius: 1 });
  const byOffset = streamWindow(ucodeStream(), { at: "0x18", radius: 1 });
  assert.deepEqual(byIndex.position, byOffset.position);
  assert.equal(byIndex.position.record_index, 2);
  const centre = byIndex.records.find((r) => r.at_position);
  assert.equal(centre.name, "Uujp");
  assert.equal(centre.detail, "target=L5");
});

test("an offset inside a record names the nearest boundaries", () => {
  assert.throws(() => streamWindow(ucodeStream(), { at: "0x14" }), /not a record boundary/);
});

test("the window reads a binasm stream the same way", () => {
  const report = streamWindow(binasmStream(), { at: "#4", radius: 1 });
  assert.equal(report.format, "binasm");
  assert.equal(report.records.find((r) => r.at_position).name, "local-label");
});

test("a fresh label is above every label the stream uses", () => {
  const [, , records] = decodeStream(ucodeStream());
  assert.equal(maxLabel(records, { stream_format: "ucode" }), 5);
  assert.deepEqual(allocateFreshLabels(records, 2, { stream_format: "ucode" }), [6, 7]);
});

test("a spec using more fresh slots than allocated is refused", () => {
  assert.throws(() => parseRecordSpec("0x1,{fresh+3}", { fresh_labels: [6] }), /only 1 fresh label/);
});

test("insert then decode round-trips the new records", () => {
  const stream = ucodeStream();
  const [, , before] = decodeStream(stream);
  const [patched, report] = patchStream(stream, { insert_at: "#2", records_spec: "0x26660000,{fresh} | 0x42600000,{fresh},0,2", fresh_label_count: 1 });
  assert.deepEqual(report.fresh_labels, [6]);
  assert.equal(report.result.decodes, true);
  assert.equal(report.result.record_delta, 2);
  const [, , after] = decodeStream(patched);
  assert.equal(after.length, before.length + 2);
  assert.deepEqual(after.slice(2, 4).map((r) => r.name), ["Ufjp", "Ulab"]);
  assert.equal(after[2].detail, "target=L6");
  assert.equal(after[3].detail, "label=L6");
  assert.deepEqual(after[1].words, before[1].words);
  assert.deepEqual(after[4].words, before[2].words);
});

test("a spec may come from a file with comments", () => {
  const dir = tmp();
  try {
    const spec = path.join(dir, "barrier.hex");
    writeFileSync(spec, "# a conditional branch to the very next label\n0x26660000 {fresh}\n\n0x42600000 {fresh} 0 2\n");
    const [, report] = patchStream(ucodeStream(), { insert_at: "#2", records_spec: spec, fresh_label_count: 1 });
    assert.equal(report.inserted.bytes, 24);
    assert.deepEqual(report.inserted.records.map((r) => r.name), ["Ufjp", "Ulab"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a spec whose groups do not match the framing is refused", () => {
  assert.throws(() => patchStream(ucodeStream(), { insert_at: "#2", records_spec: "0x42600000,7 | 0,2" }), /do not match decoded record/);
});

test("a patch that breaks framing is refused by default", () => {
  assert.throws(() => patchStream(ucodeStream(), { insert_at: "#1", records_spec: "0xff000000,0" }), /does not decode/);
});

test("delete and replace keep the stream decodable", () => {
  const stream = ucodeStream();
  const [deleted, dr] = patchStream(stream, { delete: "1" });
  assert.equal(dr.result.record_delta, -1);
  assert.equal(deleted.length, stream.length - 8);
  const [replaced, rr] = patchStream(stream, { replace: "1", records_spec: "0x7f660000,5" });
  assert.equal(rr.result.record_delta, 0);
  assert.equal(decodeStream(replaced)[2][1].name, "Utjp");
});

test("a boundary inside a literal record group is refused", () => {
  for (const position of ["#3", "0x30", "#4", "0x40"]) {
    assert.throws(() => patchStream(binasmLiteralStream(), { insert_at: position, records_spec: "0,0x00150000,0,0" }), /inside the float-literal/, position);
  }
});

test("the ends of a literal record group are still boundaries", () => {
  for (const position of ["#2", "#5"]) {
    const [, report] = patchStream(binasmLiteralStream(), { insert_at: position, records_spec: "0,0x00150000,0,0" });
    assert.equal(report.result.decodes, true);
    assert.equal(report.result.framing_preserved, true);
    assert.equal(report.result.record_delta, 1);
  }
});

test("a span that splits a literal from its payload is refused", () => {
  assert.throws(() => patchStream(binasmLiteralStream(), { delete: "2" }), /inside the float-literal/);
});

test("deleting a whole literal group is allowed", () => {
  const [, report] = patchStream(binasmLiteralStream(), { delete: "2:5" });
  assert.equal(report.result.record_delta, -3);
  assert.equal(report.result.framing_preserved, true);
});

test("an edit that reframes its neighbours is refused", () => {
  assert.throws(() => patchStream(binasmStream(), { insert_at: "#1", records_spec: "0,0x001701f8,0,32" }), /still parses/);
});

test("a reframing edit can still be kept deliberately", () => {
  const [, report] = patchStream(binasmStream(), { insert_at: "#1", records_spec: "0,0x001701f8,0,32", allow_undecodable: true });
  assert.equal(report.result.decodes, true);
  assert.equal(report.result.framing_preserved, false);
  assert.ok(report.result.framing_error.includes("after it"));
});

test("exactly one operation is required", () => {
  assert.throws(() => patchStream(ucodeStream(), { records_spec: "0x0,0" }), /exactly one of/);
  assert.throws(() => patchStream(ucodeStream(), { insert_at: "#0", delete: "1" }), /exactly one of/);
});

test("identical streams report no divergence", () => {
  const report = diffStreams(ucodeStream(), ucodeStream());
  assert.equal(report.identical, true);
  assert.equal(report.first_divergence, null);
  assert.equal(report.opcode_counts.equal, 5);
});

test("one inserted record is one inserted row", () => {
  const [patched] = patchStream(ucodeStream(), { insert_at: "#2", records_spec: "0x7f660000,5" });
  const report = diffStreams(ucodeStream(), patched);
  assert.equal(report.identical, false);
  assert.equal(report.opcode_counts.insert, 1);
  assert.equal(report.opcode_counts.replace, 0);
  assert.equal(report.opcode_counts.equal, 5);
  assert.equal(report.first_divergence.tag, "insert");
  assert.equal(report.first_divergence.right.name, "Utjp");
  assert.equal(report.first_divergence.left_index, 2);
});

test("a changed record is reported as a replacement", () => {
  const changed = replaceBytes(ucodeStream(), urecord("nop"), urecord("ret"));
  const report = diffStreams(ucodeStream(), changed);
  assert.equal(report.opcode_counts.replace, 1);
  assert.equal(report.first_divergence.left.name, "Unop");
  assert.equal(report.first_divergence.right.name, "Uret");
});

test("binasm streams diff by record too", () => {
  const left = binasmStream();
  const right = Buffer.concat([left.subarray(0, 0x30), left.subarray(0x40)]);
  const report = diffStreams(left, right);
  assert.equal(report.format, "binasm");
  assert.equal(report.opcode_counts.delete, 1);
});

test("streams of different formats are refused", () => {
  assert.throws(() => diffStreams(ucodeStream(), binasmStream()), /different formats/);
});

test("the grouped and flat spellings agree", async () => {
  const dir = tmp();
  try {
    const p = path.join(dir, "unit.U");
    writeFileSync(p, ucodeStream());
    const grouped = await runCommand(["ucode", "window", p, "--at", "#2"]);
    const flat = await runCommand(["ucode-window", p, "--at", "#2"]);
    assert.deepEqual(grouped, flat);
    assert.equal(grouped.code, 0);
    assert.ok(grouped.stdout.includes("Uujp"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("patch writes only when an output is named", async () => {
  const dir = tmp();
  try {
    const source = path.join(dir, "unit.U"), output = path.join(dir, "patched.U");
    writeFileSync(source, ucodeStream());
    const r = await runCommand(["ucode", "patch", source, "--insert-at", "#2", "--records", "0x42600000,{fresh},0,2", "--fresh-label", "-o", output]);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.stdout.includes("fresh labels: 6"));
    assert.ok(readFileSync(source).equals(ucodeStream()));
    assert.equal(readFileSync(output).length, ucodeStream().length + 16);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("patching a stream in place is refused", async () => {
  const dir = tmp();
  try {
    const source = path.join(dir, "unit.U");
    writeFileSync(source, ucodeStream());
    const r = await runCommand(["ucode", "patch", source, "--delete", "1", "-o", source]);
    assert.equal(r.code, 2);
    assert.ok(r.stderr.includes("in place"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("stream diff prints the first divergence", async () => {
  const dir = tmp();
  try {
    const left = path.join(dir, "left.U"), right = path.join(dir, "right.U");
    writeFileSync(left, ucodeStream());
    writeFileSync(right, patchStream(ucodeStream(), { insert_at: "#2", records_spec: "0x7f660000,5" })[0]);
    const r = await runCommand(["stream", "diff", left, right]);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.stdout.includes("DIFFERENT"));
    assert.ok(r.stdout.includes("first divergence: insert"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
