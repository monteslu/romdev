// ucode-cli.js - `inspect-ucode` (pass ucode / ucode inspect): retained IDO
// binary Ucode XJP dispatches.
//
// Plain JS ESM + JSDoc.

import { buildUcodeXjpReport } from "./ucode.js";
import { dumps } from "./pyjson.js";
import { isInputError, osErrorText } from "./py.js";

export function ucodeXjpCommand(args, io) {
  let report;
  try { report = buildUcodeXjpReport(args.stream, { expression_limit: args.expression_limit }); } catch (e) {
    if (!isInputError(e)) throw e;
    io.eprint(`error: ${e?.code ? osErrorText(e) : e.message}`);
    return 2;
  }
  if (args.json) { io.print(dumps(report)); return 0; }
  const s = report.stream;
  io.print(`Ucode: ${s.record_count} record(s), ${s.bytes} bytes, sha256=${s.sha256.slice(0, 12)}`);
  io.print(`XJP dispatches: ${report.dispatch_count}`);
  report.dispatches.forEach((d, n) => {
    const x = d.xjp;
    io.print(`XJP ${n + 1}: ${x.offset_hex} ${x.dtype_name} range=${d.lower_bound}..${d.upper_bound} cases=L${d.case_table_label} default=L${d.default_label}`);
    io.print(`  selector (${d.selector_expression_complete ? "complete" : "partial"} postfix slice):`);
    for (const r of d.selector_expression) io.print(`    ${r.offset_hex.padStart(8)} ${r.name.padEnd(6)} ${r.detail}`);
    const targets = d.case_targets;
    if (targets.length) {
      io.print(`  table (${d.case_table_complete ? "complete" : "partial"}, ${targets.length} entries):`);
      for (let start = 0; start < d.cases.length; start += 8) {
        io.print("    " + d.cases.slice(start, start + 8).map((c) => `${c.value}->` + c.target_chain.labels.map((l) => `L${l}`).join("->")).join(", "));
      }
      if (d.trampoline_case_count) io.print(`  trampoline targets: ${d.trampoline_case_count}/${d.cases.length}`);
    } else io.print("  table: not resolved immediately after XJP");
  });
  io.print(`proof: ${report.proof}`);
  return 0;
}

export const COMMAND_SPECS = [{
  path: ["inspect-ucode"], handler: ucodeXjpCommand,
  help: "inspect retained IDO binary Ucode XJP dispatches",
  description: "Statically decode a big-endian IDO binary Ucode stream and report every XJP selector expression, case-table/default labels, range, dense Uclab/Uujp table, and metadata-only jump-trampoline chains. This command does not run a compiler.",
  arguments: [
    { dest: "stream", help: "retained IDO binary Ucode input (UGEN positional input, not -temp)" },
    { flags: ["--expression-limit"], type: "int", default: 64, help: "maximum records searched backward for each selector (default: 64)" },
    { flags: ["--json"], action: "store_true", help: "emit JSON" },
  ],
}];
