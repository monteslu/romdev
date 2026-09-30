// Ported from the workbench's diagnosis and statement-line (loc boundary)
// tests: the combined comparison + mechanism document, its exit contracts,
// and the `.loc` evidence under a schedule residual.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "../src/decomp/workbench/argparse.js";
import { COMMAND_SPECS as DIAGNOSE_SPECS } from "../src/decomp/workbench/diagnose-cli.js";
const DIAGNOSE_SPEC = DIAGNOSE_SPECS.find((s) => s.path[0] === "diagnose");
import { diagnoseDumpsCommand } from "../src/decomp/workbench/diagnose-cli.js";
import { diagnoseInstructions, DIAGNOSIS_SCHEMA } from "../src/decomp/workbench/diagnosis.js";
import * as LB from "../src/decomp/workbench/loc-boundaries.js";
import { parseDisassembly } from "../src/decomp/workbench/objdump.js";
import { buildView } from "../src/decomp/workbench/view.js";
import { assemble } from "./fixtures/workbench/mips-asm.js";

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "workbench");
const TARGET = "\n00000000 <demo>:\n   0: 27bdffe0  addiu $sp,$sp,-32\n   4: 012a4021  addu $t0,$t1,$t2\n   8: 03e00008  jr $ra\n   c: 00000000  nop\n";
const CANDIDATE = "\n00000000 <demo>:\n   0: 27bdffe0  addiu $sp,$sp,-32\n   4: 012a5821  addu $t3,$t1,$t2\n   8: 03e00008  jr $ra\n   c: 00000000  nop\n";

async function run(argv, cwd = FIX) {
  const args = parseArgs(DIAGNOSE_SPEC, argv);
  const out = [], err = [];
  const io = { print: (s = "") => out.push(`${s}\n`), eprint: (s = "") => err.push(`${s}\n`), write: (s) => out.push(String(s)), ewrite: (s) => err.push(String(s)) };
  const status = await diagnoseDumpsCommand(args, io, { cwd, env: process.env, resolve: (p) => path.resolve(cwd, p) });
  return [status, out.join(""), err.join("")];
}

function writeDumps() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "romdev-diagnosis-"));
  fs.writeFileSync(path.join(d, "target.objdump"), TARGET);
  fs.writeFileSync(path.join(d, "candidate.objdump"), CANDIDATE);
  return d;
}

test("both halves are built from one pair of instruction streams", () => {
  const r = diagnoseInstructions(parseDisassembly(TARGET, { symbol: "demo" }), parseDisassembly(CANDIDATE, { symbol: "demo" }),
    { target_name: "target.o", candidate_name: "candidate.o", symbol: "demo" });
  assert.equal(r.comparison.aligned_register, 1);
  assert.equal(r.view.counts.register, 1);
});

test("json contains both versioned reports", async () => {
  const d = writeDumps();
  const [status, stdout, stderr] = await run([path.join(d, "target.objdump"), path.join(d, "candidate.objdump"), "--function", "demo", "--json"], d);
  const payload = JSON.parse(stdout);
  assert.equal(status, 0);
  assert.equal(stderr, "");
  assert.equal(payload.schema, DIAGNOSIS_SCHEMA);
  assert.equal(payload.comparison.aligned_register, 1);
  assert.equal(payload.view.register, 1);
});

test("fail and census exit contracts are shared", async () => {
  const d = writeDumps();
  const base = [path.join(d, "target.objdump"), path.join(d, "candidate.objdump"), "--function", "demo", "--fail-on-mismatch", "--json"];
  assert.equal((await run(base, d))[0], 1);
  assert.equal((await run([...base, "--census", "aligned_register=1"], d))[0], 1);
  assert.equal((await run([path.join(d, "target.objdump"), path.join(d, "target.objdump"), "--function", "demo", "--fail-on-mismatch", "--json"], d))[0], 0);
});

test("human default is one decisive hunk", async () => {
  const d = writeDumps();
  const [status, stdout] = await run([path.join(d, "target.objdump"), path.join(d, "candidate.objdump"), "--function", "demo", "--color", "never"], d);
  assert.equal(status, 0);
  for (const s of ["COMPARISON", "MECHANISM", "HUNK 1"]) assert.ok(stdout.includes(s), s);
  assert.ok(!stdout.includes("HUNK 2"));
});

test("human fail and census exit contracts are shared", async () => {
  const d = writeDumps();
  const base = [path.join(d, "target.objdump"), path.join(d, "candidate.objdump"), "--function", "demo", "--fail-on-mismatch"];
  assert.equal((await run(base, d))[0], 1);
  assert.equal((await run([...base, "--census", "aligned_register=1"], d))[0], 1);
  assert.equal((await run([path.join(d, "target.objdump"), path.join(d, "target.objdump"), "--function", "demo", "--fail-on-mismatch"], d))[0], 0);
});

test("--html writes a self-contained report and --emit-force-spec a handoff; neither overwrites", async () => {
  const d = writeDumps();
  const pair = [path.join(d, "target.objdump"), path.join(d, "candidate.objdump"), "--function", "demo"];
  let [status, stdout, stderr] = await run([...pair, "--html", path.join(d, "r.html"), "--emit-force-spec", path.join(d, "f.json")], d);
  assert.equal(status, 0, stderr);
  assert.ok(stderr.includes("ROM-derived"));
  assert.ok(stdout.includes("HTML report: " + path.join(d, "r.html")));
  const html = fs.readFileSync(path.join(d, "r.html"), "utf8");
  assert.ok(html.startsWith("<!doctype html>") && html.includes("decomp-workbench-html-diagnosis-v1") && !html.includes("<script"));
  const spec = JSON.parse(fs.readFileSync(path.join(d, "f.json"), "utf8"));
  assert.equal(spec.schema, "decomp-workbench-diagnostic-force-v1");
  assert.equal(spec.permutation[0].allocator_web, null);
  [status, , stderr] = await run([...pair, "--html", path.join(d, "r.html")], d);
  assert.equal(status, 2); assert.ok(stderr.includes("refusing to overwrite HTML report"));
  [status, , stderr] = await run([...pair, "--json", "--html", path.join(d, "x.html")], d);
  assert.equal(status, 2); assert.ok(stderr.includes("mutually exclusive"));
});

// ---- statement-line evidence ----

const LB_TARGET = path.join(FIX, "loc-boundary-target.objdump.txt");
const LB_CANDIDATE = path.join(FIX, "loc-boundary-candidate.objdump.txt");
const LISTING = path.join(FIX, "loc-boundary-candidate.s.txt");
const SYMBOL = "blitRow";
const SAMPLE = [
  '\t.file\t2 "sample.c"', "\t.option\tpic2", "\t.text", "\t.globl\tsample", "\t.loc\t2\t10", " #    10\tvoid sample(s32 *p) {",
  "\t.ent\tsample 2", "sample:", "\t.frame\t$sp, 0, $31", "\t.mask\t0x00000000, 0", "\t.loc\t2\t12", " #    12\t    p[0] = 1;",
  "\tli\t$t0, 1", "\tsw\t$t0, 0($a0)", "$32:", "\t.livereg\t0x0000FF0E,0x00000000", "\t.loc\t2\t14", " #    14\t    p[1] = p[0];",
  "\tlw\t$t1, 0($a0)\t# a trailing comment", "\tsw\t$t1, 4($a0)", "\t.loc\t2\t15", "\tjr\t$ra", "\t.end\tsample", "",
].join("\n");

const fixtureView = () => buildView(parseDisassembly(fs.readFileSync(LB_TARGET, "utf8"), { symbol: SYMBOL }),
  parseDisassembly(fs.readFileSync(LB_CANDIDATE, "utf8"), { symbol: SYMBOL }), { target_name: "target", candidate_name: "candidate", symbol: SYMBOL });

test("every listing instruction carries the loc that governs it", () => {
  const fns = LB.parseListing(SAMPLE);
  assert.deepEqual(fns.map((f) => f.name), ["sample"]);
  assert.deepEqual(fns[0].instructions.map((i) => [i.mnemonic, i.line]), [["li", 12], ["sw", 12], ["lw", 14], ["sw", 14], ["jr", 15]]);
  const mnemonics = new Set(fns[0].instructions.map((i) => i.mnemonic));
  for (const absent of [".livereg", ".frame", ".mask", ".option", "$32", "#"]) assert.ok(!mnemonics.has(absent), absent);
  assert.equal(fns[0].instructions[2].text, "lw $t1, 0($a0)");
  assert.equal(fns[0].instructions[0].file_index, 2);
  assert.equal(fns[0].instructions[0].file, "sample.c");
});

test("functions are kept apart; truncated and trimmed listings still parse", () => {
  assert.deepEqual(LB.parseListing(SAMPLE + SAMPLE.replaceAll("sample", "other")).map((f) => f.name), ["sample", "other"]);
  const truncated = LB.parseListing(SAMPLE.split("\t.loc\t2\t14")[0]);
  assert.equal(truncated.length, 1);
  assert.equal(truncated[0].instructions.length, 2);
  const trimmed = LB.parseListing(SAMPLE.split("\n").filter((l) => !l.includes(".ent") && !l.includes(".end")).join("\n"));
  assert.deepEqual(trimmed.map((f) => f.name), [""]);
  assert.equal(trimmed[0].instructions.length, 5);
});

test("selecting a function names what the file holds", () => {
  assert.throws(() => LB.selectFunction(LB.parseListing(SAMPLE), "absent"), /sample/);
  assert.throws(() => LB.selectFunction(LB.parseListing(SAMPLE + SAMPLE.replaceAll("sample", "b")), null), /--symbol/);
});

test("anchors map and a macro stays unmapped; a mnemonic survives a respelling", () => {
  const fn = LB.parseListing(fs.readFileSync(LISTING, "utf8"))[0];
  const cand = parseDisassembly(fs.readFileSync(LB_CANDIDATE, "utf8"), { symbol: SYMBOL });
  const mapping = LB.mapToListing(cand.map((i) => i.assembly), fn);
  assert.deepEqual(mapping.slice(0, 14), [...Array(14).keys()]);
  assert.equal(mapping[14], null);
  assert.equal(mapping[19], null);
  assert.deepEqual(mapping.slice(15, 19), [15, 16, 17, 18]);
  const respelled = LB.parseListing(SAMPLE.replace("\tjr\t$ra", "\tjr\t$31"))[0];
  assert.equal(LB.mapToListing(["li $t0,1", "sw $t0,0($a0)", "lw $t1,0($a0)", "sw $t1,4($a0)", "jr $ra"], respelled)[4], 4);
});

test("site annotation: the fixture counts, statuses, widening and rendering", () => {
  const report = LB.annotateScheduleSites(fixtureView(), fs.readFileSync(LISTING, "utf8"), { listing_name: "listing.s", symbol: SYMBOL });
  assert.equal(report.sites.length, 3);
  assert.equal(report.boundary_sites, 2);
  assert.equal(report.decidable_sites, 3);
  assert.equal(report.target_only_hunks.length, 3);
  assert.ok(report.majority);
  assert.ok(report.summary_line.includes("2 of 3 schedule-divergent sites sit at statement-line boundaries"));
  assert.deepEqual(report.sites.map((s) => s.status), ["boundary", "same-line", "boundary"]);
  assert.deepEqual(report.sites[0].distinct_lines, [201, 206, 211]);
  assert.deepEqual(report.sites[1].distinct_lines, [220]);
  assert.deepEqual(report.sites.map((s) => s.widened), [true, false, true]);
  const rendered = LB.renderLocBoundaries(report).join("\n");
  assert.ok(rendered.includes("widened=yes") && rendered.includes("one instruction on each side"));
  assert.ok(rendered.includes("3 hunks hold no candidate instruction (2, 4, 6)"));
  assert.ok(rendered.includes("lines=?,224,228") && rendered.includes("never guessed at by position"));
  const guidance = LB.reportGuidance(report).join("\n");
  assert.ok(guidance.includes("field guide levers for playbook=line-assignment-probe"));
  assert.ok(guidance.includes("lever 23:") && guidance.includes("even at -g0"));
  const payload = report.asDict();
  assert.equal(payload.schema, LB.LOC_BOUNDARIES_SCHEMA);
  assert.equal(payload.playbook, "line-assignment-probe");
  assert.equal(payload.boundary_sites, 2);
  assert.deepEqual(payload.target_only_hunks, [2, 4, 6]);
  assert.deepEqual(payload.sites[0].lines, [201, 206, 211]);
});

test("a listing for another function reports no result, not a negative", () => {
  const unrelated = "\t.loc\t1\t3\n\t.ent\tblitRow\nblitRow:\n\tmult\t$t0, $t1\n\tmflo\t$t2\n\tbreak\t0\n\t.end\tblitRow\n";
  const report = LB.annotateScheduleSites(fixtureView(), unrelated, { listing_name: "wrong.s", symbol: SYMBOL });
  assert.equal(report.boundary_sites, 0);
  assert.equal(report.decidable_sites, 0);
  assert.equal(report.unmapped_sites, 3);
  assert.ok(!report.majority);
  const guidance = LB.reportGuidance(report).join("\n");
  assert.ok(guidance.includes("no site could be attributed"));
  assert.ok(!guidance.includes("playbook=line-assignment-probe"));
  assert.equal(LB.renderLocBoundaries(report).join("\n").split("status=unmapped").length - 1, 3);
});

test("a comparison with no schedule rows says so", () => {
  const view = buildView(parseDisassembly(assemble(["lw t0,0(a0)", "jr ra"], { symbol: "tiny" }), { symbol: "tiny" }),
    parseDisassembly(assemble(["lw t1,0(a0)", "jr ra"], { symbol: "tiny" }), { symbol: "tiny" }), { target_name: "target", candidate_name: "candidate", symbol: "tiny" });
  const report = LB.annotateScheduleSites(view, "\t.ent\ttiny\ntiny:\n\t.loc\t1\t5\n\tlw\t$t1, 0($a0)\n\t.end\ttiny\n", { listing_name: "tiny.s", symbol: "tiny" });
  assert.deepEqual(report.sites, []);
  assert.ok(report.summary_line.includes("no aligned row is schedule-class"));
});

test("diagnose: the listing report and the promoted playbook reach the document", async () => {
  const base = [LB_TARGET, LB_CANDIDATE, "--function", SYMBOL, "--json"];
  let [status, stdout] = await run([...base, "--candidate-listing", LISTING]);
  assert.equal(status, 0);
  let payload = JSON.parse(stdout);
  assert.equal(payload.loc_boundaries.boundary_sites, 2);
  assert.ok(payload.view.next.join("\n").includes("field guide levers for playbook=line-assignment-probe"));
  [status, stdout] = await run(base);
  assert.equal(status, 0);
  payload = JSON.parse(stdout);
  const next = payload.view.next.join("\n");
  assert.ok(next.includes("--candidate-listing") && next.includes("cc -K") && next.includes("ugen -l"));
  assert.ok(!("loc_boundaries" in payload));
  let stderr;
  [status, , stderr] = await run([...base, "--candidate-listing", path.join(FIX, "absent.s")]);
  assert.equal(status, 2); assert.ok(stderr.includes("error:"));
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "romdev-listing-"));
  fs.writeFileSync(path.join(d, "other.s"), SAMPLE);
  [status, , stderr] = await run([...base, "--candidate-listing", path.join(d, "other.s")]);
  assert.equal(status, 2); assert.ok(stderr.includes("sample"));
});
