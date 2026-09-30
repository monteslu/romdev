// slots-cli.js - `slots`: the stack-slot traffic census.
//
// Plain JS ESM + JSDoc.

import * as O from "./cli-options.js";
import { parseRowRange } from "./cascade.js";
import { CSourceError } from "./csource.js";
import { loadDumpRows, loadObjectRows } from "./row-source.js";
import { dumpObject, trimFunctionPadding } from "./objdump.js";
import { slotReport, volatileProbeSources } from "./slots.js";
import { emitLines } from "./terminal.js";
import { dumps } from "./pyjson.js";
import { hex, isInputError, osErrorText } from "./py.js";
import { isReportedError } from "./py-extra.js";

export async function slotsCommand(args, io, ctx) {
  let report, probe = null;
  try {
    const rows = args.rows ? parseRowRange(args.rows) : null;
    let instructions;
    if (args.dumps) instructions = loadDumpRows(ctx.resolve(args.object), { symbol: args.symbol });
    else {
      let cache = null;
      if (args.disassembly_cache) { const { DisassemblyCache } = await import("./dis-cache.js"); cache = new DisassemblyCache({ directory: args.disassembly_cache }); }
      if (cache !== null) instructions = loadObjectRows(args.object, { objdump: args.objdump, symbol: args.symbol, section: args.section, cache });
      else instructions = trimFunctionPadding([...dumpObject(args.object, { objdump: args.objdump, symbol: args.symbol, section: args.section, cwd: ctx.cwd, env: ctx.env })[1]]);
    }
    report = slotReport(instructions, { label: args.object, rows, minimum: args.min_rows });
    if (args.volatile_probe) {
      if (!args.source) throw new CSourceError("--volatile-probe needs --source SOURCE: it writes one variant of that file per local, each with that local made volatile so the compiler must keep it in memory");
      probe = volatileProbeSources(args.source, { directory: args.volatile_probe, variables: [...args.variable], cwd: ctx.cwd });
    }
  } catch (e) {
    if (!(isInputError(e) || isReportedError(e))) throw e;
    io.eprint(`error: ${e.code ? osErrorText(e) : e.message}`);
    return 2;
  }
  if (args.json) {
    const payload = { ...report };
    if (probe !== null) payload.volatile_probe = probe;
    io.print(dumps(payload));
    return 0;
  }
  const frame = report.frame;
  const lines = [
    `stack slots: ${report.object}  ${report.slot_count} slot(s) over rows ${report.rows[0]}..${report.rows[1]}  ${report.touched_rows} touching row(s)` + (frame !== null ? `  frame=${frame}` : ""),
    "",
    frame !== null ? " slot     frameoff    rows  ld   st   addr  widths   registers" : " slot     rows  ld   st   addr  widths   registers",
  ];
  const l = (v, n) => String(v).padEnd(n);
  for (const item of report.slots) {
    const widths = item.widths.map(String).join(",") || "-";
    let registers = item.registers.slice(0, args.registers).join(",") || "-";
    if (item.registers.length > args.registers) registers += ",...";
    const flag = item.punned ? "  PUN" : "";
    const offset = item.frame_offset;
    const joint = offset !== null && offset < 0 ? `${hex((offset >>> 0), 10, { prefix: true })} ` : offset !== null ? `${l(offset, 10)} ` : "";
    lines.push(` ${l(item.offset, 8)} ${joint}${l(item.total, 5)} ${l(item.loads, 4)} ${l(item.stores, 4)} ${l(item.address_taken, 5)} ${l(widths, 8)} ${registers}${flag}`);
  }
  if (report.slots.some((i) => i.punned)) {
    lines.push("", "PUN: more than one access width reaches this offset. That is one storage location under two spellings, not two variables -- and the allocator keys webs on storage, not on the C name.");
  }
  if (report.slots.length) {
    lines.push("", `cheapest slots to disturb: ${report.cheapest.map((i) => `${i.offset}(${i.total} row(s))`).join(", ")}`,
      "A donor's price is the number of rows that touch its slot; this is that price, without a build.");
  }
  if (frame !== null) {
    lines.push("", `slot is sp-relative, as the rows spell it; frameoff is the same storage as the allocator trace keys it -- slot + frame (${frame}). \`decomp-workbench trace-cascade LOG --frame-offset FRAMEOFF\` reads that site's decision.`);
  }
  lines.push("", `reading: ${report.reading}`);
  if (probe !== null) lines.push("", `volatile probe: wrote ${probe.count} variant source(s) to ${probe.directory}`, `  next: ${probe.next}`);
  emitLines(io, lines, { width: args.width, pager: args.pager });
  return 0;
}

const DESCRIPTION = "Count what an object's rows do to each sp-relative stack slot: loads, stores, "
  + "address-takes, the access widths that reach it and the registers that "
  + "carry it. Two campaign questions reduce to this one census -- what a "
  + "fusion donor costs (the rows that touch its slot, which one campaign "
  + "spent a whole sweep answering by construction) and whether a slot is one "
  + "variable or a pun. It reports what the rows do; it does not claim which "
  + "C local lives at a slot, because nothing in an object says so. Each slot "
  + "is printed both ways -- sp-relative as the rows spell it, and as the "
  + "frame offset `trace-cascade` keys a site by -- because 1184 and "
  + "0xfffffdf8 are the same storage and only one of them is a command "
  + "argument.";

export const COMMAND_SPECS = [
  { path: ["slots"], handler: slotsCommand, help: "count the loads, stores and address-takes at each stack slot", description: DESCRIPTION,
    epilog: "example: decomp-workbench slots target.o --rows 1900..2200", defaults: { report_command: "slots" },
    arguments: [
      { dest: "object", help: "object to read (or dump text with --dumps)" },
      { flags: ["--rows"], metavar: "LO..HI", help: "restrict the census to these rows (inclusive)" },
      { flags: ["--min-rows"], type: "int", default: 1, metavar: "N", help: "hide slots touched fewer than N times (default: 1)" },
      { flags: ["--registers"], type: "int", default: 4, metavar: "N", help: "registers to name per slot before eliding (default: 4)" },
      { flags: ["--source"], metavar: "SOURCE", help: "the C source, for --volatile-probe" },
      { flags: ["--volatile-probe"], metavar: "DIR", help: "also write one variant of --source per local, that local made `volatile` so the compiler must keep it in memory: build each and re-run `slots` to learn which slot the compiler gave it" },
      { flags: ["--variable"], action: "append", default: [], metavar: "NAME", help: "restrict --volatile-probe to these locals; repeatable" },
      { flags: ["--dumps"], action: "store_true", help: "read retained `objdump -d -r` text rather than an object" },
      { flags: ["--section"], default: ".text", help: "object section (default: .text)" },
      { flags: ["--objdump"], help: "GNU-compatible MIPS objdump; auto-detected when omitted" },
      { flags: ["--disassembly-cache"], metavar: "DIR", help: "reuse disassemblies from this directory across runs" },
      ...O.symbolArgument({ help: "read only this exact symbol" }),
      { flags: ["--json"], action: "store_true", help: "emit JSON" },
      ...O.explainKeysArgument(),
      ...O.terminalArguments(),
    ] },
];
