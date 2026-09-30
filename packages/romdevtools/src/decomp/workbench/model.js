// model.js - data records shared by the workbench commands: relocations,
// parsed instructions, and the comparison report.
//
// Plain JS ESM + JSDoc.

import path from "node:path";
import fs from "node:fs";
import { canonicalFields } from "./schema.js";
import { splitWs, PyDict } from "./py.js";

/** One relocation attached to an instruction word. */
export class Relocation {
  constructor({ offset, kind, symbol = null }) {
    Object.assign(this, { offset, kind, symbol });
    Object.freeze(this);
  }
  asDict() { return { offset: this.offset, kind: this.kind, symbol: this.symbol }; }
}

/** One instruction parsed from objdump output. */
export class Instruction {
  constructor({ address, word, assembly, relocations = [], local_branch_destination = null }) {
    Object.assign(this, { address, word, assembly, relocations: Object.freeze([...relocations]), local_branch_destination });
    Object.freeze(this);
  }
  get opcode() { return this.assembly ? (splitWs(this.assembly, 1)[0] ?? "") : ""; }
  get word_value() { return parseInt(this.word, 16); }
  asDict() {
    return { address: this.address, word: this.word, assembly: this.assembly,
      relocations: this.relocations.map((r) => r.asDict()), local_branch_destination: this.local_branch_destination };
  }
}

/** Deep copy the way dataclasses.asdict copies containers. */
function copyValue(v) {
  if (Array.isArray(v)) return v.map(copyValue);
  if (v && typeof v === "object") {
    if (typeof v.asDict === "function") return v.asDict();
    if (v instanceof PyDict) return new PyDict([...v.entries()].map(([k, x]) => [k, copyValue(x)]));
    if (v instanceof Map) return new Map([...v].map(([k, x]) => [k, copyValue(x)]));
    const o = {};
    for (const [k, x] of Object.entries(v)) o[k] = copyValue(x);
    return o;
  }
  return v;
}

/** Field order and defaults of the comparison record. */
export const COMPARISON_FIELDS = [
  ["candidate"], ["target"], ["symbol"], ["target_instructions"], ["candidate_instructions"], ["instruction_delta"],
  ["raw_word_mismatches"], ["word_mismatches"], ["aligned_total"], ["aligned_structural"], ["aligned_schedule"],
  ["aligned_register"], ["aligned_constant"], ["aligned_commutative"], ["relocation_metadata_mismatches"],
  ["relocation_target_mismatches"], ["unknown_relocations"], ["opcode_mismatches"], ["normalized_distance"],
  ["register_mismatches"], ["fp_register_mismatches"], ["register_mismatch_ranges"], ["fp_mismatch_ranges"],
  ["target_frame_size"], ["candidate_frame_size"], ["candidate_fp_register_uses"], ["candidate_stack_offsets"],
  ["candidate_sha1"], ["candidate_sha256"], ["exact"], ["structural_exact"], ["raw_difference_breakdown"],
  ["verdict"], ["guidance"],
  ["error", () => null],
  ["relocation_symbol_mismatches", () => 0],
  ["register_diff", () => []], ["diff_sites", () => []], ["diff_site_classes", () => ({})], ["aligned_diff_sites", () => []],
  ["commutative_findings", () => []], ["relocation_target_differences", () => []],
  ["pool_exact", () => true], ["pool_prefix_exact", () => null], ["temp_prefix_exact", () => null],
  ["first_temp_divergence", () => null], ["first_divergent_row", () => null], ["alignment_method", () => "lcs"],
  ["warnings", () => []], ["target_frame_layout", () => ({})], ["candidate_frame_layout", () => ({})],
  ["aligned_insertions", () => 0], ["aligned_deletions", () => 0], ["aligned_gaps", () => 0],
  ["alignment_comparable", () => true], ["alignment_caution", () => null], ["pool_resolution", () => null],
  ["pool_matches", () => 0], ["pool_layout_mismatches", () => 0], ["target_pool_slots", () => 0],
  ["candidate_pool_slots", () => 0], ["target_true_instructions", () => 0], ["candidate_true_instructions", () => 0],
  ["true_instruction_delta", () => 0], ["instruction_count_verified", () => false], ["aligned_row_receipts", () => []],
  ["layout", () => null], ["geometry_front", () => null], ["opcode_distance", () => 0],
];

/** Metrics for one candidate object compared with a target object (mutable). */
export class Comparison {
  constructor(fields) {
    for (const [name, dflt] of COMPARISON_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(fields, name)) this[name] = fields[name];
      else if (dflt) this[name] = dflt();
      else throw new TypeError(`Comparison missing required field '${name}'`);
    }
  }

  asDict() {
    const payload = {};
    for (const [name] of COMPARISON_FIELDS) payload[name] = copyValue(this[name]);
    Object.assign(payload, canonicalFields(this));
    payload.geometry = this.geometry;
    payload.geometry_edit_distance = this.geometry_edit_distance;
    return payload;
  }

  get geometry_edit_distance() {
    return this.layout !== null && this.layout !== undefined ? Math.trunc(Number(this.layout.edit_distance)) : this.normalized_distance;
  }

  get geometry() {
    return { absolute_extent_delta: Math.abs(this.true_instruction_delta), edit_distance: this.geometry_edit_distance, opcode_distance: this.opcode_distance };
  }

  get geometry_vector() { const g = this.geometry; return [g.absolute_extent_delta, g.edit_distance, g.opcode_distance]; }

  get sort_key() {
    return [this.aligned_total, this.word_mismatches, this.unknown_relocations.length, this.relocation_metadata_mismatches,
      this.normalized_distance, this.register_mismatches, Math.abs(this.instruction_delta), this.candidate];
  }

  get raw_sort_key() {
    return [this.word_mismatches, this.raw_word_mismatches, this.unknown_relocations.length, this.relocation_metadata_mismatches,
      this.opcode_mismatches, this.aligned_total, Math.abs(this.instruction_delta), this.candidate];
  }
}

function realpath(p) {
  // Path.resolve(): follow symlinks where the path exists, absolutize otherwise.
  const abs = path.resolve(p);
  try { return fs.realpathSync(abs); } catch {
    // resolve the deepest existing parent, keep the rest literal
    let head = abs, tail = [];
    while (head !== path.dirname(head)) {
      try { return path.join(fs.realpathSync(head), ...tail); } catch { tail.unshift(path.basename(head)); head = path.dirname(head); }
    }
    return abs;
  }
}

/**
 * Return a stable, user-friendly path: relative to `cwd` when inside it,
 * otherwise the path as given.
 * @param {string} p
 * @param {string} [cwd]
 */
export function displayPath(p, cwd = process.cwd()) {
  const value = String(p);
  const resolved = realpath(path.isAbsolute(value) ? value : path.join(cwd, value));
  const base = realpath(cwd);
  if (resolved === base) return ".";
  if (resolved.startsWith(base + path.sep)) return resolved.slice(base.length + 1);
  // Path(str) normalizes redundant separators and "." components.
  return normalizePure(value);
}

function normalizePure(value) {
  if (!value) return ".";
  const abs = value.startsWith("/");
  const parts = value.split("/").filter((x) => x && x !== ".");
  const s = (abs ? "/" : "") + parts.join("/");
  return s || (abs ? "/" : ".");
}

/** Compilation status plus an optional object comparison. */
export class CompileResult {
  constructor({ source, command, returncode, stdout, stderr, object_path, comparison, cache_key = "", cached = false,
    duration_seconds = 0.0, stdout_bytes = 0, stderr_bytes = 0, stdout_truncated = false, stderr_truncated = false,
    artifacts = {}, experiment = null, region = null, signals = [], object_sha256 = null }) {
    Object.assign(this, { source, command, returncode, stdout, stderr, object_path, comparison, cache_key, cached,
      duration_seconds, stdout_bytes, stderr_bytes, stdout_truncated, stderr_truncated, artifacts, experiment, region,
      signals, object_sha256 });
  }

  asDict() {
    const deep = (v) => (v === null || typeof v !== "object" ? v : Array.isArray(v) ? v.map(deep)
      : typeof v.asDict === "function" ? v.asDict() : Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deep(x)])));
    const out = {};
    for (const k of ["source", "command", "returncode", "stdout", "stderr", "object_path", "comparison", "cache_key", "cached",
      "duration_seconds", "stdout_bytes", "stderr_bytes", "stdout_truncated", "stderr_truncated", "artifacts", "experiment",
      "region", "signals", "object_sha256"]) out[k] = deep(this[k]);
    if (this.comparison !== null && this.comparison !== undefined) out.comparison = this.comparison.asDict();
    return out;
  }
}

/**
 * Strip the directory a census's candidates share, and name it once.
 * Returns [name -> label mapping (Map), sentence or null].
 */
export function shortenPaths(names) {
  const identity = () => [new Map(names.map((n) => [n, n])), null];
  if (names.length < 2) return identity();
  const partsOf = (n) => { const abs = n.startsWith("/"); const p = n.split("/").filter((x) => x && x !== "."); return abs ? ["/", ...p] : p; };
  const parts = names.map(partsOf);
  if (parts.some((p) => p.length < 2)) return identity();
  const shared = [];
  const minLen = Math.min(...parts.map((p) => p.length));
  for (let i = 0; i < minLen; i++) {
    const col = new Set(parts.map((p) => p[i]));
    if (col.size !== 1 || shared.length + 1 >= minLen) break;
    shared.push(parts[0][i]);
  }
  if (!shared.length) return identity();
  const join = (list) => (list[0] === "/" ? "/" + list.slice(1).join("/") : list.join("/"));
  const prefix = join(shared);
  const labels = new Map(names.map((n) => [n, partsOf(n).slice(shared.length).join("/")]));
  if (new Set(labels.values()).size !== new Set(names).size) return identity();
  return [labels, `paths are relative to ${prefix}${prefix.endsWith("/") ? "" : "/"}`];
}
