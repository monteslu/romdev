// Ported from the workbench's input-diagnostics tests: what the tool says
// about its own inputs before it says anything about code. Subprocess cases
// run against stand-in objdump scripts.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { anonymousSingleFunction, crossFunctionWarning, dumpObject, parseDisassembly, scrubControlCharacters, strippedSymbolFallbackWarning,
  symbolLabels, symbolSelectionError } from "../src/decomp/workbench/objdump.js";
import { runCli } from "./fixtures/workbench/cli-run.js";

const ONE = "\n00000000 <drawObject>:\n   0: 27bdffe0  addiu $sp,$sp,-32\n   4: 24020021  li $v0,33\n   8: 03e00008  jr $ra\n   c: 00000000  nop\n";
const OTHER = "\n00000000 <drawShadow>:\n   0: 27bdffe0  addiu $sp,$sp,-32\n   4: 24020031  li $v0,49\n   8: 03e00008  jr $ra\n   c: 00000000  nop\n";
const TWO_LABELS = "\n00000000 <drawObject>:\n   0: 24020021  li $v0,33\n00000004 <drawShadow>:\n   4: 03e00008  jr $ra\n   8: 00000000  nop\n";
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "romdev-wb-input-"));
function pair(t, c) {
  const d = tmp(), tp = path.join(d, "target.objdump"), cp = path.join(d, "candidate.objdump");
  fs.writeFileSync(tp, t); fs.writeFileSync(cp, c);
  return [tp, cp];
}

/** A stand-in objdump: `filtered` answers --disassemble=, `section` answers the rest; calls are counted. */
function scriptedObjdump({ filtered = "", section = "", failSection = null, failFor = null }) {
  const d = tmp(), exe = path.join(d, "od"), calls = path.join(d, "calls");
  fs.writeFileSync(exe, `#!${process.execPath}
const fs = require("fs");
fs.appendFileSync(${JSON.stringify(calls)}, "x");
const argv = process.argv.slice(2);
const target = argv.filter((a) => !a.startsWith("-") && a !== ".text").pop() ?? "";
${failFor ? `if (target.includes(${JSON.stringify(failFor)})) { process.stderr.write("objdump: '" + target + "': No such file\\n"); process.exit(1); }` : ""}
if (argv.some((a) => a.startsWith("--disassemble="))) { process.stdout.write(${JSON.stringify(filtered)}); process.exit(0); }
${failSection !== null ? `process.stderr.write(${JSON.stringify(failSection)}); process.exit(1);` : `process.stdout.write(${JSON.stringify(section)});`}
`, { mode: 0o755 });
  return { exe, calls: () => (fs.existsSync(calls) ? fs.readFileSync(calls, "utf8").length : 0), dir: d };
}

test("cross-function warning: different single names warn; same name, several labels and an explicit selector do not", () => {
  const w = crossFunctionWarning(ONE, OTHER, { symbol: null });
  for (const s of ["'drawObject'", "'drawShadow'", "positionally", "Pass --function"]) assert.ok(w.includes(s), s);
  assert.equal(crossFunctionWarning(ONE, ONE, { symbol: null }), null);
  assert.equal(crossFunctionWarning(TWO_LABELS, ONE, { symbol: null }), null);
  assert.equal(crossFunctionWarning(ONE, TWO_LABELS, { symbol: null }), null);
  assert.equal(crossFunctionWarning(ONE, OTHER, { symbol: "drawObject" }), null);
  assert.ok(crossFunctionWarning(ONE, OTHER, { symbol: null, section: ".rodata" }).includes(".rodata section"));
  assert.deepEqual([...symbolLabels(TWO_LABELS)], ["drawObject", "drawShadow"]);
  assert.deepEqual([...symbolLabels("   0: 24020021  li $v0,33\n")], []);
});

async function assertWarns(command) {
  const pager = command === "compare-dumps" ? [] : ["--pager", "never"];
  const [status, out] = await runCli([command, ...pair(ONE, OTHER), ...pager]);
  assert.equal(status, 0); assert.ok(out.includes("warning: target defines 'drawObject'"), command);
  return out;
}

test("the warning reaches every renderer ahead of the verdict, once, and JSON consumers see it", async () => {
  let out = await assertWarns("compare-dumps");
  assert.ok(out.indexOf("warning:") < out.indexOf("verdict="));
  out = await assertWarns("view-dumps");
  assert.ok(out.indexOf("warning:") < out.indexOf("verdict:"));
  out = await assertWarns("diagnose-dumps");
  assert.equal(out.split("warning: target defines").length - 1, 1); assert.ok(out.indexOf("warning:") < out.indexOf("COMPARISON"));
  const [, json] = await runCli(["compare-dumps", ...pair(ONE, OTHER), "--json"]);
  const p = JSON.parse(json);
  assert.equal(p.warnings.length, 1); assert.ok(p.warnings[0].includes("drawShadow"));
  const [status, quiet] = await runCli(["compare-dumps", ...pair(ONE, ONE)]);
  assert.equal(status, 0); assert.ok(!quiet.includes("warning:"));
});

test("symbol selection errors: a case slip shows the name that exists; long lists elide; no selector names the expected shape", () => {
  const m = symbolSelectionError("DrawObject", { inputs: [["target.objdump", ONE], ["candidate.objdump", OTHER]] });
  for (const s of ["'DrawObject' produced no instructions", "target.objdump defines: drawObject", "candidate.objdump defines: drawShadow", "Names are case-sensitive.",
    "docs/troubleshooting.md#objdump-produced-no-instructions"]) assert.ok(m.includes(s), s);
  const text = Array.from({ length: 12 }, (_, i) => `0000000${i} <func_${i}>:\n   ${i}: 24020021  li $v0,33\n`).join("");
  const big = symbolSelectionError("missing", { inputs: [["big.objdump", text]] });
  assert.ok(big.includes("func_0")); assert.ok(big.includes("(+4 more)")); assert.ok(!big.includes("func_9"));
  const none = symbolSelectionError(null, { inputs: [["notes.txt", "hello\n"]] });
  assert.ok(none.includes("no GNU-style objdump instruction lines in notes.txt")); assert.ok(none.includes("lw t9"));
});

test("every text command uses the selection error", async () => {
  for (const command of ["compare-dumps", "view-dumps", "diagnose-dumps"]) {
    const [status, , err] = await runCli([command, ...pair(ONE, OTHER), "--function", "DrawObject"]);
    assert.equal(status, 2, command); assert.ok(err.includes("Names are case-sensitive."), command); assert.ok(err.includes("defines: drawObject"), command);
  }
});

test("control characters do not survive parsing; tabs are kept; no NUL reaches the JSON stream", async () => {
  const ins = parseDisassembly("00000000 <demo>:\n   0: 03e00008  jr\x00 $ra\x07\n");
  assert.equal(ins.length, 1); assert.equal(ins[0].assembly, "jr $ra");
  assert.equal(scrubControlCharacters("jr\t$ra"), "jr\t$ra");
  const dump = "00000000 <demo>:\n   0: 03e00008  jr\x00 $ra\n";
  const [status, out] = await runCli(["compare-dumps", ...pair(dump, dump), "--json"]);
  assert.equal(status, 0); assert.ok(!out.includes("\x00")); assert.ok(!out.includes("\\u0000")); JSON.parse(out);
});

const STRIPPED = "\n00000000 <.text>:\n   0: 27bdffe0  addiu $sp,$sp,-32\n   4: 03e00008  jr $ra\n   8: 00000000  nop\n";
const NAMED = "\n00000000 <drawObject>:\n   0: 27bdffe0  addiu $sp,$sp,-32\n   4: 03e00008  jr $ra\n   8: 00000000  nop\n";

test("a stripped export: recognized, falls back to the whole section, says so; a named object gets no fallback", () => {
  assert.equal(anonymousSingleFunction(STRIPPED), true); assert.equal(anonymousSingleFunction(NAMED), false);
  assert.equal(anonymousSingleFunction(""), false); assert.equal(anonymousSingleFunction("   0: 03e00008  jr $ra\n"), false);
  const od = scriptedObjdump({ section: STRIPPED });
  const [, instructions] = dumpObject("export/target.o", { objdump: od.exe, symbol: "drawObject", cwd: od.dir });
  assert.equal(instructions.length, 3);
  const w = strippedSymbolFallbackWarning(STRIPPED, { symbol: "drawObject", name: "target.o" });
  for (const s of ["no symbol for 'drawObject'", "decomp.me export", "whole .text section positionally"]) assert.ok(w.includes(s), s);
  assert.equal(strippedSymbolFallbackWarning(NAMED, { symbol: "drawObject", name: "target.o" }), null);
  assert.equal(strippedSymbolFallbackWarning(STRIPPED, { symbol: null, name: "target.o" }), null);
  const named = scriptedObjdump({ section: NAMED });
  assert.throws(() => dumpObject("export/target.o", { objdump: named.exe, symbol: "drawShadow", cwd: named.dir }), /produced no instructions/);
});

test("the fallback warning reaches compare ahead of the verdict", async () => {
  const [status, out] = await runCli(["compare-dumps", ...pair(STRIPPED, NAMED), "--function", "drawObject"]);
  assert.equal(status, 0); assert.ok(out.includes("has no symbol for 'drawObject'")); assert.ok(out.indexOf("warning:") < out.indexOf("verdict="));
});

const SECTION = "\n00000000 <funcA>:\n   0: 27bdffe0  addiu $sp,$sp,-32\n   4: 03e00008  jr $ra\n   8: 00000000  nop\n\n0000000c <funcB>:\n   c: 03e00008  jr $ra\n";

test("one unfiltered second pass serves both the case fold and the defines list", () => {
  let od = scriptedObjdump({ section: SECTION });
  const [, ins] = dumpObject("build/foo.o", { objdump: od.exe, symbol: "FuncA", cwd: od.dir });
  assert.equal(ins.length, 3); assert.equal(od.calls(), 2);
  od = scriptedObjdump({ section: SECTION });
  assert.throws(() => dumpObject("build/foo.o", { objdump: od.exe, symbol: "drawShadow", cwd: od.dir }),
    (e) => e.message.includes("symbol 'drawShadow' produced no instructions") && e.message.includes("defines: funcA, funcB") && !e.message.includes("no symbols") && e.message.includes("Names are case-sensitive."));
  assert.equal(od.calls(), 2);
  od = scriptedObjdump({ section: SECTION.replace("funcB", "FUNCA") });
  assert.throws(() => dumpObject("build/foo.o", { objdump: od.exe, symbol: "funca", cwd: od.dir }), /defines: funcA, FUNCA/);
  assert.equal(od.calls(), 2);
});

test("no selector does not pay for a retry; a failing retry falls back to what we had", () => {
  let od = scriptedObjdump({ section: "nothing here\n" });
  assert.throws(() => dumpObject("build/foo.o", { objdump: od.exe, cwd: od.dir }));
  assert.equal(od.calls(), 1);
  od = scriptedObjdump({ failSection: "boom" });
  assert.throws(() => dumpObject("build/foo.o", { objdump: od.exe, symbol: "FuncA", cwd: od.dir }), /produced no instructions/);
});

test("objdump failures: an unrecognized format names the cause; others are quoted in full; silence still produces a sentence", () => {
  let od = scriptedObjdump({ failSection: "objdump: build/foo.o: file format not recognized\nobjdump: build/foo.o: Bad value\n" });
  assert.throws(() => dumpObject("build/foo.o", { objdump: od.exe, cwd: od.dir }), (e) => e.message.includes("does not look like a compiled MIPS ELF object")
    && e.message.includes("that the build actually produced an object file") && e.message.includes("  objdump: build/foo.o: file format not recognized")
    && e.message.includes("  objdump: build/foo.o: Bad value"));
  od = scriptedObjdump({ failSection: "objdump: section '.text' not found\n" });
  assert.throws(() => dumpObject("build/foo.o", { objdump: od.exe, cwd: od.dir }), (e) => !e.message.includes("does not look like") && e.message.includes("  objdump: section '.text' not found"));
  od = scriptedObjdump({ failSection: "" });
  assert.throws(() => dumpObject("build/foo.o", { objdump: od.exe, cwd: od.dir }), /no output/);
});

test("a missing candidate stops the run: exit two, the path named, one JSON error document, rank reports it", async () => {
  const od = scriptedObjdump({ section: ONE, failFor: "nonexistent" });
  let [status, out, err] = await runCli(["compare", "target.o", "/nonexistent/candidate.o", "--objdump", od.exe], { cwd: od.dir });
  assert.equal(status, 2); assert.ok(err.includes("error:")); assert.ok(err.includes("/nonexistent/candidate.o")); assert.equal(out, "");
  [status, out] = await runCli(["compare", "target.o", "/nonexistent/candidate.o", "--objdump", od.exe, "--json"], { cwd: od.dir });
  assert.equal(status, 2);
  const doc = JSON.parse(out);
  assert.equal(doc.schema, "decomp-workbench-error-v1"); assert.equal(doc.error.kind, "not-found");
  assert.ok(doc.error.message.includes("/nonexistent/candidate.o")); assert.ok(!("exact" in doc));
  [status, out, err] = await runCli(["compare-dumps", "/nonexistent/target.objdump", "/nonexistent/c.objdump"]);
  assert.equal(status, 2); assert.ok(err.includes("/nonexistent/target.objdump")); assert.equal(out, "");
  [status, out] = await runCli(["rank", "target.o", "/nonexistent/a.o", "--objdump", od.exe, "--json"], { cwd: od.dir });
  assert.deepEqual(JSON.parse(out).errors.map((e) => e.candidate), ["/nonexistent/a.o"]); assert.notEqual(status, 0);
});

test("an existing but unreadable candidate is not read as an empty one", async () => {
  const od = scriptedObjdump({ failSection: "objdump: file format not recognized\n" });
  const candidate = path.join(od.dir, "candidate.o");
  fs.writeFileSync(candidate, "not an object\n");
  const [status, out, err] = await runCli(["compare", "target.o", candidate, "--objdump", od.exe], { cwd: od.dir });
  assert.equal(status, 2); assert.ok(err.includes("MIPS ELF object")); assert.equal(out, "");
});
