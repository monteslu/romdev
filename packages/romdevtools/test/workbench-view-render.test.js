// Ported from the workbench's view rendering and command tests: every
// difference is printed, human labels are the JSON keys, colour is opt-in,
// nothing is narrower than the truth, and the view / view-dumps commands
// (JSON, width, HTML, force handoff, refusals).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assemble } from "./fixtures/workbench/mips-asm.js";
import { parseDisassembly } from "../src/decomp/workbench/objdump.js";
import { buildView, schemaKeys, REGISTER_CLASS_PROFILES } from "../src/decomp/workbench/view.js";
import { RegisterReservations } from "../src/decomp/workbench/register-state.js";
import { forceSpecification } from "../src/decomp/workbench/force-spec.js";
import { Painter, renderView, resolveColor } from "../src/decomp/workbench/view-cli.js";
import { replace } from "../src/decomp/workbench/py.js";
import { runCli } from "./fixtures/workbench/cli-run.js";

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "workbench");
const PHASE_TARGET = path.join(FIX, "phase-shift-target.objdump.txt"), PHASE_CANDIDATE = path.join(FIX, "phase-shift-candidate.objdump.txt");
const SHIFT_TARGET = path.join(FIX, "shifted-insertion-target.objdump.txt"), SHIFT_CANDIDATE = path.join(FIX, "shifted-insertion-candidate.objdump.txt");
const SYMBOL = "demo";
const PROLOGUE = ["addiu sp,sp,-32", "sw ra,28(sp)", "sw s0,24(sp)", "move s0,a0"];
const EPILOGUE = ["lw ra,28(sp)", "lw s0,24(sp)", "jr ra", "addiu sp,sp,32"];
const body = (...l) => [...PROLOGUE, ...l, ...EPILOGUE];
const viewOf = (t, c) => buildView(parseDisassembly(assemble(t, { symbol: SYMBOL }), { symbol: SYMBOL }), parseDisassembly(assemble(c, { symbol: SYMBOL }), { symbol: SYMBOL }),
  { target_name: "target.objdump", candidate_name: "candidate.objdump", symbol: SYMBOL });
const TOKEN_RE = /\b([a-z_]+)=/g;
const tokens = (line) => [...line.matchAll(TOKEN_RE)].map((m) => m[1]);

function emittedKeys(view) {
  const keys = new Set();
  const walk = (n) => {
    if (n && typeof n === "object" && !Array.isArray(n)) {
      const entries = typeof n.entries === "function" && !(Object.getPrototypeOf(n) === Object.prototype) ? [...n.entries()] : Object.entries(n);
      for (const [k, v] of entries) { keys.add(String(k)); walk(v); }
    } else if (Array.isArray(n)) n.forEach(walk);
  };
  walk(JSON.parse(JSON.stringify(view.asDict({ report_regs: true }), (k, v) => (v && typeof v.entries === "function" && !Array.isArray(v) && Object.getPrototypeOf(v) !== Object.prototype ? Object.fromEntries(v.entries()) : v))));
  for (const line of renderView(view, { report_regs: true })) {
    if (line.startsWith("next: ") || line.startsWith("      ")) continue;
    for (const t of tokens(line)) keys.add(t);
  }
  return keys;
}

const RESIDUE = [body("li v0,33", "lw t8,0(s0)", "sw t8,4(s0)"), body("li v0,49", "lw t6,0(s0)", "sw t6,4(s0)")];

test("displacement is visible in the rendered screen", () => {
  const view = viewOf(body("bne a0,zero,@8", "nop", "nop", "nop"), body("bne a0,zero,@9", "nop", "nop", "nop", "nop"));
  assert.ok(renderView(view, { context: 6 }).join("\n").includes("displacement"));
});

test("a force spec refuses a residual no force can reach", () => {
  assert.throws(() => forceSpecification(viewOf(body("lw t6,0(s0)"), body("lw t7,0(s0)"))), (e) => e.message.includes("direct forced color") && e.message.includes("does not exclude upstream"));
});

test("every difference site is printed", () => {
  const screen = renderView(viewOf(...RESIDUE)).join("\n");
  for (const s of ["li $v0,33", "li $v0,49", "t8->t6 [w1]"]) assert.ok(screen.includes(s), s);
});

test("human labels and JSON keys are schema keys, and the registry and the output are one set", () => {
  const view = viewOf(...RESIDUE);
  const allowed = schemaKeys();
  for (const line of renderView(view, { report_regs: true })) {
    if (line.startsWith("next: ") || line.startsWith("      ")) continue;
    for (const t of tokens(line)) assert.ok(allowed.has(t), `${t} in ${line}`);
  }
  const payload = view.asDict({ report_regs: true });
  for (const k of Object.keys(payload)) assert.ok(allowed.has(k), k);
  for (const section of ["hunks", "lanes", "webs", "register_report"]) for (const e of payload[section]) for (const k of Object.keys(e)) assert.ok(allowed.has(k), `${section}.${k}`);
  const emitted = emittedKeys(view);
  for (const k of emittedKeys(replace(view, { target_reservations: new RegisterReservations({ reserved: ["t0"], evidence: "synthetic" }) }))) emitted.add(k);
  assert.deepEqual([...emitted].filter((k) => !allowed.has(k)), [], "printed but unregistered");
  assert.deepEqual([...allowed].filter((k) => !emitted.has(k)), [], "registered but never printed");
});

test("JSON counts agree with the printed header; report-regs covers matching rows", () => {
  const view = viewOf(...RESIDUE);
  const payload = view.asDict();
  const header = renderView(view)[1];
  for (const k of ["structural", "schedule", "register", "constant"]) assert.ok(header.includes(`${k}=${payload[k]}`), k);
  assert.ok(header.includes(`hunks=${payload.hunks.length}`));
  const v2 = viewOf(body("lw t8,0(s0)", "sw t8,4(s0)"), body("lw t6,0(s0)", "sw t6,4(s0)"));
  const report = v2.registerReport();
  assert.equal(report.length, v2.aligned_rows);
  const matched = report.filter((r) => r.class === "match");
  assert.ok(matched.length); assert.deepEqual(matched[0].target, matched[0].candidate);
});

test("the hunk limit is reported, not silently applied", () => {
  const target = body(...Array.from({ length: 6 }, (_, i) => `lw t8,${i * 4}(s0)`));
  const candidate = body(...Array.from({ length: 6 }, (_, i) => `lw t6,${i * 4}(s0)`));
  for (const i of [1, 3, 5]) candidate[PROLOGUE.length + i] = target[PROLOGUE.length + i];
  const screen = renderView(viewOf(target, candidate), { max_hunks: 1 }).join("\n");
  assert.ok(screen.includes("further hunk(s) not shown")); assert.ok(screen.includes("HUNK 1")); assert.ok(!screen.includes("HUNK 2"));
});

test("colour is opt-in, monochrome is complete, auto follows the stream and NO_COLOR, output is ASCII", () => {
  const view = viewOf(body("lw t8,0(s0)"), body("lw t6,0(s0)"));
  const mono = renderView(view, { painter: new Painter(false) }).join("\n");
  const colored = renderView(view, { painter: new Painter(true) }).join("\n");
  assert.ok(!mono.includes("\x1b[")); assert.ok(colored.includes("\x1b[")); assert.ok(mono.includes("[w1]"));
  assert.equal(resolveColor("never"), false); assert.equal(resolveColor("always"), true);
  assert.equal(resolveColor("auto", { env: {}, isatty: true }), true);
  assert.equal(resolveColor("auto", { env: {}, isatty: false }), false);
  assert.equal(resolveColor("auto", { env: { NO_COLOR: "1" }, isatty: true }), false);
  assert.ok(/^[\x00-\x7f]*$/.test(renderView(view, { report_regs: true }).join("\n")));
});

function hunkRowLines(view, { context = 2 } = {}) {
  const pairs = [];
  for (const line of renderView(view, { context })) {
    const m = /^\s+(\d+) [ >] /.exec(line);
    if (m) pairs.push([view.rows[parseInt(m[1], 10)], line]);
  }
  return pairs;
}

test("long rows are widened never truncated; every rendered hunk row shows a visible difference", () => {
  const long = viewOf(body("jal aVeryLongSymbolNameThatKeepsGoingAndGoing1", "nop"), body("jal aVeryLongSymbolNameThatKeepsGoingAndGoing2", "nop"));
  const screen = renderView(long).join("\n");
  assert.ok(screen.includes("aVeryLongSymbolNameThatKeepsGoingAndGoing1")); assert.ok(screen.includes("aVeryLongSymbolNameThatKeepsGoingAndGoing2"));
  for (const [t, c] of [[body("jal aLongSymbolNameUsedToForceColumnPadding1", "nop"), body("jal aLongSymbolNameUsedToForceColumnPadding2", "nop")],
    [body("lw t6,0(s0)", "andi t6,t6,0x1234"), body("lw t6,0(s0)", "andi t6,t6,0x1235")]]) {
    const rendered = hunkRowLines(viewOf(t, c)).filter(([row]) => row.target !== row.candidate);
    assert.ok(rendered.length);
    for (const [, line] of rendered) { const i = line.indexOf(" | "); assert.notEqual(line.slice(0, i).trim(), line.slice(i + 3).trim()); }
  }
});

test("context windows never print a row twice; the header names the register profile", () => {
  const view = viewOf(body("lw t6,0(s0)", "nop", "nop", "lw t7,4(s0)", "nop", "nop", "lw t8,8(s0)"), body("lw t9,0(s0)", "nop", "nop", "lw t6,4(s0)", "nop", "nop", "lw t7,8(s0)"));
  assert.ok(view.hunks.length >= 3);
  const idx = hunkRowLines(view, { context: 4 }).map(([r]) => r.index);
  assert.equal(idx.length, new Set(idx).size);
  assert.ok(renderView(viewOf(body("lw t6,0(s0)"), body("lw t7,0(s0)")))[0].includes("register_profile=ido53"));
});

test("register profiles are data and disjoint", () => {
  for (const [name, profile] of Object.entries(REGISTER_CLASS_PROFILES)) {
    const seen = new Set();
    for (const members of Object.values(profile)) { for (const m of members) { assert.ok(!seen.has(m), name); seen.add(m); } }
  }
});

// commands

test("view-dumps renders the documented screen", async () => {
  const [status, out] = await runCli(["view-dumps", PHASE_TARGET, PHASE_CANDIDATE, "--function", "animStep", "--color", "never"]);
  assert.equal(status, 0);
  for (const s of ["verdict: register-permutation", "signature: prefix-exact@12", "register-first-divergence", "REGISTER LANES", "rotation=+1", "HUNK 1", "WEBS", "next: owning pass: unknown"]) assert.ok(out.includes(s), s);
});

test("the documented contrast with positional counting holds", async () => {
  const [, positional] = await runCli(["compare-dumps", SHIFT_TARGET, SHIFT_CANDIDATE, "--symbol", "blockSum"]);
  const [, aligned] = await runCli(["view-dumps", SHIFT_TARGET, SHIFT_CANDIDATE, "--symbol", "blockSum", "--json"]);
  const p = JSON.parse(aligned);
  assert.ok(parseInt(/words=\s*(\d+)/.exec(positional)[1], 10) >= 10);
  assert.equal(p.structural, 1); assert.equal(p.register, 0); assert.equal(p.hunks.length, 1); assert.equal(p.verdict, "structure");
});

test("--symbol and --function are the same option; JSON uses the same keys as the human labels", async () => {
  const args = [PHASE_TARGET, PHASE_CANDIDATE, "--color", "never"];
  const [, a] = await runCli(["view-dumps", ...args, "--symbol", "animStep"]);
  const [, b] = await runCli(["view-dumps", ...args, "--function", "animStep"]);
  assert.equal(a, b);
  const [status, out] = await runCli(["view-dumps", PHASE_TARGET, PHASE_CANDIDATE, "--symbol", "animStep", "--json", "--report-regs"]);
  assert.equal(status, 0);
  const p = JSON.parse(out);
  assert.equal(p.schema, "decomp-workbench-view-v3");
  const allowed = schemaKeys();
  for (const k of Object.keys(p)) if (k !== "schema") assert.ok(allowed.has(k), k);
  assert.equal(p.verdict, "register-permutation"); assert.equal(p.playbook, "register-role-audit"); assert.equal(p.prefix_exact, 12);
  assert.equal(p.register, 6); assert.equal(p.structural, 0); assert.equal(p.register_report.length, p.aligned_rows);
  assert.ok(p.signature.includes("register-first-divergence"));
  const temp = p.lanes.find((l) => l.class === "temp");
  assert.equal(temp.rotation, 1); assert.equal(temp.slot, 5); assert.equal(temp.aligned_row, 12); assert.ok(!("divergence" in temp));
});

test("--fail-on-mismatch is opt-in; --width bounds human lines", async () => {
  const args = ["view-dumps", PHASE_TARGET, PHASE_CANDIDATE, "--symbol", "animStep", "--color", "never"];
  assert.equal((await runCli(args))[0], 0);
  assert.equal((await runCli([...args, "--fail-on-mismatch"]))[0], 1);
  assert.equal((await runCli(["view-dumps", PHASE_TARGET, PHASE_TARGET, "--symbol", "animStep", "--fail-on-mismatch", "--color", "never"]))[0], 0);
  const [status, out] = await runCli([...args, "--pager", "never", "--width", "40"]);
  assert.equal(status, 0); assert.ok(out);
  assert.ok(out.split("\n").every((l) => l.length <= 40));
});

test("the HTML report is self-contained and refuses to overwrite", async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "romdev-wb-view-"));
  const output = path.join(d, "view.html");
  const args = ["view-dumps", PHASE_TARGET, PHASE_CANDIDATE, "--symbol", "animStep", "--color", "never", "--pager", "never", "--html", output];
  const [status] = await runCli(args);
  const doc = fs.readFileSync(output, "utf8");
  const [second, , err] = await runCli(args);
  assert.equal(status, 0); assert.ok(doc.includes("<!doctype html>")); assert.ok(doc.includes("Machine-readable evidence")); assert.ok(!doc.includes("https://"));
  assert.equal(second, 2); assert.ok(err.includes("refusing to overwrite"));
});

test("a register permutation can emit an honest force handoff", async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "romdev-wb-view-"));
  const t = path.join(d, "target.objdump"), c = path.join(d, "candidate.objdump"), out = path.join(d, "force.json");
  fs.writeFileSync(t, "00000000 <demo>:\n   0: 8e110000  lw $s1,0($s0)\n   4: ae110004  sw $s1,4($s0)\n");
  fs.writeFileSync(c, "00000000 <demo>:\n   0: 8e120000  lw $s2,0($s0)\n   4: ae120004  sw $s2,4($s0)\n");
  const [status] = await runCli(["view-dumps", t, c, "--symbol", "demo", "--color", "never", "--emit-force-spec", out]);
  const p = JSON.parse(fs.readFileSync(out, "utf8"));
  assert.equal(status, 0); assert.equal(p.schema, "decomp-workbench-diagnostic-force-v1");
  assert.equal(p.permutation[0].allocator_web, null); assert.ok(p.proof.includes("not compiler allocator web IDs"));
});

test("a missing symbol, an unreadable input and a missing objdump exit two", async () => {
  let [status, , err] = await runCli(["view-dumps", PHASE_TARGET, PHASE_CANDIDATE, "--symbol", "absent"]);
  assert.equal(status, 2); assert.ok(err.includes("absent"));
  [status, , err] = await runCli(["view-dumps", PHASE_TARGET, path.join(FIX, "missing.objdump")]);
  assert.equal(status, 2); assert.ok(err.includes("error:"));
  [status, , err] = await runCli(["view", PHASE_TARGET, PHASE_CANDIDATE, "--objdump", path.join(FIX, "no-such-objdump")]);
  assert.equal(status, 2); assert.ok(err.includes("error:"));
});
