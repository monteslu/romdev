// geometry.js - structural ranking evidence (true extent, normalized and
// opcode edit distances) as Pareto layers, independent of exact matching.
//
// Plain JS ESM + JSDoc.

import { sorted } from "./py.js";

export const GEOMETRY_RANKING = "geometry-pareto";

/** Read [extent, edit, opcode] distances from a comparison record, or null. */
export function geometryVector(c) {
  const delta = c.true_insn_delta ?? c.true_instruction_delta;
  const layout = c.layout;
  const edit = layout && typeof layout === "object" ? layout.edit_distance : (c.norm ?? c.normalized_distance);
  const opcodes = c.opcode_distance;
  if (![delta, edit, opcodes].every((v) => Number.isInteger(v) && typeof v !== "boolean")) return null;
  if (edit < 0 || opcodes < 0) return null;
  return [Math.abs(delta), edit, opcodes];
}

/** Zero for nondominated vectors, increasing layers thereafter. */
export function paretoLayers(vectors) {
  const layers = new Map();
  const uniq = new Map(vectors.map((v) => [v.join(","), v]));
  for (const v of sorted([...uniq.values()])) {
    let best = -1;
    for (const [k, layer] of layers) { const o = k.split(",").map(Number); if (o.every((a, i) => a <= v[i]) && layer > best) best = layer; }
    layers.set(v.join(","), 1 + best);
  }
  return vectors.map((v) => layers.get(v.join(",")));
}
