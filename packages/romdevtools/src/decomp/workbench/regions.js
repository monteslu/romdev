// regions.js - attribute differing words to source regions by anchoring the
// candidate object's call relocations (R_MIPS_26 against a named callee) to
// the call expressions in its C source, aligned by name. Each differing row
// is placed BETWEEN the two calls that bracket it, never interpolated to a
// line; open ends and dropped calls are reported, not guessed.
//
// Plain JS ESM + JSDoc.

import { ValueError, sorted, pyInt } from "./py.js";
import { SequenceMatcher } from "./difflib.js";

export const CALL_RELOCATION = "R_MIPS_26";
export const EXCLUDED_CLASSES = Object.freeze(["relocation-layout", "relocation-controlled"]);

const NOT_CALLS = new Set(["if", "else", "for", "while", "switch", "return", "sizeof", "do", "case", "defined", "typedef", "struct", "union",
  "enum", "static", "const", "volatile", "unsigned", "signed", "void", "char", "short", "int", "long", "float", "double", "register", "extern",
  "goto", "break", "continue"]);
const CALL_RE = /\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
const BLOCK_COMMENT_RE = /\/\*[\s\S]*?\*\//g;
const LINE_COMMENT_RE = /\/\/[^\n]*/g;
const STRING_RE = /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'/g;
const signedStr = (n) => (n > 0 ? `+${n}` : String(n));

/** Region attribution could not be performed, with the reason why. */
export class RegionError extends ValueError {
  constructor(message) { super(message); this.name = "ValueError"; }
}

/** One object offset paired with the source line that emitted it. */
export class Anchor {
  constructor({ address, line, symbol }) { Object.assign(this, { address, line, symbol }); Object.freeze(this); }
  asDict() { return { address: this.address, line: this.line, symbol: this.symbol }; }
}

const sortedEntries = (obj) => Object.fromEntries(sorted(Object.entries(obj), (e) => e[0]));

/** One bracket of source, with the differing words attributed to it. */
export class Region {
  constructor({ low_line, high_line, low_symbol, high_symbol, words, classes, first_address }) {
    Object.assign(this, { low_line, high_line, low_symbol, high_symbol, words, classes, first_address });
    Object.freeze(this);
  }
  get width() { return this.low_line === null || this.high_line === null ? null : this.high_line - this.low_line; }
  label(source) {
    if (this.low_line === null && this.high_line === null) return `${source}:(unanchored)`;
    if (this.low_line === null) return `${source}:1-${this.high_line} (before the first call)`;
    if (this.high_line === null) return `${source}:${this.low_line}-end (after the last call)`;
    if (this.low_line === this.high_line) return `${source}:${this.low_line}`;
    return `${source}:${this.low_line}-${this.high_line}`;
  }
  asDict() {
    return { low_line: this.low_line, high_line: this.high_line, low_symbol: this.low_symbol, high_symbol: this.high_symbol,
      words: this.words, classes: sortedEntries(this.classes), first_address: this.first_address, width: this.width };
  }
}

/** Ranked region attribution, with the coverage that qualifies it. */
export class RegionReport {
  constructor({ source, regions, anchors, object_calls, source_calls, dropped, attributed_words, excluded_words,
    caveats = [], warnings = [], true_instruction_delta = null, expected_total = null, reconciled = true }) {
    Object.assign(this, { source, regions, anchors, object_calls, source_calls, dropped, attributed_words, excluded_words,
      caveats, warnings, true_instruction_delta, expected_total, reconciled });
    Object.freeze(this);
  }
  get median_width() {
    const widths = sorted(this.regions.map((r) => r.width).filter((w) => w !== null));
    return widths.length ? widths[Math.floor(widths.length / 2)] : null;
  }
  asDict() {
    return { source: this.source, method: "call-relocation anchoring", regions: this.regions.map((r) => r.asDict()),
      object_calls: this.object_calls, source_calls: this.source_calls, anchors: this.anchors.length, dropped_calls: [...this.dropped],
      attributed_words: this.attributed_words, excluded_words: this.excluded_words, median_bracket_width: this.median_width,
      caveats: [...this.caveats], warnings: [...this.warnings], true_instruction_delta: this.true_instruction_delta,
      expected_total: this.expected_total, reconciled: this.reconciled };
  }
}

/** Blank out comments and string literals, preserving line numbering. */
export function stripNoncode(text) {
  const blank = (m) => [...m].map((c) => (c === "\n" ? "\n" : " ")).join("");
  return text.replace(BLOCK_COMMENT_RE, blank).replace(LINE_COMMENT_RE, blank).replace(STRING_RE, blank);
}

/** [line, callee] for every call-shaped expression, in file order. */
export function sourceCalls(text) {
  const cleaned = stripNoncode(text);
  const calls = [];
  let line = 1, scanned = 0;
  for (const m of cleaned.matchAll(CALL_RE)) {
    if (NOT_CALLS.has(m[1])) continue;
    for (let i = scanned; i < m.index; i++) if (cleaned.charCodeAt(i) === 10) line++;
    scanned = m.index;
    calls.push([line, m[1]]);
  }
  return calls;
}

/** [address, callee] for every call relocation, in emission order. */
export function objectCalls(instructions) {
  const calls = [];
  for (const item of instructions) for (const r of item.relocations) if (r.kind === CALL_RELOCATION && r.symbol) calls.push([item.address, r.symbol]);
  return calls;
}

/** Align the two call sequences by name; keep only unambiguous pairs. */
export function buildAnchors(objectSide, sourceSide) {
  const on = objectSide.map(([, n]) => n), sn = sourceSide.map(([, n]) => n);
  const matcher = new SequenceMatcher(on, sn);
  const anchors = [], dropped = [];
  for (const [tag, i1, i2, j1, j2] of matcher.getOpcodes()) {
    if (tag === "equal") {
      for (let k = 0; k < i2 - i1; k++) {
        const [address, name] = objectSide[i1 + k];
        const [line] = sourceSide[j1 + k];
        anchors.push(new Anchor({ address, line, symbol: name }));
      }
    } else {
      dropped.push(...on.slice(i1, i2), ...sn.slice(j1, j2));
    }
  }
  const monotone = [];
  for (const a of anchors) {
    if (monotone.length && a.line < monotone[monotone.length - 1].line) { dropped.push(a.symbol); continue; }
    monotone.push(a);
  }
  return [monotone, dropped];
}

function bisectLeft(arr, x) {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] < x) lo = mid + 1; else hi = mid; }
  return lo;
}

function bracket(address, addresses, anchors) {
  const p = bisectLeft(addresses, address);
  if (p < addresses.length && addresses[p] === address) return [anchors[p], anchors[p]];
  return [p > 0 ? anchors[p - 1] : null, p < anchors.length ? anchors[p] : null];
}

/** Group differing sites into bracketed regions, ranked by word count. */
export function attributeSites(sites, candidate, anchors) {
  const addresses = anchors.map((a) => a.address);
  const buckets = new Map(), keys = new Map();
  let attributed = 0, excluded = 0;
  for (const site of sites) {
    const cls = String(site.class ?? "");
    if (EXCLUDED_CLASSES.includes(cls)) { excluded += 1; continue; }
    const index = pyInt(site.index);
    const address = index >= candidate.length ? (candidate.length ? candidate[candidate.length - 1].address : 0) : candidate[index].address;
    const [low, high] = bracket(address, addresses, anchors);
    const key = JSON.stringify([low ? low.line : null, high ? high.line : null]);
    if (!buckets.has(key)) { buckets.set(key, []); keys.set(key, [low, high]); }
    buckets.get(key).push(site);
    attributed += 1;
  }
  let regions = [];
  for (const [key, members] of buckets) {
    const [low, high] = keys.get(key);
    const [lowLine, highLine] = JSON.parse(key);
    const classes = new Map();
    for (const m of members) { const c = String(m.class ?? ""); classes.set(c, (classes.get(c) ?? 0) + 1); }
    const addrs = members.filter((m) => pyInt(m.index) < candidate.length).map((m) => candidate[pyInt(m.index)].address);
    regions.push(new Region({ low_line: lowLine, high_line: highLine, low_symbol: low ? low.symbol : null, high_symbol: high ? high.symbol : null,
      words: members.length, classes: Object.fromEntries(sorted([...classes.entries()], (e) => e[0])), first_address: addrs.length ? Math.min(...addrs) : 0 }));
  }
  regions = sorted(regions, (r) => [-r.words, r.first_address]);
  return [regions, attributed, excluded];
}

/** Build the full ranked attribution for one candidate and its source. */
export function buildRegionReport({ source_path, source_text, candidate, sites, instruction_delta = 0, true_instruction_delta = null, expected_total = null }) {
  const objectSide = objectCalls(candidate);
  if (!objectSide.length) {
    throw new RegionError("the candidate object carries no call relocations, so there is nothing to anchor source lines to. Calls to static functions in "
      + "the same translation unit, and calls the compiler inlined, emit no relocation; a function built entirely from them cannot be attributed this way.");
  }
  const sourceSide = sourceCalls(source_text);
  if (!sourceSide.length) throw new RegionError(`no call expressions were found in ${source_path}; check that it is the C source that produced this object`);
  const [anchors, dropped] = buildAnchors(objectSide, sourceSide);
  if (!anchors.length) {
    throw new RegionError(`none of the ${objectSide.length} call relocation(s) in the object matched any of the ${sourceSide.length} call expression(s) in `
      + `${source_path} by name. This usually means the source is not the one that produced this object.`);
  }
  const [regions, attributed, excluded] = attributeSites(sites, candidate, anchors);
  const reconciled = expected_total === null || attributed === expected_total;
  const base = { source: source_path, regions, anchors, object_calls: objectSide.length, source_calls: sourceSide.length, dropped,
    attributed_words: attributed, excluded_words: excluded, true_instruction_delta, expected_total, reconciled };
  const report = new RegionReport(base);
  return new RegionReport({ ...base, caveats: caveatsFor(report, { instruction_delta }), warnings: warningsFor(report) });
}

function warningsFor(report) {
  const w = [];
  if (report.true_instruction_delta) {
    w.push("REGION ANALYSIS UNRELIABLE: target and candidate true instruction "
      + `counts differ (delta ${signedStr(report.true_instruction_delta)}). Every `
      + "site is bracketed by its CANDIDATE address, so regions before the "
      + "first divergence stay valid, but any row after it sits at a "
      + "shifted position and may be bracketed by the wrong pair of calls. "
      + "Resolve the instruction-count delta before trusting this report.");
  }
  if (!report.reconciled) {
    w.push(`RECONCILIATION FAILED: attributed_words (${report.attributed_words}) `
      + `does not equal expected_total (${report.expected_total}). `
      + "attributed_words is an exact count, not an estimate, so this means "
      + "`sites` and the total being checked were not read from the same "
      + "comparison -- a wiring bug upstream of this report, not a property "
      + "of the code being compared. Do not rank on these regions until "
      + "the mismatch is found.");
  }
  return w;
}

function caveatsFor(report, { instruction_delta }) {
  const c = ["attribution is call-relocation anchoring: each row is placed between "
    + "the two calls that bracket it, never interpolated to a line. A row "
    + "between calls 60 lines apart gets a 60-line answer."];
  const unmatched = report.object_calls - report.anchors.length;
  if (unmatched > 0) {
    c.push(`${report.anchors.length} of ${report.object_calls} call relocation(s) `
      + `anchored; ${unmatched} dropped where the object's call order and `
      + "the source's text order disagree. That is normally a nested call "
      + "-- f(g(x)) reads outer-first and emits inner-first -- and dropping "
      + "it is deliberate: a guessed line is worse than a wider bracket.");
  }
  const width = report.median_width;
  if (width !== null) {
    c.push(`median bracket is ${width} source line(s) wide. Static and `
      + "inlined callees emit no relocation, so stretches built from them "
      + "are bracketed only by whatever calls surround them.");
  }
  if (instruction_delta) {
    c.push(`the two objects differ by ${Math.abs(instruction_delta)} instruction(s), `
      + "so rows after the divergence are shifted and their branch "
      + "immediates differ mechanically. Some of the counts below are that "
      + "shadow rather than independent work, and will vanish when the "
      + "count is fixed -- rank with that in mind.");
  }
  if (report.excluded_words) {
    c.push(`${report.excluded_words} relocation-class word(s) excluded: they `
      + "are symbol naming, not emitted code, and no source edit moves them.");
  }
  return c;
}

/** Render the ranked regions, then the coverage that qualifies them. */
export function renderRegionReport(report, { limit = null } = {}) {
  const lines = report.warnings.map((w) => `warning: ${w}`);
  lines.push(`by-region: ${report.attributed_words} differing word(s) across ${report.regions.length} region(s) of ${report.source}`,
    `anchors: ${report.anchors.length} of ${report.object_calls} object call(s) matched against ${report.source_calls} source call expression(s)`, "");
  const shown = limit === null ? report.regions : report.regions.slice(0, limit);
  if (shown.length) {
    const width = Math.max(...shown.map((r) => r.label(report.source).length));
    for (const r of shown) {
      const classes = Object.entries(r.classes).map(([n, c]) => `${n}=${c}`).join(" ");
      lines.push(`  ${r.label(report.source).padEnd(width)}  ${String(r.words).padStart(5)} word(s)  ${classes}`);
    }
  } else lines.push("  (no differing words outside the relocation classes)");
  if (limit !== null && report.regions.length > limit) lines.push(`  (${report.regions.length - limit} further region(s); pass --by-region-limit 0 for all)`);
  if (report.caveats.length) {
    lines.push("", "how to read this:");
    for (const cv of report.caveats) lines.push(...wrap(cv));
  }
  return lines.map((l) => l.replace(/\s+$/, ""));
}

function wrap(text, width = 78) {
  const lines = [];
  let current = "  - ";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (current.length + word.length + 1 > width && current.replace(/^[ -]+|[ -]+$/g, "")) { lines.push(current.replace(/\s+$/, "")); current = "    "; }
    current += word + " ";
  }
  if (current.trim()) lines.push(current.replace(/\s+$/, ""));
  return lines;
}
