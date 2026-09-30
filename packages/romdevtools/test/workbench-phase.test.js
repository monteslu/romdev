// Ported from the workbench's phase tests: slot partitions, ring cosets,
// evidence thresholds, context and baseline, shift tolerance and the
// `phase-dumps` command.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assemble } from "./fixtures/workbench/mips-asm.js";
import { parseDisassembly } from "../src/decomp/workbench/objdump.js";
import { DEFAULT_RING, Coset, PhaseError, Slot, buildPhaseReport, cosetWarning, parseRing, parseSlots, phaseLines, ringCosets, validatePartition } from "../src/decomp/workbench/phase.js";
import { buildShiftDiff } from "../src/decomp/workbench/shift-align.js";
import { runCli } from "./fixtures/workbench/cli-run.js";

const SYMBOL = "demo";
const PROLOGUE = ["addiu sp,sp,-32", "sw ra,28(sp)"];
const EPILOGUE = ["lw ra,28(sp)", "jr ra", "addiu sp,sp,32"];
const ROTATION = { f4: "f8", f6: "f10", f8: "f4", f10: "f6" };

function floatTraffic(count) {
  const registers = DEFAULT_RING.map((n) => n.replace(/^\$/, ""));
  return Array.from({ length: count }, (_, i) => `${i % 2 === 0 ? "lwc1" : "swc1"} ${registers[i % registers.length]},${(i % 12) * 4}(sp)`);
}
function rotate(lines) {
  return lines.map((line) => { const i = line.indexOf(" "); const op = line.slice(0, i); return `${op} ${line.slice(i + 1).split(",").map((p) => ROTATION[p] ?? p).join(",")}`; });
}
const body = (...ins) => [...PROLOGUE, ...ins, ...EPILOGUE];
const rows = (lines) => parseDisassembly(assemble(lines, { symbol: SYMBOL }), { symbol: SYMBOL });
function report(target, candidate, opts = {}) {
  const l = rows(target), r = rows(candidate);
  return buildPhaseReport(l, r, { shift: buildShiftDiff(l, r), ...opts });
}

test("a hole names the rows it would have swallowed", () => {
  const table = parseSlots("B1=7..1573,B2=1574..2038,W=2039..2110,B3=2111..3233,IR=3235..3284,CP=3388..3402,MD=3405..3450,RS=3451..4633");
  assert.throws(() => validatePartition(table, { first: 0, last: 4640 }), (e) => e instanceof PhaseError
    && ["belong to no slot", "3285..3387 (103 row(s))", "3403..3404", "0..6"].every((s) => e.message.includes(s)));
});

test("an overlap is an error because it counts a row twice", () => {
  assert.throws(() => validatePartition([new Slot({ name: "a", start: 0, stop: 10 }), new Slot({ name: "b", start: 8, stop: 20 })], { first: 0, last: 20 }), /overlap at rows 8\.\.10/);
});

test("the default slot table cannot have a hole; a malformed slot says how to write one", () => {
  const item = report(body(...floatTraffic(12)), body(...floatTraffic(12)));
  assert.equal(item.slots.length, 1); assert.equal(item.slots[0].slot.start, 0); assert.equal(item.slots[0].slot.stop, item.target_rows - 1);
  assert.throws(() => parseSlots("B1=7-1573"), /NAME=LO\.\.HI/);
});

test("coset families: paired is four, all is every permutation, identity first", () => {
  const paired = ringCosets(DEFAULT_RING, { family: "paired" });
  assert.equal(paired.length, 4); assert.ok(paired[0].is_identity);
  const all = ringCosets(DEFAULT_RING, { family: "all" });
  assert.equal(all.length, 24); assert.ok(all[0].is_identity);
});

test("a rotated candidate reports its coset and both counts, never a bare free count", () => {
  const traffic = floatTraffic(24);
  const item = report(body(...traffic), body(...rotate(traffic)));
  const [slot] = item.slots;
  assert.equal(slot.coset.is_identity, false); assert.equal(slot.quotiented, 0); assert.equal(slot.positional, traffic.length);
  assert.equal(item.quotiented_is_bare, false);
  const text = phaseLines(item).join("\n");
  assert.ok(text.includes("free=0 [COSET")); assert.ok(text.includes(`positional ${item.positional}]`));
  assert.ok((cosetWarning(item) ?? "").includes("COSET:"));
});

test("an identity candidate prints free without a caveat", () => {
  const traffic = floatTraffic(24);
  const item = report(body(...traffic), body(...traffic));
  assert.equal(item.quotiented_is_bare, true);
  assert.ok(phaseLines(item).join("\n").includes("every slot at the identity coset"));
  assert.equal(cosetWarning(item), null);
});

test("each slot carries its own coset", () => {
  const first = floatTraffic(12), second = floatTraffic(12);
  const target = body(...first, ...second), candidate = body(...first, ...rotate(second));
  const last = rows(target).length - 1;
  const item = report(target, candidate, { slots: [new Slot({ name: "head", start: 0, stop: 13 }), new Slot({ name: "tail", start: 14, stop: last })] });
  const [head, tail] = item.slots;
  assert.ok(head.coset.is_identity); assert.equal(tail.coset.is_identity, false); assert.equal(item.phase_vector[0], "id");
});

test("rings: any register pool; no substring rewrite; at least two; unknown names both examples", () => {
  assert.deepEqual(parseRing("$t6,$t7,$t8,$t9"), ["$t6", "$t7", "$t8", "$t9"]);
  assert.deepEqual(parseRing("f4, f6"), ["$f4", "$f6"]);
  const coset = new Coset({ ring: ["$f1", "$f2"], image: ["$f2", "$f1"] });
  assert.equal(coset.apply("lwc1 $f10,8($sp)"), "lwc1 $f10,8($sp)");
  assert.equal(coset.apply("lwc1 $f1,8($sp)"), "lwc1 $f2,8($sp)");
  assert.throws(() => parseRing("$f4"), /at least two registers/);
  assert.throws(() => parseRing("$q9"), (e) => e.message.includes("$f4,$f6,$f8,$f10") && e.message.includes("$t6,$t7,$t8,$t9"));
});

test("a slot with no ring evidence is not labelled identity; min-evidence raises the bar without improving the score", () => {
  const target = body(...Array.from({ length: 12 }, (_, i) => `addiu t0,t0,${i}`));
  const [slot] = report(target, target).slots;
  assert.equal(slot.informative, 0); assert.equal(slot.coset_evidence, "no-evidence");
  const traffic = floatTraffic(24);
  const measured = report(body(...traffic), body(...rotate(traffic)));
  const guarded = report(body(...traffic), body(...rotate(traffic)), { minimum_evidence: 1000 });
  assert.equal(measured.slots[0].coset_evidence, "measured");
  assert.equal(guarded.slots[0].coset_evidence, "no-evidence");
  assert.equal(guarded.slots[0].quotiented, guarded.slots[0].positional);
});

test("a context object fixes the coset the candidate is scored at", () => {
  const traffic = floatTraffic(24);
  const target = body(...traffic), candidate = body(...rotate(traffic)), context = body(...traffic);
  const alone = report(target, candidate);
  const inContext = report(target, candidate, { context: rows(context), context_shift: buildShiftDiff(rows(target), rows(context)), context_name: "context.o" });
  assert.equal(alone.slots[0].quotiented, 0);
  assert.equal(inContext.slots[0].coset_evidence, "fixed-by-context");
  assert.equal(inContext.slots[0].quotiented, traffic.length);
});

test("an inserted instruction does not shift every later row", () => {
  const target = body(...floatTraffic(24));
  const shifted = [...target]; shifted.splice(6, 0, "nop");
  const item = report(target, shifted);
  assert.equal(item.instruction_delta, 1); assert.equal(item.positional, 0); assert.equal(item.quotiented, 0);
});

test("healed and broken are separate facts; detail bounds the row lists", () => {
  const target = body(...floatTraffic(24));
  const previous = [...target]; previous[4] = "lwc1 f8,4(sp)"; previous[5] = "swc1 f10,8(sp)";
  const candidate = [...target]; candidate[9] = "lwc1 f8,4(sp)";
  const item = report(target, candidate, { baseline: rows(previous), baseline_shift: buildShiftDiff(rows(target), rows(previous)), baseline_name: "previous.o" });
  assert.equal(item.healed, 2); assert.equal(item.broken, 1);
  const prev2 = target.map((l) => (l.includes("f4,") ? l.replace("f4,", "f8,") : l));
  const item2 = report(target, target, { baseline: rows(prev2), baseline_shift: buildShiftDiff(rows(target), rows(prev2)), baseline_name: "previous.o" });
  const text = phaseLines(item2, { detail: true }).join("\n");
  assert.ok(text.includes("collapsed into runs")); assert.ok(text.includes("broke none")); assert.match(text, /healed \d+ row\(s\):/);
});

test("when every slot is no-evidence the total row does not read identity", () => {
  const target = body(...Array.from({ length: 12 }, (_, i) => `addiu t0,t0,${i}`));
  const item = report(target, target);
  assert.equal(item.slots[0].coset_evidence, "no-evidence");
  const total = phaseLines(item).find((l) => l.startsWith("total"));
  assert.ok(total.includes("no-evidence")); assert.ok(!total.includes("identity"));
});

// the phase-dumps command

function dir() { return fs.mkdtempSync(path.join(os.tmpdir(), "romdev-wb-phase-")); }
function dump(root, name, lines) { const p = path.join(root, name); fs.writeFileSync(p, assemble(lines, { symbol: SYMBOL })); return p; }

test("phase-dumps: a shifted candidate is flagged and still scored; --require-ni refuses it", async () => {
  const root = dir();
  const target = body(...floatTraffic(24));
  const shifted = [...target]; shifted.splice(6, 0, "nop");
  let [status, stdout, stderr] = await runCli(["phase-dumps", dump(root, "target.objdump", target), dump(root, "candidate.objdump", shifted)]);
  assert.equal(status, 0, stderr); assert.ok(stdout.includes("SHIFTED")); assert.ok(stdout.includes("insertion-only"));
  [status, , stderr] = await runCli(["phase-dumps", path.join(root, "target.objdump"), path.join(root, "candidate.objdump"), "--require-ni"]);
  assert.equal(status, 2); assert.ok(stderr.includes("--require-ni")); assert.ok(stderr.includes("real instruction"));
});

test("phase-dumps: a large ring falls back to paired cosets with a notice", async () => {
  const root = dir();
  const target = body(...floatTraffic(24));
  const [status, , stderr] = await runCli(["phase-dumps", dump(root, "t8.objdump", target), dump(root, "c8.objdump", target), "--ring", "$t2,$t3,$t4,$t5,$t6,$t7,$t8,$t9"]);
  assert.equal(status, 0, stderr); assert.ok(stderr.includes("paired cosets"));
});

test("phase-dumps: a pinned base refuses a table built from another base", async () => {
  const root = dir();
  const t = dump(root, "target.objdump", body(...floatTraffic(12))), c = dump(root, "candidate.objdump", body(...floatTraffic(12)));
  const source = path.join(root, "champion.c");
  fs.writeFileSync(source, "int main(void) { return 0; }\n");
  const [status, , stderr] = await runCli(["phase-dumps", t, c, "--base", source, "--require-base", "0000000000"]);
  assert.equal(status, 2); assert.ok(stderr.includes("built from a different base"));
});

test("phase-dumps: the slot table can come from a file; a hole is a usage error", async () => {
  const root = dir();
  const target = body(...floatTraffic(24));
  const last = rows(target).length - 1;
  const table = path.join(root, "slots.txt");
  fs.writeFileSync(table, `# named zones\nhead=0..13\ntail=14..${last}\n`);
  let [status, stdout, stderr] = await runCli(["phase-dumps", dump(root, "target.objdump", target), dump(root, "candidate.objdump", target), "--slots-from", table, "--json"]);
  assert.equal(status, 0, stderr);
  assert.deepEqual(JSON.parse(stdout).slots.map((s) => s.slot), ["head", "tail"]);
  [status, , stderr] = await runCli(["phase-dumps", path.join(root, "target.objdump"), path.join(root, "candidate.objdump"), "--slots", "head=0..5,tail=10..28"]);
  assert.equal(status, 2); assert.ok(stderr.includes("belong to no slot"));
});

test("phase-dumps: many candidates produce a ranked census naming the shared directory once", async () => {
  const root = dir();
  const traffic = floatTraffic(24);
  const target = body(...traffic);
  const [status, stdout, stderr] = await runCli(["phase-dumps", dump(root, "target.objdump", target), dump(root, "clean.objdump", target), dump(root, "rotated.objdump", body(...rotate(traffic)))]);
  assert.equal(status, 0, stderr);
  assert.ok(stdout.includes("COSET")); assert.ok(stdout.includes("rank on positional")); assert.ok(stdout.includes("paths are relative to"));
  const line = stdout.split("\n").find((l) => l.startsWith("clean"));
  assert.ok(line && line.startsWith("clean.objdump"), stdout);
});
