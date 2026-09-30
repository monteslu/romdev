// allocator-cli.js - semantic allocator reports: trace-copy-decisions,
// trace-webs, trace-origin-probe and trace-stack-homes.
//
// Plain JS ESM + JSDoc.

import { readFileSync } from "node:fs";
import { compareSemanticWebs, originProbeReport, stackHomeReport, webReport } from "./allocator-analysis.js";
import { copyDecisionReport } from "./copytrace.js";
import { parseGlobalcolorTrace } from "./globalcolor.js";
import { readTraceText } from "./trace-source.js";
import { dumps } from "./pyjson.js";
import { sorted, isInputError, osErrorText, percent } from "./py.js";
import { intBase0 } from "./cascade-cli.js";

const pyS = (v) => (v === null || v === undefined ? "None" : v === true ? "True" : v === false ? "False" : Array.isArray(v) ? `[${v.map((x) => `'${x}'`).join(", ")}]` : String(v));
const errText = (e) => (e && typeof e.code === "string" && /^E[A-Z]+$/.test(e.code) ? osErrorText(e) : e.message);
const warner = (io) => (note) => io.eprint(`warning: ${note}`);

export async function copyDecisionsCommand(args, io, ctx) {
  let report;
  try {
    const baseline = readTraceText(ctx.resolve(args.trace), { warn: warner(io) });
    const against = args.against ? readTraceText(ctx.resolve(args.against), { warn: warner(io) }) : null;
    report = copyDecisionReport(baseline, { against, tag: args.stage, proc: args.proc });
  } catch (e) {
    if (!isInputError(e)) throw e;
    io.eprint(`error: ${errText(e)}`);
    return 2;
  }
  if (args.json) io.print(dumps(report));
  else if (args.against) {
    const before = report.summary, after = report.candidate_summary;
    io.print(`copy decisions: ${before.decision_count} -> ${after.decision_count}; coalesced=${before.coalesced}->${after.coalesced}; `
      + `temporary copies=${before.temporary_copies}->${after.temporary_copies}`);
    io.print(`decision delta: ${report.difference_count} aligned difference(s)`);
    for (const item of report.differences.slice(0, args.limit)) {
      const b = item.baseline, a = item.candidate;
      const transition = b === null || a === null ? "presence changed" : `${b.decision}->${a.decision}`;
      io.print(`${item.alignment_key} ${transition} changed=${item.changed.join(",")}`);
    }
    io.print(`warning: ${report.warnings[0]}`);
    io.print(`proof: ${report.proof}`);
    if (!before.decision_count && !after.decision_count) {
      const bs = report.timeline.observed_stages, cs = report.candidate_timeline.observed_stages;
      io.print(`next: no decisions matched the selected stage; observed baseline stages=${bs.length ? pyS(bs) : "none"}, candidate stages=${cs.length ? pyS(cs) : "none"}`);
    }
  } else {
    const s = report.summary;
    io.print(`copy decisions: ${s.decision_count} at ${args.stage}; coalesced=${s.coalesced}; temporary copies=${s.temporary_copies}`);
    for (const item of report.decisions.slice(0, args.limit)) {
      io.print(`${item.alignment_key} ${item.decision} rhs_formed=${item.rhs_formed} colors=${item.lhs_color}/${item.rhs_color}`);
    }
    for (const item of report.timeline.transitions.slice(0, args.limit)) {
      io.print(`transition: ${item.alignment_key} ${item.before_decision}->${item.after_decision} across ${item.before_stage}->${item.after_stage}; owner=${item.owner_pass || "unresolved"}`);
    }
    io.print(`warning: ${report.warnings[0]}`);
    if (!s.decision_count) {
      const st = report.timeline.observed_stages;
      io.print(`next: no decisions matched the selected stage; observed stages=${st.length ? pyS(st) : "none"}`);
    }
  }
  let count = report.summary.decision_count;
  if (args.against) count += report.candidate_summary.decision_count;
  return count ? 0 : 1;
}

export async function allocatorWebsCommand(args, io, ctx) {
  let report;
  try {
    const target = parseGlobalcolorTrace(readTraceText(ctx.resolve(args.trace), { warn: warner(io) }));
    report = args.against
      ? compareSemanticWebs(target, parseGlobalcolorTrace(readTraceText(ctx.resolve(args.against), { warn: warner(io) })), { proc: args.proc })
      : webReport(target, { proc: args.proc });
  } catch (e) {
    if (!isInputError(e)) throw e;
    io.eprint(`error: ${errText(e)}`);
    return 2;
  }
  if (args.json) io.print(dumps(report));
  else if (args.against) {
    const summary = report.decision_summary, outcome = report.outcome_schedule;
    io.print(`allocator semantic diff: ${report.difference_count} difference(s), ${report.ambiguous_fingerprints.length} ambiguous fingerprint(s)`);
    const coverage = report.alignment_coverage;
    io.print(`alignment coverage: common=${report.common_fingerprints}/${report.alignment_denominator} (${coverage === null ? "n/a" : percent(coverage, 1)}) status=${report.alignment_status}`);
    if (!report.common_fingerprints) {
      const d = report.alignment_diagnosis;
      for (const [label, key] of [["present but sharing no value", "no_shared_value"], ["absent from one side", "absent_from_one_side"]]) {
        if (d[key].length) io.print(`  identity ${label}: ${d[key].join(", ")}`);
      }
      for (const record of d.missing_records) io.print(`  no record on either side supplies: ${record}`);
      io.print(`  diagnosis: ${d.guidance}`);
    }
    io.print(`decision delta: actual assignments=${summary.actual_assignment_changes}, natural choices=${summary.natural_choice_changes}, `
      + `forbidden masks=${summary.forbidden_mask_changes}, force overrides=${summary.candidate_force_overrides.length}`);
    io.print(`decision outcome: status=${outcome.status} count=${outcome.target_count}->${outcome.candidate_count} common-prefix=${outcome.common_prefix}`);
    const phases = sorted([...new Set([...Object.keys(outcome.target_phase_counts), ...Object.keys(outcome.candidate_phase_counts)])]);
    if (phases.length) io.print(`decision phases: ${phases.map((p) => `${p}:${outcome.target_phase_counts[p] ?? 0}->${outcome.candidate_phase_counts[p] ?? 0}`).join(",")}`);
    if (outcome.identical && report.alignment_status !== "aligned") {
      io.print("note: source-distinct web topology reached the same ordered register endpoints; this is carrier substitution evidence, not semantic-web identity");
    }
    for (const item of report.differences.slice(0, args.limit)) {
      const b = item.target, a = item.candidate;
      const transition = b === null || a === null ? "presence changed"
        : `w${b.numeric_web} -> w${a.numeric_web} natural=${pyS(b.natural_register)}->${pyS(a.natural_register)} assigned=${pyS(b.assigned_register)}->${pyS(a.assigned_register)}`;
      io.print(`${item.fingerprint} ${transition} changed=${item.changed.join(",")}`);
      for (const side of ["target", "candidate"]) {
        for (const cause of item[`${side}_only_forbidden_causes`]) {
          const owner = side === "target" ? b : a;
          io.print(`  ${side}-only barrier: ${pyS(cause.register)} by proc${owner.proc}:${owner.phase}:w${cause.trace_local_neighbor} (${cause.neighbor_fingerprint})`);
        }
      }
    }
    for (const o of summary.candidate_force_overrides) io.print(`force override: ${o.force_key} ${pyS(o.natural_register)}->${pyS(o.assigned_register)}`);
    if (report.next_gate) io.print(`next gate: ${report.next_gate}`);
    io.print(`outcome proof: ${outcome.proof}`);
    io.print(`proof: ${report.proof}`);
  } else {
    io.print(`allocator webs: ${report.web_count} semantic fingerprint(s), ${report.low_confidence} low-confidence`);
    io.print(`source attribution: ${report.source_attributed_webs} source-attributed, ${report.run_local_unattributed_webs} run-local/unattributed`);
    io.print(`formation lineage: ${report.formation_captured_webs}/${report.web_count} web(s) joined`);
    if (report.next_gate) io.print(`next gate: ${report.next_gate}`);
    for (const item of report.webs.slice(0, args.limit)) {
      const f = item.formation, e = item.economics;
      const formationText = f.status === "captured" ? `event=${pyS(f.range_event)} rank=${pyS(f.formation_rank)} first-bb=${pyS(f.first_member_bb)}` : "not-captured";
      io.print(`${item.fingerprint} confidence=${item.confidence} phase=${item.phase} local=w${item.numeric_web} color=${pyS(item.assigned_color)} `
        + `register=${pyS(item.assigned_register)} decision-trace=${pyS(item.decision_trace_ordinal)} economics=save:${e.save ?? "-"} nocs:${e.nocs ?? "-"} `
        + `totalsave:${e.totalsave ?? "-"} formation=${formationText}`);
    }
    io.print(`formation guidance: ${report.formation_order_guidance}`);
    io.print(`proof: ${report.proof}`);
  }
  const count = args.against ? report.target_webs + report.candidate_webs : report.web_count ?? 0;
  return count ? 0 : 1;
}

export async function stackHomesCommand(args, io, ctx) {
  let report;
  try {
    report = stackHomeReport(parseGlobalcolorTrace(readTraceText(ctx.resolve(args.trace), { warn: warner(io) })), { proc: args.proc, offset: args.offset });
  } catch (e) {
    if (!isInputError(e)) throw e;
    io.eprint(`error: ${errText(e)}`);
    return 2;
  }
  if (args.json) io.print(dumps(report));
  else {
    io.print(`stack homes: ${report.selected_count} shown / ${report.home_count} classified`);
    const dictText = (o) => `{${Object.entries(o).map(([k, v]) => `'${k}': '${v}'`).join(", ")}}`;
    for (const h of report.homes.slice(0, args.limit)) {
      io.print(`${h.fingerprint} kind=${h.kind} virtual=${h.virtual_offset} final=${pyS(h.final_offset)} source=${dictText(h.source)}`);
    }
    if (report.next_gate) io.print(`next gate: ${report.next_gate}`);
    io.print(`proof: ${report.proof}`);
  }
  return report.selected_count ? 0 : 1;
}

export async function originProbeCommand(args, io, ctx) {
  let report;
  try {
    const baseline = parseGlobalcolorTrace(readFileSync(ctx.resolve(args.baseline), "utf8"));
    const variant = parseGlobalcolorTrace(readFileSync(ctx.resolve(args.variant), "utf8"));
    report = originProbeReport(baseline, variant, { role: args.role, proc: args.proc, source_semantic: args.source_semantic, synthetic: args.synthetic });
  } catch (e) {
    if (!isInputError(e)) throw e;
    io.eprint(`error: ${errText(e)}`);
    return 2;
  }
  if (args.json) io.print(dumps(report));
  else {
    const c = report.counts;
    io.print(`origin probe: role=${report.role} classification=${report.classification} scope=${report.claim_scope}`);
    io.print(`web delta: ${c.baseline_webs} -> ${c.variant_webs}; formation -${c.formation_removed} +${c.formation_added}; `
      + `color cascades=${c.common_web_color_changes}; formation collisions=${c.formation_collisions}`);
    io.print(`coarse topology: -${c.topology_removed} +${c.topology_added}; collisions=${c.topology_collisions}`);
    io.print(`allocation economics: -${c.economics_removed} +${c.economics_added}; allocation changes=${c.allocation_economics_transitions}; `
      + `trace-local renumbers=${c.economics_renumber_only}; collisions=${c.economics_collisions}`);
    for (const item of report.allocation_economics_transitions) {
      const b = item.baseline, a = item.variant;
      io.print(`economics transition: w${b.trace_local_web}(${pyS(b.natural_register)}) -> w${a.trace_local_web}(${pyS(a.natural_register)}) changed=${item.changed.join(",")}`);
    }
    if (report.cascade_warning) io.print(`warning: ${report.cascade_warning}`);
    io.print(`proof: ${report.proof}`);
    io.print(`next gate: ${report.next_gate}`);
  }
  return report.evidence_status === "ready" ? 0 : 1;
}

export const COMMAND_SPECS = [
  {
    path: ["trace-copy-decisions"], handler: copyDecisionsCommand, help: "show IDO coalesce-versus-temporary-copy decisions",
    description: "Parse COPYDEC snapshots without treating trace-local bit numbers or hash buckets as source identity. With --against, align final "
      + "decisions by stack home and assignment ordinal.",
    arguments: [
      { dest: "trace" },
      { flags: ["--against"], help: "second COPYDEC trace to compare" },
      { flags: ["--stage"], default: "pre-reemit" },
      { flags: ["--proc"], type: "int" },
      { flags: ["--limit"], type: "int", default: 50 },
      { flags: ["--json"], action: "store_true", help: "emit JSON" },
    ],
  },
  {
    path: ["trace-webs"], handler: allocatorWebsCommand, help: "fingerprint allocator webs by semantic provenance",
    description: "Align allocator decisions by dtype, virtual home, formation chain, and block context; numeric web IDs remain trace-local.",
    arguments: [
      { dest: "trace" },
      { flags: ["--against"], help: "second trace for semantic web diff" },
      { flags: ["--proc"], type: "int" },
      { flags: ["--limit"], type: "int", default: 50 },
      { flags: ["--json"], action: "store_true", help: "emit JSON" },
    ],
  },
  {
    path: ["trace-origin-probe"], handler: originProbeCommand, help: "classify one controlled source edit's allocator-web delta",
    description: "Compare exact semantic identity and coarse topology for one controlled perturbation. This calibrates a role; it does not claim source attribution.",
    arguments: [
      { dest: "baseline" }, { dest: "variant" },
      { flags: ["--role"], required: true, help: "human experiment role label" },
      { flags: ["--proc"], type: "int" },
      { flags: ["--source-semantic"], help: "expected source role label (not producer attribution)" },
      { flags: ["--synthetic"], action: "store_true", help: "mark the result calibration-only" },
      { flags: ["--json"], action: "store_true", help: "emit JSON" },
    ],
  },
  {
    path: ["trace-stack-homes"], handler: stackHomesCommand, help: "classify and query trace-derived stack-home ownership",
    arguments: [
      { dest: "trace" },
      { flags: ["--proc"], type: "int" },
      { flags: ["--offset"], type: intBase0, help: "show owners of one virtual or explicitly recorded final offset" },
      { flags: ["--limit"], type: "int", default: 50 },
      { flags: ["--json"], action: "store_true", help: "emit JSON" },
    ],
  },
];
