// ranking.js - mechanism-aware candidate ranking.
//
// Levenshtein distance is fine for rough triage and must not select late-stage
// winners. A large sweep ranked on one scalar optimises that scalar, and the
// scalar is not the thing you want.
//
// THE RULE THAT MATTERS MOST, and the reason this file exists rather than a
// sort comparator inlined somewhere: **`aligned_total` is only comparable
// between candidates in the SAME gap state.** A gap is an insertion or deletion
// in the aligned instruction stream. Once two candidates differ in how many
// gaps they have, their aligned totals were computed over different alignments
// and comparing them is meaningless - the candidate with more gaps can post a
// lower total precisely because fewer rows lined up to be counted. Ranking a
// mixed set by aligned_total silently prefers the WORSE candidate.
//
// So: candidates are partitioned by gap state. Within a partition, aligned
// metrics rank. Across partitions, the safe fallback ranks, and the response
// says which rule was applied and why.
//
// Plain JS ESM + JSDoc.

/** Mechanism dimensions, in the order a late-stage campaign resolves them. */
export const MECHANISM_DIMENSIONS = Object.freeze([
  "opcode",        // wrong instruction: a logic/shape problem, fix the C first
  "immediate",     // wrong constant: usually a type or literal problem
  "relocation",    // wrong symbol/addend: context or linker identity
  "register",      // allocation: the allocator web / global coloring
  "scheduling",    // row order: as1 ready-set, emitted line numbers
  "pool",          // literal/constant pool placement
]);

/**
 * Normalize one candidate's metrics into a comparable record.
 *
 * Accepts either a workbench comparison block (aligned_* fields) or romdev's
 * own compare result, so a mixed campaign can rank both.
 */
export function normalizeMetrics(c) {
  const cmp = c.comparison ?? c;
  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

  const gaps = num(cmp.aligned_gaps) ?? num(cmp.alignedGaps) ?? 0;
  const insertions = num(cmp.aligned_insertions) ?? 0;
  const deletions = num(cmp.aligned_deletions) ?? 0;

  const dims = {
    opcode: num(cmp.aligned_opcode) ?? num(cmp.opcodeMismatches) ?? 0,
    immediate: num(cmp.aligned_constant) ?? num(cmp.immediateMismatches) ?? 0,
    relocation: num(cmp.aligned_relocation) ?? num(cmp.relocationMismatches) ?? 0,
    register: num(cmp.aligned_register) ?? num(cmp.registerMismatches) ?? 0,
    scheduling: num(cmp.aligned_commutative) ?? num(cmp.reorderedRows) ?? 0,
    pool: num(cmp.aligned_pool) ?? 0,
  };
  const alignedTotal = num(cmp.aligned_total) ?? Object.values(dims).reduce((a, b) => a + b, 0);

  return {
    id: c.id ?? c.candidatePath ?? c.candidateSha ?? null,
    exact: cmp.accepted === true || c.exactFunctionMatch === true,
    // The GAP STATE is the partition key. Two candidates are only
    // aligned-comparable when these agree.
    gapState: `${gaps}/${insertions}/${deletions}`,
    gaps, insertions, deletions,
    alignedTotal,
    dimensions: dims,
    // The safe fallback: a raw edit distance is comparable across ANY pair,
    // because it does not depend on an alignment succeeding.
    distance: num(c.distance?.value ?? c.distance) ?? null,
    objectSha: c.objectSha ?? null,
    firstDivergentRow: num(cmp.first_divergent_row) ?? num(c.firstDivergentRow) ?? null,
    owningPass: c.owning_pass ?? c.owningPass ?? null,
  };
}

/** Which mechanism owns the residual: the first non-zero dimension in order. */
export function mechanismOwner(m) {
  for (const d of MECHANISM_DIMENSIONS) if ((m.dimensions[d] ?? 0) > 0) return d;
  return m.alignedTotal === 0 ? "none" : "unknown";
}

/**
 * Rank candidates.
 *
 * @param {object[]} candidates raw candidate records
 * @param {{preferTemporaryPrefix?:boolean}} [opts]
 */
export function rankCandidates(candidates, opts = {}) {
  const metrics = candidates.map(normalizeMetrics);

  // Deduplicate by OBJECT OUTCOME. Two different sources that compile to the
  // same object are one result, and counting them twice makes a sweep look
  // more productive than it was.
  const byObject = new Map();
  const duplicates = [];
  for (const m of metrics) {
    const key = m.objectSha ?? `__unique__${m.id}`;
    if (m.objectSha && byObject.has(key)) { duplicates.push({ id: m.id, sameObjectAs: byObject.get(key).id, objectSha: m.objectSha }); continue; }
    byObject.set(key, m);
  }
  const unique = [...byObject.values()];

  // Partition by gap state.
  const partitions = new Map();
  for (const m of unique) {
    if (!partitions.has(m.gapState)) partitions.set(m.gapState, []);
    partitions.get(m.gapState).push(m);
  }
  const mixed = partitions.size > 1;

  // Within one gap state, aligned metrics are comparable.
  const byAligned = (a, b) => {
    if (a.exact !== b.exact) return a.exact ? -1 : 1;
    if (a.alignedTotal !== b.alignedTotal) return a.alignedTotal - b.alignedTotal;
    // Tie-break by the dimension order: an opcode difference is a deeper
    // problem than a register one, so fewer opcode differences wins first.
    for (const d of MECHANISM_DIMENSIONS) {
      const da = a.dimensions[d] ?? 0, db = b.dimensions[d] ?? 0;
      if (da !== db) return da - db;
    }
    return 0;
  };
  // Across gap states, only the alignment-independent fallback is valid.
  const byFallback = (a, b) => {
    if (a.exact !== b.exact) return a.exact ? -1 : 1;
    const da = a.distance ?? Infinity, db = b.distance ?? Infinity;
    if (da !== db) return da - db;
    return (a.gaps ?? 0) - (b.gaps ?? 0);
  };

  let ranked, rule, why;
  if (!mixed) {
    ranked = unique.slice().sort(byAligned);
    rule = "aligned";
    why = `all ${unique.length} candidates share gap state ${unique[0]?.gapState ?? "n/a"}, so aligned metrics are directly comparable.`;
  } else if (opts.preferTemporaryPrefix && unique.every((m) => m.distance != null)) {
    ranked = unique.slice().sort(byFallback);
    rule = "fallback-distance";
    why = "temporary-prefix ranking was requested but the candidate set spans multiple gap states; its precondition (one gap state) does not hold, so the safe fallback was used instead.";
  } else {
    ranked = unique.slice().sort(byFallback);
    rule = "fallback-distance";
    why = `candidates span ${partitions.size} DIFFERENT gap states (${[...partitions.keys()].join(", ")}). `
      + "aligned_total is computed over an alignment, so totals from different gap states are not comparable - "
      + "a candidate with more gaps can post a LOWER total simply because fewer rows lined up to be counted. "
      + "Ranked by the alignment-independent distance instead.";
  }

  return {
    rankingRule: rule, rankingRationale: why,
    gapStates: [...partitions.keys()],
    mixedGapState: mixed,
    ranked: ranked.map((m, i) => ({ rank: i + 1, ...m, mechanismOwner: mechanismOwner(m) })),
    ...(duplicates.length ? { deduplicated: duplicates, deduplicatedNote: "these compiled to an object already represented; counting them would overstate the sweep's yield" } : {}),
    perGapState: Object.fromEntries([...partitions].map(([k, v]) => [k, v.length])),
    policy: "NEVER compare aligned_total across candidates with different gap state. Within one gap state, aligned metrics rank and "
      + "ties break by mechanism depth (opcode > immediate > relocation > register > scheduling > pool). Across gap states, only the "
      + "alignment-independent distance is valid, and the response says so rather than producing a confident wrong order.",
  };
}
