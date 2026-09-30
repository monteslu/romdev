// campaign-cli.js - source campaign journeys: `campaign` (run), `compile-rank`
// and the persistent cockpit (status, survey, resume, note, export, package,
// finish, checkpoint, restore-best, accept, dossier-add, dossier-list).
//
// Plain JS ESM + JSDoc.

import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { dumps } from "./pyjson.js";
import { pyRepr } from "./pyrepr.js";
import { pyRound, sorted, osErrorText, splitlines } from "./py.js";
import * as O from "./cli-options.js";
import { fileSha256, runCampaign, prepareCandidates, groupObjectBasins, resolvePath } from "./campaign.js";
import { finishCampaign } from "./campaign-finish.js";
import { buildStatus, campaignIdentity, durableSourcePath, exportStatus, finalizeSourceRetention, findManifest, finishManifest,
  initializeManifest, recordControlPreflight, remainingSources, updateHypothesis, validateResume } from "./campaign-state.js";
import { surveyCampaign, surveyLines } from "./campaign-survey.js";
import { acceptBest, checkpointCampaign, restoreBest } from "./candidate-lifecycle.js";
import { MIXED_ALIGNMENT_CAUTION } from "./compare.js";
import { RESULTS as DOSSIER_RESULTS, appendEntry, dossierReport } from "./dossier.js";
import { parseEnvironment, mergeToolchainEnvironment, resolveCompilerEnvironment } from "./environment.js";
import { discoverObjdump } from "./objdump.js";
import { selectedFields } from "./schema.js";
import { FileNotFoundError, OSError } from "./py-extra.js";
import { loadsJson } from "./json-error.js";

const EM = "\u2014", ARROW = "\u2192";
const isDict = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const pyS = (v) => (v === null || v === undefined ? "None" : v === true ? "True" : v === false ? "False" : Array.isArray(v) || isDict(v) ? pyRepr(v) : String(v));
const escapeHtml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");

/** The errors a campaign command reports as `error: ...` exit 2. */
export function reportable(e) {
  return e instanceof OSError || e?.name === "ValueError" || e?.name === "RuntimeError" || e?.name === "OSError" || e?.name === "FileNotFoundError"
    || e?.name === "JSONDecodeError" || (e && typeof e.code === "string" && /^E[A-Z]+$/.test(e.code));
}
const errText = (e) => (e && typeof e.code === "string" && /^E[A-Z]+$/.test(e.code) && !e.kind ? osErrorText(e) : e.message);

export const CAMPAIGN_SUMMARY_KEYS = Object.freeze(["exact", "verdict", "structural_exact", "aligned_total", "aligned_structural", "aligned_schedule",
  "aligned_register", "aligned_constant", "aligned_commutative", "words", "raw", "norm", "opcodes", "regs", "fp", "target_insns", "insns", "insn_delta",
  "target_frame", "frame", "sha1", "sha256", "pool_exact", "pool_prefix_exact", "temp_prefix_exact", "first_temp_divergence", "first_divergent_row",
  "alignment_method"]);

/** The lane-prefix fields used by late-stage campaign ranking. */
export function allocationProgressLabel(c) {
  const pool = c.pool_exact ? "exact" : pyS(c.pool_prefix_exact);
  const temp = c.temp_prefix_exact === null || c.temp_prefix_exact === undefined ? "exact" : String(c.temp_prefix_exact);
  const first = c.first_divergent_row === null || c.first_divergent_row === undefined ? "exact" : String(c.first_divergent_row);
  return `pool=${pool} temp-prefix=${temp} first-row=${first}`;
}

export function campaignAlignmentRankingUnsafe(results) { return results.some((i) => i.comparison && !i.comparison.alignment_comparable); }

/** Name the scale that actually ordered one campaign result set. */
export function campaignRankingLabel(results, { requested }) {
  if (requested !== "auto") return requested;
  return campaignAlignmentRankingUnsafe(results) ? "geometry-pareto" : "aligned_total";
}

const rank3 = (n) => String(n).padStart(3);

async function comparisonLineOf(c) { return (await import("./comparison-render.js")).comparisonLine(c); }

async function buildEnvironment(args) {
  let environment = parseEnvironment(args.env);
  if (args.toolchain) environment = await mergeToolchainEnvironment(environment, args.toolchain);
  return resolveCompilerEnvironment(environment, args.inherit_env);
}

/** Compatibility ranking surface backed by the campaign engine. */
export async function compileRankCommand(args, io) {
  let results;
  try {
    const environment = await buildEnvironment(args);
    [results] = await runCampaign(args.sources, { target: args.target, template: args.compile_command, cache_dir: args.cache_dir, objdump: args.objdump,
      symbol: args.symbol, section: args.section, environment, compile_cwd: args.compile_cwd, keep_objects: args.keep_objects, stop_on_exact: false,
      timeout: args.timeout, stream_limit: args.stream_limit, artifact_dir: args.artifact_dir, rank_by: args.rank_by, warn: (m) => io.eprint(m) });
  } catch (e) { if (!reportable(e)) throw e; io.eprint(`error: ${errText(e)}`); return 2; }
  const successes = results.filter((i) => i.comparison);
  const failures = results.filter((i) => !i.comparison);
  const rankedBy = campaignRankingLabel(results, { requested: args.rank_by });
  let ordered = [...successes, ...failures];
  if (args.limit) ordered = ordered.slice(0, args.limit);
  if (args.json) io.print(dumps(ordered.map((i) => i.asDict())));
  else {
    if (rankedBy === "geometry-pareto" && args.rank_by === "auto") io.print(MIXED_ALIGNMENT_CAUTION);
    const shown = args.limit ? successes.slice(0, args.limit) : successes;
    for (let i = 0; i < shown.length; i++) {
      const c = shown[i].comparison;
      io.print(`${rank3(i + 1)} ${await comparisonLineOf(c)}${args.rank_by === "temp-prefix" ? ` [${allocationProgressLabel(c)}]` : ""}`);
    }
    for (const r of failures) {
      const detail = splitlines(r.stderr.trim());
      io.eprint(`FAIL ${r.source}: ${detail.length ? detail.at(-1) : `exit ${r.returncode}`}`);
    }
  }
  return successes.length ? 0 : 1;
}

/** Compile, cache, rank, and record source candidates. */
export async function campaignCommand(args, io) {
  if (args.json && args.json_summary) { io.eprint("error: --json and --json-summary are mutually exclusive"); return 2; }
  const E = await import("./experiments.js");
  let manifestPath = null;
  let effectiveLedger = args.ledger;
  let controlReport = { status: "NOT DECLARED", passed: true, receipts: [] };
  let results, duplicates, experiment = null;
  const warn = (m) => io.eprint(m);
  try {
    if (args.no_ledger && args.ledger) throw Object.assign(new Error("--ledger and --no-ledger are mutually exclusive"), { name: "ValueError" });
    const environment = await buildEnvironment(args);
    const compileCwd = args.compile_cwd ? resolvePath(args.compile_cwd) : resolvePath(process.cwd());
    const envelope = Object.fromEntries(Object.entries({ compiler_id: args.compiler_id, frontend: args.frontend, language: args.language,
      driver: args.driver, backend: args.backend }).filter(([, v]) => v));
    const target = resolvePath(args.target);
    let targetIsFile = false; try { targetIsFile = fs.statSync(target).isFile(); } catch { /* absent */ }
    if (!targetIsFile) throw new FileNotFoundError(`target object does not exist: ${target}`);
    const objdump = discoverObjdump(args.objdump);
    experiment = args.experiment_manifest ? E.loadExperiment(args.experiment_manifest) : null;
    if (experiment !== null) E.validateCampaignSources(experiment, args.sources);
    let candidates = [];
    if (!args.no_ledger || experiment !== null) {
      [candidates] = prepareCandidates(args.sources, { template: args.compile_command, target, symbol: args.symbol, environment, compile_cwd: compileCwd,
        section: args.section, objdump, compilation_envelope: envelope });
    }
    const metadata = experiment !== null ? Object.fromEntries(candidates.map((c) => [c.cache_key, experiment.metadataFor(c.source)])) : null;
    if (!args.no_ledger) {
      const [identity, inputs] = await campaignIdentity({ target, symbol: args.symbol, section: args.section, template: args.compile_command, compile_cwd: compileCwd,
        environment, objdump, toolchain: args.toolchain,
        experiment: experiment !== null && experiment.schema === E.EXPERIMENT_SCHEMA_V2 ? experiment.identityReceipt() : null, compilation_envelope: envelope });
      let ledgerPath;
      [manifestPath, ledgerPath] = initializeManifest(candidates, { identity, identity_inputs: inputs, state_root: args.state_dir, ledger: args.ledger,
        cache_dir: args.cache_dir, artifact_dir: args.artifact_dir, jobs: args.jobs, timeout: args.timeout, stop_on_exact: args.stop_on_exact,
        experiment: experiment ? experiment.asDict() : null, rank_by: args.rank_by, retain_sources: args.retain_sources });
      effectiveLedger = ledgerPath;
    }
    if (experiment !== null && experiment.controls.length) {
      const { runControlPreflight } = await import("./experiment-controls.js");
      controlReport = await runControlPreflight(experiment, { target, template: args.compile_command, cache_dir: args.cache_dir, objdump, symbol: args.symbol,
        section: args.section, environment, compile_cwd: compileCwd, timeout: args.timeout, stream_limit: args.stream_limit, artifact_dir: args.artifact_dir,
        compilation_envelope: envelope });
      if (manifestPath !== null) recordControlPreflight(manifestPath, controlReport);
      if (!controlReport.passed) {
        if (manifestPath !== null) finishManifest(manifestPath, { results: 0, prepared: candidates.length, exact: false, control_invalid: true });
        const failure = { schema: "decomp-workbench-campaign-v1", status: "control-invalid", manifest: manifestPath !== null ? manifestPath : null,
          controls: controlReport, unique_candidates: 0, prepared_candidates: candidates.length, results: [] };
        if (args.json || args.json_summary) io.print(dumps(failure));
        else {
          io.eprint(`controls: FAIL ${EM} ordinary candidates were not scheduled`);
          for (const r of controlReport.receipts) io.eprint(`  ${r.id}: ${r.status} ${EM} ${r.reason}`);
        }
        return 2;
      }
    }
    [results, duplicates] = await runCampaign(args.sources, { target, template: args.compile_command, cache_dir: args.cache_dir, ledger: effectiveLedger,
      jobs: args.jobs, objdump, symbol: args.symbol, section: args.section, environment, compile_cwd: compileCwd, keep_objects: args.keep_objects,
      stop_on_exact: args.stop_on_exact, timeout: args.timeout, stream_limit: args.stream_limit, artifact_dir: args.artifact_dir, candidate_metadata: metadata,
      selected_region: experiment ? experiment.region : null, signal_specs: experiment ? experiment.signals : [], compilation_envelope: envelope,
      rank_by: args.rank_by, warn });
    if (manifestPath !== null) {
      await finalizeSourceRetention(manifestPath);
      finishManifest(manifestPath, { results: results.length, prepared: Object.keys(duplicates).length, exact: results.some((r) => r.comparison && r.comparison.exact) });
    }
  } catch (e) {
    if (!reportable(e)) throw e;
    if (manifestPath !== null) finishManifest(manifestPath, { results: 0, prepared: 0, exact: false, interrupted: true });
    io.eprint(`error: ${errText(e)}`);
    return 2;
  }
  const shown = args.limit ? results.slice(0, args.limit) : results;
  const basins = groupObjectBasins(results, { rank_by: args.rank_by });
  const rankedBy = campaignRankingLabel(results, { requested: args.rank_by });
  const unrun = Object.keys(duplicates).length - results.length;
  const basinSummary = (basin) => {
    const c = basin[0].comparison;
    return { candidate_sha256: c.candidate_sha256, candidate_sha1: c.candidate_sha1, variant_count: basin.length, sources: basin.map((i) => i.source),
      best_metrics: selectedFields(c, ["verdict", "exact", "words", "norm", "opcodes", "regs"]) };
  };
  if (args.json || args.json_summary) {
    const serialized = shown.map((item) => {
      if (!args.json_summary) return item.asDict();
      const c = item.comparison;
      return { source: item.source, returncode: item.returncode, object_path: item.object_path, cache_key: item.cache_key, cached: item.cached,
        duration_seconds: item.duration_seconds, experiment: item.experiment, region: item.region, signals: item.signals, object_sha256: item.object_sha256,
        comparison: c ? selectedFields(c, CAMPAIGN_SUMMARY_KEYS) : null };
    });
    io.print(dumps({ schema: "decomp-workbench-campaign-v1", unique_candidates: results.length, prepared_candidates: Object.keys(duplicates).length,
      stopped_on_exact: !!unrun && args.stop_on_exact, source_files: Object.values(duplicates).reduce((s, i) => s + i.length, 0), timeout_seconds: args.timeout,
      rank_by: args.rank_by, ranked_by: rankedBy, alignment_ranking_unsafe: campaignAlignmentRankingUnsafe(results),
      manifest: manifestPath !== null ? manifestPath : null, ledger: effectiveLedger ? String(effectiveLedger) : null,
      experiment: experiment ? experiment.asDict() : null, controls: controlReport, object_basins: basins.map(basinSummary), results: serialized }));
  } else {
    if (rankedBy === "geometry-pareto" && args.rank_by === "auto") io.print(MIXED_ALIGNMENT_CAUTION);
    if (controlReport.status !== "NOT DECLARED") io.print(`controls: ${controlReport.passed_required}/${controlReport.required} required PASS`);
    for (let i = 0; i < shown.length; i++) {
      const r = shown[i];
      if (r.comparison) {
        io.print(`${rank3(i + 1)} ${await comparisonLineOf(r.comparison)} [${r.cached ? "cache" : "built"} ${r.duration_seconds.toFixed(2)}s]`
          + (args.rank_by === "temp-prefix" ? ` [${allocationProgressLabel(r.comparison)}]` : ""));
      } else {
        const detail = splitlines(r.stderr.trim());
        io.eprint(`FAIL ${r.source}: ${detail.length ? detail.at(-1) : `exit ${r.returncode}`}`);
      }
    }
    io.print(`object basins: ${basins.length} across ${basins.reduce((s, b) => s + b.length, 0)} successful variants`);
    if (args.show_basins) {
      basins.forEach((basin, n) => {
        const c = basin[0].comparison;
        if (!c) return;
        io.print(`BASIN ${rank3(n + 1)} variants=${String(basin.length).padStart(3)} sha1=${c.candidate_sha1} ${c.verdict}\n  ${basin.map((i) => i.source).join(", ")}`);
      });
    }
    if (unrun && args.stop_on_exact) io.print(`stopped on the first exact match; ${unrun} prepared candidate(s) were not compiled (pass --no-stop-on-exact to sweep them)`);
    const dup = Object.values(duplicates).reduce((s, i) => s + i.length - 1, 0);
    if (dup) io.print(`deduplicated ${dup} identical source file(s)`);
    if (effectiveLedger) io.print(`ledger: ${resolvePath(effectiveLedger)}`);
    if (manifestPath) {
      io.print(`manifest: ${manifestPath}`);
      io.print(`next: decomp-workbench campaign status ${shellQuote(path.dirname(manifestPath))}`);
    }
  }
  return results.some((i) => i.comparison) ? 0 : 1;
}

/** shlex.quote */
export function shellQuote(s) {
  if (!s) return "''";
  if (/^[\w@%+=:,./-]+$/.test(s)) return s;
  return "'" + s.replace(/'/g, "'\"'\"'") + "'";
}

function compactParameterEvidence(family) {
  const tested = family.tested_parameters ?? [];
  const testedCount = Math.trunc(Number(family.tested_parameter_sets ?? tested.length));
  let testedText;
  if (testedCount <= 6) testedText = pyRepr(tested);
  else {
    const sample = tested.slice(0, 3);
    testedText = `${testedCount} assignment(s); sample=${pyRepr(sample)} (+${testedCount - sample.length} more; use --json for all retained evidence)`;
  }
  const declared = family.declared_parameter_space ?? {};
  let declaredText = pyS(declared);
  const choiceCount = isDict(declared) ? Object.values(declared).filter(Array.isArray).reduce((s, c) => s + c.length, 0) : 0;
  if ((declaredText.length > 240 || choiceCount > 12) && isDict(declared)) {
    declaredText = Object.entries(declared).map(([n, c]) => (Array.isArray(c) ? `${n}=${c.length} choice(s)` : `${n}=${pyS(c)}`)).join(", ");
  }
  return [testedText, declaredText];
}

function printStatus(report, io) {
  io.print(`campaign: ${report.status} ${EM} ${report.recorded_candidates}/${report.prepared_candidates} candidate(s), ${report.object_basins.length} object basin(s)`);
  const rankedBy = String(report.ranked_by ?? report.rank_by ?? "auto");
  const requested = String(report.rank_by ?? "auto");
  io.print(`ranking: ${rankedBy}${requested !== rankedBy ? ` (requested ${requested})` : ""}`);
  if (report.alignment_ranking_unsafe && requested === "auto") {
    io.print(rankedBy === "geometry-pareto" ? MIXED_ALIGNMENT_CAUTION : "caution: incomplete legacy geometry evidence -- ordered by positional words; remeasure to enable geometry ranking");
  }
  const retention = report.source_retention;
  if (isDict(retention)) io.print(`sources: policy=${pyS(retention.policy)} retained=${pyS(retention.retained)} pending=${pyS(retention.pending)} not-retained=${pyS(retention.not_retained)}`);
  const best = report.best;
  const wordsOf = (c) => pyS("words" in c ? c.words : c.word_mismatches);
  if (isDict(best) && isDict(best.comparison)) {
    const c = best.comparison;
    io.print(`best: ${pyS(best.source)} ${EM} ${pyS(c.verdict)} aligned=${pyS(c.aligned_total)} words=${wordsOf(c)}`);
  }
  const bestTemp = report.best_temp_prefix;
  if (isDict(bestTemp) && bestTemp.source !== (isDict(best) ? best.source : null) && isDict(bestTemp.comparison)) {
    const c = bestTemp.comparison;
    const temp = c.temp_prefix_exact;
    const pool = c.pool_exact ? "exact" : pyS(c.pool_prefix_exact);
    io.print(`best temp prefix: ${pyS(bestTemp.source)} ${EM} pool=${pool} temp=${temp === null || temp === undefined ? "exact" : temp} words=${wordsOf(c)}`);
  }
  io.print(`outcomes: ${report.successful_candidates} successful, ${report.failed_candidates} failed, ${report.remaining_candidates} remaining`);
  const controls = report.controls ?? {};
  if (isDict(controls) && controls.status !== "NOT DECLARED") io.print(`controls: ${pyS(controls.passed_required ?? 0)}/${pyS(controls.required ?? 0)} required PASS (${pyS(controls.status)})`);
  const coverage = report.coverage;
  if (isDict(coverage)) {
    const declared = coverage.declared_assignments;
    if (declared === null || declared === undefined) io.print(`coverage: unknown denominator; ${pyS(coverage.visited_assignments ?? 0)} visited [${pyS(coverage.conclusion)}]`);
    else io.print(`coverage: ${pyS(coverage.visited_assignments ?? 0)}/${declared} visited, ${pyS(coverage.excluded_assignments ?? 0)} excluded [${pyS(coverage.conclusion)}]`);
  }
  if (report.trajectory.length && rankedBy !== "temp-prefix") {
    const field = rankedBy === "words" ? "best_words" : "best_aligned_total";
    const label = rankedBy === "words" ? "best words" : "best aligned";
    const values = report.trajectory.filter((p) => p[field] !== null && p[field] !== undefined).map((p) => Math.trunc(Number(p[field])));
    if (values.length) {
      const levels = ".:-=+*#%@";
      const high = Math.max(...values), low = Math.min(...values), scale = Math.max(1, high - low);
      const spark = values.slice(-60).map((v) => levels[Math.min(levels.length - 1, pyRound((high - v) * (levels.length - 1) / scale))]).join("");
      io.print(`trajectory: ${values[0]} ${spark} ${values.at(-1)} (${label})`);
    }
  }
  if (report.mechanism_trajectory && report.mechanism_trajectory.length) {
    const t = report.mechanism_trajectory;
    io.print(`mechanism transitions: ${t.length}`);
    for (const x of t.slice(-8)) io.print(`  #${x.record} ${x.signal}: ${x.from || "UNMEASURED"} -> ${x.to} (${pyS(x.source)})`);
  }
  if (report.object_basins.length) {
    const variants = report.object_basins.reduce((s, b) => s + Math.trunc(Number(b.variant_count)), 0);
    io.print(`idea collapse: ${variants} successful source variant(s) ${ARROW} ${report.object_basins.length} distinct object basin(s)`);
  }
  for (const w of report.warnings) io.print(`warning: ${w}`);
  if (report.families && report.families.length) {
    io.print("families:");
    for (const family of report.families) {
      const state = family.tested_candidates > 1 && family.object_basins === 1 ? "COLLAPSED" : "MOVING";
      const b = family.best.comparison || {};
      io.print(`  ${family.family}: ${family.tested_candidates} tried, ${family.object_basins} basin(s), best=${pyS(b.aligned_total)} [${state}]`);
      const [tested, declared] = compactParameterEvidence(family);
      io.print(`    tested: ${tested}`);
      io.print(`    declared: ${declared}`);
    }
  }
  if (report.hypothesis) io.print(`hypothesis: ${report.hypothesis}`);
  for (const s of report.homologous_guidance ?? []) {
    io.print(`homologous next: ${s.sibling_parameter}=${pyRepr(s.winning_value)} ${EM} ${s.reason}`);
    io.print(`  parameters: ${pyRepr(s.suggested_parameters)}`);
  }
  io.print(`manifest: ${report.manifest}`);
}

async function guarded(io, fn) {
  try { return await fn(); } catch (e) { if (!reportable(e)) throw e; io.eprint(`error: ${errText(e)}`); return null; }
}

export async function campaignStatusCommand(args, io) {
  const report = await guarded(io, async () => buildStatus(findManifest(args.campaign, { state_root: args.state_dir })));
  if (report === null) return 2;
  if (args.json) io.print(dumps(report)); else printStatus(report, io);
  return 0;
}

export async function campaignResumeCommand(args, io) {
  let sources = [], alreadyExact = false;
  const E = await import("./experiments.js");
  const report = await guarded(io, async () => {
    const manifestPath = findManifest(args.campaign, { state_root: args.state_dir, require_explicit_when_ambiguous: true });
    const manifest = await validateResume(manifestPath);
    const previouslyExact = manifest.status === "exact";
    alreadyExact = previouslyExact && (manifest.execution.stop_on_exact ?? true) && !args.continue_after_exact;
    sources = alreadyExact ? [] : remainingSources(manifest);
    if (sources.length) {
      const inputs = manifest.identity_inputs, info = inputs.compile, execution = manifest.execution;
      const experiment = manifest.experiment;
      let metadata = null, region = null, signalSpecs = [];
      const timeout = args.timeout !== null && args.timeout !== undefined ? args.timeout : execution.timeout_seconds;
      if (isDict(experiment)) {
        const loaded = typeof experiment.path === "string" ? E.loadExperiment(String(experiment.path)) : null;
        if (loaded !== null) {
          signalSpecs = loaded.signals;
          if (loaded.controls.length && !(manifest.control_preflight ?? {}).passed) {
            const { runControlPreflight } = await import("./experiment-controls.js");
            const control = await runControlPreflight(loaded, { target: inputs.target.path, template: info.template, cache_dir: manifest.cache_directory,
              objdump: inputs.objdump.requested, symbol: inputs.symbol ?? null, section: inputs.section, environment: info.environment,
              compile_cwd: info.working_directory, timeout, stream_limit: 65536, artifact_dir: manifest.artifact_directory ?? null, compilation_envelope: info.envelope ?? {} });
            recordControlPreflight(manifestPath, control);
            if (!control.passed) {
              finishManifest(manifestPath, { results: 0, prepared: manifest.sources.length, exact: false, control_invalid: true });
              throw Object.assign(new Error("required experiment control failed; ordinary candidates were not scheduled"), { name: "ValueError" });
            }
          }
          metadata = Object.fromEntries(manifest.sources.map((s) => [String(s.cache_key), loaded.metadataFor(String(s.path))]));
        } else {
          const bySource = new Map((experiment.candidates ?? []).filter((i) => isDict(i) && "source" in i).map((i) => [String(i.source), i.parameters ?? {}]));
          metadata = Object.fromEntries(manifest.sources.map((s) => [String(s.cache_key), { schema: experiment.schema ?? E.EXPERIMENT_SCHEMA, family: experiment.family,
            parameters: bySource.get(String(s.path)) ?? {}, parameter_space: experiment.parameters ?? {}, baseline: experiment.baseline ?? null, manifest: experiment.path ?? null }]));
        }
        const r = experiment.selected_region;
        if (isDict(r)) region = new E.RegionConstraint(Math.trunc(Number(r.start)), Math.trunc(Number(r.end)), String(r.name ?? "selected"));
      }
      const [results] = await runCampaign(sources, { target: inputs.target.path, template: info.template, cache_dir: manifest.cache_directory, ledger: manifest.ledger,
        jobs: args.jobs || execution.jobs, objdump: inputs.objdump.requested, symbol: inputs.symbol ?? null, section: inputs.section, environment: info.environment,
        compile_cwd: info.working_directory, stop_on_exact: execution.stop_on_exact, timeout, artifact_dir: manifest.artifact_directory ?? null,
        candidate_metadata: metadata, selected_region: region, signal_specs: signalSpecs, compilation_envelope: info.envelope ?? {},
        rank_by: String(execution.rank_by ?? "auto"), warn: (m) => io.eprint(m) });
      await finalizeSourceRetention(manifestPath);
      finishManifest(manifestPath, { results: results.length, prepared: manifest.sources.length, exact: previouslyExact || results.some((i) => i.comparison && i.comparison.exact) });
    }
    return buildStatus(manifestPath);
  });
  if (report === null) return 2;
  if (args.json) io.print(dumps(report));
  else {
    if (!sources.length) {
      io.print(alreadyExact ? "resume: exact result already recorded; pass --continue-after-exact to run the intentionally skipped grid"
        : "resume: nothing to run; every manifest candidate has a ledger record");
    }
    printStatus(report, io);
  }
  return 0;
}

async function renderHtml(report) {
  const { documentShell } = await import("./html-report.js");
  const campaign = report.campaign;
  const rows = campaign.trajectory.map((p) => `<tr><td>${Math.trunc(Number(p.record))}</td><td>${escapeHtml(pyS(p.source))}</td><td>${escapeHtml(pyS(p.verdict))}</td><td>${escapeHtml(pyS(p.aligned_total))}</td><td>${escapeHtml(pyS(p.words))}</td></tr>`);
  const table = rows.join("\n") || '<tr><td colspan="5">No results yet.</td></tr>';
  const coverage = campaign.coverage ?? {}, controls = campaign.controls ?? {};
  const mechanism = (campaign.mechanism_trajectory ?? []).map((i) => `<li>#${Math.trunc(Number(i.record))} ${escapeHtml(pyS(i.signal))}: ${escapeHtml(pyS(i.from || "UNMEASURED"))} ${ARROW} ${escapeHtml(pyS(i.to))} (${escapeHtml(pyS(i.source ?? null))})</li>`).join("\n") || "<li>No declared signal transitions.</li>";
  const note = campaign.alignment_ranking_unsafe ? " (alignment gaps made aligned totals incomparable)" : "";
  const body = `
<h1>Campaign ${escapeHtml(pyS(campaign.status))}</h1>
<p>${Math.trunc(Number(campaign.recorded_candidates))} recorded candidate(s),
${campaign.object_basins.length} object basin(s),
${Math.trunc(Number(campaign.remaining_candidates))} remaining.</p>
<p><strong>Ranking:</strong>
${escapeHtml(pyS(campaign.ranked_by ?? campaign.rank_by ?? "auto"))}
${escapeHtml(note)}.</p>
<p><strong>Controls:</strong>
${escapeHtml(pyS(controls.status ?? "NOT DECLARED"))}.
<strong>Coverage:</strong> ${escapeHtml(pyS(coverage.visited_assignments ?? 0))} /
${escapeHtml(pyS(coverage.declared_assignments || "unknown"))} visited;
conclusion=${escapeHtml(pyS(coverage.conclusion ?? "coverage-unknown"))}.</p>
<p class="proof">${escapeHtml(pyS(report.proof))}</p>
<h2>Trajectory</h2>
<div class="table-scroll"><table><caption>Candidate trajectory</caption>
<thead><tr><th>#</th><th>Source</th><th>Verdict</th><th>Aligned</th><th>Words</th></tr></thead>
<tbody>${table}</tbody>
</table></div>
<h2>Mechanism trajectory</h2>
<ul>${mechanism}</ul>
`;
  return documentShell("decomp-workbench campaign report", body, report);
}

const exists = (p) => fs.existsSync(p);
const fileExistsError = (m) => Object.assign(new OSError(m), { kind: "FileExistsError" });

export async function campaignExportCommand(args, io) {
  let output;
  const ok = await guarded(io, async () => {
    const report = await exportStatus(findManifest(args.campaign, { state_root: args.state_dir }));
    output = resolvePath(args.output);
    if (exists(output)) throw fileExistsError(`refusing to overwrite campaign export: ${output}`);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    const content = args.format === "html" ? await renderHtml(report) : dumps(report) + "\n";
    fs.writeFileSync(output, content, { encoding: "utf8", flag: "wx" });
    return true;
  });
  if (ok === null) return 2;
  const payload = { schema: "decomp-workbench-campaign-export-result-v1", format: args.format, output };
  if (args.json) io.print(dumps(payload)); else io.print(`campaign ${args.format} export: ${output}`);
  return 0;
}

export async function campaignNoteCommand(args, io) {
  let manifest;
  const updated = await guarded(io, async () => { manifest = findManifest(args.campaign, { state_root: args.state_dir, require_explicit_when_ambiguous: true }); return updateHypothesis(manifest, args.note); });
  if (updated === null) return 2;
  const payload = { schema: "decomp-workbench-campaign-note-v1", manifest, hypothesis: updated.hypothesis };
  if (args.json) io.print(dumps(payload));
  else { io.print(`campaign hypothesis: ${payload.hypothesis}`); io.print(`manifest: ${manifest}`); }
  return 0;
}

export async function campaignCheckpointCommand(args, io) {
  const report = await guarded(io, async () => {
    const manifest = findManifest(args.campaign, { state_root: args.state_dir, require_explicit_when_ambiguous: true });
    if (args.current_object && !args.current_source) throw Object.assign(new Error("--current-object requires --current-source"), { name: "ValueError" });
    return checkpointCampaign(manifest, { current_source: args.current_source, current_object: args.current_object });
  });
  if (report === null) return 2;
  if (args.json) io.print(dumps(report));
  else {
    io.print(`best checkpoint: ${report.best.id}`);
    if (report.current !== null) { io.print(`current checkpoint: ${report.current.id}`); io.print(`same: ${report.same ? "yes" : "no"}`); }
  }
  return 0;
}

export async function campaignRestoreBestCommand(args, io) {
  const report = await guarded(io, async () => restoreBest(findManifest(args.campaign, { state_root: args.state_dir, require_explicit_when_ambiguous: true }),
    { destination: args.destination, allow_drift: args.allow_drift }));
  if (report === null) return 2;
  if (args.json) io.print(dumps(report));
  else {
    io.print(`restored best ${report.best_id} -> ${report.destination}`);
    if (report.backup !== null) io.print(`backup: ${report.backup.path}`);
  }
  return 0;
}

export async function campaignAcceptCommand(args, io) {
  const report = await guarded(io, async () => acceptBest(findManifest(args.campaign, { state_root: args.state_dir, require_explicit_when_ambiguous: true }), { allow_mismatch: args.allow_mismatch }));
  if (report === null) return 2;
  if (args.json) io.print(dumps(report));
  else io.print(`accepted artifact: ${report.accepted.artifact_id} exact=${report.accepted.exact ? "yes" : "no"}`);
  return 0;
}

export async function campaignDossierAddCommand(args, io) {
  const entry = await guarded(io, async () => {
    const manifest = findManifest(args.campaign, { state_root: args.state_dir, require_explicit_when_ambiguous: true });
    return appendEntry(path.join(path.dirname(manifest), "dossier.jsonl"), { function: args.function, hypothesis: args.hypothesis, lever: args.lever,
      result: args.result, outcome: args.outcome, do_not_repeat: args.do_not_repeat, evidence: args.evidence || [] });
  });
  if (entry === null) return 2;
  if (args.json) io.print(dumps({ schema: "decomp-workbench-dossier-add-v1", entry }));
  else io.print(`dossier entry: ${entry.id} (${entry.result})`);
  return 0;
}

export async function campaignDossierListCommand(args, io) {
  const report = await guarded(io, async () => {
    const manifest = findManifest(args.campaign, { state_root: args.state_dir, require_explicit_when_ambiguous: true });
    return dossierReport(path.join(path.dirname(manifest), "dossier.jsonl"), { function: args.function, result: args.result });
  });
  if (report === null) return 2;
  if (args.json) io.print(dumps(report));
  else {
    io.print(`dossier: ${report.entry_count} ${report.entry_count === 1 ? "entry" : "entries"}, do-not-repeat=${report.do_not_repeat}`);
    for (const e of report.entries) io.print(`${e.id} ${e.function} ${e.result}: ${e.hypothesis}`);
  }
  return report.entry_count ? 0 : 1;
}

export async function campaignSurveyCommand(args, io) {
  const report = await guarded(io, async () => surveyCampaign(args.directory, { budget: args.budget, base: args.base }));
  if (report === null) return 2;
  if (args.json) { io.print(dumps(report)); return 0; }
  const { emitLines } = await import("./terminal.js");
  emitLines(io, surveyLines(report, { limit: args.limit || report.stages.length || 1 }), { width: args.width, pager: args.pager });
  return 0;
}

/** Promote a measured campaign winner into a paste-ready scratch bundle. */
export async function campaignPackageCommand(args, io) {
  let result, source, accepted;
  const ok = await guarded(io, async () => {
    const manifestPath = findManifest(args.campaign, { state_root: args.state_dir, require_explicit_when_ambiguous: true });
    const manifest = await validateResume(manifestPath, { allow_retained_sources: true });
    const report = await buildStatus(manifestPath);
    const selected = report[args.selection === "temp-prefix" ? "best_temp_prefix" : "best"];
    const V = (m) => Object.assign(new Error(m), { name: "ValueError" });
    if (!isDict(selected)) throw V("campaign has no successful candidate to package");
    const comparison = selected.comparison;
    if (!isDict(comparison)) throw V("selected campaign candidate has no comparison evidence");
    const raw = "raw" in comparison ? comparison.raw : comparison.raw_word_mismatches;
    const relocation = comparison.relocation_target_mismatches;
    accepted = !!comparison.exact && Number.isInteger(raw) && raw === 0 && Number.isInteger(relocation) && relocation === 0;
    if (!accepted && !args.allow_mismatch) throw V("selected candidate is not scratch-accepted; pass --allow-mismatch only when intentionally packaging a near-match");
    const cacheKey = selected.cache_key;
    const sourceRecord = (manifest.sources ?? []).find((i) => isDict(i) && i.cache_key === cacheKey);
    if (!isDict(sourceRecord)) throw V("selected source is absent from the campaign manifest");
    source = durableSourcePath(sourceRecord);
    if (!exists(source)) throw new FileNotFoundError(`selected campaign source no longer exists: ${source}`);
    if (selected.source_sha256 !== null && selected.source_sha256 !== undefined && selected.source_sha256 !== sourceRecord.sha256) {
      throw V("selected ledger record and campaign manifest disagree on the source hash; refusing mutable promotion");
    }
    const cacheObject = path.join(String(manifest.cache_directory), `${cacheKey}.o`);
    if (!exists(cacheObject)) throw new FileNotFoundError(`selected immutable campaign object is absent from cache: ${cacheObject}`);
    const actualObject = fileSha256(cacheObject);
    if (selected.object_sha256 !== null && selected.object_sha256 !== undefined && actualObject !== selected.object_sha256) throw V("selected cached object hash changed; refusing source/object promotion");
    let receipt = null, receiptHash = null;
    if (args.finish_receipt) {
      const finishPath = resolvePath(args.finish_receipt);
      receiptHash = fileSha256(finishPath);
      receipt = loadsJson(fs.readFileSync(finishPath, "utf8"));
      const winner = receipt.winner ?? {};
      if (receipt.schema !== "decomp-workbench-campaign-finish-v1" || receipt.status !== "PASS" || receipt.campaign_identity !== manifest.identity
        || !isDict(winner) || winner.cache_key !== cacheKey || winner.source_sha256 !== sourceRecord.sha256 || winner.recorded_object_sha256 !== actualObject) {
        throw V("finish receipt is not a passing receipt for this immutable winner");
      }
    }
    const { bundleScratch } = await import("./scratch-bundle.js");
    result = await bundleScratch(args.output, { target_assembly: args.target_assembly, context: args.context, source, platform: args.platform, compiler: args.compiler,
      compiler_flags: args.compiler_flags, diff_label: args.diff_label, project: args.project, preset: args.preset, compiler_id: args.compiler_id, language: args.language,
      provenance: { schema: "decomp-workbench-campaign-promotion-v1", campaign_identity: manifest.identity, campaign_manifest: manifestPath, selection: args.selection,
        source_cache_key: cacheKey, source_sha256: sourceRecord.sha256, object_sha256: actualObject, recorded_at_unix: selected.recorded_at_unix ?? null,
        ledger_record_cache_key: cacheKey, target_sha256: manifest.identity_inputs.target.sha256, scratch_accepted: accepted, comparison,
        finish_receipt: receipt !== null ? resolvePath(args.finish_receipt) : null, finish_receipt_sha256: receiptHash } });
    return true;
  });
  if (ok === null) return 2;
  const payload = { schema: "decomp-workbench-campaign-package-result-v1", output: result.output, source: String(source), selection: args.selection,
    scratch_accepted: accepted, manifest: result.manifest };
  if (args.json) io.print(dumps(payload));
  else {
    io.print(`campaign scratch bundle: ${result.output}`);
    io.print(`source: ${source}`);
    io.print(`acceptance: ${accepted ? "ACCEPTED" : "MISMATCH ALLOWED"}`);
    io.print("next: verify SHA256SUMS, then follow the generated README.md paste order");
  }
  return 0;
}

/** Freshly rebuild a winner and record every integration gate separately. */
export async function campaignFinishCommand(args, io) {
  const r = await guarded(io, async () => finishCampaign(findManifest(args.campaign, { state_root: args.state_dir, require_explicit_when_ambiguous: true }), {
    selection: args.selection, output: args.output, format: args.format, scratch_context: args.scratch_context, scratch_compile_command: args.scratch_compile_command,
    collateral_reference: args.collateral_reference, handoff: args.handoff, project_command: args.project_command, project_timeout: args.project_timeout,
    stream_limit: args.stream_limit, warn: (m) => io.eprint(m) }));
  if (r === null) return 2;
  const [report, output] = r;
  if (args.json) io.print(dumps({ schema: "decomp-workbench-campaign-finish-result-v1", output, status: report.status, ready: report.ready }));
  else {
    io.print(`campaign finish: ${report.status}`);
    for (const [name, gate] of Object.entries(report.gates)) io.print(`  ${name.replace(/_/g, " ")}: ${gate.status} ${EM} ${gate.reason}`);
    io.print(`receipt: ${output}`);
  }
  return report.ready ? 0 : 1;
}

const SURVEY_DESCRIPTION = "Read a campaign working directory -- the one holding the stage directories -- and report what is in it: every stage by recency with its "
  + "file, source and object counts; the findings logs with their pending sidecar notes; the sweep manifests and their coverage; the instrument-gate "
  + "stamps, or their absence. It is a reading taken now, not a registry: nothing is stored, so nothing here can be a stale claim, and nothing here "
  + "guesses which artifact is the base. For a manifest `campaign run` wrote, the command is `campaign status`.";

const CAMPAIGN_ARG = { dest: "campaign", nargs: "?", help: "manifest, directory, or ID" };
const STATE_DIR = { flags: ["--state-dir"], default: ".decomp-workbench" };
const JSON_FLAG = { flags: ["--json"], action: "store_true", help: "emit JSON" };
const defaultJobs = Math.max(1, Math.min(8, (os.availableParallelism?.() ?? os.cpus().length) || 1));

function runArguments({ campaign }) {
  const rank = { flags: ["--rank-by"], choices: ["auto", "words", "temp-prefix"], default: "auto",
    help: "candidate ordering: automatic aligned/geometry Pareto ranking, positional words, or latest exact temp-lane prefix" };
  const common = [
    { dest: "target", help: "reference object" },
    { dest: "sources", nargs: "+", help: "candidate C files" },
    { flags: ["--compile-command"], required: true, help: "command template containing {source} and {output}" },
    { flags: ["--toolchain"], help: "verified real-copy toolchain; supplies its path-sensitive environment" },
  ];
  if (!campaign) {
    return [...common,
      { flags: ["--keep-objects"], help: "directory in which to retain compiled objects" },
      { flags: ["--cache-dir"], default: ".decomp-workbench/cache", help: "content-cache directory" },
      { flags: ["--env"], action: "append", default: [], metavar: "NAME=VALUE", help: "compiler environment entry; repeatable" },
      { flags: ["--inherit-env"], action: "append", default: [], metavar: "NAME", help: "copy this host variable into the otherwise sealed compiler environment and cache identity; repeatable" },
      { flags: ["--compile-cwd"], help: "working directory for compiler processes" },
      { flags: ["--timeout"], type: "float", default: 120.0, help: "per-candidate compiler timeout in seconds (default: 120)" },
      { flags: ["--limit"], type: "int", default: 20, help: "maximum results to show" },
      rank, ...O.processOutputArguments(), ...commonCompare()];
  }
  return [...common,
    { flags: ["--compiler-id"], help: "canonical compiler build identity for this campaign cell" },
    { flags: ["--frontend"], help: "frontend family, such as IRIX 4.x accom or later cfe" },
    { flags: ["--language"], help: "source language/dialect for this cell" },
    { flags: ["--driver"], help: "historical or wrapper driver identity" },
    { flags: ["--backend"], help: "backend identity when a historical frontend feeds a later backend" },
    { flags: ["--cache-dir"], default: ".decomp-workbench/cache", help: "content-cache directory" },
    { flags: ["--ledger"], help: "append results to this JSONL file" },
    { flags: ["--no-ledger"], action: "store_true", help: "disable the default manifest and append-only ledger" },
    { flags: ["--state-dir"], default: ".decomp-workbench", help: "state namespace for default manifests and ledgers" },
    { flags: ["--experiment-manifest"], help: "experiment-v1/v2 sidecar describing family and candidates; v2 may also declare signals, controls, and coverage" },
    { flags: ["--jobs"], type: "int", default: defaultJobs, help: "parallel compiler processes" },
    { flags: ["--env"], action: "append", default: [], metavar: "NAME=VALUE", help: "compiler environment included in the cache key; repeatable" },
    { flags: ["--inherit-env"], action: "append", default: [], metavar: "NAME", help: "copy this host variable into the otherwise sealed compiler environment and campaign identity; repeatable" },
    { flags: ["--compile-cwd"], help: "working directory for compiler processes; included in the cache key" },
    { flags: ["--timeout"], type: "float", default: 120.0, help: "per-candidate compiler timeout in seconds (default: 120)" },
    { flags: ["--keep-objects"], help: "directory in which to retain compiled objects" },
    { flags: ["--retain-sources"], choices: ["leaders", "exact", "all", "none"], default: "leaders", help: "durable source policy (default: leaders); unrun candidates stay staged so resume remains possible" },
    { flags: ["--limit"], type: "int", default: 20, help: "maximum results to show" },
    rank, ...O.processOutputArguments(), ...commonCompare(),
    { flags: ["--json-summary"], action: "store_true", help: "emit compact JSON without compiler streams or instruction-level diffs" },
    { flags: ["--stop-on-exact"], dest: "stop_on_exact", action: "boolean_optional", default: true, help: "stop submitting candidates once one compares exact (default: enabled; pass --no-stop-on-exact to sweep every candidate)" },
    { flags: ["--show-basins"], action: "store_true", help: "show source variants that compiled to each identical object basin" },
  ];
}

function commonCompare() {
  return [...O.symbolArgument(), ...O.explainKeysArgument(), ...O.colorArgument(),
    { flags: ["--section"], default: ".text", help: "object section (default: .text)" },
    { flags: ["--objdump"], help: "GNU-compatible MIPS objdump; auto-detected when omitted" },
    { flags: ["--json"], action: "store_true", help: "emit JSON" }];
}

export const COMMAND_SPECS = [
  { path: ["compile-rank"], handler: compileRankCommand, help: "compile and rank C source candidates",
    description: "Compatibility convenience backed by the same cached, in-process engine as campaign. Use campaign for persistent state and resume.",
    arguments: runArguments({ campaign: false }) },
  { path: ["campaign"], handler: campaignCommand, help: "run a parallel, cached candidate campaign",
    description: "Compile, cache, rank, and record source candidates.", arguments: runArguments({ campaign: true }) },
  { path: ["campaign-survey"], handler: campaignSurveyCommand, defaults: { report_command: "campaign-survey" }, description: SURVEY_DESCRIPTION,
    epilog: "example: decomp-workbench campaign survey .workbench/my-campaign",
    arguments: [{ dest: "directory", help: "the campaign working directory" },
      { flags: ["--base"], metavar: "FILE", help: "hash this file now and print it as the pinned base" },
      { flags: ["--budget"], type: "int", default: 40000, metavar: "N", help: "files to walk before stopping and saying so (default: 40000)" },
      { flags: ["--limit"], type: "int", default: 20, metavar: "N", help: "stage rows to print before eliding (default: 20; 0 prints all)" },
      JSON_FLAG, ...O.terminalArguments()] },
  { path: ["campaign-status"], handler: campaignStatusCommand, description: "Show best candidate, trajectory, failures, and object basins.",
    arguments: [CAMPAIGN_ARG, STATE_DIR, JSON_FLAG] },
  { path: ["campaign-resume"], handler: campaignResumeCommand, description: "Resume only candidates not represented in the campaign ledger.",
    arguments: [CAMPAIGN_ARG, STATE_DIR, { flags: ["--jobs"], type: "int" }, { flags: ["--timeout"], type: "float" },
      { flags: ["--continue-after-exact"], action: "store_true", help: "run candidates intentionally skipped after the first exact result" }, JSON_FLAG] },
  { path: ["campaign-export"], handler: campaignExportCommand, description: "Write bounded, shareable campaign evidence as JSON or HTML.",
    arguments: [CAMPAIGN_ARG, STATE_DIR, { flags: ["--output"], required: true }, { flags: ["--format"], choices: ["json", "html"], default: "html" },
      { flags: ["--json"], action: "store_true", help: "emit result JSON" }] },
  { path: ["campaign-package"], handler: campaignPackageCommand, description: "Promote a validated campaign winner into a deterministic, paste-ready decomp.me scratch bundle.",
    arguments: [CAMPAIGN_ARG, STATE_DIR, { flags: ["--output"], required: true }, { flags: ["--selection"], choices: ["score", "temp-prefix"], default: "score" },
      { flags: ["--allow-mismatch"], action: "store_true" },
      { flags: ["--finish-receipt"], help: "require a passing JSON campaign-finish receipt for the selected winner" },
      { flags: ["--target-assembly"], required: true }, { flags: ["--context"], required: true }, { flags: ["--platform"], required: true },
      { flags: ["--compiler"], required: true }, { flags: ["--compiler-id"] }, { flags: ["--language"] }, { flags: ["--compiler-flags"], default: "" },
      { flags: ["--diff-label"], required: true }, { flags: ["--project"] }, { flags: ["--preset"] }, JSON_FLAG] },
  { path: ["campaign-finish"], handler: campaignFinishCommand,
    description: "Freshly rebuild one immutable winner and record function, signal, scratch, collateral, handoff, and project gates independently.",
    arguments: [CAMPAIGN_ARG, STATE_DIR, { flags: ["--selection"], choices: ["score", "temp-prefix"], default: "score" }, { flags: ["--output"] },
      { flags: ["--format"], choices: ["json", "html"], default: "json" }, { flags: ["--scratch-context"] }, { flags: ["--scratch-compile-command"] },
      { flags: ["--collateral-reference"] }, { flags: ["--handoff"] }, { flags: ["--project-command"] },
      { flags: ["--project-timeout"], type: "float", default: 120.0 }, { flags: ["--stream-limit"], type: "int", default: 65536 },
      { flags: ["--json"], action: "store_true", help: "emit result JSON" }] },
  { path: ["campaign-note"], handler: campaignNoteCommand, description: "Persist the active campaign hypothesis for status and handoff.",
    arguments: [{ dest: "note" }, CAMPAIGN_ARG, STATE_DIR, JSON_FLAG] },
  { path: ["campaign-checkpoint"], handler: campaignCheckpointCommand, defaults: { report_command: "campaign-checkpoint" },
    description: "Archive the deterministically ranked best source/object pair and, when supplied, a separate current source/object pair. Content-addressed artifacts are immutable and verified after copying.",
    arguments: [CAMPAIGN_ARG, STATE_DIR, { flags: ["--current-source"] }, { flags: ["--current-object"] }, JSON_FLAG] },
  { path: ["campaign-restore-best"], handler: campaignRestoreBestCommand, defaults: { report_command: "campaign-restore-best" },
    description: "Materialize the immutable best source at an explicit destination. Existing contents are hash-checked against the current checkpoint and copied to a recoverable backup before replacement.",
    arguments: [CAMPAIGN_ARG, STATE_DIR, { flags: ["--destination"], required: true },
      { flags: ["--allow-drift"], action: "store_true", help: "permit a destination changed since its current checkpoint" }, JSON_FLAG] },
  { path: ["campaign-accept"], handler: campaignAcceptCommand, defaults: { report_command: "campaign-accept" },
    description: "Point the manifest at one immutable best checkpoint.",
    arguments: [CAMPAIGN_ARG, STATE_DIR, { flags: ["--allow-mismatch"], action: "store_true" }, JSON_FLAG] },
  { path: ["campaign-dossier-add"], handler: campaignDossierAddCommand, defaults: { report_command: "campaign-dossier-add" },
    description: "Append one tested hypothesis and its do-not-repeat result.",
    arguments: [CAMPAIGN_ARG, STATE_DIR, { flags: ["--function"], required: true }, { flags: ["--hypothesis"], required: true }, { flags: ["--lever"], required: true },
      { flags: ["--result"], choices: sorted([...DOSSIER_RESULTS]), required: true }, { flags: ["--outcome"], required: true },
      { flags: ["--do-not-repeat"], action: "store_true" }, { flags: ["--evidence"], action: "append" }, JSON_FLAG] },
  { path: ["campaign-dossier-list"], handler: campaignDossierListCommand, defaults: { report_command: "campaign-dossier-list" },
    description: "Query tested hypotheses by function or result.",
    arguments: [CAMPAIGN_ARG, STATE_DIR, { flags: ["--function"] }, { flags: ["--result"], choices: sorted([...DOSSIER_RESULTS]) }, JSON_FLAG] },
];
