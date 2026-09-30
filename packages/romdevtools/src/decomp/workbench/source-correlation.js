// source-correlation.js - join allocator web lines to retained preprocessor
// markers and optional listing .file/.loc directives, without guessed
// provenance: a match is unique, selected, ambiguous or unresolved, and an
// include that merely shares a line number is never promoted to identity.
//
// Plain JS ESM + JSDoc.

import path from "node:path";
import { ValueError, splitlines, sorted, pyInt } from "./py.js";
import { semanticWebs } from "./allocator-analysis.js";
import { optionalInteger } from "./globalcolor.js";

export const SOURCE_CORRELATION_SCHEMA = "decomp-workbench-trace-source-v1";
export const LINE_MARKER_RE = /^\s*#\s*(?:line\s+)?(?<line>\d+)(?:\s+(?<file>"(?:[^"\\]|\\.)*"))?(?:\s|$)/;
export const LISTING_FILE_RE = /^\s*\.file\s+(?:(?<number>\d+)\s+)?(?<file>"(?:[^"\\]|\\.)*")/;
export const LISTING_LOC_RE = /^\s*\.loc\s+(?<file>\d+)\s+(?<line>\d+)(?:\s+(?<column>\d+))?/;

/** Syntax error in a quoted filename (the original's literal parser raised one). */
export class QuotedPathError extends SyntaxError {}

/** Decode a quoted filename with string-literal escape rules. */
export function quotedPath(value) {
  const body = value.slice(1, -1);
  let out = "";
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c !== "\\") { out += c; continue; }
    const n = body[++i];
    if (n === undefined) throw new QuotedPathError(`unterminated string literal: ${value}`);
    const simple = { "\\": "\\", "'": "'", '"': '"', a: "\x07", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v", "\n": "" };
    if (n in simple) { out += simple[n]; continue; }
    if (/[0-7]/.test(n)) { let d = n; while (d.length < 3 && /[0-7]/.test(body[i + 1] ?? "")) d += body[++i]; out += String.fromCharCode(parseInt(d, 8)); continue; }
    if (n === "x") {
      const h = body.slice(i + 1, i + 3);
      if (!/^[0-9a-fA-F]{2}$/.test(h)) throw new QuotedPathError(`(unicode error) truncated \\xXX escape: ${value}`);
      out += String.fromCharCode(parseInt(h, 16)); i += 2; continue;
    }
    if (n === "u" || n === "U") {
      const w = n === "u" ? 4 : 8;
      const h = body.slice(i + 1, i + 1 + w);
      if (!new RegExp(`^[0-9a-fA-F]{${w}}$`).test(h)) throw new QuotedPathError(`(unicode error) truncated \\${n} escape: ${value}`);
      out += String.fromCodePoint(parseInt(h, 16)); i += w; continue;
    }
    out += "\\" + n;
  }
  return out;
}

/** One physical input line under its preprocessor logical location. */
export class SourceLine {
  constructor({ file, line, physical_line, text }) { Object.assign(this, { file, line, physical_line, text }); Object.freeze(this); }
  asDict() { return { file: this.file, line: this.line, physical_line: this.physical_line, text: this.text }; }
}

/** One retained-listing source-location directive. */
export class ListingLocation {
  constructor({ file, file_index, line, column, listing_line }) { Object.assign(this, { file, file_index, line, column, listing_line }); Object.freeze(this); }
  asDict() { return { file: this.file, file_index: this.file_index, line: this.line, column: this.column, listing_line: this.listing_line }; }
}

/** Interpret standard `# N "file"` and `#line N "file"` markers. */
export function parseLineMarkedSource(text, { origin }) {
  let current = origin, logical = 1;
  const out = [];
  splitlines(text).forEach((raw, i) => {
    const m = LINE_MARKER_RE.exec(raw);
    if (m) {
      logical = pyInt(m.groups.line);
      if (m.groups.file !== undefined) current = quotedPath(m.groups.file);
      return;
    }
    out.push(new SourceLine({ file: current, line: logical, physical_line: i + 1, text: raw }));
    logical += 1;
  });
  return out;
}

/** Read GNU-style `.file`/`.loc` evidence from a retained listing. */
export function parseListingLocations(text) {
  const files = new Map();
  let implicit = 1;
  const out = [];
  splitlines(text).forEach((raw, i) => {
    const f = LISTING_FILE_RE.exec(raw);
    if (f) {
      const number = f.groups.number ? pyInt(f.groups.number) : implicit;
      files.set(number, quotedPath(f.groups.file));
      implicit = Math.max(implicit, number + 1);
      return;
    }
    const loc = LISTING_LOC_RE.exec(raw);
    if (!loc) return;
    const index = pyInt(loc.groups.file);
    out.push(new ListingLocation({ file: files.get(index) ?? null, file_index: index, line: pyInt(loc.groups.line),
      column: loc.groups.column !== undefined ? pyInt(loc.groups.column) : null, listing_line: i + 1 }));
  });
  return out;
}

function fileMatches(candidate, requested) {
  if (candidate === requested) return true;
  const parent = path.dirname(requested);
  return (parent === "." || parent === "") && !requested.includes("/") && path.basename(candidate) === requested;
}

/** Join allocator web lines to source and listing records. */
export function correlateTraceSource(trace, { source_text, source_origin, listing_text = null, source_file = null, proc = null }) {
  const sourceByLine = new Map();
  for (const item of parseLineMarkedSource(source_text, { origin: source_origin })) {
    if (!sourceByLine.has(item.line)) sourceByLine.set(item.line, []);
    sourceByLine.get(item.line).push(item);
  }
  const listingByLine = new Map();
  for (const item of listing_text !== null ? parseListingLocations(listing_text) : []) {
    if (!listingByLine.has(item.line)) listingByLine.set(item.line, []);
    listingByLine.get(item.line).push(item);
  }
  const rows = [];
  const counts = { selected: 0, unique: 0, ambiguous: 0, unresolved: 0 };
  for (const web of semanticWebs(trace, { proc })) {
    const detail = web.decision.detail;
    const traceLine = optionalInteger(Object.prototype.hasOwnProperty.call(detail, "line") ? detail.line : null);
    let candidates = [...(sourceByLine.get(traceLine || -1) ?? [])];
    if (source_file !== null) candidates = candidates.filter((i) => fileMatches(i.file, source_file));
    const unique = new Map();
    for (const i of candidates) unique.set(JSON.stringify([i.file, i.line, i.text]), i);
    candidates = sorted([...unique.values()], (i) => [i.file, i.line, i.physical_line]);
    const state = !candidates.length ? "unresolved" : candidates.length === 1 ? (source_file !== null ? "selected" : "unique") : "ambiguous";
    counts[state] += 1;
    let listing = [...(listingByLine.get(traceLine || -1) ?? [])];
    if (candidates.length === 1) {
      const exact = listing.filter((i) => i.file !== null && fileMatches(i.file, candidates[0].file));
      if (exact.length) listing = exact;
    }
    rows.push({ fingerprint: web.fingerprint, confidence: web.confidence, phase: web.decision.phase_tag, force_key: web.decision.force_key,
      trace_local_web: web.decision.web, trace_line: traceLine, state, source_candidates: candidates.slice(0, 8).map((i) => i.asDict()),
      source_candidates_truncated: candidates.length > 8, listing_locations: listing.slice(0, 16).map((i) => i.asDict()),
      listing_locations_truncated: listing.length > 16 });
  }
  return {
    schema: SOURCE_CORRELATION_SCHEMA, evidence: "trace-source-correlation", source_origin, source_file_filter: source_file,
    listing_supplied: listing_text !== null, web_count: rows.length, correlated_webs: counts.selected + counts.unique, states: counts, webs: rows,
    proof: "Trace logical lines were joined to retained preprocessor markers and optional .file/.loc directives. Ambiguous line-only matches "
      + "are preserved and never promoted to source identity.",
  };
}
