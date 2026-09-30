// Ported from the workbench's `next` tests: blockers outrank the steps they
// distort, every step is a runnable command with real paths, and the plan
// ends at the field guide.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assemble } from "./fixtures/workbench/mips-asm.js";
import { parseDisassembly } from "../src/decomp/workbench/objdump.js";
import { compareInstructions } from "../src/decomp/workbench/compare.js";
import { RANK_ATTRIBUTION, RANK_BLOCKER, RANK_REFERENCE, planNextSteps, renderPlan } from "../src/decomp/workbench/whats-next.js";
import { runCli } from "./fixtures/workbench/cli-run.js";

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "workbench");
const PT = path.join(FIX, "phase-shift-target.objdump.txt"), PC = path.join(FIX, "phase-shift-candidate.objdump.txt");
const SYMBOL = "demo";
const body = (...i) => ["addiu sp,sp,-32", "sw ra,28(sp)", ...i, "lw ra,28(sp)", "jr ra", "addiu sp,sp,32"];
const cmp = (t, c) => compareInstructions(parseDisassembly(assemble(t, { symbol: SYMBOL }), { symbol: SYMBOL }), parseDisassembly(assemble(c, { symbol: SYMBOL }), { symbol: SYMBOL }),
  { target_name: "target.o", candidate_name: "candidate.o", symbol: SYMBOL });
const planOf = (t, c, extra = {}) => planNextSteps(cmp(t, c), { target: "target.o", candidate: "candidate.o", ...extra });
const GROWN = [body("addu v0,a0,a1"), body("addu v0,a0,a1", "addu v1,a0,a2")];
const ALLOC = [body("addu v0,a0,a1"), body("addu t0,a0,a1")];

test("an instruction-count difference ranks first as a blocker and routes to align", () => {
  const plan = planOf(...GROWN);
  assert.equal(plan.steps[0].rank, RANK_BLOCKER); assert.ok(plan.steps[0].why.includes("instruction(s)"));
  assert.ok(plan.blocked.length); assert.ok(plan.blocked.join(" ").includes("not measurable"));
  assert.ok(plan.steps[0].command.includes("align target.o candidate.o")); assert.ok(plan.steps[0].why.includes("how many instructions away"));
  const ranks = plan.steps.map((s) => s.rank);
  assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b));
});

test("a run of float register rows routes to the ring phase", () => {
  const t = body(...Array.from({ length: 8 }, (_, i) => `lwc1 f${4 + 2 * (i % 4)},${i * 4}(sp)`));
  const c = body(...Array.from({ length: 8 }, (_, i) => `lwc1 f${8 - 2 * (i % 4) + 2},${i * 4}(sp)`));
  assert.ok(planOf(t, c).steps.some((s) => s.command.includes("phase target.o candidate.o")));
});

test("without a blocker the family step leads; the plan ends at the field guide", () => {
  const plan = planOf(...ALLOC);
  assert.notEqual(plan.steps[0].rank, RANK_BLOCKER); assert.deepEqual(plan.blocked, []);
  assert.equal(plan.steps.at(-1).rank, RANK_REFERENCE); assert.ok(plan.steps.at(-1).command.includes("decomp-workbench guide "));
});

test("every step is runnable with real paths and one sentence of why; argv needs no shell parsing", () => {
  for (const step of planOf(...ALLOC).steps) {
    assert.ok(step.command.startsWith("decomp-workbench ")); assert.ok(!step.command.includes("TARGET.o")); assert.ok(!step.command.includes("CANDIDATE.o"));
    assert.ok(step.why.trim());
    const p = step.asDict();
    assert.equal(p.command_argv[0], "decomp-workbench"); assert.deepEqual(p.command_argv.slice(1), [...step.argv]);
    assert.equal(p.safety, "read-only"); assert.ok(p.expected_signal);
  }
});

test("a source path is substituted into the region step; without one no placeholder appears", () => {
  const region = planOf(...ALLOC, { source: "work/champion.c" }).steps.filter((s) => s.rank === RANK_ATTRIBUTION);
  assert.equal(region.length, 1); assert.ok(region[0].command.includes("--by-region work/champion.c"));
  const plain = planOf(...ALLOC);
  assert.deepEqual(plain.steps.filter((s) => s.rank === RANK_ATTRIBUTION), []);
  assert.ok(!plain.steps.map((s) => s.command).join(" ").includes("SRC.c"));
});

test("an allocation residue routes to the force ceiling first; structural residues are not sent to the allocator", () => {
  const plan = planNextSteps(cmp(...ALLOC), { target: "target.o", candidate: "candidate.o", source: "work.c", trace: "allocator.log", proc: 7 });
  assert.equal(plan.verdict, "allocation-mismatch");
  const force = plan.steps.filter((s) => s.command.includes("oracle plan"));
  assert.equal(force.length, 1);
  assert.ok(force[0].why.includes("before spending builds on source variants")); assert.ok(force[0].why.includes("ceiling"));
  assert.ok(force[0].command.includes("allocator.log --proc 7"));
  const commands = plan.steps.map((s) => s.command);
  assert.ok(commands.indexOf(force[0].command) < commands.findIndex((c) => c.includes("--by-region")));
  assert.ok(!planOf(body("addu v0,a0,a1"), body("addu v0,a0,a1", "nop", "nop")).steps.map((s) => s.command).join(" ").includes("oracle plan"));
  const noTrace = planOf(...ALLOC).steps.map((s) => s.command).join(" ");
  assert.ok(!noTrace.includes("TRACE.log")); assert.ok(!noTrace.includes("--proc N"));
});

test("a match routes to the whole-object gate", () => {
  const rows = body("addu v0,a0,a1");
  const plan = planOf(rows, rows);
  assert.equal(plan.matched, true); assert.ok(plan.steps.map((s) => s.command).join(" ").includes("object-collateral"));
});

test("the default render is bounded and says so; a blocker is labelled", () => {
  const plan = planOf(...GROWN);
  const r = renderPlan(plan, { limit: 1 }).join("\n");
  assert.ok(r.includes("1.")); assert.ok(r.includes("pass --all"));
  assert.ok(renderPlan(plan).join("\n").includes("[blocker]"));
});

test("next-dumps prints a numbered plan; JSON carries the schema and the ranks", async () => {
  let [status, out] = await runCli(["next-dumps", PT, PC]);
  assert.equal(status, 0); assert.ok(out.startsWith("next: ")); assert.ok(out.includes("1.")); assert.ok(out.includes("why:"));
  [status, out] = await runCli(["next-dumps", PT, PC, "--json"]);
  const p = JSON.parse(out);
  assert.equal(status, 0); assert.equal(p.schema, "decomp-workbench-next-v1"); assert.ok(p.steps.length);
  for (const s of p.steps) for (const k of ["command", "command_argv", "why", "kind"]) assert.ok(k in s);
});

test("dump actions keep the input kind and the function selector, and execute", async () => {
  const [status, out, err] = await runCli(["next-dumps", PT, PC, "--function", "animStep", "--json"]);
  assert.deepEqual([status, err], [0, ""]);
  const p = JSON.parse(out);
  const inputs = p.steps.map((s) => s.command_argv).filter((a) => a.length > 1 && a[1].endsWith("-dumps"));
  assert.ok(inputs.length);
  for (const argv of inputs) { assert.ok(argv.includes("--function")); assert.ok(argv.includes("animStep")); }
  const commands = p.steps.map((s) => s.command).join(" ");
  assert.ok(!commands.includes("TRACE.log")); assert.ok(!commands.includes("SRC.c"));
  for (const step of p.steps) {
    const [s, , e] = await runCli(step.command_argv.slice(1));
    assert.equal(s, 0, `${step.action}: ${e}`);
  }
});

test("optional action inputs must exist; --proc requires --trace; a missing input is a clear error", async () => {
  for (const option of ["--src", "--symbol-map", "--trace"]) {
    const [status, , err] = await runCli(["next-dumps", PT, PC, option, "absent-input"]);
    assert.equal(status, 2); assert.ok(err.includes("file does not exist"), option);
  }
  let [status, , err] = await runCli(["next-dumps", PT, PC, "--proc", "7"]);
  assert.equal(status, 2); assert.ok(err.includes("--proc requires --trace"));
  [status, , err] = await runCli(["next", "absent-a.o", "absent-b.o"]);
  assert.equal(status, 2); assert.ok(err.startsWith("error: "));
});
