// diagnose-cli.js - `object diagnose`: exact comparison truth, the aligned
// mechanism evidence, and the source-edit class that evidence supports, as
// one versioned JSON document (decomp-workbench-diagnosis-v3).
//
// Three outputs from one diagnosis: the JSON document, the terminal screen
// (comparison truth, then the aligned mechanism view, then the lever), and
// the optional --html report and --emit-force-spec handoff files.
//
// Plain JS ESM + JSDoc.

import { readFileSync } from "node:fs";
import os from "node:os";
import { ValueError, splitlines, replace, isInputError, osErrorText } from "./py.js";
import { isReportedError } from "./py-extra.js";
import { dumps } from "./pyjson.js";
import { parseAs1ReorganizeTrace } from "./as1-reorganize.js";
import { CascadeError, CdxLog } from "./cascade.js";
import { parseCensus, evaluateCensus, censusStatus } from "./census.js";
import { diagnoseObjects, diagnoseDumps } from "./diagnosis.js";
import { parseEmitTrace } from "./emit-provenance.js";
import { frameLadder } from "./frame-ladder.js";
import { parseGlobalcolorTrace, passEvidence } from "./globalcolor.js";
import { leverFor, formatLever } from "./levers.js";
import { MISSING_LISTING_STEPS, annotateScheduleSites, reportGuidance, scheduleClassCount, renderLocBoundaries } from "./loc-boundaries.js";
import { alignmentCautionLines, comparisonAcceptance, comparisonExplanationLines, comparisonLine, diffSiteLines,
  relocationSymbolCautionLines, warningLines } from "./comparison-render.js";
import { Painter, emitLines, resolveColor } from "./terminal.js";
import { renderView, writeViewOutputs } from "./view-cli.js";
import { displayPath } from "./model.js";
import { loadReservations } from "./register-state.js";
import { COMPARISON_CENSUS_KEYS } from "./schema.js";
import { freshnessDisplay, freshnessPayload, guardFreshness } from "./staleness.js";
import { parseTrace } from "./trace.js";
import { readTraceText } from "./trace-source.js";
import * as O from "./cli-options.js";

export const TRACE_SETTLED_NOTHING = "trace: {name} holds no declined force and no regsleft=0 contest for this "
  + "scope, so ownership stays heuristic. Widen or correct --trace-proc/"
  + "--trace-web before reading that as agreement.";
export const TRACE_SETTLED = "trace: ownership measured from {name}{scope}.";

const expand = (p) => (p === "~" || p.startsWith("~/") ? os.homedir() + p.slice(1) : p);

function traceScope(args) {
  const parts = [["proc", args.trace_proc], ["web", args.trace_web]].filter(([, v]) => v !== null && v !== undefined).map(([l, v]) => `${l}=${v}`);
  return parts.length ? ` (${parts.join(", ")})` : " (whole compilation)";
}

function traceEvidence(args, ctx, warn) {
  if (!args.trace) return null;
  const text = readTraceText(ctx.resolve(expand(args.trace)), { name: expand(args.trace), warn });
  return passEvidence(parseGlobalcolorTrace(text), { proc: args.trace_proc ?? null, web: args.trace_web ?? null });
}

function traceLines(args, evidence, ctx) {
  if (evidence === null) return [];
  const name = displayPath(args.trace, ctx.cwd);
  if (evidence.decisive) return [TRACE_SETTLED.replace("{name}", name).replace("{scope}", traceScope(args))];
  return [TRACE_SETTLED_NOTHING.replace("{name}", name)];
}

function withTraceNote(diagnosis, args, evidence, ctx) {
  const notes = traceLines(args, evidence, ctx);
  if (!notes.length) return diagnosis;
  return replace(diagnosis, { view: replace(diagnosis.view, { guidance: [...diagnosis.view.guidance, ...notes] }) });
}

function lever(diagnosis, args, ctx, warn) {
  if (diagnosis.comparison.exact) return diagnosis;
  const read = (p) => readTraceText(ctx.resolve(expand(p)), { name: expand(p), warn });
  let ladder = null, cdxLog = null;
  if (args.ladder) {
    cdxLog = new CdxLog(read(args.ladder), { name: displayPath(args.ladder, ctx.cwd) });
    try { ladder = frameLadder(cdxLog, { proc: args.lever_proc ?? null }); } catch (e) {
      if (!(e instanceof CascadeError)) throw e;
      warn(`${e.message} Reading its colouring records only.`);
    }
  }
  const forceResult = args.force_result ? JSON.parse(readFileSync(ctx.resolve(expand(args.force_result)), "utf8")) : null;
  const ringEvents = args.ring_trace ? parseTrace(read(args.ring_trace)) : null;
  const emitEvents = args.emit_trace ? parseEmitTrace(read(args.emit_trace))[0] : null;
  const source = args.source ? splitlines(new TextDecoder("utf-8", { fatal: false }).decode(readFileSync(ctx.resolve(expand(args.source))))) : null;
  const selections = args.as1_trace ? parseAs1ReorganizeTrace(read(args.as1_trace))[0] : null;
  const l = leverFor(diagnosis.view, { ladder, cdx_log: cdxLog, force_result: forceResult, ring_events: ringEvents, emit_events: emitEvents,
    as1_selections: selections, source, proc: args.lever_proc ?? null });
  return replace(diagnosis, { lever: l });
}

function statementLines(diagnosis, args, ctx) {
  const view = diagnosis.view;
  const listing = args.candidate_listing;
  if (!listing) {
    if (scheduleClassCount(view)) return [replace(diagnosis, { view: replace(view, { guidance: [...view.guidance, ...MISSING_LISTING_STEPS] }) }), null];
    return [diagnosis, null];
  }
  const text = readFileSync(ctx.resolve(expand(listing)), "utf8");
  const report = annotateScheduleSites(view, text, { listing_name: displayPath(listing, ctx.cwd), symbol: args.symbol });
  return [replace(diagnosis, { view: replace(view, { guidance: [...view.guidance, ...reportGuidance(report)] }) }), report];
}

const errorText = (e) => (e && typeof e.code === "string" && /^E[A-Z]+$/.test(e.code) ? osErrorText(e) : e.message);
const reportable = (e) => isInputError(e) || isReportedError(e);

export function emit(diagnosis, args, predicates, io, ctx, warn = () => {}) {
  const comparison = diagnosis.comparison;
  if (args.json && args.html) { io.eprint("error: --json and --html are mutually exclusive"); return 2; }
  let listingReport;
  try {
    [diagnosis, listingReport] = statementLines(diagnosis, args, ctx);
    diagnosis = lever(diagnosis, args, ctx, warn);
  } catch (e) {
    if (!reportable(e) && !(e instanceof SyntaxError)) throw e;
    io.eprint(`error: ${errorText(e)}`);
    return 2;
  }
  let census;
  try { census = evaluateCensus(predicates, comparison.asDict()); } catch (e) {
    if (!reportable(e)) throw e;
    io.eprint(`error: ${e.message}`);
    return 2;
  }
  let outputs;
  try { outputs = writeViewOutputs(diagnosis.view, args, ctx, io, { comparison }); } catch (e) {
    if (!reportable(e)) throw e;
    io.eprint(`error: ${errorText(e)}`);
    return 2;
  }
  const [accepted] = comparisonAcceptance(comparison, { cross_rom: args.cross_rom });
  const [freshness, freshnessWarnings] = freshnessDisplay(args, [args.target, args.candidate], { labels: ["target", "candidate"], cwd: ctx.cwd });
  if (args.json) {
    const payload = diagnosis.asDict({ report_regs: args.report_regs, cross_rom: args.cross_rom });
    if (census.length) payload.comparison.census = census.map((c) => c.asDict());
    Object.assign(payload, freshnessPayload(freshness));
    if (listingReport) payload.loc_boundaries = listingReport.asDict();
    io.print(dumps(payload));
  } else {
    const painter = new Painter(resolveColor(args.color, { env: ctx.env, isatty: !!ctx.terminal?.isTTY }));
    const lines = [
      ...freshnessWarnings,
      ...freshness.provenanceLines().map((l) => `compared: ${l}`),
      ...warningLines(comparison.warnings),
      painter.bold("COMPARISON"),
      ...alignmentCautionLines(comparison),
      ...relocationSymbolCautionLines(comparison),
      comparisonLine(comparison, painter),
      ...comparisonExplanationLines(comparison, { cross_rom: args.cross_rom, guidance: false }),
    ];
    if (args.show_diff || args.show_all) lines.push(...diffSiteLines(comparison));
    lines.push("", painter.bold("MECHANISM"));
    const view = diagnosis.view;
    lines.push(...renderView(view, { context: args.context, max_hunks: args.show_all ? 0 : args.max_hunks,
      lane_window: args.show_all ? Math.max(view.target_instructions, view.candidate_instructions) : args.lane_window,
      report_regs: args.report_regs, painter, show_warnings: false, width: args.width, terse: args.terse,
      extra_sections: [...(listingReport ? renderLocBoundaries(listingReport, painter) : []), ...(diagnosis.lever ? ["", ...formatLever(diagnosis.lever)] : [])] }));
    lines.push(...census.map((c) => c.line));
    if (args.html) lines.push(`HTML report: ${outputs.htmlOutput}`);
    if (args.emit_force_spec) lines.push(`diagnostic force specification: ${outputs.forceOutput}`);
    emitLines(io, lines, { width: args.width, pager: args.pager });
  }
  return censusStatus(census, { otherwise: args.fail_on_mismatch && !accepted ? 1 : 0 });
}

/** Diagnose two object files after disassembling each exactly once. */
export async function diagnoseCommand(args, io, ctx) {
  const warn = (note) => io.eprint(`warning: ${note}`);
  let diagnosis, predicates;
  try {
    guardFreshness(args, [args.target, args.candidate], { labels: ["target", "candidate"], cwd: ctx.cwd });
    predicates = parseCensus(args.census ?? [], { allowed: COMPARISON_CENSUS_KEYS });
    const evidence = traceEvidence(args, ctx, warn);
    const res = (p) => (p === null || p === undefined ? null : ctx.resolve(expand(p)));
    diagnosis = withTraceNote(diagnoseObjects(args.target, args.candidate, {
      objdump: args.objdump, symbol: args.symbol, section: args.section, register_profile: args.register_profile, evidence,
      target_reservations: loadReservations(res(args.target_reservations), ctx.resolve(args.target), args.symbol),
      candidate_reservations: loadReservations(res(args.candidate_reservations), ctx.resolve(args.candidate), args.symbol),
      cwd: ctx.cwd, env: ctx.env,
    }), args, evidence, ctx);
  } catch (e) {
    if (!reportable(e) && !(e instanceof SyntaxError)) throw e;
    io.eprint(`error: ${errorText(e)}`);
    return 2;
  }
  return emit(diagnosis, args, predicates, io, ctx, warn);
}

/** Diagnose two retained GNU objdump text files. */
export async function diagnoseDumpsCommand(args, io, ctx) {
  const warn = (note) => io.eprint(`warning: ${note}`);
  let diagnosis, predicates;
  try {
    guardFreshness(args, [args.target, args.candidate], { labels: ["target", "candidate"], cwd: ctx.cwd });
    predicates = parseCensus(args.census ?? [], { allowed: COMPARISON_CENSUS_KEYS });
    const evidence = traceEvidence(args, ctx, warn);
    const res = (p) => (p === null || p === undefined ? null : ctx.resolve(expand(p)));
    diagnosis = withTraceNote(diagnoseDumps(args.target, args.candidate, {
      symbol: args.symbol, register_profile: args.register_profile, evidence,
      target_reservations: loadReservations(res(args.target_reservations), ctx.resolve(args.target), args.symbol),
      candidate_reservations: loadReservations(res(args.candidate_reservations), ctx.resolve(args.candidate), args.symbol),
      cwd: ctx.cwd,
    }), args, evidence, ctx);
  } catch (e) {
    if (!reportable(e) && !(e instanceof SyntaxError)) throw e;
    io.eprint(`error: ${errorText(e)}`);
    return 2;
  }
  return emit(diagnosis, args, predicates, io, ctx, warn);
}

function diagnoseArguments(objectInputs) {
  return [
    { dest: "target", help: objectInputs ? "reference object" : "reference objdump text" },
    { dest: "candidate", help: objectInputs ? "candidate object" : "candidate objdump text" },
    ...O.symbolArgument(),
    ...O.explainKeysArgument(),
    ...(objectInputs ? [
      { flags: ["--section"], default: ".text", help: "object section (default: .text)" },
      { flags: ["--objdump"], help: "GNU-compatible MIPS objdump; auto-detected when omitted" },
    ] : []),
    ...O.candidateListingArgument(),
    { flags: ["--trace"], metavar: "PATH", help: "an instrumented-uopt globalcolor trace (CSAVE/CUP/CDX). A declined force or a regsleft=0 contest in it settles ownership as a measurement, so the verdict reads ownership_basis=trace instead of heuristic" },
    { flags: ["--trace-proc"], type: "int", metavar: "N", help: "scope --trace to one procedure; a trace covers a whole compilation and a residual is one function's" },
    { flags: ["--trace-web"], type: "int", metavar: "N", help: "scope --trace to one web within the procedure" },
    { flags: ["--ladder"], metavar: "PATH", help: "a CDX log carrying CDX_SYMTAB=1 itable records; supplies the declared-local count the stack-home lever is measured against" },
    { flags: ["--force-result"], metavar: "PATH", help: "a decomp-workbench-oracle-sweep-v1 JSON from a recorded CDX_FORCE run. It answers a question no source evidence does: words=0 under a force proves the target's colours are legal in this web graph, and a declined or instruction-adding force proves they are not" },
    { flags: ["--ring-trace"], metavar: "PATH", help: "a DKWB_UGEN_TRACE free-list log; supplies ring pops per source line, which is what names the construct that bought or sold one" },
    { flags: ["--emit-trace"], metavar: "PATH", help: "a DKWB-EMIT-V1 ugen emit-provenance log; supplies the line-order conflicts the loop-header join removes" },
    { flags: ["--as1-trace"], metavar: "PATH", help: "an as1 `cc -Wa,-R` scheduler trace. The deciding key of a selection settles the line question outright: decided on lineno the line lever reaches it, decided above lineno nothing in the source does" },
    { flags: ["--source"], metavar: "PATH", help: "the candidate's C. Read only to check what the line a ring trace charged actually contains: each pop-cost rule was measured on one construct, and without the line no temp-ring edit family is named" },
    { flags: ["--lever-proc"], type: "int", metavar: "N", help: "scope --ladder, --ring-trace and --emit-trace to one procedure ordinal, for the same reason --trace-proc exists" },
    { flags: ["--json"], action: "store_true", help: "emit JSON" },
    ...O.viewRenderArguments({ defaultMaxHunks: 1, showAllHelp: "render every hunk, the full lanes, and the literal differing sites (overrides --max-hunks/--lane-window and implies --show-diff)" }),
    ...O.viewOutputArguments(),
    { flags: ["--show-diff"], action: "store_true", help: "print every positional differing site as well as the aligned hunk" },
    { flags: ["--cross-rom"], action: "store_true", help: "accept structural cross-ROM evidence; never call it an object-exact source match" },
    { flags: ["--fail-on-mismatch"], action: "store_true", help: "return exit 1 unless exact, or structurally exact with --cross-rom" },
    ...O.freshnessArguments(),
    ...O.censusArgument(),
  ];
}

export const COMMAND_SPECS = [
  { path: ["diagnose"], handler: diagnoseCommand, help: "compare and explain two MIPS objects in one screen",
    description: "Disassemble each object once, then render exact comparison truth and the decisive aligned mechanism evidence.",
    arguments: diagnoseArguments(true) },
  { path: ["diagnose-dumps"], handler: diagnoseDumpsCommand, help: "compare and explain retained GNU objdump text",
    description: "Build the combined exact and aligned diagnosis from redistributable objdump text.",
    arguments: diagnoseArguments(false) },
];
