// The scorer, checked against upstream's documented algorithm (scorer.py):
// difflib opcodes over mnemonics; on "equal" rows, +1 stack (per byte of
// sp-offset difference, with --stack-diffs), +1 branch (differing branch
// target), +5 per differing operand field (regalloc); unmatched rows become
// insertions/deletions (+100 each) unless the same row text appears on both
// sides, which counts as a reordering (+60).
//
// Fixtures are objdump -dr text as binutils prints it for MIPS, so the
// simplifier (relocation folding, hex conversion, sp masking, trailing nops)
// is exercised on the way in. A second test replays upstream's own scores on
// a local decomp corpus when one is present (see corpus.test.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { simplify_objdump, MIPS_SETTINGS } from "../src/objdump.js";
import { Scorer } from "../src/scorer.js";
import { SequenceMatcher } from "../src/difflib.js";

const HEAD = ["", "x.o:     file format elf32-tradbigmips", "", "", "Disassembly of section .text:", "", "00000000 <f>:"];
const row = (addr, word, text) => `${addr.toString(16).padStart(4, " ")}:\t${word} \t${text}`;
const reloc = (addr, type, sym) => `\t\t\t${addr.toString(16)}: ${type}\t${sym}`;

/** A scorer over already-simplified target text, bypassing ELF/objdump. */
function scorerFor(targetLines, { stack_differences = false, ign_branch_targets = true, algorithm = "difflib" } = {}) {
  const s = Object.create(Scorer.prototype);
  s.algorithm = algorithm;
  s.arch = MIPS_SETTINGS;
  s.stack_differences = stack_differences;
  s.ign_branch_targets = ign_branch_targets;
  s.debug_mode = false;
  s.re_sprel_search = new RegExp(MIPS_SETTINGS.re_sprel.source);
  s.target_seq = simplify_objdump([...HEAD, ...targetLines], MIPS_SETTINGS, { stack_differences, ign_branch_targets });
  s.difflib_differ = new SequenceMatcher({ autojunk: false });
  s.difflib_differ.set_seq2(s.target_seq.map((l) => l.mnemonic));
  return s;
}
function score(s, candLines) {
  const cand = simplify_objdump([...HEAD, ...candLines], MIPS_SETTINGS, { stack_differences: s.stack_differences, ign_branch_targets: s.ign_branch_targets });
  return { score: s.scoreLines(cand.map((l) => l.row).join("\n"), cand)[0], penalties: s.lastPenalties, cand };
}

const TARGET = [
  row(0, "3c040000", "lui\ta0,0x0"), reloc(0, "R_MIPS_HI16", "sym"),
  row(4, "24840000", "addiu\ta0,a0,0"), reloc(4, "R_MIPS_LO16", "sym"),
  row(8, "8c820000", "lw\tv0,0(a0)"),
  row(12, "00451021", "addu\tv0,v0,a1"),
  row(16, "03e00008", "jr\tra"),
  row(20, "00000000", "nop"),
  row(24, "00000000", "nop"),
];

test("simplify: relocations fold into the previous row; trailing nops drop", () => {
  const seq = simplify_objdump([...HEAD, ...TARGET], MIPS_SETTINGS, { stack_differences: false, ign_branch_targets: true });
  assert.deepEqual(seq.map((l) => [l.row, l.has_symbol]), [
    ["lui\ta0,%hi(sym)", true], ["addiu\ta0,a0,%lo(sym)", true], ["lw\tv0,0(a0)", false],
    ["addu\tv0,v0,a1", false], ["jr\tra", false],
  ]);
});

test("identical code scores 0", () => {
  assert.equal(score(scorerFor(TARGET), TARGET).score, 0);
});

test("one differing register field = one regalloc penalty (5)", () => {
  const cand = TARGET.slice();
  cand[5] = row(12, "00451821", "addu\tv1,v0,a1");
  const r = score(scorerFor(TARGET), cand);
  assert.deepEqual([r.score, r.penalties.regalloc], [5, 1]);
});

test("a swapped pair is one reordering (60)", () => {
  const cand = TARGET.slice();
  [cand[4], cand[5]] = [row(8, "00451021", "addu\tv0,v0,a1"), row(12, "8c820000", "lw\tv0,0(a0)")];
  const r = score(scorerFor(TARGET), cand);
  assert.deepEqual([r.score, r.penalties.reordering, r.penalties.insertion, r.penalties.deletion], [60, 1, 0, 0]);
});

test("an extra instruction is an insertion (100), a missing one a deletion (100)", () => {
  const extra = TARGET.slice();
  extra.splice(6, 0, row(16, "00801821", "move\tv1,a0"));
  assert.deepEqual([score(scorerFor(TARGET), extra).score, score(scorerFor(TARGET), extra).penalties.insertion], [100, 1]);
  const missing = TARGET.slice();
  missing.splice(5, 1);
  assert.deepEqual([score(scorerFor(TARGET), missing).score, score(scorerFor(TARGET), missing).penalties.deletion], [100, 1]);
});

test("branch targets: ignored by default, +1 with --no-ignore-branch-targets", () => {
  const t = [row(0, "10800003", "beqz\ta0,10 <f+0x10>"), row(4, "00000000", "nop"), row(8, "03e00008", "jr\tra")];
  const c = [row(0, "10800004", "beqz\ta0,14 <f+0x14>"), row(4, "00000000", "nop"), row(8, "03e00008", "jr\tra")];
  assert.equal(score(scorerFor(t), c).score, 0);
  const s = scorerFor(t, { ign_branch_targets: false });
  const r = score(s, c);
  assert.deepEqual([r.score, r.penalties.branch, r.penalties.regalloc], [1, 1, 0]);
});

test("stack offsets: masked by default, |delta| with --stack-diffs", () => {
  const t = [row(0, "8fa40010", "lw\ta0,16(sp)"), row(4, "03e00008", "jr\tra")];
  const c = [row(0, "8fa40018", "lw\ta0,24(sp)"), row(4, "03e00008", "jr\tra")];
  assert.equal(score(scorerFor(t), c).score, 0);
  const r = score(scorerFor(t, { stack_differences: true }), c);
  assert.deepEqual([r.score, r.penalties.stack], [8, 8]);
});

test("a section-relative relocation matches any symbol the target relocated", () => {
  const t = [row(0, "3c040000", "lui\ta0,0x0"), reloc(0, "R_MIPS_HI16", "sym"), row(4, "8c820000", "lw\tv0,0(a0)"), reloc(4, "R_MIPS_LO16", "sym")];
  const c = [row(0, "3c040000", "lui\ta0,0x0"), reloc(0, "R_MIPS_HI16", ".bss"), row(4, "8c820010", "lw\tv0,16(a0)"), reloc(4, "R_MIPS_LO16", ".bss")];
  const r = score(scorerFor(t), c);
  assert.deepEqual(r.cand.map((l) => l.row), ["lui\ta0,%hi(.bss)", "lw\tv0,%lo(.bss+0x10)(a0)"]);
  assert.equal(r.score, 0);
});

test("decimal immediates become hex unless glued to a letter; addiu on sp becomes imm", () => {
  const seq = simplify_objdump([...HEAD, row(0, "27bdffe8", "addiu\tsp,sp,-24"), row(4, "24420010", "addiu\tv0,v0,16"),
    row(8, "8c820000", "lw\tv0,0(a0)")], MIPS_SETTINGS, { stack_differences: false, ign_branch_targets: true });
  assert.deepEqual(seq.map((l) => l.row), ["addiu\tsp,sp,imm", "addiu\tv0,v0,0x10", "lw\tv0,0(a0)"]);
});

test("--algorithm levenshtein: rows come from Levenshtein.opcodes over remapped mnemonics", async () => {
  const { opcodes } = await import("../src/levenshtein.js");
  const cand = TARGET.slice();
  [cand[4], cand[5]] = [row(8, "00451021", "addu\tv0,v0,a1"), row(12, "8c820000", "lw\tv0,0(a0)")];
  const lev = score(scorerFor(TARGET, { algorithm: "levenshtein" }), cand);
  const t = ["lui", "addiu", "lw", "addu", "jr"], c = ["lui", "addiu", "addu", "lw", "jr"];
  const ids = new Map();
  const remap = (xs) => xs.map((m) => (ids.has(m) ? ids.get(m) : (ids.set(m, ids.size), ids.size - 1)));
  const ops = opcodes(remap(c), remap(t));
  // Every non-equal row is paired across the swap, so all of them are reorderings.
  const changed = ops.filter((o) => o[0] !== "equal").reduce((n, [, i1, i2]) => n + (i2 - i1), 0);
  assert.equal(lev.penalties.reordering, changed);
  assert.equal(lev.score, 60 * changed);
  assert.equal(score(scorerFor(TARGET, { algorithm: "levenshtein" }), TARGET).score, 0);
});
