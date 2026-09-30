// Ported from the workbench's force-rows, relocation-alias and collateral
// tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assemble } from "./fixtures/workbench/mips-asm.js";
import { parseDisassembly } from "../src/decomp/workbench/objdump.js";
import { buildForceRows, groupMovedRuns } from "../src/decomp/workbench/force-rows.js";
import { buildView } from "../src/decomp/workbench/view.js";
import { relocationAliasReport } from "../src/decomp/workbench/relocation-alias.js";
import { compareObjectCollateral } from "../src/decomp/workbench/collateral.js";
import { runCli } from "./fixtures/workbench/cli-run.js";

const PROLOGUE = ["addiu sp,sp,-32", "sw ra,28(sp)", "sw s0,24(sp)", "move s0,a0"];
const EPILOGUE = ["lw ra,28(sp)", "lw s0,24(sp)", "jr ra", "addiu sp,sp,32"];
const BODY = ["li v0,33", "addu v1,v0,s0", "lw t7,8(s0)", "addu a0,t7,v1", "sw a0,4(s0)"];
const BASELINE = [...PROLOGUE, ...BODY, ...EPILOGUE];
const FORCED = [...PROLOGUE, "li v0,33", "addu v1,v0,s0", "lw t8,8(s0)", "addu a0,t8,v1", "sw a0,4(s0)", ...EPILOGUE];
const TARGET = [...PROLOGUE, "nop", ...BODY, ...EPILOGUE];
const ins = (rows) => parseDisassembly(assemble(rows, { symbol: "demo" }), { symbol: "demo" });
const view = (forced) => buildView(ins(BASELINE), ins(forced), { target_name: "baseline", candidate_name: "forced" });
const build = (forced, extra = {}) => buildForceRows(ins(BASELINE), ins(forced), { force: "p1:w9=c30", baseline_name: "baseline.o", forced_name: "forced.o", ...extra });

test("run grouping: a short matched stretch stays inside one run; gap zero is strictly contiguous; negative gaps are refused", () => {
  assert.deepEqual(groupMovedRuns(view(FORCED), { gap: 3 }), [[6, 7]]);
  const forced = [...PROLOGUE, "li v0,34", "addu v1,v0,s0", "lw t8,8(s0)", "addu a0,t8,v1", "sw a0,4(s0)", ...EPILOGUE];
  assert.deepEqual(groupMovedRuns(view(forced), { gap: 0 }), [[4, 4], [6, 7]]);
  assert.deepEqual(groupMovedRuns(view(forced), { gap: 3 }), [[4, 7]]);
  assert.throws(() => groupMovedRuns(view(FORCED), { gap: -1 }), /negative/);
});

test("moved rows are grouped and counted; an unchanged build is byte-inert", () => {
  const r = build(FORCED);
  assert.equal(r.inert, false); assert.equal(r.moved_rows, 2); assert.equal(r.runs.length, 1);
  assert.deepEqual([r.runs[0].start, r.runs[0].end], [6, 7]); assert.deepEqual([r.runs[0].baseline_start, r.runs[0].baseline_end], [6, 7]);
  const inert = build(BASELINE);
  assert.equal(inert.inert, true); assert.equal(inert.moved_rows, 0); assert.deepEqual(inert.runs, []);
});

test("a changed instruction count is aligned, not zipped; the target join uses the published row numbers", () => {
  const r = build([...PROLOGUE, "nop", ...BODY, ...EPILOGUE]);
  assert.equal(r.moved_rows, 1); assert.equal(r.runs.length, 1);
  assert.ok(r.warnings.some((w) => w.includes("changed the instruction count")));
  const t = build(FORCED, { target: ins(TARGET), target_name: "target.o" }).runs[0];
  assert.equal(t.baseline_start, 6); assert.equal(t.compare_start, 7);
  assert.ok(t.target_text.includes("lw")); assert.ok(t.target_text.includes("t7"));
});

async function forceRowsCommand(flags, forced = FORCED) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "romdev-wb-force-"));
  const paths = [["baseline", BASELINE], ["forced", forced], ["target", TARGET]].map(([name, rows]) => {
    const p = path.join(root, `${name}.objdump`); fs.writeFileSync(p, assemble(rows, { symbol: "demo" })); return p;
  });
  const [status, stdout, stderr] = await runCli(["force-rows-dumps", paths[0], paths[1], ...flags]);
  return [status, stdout + stderr];
}

test("force-rows-dumps: runs with evidence, inert controls say so, unqualified forces are refused, JSON publishes the schema", async () => {
  let [status, out] = await forceRowsCommand(["--force", "p1:w9=c30"]);
  assert.equal(status, 0, out); assert.ok(out.includes("force=p1:w9=c30")); assert.ok(out.includes("rows 6-7")); assert.ok(out.includes("baseline:"));
  [status, out] = await forceRowsCommand(["--force", "p1:w9=s"], BASELINE);
  assert.equal(status, 0, out); assert.ok(out.includes("BYTE-INERT")); assert.ok(out.includes("evidence, not a failed run"));
  [status, out] = await forceRowsCommand(["--force", "w9=c30"]);
  assert.equal(status, 2); assert.ok(out.includes("phase-qualified"));
  [status, out] = await forceRowsCommand(["--force", "p2:w55=c2", "--json"]);
  assert.equal(status, 0, out);
  const payload = JSON.parse(out);
  assert.equal(payload.schema, "decomp-workbench-force-rows-v1"); assert.equal(payload.force, "p2:w55=c2"); assert.equal(payload.inert, false);
  assert.equal(payload.runs[0].start, 6);
});

// relocation aliases

const RT = "\n0: 3c010000  lui $at,0\n                  0: R_MIPS_HI16 next_symbol\n";
const RC = "\n0: 3c010000  lui $at,0\n                  0: R_MIPS_HI16 array+0x20\n";
const sym = (o) => new Map(Object.entries(o));

test("the same linked address is reported without claiming exactness; an unknown symbol stays unresolved", () => {
  const r = relocationAliasReport(parseDisassembly(RT), parseDisassembly(RC), { symbols: sym({ next_symbol: 0x80400020, array: 0x80400000 }) });
  assert.equal(r.alias_count, 1); assert.equal(r.resolved_address_aliases[0].resolved_address, 0x80400020); assert.ok(r.proof.includes("link or ROM check"));
  const u = relocationAliasReport(parseDisassembly(RT), parseDisassembly(RC), { symbols: sym({ array: 0x80400000 }) });
  assert.equal(u.alias_count, 0); assert.equal(u.unresolved_spelling_differences.length, 1);
});

test("kind and cardinality differences are never hidden", () => {
  const k = relocationAliasReport(parseDisassembly(RT), parseDisassembly(RC.replace("R_MIPS_HI16", "R_MIPS_LO16")), { symbols: sym({ next_symbol: 0x80400020, array: 0x80400000 }) });
  assert.equal(k.alias_count, 0); assert.equal(k.unresolved_spelling_differences.length, 1);
  const m = relocationAliasReport(parseDisassembly(RT), parseDisassembly("0: 3c010000  lui $at,0\n"), { symbols: sym({ next_symbol: 0x80400020 }) });
  assert.equal(m.unresolved_spelling_differences.length, 1); assert.equal(m.unresolved_spelling_differences[0].candidate, null);
});

// object collateral

function collateralObjdump(root) {
  const exe = path.join(root, "objdump");
  fs.writeFileSync(exe, `#!${process.execPath}
const fs = require("fs");
const argv = process.argv.slice(2);
const obj = argv[argv.length - 1];
const bytes = fs.existsSync(obj) ? fs.readFileSync(obj, "latin1") : "";
const changed = bytes.includes("changed"), partial = bytes.includes("partial");
const out = [];
if (argv.includes("-h")) {
  out.push("Idx Name Size VMA LMA File off Algn");
  out.push("  0 .text " + (partial ? "00000010" : "00000008") + " 00000000 00000000 00000040 2**4");
  out.push("                  CONTENTS, ALLOC, LOAD, CODE");
  out.push("  1 .bss " + (changed ? "00000020" : "00000010") + " 00000000 00000000 00000048 2**4");
  out.push("                  ALLOC");
} else if (argv.includes("-s")) { out.push("Contents of section .text:"); out.push(" 0000 11223344 55667788"); }
else if (argv.includes("-d")) { out.push("", "00000000 <demo>:", "   0: 03e00008  jr $ra", "   4: 00000000  nop"); }
else if (argv.includes("-r")) { out.push("RELOCATION RECORDS FOR [.text]:"); out.push("00000000 R_MIPS_26 helper"); }
else if (argv.includes("-t")) { out.push("SYMBOL TABLE:"); out.push("00000000 g F .text 00000008 demo"); }
process.stdout.write(out.join("\\n") + "\\n");
`, { mode: 0o755 });
  return exe;
}

function collateralPair(candidateBytes) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "romdev-wb-collateral-"));
  const objdump = collateralObjdump(root);
  fs.writeFileSync(path.join(root, "reference.o"), "reference");
  fs.writeFileSync(path.join(root, "candidate.o"), candidateBytes);
  return { root, objdump, reference: path.join(root, "reference.o"), candidate: path.join(root, "candidate.o") };
}

test("a zero-fill size change is reported without section contents", () => {
  const { objdump, reference, candidate } = collateralPair("changed");
  const r = compareObjectCollateral(reference, candidate, { objdump });
  assert.equal(r.collateral_detected, true); assert.equal(r.classification, "translation-unit-difference");
  assert.equal(r.section_change_count, 1); assert.equal(r.section_changes[0].section, ".bss");
  assert.equal(r.section_changes[0].size_delta, 16); assert.deepEqual(r.section_changes[0].changed, ["size"]);
});

test("an incomplete section dump is refused", () => {
  const { objdump, reference, candidate } = collateralPair("partial");
  assert.throws(() => compareObjectCollateral(reference, candidate, { objdump }), /returned 8 of 16 byte/);
});

test("the command can fail a collateral gate", async () => {
  const { objdump, reference, candidate } = collateralPair("changed");
  const [status] = await runCli(["object-collateral", reference, candidate, "--objdump", objdump, "--fail-on-collateral"]);
  assert.equal(status, 1);
});

test("an exact selected function classifies the remaining changes as collateral", () => {
  const { objdump, reference, candidate } = collateralPair("changed");
  const r = compareObjectCollateral(reference, candidate, { symbol: "demo", objdump });
  assert.equal(r.selected_function_exact, true); assert.equal(r.classification, "outside-selected-function");
});
