// pre-cli.js - `trace-pre` (trace pre) and `instrument-pre` (instrument pre):
// PRE/speculative-hoist compiler-decision provenance.
//
// Plain JS ESM + JSDoc.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { comparePreTraces, instrumentPreSource, loadPreProfile, parsePreTrace, preReport } from "./pre.js";
import { readTraceText } from "./trace-source.js";
import { readTextUniversal } from "./instrument-uopt-cli.js";
import { resolvePath } from "./py-path.js";
import { dumps } from "./pyjson.js";
import { ValueError, isInputError, osErrorText } from "./py.js";

const errText = (e) => (e?.code && typeof e.code === "string" && /^E[A-Z]+$/.test(e.code) ? osErrorText(e) : e.message);

export function tracePreCommand(args, io) {
  let report, selected;
  try {
    if (args.proc !== null && args.proc < 0) throw new ValueError("--proc must be non-negative");
    if (args.limit < 0) throw new ValueError("--limit must be non-negative");
    const [events, ignored] = parsePreTrace(readTraceText(args.trace));
    selected = events.filter((e) => args.proc === null || e.proc === args.proc);
    if (args.against) {
      const [candidate] = parsePreTrace(readTraceText(args.against));
      report = comparePreTraces(selected, candidate.filter((e) => args.proc === null || e.proc === args.proc));
    } else {
      report = preReport(events, { proc: args.proc });
      report.ignored_diagnostic_lines = ignored.length;
    }
  } catch (e) {
    if (!isInputError(e) && !(e instanceof SyntaxError)) throw e;
    io.eprint(`error: ${errText(e)}`);
    return 2;
  }
  if (args.json) io.print(dumps(report));
  else if (args.against) {
    io.print(`PRE diff: ${report.difference_count} decision(s) differ`);
    for (const d of report.differences.slice(0, args.limit)) io.print(`proc=${d.proc} block=${d.block} expression=${d.expression} changed=${d.changed.join(",")}`);
  } else {
    io.print(`PRE: ${report.event_count} decision(s)`);
    for (const e of report.events.slice(0, args.limit)) io.print(`proc=${e.proc} block=${e.block} line=${e.line} expression=${e.expression} decision=${e.decision} reason=${e.reason}`);
    io.print(`proof: ${report.proof}`);
  }
  return selected.length ? 0 : 1;
}

export function instrumentPreCommand(args, io) {
  let report, outputPath;
  try {
    const sourcePath = resolvePath(args.input);
    outputPath = resolvePath(args.output);
    if (sourcePath === outputPath) throw new ValueError("PRE input and output must be different paths");
    if (existsSync(outputPath)) throw Object.assign(new Error(`refusing to overwrite output: ${outputPath}`), { plain: true });
    let instrumented;
    [instrumented, report] = instrumentPreSource(readTextUniversal(sourcePath), loadPreProfile(args.profile));
    mkdirSync(path.dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, instrumented, { encoding: "utf8", flag: "wx" });
    report.output = outputPath;
  } catch (e) {
    if (!e.plain && !isInputError(e) && !(e instanceof SyntaxError)) throw e;
    io.eprint(`error: ${e.plain ? e.message : errText(e)}`);
    return 2;
  }
  if (args.json) io.print(dumps(report));
  else {
    io.print(`PRE profile: ${report.injections} injection(s) -> ${outputPath}`);
    io.print("required gates: " + report.calibration_required.join(", "));
  }
  return 0;
}

export const COMMAND_SPECS = [
  {
    path: ["trace-pre"], handler: tracePreCommand, defaults: { report_command: "trace-pre" },
    help: "read PRE and speculative-hoist decision provenance",
    description: "Read stable, procedure-scoped PRE decisions: expression, block, accept/reject outcome, reason, source line, and optional availability/cost.",
    arguments: [
      { dest: "trace" },
      { flags: ["--against"], help: "second trace for identity-aligned diff" },
      { flags: ["--proc"], type: "int" },
      { flags: ["--limit"], type: "int", default: 50 },
      { flags: ["--json"], action: "store_true", help: "emit JSON" },
    ],
  },
  {
    path: ["instrument-pre"], handler: instrumentPreCommand, defaults: { report_command: "instrument-pre" },
    help: "apply a hash-pinned PRE instrumentation profile",
    description: "Apply uniqueness-checked anchors from a project-reviewed profile. The output becomes evidence only after the listed disabled-trace fidelity and positive-control gates pass.",
    arguments: [{ dest: "input" }, { dest: "output" }, { flags: ["--profile"], required: true }, { flags: ["--json"], action: "store_true", help: "emit JSON" }],
  },
];
