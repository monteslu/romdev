// scheduler.js - the stable scheduler-trace schema (DKWB-SCHED-V1), its
// parser, the bounded report and the cycle-aligned differential view.
//
// Plain JS ESM + JSDoc.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { ValueError, splitlines, strip, splitWs, sorted, pyInt, pyEq, hex, strRepr, fullmatch, sum } from "./py.js";

export const TRACE_PREFIX = "[DKWB-SCHED-V1]";
export const TRACE_SCHEMA = "decomp-workbench-scheduler-trace-v1";
export const PROFILE_SCHEMA = "decomp-workbench-scheduler-profile-v1";
export const INSTRUMENT_RESULT_SCHEMA = "decomp-workbench-scheduler-instrument-v1";
const FIELD_RE = /([A-Za-z_][A-Za-z0-9_]*)=([^\s]+)/;
export const REQUIRED_FIELDS = ["proc", "block", "cycle", "word", "opcode", "line", "ready", "chosen", "tie"];
export const OPTIONAL_FIELDS = ["slot", "file", "statement", "reason", "ready_ids"];

/** One named scheduler selection, independent of emulated node addresses. */
export class SchedulerEvent {
  constructor({ proc, block, cycle, word, opcode, line, ready, chosen, tie, emitted_slot = null, source_file = null, source_statement = null, reason = null, ready_ids = [] }) {
    Object.assign(this, { proc, block, cycle, word, opcode, line, ready, chosen, tie, emitted_slot, source_file, source_statement, reason, ready_ids });
    Object.freeze(this);
  }
  get key() { return [this.proc, this.block, this.cycle]; }
  asDict() {
    return { proc: this.proc, block: this.block, cycle: this.cycle, word: `0x${hex(this.word, 8)}`, opcode: this.opcode,
      line: this.line, ready: this.ready, chosen: this.chosen, tie: this.tie, emitted_slot: this.emitted_slot,
      source_file: this.source_file, source_statement: this.source_statement, reason: this.reason, ready_ids: [...this.ready_ids] };
  }
}

function integer(fields, name, line) {
  try {
    if (!fields.has(name)) throw new ValueError("missing");
    return pyInt(fields.get(name), 0);
  } catch {
    throw new ValueError(`scheduler trace line ${line} has invalid integer field ${strRepr(name)}`);
  }
}

/** Parse only the stable named record and preserve unrelated diagnostics. */
export function parseSchedulerTrace(text) {
  const events = [], ignored = [], seen = new Set();
  splitlines(text).forEach((line, idx) => {
    const lineNumber = idx + 1;
    if (!line.startsWith(TRACE_PREFIX)) { if (strip(line)) ignored.push(line); return; }
    const tokens = splitWs(line.slice(TRACE_PREFIX.length));
    const pairs = [];
    for (const token of tokens) {
      const m = fullmatch(FIELD_RE, token);
      if (!m) throw new ValueError(`scheduler trace line ${lineNumber} has malformed token ${strRepr(token)}`);
      pairs.push([m[1], m[2]]);
    }
    const fields = new Map(pairs);
    if (fields.size !== pairs.length) {
      const counts = new Map();
      for (const [n] of pairs) counts.set(n, (counts.get(n) ?? 0) + 1);
      const repeated = sorted([...counts].filter(([, c]) => c > 1).map(([n]) => n));
      throw new ValueError(`scheduler trace line ${lineNumber} repeats field(s): ` + repeated.join(", "));
    }
    const unknown = sorted([...fields.keys()].filter((k) => !REQUIRED_FIELDS.includes(k) && !OPTIONAL_FIELDS.includes(k)));
    if (unknown.length) throw new ValueError(`scheduler trace line ${lineNumber} has unsupported field(s): ` + unknown.join(", "));
    const missing = REQUIRED_FIELDS.filter((n) => !fields.has(n));
    if (missing.length) throw new ValueError(`scheduler trace line ${lineNumber} is missing field(s): ` + missing.join(", "));
    const event = new SchedulerEvent({
      proc: integer(fields, "proc", lineNumber), block: integer(fields, "block", lineNumber),
      cycle: integer(fields, "cycle", lineNumber), word: integer(fields, "word", lineNumber),
      opcode: fields.get("opcode"), line: integer(fields, "line", lineNumber), ready: integer(fields, "ready", lineNumber),
      chosen: fields.get("chosen"), tie: fields.get("tie"),
      emitted_slot: fields.has("slot") ? integer(fields, "slot", lineNumber) : null,
      source_file: fields.get("file") ?? null,
      source_statement: fields.has("statement") ? integer(fields, "statement", lineNumber) : null,
      reason: fields.get("reason") ?? null,
      ready_ids: (fields.get("ready_ids") ?? "").split(",").filter(Boolean),
    });
    if (event.ready < 1) throw new ValueError(`scheduler trace line ${lineNumber} has ready=${event.ready}; the selected node itself must be ready`);
    for (const name of ["proc", "block", "cycle", "line", "emitted_slot", "source_statement"]) {
      const v = event[name];
      if (v !== null && v < 0) throw new ValueError(`scheduler trace line ${lineNumber} has negative field ${strRepr(name)}`);
    }
    if (!(event.word >= 0 && event.word <= 0xFFFFFFFF)) throw new ValueError(`scheduler trace line ${lineNumber} word is outside 32 bits`);
    if (fields.has("ready_ids")) {
      const raw = fields.get("ready_ids").split(",");
      if (raw.some((x) => !x) || new Set(raw).size !== raw.length || raw.length !== event.ready) {
        throw new ValueError(`scheduler trace line ${lineNumber} ready_ids must contain exactly ${event.ready} unique non-empty ids`);
      }
      if (!event.ready_ids.includes(event.chosen)) throw new ValueError(`scheduler trace line ${lineNumber} chosen node is absent from ready_ids`);
    }
    const k = event.key.join(",");
    if (seen.has(k)) throw new ValueError(`scheduler trace repeats proc/block/cycle (${event.key.join(", ")})`);
    seen.add(k);
    events.push(event);
  });
  return [events, ignored];
}

/** Return a focused, bounded scheduler report. */
export function schedulerReport(events, { proc = null, block = null } = {}) {
  const selected = events.filter((e) => (proc === null || e.proc === proc) && (block === null || e.block === block));
  return {
    schema: TRACE_SCHEMA,
    proof: "Compiler-decision evidence only. A scheduler trace does not prove that candidate C is original or object-exact.",
    events: selected.map((e) => e.asDict()),
    event_count: selected.length,
    ready_set_ties: sum(selected.map((e) => e.ready > 1)),
    provenance_complete: sum(selected.map((e) => e.emitted_slot !== null && e.source_file !== null && e.reason !== null && e.source_statement !== null && e.ready_ids.length > 0)),
    procedures: sorted([...new Set(events.map((e) => e.proc))]),
    blocks: sorted([...new Set(selected.map((e) => e.block))]),
  };
}

const DIFF_FIELDS = ["word", "opcode", "line", "ready", "chosen", "tie", "emitted_slot", "source_file", "source_statement", "reason", "ready_ids"];

/** Align scheduler decisions by procedure, block, and cycle. */
export function compareSchedulerTraces(target, candidate) {
  const byKey = (list) => { const m = new Map(); for (const e of list) m.set(e.key.join(","), e); return m; };
  const t = byKey(target), c = byKey(candidate);
  const keys = new Map();
  for (const e of [...target, ...candidate]) keys.set(e.key.join(","), e.key);
  const differences = [];
  for (const key of sorted([...keys.values()])) {
    const k = key.join(",");
    const expected = t.get(k) ?? null, actual = c.get(k) ?? null;
    if (pyEq(expected, actual)) continue;
    differences.push({ proc: key[0], block: key[1], cycle: key[2],
      target: expected ? expected.asDict() : null, candidate: actual ? actual.asDict() : null,
      changed: DIFF_FIELDS.filter((f) => expected === null || actual === null || !pyEq(expected[f], actual[f])) });
  }
  return { schema: "decomp-workbench-scheduler-diff-v1", target_events: target.length, candidate_events: candidate.length,
    difference_count: differences.length, differences, proof: "Aligned compiler-decision evidence, not source-match evidence." };
}

const sha256 = (s) => createHash("sha256").update(Buffer.from(s, "utf8")).digest("hex");

/** Apply a hash-pinned, exact-anchor external scheduler profile. */
export function instrumentSchedulerSource(source, profile) {
  if (profile?.schema !== PROFILE_SCHEMA) throw new ValueError(`scheduler profile schema must be ${PROFILE_SCHEMA}`);
  const digest = sha256(source);
  if (profile.source_sha256 !== digest) throw new ValueError(`scheduler profile source SHA-256 does not match the input (${digest})`);
  const injections = profile.injections;
  if (!Array.isArray(injections) || !injections.length) throw new ValueError("scheduler profile requires at least one injection");
  if ("provenance_required" in profile && typeof profile.provenance_required !== "boolean") throw new ValueError("scheduler profile provenance_required must be a boolean");
  let instrumented = source;
  const injected = [];
  injections.forEach((inj, index) => {
    if (!inj || typeof inj !== "object" || Array.isArray(inj)) throw new ValueError(`scheduler injection ${index} must be an object`);
    const { anchor, text, position } = inj;
    if (typeof anchor !== "string" || !anchor || typeof text !== "string" || !["before", "after"].includes(position)) {
      throw new ValueError(`scheduler injection ${index} requires anchor, text, and position=before|after`);
    }
    const count = instrumented.split(anchor).length - 1;
    if (count !== 1) throw new ValueError(`scheduler injection ${index} anchor matched ${count} times; exactly one is required`);
    const replacement = position === "before" ? text + anchor : anchor + text;
    const at = instrumented.indexOf(anchor);
    instrumented = instrumented.slice(0, at) + replacement + instrumented.slice(at + anchor.length);
    injected.push(text);
  });
  const emitted = injected.join("");
  for (const token of [TRACE_PREFIX, ...REQUIRED_FIELDS.map((n) => `${n}=`)]) {
    if (!emitted.includes(token)) throw new ValueError(`scheduler profile does not emit required token ${strRepr(token)}`);
  }
  if (profile.provenance_required === true) {
    for (const token of ["slot=", "file=", "statement=", "reason=", "ready_ids="]) {
      if (!emitted.includes(token)) throw new ValueError(`scheduler provenance profile does not emit required token ${strRepr(token)}`);
    }
  }
  return [instrumented, { schema: INSTRUMENT_RESULT_SCHEMA, profile: profile.name ?? null, input_sha256: digest,
    output_sha256: sha256(instrumented), injections: injected.length,
    calibration_required: ["tracing-off section identity", "positive-control event", "unedited as0/as1 replay", "collateral functions", "project output"] }];
}

export function loadSchedulerProfile(p) {
  const value = JSON.parse(readFileSync(p, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ValueError("scheduler profile must be a JSON object");
  return value;
}
