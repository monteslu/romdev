// comparison-render.js - shared human and JSON rendering for comparison
// evidence: the summary line, cautions that must print before the numbers,
// acceptance, and the explanation lines.
//
// Plain JS ESM + JSDoc.

import { ALIGNED_CLASS_KEYS } from "./compare.js";
import { summaryLine } from "./schema.js";
import { hex } from "./py.js";

const EM = "\u2014";
export const COMMUTATIVE_SITES = 5;
export const LAYOUT_BLOCKS = 6;

const signed = (n) => (n >= 0 ? `+${n}` : String(n));
const entriesOf = (d) => (d && typeof d.entries === "function" && !Array.isArray(d) && !(Object.getPrototypeOf(d) === Object.prototype) ? [...d.entries()] : Object.entries(d ?? {}));

/** Render the summary line from the shared metric registry. */
export function comparisonLine(item, painter = null) {
  let line = summaryLine(item);
  if (!item.alignment_comparable) {
    line += ` true_insn_delta=${signed(item.true_instruction_delta)} geometry_edit_distance=${item.geometry_edit_distance} opcode_distance=${item.opcode_distance}`;
    if (item.geometry_front !== null && item.geometry_front !== undefined) line += ` geometry_front=${item.geometry_front}`;
  }
  if (!painter || !painter.enabled) return line;
  const token = `verdict=${item.verdict}`;
  if (!line.startsWith(token)) return line;
  return painter.bold("verdict=") + painter.verdict(item.verdict) + line.slice(token.length);
}

export function warningLines(warnings) { return [...warnings].map((w) => `warning: ${w}`); }

export function alignmentCautionLines(item) { return item.alignment_caution ? [item.alignment_caution] : []; }

export function relocationSymbolCautionLines(item) {
  const count = item.relocation_symbol_mismatches;
  if (!count) return [];
  const [noun, verb] = count === 1 ? ["site", "names"] : ["sites", "name"];
  const lines = [
    `relocation-symbol caution: ${count} relocation ${noun} ${verb} a different symbol in each object.`,
    `                           Masking excludes those words, so words=${item.word_mismatches} is a floor, not the residual: a different`,
    "                           symbol at the same site is a different variable being read, and no link resolves it.",
  ];
  if ((item.relocation_target_differences ?? []).some((d) => d.candidate_section_symbol)) {
    lines.push("                           At least one site reaches an anonymous section offset where the target names an object: check");
    lines.push("                           the translation unit does not already define it, or the linked layout shifts.");
  }
  return lines;
}

/** Command acceptance, independent of the evidence verdict: [accepted, basis]. */
export function comparisonAcceptance(item, { cross_rom = false } = {}) {
  if (item.relocation_symbol_mismatches) return [false, "relocation-symbol-mismatch"];
  if (item.exact) return [true, "function-exact"];
  if (cross_rom && item.structural_exact) return [true, "cross-rom-structural"];
  return [false, "mismatch"];
}

/** The raw-object acceptance a decomp.me scratch uses. */
export function scratchScoreAcceptance(item) {
  if (item.raw_word_mismatches) return [false, "raw-instruction-word-mismatch"];
  if (item.relocation_target_mismatches) return [false, "relocation-target-mismatch"];
  if (!item.exact) return [false, "linked-function-mismatch"];
  return [true, "local-score-proxy-exact"];
}

export function scratchComparisonPayload(item) {
  const [scoreExact, basis] = scratchScoreAcceptance(item);
  const payload = comparisonPayload(item, { cross_rom: false });
  Object.assign(payload, {
    accepted: scoreExact, acceptance_basis: basis, acceptance_summary: scratchAcceptanceLine(item),
    exact_scope: "linked-function-after-relocation-field-masking", decomp_me_score_proxy_exact: scoreExact,
    linked_function_exact: item.exact, raw_instruction_words_exact: item.raw_word_mismatches === 0,
    relocation_targets_exact: item.relocation_target_mismatches === 0,
  });
  return payload;
}

export function scratchAcceptanceLine(item) {
  const [accepted] = scratchScoreAcceptance(item);
  if (accepted) return `ACCEPTED ${EM} raw instruction words and relocation targets agree`;
  const reasons = [];
  if (item.raw_word_mismatches) {
    const c = item.raw_word_mismatches;
    reasons.push(`${c} raw instruction ${c === 1 ? "word" : "words"} ${c === 1 ? "differs" : "differ"}`);
  } else if (item.exact) reasons.push("instruction text exact");
  if (item.relocation_target_mismatches) {
    const c = item.relocation_target_mismatches;
    reasons.push(`${c} relocation ${c === 1 ? "target" : "targets"} ${c === 1 ? "differs" : "differ"}`);
  }
  if (!item.exact && !item.raw_word_mismatches) reasons.push("linked function differs");
  return `NOT ACCEPTED ${EM} ` + reasons.join("; ");
}

export function relocationTargetDifferenceLines(item) {
  const diffs = item.relocation_target_differences ?? [];
  if (!diffs.length) return [];
  const lines = [`relocation target differences: ${diffs.length}`];
  const side = (v) => {
    if (!v || typeof v !== "object" || Array.isArray(v)) return "<missing>";
    const symbol = v.symbol || "<none>";
    const addend = Math.trunc(Number(v.addend ?? 0));
    const suffix = addend ? (addend < 0 ? "-" : "+") + hex(Math.abs(addend), 0, { prefix: true }) : "";
    return `offset=0x${hex(Math.trunc(Number(v.offset)))} type=${v.kind} symbol=${symbol}${suffix}`;
  };
  for (const d of diffs) {
    let classification = String(d.difference ?? "symbol");
    if (d.candidate_section_symbol) classification += ", candidate reaches an anonymous section offset";
    lines.push(`  instruction ${d.instruction_index} relocation ${d.relocation_index} (${classification})`);
    lines.push(`    target    ${side(d.target)}`);
    lines.push(`    candidate ${side(d.candidate)}`);
  }
  return lines;
}

/** Command-level acceptance context on a comparison JSON result. */
export function comparisonPayload(item, { cross_rom = false, census = [] } = {}) {
  const [accepted, basis] = comparisonAcceptance(item, { cross_rom });
  const payload = { ...item.asDict(), accepted, acceptance_basis: basis };
  if (census.length) payload.census = census.map((r) => r.asDict());
  return payload;
}

export function rawVersusWordsLines(item) {
  const b = item.raw_difference_breakdown ?? {};
  const controlled = (typeof b.get === "function" ? b.get("relocation_controlled") : b.relocation_controlled) ?? 0;
  if (!controlled || item.raw_word_mismatches <= item.word_mismatches) return [];
  return [
    `raw-vs-words: raw=${item.raw_word_mismatches} exceeds words=${item.word_mismatches} by ${controlled} relocation-controlled word(s):`,
    "              linker-filled bits no source change moves. A raw objdump text diff counts",
    "              them permanently, so words=0 is the real gate, not a byte-identical dump.",
  ];
}

export function trueInstructionLines(item) {
  const lines = [];
  if (item.target_true_instructions !== item.target_instructions) {
    lines.push(`target padding: ${item.target_instructions} reported, ${item.target_true_instructions} true (${item.target_instructions - item.target_true_instructions} pad word(s))`);
  }
  if (item.candidate_true_instructions !== item.candidate_instructions) {
    lines.push(`candidate padding: ${item.candidate_instructions} reported, ${item.candidate_true_instructions} true (${item.candidate_instructions - item.candidate_true_instructions} pad word(s))`);
  }
  return lines;
}

const get = (o, k) => (o && typeof o.get === "function" && !Array.isArray(o) ? o.get(k) : o?.[k]);

export function layoutLines(item) {
  const layout = item.layout;
  if (!layout || (typeof layout === "object" && !Object.keys(layout).length && !(layout.size > 0))) return [];
  const moved = [...(get(layout, "moved_blocks") ?? [])];
  const lines = [
    `layout (shift-tolerant edit script, run automatically on ${item.verdict}):`,
    `  blocks=${get(layout, "block_count")} replaced=${get(layout, "replaced")} inserted=${get(layout, "inserted")} deleted=${get(layout, "deleted")} rows=${get(layout, "target_rows")}->${get(layout, "candidate_rows")} (${signed(Math.trunc(get(layout, "row_delta")))})`,
    `  rows_away=${get(layout, "rows_away")} (${get(layout, "edit_distance")} edit + ${get(layout, "paired_mismatches")} residual) against words=${item.word_mismatches}`,
  ];
  if (!moved.length) {
    lines.push("  moved blocks: none -- the difference is not a permutation, so the positional counts are reading real new or changed code.");
    return lines;
  }
  lines.push(`  moved blocks: ${get(layout, "moved_block_count")} (${get(layout, "moved_rows")} row(s)) present in both objects at different positions`);
  for (const block of moved.slice(0, LAYOUT_BLOCKS)) {
    lines.push(`    ${String(get(block, "rows")).padStart(5)} row(s)  target ${get(block, "target_start")}..${get(block, "target_stop") - 1}  ->  candidate ${get(block, "candidate_start")}..${get(block, "candidate_stop") - 1}  (${signed(Math.trunc(get(block, "displacement")))})`);
  }
  if (moved.length > LAYOUT_BLOCKS) lines.push(`    ... ${moved.length - LAYOUT_BLOCKS} more; the full list is in --json under layout.moved_blocks`);
  lines.push(`  A permutation is a block-order question, not a ${item.word_mismatches}-word one. Run \`align\` for the full script.`);
  return lines;
}

/** Compact, action-oriented explanation lines. */
export function comparisonExplanationLines(item, { cross_rom = false, guidance = true } = {}) {
  const lines = [...trueInstructionLines(item)];
  if (item.target_frame_size !== null && item.target_frame_size !== undefined && item.candidate_frame_size !== null
    && item.candidate_frame_size !== undefined && item.target_frame_size !== item.candidate_frame_size) {
    const difference = Math.abs(item.candidate_frame_size - item.target_frame_size);
    lines.push(`frame mismatch: target=${item.target_frame_size} candidate=${item.candidate_frame_size} (${difference}-byte difference)`);
    const t = item.target_frame_layout, c = item.candidate_frame_layout;
    const nonEmpty = (x) => x && (typeof x.size === "number" ? x.size > 0 : Object.keys(x).length > 0);
    if (nonEmpty(t) && nonEmpty(c)) {
      lines.push(`frame evidence: save-slots=${get(t, "observed_save_bytes")}->${get(c, "observed_save_bytes")} bytes; non-save=${get(t, "non_save_frame_bytes")}->${get(c, "non_save_frame_bytes")} bytes`);
    }
  }
  const aligned = ALIGNED_CLASS_KEYS.filter((k) => item[k]).map((k) => `${k}=${item[k]}`).join(", ");
  if (aligned) lines.push(`aligned residual classes: ${aligned}`);
  if (item.aligned_gaps) lines.push(`alignment gaps: insertions=${item.aligned_insertions} deletions=${item.aligned_deletions} (opcodes=${item.opcode_mismatches}, words=${item.word_mismatches}, raw=${item.raw_word_mismatches})`);
  const breakdown = entriesOf(item.raw_difference_breakdown).map(([n, c]) => `${n}=${c}`).join(", ");
  if (breakdown) lines.push(`raw difference classes: ${breakdown}`);
  lines.push(...layoutLines(item), ...rawVersusWordsLines(item), ...relocationTargetDifferenceLines(item));
  if ((item.diff_sites ?? []).length) {
    const classes = entriesOf(item.diff_site_classes).map(([n, c]) => `${n}=${c}`).join(", ");
    lines.push(`diff_sites=${item.diff_sites.length} (${classes})`);
  }
  lines.push(...commutativeLines(item));
  if (guidance) (item.guidance ?? []).forEach((entry, i) => lines.push((i === 0 ? "next: " : "      ") + entry));
  const [accepted, basis] = comparisonAcceptance(item, { cross_rom });
  if (basis === "cross-rom-structural") lines.push("acceptance: PASS (cross-ROM structural evidence only; exact=false)");
  else if (!accepted && cross_rom) lines.push("acceptance: FAIL (cross-ROM structure also differs)");
  return lines;
}

export function commutativeLines(item) {
  const findings = item.commutative_findings ?? [];
  if (!findings.length) return [];
  const crossed = findings.filter((e) => get(e, "kind") === "operand-load").length;
  let heading = `commutative operands: ${findings.length} site(s)`;
  if (crossed) heading += `, ${crossed} visible only in the operand loads`;
  const lines = [heading];
  for (const e of findings.slice(0, COMMUTATIVE_SITES)) {
    lines.push(`  row ${get(e, "aligned_row")}  ${get(e, "opcode")} (${[...get(e, "sources")].map(String).join(", ")})`);
    lines.push(`    target    ${get(e, "target")}`);
    lines.push(`    candidate ${get(e, "candidate")}`);
    for (const d of get(e, "definitions") ?? []) lines.push(`    defines ${get(d, "register")} at row ${get(d, "aligned_row")}: ${get(d, "target")} | ${get(d, "candidate")}`);
    lines.push(`    lever: ${get(e, "lever")}`);
  }
  if (findings.length > COMMUTATIVE_SITES) lines.push(`  ... ${findings.length - COMMUTATIVE_SITES} more site(s); the full list is in --json under commutative_findings`);
  return lines;
}

/** Every differing site, grouped by class. */
export function diffSiteLines(item) {
  const lines = [];
  for (const [name] of entriesOf(item.diff_site_classes)) {
    for (const site of item.diff_sites ?? []) {
      if (get(site, "class") !== name) continue;
      lines.push(`\n[${String(get(site, "index")).padStart(4)}] ${name}`,
        `       target    ${get(site, "target_word")}  ${get(site, "target")}`,
        `       candidate ${get(site, "candidate_word")}  ${get(site, "candidate")}`);
    }
  }
  return lines;
}
