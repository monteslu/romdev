// pass-replay-cli.js - `replay-ugen` (pass replay-ugen) and `replay-as1`
// (pass replay-as1): replay a retained or edited pass boundary through the
// stock IDO phases.
//
// Plain JS ESM + JSDoc.

import { replayUgen, replayAs1, ListingEdit } from "./pass-replay.js";
import { parseEnvironment } from "./environment.js";
import { processOutputArguments } from "./cli-options.js";
import { dumps } from "./pyjson.js";
import { ValueError, isInputError, osErrorText, strRepr } from "./py.js";
import { isReportedError } from "./py-extra.js";

const errText = (e) => (e?.code && typeof e.code === "string" && /^E[A-Z]+$/.test(e.code) ? osErrorText(e) : e.message);
const reportable = (e) => isInputError(e) || isReportedError(e) || e?.reError;

/** shlex.quote / shlex.join. */
export function shlexQuote(s) {
  if (s === "") return "''";
  if (!/[^\w@%+=:,./-]/.test(s)) return s;
  return "'" + s.replace(/'/g, "'\"'\"'") + "'";
}
export const shlexJoin = (argv) => argv.map(shlexQuote).join(" ");

function environmentOf(values) {
  const environment = {};
  for (const item of values) {
    const i = item.indexOf("=");
    const name = i < 0 ? item : item.slice(0, i);
    if (i < 0 || !name) throw new ValueError(`--env wants NAME=VALUE, got ${strRepr(item)}`);
    environment[name] = item.slice(i + 1);
  }
  return environment;
}

export async function replayUgenCommand(args, io, ctx) {
  let report;
  try {
    report = await replayUgen(args.ucode, { toolchain: args.toolchain, argv_from: args.argv_from, output: args.output, as1_argv_from: args.as1_argv_from,
      expect: args.expect, run_as1: !args.skip_as1, keep_work: args.keep_work, work_root: args.work_root, compile_cwd: args.compile_cwd,
      environment: environmentOf(args.env), timeout: args.timeout, nice: args.nice, objdump: args.objdump, host: ctx.env });
  } catch (e) {
    if (!reportable(e)) throw e;
    io.eprint(`error: ${errText(e)}`);
    return 2;
  }
  if (args.json) io.print(dumps(report));
  else {
    io.print(`ucode: ${report.ucode.bytes} bytes, sha256=${report.ucode.sha256.slice(0, 12)}`);
    io.print(`argv from: ${report.argv_source.ugen_run}`);
    if (report.argv_source.as1_run) io.print(`as1 argv:  ${report.argv_source.as1_run} (${report.argv_source.as1_discovery})`);
    io.print(`binasm: ${report.binasm.bytes} bytes, sha256=${report.binasm.sha256.slice(0, 12)}`);
    for (const w of report.warnings ?? []) io.eprint(`warning: ${w}`);
    if (report.object) {
      io.print(`object: ${report.object.bytes} bytes, sha256=${report.object.sha256.slice(0, 12)}` + (report.object.path ? ` -> ${report.object.path}` : ""));
      io.print(`verify: ${report.verification.verdict}`);
      if (report.verification.reference) io.print(`  reference: ${report.verification.reference}`);
    }
    io.print(`proof: ${report.proof}`);
  }
  const verification = report.verification || {};
  if (args.require_identical && verification.byte_identical !== true) return 1;
  return 0;
}

export function parseListingEdit(value, position) {
  const i = value.indexOf("=");
  const pattern = i < 0 ? value : value.slice(0, i);
  if (i < 0 || !pattern) throw new ValueError(`--insert-${position} expects REGEX=TEXT: ${strRepr(value)}`);
  return new ListingEdit({ position, pattern, text: value.slice(i + 1) });
}

export async function replayAs1Command(args, io, ctx) {
  let result;
  try {
    const edits = [...args.insert_before.map((v) => parseListingEdit(v, "before")), ...args.insert_after.map((v) => parseListingEdit(v, "after"))];
    result = await replayAs1(args.listing, args.output, { as0_template: args.as0_command, as1_template: args.as1_command, edits,
      allow_multiple: args.allow_multiple, keep_work: args.keep_work, calibration_object: args.calibration_object, objdump: args.objdump,
      work_root: args.work_root, compile_cwd: args.compile_cwd, environment: parseEnvironment(args.env), timeout: args.timeout,
      stream_limit: args.stream_limit, artifact_dir: args.artifact_dir, objdump_env: ctx.env });
  } catch (e) {
    if (!reportable(e)) throw e;
    io.eprint(`error: ${errText(e)}`);
    return 2;
  }
  if (args.json) io.print(dumps(result));
  else {
    io.print(`as0: ${shlexJoin(result.as0_command)}`);
    io.print(`as1: ${shlexJoin(result.as1_command)}`);
    io.print(`object: ${result.output}`);
    if (result.retained_directory) io.print(`retained: ${result.retained_directory}`);
    if (result.calibration) io.print("unedited replay calibration: PASS (section-scoped)");
  }
  return 0;
}

export const COMMAND_SPECS = [
  {
    path: ["replay-ugen"], handler: replayUgenCommand,
    help: "replay a Ucode stream through stock ugen and as1 with captured argv",
    description: "Run one retained or patched binary Ucode stream through the stock ugen and as1 binaries, reusing the exact argument shape a capture run recorded -- including the -t symbol table, which ugen mutates and as1 then reads. Replaying a capture's own unmodified Ucode must reproduce that capture's object byte for byte; until it does, a patched variant's difference is not attributable to the patch.",
    arguments: [
      { dest: "ucode", help: "the Ucode stream to replay" },
      { flags: ["--toolchain"], required: true, help: "a capture destination or IDO root; <phase>.real is preferred" },
      { flags: ["--argv-from"], required: true, metavar: "RUN_DIR", help: "the ugen capture run whose argument shape to reuse" },
      { flags: ["--as1-argv-from"], metavar: "RUN_DIR", help: "the as1 capture run to reuse; by default the run whose positional input is this ugen run's -o file" },
      { flags: ["-o", "--output"], help: "write the replayed object here" },
      { flags: ["--expect"], help: "verify against this object instead of the as1 run's retained one" },
      { flags: ["--skip-as1"], action: "store_true", help: "stop after ugen and produce only the Binasm stream" },
      { flags: ["--require-identical"], action: "store_true", help: "exit 1 unless the replayed object matches the reference exactly" },
      { flags: ["--keep-work"], help: "retain the replay intermediates here" },
      { flags: ["--work-root"], help: "project-visible parent for the temporary work directory" },
      { flags: ["--compile-cwd"], default: ".", help: "working directory for each phase (default: .)" },
      { flags: ["--env"], action: "append", default: [], metavar: "NAME=VALUE", help: "add or override one environment variable; repeatable" },
      { flags: ["--nice"], type: "int", default: 10, help: "run each phase at this nice level (default: 10)" },
      { flags: ["--timeout"], type: "float", default: 300.0, help: "per-phase timeout in seconds (default: 300)" },
      { flags: ["--objdump"], help: "objdump used to explain a mismatch" },
      { flags: ["--json"], action: "store_true", help: "emit JSON" },
    ],
  },
  {
    path: ["replay-as1"], handler: replayAs1Command,
    help: "edit a retained ugen listing and rerun as0/as1",
    description: "Apply unique listing edits and rebuild through as0 and as1.",
    arguments: [
      { dest: "listing", help: "retained ugen assembly listing" },
      { dest: "output", help: "output object path" },
      { flags: ["--as0-command"], required: true, help: "template containing {listing} and {binasm}" },
      { flags: ["--as1-command"], required: true, help: "template containing {binasm} and {object}" },
      { flags: ["--insert-before"], action: "append", default: [], metavar: "REGEX=TEXT", help: "insert text before a unique regex match; repeatable" },
      { flags: ["--insert-after"], action: "append", default: [], metavar: "REGEX=TEXT", help: "insert text after a unique regex match; repeatable" },
      { flags: ["--allow-multiple"], action: "store_true", help: "permit an edit regex to match more than once" },
      { flags: ["--keep-work"], help: "retain the edited listing and intermediate files here" },
      { flags: ["--calibration-object"], help: "normal unedited output required before any edited replay" },
      { flags: ["--objdump"], help: "object reader for calibration gates" },
      { flags: ["--work-root"], help: "project-visible temporary root for Docker/QEMU path visibility" },
      { flags: ["--compile-cwd"], help: "working directory for as0/as1" },
      { flags: ["--env"], action: "append", default: [], metavar: "NAME=VALUE", help: "explicit pass environment entry; repeatable" },
      { flags: ["--timeout"], type: "float", default: 120.0 },
      ...processOutputArguments(),
      { flags: ["--json"], action: "store_true", help: "emit JSON" },
    ],
  },
];
