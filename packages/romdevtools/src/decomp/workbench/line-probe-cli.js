// line-probe-cli.js - `probe lines`: whether statement line assignment owns
// a schedule residue, by compiling token-identical line-layout variants.
//
// Plain JS ESM + JSDoc.

import { ValueError, strRepr, splitlines, isInputError, osErrorText } from "./py.js";
import { parseEnvironment } from "./environment.js";
import {
  DEFAULT_SHIFT_LINES, DEFAULT_SPLIT_THRESHOLD, DEFAULT_WORK_DIR, PREPROCESSED_INPUT_HELP, VARIANT_DESCRIPTIONS, VARIANT_NAMES,
  VERDICT_NONDETERMINISTIC, runLineProbe, ProbeOSError,
} from "./line-probe.js";
import { dumps } from "./pyjson.js";
import * as O from "./cli-options.js";

export const FUNCTION_HELP = "window the comparison to this function's byte range, read from the compiled object's ELF symbol table";

export const DESCRIPTION = "Compile a preprocessed C file as three deterministic variants and "
  + "report whether statement line assignment participates in late-pass "
  + "scheduling: baseline (untouched), split-statements (a token-identical "
  + "reflow - a newline after each ';' on an overlong line), and "
  + "global-shift (a control: blank lines prepended, never expected to "
  + "move the object). --tie adds a fourth variant that reassigns one "
  + "statement's line number, which is the follow-up question: not 'does "
  + "line assignment own this?' but 'which line does this statement need?'. "
  + "The input is " + PREPROCESSED_INPUT_HELP + ".";

export const EPILOG = "Variants: " + [...VARIANT_NAMES, "tie"].map((n) => `${n} - ${VARIANT_DESCRIPTIONS[n]}`).join("; ")
  + ". Verdicts: LINE-SENSITIVE (split moved the object, shift did not - "
  + "see field-guide lever 23, preprocessor line assignment); "
  + "NOT line-sensitive (neither moved); NONDETERMINISTIC (shift moved - "
  + "the compile itself is untrustworthy, not just this probe). "
  + "See docs/line-assignment-probe.md for the worked drawbitmap numbers.";

export function parseTies(entries) {
  return entries.map((entry) => {
    const i = entry.indexOf("=");
    const statement = i < 0 ? entry : entry.slice(0, i), assigned = i < 0 ? "" : entry.slice(i + 1);
    if (i < 0 || !/^\d+$/.test(statement) || !/^\d+$/.test(assigned)) {
      throw new ValueError(`--tie ${strRepr(entry)} is not STATEMENT=LINE (two 1-based line numbers, e.g. --tie 83=88)`);
    }
    return [parseInt(statement, 10), parseInt(assigned, 10)];
  });
}

function printReport(report, io) {
  io.print(`input: ${report.input}`);
  io.print(`function: ${report.function || "(whole .text)"}`);
  io.print(`split-threshold: ${report.split_threshold} char(s)   shift-lines: ${report.shift_lines}`);
  const ties = report.ties || [];
  if (ties.length) io.print("ties: " + ties.map(([s, a]) => `${s}->${a}`).join(", "));
  for (const [name, v] of Object.entries(report.variants)) io.print(`  ${name.padEnd(17)} words=${String(v.word_count).padEnd(6)} window=${v.window}`);
  io.print(`split-statements vs baseline: ${report.split_word_diff} word(s) differ`);
  io.print(`global-shift vs baseline:     ${report.shift_word_diff} word(s) differ`);
  if (report.tie_word_diff !== null && report.tie_word_diff !== undefined) io.print(`tie vs baseline:              ${report.tie_word_diff} word(s) differ`);
  io.print(`verdict: ${report.verdict}`);
  for (const line of splitlines(report.message)) io.print(line);
  const target = report.target;
  if (target && Object.keys(target).length) {
    io.print(`target: baseline differs from target at ${target.baseline.mismatched_vs_target} site(s)`);
    const moved = ["split-statements", "global-shift", ...("tie" in target ? ["tie"] : [])];
    for (const name of moved) {
      const s = target[name];
      io.print(`target: ${name} moved toward target at ${s.toward} site(s), away at ${s.away}, unchanged at ${s.unchanged} (of ${s.total_positions} `
        + `compared position(s); ${s.mismatched_vs_target} still differ)`);
    }
  }
  for (const step of report.next_steps || []) io.print(`next: ${step}`);
  io.print(`run directory: ${report.run_directory}`);
}

export async function probeLinesCommand(args, io, ctx) {
  let report;
  try {
    const environment = parseEnvironment(args.env);
    report = await runLineProbe(args.input, {
      compile_template: args.compile_command, function: args.symbol, split_threshold: args.split_threshold, shift_lines: args.shift_lines,
      work_dir: args.work_dir, compile_cwd: args.compile_cwd, environment, timeout: args.timeout, stream_limit: args.stream_limit,
      artifact_dir: args.artifact_dir === null ? null : ctx.resolve(args.artifact_dir), target_bytes: args.target_bytes, target_offset: args.target_offset,
      target_object: args.target_object, ties: parseTies(args.tie), cwd: ctx.cwd,
    });
  } catch (e) {
    if (!isInputError(e) && !(e instanceof ProbeOSError) && e?.name !== "RuntimeError" && e?.name !== "OSError") throw e;
    io.eprint(`error: ${e.code && /^E[A-Z]+$/.test(e.code) ? osErrorText(e) : e.message}`);
    return 2;
  }
  if (args.json) io.print(dumps(report));
  else printReport(report, io);
  return report.verdict === VERDICT_NONDETERMINISTIC ? 1 : 0;
}

export const COMMAND_SPECS = [
  {
    path: ["probe-lines"], handler: probeLinesCommand, help: "probe whether statement line assignment owns a schedule residue",
    description: DESCRIPTION, epilog: EPILOG,
    arguments: [
      { dest: "input", help: `preprocessed .i file - ${PREPROCESSED_INPUT_HELP}` },
      { flags: ["--compile-command"], required: true, help: "command template containing {input} and {output}" },
      ...O.symbolArgument({ help: FUNCTION_HELP }),
      { flags: ["--split-threshold"], type: "int", default: DEFAULT_SPLIT_THRESHOLD, metavar: "CHARS", help: `only reflow physical lines longer than this (default: ${DEFAULT_SPLIT_THRESHOLD})` },
      { flags: ["--shift-lines"], type: "int", default: DEFAULT_SHIFT_LINES, metavar: "N", help: `blank lines the global-shift control prepends (default: ${DEFAULT_SHIFT_LINES})` },
      { flags: ["--tie"], action: "append", default: [], metavar: "STATEMENT=LINE", help: "reassign the statement on 1-based input line STATEMENT to line number LINE via a #line pair (a fourth 'tie' variant); repeatable - the probe that converts a line-owned schedule residue into a fix" },
      { flags: ["--target-bytes"], help: "score every variant against this raw binary file (word diff)" },
      { flags: ["--target-offset"], type: "int", default: 0, metavar: "N", help: "byte offset into --target-bytes (default: 0)" },
      { flags: ["--target-object"], help: "score every variant against this object's ELF-windowed .text" },
      { flags: ["--work-dir"], default: DEFAULT_WORK_DIR, help: `project-visible run root (default: ${DEFAULT_WORK_DIR})` },
      { flags: ["--compile-cwd"], help: "working directory for the compile command" },
      { flags: ["--env"], action: "append", default: [], metavar: "NAME=VALUE", help: "explicit compiler environment entry; repeatable" },
      { flags: ["--timeout"], type: "float", default: 120.0, metavar: "SECONDS", help: "seconds to allow each compile (default: 120.0)" },
      ...O.processOutputArguments(),
      { flags: ["--json"], action: "store_true", help: "emit JSON" },
    ],
  },
];
