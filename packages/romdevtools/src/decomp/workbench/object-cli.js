// object-cli.js - the object comparison and ranking journey: `compare`,
// `compare-dumps`, `rank`.
//
// Plain JS ESM + JSDoc.

import fs from "node:fs";
import { parseCensus, evaluateCensus, censusStatus } from "./census.js";
import * as O from "./cli-options.js";
import { MIXED_ALIGNMENT_CAUTION, compareInstructions, compareObjects, rankComparisons } from "./compare.js";
import { alignmentCautionLines, comparisonAcceptance, comparisonExplanationLines, comparisonLine, comparisonPayload,
  diffSiteLines, relocationSymbolCautionLines, warningLines } from "./comparison-render.js";
import { displayPath } from "./model.js";
import { dumpObject, parseSelectedDisassembly, selectionWarnings, symbolSelectionError } from "./objdump.js";
import { COMPARISON_CENSUS_KEYS } from "./schema.js";
import { freshnessDisplay, freshnessPayload, guardFreshness } from "./staleness.js";
import { Painter, resolveColor } from "./terminal.js";
import { evaluateWatchRows, parseWatchRows, watchRowLines, watchRowPayload, watchSignature } from "./watch-rows.js";
import { dumps } from "./pyjson.js";
import { ValueError, isInputError, osErrorText } from "./py.js";
import { isReportedError } from "./py-extra.js";

const errText = (e) => (e && typeof e.code === "string" && /^E[A-Z]+$/.test(e.code) ? osErrorText(e) : e.message);
const reportable = (e) => isInputError(e) || isReportedError(e) || e instanceof SyntaxError;

export function commonCompareArguments() {
  return [
    ...O.symbolArgument(), ...O.explainKeysArgument(), ...O.colorArgument(),
    { flags: ["--section"], default: ".text", help: "object section (default: .text)" },
    { flags: ["--objdump"], help: "GNU-compatible MIPS objdump; auto-detected when omitted" },
    { flags: ["--json"], action: "store_true", help: "emit JSON" },
  ];
}

export const CROSS_ROM_ARGUMENT = { flags: ["--cross-rom"], action: "store_true", help: "accept structural cross-ROM evidence; never call it an object-exact source match" };

/** Python repr of a list of (low, high) ranges, or 'none'. */
function rangesText(ranges) {
  if (!ranges || !ranges.length) return "none";
  return `[${ranges.map((r) => `(${r[0]}, ${r[1]})`).join(", ")}]`;
}

async function regionReport(comparison, args, candidateInstructions, ctx) {
  const source = args.by_region;
  if (!source) return null;
  const { RegionError, buildRegionReport } = await import("./regions.js");
  if (candidateInstructions === null) {
    throw new RegionError("--by-region needs the candidate's instructions with their relocations; this input form does not carry them");
  }
  return buildRegionReport({ source_path: source, source_text: fs.readFileSync(ctx.resolve(source), "utf8"), candidate: candidateInstructions,
    sites: comparison.diff_sites, instruction_delta: comparison.instruction_delta, true_instruction_delta: comparison.true_instruction_delta,
    expected_total: comparison.word_mismatches });
}

/** How many positional rows a comparison covers. */
export function comparisonRows(item) { return Math.max(item.target_instructions, item.candidate_instructions); }

function watchResults(comparison, rows) {
  const results = evaluateWatchRows(rows, { diff_sites: comparison.diff_sites, compared_rows: comparisonRows(comparison) });
  return [watchRowPayload(results), watchRowLines(results)];
}

async function emitComparison(comparison, args, io, ctx, { predicates, show_ranges, candidate_instructions = null }) {
  const [accepted] = comparisonAcceptance(comparison, { cross_rom: args.cross_rom });
  const [freshness, freshnessWarnings] = freshnessDisplay(args, [args.target, args.candidate], { labels: ["target", "candidate"], cwd: ctx.cwd });
  let census, regions, watched;
  try {
    census = evaluateCensus(predicates, comparison.asDict());
    regions = await regionReport(comparison, args, candidate_instructions, ctx);
    watched = parseWatchRows(args.watch_rows ?? null, { cwd: ctx.cwd });
  } catch (e) { if (!reportable(e)) throw e; io.eprint(`error: ${errText(e)}`); return 2; }
  const [watchPayload, watchLines] = watched.length ? watchResults(comparison, watched) : [{}, []];
  if (args.json) {
    const payload = comparisonPayload(comparison, { cross_rom: args.cross_rom, census });
    Object.assign(payload, freshnessPayload(freshness));
    if (regions !== null) payload.by_region = regions.asDict();
    Object.assign(payload, watchPayload);
    io.print(dumps(payload));
  } else {
    const painter = new Painter(resolveColor(args.color ?? "never", { env: ctx.env, isatty: !!ctx.terminal?.isTTY }));
    for (const line of freshnessWarnings) io.print(line);
    for (const line of freshness.provenanceLines()) io.print(`compared: ${line}`);
    for (const line of [...warningLines(comparison.warnings), ...alignmentCautionLines(comparison), ...relocationSymbolCautionLines(comparison)]) io.print(line);
    io.print(comparisonLine(comparison, painter));
    for (const line of watchLines) io.print(line);
    for (const line of comparisonExplanationLines(comparison, { cross_rom: args.cross_rom })) io.print(line);
    if (show_ranges) {
      io.print(`register ranges: ${rangesText(comparison.register_mismatch_ranges)}`);
      io.print(`FP ranges: ${rangesText(comparison.fp_mismatch_ranges)}`);
    }
    if (comparison.relocation_metadata_mismatches) io.print(`relocation metadata mismatches: ${comparison.relocation_metadata_mismatches}`);
    if ((comparison.unknown_relocations ?? []).length) io.print("unknown relocations (not masked): " + comparison.unknown_relocations.join(", "));
    if (args.show_diff) for (const line of diffSiteLines(comparison)) io.print(line);
    if (regions !== null) {
      const { renderRegionReport } = await import("./regions.js");
      io.print("");
      io.print(renderRegionReport(regions, { limit: args.by_region_limit || null }).join("\n"));
    }
    for (const c of census) io.print(c.line);
  }
  return censusStatus(census, { otherwise: args.fail_on_mismatch && !accepted ? 1 : 0 });
}

export async function compareCommand(args, io, ctx) {
  let predicates, comparison, candidateInstructions = null;
  try {
    guardFreshness(args, [args.target, args.candidate], { labels: ["target", "candidate"], cwd: ctx.cwd });
    predicates = parseCensus(args.census, { allowed: COMPARISON_CENSUS_KEYS });
    comparison = compareObjects(args.target, args.candidate, { objdump: args.objdump, symbol: args.symbol, section: args.section, cwd: ctx.cwd, env: ctx.env });
    if (args.by_region) [, candidateInstructions] = dumpObject(args.candidate, { objdump: args.objdump, symbol: args.symbol, section: args.section, cwd: ctx.cwd, env: ctx.env });
  } catch (e) { if (!reportable(e)) throw e; io.eprint(`error: ${errText(e)}`); return 2; }
  return emitComparison(comparison, args, io, ctx, { predicates, show_ranges: true, candidate_instructions: candidateInstructions });
}

export async function compareDumpsCommand(args, io, ctx) {
  let predicates, comparison, candidate;
  try {
    guardFreshness(args, [args.target, args.candidate], { labels: ["target", "candidate"], cwd: ctx.cwd });
    predicates = parseCensus(args.census, { allowed: COMPARISON_CENSUS_KEYS });
    const tText = fs.readFileSync(ctx.resolve(args.target), "utf8"), cText = fs.readFileSync(ctx.resolve(args.candidate), "utf8");
    const target = parseSelectedDisassembly(tText, { symbol: args.symbol });
    candidate = parseSelectedDisassembly(cText, { symbol: args.symbol });
    const tn = displayPath(args.target, ctx.cwd), cn = displayPath(args.candidate, ctx.cwd);
    if (!target.length || !candidate.length) throw new ValueError(symbolSelectionError(args.symbol, { inputs: [[tn, tText], [cn, cText]] }));
    const warnings = selectionWarnings(tText, cText, { symbol: args.symbol, target_name: tn, candidate_name: cn });
    comparison = compareInstructions(target, candidate, { target_name: tn, candidate_name: cn, symbol: args.symbol, warnings });
  } catch (e) { if (!reportable(e)) throw e; io.eprint(`error: ${errText(e)}`); return 2; }
  return emitComparison(comparison, args, io, ctx, { predicates, show_ranges: false, candidate_instructions: candidate });
}

export async function rankCommand(args, io, ctx) {
  let comparisons = [];
  const errors = [];
  let watched;
  try { watched = parseWatchRows(args.watch_rows ?? null, { cwd: ctx.cwd }); }
  catch (e) { if (!reportable(e)) throw e; io.eprint(`error: ${e.message}`); return 2; }
  for (const candidate of args.candidates) {
    try { comparisons.push(compareObjects(args.target, candidate, { objdump: args.objdump, symbol: args.symbol, section: args.section, cwd: ctx.cwd, env: ctx.env })); }
    catch (e) {
      if (!(e?.name === "RuntimeError" || e?.name === "OSError" || e?.name === "FileNotFoundError" || (typeof e?.code === "string" && /^E[A-Z]+$/.test(e.code)))) throw e;
      errors.push({ candidate, error: errText(e) });
    }
  }
  const mixed = new Set(comparisons.map((c) => c.alignment_comparable)).size > 1;
  let unsafe;
  [comparisons, unsafe] = rankComparisons(comparisons);
  const limited = args.limit ? comparisons.slice(0, args.limit) : comparisons;
  if (args.json) {
    const results = limited.map((item) => { const p = item.asDict(); if (watched.length) Object.assign(p, watchResults(item, watched)[0]); return p; });
    io.print(dumps({ results, errors, ranked_by: unsafe ? "geometry-pareto" : "aligned_total", mixed_alignment: mixed,
      alignment_ranking_unsafe: unsafe, watch_row_set: watched.map((w) => w.asDict()) }));
  } else {
    const painter = new Painter(resolveColor(args.color ?? "never", { env: ctx.env, isatty: !!ctx.terminal?.isTTY }));
    if (unsafe) io.print(MIXED_ALIGNMENT_CAUTION);
    if (watched.length) io.print("watch rows (. healed, X broken, ? out of range): " + watched.map((w) => w.label).join(" "));
    limited.forEach((item, i) => {
      for (const line of [...warningLines(item.warnings), ...alignmentCautionLines(item), ...relocationSymbolCautionLines(item)]) io.print(line);
      const signature = watched.length ? watchSignature(evaluateWatchRows(watched, { diff_sites: item.diff_sites, compared_rows: comparisonRows(item) })) + " " : "";
      io.print(`${String(i + 1).padStart(3)} ${signature}${comparisonLine(item, painter)}`);
    });
    for (const f of errors) io.eprint(`ERROR ${f.candidate}: ${f.error}`);
  }
  return comparisons.length ? 0 : 1;
}

function byRegionArguments() {
  return [
    { flags: ["--by-region"], metavar: "SRC", help: "group the differing words by the source construct that emitted them, ranked by count, each citing SRC:line. Attribution is call-relocation anchoring: rows are bracketed between the two calls around them, never interpolated to a line, and the report states its own coverage" },
    { flags: ["--by-region-limit"], type: "int", default: 12, metavar: "N", help: "show only the top N regions (default: 12; 0 for all)" },
  ];
}

const SHOW_DIFF = { flags: ["--show-diff"], action: "store_true", help: "print every differing site, grouped by class" };
const FAIL = { flags: ["--fail-on-mismatch"], action: "store_true", help: "return exit 1 unless exact, or structurally exact with --cross-rom" };

export const COMMAND_SPECS = [
  { path: ["compare"], handler: compareCommand, help: "compare two MIPS objects",
    description: "Compare instruction words, relocations, structure, and registers.",
    arguments: [{ dest: "target", help: "reference object" }, { dest: "candidate", help: "candidate object" }, ...commonCompareArguments(),
      CROSS_ROM_ARGUMENT, SHOW_DIFF, FAIL, ...O.freshnessArguments(), ...O.watchRowsArgument(), ...byRegionArguments(), ...O.censusArgument()] },
  { path: ["compare-dumps"], handler: compareDumpsCommand, help: "compare retained GNU objdump text without object files",
    description: "Run the object comparator on redistributable objdump text.",
    arguments: [{ dest: "target", help: "reference objdump text" }, { dest: "candidate", help: "candidate objdump text" }, ...O.symbolArgument(),
      ...O.explainKeysArgument(), ...O.colorArgument(), { flags: ["--json"], action: "store_true", help: "emit JSON" }, CROSS_ROM_ARGUMENT, SHOW_DIFF, FAIL,
      ...O.freshnessArguments(), ...O.watchRowsArgument(), ...byRegionArguments(), ...O.censusArgument()] },
  { path: ["rank"], handler: rankCommand, help: "rank candidate objects", description: "Compare prebuilt candidates and sort the usable results.",
    arguments: [{ dest: "target", help: "reference object" }, { dest: "candidates", nargs: "+", help: "candidate objects" },
      { flags: ["--limit"], type: "int", default: 20, help: "maximum results to show" }, ...commonCompareArguments(), ...O.watchRowsArgument()] },
];
