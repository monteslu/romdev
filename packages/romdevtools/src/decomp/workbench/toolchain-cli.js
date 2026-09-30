// toolchain-cli.js - toolchain-init, toolchain-calibrate, toolchain-status:
// real-copy external toolchain setup and health.
//
// Plain JS ESM + JSDoc.

import { dumps } from "./pyjson.js";
import { ValueError, strRepr, isInputError, osErrorText } from "./py.js";
import { isReportedError } from "./py-extra.js";
import { calibrateToolchain, initializeToolchain, toolchainStatus } from "./toolchain.js";

function named(values, { option }) {
  const result = {};
  for (const value of values) {
    const i = value.indexOf("=");
    const name = i < 0 ? value : value.slice(0, i), p = i < 0 ? "" : value.slice(i + 1);
    if (i < 0 || !name || !p) throw new ValueError(`${option} expects RELATIVE_PATH=SOURCE: ${strRepr(value)}`);
    if (name in result) throw new ValueError(`${option} repeats ${strRepr(name)}`);
    result[name] = p;
  }
  return result;
}

function pairs(values, { option = "--fidelity-pair" } = {}) {
  return values.map((value) => {
    const i = value.indexOf("=");
    const left = i < 0 ? value : value.slice(0, i), right = i < 0 ? "" : value.slice(i + 1);
    if (i < 0 || !left || !right) throw new ValueError(`${option} expects LEFT=RIGHT: ${strRepr(value)}`);
    return [left, right];
  });
}

const reportable = (e) => isInputError(e) || isReportedError(e) || e?.name === "OSError";
const text = (e) => (e && typeof e.code === "string" && /^E[A-Z]+$/.test(e.code) ? osErrorText(e) : e.message);
const label = (passed) => (passed ? "PASS" : "NOT RUN");

export async function toolchainInitCommand(args, io, ctx) {
  let report;
  try {
    const replacements = named(args.replace, { option: "--replace" });
    for (const [relative, source] of [["uopt", args.uopt], ["ugen", args.ugen]]) {
      if (source === null || source === undefined) continue;
      if (relative in replacements) throw new ValueError(`--${relative} and --replace ${relative}=... are mutually exclusive`);
      replacements[relative] = source;
    }
    report = await initializeToolchain(ctx.resolve(args.destination), { base: ctx.resolve(args.base),
      replacements: Object.fromEntries(Object.entries(replacements).map(([k, v]) => [k, ctx.resolve(v)])),
      fidelity_pairs: pairs(args.fidelity_pair).map(([a, b]) => [ctx.resolve(a), ctx.resolve(b)]),
      scheduler_positive_log: args.scheduler_positive_log ? ctx.resolve(args.scheduler_positive_log) : null, objdump: args.objdump });
  } catch (e) {
    if (!reportable(e)) throw e;
    io.eprint(`error: ${text(e)}`);
    return 2;
  }
  if (args.json) { io.print(dumps(report)); return 0; }
  io.print(`toolchain: ${report.claim.toUpperCase()} (${report.directory})`);
  io.print("gates:");
  for (const [name, passed] of Object.entries(report.gates)) io.print(`  ${name}: ${label(passed)}`);
  if (report.claim !== "ready") {
    io.print("next: finish every fidelity gate before treating traces as supported evidence");
    io.print(`      run the gates: decomp-workbench toolchain calibrate ${report.directory} (see docs/toolchain-calibration.md)`);
    io.print("      no instrumented toolchain yet? the source-only levers still apply: decomp-workbench guide pool-position");
  }
  return 0;
}

export async function toolchainCalibrateCommand(args, io, ctx) {
  let report;
  try {
    const abs = (list, option) => pairs(list, { option }).map(([a, b]) => [ctx.resolve(a), ctx.resolve(b)]);
    report = await calibrateToolchain(ctx.resolve(args.directory), {
      unedited_replay_pairs: abs(args.unedited_replay_pair, "--unedited-replay-pair"),
      collateral_pairs: abs(args.collateral_pair, "--collateral-pair"),
      project_output_pairs: abs(args.project_output_pair, "--project-output-pair"),
      scheduler_positive_log: args.scheduler_positive_log ? ctx.resolve(args.scheduler_positive_log) : null, objdump: args.objdump });
  } catch (e) {
    if (!reportable(e)) throw e;
    io.eprint(`error: ${text(e)}`);
    return 2;
  }
  if (args.json) io.print(dumps(report));
  else {
    io.print(`toolchain: ${report.claim.toUpperCase()} (${report.directory})`);
    for (const [name, passed] of Object.entries(report.gates)) io.print(`  ${name}: ${label(passed)}`);
    if (report.next_missing_gates.length) io.print("next missing gates: " + report.next_missing_gates.join(", "));
  }
  // A partially calibrated toolchain is a state, not a command failure.
  return 0;
}

export async function toolchainStatusCommand(args, io, ctx) {
  let report;
  try { report = toolchainStatus(ctx.resolve(args.directory)); } catch (e) {
    if (!reportable(e)) throw e;
    io.eprint(`error: ${text(e)}`);
    return 2;
  }
  if (args.json) io.print(dumps(report));
  else {
    io.print(`toolchain: ${report.claim.toUpperCase()} (${report.directory})`);
    io.print(`integrity: ${report.integrity ? "PASS" : "FAIL"}`);
    if (report.next_missing_gates.length) io.print("missing gates: " + report.next_missing_gates.join(", "));
  }
  return report.integrity ? 0 : 1;
}

export const COMMAND_SPECS = [
  {
    path: ["toolchain-init"], handler: toolchainInitCommand, hidden: true,
    description: "Materialize a real-copy external toolchain and record hashes and calibration gates. No compiler binaries enter this repository.",
    arguments: [
      { dest: "destination" },
      { flags: ["--base"], required: true },
      { flags: ["--uopt"], help: "instrumented uopt copied to BASE/uopt" },
      { flags: ["--ugen"], help: "instrumented ugen copied to BASE/ugen" },
      { flags: ["--replace"], action: "append", default: [], metavar: "RELATIVE_PATH=SOURCE" },
      { flags: ["--fidelity-pair"], action: "append", default: [], metavar: "STOCK=INSTRUMENTED_OFF" },
      { flags: ["--scheduler-positive-log"] },
      { flags: ["--objdump"] },
      { flags: ["--json"], action: "store_true", help: "emit JSON" },
    ],
  },
  {
    path: ["toolchain-calibrate"], handler: toolchainCalibrateCommand, hidden: true,
    description: "Run missing calibration cells. Object pairs use section-scoped fidelity; project outputs require exact file identity.",
    arguments: [
      { dest: "directory" },
      { flags: ["--unedited-replay-pair"], action: "append", default: [], metavar: "NORMAL=REPLAY" },
      { flags: ["--collateral-pair"], action: "append", default: [], metavar: "STOCK=INSTRUMENTED_OFF" },
      { flags: ["--project-output-pair"], action: "append", default: [], metavar: "EXPECTED=ACTUAL" },
      { flags: ["--scheduler-positive-log"] },
      { flags: ["--objdump"] },
      { flags: ["--json"], action: "store_true", help: "emit JSON" },
    ],
  },
  {
    path: ["toolchain-status"], handler: toolchainStatusCommand, hidden: true,
    description: "Verify toolchain hashes and summarize calibration claims.",
    arguments: [{ dest: "directory" }, { flags: ["--json"], action: "store_true", help: "emit JSON" }],
  },
];
