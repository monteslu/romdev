// provenance.js - whether a result may be read as a match, or only as a
// reachability proof. Zero differing words from a run with allocator forcing
// enabled is a statement about the allocator, not the source; a caller that
// cannot say how the object was built gets `unknown`, which is never
// promotable.
//
// Plain JS ESM + JSDoc.

import { ValueError, strRepr } from "./py.js";

/** Environment variables whose presence means the allocator was steered. */
export const FORCING_ENVIRONMENT = Object.freeze(["CDX_FORCE", "CDX_COLOR_TABLE", "CDX_MAX_COLOR", "CDX_MAX_FORCE_ENTRY", "CDX_COST"]);

/** What a result supports, and the lines that say so. */
export class Claim {
  constructor(provenance, claim, lines) { Object.assign(this, { provenance, claim, lines }); Object.freeze(this); }
  get is_match() { return this.claim === "match"; }
}

/** `forced`, `stock`, or `unknown` for a build environment (null = unknown). */
export function classifyEnvironment(env) {
  if (env === null || env === undefined) return "unknown";
  const has = (n) => (env instanceof Map ? env.has(n) : Object.prototype.hasOwnProperty.call(env, n));
  if (FORCING_ENVIRONMENT.some(has)) return "forced";
  return "stock";
}

/** What an exact-or-not result may be claimed as. */
export function readResult({ exact, provenance }) {
  if (!["stock", "forced", "unknown"].includes(provenance)) throw new ValueError(`unknown provenance ${strRepr(provenance)}`);
  if (!exact) return new Claim(provenance, "no-claim", ["the candidate differs; nothing to claim beyond the measured residual."]);
  if (provenance === "forced") {
    return new Claim(provenance, "reachability-proof", [
      "NOT A MATCH: zero differing words under allocator forcing.",
      "  this proves the target's allocation is reachable in this web graph, which is a statement about the allocator, not the source.",
      "  a match needs the same result from the stock compiler; re-run without the forcing environment before claiming one.",
    ]);
  }
  if (provenance === "unknown") {
    return new Claim(provenance, "unverified", [
      "NOT CLAIMABLE: zero differing words, but the build environment was not supplied.",
      "  a forced run scores identically to a stock one, so this cannot be told apart from a reachability proof.",
      "  record the environment and re-read before claiming a match.",
    ]);
  }
  return new Claim(provenance, "match", [
    "match: zero differing words from stock compiler output.",
    "  the ordinary acceptance proofs still apply -- exact owned bytes, exact relocation identities, and a linked byte comparison.",
  ]);
}
