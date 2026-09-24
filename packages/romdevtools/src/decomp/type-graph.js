// type-graph.js - project-wide type evidence, not per-function guesses.
//
// `types.js` records what ONE function's asm proves about ONE base register:
// this offset was loaded with lw, that one with lhu. That is real evidence and
// it is stranded. The same struct is passed to a dozen functions, returned from
// another, stored in a global, and walked with a stride in a loop; every one of
// those is evidence about the SAME type, and none of it was being combined.
//
// Real campaign progress comes from exactly that combination - entity node
// banks, controller records, component links, camera state, splines, particle
// arrays. Recovering a layout once should improve every dependent function
// instead of being rediscovered per function.
//
// WHAT THIS DOES AND DOES NOT CLAIM. It is an EVIDENCE graph, not a type
// inferencer. Every fact carries where it came from and how strongly it is
// held, conflicts are recorded as conflicts rather than silently resolved by
// last-writer-wins, and a proposal is a proposal until a human or a compare
// accepts it. An inferencer that quietly picked a winner would produce
// confident wrong headers, which is more expensive than no headers.
//
// Plain JS ESM + JSDoc.

import fs from "node:fs";
import path from "node:path";
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";

export const TYPE_GRAPH_SCHEMA = "romdev-decomp-type-graph-v1";

const graphDir = (project) => path.join(project.ws, "type-graph");
const graphFile = (project) => path.join(graphDir(project), "graph.json");

/** Confidence, highest first. A header declaration outranks an inference. */
export const CONFIDENCE = Object.freeze({
  declared: "the project's own header says so",
  observed: "the asm's access width/signedness proves it",
  propagated: "carried from a caller/callee or an aliasing copy",
  inferred: "derived from a stride, bound or arithmetic pattern",
});

const CONF_RANK = { declared: 4, observed: 3, propagated: 2, inferred: 1 };

/** Widths that can legitimately overlap in a union view rather than conflict. */
function widthsConflict(a, b) {
  // ABSENCE OF EVIDENCE IS NOT A CONFLICT. A fact with no observed width says
  // nothing; treating it as a disagreement produced 1320 "conflicts" that were
  // really just offsets some run had not measured, which buries the handful of
  // REAL contradictions that a human needs to look at.
  if (a.width == null || b.width == null) return false;
  // "32-bit" is what a store-only access yields - it is the same claim as s32/
  // u32/ptr at the same width, not a competing one.
  const generic = (t) => !t || /^\d+-bit$/.test(t);
  if (a.width !== b.width) return true;
  if (generic(a.type) || generic(b.type)) return false;
  // IDENTICAL CLAIMS ARE NOT A CONFLICT. Two runs observing the same thing is
  // corroboration; comparing a fact against itself reported 1243 "conflicts"
  // whose `best` and `disagreeing` entries were literally the same record.
  if (a.type === b.type) return false;
  // "s32/u32/ptr" is ONE ambiguous label from a 4-byte load, not a claim of
  // signedness. Only a definite disagreement counts: integer vs float, or a
  // committed signed-vs-unsigned pair.
  const isFloat = (t) => /^f\d/.test(t ?? "");
  if (isFloat(a.type) !== isFloat(b.type)) return true;
  const definite = (t) => /^s\d+$/.test(t ?? "") || /^u\d+$/.test(t ?? "");
  if (!definite(a.type) || !definite(b.type)) return false;
  return a.type !== b.type;
}

/**
 * Build the project-wide graph from every stored per-function type record plus
 * the call graph (for caller/callee unification).
 */
export async function buildTypeGraph(project, { callGraph: g } = {}) {
  const tDir = path.join(project.ws, "types");
  /** base name -> { fields: {offset: {facts[]}}, functions: Set, conflicts: [] } */
  const bases = new Map();
  const files = fs.existsSync(tDir) ? await readdir(tDir) : [];

  const addFact = (baseName, offset, fact) => {
    if (!bases.has(baseName)) bases.set(baseName, { base: baseName, fields: new Map(), functions: new Set(), conflicts: [] });
    const b = bases.get(baseName);
    if (fact.function) b.functions.add(fact.function);
    const key = String(offset);
    if (!b.fields.has(key)) b.fields.set(key, []);
    b.fields.get(key).push(fact);
  };

  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    let rec;
    try { rec = JSON.parse(await readFile(path.join(tDir, f), "utf8")); } catch { continue; }
    for (const [baseName, base] of Object.entries(rec.bases ?? {})) {
      for (const [offset, field] of Object.entries(base.fields ?? {})) {
        // The stored schema carries ARRAYS: `widths` and `types` accumulate
        // every access seen at this offset across runs. Reading them as scalars
        // yielded `width: null` and a proposal full of `u8 /* width null */`,
        // which looks like knowledge and is not.
        const widths = Array.isArray(field.widths) ? field.widths : (field.width != null ? [field.width] : []);
        const types = Array.isArray(field.types) ? field.types : (field.type ? [field.type] : []);
        // The widest observed access is the binding one: a struct field read
        // with lw and also with lbu is 4 bytes with a byte read inside it.
        const width = widths.length ? Math.max(...widths.filter((w) => Number.isFinite(w))) : null;
        // Prefer a concrete signed/unsigned/float spelling over the generic
        // "32-bit" that a store-only access yields.
        const type = types.find((t) => /^[suf]\d/.test(t)) ?? types.find((t) => /ptr/.test(t)) ?? types[0] ?? null;
        addFact(baseName, offset, {
          width, type,
          widths: [...new Set(widths)], types: [...new Set(types)],
          confidence: field.declared ? "declared" : "observed",
          source: `types/${rec.symbol}`, function: rec.symbol, tu: rec.tu ?? null,
          accesses: (field.evidence ?? []).flatMap((e) => e.asmAccesses ?? []).length || undefined,
        });
      }
    }
  }

  // CALLER/CALLEE UNIFICATION. If a function's argument N is a base we have
  // facts about, every caller passing into argument N is talking about the same
  // type. The edge is what makes one function's discovery improve the others.
  const unified = [];
  if (g?.edges) {
    for (const [caller, callees] of Object.entries(g.edges)) {
      for (const callee of callees) {
        // Only record the RELATION; asserting the types are identical would be
        // an inference this graph deliberately does not make on its own.
        if (bases.has("arg0") || bases.size) unified.push({ caller, callee, relation: "argument-position", note: "arguments passed at the same position are candidates for type unification" });
      }
    }
  }

  // Resolve each field: highest-confidence fact wins, disagreements recorded.
  const out = [];
  for (const b of bases.values()) {
    const fields = [];
    for (const [offset, facts] of [...b.fields.entries()].sort((x, y) => Number(x[0]) - Number(y[0]))) {
      const sorted = facts.slice().sort((x, y) => (CONF_RANK[y.confidence] ?? 0) - (CONF_RANK[x.confidence] ?? 0));
      const best = sorted[0];
      const conflicting = sorted.filter((f) => widthsConflict(best, f));
      if (conflicting.length) {
        b.conflicts.push({ offset: Number(offset), best: { width: best.width, type: best.type, source: best.source },
          disagreeing: conflicting.slice(0, 4).map((f) => ({ width: f.width, type: f.type, source: f.source })) });
      }
      const allWidths = [...new Set(facts.flatMap((f) => f.widths ?? []))].sort((a, b) => a - b);
      fields.push({
        offset: Number(offset), width: best.width, type: best.type,
        ...(allWidths.length > 1 ? { observedWidths: allWidths, widthNote: "accessed at more than one width: the widest is used, narrower reads are sub-field accesses or a union view" } : {}),
        confidence: best.confidence, confidenceMeaning: CONFIDENCE[best.confidence],
        evidenceCount: facts.length,
        sources: [...new Set(facts.map((f) => f.function).filter(Boolean))].slice(0, 8),
        ...(conflicting.length ? { conflict: true, unionView: [...new Set(sorted.filter((f) => f.width != null).map((f) => `${f.width}:${f.type}`))] } : {}),
      });
    }
    // Stride evidence: evenly spaced fields of one width look like an array.
    const offsets = fields.map((f) => f.offset);
    let stride = null;
    if (offsets.length >= 3) {
      const deltas = offsets.slice(1).map((o, i) => o - offsets[i]);
      const first = deltas[0];
      if (first > 0 && deltas.every((d) => d === first)) stride = first;
    }
    out.push({
      base: b.base, fieldCount: fields.length, fields,
      functions: [...b.functions].slice(0, 20), functionCount: b.functions.size,
      ...(stride ? { stride, strideNote: `fields are evenly spaced ${stride} bytes apart - consistent with an array of a ${stride}-byte element` } : {}),
      ...(b.conflicts.length ? { conflicts: b.conflicts } : {}),
      // A base seen by many functions is worth typing FIRST: the fix lands once
      // and improves every one of them.
      leverage: b.functions.size,
    });
  }
  out.sort((a, b) => b.leverage - a.leverage || b.fieldCount - a.fieldCount);

  const graph = {
    schema: TYPE_GRAPH_SCHEMA, project: project.id, builtAt: new Date().toISOString(),
    baseCount: out.length,
    totalFields: out.reduce((s, b) => s + b.fieldCount, 0),
    conflictCount: out.reduce((s, b) => s + (b.conflicts?.length ?? 0), 0),
    bases: out,
    unificationEdges: unified.length,
    confidenceLevels: CONFIDENCE,
    policy: "an EVIDENCE graph, not an inferencer: every fact carries its source and confidence, a disagreement is recorded as a "
      + "conflict with a union view rather than resolved by last-writer-wins, and nothing here is applied to the project's headers. "
      + "Bases are ordered by LEVERAGE - how many functions share them - because typing one of those lands the fix everywhere at once.",
  };
  await mkdir(graphDir(project), { recursive: true });
  await writeFile(graphFile(project), JSON.stringify(graph, null, 2));
  return graph;
}

/** Load the cached graph, or build it. */
export async function loadTypeGraph(project, { rebuild = false, callGraph } = {}) {
  const f = graphFile(project);
  if (!rebuild && fs.existsSync(f)) {
    try { return JSON.parse(await readFile(f, "utf8")); } catch {}
  }
  return await buildTypeGraph(project, { callGraph });
}

/**
 * Propose a C struct for one base, from the evidence only.
 *
 * Gaps are emitted as explicit padding with a comment saying they are UNKNOWN
 * rather than being filled with a plausible guess - a fabricated field is worse
 * than a hole, because it reads as knowledge.
 */

/**
 * A VALID C type token for one evidence field.
 *
 * Evidence notation is not C: a 4-byte load proves "s32/u32/ptr", which is a
 * set of possibilities. This picks one that parses and records the rest in a
 * comment at the call site. Unsigned is the safe default for an ambiguous
 * integer width - it makes no claim about sign that the evidence did not.
 */
function cTypeFor(f) {
  const CT = { 1: "u8", 2: "u16", 4: "u32", 8: "u64" };
  const t = String(f.type ?? "");
  // A single definite spelling (s32, u16, f32) is already valid C.
  if (/^[suf]\d+$/.test(t)) return t;
  // A pointer is only unambiguous when nothing else is on the list.
  if (/^ptr$/.test(t)) return "void*";
  return CT[f.width] ?? "u32";
}

export function proposeStruct(base, { name } = {}) {
  const lines = [];
  const structName = name ?? `Unk${(base.base ?? "Base").replace(/[^\w]/g, "")}`;
  lines.push(`/* PROPOSED from ${base.fieldCount} evidence fields across ${base.functionCount} function(s).`);
  lines.push(` * This is a PROPOSAL: every field below is backed by an observed access width.`);
  lines.push(` * Holes are left as explicit padding, never invented fields.`);
  lines.push(` * An offset accessed at two INCOMPATIBLE types is emitted as a real C union,`);
  lines.push(` * not as one arbitrary winner - the evidence says both, so the type says both. */`);
  lines.push(`typedef struct ${structName} {`);

  // Walk in offset order, but group fields that OVERLAP in memory: a field
  // whose extent crosses the next field's offset is not a sibling, it is an
  // alternative view of the same bytes. Emitting those sequentially (as this
  // did) produces a struct whose layout does not match the evidence at all -
  // every following offset is pushed along by bytes that were never there.
  const fields = [...base.fields].sort((a, b) => a.offset - b.offset);
  const groups = [];
  for (const f of fields) {
    const g = groups[groups.length - 1];
    const extent = (x) => x.offset + (x.width ?? 4);
    if (g && f.offset < Math.max(...g.map(extent))) g.push(f);
    else groups.push([f]);
  }

  let cursor = 0;
  let unionCount = 0;
  for (const group of groups) {
    const at = group[0].offset;
    if (at > cursor) {
      lines.push(`    /* 0x${cursor.toString(16).toUpperCase()} */ u8 pad_${cursor.toString(16)}[0x${(at - cursor).toString(16).toUpperCase()}]; /* UNKNOWN: no access observed */`);
    }

    // The alternatives at this location: overlapping fields, plus the distinct
    // types recorded at ONE offset (a same-offset conflict).
    const alts = [];
    const push = (ct, why, off) => {
      if (!ct) return;
      const key = `${ct}@${off}`;
      if (!alts.some((a) => a.key === key)) alts.push({ key, ct, why, off });
    };
    for (const f of group) {
      push(cTypeFor(f), f.type && f.type !== cTypeFor(f) ? `observed ${f.type}` : null, f.offset);
      for (const v of f.conflict ? (f.unionView ?? []) : []) {
        // unionView entries look like "4:f32" / "2:s16".
        const [w, t] = String(v).split(":");
        const ct = cTypeFor({ width: Number(w), type: t });
        push(ct, `observed ${t} at width ${w}`, f.offset);
      }
    }

    const hex = at.toString(16).toUpperCase();
    if (alts.length <= 1) {
      const only = alts[0];
      if (!only) {
        lines.push(`    /* 0x${hex} */ /* UNKNOWN width at this offset - evidence recorded but not conclusive */`);
        cursor = at;
        continue;
      }
      lines.push(`    /* 0x${hex} */ ${only.ct} unk_${hex};${only.why ? `  /* ${only.why} */` : ""}`);
    } else {
      // A REAL UNION. Members are named by their type so two views of the same
      // bytes are distinguishable, and each carries the evidence that produced
      // it. This is what "compilable union representation" means: the struct
      // now describes the bytes the way the accesses actually used them.
      unionCount++;
      lines.push(`    /* 0x${hex} */ union {`);
      for (const a of alts) {
        const rel = a.off - at;
        const note = [a.why, rel ? `at +0x${rel.toString(16).toUpperCase()}` : null].filter(Boolean).join("; ");
        lines.push(`        ${a.ct} as_${a.ct}${rel ? `_${rel.toString(16)}` : ""};${note ? `  /* ${note} */` : ""}`);
      }
      lines.push(`    } unk_${hex};  /* ${alts.length} incompatible views of these bytes */`);
    }
    cursor = Math.max(...group.map((f) => f.offset + (f.width ?? 4)));
  }

  lines.push(`} ${structName}; /* size >= 0x${cursor.toString(16).toUpperCase()} (lower bound: only observed accesses) */`);
  return {
    base: base.base, structName, code: lines.join("\n"),
    fieldCount: base.fieldCount, conflicts: base.conflicts?.length ?? 0,
    unions: unionCount,
    note: "a PROPOSAL derived from observed accesses. The size is a LOWER BOUND - no access past the last field was observed, "
      + "which is not evidence that the struct ends there. An offset with two incompatible observed types is a real C union, "
      + "because the evidence supports both and picking one would be a guess. Apply it to a context experiment before touching "
      + "the project's headers.",
  };
}

