// Ported from the workbench's register-era tests: era capabilities are not
// per-function register ownership, the unverified table ships unchanged, the
// evidence travels with the answer, and the guide carries the law.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { assemble } from "./fixtures/workbench/mips-asm.js";
import { parseDisassembly } from "../src/decomp/workbench/objdump.js";
import { nextSteps } from "../src/decomp/workbench/field-guide.js";
import { DEFAULT_REGISTER_PROFILE, REGISTER_CLASS_PROFILES, REGISTER_PROFILE_EVIDENCE, UNVERIFIED_CLASSES, buildView } from "../src/decomp/workbench/view.js";
import { formatHelp } from "../src/decomp/workbench/argparse.js";
import { viewRenderArguments } from "../src/decomp/workbench/cli-options.js";

const DATA = fileURLToPath(new URL("../src/decomp/workbench/data/", import.meta.url));
const PROLOGUE = ["addiu sp,sp,-32", "sw ra,28(sp)", "sw s0,24(sp)", "move s0,a0"];
const EPILOGUE = ["lw ra,28(sp)", "lw s0,24(sp)", "jr ra", "addiu sp,sp,32"];
const ins = (l) => parseDisassembly(assemble([...PROLOGUE, ...l, ...EPILOGUE], { symbol: "demo" }), { symbol: "demo" });
const viewOf = (l, c = null, profile = DEFAULT_REGISTER_PROFILE) => buildView(ins(l), c === null ? ins(l) : ins(c), { target_name: "t", candidate_name: "c", symbol: "demo", register_profile: profile });
const laneOf = (v, r) => v.lanes.find((l) => l.target.includes(r))?.classification ?? null;
const candidateLaneOf = (v, r) => v.lanes.find((l) => l.candidate.includes(r))?.classification ?? null;

test("shared registers are not assigned an unproved role; saved registers are uopt colors", () => {
  for (const r of ["t0", "t1", "t2", "t3", "t4", "t5", "t6", "t9"]) assert.equal(laneOf(viewOf([`lw ${r},0(s0)`]), r), ["t0", "t1", "t2", "t3", "t4", "t5"].includes(r) ? "shared" : "temp", r);
  for (const r of ["s1", "s2", "s7", "s8"]) assert.equal(laneOf(viewOf([`lw ${r},0(s0)`]), r), "pool", r);
});

test("the float split is carried; f16 is a coloring change, not a closed temp site; the evidence states the measured ring", () => {
  const p = REGISTER_CLASS_PROFILES.ido53;
  for (const r of ["f4", "f6", "f8", "f10"]) assert.ok(p["fp-temp"].includes(r));
  for (const r of ["f0", "f2", "f12", "f20", "f24", "f16", "f18"]) assert.ok(p["fp-pool"].includes(r));
  assert.ok(!p["fp-temp"].includes("f16")); assert.ok(!p["fp-temp"].includes("f18")); assert.equal(p["fp-temp"].length, 4);
  const v = viewOf(["lwc1 f12,16(s0)"], ["lwc1 f16,16(s0)"]);
  assert.equal(laneOf(v, "f12"), "fp-pool"); assert.equal(candidateLaneOf(v, "f16"), "fp-pool");
  assert.ok(REGISTER_PROFILE_EVIDENCE.ido53.includes("f16/f18")); assert.ok(REGISTER_PROFILE_EVIDENCE.ido53.includes("withdrawn"));
});

test("temp tables are in ugen ring order", () => {
  assert.deepEqual([...REGISTER_CLASS_PROFILES.ido53.temp], ["t6", "t7", "t8", "t9"]);
  assert.deepEqual([...REGISTER_CLASS_PROFILES.ido53["fp-temp"]], ["f4", "f6", "f8", "f10"]);
});

test("the pre-probe table ships unchanged; the two eras disagree about one register; the unverified era has no float lanes", () => {
  const plain = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, [...v]]));
  assert.deepEqual(plain(UNVERIFIED_CLASSES), { pool: ["v0", "v1", "a0", "a1", "a2", "a3", "t0", "t1", "t2", "t3", "t4", "t5"], temp: ["t6", "t7", "t8", "t9", "s8"] });
  assert.equal(REGISTER_CLASS_PROFILES.unverified, UNVERIFIED_CLASSES);
  assert.equal(laneOf(viewOf(["lw t0,0(s0)"]), "t0"), "shared");
  assert.equal(laneOf(viewOf(["lw t0,0(s0)"], null, "unverified"), "t0"), "pool");
  assert.ok(!("fp-temp" in REGISTER_CLASS_PROFILES.unverified));
});

test("every profile declares what it is made of, and the evidence travels with the answer and the flag help", () => {
  assert.deepEqual(Object.keys(REGISTER_PROFILE_EVIDENCE).sort(), Object.keys(REGISTER_CLASS_PROFILES).sort());
  let p = viewOf(["lw t6,0(s0)"]).asDict();
  assert.equal(p.register_profile, "ido53"); assert.ok(p.register_profile_evidence.includes("probed"));
  p = viewOf(["lw t6,0(s0)"], null, "unverified").asDict();
  assert.equal(p.register_profile, "unverified"); assert.ok(p.register_profile_evidence.includes("not measured"));
  const help = formatHelp({ arguments: viewRenderArguments() }, { prog: "x" }).split(/\s+/).join(" ");
  for (const [name, evidence] of Object.entries(REGISTER_PROFILE_EVIDENCE)) { assert.ok(help.includes(name)); assert.ok(help.includes(evidence.split(",")[0].split(/\s+/).join(" ")), name); }
});

const guide = () => fs.readFileSync(DATA + "docs/field-guide.md", "utf8");

test("the guide carries the era table, the five-three law and which claims are verified", () => {
  const t = guide();
  for (const s of ["s0 s1 s2 s3 s4 s5 s6 s7 s8", "t6 t7 t8 t9 t0 t1 t2 t3 t4 t5", "f4 f6 f8 f10", "unverified", "least-recently-freed", "once per procedure",
    "pure function of the alloc/free", "class-crossing", "monotone", "5.3-verified", "IDO 7.1"]) assert.ok(t.includes(s), s);
});

test("the on-ramp repeats the site-count rule; the agent reference carries the split", () => {
  const joined = nextSteps("temp-fifo-phase").join(" ");
  assert.ok(joined.toLowerCase().includes("class-crossing")); assert.ok(joined.includes("not")); assert.ok(joined.includes("monotone"));
  const ref = fs.readFileSync(DATA + "skills/n64-decomp-campaign/references/ido-late-stage-patterns.md", "utf8");
  for (const s of ["always", "`t0-t5`", "unverified"]) assert.ok(ref.includes(s), s);
});
