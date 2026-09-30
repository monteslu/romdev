// pass-adapter-cli.js - `pass-diff` (pass diff): a user-supplied original pass
// against a static recompilation of it.
//
// Plain JS ESM + JSDoc.

import { runPassDifferential } from "./pass-adapter.js";
import { dumps } from "./pyjson.js";
import { isInputError, osErrorText } from "./py.js";
import { isReportedError } from "./py-extra.js";

const errText = (e) => (e?.code && typeof e.code === "string" && /^E[A-Z]+$/.test(e.code) ? osErrorText(e) : e.message);

export async function passDiffCommand(args, io) {
  let report;
  try {
    report = await runPassDifferential(args.input, { original_template: args.original_command, static_template: args.static_command, boundary: args.boundary,
      work_root: args.work_dir, compile_cwd: args.compile_cwd, timeout: args.timeout, stream_limit: args.stream_limit, downstream_template: args.downstream_command });
  } catch (e) {
    if (!isInputError(e) && !isReportedError(e)) throw e;
    io.eprint(`error: ${errText(e)}`);
    return 2;
  }
  if (args.json) io.print(dumps(report));
  else {
    io.print(`pass boundary ${report.boundary}: bytes ${report.byte_identical ? "IDENTICAL" : "DIFFERENT"}, host-normalized ${report.normalized_identical ? "IDENTICAL" : "DIFFERENT"}`);
    if (report.downstream) io.print(`downstream: ${report.downstream.identical ? "IDENTICAL" : "DIFFERENT"}`);
    io.print(`work directory: ${report.work_directory}`);
    io.print(`proof: ${report.proof}`);
  }
  if (args.require_identical && !report.byte_identical) return 1;
  return 0;
}

export const COMMAND_SPECS = [{
  path: ["pass-diff"], handler: passDiffCommand,
  help: "compare a user-supplied original pass with a static recompilation",
  description: "Run one retained pass boundary through explicit original and static commands, retain hashes and outputs in a project-visible directory, and optionally run the same downstream stage.",
  arguments: [
    { dest: "input" },
    { flags: ["--original-command"], required: true },
    { flags: ["--static-command"], required: true },
    { flags: ["--downstream-command"] },
    { flags: ["--boundary"], required: true },
    { flags: ["--work-dir"], default: ".decomp-workbench/pass-diff", help: "project-visible run root (default: .decomp-workbench/pass-diff)" },
    { flags: ["--compile-cwd"], default: ".", help: "working directory for every external pass" },
    { flags: ["--timeout"], type: "float", default: 120.0 },
    { flags: ["--stream-limit"], type: "int", default: 64 * 1024 },
    { flags: ["--require-identical"], action: "store_true" },
    { flags: ["--json"], action: "store_true", help: "emit JSON" },
  ],
}];
