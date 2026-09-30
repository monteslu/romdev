// handoff-cli.js - `audit-handoff`: catch publication paths and files that
// will not travel.
//
// Plain JS ESM + JSDoc.

import { auditHandoff } from "./handoff-audit.js";
import { dumps } from "./pyjson.js";
import { isInputError, osErrorText } from "./py.js";

export function auditHandoffCommand(args, io, ctx) {
  let report;
  try {
    report = auditHandoff(args.path, { dependency_roots: args.dependency_root, exclude: args.exclude, cwd: ctx.cwd });
  } catch (e) {
    if (!(isInputError(e) || e?.name === "NotADirectoryError" || e?.name === "OSError")) throw e;
    io.eprint(`error: ${e.code ? osErrorText(e) : e.message}`);
    return 2;
  }
  if (args.json) io.print(dumps(report));
  else {
    io.print(`handoff: ${report.ready ? "READY" : "NEEDS ATTENTION"} (${report.errors} error(s), ${report.warnings} warning(s))`);
    io.print(`root: ${report.root}`);
    for (const f of report.findings) {
      let location = String(f.source);
      if (f.line !== null) location += `:${f.line}`;
      const reference = f.reference ? ` (${f.reference})` : "";
      io.print(`${String(f.severity).toUpperCase()} ${f.code} ${location}${reference}: ${f.message}`);
      io.print(`  do: ${f.action}`);
    }
    io.print(`proof: ${report.proof}`);
  }
  const failed = !report.ready || (args.fail_on_warning && report.warnings);
  return failed ? 1 : 0;
}

export const COMMAND_SPECS = [
  {
    path: ["audit-handoff"], handler: auditHandoffCommand,
    help: "catch publication paths and files that will not travel",
    description: "Audit a proof/handoff repository for missing local references, absolute user paths, and files or dependencies absent from Git.",
    arguments: [
      { dest: "path", help: "public handoff repository or directory" },
      { flags: ["--dependency-root"], action: "append", default: [], metavar: "PATH", help: "project root allowed to satisfy references; repeatable" },
      { flags: ["--fail-on-warning"], action: "store_true", help: "return exit 1 for warnings as well as errors" },
      { flags: ["--exclude"], action: "append", default: [], metavar: "GLOB", help: "repository-relative path glob to exclude; repeatable" },
      { flags: ["--json"], action: "store_true", help: "emit JSON" },
    ],
  },
];
