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
