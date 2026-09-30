// staleness.js - whether the artifact in front of you was built from the
// inputs beside it. Reads modification times (and optionally content hashes)
// of artifacts named in build order and reports a derived artifact older
// than something it is derived from. Nothing here rebuilds anything.
//
// Also carries the comparison-facing freshness helpers (`--built-from`,
// `--allow-stale`) the comparison commands share.
//
// Plain JS ESM + JSDoc.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { ValueError } from "./py.js";

export const STALENESS_SCHEMA = "decomp-workbench-staleness-v1";
export const DEFAULT_TOLERANCE_SECONDS = 1.0;
export const STATUSES = Object.freeze(["fresh", "unknown", "missing", "stale"]);

/** `{value:.Nf}` with round-half-even on exact binary ties, like the original. */
function pyFixed(value, digits) {
  const s = value.toFixed(digits);
  const scaled = value * 10 ** digits;
  if (Number.isFinite(scaled) && Math.abs(scaled) < 2 ** 52 && scaled - Math.trunc(scaled) !== 0 && Math.abs(scaled - Math.trunc(scaled)) === 0.5) {
    const lo = Math.floor(scaled), hi = lo + 1;
    const even = lo % 2 === 0 ? lo : hi;
    return (even / 10 ** digits).toFixed(digits);
  }
  return s;
}

function timestamp(seconds) {
  // Rounded to microseconds, then printed to whole seconds (truncated).
  const us = Math.round(seconds * 1e6);
  const whole = Math.floor(us / 1e6);
  return new Date(whole * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** How the original renders a path it was given: `pathlib.Path` spelling. */
export function pathText(p) {
  let s = String(p);
  if (s === "") return ".";
  const abs = s.startsWith("/");
  const lead = /^\/\/(?!\/)/.test(s) ? "//" : abs ? "/" : "";
  const parts = s.split("/").filter((x) => x && x !== ".");
  const body = parts.join("/");
  return lead + body || (abs ? lead : ".");
}

function expanduser(p) {
  const s = String(p);
  if (s === "~" || s.startsWith("~/")) return os.homedir() + s.slice(1);
  return s;
}

/** Return the content hash of one file, or null when it cannot be read. */
export function fileSha256(file) {
  try { return createHash("sha256").update(fs.readFileSync(file)).digest("hex"); } catch { return null; }
}

/** One named file in a build chain, and when it was last written. */
export class Artifact {
  constructor({ path: p, label, exists, mtime = null, size = null, sha256 = null }) {
    Object.assign(this, { path: p, label, exists, mtime, size, sha256 });
    Object.freeze(this);
  }
  get built_at() { return this.mtime === null ? "(missing)" : timestamp(this.mtime); }
  asDict() {
    return { label: this.label, path: this.path, exists: this.exists, mtime: this.mtime, built_at: this.built_at, size: this.size, sha256: this.sha256 };
  }
}

function age(seconds) {
  if (seconds < 90) return `${pyFixed(seconds, 0)}s`;
  if (seconds < 5400) return `${pyFixed(seconds / 60, 0)}m`;
  if (seconds < 172800) return `${pyFixed(seconds / 3600, 1)}h`;
  return `${pyFixed(seconds / 86400, 1)}d`;
}

/** One derived artifact that predates an input it is derived from. */
export class Violation {
  constructor({ input, derived, seconds }) { Object.assign(this, { input, derived, seconds }); Object.freeze(this); }
  get message() {
    return `${this.derived.label} ${this.derived.path} was built ${age(this.seconds)} BEFORE ${this.input.label} `
      + `${this.input.path} was last written (${this.derived.built_at} < ${this.input.built_at})`;
  }
  asDict() {
    return { input: this.input.label, input_path: this.input.path, derived: this.derived.label, derived_path: this.derived.path,
      seconds: Number(this.seconds.toFixed(3)), message: this.message };
  }
}

/** What was compared, when each part of it was built, and whether that holds. */
export class StalenessReport {
  constructor({ artifacts, violations, tolerance_seconds = DEFAULT_TOLERANCE_SECONDS, comparisons = 0 }) {
    Object.assign(this, { artifacts, violations, tolerance_seconds, comparisons });
    Object.freeze(this);
  }
  get missing() { return this.artifacts.filter((a) => !a.exists); }
  get status() {
    if (this.violations.length) return "stale";
    if (this.missing.length) return "missing";
    if (!this.comparisons) return "unknown";
    return "fresh";
  }
  get stale() { return this.violations.length > 0; }
  get fresh() { return this.status === "fresh"; }
  get message() {
    if (this.violations.length) {
      return `${this.violations[0].message}. A comparison against a build older than its inputs measures the previous edit: rebuild, `
        + "or pass --allow-stale to say you meant this one";
    }
    if (this.missing.length) {
      return `freshness unproven: ${this.missing.map((a) => a.path).join(", ")} does not exist, so the build chain could not be checked`;
    }
    if (!this.comparisons) return "freshness unproven: name the inputs these artifacts were built from (--built-from) to have them checked";
    return "every artifact is at least as new as the inputs before it";
  }
  provenanceLines() {
    if (!this.artifacts.length) return [];
    const width = Math.max(...this.artifacts.map((a) => a.label.length));
    return this.artifacts.map((a) => `${a.label.padEnd(width)}  ${a.path}  built ${a.built_at}`);
  }
  lines() {
    const out = ["build freshness: " + this.status, ...this.provenanceLines()];
    for (const v of this.violations) out.push(`STALE: ${v.message}`);
    if (!this.violations.length && this.status !== "fresh") out.push(`note: ${this.message}`);
    return out;
  }
  asDict() {
    return { schema: STALENESS_SCHEMA, status: this.status, stale: this.stale, fresh: this.fresh, tolerance_seconds: this.tolerance_seconds,
      comparisons: this.comparisons, artifacts: this.artifacts.map((a) => a.asDict()), violations: this.violations.map((v) => v.asDict()), message: this.message };
  }
}

function evaluate(artifacts, pairs, tolerance) {
  const violations = [];
  let compared = 0;
  for (const [i, j] of pairs) {
    const earlier = artifacts[i], derived = artifacts[j];
    if (earlier.mtime === null || derived.mtime === null) continue;
    compared += 1;
    const gap = earlier.mtime - derived.mtime;
    if (gap > tolerance) violations.push(new Violation({ input: earlier, derived, seconds: gap }));
  }
  return [violations, compared];
}

function labelFor(index, total, given) {
  if (given) return given;
  if (index === total - 1) return "built";
  return total > 2 ? `input${index + 1}` : "input";
}

/**
 * Stat one artifact, hashing it only when asked. `cwd` resolves a relative
 * path the way the original's process working directory did.
 */
export function artifactFor(p, { label, hashes = false, cwd = process.cwd() }) {
  const shown = pathText(expanduser(p));
  const real = path.resolve(cwd, shown);
  let st;
  try { st = fs.statSync(real, { bigint: true }); } catch { return new Artifact({ path: shown, label, exists: false }); }
  const ns = st.mtimeNs;
  const sec = ns / 1000000000n, nsec = ns % 1000000000n;
  const mtime = Number(sec) + Number(nsec) * 1e-9;
  return new Artifact({ path: shown, label, exists: true, mtime, size: Number(st.size), sha256: hashes ? fileSha256(real) : null });
}

function artifactsOf(paths, { labels, hashes, cwd }) {
  const total = paths.length;
  return paths.map((p, i) => artifactFor(p, { label: labelFor(i, total, labels ? labels[i] : null), hashes, cwd }));
}

/** Check a build chain named in build order, earliest input first. */
export function stalenessReport(paths, { labels = null, hashes = false, tolerance_seconds = DEFAULT_TOLERANCE_SECONDS, cwd = process.cwd() } = {}) {
  if (labels !== null && labels.length !== paths.length) {
    throw new ValueError(`staleness_report got ${paths.length} path(s) and ${labels.length} label(s); they must correspond`);
  }
  const artifacts = artifactsOf(paths, { labels, hashes, cwd });
  const pairs = [];
  for (let later = 0; later < artifacts.length; later++) for (let earlier = 0; earlier < later; earlier++) pairs.push([earlier, later]);
  const [violations, compared] = evaluate(artifacts, pairs, tolerance_seconds);
  return new StalenessReport({ artifacts, violations, tolerance_seconds, comparisons: compared });
}

/** A comparison was asked to trust an artifact older than its inputs. */
export class StaleBuildError extends ValueError {}

/** Refuse a stale comparison, or return the warning that replaces the refusal. */
export function enforceFreshness(report, { allow_stale }) {
  if (!report.stale) return [];
  if (!allow_stale) throw new StaleBuildError(report.message);
  return [...report.violations.map((v) => `warning: ${v.message}`),
    "warning: --allow-stale was given, so this result is about a build that predates its inputs"];
}

/** Check several derived artifacts against one shared set of inputs. */
export function chainReport(derived, inputs, { labels = null, hashes = false, cwd = process.cwd() } = {}) {
  const ordered = [...inputs, ...derived];
  if (labels !== null && labels.length !== ordered.length) throw new ValueError("chain_report labels must match inputs plus derived");
  const artifacts = artifactsOf(ordered, { labels, hashes, cwd });
  const pairs = [];
  for (let earlier = 0; earlier < inputs.length; earlier++) for (let later = inputs.length; later < ordered.length; later++) pairs.push([earlier, later]);
  const [violations, compared] = evaluate(artifacts, pairs, DEFAULT_TOLERANCE_SECONDS);
  return new StalenessReport({ artifacts, violations, tolerance_seconds: DEFAULT_TOLERANCE_SECONDS, comparisons: compared });
}

// ---- the comparison-facing half (`--built-from`, `--allow-stale`) ----

/** Build the report for one comparison's own inputs and outputs. */
export function freshnessReport(args, derived, { labels = [], cwd = process.cwd() } = {}) {
  const inputs = [...(args.built_from ?? [])];
  const inputLabels = inputs.map((_, i) => (inputs.length > 1 ? `source${i + 1}` : "source"));
  return chainReport(derived, inputs, { labels: labels.length ? [...inputLabels, ...labels] : null, cwd });
}

/** Return [report, warnings], refusing a stale build by default. */
export function guardFreshness(args, derived, { labels = [], cwd = process.cwd() } = {}) {
  const report = freshnessReport(args, derived, { labels, cwd });
  return [report, enforceFreshness(report, { allow_stale: !!args.allow_stale })];
}

/** Return [report, warnings] for a command that already ran. Never raises. */
export function freshnessDisplay(args, derived, { labels = [], cwd = process.cwd() } = {}) {
  const report = freshnessReport(args, derived, { labels, cwd });
  if (!report.stale) return [report, []];
  return [report, enforceFreshness(report, { allow_stale: true })];
}

/** Render the report as a namespaced sub-document. */
export function freshnessPayload(report) {
  const body = report.asDict();
  delete body.schema;
  return { staleness: body, staleness_schema: STALENESS_SCHEMA };
}
