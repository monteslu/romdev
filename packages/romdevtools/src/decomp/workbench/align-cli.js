// align-cli.js - `align` / `align-dumps`: how many instructions a candidate
// is away from the target, as a shift-tolerant edit script, rather than how
// far one insertion shifted every later row.
//
// Plain JS ESM + JSDoc.

import { ArgumentTypeError } from "./argparse.js";
import * as O from "./cli-options.js";
import { displayPath, shortenPaths } from "./model.js";
import { loadDumpRows, loadObjectRows } from "./row-source.js";
import { dumpObject, trimFunctionPadding } from "./objdump.js";
import { ALIGNMENT_GRANULARITIES, DEFAULT_GRANULARITY, buildShiftDiff, shiftDiffLines } from "./shift-align.js";
import { emitLines } from "./terminal.js";
import { dumps } from "./pyjson.js";
import { strRepr, strip, sorted, isInputError, osErrorText } from "./py.js";
import { isReportedError } from "./py-extra.js";

export const ALIGN_CENSUS_SCHEMA = "decomp-workbench-align-census-v1";

/** Parse `LO..HI` into an inclusive target row range. */
export function parseWindow(value) {
  const text = strip(value);
  const i = text.indexOf("..");
  if (i < 0) throw new ArgumentTypeError(`invalid --window ${strRepr(value)}; write it as LO..HI, for example --window 2039..2110`);
  const s = text.slice(0, i), e = text.slice(i + 2);
  const isInt = (x) => /^\s*[-+]?\d+\s*$/.test(x);
  if (!isInt(s) || !isInt(e)) throw new ArgumentTypeError(`invalid --window ${strRepr(value)}; both bounds must be row numbers`);
  const low = parseInt(s, 10), high = parseInt(e, 10);
  if (high < low) throw new ArgumentTypeError(`invalid --window ${strRepr(value)}; the lower row comes first`);
  return [low, high];
}
parseWindow.displayName = "parse_window";

function rows(p, args, cache, ctx) {
  if (args.dumps) return loadDumpRows(ctx.resolve(p), { symbol: args.symbol });
  if (cache !== null) return loadObjectRows(p, { objdump: args.objdump, symbol: args.symbol, section: args.section, cache });
  const [, instructions] = dumpObject(p, { objdump: args.objdump, symbol: args.symbol, section: args.section, cwd: ctx.cwd, env: ctx.env });
  return trimFunctionPadding([...instructions]);
}

function windowTally(diff, [low, high]) {
  return { window_start: low, window_stop: high, before: diff.cuts.filter((r) => r < low).length, inside: diff.cuts.filter((r) => low <= r && r <= high).length };
}

const pad = (v, n) => String(v).padStart(n);
const signedPad = (v, n) => (v >= 0 ? `+${v}` : String(v)).padStart(n);

export function censusLines(results) {
  const [labels, shared] = shortenPaths(results.map(([d]) => d.candidate_name));
  const width = Math.max(...results.map(([d]) => labels.get(d.candidate_name).length));
  let header = `${"candidate".padEnd(width)}  ${"rows".padStart(5)} ${"delta".padStart(6)} ${"away".padStart(6)} ${"edit".padStart(5)} ${"rep".padStart(5)} ${"ins".padStart(5)} ${"del".padStart(5)} ${"residual".padStart(8)}  shape`;
  if (results.length && results[0][1] !== null) header += "  before  inside";
  const lines = [header];
  for (const [diff, window] of sorted(results, (r) => [r[0].rows_away, r[0].candidate_name])) {
    const shape = !diff.blocks.length ? "aligned" : diff.insertion_only ? "insertion-only" : "structural";
    let line = `${labels.get(diff.candidate_name).padEnd(width)}  ${pad(diff.candidate_rows, 5)} ${signedPad(diff.candidate_rows - diff.target_rows, 6)} ${pad(diff.rows_away, 6)} `
      + `${pad(diff.edit_distance, 5)} ${pad(diff.replaced, 5)} ${pad(diff.inserted, 5)} ${pad(diff.deleted, 5)} ${pad(diff.paired_mismatches, 8)}  ${shape}`;
    if (window !== null) line += `  ${pad(window.before, 6)}  ${pad(window.inside, 6)}`;
    lines.push(line);
  }
  lines.push("");
  if (shared) lines.push(shared);
  lines.push("away = edit + residual: the instructions a source change must move. It is the ranking number; delta is how far the candidate's length is from the target's.");
  return lines;
}

export async function alignCommand(args, io, ctx) {
  let cache = null;
  if (args.disassembly_cache) {
    const { DisassemblyCache } = await import("./dis-cache.js");
    cache = new DisassemblyCache({ directory: args.disassembly_cache, objdump: args.objdump });
  }
  const results = [];
  try {
    const target = rows(args.target, args, cache, ctx);
    if (!target.length) {
      io.eprint(`error: ${displayPath(args.target, ctx.cwd)} holds no instruction rows to align against; check --section and --symbol`);
      return 2;
    }
    for (const candidate of args.candidates) {
      const r = rows(candidate, args, cache, ctx);
      const diff = buildShiftDiff(target, r, { target_name: displayPath(args.target, ctx.cwd), candidate_name: displayPath(candidate, ctx.cwd),
        symbol: args.symbol, granularity: args.align_on, context: args.context_rows });
      results.push([diff, args.window ? windowTally(diff, args.window) : null]);
    }
  } catch (e) {
    if (!(isInputError(e) || isReportedError(e))) throw e;
    io.eprint(`error: ${e.code ? osErrorText(e) : e.message}`);
    return 2;
  }
  const notes = (cache ? cache.rejections : []).map((ev) => `cache: ${ev}`);
  if (args.json) {
    let payload;
    if (results.length === 1) {
      payload = results[0][0].asDict();
      if (results[0][1] !== null) payload.window = results[0][1];
    } else {
      payload = { schema: ALIGN_CENSUS_SCHEMA, target: displayPath(args.target, ctx.cwd),
        candidates: results.map(([d, w]) => ({ ...d.asDict(), ...(w ? { window: w } : {}) })) };
    }
    payload.cache_rejections = (cache ? cache.events : []).filter((ev) => ev.status === "rejected").map((ev) => ev.asDict());
    io.print(dumps(payload));
    return 0;
  }
  let lines;
  if (results.length === 1) {
    const [diff, window] = results[0];
    lines = shiftDiffLines(diff, { blocks: args.blocks });
    if (window !== null) lines.push(`window ${window.window_start}..${window.window_stop}: ${window.before} insertion(s) before it, ${window.inside} inside it`);
  } else lines = censusLines(results);
  if (notes.length) lines.push("", ...notes);
  emitLines(io, lines, { width: args.width, pager: args.pager });
  return 0;
}

function alignArguments(objectInputs) {
  return [
    { flags: ["--align-on"], choices: ALIGNMENT_GRANULARITIES, default: DEFAULT_GRANULARITY,
      help: `how much of each instruction the aligner sees: opcode (mnemonics only -- survives a register renaming, and the granularity a scorer wants), normalized (operand shape too), or exact (default: ${DEFAULT_GRANULARITY})` },
    { flags: ["--window"], type: parseWindow, metavar: "LO..HI", help: "also tally how many insertions land before and inside this inclusive target row range, for example --window 2039..2110" },
    { flags: ["--blocks"], type: "int", default: 20, metavar: "N", help: "edit-script blocks to quote in the single-candidate report (default: 20)" },
    { flags: ["--context-rows"], type: "int", default: 3, metavar: "N", help: "instructions quoted from each side of a block (default: 3)" },
    ...O.symbolArgument({ help: "align only this exact symbol; --function is the same option" }),
    ...(objectInputs ? [
      { flags: ["--section"], default: ".text", help: "object section (default: .text)" },
      { flags: ["--objdump"], help: "GNU-compatible MIPS objdump; auto-detected when omitted" },
      { flags: ["--disassembly-cache"], metavar: "DIR", help: "reuse disassemblies from this directory across runs; entries are rebuilt unless they prove they are a complete disassembly of the object on disk. There is no default: a scorer that defaults to a directory scores whatever is in it" },
    ] : []),
    { flags: ["--json"], action: "store_true", help: "emit JSON. One candidate is a `decomp-workbench-shift-diff-v1` report; more than one is a `decomp-workbench-align-census-v1` document holding one such report per candidate under `candidates`. Switch on `schema`" },
    ...O.explainKeysArgument(),
    ...O.terminalArguments(),
  ];
}

const DESCRIPTION = "Report how many instructions a candidate is away from the target, "
  + "rather than how far one insertion shifted it. Position-indexed "
  + "comparison reads candidate row N against target row N, so an object "
  + "that is byte-exact apart from one extra instruction reports a "
  + "four-figure mismatch count and reads as garbage. This aligns the two "
  + "streams and prints the edit script instead: replaced, inserted and "
  + "deleted counts, the target rows each block lands at, and the derived "
  + "cut list a banded scorer needs. Pass more than one candidate for a "
  + "one-line-each census ordered by edit distance.";

export const COMMAND_SPECS = [
  { path: ["align"], handler: alignCommand, help: "report the edit script between two objects, tolerant of shifts", description: DESCRIPTION,
    epilog: "example: decomp-workbench align target.o candidate.o --window 2039..2110",
    defaults: { dumps: false, report_command: "align" },
    arguments: [{ dest: "target", help: "reference object" }, { dest: "candidates", nargs: "+", help: "candidate object(s)" }, ...alignArguments(true)] },
  { path: ["align-dumps"], handler: alignCommand, help: "align retained objdump text instead of objects",
    description: DESCRIPTION + " This variant reads retained `objdump -d -r` text, for a reader who has the dumps but not the objects.",
    defaults: { dumps: true, objdump: null, section: ".text", disassembly_cache: null, report_command: "align-dumps" },
    arguments: [{ dest: "target", help: "retained target disassembly" }, { dest: "candidates", nargs: "+", help: "retained candidate disassembly" }, ...alignArguments(false)] },
];
