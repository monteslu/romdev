// Ucode XJP dispatch decoding on a synthesized stream built from the
// published record formats (ucode.h / uini.c widths): selector postfix
// slice, case table, default label, trampoline chains, and the Uldc integer
// constant members. No real compilation is used.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { OPCODE_NAMES, buildUcodeXjpReport, parseUcode } from "../src/decomp/workbench/ucode.js";
import { uword } from "./fixtures/workbench/phase-streams.js";
import { runCommand } from "../src/decomp/workbench/cli.js";

const hdr = (name, { dtype = 6, mtype = 3, lexlev = 0 } = {}) => ((OPCODE_NAMES.indexOf(name) << 24) | (mtype << 21) | (dtype << 16) | lexlev) >>> 0;
const rec = (name, words, opts) => uword(hdr(name, opts), ...words);

// lod (4 words) -> ldc Jdt 5 (4 + 2 constant words) -> add -> xjp L10 default L11 range 2..4
// clab L10 x3 -> ujp L20, ujp L21, ujp L22; L20: ujp L30 (trampoline); L30: ret
function stream() {
  return Buffer.concat([
    rec("lod", [7, 16, 4]),
    rec("ldc", [0, 4, 0, 5, 0xDEADBEEF]),
    rec("add", [0]),
    rec("xjp", [10, 11, 0, 0, 2, 0, 4]),
    rec("clab", [10, 3, 0]),
    rec("ujp", [20]), rec("ujp", [21]), rec("ujp", [22]),
    rec("lab", [20, 0, 0]), rec("ujp", [30]),
    rec("lab", [21, 0, 0]), rec("ret", [0]),
    rec("lab", [30, 0, 0]), rec("loc", [99]), rec("ret", [0]),
  ]);
}

test("records frame by their declared widths", () => {
  const records = parseUcode(stream());
  assert.deepEqual(records.map((r) => r.name), ["lod", "ldc", "add", "xjp", "clab", "ujp", "ujp", "ujp", "lab", "ujp", "lab", "ret", "lab", "loc", "ret"]);
  const ldc = records[1];
  assert.equal(ldc.integer_constant, 5);
  assert.equal(ldc.detail, "constant=5 length=4 inactive-word=0xdeadbeef");
  assert.equal(records[3].lower_bound, 2);
  assert.equal(records[3].upper_bound, 4);
});

test("the XJP report recovers the selector, the table and trampoline chains", () => {
  const d = mkdtempSync(path.join(os.tmpdir(), "wb-ucode-"));
  try {
    const p = path.join(d, "unit.U");
    writeFileSync(p, stream());
    const report = buildUcodeXjpReport(p);
    assert.equal(report.dispatch_count, 1);
    const x = report.dispatches[0];
    assert.equal(x.case_table_label, 10);
    assert.equal(x.default_label, 11);
    assert.equal(x.range_size, 3);
    assert.deepEqual(x.selector_expression.map((r) => r.name), ["Ulod", "Uldc", "Uadd"]);
    assert.equal(x.selector_expression_complete, true);
    assert.equal(x.case_table_complete, true);
    assert.deepEqual(x.cases.map((c) => [c.value, c.target_chain.labels, c.target_chain.status]),
      [[2, [20, 30], "trampoline"], [3, [21], "direct"], [4, [22], "missing-label"]]);
    assert.equal(x.trampoline_case_count, 1);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("inspect-ucode renders the table and flags a Binasm-shaped input", async () => {
  const d = mkdtempSync(path.join(os.tmpdir(), "wb-ucode-"));
  try {
    const p = path.join(d, "unit.U");
    writeFileSync(p, stream());
    const r = await runCommand(["pass", "ucode", p]);
    assert.equal(r.code, 0);
    assert.ok(r.stdout.includes("XJP dispatches: 1"));
    assert.ok(r.stdout.includes("2->L20->L30, 3->L21, 4->L22"));
    assert.ok(r.stdout.includes("trampoline targets: 1/3"));
    const g = path.join(d, "unit.G");
    writeFileSync(g, Buffer.concat(Array(4).fill(uword(0, 0x00150000, 0, 0).subarray(0)).map((b, i) => (i === 0 ? uword(0xff000000, 0x00150000, 0, 0) : b))));
    const bad = await runCommand(["inspect-ucode", g]);
    assert.equal(bad.code, 2);
    assert.ok(bad.stderr.includes("appears to be fixed 16-byte Binasm"));
  } finally { rmSync(d, { recursive: true, force: true }); }
});
