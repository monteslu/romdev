// Static Binasm boundary and IDO peephole evidence. Ported from the
// workbench's own binasm tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildBinasmBoundaryReport, parseBinasm, parsePeepdbg } from "../src/decomp/workbench/binasm.js";

const record = (...words) => { const b = Buffer.alloc(16); words.forEach((w, i) => b.writeUInt32BE(w >>> 0, i * 4)); return b; };
const cat = (...parts) => Buffer.concat(parts.map((p) => (typeof p === "string" ? Buffer.from(p, "ascii") : p)));
function withFile(data, fn) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wb-binasm-"));
  try { const p = path.join(dir, "unit.G"); writeFileSync(p, data); return fn(p); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("known records are named without losing raw words", () => {
  const parsed = parseBinasm(cat(record(0, 0x001C0000, 28, 85), record(0, 0x00200000, 8, 0), record(0, 0x001701AE, 0x060D0000, 0xFF), record(0xFFFFFFDB, 0, 0, 0)));
  assert.deepEqual(parsed.map((r) => r.name), ["loc", "set-nomove", "andi", "local-label"]);
  assert.deepEqual(parsed[2].words, [0, 0x001701AE, 0x060D0000, 0xFF]);
  assert.ok((parsed[2].source_lever ?? "").includes("width normalization"));
});

test("partial record is refused", () => {
  assert.throws(() => parseBinasm(Buffer.from("short")), /multiple of 16/);
});

test("a stream is read from bytes or from a path", () => {
  const data = record(0, 0x001C0000, 28, 85);
  withFile(data, (p) => {
    assert.deepEqual(parseBinasm(p).map((r) => r.words), parseBinasm(data).map((r) => r.words));
    assert.equal(parseBinasm(String(p))[0].name, "loc");
  });
});

test("both label definition shapes are named", () => {
  const parsed = parseBinasm(cat(record(0xFFFFFFDB, 0, 0, 0), record(3, 0, 0, 0)));
  assert.deepEqual(parsed.map((r) => [r.name, r.detail]), [["local-label", "local label $37"], ["symbol-label", "label definition for symbol index 3"]]);
});

test("a case table entry names its target label", () => {
  const parsed = parseBinasm(cat(record(0, 0x001A0000, 0, 0), record(0xFFFFFFDD, 0, 0, 0), record(0xFFFFFF9D, 0x00160000, 0, 1), record(0, 0x00150000, 0, 0)));
  assert.deepEqual(parsed.map((r) => r.name), ["section-switch", "local-label", "table-entry", "text"]);
  assert.equal(parsed[2].kind, "jump-table");
  assert.equal(parsed[2].detail, "case target $99");
});

test("a float literal frames its ascii digits as payload", () => {
  const parsed = parseBinasm(cat(record(0, 0x001701F8, 0x5D208000, 22), "3.05175781250000", "00e-05          ", record(0, 0x001C0000, 28, 86)));
  assert.deepEqual(parsed.map((r) => r.name), ["float-literal", "ascii-payload", "ascii-payload", "loc"]);
  assert.ok(parsed[0].detail.includes("2 payload record(s)"));
  assert.equal(parsed[2].detail, "ASCII literal digits '00e-05'");
});

test("an observed family is marked inferred, not calibrated", () => {
  const parsed = parseBinasm(cat(record(0, 0x00150000, 0, 0), record(0, 0x00350000, 0x0C00000E, 0), record(1, 0x00FF0000, 0, 0)));
  assert.deepEqual(parsed.map((r) => r.evidence), ["calibrated", "inferred", "none"]);
  assert.equal(parsed[2].kind, "unknown");
});

test("an unobserved family variant keeps its bits and drops the claim", () => {
  const parsed = parseBinasm(cat(record(0, 0x001C0007, 28, 85), record(0, 0x00160003, 0xFFFFFFFF, 1), record(0, 0x00020009, 0, 0)));
  assert.deepEqual(parsed.map((r) => r.name), ["loc", "table-entry", "globl"]);
  assert.deepEqual(parsed.map((r) => r.evidence), ["inferred", "inferred", "inferred"]);
  assert.ok(parsed[0].detail.includes("flags=0x0007"));
  assert.ok(parsed[1].detail.includes("flags=0x0003"));
  assert.ok(parsed[2].detail.includes("flags=0x0009"));
});

test("an unnamed instruction opcode is not calibrated", () => {
  const parsed = parseBinasm(cat(record(0, 0x001701AE, 0x060D0000, 0xFF), record(0, 0x00170123, 0, 0), record(0, 0x00200000, 99, 0)));
  assert.deepEqual(parsed.map((r) => r.name), ["andi", "instruction-0x0123", "set-unknown-99"]);
  assert.deepEqual(parsed.map((r) => r.evidence), ["calibrated", "inferred", "inferred"]);
});

test("the evidence tally counts only exact observed forms", () => {
  const report = withFile(cat(record(0, 0x001C0000, 28, 85), record(0, 0x001C0007, 28, 85), record(0, 0x00FF0000, 0, 0)), (p) => buildBinasmBoundaryReport(p, { boundary: 0 }));
  assert.deepEqual(report.stream.evidence_counts, { calibrated: 1, inferred: 1, none: 1 });
});

test("peepdbg pairs a replacement with the removed copy", () => {
  const [events, unparsed] = parsePeepdbg(">>Repl_reg (INST 3) 3 with 2\n>>Repl_reg (INST 4) changed to NOP\n>>Peepreg (INST 5) changed rs 2 => 3\n");
  assert.equal(events.length, 3);
  assert.equal(events[0].action, "register-replacement");
  assert.equal(events[1].action, "changed-to-nop");
  assert.equal(events[2].with_register, 3);
  assert.deepEqual(unparsed, []);
});

test("report keeps the downstream probe claim separate from source", () => {
  const report = withFile(cat(record(0, 0x00170062, 0x040D4000, 0), record(0, 0x001701AE, 0x060D0000, 0xFF)), (p) => buildBinasmBoundaryReport(p, {
    boundary: 0x10, probe_results: { results: [{ name: "identity-andi-v1-v1-ff-pre-add", exact: true }, { name: "identity-sll-v1-v1-zero-pre-add", exact: false }] } }));
  const probes = report.barrier_probes;
  assert.equal(probes.exact_count, 1);
  assert.deepEqual(probes.site_counts, { "pre-add": 1 });
  assert.ok(probes.strongest_claim.includes("do not prove a C spelling"));
  assert.equal(report.boundary.after.name, "andi");
});
