// trace-cli.js - `trace-summary`, `trace-alias` and `trace-fifo` (trace
// summary / alias / fifo): read instrumented ugen/uopt diagnostic traces.
//
// Plain JS ESM + JSDoc.

import { readFileSync } from "node:fs";
import { parseTrace, traceSummary, aliasTraceSummary, replayFifo, parseEmissionMap, parseInteger, parseRegister, registerName } from "./trace.js";
import { readTraceText } from "./trace-source.js";
import { dumps } from "./pyjson.js";
import { ValueError, isInputError, osErrorText, strRepr, sum } from "./py.js";

const errText = (e) => (e?.code && typeof e.code === "string" && /^E[A-Z]+$/.test(e.code) ? osErrorText(e) : e.message);
const reportable = (e) => isInputError(e) || e instanceof SyntaxError;

function readEvents(args, io) {
  return parseTrace(readTraceText(args.trace, { warn: (n) => io.eprint(`warning: ${n}`) }));
}

export function traceSummaryCommand(args, io) {
  let events;
  try { events = readEvents(args, io); } catch (e) { if (!reportable(e)) throw e; io.eprint(`error: ${errText(e)}`); return 2; }
  const summary = traceSummary(events);
  if (args.json) io.print(dumps(summary));
  else {
    io.print(`events: ${summary.events}`);
    for (const [action, count] of Object.entries(summary.actions)) io.print(`  ${action.padEnd(18)} ${count}`);
    if (Object.keys(summary.registers).length) io.print("registers: " + Object.entries(summary.registers).map(([n, c]) => `${n}=${c}`).join(" "));
  }
  return events.length ? 0 : 1;
}

export function traceAliasCommand(args, io) {
  let events;
  try { events = readEvents(args, io); } catch (e) { if (!reportable(e)) throw e; io.eprint(`error: ${errText(e)}`); return 2; }
  const report = aliasTraceSummary(events);
  if (args.json) io.print(dumps(report));
  else {
    io.print(`base-events=${report.base_events} alias-queries=${report.alias_queries}`);
    for (const [label, values] of [["base paths", report.base_paths], ["base types", report.base_types], ["results", report.query_results], ["left types", report.left_types], ["right types", report.right_types]]) {
      if (Object.keys(values).length) io.print(`${label}: ` + Object.entries(values).map(([n, c]) => `${n}=${c}`).join(" "));
    }
    if (args.show_queries) {
      for (const e of events) {
        if (e.action !== "alias-query") continue;
        const left = e.fields.left_type ?? "?", right = e.fields.right_type ?? "?", result = e.fields.result ?? "?";
        const reg = e.register !== null ? registerName(e.register) : "-";
        io.print(`line=${String(e.index).padEnd(5)} reg=${reg.padStart(3)} ${left.padStart(8)} \u2194 ${right.padEnd(8)} ${result}`);
      }
    }
  }
  return report.events ? 0 : 1;
}

function parseRegisterList(value) {
  if (value === null || value === undefined) return null;
  return value.split(",").filter((x) => x.trim()).map(parseRegister);
}

export async function traceFifoCommand(args, io) {
  let report, identity = null;
  try {
    const events = readEvents(args, io);
    let selectedProcedure = args.proc;
    if (selectedProcedure !== null && selectedProcedure < 0) throw new ValueError("--proc must be non-negative");
    if (args.candidate_object && !args.ucode) throw new ValueError("--candidate-object requires --ucode and --symbol");
    if (args.ucode || args.symbol) {
      if (!args.ucode || !args.symbol) throw new ValueError("--ucode and --symbol must be supplied together");
      const { procedureMap, selectProcedure } = await import("./procedure-identity.js");
      identity = await procedureMap(args.ucode, { candidate_object: args.candidate_object });
      const mapped = selectProcedure(identity, args.symbol);
      if (selectedProcedure !== null && selectedProcedure !== mapped) {
        throw new ValueError(`--proc=${selectedProcedure} disagrees with retained Ucode mapping ${strRepr(args.symbol)} to proc=${mapped}`);
      }
      selectedProcedure = mapped;
    }
    const emissionMap = args.emission_map ? parseEmissionMap(JSON.parse(readFileSync(args.emission_map, "utf8"))) : null;
    const initial = parseRegisterList(args.initial);
    const selected = parseRegisterList(args.registers);
    const listAddress = args.list_address ? parseInteger(args.list_address) : null;
    if (args.list_address && listAddress === null) throw new ValueError(`invalid list address: ${strRepr(args.list_address)}`);
    report = replayFifo(events, { initial_queue: initial, registers: selected !== null ? new Set(selected) : null, list_address: listAddress,
      emission_map: emissionMap, procedure: selectedProcedure });
  } catch (e) {
    if (!reportable(e)) throw e;
    io.eprint(`error: ${errText(e)}`);
    return 2;
  }
  if (args.json) {
    const payload = report.asDict();
    if (identity !== null) payload.procedure_identity = identity;
    io.print(dumps(payload));
  } else {
    io.print("initial: " + report.initial_queue.map(registerName).join(" "));
    io.print("allocations: " + report.allocations.map(registerName).join(" "));
    io.print("final: " + report.final_queue.map(registerName).join(" "));
    io.print(`logical values: ${sum(report.logical_events.map((e) => e.action === "allocate"))} max-live=${report.max_live}`);
    const join = report.asDict().emission_join;
    if (join && join.with_emitted_index) {
      io.print(`emission join: emitted=${join.with_emitted_index}/${join.logical_events} rows=${join.with_object_row} source=${join.with_source_line} complete=${join.complete ? "yes" : "no"}`);
      if (join.calibration_required) io.print("note: emitted ordinals are not object rows; pass --emission-map to supply measured calibration");
    }
    for (const v of report.violations) io.eprint(`VIOLATION ${v}`);
    if (args.show_events) {
      for (const e of report.logical_events) {
        const emitted = e.emitted_index !== null ? e.emitted_index : "-";
        const row = e.object_row !== null ? e.object_row : "-";
        io.print(`${e.action.padEnd(8)} v${String(e.value).padEnd(4)} ${registerName(e.register).padStart(3)} emit=${String(emitted).padStart(5)} row=${String(row).padStart(5)} source=${String(e.source_line || "-").padStart(5)} trace=${e.trace_line}`);
        if (e.instruction || e.source_file) io.print(`         ${e.source_file || "?"}:${e.source_line || "?"}  ${e.instruction || "-"}`);
      }
    }
  }
  return args.fail_on_violation && !report.valid ? 1 : 0;
}

export const COMMAND_SPECS = [
  { path: ["trace-summary"], handler: traceSummaryCommand, help: "summarize ugen diagnostic events",
    description: "Count recognized events, actions, registers, and source lines.",
    arguments: [{ dest: "trace", help: "captured compiler log" }, { flags: ["--json"], action: "store_true", help: "emit JSON" }] },
  { path: ["trace-alias"], handler: traceAliasCommand, help: "summarize profiled uopt base-provenance and alias decisions",
    description: "Report base paths, descriptor types, and alias outcomes.",
    arguments: [{ dest: "trace", help: "captured compiler log" }, { flags: ["--show-queries"], action: "store_true", help: "print each alias query" }, { flags: ["--json"], action: "store_true", help: "emit JSON" }] },
  { path: ["trace-fifo"], handler: traceFifoCommand, help: "replay a traced register free list as a FIFO",
    description: "Validate queue order and assign logical value identities.",
    arguments: [
      { dest: "trace", help: "captured compiler log" },
      { flags: ["--initial"], help: "comma-separated initial queue; inferred from leading appends" },
      { flags: ["--registers"], help: "comma-separated register class to include" },
      { flags: ["--list-address"], help: "only include appends for this list" },
      { flags: ["--proc"], type: "int", help: "include exactly one producer-stamped procedure ordinal" },
      { flags: ["--ucode"], help: "retained candidate Ucode used to map --symbol to a procedure ordinal" },
      { flags: ["--symbol"], help: "procedure name carried by --ucode" },
      { flags: ["--candidate-object"], help: "also bind the candidate object hash into the procedure identity receipt" },
      { flags: ["--emission-map"], help: "JSON mapping instrumented emitted indices to object rows and optional source locations" },
      { flags: ["--show-events"], action: "store_true", help: "print the logical event schedule" },
      { flags: ["--json"], action: "store_true", help: "emit JSON" },
      { flags: ["--fail-on-violation"], action: "store_true", help: "return exit 1 when FIFO validation fails" },
    ] },
];
