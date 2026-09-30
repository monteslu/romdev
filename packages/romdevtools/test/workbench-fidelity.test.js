// Instrumentation fidelity is section-scoped, the gate is stamped, and a
// stamp is re-run rather than trusted. Ported from the workbench's fidelity
// and instrument-gate tests; the objdump is a small fake node program.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { compareObjectFidelity, sectionBytes } from "../src/decomp/workbench/fidelity.js";

const tmp = () => mkdtempSync(path.join(os.tmpdir(), "wb-fidelity-"));

export function makeObjdump(root) {
  const objdump = path.join(root, "objdump");
  writeFileSync(objdump, `#!${process.execPath}
const fs = require("fs");
const argv = process.argv.slice(2);
const obj = argv[argv.length - 1];
const different = fs.readFileSync(obj).includes("different");
if (argv.includes("-s")) { console.log("Contents of section:"); console.log(different ? " 0000 deadbeef" : " 0000 11223344"); }
else if (argv.includes("-r")) { console.log("RELOCATION RECORDS FOR [.text]:"); console.log("00000000 R_MIPS_26 helper"); }
else if (argv.includes("-t")) { console.log("SYMBOL TABLE:"); console.log("00000000 g F .text 00000008 demo"); }
`);
  chmodSync(objdump, 0o755);
  return objdump;
}

test("a debug-only file difference does not fail meaningful sections", () => {
  const d = tmp();
  try {
    const objdump = makeObjdump(d);
    writeFileSync(path.join(d, "stock.o"), "file-a");
    writeFileSync(path.join(d, "instrumented.o"), "file-b");
    const report = compareObjectFidelity(path.join(d, "stock.o"), path.join(d, "instrumented.o"), { objdump });
    assert.equal(report.pass, true);
    assert.equal(report.file_identical, false);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("a meaningful section difference fails the gate", () => {
  const d = tmp();
  try {
    const objdump = makeObjdump(d);
    writeFileSync(path.join(d, "stock.o"), "file-a");
    writeFileSync(path.join(d, "instrumented.o"), "different");
    const report = compareObjectFidelity(path.join(d, "stock.o"), path.join(d, "instrumented.o"), { objdump });
    assert.equal(report.pass, false);
    assert.equal(report.gates[".text"], false);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("the section parser keeps a short tail and stops before ascii", () => {
  const parsed = sectionBytes(' 0000 11223344 55667788 99aabbcc ddee  ."3DUfw.......\n 0010 deadbeef  dead\n');
  assert.ok(parsed.equals(Buffer.from("112233445566778899aabbccddeedeadbeef", "hex")));
});

// instrument-gate: the identity gate, recorded and re-verified.
import { GATE_SCHEMA, InstrumentGateError, buildStamp, gateLines, verifyStamp, writeStamp } from "../src/decomp/workbench/instrument-gate.js";
import { runCommand } from "../src/decomp/workbench/cli.js";

function gateCase(fn) {
  return async () => {
    const root = tmp();
    try {
      const c = { root, objdump: makeObjdump(root), stock: path.join(root, "stock.o"), instrumented: path.join(root, "cdx.o"), failing: path.join(root, "broken.o") };
      writeFileSync(c.stock, "stock object");
      writeFileSync(c.instrumented, "instrumented object");
      writeFileSync(c.failing, "different object");
      c.stamp = (instrumented) => buildStamp({ stock: c.stock, instrumented: instrumented ?? c.instrumented, profile: "uopt-cdx", objdump: c.objdump });
      await fn(c);
    } finally { rmSync(root, { recursive: true, force: true }); }
  };
}
const gateError = (fn, re) => assert.throws(fn, (e) => e instanceof InstrumentGateError && re.test(e.message));

test("a passing gate records both objects and its claim", gateCase((c) => {
  const s = c.stamp();
  assert.equal(s.schema, GATE_SCHEMA);
  assert.equal(s.pass, true);
  assert.equal(s.profile, "uopt-cdx");
  assert.notEqual(s.stock.sha256, s.instrumented.sha256);
  assert.ok(s.claim.includes("says nothing about"));
}));

test("the gate is section-scoped and says so when files differ", gateCase((c) => {
  const lines = gateLines(c.stamp()).join("\n");
  assert.ok(lines.includes("instrument gate: PASS"));
  assert.ok(lines.includes("not file-level reproducible"));
}));

test("a failing gate says the traces are not evidence", gateCase((c) => {
  const s = c.stamp(c.failing);
  assert.equal(s.pass, false);
  assert.ok(gateLines(s).join("\n").includes("not evidence about the stock compiler"));
}));

test("a stamp with no profile cannot be looked up; a missing object is named", gateCase((c) => {
  gateError(() => buildStamp({ stock: c.stock, instrumented: c.instrumented, profile: "  ", objdump: c.objdump }), /--profile names which instrumented pass/);
  gateError(() => buildStamp({ stock: path.join(c.root, "nowhere.o"), instrumented: c.instrumented, profile: "uopt-cdx", objdump: c.objdump }), /does not build/);
}));

test("a stamp is never written into a directory nobody named", gateCase((c) => {
  gateError(() => writeStamp(c.stamp(), { path: path.join(c.root, "gates", "uopt.json") }), /does not exist/);
}));

test("a rerun that agrees passes; a changed or gone object is stale", gateCase((c) => {
  const p = writeStamp(c.stamp(), { path: path.join(c.root, "uopt-cdx.json") });
  const ok = verifyStamp(p, { objdump: c.objdump });
  assert.equal(ok.verification, "AGREES");
  assert.equal(ok.pass, true);
  writeFileSync(c.instrumented, "different object");
  const changed = verifyStamp(p, { objdump: c.objdump });
  assert.equal(changed.verification, "STALE");
  assert.equal(changed.pass, false);
  assert.ok(changed.findings[0].includes("has changed since the stamp"));
  rmSync(c.stock);
  const gone = verifyStamp(p, { objdump: c.objdump });
  assert.equal(gone.verification, "STALE");
  assert.ok(gone.findings[0].includes("is gone"));
}));

test("a stamp of another schema is refused", gateCase((c) => {
  const p = path.join(c.root, "other.json");
  writeFileSync(p, JSON.stringify({ schema: "something-else" }));
  gateError(() => verifyStamp(p), new RegExp(GATE_SCHEMA));
}));

test("the command stamps and names the file; a failing gate exits one", gateCase(async (c) => {
  const target = path.join(c.root, "uopt-cdx.json");
  const r = await runCommand(["instrument", "gate", "--stock", c.stock, "--instrumented", c.instrumented, "--profile", "uopt-cdx", "--stamp", target, "--objdump", c.objdump]);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.stdout.includes(`stamped: ${target}`));
  assert.ok(readFileSync(target, "utf8").length);
  const f = await runCommand(["instrument", "gate", "--stock", c.stock, "--instrumented", c.failing, "--profile", "uopt-cdx", "--objdump", c.objdump]);
  assert.equal(f.code, 1);
  assert.ok(f.stdout.includes("instrument gate: FAIL"));
}));

test("neither pair nor stamp explains both spellings; verify reports JSON under its schema", gateCase(async (c) => {
  const r = await runCommand(["instrument", "gate"]);
  assert.equal(r.code, 2);
  assert.ok(r.stderr.includes("--stock OBJ --instrumented OBJ"));
  assert.ok(r.stderr.includes("--verify STAMP"));
  const target = writeStamp(c.stamp(), { path: path.join(c.root, "uopt-cdx.json") });
  const v = await runCommand(["instrument", "gate", "--verify", target, "--objdump", c.objdump, "--json"]);
  assert.equal(v.code, 0);
  const payload = JSON.parse(v.stdout);
  assert.equal(payload.schema, GATE_SCHEMA);
  assert.equal(payload.verification, "AGREES");
}));

test("the fidelity command gates and exits by its verdict", gateCase(async (c) => {
  const pass = await runCommand(["instrument", "fidelity", c.stock, c.instrumented, "--objdump", c.objdump]);
  assert.equal(pass.code, 0);
  assert.ok(pass.stdout.includes("object fidelity: PASS"));
  assert.ok(pass.stdout.includes("whole-file metadata differs"));
  const fail = await runCommand(["fidelity", c.stock, c.failing, "--objdump", c.objdump, "--json"]);
  assert.equal(fail.code, 1);
  assert.equal(JSON.parse(fail.stdout).gates[".text"], false);
}));
