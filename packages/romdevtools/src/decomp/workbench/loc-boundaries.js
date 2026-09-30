// loc-boundaries.js - statement-line (`.loc`) boundaries under a `schedule`
// residual. cfe takes each statement's line from its preprocessed input, and
// uopt/ugen treat a statement line boundary as a scheduling barrier even at
// -g0; given the candidate's ugen listing this reports, per
// schedule-divergent site, the `.loc` lines of the instructions involved.
// Anything the listing cannot pair is reported unmapped, never guessed.
//
// Plain JS ESM + JSDoc.

import { SequenceMatcher } from "./difflib.js";
import { ValueError, splitlines, strip, splitWs, strRepr } from "./py.js";
import { nextSteps } from "./field-guide.js";

export const LOC_BOUNDARIES_SCHEMA = "decomp-workbench-loc-boundaries-v1";
export const PLAYBOOK = "line-assignment-probe";
const SCHEDULE = "schedule";

export const MISSING_LISTING_STEPS = Object.freeze([
  "statement lines are not in evidence here: re-run with "
    + "--candidate-listing LISTING.s to test whether the reordered instructions "
    + "straddle a .loc statement boundary (field guide lever 23).",
  "that listing is the assembly ugen wrote for this candidate: keep it with "
    + "`cc -K`, which leaves the driver's intermediates beside the object, or "
    + "run `ugen -l` directly.",
]);

const ENT_RE = /^\s*\.ent\s+(?<name>[A-Za-z_.$][\w.$]*)/;
const END_RE = /^\s*\.end\s+(?<name>[A-Za-z_.$][\w.$]*)/;
const LABEL_RE = /^\s*(?<label>[A-Za-z_.$][\w.$]*)\s*:\s*(?<rest>.*)$/s;
const LISTING_FILE_RE = /^\s*\.file\s+(?:(?<number>\d+)\s+)?(?<file>"(?:[^"\\]|\\.)*")/;
const LISTING_LOC_RE = /^\s*\.loc\s+(?<file>\d+)\s+(?<line>\d+)(?:\s+(?<column>\d+))?/;

/** Decode a C-style quoted filename literal. */
function quotedPath(value) {
  const body = value.slice(1, -1);
  return body.replace(/\\(x[0-9a-fA-F]{2}|[0-7]{1,3}|u[0-9a-fA-F]{4}|.)/gs, (_, e) => {
    const simple = { n: "\n", t: "\t", r: "\r", "\\": "\\", "'": "'", '"': '"', a: "\x07", b: "\b", f: "\f", v: "\v", "\n": "" };
    if (e in simple) return simple[e];
    if (e[0] === "x") return String.fromCharCode(parseInt(e.slice(1), 16));
    if (e[0] === "u") return String.fromCharCode(parseInt(e.slice(1), 16));
    if (/^[0-7]+$/.test(e)) return String.fromCharCode(parseInt(e, 8));
    return "\\" + e;
  });
}

export class ListingInstruction {
  constructor({ index, mnemonic, text, file, file_index, line, listing_line }) {
    Object.assign(this, { index, mnemonic, text, file, file_index, line, listing_line });
    Object.freeze(this);
  }
  asDict() {
    return { index: this.index, mnemonic: this.mnemonic, text: this.text, file: this.file, file_index: this.file_index, line: this.line, listing_line: this.listing_line };
  }
}

export class ListingFunction {
  constructor({ name, instructions, start_line, end_line }) { Object.assign(this, { name, instructions, start_line, end_line }); Object.freeze(this); }
  get lines() { return this.instructions.map((i) => i.line); }
}

function normalized(text) {
  const stripped = strip(text);
  if (!stripped) return "";
  const parts = splitWs(stripped, 1);
  const mnemonic = parts[0].toLowerCase();
  if (parts.length === 1) return mnemonic;
  return `${mnemonic} ${splitWs(parts[1]).join("").toLowerCase()}`;
}

function mnemonicOf(text) { const s = strip(text); return s ? splitWs(s, 1)[0].toLowerCase() : ""; }
function stripComment(line) { const i = line.indexOf("#"); return i < 0 ? line : line.slice(0, i); }

/** Every `.ent`-delimited function of a ugen listing, in order. */
export function parseListing(text) {
  const files = new Map();
  const functions = [];
  let openName = null, openLine = 0, collected = [];
  const loose = [];
  let fileIndex = null, lineNumber = null, lastLine = 0;
  const record = (target, body, physical) => {
    target.push(new ListingInstruction({ index: target.length, mnemonic: mnemonicOf(body), text: splitWs(body).join(" "),
      file: fileIndex !== null ? files.get(fileIndex) ?? null : null, file_index: fileIndex, line: lineNumber, listing_line: physical }));
  };
  splitlines(text).forEach((raw, idx) => {
    const physical = idx + 1;
    lastLine = physical;
    let stripped = strip(stripComment(raw));
    if (!stripped) return;
    if (stripped.startsWith(".")) {
      const loc = LISTING_LOC_RE.exec(stripped);
      if (loc) { fileIndex = parseInt(loc.groups.file, 10); lineNumber = parseInt(loc.groups.line, 10); return; }
      const fd = LISTING_FILE_RE.exec(stripped);
      if (fd) {
        const number = fd.groups.number;
        const index = number ? parseInt(number, 10) : (files.size ? Math.max(...files.keys()) : 0) + 1;
        files.set(index, quotedPath(fd.groups.file));
        return;
      }
      const entry = ENT_RE.exec(stripped);
      if (entry) { openName = entry.groups.name; openLine = physical; collected = []; return; }
      const exit = END_RE.exec(stripped);
      if (exit && openName !== null) {
        functions.push(new ListingFunction({ name: openName, instructions: collected, start_line: openLine, end_line: physical }));
        openName = null; collected = [];
        return;
      }
      return;
    }
    const label = LABEL_RE.exec(stripped);
    if (label) {
      stripped = strip(label.groups.rest);
      if (!stripped || stripped.startsWith(".")) return;
    }
    record(openName !== null ? collected : loose, stripped, physical);
  });
  if (openName !== null) functions.push(new ListingFunction({ name: openName, instructions: collected, start_line: openLine, end_line: lastLine }));
  if (!functions.length && loose.length) functions.push(new ListingFunction({ name: "", instructions: loose, start_line: 1, end_line: lastLine }));
  return functions;
}

export function listingFunctionNames(functions) { return functions.map((f) => f.name || "<unnamed>").join(", ") || "none"; }

export function selectFunction(functions, symbol) {
  if (!functions.length) {
    throw new ValueError("the listing holds no instructions; expected ugen assembly with .ent/.end and .loc records (cc -K keeps it, ugen -l writes it)");
  }
  if (symbol !== null && symbol !== undefined) {
    const hit = functions.find((f) => f.name === symbol);
    if (hit) return hit;
    throw new ValueError(`function ${strRepr(symbol)} is not in the listing; it holds: ${listingFunctionNames(functions)}`);
  }
  if (functions.length > 1) throw new ValueError(`the listing holds several functions and no --symbol was given; it holds: ${listingFunctionNames(functions)}`);
  return functions[0];
}

/** The listing index for each candidate instruction, or null. */
export function mapToListing(candidate, fn) {
  const listing = fn.instructions;
  const left = candidate.map(normalized), right = listing.map((i) => normalized(i.text));
  const mapping = new Array(candidate.length).fill(null);
  for (const [tag, ls, le, rs, re] of new SequenceMatcher(left, right, { autojunk: false }).getOpcodes()) {
    if (tag === "equal") { for (let o = 0; o < le - ls; o++) mapping[ls + o] = rs + o; continue; }
    if (tag === "delete" || tag === "insert") continue;
    const inner = new SequenceMatcher(candidate.slice(ls, le).map(mnemonicOf), listing.slice(rs, re).map((i) => i.mnemonic), { autojunk: false }).getOpcodes();
    for (const [it, as, ae, bs] of inner) {
      if (it !== "equal") continue;
      for (let o = 0; o < ae - as; o++) mapping[ls + as + o] = rs + bs + o;
    }
  }
  return mapping;
}

export class SiteAnnotation {
  constructor({ site, hunk, rows, candidate_range, window, widened, lines, mapped, unmapped, status }) {
    Object.assign(this, { site, hunk, rows, candidate_range, window, widened, lines, mapped, unmapped, status });
    Object.freeze(this);
  }
  get boundary() { return this.status === "boundary"; }
  get decidable() { return this.status === "boundary" || this.status === "same-line"; }
  get distinct_lines() { return [...new Set(this.lines.filter((l) => l !== null))].sort((a, b) => a - b); }
  asDict() {
    return { site: this.site, hunk: this.hunk, rows: [...this.rows], candidate: [...this.candidate_range], window: [...this.window],
      widened: this.widened, lines: [...this.lines], distinct_lines: this.distinct_lines, mapped: this.mapped, unmapped: this.unmapped,
      status: this.status, boundary: this.boundary };
  }
}

export class LocBoundaryReport {
  constructor({ listing, function: fn, listing_instructions, candidate_instructions, mapped_instructions, sites, target_only_hunks, schedule_rows }) {
    Object.assign(this, { listing, function: fn, listing_instructions, candidate_instructions, mapped_instructions, sites, target_only_hunks, schedule_rows });
    Object.freeze(this);
  }
  get boundary_sites() { return this.sites.filter((s) => s.boundary).length; }
  get decidable_sites() { return this.sites.filter((s) => s.decidable).length; }
  get unmapped_sites() { return this.sites.length - this.decidable_sites; }
  get majority() { return this.decidable_sites > 0 && this.boundary_sites * 2 > this.decidable_sites; }
  get summary_line() {
    if (!this.schedule_rows) return "no aligned row is schedule-class here, so there is no reordering for a statement line to explain";
    if (!this.sites.length) return "no schedule-divergent site carries a candidate instruction; there is nothing for a listing to attribute to a statement";
    return `${this.boundary_sites} of ${this.sites.length} schedule-divergent sites sit at statement-line boundaries (.loc changes between reordered instructions)`;
  }
  asDict() {
    return { schema: LOC_BOUNDARIES_SCHEMA, listing: this.listing, function: this.function, listing_instructions: this.listing_instructions,
      candidate_instructions: this.candidate_instructions, mapped_instructions: this.mapped_instructions, schedule_rows: this.schedule_rows,
      sites: this.sites.map((s) => s.asDict()), boundary_sites: this.boundary_sites, decidable_sites: this.decidable_sites,
      unmapped_sites: this.unmapped_sites, target_only_hunks: [...this.target_only_hunks], majority: this.majority,
      playbook: this.majority ? PLAYBOOK : null, summary: this.summary_line };
  }
}

/** A count out of the view's per-class tally, whatever container it is. */
export function countOf(counts, key) {
  if (!counts) return 0;
  if (typeof counts.get === "function") return counts.get(key) ?? 0;
  return Object.prototype.hasOwnProperty.call(counts, key) ? counts[key] : 0;
}

/** How many aligned rows the view classified as `schedule`. */
export function scheduleClassCount(view) { return countOf(view.counts, SCHEDULE); }

function candidateAssembly(view) {
  const stream = new Array(view.candidate_instructions).fill("");
  for (const row of view.rows) {
    if (row.candidate_index !== null && row.candidate_index !== undefined && row.candidate !== null && row.candidate !== undefined) {
      if (row.candidate_index >= 0 && row.candidate_index < stream.length) stream[row.candidate_index] = row.candidate;
    }
  }
  return stream;
}

function scheduleHunks(view) {
  const found = [];
  for (const h of view.hunks) {
    const rows = view.rows.slice(h.start, h.end + 1);
    if (rows.some((r) => r.classification === SCHEDULE)) found.push([h.hunk, [h.start, h.end]]);
  }
  return found;
}

/** Annotate the view's schedule-divergent sites with their `.loc` lines. */
export function annotateScheduleSites(view, listingText, { listing_name, symbol = null }) {
  const functions = parseListing(listingText);
  const fn = selectFunction(functions, symbol || view.symbol);
  const candidate = candidateAssembly(view);
  const mapping = mapToListing(candidate, fn);
  const sites = [], targetOnly = [];
  for (const [number, [start, end]] of scheduleHunks(view)) {
    const indexes = view.rows.slice(start, end + 1).map((r) => r.candidate_index).filter((i) => i !== null && i !== undefined);
    if (!indexes.length) { targetOnly.push(number); continue; }
    const low = Math.min(...indexes), high = Math.max(...indexes);
    const widened = high - low < 1;
    const wl = widened ? Math.max(0, low - 1) : low;
    const wh = widened ? Math.min(candidate.length - 1, high + 1) : high;
    const lines = [];
    for (let i = wl; i <= wh; i++) { const li = mapping[i]; lines.push(li === null ? null : fn.instructions[li].line); }
    const mapped = lines.filter((l) => l !== null).length;
    const unmapped = lines.length - mapped;
    const distinct = new Set(lines.filter((l) => l !== null));
    const status = distinct.size > 1 ? "boundary" : mapped === 0 ? "unmapped" : unmapped ? "undetermined" : "same-line";
    sites.push(new SiteAnnotation({ site: sites.length + 1, hunk: number, rows: [start, end], candidate_range: [low, high], window: [wl, wh],
      widened, lines, mapped, unmapped, status }));
  }
  return new LocBoundaryReport({ listing: listing_name, function: fn.name, listing_instructions: fn.instructions.length,
    candidate_instructions: candidate.length, mapped_instructions: mapping.filter((m) => m !== null).length, sites,
    target_only_hunks: targetOnly, schedule_rows: scheduleClassCount(view) });
}

const plural = (count, noun) => (count === 1 ? `${count} ${noun}` : `${count} ${noun}s`);

/** The footer lines this report adds to the aligned view's `next:`. */
export function reportGuidance(report) {
  if (!report.sites.length) return [report.summary_line];
  const leadIn = [report.summary_line];
  if (report.unmapped_sites) leadIn.push(`${plural(report.unmapped_sites, "site")} could not be attributed to a statement; the majority below is over the sites that could.`);
  if (!report.decidable_sites) {
    leadIn.push("no site could be attributed to a statement line at all: check that this listing is the one that produced this candidate. Until "
      + "it is, nothing above rules the mechanism in or out.");
    return leadIn;
  }
  if (!report.majority) {
    leadIn.push("the reordered instructions mostly share one .loc line, so preprocessor line assignment does not own this residual; stay on "
      + "playbook=g0-schedule-probe.");
    return leadIn;
  }
  leadIn.push("the reordered instructions carry different statement lines: uopt and ugen honor statement line boundaries even at -g0, so this is a "
    + "preprocessor line-assignment residual, not a compiler-version one.");
  return [...nextSteps(PLAYBOOK, { lead_in: leadIn })];
}

const lineCell = (v) => (v === null ? "?" : String(v));

/** Render the statement-line section, in the vocabulary of the JSON keys. */
export function renderLocBoundaries(report, painter = null) {
  const bold = painter && typeof painter.bold === "function" ? (s) => painter.bold(s) : (s) => s;
  const lines = ["", bold("STATEMENT LINES") + "  " + [["listing", report.listing], ["function", report.function || "<unnamed>"],
    ["listing_instructions", report.listing_instructions], ["candidate_instructions", report.candidate_instructions],
    ["mapped_instructions", report.mapped_instructions]].map(([k, v]) => `${k}=${v}`).join(" ")];
  if (!report.sites.length && !report.target_only_hunks.length) { lines.push(`  ${report.summary_line}`); return lines; }
  for (const s of report.sites) {
    const detail = [["site", s.site], ["hunk", s.hunk], ["candidate", `${s.candidate_range[0]}..${s.candidate_range[1]}`],
      ["window", `${s.window[0]}..${s.window[1]}`], ["widened", s.widened ? "yes" : "no"], ["unmapped", s.unmapped],
      ["lines", s.lines.map(lineCell).join(",")], ["status", s.status]];
    lines.push("  " + detail.map(([k, v]) => `${k}=${v}`).join(" "));
  }
  if (report.sites.some((s) => s.widened)) {
    lines.push("  widened=yes: the hunk covers one candidate instruction, so the window takes one instruction on each side - what it was reordered past.");
  }
  if (report.sites.some((s) => s.unmapped)) {
    lines.push("  ?: that instruction is not in the listing (a macro as1 expanded, a delay slot as1 filled). It is never guessed at by position.");
  }
  if (report.target_only_hunks.length) {
    lines.push(`  ${plural(report.target_only_hunks.length, "hunk")} hold no candidate instruction (${report.target_only_hunks.join(", ")}): the candidate's listing cannot `
      + "say which statement the target's instruction came from. Not counted as sites.");
  }
  if (report.unmapped_sites) lines.push(`  ${plural(report.unmapped_sites, "site")} could not be attributed to a statement and are excluded from the majority.`);
  lines.push(`  ${report.summary_line}`);
  return lines;
}
