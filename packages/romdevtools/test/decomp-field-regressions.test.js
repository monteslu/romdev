import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadLinkerMap } from "../src/decomp/splat-map.js";
import { compareAgainstRom } from "../src/decomp/compile.js";
import { residualSummary, linkedMismatchCount } from "../src/decomp/measurement.js";
import { metricsOf } from "../src/decomp/variants.js";
import { searchBaseline, searchLogErrors, jobStatus, jobReport } from "../src/decomp/jobs.js";
import { romLinkedState, VERIFIER_VERSION } from "../src/decomp/verdict.js";
import { groupResiduals, classifyGroup } from "../src/decomp/diagnose.js";

test("linker-evaluated aliases, expressions and defined PROVIDEs retain addresses, not object sizes", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "romdev-map-alias-"));
  const file = path.join(dir, "test.map");
  await writeFile(file, [
    " .text          0x80000400      0x40 build/src/main.o",
    "                0x80000400                first",
    "                0x801ce704                alias = (base + 0x8)",
    "                0x801CE708                provided = ALIGN (base, 0x8)",
    "                0x801ce70c                PROVIDE (conditional = (base + 0x10))",
    "                0x801ce710                PROVIDE_HIDDEN (hidden = (base + 0x14))",
    "                [!provide]               PROVIDE (not_defined = (base + 0x18))",
    "                                         unknown = (base + 0x1c)",
    "                0x80000410                . = ALIGN (0x10)",
    "                0x80000420                second",
  ].join("\n"));
  const ld = await loadLinkerMap(file);
  for (const [name, va] of [["alias", 0x801ce704], ["provided", 0x801ce708], ["conditional", 0x801ce70c], ["hidden", 0x801ce710]]) {
    assert.equal(ld.symbols.get(name)?.va, va);
    assert.equal(ld.symbols.get(name)?.size, 0);
    assert.equal(ld.symbols.get(name)?.object, null);
  }
  for (const name of ["not_defined", "unknown", "."]) assert.equal(ld.symbols.has(name), false);
  assert.equal(ld.symbols.get("first").size, 0x20);
  assert.equal(ld.symbols.get("second").size, 0x20);
});

const ins = (mnemonic, operands, word = 0, reloc = null) => ({ mnemonic, operands, word, reloc });
const reloc = symbol => ({ type: "R_MIPS_LO16", symbol, addend: 0 });
const diagnose = (a, b, indices = a.map((_, i) => i)) => groupResiduals(a, b,
  { mismatches: indices.map(index => ({ index })) }).map(g => ({ ...g, ...classifyGroup(g, a, b) }));

test("same-shaped move/store swaps are scheduling, not opposing register mappings", () => {
  for (const pair of [
    [ins("or", "a2,zero,zero", 0x3025), ins("or", "a3,zero,zero", 0x3825)],
    [ins("sw", "t3,0(a1)"), ins("sw", "t4,0(a2)")],
    [ins("sw", "zero,0(at)", 0, reloc("reset")), ins("lw", "a1,0(a1)", 0, reloc("course"))],
  ]) {
    const groups = diagnose(pair, [...pair].reverse());
    assert.equal(groups.length, 1);
    assert.equal(groups[0].mechanism, "scheduling-permutation");
    assert.equal(groups[0].mapping, null);
  }
});

test("equal decoded words with different relocations are NOT a scheduling proof", () => {
  const a = [ins("sw", "t3,0(a1)", 0, reloc("a")), ins("sw", "t4,0(a2)", 0, reloc("b"))];
  const b = [ins("sw", "t4,0(a2)", 0, reloc("other")), a[0]];
  assert.ok(diagnose(a, b).every(g => g.mechanism !== "scheduling-permutation"));
  assert.notEqual(classifyGroup({ indices: [0, 1] }, a, b).mechanism, "scheduling-permutation");
});

test("permutation detection does not cross a matched branch or ignore length differences", () => {
  const a = [ins("sw", "a0,0(v0)"), ins("beq", "v0,zero,20"), ins("sw", "a1,4(v0)")];
  const b = [a[2], a[1], a[0]];
  assert.ok(diagnose(a, b, [0, 2]).every(g => g.mechanism !== "scheduling-permutation"));
  assert.ok(diagnose([a[0], a[2]], [a[2], a[0], ins("nop", "")]).every(g => g.mechanism !== "scheduling-permutation"));
});

async function romCompare(stream, words, symbols = new Map()) {
  const bytes = Buffer.alloc(words.length * 4);
  words.forEach((w, i) => bytes.writeUInt32BE(w >>> 0, i * 4));
  const project = { m: { platform: "n64" }, linkerMap: async () => ({ symbols, objects: new Map() }),
    symbolAddrs: async () => new Map(), splatSectionPlacement: async () => [], romSlice: async (offset, length) => ({ bytes: bytes.subarray(offset, offset + length), sha1: "fixture" }) };
  return compareAgainstRom(project, { va: 0x80000400, romOffset: 0, romOffsetHex: "0x0", sizeBytes: bytes.length }, stream, new Map());
}

test("linked producer keeps unresolved words unknown even when their placeholder equals ROM", async () => {
  const stream = [ins("lui", "a0,0", 0x3c040000, { type: "R_MIPS_HI16", symbol: "missing", addend: 0 })];
  const linked = await romCompare(stream, [0x3c040000]);
  assert.equal(linked.status, "unresolved-relocations");
  assert.equal(linked.uncheckableWords, 1);
  assert.equal(linked.mismatches, null);
  assert.equal(linked.knownMismatches, 0);
});

test("partial comparisons preserve real mismatches as a lower bound, not a total", async () => {
  const stream = [ins("lw", "a0,0(a0)", 0x8c840000, reloc("missing")), ins("nop", "", 0)];
  const linked = await romCompare(stream, [0x8c84e704, 0x24020001]);
  assert.equal(linked.status, "mismatch");
  assert.equal(linked.mismatches, null);
  assert.equal(linked.knownMismatches, 1);
  assert.match(romLinkedState(linked).reason, /at least 1/);
});

test("resolved aliases link normally and a wrong resolved address still mismatches", async () => {
  const stream = [ins("lui", "at,0", 0x3c010000, { type: "R_MIPS_HI16", symbol: "alias", addend: 0 }),
    ins("sw", "t7,0(at)", 0xac2f0000, reloc("alias"))];
  const linked = await romCompare(stream, [0x3c01801d, 0xac2fe704], new Map([["alias", { va: 0x801ce704 }]]));
  assert.equal(linked.status, "exact");
  assert.equal(linked.mismatches, 0);
  const wrong = await romCompare(stream, [0x3c01801d, 0xac2fe704], new Map([["alias", { va: 0x801ce708 }]]));
  assert.equal(wrong.status, "mismatch");
  assert.equal(wrong.mismatches, 1);
});

test("all summary consumers reject zero from unresolved, partial, absent and legacy-unknown checks", () => {
  for (const linked of [undefined, { mismatches: 0 }, { status: "unresolved-relocations", mismatches: 0 },
    { status: "mismatch", mismatches: 1, uncheckableWords: 2 }, { status: "exact", mismatches: 0, unresolvedSymbols: ["x"] }]) {
    const r = { romLinked: linked };
    assert.equal(linkedMismatchCount(r), null);
    assert.equal(residualSummary(r).linkedMismatches, null);
    assert.equal(metricsOf(r).linkedMismatches, null);
    assert.equal(searchBaseline(r).linkedMismatches, null);
  }
  assert.equal(linkedMismatchCount({ romLinked: { status: "exact", mismatches: 0 } }), 0);
});

const interrupt = "Exception ignored in atexit callback <function _exit_function>:\nTraceback (most recent call last):\n  File \"multiprocessing/util.py\", line 424, in _exit_function\n    p.join()\nKeyboardInterrupt: \n";
test("search baseline retains the verifier policy required by freshness validation", () => {
  assert.equal(searchBaseline({ verifierVersion: VERIFIER_VERSION }).verifierVersion, VERIFIER_VERSION);
});
test("only shutdown interrupts following an intentional stop are discounted", () => {
  assert.equal(searchLogErrors(interrupt, { reason: "no-improvement-budget" }, { code: 124 }).errorLines, 0);
  assert.equal(searchLogErrors(interrupt, null, { code: 0 }).errorLines, 1);
  assert.equal(searchLogErrors(interrupt, { reason: "no-improvement-budget", logBytes: Buffer.byteLength(interrupt) }, { code: 124 }).errorLines, 1);
  const error = "Traceback (most recent call last):\n  File \"search.py\", line 1\nValueError: real backend failure\n";
  assert.ok(searchLogErrors(error + interrupt, { reason: "no-improvement-budget" }, { code: 124 }).errorLines > 0);
});

test("job status and report preserve deliberate stop, but not real backend failures", async () => {
  for (const [extraLog, exitCode, expected, reason = "no-improvement-budget", signal = null] of [["", 124, "complete-no-progress"],
    ["Error: backend failed\n", 124, "failed"], ["", 1, "failed"],
    ["", 130, "complete-no-progress"], ["", null, "complete-no-progress", "no-improvement-budget", "SIGINT"],
    ["", 130, "failed", "unrecognized-stop"], ["", null, "failed", "unrecognized-stop", "SIGINT"]]) {
    const ws = await mkdtemp(path.join(os.tmpdir(), "romdev-stop-fixture-"));
    const dir = path.join(ws, "jobs", "fixture");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "permuter.log"), "base score = 50\n" + extraLog + interrupt);
    await writeFile(path.join(dir, "job.json"), JSON.stringify({ jobId: "fixture", status: "failed", dir, function: { symbol: "f" },
      startedAt: "2026-09-16T07:04:15.617Z", endedAt: "2026-09-16T07:04:36.835Z",
      log: path.join(dir, "permuter.log"), permuterDir: dir, preflight: { exactFunctionMatch: false } }));
    await writeFile(path.join(dir, "termination.json"), JSON.stringify({ reason }));
    await writeFile(path.join(dir, "exit.json"), JSON.stringify({ code: exitCode, signal }));
    const status = await jobStatus({ ws }, "fixture");
    assert.equal(status.status, expected);
    assert.equal(status.elapsedS, 21);
    assert.equal((await jobStatus({ ws }, "fixture")).status, expected, "stable across reads");
    assert.equal((await jobReport({ ws }, "fixture")).status, expected);
  }
});
