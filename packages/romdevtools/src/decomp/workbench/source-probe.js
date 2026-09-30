// source-probe.js - two source-level probes: are two reads of a local the
// same value (probe-equiv), and where can a statement that emits nothing
// change the allocation (probe-deadread: a discarded read adds an occurrence
// to the variable's web while leaving no trace in the object). Both are
// probes over the text and the block structure, not proofs, and every limit
// is printed with the report.
//
// Plain JS ESM + JSDoc.

import fs from "node:fs";
import path from "node:path";
import { sorted, strip, lstrip, splitlines, strRepr, osErrorText } from "./py.js";
import { CSourceError, declarationLine, definitionLines, identifiers, reads, scanStatements, stripNoncode, takesAddress } from "./csource.js";

export const EQUALITY_SCHEMA = "decomp-workbench-value-equality-v1";
export const DEADREAD_SCHEMA = "decomp-workbench-dead-read-v1";

export const EQUALITY_LIMITS = Object.freeze([
  "Definitions are found by text: an assignment, a compound assignment, an increment, or an address-of. A write through a pointer the text does not spell is not seen.",
  "A callee can only write a local whose address escapes, so the purity argument is exactly the address-of check -- and it is a whole-file check, not a per-call one.",
  "`goto` is not followed, and neither is `switch` fallthrough. A label or a jump inside a range makes textual order stop describing the control flow, and the range is flagged rather than trusted.",
  "A loop back-edge means a read late in the body and a read early in it are not one range, even with no definition between them in the text.",
  "Nothing here reads types, so a union member or a pun that reaches the same storage under another name is a different identifier to this probe.",
]);

export const DEADREAD_LIMITS = Object.freeze([
  "A candidate is a position where the variable is in scope and structurally reached by a definition. Whether the construct actually moves the allocator is measured by building it, not decided here.",
  "Positions inside a loop body are listed separately and never ranked first: the same construct that costs nothing outside a loop emitted real code inside one in every case measured.",
  "The spelling table's footprints are one compiler's measurements (IDO 5.3, one function, 3930 builds). Re-measure them before trusting them on another compiler.",
  "Insertion is textual, at the start of the named line. A line holding two statements gets one candidate, at its start.",
]);

/** One way to spell a discarded read, with what it measured. */
export class Spelling {
  constructor(text, footprint, note) { Object.assign(this, { text, footprint, note }); Object.freeze(this); }
  rendered(variable) { return this.text.split("V").join(variable); }
}

export const SPELLINGS = Object.freeze([
  new Spelling("if (V != 0.0f);", "0", "value-guarded; preferred"),
  new Spelling("if (V < 0.0f);", "0", "value-guarded"),
  new Spelling("if (V > 0.0f);", "0", "value-guarded"),
  new Spelling("if (V >= 0.0f);", "0", "value-guarded"),
  new Spelling("if (0.0f < V);", "0", "value-guarded, operands reversed"),
  new Spelling("if ((s32) V);", "0", "value-guarded through an integer cast"),
  new Spelling("if (V);", "0 or +2", "bare; merges with a neighbouring empty guard and can cost its bc1f+nop pair"),
  new Spelling("V;", "0", "INERT: never became an occurrence in any build"),
  new Spelling("(void) V;", "0", "INERT"),
  new Spelling("V = V;", "0", "INERT: a self-assignment is eliminated"),
  new Spelling("V = 0.0f;", "0", "INERT: a dead store is eliminated before it can be an occurrence (986 of 999 positions, zero kills)"),
]);

export const GUARDED = Object.freeze(SPELLINGS.filter((s) => s.note.startsWith("value-guarded")));

const CALL_RE = /(?<![\w.])([A-Za-z_]\w*)\s*\(/g;
const LABEL_RE = /^\s*[A-Za-z_]\w*\s*:\s*(?:$|[^:=])/;

function readLines(p, cwd) {
  let text;
  try { text = new TextDecoder("utf-8", { fatal: false }).decode(fs.readFileSync(path.resolve(cwd, p))); } catch (e) {
    throw new CSourceError(`cannot read ${p}: ${osErrorText(e)}`);
  }
  if (!strip(text)) throw new CSourceError(`${p} is empty`);
  return [splitlines(text), stripNoncode(text)];
}

function requireVariable(code, variable) {
  const declared = declarationLine(code, variable);
  const written = definitionLines(code, variable);
  if (!code.some((line) => identifiers(line).has(variable))) {
    throw new CSourceError(`no line mentions ${strRepr(variable)}. This probe reasons about a local this file declares; check the spelling, and remember that a `
      + "struct or union member is a different identifier to it.");
  }
  return [declared, written];
}

/** Report the ranges over which every read of `variable` is one value. */
export function valueEqualityReport(p, { variable, positions = [], cwd = process.cwd() }) {
  const [, code] = readLines(p, cwd);
  const [declared, written] = requireVariable(code, variable);
  const escapes = takesAddress(code, variable);
  const statements = scanStatements(code);
  const byLine = new Map(statements.map((s) => [s.line, s]));
  const readLinesList = [];
  code.forEach((line, i) => { if (reads(line, variable) && !written.includes(i + 1)) readLinesList.push(i + 1); });
  const labels = [];
  code.forEach((line, i) => { if (LABEL_RE.test(line) || strip(line).startsWith("goto ")) labels.push(i + 1); });
  const boundaries = sorted([...new Set(written)]);
  const ranges = boundaries.map((start, index) => {
    const end = index + 1 < boundaries.length ? boundaries[index + 1] - 1 : code.length;
    const members = readLinesList.filter((n) => start <= n && n <= end);
    const loops = sorted([...new Set(members.flatMap((n) => (byLine.has(n) ? byLine.get(n).loops : [])))]);
    const crossing = labels.filter((n) => start <= n && n <= end);
    return { index: index + 1, defined_at: start, first_line: start, last_line: end, reads: members, read_count: members.length, loops,
      control_breaks: crossing, single_valued: !crossing.length && !loops.length };
  });
  const skip = new Set(["if", "for", "while", "switch", "return", "sizeof"]);
  const calls = sorted([...new Set(code.flatMap((line) => [...line.matchAll(CALL_RE)].map((m) => m[1]).filter((n) => !skip.has(n))))]);
  const report = {
    schema: EQUALITY_SCHEMA, source: String(p), variable, declared_at: declared, definitions: boundaries, reads: readLinesList,
    address_taken_at: escapes, callee_safe: !escapes.length,
    callee_safe_reason: !escapes.length
      ? `${variable}'s address is never taken in this file, so no callee can write it: a call between two reads cannot have changed the value`
      : `${variable}'s address is taken at line(s) ` + escapes.join(", ") + ", so a callee may write it and no range below is a claim about calls",
    called_functions: calls, ranges, limits: [...EQUALITY_LIMITS],
  };
  if (positions.length) report.pairs = pairs(positions, { ranges, byLine, report });
  return report;
}

const rangeOf = (line, ranges) => ranges.find((r) => r.first_line <= line && line <= r.last_line) ?? null;

function pairs(positions, { ranges, byLine, report }) {
  const results = [];
  const ordered = sorted([...new Set(positions)]);
  ordered.forEach((first, index) => {
    for (const second of ordered.slice(index + 1)) {
      const left = rangeOf(first, ranges), right = rangeOf(second, ranges);
      const reasons = [];
      let same = left !== null && right !== null && left === right;
      if (left === null || right === null) reasons.push("one of the lines is before the variable's first definition, so it has no value to compare");
      else if (!same) reasons.push(`a definition at line ${right.defined_at} sits between them, so the second read is a different value`);
      if (same && !report.callee_safe) { same = false; reasons.push(report.callee_safe_reason); }
      if (same && left !== null && left.control_breaks.length) {
        same = false;
        reasons.push("a label or goto between them means textual order does not describe the control flow here");
      }
      if (same && left !== null && left.loops.length) {
        const between = [first, second].filter((l) => byLine.has(l)).flatMap((l) => byLine.get(l).loops);
        if (between.length) { same = false; reasons.push("both reads are inside a loop body, so a back-edge can carry a definition between them"); }
      }
      results.push({ lines: [first, second], same_value: same, verdict: same ? "SAME-VALUE" : "NOT-PROVEN",
        reasons: reasons.length ? reasons : ["no definition between them, and no callee can write a local whose address never escapes"] });
    }
  });
  return results;
}

export const REACH_MODES = Object.freeze(["dominating", "textual"]);

function isStatementPosition(item) {
  const text = item.text;
  if (!text || text.startsWith("#") || text.startsWith("}") || text.startsWith("{")) return false;
  if (text.startsWith("else") || text.startsWith("case ") || text.startsWith("default:")) return false;
  if (LABEL_RE.test(text)) return false;
  return !(text.endsWith(",") || text.endsWith("\\"));
}

const indentOf = (s) => s.slice(0, s.length - lstrip(s).length);

/** List the positions where a zero-footprint discarded read can be tried. */
export function deadReadReport(p, { variable, spellings = GUARDED, limit = null, reach = "dominating", cwd = process.cwd() }) {
  if (!REACH_MODES.includes(reach)) throw new CSourceError(`unknown reach ${strRepr(reach)}; choose ${REACH_MODES.join(" or ")}`);
  const [raw, code] = readLines(p, cwd);
  const [declared, written] = requireVariable(code, variable);
  if (!written.length) {
    throw new CSourceError(`no line in ${p} assigns ${variable}. A discarded read only creates an occurrence where the variable already holds a value; `
      + "at a position no definition reaches, there is nothing to read.");
  }
  const statements = scanStatements(code);
  const byLine = new Map(statements.map((s) => [s.line, s]));
  const definitions = written.filter((n) => byLine.has(n)).map((n) => byLine.get(n));
  const candidates = [];
  const excluded = { "before-any-definition": 0, "not-a-statement": 0, "on-a-definition": 0 };
  for (const item of statements) {
    if (written.includes(item.line)) { excluded["on-a-definition"] += 1; continue; }
    if (!isStatementPosition(item)) { excluded["not-a-statement"] += 1; continue; }
    const reaching = definitions.filter((d) => item.reachedFrom(d)).map((d) => d.line);
    const earlier = written.filter((n) => n < item.line);
    if (!reaching.length && (reach === "dominating" || !earlier.length)) { excluded["before-any-definition"] += 1; continue; }
    candidates.push({ line: item.line, depth: item.depth, in_loop: item.in_loop, reached_by: reaching.length ? reaching : earlier,
      dominated: reaching.length > 0, before: item.text, raw: item.line <= raw.length ? raw[item.line - 1] : "" });
  }
  const ordered = sorted(candidates, (i) => [i.in_loop, !i.dominated, i.line]);
  const shown = limit === null ? ordered : ordered.slice(0, limit);
  for (const entry of shown) {
    const indent = indentOf(String(entry.raw));
    entry.patches = spellings.map((s) => ({ spelling: s.text, insert: indent + s.rendered(variable), footprint: s.footprint }));
  }
  return {
    schema: DEADREAD_SCHEMA, source: String(p), variable, declared_at: declared, definitions: written, statement_positions: statements.length, reach,
    candidate_count: ordered.length, loop_free_count: ordered.filter((i) => !i.in_loop).length, dominated_count: ordered.filter((i) => i.dominated).length,
    excluded, candidates: shown, spellings: SPELLINGS.map((s) => ({ spelling: s.text, footprint: s.footprint, note: s.note })), limits: [...DEADREAD_LIMITS],
  };
}

/** str.splitlines(keepends=True). */
function splitlinesKeep(text) {
  const out = [];
  const re = /\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/g;
  let last = 0, m;
  while ((m = re.exec(text)) !== null) { out.push(text.slice(last, m.index + m[0].length)); last = m.index + m[0].length; }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Write one variant source per candidate, inserting the named spelling. */
export function writeVariants(report, { directory, spelling, variable, source, cwd = process.cwd() }) {
  const chosen = SPELLINGS.find((s) => s.text === spelling);
  if (!chosen) throw new CSourceError(`unknown spelling ${strRepr(spelling)}; choose one of: ${SPELLINGS.map((s) => s.text).join(", ")}`);
  fs.mkdirSync(path.resolve(cwd, directory), { recursive: true });
  const lines = splitlinesKeep(fs.readFileSync(path.resolve(cwd, source), "utf8"));
  const stem = path.basename(source).replace(/\.[^.]*$/, (m) => (m === path.basename(source) ? m : ""));
  const written = [];
  for (const item of report.candidates) {
    const number = parseInt(item.line, 10);
    const indent = indentOf(item.raw);
    const body = [...lines];
    body.splice(number - 1, 0, `${indent}${chosen.rendered(variable)}\n`);
    const out = path.join(directory, `${stem}.L${number}.c`);
    fs.writeFileSync(path.resolve(cwd, out), body.join(""), "utf8");
    written.push({ line: String(number), path: out });
  }
  return written;
}
