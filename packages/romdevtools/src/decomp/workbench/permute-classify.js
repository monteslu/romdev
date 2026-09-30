// permute-classify.js - turn a sweep's record into a measured wall class per
// function, so routing is decided from measurements a sweep took (base score,
// best score, where in the window the best candidate landed, whether an
// extension was earned) rather than from how a verdict was worded. It
// classifies; it does not search, promote, or judge matchability.
//
// Plain JS ESM + JSDoc.

import { ValueError, pyRound, percent, fixed } from "./py.js";

export const CLASSIFY_SCHEMA = "decomp-workbench-permute-classify-v1";
export const MATCHED = "MATCHED";
export const P_STUCK_DESCENDING = "P_STUCK_DESCENDING";
export const P_STUCK_FLAT = "P_STUCK_FLAT";
export const IMPORT_FAULT = "IMPORT_FAULT";
export const CLASSES = Object.freeze([MATCHED, P_STUCK_DESCENDING, P_STUCK_FLAT, IMPORT_FAULT]);

/** A best candidate landing in the last third of the window is "still descending". */
export const LATE_FRACTION = 2.0 / 3.0;

export const ROUTING = Object.freeze({
  [MATCHED]: "verify on the authoritative build, then promote",
  [P_STUCK_DESCENDING]: "trace levers or manual work; the search is still moving",
  [P_STUCK_FLAT]: "the pool that decides whether deeper instrumentation is worth funding",
  [IMPORT_FAULT]: "fix the scratch (prototype conflicts, missing context, flags)",
});

/** One function's measured class, and the numbers behind it. */
export class Classification {
  constructor({ function: fn, source, wall_class, reason, base = null, best = null, delta = null, elapsed = 0.0, extended = false,
    hit_cap = false, best_output_mtime_fraction = null, flags_recovered = true, error = null }) {
    Object.assign(this, { function: fn, source, wall_class, reason, base, best, delta, elapsed, extended, hit_cap,
      best_output_mtime_fraction, flags_recovered, error });
    Object.freeze(this);
  }
  asDict() {
    return {
      function: this.function, source: this.source, class: this.wall_class, reason: this.reason, routing: ROUTING[this.wall_class],
      base: this.base, best: this.best, delta: this.delta, elapsed: pyRound(this.elapsed, 1), extended: this.extended,
      hit_cap: this.hit_cap, best_output_mtime_fraction: this.best_output_mtime_fraction, flags_recovered: this.flags_recovered, error: this.error,
    };
  }
}

const integer = (v) => (typeof v === "number" && Number.isInteger(v) ? v : null);
const fraction = (v) => (typeof v === "number" ? v : null);
const truthy = (v) => !(v === null || v === undefined || v === false || v === 0 || v === "" || (Array.isArray(v) && !v.length)
  || (typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0));

/** Classify one `summary.json` result row. */
export function classifyRow(row) {
  const fn = String(row.function ?? "");
  const source = String(row.source ?? "");
  const base = integer(row.base_score);
  const best = integer(row.best_score);
  const elapsed = fraction(row.seconds) || 0.0;
  const extended = truthy(row.extended);
  const hit_cap = truthy(row.hit_cap);
  const frac = fraction(row.best_output_mtime_fraction);
  const flags_recovered = truthy(row.flags_recovered);
  const error = typeof row.error === "string" ? row.error : null;
  const common = { function: fn, source, base, best, elapsed, extended, hit_cap, best_output_mtime_fraction: frac, flags_recovered, error };
  if (error !== null || !truthy(row.ok) || base === null) {
    return new Classification({ ...common, wall_class: IMPORT_FAULT, reason: error || "the scratch produced no base score", delta: null });
  }
  if (best === 0) {
    return new Classification({ ...common, wall_class: MATCHED, reason: "the scratch reached score 0; the real build has not confirmed it", delta: base });
  }
  const reached = best === null ? base : best;
  const delta = base - reached;
  if (delta <= 0) return new Classification({ ...common, wall_class: P_STUCK_FLAT, reason: "no candidate ever improved on the base score", delta });
  if (extended) {
    return new Classification({ ...common, wall_class: P_STUCK_DESCENDING, delta,
      reason: "the search earned its extension: it was still improving when its first window closed" });
  }
  if (frac === null) {
    return new Classification({ ...common, wall_class: P_STUCK_DESCENDING, delta,
      reason: "improved on the base, but this summary does not record when the best candidate landed; re-run the sweep to measure it" });
  }
  if (frac >= LATE_FRACTION) {
    return new Classification({ ...common, wall_class: P_STUCK_DESCENDING, delta,
      reason: `the best candidate landed ${percent(frac, 0)} into the window, so the search was still descending when it stopped` });
  }
  return new Classification({ ...common, wall_class: P_STUCK_FLAT, delta,
    reason: `the best candidate landed ${percent(frac, 0)} into the window and nothing improved after it` });
}

/** Classify every result in a `permute sweep` summary document. */
export function classifySummary(payload) {
  const rows = payload && typeof payload === "object" && !Array.isArray(payload) ? (payload.results ?? []) : payload;
  if (!Array.isArray(rows)) throw new ValueError("a sweep summary must hold a list of results");
  return rows.filter((r) => r && typeof r === "object" && !Array.isArray(r)).map(classifyRow);
}

/** The JSON document, with the per-class totals a triage page needs. */
export function classifyPayload(rows, { source = null } = {}) {
  return {
    schema: CLASSIFY_SCHEMA,
    summary: source,
    totals: Object.fromEntries(CLASSES.map((name) => [name, rows.filter((r) => r.wall_class === name).length])),
    routing: { ...ROUTING },
    functions: rows.map((r) => r.asDict()),
  };
}

const cell = (v) => (v === null || v === undefined ? "-" : String(v));

/** A table that can be pasted into a triage document unedited. */
export function renderMarkdown(rows, { source = null } = {}) {
  const lines = [];
  if (source) lines.push(`Sweep: \`${source}\``, "");
  lines.push("| function | class | base | best | delta | best at | elapsed | ext |", "|---|---|---:|---:|---:|---:|---:|---|");
  for (const r of rows) {
    const f = r.best_output_mtime_fraction === null ? "-" : percent(r.best_output_mtime_fraction, 0);
    lines.push(`| \`${r.function}\` | ${r.wall_class} | ${cell(r.base)} | ${cell(r.best)} | ${cell(r.delta)} | ${f} | ${fixed(r.elapsed, 0)}s | ${r.extended ? "yes" : "no"} |`);
  }
  lines.push("", "| class | functions | routes to |", "|---|---:|---|");
  for (const name of CLASSES) lines.push(`| ${name} | ${rows.filter((r) => r.wall_class === name).length} | ${ROUTING[name]} |`);
  const fallback = rows.filter((r) => !r.flags_recovered && r.wall_class !== IMPORT_FAULT).map((r) => r.function);
  if (fallback.length) {
    lines.push("", "Searched with fallback flags, so their class is not evidence about the function: " + fallback.map((n) => `\`${n}\``).join(", "));
  }
  return lines;
}
