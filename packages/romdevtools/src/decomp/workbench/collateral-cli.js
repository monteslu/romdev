// collateral-cli.js - `object-collateral`: translation-unit changes hidden by
// a function-only match.
//
// Plain JS ESM + JSDoc.

import { DEFAULT_IGNORES, compareObjectCollateral } from "./collateral.js";
import { dumps } from "./pyjson.js";
import { isInputError, osErrorText } from "./py.js";
import { isReportedError } from "./py-extra.js";

const signed = (n) => (n >= 0 ? `+${n}` : String(n));

export async function collateralCommand(args, io, ctx) {
  let report;
  try {
    report = compareObjectCollateral(args.reference, args.candidate, { symbol: args.symbol, section: args.section, objdump: args.objdump,
      ignore: [...args.ignore_section], timeout: args.timeout, cwd: ctx.cwd, env: ctx.env });
  } catch (e) {
    if (!(isInputError(e) || isReportedError(e))) throw e;
    io.eprint(`error: ${e.code ? osErrorText(e) : e.message}`);
    return 2;
  }
  if (args.json) io.print(dumps(report));
  else {
    io.print(`object collateral: ${report.collateral_detected ? "DETECTED" : "NONE"} classification=${report.classification}`);
    if (report.selected_symbol !== null) io.print(`selected function: ${report.selected_symbol} raw/relocation exact=${report.selected_function_exact ? "yes" : "no"}`);
    for (const item of report.section_changes) io.print(`${item.section}: size-delta=${signed(item.size_delta)} changed=${item.changed.join(",")}`);
    io.print(`tables: relocations=${report.relocations_identical ? "same" : "different"} symbols=${report.symbol_table_identical ? "same" : "different"}`);
    io.print(`proof: ${report.proof}`);
    io.print(`next gate: ${report.next_gate}`);
  }
  return args.fail_on_collateral && report.collateral_detected ? 1 : 0;
}

export const COMMAND_SPECS = [
  { path: ["object-collateral"], handler: collateralCommand, help: "report translation-unit changes hidden by a function-only match",
    description: "Compare section sizes (including zero-fill), section contents, relocations, and symbols. Optionally prove that one selected function is exact while the containing object still changed.",
    defaults: { report_command: "object-collateral" },
    arguments: [
      { dest: "reference" }, { dest: "candidate" },
      { flags: ["--symbol", "--function"], dest: "symbol" },
      { flags: ["--section"], default: ".text" },
      { flags: ["--objdump"] },
      { flags: ["--ignore-section"], action: "append", default: [...DEFAULT_IGNORES], metavar: "GLOB", help: "section glob to exclude; repeatable" },
      { flags: ["--timeout"], type: "float", default: 10.0 },
      { flags: ["--json"], action: "store_true", help: "emit JSON" },
      { flags: ["--fail-on-collateral"], action: "store_true", help: "return exit 1 when any scoped collateral remains" },
    ] },
];
