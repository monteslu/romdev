// Ported from the workbench's score tests: windowing by symbol and between
// two kept symbols, ROM windows, relocation floors, controls, guidance and
// the `score` command. Object-shaped cases run against a stand-in objdump.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseDisassembly } from "../src/decomp/workbench/objdump.js";
import { BETWEEN_RATIONALE, ControlSpec, ScoreError, ScoreSpec, TargetSpec, Window, WordScore, buildGuidance, labelAddresses,
  parseControlSpec, readRomWindow, scoreReport, scoreSpecFromDict, scoreWindow, windowBetween, windowBySymbol, wordsFromBytes } from "../src/decomp/workbench/score.js";
import { fakeObjdump } from "./fixtures/workbench/fake-objdump.js";
import { runCli } from "./fixtures/workbench/cli-run.js";

const SECTION_TEXT = `
00000000 <funcA>:
   0: 03e00008  jr $ra
   4: 00000000  nop

00000008 <hidden>:
   8: 27bdffe0  addiu $sp,$sp,-32
   c: 03e00008  jr $ra
  10: 00000000  nop

00000014 <funcB>:
  14: 03e00008  jr $ra
  18: 00000000  nop
`;
const RELOC_CANDIDATE_TEXT = `
00000000 <demo>:
   0: 0c000000  jal 0 <callee>
                        0: R_MIPS_26 callee
   4: 24020005  li $v0,5
   8: 03e00008  jr $ra
   c: 00000000  nop
`;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "romdev-wb-score-"));
function setup(text) {
  const d = tmp();
  fs.writeFileSync(path.join(d, "candidate.o"), "placeholder");
  return { d, objdump: fakeObjdump(d, { "candidate.o": text }), candidate: path.join(d, "candidate.o") };
}
const hexBytes = (...w) => Buffer.from(w.join(""), "hex");

test("window by symbol extracts one function", () => {
  const { d, objdump } = setup(SECTION_TEXT);
  const w = windowBySymbol("candidate.o", { objdump, symbol: "funcA", cwd: d });
  assert.equal(w.mode, "function"); assert.equal(w.instructions.length, 2); assert.equal(w.size, 8); assert.equal(w.note, null);
});

test("window by symbol: a missing symbol suggests --between", () => {
  const { d, objdump } = setup(SECTION_TEXT);
  assert.throws(() => windowBySymbol("candidate.o", { objdump, symbol: "nope", cwd: d }), (e) => e instanceof ScoreError && e.message.includes("--between"));
});

test("label addresses parse whole-section text", () => {
  assert.deepEqual(Object.fromEntries(labelAddresses(SECTION_TEXT)), { funcA: 0, hidden: 8, funcB: 0x14 });
});

test("window between locates the stripped local function", () => {
  const { d, objdump } = setup(SECTION_TEXT);
  const w = windowBetween("candidate.o", { objdump, start_symbol: "funcA", end_symbol: "funcB", cwd: d });
  assert.equal(w.mode, "between"); assert.equal(w.note, BETWEEN_RATIONALE);
  assert.deepEqual(w.instructions.map((i) => i.address), [8, 0xC, 0x10]);
});

test("window between reports a missing end symbol, and an empty or reversed range", () => {
  const { d, objdump } = setup(SECTION_TEXT);
  assert.throws(() => windowBetween("candidate.o", { objdump, start_symbol: "funcA", end_symbol: "typo", cwd: d }), /defines: funcA, funcB, hidden/);
  assert.throws(() => windowBetween("candidate.o", { objdump, start_symbol: "funcB", end_symbol: "funcA", cwd: d }), /empty or reversed/);
});

test("ROM windows: the requested slice and every refusal names the fix", () => {
  const d = tmp();
  const rom = path.join(d, "baserom.z64");
  fs.writeFileSync(rom, Buffer.concat([Buffer.alloc(16), Buffer.from([1, 2, 3, 4]), Buffer.alloc(16, 0xff)]));
  const w = readRomWindow(rom, { offset: 16, size: 4 });
  assert.deepEqual([...w], [1, 2, 3, 4]); assert.deepEqual(wordsFromBytes(w), ["01020304"]);
  assert.throws(() => readRomWindow("/no/such/rom.z64", { offset: 0, size: 4 }), /does not exist/);
  fs.writeFileSync(rom, Buffer.alloc(8));
  assert.throws(() => readRomWindow(rom, { offset: 100, size: 4 }), /past the end/);
  assert.throws(() => readRomWindow(rom, { offset: 4, size: 8 }), /reaches past the end/);
  assert.throws(() => readRomWindow(rom, { offset: 0, size: 3 }), /not a multiple of 4/);
});

test("relocation words are a floor, not a diff; a short target counts", () => {
  const w = new Window({ label: "demo", instructions: parseDisassembly(RELOC_CANDIDATE_TEXT, { symbol: "demo" }), mode: "function" });
  const r = scoreWindow(w, ["0c123456", "24020006", "03e00008", "00000000"]);
  assert.equal(r.candidate_size, 16); assert.equal(r.target_size, 16); assert.equal(r.relocation_floor, 1); assert.equal(r.diff_words, 1);
  assert.deepEqual(r.diff_positions, [1]); assert.equal(r.matched, false);
  assert.ok(r.summary.includes("size 16/16, diff words 1")); assert.ok(r.summary.includes("+1 relocation-floor word)"));
  const s = scoreWindow(w, ["0c123456", "24020005", "03e00008"]);
  assert.equal(s.diff_words, 1); assert.equal(s.matched, false);
});

test("control specs", () => {
  assert.deepEqual({ ...parseControlSpec("ctrl") }, { ...new ControlSpec({ name: "ctrl" }) });
  assert.deepEqual({ ...parseControlSpec("ctrl@0x100") }, { ...new ControlSpec({ name: "ctrl", offset: 0x100 }) });
  assert.deepEqual({ ...parseControlSpec("ctrl@0x100:32") }, { ...new ControlSpec({ name: "ctrl", offset: 0x100, size: 32 }) });
  assert.throws(() => parseControlSpec("@0x10"), /NAME@0xOFFSET/);
});

test("a matched function with a relocation floor", async () => {
  const { d, objdump, candidate } = setup(RELOC_CANDIDATE_TEXT);
  const rom = path.join(d, "baserom.z64");
  fs.writeFileSync(rom, Buffer.concat([Buffer.alloc(32), hexBytes("0c123456", "24020005", "03e00008", "00000000")]));
  const spec = new ScoreSpec({ target: new TargetSpec({ kind: "rom", rom, rom_offset: 32 }), function: "demo", between: null, objdump });
  const report = await scoreReport(candidate, spec, { cwd: d });
  assert.equal(report.matched, true); assert.equal(report.function.diff_words, 0); assert.equal(report.function.relocation_floor, 1);
  assert.equal(report.controls_broken, false); assert.ok(report.guidance.join("").includes("relocation floor"));
});

const ws = (over) => new WordScore({ label: "demo", mode: "function", note: null, candidate_size: 4, target_size: 4, diff_words: 1, relocation_floor: 0,
  diff_positions: [0], candidate_sha256: "0".repeat(64), matched: false, ...over });

test("object mismatch guidance names the real candidate", () => {
  const g = buildGuidance({ matched: false, function_score: ws(), controls_broken: false, target: new TargetSpec({ kind: "object", target_object: "target.o" }),
    function_symbol: "demo", candidate: "run/objects/best.o" });
  assert.ok(g[0].includes("target.o run/objects/best.o")); assert.ok(!g[0].includes("<candidate.o>"));
});

test("between guidance does not invent a function symbol", () => {
  const g = buildGuidance({ matched: false, function_score: ws({ label: "before..after", mode: "between" }), controls_broken: false,
    target: new TargetSpec({ kind: "rom", rom: "base.z64", rom_offset: 0 }), function_symbol: null, candidate: "candidate.o" });
  assert.ok(g[0].includes("selected with `--between`")); assert.ok(g[0].includes("diagnose-dumps")); assert.ok(!g[0].includes("--function"));
});

test("a broken control marks the whole run", async () => {
  const control = "\n00000000 <ctrl>:\n   0: 24020005  li $v0,5\n   4: 03e00008  jr $ra\n   8: 00000000  nop\n";
  const { d, objdump, candidate } = setup({ d: RELOC_CANDIDATE_TEXT, sym: { ctrl: control } });
  const rom = path.join(d, "baserom.z64");
  fs.writeFileSync(rom, hexBytes("0c123456", "24020005", "03e00008", "00000000", "24020099", "03e00008", "00000000"));
  const spec = new ScoreSpec({ target: new TargetSpec({ kind: "rom", rom, rom_offset: 0 }), function: "demo", between: null,
    controls: [new ControlSpec({ name: "ctrl", offset: 16 })], objdump });
  const report = await scoreReport(candidate, spec, { cwd: d });
  assert.equal(report.function.matched, true); assert.equal(report.controls[0].matched, false); assert.equal(report.controls_broken, true);
  assert.equal(report.matched, false);
  assert.ok(report.guidance.some((l) => l.includes("CONTROLS BROKEN")));
  assert.equal(report.guidance.length, 1); assert.ok(!report.guidance[0].includes("diagnose"));
});

test("a missing candidate names the fix", async () => {
  const spec = new ScoreSpec({ target: new TargetSpec({ kind: "rom", rom: "unused", rom_offset: 0 }), function: "demo", between: null });
  await assert.rejects(scoreReport("/no/such/candidate.o", spec), /does not exist/);
});

test("score specs from a matrix document", () => {
  assert.throws(() => scoreSpecFromDict({ rom: "r.z64", rom_offset: "0x0" }), ScoreError);
  assert.throws(() => scoreSpecFromDict({ function: "demo", between: ["a", "b"], rom: "r.z64", rom_offset: "0x0" }), ScoreError);
  assert.throws(() => scoreSpecFromDict({ function: "demo" }), ScoreError);
  assert.throws(() => scoreSpecFromDict({ function: "demo", rom: "r.z64" }), ScoreError);
  const spec = scoreSpecFromDict({ function: "demo", rom: "r.z64", rom_offset: "0x100", size: 32, controls: ["ctrl@0x200:16"] });
  assert.equal(spec.target.kind, "rom"); assert.equal(spec.target.rom_offset, 0x100);
  assert.deepEqual(spec.controls.map((c) => ({ ...c })), [{ name: "ctrl", offset: 0x200, size: 16 }]);
});

function romWith(d, ...words) { const rom = path.join(d, "baserom.z64"); fs.writeFileSync(rom, hexBytes(...words)); return rom; }

test("score command: a match exits zero, a mismatch one, JSON carries the schema", async () => {
  const { d, objdump, candidate } = setup(RELOC_CANDIDATE_TEXT);
  let rom = romWith(d, "0c123456", "24020005", "03e00008", "00000000");
  let [status, stdout, stderr] = await runCli(["score", candidate, "--function", "demo", "--rom", rom, "--rom-offset", "0x0", "--objdump", objdump], { cwd: d });
  assert.equal(status, 0, stderr); assert.equal(stderr, ""); assert.ok(stdout.includes("verdict: MATCH")); assert.ok(stdout.includes("next:"));
  [status, stdout, stderr] = await runCli(["score", candidate, "--function", "demo", "--rom", rom, "--rom-offset", "0x0", "--objdump", objdump, "--json"], { cwd: d });
  assert.equal(status, 0); assert.equal(stderr, "");
  const payload = JSON.parse(stdout);
  assert.equal(payload.schema, "decomp-workbench-score-v1"); assert.equal(payload.function.relocation_floor, 1); assert.equal(payload.matched, true);
  rom = romWith(d, "0c123456", "24020099", "03e00008", "00000000");
  [status, stdout] = await runCli(["score", candidate, "--function", "demo", "--rom", rom, "--rom-offset", "0x0", "--objdump", objdump], { cwd: d });
  assert.equal(status, 1); assert.ok(stdout.includes("verdict: MISMATCH"));
});

test("score command refusals are clean errors", async () => {
  let [status, stdout, stderr] = await runCli(["score", "/no/such/candidate.o", "--function", "demo", "--rom", "/no/such/rom.z64", "--rom-offset", "0x0"]);
  assert.equal(status, 2); assert.equal(stdout, ""); assert.ok(stderr.includes("does not exist"));
  const d = tmp();
  const candidate = path.join(d, "candidate.o");
  fs.writeFileSync(candidate, "x");
  [status, , stderr] = await runCli(["score", candidate, "--function", "demo", "--rom", "rom.z64", "--rom-offset", "0x0", "--target-object", "other.o"], { cwd: d });
  assert.equal(status, 2); assert.ok(stderr.includes("exactly one of --target-object or --rom"));
  [status, , stderr] = await runCli(["score", candidate, "--rom", "rom.z64", "--rom-offset", "0x0"], { cwd: d });
  assert.equal(status, 2); assert.ok(stderr.includes("exactly one of --function/--symbol or --between"));
});

test("--between is wired to the windower", async () => {
  const { d, objdump, candidate } = setup(SECTION_TEXT);
  const hidden = parseDisassembly(SECTION_TEXT, { symbol: null }).filter((i) => i.address >= 8 && i.address < 0x14).map((i) => i.word);
  const rom = romWith(d, ...hidden);
  const [status, stdout, stderr] = await runCli(["score", candidate, "--between", "funcA,funcB", "--rom", rom, "--rom-offset", "0x0", "--objdump", objdump, "--json"], { cwd: d });
  assert.equal(status, 0, stderr);
  const payload = JSON.parse(stdout);
  assert.equal(payload.matched, true); assert.equal(payload.function.mode, "between"); assert.equal(payload.function.note, BETWEEN_RATIONALE);
});
