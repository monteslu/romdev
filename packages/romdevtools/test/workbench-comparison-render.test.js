// Ported from the workbench's comparison tests that exercise the shared
// renderer: acceptance independent of the verdict, the relocation-symbol
// caution ahead of the counters, raw-vs-words, the explanation lines,
// diff sites, and the scratch acceptance line.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDisassembly } from "../src/decomp/workbench/objdump.js";
import { compareInstructions } from "../src/decomp/workbench/compare.js";
import { comparisonAcceptance, comparisonExplanationLines, comparisonLine, comparisonPayload, diffSiteLines, rawVersusWordsLines,
  relocationSymbolCautionLines, scratchAcceptanceLine, scratchScoreAcceptance, trueInstructionLines, warningLines } from "../src/decomp/workbench/comparison-render.js";

const cmp = (t, c, symbol = null) => compareInstructions(parseDisassembly(t, { symbol }), parseDisassembly(c, { symbol }), { target_name: "target.o", candidate_name: "candidate.o", symbol });
const MIXED_TARGET = "\n00000000 <demo>:\n   0: 24020021  li $v0,33\n   4: 012a4021  addu $t0,$t1,$t2\n   8: 03e00008  jr $ra\n   c: 00000000  nop\n";
const MIXED_CANDIDATE = "\n00000000 <demo>:\n   0: 24020031  li $v0,49\n   4: 012a5821  addu $t3,$t1,$t2\n   8: 03e00008  jr $ra\n   c: 00000000  nop\n";
const RELOC_TARGET = "\n00000000 <demo>:\n   0: 0c123456  jal 48d158 <callee>\n                        0: R_MIPS_26 callee\n   4: 3c010123  lui $at,0x123\n                        4: R_MIPS_HI16 global\n";
const RELOC_CANDIDATE = "\n00000000 <demo>:\n   0: 0c000000  jal 0 <callee>\n                        0: R_MIPS_26 callee\n   4: 3c010000  lui $at,0x0\n                        4: R_MIPS_HI16 global\n";

test("a different relocation symbol is not accepted; a different addend on the same symbol is", () => {
  const sym = cmp("  0: 3c020000 lui v0,0x0\n  0: R_MIPS_HI16 viMode\n", "  0: 3c020000 lui v0,0x0\n  0: R_MIPS_HI16 g_viOriginalHstart\n");
  assert.deepEqual(comparisonAcceptance(sym, { cross_rom: false }), [false, "relocation-symbol-mismatch"]);
  const add = cmp("  0: 3c020000 lui v0,0x0\n  0: R_MIPS_HI16 table\n", "  0: 3c020000 lui v0,0x0\n  0: R_MIPS_HI16 table+0x10\n");
  assert.equal(comparisonAcceptance(add, { cross_rom: false })[0], true);
});

test("an anonymous section target is called out; the symbol caution precedes the counters it qualifies", () => {
  const anon = cmp("  0: 3c020000 lui v0,0x0\n  0: R_MIPS_HI16 aNoGfxlist\n", "  0: 3c020000 lui v0,0x0\n  0: R_MIPS_HI16 .rodata+0x118\n");
  assert.ok(relocationSymbolCautionLines(anon).join("\n").includes("anonymous section offset"));
  const r = cmp("  0: 3c020000 lui v0,0x0\n  0: R_MIPS_HI16 viMode\n", "  0: 3c020000 lui v0,0x0\n  0: R_MIPS_HI16 osTvType\n");
  const lines = relocationSymbolCautionLines(r);
  assert.ok(lines.length); assert.ok(lines[0].includes("relocation-symbol caution")); assert.ok(lines.join("").includes("words=0 is a floor"));
  assert.ok(comparisonLine(r).includes("reloc_syms=   1"));
});

test("raw above words is explained once, as relocation-controlled; the payload carries acceptance", () => {
  const r = cmp(RELOC_TARGET, RELOC_CANDIDATE, "demo");
  const lines = rawVersusWordsLines(r).join("\n");
  if (r.raw_word_mismatches > r.word_mismatches) { assert.ok(lines.includes("relocation-controlled")); assert.ok(lines.includes("words=0 is the real gate")); }
  const p = comparisonPayload(r, { cross_rom: false });
  assert.equal(p.accepted, r.exact); assert.ok(["function-exact", "mismatch"].includes(p.acceptance_basis));
});

test("the explanation names every residual class and ends in one indented next footer; diff sites group by class", () => {
  const r = cmp(MIXED_TARGET, MIXED_CANDIDATE, "demo");
  const lines = comparisonExplanationLines(r, { cross_rom: false });
  assert.ok(lines.some((l) => l.startsWith("diff_sites=2 (")));
  const next = lines.filter((l) => l.startsWith("next: "));
  assert.equal(next.length, 1);
  assert.equal(comparisonExplanationLines(r, { cross_rom: false, guidance: false }).filter((l) => l.startsWith("next: ")).length, 0);
  const sites = diffSiteLines(r).join("\n");
  assert.ok(sites.includes("li $v0,33")); assert.ok(sites.includes("li $v0,49")); assert.ok(sites.includes("addu $t3,$t1,$t2"));
  assert.deepEqual(warningLines(["x"]), ["warning: x"]);
});

test("cross-ROM acceptance is labelled as structural evidence only", () => {
  const r = cmp("0: 3c080123  lui t0,0x123\n4: 25081234  addiu t0,t0,4660\n", "0: 3c084567  lui $t0,0x4567\n4: 250889ab  addiu $t0,$t0,-30293\n");
  assert.deepEqual(comparisonAcceptance(r, { cross_rom: true }), [true, "cross-rom-structural"]);
  assert.ok(comparisonExplanationLines(r, { cross_rom: true }).includes("acceptance: PASS (cross-ROM structural evidence only; exact=false)"));
});

test("scratch acceptance is raw-word and relocation-target exact, and says which failed", () => {
  const same = cmp(MIXED_TARGET, MIXED_TARGET, "demo");
  assert.deepEqual(scratchScoreAcceptance(same), [true, "local-score-proxy-exact"]);
  assert.ok(scratchAcceptanceLine(same).startsWith("ACCEPTED — "));
  const diff = cmp(MIXED_TARGET, MIXED_CANDIDATE, "demo");
  assert.deepEqual(scratchScoreAcceptance(diff), [false, "raw-instruction-word-mismatch"]);
  assert.ok(scratchAcceptanceLine(diff).includes("2 raw instruction words differ"));
  const addend = cmp("  0: 3c020000 lui v0,0x0\n  0: R_MIPS_HI16 table\n", "  0: 3c020000 lui v0,0x0\n  0: R_MIPS_HI16 table+0x10\n");
  assert.equal(scratchScoreAcceptance(addend)[1], "relocation-target-mismatch");
  assert.ok(scratchAcceptanceLine(addend).includes("1 relocation target differs"));
});

test("padding is reported only where it hides a real length", () => {
  const padded = "\n00000000 <demo>:\n   0: 848e004c  lh $t6,76($a0)\n   4: 03e00008  jr $ra\n   8: a4ae004c  sh $t6,76($a1)\n   c: 00000000  nop\n  10: 00000000  nop\n";
  const r = cmp(padded, padded, "demo");
  const lines = trueInstructionLines(r);
  if (r.target_true_instructions === r.target_instructions) assert.deepEqual(lines, []);
  else assert.ok(lines[0].startsWith("target padding:"));
});
