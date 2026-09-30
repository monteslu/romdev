// source-probe-cli.js - `probe equiv` and `probe deadread`, the two
// source-level probes.
//
// Plain JS ESM + JSDoc.

import { CSourceError } from "./csource.js";
import { DEADREAD_LIMITS, EQUALITY_LIMITS, GUARDED, REACH_MODES, SPELLINGS, deadReadReport, valueEqualityReport, writeVariants } from "./source-probe.js";
import { emitLines } from "./terminal.js";
import { dumps } from "./pyjson.js";
import { strRepr, osErrorText } from "./py.js";
import * as O from "./cli-options.js";

const limitLines = (limits) => ["", "what this does not know:", ...limits.map((i) => `  - ${i}`)];

export async function equivCommand(args, io, ctx) {
  let report;
  try {
    report = valueEqualityReport(args.source, { variable: args.variable, positions: args.at, cwd: ctx.cwd });
  } catch (e) {
    if (!(e instanceof CSourceError)) throw e;
    io.eprint(`error: ${e.message}`);
    return 2;
  }
  if (args.json) { io.print(dumps(report)); return 0; }
  const lines = [
    `value equality: ${report.source}  variable=${report.variable}`,
    `  declared at line ${report.declared_at || "-"}; ${report.definitions.length} definition(s); ${report.reads.length} read(s)`,
    `  ${report.callee_safe_reason}`, "", " range  defined  lines            reads  note",
  ];
  for (const item of report.ranges) {
    let note = "same value at every read";
    if (item.control_breaks.length) note = "NOT ONE RANGE: a label or goto is inside it";
    else if (item.loops.length) note = "spans a loop body: a back-edge can carry a definition";
    const span = `${item.first_line}..${item.last_line}`;
    lines.push(` ${String(item.index).padEnd(6)} ${String(item.defined_at).padEnd(8)} ${span.padEnd(16)} ${String(item.read_count).padEnd(6)} ${note}`);
  }
  if (!report.ranges.length) lines.push(" (no definition of this variable, so no range to report)");
  for (const pair of report.pairs ?? []) {
    const [first, second] = pair.lines;
    lines.push("", `lines ${first} and ${second}: ${pair.verdict}`);
    for (const r of pair.reasons) lines.push(`  ${r}`);
  }
  lines.push(...limitLines(EQUALITY_LIMITS));
  emitLines(io, lines, { width: args.width, pager: args.pager });
  return 0;
}

export async function deadreadCommand(args, io, ctx) {
  let report, variants = [];
  try {
    const spellings = args.spellings === "all" ? SPELLINGS : args.spellings === "guarded" ? GUARDED : SPELLINGS.filter((s) => s.text === args.spellings);
    if (!spellings.length) {
      io.eprint(`error: unknown --spellings ${strRepr(args.spellings)}; use 'guarded', 'all', or one of: ${SPELLINGS.map((s) => s.text).join(", ")}`);
      return 2;
    }
    report = deadReadReport(args.source, { variable: args.variable, spellings, limit: args.limit, reach: args.reach, cwd: ctx.cwd });
    if (args.write) variants = writeVariants(report, { directory: args.write, spelling: args.spelling, variable: args.variable, source: args.source, cwd: ctx.cwd });
  } catch (e) {
    if (e instanceof CSourceError) { io.eprint(`error: ${e.message}`); return 2; }
    if (e && typeof e.code === "string" && /^E[A-Z]+$/.test(e.code)) { io.eprint(`error: ${osErrorText(e)}`); return 2; }
    throw e;
  }
  if (args.json) { io.print(dumps({ ...report, written_variants: variants })); return 0; }
  const ex = report.excluded;
  const lines = [
    `dead-read probe: ${report.source}  variable=${report.variable}`,
    `  declared at line ${report.declared_at || "-"}; definitions at ${report.definitions.slice(0, 8).join(", ")}` + (report.definitions.length > 8 ? " ..." : ""),
    `  ${report.candidate_count} candidate position(s) of ${report.statement_positions}; ${report.loop_free_count} outside any loop, `
      + `${report.dominated_count} reached by a definition on every path`,
    "  excluded: " + Object.entries(ex).map(([n, v]) => `${v} ${n}`).join(", "),
    "",
    "A discarded read costs zero instructions and still adds an occurrence to the variable's web, which is what can drive the web memory-"
      + "resident. It leaves nothing in the object, so no disassembly diff will ever point at it.",
    "", " spelling            footprint  note",
  ];
  for (const s of report.spellings) lines.push(` ${s.spelling.padEnd(19)} ${s.footprint.padEnd(10)} ${s.note}`);
  lines.push("", " line   depth  loop  reached-by    statement",
    " (a bracketed reached-by is a definition in a branch that has closed: the read is still zero-footprint, but it is not a read of a value every path assigned)");
  for (const item of report.candidates) {
    let reached = item.reached_by.slice(0, 3).join(",");
    if (!item.dominated) reached = `(${reached})`;
    lines.push(` ${String(item.line).padEnd(6)} ${String(item.depth).padEnd(6)} ${(item.in_loop ? "LOOP" : "-").padEnd(5)} ${reached.padEnd(13)} ${[...item.before].slice(0, 60).join("")}`);
  }
  if (report.candidates.length) {
    const first = report.candidates[0];
    lines.push("", `patch for line ${first.line}:`, ...first.patches.map((p) => `  ${p.insert}`));
  }
  if (variants.length) lines.push("", `wrote ${variants.length} variant source(s) to ${args.write}; build them with the sweep driver this project already has`);
  lines.push(...limitLines(DEADREAD_LIMITS));
  emitLines(io, lines, { width: args.width, pager: args.pager });
  return 0;
}

export const COMMAND_SPECS = [
  {
    path: ["probe-equiv"], handler: equivCommand, defaults: { report_command: "probe-equiv" },
    help: "report the ranges over which every read of a local is one value",
    description: "A local whose address never escapes cannot be written by a callee, so between two of its definitions its value is fixed and "
      + "every read in that span is the same value -- which makes two differently-spelled expressions built from those reads equal. "
      + "One campaign's closing lever was exactly this fact, and five stages searched the register allocator for it because nothing "
      + "named the check. This is a probe over the text and the block structure, not a verifier: every limit it has is printed with the report.",
    epilog: "example: decomp-workbench probe-equiv work.c --variable sp4B8 --at 920 --at 991",
    arguments: [
      { dest: "source", help: "C source file" },
      { flags: ["--variable"], required: true, metavar: "NAME", help: "the local to reason about" },
      { flags: ["--at"], type: "int", action: "append", default: [], metavar: "LINE", help: "answer the pairwise question for these lines too; repeatable" },
      { flags: ["--json"], action: "store_true", help: "emit JSON" },
      ...O.terminalArguments(),
    ],
  },
  {
    path: ["probe-deadread"], handler: deadreadCommand, defaults: { report_command: "probe-deadread" },
    help: "list positions where a zero-footprint discarded read can be tried",
    description: "A statement that reads a local and drops the value emits no instructions and still adds an occurrence to the variable's web. "
      + "That is enough to change an allocator decision, and it is invisible to every object-level diff, because nothing was "
      + "emitted on either side. This lists the statement positions where a definition structurally reaches the variable, ranks the ones "
      + "outside any loop first, and prints the spelling table with the footprint each one measured.",
    epilog: "example: decomp-workbench probe-deadread work.c --variable sp4A0 --limit 20",
    arguments: [
      { dest: "source", help: "C source file" },
      { flags: ["--variable"], required: true, metavar: "NAME", help: "the local to read" },
      { flags: ["--spellings"], default: "guarded", metavar: "WHICH", help: "which spellings to print patches for: 'guarded' (the zero-footprint value-guarded forms, the default), 'all', or one exact spelling" },
      { flags: ["--reach"], choices: [...REACH_MODES], default: "dominating", help: "which positions count: 'dominating' keeps only those a definition structurally reaches, so the read is of a value every path assigned; 'textual' keeps every position after the first definition line, which is the wider set the campaign's own sweep used and where several of its kills were found (default: dominating)" },
      { flags: ["--limit"], type: "int", metavar: "N", help: "show only the first N candidates (they are ranked loop-free first)" },
      { flags: ["--write"], metavar: "DIR", help: "also write one variant source per candidate into this directory, ready for the project's own sweep driver" },
      { flags: ["--spelling"], default: "if (V != 0.0f);", metavar: "TEXT", help: "the spelling --write inserts, with V standing for the variable (default: if (V != 0.0f);)" },
      { flags: ["--json"], action: "store_true", help: "emit JSON" },
      ...O.terminalArguments(),
    ],
  },
];
