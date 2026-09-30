// matrix-cli.js - `matrix`: run pipeline variants and cluster them into
// attractors.
//
// Plain JS ESM + JSDoc.

import { runMatrix } from "./matrix.js";
import { ScoreError } from "./score.js";
import { dumps } from "./pyjson.js";
import { isInputError, osErrorText } from "./py.js";

export function matrixPayload(report) { return { schema: "decomp-workbench-matrix-v1", ...report.asDict() }; }

export function renderMatrixHuman(io, report) {
  io.print(`run directory (logs never discarded): ${report.run_dir}`);
  const scored = report.variants.filter((v) => v.score !== null).length;
  io.print(`${report.variants.length} variant(s), ${scored} scored, ${report.attractors.length} attractor(s)`);
  io.print(`${"ATTR".padEnd(5)}${"DIFF".padStart(6)}  MEMBERS`);
  for (const a of report.attractors) {
    const note = a.members.length >= 2 ? "  <- SAME OUTPUT (silent fallback? see labels)" : "";
    io.print(`${a.letter.padEnd(5)}${String(a.diff_words).padStart(6)}  ${a.members.join(", ")}${note}`);
  }
  const failed = report.variants.filter((v) => v.score === null);
  if (failed.length) { io.print(""); io.print("no scorable object:"); for (const f of failed) io.print(`  ${f.label}: ${f.error}`); }
  if (report.silent_fallback_warnings.length) {
    io.print(""); io.print("stderr warnings (possible silent flag fallback):");
    for (const [label, line] of report.silent_fallback_warnings) io.print(`  ${label}: ${line}`);
  }
  if (report.collapsed_attractors.length && !report.all_collapsed) {
    io.print("");
    for (const a of report.collapsed_attractors) io.print(`NOTE: attractor ${a.letter} contains ${a.members.length} differently-labeled variants that produced identical bytes: ${a.members.join(", ")}`);
  }
  if (report.caution) { io.print(""); io.print(`CAUTION: ${report.caution}`); }
  io.print("");
  if (report.attractors.length) {
    const best = new Set(report.attractors[0].members);
    const hit = report.variants.find((v) => best.has(v.label) && v.score !== null);
    if (hit) for (const step of hit.score.guidance) io.print(`next: ${step}`);
  }
}

export async function matrixCommand(args, io, ctx) {
  let report;
  try { report = await runMatrix(args.spec, { run_dir: args.run_dir || null, timeout: args.timeout, cwd: ctx.cwd, env: ctx.env }); }
  catch (e) {
    if (!(e instanceof ScoreError || isInputError(e))) throw e;
    io.eprint(`error: ${e.code ? osErrorText(e) : e.message}`);
    return 2;
  }
  if (args.json) io.print(dumps(matrixPayload(report)));
  else renderMatrixHuman(io, report);
  return report.variants.some((v) => v.score !== null) ? 0 : 1;
}

export const COMMAND_SPECS = [
  { path: ["matrix"], handler: matrixCommand, help: "run pipeline variants and cluster their output into attractors",
    description: "Run every variant command in a JSON spec, substituting $OUTPUT for a per-variant object path, then score and hash each produced object. Identical hashes cluster into lettered attractors (A is the closest to matching); two or more differently-labeled variants sharing one attractor, or every variant collapsing into one, are called out explicitly, because a silently-ignored flag looks identical to an exhausted search axis otherwise.",
    arguments: [
      { dest: "spec", help: "matrix JSON spec file (see docs/score-and-matrix.md)" },
      { flags: ["--run-dir"], help: "directory for produced objects and per-variant stdout/stderr logs (default: .decomp-workbench/matrix/<timestamp>)" },
      { flags: ["--timeout"], type: "float", default: 120.0, help: "per-variant command timeout in seconds (default: 120)" },
      { flags: ["--json"], action: "store_true", help: "emit JSON" },
    ] },
];
