// Allocator reports align semantic provenance and explain stack ownership:
// fingerprints, interference joins, the alignment diagnosis, the controlled
// origin probe and stack homes, plus the trace-webs command. Ported from the
// workbench's own allocator-analysis tests (synthetic CDX records).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { compareSemanticWebs, originProbeReport, semanticWebs, stackHomeReport, webReport, FINGERPRINT_FIELD_SOURCES, FINGERPRINT_FIELDS } from "../src/decomp/workbench/allocator-analysis.js";
import { parseGlobalcolorTrace as parse } from "../src/decomp/workbench/globalcolor.js";
import { runCommand } from "../src/decomp/workbench/cli.js";

const TARGET = "[CDX] webdetail proc=2 role=target web=15 sym=0 type=3 dtype=13 table=4 chain=7 exprtable=2 exprchain=1 bb=3 line=5 raw10=0xffffffc0 raw14=0x04ae0102\n"
  + "[CDX] webdetail proc=2 role=target web=16 sym=42 type=3 dtype=13 table=5 chain=8 exprtable=2 exprchain=2 bb=3 line=6 raw10=0xffffffb8 raw14=0x04ae0102\n"
  + "[CDX] webneighbor proc=2 web=15 neighbor=16\n"
  + "[CDX] p2dec phase=p2 proc=2 web=15 bestcolor=1 forbidden0=0x20000000 decision=color\n"
  + "[CDX] p2dec phase=p2 proc=2 web=16 bestcolor=2 forbidden0=0 decision=color\n";
const CANDIDATE = "[CDX] webdetail proc=2 role=target web=25 sym=0 type=3 dtype=13 table=4 chain=7 exprtable=2 exprchain=1 bb=3 line=5 raw10=0xffffffc0 raw14=0x04ae0102\n"
  + "[CDX] webdetail proc=2 role=target web=26 sym=42 type=3 dtype=13 table=5 chain=8 exprtable=2 exprchain=2 bb=3 line=6 raw10=0xffffffb8 raw14=0x04ae0102\n"
  + "[CDX] webneighbor proc=2 web=25 neighbor=26\n"
  + "[CDX] p2dec phase=p2 proc=2 web=25 bestcolor=2 forbidden0=0x20000000 decision=color\n"
  + "[CDX] p2dec phase=p2 proc=2 web=26 bestcolor=2 forbidden0=0 decision=color\n";
const EXTRA = "[CDX] webdetail phase=p2 proc=2 role=target web=27 type=3 dtype=6 table=99 chain=0 bb=4\n[CDX] p2dec phase=p2 proc=2 web=27 bestcolor=3 decision=color\n";

test("web report joins run-local formation order", () => {
  const trace = parse("[CDX] lineage_range proc=2 event=4 table=4 chain=7 type=3 dtype=13 sym=0 exprtable=2 exprchain=1\n"
    + "[CDX] lineage_member proc=2 event=5 table=4 chain=7 type=3 dtype=13 sym=0 bb=8 line=5 flags=0,0,0,0,0,0\n"
    + "[CDX] lineage_member proc=2 event=9 table=4 chain=7 type=3 dtype=13 sym=0 bb=11 line=5 flags=0,0,0,0,0,0\n"
    + "[CDX] lineage_range proc=2 event=12 table=5 chain=8 type=3 dtype=13 sym=42 exprtable=2 exprchain=2\n"
    + "[CDX] lineage_member proc=2 event=13 table=5 chain=8 type=3 dtype=13 sym=42 bb=11 line=6 flags=0,0,0,0,0,0\n" + TARGET);
  const report = webReport(trace, { proc: 2 });
  const byWeb = new Map(report.webs.map((w) => [w.numeric_web, w]));
  assert.equal(report.formation_captured_webs, 2);
  assert.equal(byWeb.get(15).formation.range_event, 4);
  assert.equal(byWeb.get(15).formation.formation_rank, 1);
  assert.equal(byWeb.get(15).formation.first_member_bb, 8);
  assert.deepEqual(byWeb.get(15).formation.member_bbs, [8, 11]);
  assert.equal(byWeb.get(16).formation.formation_rank, 2);
  assert.equal(byWeb.get(15).decision_trace_ordinal, 1);
  assert.equal(byWeb.get(16).decision_trace_ordinal, 2);
  assert.deepEqual(byWeb.get(15).economics, {});
  for (const s of ["construction chronology", "Economics reports", "observed p1dec/p2dec order"]) assert.ok(report.formation_order_guidance.includes(s));
});

test("web report exposes the min-cost tie set, not 'available'", () => {
  const item = webReport(parse("[CDX] p1dec phase=p1 proc=2 web=15 bestcolor=26 bestreg=t3 forbidden0=0xd3 available0=0x1c decision=color\n"), { proc: 2 }).webs[0];
  assert.deepEqual(item.mincost_tie_colors, [27, 28, 29]);
  assert.deepEqual(item.mincost_tie_registers, [{ color: 27, register: "$f14" }, { color: 28, register: "$f16" }, { color: 29, register: "$f18" }]);
});

test("web report requests lineage when formation is absent", () => {
  const report = webReport(parse(TARGET), { proc: 2 });
  assert.equal(report.formation_captured_webs, 0);
  assert.equal(report.webs[0].formation.status, "not-captured");
  assert.ok(report.formation_order_guidance.includes("CDX_LINEAGE_TABLES"));
});

test("numeric renumbering does not change fingerprints", () => {
  const t = semanticWebs(parse(TARGET), { proc: 2 }), c = semanticWebs(parse(CANDIDATE), { proc: 2 });
  assert.deepEqual(t.map((w) => w.fingerprint), c.map((w) => w.fingerprint));
  assert.deepEqual(t.map((w) => w.decision.web).sort((a, b) => a - b), [15, 16]);
  assert.deepEqual(c.map((w) => w.decision.web).sort((a, b) => a - b), [25, 26]);
});

test("an opaque raw14 change does not hide an allocator delta", () => {
  const target = parse("[CDX] webdetail phase=p2 proc=0 role=target web=98 type=4 dtype=0 table=356 chain=0 exprtable=-1 exprchain=-1 bb=-1 raw10=0x01000000 raw14=0x10057298\n"
    + "[CDX] p2dec phase=p2 proc=0 web=98 bestcolor=12 forbidden0=0x7ff3c000 decision=color\n");
  const candidate = parse("[CDX] p2dec phase=p2 proc=0 web=60 bestcolor=12 forbidden0=0x7ff00000 decision=color\n"
    + "[CDX] webdetail phase=p2 proc=0 role=target web=98 type=4 dtype=0 table=356 chain=0 exprtable=-1 exprchain=-1 bb=-1 raw10=0x01000000 raw14=0x10056bf8\n"
    + "[CDX] intf phase=p2 proc=0 web=98 other=60 assigned=12\n"
    + "[CDX] p2dec phase=p2 proc=0 web=98 bestcolor=18 forbidden0=0x7ffbc000 decision=color\n");
  const report = compareSemanticWebs(target, candidate, { proc: 0 });
  const pointer = report.differences.find((r) => r.target && r.target.numeric_web === 98);
  assert.ok(!pointer.changed.includes("presence"));
  assert.deepEqual(pointer.changed, ["assigned_color", "natural_color", "forbidden_colors"]);
  assert.equal(pointer.target.assigned_register, "t5");
  assert.equal(pointer.candidate.assigned_register, "s4");
  assert.equal(pointer.candidate_forbidden_causes[0].trace_local_neighbor, 60);
  assert.deepEqual(pointer.candidate_only_forbidden_causes, [{ color: 12, register: "t5", neighbor_fingerprint: pointer.candidate_forbidden_causes[0].neighbor_fingerprint, trace_local_neighbor: 60 }]);
  assert.ok(report.fingerprint_excluded_observations.includes("raw14"));
});

test("zero alignment coverage is inconclusive, not N presence claims", () => {
  const report = compareSemanticWebs(parse("[CDX] webdetail phase=p2 proc=0 role=target web=1 type=3 dtype=6 table=10 chain=0 bb=1\n[CDX] p2dec phase=p2 proc=0 web=1 bestcolor=12 decision=color\n"),
    parse("[CDX] webdetail phase=p2 proc=0 role=target web=9 type=3 dtype=6 table=99 chain=0 bb=4\n[CDX] p2dec phase=p2 proc=0 web=9 bestcolor=18 decision=color\n"), { proc: 0 });
  assert.equal(report.alignment_status, "no-common-fingerprints");
  assert.equal(report.common_fingerprints, 0);
  assert.equal(report.alignment_coverage, 0.0);
  assert.ok(report.proof.includes("fingerprint churn"));
  assert.ok(report.next_gate.includes("trace-origin-probe"));
});

test("alignment coverage counts unique webs present on only one side", () => {
  const report = compareSemanticWebs(parse(TARGET), parse(CANDIDATE + EXTRA), { proc: 2 });
  assert.equal(report.common_fingerprints, 2);
  assert.equal(report.alignment_denominator, 3);
  assert.ok(Math.abs(report.alignment_coverage - 2 / 3) < 1e-9);
  assert.equal(report.alignment_status, "partial");
});

test("distinct webs can have an identical decision outcome", () => {
  const report = compareSemanticWebs(
    parse("[CDX] webdetail phase=p2 proc=0 role=target web=10 type=3 dtype=6 table=40 chain=0 bb=11\n[CDX] p2dec phase=p2 proc=0 web=10 bestcolor=15 decision=color\n"
      + "[CDX] webdetail phase=p2 proc=0 role=target web=20 type=3 dtype=6 table=44 chain=0 bb=13\n[CDX] p2dec phase=p2 proc=0 web=20 bestcolor=16 decision=color\n"),
    parse("[CDX] webdetail phase=p2 proc=0 role=target web=80 type=4 dtype=6 table=140 chain=0 bb=11\n[CDX] p2dec phase=p2 proc=0 web=80 bestcolor=15 decision=color\n"
      + "[CDX] webdetail phase=p2 proc=0 role=target web=90 type=4 dtype=6 table=144 chain=0 bb=13\n[CDX] p2dec phase=p2 proc=0 web=90 bestcolor=16 decision=color\n"), { proc: 0 });
  assert.equal(report.alignment_status, "no-common-fingerprints");
  const o = report.outcome_schedule;
  assert.equal(o.status, "identical");
  assert.equal(o.common_prefix, 2);
  assert.equal(o.difference_count, 0);
  assert.deepEqual(o.target_phase_counts, { p2: 2 });
  assert.deepEqual(o.candidate_phase_counts, { p2: 2 });
  assert.ok(o.proof.includes("does not align semantic webs"));
});

test("missing colours cannot claim an identical outcome", () => {
  const trace = parse("[CDX] webdetail phase=p2 proc=0 role=target web=10 type=3 dtype=6 table=40 chain=0 bb=11\n[CDX] p2dec phase=p2 proc=0 web=10 decision=color\n");
  const o = compareSemanticWebs(trace, trace, { proc: 0 }).outcome_schedule;
  assert.equal(o.status, "incomplete-evidence");
  assert.equal(o.incomplete_rows, 2);
  assert.equal(o.identical, false);
});

test("decision outcome reports first divergence and count changes", () => {
  const o = compareSemanticWebs(parse(TARGET), parse(CANDIDATE + EXTRA), { proc: 2 }).outcome_schedule;
  assert.equal(o.status, "count-mismatch");
  assert.equal(o.common_prefix, 0);
  assert.equal(o.difference_count, 2);
});

test("ambiguous fingerprints prevent an aligned claim", () => {
  const duplicate = "[CDX] p2dec phase=p2 proc=2 web=99 bestcolor=1 forbidden0=0x20000000 decision=color\n"
    + "[CDX] webdetail proc=2 role=target web=99 sym=0 type=3 dtype=13 table=4 chain=7 exprtable=2 exprchain=1 bb=3 line=5 raw10=0xffffffc0 raw14=0x04ae0102\n";
  const report = compareSemanticWebs(parse(TARGET + duplicate), parse(CANDIDATE), { proc: 2 });
  assert.ok(report.ambiguous_fingerprints.length);
  assert.equal(report.alignment_status, "partial");
  assert.notEqual(report.next_gate, null);
});

test("empty allocator traces report no evidence", () => {
  const empty = parse("");
  const report = compareSemanticWebs(empty, empty, { proc: 2 });
  const probe = originProbeReport(empty, empty, { proc: 2, role: "empty" });
  assert.equal(report.alignment_status, "no-evidence");
  assert.equal(report.alignment_coverage, null);
  assert.equal(probe.classification, "no-evidence");
  assert.equal(probe.evidence_status, "no-allocator-web-evidence");
});

test("the semantic diff attributes a forbidden colour to its neighbour", () => {
  const changed = compareSemanticWebs(parse(TARGET), parse(CANDIDATE), { proc: 2 }).differences.find((d) => d.changed.includes("assigned_color"));
  assert.equal(changed.target_forbidden_causes[0].color, 2);
  assert.equal(changed.target_forbidden_causes[0].register, "v1");
  assert.ok("neighbor_fingerprint" in changed.target_forbidden_causes[0]);
});

test("forbidproducer records are joined as interference causes", () => {
  const trace = parse("[CDX] provenance_web proc=2 phase=p2 web=10 snapshot=preselect owner_sym=10 owner_type=3\n"
    + "[CDX] provenance_web proc=2 phase=p2 web=10 snapshot=postselect owner_sym=10 owner_type=3\n"
    + "[CDX] p2dec proc=2 phase=p2 web=10 bestcolor=2 forbidden0=0 decision=color\n[CDX] p2color proc=2 phase=p2 web=10 color=2 reg=v1\n"
    + "[CDX] provenance_web proc=2 phase=p2 web=20 snapshot=preselect owner_sym=20 owner_type=4\n"
    + "[CDX] provenance_web proc=2 phase=p2 web=20 snapshot=postselect owner_sym=20 owner_type=4\n"
    + "[CDX] p2dec proc=2 phase=p2 web=20 bestcolor=3 forbidden0=0x20000000 decision=color\n[CDX] p2color proc=2 phase=p2 web=20 color=3 reg=a0\n"
    + "[CDX] forbidproducer proc=2 phase=p2 web=20 color=2 producer_web=10 relation=direct-interference\n");
  assert.deepEqual(semanticWebs(trace, { proc: 2 }).find((w) => w.decision.web === 20).neighbors, [10]);
  const causes = compareSemanticWebs(trace, parse(""), { proc: 2 }).differences.find((r) => r.target && r.target.numeric_web === 20).target_forbidden_causes;
  assert.equal(causes[0].register, "v1");
});

test("stack homes name virtual ownership without inventing layout", () => {
  const report = stackHomeReport(parse(TARGET), { proc: 2 });
  assert.equal(report.capture_status, "ready");
  assert.equal(report.next_gate, null);
  const byOffset = new Map(report.homes.map((h) => [h.virtual_offset, h]));
  assert.equal(byOffset.get(-64).kind, "compiler-temporary");
  assert.equal(byOffset.get(-72).kind, "named-source-local");
  assert.equal(byOffset.get(-64).final_offset, null);
  const focused = stackHomeReport(parse(TARGET), { proc: 2, offset: -72 });
  assert.equal(focused.selected_count, 1);
  assert.equal(focused.homes[0].symbol, "42");
});

test("stack homes explain when the profile has only opaque words", () => {
  const report = stackHomeReport(parse("[CDX] webdetail phase=p2 proc=0 role=target web=62 sym=62 type=3 dtype=6 raw10=0xffffffe4 raw14=0x00070102\n"
    + "[CDX] p2dec phase=p2 proc=0 web=62 bestcolor=12 decision=color\n"), { proc: 0 });
  assert.equal(report.allocator_web_count, 1);
  assert.equal(report.home_count, 0);
  assert.equal(report.capture_status, "no-stack-home-evidence");
  assert.ok(report.next_gate.includes("current globalcolor profile cannot answer"));
  assert.ok(report.next_gate.includes("raw10/raw14 are opaque"));
});

test("neighbour identity is phase-qualified", () => {
  const trace = parse("[CDX] webdetail phase=p1 proc=3 role=target web=9 dtype=1 table=1 chain=1 bb=1\n"
    + "[CDX] webdetail phase=p2 proc=3 role=target web=9 dtype=2 table=2 chain=2 bb=2\n"
    + "[CDX] intf phase=p1 proc=3 web=9 other=10\n[CDX] intf phase=p2 proc=3 web=9 other=11\n"
    + "[CDX] p1dec phase=p1 proc=3 web=9 bestcolor=1 decision=color\n[CDX] p2dec phase=p2 proc=3 web=9 bestcolor=2 decision=color\n");
  const byPhase = new Map(semanticWebs(trace, { proc: 3 }).map((w) => [w.decision.phase_tag, w]));
  assert.deepEqual(byPhase.get("p1").neighbors, [10]);
  assert.deepEqual(byPhase.get("p2").neighbors, [11]);
  assert.equal(byPhase.get("p1").decision.dtype, 1);
  assert.equal(byPhase.get("p2").decision.dtype, 2);
});

test("owner, line and lineage do not claim source attribution", () => {
  const trace = parse("[CDX] webdetail proc=3 role=owner web=9 dtype=13 bb=4 line=20 lineage=frontend-a owner=42\n[CDX] p1dec phase=p1 proc=3 web=9 bestcolor=1 decision=color\n");
  const web = semanticWebs(trace, { proc: 3 })[0];
  assert.equal(web.source_attribution.classification, "run-local-unattributed");
  assert.ok(web.source_attribution.next_gate.includes("source_semantic"));
  const report = webReport(trace, { proc: 3 });
  assert.equal(report.run_local_unattributed_webs, 1);
  assert.ok(report.next_gate.includes("source_semantic"));
});

test("an unavailable source_semantic remains run-local", () => {
  const rec = (snap) => `[CDX] provenance_web proc=3 phase=p1 web=9 snapshot=${snap} source_semantic=unavailable `
    + "semantic_reason=no-source-metadata-at-globalcolor owner_sym=17 owner_type=3 owner_dtype=13 primary_ichain_table=4 "
    + "primary_ichain_chain=7 expr_table=2 expr_chain=1 ir_bb=9 source_span=20:24 merge_lineage=42 merge_lineage_scope=local\n";
  const web = semanticWebs(parse(rec("preselect") + rec("postselect") + "[CDX] p1dec phase=p1 proc=3 web=9 bestcolor=1 decision=color\n"), { proc: 3 })[0];
  assert.equal(web.source_attribution.classification, "run-local-unattributed");
  assert.ok(web.source_attribution.next_gate.includes("source_semantic"));
  assert.deepEqual(web.provenance, { owner_sym: "17", owner_type: "3", owner_dtype: "13", primary_ichain_table: "4", primary_ichain_chain: "7",
    expr_table: "2", expr_chain: "1", ir_bb: "9", source_span: "20:24", merge_lineage: "42", merge_lineage_scope: "local",
    semantic_reason: "no-source-metadata-at-globalcolor" });
  assert.ok(!("source_semantic" in web.provenance));
});

const semanticTrace = (web, label) => parse(`[CDX] provenance_web proc=3 phase=p2 web=${web} snapshot=preselect source_semantic=${label} semantic_reason=ir-local\n`
  + `[CDX] provenance_web proc=3 phase=p2 web=${web} snapshot=postselect source_semantic=${label} semantic_reason=ir-local\n`
  + `[CDX] p2dec phase=p2 proc=3 web=${web} bestcolor=1 decision=color\n`);

test("a direct source_semantic unlocks source attribution and participates in identity", () => {
  assert.deepEqual(semanticWebs(semanticTrace(62, "local:pending-flag"), { proc: 3 })[0].source_attribution, { classification: "source-attributed", source_semantic: "local:pending-flag" });
  assert.notEqual(semanticWebs(semanticTrace(62, "local:first"), { proc: 3 })[0].fingerprint, semanticWebs(semanticTrace(99, "local:second"), { proc: 3 })[0].fingerprint);
});

const WEB25 = "[CDX] webdetail proc=2 role=target web=25 sym=0 type=3 dtype=13 table=4 chain=7 exprtable=2 exprchain=1 bb=3 line=5 raw10=0xffffffc0 raw14=0x04ae0102\n";

test("the origin probe classifies one web removal without a source claim", () => {
  const report = originProbeReport(parse(TARGET), parse(WEB25 + "[CDX] p2dec phase=p2 proc=2 web=25 bestcolor=1 forbidden0=0x20000000 decision=color\n"),
    { proc: 2, role: "texture-value", source_semantic: "local:texture-value", synthetic: true });
  assert.equal(report.classification, "isolated-removal");
  assert.equal(report.claim_scope, "synthetic-calibration");
  assert.equal(report.counts.formation_removed, 1);
  assert.equal(report.counts.producer_source_attributed_webs, 0);
  assert.ok(report.proof.includes("do not survive arbitrary"));
});

test("an origin probe with a colour cascade is ambiguous", () => {
  const report = originProbeReport(parse(TARGET), parse(WEB25 + "[CDX] p2dec phase=p2 proc=2 web=25 bestcolor=2 forbidden0=0x20000000 decision=color\n"), { proc: 2, role: "texture-value" });
  assert.equal(report.classification, "ambiguous");
  assert.equal(report.counts.common_web_color_changes, 1);
});

test("the origin probe names a colour-only cascade and requires an object check", () => {
  const detail = "[CDX] webdetail proc=2 role=target web=25 type=3 dtype=13 table=4 chain=7 exprtable=2 exprchain=1 bb=3\n";
  const report = originProbeReport(parse(detail + "[CDX] p2dec phase=p2 proc=2 web=25 bestcolor=1 forbidden0=0x20000000 decision=color\n"),
    parse(detail + "[CDX] p2dec phase=p2 proc=2 web=25 bestcolor=2 forbidden0=0x20000000 decision=color\n"), { proc: 2, role: "forced-color" });
  assert.equal(report.classification, "allocation-cascade-only");
  assert.ok(report.cascade_warning.includes("forced color is diagnostic"));
  assert.ok(report.next_gate.includes("Re-compare the compiled object"));
});

test("origin probe economics survive ICHAIN renumbering", () => {
  const report = originProbeReport(
    parse("[CDX] webdetail proc=2 role=target web=62 type=3 dtype=6 table=688 chain=0 bb=11\n"
      + "[CDX] p2dec phase=p2 proc=2 web=62 class=1 save=100.0 nocs=1 totalsave=100.0 numintf=19 bestcolor=12 forbidden0=0x7ff00000 decision=color\n"),
    parse("[CDX] webdetail proc=2 role=target web=29 type=3 dtype=6 table=901 chain=4 bb=2\n"
      + "[CDX] p2dec phase=p2 proc=2 web=29 class=1 save=100.0 nocs=1 totalsave=100.0 numintf=19 bestcolor=5 forbidden0=0x7a000000 decision=color\n"),
    { proc: 2, role: "induction-owner" });
  assert.equal(report.counts.unique_economics_transitions, 1);
  assert.equal(report.counts.allocation_economics_transitions, 1);
  assert.equal(report.counts.economics_renumber_only, 0);
  const t = report.unique_economics_transitions[0];
  assert.equal(t.baseline.trace_local_web, 62);
  assert.equal(t.variant.trace_local_web, 29);
  assert.equal(t.baseline.natural_register, "t5");
  assert.equal(t.variant.natural_register, "a2");
});

test("the origin probe separates web renumbering from an allocation change", () => {
  const dec = (web) => `[CDX] p2dec phase=p2 proc=2 web=${web} class=1 save=100.0 nocs=1 totalsave=100.0 numintf=19 bestcolor=12 forbidden0=0x7ff00000 decision=color\n`;
  const report = originProbeReport(parse(dec(62)), parse(dec(29)), { proc: 2, role: "renumber" });
  assert.equal(report.counts.unique_economics_transitions, 1);
  assert.equal(report.counts.allocation_economics_transitions, 0);
  assert.equal(report.counts.economics_renumber_only, 1);
  assert.deepEqual(report.allocation_economics_transitions, []);
});

// -- alignment diagnosis --

const CHURNED = "[CDX] webdetail proc=2 role=target web=15 sym=0 type=3 dtype=13 table=904 chain=71 exprtable=22 exprchain=11 bb=33 line=5 raw10=0xfffffec0 raw14=0x04ae0102\n"
  + "[CDX] p2dec phase=p2 proc=2 web=15 bestcolor=1 forbidden0=0x20000000 decision=color\n";
const NO_DETAIL = "[CDX] p2dec phase=p2 proc=2 web=15 bestcolor=1 forbidden0=0x20000000 decision=color\n"
  + "[CDX] p2dec phase=p2 proc=2 web=16 bestcolor=2 forbidden0=0 decision=color\n";
const diagnose = (t, c) => compareSemanticWebs(parse(t), parse(c), { proc: 2 });

test("a log without detail records names the record", () => {
  const report = diagnose(NO_DETAIL, NO_DETAIL), d = report.alignment_diagnosis;
  assert.equal(report.common_fingerprints, 0);
  assert.ok(d.absent_from_both.includes("dtype"));
  assert.ok(d.absent_from_both.includes("raw10"));
  assert.ok(d.missing_records.includes("[CDX] webdetail role=target"));
  assert.ok(d.guidance.includes("webdetail"));
});

test("renumbering is reported as renumbering, not as a missing record", () => {
  const report = diagnose(TARGET, CHURNED), d = report.alignment_diagnosis;
  assert.equal(report.common_fingerprints, 0);
  assert.ok(!d.missing_records.includes("[CDX] webdetail role=target"));
  for (const n of ["table", "chain", "raw10", "bb"]) assert.ok(d.no_shared_value.includes(n), n);
  assert.ok(d.guidance.includes("renumbered, not missing"));
  assert.ok(d.guidance.includes("source_semantic"));
  assert.ok(report.next_gate.includes("renumbered, not missing"));
});

test("a field carried by both is not a failure; one-sided evidence is its own status; aligned pairs pass", () => {
  const d = diagnose(TARGET, CHURNED).alignment_diagnosis;
  assert.ok(d.carried_by_both.includes("dtype"));
  assert.ok(!d.no_shared_value.includes("dtype"));
  assert.ok(diagnose(TARGET, NO_DETAIL).alignment_diagnosis.absent_from_one_side.includes("dtype"));
  const a = diagnose(TARGET, TARGET).alignment_diagnosis;
  assert.deepEqual(a.no_shared_value, []);
  assert.ok(a.guidance.includes("shares values"));
});

test("every fingerprint input has a named producing record", () => {
  assert.deepEqual(new Set(FINGERPRINT_FIELDS), new Set(Object.keys(FINGERPRINT_FIELD_SOURCES)));
});

async function runWebs(target, candidate) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "romdev-wb-webs-"));
  try {
    fs.writeFileSync(path.join(dir, "target.log"), target);
    fs.writeFileSync(path.join(dir, "candidate.log"), candidate);
    return await runCommand(["trace-webs", path.join(dir, "target.log"), "--against", path.join(dir, "candidate.log"), "--proc", "2"]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test("trace-webs: zero common fingerprints name the renumbered fields or the missing record; an aligned pair is not lectured", async () => {
  const churn = (await runWebs(TARGET, CHURNED)).stdout;
  for (const s of ["common=0", "identity present but sharing no value:", "raw10", "renumbered, not missing"]) assert.ok(churn.includes(s), s);
  const missing = (await runWebs(NO_DETAIL, NO_DETAIL)).stdout;
  for (const s of ["common=0", "no record on either side supplies:", "webdetail"]) assert.ok(missing.includes(s), s);
  assert.ok(!(await runWebs(TARGET, TARGET)).stdout.includes("diagnosis:"));
});

test("trace-webs, trace-stack-homes and trace-origin-probe JSON carry their schemas", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "romdev-wb-webs-"));
  try {
    const a = path.join(dir, "a.log"), b = path.join(dir, "b.log");
    fs.writeFileSync(a, TARGET); fs.writeFileSync(b, CANDIDATE);
    const w = await runCommand(["trace", "webs", a, "--json"]);
    assert.equal(w.code, 0);
    assert.equal(JSON.parse(w.stdout).schema, "decomp-workbench-allocator-webs-v2");
    const d = await runCommand(["trace-webs", a, "--against", b, "--json"]);
    assert.equal(JSON.parse(d.stdout).schema, "decomp-workbench-allocator-web-diff-v2");
    const h = await runCommand(["trace", "stack-homes", a, "--offset", "-72", "--json"]);
    assert.equal(h.code, 0);
    assert.equal(JSON.parse(h.stdout).selected_count, 1);
    const o = await runCommand(["trace", "origin-probe", a, b, "--role", "x", "--json"]);
    assert.equal(o.code, 0);
    assert.equal(JSON.parse(o.stdout).schema, "decomp-workbench-origin-probe-v1");
    const noRole = await runCommand(["trace-origin-probe", a, b, "--json"]);
    assert.equal(noRole.code, 2);
    assert.match(JSON.parse(noRole.stdout).error.message, /required: --role/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
