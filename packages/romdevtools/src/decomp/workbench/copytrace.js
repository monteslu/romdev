// copytrace.js - parse and compare IDO copy/coalescing decision traces
// (COPYDEC records). The producer's rhstable field is a hash-table bucket,
// not an expression identity, so it is kept as an observation while final
// decisions are aligned by the LHS stack home and assignment ordinal.
//
// Plain JS ESM + JSDoc.

import { splitlines, strip, sorted, hex, counter, pyInt } from "./py.js";

export const COPYTRACE_SCHEMA = "decomp-workbench-copy-decisions-v1";
export const COPYDEC_STAGE_ORDER = Object.freeze(["pre-makelivranges", "post-makelivranges", "pre-localcolor", "post-localcolor", "post-globalcolor", "pre-reemit"]);
export const COPYDEC_RE = new RegExp(
  "^CDXW\\s+\\d+\\s+p(?<proc>-?\\d+)\\s+d\\d+\\s+COPYDEC\\s+"
  + "tag=(?<tag>\\S+)\\s+stmt=(?<stmt>-?\\d+)\\s+"
  + "lhs=(?<lhs>-?\\d+)\\s+rhs=(?<rhs>-?\\d+)\\s+"
  + "rhsop=(?<rhsop>[0-9a-fA-F]+)\\s+"
  + "rhstable=(?<bucket>\\d+)\\s+rhschain=(?<chain>\\d+)\\s+"
  + "occ=(?<formed_occurrences>\\d+)/(?<bucket_occupancy>\\d+)\\s+"
  + "rhsformed=(?<rhsformed>-?\\d+)\\s+bbwit=(?<bbwit>-?\\d+)\\s+"
  + "lhscolor=(?<lhscolor>-?\\d+)\\s+rhscolor=(?<rhscolor>-?\\d+)\\s+"
  + "lhsframe=(?<lhsframe>[0-9a-fA-F]+)\\s+->\\s+"
  + "(?<decision>COALESCE|TEMPCOPY)$");

function signedU32(value) { const v = parseInt(value, 16); return v >= 0x80000000 ? v - 0x100000000 : v; }

/** `{value:+#x}` */
const signedHex = (v) => (v < 0 ? "-" : "+") + "0x" + Math.abs(v).toString(16);

/** One trace-local assignment decision at an optimizer census point. */
export class CopyDecision {
  constructor(f) {
    const { proc, tag, stmt, lhs, rhs, rhs_opcode, rhs_hash_bucket, rhs_hash_chain, bucket_formed_entries, bucket_occupancy, rhs_formed,
      basic_block_witnesses, lhs_color, rhs_color, lhs_frame, decision, home_ordinal = 0 } = f;
    Object.assign(this, { proc, tag, stmt, lhs, rhs, rhs_opcode, rhs_hash_bucket, rhs_hash_chain, bucket_formed_entries, bucket_occupancy,
      rhs_formed, basic_block_witnesses, lhs_color, rhs_color, lhs_frame, decision, home_ordinal });
    Object.freeze(this);
  }
  get stable_key() { return [this.proc, this.lhs_frame, this.home_ordinal]; }
  asDict() {
    return { ...this, rhs_opcode: `0x${hex(this.rhs_opcode, 2)}`, lhs_frame_hex: `0x${hex((this.lhs_frame >>> 0), 8)}`,
      alignment_key: `proc${this.proc}:home${signedHex(this.lhs_frame)}:#${this.home_ordinal}` };
  }
}

/** Parse one COPYDEC snapshot and retain malformed records. */
export function parseCopyDecisions(text, { tag = "pre-reemit", proc = null } = {}) {
  const selected = [], malformed = [];
  const ordinals = new Map();
  for (const raw of splitlines(text)) {
    if (!raw.includes("COPYDEC")) continue;
    const m = COPYDEC_RE.exec(strip(raw));
    if (!m) { malformed.push(raw); continue; }
    const v = m.groups;
    const itemProc = pyInt(v.proc);
    if (v.tag !== tag || (proc !== null && itemProc !== proc)) continue;
    const lhsFrame = signedU32(v.lhsframe);
    const key = `${itemProc},${lhsFrame}`;
    const ordinal = ordinals.get(key) ?? 0;
    ordinals.set(key, ordinal + 1);
    selected.push(new CopyDecision({ proc: itemProc, tag: v.tag, stmt: pyInt(v.stmt), lhs: pyInt(v.lhs), rhs: pyInt(v.rhs), rhs_opcode: parseInt(v.rhsop, 16),
      rhs_hash_bucket: pyInt(v.bucket), rhs_hash_chain: pyInt(v.chain), bucket_formed_entries: pyInt(v.formed_occurrences), bucket_occupancy: pyInt(v.bucket_occupancy),
      rhs_formed: pyInt(v.rhsformed), basic_block_witnesses: pyInt(v.bbwit), lhs_color: pyInt(v.lhscolor), rhs_color: pyInt(v.rhscolor), lhs_frame: lhsFrame,
      decision: v.decision, home_ordinal: ordinal }));
  }
  return [selected, malformed];
}

function summary(items) {
  const outcomes = counter(items.map((i) => i.decision));
  return { decision_count: items.length, coalesced: outcomes.get("COALESCE") ?? 0, temporary_copies: outcomes.get("TEMPCOPY") ?? 0,
    stack_homes: new Set(items.map((i) => `${i.proc},${i.lhs_frame}`)).size };
}

/** Name a pass only when snapshots directly bracket that same pass. */
function ownerPass(before, after) {
  if (before.startsWith("pre-") && after === `post-${before.slice(4)}`) return before.slice(4);
  return null;
}

function transitionTimeline(text, { proc }) {
  const snapshots = new Map();
  const observed = [];
  for (const stage of COPYDEC_STAGE_ORDER) {
    const [items] = parseCopyDecisions(text, { tag: stage, proc });
    if (items.length) observed.push(stage);
    for (const item of items) {
      const k = item.stable_key.join(",");
      if (!snapshots.has(k)) snapshots.set(k, []);
      snapshots.get(k).push(item);
    }
  }
  const transitions = [];
  for (const items of snapshots.values()) {
    for (let i = 0; i + 1 < items.length; i++) {
      const before = items[i], after = items[i + 1];
      if (before.decision === after.decision) continue;
      const owner = ownerPass(before.tag, after.tag);
      transitions.push({ alignment_key: before.asDict().alignment_key, before_stage: before.tag, after_stage: after.tag,
        before_decision: before.decision, after_decision: after.decision, before_rhs_formed: before.rhs_formed, after_rhs_formed: after.rhs_formed,
        before_basic_block_witnesses: before.basic_block_witnesses, after_basic_block_witnesses: after.basic_block_witnesses,
        owner_pass: owner, owner_claim: owner !== null ? "directly bracketed pass" : "unresolved interval between snapshots" });
      break;
    }
  }
  return { observed_stages: observed, decision_transition_count: transitions.length, transitions };
}

const TRUSTED = ["decision", "rhs_formed", "basic_block_witnesses", "lhs_color", "rhs_color", "rhs_opcode"];

/** Report one trace or compare two final copy-decision snapshots. */
export function copyDecisionReport(text, { against = null, tag = "pre-reemit", proc = null } = {}) {
  const [baseline, malformed] = parseCopyDecisions(text, { tag, proc });
  const report = {
    schema: COPYTRACE_SCHEMA, stage: tag, proc, claim_scope: "allocator-copy-decision",
    summary: summary(baseline), decisions: baseline.map((i) => i.asDict()), timeline: transitionTimeline(text, { proc }),
    malformed_copydec_lines: malformed,
    warnings: [
      "rhs_hash_bucket/rhs_hash_chain are collision-prone hash-table observations, not expression identity or CSE multiplicity.",
      "stmt, lhs, and rhs numbers are trace-local; comparison aligns by LHS stack home and assignment ordinal.",
      "A changed decision identifies compiler behavior, not the source expression that caused it; recompare the emitted object.",
      "A basic-block witness is correlated formation evidence, not by itself proof that the observed set is the pass's causal input.",
    ],
  };
  if (against === null || against === undefined) return report;
  const [candidate, candidateMalformed] = parseCopyDecisions(against, { tag, proc });
  const byKey = (list) => new Map(list.map((i) => [i.stable_key.join(","), i]));
  const b = byKey(baseline), c = byKey(candidate);
  const keys = new Map([...baseline, ...candidate].map((i) => [i.stable_key.join(","), i.stable_key]));
  const differences = [];
  for (const key of sorted([...keys.values()])) {
    const k = key.join(",");
    const before = b.get(k) ?? null, after = c.get(k) ?? null;
    const changed = before === null || after === null ? ["presence"] : TRUSTED.filter((f) => before[f] !== after[f]);
    if (!changed.length) continue;
    const aligned = before ?? after;
    differences.push({ alignment_key: aligned.asDict().alignment_key, changed, baseline: before ? before.asDict() : null, candidate: after ? after.asDict() : null });
  }
  Object.assign(report, {
    candidate_summary: summary(candidate), candidate_timeline: transitionTimeline(against, { proc }),
    candidate_malformed_copydec_lines: candidateMalformed, difference_count: differences.length, differences,
    proof: "COPYDEC outcomes and formation witnesses are direct producer observations; alignment and source causality remain hypotheses.",
  });
  return report;
}
