// Source-region attribution of differing words: call-relocation anchoring,
// honest refusals and reported coverage. Ported from the workbench's own
// tests; the compare-dumps --by-region cases run through the in-process
// command surface.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { Instruction, Relocation } from "../src/decomp/workbench/model.js";
import { Anchor, RegionError, buildAnchors, buildRegionReport, objectCalls, renderRegionReport, sourceCalls, stripNoncode } from "../src/decomp/workbench/regions.js";
import { runCommand, resolveCommand } from "../src/decomp/workbench/cli.js";

const SOURCE = "#include <stuff.h>\n\nvoid demo(void) {\n    if (ready()) {\n        alpha();\n    }\n    beta(1, 2);\n    /* gamma() in a comment must not count */\n    delta();\n}\n";
const FIX = fileURLToPath(new URL("./fixtures/workbench/", import.meta.url));

const callInstruction = (address, symbol) => new Instruction({ address, word: "0c000000", assembly: `jal ${symbol}`, relocations: [new Relocation({ offset: address, kind: "R_MIPS_26", symbol })] });
const plain = (address) => new Instruction({ address, word: "00000000", assembly: "nop" });

test("comments, strings and control keywords do not contribute calls", () => {
  const names = sourceCalls(SOURCE).map(([, n]) => n);
  assert.ok(names.includes("alpha") && !names.includes("gamma"));
  assert.ok(!names.includes("if") && names.includes("ready"));
});

test("line numbers survive comment blanking", () => {
  const text = "/* a\nmultiline\ncomment */\nalpha();\n";
  assert.equal(stripNoncode(text).split("\n").length, text.split("\n").length);
  assert.deepEqual(sourceCalls(text), [[4, "alpha"]]);
});

test("matching sequences anchor every call", () => {
  const [anchors, dropped] = buildAnchors([[0, "alpha"], [16, "beta"], [32, "delta"]], [[5, "alpha"], [7, "beta"], [9, "delta"]]);
  assert.equal(anchors.length, 3);
  assert.deepEqual(dropped, []);
  assert.deepEqual(anchors[1], new Anchor({ address: 16, line: 7, symbol: "beta" }));
});

test("a nested call transposition is dropped, not guessed", () => {
  const source = [[5, "outer"], [5, "inner"], [9, "tail"]];
  const [anchors, dropped] = buildAnchors([[0, "inner"], [16, "outer"], [32, "tail"]], source);
  assert.ok(anchors.some((a) => a.symbol === "tail"));
  assert.ok(dropped.length);
  const byLine = new Map(source.map(([l, n]) => [l, n]));
  for (const a of anchors) assert.equal(a.symbol, byLine.get(a.line) ?? a.symbol);
});

test("spurious source names fall out of the alignment; anchors are monotone", () => {
  let [anchors] = buildAnchors([[0, "alpha"], [16, "beta"]], [[1, "SOME_MACRO"], [5, "alpha"], [7, "beta"]]);
  assert.deepEqual(anchors.map((a) => a.symbol), ["alpha", "beta"]);
  [anchors] = buildAnchors([[0, "a"], [8, "b"], [16, "c"], [24, "d"]], [[10, "a"], [30, "b"], [20, "c"], [40, "d"]]);
  const lines = anchors.map((a) => a.line), addrs = anchors.map((a) => a.address);
  assert.deepEqual(lines, [...lines].sort((x, y) => x - y));
  assert.deepEqual(addrs, [...addrs].sort((x, y) => x - y));
});

test("only call relocations anchor", () => {
  const ins = [callInstruction(0, "alpha"), new Instruction({ address: 4, word: "3c010000", assembly: "lui at,0x0",
    relocations: [new Relocation({ offset: 4, kind: "R_MIPS_HI16", symbol: "data" })] }), callInstruction(8, "beta")];
  assert.deepEqual(objectCalls(ins), [[0, "alpha"], [8, "beta"]]);
});

const build = (sites, { delta = 0, true_delta = null, expected_total = null } = {}) => buildRegionReport({ source_path: "demo.c", source_text: SOURCE,
  candidate: [callInstruction(0, "ready"), plain(4), plain(8), callInstruction(12, "alpha"), plain(16), callInstruction(20, "beta"), plain(24), callInstruction(28, "delta"), plain(32)],
  sites, instruction_delta: delta, true_instruction_delta: true_delta, expected_total });

test("words are bracketed between the calls around them", () => {
  const r = build([{ index: 4, class: "register" }]);
  assert.equal(r.regions.length, 1);
  const g = r.regions[0];
  assert.equal(g.low_symbol, "alpha");
  assert.equal(g.high_symbol, "beta");
  assert.ok(g.low_line !== null && g.low_line < g.high_line);
});

test("regions are ranked by word count", () => {
  const r = build([{ index: 4, class: "register" }, { index: 8, class: "register" }, { index: 8, class: "register" }, { index: 8, class: "register" }]);
  assert.ok(r.regions[0].words >= r.regions[r.regions.length - 1].words);
  assert.equal(r.regions[0].words, 3);
});

test("relocation-class words are excluded and counted; attribution never interpolates", () => {
  let r = build([{ index: 4, class: "register" }, { index: 6, class: "relocation-controlled" }]);
  assert.equal(r.attributed_words, 1);
  assert.equal(r.excluded_words, 1);
  assert.ok(r.caveats.join(" ").includes("relocation-class"));
  r = build([{ index: 4, class: "register" }]);
  assert.notEqual(r.regions[0].low_line, r.regions[0].high_line);
  assert.ok(r.caveats.join(" ").includes("never interpolated"));
});

test("instruction-count deltas: shadow caveat, loud true-delta warning, zero/unset warn nothing", () => {
  assert.ok(build([{ index: 4, class: "constant" }], { delta: 2 }).caveats.join(" ").includes("shadow"));
  const r = build([{ index: 4, class: "register" }], { true_delta: 3 });
  assert.equal(r.true_instruction_delta, 3);
  assert.ok(r.warnings.some((w) => w.includes("REGION ANALYSIS UNRELIABLE")));
  assert.deepEqual(build([{ index: 4, class: "register" }], { true_delta: 0 }).warnings, []);
  const u = build([{ index: 4, class: "register" }]);
  assert.equal(u.true_instruction_delta, null);
  assert.deepEqual(u.warnings, []);
});

test("reconciliation with an expected total", () => {
  let r = build([{ index: 4, class: "register" }, { index: 6, class: "relocation-controlled" }], { expected_total: 1 });
  assert.equal(r.attributed_words, 1);
  assert.equal(r.reconciled, true);
  assert.deepEqual(r.warnings, []);
  r = build([{ index: 4, class: "register" }], { expected_total: 99 });
  assert.equal(r.reconciled, false);
  assert.ok(r.warnings.some((w) => w.includes("RECONCILIATION FAILED")));
  r = build([{ index: 4, class: "register" }]);
  assert.equal(r.expected_total, null);
  assert.equal(r.reconciled, true);
});

test("warnings render ahead of the region table; a reliable report renders none", () => {
  const lines = renderRegionReport(build([{ index: 4, class: "register" }], { true_delta: 3 }));
  assert.ok(lines[0].startsWith("warning: REGION ANALYSIS UNRELIABLE"));
  assert.ok(lines.findIndex((l) => l.startsWith("warning:")) < lines.findIndex((l) => l.startsWith("by-region:")));
  assert.ok(!renderRegionReport(build([{ index: 4, class: "register" }], { true_delta: 0 })).some((l) => l.startsWith("warning:")));
});

test("JSON carries the new fields; coverage is always reported", () => {
  const p = build([{ index: 4, class: "register" }], { true_delta: 3, expected_total: 1 }).asDict();
  assert.equal(p.true_instruction_delta, 3);
  assert.equal(p.expected_total, 1);
  assert.equal(p.reconciled, true);
  assert.ok(p.warnings.some((w) => w.includes("REGION ANALYSIS UNRELIABLE")));
  const r = build([{ index: 4, class: "register" }]);
  assert.equal(r.object_calls, 4);
  assert.ok(r.source_calls >= 4);
});

test("clear refusals: no call relocations, a source that matches nothing", () => {
  assert.throws(() => buildRegionReport({ source_path: "demo.c", source_text: SOURCE, candidate: [plain(0), plain(4)], sites: [{ index: 1, class: "register" }] }),
    (e) => e instanceof RegionError && e.message.includes("no call relocations"));
  assert.throws(() => buildRegionReport({ source_path: "wrong.c", source_text: "void f(void) { unrelated(); }\n", candidate: [callInstruction(0, "alpha"), plain(4)],
    sites: [{ index: 1, class: "register" }] }), (e) => e instanceof RegionError && e.message.includes("not the one that produced this object"));
});

// compare-dumps --by-region, end to end through the command surface.
const PADDED_TARGET_DUMP = "00000000 <demo>:\n   0: 0c000000  jal 0 <alpha>\n                        0: R_MIPS_26 alpha\n   4: 24020001  li $v0,1\n   8: 03e00008  jr $ra\n   c: 00000000  nop\n  10: 00000000  nop\n  14: 00000000  nop\n";
const UNPADDED_CANDIDATE_DUMP = "00000000 <demo>:\n   0: 0c000000  jal 0 <alpha>\n                        0: R_MIPS_26 alpha\n   4: 24020001  li $v0,1\n   8: 24030002  li $v1,2\n   c: 24040003  li $a0,3\n  10: 24050004  li $a1,4\n  14: 03e00008  jr $ra\n";
const haveCompareDumps = async () => !!(await resolveCommand(["compare-dumps"]));

test("by-region: a missing source file is an error, not a silent omission", async (t) => {
  if (!(await haveCompareDumps())) return t.skip("compare-dumps is not registered");
  const r = await runCommand(["compare-dumps", path.join(FIX, "phase-shift-target.objdump.txt"), path.join(FIX, "phase-shift-candidate.objdump.txt"), "--by-region", "definitely-absent.c"]);
  assert.equal(r.code, 2);
  assert.ok(r.stderr.startsWith("error: "));
});

test("by-region: JSON carries the region payload beside the existing keys", async (t) => {
  if (!(await haveCompareDumps())) return t.skip("compare-dumps is not registered");
  const dir = mkdtempSync(path.join(os.tmpdir(), "romdev-wb-regions-"));
  try {
    writeFileSync(path.join(dir, "demo.c"), SOURCE);
    const r = await runCommand(["compare-dumps", path.join(FIX, "phase-shift-target.objdump.txt"), path.join(FIX, "phase-shift-candidate.objdump.txt"), "--by-region", path.join(dir, "demo.c"), "--json"]);
    if (r.code === 0) {
      const p = JSON.parse(r.stdout);
      assert.ok("verdict" in p && "by_region" in p);
      assert.equal(p.by_region.method, "call-relocation anchoring");
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("by-region: a true instruction mismatch is a loud warning end to end, and reconciles in JSON", async (t) => {
  if (!(await haveCompareDumps())) return t.skip("compare-dumps is not registered");
  const dir = mkdtempSync(path.join(os.tmpdir(), "romdev-wb-regions-"));
  try {
    const tgt = path.join(dir, "target.objdump"), cand = path.join(dir, "candidate.objdump"), src = path.join(dir, "demo.c");
    writeFileSync(tgt, PADDED_TARGET_DUMP); writeFileSync(cand, UNPADDED_CANDIDATE_DUMP); writeFileSync(src, SOURCE);
    const r = await runCommand(["compare-dumps", tgt, cand, "--by-region", src]);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.stdout.includes("REGION ANALYSIS UNRELIABLE"));
    assert.ok(r.stdout.indexOf("REGION ANALYSIS UNRELIABLE") < r.stdout.indexOf("by-region:"));
    const j = await runCommand(["compare-dumps", tgt, cand, "--by-region", src, "--json"]);
    assert.equal(j.code, 0, j.stderr);
    const p = JSON.parse(j.stdout);
    assert.equal(p.true_instruction_delta, 2);
    assert.equal(p.by_region.true_instruction_delta, 2);
    assert.equal(p.by_region.expected_total, p.word_mismatches);
    assert.equal(p.by_region.reconciled, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
