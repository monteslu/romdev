// setup.js - a decomp checkout's own setup/extract targets (ROM decompression,
// splitting with splat, segment and asset extraction), run through romdev's
// recipe runner: splat is romdev-splat (JS), the project's setup scripts are
// JS ports matched by content hash, its native tools are WASM builds. No host
// python, make or compiler is run; a step romdev has no port for is reported
// and fails the target.
import fs from "node:fs";
import path from "node:path";
import { loadMakefile, buildGoal } from "./build.js";

/** The setup goals a Makefile offers, in the order a fresh checkout runs them. */
export function defaultSetupTargets(mk) {
  return ["setup", "extract"].filter((t) => mk.findRule(t));
}

/**
 * Run a checkout's setup goals (default: `setup` then `extract`, whichever the
 * Makefile has).
 * @param {{root:string, targets?:string[], makeVariables?:Record<string,string>, tmpRoot?:string, jobs?:number}} o
 */
export async function runProjectSetup({ root, targets, makeVariables = {}, tmpRoot, jobs = 8 }) {
  if (!root || !fs.existsSync(path.join(root, "Makefile"))) throw Object.assign(new Error(`no Makefile in '${root}'`), { code: "BAD_ARGS" });
  const tmp = tmpRoot ?? path.join(root, ".romdev-tmp");
  fs.mkdirSync(tmp, { recursive: true });
  const results = [];
  try {
    for (const goal of targets?.length ? targets : defaultSetupTargets(await loadMakefile(root, { overrides: makeVariables }))) {
      // Read the Makefile again per goal: an earlier goal may have written files it includes.
      const mk = await loadMakefile(root, { overrides: makeVariables });
      const r = await buildGoal(mk, goal, { jobs, tmpRoot: tmp });
      results.push({ goal, ok: r.ok, built: r.built.length, providedByRomdev: r.providedByRomdev, failed: r.failed, ms: r.ms,
        log: Object.values(r.logs).join("").slice(-4000) });
      if (!r.ok) break;
    }
  } finally {
    if (!tmpRoot) fs.rmSync(tmp, { recursive: true, force: true });
  }
  return { root, ok: results.length > 0 && results.every((r) => r.ok), goals: results };
}
