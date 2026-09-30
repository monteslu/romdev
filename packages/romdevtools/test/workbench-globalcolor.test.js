// Ported from the workbench's globalcolor trace-parsing tests, plus CLI
// contract checks for `trace globalcolor`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  ALLOCATOR_COLOR_REGISTERS, COLOR_REGISTERS, FP_LOCAL_RING, colorForRegister, parseGlobalcolorTrace, registerForColor, passEvidence, formatG,
} from "../src/decomp/workbench/globalcolor.js";
import { runCommand } from "../src/decomp/workbench/cli.js";

const TRACE = `CSAVE bitpos=279 kind=1 dtype=13 unk1C=81 adjsave=2.5 unk23=0
  UNIT bb=4 dep=2 ld=1 st=0 reg=0 fstr=0 nrl=0 nrs=0 dout=0
CUP bitpos=279 reg=24 cs=1 cost=100.0
CUP bitpos=279 reg=30 cs=2 cost=20.0
CSAVE bitpos=12 kind=1 dtype=4 unk1C=2 adjsave=1.0 unk23=1
[CDX] p1dec proc=3 web=9 sym=7 class=2 save=3.5 -> COLOR
`;
const webs = (text, opts) => parseGlobalcolorTrace(text).allocatorWebs(opts);

test("parses and ranks live ranges", () => {
  const report = parseGlobalcolorTrace(TRACE);
  assert.equal(report.live_ranges.size, 2);
  const item = report.live_ranges.get(279);
  assert.equal(item.total_save, 202.5);
  assert.equal(item.finite_costs[1].register, 30);
  assert.equal(report.ranked()[0].bitpos, 279);
  assert.equal(report.ranked({ dtype: 4 })[0].bitpos, 12);
});

test("parses cdx decision", () => {
  const report = parseGlobalcolorTrace(TRACE);
  const decision = report.decisions[0];
  assert.equal(decision.phase, "p1dec");
  assert.equal(decision.fields.web, "9");
  assert.deepEqual(report.decisionsFor(3), [decision]);
  assert.deepEqual(report.decisionsFor(4), []);
  assert.deepEqual(report.decisionsFor(), report.decisions);
  assert.deepEqual(report.decisionsFor(3, { web: 9 }), [decision]);
  assert.deepEqual(report.decisionsFor(3, { web: 10 }), []);
  assert.deepEqual(report.unparsed_diagnostic_lines, []);
});

test("filters pre-globalcolor lineage by procedure and table", () => {
  const report = parseGlobalcolorTrace("[CDX] lineage_range proc=0 event=0 table=1004 chain=0 type=4 dtype=6\n"
    + "[CDX] lineage_member proc=0 event=1 table=1004 chain=0 bb=10 line=2 flags=0,0,0,0,0,0\n"
    + "[CDX] lineage_range proc=1 event=0 table=688 chain=0 type=3 dtype=6\n");
  assert.deepEqual(report.lineageFor(0, { tables: new Set([1004]) }).map((i) => i.phase), ["lineage_range", "lineage_member"]);
  assert.deepEqual(report.lineageFor(0, { tables: new Set([688]) }), []);
  assert.equal(report.lineageFor().length, 3);
});

test("accepts nonfinite compiler cost", () => {
  const report = parseGlobalcolorTrace("CSAVE bitpos=1 kind=1 dtype=13 unk1C=1 adjsave=1e+03 unk23=0\nCUP bitpos=1 reg=2 cs=3 cost=inf\n");
  const item = report.live_ranges.get(1);
  assert.equal(item.total_save, 1000);
  assert.deepEqual(item.finite_costs, []);
  assert.deepEqual(report.unparsed_diagnostic_lines, []);
  assert.equal(item.color_costs[0].asDict().cost, "inf");
  assert.doesNotThrow(() => JSON.stringify(report.asDict()));
});

test("excludes ido unavailable cost sentinel", () => {
  const report = parseGlobalcolorTrace("CSAVE bitpos=1 kind=1 dtype=13 unk1C=1 adjsave=1 unk23=0\n"
    + "CUP bitpos=1 reg=12 cs=1 cost=100000002004087734272.000000\nCUP bitpos=1 reg=18 cs=2 cost=5.5\n");
  const item = report.live_ranges.get(1);
  assert.deepEqual(item.finite_costs.map((e) => e.register), [12, 18]);
  assert.deepEqual(item.eligible_costs.map((e) => e.register), [18]);
  assert.equal(item.color_costs[0].asDict().eligible, false);
});

test("joins allocator decision with web detail", () => {
  const report = parseGlobalcolorTrace("[CDX] p1cost proc=2 web=15 color=1 kind=caller cost=22.250000 best_before=100000002004087734272.000000\n"
    + "[CDX] p1cost proc=2 web=15 color=2 kind=caller cost=22.250000 best_before=22.250000\n"
    + "[CDX] p1dec proc=2 web=15 sym=15 class=2 save=13.500000 nocs=4 totalsave=54.000000 bestcost=22.250000 bestcolor=30 "
    + "forbidden0=0x000000a0 forbidden1=0x00000000 regsleft=10 numintf=13 decision=color forced=-2\n"
    + "[CDX] webdetail proc=2 role=target web=15 sym=15 type=3 dtype=13 table=0 chain=0 exprtable=0 exprchain=1 bb=0 line=5 "
    + "raw10=0xffffff9c raw14=0x00240102 raw18=0x04010000 raw20=0x00000000\n");
  const items = report.allocatorWebs({ proc: 2, dtype: 13 });
  assert.equal(items.length, 1);
  assert.deepEqual([items[0].proc, items[0].web], [2, 15]);
  assert.equal(items[0].phase, "p1dec");
  assert.equal(items[0].fields.bestcolor, "30");
  assert.equal(items[0].assigned_register, null);
  assert.match(items[0].explanation, /selected c30/);
  assert.equal(items[0].detail.line, "5");
  assert.deepEqual(items[0].color_costs.map((c) => c.color), ["1", "2"]);
  assert.equal(items[0].color_costs[1].best_before, "22.250000");
  assert.deepEqual(report.allocatorWebs({ dtype: 6 }), []);
});

test("phase-less detail is withheld when web number is ambiguous", () => {
  const items = webs("[CDX] webdetail proc=2 role=target web=15 dtype=13 line=5\n"
    + "[CDX] p1dec phase=p1 proc=2 web=15 bestcolor=1 decision=color\n[CDX] p2dec phase=p2 proc=2 web=15 bestcolor=2 decision=color\n", { proc: 2, web: 15 });
  assert.equal(items.length, 2);
  assert.ok(items.every((i) => Object.keys(i.detail).length === 0));
});

test("provenance snapshots join only when unique and consistent", () => {
  const detail = webs("[CDX] provenance_web proc=2 phase=p2 web=62 snapshot=preselect source_semantic=local:pending-flag semantic_reason=ir-local\n"
    + "[CDX] provenance_web proc=2 phase=p2 web=62 snapshot=postselect source_semantic=local:pending-flag semantic_reason=ir-local\n"
    + "[CDX] p2dec phase=p2 proc=2 web=62 bestcolor=2 decision=color\n", { proc: 2, web: 62 })[0].detail;
  assert.equal(detail.source_semantic, "local:pending-flag");
  assert.equal(detail.semantic_reason, "ir-local");
});

test("ambiguous provenance is withheld", () => {
  const items = webs("[CDX] provenance_web proc=2 phase=p2 web=62 snapshot=preselect source_semantic=local:first\n"
    + "[CDX] provenance_web proc=2 phase=p2 web=62 snapshot=preselect source_semantic=local:first\n"
    + "[CDX] provenance_web proc=2 phase=p2 web=62 snapshot=postselect source_semantic=local:second\n"
    + "[CDX] p2dec phase=p2 proc=2 web=62 bestcolor=2 decision=color\n", { proc: 2, web: 62 });
  assert.deepEqual(items[0].detail, {});
});

test("forced assignment preserves owner and reports actual color", () => {
  const item = webs("[CDX] provenance_web proc=2 phase=p2 web=62 snapshot=preselect selected_color=12 selected_reg=t5 owner_sym=62 owner_type=3\n"
    + "[CDX] p2dec proc=2 phase=p2 web=62 bestcolor=12 bestreg=t5 decision=color forced=18\n"
    + "[CDX] p2color proc=2 phase=p2 web=62 color=18 reg=s4 forced=18\n"
    + "[CDX] provenance_web proc=2 phase=p2 web=62 snapshot=postselect selected_color=18 selected_reg=s4 owner_sym=62 owner_type=3\n", { proc: 2, web: 62 })[0];
  assert.equal(item.natural_color, 12);
  assert.equal(item.assigned_color, 18);
  assert.equal(item.assigned_register, "s4");
  assert.equal(item.detail.owner_sym, "62");
  assert.equal(item.detail.preselect_selected_color, "12");
  assert.equal(item.detail.postselect_selected_color, "18");
  assert.equal(item.asDict().natural_register, "t5");
});

test("a decision names the colors a force cannot take", () => {
  const item = webs("[CDX] p2dec phase=p2 proc=11 web=300 sym=300 class=1 save=1 nocs=2 totalsave=2 bestcost=0 bestcolor=-1 "
    + "forbidden0=0x7f800000 forbidden1=0x00000000 decision=no-color\n", { proc: 11, web: 300 })[0];
  assert.deepEqual(item.forbidden_colors, [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(item.natural_color, null);
  assert.equal(item.assigned_color, null);
  assert.deepEqual(item.asDict().forbidden_colors, [1, 2, 3, 4, 5, 6, 7, 8]);
});

test("a decision without a mask claims nothing", () => {
  assert.deepEqual(webs("[CDX] p1dec proc=46 web=240 bestcolor=17 decision=color\n", { proc: 46 })[0].forbidden_colors, []);
});

test("mincost tie colors decode available, not forbidden", () => {
  const item = webs("[CDX] p1dec phase=p1 proc=0 web=3097 sym=3097 class=1 save=2.0 nocs=2 totalsave=4.0 bestcost=0.0 bestcolor=26 bestreg=t3 "
    + "forbidden0=0xd3 forbidden1=0x00000000 regsleft=7 numintf=10 available0=0x1c available1=0x00000000 decision=color\n", { proc: 0, web: 3097 })[0];
  assert.deepEqual(item.mincost_tie_colors, [27, 28, 29]);
  assert.equal(item.fields.available0, "0x1c");
  assert.deepEqual(item.asDict().mincost_tie_colors, [27, 28, 29]);
});

test("a decision without an available mask claims no tie set", () => {
  assert.deepEqual(webs("[CDX] p1dec proc=46 web=240 bestcolor=17 decision=color\n", { proc: 46 })[0].mincost_tie_colors, []);
});

test("desired register barrier names interfering owner", () => {
  const barrier = webs("[CDX] p2dec phase=p2 proc=0 web=100 bestcolor=18 forbidden0=0x00080000 decision=color\n"
    + "[CDX] intf phase=p2 proc=0 web=100 other=60 assigned=12\n"
    + "[CDX] webdetail phase=p2 proc=0 role=neighbor web=60 dtype=6 type=4 table=1004\n", { proc: 0, web: 100 })[0].colorBarrier(12);
  assert.equal(barrier.status, "desired-forbidden");
  assert.deepEqual(barrier.blocking_neighbors, [{ phase: "p2", web: 60, force_key: "p2:w60", assigned_color: 12, assigned_register: "t5",
    detail: { phase: "p2", proc: "0", role: "neighbor", web: "60", dtype: "6", type: "4", table: "1004" } }]);
  assert.match(String(barrier.advice), /p2:w60/);
});

test("desired register barrier names ineligible sentinel", () => {
  const barrier = webs("[CDX] p2cost phase=p2 proc=3 web=0 color=12 reg=t5 kind=caller cost=100000002004087734272.000000\n"
    + "[CDX] p2cost phase=p2 proc=3 web=0 color=14 reg=s0 kind=callee cost=4.5\n"
    + "[CDX] p2dec phase=p2 proc=3 web=0 bestcolor=14 forbidden0=0x00000000 decision=color\n", { proc: 3, web: 0 })[0].colorBarrier(12);
  assert.equal(barrier.status, "desired-ineligible");
  assert.equal(barrier.desired_ineligible, true);
  assert.equal(barrier.cost_gap, null);
  assert.match(String(barrier.advice), /unavailable-cost sentinel/);
});

test("barrier recognizes an already natural color", () => {
  const item = webs("[CDX] p2cost phase=p2 proc=3 web=0 color=12 reg=t5 kind=caller cost=4.5\n"
    + "[CDX] p2dec phase=p2 proc=3 web=0 bestcolor=12 forbidden0=0x00000000 decision=color\n", { proc: 3, web: 0 })[0];
  const barrier = item.colorBarrier(12);
  assert.equal(barrier.status, "already-natural");
  assert.match(String(barrier.advice), /already/);
  assert.equal(item.asDict().decision_trace_ordinal, 1);
});

test("names stable callee-saved colors and filters webs", () => {
  const text = "[CDX] p1dec proc=46 web=240 sym=240 class=1 save=1 nocs=2 totalsave=2 bestcost=0 bestcolor=17 decision=color\n";
  const item = webs(text, { proc: 46, web: 240 })[0];
  assert.equal(item.assigned_color, 17);
  assert.equal(item.assigned_register, "s3");
  assert.equal(item.explanation, "color: selected c17 (s3)");
  assert.deepEqual(webs(text, { proc: 46, web: 241 }), []);
});

test("decodes caller-saved colors and phase namespace", () => {
  const item = webs("[CDX] p2dec phase=p2 proc=7 web=55 sym=55 class=1 save=1 nocs=2 totalsave=2 bestcost=0 bestcolor=2 bestreg=v1 decision=color\n", { proc: 7, web: 55 })[0];
  assert.equal(item.assigned_color, 2);
  assert.equal(item.assigned_register, "v1");
  assert.equal(item.phase_tag, "p2");
  assert.equal(item.force_key, "p2:w55");
  assert.equal(item.explanation, "color: selected c2 (v1)");
});

test("phase namespace falls back to the record name", () => {
  const item = webs("[CDX] p1dec proc=7 web=9 bestcolor=1 decision=color\n", { proc: 7, web: 9 })[0];
  assert.equal(item.phase_tag, "p1");
  assert.equal(item.force_key, "p1:w9");
  assert.equal(item.assigned_register, "v0");
});

test("unconfirmed colors are not named", () => {
  assert.equal(registerForColor(13), null);
  assert.equal(registerForColor(30), null);
  assert.equal(registerForColor(null), null);
  assert.equal(registerForColor(12), "t5");
  assert.equal(registerForColor(23), "ra");
});

test("the float color map is the corrected one", () => {
  assert.equal(registerForColor(24), "$f0");
  assert.equal(registerForColor(25), "$f2");
  assert.equal(registerForColor(26), "$f12");
  assert.equal(registerForColor(29), "$f18");
  for (const ring of FP_LOCAL_RING) {
    assert.equal(colorForRegister(ring), null);
    assert.ok(![...ALLOCATOR_COLOR_REGISTERS.values()].includes(ring));
  }
  assert.equal(colorForRegister("$f14"), 27);
  assert.equal(colorForRegister("f14"), 27);
});

test("the generated instrument table stays integer-only", () => {
  assert.equal(Math.max(...COLOR_REGISTERS.keys()), 23);
  assert.ok(!COLOR_REGISTERS.has(24));
});

test("ranks nan save last", () => {
  const report = parseGlobalcolorTrace("CSAVE bitpos=1 kind=1 dtype=13 unk1C=1 adjsave=nan unk23=0\nCSAVE bitpos=2 kind=1 dtype=13 unk1C=1 adjsave=2.0 unk23=0\n");
  assert.deepEqual(report.ranked().map((i) => i.bitpos), [2, 1]);
});

test("malformed cdx numbers do not crash focused reports", () => {
  const report = parseGlobalcolorTrace("[CDX] p1dec proc=bad web=9 totalsave=bad decision=color\n");
  assert.deepEqual(report.decisionsFor(3, { web: 9 }), []);
  assert.deepEqual(report.allocatorWebs({ proc: 3 }), []);
});

test("a split with no registers left names lever 28", () => {
  const item = webs("[CDX] p1dec phase=p1 proc=1 web=5 bestcolor=17 regsleft=0 decision=split\n", { proc: 1, web: 5 })[0];
  assert.equal(item.contested_allocation, true);
  assert.equal(item.registers_left, 0);
  assert.match(item.explanation, /taken, not/);
  assert.match(item.explanation, /lever 28/);
});

test("a split with registers left is an ordinary split", () => {
  const item = webs("[CDX] p1dec phase=p1 proc=1 web=5 bestcolor=17 regsleft=3 decision=split\n", { proc: 1, web: 5 })[0];
  assert.equal(item.contested_allocation, false);
  assert.doesNotMatch(item.explanation, /lever 28/);
});

test("an unrecorded budget claims nothing", () => {
  const item = webs("[CDX] p1dec phase=p1 proc=1 web=5 bestcolor=17 decision=split\n", { proc: 1, web: 5 })[0];
  assert.equal(item.registers_left, null);
  assert.equal(item.contested_allocation, false);
});

test("a phase two denial counts as contested", () => {
  assert.equal(webs("[CDX] p2dec phase=p2 proc=1 web=5 bestcolor=17 regsleft=0 decision=no-color\n", { proc: 1, web: 5 })[0].contested_allocation, true);
});

test("a forbidden desired color routes to lever 28", () => {
  const barrier = webs("[CDX] p2dec phase=p2 proc=0 web=100 bestcolor=18 forbidden0=0x00080000 decision=color\n"
    + "[CDX] intf phase=p2 proc=0 web=100 other=60 assigned=12\n", { proc: 0, web: 100 })[0].colorBarrier(12);
  assert.equal(barrier.status, "desired-forbidden");
  assert.match(String(barrier.advice), /lever 28/);
});

// Beyond the original module tests: evidence scoping, number formatting and
// the command contract romdev drives.

test("pass evidence is scoped to proc and web", () => {
  const trace = parseGlobalcolorTrace("[CDX] p1dec phase=p1 proc=1 web=5 bestcolor=17 regsleft=0 decision=split\n"
    + "[CDX] force_declined proc=2 web=7 color=12\n");
  assert.equal(passEvidence(trace).decisive, true);
  assert.equal(passEvidence(trace, { proc: 1 }).contested_allocation, true);
  assert.equal(passEvidence(trace, { proc: 1 }).force_declined, false);
  assert.equal(passEvidence(trace, { proc: 2, web: 7 }).force_declined, true);
  assert.equal(passEvidence(trace, { proc: 3 }).decisive, false);
});

test("general format matches the original's g spec", () => {
  assert.equal(formatG(2.5), "2.5");
  assert.equal(formatG(1e20), "1e+20");
  assert.equal(formatG(0.0001), "0.0001");
  assert.equal(formatG(0.00001), "1e-05");
  assert.equal(formatG(123456789), "1.23457e+08");
  assert.equal(formatG(202.5, 13), "        202.5");
});

test("trace globalcolor command: JSON document, filters and lookup errors", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "romdev-wb-gc-"));
  const file = path.join(dir, "gc.trace");
  await writeFile(file, TRACE + "[CDX] p2dec phase=p2 proc=0 web=100 bestcolor=18 forbidden0=0x00080000 decision=color\n"
    + "[CDX] intf phase=p2 proc=0 web=100 other=60 assigned=12\n");
  const r = await runCommand(["trace", "globalcolor", file, "--json"]);
  assert.equal(r.code, 0);
  const doc = JSON.parse(r.stdout);
  assert.equal(doc.schema, "decomp-workbench-trace-globalcolor-v1");
  assert.equal(doc.legacy_live_range_capture, "present");
  assert.deepEqual(doc.live_ranges.map((i) => i.bitpos), [279, 12]);
  assert.equal(doc.allocator_webs.length, 2);
  const barrier = await runCommand(["trace", "globalcolor", file, "--proc", "0", "--web", "100", "--desired-register", "t5", "--json"]);
  assert.equal(JSON.parse(barrier.stdout).color_barriers[0].status, "desired-forbidden");
  const miss = await runCommand(["trace", "globalcolor", file, "--proc", "0", "--web", "5", "--json"]);
  assert.equal(miss.code, 1);
  assert.equal(JSON.parse(miss.stdout).error, "no allocator decision matched proc=0 web=5; available web(s): 100");
  const usage = await runCommand(["trace", "globalcolor", file, "--web", "5", "--json"]);
  assert.equal(usage.code, 2);
  assert.equal(JSON.parse(usage.stdout).schema, "decomp-workbench-error-v1");
  const text = await runCommand(["trace", "globalcolor", file]);
  assert.equal(text.code, 0);
  assert.match(text.stdout, /^bitpos=  279 dtype=13 weight=   81 adjsave=        2.5 total=        202.5 best=r30:20$/m);
  assert.match(text.stdout, /legacy-live-ranges=2\/2 allocator-webs=2 decisions=3 lineage=0 unparsed=0/);
  const lineage = await runCommand(["trace", "globalcolor", file, "--proc", "0", "--lineage-table", "7"]);
  assert.equal(lineage.code, 1);
  assert.match(lineage.stdout, /lineage_range\/lineage_member are opt-in/);
});
