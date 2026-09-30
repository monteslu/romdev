// compare.js - layered object comparison oracles: relocation-aware words,
// positional and aligned residual classes, verdict and guidance, the literal
// pool reading, frame layout and the shift-tolerant layout summary.
//
// Plain JS ESM + JSDoc.

import path from "node:path";
import { createHash } from "node:crypto";
import { commutativeFindings } from "./commutative.js";
import { trueInstructionCount as elfTrueInstructionCount } from "./elf-instructions.js";
import { AMBIGUOUS_PLAYBOOK_FAMILIES, COARSE_ALLOCATION_LEAD_IN, VERDICT_PLAYBOOKS, nextSteps } from "./field-guide.js";
import { PoolReport } from "./literal-pool.js";
import { Comparison, displayPath } from "./model.js";
import { dumpObject, selectionWarnings, symbolLabels, trueInstructionCount } from "./objdump.js";
import { buildShiftDiff, movedBlocks } from "./shift-align.js";
import { DISPLACEMENT, MATCH, POOL, POOL_LAYOUT, RELOCATION, RESIDUAL_CLASSES, buildView } from "./view.js";
import { paretoLayers } from "./geometry.js";
import { SequenceMatcher } from "./difflib.js";
import { PyDict, pyInt, sorted, strip, pyCmp } from "./py.js";

export const REGISTER_RE = /(?<![A-Za-z0-9_$])\$?(?:f\d+|zero|at|v[01]|a[0-3]|t\d|s\d|k[01]|gp|sp|fp|ra)\b/g;
export const FP_REGISTER_RE = /(?<![A-Za-z0-9_$])\$?f\d+\b/g;
export const SYMBOLIZED_ADDRESS_RE = /\b[0-9a-fA-F]+\s+<[^>]+>/g;
export const STACK_OFFSET_RE = /(-?(?:0x[0-9a-fA-F]+|\d+))\(\$?sp\)/g;
export const FRAME_RE = /(?:addiu|daddiu)\s+\$?sp\s*,\s*\$?sp\s*,\s*(-?(?:0x[0-9a-fA-F]+|\d+))/;
export const SAVE_SLOT_RE = /^(?<opcode>sw|sd|sdc1)\s+\$?(?<register>s[0-8]|fp|ra|gp|f(?:20|22|24|26|28|30))\s*,\s*(?<offset>-?(?:0x[0-9a-fA-F]+|\d+))\(\$?sp\)/;

/** Linker-supplied bits per relocation kind; unknown kinds are never masked. */
export const RELOCATION_FIELD_MASKS = Object.freeze({
  R_MIPS_16: 0x0000FFFF, R_MIPS_PC16: 0x0000FFFF, R_MIPS_GPREL16: 0x0000FFFF, R_MIPS_LITERAL: 0x0000FFFF, R_MIPS_GOT16: 0x0000FFFF,
  R_MIPS_CALL16: 0x0000FFFF, R_MIPS_HI16: 0x0000FFFF, R_MIPS_LO16: 0x0000FFFF, R_MIPS_HIGHER: 0x0000FFFF, R_MIPS_HIGHEST: 0x0000FFFF,
  R_MIPS_GOT_DISP: 0x0000FFFF, R_MIPS_GOT_PAGE: 0x0000FFFF, R_MIPS_GOT_OFST: 0x0000FFFF, R_MIPS_GOT_HI16: 0x0000FFFF,
  R_MIPS_GOT_LO16: 0x0000FFFF, R_MIPS_CALL_HI16: 0x0000FFFF, R_MIPS_CALL_LO16: 0x0000FFFF, R_MIPS_TLS_GD: 0x0000FFFF,
  R_MIPS_TLS_LDM: 0x0000FFFF, R_MIPS_DTPREL_HI16: 0x0000FFFF, R_MIPS_DTPREL_LO16: 0x0000FFFF, R_MIPS_GOTTPREL: 0x0000FFFF,
  R_MIPS_TPREL_HI16: 0x0000FFFF, R_MIPS_TPREL_LO16: 0x0000FFFF, R_MIPS_26: 0x03FFFFFF, R_MIPS_32: 0xFFFFFFFF, R_MIPS_REL32: 0xFFFFFFFF,
  R_MIPS_64: 0xFFFFFFFF,
});

const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const hex8 = (v) => (v >>> 0).toString(16).padStart(8, "0");
const findall = (re, text) => [...text.matchAll(re)].map((m) => (m.length > 1 ? m[1] : m[0]));
const eqSeq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Remove unstable addresses, immediates, and stack offsets. */
export function normalizeInstruction(assembly) {
  let v = assembly.replace(/\b[0-9a-fA-F]+\s+<[^>]+>/g, "ADDR");
  v = v.replace(/-?(?:0x[0-9a-fA-F]+|\d+)\(\$?sp\)/g, "OFF(sp)");
  v = v.replace(/(?<![A-Za-z0-9_])-?(?:0x[0-9a-fA-F]+|\d+)\b/g, "IMM");
  return v.replaceAll("$", "");
}

/** Collapse sorted mismatch indices into inclusive [start, end] ranges. */
export function mismatchRanges(indices) {
  if (!indices.length) return [];
  const out = [];
  let start = indices[0], previous = indices[0];
  for (const i of indices.slice(1)) {
    if (i !== previous + 1) { out.push([start, previous]); start = i; }
    previous = i;
  }
  out.push([start, previous]);
  return out;
}

/** Count unequal aligned items plus the length difference. */
export function positionalMismatches(left, right) {
  let n = 0;
  const m = Math.min(left.length, right.length);
  for (let i = 0; i < m; i++) {
    const a = left[i], b = right[i];
    if (typeof a === "object" && a !== null ? !eqSeq(a, b) : a !== b) n++;
  }
  return n + Math.abs(left.length - right.length);
}

/** Insertion/deletion/replacement distance over two sequences. */
export function sequenceDistance(left, right) {
  let total = 0;
  for (const [tag, ls, le, rs, re] of new SequenceMatcher(left, right).getOpcodes()) if (tag !== "equal") total += Math.max(le - ls, re - rs);
  return total;
}

/** The first stack-frame adjustment, or null. */
export function frameSize(disassembly) {
  const m = FRAME_RE.exec(disassembly);
  return m ? pyInt(m[1], 0) : null;
}

/** Partition a frame into observed save slots and everything else. */
export function frameSaveLayout(instructions) {
  const adjustment = frameSize(instructions.map((i) => i.assembly).join("\n"));
  const slots = new Map();
  for (const ins of instructions) {
    const m = SAVE_SLOT_RE.exec(strip(ins.assembly));
    if (!m) continue;
    const offset = pyInt(m.groups.offset, 0);
    const size = m.groups.opcode === "sw" ? 4 : 8;
    if (!slots.has(offset)) slots.set(offset, [size, new Set()]);
    const [prev, regs] = slots.get(offset);
    slots.set(offset, [Math.max(prev, size), regs]);
    regs.add(m.groups.register);
  }
  const rendered = [];
  const occupied = new Set();
  for (const offset of [...slots.keys()].sort((a, b) => a - b)) {
    const [size, regs] = slots.get(offset);
    const registers = sorted([...regs]);
    for (let b = offset; b < offset + size; b++) occupied.add(b);
    const slot = { offset, bytes: size, registers };
    if (registers.length === 1) slot.register = registers[0];
    rendered.push(slot);
  }
  const saveBytes = occupied.size;
  const frameBytes = adjustment === null ? null : Math.abs(adjustment);
  const exceeds = frameBytes !== null && saveBytes > frameBytes;
  return {
    frame_adjustment: adjustment, observed_save_slots: rendered, observed_save_slot_count: rendered.length, observed_save_bytes: saveBytes,
    non_save_frame_bytes: frameBytes === null || exceeds ? null : frameBytes - saveBytes, save_bytes_exceed_frame: exceeds,
    claim_boundary: "Non-save bytes are not automatically source locals; they may include ABI padding, outgoing arguments, spills, or temporaries.",
  };
}

/** Count stack-relative operands; a numeric-keyed mapping in offset order. */
export function stackOffsets(instructions) {
  const counts = new Map();
  for (const ins of instructions) for (const v of findall(STACK_OFFSET_RE, ins.assembly)) { const k = pyInt(v, 0); counts.set(k, (counts.get(k) ?? 0) + 1); }
  return new PyDict([...counts].sort((a, b) => a[0] - b[0]));
}

/** Count floating-point register operands, ordered by register number. */
export function fpUses(instructions) {
  const counts = new Map();
  for (const ins of instructions) for (const m of findall(FP_REGISTER_RE, ins.assembly)) { const k = `$${m.replace(/^\$+/, "")}`; counts.set(k, (counts.get(k) ?? 0) + 1); }
  const out = {};
  for (const [k, v] of [...counts].sort((a, b) => parseInt(a[0].slice(2), 10) - parseInt(b[0].slice(2), 10))) out[k] = v;
  return out;
}

/** Canonical register names across objdump dialects (`t0` == `$t0`). */
export function registerOperands(assembly, { fp_only = false } = {}) {
  const operands = assembly.replace(SYMBOLIZED_ADDRESS_RE, "ADDR");
  return findall(fp_only ? FP_REGISTER_RE : REGISTER_RE, operands).map((m) => m.replace(/^\$+/, ""));
}

/** [linker-controlled bit mask, unknown relocation kinds]. */
export function relocationFieldMask(instruction) {
  let mask = 0;
  const unknown = [];
  for (const r of instruction.relocations) {
    if (r.kind === "R_MIPS_NONE" || r.kind === "R_MIPS_JALR") continue;
    if (!own(RELOCATION_FIELD_MASKS, r.kind)) unknown.push(r.kind);
    else mask = (mask | RELOCATION_FIELD_MASKS[r.kind]) >>> 0;
  }
  return [mask, unknown];
}

/** Mask the union of known relocation fields at each aligned position. */
export function relocationAwareWords(target, candidate) {
  const tw = [], cw = [];
  const unknown = new Set();
  const n = Math.min(target.length, candidate.length);
  for (let i = 0; i < n; i++) {
    const [em, eu] = relocationFieldMask(target[i]);
    const [am, au] = relocationFieldMask(candidate[i]);
    for (const u of [...eu, ...au]) unknown.add(u);
    const keep = (~(em | am)) >>> 0;
    tw.push(hex8((target[i].word_value & keep) >>> 0));
    cw.push(hex8((candidate[i].word_value & keep) >>> 0));
  }
  if (target.length > candidate.length) tw.push(...target.slice(candidate.length).map((x) => x.word));
  else if (candidate.length > target.length) cw.push(...candidate.slice(target.length).map((x) => x.word));
  return [tw, cw, sorted([...unknown])];
}

export function relocationSignature(ins) { return ins.relocations.map((r) => r.kind); }
export function relocationTargetSignature(ins) { return ins.relocations.map((r) => [r.kind, r.symbol]); }

export const RELOCATION_ADDEND_RE = /^(?<symbol>.*?)(?<addend>[+-](?:0x[0-9a-fA-F]+|\d+))$/;

/** Split objdump's `symbol+addend` spelling into [symbol, addend]. */
export function relocationTargetParts(symbol) {
  if (symbol === null || symbol === undefined) return [null, 0];
  const m = RELOCATION_ADDEND_RE.exec(symbol);
  if (!m || !m.groups.symbol) return [symbol, 0];
  return [m.groups.symbol, pyInt(m.groups.addend, 0)];
}

export function relocationSymbolSignature(ins) { return ins.relocations.map((r) => [r.kind, relocationTargetParts(r.symbol)[0]]); }

export const VERDICT_SCHEDULE_MISMATCH = "schedule-mismatch";
export const VERDICT_STRUCTURE_MISMATCH = "structure-mismatch";
export const SECTION_SYMBOLS = new Set([".text", ".data", ".rodata", ".bss", ".sdata", ".sbss"]);

/** Why one relocation site differs: symbol, kind, or addend. */
export function relocationDifferenceClass(target, candidate) {
  if (target === null || candidate === null) return "symbol";
  if (target.symbol !== candidate.symbol) return "symbol";
  if (target.kind !== candidate.kind) return "kind";
  return "addend";
}

/** Every positional relocation target mismatch with both sides. */
export function relocationTargetDifferences(target, candidate) {
  const out = [];
  const width = Math.max(target.length, candidate.length);
  const payload = (r) => {
    if (r === null) return null;
    const [base, addend] = relocationTargetParts(r.symbol);
    return { offset: r.offset, kind: r.kind, symbol: base, addend, raw_target: r.symbol };
  };
  for (let index = 0; index < width; index++) {
    const expected = index < target.length ? target[index] : null;
    const actual = index < candidate.length ? candidate[index] : null;
    const er = expected !== null ? expected.relocations : [];
    const ar = actual !== null ? actual.relocations : [];
    for (let ri = 0; ri < Math.max(er.length, ar.length); ri++) {
      const left = ri < er.length ? er[ri] : null;
      const right = ri < ar.length ? ar[ri] : null;
      const ls = left === null ? null : [left.kind, left.symbol];
      const rs = right === null ? null : [right.kind, right.symbol];
      if (eqSeq(ls, rs)) continue;
      const lp = payload(left), rp = payload(right);
      const cls = relocationDifferenceClass(lp, rp);
      const cs = rp !== null ? rp.symbol : null;
      const ts = lp !== null ? lp.symbol : null;
      out.push({ instruction_index: index, relocation_index: ri, difference: cls,
        candidate_section_symbol: cls === "symbol" && SECTION_SYMBOLS.has(cs) && !SECTION_SYMBOLS.has(ts) && ts !== null,
        target_instruction_offset: expected !== null ? expected.address : null,
        candidate_instruction_offset: actual !== null ? actual.address : null, target: lp, candidate: rp });
    }
  }
  return out;
}

export const COMMUTATIVE_OPCODES = new Set(["add", "addu", "and", "dadd", "daddu", "dmult", "dmultu", "mult", "multu", "nor", "or", "xor", "add.d", "add.s", "mul.d", "mul.s"]);
export const CONSTANT_OPCODES = new Set(["addiu", "andi", "daddiu", "li", "lui", "ori", "slti", "sltiu", "xori"]);
export const ALIGNED_CLASS_KEYS = ["aligned_structural", "aligned_schedule", "aligned_register", "aligned_constant", "aligned_commutative"];
export const ALIGNMENT_GAP_KEYS = ["aligned_insertions", "aligned_deletions"];
export const OPCODE_MISMATCH_CAUTION_THRESHOLD = 2;

/** The cross-candidate comparability caution, or null. */
export function alignmentCaution({ insertions, deletions, opcode_mismatches }) {
  const gaps = insertions + deletions;
  if (gaps === 0 && opcode_mismatches <= OPCODE_MISMATCH_CAUTION_THRESHOLD) return null;
  return `caution: alignment inserted ${gaps} gaps (${opcode_mismatches} opcode mismatches) -- compare candidates on positional words (words=), not aligned rows`;
}

const countOf = (counts, name) => (counts instanceof Map ? counts.get(name) : counts[name]) ?? 0;

/**
 * Aligned evidence: [counts, gaps, sites, pool, commutative, progress, row_receipts].
 */
export function alignedResidualAnalysis(target, candidate) {
  if (!target.length || !candidate.length) {
    const counts = Object.fromEntries(ALIGNED_CLASS_KEYS.map((k) => [k, 0]));
    const n = Math.max(target.length, candidate.length);
    counts.aligned_structural = n;
    const gaps = { aligned_insertions: target.length ? 0 : candidate.length, aligned_deletions: candidate.length ? 0 : target.length };
    const range = [...Array(n).keys()];
    const sites = range.map((i) => ({ index: target.length ? i : 0, target_index: target.length ? i : null, candidate_index: candidate.length ? i : null,
      aligned_row: i, class: "structural", target: target.length ? target[i].assembly : null, candidate: candidate.length ? candidate[i].assembly : null }));
    const progress = { pool_exact: !target.length && !candidate.length, pool_prefix_exact: 0, temp_prefix_exact: 0, first_temp_divergence: null,
      first_divergent_row: 0, alignment_method: "lcs" };
    return [counts, gaps, sites, null, [], progress, range.map((i) => ({ aligned_row: i, target_index: target.length ? i : null,
      candidate_index: candidate.length ? i : null, class: "structural", raw_exact: false, relocation_aware_exact: false }))];
  }
  const view = buildView(target, candidate, { target_name: "", candidate_name: "" });
  const counts = Object.fromEntries(RESIDUAL_CLASSES.map((n) => [`aligned_${n}`, countOf(view.counts, n)]));
  const gaps = { aligned_insertions: view.rows.filter((r) => r.target_index === null).length, aligned_deletions: view.rows.filter((r) => r.candidate_index === null).length };
  let nextTarget = target.length;
  const anchors = new Map();
  for (const row of [...view.rows].reverse()) { if (row.target_index !== null) nextTarget = row.target_index; anchors.set(row.index, nextTarget); }
  const sites = view.rows.filter((r) => r.reported).map((r) => ({ index: anchors.get(r.index), target_index: r.target_index, candidate_index: r.candidate_index,
    aligned_row: r.index, class: r.classification, target: r.target, candidate: r.candidate }));
  const pool = view.pool === null || view.pool === undefined ? null : new PoolReport({ resolution: view.pool.resolution, matches: countOf(view.counts, POOL),
    layout_mismatches: countOf(view.counts, POOL_LAYOUT), target_slots: view.pool.target_slots, candidate_slots: view.pool.candidate_slots });
  const poolLanes = view.lanes.filter((l) => l.classification === "pool");
  const tempLanes = view.lanes.filter((l) => l.classification === "temp" || l.classification === "fp-temp");
  const firstLaneDivergence = (lanes) => {
    const d = lanes.filter((l) => l.divergence_row !== null);
    let best = null;
    for (const l of d) if (best === null || l.divergence_row < best.divergence_row) best = l;
    return best;
  };
  const firstPool = firstLaneDivergence(poolLanes), firstTemp = firstLaneDivergence(tempLanes);
  let firstTempPayload = null;
  if (firstTemp !== null) {
    const slot = firstTemp.divergence;
    firstTempPayload = { class: firstTemp.classification, slot, aligned_row: firstTemp.divergence_row,
      target_register: slot < firstTemp.target.length ? firstTemp.target[slot] : null,
      candidate_register: slot < firstTemp.candidate.length ? firstTemp.candidate[slot] : null, rotation: firstTemp.rotation };
  }
  const progress = {
    pool_exact: firstPool === null, pool_prefix_exact: firstPool !== null ? firstPool.divergence_row : null,
    temp_prefix_exact: firstTemp !== null ? firstTemp.divergence_row : null, first_temp_divergence: firstTempPayload,
    first_divergent_row: view.prefix_exact,
    alignment_method: target.length === candidate.length && target.every((l, i) => l.opcode === candidate[i].opcode) ? "positional-opcode" : "lcs",
  };
  const receipts = view.rows.map((r) => ({ aligned_row: r.index, target_index: r.target_index, candidate_index: r.candidate_index, class: r.classification,
    raw_exact: r.classification === MATCH, relocation_aware_exact: [MATCH, DISPLACEMENT, RELOCATION, POOL].includes(r.classification) }));
  return [counts, gaps, sites, pool, commutativeFindings(view.rows), progress, receipts];
}

export function alignedResidual(target, candidate) { return alignedResidualAnalysis(target, candidate)[0]; }

/** Whether two operand lists are one swap of a commutative pair. */
export function commutativeSwap(opcode, expected, actual) {
  if (!COMMUTATIVE_OPCODES.has(opcode)) return false;
  if (expected.length !== actual.length) return false;
  let sources, other;
  if (expected.length === 2) { sources = expected; other = actual; }
  else if (expected.length === 3) { if (expected[0] !== actual[0]) return false; sources = expected.slice(1); other = actual.slice(1); }
  else return false;
  return sources[0] === other[1] && sources[1] === other[0] && sources[0] !== sources[1];
}

export function isCommutativeSwap(expected, actual) {
  if (expected.opcode !== actual.opcode) return false;
  return commutativeSwap(expected.opcode, registerOperands(expected.assembly), registerOperands(actual.assembly));
}

export function isConstantDifference(expected, actual) {
  if (expected.opcode !== actual.opcode || !CONSTANT_OPCODES.has(expected.opcode)) return false;
  if (FRAME_RE.test(expected.assembly) || FRAME_RE.test(actual.assembly)) return false;
  return eqSeq(registerOperands(expected.assembly), registerOperands(actual.assembly));
}

/** The cheapest mechanism that explains one differing site. */
export function classifyDiffSite(expected, actual, { masked_equal }) {
  if (masked_equal) return eqSeq(relocationSignature(expected), relocationSignature(actual)) ? "relocation-controlled" : "relocation-layout";
  if (expected.opcode !== actual.opcode) return "opcode";
  if (isCommutativeSwap(expected, actual)) return "commutative-order";
  if (!eqSeq(registerOperands(expected.assembly), registerOperands(actual.assembly))) return "register";
  if (isConstantDifference(expected, actual)) return "constant";
  return "operand";
}

/** Every differing site, classified and never filtered. */
export function diffSites(target, candidate, targetWords, candidateWords) {
  const sites = [];
  const aligned = Math.min(target.length, candidate.length);
  for (let i = 0; i < aligned; i++) {
    const e = target[i], a = candidate[i];
    if (e.word === a.word && eqSeq(relocationSignature(e), relocationSignature(a))) continue;
    sites.push({ index: i, class: classifyDiffSite(e, a, { masked_equal: targetWords[i] === candidateWords[i] }), target: e.assembly, candidate: a.assembly,
      target_word: e.word, candidate_word: a.word });
  }
  for (let i = aligned; i < Math.max(target.length, candidate.length); i++) {
    const e = i < target.length ? target[i] : null, a = i < candidate.length ? candidate[i] : null;
    sites.push({ index: i, class: "instruction-count", target: e ? e.assembly : "-", candidate: a ? a.assembly : "-",
      target_word: e ? e.word : "-", candidate_word: a ? a.word : "-" });
  }
  return sites;
}

/** Differing sites per class, sorted by class name. */
export function diffSiteClasses(sites) {
  const counts = new Map();
  for (const s of sites) counts.set(String(s.class), (counts.get(String(s.class)) ?? 0) + 1);
  return Object.fromEntries(sorted([...counts], (e) => e[0]));
}

/** Classify raw differences without hiding why they disappeared. */
export function rawDifferenceBreakdown(target, candidate, targetWords, candidateWords) {
  const r = new Map();
  const add = (k, n = 1) => r.set(k, (r.get(k) ?? 0) + n);
  const aligned = Math.min(target.length, candidate.length);
  for (let i = 0; i < aligned; i++) {
    if (target[i].word === candidate[i].word) continue;
    if (targetWords[i] !== candidateWords[i]) add("instruction_bits");
    else if (!eqSeq(relocationSignature(target[i]), relocationSignature(candidate[i]))) add("relocation_layout");
    else add("relocation_controlled");
  }
  add("instruction_bits", Math.abs(target.length - candidate.length));
  return Object.fromEntries(sorted([...r], (e) => e[0]).filter(([, c]) => c));
}

/** Name cheaper mechanisms hiding inside a broader residual. */
export function mixedSiteCallouts(siteClasses) {
  const out = [];
  if (siteClasses.constant) out.push("Some differing sites are constant materializations: audit the flag, enum, or constant against the assembly first, since one wrong identifier can present as a much larger residual.");
  if (siteClasses["commutative-order"]) out.push("Some differing sites are swapped sources of a commutative operation: that part is expression shape (`x |= y`), not allocation.");
  return out;
}

/** Verdict, next action, and the field-guide on-ramp. */
export function comparisonGuidance(o) {
  const [verdict, guidance] = comparisonGuidanceCore(o);
  const playbook = own(VERDICT_PLAYBOOKS, verdict) ? VERDICT_PLAYBOOKS[verdict] : null;
  if (playbook !== null) {
    const lead_in = own(AMBIGUOUS_PLAYBOOK_FAMILIES, playbook) ? [COARSE_ALLOCATION_LEAD_IN] : [];
    guidance.push(...nextSteps(playbook, { lead_in }));
  }
  return [verdict, guidance];
}

function comparisonGuidanceCore({ exact, structural_exact, raw_difference_breakdown: rdb, relocation_mismatches, relocation_symbol_mismatches, unknown_relocations,
  opcode_mismatches, instruction_delta, register_mismatches, site_classes, instruction_multiset_equal, aligned_counts, target_frame_size = null, candidate_frame_size = null }) {
  const ac = (k) => aligned_counts[k] ?? 0;
  const controlled = rdb.relocation_controlled ?? 0;
  if (exact) {
    if (relocation_symbol_mismatches) {
      const count = relocation_symbol_mismatches, noun = count === 1 ? "site" : "sites";
      return ["relocation-symbol-mismatch", [
        `Instruction bits and relocation kinds agree, but ${count} relocation ${noun} name a different symbol in each object.`,
        "That is a semantic difference no link resolves: the two objects read different variables. Masking excludes those words, so words= understates the residual here.",
        "Read `relocation_target_differences` (or the terminal's relocation target table) and reconcile each symbol before treating this as a match."]];
    }
    if (controlled) {
      return ["instruction-exact", [
        `Instruction-exact: raw differences are linker-controlled relocation fields (${controlled} word(s)), all naming the same symbol on both sides. No source change is indicated for a linked-project match.`,
        "This is not raw-object exact: decomp.me can still assign a non-zero score for the relocation addend or symbol shape. Use check-scratch when a 100% site score is the goal.",
        "Run the project's normal link or ROM verification for the final proof."]];
    }
    return ["instruction-words-identical", ["Instruction words and known relocation-kind layout are identical for the selected function. Run the project's normal final verification."]];
  }
  if (unknown_relocations.length) {
    return ["unknown-relocation", ["Known instruction evidence may match, but an unrecognized relocation prevents a safe exact verdict.",
      "Add the relocation kind with a precise field mask before trusting this comparison."]];
  }
  if (relocation_mismatches && !rdb.instruction_bits) {
    return ["relocation-layout-mismatch", ["Instruction bits match after relocation masking, but relocation layouts differ.",
      "Check translation-unit context, symbol spelling, and linked/ROM output before changing source."]];
  }
  const classes = new Set(Object.entries(site_classes).filter(([n, c]) => c && n !== "relocation-controlled").map(([n]) => n));
  const frameMismatch = target_frame_size !== null && candidate_frame_size !== null && target_frame_size !== candidate_frame_size;
  if (frameMismatch && aligned_counts.aligned_constant === 2
    && !["aligned_structural", "aligned_schedule", "aligned_register", "aligned_commutative"].some((n) => ac(n))
    && rdb.instruction_bits === 2 && !opcode_mismatches && !instruction_delta && !register_mismatches) {
    return ["frame-layout-mismatch", [
      `Register allocation, opcode schedule, and instruction count agree; only the symmetric stack adjustment differs (target ${target_frame_size}, candidate ${candidate_frame_size}).`,
      "Treat this as a stack-home/layout problem, not a literal audit: preserve the successful live-range topology while shrinking, reusing, or eliminating source-local homes.",
      "Ablate one local at a time and record both normalized residue and frame size; allocation-exact with the wrong frame is a useful intermediate, not acceptance."]];
  }
  const only = (name) => classes.size === 1 && classes.has(name);
  if (only("constant")) {
    return ["constant-mismatch", [
      "Every difference is an immediate on a constant-materializing instruction; opcodes and registers already agree.",
      "Audit the flag, enum, or constant against the target assembly first: the assembly encodes the truth, and one wrong identifier can present as a large structural difference.",
      "Re-derive any fake expressions afterwards; they may have been fitted to the wrong constant. Literal search is comparison work, not permuter work."]];
  }
  if (only("commutative-order")) {
    return ["commutative-order", [
      "Same opcodes and same operands with the two sources of a commutative operation swapped: this is front-end expression shape, not register allocation.",
      "Reach for compound assignment. `a | b` and `b | a` canonicalize to the same object, but `x |= y` is a distinct expression tree and flips the emitted operand order.",
      "Do not trace the allocator for this residual."]];
  }
  const scheduleOnly = Boolean(ac("aligned_schedule")) && !["aligned_structural", "aligned_register", "aligned_constant", "aligned_commutative"].some((n) => ac(n));
  if (scheduleOnly || (instruction_multiset_equal && opcode_mismatches && !instruction_delta && [...classes].every((c) => c === "opcode"))) {
    return [VERDICT_SCHEDULE_MISMATCH, [
      "Instruction count and the full instruction multiset (registers included) are identical; only their order differs. This is late-pass scheduling, not allocation or control flow.",
      "Regroup expressions and statements rather than changing values or lifetimes.",
      "Ownership probe: rebuild the candidate with -g0. If the region collapses, debug line metadata constrains the -g3 schedule and the assembler can reach the target ordering.",
      "A -g0 collapse does not prove source correctness: a freer scheduler can rescue a non-original expression or statement shape. Compare source topology and line tags before declaring that search complete.",
      "`replay-as1` tests whether the final assembler pass owns the ordering."]];
  }
  if (opcode_mismatches || instruction_delta) {
    return [VERDICT_STRUCTURE_MISMATCH, [...mixedSiteCallouts(site_classes),
      "Instruction shape differs: work at the C/control-flow or expression-tree level first.",
      "Avoid allocator-only experiments until the instruction count and opcode schedule stabilize."]];
  }
  if (register_mismatches) {
    const lead = frameMismatch
      ? `Opcode schedule matches, but the stack frame differs (target ${target_frame_size}, candidate ${candidate_frame_size}) alongside the register-allocation residue.`
      : "Opcode shape matches but register allocation differs.";
    const gate = frameMismatch ? ["Treat frame recovery as a separate acceptance gate: inspect callee-save usage, spills, and source-local stack homes. A smaller normalized register score cannot compensate for a wrong frame."] : [];
    return ["allocation-mismatch", [...mixedSiteCallouts(site_classes), lead, ...gate,
      "Run `view` or `diagnose` on this pair next; no instrumented toolchain is needed to inspect the alignment. It may leave the register family and per-function ownership unresolved instead of prescribing an unsupported source lever.",
      "Use an already configured globalcolor/UGEN trace when reservation or demand evidence is needed to choose a lever; neither trace-first nor exhausting every family is universal."]];
  }
  if (structural_exact) {
    return ["operand-mismatch", ["Opcode, normalized instruction shape, registers, frame, and instruction count agree, but literal operands differ.",
      "Use --cross-rom only when the inputs are intentionally from different revisions; otherwise inspect the localized operands."]];
  }
  return ["operand-mismatch", ["Instruction shape is close, but operands or immediates still differ. Inspect the localized diff."]];
}

export const LAYOUT_SUMMARY_SCHEMA = "decomp-workbench-layout-summary-v1";
export const LAYOUT_VERDICTS = new Set([VERDICT_STRUCTURE_MISMATCH, VERDICT_SCHEDULE_MISMATCH]);

/** The shift-tolerant edit script beside the positional count. */
export function layoutSummary(target, candidate) {
  const diff = buildShiftDiff(target, candidate, { granularity: "normalized" });
  const moved = movedBlocks(diff, target, candidate);
  return {
    schema: LAYOUT_SUMMARY_SCHEMA, granularity: diff.granularity, target_rows: diff.target_rows, candidate_rows: diff.candidate_rows,
    row_delta: diff.candidate_rows - diff.target_rows, block_count: diff.blocks.length, replaced: diff.replaced, inserted: diff.inserted,
    deleted: diff.deleted, edit_distance: diff.edit_distance, paired_mismatches: diff.paired_mismatches, rows_away: diff.rows_away,
    positional_mismatches: diff.positional_mismatches, insertion_only: diff.insertion_only, moved_block_count: moved.length,
    moved_rows: moved.reduce((n, b) => n + b.rows, 0), moved_blocks: moved.map((b) => b.asDict()),
  };
}

const signedInt = (n) => (n >= 0 ? `+${n}` : String(n));

function multisetEqual(a, b) {
  if (a.length !== b.length) return false;
  const m = new Map();
  for (const x of a) m.set(x, (m.get(x) ?? 0) + 1);
  for (const x of b) { const c = m.get(x); if (!c) return false; m.set(x, c - 1); }
  return true;
}

/**
 * Compare parsed instruction streams.
 * @param {any[]} target
 * @param {any[]} candidate
 * @param {{target_name: string, candidate_name: string, symbol: string|null, warnings?: string[], target_true_instructions?: number|null,
 *   candidate_true_instructions?: number|null, instruction_count_verified?: boolean}} opts
 */
export function compareInstructions(target, candidate, { target_name, candidate_name, symbol, warnings = [], target_true_instructions = null,
  candidate_true_instructions = null, instruction_count_verified = false }) {
  const rawT = target.map((i) => i.word), rawC = candidate.map((i) => i.word);
  const [tw, cw, unknown] = relocationAwareWords(target, candidate);
  const tOps = target.map((i) => i.opcode), cOps = candidate.map((i) => i.opcode);
  const tNorm = target.map((i) => normalizeInstruction(i.assembly)), cNorm = candidate.map((i) => normalizeInstruction(i.assembly));
  const registerBad = [], fpBad = [], registerDiff = [];
  for (let i = 0; i < Math.min(target.length, candidate.length); i++) {
    const e = target[i], a = candidate[i];
    const er = registerOperands(e.assembly), ar = registerOperands(a.assembly);
    const ef = registerOperands(e.assembly, { fp_only: true }), af = registerOperands(a.assembly, { fp_only: true });
    if (!eqSeq(er, ar)) { registerBad.push(i); registerDiff.push({ index: i, target: e.assembly, candidate: a.assembly, target_registers: er, candidate_registers: ar }); }
    if (!eqSeq(ef, af)) fpBad.push(i);
  }
  const lengthExtra = Math.abs(target.length - candidate.length);
  const registerCount = registerBad.length + lengthExtra, fpCount = fpBad.length + lengthExtra;
  const exactMismatches = positionalMismatches(tw, cw);
  const rawMismatches = positionalMismatches(rawT, rawC);
  const relocationMismatches = positionalMismatches(target.map(relocationSignature), candidate.map(relocationSignature));
  const relocationTargetMismatches = positionalMismatches(target.map(relocationTargetSignature), candidate.map(relocationTargetSignature));
  const relocationSymbolMismatches = positionalMismatches(target.map(relocationSymbolSignature), candidate.map(relocationSymbolSignature));
  const payload = Buffer.from(rawC.join(""), "ascii");
  const targetFrame = frameSize(target.map((i) => i.assembly).join("\n"));
  const candidateFrame = frameSize(candidate.map((i) => i.assembly).join("\n"));
  const targetLayout = frameSaveLayout(target), candidateLayout = frameSaveLayout(candidate);
  const structuralExact = target.length === candidate.length && sequenceDistance(tNorm, cNorm) === 0 && positionalMismatches(tOps, cOps) === 0
    && registerCount === 0 && fpCount === 0 && targetFrame === candidateFrame;
  const [aligned, alignedGaps, alignedSites, pool, commutative, progress, rowReceipts] = alignedResidualAnalysis(target, candidate);
  const relocationDifferences = relocationTargetDifferences(target, candidate);
  const breakdown = rawDifferenceBreakdown(target, candidate, tw, cw);
  const sites = diffSites(target, candidate, tw, cw);
  const siteClasses = diffSiteClasses(sites);
  const opcodeMismatches = positionalMismatches(tOps, cOps);
  const caution = alignmentCaution({ insertions: alignedGaps.aligned_insertions, deletions: alignedGaps.aligned_deletions, opcode_mismatches: opcodeMismatches });
  const exact = exactMismatches === 0 && relocationMismatches === 0 && !unknown.length;
  const [verdict, guidance] = comparisonGuidance({ exact, structural_exact: structuralExact, raw_difference_breakdown: breakdown,
    relocation_mismatches: relocationMismatches, relocation_symbol_mismatches: relocationSymbolMismatches, unknown_relocations: unknown,
    opcode_mismatches: opcodeMismatches, instruction_delta: candidate.length - target.length, register_mismatches: registerCount,
    site_classes: siteClasses, instruction_multiset_equal: multisetEqual(tNorm, cNorm), aligned_counts: aligned,
    target_frame_size: targetFrame, candidate_frame_size: candidateFrame });
  const layout = LAYOUT_VERDICTS.has(verdict) && target.length && candidate.length ? layoutSummary(target, candidate) : null;
  if (layout !== null && layout.moved_block_count) {
    const movedCount = layout.moved_block_count, noun = movedCount === 1 ? "block" : "blocks";
    guidance.unshift(`Layout: ${movedCount} ${noun} of code (${layout.moved_rows} row(s)) are present in both objects at different positions. A permutation `
      + `is not ${exactMismatches} words of difference -- the shift-tolerant edit script is ${layout.rows_away} row(s). Fix the block order before reading the positional counts.`);
  }
  if (targetFrame !== candidateFrame) {
    const ts = targetLayout.observed_save_bytes, cs = candidateLayout.observed_save_bytes;
    if (ts === cs) {
      const pyNone = (v) => (v === null ? "None" : String(v));
      guidance.splice(Math.min(2, guidance.length), 0, `Observed save slots account for the same ${ts} byte(s) on both sides; non-save frame `
        + `bytes differ (${pyNone(targetLayout.non_save_frame_bytes)} -> ${pyNone(candidateLayout.non_save_frame_bytes)}). `
        + "Search ABI padding, outgoing arguments, spills, or local/temp homes rather than the saved-register set.");
    }
  }
  const resolvedT = target_true_instructions !== null && target_true_instructions !== undefined ? target_true_instructions : trueInstructionCount(target);
  const resolvedC = candidate_true_instructions !== null && candidate_true_instructions !== undefined ? candidate_true_instructions : trueInstructionCount(candidate);
  const resolvedWarnings = [...warnings];
  if (resolvedT !== resolvedC) {
    resolvedWarnings.push(`true instruction count differs: target=${resolvedT} candidate=${resolvedC} (delta ${signedInt(resolvedC - resolvedT)}). `
      + `.text is 16-byte padded, so target_instructions/candidate_instructions (${target.length}/${candidate.length}) can `
      + "agree even when the real function lengths do not -- any per-region or per-row analysis keyed on absolute position is unreliable until this is resolved.");
  }
  const sum = Object.values(aligned).reduce((n, v) => n + v, 0);
  return new Comparison({
    candidate: candidate_name, target: target_name, symbol, target_instructions: target.length, candidate_instructions: candidate.length,
    instruction_delta: candidate.length - target.length, raw_word_mismatches: rawMismatches, word_mismatches: exactMismatches,
    aligned_total: sum, aligned_structural: aligned.aligned_structural, aligned_schedule: aligned.aligned_schedule, aligned_register: aligned.aligned_register,
    aligned_constant: aligned.aligned_constant, aligned_commutative: aligned.aligned_commutative,
    relocation_metadata_mismatches: relocationMismatches, relocation_target_mismatches: relocationTargetMismatches,
    relocation_symbol_mismatches: relocationSymbolMismatches, unknown_relocations: unknown, opcode_mismatches: opcodeMismatches,
    normalized_distance: sequenceDistance(tNorm, cNorm), opcode_distance: eqSeq(tOps, cOps) ? 0 : sequenceDistance(tOps, cOps),
    register_mismatches: registerCount, fp_register_mismatches: fpCount, register_mismatch_ranges: mismatchRanges(registerBad),
    fp_mismatch_ranges: mismatchRanges(fpBad), target_frame_size: targetFrame, candidate_frame_size: candidateFrame,
    candidate_fp_register_uses: fpUses(candidate), candidate_stack_offsets: stackOffsets(candidate),
    candidate_sha1: createHash("sha1").update(payload).digest("hex").slice(0, 12), candidate_sha256: createHash("sha256").update(payload).digest("hex"),
    exact, structural_exact: structuralExact, raw_difference_breakdown: breakdown, verdict, guidance, register_diff: registerDiff,
    diff_sites: sites, diff_site_classes: siteClasses, aligned_diff_sites: alignedSites, commutative_findings: commutative.map((c) => c.asDict()),
    relocation_target_differences: relocationDifferences, pool_exact: progress.pool_exact, pool_prefix_exact: progress.pool_prefix_exact,
    temp_prefix_exact: progress.temp_prefix_exact,
    first_temp_divergence: progress.first_temp_divergence && typeof progress.first_temp_divergence === "object" ? { ...progress.first_temp_divergence } : null,
    first_divergent_row: progress.first_divergent_row, alignment_method: progress.alignment_method, warnings: resolvedWarnings,
    target_frame_layout: targetLayout, candidate_frame_layout: candidateLayout, aligned_insertions: alignedGaps.aligned_insertions,
    aligned_deletions: alignedGaps.aligned_deletions, aligned_gaps: alignedGaps.aligned_insertions + alignedGaps.aligned_deletions,
    alignment_comparable: caution === null, alignment_caution: caution,
    pool_resolution: pool !== null ? pool.resolution : null, pool_matches: pool !== null ? pool.matches : 0,
    pool_layout_mismatches: pool !== null ? pool.layout_mismatches : 0, target_pool_slots: pool !== null ? pool.target_slots : 0,
    candidate_pool_slots: pool !== null ? pool.candidate_slots : 0, target_true_instructions: resolvedT, candidate_true_instructions: resolvedC,
    true_instruction_delta: resolvedC - resolvedT,
    instruction_count_verified: Boolean(instruction_count_verified && target_true_instructions !== null && target_true_instructions !== undefined
      && candidate_true_instructions !== null && candidate_true_instructions !== undefined),
    aligned_row_receipts: rowReceipts, layout,
  });
}

export const MIXED_ALIGNMENT_CAUTION = "caution: one or more candidates have incomparable aligned totals -- ordered by "
  + "geometry Pareto layers (true extent, normalized and opcode edits), then positional words; tradeoffs within a layer are not proven improvements";

/** Order candidates; [ordered, byRaw]. */
export function rankComparisons(items) {
  let ordered = [...items];
  const byRaw = ordered.some((i) => !i.alignment_comparable);
  if (byRaw) {
    const fronts = paretoLayers(ordered.map((i) => i.geometry_vector));
    ordered.forEach((item, k) => { item.geometry_front = fronts[k]; });
    ordered = sorted(ordered.map((item, k) => [fronts[k], item]), (p) => [!p[1].exact, p[0], p[1].raw_sort_key]).map((p) => p[1]);
  } else {
    for (const item of ordered) item.geometry_front = null;
    ordered = sorted(ordered, (i) => i.sort_key);
  }
  return [ordered, byRaw];
}

/** The true instruction count read straight from the object's ELF (whole-section only). */
export function resolveTrueInstructions(file, { symbol, section, cwd = process.cwd() }) {
  if (symbol !== null && symbol !== undefined) return null;
  try { return elfTrueInstructionCount(path.resolve(cwd, String(file)), { section }); }
  catch (e) { if (e?.name === "ValueError" || e?.code || e instanceof RangeError) return null; throw e; }
}

/** A disassembled target retained for repeated comparison. */
export class TargetObject {
  constructor({ name, symbol, instructions, labels = [], text = "", true_instructions = null, section = ".text" }) {
    Object.assign(this, { name, symbol, instructions, labels, text, true_instructions, section }); Object.freeze(this);
  }
}

export function loadTarget(target, { objdump = null, symbol = null, section = ".text", cwd = process.cwd(), env = process.env } = {}) {
  const [text, instructions] = dumpObject(target, { objdump, symbol, section, cwd, env });
  return new TargetObject({ name: displayPath(target, cwd), symbol, instructions, labels: symbolLabels(text), text,
    true_instructions: resolveTrueInstructions(target, { symbol, section, cwd }), section });
}

export function compareLoaded(target, candidate) {
  const warnings = selectionWarnings(target.text, candidate.text, { symbol: target.symbol, target_name: target.name, candidate_name: candidate.name, section: target.section });
  return compareInstructions(target.instructions, candidate.instructions, { target_name: target.name, candidate_name: candidate.name, symbol: target.symbol,
    warnings, target_true_instructions: target.true_instructions, candidate_true_instructions: candidate.true_instructions,
    instruction_count_verified: target.true_instructions !== null && candidate.true_instructions !== null });
}

export function compareCandidate(target, candidate, { objdump = null, section = ".text", cwd = process.cwd(), env = process.env } = {}) {
  return compareLoaded(target, loadTarget(candidate, { objdump, symbol: target.symbol, section, cwd, env }));
}

export function compareObjects(target, candidate, { objdump = null, symbol = null, section = ".text", cwd = process.cwd(), env = process.env } = {}) {
  return compareCandidate(loadTarget(target, { objdump, symbol, section, cwd, env }), candidate, { objdump, section, cwd, env });
}
