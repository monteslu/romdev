// force-rows.js - join an allocator force control to the object rows it
// moved. The join is measured, not read: the same source built without and
// with one control, aligned, and the rows that moved are the rows that
// control owns. It builds nothing itself.
//
// Plain JS ESM + JSDoc.

import { buildView } from "./view.js";
import { ValueError } from "./py.js";

export const FORCE_ROWS_SCHEMA = "decomp-workbench-force-rows-v1";
export const DEFAULT_GAP = 3;
export const INERT_NOTE = "no row moved: under this force the two builds are instruction-identical. "
  + "That is evidence, not a failed run -- the control reached the pass and "
  + "changed no emitted instruction, so this web owns no object row here";
export const LENGTH_WARNING = "the force changed the instruction count ({baseline} -> {forced}); runs "
  + "are reported over the alignment of the two builds, not by position";

export class MovedRun {
  constructor(f) { Object.assign(this, f); Object.freeze(this); }
  asDict() {
    return { run: this.run, start: this.start, end: this.end, rows: this.rows, classes: [...this.classes], baseline_start: this.baseline_start,
      baseline_end: this.baseline_end, compare_start: this.compare_start, compare_end: this.compare_end, baseline_text: this.baseline_text,
      target_text: this.target_text };
  }
}

export class ForceRows {
  constructor(f) { Object.assign(this, f); Object.freeze(this); }
  get inert() { return this.moved_rows === 0; }
  asDict() {
    return { schema: FORCE_ROWS_SCHEMA, force: this.force, baseline: this.baseline, forced: this.forced, target: this.target, symbol: this.symbol,
      gap: this.gap, aligned_rows: this.aligned_rows, moved_rows: this.moved_rows, inert: this.inert, runs: this.runs.map((r) => r.asDict()),
      warnings: [...this.warnings] };
  }
}

/** Group non-matching rows into runs, tolerating `gap` matched rows. */
export function groupMovedRuns(view, { gap = DEFAULT_GAP } = {}) {
  if (gap < 0) throw new ValueError("--gap cannot be negative");
  const moved = view.rows.filter((r) => !r.matched).map((r) => r.index);
  if (!moved.length) return [];
  const runs = [];
  let start = moved[0], previous = moved[0];
  for (const index of moved.slice(1)) {
    if (index > previous + gap + 1) { runs.push([start, previous]); start = index; }
    previous = index;
  }
  runs.push([start, previous]);
  return runs;
}

function compareRows(view) {
  const m = new Map();
  if (view === null) return m;
  for (const row of view.rows) if (row.candidate_index !== null && row.candidate_index !== undefined) m.set(row.candidate_index, row.index);
  return m;
}

function targetText(view, row) {
  if (view === null || row === null || row === undefined || !(row >= 0 && row < view.rows.length)) return null;
  return view.rows[row].target;
}

/** Measure which rows one force control moved, and where they sit. */
export function buildForceRows(baseline, forced, { force, baseline_name, forced_name, target = null, target_name = null, symbol = null, gap = DEFAULT_GAP, warnings = [] }) {
  const perturbation = buildView(baseline, forced, { target_name: baseline_name, candidate_name: forced_name, symbol });
  const comparison = target !== null ? buildView(target, baseline, { target_name: target_name || "target", candidate_name: baseline_name, symbol }) : null;
  const rows = compareRows(comparison);
  const collected = [...warnings];
  if (baseline.length !== forced.length) collected.push(LENGTH_WARNING.replace("{baseline}", baseline.length).replace("{forced}", forced.length));
  const runs = [];
  let movedRows = 0;
  groupMovedRuns(perturbation, { gap }).forEach(([low, high], i) => {
    const selected = perturbation.rows.slice(low, high + 1);
    movedRows += selected.filter((r) => !r.matched).length;
    const classes = [];
    for (const r of selected) if (!r.matched && !classes.includes(r.classification)) classes.push(r.classification);
    const indices = selected.map((r) => r.target_index).filter((x) => x !== null && x !== undefined);
    const bs = indices.length ? indices[0] : null, be = indices.length ? indices[indices.length - 1] : null;
    const cs = bs !== null ? rows.get(bs) ?? null : null, ce = be !== null ? rows.get(be) ?? null : null;
    runs.push(new MovedRun({ run: i + 1, start: low, end: high, rows: selected.length, classes, baseline_start: bs, baseline_end: be,
      compare_start: cs, compare_end: ce, baseline_text: selected.length ? selected[0].target : null, target_text: targetText(comparison, cs) }));
  });
  return new ForceRows({ force, baseline: baseline_name, forced: forced_name, target: target_name, symbol, gap, aligned_rows: perturbation.aligned_rows,
    moved_rows: movedRows, runs, warnings: collected });
}

/** Render the join for a terminal, evidence first. */
export function forceRowsLines(result) {
  const lines = result.warnings.map((w) => `warning: ${w}`);
  lines.push(`force=${result.force} aligned_rows=${result.aligned_rows} moved=${result.moved_rows} runs=${result.runs.length}`);
  if (result.inert) { lines.push(`BYTE-INERT  ${INERT_NOTE}`); return lines; }
  for (const run of result.runs) {
    let head = `  run ${String(run.run).padStart(3)}  rows ${run.start}-${run.end}  moved=${run.rows}  classes=${run.classes.join(",") || "-"}`;
    if (run.compare_start !== null) head += `  compare_row=${run.compare_start}`;
    lines.push(head);
    if (run.baseline_text) lines.push(`        baseline: ${run.baseline_text}`);
    if (run.target_text) lines.push(`        target:   ${run.target_text}`);
  }
  return lines;
}
