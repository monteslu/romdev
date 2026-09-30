// experiment-cli.js - `experiment validate`, `inspect-source`,
// `review-mutation` and `compose`: validate experiment-family manifests and
// build bounded candidate sets before anything is compiled.
//
// Plain JS ESM + JSDoc.

import { dumps } from "./pyjson.js";
import { isInputError } from "./py.js";
import { osText, isOSError } from "./py-path.js";
import { composeSources, inspectSource, loadComposition, reviewMutation } from "./composition.js";
import { expectedParameterCombinations, loadExperiment } from "./experiments.js";
import { groupListingSpec } from "./group-listing.js";

const reportable = (e) => isOSError(e) || isInputError(e) || e?.name === "JSONDecodeError" || e instanceof SyntaxError;
const errText = (e) => (isOSError(e) && !(e.name === "FileNotFoundError") ? osText(e) : e.message);

export function experimentValidateCommand(args, io, ctx) {
  let report;
  try {
    const manifest = loadExperiment(ctx.resolve(args.manifest));
    const declared = expectedParameterCombinations(manifest);
    const excluded = Number(manifest.coverage.excluded ?? 0);
    let proof = "Schema, paths, assignments, parameter membership, uniqueness, and selected-region bounds validated";
    if (manifest.schema === "decomp-workbench-experiment-v2") proof += "; signal/control references, control-source hash identity, and coverage bounds validated";
    report = {
      ...manifest.asDict(),
      declared_combinations: declared,
      described_candidates: manifest.candidates.size,
      complete_grid: manifest.candidates.size === declared,
      accounted_combinations: manifest.candidates.size + excluded,
      coverage_complete: manifest.candidates.size + excluded === declared,
      signal_count: manifest.signals.length,
      control_count: manifest.controls.length,
      identity: manifest.identityReceipt(),
      proof: proof + "; no candidate was compiled.",
    };
  } catch (e) { if (!reportable(e)) throw e; io.eprint(`error: ${errText(e)}`); return 2; }
  if (args.json || args.json_summary) {
    let payload = report;
    if (args.json_summary) payload = Object.fromEntries(Object.entries(report).filter(([k]) => k !== "candidates"));
    io.print(dumps(payload));
  } else {
    io.print(`experiment: ${report.family} (${report.path})`);
    io.print(`schema: ${report.schema}`);
    io.print(`candidates: ${report.described_candidates} described / ${report.declared_combinations} Cartesian combination(s)`);
    io.print("grid: " + (report.complete_grid ? "COMPLETE" : "PARTIAL (explicit)"));
    if (report.schema === "decomp-workbench-experiment-v2") {
      io.print(`executable evidence: ${report.signal_count} signal(s), ${report.control_count} control(s); coverage accounted ${report.accounted_combinations}/${report.declared_combinations}`);
    }
    io.print(`proof: ${report.proof}`);
  }
  return 0;
}

export function experimentComposeCommand(args, io, ctx) {
  let report;
  try {
    report = composeSources(loadComposition(ctx.resolve(args.manifest)), ctx.resolve(args.output), {
      max_order: args.max_order, max_candidates: args.max_candidates, step: args.step, write: !args.dry_run });
  } catch (e) { if (!reportable(e)) throw e; io.eprint(`error: ${errText(e)}`); return 2; }
  if (args.json) io.print(dumps(report));
  else {
    const mode = args.dry_run ? "planned" : "generated";
    io.print(`composition: ${report.generated_candidates} candidate(s) ${mode}; cross-family=${report.cross_family_candidates} rejected=${report.rejected_combinations.length}`);
    io.print(report.coverage.sentence);
    if (report.output) io.print(`experiment: ${report.output}/experiment.json`);
    for (const item of report.rejected_combinations.slice(0, 5)) io.print(`rejected: ${item.transformations.join("+")}: ${item.error}`);
    if (report.rejected_combinations.length > 5) io.print(`rejected: ... and ${report.rejected_combinations.length - 5} more (use --json for all)`);
    for (const step of report.next_steps) io.print(`next: ${step}`);
    io.print(`proof: ${report.proof}`);
  }
  return report.rejected_combinations.length ? 1 : 0;
}

export function experimentInspectSourceCommand(args, io, ctx) {
  let report;
  try { report = inspectSource(ctx.resolve(args.source)); } catch (e) { if (!reportable(e)) throw e; io.eprint(`error: ${errText(e)}`); return 2; }
  if (args.json) io.print(dumps(report));
  else {
    io.print(`source inspection: ${report.finding_count} candidate construct(s)`);
    for (const item of report.findings) {
      io.print(`line ${item.line}: ${item.kind}: ${item.source}`);
      io.print(`  ask: ${item.review_question}`);
    }
    for (const item of report.duplicate_empty_controls) io.print(`duplicate empty control: count=${item.count} lines=${item.lines.join(",")}`);
    io.print(`proof: ${report.proof}`);
    io.print(`next gate: ${report.next_gate}`);
    io.print("cleanup gates:");
    report.cleanup_gates.forEach((gate, i) => io.print(`  ${i + 1}. ${gate}`));
  }
  return 0;
}

export function experimentReviewMutationCommand(args, io, ctx) {
  let report;
  try { report = reviewMutation(ctx.resolve(args.baseline), ctx.resolve(args.variant), { context: args.context }); } catch (e) {
    if (!reportable(e)) throw e; io.eprint(`error: ${errText(e)}`); return 2;
  }
  if (args.json) io.print(dumps(report));
  else {
    const state = report.findings.length ? "UNREVIEWED" : "NO KNOWN INVALID SHAPE";
    io.print(`mutation review: ${state} (${report.errors} error(s), ${report.warnings} warning(s))`);
    io.print(`changed lines: -${report.changed_lines_removed} +${report.changed_lines_added}`);
    for (const f of report.findings) {
      const location = f.line !== null ? `:${f.line}` : "";
      io.print(`${String(f.severity).toUpperCase()} ${f.code}${location}: ${f.message}`);
      io.print(`  do: ${f.action}`);
    }
    if (!args.no_diff) for (const line of report.diff) io.print(line);
    io.print(`proof: ${report.proof}`);
    io.print(`next gate: ${report.next_gate}`);
  }
  const failed = !!report.errors || (args.fail_on_warning && report.warnings);
  return failed ? 1 : 0;
}

const JSON_FLAG = { flags: ["--json"], action: "store_true", help: "emit JSON" };

const SUBS = [
  { path: ["experiment", "validate"], help: "validate paths, assignments, grid size, and selected region", handler: experimentValidateCommand,
    defaults: { report_command: "experiment-validate" },
    arguments: [{ dest: "manifest" }, JSON_FLAG, { flags: ["--json-summary"], action: "store_true", help: "emit compact JSON without the full candidate list" }],
    mutex: [{ required: false, dests: ["json", "json_summary"] }] },
  { path: ["experiment", "inspect-source"], help: "inventory suspicious fake-match constructs before minimization", handler: experimentInspectSourceCommand,
    defaults: { report_command: "experiment-inspect-source" }, arguments: [{ dest: "source" }, JSON_FLAG] },
  { path: ["experiment", "review-mutation"], help: "diff a sweep winner and name the shapes that invalidate one", handler: experimentReviewMutationCommand,
    description: "Print the baseline-to-variant diff a mutation-sweep winner must be justified against, and flag the two shapes that made a recorded sweep emit variants that compiled, scored, and were not the same program: a read that reaches no definition, and a removed write whose value is still read. Textual review only -- a clean report is not a validity claim.",
    defaults: { report_command: "experiment-review-mutation" },
    arguments: [
      { dest: "baseline", help: "source the sweep mutated" },
      { dest: "variant", help: "candidate the sweep produced" },
      { flags: ["--context"], type: "int", default: 3, help: "diff context lines (default: 3)" },
      { flags: ["--no-diff"], action: "store_true", help: "print findings only; the diff is the review surface, so prefer it" },
      { flags: ["--fail-on-warning"], action: "store_true", help: "return exit 1 for a warning as well as an error" },
      JSON_FLAG,
    ] },
  { path: ["experiment", "compose"], help: "generate a bounded cross-mechanism candidate set", handler: experimentComposeCommand,
    defaults: { report_command: "experiment-compose" },
    arguments: [
      { dest: "manifest" }, { dest: "output" },
      { flags: ["--max-order"], type: "int" },
      { flags: ["--max-candidates"], type: "int" },
      { flags: ["--step"], type: "int", default: 1, metavar: "N", help: "visit every Nth combination, sampling a space too large to enumerate instead of failing the cap. The record says so: a sampled sweep reports the stride and the points it never visited, because a negative result over one point in eight is not a proof about the other seven (default: 1, exhaustive)" },
      { flags: ["--dry-run"], action: "store_true", help: "validate and plan without writing" },
      JSON_FLAG,
    ] },
];

export const COMMAND_SPECS = [
  groupListingSpec(["experiment"], { help: "validate experiment-family manifests before compiling", subcommands: SUBS, required: true, dest: "experiment_command" }),
  ...SUBS,
];
