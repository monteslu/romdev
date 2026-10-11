// context-lint-cli.js - `context lint` (every collapsed-by-absence
// #if/#elif guard) and `context duplicates` (simple file-scope definitions
// repeated across source fragments).
//
// Plain JS ESM + JSDoc.

import fs from "node:fs";
import { dumps } from "./pyjson.js";
import { isInputError } from "./py.js";
import { osText, isOSError } from "./py-path.js";
import { duplicateFileScopeDefinitions, lintSources, parseDefines, renderReport } from "./context-lint.js";
import { groupListingSpec } from "./group-listing.js";

export function contextLintCommand(args, io, ctx) {
  let report;
  try {
    const defines = parseDefines(args.define);
    report = lintSources(args.files.map((p) => [p, fs.readFileSync(ctx.resolve(p), "utf8")]), defines);
  } catch (e) {
    if (!isOSError(e) && !isInputError(e)) throw e;
    io.eprint(`error: ${isOSError(e) ? osText(e) : e.message}`);
    return 2;
  }
  if (args.json) io.print(dumps(report.asDict()));
  else for (const line of renderReport(report)) io.print(line);
  if (args.fail_on_high && report.findings.some((f) => f.severity === "high")) return 1;
  return 0;
}

export function contextDuplicatesCommand(args, io, ctx) {
  if (args.files.length < 2) { io.eprint("error: context duplicates requires at least two files"); return 2; }
  let findings;
  try {
    findings = duplicateFileScopeDefinitions(args.files.map((p) => [p, fs.readFileSync(ctx.resolve(p), "utf8")]));
  } catch (e) {
    if (!isOSError(e)) throw e;
    io.eprint(`error: ${osText(e)}`);
    return 2;
  }
  if (args.json) {
    io.print(dumps({ schema: "decomp-workbench-context-duplicates-v1", files: args.files, findings,
      limitations: "single-line file-scope definitions only; this is an approximation, not a C parser" }));
  } else {
    io.print(`context duplicates: ${findings.length} repeated definition(s) across ${args.files.length} file(s)`);
    for (const f of findings) io.print(`  ${f.symbol}: ${f.occurrences.map((o) => `${o.source}:${o.line}`).join(", ")}`);
    if (!findings.length) io.print("no repeated file-scope definition found");
    io.print("note: scans simple single-line definitions; it is not a C parser");
  }
  return args.fail_on_findings && findings.length ? 1 : 0;
}

const SUBS = [
  { path: ["context", "lint"], handler: contextLintCommand, help: "report every collapsed-by-absence #if/#elif guard",
    description: "Parse every #if/#elif in the given files against the macros you name with --define plus whatever the files #define along the way, and report guards whose truth was decided entirely by identifiers that were never defined.",
    defaults: { report_command: "context-lint" },
    arguments: [
      { dest: "files", nargs: "+", help: "C source or header files to scan, in the order a compiler would see them" },
      { flags: ["--define"], action: "append", default: [], metavar: "NAME[=VALUE]", help: "a macro this translation unit defines, as a compiler -D flag would; repeatable, and later entries may reference earlier ones" },
      { flags: ["--fail-on-high"], action: "store_true", help: "return exit 1 if any always-true-by-absence finding is present" },
      { flags: ["--json"], action: "store_true", help: "emit JSON" },
    ] },
  { path: ["context", "duplicates"], handler: contextDuplicatesCommand, help: "find simple file-scope definitions repeated across source fragments",
    defaults: { report_command: "context-duplicates" },
    arguments: [
      { dest: "files", nargs: "+", help: "two or more C source fragments" },
      { flags: ["--fail-on-findings"], action: "store_true", help: "return exit 1 when a repeated definition is found" },
      { flags: ["--json"], action: "store_true", help: "emit JSON" },
    ] },
];

export const COMMAND_SPECS = [
  groupListingSpec(["context"], { help: "audit #if/#elif guards for the undefined-identifier-collapse trap",
    description: "Scan C sources for #if/#elif conditionals whose expression's identifiers are all undefined, so the guard silently evaluates to a constant no one intended.",
    subcommands: SUBS, required: false }),
  ...SUBS,
];
