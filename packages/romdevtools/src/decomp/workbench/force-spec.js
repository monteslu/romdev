// force-spec.js - handoff from register permutations to allocator
// oracle tooling: the observed permutation, never invented allocator web ids.
//
// Plain JS ESM + JSDoc.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { uncolorableTargets } from "./view.js";
import { dumps } from "./pyjson.js";
import { ValueError } from "./py.js";
import { OSError } from "./py-extra.js";

export const FORCE_SPEC_SCHEMA = "decomp-workbench-diagnostic-force-v1";

/** Describe the observed permutation without inventing allocator web ids. */
export function forceSpecification(view) {
  if (view.verdict === "register-ring-only") {
    const named = uncolorableTargets(view.webs, view.register_profile).map((w) => w.target).join(", ");
    throw new ValueError("--emit-force-spec cannot address this residual: every target "
      + `register in it (${named}) is outside the era's colorable set, so `
      + "no supported direct forced color reaches one. This does not "
      + "exclude upstream coloring/reservation effects on temporary "
      + "allocation. Establish per-procedure register roles first.");
  }
  if (view.verdict !== "register-permutation") throw new ValueError("--emit-force-spec requires a register-permutation verdict");
  const ringOnly = new Set(uncolorableTargets(view.webs, view.register_profile).map((w) => w.web));
  return {
    schema: FORCE_SPEC_SCHEMA,
    evidence: "diagnostic-oracle-input",
    proof: "Observed register permutation only. The wN labels are local aligned "
      + "groups, not compiler allocator web IDs; join them to a calibrated "
      + "trace before constructing CDX_FORCE controls."
      + (ringOnly.size ? " Entries marked ring_only_target want a register the era's "
        + "supported palette cannot force directly. Indirect reservation "
        + "effects on those temporary sites remain possible." : ""),
    target: view.target, candidate: view.candidate, symbol: view.symbol, register_profile: view.register_profile,
    permutation: view.webs.map((web) => ({
      aligned_web: web.web, target_register: web.target, candidate_register: web.candidate,
      affected_indices: [...web.rows], sites: web.count, allocator_web: null, phase: null, ring_only_target: ringOnly.has(web.web),
    })),
  };
}

/** Expand `~` and resolve against the working directory, like Path.expanduser().resolve(). */
export function expandResolve(p, cwd = process.cwd()) {
  const e = p === "~" || p.startsWith("~/") ? os.homedir() + p.slice(1) : p;
  return path.resolve(cwd, e);
}

/** Write a diagnostic permutation handoff without overwriting a file. */
export function writeForceSpecification(view, p, { cwd = process.cwd() } = {}) {
  const output = expandResolve(String(p), cwd);
  if (fs.existsSync(output)) throw new OSError(`refusing to overwrite force specification: ${output}`);
  const text = dumps(forceSpecification(view)) + "\n";
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, text, { flag: "wx" });
  return output;
}
