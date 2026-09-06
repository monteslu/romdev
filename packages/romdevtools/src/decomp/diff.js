// diff.js — compare a candidate function's instruction stream against the
// target's. Two layers, kept deliberately separate:
//
//   STRICT  — the acceptance test. Word-for-word equality of every encoded
//             instruction AND equality of every relocation (type + symbol +
//             addend). A same-shaped stream with a different call target fails
//             here even though the words match (the word is 0 under a
//             R_MIPS_26 reloc in both objects).
//   SCORED  — the ranking signal. A documented edit distance over NORMALIZED
//             instructions so a search can tell "closer" from "farther". It is
//             never presented as proof; `strict.exact` is.
//
// Classification is evidence-first: when a difference does not fit a named
// kind, the raw instruction pairs are returned and the kind is 'unclassified'.

const REG_RE = /\$?\b(zero|at|v[01]|a[0-3]|t[0-9]|s[0-8]|k[01]|gp|sp|fp|ra|f\d{1,2})\b/g;
const BRANCH_RE = /^(b|bc1|j|jal|jr|jalr)/;

/** Normalize one instruction for scoring: registers → their class, branch targets → relative. */
export function normalizeInstruction(ins, index, symbolOffset = 0) {
  let ops = ins.operands;
  if (BRANCH_RE.test(ins.mnemonic) && !/^j(al)?r?$/.test(ins.mnemonic)) {
    // objdump prints branch targets as absolute offsets within the section;
    // encode as delta from this instruction so a shifted function still aligns.
    ops = ops.replace(/\b(0x)?([0-9a-f]+)\s*$/i, (m) => {
      const tgt = parseInt(m, 16);
      return Number.isFinite(tgt) ? "rel" + (tgt - ins.offset) : m;
    });
  }
  const relocKey = ins.reloc ? `${ins.reloc.type}:${ins.reloc.symbol}${ins.reloc.addend ? "+" + ins.reloc.addend : ""}` : "";
  return { mnemonic: ins.mnemonic, ops, regs: (ins.operands.match(REG_RE) ?? []).join(","), opsNoRegs: ops.replace(REG_RE, "R"), reloc: relocKey };
}

/** Strict per-instruction comparison. */
export function strictCompare(target, candidate) {
  const n = Math.max(target.length, candidate.length);
  const mismatches = [];
  for (let i = 0; i < n; i++) {
    const a = target[i], b = candidate[i];
    if (!a || !b) { mismatches.push({ index: i, kind: !a ? "extra-instruction" : "missing-instruction", target: a ? fmt(a) : null, candidate: b ? fmt(b) : null }); continue; }
    const wordEq = a.word === b.word;
    const relocEq = relocKey(a.reloc) === relocKey(b.reloc);
    if (wordEq && relocEq) continue;
    mismatches.push({ index: i, kind: !relocEq && wordEq ? "relocation-target" : "instruction", target: fmt(a), candidate: fmt(b) });
  }
  return { exact: mismatches.length === 0, targetBytes: target.length * 4, candidateBytes: candidate.length * 4, mismatchCount: mismatches.length, mismatches };
}

/** Levenshtein over normalized instruction lines with a substitution cost that
 * distinguishes register-only differences (0.35) from anything else (1.0). */
export function scoreDistance(target, candidate) {
  const A = target.map((ins, i) => normalizeInstruction(ins, i));
  const B = candidate.map((ins, i) => normalizeInstruction(ins, i));
  const n = A.length, m = B.length;
  const prev = new Float64Array(m + 1);
  const cur = new Float64Array(m + 1);
  for (let j = 0; j <= m; j++) prev[j] = j;
  for (let i = 1; i <= n; i++) {
    cur[0] = i;
    for (let j = 1; j <= m; j++) {
      const a = A[i - 1], b = B[j - 1];
      let sub;
      if (a.mnemonic === b.mnemonic && a.ops === b.ops && a.reloc === b.reloc) sub = 0;
      else if (a.mnemonic === b.mnemonic && a.opsNoRegs === b.opsNoRegs && a.reloc === b.reloc) sub = 0.35; // register allocation only
      else if (a.mnemonic === b.mnemonic && a.reloc === b.reloc) sub = 0.7; // same op, different immediate/offset
      else sub = 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + sub);
    }
    prev.set(cur);
  }
  const value = Math.round(prev[m] * 100) / 100;
  return { metric: "levenshtein-instructions-v1", value, note: "edit distance over normalized instructions: insert/delete=1, register-only substitution=0.35, same-op immediate/offset=0.7, other=1; branch targets compared relative to the instruction; relocation symbol+type part of the line. Lower is closer. 0 is NOT proof — strict.exact is." };
}

/**
 * Classify the strict mismatches into named kinds with evidence. Never invents
 * an explanation: an unfittable difference stays 'unclassified' with the pairs.
 */
export function classifyDifferences(target, candidate, strict) {
  const kinds = new Set();
  const evidence = { registerSubstitutions: [], immediateDifferences: [], branchTargetDifferences: [], relocationDifferences: [], stackFrame: null, instructionCount: null, reordered: false, unclassified: [] };
  if (target.length !== candidate.length) { kinds.add("instruction-count"); evidence.instructionCount = { target: target.length, candidate: candidate.length }; }
  // Stack frame: first addiu sp,sp,-N.
  const frame = (s) => { const f = s.find((i) => i.mnemonic === "addiu" && /^sp,sp,-/.test(i.operands)); return f ? f.operands : null; };
  const ft = frame(target), fc = frame(candidate);
  if (ft !== fc) { kinds.add("stack-frame"); evidence.stackFrame = { target: ft, candidate: fc }; }
  // Multiset reorder check (same instructions, different order) on the aligned length.
  if (target.length === candidate.length && strict.mismatchCount > 0) {
    const key = (i) => `${i.mnemonic} ${i.operands} ${relocKey(i.reloc)}`;
    const ta = target.map(key).sort().join("\n"), ca = candidate.map(key).sort().join("\n");
    if (ta === ca) { kinds.add("instruction-scheduling"); evidence.reordered = true; }
  }
  for (const mm of strict.mismatches) {
    const a = target[mm.index], b = candidate[mm.index];
    if (!a || !b) continue;
    if (mm.kind === "relocation-target") { kinds.add("relocation-target"); evidence.relocationDifferences.push({ index: mm.index, target: relocKey(a.reloc), candidate: relocKey(b.reloc), mnemonic: a.mnemonic }); continue; }
    const na = normalizeInstruction(a, mm.index), nb = normalizeInstruction(b, mm.index);
    if (na.mnemonic === nb.mnemonic && na.opsNoRegs === nb.opsNoRegs && na.reloc === nb.reloc) { kinds.add("register-allocation"); evidence.registerSubstitutions.push({ index: mm.index, mnemonic: a.mnemonic, target: na.regs, candidate: nb.regs }); continue; }
    if (na.mnemonic === nb.mnemonic && BRANCH_RE.test(na.mnemonic)) { kinds.add("branch-target"); evidence.branchTargetDifferences.push({ index: mm.index, target: a.operands, candidate: b.operands }); continue; }
    if (na.mnemonic === nb.mnemonic && na.regs === nb.regs) { kinds.add("immediate"); evidence.immediateDifferences.push({ index: mm.index, mnemonic: a.mnemonic, target: a.operands, candidate: b.operands }); continue; }
    if (!evidence.reordered) evidence.unclassified.push({ index: mm.index, target: fmt(a), candidate: fmt(b) });
  }
  if (evidence.unclassified.length) kinds.add("unclassified");
  // Trim evidence lists so a result stays bounded; counts stay exact.
  const cap = (arr) => ({ count: arr.length, first: arr.slice(0, 12) });
  return {
    kinds: [...kinds],
    evidence: {
      instructionCount: evidence.instructionCount, stackFrame: evidence.stackFrame, reordered: evidence.reordered,
      registerSubstitutions: cap(evidence.registerSubstitutions), immediateDifferences: cap(evidence.immediateDifferences),
      branchTargetDifferences: cap(evidence.branchTargetDifferences), relocationDifferences: cap(evidence.relocationDifferences),
      unclassified: cap(evidence.unclassified),
    },
  };
}

/** Changed ranges (contiguous mismatch indices) for a compact overview. */
export function changedRanges(strict, maxRanges = 24) {
  const ranges = [];
  let cur = null;
  for (const mm of strict.mismatches) {
    if (cur && mm.index === cur.end + 1) { cur.end = mm.index; continue; }
    cur = { start: mm.index, end: mm.index }; ranges.push(cur);
  }
  return { count: ranges.length, ranges: ranges.slice(0, maxRanges).map((r) => ({ start: r.start, end: r.end, bytes: (r.end - r.start + 1) * 4 })) };
}

/** Side-by-side text diff of the mismatching region, bounded. */
export function renderDiff(target, candidate, strict, maxLines = 40) {
  const lines = [];
  const idx = new Set(strict.mismatches.map((m) => m.index));
  const n = Math.max(target.length, candidate.length);
  let shown = 0;
  for (let i = 0; i < n && shown < maxLines; i++) {
    if (!idx.has(i)) continue;
    const a = target[i] ? fmt(target[i]) : "(none)";
    const b = candidate[i] ? fmt(candidate[i]) : "(none)";
    lines.push(`${String(i).padStart(4)}  ${a.padEnd(44)} | ${b}`);
    shown++;
  }
  if (strict.mismatches.length > shown) lines.push(`... ${strict.mismatches.length - shown} more mismatching instructions (see the diff artifact)`);
  return lines.join("\n");
}

function relocKey(r) { return r ? `${r.type}:${r.symbol}${r.addend ? "+" + r.addend : ""}` : ""; }
function fmt(i) { return `${i.mnemonic} ${i.operands}${i.reloc ? `  {${relocKey(i.reloc)}}` : ""}`.trim(); }
export { relocKey, fmt as formatInstruction };
