// pre.js - stable PRE/speculative-hoist decision records (DKWB-PRE-V1), their
// report and identity-aligned diff, and guarded source-hash-pinned
// instrumentation profiles.
//
// Plain JS ESM + JSDoc.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { ValueError, splitlines, strip, splitWs, sorted, pyInt, pyEq, strRepr, fullmatch } from "./py.js";

export const TRACE_PREFIX = "[DKWB-PRE-V1]";
export const TRACE_SCHEMA = "decomp-workbench-pre-trace-v1";
export const PROFILE_SCHEMA = "decomp-workbench-pre-profile-v1";
export const INSTRUMENT_SCHEMA = "decomp-workbench-pre-instrument-v1";
const FIELD_RE = /([A-Za-z_][A-Za-z0-9_]*)=([^\s]+)/;
export const DECISIONS = Object.freeze(new Set(["insert", "hoist", "retain", "reject", "kill"]));
export const REQUIRED_FIELDS = Object.freeze(["proc", "block", "expression", "decision", "reason", "line"]);
export const OPTIONAL_FIELDS = Object.freeze(["candidate", "availability", "cost"]);

/** One PRE or speculative-hoist decision named without pointer identities. */
export class PreDecision {
  constructor({ proc, block, expression, decision, reason, line, candidate = null, availability = null, cost = null }) {
    Object.assign(this, { proc, block, expression, decision, reason, line, candidate, availability, cost });
    Object.freeze(this);
  }
  get key() { return [this.proc, this.block, this.expression]; }
  asDict() {
    const { proc, block, expression, decision, reason, line, candidate, availability, cost } = this;
    return { proc, block, expression, decision, reason, line, candidate, availability, cost };
  }
}

function integer(fields, name, line) {
  try { if (!fields.has(name)) throw new Error(); return pyInt(fields.get(name), 0); } catch {
    throw new ValueError(`PRE trace line ${line} has invalid integer field ${strRepr(name)}`);
  }
}

const keyRepr = (k) => `(${k[0]}, ${k[1]}, ${strRepr(k[2])})`;

/** Parse versioned records and retain unrelated compiler diagnostics. */
export function parsePreTrace(text) {
  const decisions = [], ignored = [], seen = new Set();
  splitlines(text).forEach((line, i) => {
    const n = i + 1;
    if (!line.startsWith(TRACE_PREFIX)) { if (strip(line)) ignored.push(line); return; }
    const pairs = splitWs(line.slice(TRACE_PREFIX.length)).map((token) => {
      const m = fullmatch(FIELD_RE, token);
      if (!m) throw new ValueError(`PRE trace line ${n} has malformed token ${strRepr(token)}`);
      return [m[1], m[2]];
    });
    const fields = new Map(pairs);
    if (fields.size !== pairs.length) throw new ValueError(`PRE trace line ${n} repeats a field`);
    const unknown = sorted([...fields.keys()].filter((k) => !REQUIRED_FIELDS.includes(k) && !OPTIONAL_FIELDS.includes(k)));
    if (unknown.length) throw new ValueError(`PRE trace line ${n} has unsupported field(s): ` + unknown.join(", "));
    const missing = REQUIRED_FIELDS.filter((k) => !fields.has(k));
    if (missing.length) throw new ValueError(`PRE trace line ${n} is missing field(s): ` + missing.join(", "));
    const decision = fields.get("decision");
    if (!DECISIONS.has(decision)) throw new ValueError(`PRE trace line ${n} has unsupported decision ${strRepr(decision)}`);
    const cost = fields.has("cost") ? integer(fields, "cost", n) : null;
    const item = new PreDecision({ proc: integer(fields, "proc", n), block: integer(fields, "block", n), expression: fields.get("expression"),
      decision, reason: fields.get("reason"), line: integer(fields, "line", n), candidate: fields.get("candidate") ?? null,
      availability: fields.get("availability") ?? null, cost });
    for (const name of ["proc", "block", "line", "cost"]) {
      const v = item[name];
      if (v !== null && v < 0) throw new ValueError(`PRE trace line ${n} has negative field ${strRepr(name)}`);
    }
    const k = JSON.stringify(item.key);
    if (seen.has(k)) throw new ValueError("PRE trace repeats proc/block/expression " + keyRepr(item.key));
    seen.add(k);
    decisions.push(item);
  });
  return [decisions, ignored];
}

export function preReport(decisions, { proc = null } = {}) {
  const selected = decisions.filter((d) => proc === null || d.proc === proc);
  const counts = Object.fromEntries(sorted([...DECISIONS]).map((d) => [d, 0]));
  for (const item of selected) counts[item.decision] += 1;
  return {
    schema: TRACE_SCHEMA,
    events: selected.map((d) => d.asDict()),
    event_count: selected.length,
    decisions: Object.fromEntries(Object.entries(counts).filter(([, v]) => v)),
    procedures: sorted([...new Set(decisions.map((d) => d.proc))]),
    proof: "Compiler-decision evidence: this records where PRE/hoisting accepted or rejected an expression. It does not prove source originality or object equality.",
  };
}

const DIFF_FIELDS = ["decision", "reason", "line", "candidate", "availability", "cost"];

export function comparePreTraces(target, candidate) {
  const byKey = (list) => new Map(list.map((d) => [JSON.stringify(d.key), d]));
  const expected = byKey(target), actual = byKey(candidate);
  const keys = new Map([...target, ...candidate].map((d) => [JSON.stringify(d.key), d.key]));
  const differences = [];
  for (const key of sorted([...keys.values()])) {
    const k = JSON.stringify(key);
    const left = expected.get(k) ?? null, right = actual.get(k) ?? null;
    if (pyEq(left, right)) continue;
    differences.push({ proc: key[0], block: key[1], expression: key[2], target: left ? left.asDict() : null, candidate: right ? right.asDict() : null,
      changed: DIFF_FIELDS.filter((f) => left === null || right === null || !pyEq(left[f], right[f])) });
  }
  return { schema: "decomp-workbench-pre-diff-v1", target_events: target.length, candidate_events: candidate.length,
    difference_count: differences.length, differences, proof: "Aligned PRE decision evidence, not source-match evidence." };
}

const sha = (s) => createHash("sha256").update(Buffer.from(s, "utf8")).digest("hex");

/** Apply a source-hash-pinned list of uniqueness-checked injections. */
export function instrumentPreSource(source, profile) {
  if (profile?.schema !== PROFILE_SCHEMA) throw new ValueError(`PRE profile schema must be ${PROFILE_SCHEMA}`);
  const digest = sha(source);
  if (profile.source_sha256 !== digest) throw new ValueError(`PRE profile source SHA-256 does not match input (${digest})`);
  const injections = profile.injections;
  if (!Array.isArray(injections) || !injections.length) throw new ValueError("PRE profile injections must be a non-empty list");
  let instrumented = source;
  const injected = [];
  injections.forEach((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ValueError(`PRE injection ${index} must be an object`);
    const { anchor, text, position } = raw;
    if (typeof anchor !== "string" || !anchor || typeof text !== "string" || !["before", "after"].includes(position)) {
      throw new ValueError(`PRE injection ${index} requires anchor, text, and position=before|after`);
    }
    const count = instrumented.split(anchor).length - 1;
    if (count !== 1) throw new ValueError(`PRE injection ${index} anchor matched ${count} times; exactly one required`);
    const at = instrumented.indexOf(anchor);
    instrumented = instrumented.slice(0, at) + (position === "before" ? text + anchor : anchor + text) + instrumented.slice(at + anchor.length);
    injected.push(text);
  });
  const emitted = injected.join("");
  for (const token of [TRACE_PREFIX, ...REQUIRED_FIELDS.map((f) => `${f}=`)]) {
    if (!emitted.includes(token)) throw new ValueError(`PRE profile does not emit required token ${strRepr(token)}`);
  }
  return [instrumented, { schema: INSTRUMENT_SCHEMA, profile: profile.name ?? null, input_sha256: digest, output_sha256: sha(instrumented),
    injections: injections.length,
    calibration_required: ["tracing-off section identity", "positive-control accept decision", "positive-control reject decision", "collateral procedures"] }];
}

export function loadPreProfile(p) {
  const value = JSON.parse(readFileSync(p, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ValueError("PRE profile must be a JSON object");
  return value;
}
