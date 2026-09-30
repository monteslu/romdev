// sweep-ingest.js - reading a sweep's objects back: the gate, the score, and
// the price table. Find each variant's object, gate it, score it with the
// shift-tolerant edit distance (a wrong instruction count is a column, not a
// rejection), and report the family with the coverage its own manifest
// declared. A variant with no object is a row, never a silent omission; the
// price table measures every construct against the control built in the same
// run.
//
// Plain JS ESM + JSDoc.

import fs from "node:fs";
import path from "node:path";
import { SweepCoverage } from "./coverage.js";
import { DisassemblyCache } from "./dis-cache.js";
import { loadDumpRows, loadObjectRows } from "./row-source.js";
import { buildScreenLine } from "./screen.js";
import { buildShiftDiff } from "./shift-align.js";
import { INGEST_SCHEMA, SweepError } from "./sweep.js";
import { sorted, splitlines, isInputError, osErrorText } from "./py.js";
import { isReportedError } from "./py-extra.js";

export const CONTROL_SITE = "control";

/** One variant's object, gate line and score -- or why there is none. */
export class VariantResult {
  constructor({ key, description, object_path, screen = null, rows_away = null, inserted = 0, deleted = 0, replaced = 0, paired_mismatches = 0, missing = null }) {
    Object.assign(this, { key, description, object_path, screen, rows_away, inserted, deleted, replaced, paired_mismatches, missing });
    Object.freeze(this);
  }
  get scored() { return this.rows_away !== null; }
  asDict() {
    return { ...this.key.asDict(), description: this.description, object: this.object_path, missing: this.missing, rows_away: this.rows_away,
      inserted: this.inserted, deleted: this.deleted, replaced: this.replaced, paired_mismatches: this.paired_mismatches,
      screen: this.screen ? this.screen.asDict() : null };
  }
}

/** A whole sweep, read back and ranked. */
export class IngestResult {
  constructor({ manifest, target, results, control, target_rows }) {
    Object.assign(this, { manifest, target, results, control, target_rows });
    Object.freeze(this);
  }
  get scored() { return this.results.filter((r) => r.scored); }
  get missing() { return this.results.filter((r) => !r.scored); }
  get ranked() { return sorted(this.scored, (r) => [r.rows_away !== null ? r.rows_away : 2 ** 30, r.key.label]); }
  /** Rows better than the control (positive = the removed construct cost that much). */
  price(item) {
    if (!this.control || this.control.rows_away === null) return null;
    if (item.rows_away === null) return null;
    return this.control.rows_away - item.rows_away;
  }
  asDict() {
    return {
      schema: INGEST_SCHEMA,
      generator: this.manifest.generator,
      base: this.manifest.base,
      base_sha256: this.manifest.base_sha256,
      target: this.target,
      target_rows: this.target_rows,
      control: this.control ? this.control.asDict() : null,
      scored_count: this.scored.length,
      missing_count: this.missing.length,
      results: this.ranked.map((r) => ({ ...r.asDict(), price: this.price(r) })),
      missing: this.missing.map((r) => r.asDict()),
      dropped: this.manifest.dropped.map((d) => ({ ...d })),
      coverage: ingestCoverage(this).asDict(),
      limits: [...this.manifest.limits],
    };
  }
}

/** The manifest's coverage, reduced by whatever failed to build (never credited as excluded). */
export function ingestCoverage(result) {
  const d = result.manifest.coverage;
  return new SweepCoverage({ basis: d.basis, space: d.space, covered: result.scored.length, step: d.step, excluded: d.excluded });
}

function load(p, { dumps, objdump, symbol, section, cache, cwd }) {
  const abs = path.resolve(cwd, p);
  if (dumps) return loadDumpRows(abs, { symbol });
  return loadObjectRows(abs, { objdump, symbol, section, cache });
}

const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };

/** Gate and score every built variant of one sweep. */
export async function ingestSweep(manifest, { objects, target, suffix = ".o", dumps = false, target_dumps = false, objdump = null, symbol = null,
  section = ".text", slot = null, cache_directory = null, cwd = process.cwd(), env = process.env }) {
  const directory = String(objects);
  const abs = (p) => path.resolve(cwd, p);
  if (!isDir(abs(directory))) {
    throw new SweepError(`${directory} is not a directory. --objects names the directory the project's compile-one wrapper wrote the built variants into.`);
  }
  const cache = cache_directory ? new DisassemblyCache({ directory: abs(String(cache_directory)) }) : null;
  const targetRows = load(String(target), { dumps: target_dumps, objdump, symbol, section, cache, cwd, env });
  const results = [];
  for (const variant of manifest.variants) {
    const candidate = path.join(directory, `${variant.stem}${suffix}`);
    if (!isFile(abs(candidate))) {
      results.push(new VariantResult({ key: variant.key, description: variant.description, object_path: null, missing: `no object at ${candidate}` }));
      continue;
    }
    let rows;
    try {
      rows = load(candidate, { dumps, objdump, symbol, section, cache, cwd, env });
    } catch (e) {
      if (!isInputError(e) && !isReportedError(e)) throw e;
      results.push(new VariantResult({ key: variant.key, description: variant.description, object_path: candidate,
        missing: `unreadable: ${e.code && /^E[A-Z]+$/.test(e.code) ? osErrorText(e) : e.message}` }));
      continue;
    }
    const diff = buildShiftDiff(targetRows, rows);
    const screen = await buildScreenLine(rows, { label: variant.key.label, path: dumps ? null : abs(candidate), target: targetRows, slot });
    results.push(new VariantResult({ key: variant.key, description: variant.description, object_path: candidate, screen,
      rows_away: diff.rows_away, inserted: diff.inserted, deleted: diff.deleted, replaced: diff.replaced, paired_mismatches: diff.paired_mismatches }));
  }
  const control = results.find((r) => r.key.site === CONTROL_SITE && r.scored) ?? null;
  return new IngestResult({ manifest, target: String(target), results, control, target_rows: targetRows.length });
}

const pad = (s, n) => String(s).padEnd(n);
const rjust = (s, n) => String(s).padStart(n);

/** Render the ingest report: the ranked family, then everything it lost. */
export function ingestLines(result, { limit = 20 } = {}) {
  const manifest = result.manifest;
  const lines = [
    `sweep ${manifest.generator}: ${manifest.base} -> ${result.target}`,
    `base sha256 ${manifest.base_sha256.slice(0, 16)}  ${result.scored.length} scored, ${result.missing.length} unbuilt, ${manifest.dropped.length} refused by the generator`,
    "",
  ];
  if (result.control) {
    const screen = result.control.screen;
    lines.push(`control (the base, unedited): rows_away=${result.control.rows_away}  ${screen ? screen.render() : ""}`);
    lines.push("");
  }
  lines.push(" rows  price  ni    frame  coset  class site                 carrier");
  const ranked = result.ranked;
  for (const item of ranked.slice(0, limit)) lines.push(resultRow(item, { price: result.price(item) }));
  if (ranked.length > limit) lines.push(` ... ${ranked.length - limit} more scored variant(s); --limit 0 prints every row`);
  if (result.control && manifest.generator === "regress") lines.push("", ...priceLines(result));
  const missing = result.missing;
  if (missing.length) {
    lines.push("", `unbuilt (${missing.length}):`);
    for (const item of missing.slice(0, limit)) {
      let reason = splitlines(item.missing || "");
      if (!reason.length) reason = [""];
      const more = reason.length === 1 ? "" : ` (+${reason.length - 1} more line(s))`;
      lines.push(`  ${item.key.label}  ${reason[0]}${more}`);
    }
    if (missing.length > limit) lines.push(`  ... ${missing.length - limit} more`);
  }
  if (manifest.dropped.length) {
    lines.push("", `refused by the generator (${manifest.dropped.length}):`);
    for (const entry of manifest.dropped.slice(0, limit)) lines.push(`  ${entry.site ?? "?"}  ${entry.reason ?? ""}`);
    if (manifest.dropped.length > limit) lines.push(`  ... ${manifest.dropped.length - limit} more`);
  }
  const coset = result.scored.filter((r) => r.screen && r.screen.rotated);
  if (coset.length) {
    lines.push("", `COSET: ${coset.length} scored variant(s) sit at a rotated scratch ring. A ring-quotienting scorer reads them as better `
      + "than they are; do not record one as a win on that number.");
  }
  lines.push("", ingestCoverage(result).sentence());
  return lines;
}

function priceRow(price) {
  if (price === null) return "-";
  return price > 0 ? `+${price}` : String(price);
}

function resultRow(item, { price }) {
  const screen = item.screen;
  const instructions = screen ? String(screen.instructions) : "-";
  const frame = screen && screen.frame !== null && screen.frame !== undefined ? String(screen.frame) : "-";
  const coset = screen ? (screen.coset || "-") : "-";
  return ` ${rjust(String(item.rows_away), 4)}  ${rjust(priceRow(price), 5)}  ${pad(instructions, 5)} ${pad(frame, 6)} ${pad(coset, 6)} `
    + `${pad(item.key.generator_class, 5)} ${pad(item.key.site.slice(0, 20), 20)} ${item.key.carrier}`;
}

function priceLines(result) {
  const lines = ["what each construct costs on the base as it stands now:"];
  const singles = result.ranked.filter((r) => r.key.site !== CONTROL_SITE && !r.key.site.includes("+"));
  if (!singles.length) return [...lines, "  (no single-construct removal scored)"];
  for (const item of sorted(singles, (r) => r.key.site)) {
    const price = result.price(item);
    if (price === null) continue;
    const verdict = price > 0 ? `COSTS ${price} row(s): removing it improves the base`
      : price === 0 ? "free: removing it changes nothing measurable" : `EARNS ${-price} row(s): it is load-bearing`;
    lines.push(`  ${pad(item.key.site, 20)} ${pad(item.description.slice(0, 44), 44)} ${verdict}`);
  }
  return lines;
}

/** Count the family by generator class, for a one-line census. */
export function summarize(rows) {
  const counts = {};
  for (const r of rows) counts[r.key.generator_class] = (counts[r.key.generator_class] ?? 0) + 1;
  return counts;
}
