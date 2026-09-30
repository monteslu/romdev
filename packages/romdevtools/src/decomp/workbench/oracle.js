// oracle.js - calibrated allocator-oracle planning and semantic trace
// comparison. A plan is a phase-complete grid of force cells built from the
// recorded decisions and the measured viable colors (never a guessed register
// universe); a sweep compiles the unforced baseline and every force through
// the campaign engine and names what each force changed in emitted code.
// Forced output is diagnostic evidence about a compiler decision, never an
// acceptable source match.
//
// Plain JS ESM + JSDoc.

import fs from "node:fs";
import { compareSemanticWebs, semanticWebs } from "./allocator-analysis.js";
import { DEFAULT_STREAM_LIMIT } from "./artifacts.js";
import { ParameterizedCandidate, runParameterizedCampaign, resolvePath } from "./campaign.js";
import { compareObjects } from "./compare.js";
import { optionalInteger, registerForColor } from "./globalcolor.js";
import { ValueError, sorted, strRepr, isInputError } from "./py.js";
import { isReportedError } from "./py-extra.js";

export const PLAN_SCHEMA = "decomp-workbench-oracle-plan-v1";
export const DIFF_SCHEMA = "decomp-workbench-oracle-diff-v1";
export const SWEEP_SCHEMA = "decomp-workbench-oracle-sweep-v1";
export const EFFECT_SCHEMA = "decomp-workbench-oracle-emitted-effect-v1";
export const PHASES = Object.freeze(["p1", "p2"]);

const field = (fields, key) => (fields && Object.prototype.hasOwnProperty.call(fields, key) ? fields[key] : null);
const truthy = (v) => v !== null && v !== undefined && v !== "" && v !== 0 && v !== false;

function selectedProc(trace, proc) {
  const set = new Set();
  for (const item of trace.decisions) {
    if (item.phase !== "p1dec" && item.phase !== "p2dec") continue;
    const v = optionalInteger(field(item.fields, "proc"));
    if (v !== null) set.add(v);
  }
  const procedures = sorted([...set]);
  if (proc !== null && proc !== undefined) {
    if (!procedures.includes(proc)) {
      throw new ValueError(`procedure ${proc} has no allocator decisions; available: ${procedures.join(", ") || "none"}`);
    }
    return proc;
  }
  if (procedures.length !== 1) {
    throw new ValueError(`oracle planning requires --proc when the trace does not contain exactly one procedure; available: ${procedures.join(", ") || "none"}`);
  }
  return procedures[0];
}

function observedColors(trace, { proc }) {
  const colors = new Map();
  for (const item of trace.decisions) {
    const phase = item.phase.slice(0, 2);
    if (!PHASES.includes(phase)) continue;
    if (optionalInteger(field(item.fields, "proc")) !== proc) continue;
    if (item.phase === "p1cost" || item.phase === "p2cost") {
      const color = optionalInteger(field(item.fields, "color"));
      if (color !== null && color >= 0) {
        if (!colors.has(phase)) colors.set(phase, new Set());
        colors.get(phase).add(color);
      }
    }
  }
  return colors;
}

function sourceOf(web) {
  const out = {};
  for (const key of ["file", "line", "source", "expr", "listing"]) {
    const v = field(web.detail, key);
    if (truthy(v)) out[key] = v;
  }
  return out;
}

/** Build a phase-complete grid from recorded decisions and viable colors. */
export function oraclePlan(trace, { proc = null, colors = null, include_split = true } = {}) {
  const selected = selectedProc(trace, proc);
  const observed = observedColors(trace, { proc: selected });
  const overrides = new Map(Object.entries(colors ?? {}).map(([p, v]) => [p, new Set(v)]));
  const unknown = sorted([...overrides.keys()].filter((p) => !PHASES.includes(p)));
  if (unknown.length) throw new ValueError("unknown allocator phase(s): " + unknown.join(", "));
  const phaseColors = {};
  for (const phase of PHASES) phaseColors[phase] = sorted([...(overrides.get(phase) ?? observed.get(phase) ?? new Set())]);
  for (const [phase, values] of Object.entries(phaseColors)) {
    if (values.some((c) => c < 0 || c > 63)) throw new ValueError(`${phase} colors must be in the mask range c0..c63`);
  }
  const decisions = new Map();
  for (const decision of trace.allocatorWebs({ proc: selected })) {
    const key = `${decision.phase_tag}\u0000${decision.web}`;
    if (decisions.has(key)) {
      throw new ValueError(`trace repeats allocator decision ${decision.phase_tag}:w${decision.web}; use one invocation per oracle plan`);
    }
    decisions.set(key, decision);
  }
  const semantic = semanticWebs(trace, { proc: selected });
  const attributions = new Map(semantic.map((w) => [`${w.decision.phase_tag}\u0000${w.decision.web}`, w.source_attribution]));
  const forces = [];
  const coverage = {};
  for (const phase of PHASES) {
    const phaseWebs = sorted([...decisions.values()].filter((w) => w.phase_tag === phase), (w) => w.web);
    const before = forces.length;
    for (const web of phaseWebs) {
      const attribution = attributions.get(`${web.phase_tag}\u0000${web.web}`) ?? { classification: "run-local-unattributed" };
      for (const color of phaseColors[phase]) {
        if (web.forbidden_colors.includes(color)) continue;
        forces.push({ force: `${phase}:w${web.web}=c${color}`, phase, web: web.web, color, register: registerForColor(color),
          decision: field(web.fields, "decision"), source_attribution: attribution, source: sourceOf(web) });
      }
      if (include_split) {
        forces.push({ force: `${phase}:w${web.web}=s`, phase, web: web.web, color: null, register: null,
          decision: field(web.fields, "decision"), source_attribution: attribution, source: sourceOf(web) });
      }
    }
    coverage[phase] = { webs: phaseWebs.length, colors: phaseColors[phase], include_split, forces: forces.length - before,
      color_source: overrides.has(phase) ? "override" : "measured-cost-records" };
  }
  const recommendations = semantic.filter((w) => w.source_attribution.classification === "source-attributed").map((w) => ({
    force_key: w.decision.force_key, source_semantic: w.source_attribution.source_semantic,
    recommendation: "Use this direct source semantic handle to design a source lifetime, priority, or coalescing experiment.",
  }));
  const unattributed = semantic.filter((w) => w.source_attribution.classification === "run-local-unattributed").length;
  const warnings = [];
  for (const phase of PHASES) {
    if (coverage[phase].webs === 0) warnings.push(`${phase}: 0 allocator webs recorded`);
    else if (!phaseColors[phase].length && !include_split) warnings.push(`${phase}: no measured colors; pass an explicit ${phase} color set`);
  }
  return {
    schema: PLAN_SCHEMA,
    evidence: "diagnostic-oracle-plan",
    procedure: selected,
    coverage,
    both_phases_reported: PHASES.every((p) => p in coverage) && Object.keys(coverage).length === PHASES.length,
    forces,
    force_count: forces.length,
    source_attribution: {
      classification: !unattributed ? "source-attributed" : recommendations.length ? "mixed" : "run-local-unattributed",
      source_attributed_webs: recommendations.length,
      run_local_unattributed_webs: unattributed,
      source_experiment_recommendations: recommendations,
      next_gate: recommendations.length ? null
        : "Record a direct source_semantic for the allocator web; web, color, owner, lineage, and line fields remain run-local and do not support a source-experiment recommendation.",
    },
    warnings,
    proof: "Compiler-decision probes only. Forbidden colors are omitted; both phase namespaces are always reported, including zero-web phases.",
  };
}

/** Compare two allocator traces through stable semantic fingerprints. */
export function oracleDiff(target, candidate, { proc = null } = {}) {
  const semantic = compareSemanticWebs(target, candidate, { proc });
  return {
    schema: DIFF_SCHEMA, evidence: "diagnostic-oracle-diff", semantic, difference_count: semantic.difference_count,
    proof: "Compiler-decision evidence aligned by semantic provenance. Numeric web IDs and forced objects are never source-match evidence.",
  };
}

function compactResult(result) {
  const metadata = result.experiment && typeof result.experiment === "object" && !Array.isArray(result.experiment) ? result.experiment : {};
  const c = result.comparison;
  const compact = c ? {
    exact: c.exact, verdict: c.verdict, aligned_total: c.aligned_total, aligned_structural: c.aligned_structural,
    aligned_schedule: c.aligned_schedule, aligned_register: c.aligned_register, aligned_constant: c.aligned_constant,
    words: c.word_mismatches, candidate_instructions: c.candidate_instructions, target_instructions: c.target_instructions,
    candidate_sha256: c.candidate_sha256,
  } : null;
  const m = (k) => (k in metadata ? metadata[k] : null);
  return {
    force: m("force"), phase: m("phase"), web: m("web"), color: m("color"), register: m("register"), components: m("components"),
    baseline: !!metadata.baseline, returncode: result.returncode, cached: result.cached, duration_seconds: result.duration_seconds,
    cache_key: result.cache_key, object: result.object_path, comparison: compact,
    failure: c ? null : String(result.stderr ?? "").slice(-2048),
  };
}

/** What one force changed in emitted code (object-level attribution only). */
function emittedForceEffect(baseline, forced, { objdump, symbol, section }) {
  if (baseline.object_path === null || baseline.object_path === undefined || forced.object_path === null || forced.object_path === undefined) {
    return { schema: EFFECT_SCHEMA, available: false, reason: "baseline or forced object was not retained" };
  }
  const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
  if (!isFile(baseline.object_path) || !isFile(forced.object_path)) {
    return { schema: EFFECT_SCHEMA, available: false, reason: "baseline or forced object is unavailable" };
  }
  let comparison;
  try {
    comparison = compareObjects(baseline.object_path, forced.object_path, { objdump, symbol, section });
  } catch (e) {
    if (!isInputError(e) && !isReportedError(e)) throw e;
    return { schema: EFFECT_SCHEMA, available: false, reason: String(e.message ?? e) };
  }
  const siteGet = (row, k) => (row && typeof row.get === "function" ? row.get(k) : row?.[k]) ?? null;
  const all = comparison.diff_sites;
  const sites = all.filter((r) => siteGet(r, "class") !== "relocation-controlled")
    .map((r) => ({ index: siteGet(r, "index"), class: siteGet(r, "class"), baseline: siteGet(r, "target"), forced: siteGet(r, "candidate") }));
  const relocationSites = all.filter((r) => siteGet(r, "class") === "relocation-controlled").length;
  const registerOnly = sites.length > 0 && sites.every((r) => r.class === "register");
  let classification;
  if (!sites.length && !relocationSites && comparison.raw_word_mismatches === 0) classification = "no-emitted-effect";
  else if (!sites.length && relocationSites) classification = "relocation-only-effect";
  else if (registerOnly && comparison.instruction_delta === 0 && comparison.opcode_mismatches === 0) classification = "instruction-neutral-register-effect";
  else classification = "emitted-code-effect";
  return {
    schema: EFFECT_SCHEMA, available: true, classification, changed_site_count: sites.length, relocation_controlled_site_count: relocationSites,
    changed_sites: sites, raw_word_mismatches: comparison.raw_word_mismatches, relocation_target_mismatches: comparison.relocation_target_mismatches,
    instruction_delta: comparison.instruction_delta, opcode_mismatches: comparison.opcode_mismatches, aligned_total: comparison.aligned_total,
    proof_boundary: "Controlled baseline-to-force object delta. Instruction text can identify a likely value role, but this is not source_semantic "
      + "and forced output is never an acceptable source match.",
  };
}

/** Compile the baseline and one source under every validated force cell. */
export async function runOracleCampaign(plan, { source, target, template, environment, cache_dir, ledger = null, jobs = 1, objdump = null, symbol = null,
  section = ".text", compile_cwd = null, keep_objects = null, timeout = 120.0, stream_limit = DEFAULT_STREAM_LIMIT, artifact_dir = null,
  campaign = runParameterizedCampaign }) {
  if (plan?.schema !== PLAN_SCHEMA) throw new ValueError(`oracle sweep requires a ${PLAN_SCHEMA} plan`);
  const procedure = Math.trunc(Number(plan.procedure));
  if ("CDX_FORCE" in environment) throw new ValueError("oracle owns CDX_FORCE; remove it from --env and select forces in the plan");
  if ("CDX_PROC" in environment && environment.CDX_PROC !== String(procedure)) {
    throw new ValueError(`trace selected proc ${procedure}, but --env supplied CDX_PROC=${strRepr(environment.CDX_PROC)}`);
  }
  const baseEnv = { ...environment, CDX_PROC: String(procedure) };
  const variants = [new ParameterizedCandidate({ source, environment: baseEnv, metadata: { schema: SWEEP_SCHEMA, baseline: true, force: null } })];
  for (const row of plan.forces) {
    if (!row || typeof row !== "object" || Array.isArray(row) || typeof row.force !== "string") throw new ValueError("oracle plan contains an invalid force row");
    variants.push(new ParameterizedCandidate({ source, environment: { ...baseEnv, CDX_FORCE: row.force }, metadata: { schema: SWEEP_SCHEMA, baseline: false, ...row } }));
  }
  const results = await campaign(variants, { target, template, cache_dir, ledger, jobs, objdump, symbol, section, compile_cwd,
    keep_objects, stop_on_exact: false, timeout, stream_limit, artifact_dir });
  const baselineResult = results.find((r) => r.experiment && typeof r.experiment === "object" && r.experiment.baseline) ?? null;
  const compact = [];
  for (const result of results) {
    const row = compactResult(result);
    if (!row.baseline && baselineResult) row.emitted_effect = emittedForceEffect(baselineResult, result, { objdump, symbol, section });
    compact.push(row);
  }
  const baseline = compact.find((r) => r.baseline) ?? null;
  const forced = sorted(compact.filter((r) => !r.baseline), (r) => [r.comparison === null,
    r.comparison && typeof r.comparison === "object" ? [Math.trunc(Number(r.comparison.aligned_total)), Math.trunc(Number(r.comparison.words))] : [],
    String(r.force)]);
  const observedExact = forced.filter((r) => r.comparison && r.comparison.exact).map((r) => String(r.force));
  const baselineComparison = baseline ? baseline.comparison : null;
  const controlValid = !!(baselineComparison && typeof baselineComparison === "object");
  const baselineExact = !!(controlValid && baselineComparison.exact);
  const exactRows = controlValid && !baselineExact ? forced.filter((r) => r.comparison && r.comparison.exact) : [];
  const exactForces = exactRows.map((r) => String(r.force));
  const widths = exactRows.map((r) => (Array.isArray(r.components) && r.components.length ? r.components.length : 1));
  const minimum = widths.length ? Math.min(...widths) : null;
  let signature;
  if (!exactForces.length) signature = null;
  else if (minimum === 1) signature = exactForces.length === 1 ? `one-force-exact(${exactForces[0]})` : `one-force-exact(${exactForces.length} alternatives)`;
  else {
    const minimumRows = exactForces.filter((_, i) => widths[i] === minimum);
    signature = minimumRows.length === 1 ? `force-set-exact(${minimumRows[0]})` : `force-set-exact(${minimum} controls; ${minimumRows.length} alternatives)`;
  }
  return {
    schema: SWEEP_SCHEMA, evidence: "diagnostic-oracle", procedure, coverage: plan.coverage, planned_forces: plan.forces.length,
    completed_forces: forced.length, baseline, results: forced, control_valid: controlValid, baseline_exact: baselineExact,
    observed_exact_forces: observedExact, exact_forces: exactForces, minimum_forces_to_exact: minimum, signature,
    ledger: ledger ? resolvePath(String(ledger)) : null,
    objects: keep_objects ? resolvePath(String(keep_objects)) : null,
    proof: "A forced exact row is causal only with a valid, non-exact unforced control. Forced compiler output is never an acceptable source match; "
      + "return to source-level lifetime and priority levers.",
    warnings: !controlValid ? ["unforced baseline failed; exact force rows are not causal evidence"]
      : baselineExact ? ["unforced baseline is already exact; no force closed a residual"] : [],
  };
}

