// handoff.js - a handoff that is generated and audited, not narrated.
//
// The current handoff grew by PREPENDING hundreds of narrative entries. Every
// fact in it was true when written, which is exactly the problem: current facts
// are expensive to extract, easy to contradict with an older entry two hundred
// lines down, and impossible to verify mechanically. A reader cannot tell which
// paths still exist, which candidates still compile, or which conclusions the
// current source tree still supports.
//
// So this GENERATES the summary from the workspace and the checkout, and AUDITS
// every path it references. A dependency that no longer exists is reported as
// broken rather than carried forward as if it were still there - a handoff
// whose references have rotted is worse than a short one, because it sends the
// next agent to files that are gone.
//
// Plain JS ESM + JSDoc.

import fs from "node:fs";
import path from "node:path";

export const HANDOFF_SCHEMA = "romdev-decomp-handoff-v1";

/**
 * Generate a current-state handoff with a machine-readable manifest.
 *
 * @param {import("./project.js").Project} project
 */
export async function generateHandoff(project, { limit = 20 } = {}) {
  const { projectFreshness } = await import("./project.js");
  const { computeProgress } = await import("./progress.js");
  const { planWork } = await import("./plan.js");
  const { listExperiments, exhaustedFamilies } = await import("./experiment.js");
  const { listJobs } = await import("./jobs.js");
  const { buildLedger } = await import("./ledger.js");

  const freshness = await projectFreshness(project);
  let progress = null, plan = null, ledger = null;
  try { progress = await computeProgress(project); } catch {}
  try { plan = await planWork(project, { limit }); } catch {}
  try { ledger = await buildLedger(project, { progress, workClasses: plan?.workClasses }); } catch {}

  const experiments = await listExperiments(project).catch(() => []);
  const jobs = await listJobs(project).catch(() => []);

  // ── DEPENDENCY AUDIT: every referenced path must still exist ──
  const audited = [];
  const check = (label, p) => {
    if (!p) return;
    const abs = path.isAbsolute(p) ? p : project.abs(p);
    audited.push({ label, path: p, exists: fs.existsSync(abs) });
  };
  check("rom", project.m.rom?.path);
  check("splatYaml", project.m.splat?.yaml);
  check("linkerMap", project.m.built?.map);
  check("builtRom", project.m.built?.rom);
  check("compiler", project.m.toolchain?.compiler?.path);
  check("objdump", project.m.toolchain?.objdump?.path);
  for (const e of experiments.slice(0, 40)) {
    for (const c of e.candidates ?? []) if (c.candidatePath) check(`experiment:${e.id}`, c.candidatePath);
  }
  const broken = audited.filter((a) => !a.exists);

  // ── what is actually open right now ──
  const openExperiments = experiments.filter((e) => e.status !== "closed");
  const runningJobs = jobs.filter((j) => j.status === "running");
  const symbols = [...new Set(experiments.map((e) => e.symbol))];
  const families = [];
  for (const s of symbols.slice(0, 20)) {
    try { const f = await exhaustedFamilies(project, s); if (f.deadFamilies.length) families.push({ symbol: s, dead: f.deadFamilies }); } catch {}
  }

  const nextExperiments = (plan?.queue ?? []).slice(0, 5).map((q) => ({
    symbol: q.symbol, sizeBytes: q.sizeBytes, workClass: q.workClass,
    lastDistance: q.lastDistance, attempts: q.attempts,
    falsifiableNext: q.attempts === 0
      ? `untried: run decomp({op:'dispatch', symbols:['${q.symbol}']}) and bucket the blocker before assigning any search budget`
      : `${q.attempts} attempt(s) on the CURRENT tree, best distance ${q.lastDistance}. State a hypothesis and one lever, then decomp({op:'experiment', action:'create'}).`,
  }));

  const manifest = {
    schema: HANDOFF_SCHEMA, project: project.id, generatedAt: new Date().toISOString(),
    commit: freshness.liveGit, registeredCommit: freshness.registeredGit,
    manifestState: freshness.manifestState, buildFreshness: freshness.buildFreshness,
    staleReasons: freshness.staleReasons,
    build: { romMatchesBase: progress?.builtRomMatchesBase ?? null, builtAt: freshness.builtAt },
    completion: ledger ? {
      gameCodeInC: ledger.dimensions["game-cpu-code"]?.percentInC ?? null,
      libraryCodeInC: ledger.dimensions["library-code"]?.percentInC ?? null,
      opaqueRomBytes: ledger.dimensions["compressed-archives"]?.bytes ?? null,
      romBytes: ledger.rom?.bytes ?? null,
      caveat: "these are SEPARATE dimensions; there is deliberately no single completion percentage",
    } : null,
    queues: plan?.workClasses ? { byClass: plan.workClasses.counts, selected: plan.workClasses.selected } : null,
    openExperiments: openExperiments.map((e) => ({ id: e.id, symbol: e.symbol, hypothesis: e.hypothesis, lever: e.lever,
      controlsRun: Object.entries(e.controls ?? {}).filter(([, v]) => v).map(([k]) => k) })),
    runningJobs: runningJobs.map((j) => ({ jobId: j.jobId, symbol: j.symbol, elapsedS: j.elapsedS })),
    deadFamilies: families,
    nextExperiments,
    dependencyAudit: { checked: audited.length, broken: broken.length, brokenPaths: broken.slice(0, 20) },
    artifactLocations: { workspace: project.ws, candidates: path.join(project.ws, "candidates"), experiments: path.join(project.ws, "experiments") },
  };

  // ── the human-readable half, generated from the same facts ──
  const md = [
    `# ${project.id} - generated handoff`,
    ``,
    `Generated ${manifest.generatedAt}. Every fact below was read from the workspace and the checkout at that moment.`,
    ``,
    `## State`,
    `- commit: **${freshness.liveGit?.head ?? "?"}** (${freshness.liveGit?.dirtyFiles ?? "?"} modified/untracked)`,
    `- manifest: **${freshness.manifestState}**${freshness.staleReasons.length ? ` - ${freshness.staleReasons.join("; ")}` : ""}`,
    `- build freshness: **${freshness.buildFreshness}**; built ROM matches base: **${progress?.builtRomMatchesBase ?? "unknown"}**`,
    ``,
    `> A matching ROM proves the MIXED C/asm build is byte-exact. It does NOT mean the game is decompiled.`,
    ``,
    `## Completion (separate dimensions, deliberately not one number)`,
    ledger ? `- game CPU code in C: **${ledger.dimensions["game-cpu-code"]?.percentInC ?? "?"}%**` : "- (ledger unavailable)",
    ledger ? `- library code in C: **${ledger.dimensions["library-code"]?.percentInC ?? "?"}%**` : "",
    ledger ? `- opaque ROM bytes: **${ledger.dimensions["compressed-archives"]?.bytes ?? "?"}** of ${ledger.rom?.bytes ?? "?"} - assets and audio, NOT "undecompiled code"` : "",
    ``,
    `## Queues`,
    ...(plan?.workClasses ? Object.entries(plan.workClasses.counts).filter(([, v]) => v.functions)
      .map(([k, v]) => `- ${k}: **${v.functions}** functions, ${v.bytes} bytes`) : ["- (plan unavailable)"]),
    ``,
    `## Next falsifiable experiments`,
    ...(nextExperiments.length ? nextExperiments.map((n) => `- \`${n.symbol}\` (${n.sizeBytes}B): ${n.falsifiableNext}`) : ["- (queue empty)"]),
    ``,
    ...(families.length ? [`## Dead source families - do NOT re-run these`,
      ...families.map((f) => `- \`${f.symbol}\`: ${f.dead.join(", ")}`), ``] : []),
    `## Dependency audit`,
    broken.length
      ? `**${broken.length} of ${audited.length} referenced paths are MISSING** - this handoff's references have rotted:\n${broken.slice(0, 10).map((b) => `  - ${b.label}: \`${b.path}\``).join("\n")}`
      : `All ${audited.length} referenced paths exist.`,
    ``,
    `## Resume`,
    `\`\`\``,
    `decomp({op:'refresh', project:'${project.id}'})   # re-capture git/toolchain/maps; evidence untouched`,
    `decomp({op:'plan', project:'${project.id}'})      # game-matching-c queue, ranked on CURRENT-tree evidence`,
    `decomp({op:'dispatch', project:'${project.id}'})  # parallel triage of untouched functions`,
    `\`\`\``,
  ].filter((l) => l !== "").join("\n");

  return {
    ...manifest,
    markdown: md,
    auditPassed: broken.length === 0,
    note: broken.length
      ? "The dependency audit FAILED: this handoff references paths that no longer exist. Fix or re-generate before handing it on - a handoff whose references have rotted sends the next agent to files that are gone."
      : "Dependency audit passed: every path referenced here exists right now.",
  };
}
