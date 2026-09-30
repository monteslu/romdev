// scheduler-cli.js - `trace scheduler`: stable scheduler traces, native
// IDO 5.3 `as1 -R` traces, and the cycle-aligned diff of two of them.
//
// Plain JS ESM + JSDoc.

import { writeFileSync } from "node:fs";
import { parseAs1ReorganizeTrace, toDkwbRecords } from "./as1-reorganize.js";
import { compareSchedulerTraces, parseSchedulerTrace, schedulerReport } from "./scheduler.js";
import { readTraceText } from "./trace-source.js";
import { dumps } from "./pyjson.js";
import { ValueError, isInputError, osErrorText } from "./py.js";

/** What the native `as1 -R` reader can and cannot establish. */
export const AS1_R_PROOF = "Read from IDO 5.3 `as1 -R` (cc -Wa,-R), which is print-only: the traced "
  + "object is byte-identical to the untraced one. `tie=` is computed here "
  + "from the losing candidates, which the schema has no field for. The key "
  + "chain is evaluated without node->addr, which the record does not carry "
  + "per candidate; where addr differs between candidates the named key is "
  + "the next one down. Key order: start-time (lower wins), besttime, "
  + "aftercycles, latency (higher wins), then lineno (lower wins).";

function readSchedulerTrace(file, { fromAs1R, proc, warn }) {
  const text = readTraceText(file, { warn });
  if (!fromAs1R) return parseSchedulerTrace(text);
  const [, events, ignored] = parseAs1ReorganizeTrace(text, { proc });
  if (!events.length) {
    throw new ValueError(`${file} carries no \`Picking node\` selection with a candidate `
      + "list. Capture both streams -- `cc -Wa,-R -c source.c "
      + ">sched.log 2>&1` -- because which one carries the trace is a "
      + "property of the assembler build: IDO 5.3's as1 writes it to "
      + "stdout, and a `2>sched.log` redirect then captures a one-line "
      + "cfe warning and nothing else.");
  }
  return [events, ignored];
}

export async function traceSchedulerCommand(args, io, ctx) {
  const warn = (note) => io.eprint(`warning: ${note}`);
  let report, selected;
  try {
    for (const name of ["proc", "block", "limit"]) {
      const v = args[name];
      if (v !== null && v !== undefined && v < 0) throw new ValueError(`--${name} must be non-negative`);
    }
    const rel = (p) => ctx.resolve(p);
    const [events, ignored] = readSchedulerTrace(rel(args.trace), { fromAs1R: args.from_as1_r, proc: args.proc || 0, warn });
    const keep = (e) => (args.proc === null || e.proc === args.proc) && (args.block === null || e.block === args.block);
    selected = events.filter(keep);
    if (args.against) {
      const [candidate] = readSchedulerTrace(rel(args.against), { fromAs1R: args.from_as1_r, proc: args.proc || 0, warn });
      report = compareSchedulerTraces(selected, candidate.filter(keep));
    } else {
      report = schedulerReport(events, { proc: args.proc, block: args.block });
      report.ignored_diagnostic_lines = ignored.length;
    }
    if (args.from_as1_r) report.proof = `${AS1_R_PROOF} ${report.proof}`;
    if (args.emit) {
      writeFileSync(rel(args.emit), toDkwbRecords(events), "utf8");
      report.emitted = args.emit;
    }
  } catch (e) {
    if (!isInputError(e)) throw e;
    io.eprint(`error: ${e.code ? osErrorText(e) : e.message}`);
    return 2;
  }
  if (args.json) {
    io.print(dumps(report));
  } else {
    if (args.against) {
      io.print(`scheduler diff: ${report.difference_count} decision(s) differ across ${report.target_events} / ${report.candidate_events} events`);
      for (const item of report.differences.slice(0, args.limit)) {
        io.print(`proc=${item.proc} block=${item.block} cycle=${item.cycle} changed=${item.changed.join(",")}`);
      }
    } else {
      io.print(`scheduler: ${report.event_count} event(s), ${report.ready_set_ties} ready-set tie(s), provenance=${report.provenance_complete}/${report.event_count}`);
      for (const e of report.events.slice(0, args.limit)) {
        io.print(`proc=${e.proc} block=${e.block} cycle=${e.cycle} word=${e.word} opcode=${e.opcode} line=${e.line} `
          + `ready=${e.ready} chosen=${e.chosen} tie=${e.tie}`
          + (e.emitted_slot !== null && e.emitted_slot !== undefined ? ` slot=${e.emitted_slot} statement=${e.source_statement === null ? "None" : e.source_statement} reason=${e.reason === null ? "None" : e.reason}` : ""));
      }
    }
    io.print(`proof: ${report.proof}`);
  }
  return selected.length ? 0 : 1;
}

// instrument-scheduler and trace-emit

export async function instrumentSchedulerCommand(args, io, ctx) {
  const { existsSync, mkdirSync, readFileSync: rf, writeFileSync: wf } = await import("node:fs");
  const path = await import("node:path");
  const { instrumentSchedulerSource, loadSchedulerProfile } = await import("./scheduler.js");
  let report, outputPath;
  try {
    const expand = (p) => (p.startsWith("~/") ? (process.env.HOME ?? "") + p.slice(1) : p);
    const inputPath = ctx.resolve(expand(args.input));
    outputPath = ctx.resolve(expand(args.output));
    if (inputPath === outputPath) throw new ValueError("scheduler input and output must be different paths");
    if (existsSync(outputPath)) throw new ValueError(`refusing to overwrite output: ${outputPath}`);
    const source = rf(inputPath, "utf8");
    const profile = loadSchedulerProfile(ctx.resolve(args.profile));
    let instrumented;
    [instrumented, report] = instrumentSchedulerSource(source, profile);
    mkdirSync(path.dirname(outputPath), { recursive: true });
    wf(outputPath, instrumented, { flag: "wx" });
    report.output = outputPath;
  } catch (e) {
    if (!isInputError(e) && !(e instanceof SyntaxError)) throw e;
    io.eprint(`error: ${e.code ? osErrorText(e) : e.message}`);
    return 2;
  }
  if (args.json) io.print(dumps(report));
  else {
    io.print(`scheduler profile: ${report.injections} injection(s) -> ${outputPath}`);
    io.print("required gates: " + report.calibration_required.join(", "));
  }
  return 0;
}

export async function traceEmitCommand(args, io, ctx) {
  const { parseEmitTrace, emitReport, formatEmitReport } = await import("./emit-provenance.js");
  let report;
  try {
    for (const name of ["proc", "block"]) if (args[name] !== null && args[name] < 0) throw new ValueError(`--${name} must be non-negative`);
    const text = readTraceText(ctx.resolve(args.trace), { warn: (n) => io.eprint(`warning: ${n}`) });
    const [events, ignored] = parseEmitTrace(text);
    report = emitReport(events, { proc: args.proc, block: args.block });
    report.ignored_diagnostic_lines = ignored.length;
  } catch (e) {
    if (!isInputError(e)) throw e;
    io.eprint(`error: ${e.code ? osErrorText(e) : e.message}`);
    return 2;
  }
  if (args.json) io.print(dumps(report));
  else io.print(formatEmitReport(report));
  return 0;
}

export const COMMAND_SPECS = [
  {
    path: ["trace-scheduler"], handler: traceSchedulerCommand,
    help: "read stable named as1 scheduler selection records",
    description: "Read DKWB-SCHED-V1 records with procedure, block, cycle, word, opcode, source line, ready-set size, chosen node, and tie-break. For IDO 5.3, reach for --from-as1-r first: the assembler ships its own selection trace behind `cc -Wa,-R`, no patched compiler involved, and the traced object is byte-identical to the untraced one.",
    epilog: "example: cc -Wa,-R -c source.c >sched.log 2>&1 && decomp-workbench trace-scheduler sched.log --from-as1-r --block 429\n\nCapture both streams: IDO 5.3's as1 prints the -R trace on stdout, other assembler builds may use stderr, and `>` alone silently produces an empty log on the ones that do.",
    arguments: [
      { dest: "trace" },
      { flags: ["--against"], help: "second trace for cycle-aligned diff" },
      { flags: ["--from-as1-r"], action: "store_true", help: "the input is a native IDO 5.3 `cc -Wa,-R` trace rather than DKWB-SCHED-V1; the deciding key is computed from the losing candidates, which the schema cannot carry" },
      { flags: ["--emit"], metavar: "PATH", help: "also write the selections as DKWB-SCHED-V1 records" },
      { flags: ["--proc"], type: "int" },
      { flags: ["--block"], type: "int" },
      { flags: ["--limit"], type: "int", default: 50 },
      { flags: ["--json"], action: "store_true", help: "emit JSON" },
    ],
  },
  {
    path: ["trace-emit"], handler: traceEmitCommand,
    help: "read ugen DKWB-EMIT-V1 emit-order provenance records",
    description: "Print, per basic block, the order ugen wrote instruction records into the ibuffer and the source line each one carries into the assembler's scheduler. This is the scheduler's *input*: ugen has no ready list, no dependence DAG and no delay-slot filler, so slot, priority and delay-slot occupancy come from `trace-scheduler --from-as1-r`, not from here. What this answers is which source line each of two independent ready nodes carries -- the one scheduler key with a source lever attached.",
    epilog: "example: DKWB_UGEN_SCHED=1 cc -c source.c 2>emit.log && decomp-workbench trace-emit emit.log --proc 0 --block 0\n\nProduce the log with an ugen instrumented by `instrument-ugen --emit-provenance`.",
    arguments: [
      { dest: "trace" },
      { flags: ["--proc"], type: "int" },
      { flags: ["--block"], type: "int" },
      { flags: ["--json"], action: "store_true", help: "emit JSON" },
    ],
  },
  {
    path: ["instrument-scheduler"], handler: instrumentSchedulerCommand,
    help: "apply a hash-pinned external scheduler instrumentation profile",
    description: "Apply exact source anchors from a user-supplied profile. The output is not supported evidence until every reported fidelity gate passes. Era note: for IDO 5.3 this is usually unnecessary. `as1` already carries a richer selection trace behind `cc -Wa,-R`, with no patch and therefore no profile to pin -- read it with `trace-scheduler --from-as1-r`. Patch only when the era's assembler has no built-in trace, or when you need a field the built-in one does not print.",
    arguments: [
      { dest: "input" }, { dest: "output" },
      { flags: ["--profile"], required: true },
      { flags: ["--json"], action: "store_true", help: "emit JSON" },
    ],
  },
];
