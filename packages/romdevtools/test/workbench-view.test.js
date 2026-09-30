// Aligned mechanism view: alignment, classification, lanes, colorability,
// ownership and routing. Every fixture is synthetic assembly rendered by the
// fixture assembler; nothing comes from a compiler or a ROM.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { assemble } from "./fixtures/workbench/mips-asm.js";
import { parseDisassembly } from "../src/decomp/workbench/objdump.js";
import { Instruction } from "../src/decomp/workbench/model.js";
import { VIEW_METRICS_BY_KEY } from "../src/decomp/workbench/schema.js";
import { parseGlobalcolorTrace, passEvidence, registerForColor } from "../src/decomp/workbench/globalcolor.js";
import { dumps } from "../src/decomp/workbench/pyjson.js";
import { replace } from "../src/decomp/workbench/py.js";
import {
  REGISTER_CLASS_PROFILES, Web, buildView, classifyPair, colorableRegisters, destinationRegister, schemaKeys,
  uncolorableTargets, ownershipFor, routingFor, sequenceOpcodes, PassEvidence,
  BASIS_HEURISTIC, BASIS_NONE, BASIS_TRACE, BASIS_VALUES, OWNING_PASS_CFE, OWNING_PASS_G0_SCHEDULER, OWNING_PASS_LOAD_FORM,
  OWNING_PASS_NONE, OWNING_PASS_STACK_HOME, OWNING_PASS_UGEN_RING, OWNING_PASS_UNKNOWN, OWNING_PASS_UOPT_COLOR,
  OWNING_PASS_VALUES, REACHABILITY_PASS_OWNED, REACHABILITY_PERMUTER, REACHABILITY_SOURCE, REACHABILITY_UNKNOWN,
  REACHABILITY_VALUES, ROUTING_IMPORT_FIX, ROUTING_NONE, ROUTING_PERMUTER_FIRST, ROUTING_STRUCTURAL, ROUTING_VALUES,
  PERMUTER_ROUTING_SENTENCE,
} from "../src/decomp/workbench/view.js";
import { REGISTER_STATE_SCHEMA, RegisterReservations, loadReservations } from "../src/decomp/workbench/register-state.js";

const SYMBOL = "demo";
const PROLOGUE = ["addiu sp,sp,-32", "sw ra,28(sp)", "sw s0,24(sp)", "move s0,a0"];
const EPILOGUE = ["lw ra,28(sp)", "lw s0,24(sp)", "jr ra", "addiu sp,sp,32"];
const body = (...lines) => [...PROLOGUE, ...lines, ...EPILOGUE];

function viewOf(target, candidate, { symbol = SYMBOL, relocations = null, candidate_relocations = null, evidence = null } = {}) {
  const t = assemble(target, { symbol, relocations });
  const c = assemble(candidate, { symbol, relocations: candidate_relocations === null ? relocations : candidate_relocations });
  return buildView(parseDisassembly(t, { symbol }), parseDisassembly(c, { symbol }),
    { target_name: "target.objdump", candidate_name: "candidate.objdump", symbol, evidence });
}
/** The ownership/routing tests wrap their lines in the prologue themselves. */
const wrapped = (target, candidate, opts) => viewOf(body(...target), body(...candidate), opts);
const lane = (view, name) => view.lanes.find((l) => l.classification === name);
const joined = (view) => view.guidance.join(" ");

// ---------------------------------------------------------------- sequence matcher

test("sequence matcher reproduces longest-block opcodes on a known case", () => {
  assert.deepEqual(sequenceOpcodes([..."abxcd"], [..."abcd"]), [["equal", 0, 2, 0, 2], ["delete", 2, 3, 2, 2], ["equal", 3, 5, 2, 4]]);
  assert.deepEqual(sequenceOpcodes([..."qabxcd"], [..."abycdf"]),
    [["delete", 0, 1, 0, 0], ["equal", 1, 3, 0, 2], ["replace", 3, 4, 2, 3], ["equal", 4, 6, 3, 5], ["insert", 6, 6, 5, 6]]);
  assert.deepEqual(sequenceOpcodes([], []), []);
});

// ---------------------------------------------------------------- assembler fixture

test("fixture assembler: words track operands, identical input encodes identically, labels resolve", () => {
  const first = assemble(["addu t6,t0,t1"]), second = assemble(["addu t7,t0,t1"]);
  assert.ok(first.includes("addu $t6,$t0,$t1"));
  assert.notEqual(parseDisassembly(first)[0].word, parseDisassembly(second)[0].word);
  const lines = body("lw t6,0(s0)", "addu t7,t6,t6");
  assert.equal(assemble(lines), assemble(lines));
  assert.ok(assemble(["bne a0,zero,@3", "nop", "nop", "jr ra", "nop"]).includes("bne $a0,$zero,c <demo+0xc>"));
});

// ---------------------------------------------------------------- alignment

test("shifted insertion is one hunk, not a phantom cascade", () => {
  const target = body("bne a0,zero,@10", "lw t6,0(s0)", "addu t7,t6,t6", "sw t7,4(s0)", "lw t8,8(s0)", "addu t9,t8,t7");
  const candidate = body("bne a0,zero,@11", "nop", "lw t6,0(s0)", "addu t7,t6,t6", "sw t7,4(s0)", "lw t8,8(s0)", "addu t9,t8,t7");
  const view = viewOf(target, candidate);
  assert.equal(view.counts.structural, 1);
  assert.equal(view.hunks.length, 1);
  assert.equal(view.verdict, "structure");
  assert.equal(view.counts.displacement, 1);
  assert.equal(view.counts.match, target.length - 1);
});

test("branch targets are alignment-relative", () => {
  const view = viewOf(body("bne a0,zero,@10", "nop", "nop", "nop", "nop", "nop"), body("bne a0,zero,@11", "nop", "nop", "nop", "nop", "nop", "nop"));
  const branch = view.rows.find((r) => (r.target || "").startsWith("bne"));
  assert.equal(branch.classification, "displacement");
  assert.notEqual(branch.target, branch.candidate);
  assert.equal(branch.matched, false);
  assert.equal(branch.reported, false);
  assert.ok(view.hunks.every((h) => h.start !== branch.index));
});

test("a relocated call is never read as a local branch", () => {
  const view = viewOf(body("jal helper", "nop"), body("jal helper", "nop"), { relocations: { 4: "R_MIPS_26 helper" } });
  assert.equal(view.verdict, "exact");
});

test("insertion into a duplicated opcode run is one hunk", () => {
  const target = body(...[2, 3, 4, 5].map((i) => `addu t${i},t0,t1`));
  const view = viewOf(target, body("addu t2,t0,t1", "addu t3,t0,t1", "addu t9,t0,t1", "addu t4,t0,t1", "addu t5,t0,t1"));
  assert.equal(view.verdict, "structure");
  assert.equal(view.counts.structural, 1);
  assert.equal(view.counts.register, 0);
  assert.equal(view.hunks.length, 1);
  assert.equal(view.counts.match, target.length);
});

test("the better of the two anchorings wins", () => {
  const target = body("addu t2,t0,t1", "addu t2,t0,t1", "addu t2,t0,t1");
  const view = viewOf(target, body("addu t2,t0,t1", "addu t2,t0,t1", "addu t2,t0,t1", "addu t2,t0,t1"));
  assert.equal(view.counts.match, target.length);
  assert.equal(view.counts.structural, 1);
});

// ---------------------------------------------------------------- phase shift evidence

test("one substitution is not a phase", () => {
  const view = viewOf(body("lw s1,0(s0)"), body("lw s2,0(s0)"));
  assert.equal(view.verdict, "register-permutation");
});

test("two-register swap is a permutation, not a phase", () => {
  const view = viewOf(body("lw s1,0(s0)", "lw s2,4(s0)", "sw s1,8(s0)", "sw s2,12(s0)"), body("lw s2,0(s0)", "lw s1,4(s0)", "sw s2,8(s0)", "sw s1,12(s0)"));
  assert.equal(view.verdict, "register-permutation");
  assert.equal(lane(view, "pool").rotation, null);
});

test("inconsistent substitutions are allocation, not a phase", () => {
  const view = viewOf(body("lw s1,0(s0)", "lw s3,4(s0)", "lw s4,8(s0)", "addu s1,s1,s3", "sw s1,12(s0)"),
    body("lw s2,0(s0)", "lw s1,4(s0)", "lw s2,8(s0)", "addu s2,s2,s1", "sw s2,12(s0)"));
  assert.equal(view.verdict, "allocation");
});

test("a reordered stream is schedule, not a phase", () => {
  const view = viewOf(body("lw t6,0(s0)", "lw t7,4(s0)", "lw t8,8(s0)"), body("lw t8,8(s0)", "lw t7,4(s0)", "lw t6,0(s0)"));
  assert.equal(view.verdict, "schedule");
});

test("a diverging lane without a rotation blocks the phase claim", () => {
  const view = viewOf(
    body("lw t6,0(s0)", "lw t7,4(s0)", "addu t8,t6,t7", "lw t9,8(s0)", "addu t6,t8,t9", "andi t7,t6,0xff", "sll t8,t7,2", "lw s1,16(s0)", "sw s1,20(s0)", "lw s1,24(s0)"),
    body("lw t6,0(s0)", "lw t7,4(s0)", "addu t8,t6,t7", "lw t9,8(s0)", "addu t7,t8,t9", "andi t8,t7,0xff", "sll t9,t8,2", "lw s3,16(s0)", "sw s3,20(s0)", "lw s4,24(s0)"));
  assert.equal(view.verdict, "allocation");
  assert.equal(lane(view, "temp").rotation, 1);
  assert.equal(lane(view, "pool").rotation, null);
});

// ---------------------------------------------------------------- displacement / symbol tables

test("displacement is counted, does not open a hunk, and does not claim byte identity", () => {
  const view = viewOf(body("bne a0,zero,@8", "nop", "nop", "nop"), body("bne a0,zero,@9", "nop", "nop", "nop", "nop"));
  assert.equal(view.counts.displacement, 1);
  assert.equal(view.hunks.length, 1);
  assert.equal(view.hunks[0].classification, "structural");
  const payload = view.asDict();
  assert.equal(payload.displacement, 1);
  assert.equal(payload.match + payload.displacement, view.aligned_rows - 1);
});

const STRIPPED = "00000000 <.text>:\n"
  + "   0: 27bdffe0  addiu $sp,$sp,-32\n"
  + "   4: afbf001c  sw $ra,28($sp)\n"
  + "   8: 0c000000  jal 0x0\n"
  + "                        8: R_MIPS_26 helper\n"
  + "   c: 00000000  nop\n"
  + "  10: 10000002  b 0x1c\n"
  + "  14: 00000000  nop\n"
  + "  18: 00000000  nop\n"
  + "  1c: 8fbf001c  lw $ra,28($sp)\n"
  + "  20: 03e00008  jr $ra\n"
  + "  24: 27bd0020  addiu $sp,$sp,32\n";
const SYMBOLIZED = STRIPPED.replace("<.text>", "<demo>").replace("jal 0x0", "jal 0 <demo>").replace("b 0x1c", "b 1c <demo+0x1c>");
const rawView = (t, c) => buildView(parseDisassembly(t), parseDisassembly(c), { target_name: "target.o", candidate_name: "candidate.o" });

test("the same word rendered two ways is a match; a real relocation difference is still reported", () => {
  const same = rawView(STRIPPED, SYMBOLIZED);
  assert.equal(same.counts.relocation, 0);
  assert.equal(same.counts.structural, 0);
  assert.equal(same.counts.match, same.aligned_rows);
  assert.equal(same.verdict, "exact");
  const other = rawView(STRIPPED, SYMBOLIZED.replace("R_MIPS_26 helper", "R_MIPS_26 other_helper"));
  assert.equal(other.counts.match, other.aligned_rows - 1);
  assert.notEqual(other.rows.find((r) => (r.target || "").startsWith("jal")).classification, "match");
});

test("a moved instruction is schedule, a real insertion is still structure", () => {
  const moved = viewOf(body("lw s1,0(s0)", "addu s1,s1,s1", "sw ra,20(sp)", "sw s1,4(s0)", "lw s2,8(s0)"),
    body("sw ra,20(sp)", "lw s1,0(s0)", "addu s1,s1,s1", "sw s1,4(s0)", "lw s3,8(s0)"));
  assert.equal(moved.counts.structural, 0);
  assert.equal(moved.counts.schedule, 2);
  assert.equal(moved.playbook, "g0-schedule-probe");
  const inserted = viewOf(body("lw s1,0(s0)", "sw s1,4(s0)"), body("lw s1,0(s0)", "addu s1,s1,s1", "sw s1,4(s0)"));
  assert.equal(inserted.counts.schedule, 0);
  assert.ok(inserted.counts.structural);
  assert.equal(inserted.playbook, "structure-buckets");
});

// ---------------------------------------------------------------- colorability

test("the colorable set excludes the ugen ring", () => {
  const colorable = colorableRegisters("ido53");
  for (const r of ["v0", "a0", "s0", "s8", "f0", "f12", "f18", "t0", "t5"]) assert.ok(colorable.has(r), r);
  for (const r of ["t6", "t9", "f4", "f6", "f8", "f10"]) assert.ok(!colorable.has(r), r);
});

test("a ring-only residual is not routed to a color playbook and says why", () => {
  const view = viewOf(body("lw t6,0(s0)"), body("lw t7,0(s0)"));
  assert.equal(view.verdict, "register-ring-only");
  assert.equal(view.playbook, "register-role-audit");
  const g = joined(view);
  assert.ok(g.includes("reservations"));
  assert.ok(g.includes("does not establish a changed demand"));
  assert.ok(!g.includes("dead families"));
  assert.deepEqual(view.asDict().ring_only_targets, ["t6"]);
});

test("a colorable target keeps the permutation verdict; a mixed residual names the ring-only sites", () => {
  const view = viewOf(body("lw s1,0(s0)"), body("lw s2,0(s0)"));
  assert.equal(view.verdict, "register-permutation");
  assert.deepEqual(view.asDict().ring_only_targets, []);
  const mixed = viewOf(body("lw s1,0(s0)", "sw t6,4(s0)"), body("lw s2,0(s0)", "sw t7,4(s0)"));
  assert.deepEqual(mixed.asDict().ring_only_targets, ["t6"]);
  assert.ok(joined(mixed).includes("per-procedure reservations"));
});

test("an unmeasured register is not called unreachable", () => {
  const webs = [new Web({ web: "w1", target: "k0", candidate: "k1", count: 1, rows: [0] })];
  assert.deepEqual(uncolorableTargets(webs, "ido53"), []);
});

// ---------------------------------------------------------------- classification

test("commutative swap is not allocation; a non-commutative swap keeps the register class", () => {
  const view = viewOf(body("lw t6,0(s0)", "lw t7,4(s0)", "or t8,t6,t7", "sw t8,8(s0)"), body("lw t6,0(s0)", "lw t7,4(s0)", "or t8,t7,t6", "sw t8,8(s0)"));
  assert.equal(view.verdict, "commutative-order");
  assert.equal(view.counts.commutative, 1);
  assert.equal(view.counts.register, 0);
  assert.equal(view.playbook, "ast-shape");
  assert.ok(joined(view).includes("`x |= y`"));
  const sub = viewOf(body("subu t8,t6,t7", "sw t8,8(s0)"), body("subu t8,t7,t6", "sw t8,8(s0)"));
  assert.equal(sub.counts.commutative, 0);
  assert.equal(sub.counts.register, 1);
});

test("a register cascade reports one bijection", () => {
  const view = viewOf(body("lw s3,0(s0)", "addu s3,s3,s3", "sw s3,4(s0)", "lw s4,8(s0)"), body("lw s1,0(s0)", "addu s1,s1,s1", "sw s1,4(s0)", "lw s4,8(s0)"));
  assert.equal(view.verdict, "register-permutation");
  assert.deepEqual(view.webs.map((w) => w.target), ["s3"]);
  assert.equal(view.webs[0].count, 3);
  assert.equal(view.webs[0].web, "w1");
});

test("inconsistent substitutions are allocation with pool-position guidance", () => {
  const view = viewOf(body("lw s3,0(s0)", "sw s3,4(s0)", "lw s3,8(s0)", "sw s3,12(s0)"), body("lw s1,0(s0)", "sw s1,4(s0)", "lw s2,8(s0)", "sw s2,12(s0)"));
  assert.equal(view.verdict, "allocation");
  assert.equal(view.playbook, "pool-position");
  assert.ok(joined(view).includes("NEXT FREE slot"));
  assert.ok(joined(view).includes("only if an instrumented"));
});

test("a temp rotation under ido53 is a register-role audit with a measured lane", () => {
  const view = viewOf(
    body("lw t6,0(s0)", "lw t7,4(s0)", "addu t8,t6,t7", "lw t9,8(s0)", "addu t6,t8,t9", "andi t7,t6,0xff", "sll t8,t7,2", "sw t8,12(s0)"),
    body("lw t6,0(s0)", "lw t7,4(s0)", "addu t8,t6,t7", "lw t9,8(s0)", "addu t7,t8,t9", "andi t8,t7,0xff", "sll t9,t8,2", "sw t9,12(s0)"));
  assert.equal(view.verdict, "register-permutation");
  assert.equal(view.playbook, "register-role-audit");
  assert.equal(lane(view, "temp").divergence, 4);
  assert.equal(lane(view, "temp").rotation, 1);
  assert.ok(joined(view).includes("reservations"));
});

test("constants, stack offsets and reorderings classify by their cheapest explanation", () => {
  const constant = viewOf(body("li v0,33", "sw v0,0(s0)"), body("li v0,49", "sw v0,0(s0)"));
  assert.equal(constant.verdict, "constant");
  assert.equal(constant.counts.constant, 1);
  assert.ok(joined(constant).includes("assembly encodes the truth"));
  assert.equal(viewOf(body("lw t6,16(sp)"), body("lw t6,20(sp)")).counts.constant, 1);
  const reorder = viewOf(body("addu t6,a0,a1", "lw t7,0(s0)", "sw t7,4(s0)"), body("lw t7,0(s0)", "addu t6,a0,a1", "sw t7,4(s0)"));
  assert.equal(reorder.verdict, "schedule");
  assert.equal(reorder.counts.structural, 0);
  assert.ok(reorder.counts.schedule > 0);
  assert.ok(joined(reorder).includes("-g0"));
  const same = viewOf(body("lw t6,0(s0)", "lw t7,4(s0)", "sw t6,8(s0)", "sw t7,12(s0)"), body("lw t7,4(s0)", "lw t6,0(s0)", "sw t6,8(s0)", "sw t7,12(s0)"));
  assert.equal(same.verdict, "schedule");
  assert.equal(same.counts.register, 0);
  assert.equal(same.counts.schedule, 2);
});

test("relocation addends elsewhere do not hide a reorder", () => {
  const target = parseDisassembly("00000000 <demo>:\n   0: 8c380000  lw $t8,0($at)\n                        0: R_MIPS_LO16 jump_table\n   4: 2401000a  li $at,10\n   8: 240e002d  li $t6,45\n", { symbol: "demo" });
  const candidate = parseDisassembly("00000000 <demo>:\n   0: 8c380014  lw $t8,20($at)\n                        0: R_MIPS_LO16 jump_table\n   4: 240e002d  li $t6,45\n   8: 2401000a  li $at,10\n", { symbol: "demo" });
  const view = buildView(target, candidate, { target_name: "target.o", candidate_name: "candidate.o", symbol: "demo" });
  assert.equal(view.verdict, "schedule");
  assert.equal(view.counts.schedule, 2);
  assert.equal(view.counts.structural, 0);
  assert.equal(view.counts.relocation, 0);
  assert.equal(view.counts.pool_layout, 1);
  assert.ok(joined(view).includes("does not prove source correctness"));
});

test("a relocation-only difference is linker controlled", () => {
  const t = parseDisassembly("00000000 <demo>:\n   0: 3c010123  lui $at,0x123\n                        0: R_MIPS_HI16 global\n   4: 03e00008  jr $ra\n   8: 00000000  nop\n", { symbol: "demo" });
  const c = parseDisassembly("00000000 <demo>:\n   0: 3c010000  lui $at,0x0\n                        0: R_MIPS_HI16 global\n   4: 03e00008  jr $ra\n   8: 00000000  nop\n", { symbol: "demo" });
  const view = buildView(t, c, { target_name: "t", candidate_name: "c", symbol: "demo" });
  assert.equal(view.verdict, "words-identical");
  assert.equal(view.counts.relocation, 1);
  assert.equal(view.counts.constant, 0);
  assert.equal(view.playbook, "relocation-only");
});

test("jump-table section addends are pool rows, not source residuals", () => {
  const view = viewOf(body("lui at,0", "addu at,at,t8", "lw t8,0(at)"), body("lui at,0", "addu at,at,t8", "lw t8,172(at)"), {
    relocations: { 4: "R_MIPS_HI16 jtbl_8009AE9C", 6: "R_MIPS_LO16 jtbl_8009AE9C" },
    candidate_relocations: { 4: "R_MIPS_HI16 .rodata", 6: "R_MIPS_LO16 .rodata" },
  });
  assert.equal(view.verdict, "words-identical");
  assert.equal(view.counts.pool, 2);
  assert.equal(view.counts.pool_layout, 0);
  assert.equal(view.counts.relocation, 0);
  assert.equal(view.counts.schedule, 0);
  assert.equal(view.counts.constant, 0);
});

test("unknown relocations are announced, identical input is exact, mixed residuals name every class", () => {
  assert.ok(viewOf(body("jal helper", "nop"), body("jal helper", "nop"), { relocations: { 4: "R_MIPS_INVENTED helper" } }).signature.includes("unknown-relocation:R_MIPS_INVENTED"));
  const lines = body("lw t6,0(s0)", "addu t7,t6,t6");
  const exact = viewOf(lines, lines);
  assert.equal(exact.verdict, "exact");
  assert.equal(exact.prefix_exact, null);
  assert.ok(exact.signature.includes("prefix-exact@all"));
  assert.deepEqual(exact.hunks, []);
  const mixed = viewOf(body("li v0,33", "lw t8,0(s0)", "sw t8,4(s0)"), body("li v0,49", "lw t6,0(s0)", "sw t6,4(s0)"));
  assert.ok(mixed.verdict.startsWith("mixed("));
  assert.ok(mixed.verdict.includes("constant:1"));
  assert.ok(mixed.verdict.includes("register:2"));
  assert.ok(mixed.guidance[0].includes("fix constants first"));
});

// ---------------------------------------------------------------- signature and lanes

test("prefix-exact and register-first divergence signatures", () => {
  const view = viewOf(body("lw t6,0(s0)", "lw t7,4(s0)", "addu t8,t6,t7"), body("lw t6,0(s0)", "lw t7,4(s0)", "subu t8,t6,t7"));
  assert.equal(view.prefix_exact, 6);
  assert.ok(view.signature.includes("prefix-exact@6"));
  assert.equal(view.register_first_divergence, false);
  const reg = viewOf(body("lw t6,0(s0)", "lw t7,4(s0)", "addu t8,t6,t7", "lw t9,8(s0)", "addu t6,t8,t9", "sw t6,12(s0)"),
    body("lw t6,0(s0)", "lw t7,4(s0)", "addu t8,t6,t7", "lw t9,8(s0)", "addu t7,t8,t9", "sw t7,12(s0)"));
  assert.ok(reg.signature.includes("state-divergence@temp:4"));
  assert.equal(reg.register_first_divergence, true);
});

test("lanes include matching instructions and come from the profile table", () => {
  const view = viewOf(body("lw t6,0(s0)", "lw t7,4(s0)", "addu t8,t6,t7"), body("lw t6,0(s0)", "lw t7,4(s0)", "addu t8,t6,t7"));
  assert.deepEqual(lane(view, "temp").target, ["t6", "t7", "t8"]);
  assert.deepEqual(lane(view, "temp").candidate, ["t6", "t7", "t8"]);
  assert.equal(lane(view, "temp").divergence, null);
  const lines = body("lw s1,0(s0)", "lw t6,4(s0)");
  const classes = Object.fromEntries(viewOf(lines, lines).lanes.map((l) => [l.classification, l.target]));
  assert.deepEqual(classes.pool, ["s0", "s1", "s0"]);
  assert.deepEqual(classes.temp, ["t6"]);
});

test("unknown profiles and empty input are refused", () => {
  const instructions = parseDisassembly(assemble(body("nop"), { symbol: SYMBOL }), { symbol: SYMBOL });
  assert.throws(() => buildView(instructions, instructions, { target_name: "t", candidate_name: "c", register_profile: "nope" }), /ido53/);
  for (const [t, c] of [[[], instructions], [instructions, []], [[], []]]) {
    assert.throws(() => buildView(t, c, { target_name: "t", candidate_name: "c" }), /no instructions/);
  }
});

test("stores and branches do not add lane slots", () => {
  for (const a of ["sw $t6,4($s0)", "bne $a0,$zero,10 <demo+0x10>", "jal 0 <helper>", "nop", "mult $t6,$t7"]) assert.equal(destinationRegister(a), null, a);
  assert.equal(destinationRegister("lw $t6,4($s0)"), "t6");
  assert.equal(destinationRegister("addu $t8,$t6,$t7"), "t8");
});

test("classify_pair rules", () => {
  const pair = (t, c) => classifyPair(new Instruction({ address: 0, word: "00000000", assembly: t }), new Instruction({ address: 0, word: "00000001", assembly: c }),
    { target_text: t.replaceAll("$", ""), candidate_text: c.replaceAll("$", "") });
  assert.equal(pair("addu $t6,$t0,$t1", "addu $t7,$t0,$t1"), "register");
  assert.equal(pair("or $t6,$t0,$t1", "or $t6,$t1,$t0"), "commutative");
  assert.equal(pair("li $v0,33", "li $v0,49"), "constant");
  assert.equal(pair("jal 0 <a>", "jal 0 <b>"), "structural");
  assert.equal(pair("nop", "nop"), "structural");
});

// ---------------------------------------------------------------- payload keys

test("json keys are schema keys, and report_regs covers matching rows", () => {
  const view = viewOf(body("li v0,33", "lw t8,0(s0)", "sw t8,4(s0)"), body("li v0,49", "lw t6,0(s0)", "sw t6,4(s0)"));
  const payload = view.asDict({ report_regs: true });
  const allowed = schemaKeys();
  for (const k of Object.keys(payload)) assert.ok(allowed.has(k), k);
  for (const section of ["hunks", "lanes", "webs", "register_report"]) for (const e of payload[section]) for (const k of Object.keys(e)) assert.ok(allowed.has(k), `${section}.${k}`);
  const regs = viewOf(body("lw t8,0(s0)", "sw t8,4(s0)"), body("lw t6,0(s0)", "sw t6,4(s0)"));
  const report = regs.registerReport();
  assert.equal(report.length, regs.aligned_rows);
  const matched = report.filter((r) => r.class === "match");
  assert.ok(matched.length);
  assert.deepEqual(matched[0].target, matched[0].candidate);
  // A reservation-bearing view still renders through the report serializer.
  const withState = replace(view, { target_reservations: new RegisterReservations({ reserved: ["t0"], evidence: "synthetic" }) });
  assert.ok(dumps(withState.asDict()).includes("supplied-reservations"));
});

// ---------------------------------------------------------------- performance

const OPCODE_CYCLE = ["lw t{a},0(s0)", "addu t{a},t{a},t{b}", "sw t{a},4(s0)", "andi t{b},t{a},0xff", "sll t{b},t{b},2", "lbu t{a},8(s0)", "or t{b},t{a},t{b}", "subu t{a},t{b},t{a}"];
function longFunction(count, swapAt = -1) {
  const lines = [...PROLOGUE];
  for (let i = 0; i < count; i++) {
    const r = i !== swapAt ? { a: 6, b: 7 } : { a: 8, b: 9 };
    lines.push(OPCODE_CYCLE[i % OPCODE_CYCLE.length].replaceAll("{a}", r.a).replaceAll("{b}", r.b));
  }
  return [...lines, ...EPILOGUE];
}

test("a large function aligns quickly", () => {
  const t = assemble(longFunction(1500), { symbol: "big" }), c = assemble(longFunction(1500, 700), { symbol: "big" });
  const start = performance.now();
  const view = buildView(parseDisassembly(t, { symbol: "big" }), parseDisassembly(c, { symbol: "big" }), { target_name: "t", candidate_name: "c", symbol: "big" });
  const elapsed = performance.now() - start;
  assert.equal(view.counts.register, 1);
  assert.equal(view.counts.structural, 0);
  assert.ok(elapsed < 2000, `view took ${elapsed}ms`);
});

test("repeating text does not derail the alignment", () => {
  const target = longFunction(400);
  const view = viewOf(target, longFunction(400, 100), { symbol: "big" });
  assert.equal(view.counts.register, 1);
  assert.equal(view.counts.structural, 0);
  assert.equal(view.counts.match, target.length - 1);
});

test("register profiles are data and disjoint", () => {
  for (const [name, profile] of Object.entries(REGISTER_CLASS_PROFILES)) {
    const seen = new Set();
    for (const members of Object.values(profile)) { for (const m of members) { assert.ok(!seen.has(m), name); seen.add(m); } }
  }
});

// ---------------------------------------------------------------- register reservations

function makeView(target, candidate, targetState = null, candidateState = null, evidence = null) {
  return buildView(parseDisassembly(assemble(target, { symbol: "demo" }), { symbol: "demo" }),
    parseDisassembly(assemble(candidate, { symbol: "demo" }), { symbol: "demo" }),
    { target_name: "target", candidate_name: "candidate", symbol: "demo", target_reservations: targetState, candidate_reservations: candidateState, evidence });
}

test("decoded colors are possible, not automatically actual", () => {
  for (let color = 7; color < 13; color++) {
    const register = registerForColor(color);
    assert.ok(colorableRegisters().has(register));
    const view = makeView([`lw ${register},0(s0)`], ["lw s1,0(s0)"]);
    assert.deepEqual(view.asDict().ring_only_targets, []);
    assert.equal(view.owning_pass, "unknown");
    assert.equal(view.routing, "evidence-first");
    assert.equal(view.lanes[1].classification, "shared");
  }
});

test("cyclic shared roles do not prove a fifo", () => {
  const view = makeView(["lw t0,0(s0)", "lw t1,4(s0)", "lw t2,8(s0)"], ["lw t1,0(s0)", "lw t2,4(s0)", "lw t0,8(s0)"]);
  assert.notEqual(view.verdict, "phase-shift");
  assert.equal(view.playbook, "register-role-audit");
});

test("decisive evidence keeps dispatch consistent", () => {
  for (const [evidence, owner, playbook] of [
    [new PassEvidence({ contested_allocation: true }), "uopt-globalcolor", "forced-color-oracle"],
    [new PassEvidence({ force_declined: true }), "uopt-globalcolor", "forced-color-oracle"],
    [new PassEvidence({ ring_pop_divergence: true }), "ugen-temp-ring", "temp-fifo-phase"],
    [new PassEvidence({ schedule_slot_divergence: true }), "g0-scheduler", "g0-schedule-probe"],
  ]) {
    const view = makeView(["lw t0,0(a0)"], ["lw t2,0(a0)"], null, null, evidence);
    assert.equal(view.owning_pass, owner);
    assert.equal(view.ownership.basis, "trace");
    assert.equal(view.playbook, playbook);
    assert.notEqual(view.routing, "evidence-first");
    assert.ok(!joined(view).includes("ownership: unknown"));
  }
});

test("supplied reservation sides do not leak and remain conditional", () => {
  const five = new RegisterReservations({ reserved: ["t0", "t1", "t2", "t3", "t4"], evidence: "synthetic assumption" });
  const six = new RegisterReservations({ reserved: [...five.reserved, "t5"], evidence: "synthetic assumption" });
  const left = ["lw t5,0(s0)"], right = ["lw t6,0(s0)"];
  for (const [t, c, ts, cs] of [[left, right, five, six], [right, left, six, five]]) {
    const view = makeView(t, c, ts, cs);
    assert.equal(view.owning_pass, "unknown");
    const state = view.asDict().register_reservations;
    assert.deepEqual(state.target.reserved, [...ts.reserved]);
    assert.deepEqual(state.candidate.reserved, [...cs.reserved]);
    assert.ok(!view.lanes.some((l) => l.rotation));
    assert.equal(state.candidate.basis, "supplied-reservations");
  }
  const unknown = makeView(left, right, null, six);
  assert.equal(unknown.asDict().register_reservations.target, null);
  assert.ok(lane(unknown, "shared").target.includes("t5"));
});

test("reserved without emission is not an invented use; projection does not change metrics", () => {
  const state = new RegisterReservations({ reserved: ["t5"], evidence: "synthetic assumption" });
  const view = makeView(["lw t6,0(s0)"], ["lw t7,0(s0)"], state, state);
  assert.ok(view.lanes.every((l) => ![...l.target, ...l.candidate].includes("t5")));
  assert.deepEqual(view.asDict().register_reservations.target.reserved, ["t5"]);
  const lines = ["lw t5,0(s0)", "sw t5,4(s0)"];
  const plain = makeView(lines, lines), supplied = makeView(lines, lines, state, state);
  assert.deepEqual(plain.counts, supplied.counts);
  assert.equal(supplied.verdict, "exact");
});

test("invalid reservations refuse; sidecars bind input and symbol", () => {
  for (const regs of [["t0", "t0"], ["t6"], ["unknown"]]) assert.throws(() => new RegisterReservations({ reserved: regs, evidence: "synthetic" }));
  assert.throws(() => new RegisterReservations({ reserved: [], evidence: "" }));
  const dir = mkdtempSync(path.join(os.tmpdir(), "romdev-wb-reserve-"));
  try {
    const source = path.join(dir, "input.o"), sidecar = path.join(dir, "state.json");
    writeFileSync(source, "synthetic object identity");
    const value = { schema: REGISTER_STATE_SCHEMA, symbol: "demo", input_sha256: createHash("sha256").update(readFileSync(source)).digest("hex"), reserved: ["t0"], evidence: "explicit synthetic assumption" };
    writeFileSync(sidecar, JSON.stringify(value));
    assert.deepEqual(loadReservations(sidecar, source, "demo").reserved, ["t0"]);
    for (const bad of [[], { ...value, symbol: "other" }, { ...value, input_sha256: "0".repeat(64) }, { ...value, reserved: "t0" }, { ...value, reserved: [8] }]) {
      writeFileSync(sidecar, JSON.stringify(bad));
      assert.throws(() => loadReservations(sidecar, source, "demo"));
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- ownership

test("every ownership answer is one of the declared values; exact owns nothing", () => {
  for (const [t, c] of [[["li v0,33"], ["li v0,33"]], [["li v0,33"], ["li v0,49"]], [["lw t8,0(s0)", "sw t8,4(s0)"], ["lw t6,0(s0)", "sw t6,4(s0)"]],
    [["sw v0,24(sp)"], ["sw v0,28(sp)"]], [["addu v0,a0,a1", "lw a2,0(s0)"], ["lw a2,0(s0)", "addu v0,a0,a1"]]]) {
    const o = wrapped(t, c).ownership;
    assert.ok(OWNING_PASS_VALUES.includes(o.owning_pass));
    assert.ok(REACHABILITY_VALUES.includes(o.reachability));
    assert.ok(BASIS_VALUES.includes(o.basis));
    assert.ok(o.reason);
  }
  const exact = wrapped(["li v0,33"], ["li v0,33"]).ownership;
  assert.equal(exact.owning_pass, OWNING_PASS_NONE);
  assert.equal(exact.basis, BASIS_NONE);
  assert.deepEqual(exact.steps, []);
  const incomparable = ownershipFor("register-permutation", [], [], [], "ido53", ["selected a different symbol"]);
  assert.equal(incomparable.owning_pass, OWNING_PASS_UNKNOWN);
  assert.equal(incomparable.reachability, REACHABILITY_UNKNOWN);
  assert.equal(incomparable.basis, BASIS_NONE);
});

test("heuristic ownership per residual shape", () => {
  const home = wrapped(["sw v0,24(sp)"], ["sw v0,28(sp)"]);
  assert.equal(home.owning_pass, OWNING_PASS_STACK_HOME);
  assert.equal(home.reachability, REACHABILITY_SOURCE);
  assert.ok(home.ownership.reason.includes("N(sp)"));
  const frame = ["sw ra,36(sp)", "lw ra,36(sp)"];
  const fl = buildView(parseDisassembly(assemble(["addiu sp,sp,-40", ...frame, "addiu sp,sp,40", "jr ra", "nop"], { symbol: SYMBOL }), { symbol: SYMBOL }),
    parseDisassembly(assemble(["addiu sp,sp,-56", ...frame, "addiu sp,sp,56", "jr ra", "nop"], { symbol: SYMBOL }), { symbol: SYMBOL }),
    { target_name: "target", candidate_name: "candidate", symbol: SYMBOL });
  assert.equal(fl.verdict, "frame-layout");
  assert.equal(fl.owning_pass, OWNING_PASS_STACK_HOME);
  assert.equal(fl.reachability, REACHABILITY_SOURCE);
  const load = wrapped(["lwc1 f4,0(s0)"], ["lui a0,0x3f00"]);
  assert.equal(load.owning_pass, OWNING_PASS_LOAD_FORM);
  assert.equal(load.reachability, REACHABILITY_SOURCE);
  assert.notEqual(wrapped(["lwc1 f4,0(s0)", "addiu t0,t1,8"], ["lwc1 f6,0(s0)", "lw t2,0(sp)"]).owning_pass, OWNING_PASS_LOAD_FORM);
  const cfe = wrapped(["li v0,33"], ["li v0,49"]);
  assert.equal(cfe.owning_pass, OWNING_PASS_CFE);
  assert.equal(cfe.reachability, REACHABILITY_SOURCE);
  const sched = wrapped(["addu v0,a0,a1", "lw a2,0(s0)"], ["lw a2,0(s0)", "addu v0,a0,a1"]);
  assert.equal(sched.verdict, "schedule");
  assert.equal(sched.owning_pass, OWNING_PASS_G0_SCHEDULER);
  assert.equal(sched.reachability, REACHABILITY_PERMUTER);
  const color = wrapped(["move s0,s1"], ["move s0,s2"]);
  assert.equal(color.owning_pass, OWNING_PASS_UOPT_COLOR);
  assert.equal(color.reachability, REACHABILITY_PERMUTER);
  const ring = wrapped(["lw t8,0(s0)", "sw t8,4(s0)"], ["lw t6,0(s0)", "sw t6,4(s0)"]);
  assert.equal(ring.owning_pass, OWNING_PASS_UNKNOWN);
  assert.equal(ring.reachability, REACHABILITY_UNKNOWN);
  for (const [t, c] of [[["li v0,33"], ["li v0,49"]], [["sw v0,24(sp)"], ["sw v0,28(sp)"]], [["move s0,s1"], ["move s0,s2"]]]) {
    assert.equal(wrapped(t, c).ownership.basis, BASIS_HEURISTIC);
  }
});

test("trace evidence turns ownership into a measurement", () => {
  const declined = wrapped(["move s0,s1"], ["move s0,s2"], { evidence: new PassEvidence({ force_declined: true }) });
  assert.equal(declined.ownership.basis, BASIS_TRACE);
  assert.equal(declined.owning_pass, OWNING_PASS_UOPT_COLOR);
  assert.equal(declined.reachability, REACHABILITY_PASS_OWNED);
  assert.ok(declined.ownership.reason.includes("taken, not underpriced"));
  assert.ok(wrapped(["move s0,s1"], ["move s0,s2"], { evidence: new PassEvidence({ contested_allocation: true }) }).ownership.reason.includes("regsleft=0"));
  const pop = wrapped(["lw t8,0(s0)", "sw t8,4(s0)"], ["lw t6,0(s0)", "sw t6,4(s0)"], { evidence: new PassEvidence({ ring_pop_divergence: true }) });
  assert.equal(pop.owning_pass, OWNING_PASS_UGEN_RING);
  assert.equal(pop.reachability, REACHABILITY_SOURCE);
  assert.equal(pop.ownership.basis, BASIS_TRACE);
  const nothing = wrapped(["li v0,33"], ["li v0,49"], { evidence: new PassEvidence() });
  assert.equal(nothing.ownership.basis, BASIS_HEURISTIC);
  assert.equal(nothing.owning_pass, OWNING_PASS_CFE);
  const trace = parseGlobalcolorTrace("[CDX] force_declined phase=p1 site=color proc=1 web=7 color=12\n");
  const evidence = passEvidence(trace, { proc: 1, web: 7 });
  assert.equal(evidence.force_declined, true);
  assert.equal(evidence.decisive, true);
  assert.equal(passEvidence(trace, { proc: 2 }).decisive, false);
});

test("footer names the pass before the levers and points at its law; payload matches", () => {
  const view = wrapped(["sw v0,24(sp)"], ["sw v0,28(sp)"]);
  const g = view.guidance;
  const owning = g.findIndex((l) => l.startsWith("owning "));
  const levers = g.findIndex((l) => l.startsWith("field guide levers"));
  assert.ok(owning >= 0 && levers >= 0 && owning < levers);
  assert.ok(g[owning + 1].startsWith("reachability: "));
  assert.ok(joined(view).includes("law L63:"));
  assert.ok(joined(view).includes("decomp-workbench guide laws ido53 L63"));
  const payload = view.asDict();
  assert.equal(payload.owning_pass, view.owning_pass);
  assert.equal(payload.reachability, view.reachability);
  assert.equal(payload.ownership_basis, view.ownership.basis);
  for (const key of ["owning_pass", "reachability", "ownership_basis"]) assert.ok(key in VIEW_METRICS_BY_KEY);
});

// ---------------------------------------------------------------- routing

test("routing vocabulary", () => {
  for (const v of ["allocation", "phase-shift", "register-permutation", "register-ring-only", "schedule"]) assert.equal(routingFor(v, {}), ROUTING_PERMUTER_FIRST, v);
  for (const v of ["constant", "structure", "pool-layout", "frame-layout"]) assert.equal(routingFor(v, {}), ROUTING_STRUCTURAL, v);
  assert.equal(routingFor("mixed(register:6, schedule:2)", { register: 6, schedule: 2 }), ROUTING_PERMUTER_FIRST);
  assert.equal(routingFor("mixed(constant:3, register:1)", { constant: 3, register: 1 }), ROUTING_STRUCTURAL);
  assert.equal(routingFor("register-permutation", {}, ["selected a different symbol"]), ROUTING_IMPORT_FIX);
  assert.equal(routingFor("exact", {}), ROUTING_NONE);
  assert.equal(routingFor("words-identical", {}), ROUTING_NONE);
  for (const v of ["exact", "allocation", "constant", "mixed(register:2)", "something-nobody-has-written-yet"]) assert.ok(ROUTING_VALUES.includes(routingFor(v, { register: 2 })));
  assert.equal(routingFor("constant", { constant: 3 }, [], REACHABILITY_PASS_OWNED), ROUTING_PERMUTER_FIRST);
  assert.equal(routingFor("constant", { constant: 1 }, ["selected a different symbol"], REACHABILITY_PASS_OWNED), ROUTING_IMPORT_FIX);
  assert.ok(PERMUTER_ROUTING_SENTENCE.includes("HAND"));
  assert.ok(PERMUTER_ROUTING_SENTENCE.includes("permuter target"));
  assert.ok(PERMUTER_ROUTING_SENTENCE.includes("before concluding a wall"));
});

test("routed guidance: evidence first for GP roles, constants to source, exact nowhere", () => {
  const gp = wrapped(["lw t8,0(s0)", "sw t8,4(s0)"], ["lw t6,0(s0)", "sw t6,4(s0)"]);
  assert.equal(gp.reachability, REACHABILITY_UNKNOWN);
  assert.equal(gp.routing, "evidence-first");
  assert.ok(!gp.guidance.includes(PERMUTER_ROUTING_SENTENCE));
  assert.ok(joined(gp).includes("reservation"));
  assert.ok(!joined(gp).includes("permute-doctor"));
  assert.equal(gp.asDict().routing, gp.routing);
  const constant = wrapped(["li v0,33"], ["li v0,49"]);
  assert.equal(constant.reachability, REACHABILITY_SOURCE);
  assert.equal(constant.routing, ROUTING_STRUCTURAL);
  assert.ok(!constant.guidance.includes(PERMUTER_ROUTING_SENTENCE));
  const exact = wrapped(["li v0,33"], ["li v0,33"]);
  assert.equal(exact.routing, ROUTING_NONE);
  assert.ok(!exact.guidance.includes(PERMUTER_ROUTING_SENTENCE));
});
