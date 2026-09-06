// decomp-diff.test.js — the comparison engine on synthetic MIPS streams:
// strict equality, the relocation-target trap, register-only vs immediate
// vs count differences, the documented distance, relocation application
// (HI16/LO16 carry, R_MIPS_26), objdump parsing, and TU splicing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { strictCompare, scoreDistance, classifyDifferences, changedRanges } from "../src/decomp/diff.js";
import { parseObjdump, prepareTargetAsm, trimToSize } from "../src/decomp/mips-obj.js";
import { applyRelocations, spliceFunction, extractFunction } from "../src/decomp/compile.js";
import { splitM2cOutput } from "../src/decomp/m2c.js";

const ins = (offset, word, mnemonic, operands, reloc = null) => ({ offset, word, mnemonic, operands, reloc });
const base = () => [
  ins(0, 0x27bdffe8, "addiu", "sp,sp,-24"),
  ins(4, 0xafbf0014, "sw", "ra,20(sp)"),
  ins(8, 0x0c000000, "jal", "0", { type: "R_MIPS_26", symbol: "callee", addend: 0 }),
  ins(12, 0x00000000, "nop", ""),
  ins(16, 0x8fbf0014, "lw", "ra,20(sp)"),
  ins(20, 0x03e00008, "jr", "ra"),
  ins(24, 0x27bd0018, "addiu", "sp,sp,24"),
];

test("strict: identical streams are exact; distance 0; no kinds", () => {
  const s = strictCompare(base(), base());
  assert.equal(s.exact, true); assert.equal(s.mismatchCount, 0);
  assert.equal(scoreDistance(base(), base()).value, 0);
  assert.deepEqual(classifyDifferences(base(), base(), s).kinds, []);
});

test("strict: same words, different relocation target FAILS (the call-target trap)", () => {
  const cand = base(); cand[2] = { ...cand[2], reloc: { type: "R_MIPS_26", symbol: "other_callee", addend: 0 } };
  const s = strictCompare(base(), cand);
  assert.equal(s.exact, false); assert.equal(s.mismatches[0].kind, "relocation-target");
  const c = classifyDifferences(base(), cand, s);
  assert.ok(c.kinds.includes("relocation-target")); assert.equal(c.evidence.relocationDifferences.count, 1);
  // Normalized score sees it too (reloc is part of the line).
  assert.ok(scoreDistance(base(), cand).value > 0);
});

test("strict: same size, one changed constant fails; classified as immediate", () => {
  const cand = base(); cand[0] = ins(0, 0x27bdffe0, "addiu", "sp,sp,-32"); cand[6] = ins(24, 0x27bd0020, "addiu", "sp,sp,32");
  const s = strictCompare(base(), cand);
  assert.equal(s.exact, false); assert.equal(s.mismatchCount, 2);
  const c = classifyDifferences(base(), cand, s);
  assert.ok(c.kinds.includes("immediate")); assert.ok(c.kinds.includes("stack-frame"));
  assert.deepEqual(c.evidence.stackFrame, { target: "sp,sp,-24", candidate: "sp,sp,-32" });
  assert.equal(changedRanges(s).count, 2);
});

test("register-only substitution is visible and scores cheaper than an instruction change", () => {
  const regOnly = base(); regOnly[1] = ins(4, 0xafb00014, "sw", "s0,20(sp)"); regOnly[4] = ins(16, 0x8fb00014, "lw", "s0,20(sp)");
  const s = strictCompare(base(), regOnly);
  const c = classifyDifferences(base(), regOnly, s);
  assert.deepEqual(c.kinds, ["register-allocation"]);
  assert.equal(c.evidence.registerSubstitutions.count, 2);
  const d1 = scoreDistance(base(), regOnly).value;
  const opChange = base(); opChange[1] = ins(4, 0xafbf0014, "sh", "ra,20(sp)"); opChange[4] = ins(16, 0x8fbf0014, "lh", "ra,20(sp)");
  const d2 = scoreDistance(base(), opChange).value;
  assert.ok(d1 < d2, `register-only ${d1} should be cheaper than op change ${d2}`);
  assert.equal(scoreDistance(base(), regOnly).metric, "levenshtein-instructions-v1");
});

test("instruction count differences and reordering are named", () => {
  const longer = [...base(), ins(28, 0x00000000, "nop", "")];
  const s = strictCompare(base(), longer);
  assert.equal(s.exact, false); assert.equal(s.mismatches[0].kind, "extra-instruction");
  assert.ok(classifyDifferences(base(), longer, s).kinds.includes("instruction-count"));
  const re = base(); [re[0], re[1]] = [re[1], re[0]]; re[0].offset = 0; re[1].offset = 4;
  const s2 = strictCompare(base(), re);
  assert.ok(classifyDifferences(base(), re, s2).kinds.includes("instruction-scheduling"));
});

test("applyRelocations: R_MIPS_26 and a HI16/LO16 pair with carry link to the expected words", () => {
  const stream = [
    ins(0, 0x0c000000, "jal", "0", { type: "R_MIPS_26", symbol: "callee", addend: 0 }),
    ins(4, 0x3c020000, "lui", "v0,0x0", { type: "R_MIPS_HI16", symbol: "D_1", addend: 0 }),
    ins(8, 0x24429000, "addiu", "v0,v0,-28672", { type: "R_MIPS_LO16", symbol: "D_1", addend: 0 }),
    ins(12, 0x3c030000, "lui", "v1,0x0", { type: "R_MIPS_HI16", symbol: "nowhere", addend: 0 }),
  ];
  const va = (n) => ({ callee: 0x80012340, D_1: 0x80100000 })[n] ?? null;
  const r = applyRelocations(stream, va, 0x80000000);
  assert.equal(r.stream[0].linkedWord, (0x0c000000 | ((0x80012340 >>> 2) & 0x03ffffff)) >>> 0);
  // D_1 + lo(-0x7000) → full = 0x800f9000 → hi = 0x800f + carry(0x9000 >= 0x8000 → +1) = 0x8010, lo = 0x9000
  assert.equal(r.stream[1].linkedWord, 0x3c028010);
  assert.equal(r.stream[2].linkedWord, 0x24429000);
  assert.deepEqual(r.unresolved, ["nowhere"]);
});

test("parseObjdump: symbols, words, operands, relocation lines; trimToSize drops padding", () => {
  const text = `\nx.o:     file format elf32-tradbigmips\n\n\nDisassembly of section .text:\n\n00000000 <func_X>:\n   0:\t27bdffe8 \taddiu\tsp,sp,-24\n   4:\t0c000000 \tjal\t0 <func_X>\n\t\t\t4: R_MIPS_26\tcallee\n   8:\t00000000 \tnop\n   c:\t3c020000 \tlui\tv0,0x0\n\t\t\tc: R_MIPS_HI16\tD_1\n  10:\t00000000 \tnop\n  14:\t00000000 \tnop\n`;
  const d = parseObjdump(text);
  const f = d.sections.get(".text").get("func_X");
  assert.equal(f.instructions.length, 6);
  assert.equal(f.instructions[1].reloc.symbol, "callee"); assert.equal(f.instructions[1].reloc.type, "R_MIPS_26");
  assert.equal(f.instructions[3].reloc.symbol, "D_1");
  assert.equal(f.instructions[1].operands, "0");
  assert.equal(trimToSize(f.instructions, 16).length, 4);
});

test("prepareTargetAsm: strips nonmatching markers, moves .late_rodata to .rodata after the text", () => {
  const out = prepareTargetAsm(`.section .late_rodata\nnonmatching D_1\ndlabel D_1\n .float 1.0\n\n.section .text\nnonmatching func_X, 0x8\nglabel func_X\n jr $ra\n nop\n`);
  assert.ok(!/^\s*nonmatching\s+(func_X|D_1)/m.test(out), "nonmatching size markers stripped");
  assert.ok(out.indexOf("glabel func_X") < out.indexOf(".section .rodata"));
  assert.ok(/\.macro glabel/.test(out));
});

test("spliceFunction: replaces a GLOBAL_ASM pragma, or an existing definition, and extractFunction round-trips", () => {
  const tu = `#include "x.h"\n\n#pragma GLOBAL_ASM("asm/nonmatchings/a/func_A.s")\n\nvoid func_B(s32 x) {\n    if (x) { x = 1; } /* } */\n}\n\n#pragma GLOBAL_ASM("asm/nonmatchings/a/func_C.s")\n`;
  const a = spliceFunction(tu, "func_A", "void func_A(void) {\n    return;\n}\n");
  assert.equal(a.replaced, "pragma"); assert.equal(a.line, 3);
  assert.ok(a.text.includes("void func_A(void)")); assert.ok(a.text.includes("func_C.s"));
  const b = spliceFunction(tu, "func_B", "void func_B(s32 x) {\n    x = 2;\n}");
  assert.equal(b.replaced, "definition");
  assert.ok(!b.text.includes("x = 1")); assert.ok(b.text.includes("func_C.s"));
  assert.equal(extractFunction(tu, "func_B"), "void func_B(s32 x) {\n    if (x) { x = 1; } /* } */\n}");
  assert.throws(() => spliceFunction(tu, "func_Z", "void func_Z(void) {}"), /neither a GLOBAL_ASM pragma nor a C definition/);
});

test("splitM2cOutput: invented declarations are separated from the body", () => {
  const r = splitM2cOutput(`? func_1(s32);                                   /* extern */\nextern ? D_2;\n\nvoid f(void) {\n    func_1(D_2);\n}\n`);
  assert.equal(r.declarations.length, 2); assert.ok(r.body.startsWith("void f(void)"));
});
