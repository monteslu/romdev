// capture-cli.js - capture-make and capture-runs: generate and read a
// compiler phase-capture toolchain.
//
// Plain JS ESM + JSDoc.

import { dumps } from "./pyjson.js";
import { isInputError, osErrorText } from "./py.js";
import { isReportedError } from "./py-extra.js";
import { DEFAULT_PHASES, listCaptureRuns, makeCaptureToolchain } from "./capture.js";

function humanBytes(value) {
  if (value < 1024) return `${value}B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)}K`;
  return `${(value / (1024 * 1024)).toFixed(1)}M`;
}

const reportable = (e) => isInputError(e) || isReportedError(e) || e?.name === "OSError";
const text = (e) => (e && typeof e.code === "string" && /^E[A-Z]+$/.test(e.code) ? osErrorText(e) : e.message);
const fmtPhaseCounts = (counts) => (Object.keys(counts).length ? `{${Object.entries(counts).map(([k, v]) => `'${k}': ${v}`).join(", ")}}` : "none");

export async function captureMakeCommand(args, io, ctx) {
  let manifest;
  try {
    manifest = makeCaptureToolchain(ctx.resolve(args.ido_root), ctx.resolve(args.destination), { phases: args.phase.length ? args.phase : DEFAULT_PHASES, link: args.link, force: args.force });
  } catch (e) {
    if (!reportable(e)) throw e;
    io.eprint(`error: ${text(e)}`);
    return 2;
  }
  if (args.json) { io.print(dumps(manifest)); return 0; }
  const carried = manifest.entries.filter((i) => i.carried === "copy" || i.carried === "symlink").length;
  io.print(`capture toolchain: ${manifest.toolchain}`);
  io.print(`wrapped phases: ${manifest.wrapped_phases.join(", ")} (originals kept as <phase>.real)`);
  io.print(`carried: ${carried} other entr(ies) by ${manifest.carry_mode}` + (manifest.self_aliases.length ? `; self-alias ${manifest.self_aliases.join(", ")} -> .` : ""));
  io.print(`captures: ${manifest.captures}`);
  io.print(`next: ${manifest.usage}`);
  io.print(`proof: ${manifest.proof}`);
  return 0;
}

export async function captureRunsCommand(args, io, ctx) {
  let report;
  try {
    report = listCaptureRuns(ctx.resolve(args.destination), { phase: args.phase, limit: args.all ? null : args.limit });
  } catch (e) {
    if (!reportable(e)) throw e;
    io.eprint(`error: ${text(e)}`);
    return 2;
  }
  if (args.json) { io.print(dumps(report)); return 0; }
  io.print(`captures: ${report.captures} (${report.run_count} run(s), ${report.listed_count} listed; ${fmtPhaseCounts(report.phase_counts)})`);
  if (!report.runs.length) io.print("no runs; build one translation unit through the capture toolchain");
  for (const run of report.runs) {
    const status = run.status === null ? "-" : String(run.status);
    io.print(`${run.run_id.padEnd(34)} ${run.phase.padEnd(8)} rc=${status.padEnd(4)} ${humanBytes(run.stream_bytes).padStart(7)} in ${String(run.file_count).padStart(2)} file(s)  ${run.argv.summary}`);
  }
  for (const item of report.unreadable) io.eprint(`unreadable: ${item.directory}: ${item.error}`);
  return 0;
}

export const COMMAND_SPECS = [
  {
    path: ["capture-make"], handler: captureMakeCommand, hidden: true,
    help: "generate an arg-preserving capture toolchain around an IDO root",
    description: "Wrap ugen/as0/as1 in one node wrapper that retains every file argument before and after each invocation, so a normal build leaves the exact streams that crossed each pass boundary. The wrapper runs the untouched phase binary; the build's bytes do not change.",
    arguments: [
      { dest: "ido_root", help: "the unmodified IDO compiler directory" },
      { dest: "destination", help: "where to write toolchain/ and captures/ (must not be inside the root)" },
      { flags: ["--phase"], action: "append", default: [], metavar: "NAME", help: "phase to wrap; repeatable. Default: " + DEFAULT_PHASES.join(", ") },
      { flags: ["--link"], action: "store_true", help: "symlink the carried binaries instead of copying them" },
      { flags: ["--force"], action: "store_true", help: "replace an existing toolchain directory, keeping collected captures" },
      { flags: ["--json"], action: "store_true", help: "emit JSON" },
    ],
  },
  {
    path: ["capture-runs"], handler: captureRunsCommand, hidden: true,
    help: "list the phase runs a capture toolchain collected",
    description: "Read the run directories under a capture destination and report each run's phase, exit status, argv shape, and retained stream sizes. This command is static and runs no compiler.",
    arguments: [
      { dest: "destination", help: "a capture destination, or the captures directory itself" },
      { flags: ["--phase"], help: "list only runs of this phase" },
      { flags: ["--limit"], type: "int", default: 20, help: "show at most this many newest runs (default: 20)" },
      { flags: ["--all"], action: "store_true", help: "show every run" },
      { flags: ["--json"], action: "store_true", help: "emit JSON" },
    ],
  },
];
