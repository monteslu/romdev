// relocation-cli.js - `relocation-aliases`: linked-address relocation alias
// evidence.
//
// Plain JS ESM + JSDoc.

import fs from "node:fs";
import { parseDisassembly } from "./objdump.js";
import { loadSymbolMap, relocationAliasReport } from "./relocation-alias.js";
import { dumps } from "./pyjson.js";
import { ValueError, hex, isInputError, osErrorText } from "./py.js";

export async function relocationAliasesCommand(args, io, ctx) {
  let report;
  try {
    const target = parseDisassembly(fs.readFileSync(ctx.resolve(args.target), "utf8"), { symbol: args.symbol });
    const candidate = parseDisassembly(fs.readFileSync(ctx.resolve(args.candidate), "utf8"), { symbol: args.symbol });
    if (!target.length || !candidate.length) throw new ValueError("both dumps must contain the selected instruction stream");
    report = relocationAliasReport(target, candidate, { symbols: loadSymbolMap(ctx.resolve(args.symbol_map)) });
  } catch (e) {
    if (!isInputError(e)) throw e;
    io.eprint(`error: ${e.code ? osErrorText(e) : e.message}`);
    return 2;
  }
  if (args.json) io.print(dumps(report));
  else {
    io.print(`relocation aliases: ${report.alias_count} resolved-address equivalent pair(s), ${report.unresolved_spelling_differences.length} unresolved`);
    for (const item of report.resolved_address_aliases) io.print(`index=${item.index} ${item.target.expression} == ${item.candidate.expression} -> 0x${hex(item.resolved_address)}`);
    io.print(`proof: ${report.proof}`);
  }
  return report.alias_count ? 0 : 1;
}

export const COMMAND_SPECS = [
  { path: ["relocation-aliases"], handler: relocationAliasesCommand, help: "resolve relocation spellings through a supplied linked symbol map",
    arguments: [
      { dest: "target", help: "target GNU objdump text" },
      { dest: "candidate", help: "candidate GNU objdump text" },
      { flags: ["--symbol"] },
      { flags: ["--symbol-map"], required: true, help: "JSON or nm-style map" },
      { flags: ["--json"], action: "store_true", help: "emit JSON" },
    ] },
];
