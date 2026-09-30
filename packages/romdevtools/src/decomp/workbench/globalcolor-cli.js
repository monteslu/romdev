// globalcolor-cli.js - `trace globalcolor`: rank live ranges and report the
// allocator's color/split decisions from an instrumented uopt trace, joined
// per web with costs, interference and formation lineage.
//
// Plain JS ESM + JSDoc.

import { COLOR_REGISTERS, colorForRegister, optionalInteger, parseGlobalcolorTrace, registerForColor, formatG } from "./globalcolor.js";
import { readTraceText } from "./trace-source.js";
import { dumps } from "./pyjson.js";
import { sorted, strRepr, floatRepr, isInputError, osErrorText } from "./py.js";

/** Render a selected color without producing user-facing `cNone`. */
export function allocatorColorLabel(color) {
  if (color === null || color === undefined) return "-";
  return `c${color}(${registerForColor(color) || "-"})`;
}

/** The machine register for a recorded color, in parentheses. */
export function decodedColor(cost) {
  const register = cost.reg || registerForColor(optionalInteger(cost.color ?? null));
  return register ? `(${register})` : "";
}

/** Explain an empty `--lineage-table` result instead of returning silence. */
export function lineageNotes(report, lineage, { requested }) {
  if (!requested.size || lineage.length) return [];
  const known = report.webdetailTables();
  const present = sorted([...requested].filter((v) => known.has(v)));
  const notes = [];
  if (present.length) {
    notes.push(`note: table ${present.join(", ")} appears on webdetail records in this trace, `
      + "but it carries no formation records for it.");
  }
  notes.push("note: lineage_range/lineage_member are opt-in at capture time. "
    + "Re-capture with CDX_LINEAGE_TABLES naming the table(s); "
    + "CDX_DETAIL_WEB alone does not emit them.");
  if (!present.length && known.size) {
    notes.push("note: webdetail tables present in this trace: " + sorted([...known]).slice(0, 12).join(", "));
  }
  return notes;
}

/** str() of a serialized float field (number, "nan"/"inf" text, or None). */
const floatText = (v) => (v === null || v === undefined ? "None" : typeof v === "number" ? floatRepr(v) : String(v));
const g = (o, k, d) => (Object.prototype.hasOwnProperty.call(o, k) ? o[k] : d);

export async function traceGlobalcolorCommand(args, io, ctx) {
  if (args.web !== null && args.proc === null) {
    io.eprint("error: --web requires --proc so the allocator lookup is unambiguous");
    return 2;
  }
  if (args.lineage_table.length && args.proc === null) {
    io.eprint("error: --lineage-table requires --proc so formation records are not mixed across procedures");
    return 2;
  }
  let desiredColor = null;
  if (args.desired_register !== null) {
    if (args.web === null || args.proc === null) {
      io.eprint("error: --desired-register requires --proc and --web");
      return 2;
    }
    desiredColor = colorForRegister(args.desired_register);
    if (desiredColor === null) {
      const known = sorted([...new Set(COLOR_REGISTERS.values())]).join(", ");
      io.eprint(`error: unknown allocator register ${strRepr(args.desired_register)}; known registers: ${known}`);
      return 2;
    }
  }
  let report;
  try {
    report = parseGlobalcolorTrace(readTraceText(ctx.resolve(args.trace), { warn: (n) => io.eprint(`warning: ${n}`) }));
  } catch (e) {
    if (!isInputError(e)) throw e;
    io.eprint(`error: ${e.code ? osErrorText(e) : e.message}`);
    return 2;
  }
  const selected = args.proc !== null ? [] : report.ranked({ dtype: args.dtype, limit: args.top });
  const lineageOnly = args.lineage_table.length > 0 && args.web === null && args.dtype === null;
  const allocatorWebs = lineageOnly ? [] : report.allocatorWebs({ proc: args.proc, web: args.web, dtype: args.dtype, limit: args.top });
  const decisions = lineageOnly ? [] : report.decisionsFor(args.proc, { web: args.web });
  const lineageTables = new Set(args.lineage_table);
  if (args.web !== null) {
    for (const item of allocatorWebs) {
      const table = optionalInteger(item.detail.table ?? null);
      if (table !== null) lineageTables.add(table);
    }
  }
  const lineage = report.lineageFor(args.proc, { tables: lineageTables.size ? lineageTables : null });
  const notes = lineageNotes(report, lineage, { requested: new Set(args.lineage_table) });
  let lookupError = null;
  if (args.web !== null && !allocatorWebs.length) {
    const sameWeb = report.allocatorWebs({ proc: args.proc, web: args.web });
    let suffix;
    if (sameWeb.length && args.dtype !== null) {
      const recorded = sorted([...new Set(sameWeb.map((i) => (i.dtype !== null ? String(i.dtype) : "unknown")))]);
      suffix = ` web exists but does not match dtype=${args.dtype}; recorded dtype(s): ${recorded.join(", ")}`;
    } else {
      const availableWebs = sorted([...new Set(report.allocatorWebs({ proc: args.proc }).map((i) => i.web))]);
      suffix = availableWebs.length ? " available web(s): " + availableWebs.join(", ") : " no allocator decisions were recorded for that procedure";
    }
    lookupError = `no allocator decision matched proc=${args.proc} web=${args.web};${suffix}`;
  } else if (args.proc !== null && !allocatorWebs.length && !decisions.length && !lineage.length) {
    const procs = sorted([...new Set(report.allocatorWebs().map((i) => i.proc))]);
    const suffix = procs.length ? " available procedure(s): " + procs.join(", ") : " no allocator decisions were recorded";
    lookupError = `no allocator data matched proc=${args.proc};${suffix}`;
  }
  if (args.json) {
    io.print(dumps({
      error: lookupError,
      filters: { desired_register: args.desired_register, dtype: args.dtype, proc: args.proc, top: args.top, web: args.web },
      legacy_live_range_capture: report.live_ranges.size ? "present" : "not-captured",
      live_ranges: selected.map((i) => i.asDict()),
      allocator_webs: allocatorWebs.map((i) => i.asDict()),
      lineage: lineage.map((i) => i.asDict()),
      color_barriers: desiredColor !== null ? allocatorWebs.map((i) => i.colorBarrier(desiredColor)) : [],
      decisions: decisions.map((i) => i.asDict()),
      unparsed_diagnostic_lines: report.unparsed_diagnostic_lines,
    }));
  } else {
    if (lookupError) {
      io.eprint(`error: ${lookupError}`);
      for (const note of notes) io.print(note);
      if (notes.length) io.print("lineage=0");
      return 1;
    }
    for (const item of selected) {
      const costs = sorted(item.eligible_costs, (c) => c.cost);
      const best = costs.length ? `r${costs[0].register}:${formatG(costs[0].cost)}` : "-";
      io.print(`bitpos=${String(item.bitpos).padStart(5)} dtype=${String(item.dtype).padStart(2)} `
        + `weight=${String(item.weight).padStart(5)} adjsave=${formatG(item.adjusted_save, 11)} `
        + `total=${formatG(item.total_save, 13)} best=${best}`);
    }
    for (const w of allocatorWebs) {
      const detail = w.detail;
      const costText = w.color_costs.map((c) => `c${g(c, "color", "?")}${decodedColor(c)}:${g(c, "cost", "?")}`).join(",");
      io.print(`proc=${w.proc} web=${w.web} phase=${w.phase} force_key=${w.force_key} `
        + `dtype=${g(detail, "dtype", "?")} save=${g(w.fields, "save", "?")} nocs=${g(w.fields, "nocs", "?")} `
        + `natural=${allocatorColorLabel(w.natural_color)} assigned=${allocatorColorLabel(w.assigned_color)} `
        + `force=${g(w.fields, "forced", "-2")} decision=${g(w.fields, "decision", "?")} `
        + `bb=${g(detail, "bb", "?")} line=${g(detail, "line", "?")} costs=${costText || "-"}\n  ${w.explanation}`);
      if (desiredColor !== null) {
        const b = w.colorBarrier(desiredColor);
        io.print("  barrier: "
          + `desired=c${b.desired_color}(${b.desired_register || "-"}) cost=${floatText(b.desired_cost)} `
          + `natural=${allocatorColorLabel(b.natural_color)} cost=${floatText(b.natural_cost)} gap=${floatText(b.cost_gap)} `
          + `forbidden=${b.desired_forbidden ? "yes" : "no"} ineligible=${b.desired_ineligible ? "yes" : "no"}`);
        io.print(`    ${b.advice}`);
        for (const blocker of b.blocking_neighbors) {
          const bd = blocker.detail;
          io.print(`    blocker: ${blocker.force_key === null ? "None" : blocker.force_key} `
            + `assigned=c${blocker.assigned_color}(${blocker.assigned_register || "-"}) `
            + `dtype=${g(bd, "dtype", "?")} type=${g(bd, "type", "?")} table=${g(bd, "table", "?")}`);
        }
        io.print(`    ${b.claim_boundary}`);
      }
    }
    for (const item of lineage) {
      const f = item.fields;
      if (item.phase === "lineage_range") {
        io.print(`lineage range: proc=${g(f, "proc", "?")} event=${g(f, "event", "?")} table=${g(f, "table", "?")} `
          + `chain=${g(f, "chain", "?")} type=${g(f, "type", "?")} dtype=${g(f, "dtype", "?")}`);
      } else {
        io.print(`lineage member: proc=${g(f, "proc", "?")} event=${g(f, "event", "?")} table=${g(f, "table", "?")} `
          + `chain=${g(f, "chain", "?")} bb=${g(f, "bb", "?")} line=${g(f, "line", "?")} flags=${g(f, "flags", "?")}`);
      }
    }
    const status = report.live_ranges.size ? `legacy-live-ranges=${selected.length}/${report.live_ranges.size}`
      : "legacy-live-ranges=not-captured(CSAVE/CUP absent)";
    io.print(`${status} allocator-webs=${allocatorWebs.length} decisions=${decisions.length} `
      + `lineage=${lineage.length} unparsed=${report.unparsed_diagnostic_lines.length}`);
    for (const note of notes) io.print(note);
  }
  if (lookupError) return 1;
  return selected.length || allocatorWebs.length || decisions.length || lineage.length ? 0 : 1;
}

export const COMMAND_SPECS = [
  {
    path: ["trace-globalcolor"], handler: traceGlobalcolorCommand,
    help: "summarize uopt CSAVE/CUP and CDX globalcolor traces",
    description: "Rank live ranges and report color/split decisions.",
    arguments: [
      { dest: "trace", help: "captured compiler log" },
      { flags: ["--proc"], type: "int", help: "include only CDX decisions from this procedure" },
      { flags: ["--desired-register"], help: "measure the cost/interference barrier to this register; requires --proc and --web" },
      { flags: ["--web"], type: "int", help: "inspect one allocator web; pair with --proc for an unambiguous lookup" },
      { flags: ["--lineage-table"], type: "int", action: "append", default: [], help: "show pre-globalcolor formation for this ICHAIN table; repeat for more tables and pair with --proc" },
      { flags: ["--dtype"], type: "int", help: "include only this data type" },
      { flags: ["--top"], type: "int", default: 20, help: "maximum live ranges to show" },
      { flags: ["--json"], action: "store_true", help: "emit JSON" },
    ],
  },
];
