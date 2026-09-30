// Workbench object parsing and the layered comparison oracle: relocation
// masking, diff sites, verdicts, frame layout, true instruction counts and
// the LCS-aligned residual. Every fixture is synthetic objdump text.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { assemble } from "./fixtures/workbench/mips-asm.js";
import { buildElf32be, words } from "./fixtures/workbench/elf-fixtures.js";
import { ALIGNED_CLASS_KEYS, alignedResidual, commutativeSwap, compareInstructions, compareObjects, frameSaveLayout, mismatchRanges, normalizeInstruction } from "../src/decomp/workbench/compare.js";
import { mipsProbeObject, discoverObjdump, parseDisassembly, parseRelocations, trimFunctionPadding } from "../src/decomp/workbench/objdump.js";
import { RESIDUAL_CLASSES, buildView } from "../src/decomp/workbench/view.js";
import { sorted } from "../src/decomp/workbench/py.js";

const TARGET = `
00000000 <demo>:
   0: 27bdffe0  addiu $sp,$sp,-32
   4: afbf001c  sw $ra,28($sp)
   8: 460c0000  add.s $f0,$f0,$f12
   c: 10000002  b 18 <demo+0x18>
`;
const CANDIDATE = `
00000000 <demo>:
   0: 27bdffd0  addiu $sp,$sp,-48
   4: afbf002c  sw $ra,44($sp)
   8: 460c0800  add.s $f0,$f1,$f12
   c: 10000005  b 24 <demo+0x24>
`;
const RELOC_TARGET = `
00000000 <demo>:
   0: 0c123456  jal 48d158 <callee>
                        0: R_MIPS_26 callee
   4: 3c010123  lui $at,0x123
                        4: R_MIPS_HI16 global
`;
const RELOC_CANDIDATE = `
00000000 <demo>:
   0: 0c000000  jal 0 <callee>
                        0: R_MIPS_26 callee
   4: 3c010000  lui $at,0x0
                        4: R_MIPS_HI16 global
`;
const MIXED_TARGET = `
00000000 <demo>:
   0: 24020021  li $v0,33
   4: 012a4021  addu $t0,$t1,$t2
   8: 03e00008  jr $ra
   c: 00000000  nop
`;
const MIXED_CANDIDATE = `
00000000 <demo>:
   0: 24020031  li $v0,49
   4: 012a5821  addu $t3,$t1,$t2
   8: 03e00008  jr $ra
   c: 00000000  nop
`;

const cmp = (t, c, symbol = null, extra = {}) => compareInstructions(t, c, { target_name: "target.o", candidate_name: "candidate.o", symbol, ...extra });
const compareText = (t, c) => cmp(parseDisassembly(t), parseDisassembly(c));
const tmp = () => mkdtempSync(path.join(os.tmpdir(), "wb-compare-"));

test("frame layout separates observed saves from remainder", () => {
  const layout = frameSaveLayout(parseDisassembly(`
   0: 27bdffd8  addiu $sp,$sp,-40
   4: afb00008  sw $s0,8($sp)
   8: afb1000c  sw $s1,12($sp)
   c: afb20010  sw $s2,16($sp)
  10: afb30014  sw $s3,20($sp)
  14: afb40018  sw $s4,24($sp)
  18: afb5001c  sw $s5,28($sp)
  1c: afb60020  sw $s6,32($sp)
  20: afb70024  sw $s7,36($sp)
`));
  assert.equal(layout.observed_save_slot_count, 8);
  assert.equal(layout.observed_save_bytes, 32);
  assert.equal(layout.non_save_frame_bytes, 8);
});

test("frame save layout counts one physical slot once", () => {
  const layout = frameSaveLayout(parseDisassembly("   0: 27bdffe0  addiu $sp,$sp,-32\n   4: afb00010  sw $s0,16($sp)\n   8: afb10010  sw $s1,16($sp)\n"));
  assert.equal(layout.observed_save_slot_count, 1);
  assert.equal(layout.observed_save_bytes, 4);
  assert.equal(layout.non_save_frame_bytes, 28);
  assert.deepEqual(layout.observed_save_slots, [{ offset: 16, bytes: 4, registers: ["s0", "s1"] }]);
});

test("explicit objdump never silently falls back and must be executable", () => {
  assert.throws(() => discoverObjdump("/definitely/missing/mips-objdump"), /explicit objdump/);
  const p = path.join(tmp(), "objdump");
  writeFileSync(p, "#!/bin/sh\n");
  chmodSync(p, 0o644);
  assert.throws(() => discoverObjdump(p), /not executable/);
});

test("the capability probe is a MIPS relocatable object", () => {
  const probe = mipsProbeObject();
  assert.deepEqual([...probe.subarray(0, 7)], [0x7f, 0x45, 0x4c, 0x46, 1, 2, 1]);
  assert.equal(probe.readUInt16BE(16), 1);
  assert.equal(probe.readUInt16BE(18), 8);
  assert.ok(probe.includes("probe_func") && probe.includes("probe_external"));
});

test("parse and normalize", () => {
  const ins = parseDisassembly(TARGET);
  assert.equal(ins.length, 4);
  assert.equal(ins[0].word, "27bdffe0");
  assert.equal(normalizeInstruction(ins[1].assembly), "sw ra,OFF(sp)");
  assert.equal(normalizeInstruction(ins[3].assembly), "b ADDR");
  assert.equal(normalizeInstruction("addiu $t0,$t0,-1"), "addiu t0,t0,IMM");
});

test("symbol selection: exact, unique case fold, fold requires uniqueness", () => {
  const sel = parseDisassembly("00000000 <first>:\n   0: 03e00008  jr $ra\n00000004 <second>:\n   4: 00000000  nop\n", { symbol: "second" });
  assert.deepEqual(sel.map((i) => i.address), [4]);
  const folded = parseDisassembly("00000000 <func_ovl8_803781a4>:\n   0: 03e00008  jr $ra\n00000004 <other>:\n   4: 00000000  nop\n", { symbol: "func_ovl8_803781A4" });
  assert.deepEqual(folded.map((i) => i.address), [0]);
  const text = "00000000 <demo>:\n   0: 03e00008  jr $ra\n00000004 <DEMO>:\n   4: 00000000  nop\n";
  assert.deepEqual(parseDisassembly(text, { symbol: "Demo" }), []);
  assert.deepEqual(parseDisassembly(text, { symbol: "DEMO" }).map((i) => i.address), [4]);
});

test("selected symbol owns frame metric", () => {
  const sel = parseDisassembly("00000000 <first>:\n   0: 27bdffe0  addiu $sp,$sp,-32\n00000004 <second>:\n   4: 27bdffc0  addiu $sp,$sp,-64\n", { symbol: "second" });
  assert.equal(cmp(sel, sel, "second").candidate_frame_size, -64);
});

test("padding trim: two zero words trimmed, one kept, delay slot and nonzero content kept", () => {
  const two = parseDisassembly("00000000 <demo>:\n   0: 848e004c  lh $t6,76($a0)\n   4: 03e00008  jr $ra\n   8: a4ae004c  sh $t6,76($a1)\n   c: 00000000  nop\n  10: 00000000  nop\n", { symbol: "demo" });
  assert.deepEqual(two.map((i) => i.address), [0, 4, 8]);
  const one = parseDisassembly("00000000 <demo>:\n   0: 848e004c  lh $t6,76($a0)\n   4: 03e00008  jr $ra\n   8: a4ae004c  sh $t6,76($a1)\n   c: 00000000  nop\n", { symbol: "demo" });
  assert.equal(trimFunctionPadding(one), one);
  const slot = parseDisassembly("   0: 03e00008  jr $ra\n   4: 00000000  nop\n");
  assert.equal(trimFunctionPadding(slot), slot);
  const tail = parseDisassembly("   0: 03e00008  jr $ra\n   4: 00000000  nop\n   8: 24020001  li $v0,1\n");
  assert.equal(trimFunctionPadding(tail), tail);
});

test("comparison layers", () => {
  const r = cmp(parseDisassembly(TARGET), parseDisassembly(CANDIDATE), "demo");
  assert.equal(r.word_mismatches, 4);
  assert.equal(r.raw_word_mismatches, 4);
  assert.equal(r.opcode_mismatches, 0);
  assert.equal(r.normalized_distance, 1);
  assert.equal(r.fp_register_mismatches, 1);
  assert.deepEqual(r.fp_mismatch_ranges, [[2, 2]]);
  assert.equal(r.target_frame_size, -32);
  assert.equal(r.candidate_frame_size, -48);
  assert.equal(r.exact, false);
});

test("register comparison accepts objdump dialects and detects prefixless differences", () => {
  const r = cmp(parseDisassembly("   0: 012a4021  addu $t0,$t1,$t2\n   4: 460c0000  add.s $f0,$f0,$f12\n"),
    parseDisassembly("   0: 012a4021  addu t0,t1,t2\n   4: 460c0000  add.s f0,f0,f12\n"));
  assert.equal(r.register_mismatches, 0);
  assert.equal(r.fp_register_mismatches, 0);
  assert.deepEqual(r.candidate_fp_register_uses, { $f0: 2, $f12: 1 });
  const d = cmp(parseDisassembly("   0: 012a4021  addu t0,t1,t2\n"), parseDisassembly("   0: 016c5021  addu t2,t3,t4\n"));
  assert.equal(d.register_mismatches, 1);
  assert.deepEqual(d.register_diff[0].target_registers, ["t0", "t1", "t2"]);
});

test("symbolized hex address is not a register", () => {
  const r = cmp(parseDisassembly("   0: 10000027  bnez at,a0 <demo+0xa0>\n"), parseDisassembly("   0: 10000027  bnez at,85bc <demo+0xa0>\n"));
  assert.equal(r.register_mismatches, 0);
  assert.equal(r.fp_register_mismatches, 0);
});

test("relocation fields are masked precisely", () => {
  const t = parseDisassembly(RELOC_TARGET);
  const r = cmp(t, parseDisassembly(RELOC_CANDIDATE), "demo");
  assert.equal(r.raw_word_mismatches, 2);
  assert.equal(r.word_mismatches, 0);
  assert.equal(r.exact, true);
  assert.equal(r.verdict, "instruction-exact");
  assert.deepEqual(r.raw_difference_breakdown, { relocation_controlled: 2 });
  assert.deepEqual(t[0].relocations.map((x) => x.kind), ["R_MIPS_26"]);
});

test("unknown relocation cannot claim exact", () => {
  const text = "   0: 00000000  nop\n                        0: R_MIPS_FUTURE symbol\n";
  const r = cmp(parseDisassembly(text), parseDisassembly(text));
  assert.equal(r.word_mismatches, 0);
  assert.deepEqual(r.unknown_relocations, ["R_MIPS_FUTURE"]);
  assert.equal(r.exact, false);
  assert.equal(r.verdict, "unknown-relocation");
});

test("cross-ROM structural match is not object-exact", () => {
  const r = cmp(parseDisassembly("   0: 3c080123  lui t0,0x123\n   4: 25081234  addiu t0,t0,4660\n   8: 8d090020  lw t1,32(t0)\n"),
    parseDisassembly("   0: 3c084567  lui $t0,0x4567\n   4: 250889ab  addiu $t0,$t0,-30293\n   8: 8d090060  lw $t1,96($t0)\n"), "demo");
  assert.equal(r.exact, false);
  assert.equal(r.structural_exact, true);
  assert.equal(r.verdict, "operand-mismatch");
  assert.equal(r.normalized_distance, 0);
  assert.equal(r.register_mismatches, 0);
});

test("missing relocation cannot claim exact", () => {
  const r = cmp(parseDisassembly("  0: 0c001234 jal 48d0 <callee>\n  0: R_MIPS_26 callee\n"), parseDisassembly("  0: 0c005678 jal 159e0 <callee>\n"));
  assert.equal(r.word_mismatches, 0);
  assert.equal(r.relocation_metadata_mismatches, 1);
  assert.equal(r.exact, false);
  assert.equal(r.verdict, "relocation-layout-mismatch");
});

test("relocation target identity is a separate metric", () => {
  const r = cmp(parseDisassembly("  0: 0c000000 jal 0 <callee>\n  0: R_MIPS_26 callee+0x4\n"), parseDisassembly("  0: 0c000000 jal 0 <other>\n  0: R_MIPS_26 other+0x4\n"));
  assert.equal(r.exact, true);
  assert.equal(r.raw_word_mismatches, 0);
  assert.equal(r.relocation_metadata_mismatches, 0);
  assert.equal(r.relocation_target_mismatches, 1);
  assert.deepEqual(r.relocation_target_differences, [{ instruction_index: 0, relocation_index: 0, difference: "symbol", candidate_section_symbol: false,
    target_instruction_offset: 0, candidate_instruction_offset: 0,
    target: { offset: 0, kind: "R_MIPS_26", symbol: "callee", addend: 4, raw_target: "callee+0x4" },
    candidate: { offset: 0, kind: "R_MIPS_26", symbol: "other", addend: 4, raw_target: "other+0x4" } }]);
});

test("a different relocation symbol is counted apart from an addend", () => {
  const r = cmp(parseDisassembly("  0: 3c020000 lui v0,0x0\n  0: R_MIPS_HI16 viMode\n"), parseDisassembly("  0: 3c020000 lui v0,0x0\n  0: R_MIPS_HI16 g_viOriginalHstart\n"));
  assert.equal(r.word_mismatches, 0);
  assert.equal(r.opcode_mismatches, 0);
  assert.equal(r.aligned_gaps, 0);
  assert.equal(r.relocation_symbol_mismatches, 1);
  assert.equal(r.verdict, "relocation-symbol-mismatch");
  assert.equal(r.relocation_target_differences[0].difference, "symbol");
});

test("a different addend on the same symbol is not a symbol mismatch", () => {
  const r = cmp(parseDisassembly("  0: 3c020000 lui v0,0x0\n  0: R_MIPS_HI16 table\n"), parseDisassembly("  0: 3c020000 lui v0,0x0\n  0: R_MIPS_HI16 table+0x10\n"));
  assert.equal(r.relocation_target_mismatches, 1);
  assert.equal(r.relocation_symbol_mismatches, 0);
  assert.equal(r.relocation_target_differences[0].difference, "addend");
  assert.equal(r.verdict, "instruction-words-identical");
});

test("an anonymous section target is flagged against a named object", () => {
  const r = cmp(parseDisassembly("  0: 3c020000 lui v0,0x0\n  0: R_MIPS_HI16 aNoGfxlist\n"), parseDisassembly("  0: 3c020000 lui v0,0x0\n  0: R_MIPS_HI16 .rodata+0x118\n"));
  assert.equal(r.relocation_target_differences[0].candidate_section_symbol, true);
});

test("positionally opcode-exact streams never gain LCS gaps", () => {
  const r = cmp(parseDisassembly("  0: 01094021 addu t0,t0,t1\n  4: 012a4821 addu t1,t1,t2\n  8: 014b5021 addu t2,t2,t3\n"),
    parseDisassembly("  0: 012a4821 addu t1,t1,t2\n  4: 014b5021 addu t2,t2,t3\n  8: 016c5821 addu t3,t3,t4\n"));
  assert.equal(r.opcode_mismatches, 0);
  assert.equal(r.aligned_gaps, 0);
  assert.equal(r.alignment_method, "positional-opcode");
  assert.equal(r.alignment_comparable, true);
});

test("raw identity is scoped to instruction words", () => {
  const ins = parseDisassembly(TARGET);
  const r = cmp(ins, ins, "demo");
  assert.equal(r.exact, true);
  assert.equal(r.verdict, "instruction-words-identical");
});

test("register verdict still reports the literal site and names it first", () => {
  const r = cmp(parseDisassembly(MIXED_TARGET, { symbol: "demo" }), parseDisassembly(MIXED_CANDIDATE, { symbol: "demo" }), "demo");
  assert.equal(r.verdict, "allocation-mismatch");
  assert.deepEqual(r.register_mismatch_ranges, [[1, 1]]);
  assert.equal(r.raw_word_mismatches, 2);
  assert.deepEqual(r.diff_site_classes, { constant: 1, register: 1 });
  const literal = r.diff_sites.filter((s) => s.class === "constant");
  assert.equal(literal.length, 1);
  assert.deepEqual([literal[0].index, literal[0].target, literal[0].candidate], [0, "li $v0,33", "li $v0,49"]);
  assert.match(r.guidance[0], /constant materializations/);
});

test("every differing word becomes a diff site", () => {
  for (const [t, c] of [[TARGET, CANDIDATE], [MIXED_TARGET, MIXED_CANDIDATE], [RELOC_TARGET, RELOC_CANDIDATE], [TARGET, MIXED_CANDIDATE]]) {
    const r = compareText(t, c);
    assert.equal(r.diff_sites.filter((s) => s.target_word !== s.candidate_word).length, r.raw_word_mismatches);
    assert.equal(Object.values(r.diff_site_classes).reduce((a, b) => a + b, 0), r.diff_sites.length);
  }
});

test("length and relocation layout differences are diff sites", () => {
  const r = compareText("   0: 03e00008  jr $ra\n   4: 00000000  nop\n", "   0: 03e00008  jr $ra\n   4: 00000000  nop\n   8: 24020001  li $v0,1\n");
  assert.deepEqual(r.diff_site_classes, { "instruction-count": 1 });
  assert.equal(r.diff_sites[0].target, "-");
  assert.equal(r.diff_sites[0].candidate, "li $v0,1");
  assert.deepEqual(compareText("  0: 0c001234 jal 48d0 <callee>\n  0: R_MIPS_26 callee\n", "  0: 0c005678 jal 159e0 <callee>\n").diff_site_classes, { "relocation-layout": 1 });
});

test("swapped commutative operands are not an allocation verdict", () => {
  const r = compareText("   0: 00851025  or $v0,$a0,$a1\n", "   0: 00a41025  or $v0,$a1,$a0\n");
  assert.equal(r.verdict, "commutative-order");
  assert.deepEqual(r.diff_site_classes, { "commutative-order": 1 });
  assert.equal(r.register_mismatches, 1);
  const g = r.guidance.join(" ");
  assert.ok(g.includes("|="));
  assert.ok(!g.replace("Do not trace", "").includes("trace"));
  assert.equal(compareText("   0: 00851025  or $v0,$a0,$a1\n", "   0: 00851825  or $v1,$a0,$a1\n").verdict, "allocation-mismatch");
});

test("reordered identical opcodes are a schedule verdict", () => {
  const r = compareText("   0: 8c880000  lw $t0,0($a0)\n   4: 25290001  addiu $t1,$t1,1\n", "   0: 25290001  addiu $t1,$t1,1\n   4: 8c880000  lw $t0,0($a0)\n");
  assert.equal(r.verdict, "schedule-mismatch");
  assert.equal(r.opcode_mismatches, 2);
  assert.equal(r.instruction_delta, 0);
  const g = r.guidance.join(" ");
  for (const s of ["-g0", "replay-as1", "does not prove source correctness"]) assert.ok(g.includes(s), s);
});

test("reordering with a register difference is a structure verdict", () => {
  const r = compareText("   0: 8c880000  lw $t0,0($a0)\n   4: 25290001  addiu $t1,$t1,1\n   8: 016c5021  addu $t2,$t3,$t4\n",
    "   0: 25290001  addiu $t1,$t1,1\n   4: 8c880000  lw $t0,0($a0)\n   8: 016c6821  addu $t5,$t3,$t4\n");
  assert.deepEqual(r.diff_site_classes, { opcode: 2, register: 1 });
  assert.equal(r.verdict, "structure-mismatch");
  assert.ok(!r.guidance.join(" ").includes("not allocation"));
  assert.equal(compareText("   0: 8c880000  lw $t0,0($a0)\n   4: 25290001  addiu $t1,$t1,1\n", "   0: 25290001  addiu $t1,$t1,1\n   4: 25290001  addiu $t1,$t1,1\n").verdict, "structure-mismatch");
});

test("two-operand commutative swap is recognized; div is not", () => {
  const m = compareText("   0: 00850018  mult $a0,$a1\n", "   0: 00a40018  mult $a1,$a0\n");
  assert.deepEqual(m.diff_site_classes, { "commutative-order": 1 });
  assert.equal(m.verdict, "commutative-order");
  const d = compareText("   0: 0085001a  div $a0,$a1\n", "   0: 00a4001a  div $a1,$a0\n");
  assert.deepEqual(d.diff_site_classes, { register: 1 });
  assert.equal(d.verdict, "allocation-mismatch");
});

test("register verdict guidance: commutative callout, plain first line, frame gate, unresolved ownership", () => {
  const r = compareText("   0: 00851025  or $v0,$a0,$a1\n   4: 012a4021  addu $t0,$t1,$t2\n", "   0: 00a41025  or $v0,$a1,$a0\n   4: 012a5821  addu $t3,$t1,$t2\n");
  assert.deepEqual(r.diff_site_classes, { "commutative-order": 1, register: 1 });
  assert.equal(r.verdict, "allocation-mismatch");
  assert.match(r.guidance[0], /commutative/);
  const plain = compareText("   0: 012a4021  addu $t0,$t1,$t2\n", "   0: 012a5821  addu $t3,$t1,$t2\n");
  assert.ok(plain.guidance[0].startsWith("Opcode shape matches"));
  const g = plain.guidance;
  const v = g.findIndex((l) => l.includes("`view` or `diagnose`")), tr = g.findIndex((l) => l.includes("globalcolor/UGEN"));
  assert.ok(v >= 0 && v < tr);
  assert.ok(g[v].includes("no instrumented toolchain") && g[v].includes("ownership unresolved"));
  assert.ok(g[tr].includes("neither trace-first"));
  const f = compareText("   0: 27bdffd8  addiu $sp,$sp,-40\n   4: 012a4021  addu $t0,$t1,$t2\n", "   0: 27bdffb8  addiu $sp,$sp,-72\n   4: 012a5821  addu $t3,$t1,$t2\n");
  assert.equal(f.verdict, "allocation-mismatch");
  assert.ok(f.guidance[0].includes("target -40, candidate -72"));
  assert.ok(f.guidance[1].includes("separate acceptance gate") && f.guidance[1].includes("cannot compensate"));
});

test("literal-only, linker-controlled, frame and structure constant verdicts", () => {
  const c = compareText("   0: 24020021  li $v0,33\n", "   0: 24020031  li $v0,49\n");
  assert.equal(c.verdict, "constant-mismatch");
  assert.ok(c.guidance.join(" ").includes("assembly encodes the truth") && c.guidance.join(" ").includes("fake"));
  const l = compareText("   0: 24020021  li $v0,33\n   4: 3c010123  lui $at,0x123\n                        4: R_MIPS_HI16 global\n",
    "   0: 24020031  li $v0,49\n   4: 3c010000  lui $at,0x0\n                        4: R_MIPS_HI16 global\n");
  assert.deepEqual(l.diff_site_classes, { constant: 1, "relocation-controlled": 1 });
  assert.equal(l.verdict, "constant-mismatch");
  const fr = compareText("   0: 27bdffe0  addiu $sp,$sp,-32\n", "   0: 27bdffd0  addiu $sp,$sp,-48\n");
  assert.deepEqual(fr.diff_site_classes, { operand: 1 });
  assert.equal(fr.verdict, "operand-mismatch");
  const s = compareText("   0: 3c081000  lui $t0,0x1000\n   4: 8c880000  lw $t0,0($a0)\n", "   0: 3c080010  lui $t0,0x10\n");
  assert.equal(s.verdict, "structure-mismatch");
  assert.match(s.guidance[0], /constant materializations/);
});

test("parse relocations and ranges", () => {
  const r = parseRelocations(RELOC_TARGET);
  assert.equal(r.get(0)[0].symbol, "callee");
  assert.equal(r.get(4)[0].kind, "R_MIPS_HI16");
  assert.deepEqual(mismatchRanges([]), []);
  assert.deepEqual(mismatchRanges([1, 2, 3, 7, 9, 10]), [[1, 3], [7, 7], [9, 10]]);
});

const PADDED_TARGET = "\n00000000 <demo>:\n   0: 848e004c  lh $t6,76($a0)\n   4: 03e00008  jr $ra\n   8: a4ae004c  sh $t6,76($a1)\n   c: 00000000  nop\n  10: 00000000  nop\n";
const UNPADDED_CANDIDATE = "\n00000000 <demo>:\n   0: 848e004c  lh $t6,76($a0)\n   4: 848f0050  lh $t7,80($a0)\n   8: a4ae004c  sh $t6,76($a1)\n   c: a4af0050  sh $t7,80($a1)\n  10: 03e00008  jr $ra\n";

test("padded counts hide a real length difference, and the report says so", () => {
  const t = parseDisassembly(PADDED_TARGET), c = parseDisassembly(UNPADDED_CANDIDATE);
  assert.equal(t.length, c.length);
  const r = cmp(t, c);
  assert.equal(r.target_instructions, r.candidate_instructions);
  assert.equal(r.target_true_instructions, 3);
  assert.equal(r.candidate_true_instructions, 5);
  assert.equal(r.true_instruction_delta, 2);
  assert.equal(r.instruction_count_verified, false);
  assert.ok(r.warnings.some((w) => w.includes("true instruction count differs")));
});

test("agreeing true counts carry no warning; ELF-measured counts override", () => {
  const t = parseDisassembly(TARGET, { symbol: "demo" });
  const r = cmp(t, parseDisassembly(TARGET, { symbol: "demo" }), "demo");
  assert.equal(r.target_true_instructions, r.candidate_true_instructions);
  assert.ok(!r.warnings.some((w) => w.includes("true instruction count")));
  const p = parseDisassembly(PADDED_TARGET, { symbol: "demo" });
  const o = cmp(p, p, "demo", { target_true_instructions: 3, candidate_true_instructions: 5, instruction_count_verified: true });
  assert.equal(o.candidate_true_instructions, 5);
  assert.equal(o.instruction_count_verified, true);
});

test("compareObjects reads the true count from the ELF file", () => {
  const root = tmp();
  const objdump = path.join(root, "objdump");
  writeFileSync(objdump, "#!/bin/sh\nprintf '00000000 <demo>:\\n   0:\\t00000000 \\tnop\\n   4:\\t03e00008 \\tjr\\tra\\n   8:\\t27bd0010 \\taddiu\\tsp,sp,16\\n'\n");
  chmodSync(objdump, 0o755);
  const jr = 0x03E00008;
  writeFileSync(path.join(root, "target.o"), buildElf32be({ ".text": words(0, jr, 0x27BD0010, 0, 0, 0) }));
  writeFileSync(path.join(root, "candidate.o"), buildElf32be({ ".text": words(0, jr, 0x27BD0010) }));
  const r = compareObjects(path.join(root, "target.o"), path.join(root, "candidate.o"), { objdump });
  assert.equal(r.target_true_instructions, 3);
  assert.equal(r.candidate_true_instructions, 3);
  assert.equal(r.instruction_count_verified, true);
  assert.ok(!r.warnings.some((w) => w.includes("true instruction count")));
});

test("commutative predicate: operand shapes, and compare and view agree", () => {
  assert.equal(commutativeSwap("or", ["t0", "t1", "t2"], ["t0", "t2", "t1"]), true);
  assert.equal(commutativeSwap("mult", ["t1", "t2"], ["t2", "t1"]), true);
  assert.equal(commutativeSwap("subu", ["t0", "t1", "t2"], ["t0", "t2", "t1"]), false);
  assert.equal(commutativeSwap("div", ["t1", "t2"], ["t2", "t1"]), false);
  assert.equal(commutativeSwap("or", ["t0", "t1", "t2"], ["t0", "t1", "t2"]), false);
  assert.equal(commutativeSwap("or", ["t0", "t1", "t2"], ["t3", "t2", "t1"]), false);
  assert.equal(commutativeSwap("or", ["t0", "t1"], ["t0", "t1", "t2"]), false);
  const cases = [
    ["   0: 00851025  or $v0,$a0,$a1\n", "   0: 00a41025  or $v0,$a1,$a0\n", "commutative"],
    ["   0: 00850018  mult $a0,$a1\n", "   0: 00a40018  mult $a1,$a0\n", "commutative"],
    ["   0: 0085001a  div $a0,$a1\n", "   0: 00a4001a  div $a1,$a0\n", "register"],
    ["   0: 00851023  subu $v0,$a0,$a1\n", "   0: 00a41023  subu $v0,$a1,$a0\n", "register"],
    ["   0: 00851025  or $v0,$a0,$a1\n", "   0: 00a41825  or $v1,$a1,$a0\n", "register"],
  ];
  for (const [t, c, mech] of cases) {
    assert.deepEqual(compareText(t, c).diff_site_classes, { [mech === "commutative" ? "commutative-order" : "register"]: 1 });
    const view = buildView(parseDisassembly(t), parseDisassembly(c), { target_name: "target.o", candidate_name: "candidate.o" });
    assert.equal(view.counts[mech], 1);
    assert.equal(view.counts[mech === "commutative" ? "register" : "commutative"] ?? 0, 0);
  }
});

const ALIGN_TARGET = ["addiu sp,sp,-32", "sw ra,28(sp)", "lw t0,0(a0)", "lw t1,4(a0)", "addu t2,t0,t1", "sw t2,8(a0)", "lw ra,28(sp)", "jr ra", "addiu sp,sp,32"];
const SHIFTED = ["addiu sp,sp,-32", "sw ra,28(sp)", "nop", "lw t0,0(a0)", "lw t1,4(a0)", "addu t2,t0,t1", "sw t2,8(a0)", "lw ra,28(sp)", "jr ra", "addiu sp,sp,32"];
const RECOLORED = ["addiu sp,sp,-32", "sw ra,28(sp)", "lw t4,0(a0)", "lw t5,4(a0)", "addu t2,t4,t5", "sw t2,8(a0)", "lw ra,28(sp)", "jr ra", "addiu sp,sp,32"];
const asm = (lines) => parseDisassembly(assemble(lines, { symbol: "demo" }), { symbol: "demo" });
const compareLines = (t, c) => cmp(asm(t), asm(c), "demo");

test("the aligned counts are the view counts", () => {
  const t = asm(ALIGN_TARGET), c = asm(SHIFTED);
  const comparison = cmp(t, c, "demo");
  const view = buildView(t, c, { target_name: "target.o", candidate_name: "candidate.o", symbol: "demo" });
  for (const name of RESIDUAL_CLASSES) assert.equal(comparison[`aligned_${name}`], view.counts[name] ?? 0, name);
  assert.equal(comparison.aligned_total, ALIGNED_CLASS_KEYS.reduce((n, k) => n + comparison[k], 0));
});

test("an insertion is one aligned difference; ranking follows the aligned residual", () => {
  const shifted = compareLines(ALIGN_TARGET, SHIFTED), recolored = compareLines(ALIGN_TARGET, RECOLORED);
  assert.equal(shifted.aligned_structural, 1);
  assert.equal(shifted.aligned_total, 1);
  assert.ok(shifted.word_mismatches > shifted.aligned_total);
  assert.equal(recolored.aligned_register, 3);
  assert.ok(shifted.word_mismatches > recolored.word_mismatches);
  assert.ok(shifted.aligned_total < recolored.aligned_total);
  shifted.candidate = "shifted.o"; recolored.candidate = "recolored.o";
  const order = sorted([recolored, shifted], (i) => i.sort_key);
  assert.deepEqual(order.map((i) => i.candidate), ["shifted.o", "recolored.o"]);
});

test("residual classes exclude match, displacement and relocation", () => {
  assert.deepEqual(new Set(ALIGNED_CLASS_KEYS), new Set(RESIDUAL_CLASSES.map((n) => `aligned_${n}`)));
  for (const x of ["match", "displacement", "relocation"]) assert.ok(!ALIGNED_CLASS_KEYS.includes(`aligned_${x}`));
});

test("jump table section addends do not inflate aligned total", () => {
  const r = cmp(parseDisassembly("   0: 3c010000  lui $at,0x0\n                        0: R_MIPS_HI16 jtbl_8009AE9C\n   4: 00380821  addu $at,$at,$t8\n   8: 8c380000  lw $t8,0($at)\n                        8: R_MIPS_LO16 jtbl_8009AE9C\n"),
    parseDisassembly("   0: 3c010000  lui $at,0x0\n                        0: R_MIPS_HI16 .rodata\n   4: 00380821  addu $at,$at,$t8\n   8: 8c3800ac  lw $t8,172($at)\n                        8: R_MIPS_LO16 .rodata\n"));
  assert.equal(r.exact, true);
  assert.equal(r.aligned_total, 0);
  assert.equal(r.aligned_schedule, 0);
  assert.equal(r.aligned_constant, 0);
});

test("an empty side is never reported as agreement", () => {
  const t = asm(ALIGN_TARGET);
  const counts = alignedResidual(t, []);
  assert.equal(counts.aligned_structural, t.length);
  assert.equal(Object.values(counts).reduce((a, b) => a + b, 0), t.length);
  assert.deepEqual(alignedResidual([], []), Object.fromEntries(ALIGNED_CLASS_KEYS.map((k) => [k, 0])));
});
