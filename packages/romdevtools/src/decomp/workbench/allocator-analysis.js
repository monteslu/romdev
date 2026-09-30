// allocator-analysis.js - semantic allocator-web fingerprints, interference
// joins, controlled-edit origin probes and stack homes. Numeric web IDs are
// trace-local handles; identity comes from the web's compiler-visible
// provenance, and collisions are reported rather than guessed away.
//
// Plain JS ESM + JSDoc.

import { createHash } from "node:crypto";
import { sorted, strip, pyEq } from "./py.js";
import { optionalInteger, registerForColor } from "./globalcolor.js";

export const FINGERPRINT_SCHEMA = "decomp-workbench-allocator-webs-v2";
export const DIFF_SCHEMA = "decomp-workbench-allocator-web-diff-v2";
export const STACK_SCHEMA = "decomp-workbench-stack-homes-v1";
export const ORIGIN_PROBE_SCHEMA = "decomp-workbench-origin-probe-v1";

export const PROVENANCE_FIELDS = Object.freeze(["dtype", "type", "raw10", "raw14", "table", "chain", "exprtable", "exprchain", "bb", "defbb", "usebbs",
  "ancestry", "owner_sym", "owner_type", "owner_dtype", "primary_ichain_table", "primary_ichain_chain", "expr_table", "expr_chain", "ir_bb",
  "source_span", "merge_lineage", "merge_lineage_scope", "semantic_reason"]);
/** raw14 is retained as evidence but is not identity (it moves between runs). */
export const FINGERPRINT_FIELDS = Object.freeze([...PROVENANCE_FIELDS.filter((f) => f !== "raw14"), "source_semantic"]);
export const FINGERPRINT_EXCLUDED_OBSERVATIONS = Object.freeze(["raw14"]);
export const SOURCE_FIELDS = Object.freeze(["file", "line", "source", "expr", "listing"]);
export const SOURCE_SEMANTIC_FIELD = "source_semantic";
export const TOPOLOGY_FIELDS = Object.freeze(["dtype", "type", "chain", "exprchain", "bb", "defbb", "usebbs", "ancestry", "owner_type", "owner_dtype",
  "primary_ichain_chain", "expr_chain", "ir_bb", "merge_lineage_scope"]);
export const FORMATION_FIELDS = Object.freeze(["dtype", "type", "table", "chain", "exprtable", "exprchain", "bb"]);
export const ECONOMIC_DECISION_FIELDS = Object.freeze(["class", "save", "nocs", "totalsave", "numintf", "decision"]);
const MISSING_SOURCE_SEMANTICS = new Set(["", "-", "n/a", "na", "none", "null", "unknown", "unavailable", "unattributed", "unset", "missing",
  "not-available", "not_available", "not-applicable", "not_applicable", "no-metadata", "no_metadata", "no-source-metadata", "no_source_metadata"]);

const get = (o, k, d = null) => (o && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : d);
const present = (o, k) => { const v = get(o, k); return v !== null && v !== ""; };

/** `json.dumps(value, sort_keys=True, separators=(",", ":"))`. */
export function compactJson(value) {
  const sortKeys = (v) => {
    if (Array.isArray(v)) return v.map(sortKeys);
    if (v && typeof v === "object") return Object.fromEntries(sorted(Object.keys(v)).map((k) => [k, sortKeys(v[k])]));
    return v;
  };
  return JSON.stringify(sortKeys(value)).replace(/[\u007f-\uffff]/g, (c) => (c === "\u007f" ? c : `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`));
}

const hash20 = (value) => createHash("sha256").update(Buffer.from(compactJson(value), "utf8")).digest("hex").slice(0, 20);

/** One allocator web identified by semantic provenance, not its bit number. */
export class SemanticWeb {
  constructor({ fingerprint, confidence, decision, provenance, source, source_attribution, formation, neighbors, identity = {} }) {
    Object.assign(this, { fingerprint, confidence, decision, provenance, source, source_attribution, formation, neighbors, identity });
    Object.freeze(this);
  }
  asDict() {
    const d = this.decision;
    const economics = {};
    for (const key of ["save", "nocs", "totalsave"]) if (get(d.fields, key) !== null) economics[key] = d.fields[key];
    return {
      fingerprint: this.fingerprint, confidence: this.confidence, phase: d.phase_tag, proc: d.proc, numeric_web: d.web, force_key: d.force_key,
      decision_trace_ordinal: d.decision_trace_ordinal, economics, provenance: this.provenance, source: this.source,
      source_attribution: this.source_attribution, formation: this.formation, neighbors: [...this.neighbors],
      assigned_color: d.assigned_color, assigned_register: d.assigned_register, natural_color: d.natural_color,
      natural_register: registerForColor(d.natural_color), forbidden_colors: d.forbidden_colors,
      forbidden_registers: d.forbidden_colors.map((c) => ({ color: c, register: registerForColor(c) })),
      mincost_tie_colors: d.mincost_tie_colors,
      mincost_tie_registers: d.mincost_tie_colors.map((c) => ({ color: c, register: registerForColor(c) })),
    };
  }
}

/** Classify whether a trace names a source-level semantic handle. */
export function sourceAttribution(detail) {
  const semantic = strip(String(get(detail, SOURCE_SEMANTIC_FIELD, "")));
  if (!MISSING_SOURCE_SEMANTICS.has(semantic.toLowerCase())) return { classification: "source-attributed", source_semantic: semantic };
  return { classification: "run-local-unattributed",
    next_gate: "Record a direct source_semantic for this web; line, owner, and lineage fields are run-local evidence, not source attribution." };
}

function neighborMap(trace) {
  const result = new Map();
  const decisionPhases = new Map();
  for (const item of trace.decisions) {
    if (item.phase !== "p1dec" && item.phase !== "p2dec") continue;
    const proc = optionalInteger(get(item.fields, "proc")), web = optionalInteger(get(item.fields, "web"));
    if (proc !== null && web !== null) {
      const k = `${proc},${web}`;
      if (!decisionPhases.has(k)) decisionPhases.set(k, new Set());
      decisionPhases.get(k).add(get(item.fields, "phase") || item.phase.slice(0, 2));
    }
  }
  const add = (k, v) => { if (!result.has(k)) result.set(k, new Set()); result.get(k).add(v); };
  for (const item of trace.decisions) {
    const proc = optionalInteger(get(item.fields, "proc")), web = optionalInteger(get(item.fields, "web"));
    if (proc === null || web === null) continue;
    let phase = get(item.fields, "phase") || item.phase.slice(0, 2);
    if (phase !== "p1" && phase !== "p2") {
      const phases = decisionPhases.get(`${proc},${web}`) ?? new Set();
      if (phases.size !== 1) continue;
      phase = [...phases][0];
    }
    const key = `${proc},${phase},${web}`;
    for (const k of ["neighbor", "other"]) { const n = optionalInteger(get(item.fields, k)); if (n !== null) add(key, n); }
    if (item.phase === "forbidproducer") { const p = optionalInteger(get(item.fields, "producer_web")); if (p !== null) add(key, p); }
    for (const value of String(get(item.fields, "neighbors", "")).split(",")) { const n = optionalInteger(value); if (n !== null) add(key, n); }
  }
  return result;
}

/** Join opt-in formation events to the ICHAIN identity webdetail uses. */
function formationMap(trace) {
  const grouped = new Map();
  const rangeEvents = new Map();
  for (const item of trace.lineageFor()) {
    const f = item.fields;
    const proc = optionalInteger(get(f, "proc")), table = optionalInteger(get(f, "table")), chain = optionalInteger(get(f, "chain"));
    const event = optionalInteger(get(f, "event"));
    if (proc === null || table === null || chain === null) continue;
    const key = `${proc},${table},${chain}`;
    const sym = optionalInteger(get(f, "sym"));
    if (!grouped.has(key)) {
      grouped.set(key, { proc, record: { status: "captured", procedure_ordinal_basis: "makelivranges-invocation", table, chain, sym,
        range_event: null, first_member_event: null, first_member_bb: null, member_bbs: [], member_count: 0 } });
    }
    const record = grouped.get(key).record;
    if (item.phase === "lineage_range") {
      if (event !== null) {
        record.range_event = event;
        if (!rangeEvents.has(proc)) rangeEvents.set(proc, []);
        rangeEvents.get(proc).push(event);
      }
      continue;
    }
    const bb = optionalInteger(get(f, "bb"));
    record.member_count += 1;
    if (bb !== null && !record.member_bbs.includes(bb)) record.member_bbs.push(bb);
    const first = record.first_member_event;
    if (event !== null && (first === null || event < first)) { record.first_member_event = event; record.first_member_bb = bb; }
  }
  const ranks = new Map([...rangeEvents].map(([proc, events]) => [proc, new Map(sorted([...new Set(events)]).map((e, i) => [e, i + 1]))]));
  for (const { proc, record } of grouped.values()) {
    record.formation_rank = ranks.get(proc)?.get(record.range_event) ?? null;
    record.member_bbs = sorted(record.member_bbs);
  }
  const symGroups = new Map();
  for (const { proc, record } of grouped.values()) {
    if (record.sym === null) continue;
    const k = `${proc},${record.sym}`;
    if (!symGroups.has(k)) symGroups.set(k, []);
    symGroups.get(k).push(record);
  }
  const bySym = new Map([...symGroups].filter(([, r]) => r.length === 1).map(([k, r]) => [k, r[0]]));
  return [new Map([...grouped].map(([k, v]) => [k, v.record])), bySym];
}

/** Derive stable handles from the trace's semantic provenance. */
export function semanticWebs(trace, { proc = null } = {}) {
  const neighbors = neighborMap(trace);
  const [formations, formationsBySym] = formationMap(trace);
  const result = [];
  for (const decision of trace.allocatorWebs({ proc })) {
    const detail = decision.detail;
    const provenance = Object.fromEntries(PROVENANCE_FIELDS.filter((k) => present(detail, k)).map((k) => [k, detail[k]]));
    const source = Object.fromEntries(SOURCE_FIELDS.filter((k) => present(detail, k)).map((k) => [k, detail[k]]));
    const attribution = sourceAttribution(detail);
    const table = optionalInteger(get(detail, "table")), chain = optionalInteger(get(detail, "chain"));
    const sym = optionalInteger(get(decision.fields, "sym"));
    let formation = table !== null && chain !== null ? formations.get(`${decision.proc},${table},${chain}`) ?? null : null;
    if (formation === null && sym !== null) formation = formationsBySym.get(`${decision.proc},${sym}`) ?? null;
    if (formation === null) {
      formation = { status: "not-captured", next_gate: "Capture this procedure with CDX_LINEAGE_TABLES=all (or the web's ICHAIN table) to inspect formation order." };
    }
    const identityProvenance = Object.fromEntries(FINGERPRINT_FIELDS.filter((k) => k in provenance).map((k) => [k, provenance[k]]));
    if (attribution.classification === "source-attributed") identityProvenance[SOURCE_SEMANTIC_FIELD] = attribution[SOURCE_SEMANTIC_FIELD];
    const fingerprint = hash20({ phase: decision.phase_tag, provenance: identityProvenance });
    const evidence = Object.keys(identityProvenance).length;
    const confidence = evidence >= 6 ? "high" : evidence >= 3 ? "medium" : "low";
    result.push(new SemanticWeb({ fingerprint, confidence, decision, provenance, source, source_attribution: attribution, formation,
      neighbors: sorted([...(neighbors.get(`${decision.proc},${decision.phase_tag},${decision.web}`) ?? [])]), identity: { ...identityProvenance } }));
  }
  return sorted(result, (w) => [w.decision.proc, w.decision.phase_tag, w.fingerprint, w.decision.web]);
}

export function webReport(trace, { proc = null } = {}) {
  const webs = semanticWebs(trace, { proc });
  const attributed = webs.filter((w) => w.source_attribution.classification === "source-attributed").length;
  const captured = webs.filter((w) => w.formation.status === "captured").length;
  return {
    schema: FINGERPRINT_SCHEMA,
    proof: "Fingerprints align semantic provenance. Numeric web IDs are shown only as trace-local handles and are never treated as stable. "
      + "Opaque raw14 is retained as evidence but excluded from identity.",
    fingerprint_fields: [...FINGERPRINT_FIELDS], fingerprint_excluded_observations: [...FINGERPRINT_EXCLUDED_OBSERVATIONS],
    webs: webs.map((w) => w.asDict()), web_count: webs.length, low_confidence: webs.filter((w) => w.confidence === "low").length,
    source_attributed_webs: attributed, run_local_unattributed_webs: webs.length - attributed, formation_captured_webs: captured,
    formation_order_guidance: captured
      ? "Formation rank is construction chronology, not coloring priority. Economics reports save/nocs/totalsave at the decision, where "
        + "nocs is the pass's compressed occurrence divisor and not an occurrence count. Decision-trace ordinal is the observed p1dec/p2dec order. Compare "
        + "paired traces: these are separate observations, and no one scalar proves the source cause."
      : "Decision-trace ordinal shows observed selection order. Capture CDX_LINEAGE_TABLES separately to make construction chronology visible.",
    next_gate: attributed ? null : "Record a direct source_semantic before using this trace to recommend a source experiment.",
  };
}

function indexUnique(webs) {
  const grouped = new Map();
  for (const w of webs) { if (!grouped.has(w.fingerprint)) grouped.set(w.fingerprint, []); grouped.get(w.fingerprint).push(w); }
  const ambiguous = new Set([...grouped].filter(([, l]) => l.length !== 1).map(([k]) => k));
  return [new Map([...grouped].filter(([, l]) => l.length === 1).map(([k, l]) => [k, l[0]])), ambiguous];
}

function forbiddenCauses(web, allWebs) {
  const byNumber = new Map();
  for (const item of allWebs) if (item.decision.proc === web.decision.proc && item.decision.phase_tag === web.decision.phase_tag) byNumber.set(item.decision.web, item);
  const causes = [];
  for (const n of web.neighbors) {
    const neighbor = byNumber.get(n);
    if (!neighbor || neighbor.decision.assigned_color === null) continue;
    const color = neighbor.decision.assigned_color;
    if (!web.decision.forbidden_colors.includes(color)) continue;
    causes.push({ color, register: neighbor.decision.assigned_register, neighbor_fingerprint: neighbor.fingerprint, trace_local_neighbor: n });
  }
  return causes;
}

const causesForColors = (causes, colors) => causes.filter((c) => colors.has(c.color));

function decisionOutcomeSchedule(webs) {
  return sorted(webs, (w) => [w.decision.proc, w.decision.phase_tag, w.decision.decision_trace_ordinal, w.decision.web]).map((w) => ({
    proc: w.decision.proc, phase: w.decision.phase_tag, ordinal: w.decision.decision_trace_ordinal, decision: get(w.decision.fields, "decision"),
    assigned_color: w.decision.assigned_color, assigned_register: w.decision.assigned_register, natural_color: w.decision.natural_color,
    natural_register: registerForColor(w.decision.natural_color),
  }));
}

function compareDecisionOutcomes(targetWebs, candidateWebs) {
  const target = decisionOutcomeSchedule(targetWebs), candidate = decisionOutcomeSchedule(candidateWebs);
  const comparable = Math.min(target.length, candidate.length);
  const differences = [];
  let prefix = 0;
  for (let i = 0; i < comparable; i++) {
    const before = target[i], after = candidate[i];
    const changed = ["proc", "phase", "ordinal", "decision", "assigned_color", "natural_color"].filter((f) => before[f] !== after[f]);
    if (!changed.length && prefix === i) prefix += 1;
    if (changed.length) differences.push({ index: i, changed, target: before, candidate: after });
  }
  for (let i = comparable; i < Math.max(target.length, candidate.length); i++) {
    differences.push({ index: i, changed: ["presence"], target: i < target.length ? target[i] : null, candidate: i < candidate.length ? candidate[i] : null });
  }
  const incomplete = [...target, ...candidate].filter((i) => i.assigned_color === null || i.natural_color === null).length;
  const status = !target.length && !candidate.length ? "no-evidence" : target.length !== candidate.length ? "count-mismatch"
    : differences.length ? "different" : incomplete ? "incomplete-evidence" : "identical";
  const phaseCounts = (list) => Object.fromEntries(sorted([...new Set(list.map((i) => i.phase))]).map((p) => [p, list.filter((i) => i.phase === p).length]));
  return {
    status, identical: status === "identical", target_count: target.length, candidate_count: candidate.length, common_prefix: prefix,
    target_phase_counts: phaseCounts(target), candidate_phase_counts: phaseCounts(candidate), difference_count: differences.length,
    incomplete_rows: incomplete, differences, target, candidate,
    proof: "Observed decision-order/register endpoint equivalence only. It does not align semantic webs or prove equivalent source cause.",
  };
}

/** Which record supplies which fingerprint input. */
export const FINGERPRINT_FIELD_SOURCES = Object.freeze(Object.fromEntries([
  ...["dtype", "type", "raw10", "table", "chain", "exprtable", "exprchain", "bb"].map((f) => [f, "[CDX] webdetail role=target"]),
  ...["defbb", "usebbs", "ancestry", "owner_sym", "owner_type", "owner_dtype", "primary_ichain_table", "primary_ichain_chain", "expr_table",
    "expr_chain", "ir_bb", "source_span", "merge_lineage", "merge_lineage_scope", "semantic_reason"].map((f) => [f, "[CDX] provenance_web (preselect and postselect)"]),
  ["source_semantic", "a producer-recorded source_semantic= field"],
]));

/** Without this record there is no identity at all. */
export const REQUIRED_RECORDS = Object.freeze(["[CDX] webdetail role=target"]);

function fieldCoverage(targetWebs, candidateWebs) {
  return FINGERPRINT_FIELDS.map((name) => {
    const tv = new Set(targetWebs.filter((w) => name in w.identity).map((w) => w.identity[name]));
    const cv = new Set(candidateWebs.filter((w) => name in w.identity).map((w) => w.identity[name]));
    const tc = targetWebs.filter((w) => name in w.identity).length, cc = candidateWebs.filter((w) => name in w.identity).length;
    const shared = [...tv].filter((v) => cv.has(v));
    const status = !tc && !cc ? "absent-from-both" : !tc || !cc ? "absent-from-one-side" : !shared.length ? "no-shared-value"
      : tv.size !== cv.size || shared.length !== tv.size ? "partly-shared" : "shared";
    return { field: name, record: FINGERPRINT_FIELD_SOURCES[name] ?? "unknown", status, target_webs: tc, candidate_webs: cc,
      shared_values: shared.length, target_only_values: [...tv].filter((v) => !cv.has(v)).length, candidate_only_values: [...cv].filter((v) => !tv.has(v)).length };
  });
}

/** Say which fingerprint inputs failed, and whether the fix is an instrument. */
export function alignmentDiagnosis(targetWebs, candidateWebs) {
  const coverage = fieldCoverage(targetWebs, candidateWebs);
  const of = (s) => coverage.filter((r) => r.status === s).map((r) => r.field);
  const missing = of("absent-from-both"), oneSided = of("absent-from-one-side"), churned = of("no-shared-value");
  const carried = coverage.filter((r) => r.status === "shared" || r.status === "partly-shared").map((r) => r.field);
  const records = [];
  for (const record of sorted([...new Set(Object.values(FINGERPRINT_FIELD_SOURCES))])) {
    const owned = coverage.filter((r) => FINGERPRINT_FIELD_SOURCES[r.field] === record);
    const statuses = new Set(owned.map((r) => r.status));
    const subset = (allowed) => [...statuses].every((s) => allowed.includes(s));
    const status = statuses.size === 1 && statuses.has("absent-from-both") ? "absent-from-both"
      : subset(["absent-from-both", "absent-from-one-side"]) ? "absent-from-one-side"
      : subset(["absent-from-both", "no-shared-value"]) ? "no-shared-value" : "carried";
    records.push({ record, status, fields: owned.map((r) => r.field) });
  }
  const missingRecords = records.filter((r) => r.status === "absent-from-both").map((r) => r.record);
  const requiredMissing = missingRecords.filter((r) => REQUIRED_RECORDS.includes(r));
  let guidance;
  if (!carried.length && !churned.length) {
    guidance = "No fingerprint input reached either side: neither log carries " + (missingRecords.join(", ") || "any identity record")
      + ". Rebuild with CDX_LOG=1 and keep the compiler's stderr; `trace-cascade --grammar` prints the records.";
  } else if (churned.length) {
    guidance = "Present on both sides but sharing no value: " + churned.join(", ") + ". These are renumbered, not missing -- no instrument setting "
      + "recovers them. Reduce the comparison to one controlled edit with `trace-origin-probe`, or record a producer `source_semantic`, "
      + "which is the one identity a renumbering does not move.";
  } else if (requiredMissing.length) {
    guidance = "No record on either side supplies " + requiredMissing.join(", ") + ", so these identity fields never reached the fingerprint: "
      + missing.filter((n) => requiredMissing.includes(FINGERPRINT_FIELD_SOURCES[n])).join(", ")
      + ". Enable it and re-run before reading the presence rows as insertions or removals.";
  } else {
    const optional = missingRecords.filter((r) => !REQUIRED_RECORDS.includes(r));
    guidance = "Every fingerprint input a record supplied is carried by both logs and shares values; alignment failure, if any, is in the "
      + "combination rather than in one field.";
    if (optional.length) guidance += " Neither log carries the optional enrichment " + optional.join(", ") + ", which would add identity a renumbering does not move.";
  }
  return { fields: coverage, records, absent_from_both: missing, absent_from_one_side: oneSided, no_shared_value: churned,
    carried_by_both: carried, missing_records: missingRecords, guidance };
}

/** Align two allocator traces by semantic provenance. */
export function compareSemanticWebs(target, candidate, { proc = null } = {}) {
  const targetWebs = semanticWebs(target, { proc }), candidateWebs = semanticWebs(candidate, { proc });
  const [ti, ta] = indexUnique(targetWebs), [ci, ca] = indexUnique(candidateWebs);
  const ambiguous = sorted([...new Set([...ta, ...ca])]);
  const diagnosis = alignmentDiagnosis(targetWebs, candidateWebs);
  const common = sorted([...ti.keys()].filter((k) => ci.has(k)));
  const all = sorted([...new Set([...ti.keys(), ...ci.keys()])]);
  const denominator = all.length;
  const coverage = denominator ? common.length / denominator : null;
  let status, proof, nextGate;
  if (!targetWebs.length && !candidateWebs.length) {
    status = "no-evidence";
    proof = "Neither trace contains allocator-web evidence for the selected procedure. No alignment or equality claim is possible.";
    nextGate = "Verify the procedure filter and capture globalcolor decision records before comparing allocator webs. " + diagnosis.guidance;
  } else if (denominator && !common.length) {
    status = "no-common-fingerprints";
    proof = "No semantic alignment was established: every unique fingerprint changed presence. Treat this as fingerprint churn across a broad "
      + "source-topology change, not as N proven web insertions/removals. Use trace-origin-probe on one controlled edit or capture producer "
      + "source_semantic/formation lineage before interpreting decisions.";
    nextGate = "Reduce the comparison to one controlled source edit with trace-origin-probe, or add producer-emitted source_semantic; this "
      + "pair cannot support a web-by-web causal claim. " + diagnosis.guidance;
  } else if (ambiguous.length || (coverage !== null && coverage < 1.0)) {
    status = "partial";
    proof = "Semantic fingerprints align only the reported common subset; presence-only rows outside it may be provenance churn. Ambiguous "
      + "fingerprints are withheld rather than guessed.";
    nextGate = "Interpret decision deltas only for common fingerprints; calibrate presence changes with trace-origin-probe before source advice.";
  } else {
    status = "aligned";
    proof = "Semantic alignment, not numeric web-line diff. Ambiguous fingerprints are withheld rather than guessed. Opaque raw14 is "
      + "retained as evidence but excluded from identity.";
    nextGate = null;
  }
  const rows = [];
  for (const fp of all) {
    const expected = ti.get(fp) ?? null, actual = ci.get(fp) ?? null;
    const changed = [];
    if (expected === null || actual === null) changed.push("presence");
    else {
      if (expected.decision.assigned_color !== actual.decision.assigned_color) changed.push("assigned_color");
      if (expected.decision.natural_color !== actual.decision.natural_color) changed.push("natural_color");
      if (!pyEq(expected.decision.forbidden_colors, actual.decision.forbidden_colors)) changed.push("forbidden_colors");
      if (!pyEq(expected.source, actual.source)) changed.push("source_correlation");
    }
    if (!changed.length) continue;
    const tcauses = expected ? forbiddenCauses(expected, targetWebs) : [];
    const ccauses = actual ? forbiddenCauses(actual, candidateWebs) : [];
    const tcolors = new Set(expected ? expected.decision.forbidden_colors : []), ccolors = new Set(actual ? actual.decision.forbidden_colors : []);
    rows.push({ fingerprint: fp, changed, target: expected ? expected.asDict() : null, candidate: actual ? actual.asDict() : null,
      target_forbidden_causes: tcauses, candidate_forbidden_causes: ccauses,
      target_only_forbidden_causes: causesForColors(tcauses, new Set([...tcolors].filter((c) => !ccolors.has(c)))),
      candidate_only_forbidden_causes: causesForColors(ccauses, new Set([...ccolors].filter((c) => !tcolors.has(c)))) });
  }
  return {
    schema: DIFF_SCHEMA, proof, next_gate: nextGate, alignment_status: status, common_fingerprints: common.length, alignment_denominator: denominator,
    alignment_coverage: coverage, alignment_diagnosis: diagnosis, fingerprint_fields: [...FINGERPRINT_FIELDS],
    fingerprint_excluded_observations: [...FINGERPRINT_EXCLUDED_OBSERVATIONS], differences: rows, difference_count: rows.length,
    decision_summary: {
      actual_assignment_changes: rows.filter((r) => r.changed.includes("assigned_color")).length,
      natural_choice_changes: rows.filter((r) => r.changed.includes("natural_color")).length,
      forbidden_mask_changes: rows.filter((r) => r.changed.includes("forbidden_colors")).length,
      candidate_force_overrides: rows.filter((r) => r.candidate !== null && r.candidate.natural_color !== r.candidate.assigned_color)
        .map((r) => ({ fingerprint: r.fingerprint, force_key: r.candidate.force_key, natural_register: r.candidate.natural_register,
          assigned_register: r.candidate.assigned_register })),
    },
    outcome_schedule: compareDecisionOutcomes(targetWebs, candidateWebs),
    ambiguous_fingerprints: ambiguous, target_webs: targetWebs.length, candidate_webs: candidateWebs.length,
  };
}

const pick = (obj, keys) => Object.fromEntries(keys.filter((k) => present(obj, k)).map((k) => [k, obj[k]]));
const topologyKey = (w) => hash20({ phase: w.decision.phase_tag, shape: pick(w.decision.detail, TOPOLOGY_FIELDS) });
const formationKey = (w) => hash20({ phase: w.decision.phase_tag, formation: pick(w.decision.detail, FORMATION_FIELDS), logical_line: get(w.source, "line") });
const economicKey = (w) => hash20({ phase: w.decision.phase_tag, decision: pick(w.decision.fields, ECONOMIC_DECISION_FIELDS) });

function groupBy(webs, keyFn) {
  const grouped = new Map();
  for (const w of webs) { const k = keyFn(w); if (!grouped.has(k)) grouped.set(k, []); grouped.get(k).push(w); }
  return grouped;
}

function economicTransitions(baseline, variant) {
  const rows = [];
  const side = (w) => ({ trace_local_web: w.decision.web, natural_color: w.decision.natural_color, natural_register: registerForColor(w.decision.natural_color),
    assigned_color: w.decision.assigned_color, assigned_register: w.decision.assigned_register });
  for (const key of sorted([...baseline.keys()].filter((k) => variant.has(k)))) {
    const before = baseline.get(key), after = variant.get(key);
    if (before.length !== 1 || after.length !== 1) continue;
    const b = before[0], a = after[0];
    const changed = [];
    if (b.decision.web !== a.decision.web) changed.push("trace_local_web");
    if (b.decision.natural_color !== a.decision.natural_color) changed.push("natural_color");
    if (b.decision.assigned_color !== a.decision.assigned_color) changed.push("assigned_color");
    if (!pyEq(b.decision.forbidden_colors, a.decision.forbidden_colors)) changed.push("forbidden_colors");
    if (changed.length) rows.push({ economics_fingerprint: key, changed, baseline: side(b), variant: side(a) });
  }
  return rows;
}

function multisetDelta(baseline, variant, { label }) {
  const removed = [], added = [], collisions = [];
  for (const key of sorted([...new Set([...baseline.keys(), ...variant.keys()])])) {
    const before = baseline.get(key) ?? [], after = variant.get(key) ?? [];
    if (before.length > 1 || after.length > 1) collisions.push(key);
    const delta = after.length - before.length;
    const row = { [label]: key, baseline_count: before.length, variant_count: after.length };
    if (delta < 0) for (let i = 0; i < -delta; i++) removed.push(row);
    else if (delta > 0) for (let i = 0; i < delta; i++) added.push(row);
  }
  return [removed, added, collisions];
}

/** Classify one controlled source perturbation without inventing identity. */
export function originProbeReport(baseline, variant, { role, proc = null, source_semantic = null, synthetic = false }) {
  const bw = semanticWebs(baseline, { proc }), vw = semanticWebs(variant, { proc });
  const hasEvidence = Boolean(bw.length || vw.length);
  const exact = compareSemanticWebs(baseline, variant, { proc });
  const [fRemoved, fAdded, fCollisions] = multisetDelta(groupBy(bw, formationKey), groupBy(vw, formationKey), { label: "formation_fingerprint" });
  const [tRemoved, tAdded, tCollisions] = multisetDelta(groupBy(bw, topologyKey), groupBy(vw, topologyKey), { label: "topology_fingerprint" });
  const be = groupBy(bw, economicKey), ve = groupBy(vw, economicKey);
  const [eRemoved, eAdded, eCollisions] = multisetDelta(be, ve, { label: "economics_fingerprint" });
  const transitions = economicTransitions(be, ve);
  const allocationTransitions = transitions.filter((r) => r.changed.some((c) => c !== "trace_local_web"));
  const renumberOnly = transitions.length - allocationTransitions.length;
  const presenceRows = exact.differences.filter((r) => r.changed.includes("presence"));
  const commonChangeRows = exact.differences.filter((r) => !r.changed.includes("presence"));
  const colorCascade = commonChangeRows.filter((r) => r.changed.includes("assigned_color")).length;
  const removedCount = fRemoved.length, addedCount = fAdded.length;
  const ambiguous = Boolean(fCollisions.length || exact.ambiguous_fingerprints.length);
  let classification;
  if (!hasEvidence) classification = "no-evidence";
  else if (!exact.difference_count) classification = "no-effect";
  else if (!removedCount && !addedCount) classification = colorCascade ? "allocation-cascade-only" : "provenance-only";
  else if (ambiguous || colorCascade) classification = "ambiguous";
  else if (removedCount === 1 && addedCount === 0) classification = "isolated-removal";
  else if (removedCount === 0 && addedCount === 1) classification = "isolated-insertion";
  else if (removedCount === 1 && addedCount === 1) classification = "isolated-replacement";
  else classification = "ambiguous";
  const attributed = [...bw, ...vw].filter((w) => w.source_attribution.classification === "source-attributed").length;
  const cascadeWarning = colorCascade
    ? "The controlled edit recolored existing webs without changing their formation multiset. Re-compare the compiled object: a forced color is "
      + "diagnostic evidence, not a source solution, and collateral recolors can regress lanes that were already correct."
    : null;
  const nextGate = !hasEvidence ? "Verify the procedure filter and capture globalcolor decision records in both runs before classifying the probe."
    : cascadeWarning ? "Re-compare the compiled object, then inspect every collateral recolor before translating the forced decision into source."
    : attributed === 0 ? "Treat this only as an M0 role anchor; record producer-emitted source_semantic or ICHAIN creation lineage before source advice."
    : "Inspect the producer-attributed exact diff before source advice.";
  return {
    schema: ORIGIN_PROBE_SCHEMA, role, source_semantic_label: source_semantic, evidence_status: hasEvidence ? "ready" : "no-allocator-web-evidence",
    classification, claim_scope: synthetic ? "synthetic-calibration" : "controlled-differential",
    proof: "Exact fingerprints are primary. Run-local formation shapes may calibrate one controlled M0 edit but do not survive arbitrary "
      + "compiler renumbering. Coarse topology exposes collisions and never proves that a web came from the named source role.",
    counts: {
      baseline_webs: bw.length, variant_webs: vw.length, exact_differences: exact.difference_count, exact_presence_differences: presenceRows.length,
      common_web_color_changes: colorCascade, formation_removed: removedCount, formation_added: addedCount, formation_collisions: fCollisions.length,
      topology_removed: tRemoved.length, topology_added: tAdded.length, topology_collisions: tCollisions.length, economics_removed: eRemoved.length,
      economics_added: eAdded.length, economics_collisions: eCollisions.length, unique_economics_transitions: transitions.length,
      allocation_economics_transitions: allocationTransitions.length, economics_renumber_only: renumberOnly, producer_source_attributed_webs: attributed,
    },
    formation_removed: fRemoved, formation_added: fAdded, formation_collision_fingerprints: fCollisions,
    topology_removed: tRemoved, topology_added: tAdded, topology_collision_fingerprints: tCollisions,
    economics_removed: eRemoved, economics_added: eAdded, economics_collision_fingerprints: eCollisions,
    unique_economics_transitions: transitions, allocation_economics_transitions: allocationTransitions,
    cascade_warning: cascadeWarning, exact_diff: exact, next_gate: nextGate,
  };
}

const signed32 = (value) => Number((BigInt(value) & 0x80000000n) ? BigInt(value) - 0x100000000n : BigInt(value));

/** Classify the virtual home only when the trace carries home evidence. */
export function classifyStackHome(web) {
  const detail = web.decision.detail;
  let raw = optionalInteger(get(detail, "virtual_offset"));
  if (raw === null && get(detail, "raw14") === "0x04ae0102") raw = optionalInteger(get(detail, "raw10"));
  if (raw === null) return null;
  const virtualOffset = signed32(BigInt(raw) & 0xFFFFFFFFn);
  const role = get(detail, "role", "");
  const symbol = get(detail, "symbol") || get(detail, "sym");
  let kind;
  if (["outgoing", "arg-home", "argument"].includes(role)) kind = "outgoing-argument-home";
  else if (![null, undefined, "", "0", "-1"].includes(symbol)) kind = "named-source-local";
  else if (["1", "true", "yes"].includes(get(detail, "spill"))) kind = "allocator-spill";
  else kind = "compiler-temporary";
  return { fingerprint: web.fingerprint, confidence: web.confidence, kind, virtual_offset: virtualOffset,
    final_offset: optionalInteger(get(detail, "final_offset")), source: web.source, symbol: symbol ?? null, phase: web.decision.phase_tag,
    trace_local_web: web.decision.web };
}

/** Report stack-home ownership, optionally centered on a final offset. */
export function stackHomeReport(trace, { proc = null, offset = null } = {}) {
  const webs = semanticWebs(trace, { proc });
  const homes = webs.map(classifyStackHome).filter((h) => h !== null);
  const selected = offset !== null ? homes.filter((h) => h.final_offset === offset || h.virtual_offset === offset) : homes;
  const counts = new Map();
  for (const h of homes) counts.set(String(h.kind), (counts.get(String(h.kind)) ?? 0) + 1);
  let captureStatus, nextGate;
  if (!homes.length && webs.length) {
    captureStatus = "no-stack-home-evidence";
    nextGate = `The trace contains ${webs.length} allocator web(s), but none carry producer-emitted virtual_offset/final_offset evidence. The current `
      + "globalcolor profile cannot answer this query; add a calibrated producer hook before recapturing. raw10/raw14 are opaque in this "
      + "profile and are not inferred as frame offsets.";
  } else if (!homes.length) {
    captureStatus = "no-allocator-web-evidence";
    nextGate = "No allocator webs were parsed for this procedure. Check --proc and capture a detailed globalcolor trace before querying stack homes.";
  } else if (offset !== null && !selected.length) {
    captureStatus = "offset-not-found";
    nextGate = `Stack-home evidence exists, but no recorded virtual or final offset equals ${offset}.`;
  } else { captureStatus = "ready"; nextGate = null; }
  return {
    schema: STACK_SCHEMA,
    proof: "Trace-derived virtual-home provenance. final_offset is null unless the producer explicitly recorded final frame layout.",
    homes: selected, allocator_web_count: webs.length, home_count: homes.length, selected_count: selected.length,
    kinds: Object.fromEntries(sorted([...counts.entries()], (e) => e[0])), offset, capture_status: captureStatus, next_gate: nextGate,
  };
}
