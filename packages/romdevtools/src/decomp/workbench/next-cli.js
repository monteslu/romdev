// next-cli.js - `next` / `next-dumps`: discovery as a command.
//
// Plain JS ESM + JSDoc.

import fs from "node:fs";
import * as O from "./cli-options.js";
import { compareInstructions, compareObjects } from "./compare.js";
import { displayPath } from "./model.js";
import { crossFunctionWarning, parseDisassembly, symbolSelectionError } from "./objdump.js";
import { planNextSteps, renderPlan } from "./whats-next.js";
import { dumps } from "./pyjson.js";
import { ValueError, isInputError, osErrorText } from "./py.js";
import { isReportedError } from "./py-extra.js";

export const DEFAULT_LIMIT = 3;

function compareDumps(target, candidate, { symbol, ctx }) {
  const tText = fs.readFileSync(ctx.resolve(target), "utf8"), cText = fs.readFileSync(ctx.resolve(candidate), "utf8");
  const t = parseDisassembly(tText, { symbol }), c = parseDisassembly(cText, { symbol });
  const tn = displayPath(target, ctx.cwd), cn = displayPath(candidate, ctx.cwd);
  if (!t.length || !c.length) throw new ValueError(symbolSelectionError(symbol, { inputs: [[tn, tText], [cn, cText]] }));
  const warning = crossFunctionWarning(tText, cText, { symbol });
  return compareInstructions(t, c, { target_name: tn, candidate_name: cn, symbol, warnings: warning ? [warning] : [] });
}

export async function nextCommand(args, io, ctx) {
  if (args.proc !== null && args.proc !== undefined && !args.trace) { io.eprint("error: --proc requires --trace FILE"); return 2; }
  for (const [option, value] of [["--src", args.src], ["--symbol-map", args.symbol_map], ["--trace", args.trace]]) {
    if (value === null || value === undefined) continue;
    let isFile = false;
    try { isFile = fs.statSync(ctx.resolve(value)).isFile(); } catch {}
    if (!isFile) { io.eprint(`error: ${option} file does not exist: ${value}`); return 2; }
  }
  let comparison;
  try {
    comparison = args.dumps ? compareDumps(args.target, args.candidate, { symbol: args.symbol, ctx })
      : compareObjects(args.target, args.candidate, { objdump: args.objdump, symbol: args.symbol, section: args.section, cwd: ctx.cwd, env: ctx.env });
  } catch (e) {
    if (!(isInputError(e) || isReportedError(e))) throw e;
    io.eprint(`error: ${e.code ? osErrorText(e) : e.message}`);
    return 2;
  }
  if (comparison.error) { io.eprint(`error: ${comparison.error}`); return 2; }
  const plan = planNextSteps(comparison, { target: args.target, candidate: args.candidate, source: args.src, dumps: args.dumps, symbol: args.symbol,
    section: args.section, objdump: args.objdump, symbol_map: args.symbol_map, trace: args.trace, proc: args.proc });
  if (args.json) io.print(dumps(plan.asDict()));
  else io.print(renderPlan(plan, { limit: args.all ? null : DEFAULT_LIMIT }).join("\n"));
  return 0;
}

const DESCRIPTION = "Read the current comparison state and print the next diagnostic step "
  + "or steps, in priority order, each as a runnable command with the real "
  + "paths already substituted and one sentence saying what it settles. "
  + "Steps that clear a blocker -- a difference that makes the others "
  + "unreadable, such as an instruction-count delta -- rank above steps that "
  + "interpret what the blocker distorts. The lever detail stays in `guide`, "
  + "which every plan ends by naming.";

function common() {
  return [
    ...O.symbolArgument({ help: "compare only this function, selected from both inputs" }),
    { flags: ["--src"], metavar: "FILE", help: "the candidate's C source, so region attribution names a real path" },
    { flags: ["--symbol-map"], metavar: "FILE", help: "linked JSON or nm-style symbol map; when relocation fields are the only residue, emit a complete alias-proof command" },
    { flags: ["--trace"], metavar: "FILE", help: "allocator trace for this exact candidate; when allocation owns the residue, emit a concrete oracle plan instead of a placeholder" },
    { flags: ["--proc"], type: "int", metavar: "N", help: "procedure number inside --trace, forwarded to oracle plan" },
    { flags: ["--all"], action: "store_true", help: `print every step, not just the first ${DEFAULT_LIMIT}` },
    { flags: ["--json"], action: "store_true", help: "emit JSON" },
  ];
}

export const COMMAND_SPECS = [
  { path: ["next"], handler: nextCommand, help: "name the next diagnostic step, with the command and why", description: DESCRIPTION,
    epilog: "example: decomp-workbench next target.o candidate.o --src work.c", defaults: { dumps: false },
    arguments: [{ dest: "target", help: "target object (.o)" }, { dest: "candidate", help: "candidate object (.o)" }, ...common(),
      { flags: ["--objdump"], help: "GNU-compatible MIPS objdump; auto-detected when omitted" },
      { flags: ["--section"], default: ".text", help: "object section (default: .text)" }] },
  { path: ["next-dumps"], handler: nextCommand, help: null, description: DESCRIPTION + " Reads two retained objdump texts.",
    defaults: { dumps: true, objdump: null, section: ".text" },
    arguments: [{ dest: "target", help: "retained target disassembly text" }, { dest: "candidate", help: "retained candidate disassembly text" }, ...common()] },
];
