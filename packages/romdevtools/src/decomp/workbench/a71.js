// a71.js - parse and compare the compact IDO 7.1 `[A71]` allocator trace:
// the allocator's final coloring order, with no procedure or semantic-web
// provenance, so `(phase, web)` is deliberately a run-local key.
//
// Plain JS ESM + JSDoc.

import { ValueError, splitlines, strip, sorted, hex, strRepr, PyDict, counter, pyEq } from "./py.js";
import { decodeForbiddenColors } from "./globalcolor.js";

export const A71_PREFIX = "[A71]";
export const A71_FIELD_RE = /([A-Za-z_][A-Za-z0-9_]*)=([^\s]+)/g;
export const A71_REQUIRED_FIELDS = Object.freeze(["phase", "web", "sym", "class", "color", "savebits", "forbidden0", "forbidden1"]);
/** Colour map with direct IDO 7.1 object receipts (not the 5.3 CDX map). */
export const A71_COLOR_REGISTERS = new Map([[1, "v0"], [2, "v1"], [3, "a0"], [4, "a1"], [5, "a2"], [24, "$f0"], [25, "$f2"], [26, "$f12"], [27, "$f14"], [28, "$f16"], [29, "$f18"]]);
/** refs/defs read the wrong live-range offsets; never alignment inputs. */
export const A71_UNVERIFIED_FIELDS = Object.freeze(["refs", "defs"]);

function decimal(value, { field, line }) {
  if (!/^\s*[-+]?\d+\s*$/.test(value)) throw new ValueError(`line ${line}: A71 field ${field} is not decimal: ${strRepr(value)}`);
  return parseInt(value, 10);
}

function hexWord(value, { field, line }) {
  const cleaned = value.replace(/^0x/, "").replace(/^0X/, "");
  if (!/^[0-9a-fA-F]{1,8}$/.test(cleaned)) throw new ValueError(`line ${line}: A71 field ${field} is not a 32-bit hex word: ${strRepr(value)}`);
  return parseInt(cleaned, 16);
}

export function priorityFromBits(bits) {
  const buf = Buffer.alloc(4);
  buf.writeUInt32BE(bits >>> 0);
  return buf.readFloatBE(0);
}

const jsonFloat = (v) => (Number.isFinite(v) ? v : Number.isNaN(v) ? "nan" : v > 0 ? "inf" : "-inf");

/** One final-color record from the read-only IDO 7.1 trace point. */
export class A71Record {
  constructor({ phase, web, symbol, register_class, color, priority_bits, forbidden0, forbidden1, trace_line }) {
    Object.assign(this, { phase, web, symbol, register_class, color, priority_bits, forbidden0, forbidden1, trace_line });
    Object.freeze(this);
  }
  get key() { return [this.phase, this.web]; }
  get priority() { return priorityFromBits(this.priority_bits); }
  get register() { return A71_COLOR_REGISTERS.get(this.color) ?? null; }
  get forbidden_colors() { return decodeForbiddenColors(this.forbidden0, this.forbidden1); }
  asDict() {
    return { phase: this.phase, web: this.web, symbol: this.symbol, register_class: this.register_class, color: this.color, register: this.register,
      priority: jsonFloat(this.priority), priority_bits: `0x${hex(this.priority_bits, 8)}`, forbidden0: `0x${hex(this.forbidden0, 8)}`,
      forbidden1: `0x${hex(this.forbidden1, 8)}`, forbidden_colors: this.forbidden_colors, trace_line: this.trace_line };
  }
}

/** A validated single-input A71 allocation stream. */
export class A71Trace {
  constructor({ records, ignored_diagnostic_lines = 0, unverified_fields_seen = [] }) {
    Object.assign(this, { records, ignored_diagnostic_lines, unverified_fields_seen });
    Object.freeze(this);
  }
  selected({ phase = null, web = null, register_class = null } = {}) {
    return this.records.filter((r) => (phase === null || r.phase === phase) && (web === null || r.web === web)
      && (register_class === null || r.register_class === register_class));
  }
  summary(records = null) {
    const sel = records === null ? [...this.records] : records;
    const counts = (key) => new PyDict(sorted([...counter(sel.map(key)).entries()], (e) => e[0]));
    return { record_count: sel.length, phase_counts: counts((i) => i.phase), class_counts: counts((i) => i.register_class),
      ignored_diagnostic_lines: this.ignored_diagnostic_lines, unverified_fields_seen: [...this.unverified_fields_seen] };
  }
}

/** Parse A71 records from a filtered trace or a mixed compiler log. */
export function parseA71Trace(text) {
  const records = [], seen = new Set(), unverified = new Set();
  let ignored = 0;
  splitlines(text).forEach((raw, i) => {
    const line = strip(raw), number = i + 1;
    if (!line.startsWith(A71_PREFIX)) { if (line) ignored += 1; return; }
    const fields = new Map([...line.slice(A71_PREFIX.length).matchAll(A71_FIELD_RE)].map((m) => [m[1], m[2]]));
    const missing = sorted(A71_REQUIRED_FIELDS.filter((f) => !fields.has(f)));
    if (missing.length) throw new ValueError(`line ${number}: malformed A71 record; missing ` + missing.join(", "));
    for (const f of A71_UNVERIFIED_FIELDS) if (fields.has(f)) unverified.add(f);
    const record = new A71Record({
      phase: decimal(fields.get("phase"), { field: "phase", line: number }), web: decimal(fields.get("web"), { field: "web", line: number }),
      symbol: decimal(fields.get("sym"), { field: "sym", line: number }), register_class: decimal(fields.get("class"), { field: "class", line: number }),
      color: decimal(fields.get("color"), { field: "color", line: number }), priority_bits: hexWord(fields.get("savebits"), { field: "savebits", line: number }),
      forbidden0: hexWord(fields.get("forbidden0"), { field: "forbidden0", line: number }),
      forbidden1: hexWord(fields.get("forbidden1"), { field: "forbidden1", line: number }), trace_line: number,
    });
    const k = record.key.join(",");
    if (seen.has(k)) throw new ValueError(`line ${number}: duplicate A71 phase/web key (${record.key.join(", ")})`);
    seen.add(k);
    records.push(record);
  });
  if (!records.length) throw new ValueError("trace contains no [A71] records");
  return new A71Trace({ records, ignored_diagnostic_lines: ignored, unverified_fields_seen: sorted([...unverified]) });
}

const COMPARISON_FIELDS = ["symbol", "register_class", "color", "priority_bits", "forbidden0", "forbidden1"];

/** Diff two A71 streams on their explicitly run-local phase/web keys. */
export function compareA71Traces(baseline, candidate, { phase = null, web = null, register_class = null } = {}) {
  const beforeRecords = baseline.selected({ phase, web, register_class }), afterRecords = candidate.selected({ phase, web, register_class });
  const before = new Map(beforeRecords.map((r) => [r.key.join(","), r])), after = new Map(afterRecords.map((r) => [r.key.join(","), r]));
  const keys = new Map([...beforeRecords, ...afterRecords].map((r) => [r.key.join(","), r.key]));
  const changes = [];
  for (const key of sorted([...keys.values()])) {
    const k = key.join(",");
    const left = before.get(k) ?? null, right = after.get(k) ?? null;
    if (left === null) { changes.push({ status: "added", phase: key[0], web: key[1], changed_fields: [], baseline: null, candidate: right.asDict() }); continue; }
    if (right === null) { changes.push({ status: "removed", phase: key[0], web: key[1], changed_fields: [], baseline: left.asDict(), candidate: null }); continue; }
    const changed = COMPARISON_FIELDS.filter((f) => !pyEq(left[f], right[f]));
    if (changed.length) changes.push({ status: "changed", phase: key[0], web: key[1], changed_fields: changed, baseline: left.asDict(), candidate: right.asDict() });
  }
  return {
    format: "ido-7.1-a71-final-color", filters: { phase, web, register_class },
    baseline_summary: baseline.summary(beforeRecords), candidate_summary: candidate.summary(afterRecords),
    difference_count: changes.length, changes, alignment_scope: "run-local-phase-web",
    alignment_warning: "A71 has no semantic-web provenance. Phase/web keys may be compared only for controlled inputs where numbering remains aligned; added "
      + "or removed webs can shift later keys.",
    field_warning: "Historical refs/defs fields read invalid recovered-source offsets and are ignored by parsing and comparison.",
  };
}
