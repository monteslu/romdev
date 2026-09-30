// Ported from the workbench's lever tests. The property under test is the
// honesty rule: a class named without its deciding evidence leaves
// `edit_family` empty and names the capture instead. The law-citation tests
// (which read the workbench's own docs pages) are not ported.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { replace } from "../src/decomp/workbench/py.js";
import { parseAs1ReorganizeTrace } from "../src/decomp/workbench/as1-reorganize.js";
import { CdxLog } from "../src/decomp/workbench/cascade.js";
import { parseEmitTrace } from "../src/decomp/workbench/emit-provenance.js";
import { frameLadder } from "../src/decomp/workbench/frame-ladder.js";
import * as L from "../src/decomp/workbench/levers.js";
import { parseDisassembly } from "../src/decomp/workbench/objdump.js";
import { parseTrace } from "../src/decomp/workbench/trace.js";
import { Web, buildView } from "../src/decomp/workbench/view.js";
import { parseArgs } from "../src/decomp/workbench/argparse.js";
import { COMMAND_SPECS as DIAGNOSE_SPECS } from "../src/decomp/workbench/diagnose-cli.js";
const DIAGNOSE_SPEC = DIAGNOSE_SPECS.find((s) => s.path[0] === "diagnose");
import { diagnoseDumpsCommand } from "../src/decomp/workbench/diagnose-cli.js";

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "workbench");
const read = (name) => fs.readFileSync(path.join(FIX, name), "utf8");

const HOME_TARGET = `
00000000 <demo>:
   0: 27bdffd0  addiu $sp,$sp,-48
   4: afbf0014  sw $ra,20($sp)
   8: afa2001c  sw $v0,28($sp)
   c: 8fa2001c  lw $v0,28($sp)
  10: 03e00008  jr $ra
  14: 27bd0030  addiu $sp,$sp,48
`;
const HOME_CANDIDATE = `
00000000 <demo>:
   0: 27bdffd0  addiu $sp,$sp,-48
   4: afbf0014  sw $ra,20($sp)
   8: afa20018  sw $v0,24($sp)
   c: 8fa20018  lw $v0,24($sp)
  10: 03e00008  jr $ra
  14: 27bd0030  addiu $sp,$sp,48
`;
const FRAME_TARGET = HOME_TARGET;
const FRAME_CANDIDATE = `
00000000 <demo>:
   0: 27bdffc8  addiu $sp,$sp,-56
   4: afbf0014  sw $ra,20($sp)
   8: afa2001c  sw $v0,28($sp)
   c: 8fa2001c  lw $v0,28($sp)
  10: 03e00008  jr $ra
  14: 27bd0038  addiu $sp,$sp,56
`;
const RING_TRACE = `DKWB-FREELIST ADD proc=3 reg=14
DKWB-FREELIST ADD proc=3 reg=15
DKWB-FREELIST ADD proc=3 reg=24
DKWB-FREELIST ADD proc=3 reg=25
DKWB-FREELIST ALLOC_GP_RESULT proc=3 reg=14 line=41 emitted=10 row=1
DKWB-FREELIST ALLOC_GP_RESULT proc=3 reg=15 line=42 emitted=11 row=2
DKWB-FREELIST ALLOC_GP_RESULT proc=3 reg=24 line=42 emitted=12 row=3
DKWB-FREELIST ALLOC_GP_RESULT proc=3 reg=25 line=43 emitted=13 row=4
DKWB-FREELIST REMOVE proc=3 reg=2 line=43 emitted=13
`;
const EMIT_TRACE = `DKWB-EMIT-V1 proc=0 block=0 emit=4 op=28 line=45 buffer=fwd fn=f_emit_dir2
DKWB-EMIT-V1 proc=0 block=0 emit=5 op=41 line=45 buffer=fwd fn=f_emit_ri_
DKWB-EMIT-V1 proc=0 block=0 emit=7 op=36 line=46 buffer=fwd fn=f_emit_ra
`;

const viewFor = (t, c, opts = {}) => buildView(parseDisassembly(t), parseDisassembly(c), { target_name: "target", candidate_name: "candidate", symbol: "demo", ...opts });
const rotationView = (opts = { register_profile: "unverified" }) => viewFor(read("phase-shift-target.objdump.txt"), read("phase-shift-candidate.objdump.txt"), opts);
const selections = () => parseAs1ReorganizeTrace(read("as1-reorganize.trace"))[0];
const joined = (lever) => lever.evidence.join(" ");

// ---- stack home ----

test("a displaced home at an equal frame names the carrier edit, one home not two", () => {
  const lever = L.leverFor(viewFor(HOME_TARGET, HOME_CANDIDATE));
  assert.equal(lever.lever_class, L.LEVER_STACK_HOME);
  assert.equal(lever.family.name, "reuse-an-existing-local-as-carrier");
  assert.equal(lever.measurements.frame_delta, 0);
  assert.equal(lever.measurements.instruction_counts_agree, true);
  assert.equal(lever.measurements.displaced_home_rows, 2);
  assert.equal(lever.measurements.displaced_homes, 1);
  assert.equal(lever.measurements.declared_locals, null);
  assert.ok(lever.needs.some((n) => n.includes("CDX_SYMTAB=1")));
  assert.ok(joined(lever).includes("register-coloured") && joined(lever).includes("rounds up to 8"));
  assert.deepEqual(new Set([lever.family.name, ...lever.alternatives.map((a) => a.name)]), new Set(L.STACK_HOME_FAMILIES.map((f) => f.name)));
});

test("a larger candidate frame names the drop edit", () => {
  const lever = L.leverFor(viewFor(FRAME_TARGET, FRAME_CANDIDATE));
  assert.equal(lever.lever_class, L.LEVER_STACK_HOME);
  assert.equal(lever.family.name, "drop-a-declared-local");
  assert.equal(lever.measurements.frame_delta, 8);
  assert.equal(lever.measurements.frame_delta_words, 2);
});

test("a ladder supplies the declared-local count", () => {
  const ladder = frameLadder(new CdxLog(read("frame-ladder.trace"), { name: "frame-ladder.log" }), { frame: -216 });
  const lever = L.leverFor(viewFor(HOME_TARGET, HOME_CANDIDATE), { ladder });
  assert.equal(lever.measurements.declared_locals, ladder.named.length);
  assert.ok(!lever.needs.some((n) => n.includes("CDX_SYMTAB=1")));
});

test("lane evidence outranks frame arithmetic, in both directions", () => {
  const surplus = (side) => {
    const view = viewFor(HOME_TARGET, HOME_CANDIDATE);
    const pool = view.lanes.find((l) => l.classification === "pool");
    const grown = replace(pool, { [side]: [...pool[side], "v1"] });
    return replace(view, { lanes: view.lanes.map((l) => (l.classification === "pool" ? grown : l)) });
  };
  let lever = L.leverFor(surplus("candidate"));
  assert.equal(lever.family.name, "drop-a-declared-local");
  assert.equal(lever.measurements.pool_lane_length_delta, 1);
  assert.ok(joined(lever).includes("outranks the frame arithmetic"));
  lever = L.leverFor(surplus("target"));
  assert.equal(lever.measurements.pool_lane_length_delta, -1);
  assert.ok(lever.reason.includes("so the target colours a web"));
  assert.ok(joined(lever).includes("the target colours a web"));
  assert.equal(L.STACK_HOME_RANKING.length, 3);
  assert.ok(L.STACK_HOME_RANKING[0].includes("pool lane") && L.STACK_HOME_RANKING[1].includes("frame delta"));
});

// ---- temp ring ----

test("a rotation without a trace refuses to name a family", () => {
  const lever = L.leverFor(rotationView());
  assert.equal(lever.lever_class, L.LEVER_TEMP_RING);
  assert.equal(lever.family, null);
  assert.ok(lever.needs.some((n) => n.includes("DKWB_UGEN_TRACE=1")));
  assert.deepEqual(new Set(lever.alternatives.map((a) => a.name)), new Set(L.TEMP_RING_FAMILIES.map((f) => f.name)));
});

test("a ring trace reports pops per line, the ring order and the two-pop rule", () => {
  const lever = L.leverFor(rotationView(), { ring_events: parseTrace(RING_TRACE), proc: 3 });
  assert.equal(lever.lever_class, L.LEVER_TEMP_RING);
  assert.deepEqual(lever.measurements.pops_by_line, { 41: 1, 42: 2, 43: 1 });
  assert.equal(lever.measurements.pop_total, 4);
  assert.ok(joined(lever).includes("42"));
  assert.deepEqual(lever.measurements.ring_order, ["t6", "t7", "t8", "t9"]);
  assert.ok(joined(lever).includes("two pops off means two of these"));
});

test("a procedure scope excludes other procedures; modern pairs count by bank", () => {
  const events = parseTrace(RING_TRACE);
  assert.deepEqual([...L.popsByLine(events, { proc: 4 })], []);
  assert.deepEqual([...L.popsByLine(events, { proc: 3 })], [[41, 1], [42, 2], [43, 1]]);
  const modern = parseTrace("DKWB-FREELIST ALLOC_GP proc=3 reg=8 line=42 emitted=1\nDKWB-FREELIST ALLOC_GP_RESULT proc=3 reg=14 line=42 emitted=1\n"
    + "DKWB-FREELIST ALLOC_FP proc=3 reg=14 line=42 emitted=2\nDKWB-FREELIST ALLOC_FP_RESULT proc=3 reg=36 line=42 emitted=2\nDKWB-FREELIST ALLOC_GP_RESULT proc=4 reg=15 line=42 emitted=3\n");
  assert.deepEqual([...L.popsByLine(modern, { proc: 3 })], [[42, 1]]);
  assert.deepEqual([...L.popsByLine(modern, { proc: 3, bank: "fp" })], [[42, 1]]);
  const lever = L.leverFor(rotationView(), { ring_events: modern, proc: 3 });
  assert.equal(lever.measurements.pop_total, 1);
  assert.deepEqual(lever.measurements.ring_order, ["t6"]);
  assert.deepEqual(lever.measurements.allocation_event_counts, { ALLOC_GP: 1, ALLOC_GP_RESULT: 1, ALLOC_FP: 1, ALLOC_FP_RESULT: 1 });
  assert.equal(lever.family, null);
});

test("incomplete or unscoped ring evidence withholds source advice", () => {
  const source = Array.from({ length: 50 }, () => "value = entry->field;");
  const cases = {
    "missing mapping": RING_TRACE.replaceAll(" row=", " unused="),
    "invalid queue": RING_TRACE + "DKWB-FREELIST FREE proc=3 reg=8\n",
    "missing result": RING_TRACE + "DKWB-FREELIST ALLOC_GP proc=3 reg=8 line=49\n",
    "unknown event": RING_TRACE + "DKWB-FREELIST ALLOC_FUTURE proc=3 reg=14\n",
    "queue control": RING_TRACE + "DKWB-FREELIST MOVE_END proc=3 reg=14\n",
    "unscoped": RING_TRACE + "DKWB-FREELIST ALLOC_GP_RESULT reg=14 line=42 row=9\n",
    "empty": "",
  };
  for (const [name, trace] of Object.entries(cases)) {
    const events = parseTrace(trace);
    if (name === "queue control") events[events.length - 1] = replace(events[events.length - 1], { action: "move-end" });
    const lever = L.leverFor(rotationView(), { ring_events: events, proc: 3, source });
    assert.equal(lever.family, null, name);
    assert.ok(lever.needs.length, name);
    assert.ok(lever.measurements.trace_evidence_issues?.length, name);
  }
  assert.deepEqual([...L.popsByLine(parseTrace("DKWB-FREELIST ALLOC_GP_RESULT reg=14 line=42\n"), { proc: 3 })], []);
});

test("mixed procedures require scope and legacy events stay explicit", () => {
  const lever = L.leverFor(rotationView(), { ring_events: parseTrace(RING_TRACE + "DKWB-FREELIST ALLOC_GP_RESULT proc=4 reg=14 line=42 row=1\n") });
  assert.equal(lever.family, null);
  assert.ok(lever.reason.includes("mixed procedure"));
  const legacy = parseTrace("DKWB-FREELIST ALLOC reg=14 line=42\nCODEX-ALLOC reg=36 line=42\n");
  assert.deepEqual([...L.popsByLine(legacy)], [[42, 1]]);
  assert.deepEqual([...L.popsByLine(legacy, { bank: "fp" })], [[42, 1]]);
});

test("temp ring preconditions: the charged line's construct gates the family", () => {
  const src = (line42) => { const lines = Array(50).fill(""); lines[40] = "total = other;"; lines[41] = line42; lines[42] = "next = other;"; return lines; };
  const ring = parseTrace(RING_TRACE);
  let lever = L.leverFor(rotationView(), { ring_events: ring, proc: 3 });
  assert.equal(lever.family, null);
  assert.ok(lever.needs.some((n) => n.includes("--source")));
  lever = L.leverFor(rotationView(), { ring_events: ring, proc: 3, source: src("blue = entry->blue;") });
  assert.equal(lever.family.name, "read-the-field-directly");
  assert.deepEqual(lever.needs, []);
  assert.equal(lever.measurements.constructs_by_line["42"], "field-through-local");
  lever = L.leverFor(rotationView(), { ring_events: ring, proc: 3, source: src("table = (s32 **)0x800A0000;") });
  assert.equal(lever.family, null);
  assert.ok(lever.reason.includes("measured pop cost") && lever.reason.includes("constant"));
  lever = L.leverFor(rotationView(), { ring_events: ring, proc: 3, source: src("owner = ctx->entries[i * 2].owner;") });
  assert.equal(lever.family.name, "scale-the-index-twice");
  const flat = parseTrace("DKWB-FREELIST ADD proc=3 reg=14\nDKWB-FREELIST ADD proc=3 reg=15\n"
    + "DKWB-FREELIST ALLOC_GP_RESULT proc=3 reg=14 line=41 emitted=10 row=1\nDKWB-FREELIST ALLOC_GP_RESULT proc=3 reg=15 line=42 emitted=11 row=2\n");
  const lines = Array(50).fill(""); lines[40] = "limit = 0x40;"; lines[41] = "count = entry->total;";
  lever = L.leverFor(rotationView(), { ring_events: flat, proc: 3, source: lines });
  assert.equal(lever.family.name, "read-the-field-directly");
  assert.ok(lever.reason.includes("line 42 is a field-through-local"));
  assert.ok(!lever.reason.includes("is a constant"));
});

test("construct classification", () => {
  assert.equal(L.classifyConstruct("flare.blue = entry->blue & 0xFFFFU;"), "field-through-local");
  assert.equal(L.classifyConstruct("owner = context->entries[index * 2].owner;"), "scaled-index");
  assert.equal(L.classifyConstruct("angle = state->angle + state->angleStep * ticks;"), "fused-accumulate");
  for (const t of ["table = (s32 **)0x800A0000;", "count = 7;", "i = 0;"]) assert.equal(L.classifyConstruct(t), "constant", t);
  for (const t of ["entry = &D_0_entries;", "if (a == b) {", ""]) assert.equal(L.classifyConstruct(t), "unclassified", t);
  assert.equal(L.classifyConstruct("x = s->base + s->step * n;"), "fused-accumulate");
  assert.equal(L.classifyConstruct("n = *cursor + 1;"), "unclassified");
  assert.equal(L.classifyConstruct("x = a + b * c;"), "fused-accumulate");
});

// ---- line order and as1 ----

const scheduleView = () => viewFor(read("loc-boundary-target.objdump.txt"), read("loc-boundary-candidate.objdump.txt"), { register_profile: "unverified" });

test("an emit trace names the join, the conflicting pair and the alternative", () => {
  const [events] = parseEmitTrace(EMIT_TRACE);
  const lever = L.leverFor(scheduleView(), { emit_events: events });
  assert.equal(lever.lever_class, L.LEVER_LINE_ORDER);
  assert.equal(lever.family.name, "join-the-initialiser-to-the-loop-header");
  assert.equal(lever.measurements.line_order_conflicts, 1);
  assert.ok(joined(lever).includes("line 45"));
  assert.deepEqual(lever.alternatives.map((a) => a.name), [L.LINE_ORDER_FAMILIES[1].name]);
});

test("an emit trace with no conflict is none-known, not a guess", () => {
  const [events] = parseEmitTrace("DKWB-EMIT-V1 proc=0 block=0 emit=5 op=41 line=46 buffer=fwd fn=f_emit_ri_\nDKWB-EMIT-V1 proc=0 block=0 emit=7 op=36 line=46 buffer=fwd fn=f_emit_ra\n");
  const lever = L.leverFor(scheduleView(), { emit_events: events });
  assert.equal(lever.lever_class, L.LEVER_NONE_KNOWN);
  assert.equal(lever.family, null);
  assert.ok(lever.reason.includes("nothing here is separated by a line stamp"));
});

test("as1 readiness: the tally, the unreachable proof, the line lever, and precedence", () => {
  const all = selections();
  const tally = L.readinessKeys(all);
  assert.ok(tally.size);
  assert.equal([...tally.values()].reduce((a, b) => a + b, 0), all.length);
  const readiness = all.filter((s) => s.tie === "start-time");
  assert.ok(readiness.length, "fixture holds a start-time decision");
  let lever = L.leverFor(viewFor(HOME_TARGET, HOME_CANDIDATE), { as1_selections: readiness });
  assert.equal(lever.lever_class, L.LEVER_UNREACHABLE);
  assert.equal(lever.unreachable.name, "as1-readiness");
  assert.ok(lever.unreachable.proof.includes("leftover"));
  assert.ok(lever.unreachable.reopens_when.includes("besttime"));
  lever = L.leverFor(viewFor(FRAME_TARGET, FRAME_CANDIDATE), { as1_selections: readiness });
  assert.equal(lever.lever_class, L.LEVER_UNREACHABLE);
  const byLine = all.filter((s) => s.tie === "lineno");
  if (byLine.length) assert.equal(L.leverFor(viewFor(HOME_TARGET, HOME_CANDIDATE), { as1_selections: byLine }).lever_class, L.LEVER_LINE_ORDER);
});

// ---- catalogue and rendering ----

test("the catalogue: every proof and family is complete", () => {
  assert.deepEqual(new Set(Object.keys(L.UNREACHABLE_PROOFS)), new Set(["as1-readiness", "uopt-address-folding", "uopt-coalescing-tie-break", "cfe-pointer-add-order"]));
  for (const [name, proof] of Object.entries(L.UNREACHABLE_PROOFS)) {
    assert.equal(proof.name, name);
    for (const f of ["proof", "citation", "reopens_when", "precondition"]) assert.ok(proof[f].trim(), `${name}.${f}`);
  }
  for (const f of [...L.STACK_HOME_FAMILIES, ...L.TEMP_RING_FAMILIES, ...L.LINE_ORDER_FAMILIES]) {
    assert.ok(f.citation.includes("2026-09-0"), f.name);
    assert.ok(f.discriminator.trim(), f.name);
  }
});

test("the rendered block and the payload shape", () => {
  let lines = L.formatLever(L.leverFor(viewFor(HOME_TARGET, HOME_CANDIDATE)));
  assert.ok(lines[0].startsWith("lever: stack-home --"));
  assert.ok(lines.some((l) => l.startsWith("  edit (")) && lines.some((l) => l.startsWith("  proved on: ")));
  lines = L.formatLever(L.leverFor(rotationView({})));
  assert.ok(lines.some((l) => l.startsWith("  capture: ")));
  const payload = L.leverFor(viewFor(HOME_TARGET, HOME_CANDIDATE)).asDict();
  assert.deepEqual(new Set(Object.keys(payload)), new Set(["lever_class", "reason", "reachability", "edit_family", "edit", "citation", "evidence", "needs", "measurements", "alternatives", "see_also", "unreachable"]));
  assert.equal(L.LEVER_SCHEMA, "decomp-workbench-lever-v1");
});

test("every class keeps the documented nullability", () => {
  const ring = rotationView();
  const readiness = selections().filter((s) => s.tie === "start-time");
  for (const lever of [L.leverFor(viewFor(HOME_TARGET, HOME_CANDIDATE)), L.leverFor(ring), L.leverFor(ring, { ring_events: parseTrace(RING_TRACE), proc: 3 }), L.leverFor(ring, { as1_selections: readiness })]) {
    const p = lever.asDict();
    assert.ok(L.LEVER_CLASS_VALUES.includes(p.lever_class));
    const named = p.edit_family !== null;
    assert.equal(named, p.edit !== null);
    assert.equal(named, p.citation !== null);
    assert.equal(p.unreachable !== null, p.lever_class === L.LEVER_UNREACHABLE);
    if (p.lever_class === L.LEVER_UNREACHABLE) assert.equal(p.edit_family, null);
    if (p.see_also.length) { assert.equal(p.edit_family, null); assert.equal(p.unreachable, null); }
  }
});

test("only stack-home names a family while needs is non-empty", () => {
  const home = L.leverFor(viewFor(HOME_TARGET, HOME_CANDIDATE));
  assert.ok(home.family !== null && home.needs.length);
  const untraced = L.leverFor(rotationView({}));
  assert.equal(untraced.lever_class, L.LEVER_NONE_KNOWN);
  assert.equal(untraced.family, null);
  assert.ok(untraced.needs.length);
});

// ---- pool lanes, sweeps, forces ----

const P2_LOG = `[CDX] webdetail phase=p2 proc=0 role=target web=6 sym=6 type=3 dtype=6 table=1 chain=1 exprtable=1 exprchain=1 bb=1 line=9 raw10=0x00000000 raw14=0x00000000 raw18=0x00000000 raw20=0x00000000
[CDX] p2dec phase=p2 proc=0 web=6 sym=6 class=1 save=560.500000 nocs=1 totalsave=560.500000 bestcost=0.000000 bestcolor=1 bestreg=v0 forbidden0=0x00000000 forbidden1=0x00000000 regsleft=9 numintf=4 available0=0x7ffc0000 available1=0x00000000 allcallersave=0 taken1=-1 taken2=-1 decision=color forced=-2
[CDX] p2color phase=p2 proc=0 web=6 sym=6 color=1 reg=v0 forced=-2
[CDX] webdetail phase=p2 proc=0 role=target web=9 sym=0 type=4 dtype=6 table=2 chain=1 exprtable=2 exprchain=1 bb=4 line=9 raw10=0x00000000 raw14=0x00000000 raw18=0x00000000 raw20=0x00000000
[CDX] p2dec phase=p2 proc=0 web=9 sym=0 class=1 save=3.700000 nocs=1 totalsave=3.700000 bestcost=0.000000 bestcolor=2 bestreg=v1 forbidden0=0x00000000 forbidden1=0x00000000 regsleft=8 numintf=4 available0=0x7ffc0000 available1=0x00000000 allcallersave=0 taken1=-1 taken2=-1 decision=color forced=-2
[CDX] p2color phase=p2 proc=0 web=9 sym=0 color=2 reg=v1 forced=-2
`;
const P1_TIED_LOG = `[CDX] webdetail phase=p1 proc=1 role=target web=48 sym=0 type=4 dtype=6 table=1 chain=1 exprtable=1 exprchain=1 bb=6 line=81 raw10=0x00000000 raw14=0x00000000 raw18=0x00000000 raw20=0x00000000
[CDX] p1dec phase=p1 proc=1 web=48 sym=0 class=1 save=1.500000 nocs=2 totalsave=3.000000 bestcost=0.000000 bestcolor=1 bestreg=v0 forbidden0=0x00038000 forbidden1=0x00000000 regsleft=9 numintf=4 available0=0x7ffc0000 available1=0x00000000 allcallersave=0 taken1=-1 taken2=-1 decision=color forced=-2
[CDX] p1color phase=p1 proc=1 web=48 sym=0 color=1 reg=v0 forced=-2
[CDX] webdetail phase=p1 proc=1 role=target web=50 sym=71 type=3 dtype=6 table=2 chain=1 exprtable=2 exprchain=1 bb=6 line=81 raw10=0x00000000 raw14=0x00000000 raw18=0x00000000 raw20=0x00000000
[CDX] p1dec phase=p1 proc=1 web=50 sym=71 class=1 save=1.500000 nocs=2 totalsave=3.000000 bestcost=0.000000 bestcolor=2 bestreg=v1 forbidden0=0x00038000 forbidden1=0x00000000 regsleft=8 numintf=4 available0=0x7ffc0000 available1=0x00000000 allcallersave=0 taken1=-1 taken2=-1 decision=color forced=-2
[CDX] p1color phase=p1 proc=1 web=50 sym=71 color=2 reg=v1 forced=-2
[CDX] webdetail phase=p1 proc=1 role=target web=146 sym=12 type=3 dtype=6 table=3 chain=1 exprtable=3 exprchain=1 bb=1 line=81 raw10=0x00000000 raw14=0x00000000 raw18=0x00000000 raw20=0x00000000
[CDX] p1dec phase=p1 proc=1 web=146 sym=12 class=1 save=7.000000 nocs=2 totalsave=14.000000 bestcost=0.000000 bestcolor=14 bestreg=s0 forbidden0=0x00000000 forbidden1=0x00000000 regsleft=9 numintf=9 available0=0x7ffc0000 available1=0x00000000 allcallersave=0 taken1=-1 taken2=-1 decision=color forced=-2
[CDX] p1color phase=p1 proc=1 web=146 sym=12 color=14 reg=s0 forced=-2
`;
const P1_UNTIED_LOG = P1_TIED_LOG.replace("web=50 sym=71 class=1 save=1.500000", "web=50 sym=71 class=1 save=4.000000");
const FORCE_PROVEN = { schema: "decomp-workbench-oracle-sweep-v1", baseline: { force: null, comparison: { words: 8, candidate_instructions: 96 } },
  results: [{ force: "p1:w13=c2", comparison: { words: 5, candidate_instructions: 96 } }, { force: "p1:w13=c2,p1:w48=c3,p1:w50=c2", comparison: { words: 0, candidate_instructions: 96 } }] };
const FORCE_REFUSED = { schema: "decomp-workbench-oracle-sweep-v1", baseline: { force: null, comparison: { words: 8, candidate_instructions: 96 } },
  results: [{ force: "p1:w13=c2", comparison: null }, { force: "p1:w22=c2", comparison: { words: 6, candidate_instructions: 98 } }] };

function colourView({ target_pool, candidate_pool, webs = [["v1", "v0"], ["v0", "v1"]] }) {
  const view = viewFor(HOME_TARGET, HOME_TARGET);
  const made = webs.map(([target, candidate], index) => new Web({ web: `w${index}`, target, candidate, count: 3, rows: [index] }));
  const pool = replace(view.lanes.find((l) => l.classification === "pool"), { target: target_pool, candidate: candidate_pool });
  return replace(view, { webs: made, verdict: "register-permutation", lanes: view.lanes.map((l) => (l.classification === "pool" ? pool : l)) });
}
const rotation = () => colourView({ target_pool: ["v1", "v0"], candidate_pool: ["v0", "v1"] });
const cdx = (text) => new CdxLog(text, { name: "capture.log" });

test("pool lane gate: unequal lanes are a population difference", () => {
  let lever = L.leverFor(colourView({ target_pool: ["v0", "v1", "a0"], candidate_pool: ["v0", "v1"] }));
  assert.equal(lever.lever_class, L.LEVER_POOL_POPULATION);
  assert.equal(lever.family, null);
  assert.equal(lever.measurements.pool_lane_length_delta, -1);
  assert.ok(lever.reason.includes("not a rotation"));
  assert.ok(joined(lever).includes("overlay43FilterImage"));
  lever = L.leverFor(colourView({ target_pool: ["v0", "v1"], candidate_pool: ["v0", "v1", "a0"] }));
  assert.ok(lever.reason.includes("the candidate has 1 additional emitted") && lever.reason.includes("not a count of distinct colored webs"));
  lever = L.leverFor(rotation());
  assert.equal(lever.lever_class, L.LEVER_POOL_ROTATION);
  assert.equal(lever.family, null);
  assert.ok(lever.needs.some((n) => n.includes("CDX_LOG=1")));
  lever = L.leverFor(colourView({ target_pool: ["v0", "v1"], candidate_pool: ["v0", "v1"] }));
  assert.ok(![L.LEVER_POOL_ROTATION, L.LEVER_POOL_POPULATION].includes(lever.lever_class));
});

test("the owning sweep: p2 order, inert save, and the direction reading", () => {
  const lever = L.leverFor(rotation(), { cdx_log: cdx(P2_LOG), proc: 0 });
  assert.equal(lever.lever_class, L.LEVER_POOL_ROTATION);
  assert.equal(lever.measurements.owning_sweep, "p2");
  assert.ok(joined(lever).includes("ascending web number") && joined(lever).includes("bestcost=0.000000"));
  assert.equal(lever.measurements.move_earlier, 9);
  assert.equal(lever.measurements.move_later, 6);
  assert.ok(joined(lever).includes("web 9 would have to be visited first") && joined(lever).includes("no recorded edit has yet reordered a pair"));
  assert.equal(lever.family.name, "store-site-truncation");
  const other = L.leverFor(rotation(), { cdx_log: cdx(P2_LOG.replace("web=9 sym=0 type=4", "web=9 sym=0 type=3")), proc: 0 });
  assert.equal(other.family, null);
  assert.ok(joined(other).includes("type=4 expression web"));
});

test("p1: no direction, the tie group, and the untied cost route", () => {
  let lever = L.leverFor(rotation(), { cdx_log: cdx(P1_TIED_LOG), proc: 1 });
  assert.equal(lever.measurements.owning_sweep, "p1");
  assert.equal(lever.measurements.move_earlier, null);
  assert.equal(lever.measurements.move_later, null);
  assert.ok(joined(lever).includes("recorded for p2 and not for p1"));
  assert.ok(joined(lever).includes("not by itself a lever") && joined(lever).includes("webs 13 and 22"));
  assert.deepEqual(lever.measurements.tie_group, { save: 1.5, webs: [48, 50] });
  lever = L.leverFor(rotation(), { cdx_log: cdx(P1_UNTIED_LOG), proc: 1 });
  assert.equal(lever.family.name, "change-the-save-cost");
  assert.ok(joined(lever).includes("not tied on save (1.5 against 4.0)"));
  for (const [text, proc] of [[P2_LOG, 0], [P1_TIED_LOG, 1], [P1_UNTIED_LOG, 1]]) {
    const l = L.leverFor(rotation(), { cdx_log: cdx(text), proc });
    if (l.family !== null) assert.ok(l.needs.some((n) => n.includes("CONFIRMING second capture")));
  }
});

test("a web held by two decisions names no direction", () => {
  const doubled = P2_LOG + P2_LOG.split("[CDX] webdetail phase=p2 proc=0 role=target web=9")[0].replaceAll("web=6", "web=13");
  const lever = L.leverFor(rotation(), { cdx_log: cdx(doubled), proc: 0 });
  assert.equal(lever.measurements.move_earlier, null);
  assert.ok(lever.reason.includes("more than one coloured web"));
  assert.ok(lever.needs.some((n) => n.includes("CDX_DETAIL_WEB")));
});

test("force reachability: proven, unreachable, measurement, absent", () => {
  let lever = L.leverFor(rotation(), { cdx_log: cdx(P2_LOG), force_result: FORCE_PROVEN, proc: 0 });
  assert.equal(lever.reachability, "proven");
  assert.ok(joined(lever).includes("words=0"));
  assert.ok(L.formatLever(lever).some((l) => l.startsWith("  reachability: proven")));
  lever = L.leverFor(rotation(), { cdx_log: cdx(P2_LOG), force_result: FORCE_REFUSED, proc: 0 });
  assert.equal(lever.reachability, "unreachable");
  const [verdict, notes] = L.forceReachability({ schema: "decomp-workbench-oracle-sweep-v1", baseline: { comparison: { words: 8, candidate_instructions: 96 } },
    results: [{ force: "p1:w13=c2", comparison: { words: 5, candidate_instructions: 96 } }] });
  assert.equal(verdict, null);
  assert.ok(notes.join(" ").includes("measurement, not a proof"));
  lever = L.leverFor(rotation(), { cdx_log: cdx(P2_LOG), proc: 0 });
  assert.equal(lever.reachability, null);
  assert.ok(lever.needs.some((n) => n.includes("CDX_FORCE")));
});

test("sweep records: tie groups are p1 only and keyed by save", () => {
  const groups = new Map(L.tieGroups(L.sweepRecords(cdx(P1_TIED_LOG), { proc: 1 })));
  assert.deepEqual(groups.get(1.5), [48, 50]);
  assert.deepEqual(groups.get(7.0), [146]);
  const p2 = L.sweepRecords(cdx(P2_LOG), { proc: 0 });
  assert.deepEqual(L.tieGroups(p2), []);
  assert.deepEqual(p2.map((r) => r.phase), ["p2", "p2"]);
});

test("a proof whose precondition is met is the verdict", () => {
  const colour = (n) => {
    const view = viewFor(HOME_TARGET, HOME_TARGET);
    return replace(view, { webs: Array.from({ length: n }, (_, i) => new Web({ web: `w${i}`, target: "v0", candidate: "a0", count: 7, rows: [i] })), verdict: "register-permutation" });
  };
  let lever = L.leverFor(colour(1));
  assert.equal(lever.lever_class, L.LEVER_UNREACHABLE);
  assert.equal(lever.unreachable.name, "uopt-coalescing-tie-break");
  assert.deepEqual(lever.needs, []);
  assert.deepEqual(lever.see_also.map((p) => p.name), ["uopt-address-folding"]);
  lever = L.leverFor(colour(3));
  assert.equal(lever.lever_class, L.LEVER_NONE_KNOWN);
  assert.ok(lever.needs.length);
  assert.ok(L.formatLever(lever).some((l) => l.startsWith("    applies when: ")));
  const one = colour(1);
  lever = L.leverFor(replace(one, { webs: [replace(one.webs[0], { target: "s0", candidate: "s1" })] }));
  assert.equal(lever.lever_class, L.LEVER_NONE_KNOWN);
  assert.ok(lever.see_also.map((p) => p.name).includes("uopt-coalescing-tie-break"));
});

// ---- the block in the diagnose document ----

async function run(files, extra, dir) {
  const args = parseArgs(DIAGNOSE_SPEC, [...files, "--function", "demo", "--json", ...extra]);
  const out = [], err = [];
  const io = { print: (s = "") => out.push(`${s}\n`), eprint: (s = "") => err.push(`${s}\n`) };
  const status = await diagnoseDumpsCommand(args, io, { cwd: dir, env: process.env, resolve: (p) => path.resolve(dir, p) });
  return [status, out.join(""), err.join("")];
}
function pair(t, c) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "romdev-levers-"));
  fs.writeFileSync(path.join(d, "target.objdump"), t);
  fs.writeFileSync(path.join(d, "candidate.objdump"), c);
  return [d, [path.join(d, "target.objdump"), path.join(d, "candidate.objdump")]];
}

test("the document namespaces the block; an exact comparison gets none", async () => {
  let [d, files] = pair(HOME_TARGET, HOME_CANDIDATE);
  let [, stdout] = await run(files, [], d);
  let payload = JSON.parse(stdout);
  assert.equal(payload.schema, "decomp-workbench-diagnosis-v3");
  assert.equal(payload.lever_schema, L.LEVER_SCHEMA);
  assert.equal(payload.lever.lever_class, L.LEVER_STACK_HOME);
  [, stdout] = await run([files[0], files[0]], [], d);
  payload = JSON.parse(stdout);
  assert.ok(!("lever" in payload) && !("lever_schema" in payload));
  const [status, , stderr] = await run(files, ["--emit-trace", path.join(d, "missing.log")], d);
  assert.equal(status, 2);
  assert.ok(stderr.startsWith("error: "));
});

test("a ring trace reaches the document", async () => {
  const [d] = pair(read("phase-shift-target.objdump.txt"), read("phase-shift-candidate.objdump.txt"));
  fs.writeFileSync(path.join(d, "ring.log"), RING_TRACE);
  const args = parseArgs(DIAGNOSE_SPEC, [path.join(d, "target.objdump"), path.join(d, "candidate.objdump"), "--function", "animStep",
    "--ring-trace", path.join(d, "ring.log"), "--lever-proc", "3", "--json"]);
  const out = [];
  await diagnoseDumpsCommand(args, { print: (s) => out.push(s), eprint: () => {} }, { cwd: d, env: process.env, resolve: (p) => path.resolve(d, p) });
  const lever = JSON.parse(out.join("")).lever;
  assert.deepEqual(lever.measurements.observed_gp_results, [14, 15, 24, 25]);
  assert.equal(lever.edit_family, null);
  assert.ok(lever.needs.some((n) => n.includes("reservation")));
});

const ROTATION_TARGET = `
00000000 <demo>:
   0: 27bdffe8  addiu $sp,$sp,-24
   4: afbf0014  sw $ra,20($sp)
   8: 00808025  move $s0,$a0
   c: 8e020000  lw $v0,0($s0)
  10: 8e030004  lw $v1,4($s0)
  14: 00431021  addu $v0,$v0,$v1
  18: 03e00008  jr $ra
  1c: 27bd0018  addiu $sp,$sp,24
`;
const ROTATION_CANDIDATE = `
00000000 <demo>:
   0: 27bdffe8  addiu $sp,$sp,-24
   4: afbf0014  sw $ra,20($sp)
   8: 00808025  move $s0,$a0
   c: 8e030000  lw $v1,0($s0)
  10: 8e020004  lw $v0,4($s0)
  14: 00621821  addu $v1,$v1,$v0
  18: 03e00008  jr $ra
  1c: 27bd0018  addiu $sp,$sp,24
`;

test("a rotation from two real disassemblies, then with the capture and the force", async () => {
  const [d, files] = pair(ROTATION_TARGET, ROTATION_CANDIDATE);
  let [status, stdout] = await run(files, [], d);
  assert.equal(status, 0);
  let lever = JSON.parse(stdout).lever;
  assert.equal(lever.lever_class, L.LEVER_POOL_ROTATION);
  assert.equal(lever.reachability, null);
  assert.ok(lever.needs.some((n) => n.includes("CDX_LOG=1")));
  fs.writeFileSync(path.join(d, "cdx.log"), P2_LOG);
  fs.writeFileSync(path.join(d, "force.json"), JSON.stringify(FORCE_PROVEN));
  [status, stdout] = await run(files, ["--ladder", path.join(d, "cdx.log"), "--force-result", path.join(d, "force.json"), "--lever-proc", "0"], d);
  assert.equal(status, 0);
  lever = JSON.parse(stdout).lever;
  assert.equal(lever.lever_class, L.LEVER_POOL_ROTATION);
  assert.equal(lever.reachability, "proven");
  assert.equal(lever.measurements.owning_sweep, "p2");
  assert.equal(lever.measurements.move_earlier, 9);
});
