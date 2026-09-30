// diagnose-cli.js - `object diagnose`: exact comparison truth, the aligned
// mechanism evidence, and the source-edit class that evidence supports, as
// one versioned JSON document (decomp-workbench-diagnosis-v3).
//
// Only the JSON document is produced here. The terminal rendering and the
// --html / --emit-force-spec file outputs are not part of romdev; asking for
// them is a usage error that says so.
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
import { leverFor } from "./levers.js";
import { MISSING_LISTING_STEPS, annotateScheduleSites, reportGuidance, scheduleClassCount } from "./loc-boundaries.js";
import { displayPath } from "./model.js";
import { loadReservations } from "./register-state.js";
import { COMPARISON_CENSUS_KEYS } from "./schema.js";
import { freshnessDisplay, freshnessPayload, guardFreshness } from "./staleness.js";
import { parseTrace } from "./trace.js";
import { readTraceText } from "./trace-source.js";

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

function comparisonAccepted(c, crossRom) {
  if (c.relocation_symbol_mismatches) return false;
  if (c.exact) return true;
  return !!(crossRom && c.structural_exact);
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
  if (args.html || args.emit_force_spec) {
    io.eprint(`error: ${args.html ? "--html" : "--emit-force-spec"} writes a file romdev does not produce; this in-process diagnose returns the JSON document only (use --json)`);
    return 2;
  }
  const accepted = comparisonAccepted(comparison, args.cross_rom);
  const [freshness] = freshnessDisplay(args, [args.target, args.candidate], { labels: ["target", "candidate"], cwd: ctx.cwd });
  const payload = diagnosis.asDict({ report_regs: args.report_regs, cross_rom: args.cross_rom });
  if (census.length) payload.comparison.census = census.map((c) => c.asDict());
  Object.assign(payload, freshnessPayload(freshness));
  if (listingReport) payload.loc_boundaries = listingReport.asDict();
  io.print(dumps(payload));
  return censusStatus(census, { otherwise: args.fail_on_mismatch && !accepted ? 1 : 0 });
}

/** Diagnose two object files after disassembling each exactly once. */
export async function diagnoseCommand(args, io, ctx) {
  const warn = (note) => io.eprint(`warning: ${note}`);
  if (!args.json) {
    io.eprint("error: the terminal rendering of diagnose is not available in romdev; pass --json for the diagnosis document");
    return 2;
  }
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

/**
 * Diagnose two retained GNU objdump text files (the same JSON document). Not
 * a registered command; the object form is what romdev drives.
 */
export async function diagnoseDumpsCommand(args, io, ctx) {
  const warn = (note) => io.eprint(`warning: ${note}`);
  if (!args.json) {
    io.eprint("error: the terminal rendering of diagnose is not available in romdev; pass --json for the diagnosis document");
    return 2;
  }
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
