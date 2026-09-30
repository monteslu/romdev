// score-cli.js - `score`: byte-exact function scoring against ROM or object
// truth, or (two positional objects) one headline number.
//
// Plain JS ESM + JSDoc.

import * as O from "./cli-options.js";
import { compareLoaded, loadTarget } from "./compare.js";
import { buildHeadline, renderHeadline } from "./headline.js";
import { ScoreError, ScoreSpec, TargetSpec, parseControlSpec, scoreReport } from "./score.js";
import { buildScreenLine } from "./screen.js";
import { dumps } from "./pyjson.js";
import { strRepr, pyInt, isInputError, osErrorText } from "./py.js";
import { isReportedError } from "./py-extra.js";

export const NEXT_GUIDE = "decomp-workbench guide";
export const NEXT_DIAGNOSE = "decomp-workbench diagnose";

const errText = (e) => (e && typeof e.code === "string" && /^E[A-Z]+$/.test(e.code) ? osErrorText(e) : e.message);
const reportable = (e) => isInputError(e) || isReportedError(e);

/** Translate parsed arguments into a ScoreSpec, validating combinations. */
export function scoreSpecFromArgs(args) {
  const fn = args.symbol;
  let between = null;
  if (args.between) {
    const parts = args.between.split(",").map((x) => x.trim());
    if (parts.length !== 2 || !parts.every(Boolean)) throw new ScoreError(`--between expects SYMA,SYMB (two symbol names): got ${strRepr(args.between)}`);
    between = parts;
  }
  if (Boolean(fn) === Boolean(between)) throw new ScoreError("pass exactly one of --function/--symbol or --between to select the candidate function");
  if (Boolean(args.target_object) === Boolean(args.rom)) throw new ScoreError("pass exactly one of --target-object or --rom to supply target bytes");
  let target;
  if (args.rom) {
    if (!args.rom_offset) throw new ScoreError("--rom requires --rom-offset");
    let romOffset;
    try { romOffset = pyInt(args.rom_offset, 0); } catch { throw new ScoreError(`--rom-offset is not a valid integer: ${strRepr(args.rom_offset)}`); }
    target = new TargetSpec({ kind: "rom", rom: args.rom, rom_offset: romOffset, size: args.size });
  } else {
    if (args.size !== null && args.size !== undefined) throw new ScoreError("--size only applies together with --rom");
    target = new TargetSpec({ kind: "object", target_object: args.target_object });
  }
  return new ScoreSpec({ target, function: fn, between, controls: args.control.map(parseControlSpec), objdump: args.objdump, section: args.section });
}

function printGuidance(io, lines) { lines.forEach((entry, i) => io.print(`${i === 0 ? "next: " : "      "}${entry}`)); }

function printWordScore(io, item, indent = "") {
  io.print(`${indent}${item.label} (${item.mode}): ${item.summary}`);
  if (item.note) io.print(`${indent}  note: ${item.note}`);
}

function renderScoreHuman(io, report) {
  io.print(`candidate: ${report.candidate}`);
  io.print(`target: ${report.target_description}`);
  if (report.screen) {
    io.print(report.screen.rendered);
    if (report.screen.coset_caution) io.print(report.screen.coset_caution);
  }
  printWordScore(io, report.function);
  if (report.controls.length) {
    io.print(`controls: ${report.controls.length} checked`);
    for (const c of report.controls) io.print(`  ${c.label} (${c.mode}): ${c.summary} ${c.matched ? "OK" : "BROKEN"}`);
  }
  let verdict = report.matched ? "MATCH" : "MISMATCH";
  if (report.controls_broken) verdict += " (CONTROLS BROKEN)";
  io.print(`verdict: ${verdict}`);
  printGuidance(io, report.guidance);
}

/** Name the next command, ordered by what the headline actually shows. */
export function headlineGuidance(report) {
  if (report.matched) return ["nothing left on this function; verify the whole object with `decomp-workbench fidelity`"];
  const lines = [];
  if (report.instruction_delta) lines.push(`instruction counts differ; fix that first: decomp-workbench view ${report.target} ${report.candidate}`);
  lines.push(`decomp-workbench next ${report.target} ${report.candidate}`);
  lines.push(`decomp-workbench diagnose ${report.target} ${report.candidate}`);
  return lines;
}

async function headlineCommand(args, io, ctx) {
  const conflicting = [["--target-object", args.target_object], ["--rom", args.rom], ["--rom-offset", args.rom_offset], ["--size", args.size]].filter(([, v]) => v).map(([n]) => n);
  if (conflicting.length) {
    io.eprint(`error: ${conflicting.join(", ")} supplies target bytes from outside the pair, so it cannot be combined with two positional objects.\n`
      + "  Two objects:   decomp-workbench score TARGET.o CANDIDATE.o\n"
      + "  External truth: decomp-workbench score CANDIDATE.o --target-object TARGET.o --symbol NAME");
    return 2;
  }
  if (args.control.length) { io.eprint("error: --control needs a windowed byte comparison; use the single-object form with --target-object or --rom"); return 2; }
  let comparison, screen;
  try {
    const loaded = [args.target, args.candidate].map((p) => loadTarget(p, { objdump: args.objdump, symbol: args.symbol, section: args.section, cwd: ctx.cwd, env: ctx.env }));
    comparison = compareLoaded(loaded[0], loaded[1]);
    screen = await buildScreenLine(loaded[1].instructions, { label: loaded[1].name, path: ctx.resolve(args.candidate), target: loaded[0].instructions, slot: args.slot });
  } catch (e) { if (!reportable(e)) throw e; io.eprint(`error: ${errText(e)}`); return 2; }
  if (comparison.error) { io.eprint(`error: ${comparison.error}`); return 2; }
  const report = buildHeadline(comparison);
  if (args.json) io.print(dumps({ schema: "decomp-workbench-score-v1", mode: "headline", ...report.asDict(), screen: screen.asDict() }));
  else {
    io.print(renderHeadline(report, { verbose: args.verbose }).join("\n"));
    io.print(screen.render());
    const caution = screen.caution();
    if (caution) io.print(caution);
    printGuidance(io, headlineGuidance(report));
  }
  return report.matched ? 0 : 1;
}

export async function scoreCommand(args, io, ctx) {
  if (args.candidate !== null && args.candidate !== undefined) return headlineCommand(args, io, ctx);
  if (!args.target_object && !args.rom) {
    io.eprint("error: one object was given and nothing to compare it against.\n"
      + "  Two objects:   decomp-workbench score TARGET.o CANDIDATE.o\n"
      + "  External truth: decomp-workbench score CANDIDATE.o --target-object TARGET.o --symbol NAME\n"
      + "                  decomp-workbench score CANDIDATE.o --rom game.z64 --rom-offset 0xNNN --symbol NAME");
    return 2;
  }
  let report;
  try { report = await scoreReport(args.target, scoreSpecFromArgs(args), { slot: args.slot, cwd: ctx.cwd, env: ctx.env }); }
  catch (e) { if (!reportable(e)) throw e; io.eprint(`error: ${errText(e)}`); return 2; }
  if (args.json) io.print(dumps({ schema: "decomp-workbench-score-v1", ...report.asDict() }));
  else renderScoreHuman(io, report);
  return report.matched ? 0 : 1;
}

const BETWEEN_SUFFIX = "IDO strips local (static) function symbols, so --function cannot find them; --between finds the bytes between two symbols IDO did keep.";

export const COMMAND_SPECS = [
  { path: ["score"], handler: scoreCommand, formatter: "raw_description", help: "how far is this candidate from the target, in one number",
    description: "Two forms, one number.\n\n  score TARGET.o CANDIDATE.o\n    Compare two objects and print one headline: the positional word delta, which is the function-level matching oracle. The other two counts the workbench reports (aligned_total, raw) are printed beneath it, labelled with what each is for, and any disagreement between them is stated with its cause. Start here.\n\n  score CANDIDATE.o --target-object T.o --symbol NAME\n  score CANDIDATE.o --rom game.z64 --rom-offset 0x1234 --symbol NAME\n    Window one function out of the candidate and compare its bytes against target bytes that live outside the pair -- a ROM image, or an object whose symbol names differ. Repeatable --control functions catch a lever that changed something it must not touch.",
    arguments: [
      { dest: "target", metavar: "TARGET", help: "target object, in the same TARGET CANDIDATE order as compare, diagnose, and view. With no second positional argument this is the CANDIDATE instead, and target bytes come from --target-object or --rom" },
      { dest: "candidate", nargs: "?", metavar: "CANDIDATE", help: "candidate object (.o); omit it to use --target-object/--rom" },
      { flags: ["--verbose"], action: "store_true", help: "explain what each metric in the breakdown measures" },
      ...O.symbolArgument({ help: "score only this function, selected from the symbol table" }),
      { flags: ["--between"], metavar: "SYMA,SYMB", help: "score the bytes between the end of SYMA and the start of SYMB, instead of --function/--symbol. " + BETWEEN_SUFFIX },
      { flags: ["--target-object"], metavar: "FILE", help: "reference object providing target bytes via --function/--between" },
      { flags: ["--rom"], metavar: "FILE", help: "local ROM/binary file providing raw big-endian target bytes" },
      { flags: ["--rom-offset"], metavar: "0xNNN", help: "byte offset into --rom; required together with --rom" },
      { flags: ["--size"], type: "int", metavar: "BYTES", help: "target window size in bytes; only valid with --rom (default: the candidate function's own size)" },
      { flags: ["--slot"], type: "int", metavar: "OFFSET", help: "narrow the screen line's float load and store counts to one stack slot, printed as ld<OFFSET>/st<OFFSET>. Omit it for the whole frame" },
      { flags: ["--control"], action: "append", default: [], metavar: "NAME[@0xOFFSET[:SIZE]]", help: "repeatable known-good control function. With --rom, use NAME@0xOFFSET[:SIZE]; with --target-object, use the bare symbol NAME. Any control with a nonzero non-relocation diff marks the run CONTROLS BROKEN." },
      { flags: ["--objdump"], help: "GNU-compatible MIPS objdump; auto-detected when omitted" },
      { flags: ["--section"], default: ".text", help: "object section (default: .text)" },
      { flags: ["--json"], action: "store_true", help: "emit JSON" },
      ...O.explainKeysArgument(),
    ] },
];
