// experiment-signals.js - declarative, selected-function experiment
// signals: exact target rows or regions, metric predicates and residual
// classes, evaluated over an existing comparison without loading anything.
//
// Plain JS ESM + JSDoc.

import { sorted, pyInt, pyEq } from "./py.js";

export const STATUS_PASS = "PASS";
export const STATUS_FAIL = "FAIL";
export const STATUS_UNKNOWN = "UNKNOWN";

const receipt = (spec, status, reason, evidence = {}) => ({ id: spec.id, kind: spec.kind, required: spec.required, status, reason, ...evidence });
const toInt = (v) => (typeof v === "boolean" ? Number(v) : typeof v === "number" ? Math.trunc(v) : pyInt(v));

function requestedRows(spec) {
  const rows = new Set((spec.config.rows ?? []).map(toInt));
  for (const interval of spec.config.ranges ?? []) for (let r = toInt(interval.start); r < toInt(interval.end); r++) rows.add(r);
  return sorted([...rows]);
}

function rowsExact(spec, comparison, rows) {
  if (!rows.length) return receipt(spec, STATUS_UNKNOWN, "no target rows were requested");
  const unavailable = rows.filter((r) => r >= comparison.target_instructions);
  if (unavailable.length) return receipt(spec, STATUS_UNKNOWN, "requested target row is outside the selected function", { requested_rows: rows, unavailable_rows: unavailable });
  const byTarget = new Map();
  for (const item of comparison.aligned_row_receipts ?? []) if (item.target_index !== null && item.target_index !== undefined) byTarget.set(toInt(item.target_index), item);
  const missing = rows.filter((r) => !byTarget.has(r));
  if (missing.length) return receipt(spec, STATUS_UNKNOWN, "alignment did not produce a receipt for every requested target row", { requested_rows: rows, unavailable_rows: missing });
  const mode = spec.config.comparison ?? "relocation-aware";
  const field = mode === "raw" ? "raw_exact" : "relocation_aware_exact";
  const failed = rows.filter((r) => !byTarget.get(r)[field]);
  return receipt(spec, failed.length ? STATUS_FAIL : STATUS_PASS, failed.length ? "one or more selected target rows differ" : "all selected target rows agree",
    { comparison: mode, requested_rows: rows, failed_rows: failed, matched_rows: rows.length - failed.length });
}

const comparable = (a, b) => (typeof a === "number" || typeof a === "boolean") && (typeof b === "number" || typeof b === "boolean")
  || (typeof a === "string" && typeof b === "string") || (Array.isArray(a) && Array.isArray(b));

function metricSignal(spec, comparison) {
  const values = comparison.asDict();
  const observed = {};
  const failures = [], unavailable = [];
  for (const predicate of ["equals", "minimum", "maximum"]) {
    for (const [key, wanted] of Object.entries(spec.config[predicate] ?? {})) {
      const actual = values[key] ?? null;
      observed[key] = actual;
      if (actual === null) { unavailable.push(key); continue; }
      let passed;
      if (predicate === "equals") passed = pyEq(actual, wanted);
      else {
        if (!comparable(actual, wanted)) { unavailable.push(key); continue; }
        const a = typeof actual === "boolean" ? Number(actual) : actual, w = typeof wanted === "boolean" ? Number(wanted) : wanted;
        passed = predicate === "minimum" ? a >= w : a <= w;
      }
      if (!passed) failures.push(`${predicate}:${key}`);
    }
  }
  if (unavailable.length) return receipt(spec, STATUS_UNKNOWN, "one or more requested metrics are unavailable or incomparable", { observed, unavailable: sorted([...new Set(unavailable)]) });
  return receipt(spec, failures.length ? STATUS_FAIL : STATUS_PASS, failures.length ? "metric predicate failed" : "all metric predicates passed", { observed, failed_predicates: failures });
}

function residualSignal(spec, comparison) {
  const observed = Object.fromEntries(["structural", "schedule", "register", "constant", "commutative"].map((n) => [n, toInt(comparison[`aligned_${n}`])]));
  const present = Object.keys(observed).filter((n) => observed[n]);
  const allowed = new Set(spec.config.allowed ?? Object.keys(observed));
  const forbidden = new Set(spec.config.forbidden ?? []);
  const violations = sorted([...new Set(present.filter((n) => !allowed.has(n) || forbidden.has(n)))]);
  return receipt(spec, violations.length ? STATUS_FAIL : STATUS_PASS, violations.length ? "residual class predicate failed" : "residual classes are within the declared set", { observed, violations });
}

/** Evaluate one signal without loading any object or target text. */
export function evaluateSignal(spec, comparison) {
  if (comparison === null || comparison === undefined) return receipt(spec, STATUS_UNKNOWN, "candidate comparison is unavailable");
  if (spec.kind === "target-rows-exact") return rowsExact(spec, comparison, requestedRows(spec));
  if (spec.kind === "target-region-exact") {
    const rows = [];
    for (let r = toInt(spec.config.start); r < toInt(spec.config.end); r++) rows.push(r);
    return rowsExact(spec, comparison, rows);
  }
  if (spec.kind === "metrics") return metricSignal(spec, comparison);
  return residualSignal(spec, comparison);
}

export function evaluateSignals(specs, comparison) { return specs.map((s) => evaluateSignal(s, comparison)); }

export function requiredSignalsPass(receipts) { return receipts.filter((r) => r.required).every((r) => r.status === STATUS_PASS); }
