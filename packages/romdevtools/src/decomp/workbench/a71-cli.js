// a71-cli.js - `trace a71`: inspect or diff an IDO 7.1 A71 allocator trace.
//
// Plain JS ESM + JSDoc.

import { compareA71Traces, parseA71Trace } from "./a71.js";
import { readTraceText } from "./trace-source.js";
import { formatG } from "./globalcolor.js";
import { dumps } from "./pyjson.js";
import { hex, isInputError, osErrorText, floatRepr } from "./py.js";

const colorText = (r) => `c${r.color}${r.register ? ` (${r.register})` : ""}`;
const recordLine = (marker, r) => `${marker} p${r.phase} w${r.web} sym=${r.symbol} class=${r.register_class} priority=${formatG(r.priority)} `
  + `[${hex(r.priority_bits, 8)}] color=${colorText(r)} forbidden=${r.forbidden_colors.map((c) => `c${c}`).join(",") || "none"}`;
const dictRepr = (d) => `{${[...d.entries()].map(([k, v]) => `${k}: ${v}`).join(", ")}}`;
const valueText = (display, v) => (v === null ? "None" : display === "priority" && typeof v === "number" ? floatRepr(v) : String(v));

export async function traceA71Command(args, io, ctx) {
  const warn = (n) => io.eprint(`warning: ${n}`);
  let baseline, candidate = null;
  try {
    baseline = parseA71Trace(readTraceText(ctx.resolve(args.trace), { warn }));
    if (args.against) candidate = parseA71Trace(readTraceText(ctx.resolve(args.against), { warn }));
  } catch (e) {
    if (!isInputError(e)) throw e;
    io.eprint(`error: ${e.code ? osErrorText(e) : e.message}`);
    return 2;
  }
  const filters = { phase: args.phase, web: args.web, register_class: args.register_class };
  const selected = baseline.selected(filters);
  if (candidate === null) {
    const report = { format: "ido-7.1-a71-final-color", filters, summary: baseline.summary(selected), records: selected.map((r) => r.asDict()),
      field_warning: "Historical refs/defs fields read invalid recovered-source offsets and are ignored." };
    if (args.json) io.print(dumps(report));
    else {
      const s = report.summary;
      io.print(`A71: ${s.record_count} final-color record(s); phases=${dictRepr(s.phase_counts)} classes=${dictRepr(s.class_counts)}`);
      for (const r of selected.slice(0, args.limit)) io.print(recordLine(" ", r));
      if (selected.length > args.limit) io.print(`... ${selected.length - args.limit} more record(s); use --limit`);
      io.print(`warning: ${report.field_warning}`);
    }
    return selected.length ? 0 : 1;
  }
  const report = compareA71Traces(baseline, candidate, filters);
  if (args.json) { io.print(dumps(report)); return 0; }
  io.print(`A71 diff: baseline=${report.baseline_summary.record_count} candidate=${report.candidate_summary.record_count} changed_phase_webs=${report.difference_count}`);
  for (const change of report.changes.slice(0, args.limit)) {
    const find = (trace) => trace.records.find((r) => r.phase === change.phase && r.web === change.web);
    if (change.baseline === null) io.print(recordLine("+", find(candidate)));
    else if (change.candidate === null) io.print(recordLine("-", find(baseline)));
    else {
      const deltas = change.changed_fields.map((f) => {
        const display = f === "priority_bits" ? "priority" : f;
        return `${display}:${valueText(display, change.baseline[display])}->${valueText(display, change.candidate[display])}`;
      });
      io.print(`~ p${change.phase} w${change.web} ` + deltas.join(" "));
    }
  }
  if (report.changes.length > args.limit) io.print(`... ${report.changes.length - args.limit} more change(s); use --limit`);
  io.print(`warning: ${report.alignment_warning}`);
  io.print(`warning: ${report.field_warning}`);
  return 0;
}

export const COMMAND_SPECS = [
  {
    path: ["trace-a71"], handler: traceA71Command, help: "inspect or diff an IDO 7.1 A71 allocator trace",
    description: "Statically parse the compact [A71] final-color stream, decoding priority bits and masks. With --against, compare run-local "
      + "phase/web keys without claiming semantic identity.",
    arguments: [
      { dest: "trace", help: "filtered .a71 trace or mixed compiler log" },
      { flags: ["--against"], help: "candidate A71 trace to compare" },
      { flags: ["--phase"], type: "int", choices: [1, 2], help: "only this phase" },
      { flags: ["--web"], type: "int", help: "only this run-local web number" },
      { flags: ["--class"], type: "int", choices: [1, 2], dest: "register_class", help: "only this register class" },
      { flags: ["--limit"], type: "int", default: 50, help: "maximum rows shown (default: 50)" },
      { flags: ["--json"], action: "store_true", help: "emit JSON" },
    ],
  },
];
