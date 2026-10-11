// headline.js - one number for "how far is this candidate from the
// target": the headline is always `words` (positional word differences after
// masking linker-controlled relocation fields); aligned_total and raw appear
// beneath it labelled with what they are for, and every disagreement between
// the three is stated with its cause.
//
// Plain JS ESM + JSDoc.

export const HEADLINE_GLOSS = "positional word differences after masking linker-controlled relocation fields";
export const ROLE_SCORE = "the score";
export const ROLE_ONE_CANDIDATE = "one candidate only";
export const ROLE_NEVER = "never the score";

export class MetricRow {
  constructor({ key, value, role, gloss }) { Object.assign(this, { key, value, role, gloss }); Object.freeze(this); }
  asDict() { return { key: this.key, value: this.value, role: this.role, gloss: this.gloss }; }
}

export class Headline {
  constructor(f) { Object.assign(this, f); Object.freeze(this); }
  get instruction_delta() { return this.candidate_instructions - this.target_instructions; }
  asDict() {
    return { headline_metric: "words", headline_value: this.words, headline_gloss: HEADLINE_GLOSS, matched: this.matched, target: this.target,
      candidate: this.candidate, symbol: this.symbol, target_instructions: this.target_instructions, candidate_instructions: this.candidate_instructions,
      instruction_delta: this.instruction_delta, metrics: this.metrics.map((r) => r.asDict()), metric_disagreements: [...this.disagreements],
      verdict: this.verdict, true_instruction_delta: this.true_instruction_delta, geometry: this.geometry };
  }
}

/** The three counts, ordered by how much they can be trusted. */
export function metricRows(item) {
  return [
    new MetricRow({ key: "words", value: item.word_mismatches, role: ROLE_SCORE, gloss: HEADLINE_GLOSS + "; words=0 is the match" }),
    new MetricRow({ key: "aligned_total", value: item.aligned_total, role: ROLE_ONE_CANDIDATE,
      gloss: "LCS-aligned rows a source change controls; it answers how much of this candidate would have to move, not which of two candidates is closer" }),
    new MetricRow({ key: "raw", value: item.raw_word_mismatches, role: ROLE_NEVER, gloss: "every differing word including relocation-controlled ones, which no source change moves" }),
  ];
}

/** Every way the three counts disagree, each with its cause. */
export function disagreementNotes(item) {
  const notes = [];
  const controlled = (item.raw_difference_breakdown ?? {}).relocation_controlled ?? 0;
  if (item.raw_word_mismatches > item.word_mismatches) {
    const cause = controlled ? `${controlled} relocation-controlled word(s)` : "words whose only differing bits are linker-filled";
    notes.push(`raw=${item.raw_word_mismatches} exceeds words=${item.word_mismatches} by ${item.raw_word_mismatches - item.word_mismatches}: ${cause}. `
      + "The linker owns those bits, so raw cannot reach zero on this pair and words=0 is the real gate.");
  }
  if (item.aligned_gaps) {
    notes.push(`aligned_total=${item.aligned_total} counts rows the aligner paired, and it inserted ${item.aligned_gaps} gap(s) `
      + `(${item.aligned_insertions} insertion(s), ${item.aligned_deletions} deletion(s)). Those are positions the two objects do not share, so this `
      + "aligned_total counts different things from another candidate's and must not be ranked against it.");
  }
  if (item.aligned_total < item.word_mismatches) {
    notes.push(`aligned_total=${item.aligned_total} is ${item.word_mismatches - item.aligned_total} below words=${item.word_mismatches}: the aligner absorbed shifted rows into its gaps, so aligned_total under-reports the work left.`);
  } else if (item.aligned_total > item.word_mismatches) {
    notes.push(`aligned_total=${item.aligned_total} is ${item.aligned_total - item.word_mismatches} above words=${item.word_mismatches}: rows differ at positions where the masked relocation fields agree, so they cost an aligned row and no word.`);
  }
  const delta = item.candidate_instructions - item.target_instructions;
  if (delta) {
    notes.push(`the candidate emits ${Math.abs(delta)} ${delta > 0 ? "more" : "fewer"} instruction(s) than the target. Instruction counts must agree before any of these `
      + "numbers is a measure of allocation or scheduling: every word after the first count difference is shifted, not wrong.");
  }
  return notes;
}

export function buildHeadline(item) {
  return new Headline({ target: item.target, candidate: item.candidate, symbol: item.symbol, words: item.word_mismatches, matched: item.exact,
    target_instructions: item.target_instructions, candidate_instructions: item.candidate_instructions, metrics: metricRows(item),
    disagreements: disagreementNotes(item), verdict: item.verdict, true_instruction_delta: item.true_instruction_delta, geometry: item.geometry });
}

/** The single line a reader is meant to quote. */
export function headlineLine(report) {
  if (report.matched) return "score: 0 words differ \u2014 MATCH";
  return `score: ${report.words} word${report.words === 1 ? "" : "s"} differ (0 = match)`;
}

const signed = (n) => (n >= 0 ? `+${n}` : String(n));

/** Render the headline, the breakdown, and any disagreement notes. */
export function renderHeadline(report, { verbose = false } = {}) {
  const lines = [headlineLine(report)];
  lines.push(`target:    ${report.target}${report.symbol ? ` [${report.symbol}]` : ""}`);
  lines.push(`candidate: ${report.candidate}`);
  if (report.true_instruction_delta || ["structure-mismatch", "schedule-mismatch"].includes(report.verdict)) {
    lines.push(`geometry: extent=${signed(report.true_instruction_delta)} edit=${report.geometry.edit_distance} opcode-edits=${report.geometry.opcode_distance} (search evidence; words remains the score)`);
  }
  lines.push("");
  const width = Math.max(...report.metrics.map((r) => r.key.length));
  const vw = Math.max(...report.metrics.map((r) => String(r.value).length));
  for (const row of report.metrics) {
    const marker = row.role === ROLE_SCORE ? "<-" : "  ";
    lines.push(`  ${row.key.padEnd(width)}  ${String(row.value).padStart(vw)}  ${marker} ${row.role}`);
    if (verbose) lines.push(`  ${" ".repeat(width)}  ${" ".repeat(vw)}     ${row.gloss}`);
  }
  if (report.disagreements.length) {
    lines.push("", "these numbers disagree, and here is why:");
    for (const note of report.disagreements) lines.push(...wrapNote(note));
  } else lines.push("", "the three counts agree; any of them would rank this candidate the same way");
  lines.push("", `verdict: ${report.verdict}`);
  return lines;
}

function wrapNote(note, { width = 74 } = {}) {
  const words = note.split(/\s+/).filter(Boolean);
  const lines = [];
  let current = "  - ";
  for (const word of words) {
    if (current.length + word.length + 1 > width && current.replace(/^[ -]+|[ -]+$/g, "")) { lines.push(current.trimEnd()); current = "    "; }
    current += word + " ";
  }
  if (current.trim()) lines.push(current.trimEnd());
  return lines;
}
