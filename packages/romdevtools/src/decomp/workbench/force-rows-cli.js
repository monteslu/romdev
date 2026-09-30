// force-rows-cli.js - `force-rows` / `force-rows-dumps`: the measured
// force-control to object-row join.
//
// Plain JS ESM + JSDoc.

import fs from "node:fs";
import * as O from "./cli-options.js";
import { DEFAULT_GAP, buildForceRows, forceRowsLines } from "./force-rows.js";
import { parseForceSpecification } from "./instrument-uopt.js";
import { displayPath } from "./model.js";
import { dumpObject, parseDisassembly, symbolSelectionError } from "./objdump.js";
import { emitLines } from "./terminal.js";
import { dumps } from "./pyjson.js";
import { ValueError, isInputError, osErrorText } from "./py.js";
import { isReportedError } from "./py-extra.js";

function load(p, args, ctx, { symbol }) {
  if ((args.objdump !== null && args.objdump !== undefined) || "section" in args) {
    const [, instructions] = dumpObject(p, { objdump: args.objdump ?? null, symbol, section: args.section, cwd: ctx.cwd, env: ctx.env });
    return [...instructions];
  }
  const text = fs.readFileSync(ctx.resolve(p), "utf8");
  const instructions = parseDisassembly(text, { symbol });
  if (!instructions.length) throw new ValueError(symbolSelectionError(symbol, { inputs: [[displayPath(p, ctx.cwd), text]] }));
  return [...instructions];
}

export async function forceRowsCommand(args, io, ctx) {
  let result;
  try {
    parseForceSpecification(args.force);
    const symbol = args.symbol ?? null;
    const baseline = load(args.baseline, args, ctx, { symbol });
    const forced = load(args.forced, args, ctx, { symbol });
    const target = args.target ? load(args.target, args, ctx, { symbol }) : null;
    result = buildForceRows(baseline, forced, { force: args.force, baseline_name: displayPath(args.baseline, ctx.cwd), forced_name: displayPath(args.forced, ctx.cwd),
      target, target_name: args.target ? displayPath(args.target, ctx.cwd) : null, symbol, gap: args.gap });
  } catch (e) {
    if (!(isInputError(e) || isReportedError(e))) throw e;
    io.eprint(`error: ${e.code ? osErrorText(e) : e.message}`);
    return 2;
  }
  if (args.json) { io.print(dumps(result.asDict())); return 0; }
  emitLines(io, forceRowsLines(result), { width: args.width, pager: args.pager });
  return 0;
}

function forceRowsArguments(objectInputs) {
  return [
    { flags: ["--force"], required: true, metavar: "CONTROL", help: "the phase-qualified control the forced build was made with, such as p1:w9=c30; validated by the same parser the instrumented pass uses, and recorded in the report" },
    { flags: ["--target"], help: "optional reference object; joins every run to the aligned row `compare --json` and `window` publish" },
    { flags: ["--gap"], type: "int", default: DEFAULT_GAP, help: `matched rows tolerated inside one run before it is split (default: ${DEFAULT_GAP}; 0 reports strictly contiguous runs)` },
    ...O.symbolArgument({ help: "measure only this exact symbol; --function is the same option" }),
    ...(objectInputs ? [{ flags: ["--section"], default: ".text", help: "object section (default: .text)" },
      { flags: ["--objdump"], help: "GNU-compatible MIPS objdump; auto-detected when omitted" }] : []),
    ...O.explainKeysArgument(),
    { flags: ["--json"], action: "store_true", help: "emit JSON" },
    ...O.terminalArguments(),
  ];
}

const DESCRIPTION = "Measure which object rows one allocator force control owns. Build "
  + "the same source twice -- once without the control and once with it "
  + "-- and this reports the rows that moved, grouped into runs and "
  + "joined to the aligned row numbers `compare --json` publishes. It "
  + "builds nothing itself: the two objects are inputs, so the join works "
  + "for any control a reader can set.";

export const COMMAND_SPECS = [
  { path: ["force-rows"], handler: forceRowsCommand, help: "join an allocator force control to the object rows it moved", description: DESCRIPTION,
    defaults: { report_command: "force-rows" },
    arguments: [{ dest: "baseline", help: "object built without the control" }, { dest: "forced", help: "object built with the control" }, ...forceRowsArguments(true)] },
  { path: ["force-rows-dumps"], handler: forceRowsCommand, help: "join a force control to object rows from retained objdump text", description: DESCRIPTION,
    defaults: { report_command: "force-rows-dumps" },
    arguments: [{ dest: "baseline", help: "objdump text of the unforced build" }, { dest: "forced", help: "objdump text of the forced build" }, ...forceRowsArguments(false)] },
];
