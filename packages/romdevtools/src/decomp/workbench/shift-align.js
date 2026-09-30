// shift-align.js - what an inserted instruction costs, as opposed to what it
// shifts: align two instruction streams, report the edit script instead of a
// positional count, and pair rows so a scorer charges shifted rows to the
// rows they really correspond to. Target and candidate relocation rows are
// masked separately; branch destinations are renormalized through the
// pairing.
//
// Plain JS ESM + JSDoc.

import { SequenceMatcher } from "./difflib.js";
import { normalizeInstruction } from "./compare.js";
import { ValueError, strRepr, floorDiv } from "./py.js";

export const ALIGNMENT_GRANULARITIES = ["opcode", "normalized", "exact"];
export const DEFAULT_GRANULARITY = "opcode";
export const SHIFT_DIFF_SCHEMA = "decomp-workbench-shift-diff-v1";
export const MINIMUM_MOVED_ROWS = 3;

const DESTINATION_RE = /(?<=[,\s])(?:0x)?(?<address>[0-9a-fA-F]+)(?:\s+<[^>]*>)?\s*$/;
const NON_DESTINATION_OPCODES = new Set(["break", "jr", "jalr"]);
const hasDestination = (op) => Boolean(op) && "bj".includes(op[0]) && !NON_DESTINATION_OPCODES.has(op);

/** The token the aligner matches this instruction on. */
export function alignmentKey(instruction, { granularity }) {
  if (granularity === "opcode") return instruction.opcode;
  if (granularity === "normalized") return normalizeInstruction(instruction.assembly);
  if (granularity === "exact") return instruction.assembly;
  throw new ValueError(`unknown alignment granularity ${strRepr(granularity)}; expected one of ` + ALIGNMENT_GRANULARITIES.join(", "));
}

/** Row numbers whose words carry a relocation. */
export function relocationRows(instructions) {
  const out = new Set();
  instructions.forEach((item, i) => { if (item.relocations.length) out.add(i); });
  return out;
}

/** One instruction's text with its branch destination in row space. */
export function comparableText(instruction, { row_of_address = null } = {}) {
  if (!hasDestination(instruction.opcode)) return instruction.assembly;
  const m = DESTINATION_RE.exec(instruction.assembly);
  if (!m) return instruction.assembly;
  const address = parseInt(m.groups.address, 16);
  const destination = row_of_address === null ? floorDiv(address, 4) : (row_of_address.has(address) ? row_of_address.get(address) : null);
  const rendered = destination === null ? "@?" : `@${destination}`;
  return instruction.assembly.slice(0, m.index) + rendered;
}

export class EditBlock {
  constructor({ tag, target_start, target_stop, candidate_start, candidate_stop, target_text = [], candidate_text = [] }) {
    Object.assign(this, { tag, target_start, target_stop, candidate_start, candidate_stop, target_text, candidate_text }); Object.freeze(this);
  }
  get target_rows() { return this.target_stop - this.target_start; }
  get candidate_rows() { return this.candidate_stop - this.candidate_start; }
  asDict() {
    return { tag: this.tag, target_start: this.target_start, target_stop: this.target_stop, candidate_start: this.candidate_start,
      candidate_stop: this.candidate_stop, target_rows: this.target_rows, candidate_rows: this.candidate_rows,
      target_text: [...this.target_text], candidate_text: [...this.candidate_text] };
  }
}

export class RowPairing {
  constructor({ candidate_of_target }) { this.candidate_of_target = candidate_of_target; Object.freeze(this); }
  candidateRow(t) { return t >= 0 && t < this.candidate_of_target.length ? this.candidate_of_target[t] : null; }
  /** candidate row -> target row (Map). */
  get target_of_candidate() {
    const m = new Map();
    this.candidate_of_target.forEach((c, t) => { if (c !== null) m.set(c, t); });
    return m;
  }
  get shift_at_end() {
    for (let t = this.candidate_of_target.length - 1; t >= 0; t--) { const c = this.candidate_of_target[t]; if (c !== null) return c - t; }
    return 0;
  }
}

export class ShiftDiff {
  constructor(f) { Object.assign(this, f); Object.freeze(this); }
  get edit_distance() { return this.replaced + this.inserted + this.deleted; }
  get rows_away() { return this.edit_distance + this.paired_mismatches; }
  get insertion_only() { return this.blocks.every((b) => b.tag === "insert"); }
  get cuts() { return this.blocks.filter((b) => b.tag === "insert").flatMap((b) => Array(b.candidate_rows).fill(b.target_start)); }
  asDict() {
    return { schema: SHIFT_DIFF_SCHEMA, target: this.target_name, candidate: this.candidate_name, symbol: this.symbol, granularity: this.granularity,
      target_rows: this.target_rows, candidate_rows: this.candidate_rows, row_delta: this.candidate_rows - this.target_rows,
      replaced: this.replaced, inserted: this.inserted, deleted: this.deleted, edit_distance: this.edit_distance, rows_away: this.rows_away,
      insertion_only: this.insertion_only, positional_mismatches: this.positional_mismatches, paired_rows: this.paired_rows,
      paired_mismatches: this.paired_mismatches, paired_mismatch_rows: [...this.paired_mismatch_rows], relocation_masked: this.relocation_masked,
      blocks: this.blocks.map((b) => b.asDict()), cuts: [...this.cuts] };
  }
}

function pairRows(opcodes, { target_rows }) {
  const pairing = new Array(target_rows).fill(null);
  for (const [tag, ts, te, cs, ce] of opcodes) {
    if (tag === "insert") continue;
    const span = Math.min(te - ts, ce - cs);
    for (let o = 0; o < span; o++) pairing[ts + o] = cs + o;
  }
  return new RowPairing({ candidate_of_target: pairing });
}

/** Align two instruction streams and report the edit script and residual. */
export function buildShiftDiff(target, candidate, { target_name = "target", candidate_name = "candidate", symbol = null, granularity = DEFAULT_GRANULARITY, context = 3 } = {}) {
  if (!ALIGNMENT_GRANULARITIES.includes(granularity)) {
    throw new ValueError(`unknown alignment granularity ${strRepr(granularity)}; expected one of ` + ALIGNMENT_GRANULARITIES.join(", "));
  }
  const tk = target.map((i) => alignmentKey(i, { granularity }));
  const ck = candidate.map((i) => alignmentKey(i, { granularity }));
  const opcodes = new SequenceMatcher(tk, ck).getOpcodes();
  let replaced = 0, inserted = 0, deleted = 0;
  const blocks = [];
  for (const [tag, i1, i2, j1, j2] of opcodes) {
    if (tag === "equal") continue;
    if (tag === "insert") inserted += j2 - j1;
    else if (tag === "delete") deleted += i2 - i1;
    else replaced += Math.max(i2 - i1, j2 - j1);
    blocks.push(new EditBlock({ tag, target_start: i1, target_stop: i2, candidate_start: j1, candidate_stop: j2,
      target_text: target.slice(i1, Math.min(i2, i1 + context)).map((x) => x.assembly),
      candidate_text: candidate.slice(j1, Math.min(j2, j1 + context)).map((x) => x.assembly) }));
  }
  const pairing = pairRows(opcodes, { target_rows: target.length });
  const tRel = relocationRows(target), cRel = relocationRows(candidate);
  const inverse = pairing.target_of_candidate;
  const inTargetSpace = new Map();
  candidate.forEach((item, idx) => { if (inverse.has(idx)) inTargetSpace.set(item.address, inverse.get(idx)); });
  let paired = 0, masked = 0;
  const mismatched = [];
  pairing.candidate_of_target.forEach((cr, tr) => {
    if (cr === null) return;
    paired++;
    if (tRel.has(tr) || cRel.has(cr)) { masked++; return; }
    if (comparableText(target[tr]) !== comparableText(candidate[cr], { row_of_address: inTargetSpace })) mismatched.push(tr);
  });
  let positional = 0;
  for (let i = 0; i < Math.max(target.length, candidate.length); i++) {
    if (i >= target.length || i >= candidate.length || target[i].assembly !== candidate[i].assembly) positional++;
  }
  return new ShiftDiff({ target_name, candidate_name, symbol, granularity, target_rows: target.length, candidate_rows: candidate.length,
    replaced, inserted, deleted, blocks, paired_rows: paired, paired_mismatches: mismatched.length, paired_mismatch_rows: mismatched,
    relocation_masked: masked, pairing, positional_mismatches: positional });
}

export class MovedBlock {
  constructor({ target_start, target_stop, candidate_start, candidate_stop }) { Object.assign(this, { target_start, target_stop, candidate_start, candidate_stop }); Object.freeze(this); }
  get rows() { return this.target_stop - this.target_start; }
  get displacement() { return this.candidate_start - this.target_start; }
  asDict() { return { target_start: this.target_start, target_stop: this.target_stop, candidate_start: this.candidate_start, candidate_stop: this.candidate_stop, rows: this.rows, displacement: this.displacement }; }
}

/** Each non-equal block whose code the candidate kept somewhere else. */
export function movedBlocks(diff, target, candidate, { minimum_rows = MINIMUM_MOVED_ROWS } = {}) {
  const blocks = diff.blocks.filter((b) => b.tag !== "insert" && b.target_rows >= minimum_rows);
  if (!blocks.length) return [];
  const tk = target.map((i) => alignmentKey(i, { granularity: "normalized" }));
  const ck = candidate.map((i) => alignmentKey(i, { granularity: "normalized" }));
  const claimed = [], found = [];
  for (const block of blocks) {
    const wanted = tk.slice(block.target_start, block.target_stop);
    const width = wanted.length;
    if (!width || width > ck.length) continue;
    for (let start = 0; start < ck.length - width + 1; start++) {
      const stop = start + width;
      if (start < block.candidate_stop && stop > block.candidate_start) continue;
      if (claimed.some(([b, e]) => start < e && stop > b)) continue;
      let same = true;
      for (let k = 0; k < width; k++) if (ck[start + k] !== wanted[k]) { same = false; break; }
      if (!same) continue;
      claimed.push([start, stop]);
      found.push(new MovedBlock({ target_start: block.target_start, target_stop: block.target_stop, candidate_start: start, candidate_stop: stop }));
      break;
    }
  }
  return found;
}

function blockLine(b) {
  const t = b.target_rows ? `${b.target_start}..${b.target_stop - 1}` : `before ${b.target_start}`;
  const c = b.candidate_rows ? `${b.candidate_start}..${b.candidate_stop - 1}` : `before ${b.candidate_start}`;
  return `  ${b.tag.padEnd(8)} target ${t} (${b.target_rows}) <- candidate ${c} (${b.candidate_rows})`;
}

/** Render one shift-tolerant diff for a terminal. */
export function shiftDiffLines(diff, { blocks = 20 } = {}) {
  const delta = diff.candidate_rows - diff.target_rows;
  const signed = (n) => (n >= 0 ? `+${n}` : String(n));
  const lines = [
    `shift-tolerant diff: ${diff.candidate_name} against ${diff.target_name}` + (diff.symbol ? ` (${diff.symbol})` : ""),
    `rows: target ${diff.target_rows} candidate ${diff.candidate_rows} (${signed(delta)})`,
    `edit script (aligned on ${diff.granularity}): replaced ${diff.replaced} inserted ${diff.inserted} deleted ${diff.deleted}`,
    `paired rows: ${diff.paired_rows} compared, ${diff.paired_mismatches} differing, ${diff.relocation_masked} masked as linker-controlled`,
    `=> ${diff.rows_away} instruction(s) away (${diff.edit_distance} edit + ${diff.paired_mismatches} residual)`,
  ];
  if (delta && diff.positional_mismatches > diff.rows_away) {
    lines.push(`a position-indexed comparison charges ${diff.positional_mismatches} rows for the same object: the ${Math.abs(delta)}-row shift moves every later row against its neighbour. Read the edit script.`);
  }
  if (diff.blocks.length) {
    lines.push("shift shape: " + (diff.insertion_only ? "insertion-only, so a banded scorer can compensate for it"
      : "not insertion-only, so rows inside the replaced or deleted blocks are genuinely different instructions"));
    if (diff.cuts.length) lines.push(`cuts (target rows the candidate inserts at): [${diff.cuts.join(", ")}]`);
    lines.push("", "edit script:");
    for (const b of diff.blocks.slice(0, blocks)) {
      lines.push(blockLine(b));
      b.target_text.forEach((t, o) => lines.push(`      target    ${String(b.target_start + o).padStart(5)}  ${t}`));
      const th = (b.target_stop - b.target_start) - b.target_text.length;
      if (th > 0) lines.push(`      target    ... ${th} more row(s) in this block; raise --context-rows to quote them`);
      b.candidate_text.forEach((t, o) => lines.push(`      candidate ${String(b.candidate_start + o).padStart(5)}  ${t}`));
      const ch = (b.candidate_stop - b.candidate_start) - b.candidate_text.length;
      if (ch > 0) lines.push(`      candidate ... ${ch} more row(s) in this block; raise --context-rows to quote them`);
    }
    if (diff.blocks.length > blocks) lines.push(`  ... ${diff.blocks.length - blocks} more block(s); raise --blocks to see them`);
  } else lines.push("edit script: empty -- the two streams align exactly");
  return lines;
}
