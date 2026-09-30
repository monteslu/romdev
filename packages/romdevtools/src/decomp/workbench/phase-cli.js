// phase-cli.js - `phase` / `phase-dumps`: the ring-phase profiler.
//
// Plain JS ESM + JSDoc.

import fs from "node:fs";
import { createHash } from "node:crypto";
import * as O from "./cli-options.js";
import { displayPath, shortenPaths } from "./model.js";
import { COSET_FAMILIES, DEFAULT_RING, MAX_ALL_RING, PhaseError, buildPhaseReport, parseRing, parseSlots, phaseLines } from "./phase.js";
import { loadDumpRows, loadObjectRows } from "./row-source.js";
import { dumpObject, trimFunctionPadding } from "./objdump.js";
import { ALIGNMENT_GRANULARITIES, DEFAULT_GRANULARITY, buildShiftDiff } from "./shift-align.js";
import { emitLines } from "./terminal.js";
import { dumps } from "./pyjson.js";
import { sorted, splitlines, isInputError, osErrorText } from "./py.js";
import { isReportedError } from "./py-extra.js";

export const PHASE_CENSUS_SCHEMA = "decomp-workbench-phase-census-v1";

function readSlots(args, ctx) {
  if (args.slots && args.slots_from) throw new PhaseError("--slots and --slots-from both name the slot table; pass one of them");
  if (args.slots) return parseSlots(args.slots);
  if (args.slots_from) {
    const text = fs.readFileSync(ctx.resolve(args.slots_from), "utf8");
    const entries = splitlines(text).map((l) => l.split("#", 1)[0].trim());
    return parseSlots(entries.filter(Boolean).join(","));
  }
  return null;
}

function rows(p, args, cache, ctx) {
  if (args.dumps) return loadDumpRows(ctx.resolve(p), { symbol: args.symbol });
  if (cache !== null) return loadObjectRows(p, { objdump: args.objdump, symbol: args.symbol, section: args.section, cache });
  const [, instructions] = dumpObject(p, { objdump: args.objdump, symbol: args.symbol, section: args.section, cwd: ctx.cwd, env: ctx.env });
  return trimFunctionPadding([...instructions]);
}

function baseIdentity(args, ctx) {
  if (!args.base) {
    if (args.require_base) throw new PhaseError("--require-base needs --base SOURCE to check against; pass the source file this candidate was built from");
    return [null, null];
  }
  const digest = createHash("sha256").update(fs.readFileSync(ctx.resolve(args.base))).digest("hex");
  if (args.require_base && !digest.startsWith(args.require_base.toLowerCase())) {
    throw new PhaseError(`--base ${displayPath(args.base, ctx.cwd)} has sha256 ${digest}, which does not start with the pinned --require-base ${args.require_base}. `
      + "These candidates were built from a different base than the table you are comparing them with; rebuild, or drop the pin deliberately.");
  }
  return [displayPath(args.base, ctx.cwd), digest];
}

const signed = (n) => (n >= 0 ? `+${n}` : String(n));

function checkInstructionCount(report, { strict }) {
  if (report.instruction_delta === 0) return null;
  const message = `NI: ${report.candidate_name} holds ${report.candidate_rows} real instruction(s) against the target's ${report.target_rows} `
    + `(${signed(report.instruction_delta)}). Rows below are paired through the alignment, so the slot scores are still meaningful -- but a `
    + "row-for-row scorer would have shifted every row after the divergence and reported a number for a different question.";
  if (strict) throw new PhaseError(message + " --require-ni was passed, so this candidate is not scored.");
  return message;
}

export function censusLines(reports) {
  const [labels, shared] = shortenPaths(reports.map((r) => r.candidate_name));
  const width = Math.max(...reports.map((r) => labels.get(r.candidate_name).length));
  const vw = Math.max(...reports.map((r) => r.phase_vector.join(" ").length));
  const lines = [`${"candidate".padEnd(width)}  ${"ni".padStart(5)} ${"delta".padStart(6)}  ${"phase".padEnd(vw)}  ${"free".padStart(6)} ${"positional".padStart(10)}  note`];
  for (const item of sorted(reports, (r) => [r.positional, r.candidate_name])) {
    let note = item.quotiented_is_bare ? "" : "COSET";
    if (item.instruction_delta) note = `SHIFTED ${note}`.trim();
    lines.push(`${labels.get(item.candidate_name).padEnd(width)}  ${String(item.candidate_rows).padStart(5)} ${signed(item.instruction_delta).padStart(6)}  `
      + `${item.phase_vector.join(" ").padEnd(vw)}  ${String(item.quotiented).padStart(6)} ${String(item.positional).padStart(10)}  ${note}`);
  }
  lines.push("");
  if (shared) lines.push(shared);
  lines.push("free is quotiented by each slot's best-fit ring coset; positional is what the object scores as written. They agree only for a row marked with no COSET note -- rank on positional.");
  return lines;
}

export async function phaseCommand(args, io, ctx) {
  let cache = null;
  if (args.disassembly_cache) {
    const { DisassemblyCache } = await import("./dis-cache.js");
    cache = new DisassemblyCache({ directory: args.disassembly_cache, objdump: args.objdump });
  }
  const reports = [], notices = [];
  try {
    const ring = parseRing(args.ring);
    if (args.cosets === null || args.cosets === undefined) {
      if (ring.length > MAX_ALL_RING) {
        args.cosets = "paired";
        io.eprint(`note: ${ring.length}-register ring is too large to permute; searching paired cosets (pass --cosets to choose)`);
      } else args.cosets = "all";
    }
    const slots = readSlots(args, ctx);
    const [baseSource, baseSha] = baseIdentity(args, ctx);
    const target = rows(args.target, args, cache, ctx);
    const context = args.context ? rows(args.context, args, cache, ctx) : null;
    const baseline = args.baseline ? rows(args.baseline, args, cache, ctx) : null;
    const shiftOf = (r, name) => buildShiftDiff(target, r, { target_name: displayPath(args.target, ctx.cwd), candidate_name: name, symbol: args.symbol, granularity: args.align_on });
    const contextShift = context !== null ? shiftOf(context, displayPath(args.context, ctx.cwd)) : null;
    const baselineShift = baseline !== null ? shiftOf(baseline, displayPath(args.baseline, ctx.cwd)) : null;
    for (const candidate of args.candidates) {
      const r = rows(candidate, args, cache, ctx);
      const name = displayPath(candidate, ctx.cwd);
      const report = buildPhaseReport(target, r, { shift: shiftOf(r, name), slots, ring, coset_family: args.cosets, minimum_evidence: args.min_evidence,
        target_name: displayPath(args.target, ctx.cwd), candidate_name: name, symbol: args.symbol, context, context_shift: contextShift,
        context_name: args.context ? displayPath(args.context, ctx.cwd) : null, baseline, baseline_shift: baselineShift,
        baseline_name: args.baseline ? displayPath(args.baseline, ctx.cwd) : null, base_source: baseSource, base_sha256: baseSha });
      const notice = checkInstructionCount(report, { strict: args.require_ni });
      if (notice) notices.push(notice);
      reports.push(report);
    }
  } catch (e) {
    if (!(isInputError(e) || isReportedError(e))) throw e;
    io.eprint(`error: ${e.code ? osErrorText(e) : e.message}`);
    return 2;
  }
  const rejections = (cache ? cache.rejections : []).map((ev) => `cache: ${ev}`);
  if (args.json) {
    const payload = reports.length === 1 ? reports[0].asDict()
      : { schema: PHASE_CENSUS_SCHEMA, target: displayPath(args.target, ctx.cwd), candidates: reports.map((r) => r.asDict()) };
    payload.instruction_count_notices = notices;
    payload.cache_rejections = (cache ? cache.events : []).filter((ev) => ev.status === "rejected").map((ev) => ev.asDict());
    io.print(dumps(payload));
    return 0;
  }
  let lines;
  if (reports.length === 1) lines = phaseLines(reports[0], { detail: args.detail });
  else { lines = censusLines(reports); if (notices.length) lines.push("", ...notices); }
  if (rejections.length) lines.push("", ...rejections);
  emitLines(io, lines, { width: args.width, pager: args.pager });
  return 0;
}

function phaseArguments(objectInputs) {
  return [
    { flags: ["--slots"], metavar: "NAME=LO..HI,...", help: "named, inclusive target row ranges to read the phase over; they must partition the object's rows exactly, and a hole or an overlap is an error naming the rows. Default: one slot covering the whole object" },
    { flags: ["--slots-from"], metavar: "FILE", help: "read the slot table from a file, one NAME=LO..HI per line, '#' starting a comment; use this rather than a shell variable, which zsh does not word-split" },
    { flags: ["--ring"], default: DEFAULT_RING.join(","), metavar: "REGISTERS", help: `the scratch ring whose rotation is quotiented out (default: ${DEFAULT_RING.join(",")})` },
    { flags: ["--cosets"], choices: COSET_FAMILIES, default: null, help: "which renamings count as the same allocation rotated: all permutations of the ring, or paired (identity plus disjoint-pair swaps, the physically plausible set) (default: all, falling back to paired with a notice when the ring is too large to permute)" },
    { flags: ["--min-evidence"], type: "int", default: 1, metavar: "ROWS", help: "rows whose match depends on the coset that a slot needs before its phase is reported as measured; below this the slot reads no-evidence rather than being labelled from one row (default: 1)" },
    { flags: ["--context"], metavar: "OBJECT", help: "score each slot at the coset this object measures, instead of at the candidate's own best fit. A small slot classified in isolation lands on whichever permutation happens to win; scored on a context that already uses the ring, its real cost shows" },
    { flags: ["--baseline"], metavar: "OBJECT", help: "also report which rows this candidate healed and which it broke against a previous candidate, rather than only the net score" },
    { flags: ["--base"], metavar: "SOURCE", help: "stamp the source file these candidates were built from, by SHA-256" },
    { flags: ["--require-base"], metavar: "SHA256", help: "refuse to score unless --base has this SHA-256 (a prefix is enough); stops a table of objects built from one base being compared with an object built from another" },
    { flags: ["--require-ni"], action: "store_true", help: "refuse to score a candidate whose real instruction count is not the target's, instead of scoring it and flagging the shift" },
    { flags: ["--align-on"], choices: ALIGNMENT_GRANULARITIES, default: DEFAULT_GRANULARITY, help: `granularity the rows are paired at before scoring (default: ${DEFAULT_GRANULARITY}; see \`align\`)` },
    { flags: ["--detail"], action: "store_true", help: "also print where inside each slot the residual rows fall" },
    ...O.symbolArgument({ help: "read only this exact symbol; --function is the same option" }),
    ...(objectInputs ? [
      { flags: ["--section"], default: ".text", help: "object section (default: .text)" },
      { flags: ["--objdump"], help: "GNU-compatible MIPS objdump; auto-detected when omitted" },
      { flags: ["--disassembly-cache"], metavar: "DIR", help: "reuse disassemblies from this directory across runs; entries are rebuilt unless they prove they are a complete disassembly of the object on disk" },
    ] : []),
    { flags: ["--json"], action: "store_true", help: "emit JSON. One candidate is a `decomp-workbench-phase-v1` report; more than one is a `decomp-workbench-phase-census-v1` document holding one such report per candidate under `candidates`. Switch on `schema`" },
    ...O.explainKeysArgument(),
    ...O.terminalArguments(),
  ];
}

const DESCRIPTION = "Read a candidate's scratch-ring phase as a vector over named row slots. "
  + "A float-heavy function is often not wrong but rotated: the same values "
  + "in the same ring, starting at a different register, so whole regions "
  + "differ in every row while being one renaming away from exact. This "
  + "reports, per slot, the ring coset that would make it match, the "
  + "quotiented count under that coset, and the positional count it really "
  + "scores -- never the first without the second, because a bare quotiented "
  + "number reads as progress an object has not made. Slots are checked to "
  + "partition the row space, so no mismatch can fall in a gap, and rows are "
  + "paired through the same alignment `align` reports, so an inserted "
  + "instruction shifts the comparison instead of destroying it.";

export const COMMAND_SPECS = [
  { path: ["phase"], handler: phaseCommand, help: "read the scratch-ring phase vector over named row slots", description: DESCRIPTION,
    epilog: "example: decomp-workbench phase target.o candidate.o --slots head=1..2038,body=2039..4200,tail=4201..4641",
    defaults: { dumps: false, report_command: "phase" },
    arguments: [{ dest: "target", help: "reference object" }, { dest: "candidates", nargs: "+", help: "candidate object(s)" }, ...phaseArguments(true)] },
  { path: ["phase-dumps"], handler: phaseCommand, help: "read the ring phase from retained objdump text",
    description: DESCRIPTION + " This variant reads retained `objdump -d -r` text, for a reader who has the dumps but not the objects.",
    defaults: { dumps: true, objdump: null, section: ".text", disassembly_cache: null, report_command: "phase-dumps" },
    arguments: [{ dest: "target", help: "retained target disassembly" }, { dest: "candidates", nargs: "+", help: "retained candidate disassembly" }, ...phaseArguments(false)] },
];
