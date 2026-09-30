// fidelity-cli.js - `fidelity` (instrument fidelity) and `instrument-gate`
// (instrument gate): section-scoped instrumentation gates, and the recorded
// stamp that proves one was run.
//
// Plain JS ESM + JSDoc.

import { compareObjectFidelity } from "./fidelity.js";
import { buildStamp, gateLines, verificationLines, verifyStamp, writeStamp, InstrumentGateError } from "./instrument-gate.js";
import { emitLines } from "./terminal.js";
import { terminalArguments } from "./cli-options.js";
import { dumps } from "./pyjson.js";
import { isInputError, osErrorText } from "./py.js";
import { isReportedError } from "./py-extra.js";

const errText = (e) => (e?.code && typeof e.code === "string" && /^E[A-Z]+$/.test(e.code) ? osErrorText(e) : e.message);
const reportable = (e) => isInputError(e) || isReportedError(e);

export function fidelityCommand(args, io, ctx) {
  let report;
  try { report = compareObjectFidelity(args.stock, args.instrumented, { objdump: args.objdump, sections: args.section, timeout: args.timeout, env: ctx.env }); } catch (e) {
    if (!reportable(e)) throw e;
    io.eprint(`error: ${errText(e)}`);
    return 2;
  }
  if (args.json) io.print(dumps(report));
  else {
    io.print(`object fidelity: ${report.pass ? "PASS" : "FAIL"}`);
    for (const [gate, passed] of Object.entries(report.gates)) io.print(`${gate}: ${passed ? "PASS" : "FAIL"}`);
    if (report.pass && !report.file_identical) io.print("note: scoped sections agree; whole-file metadata differs");
    io.print(`proof: ${report.proof}`);
  }
  return report.pass ? 0 : 1;
}

export function instrumentGateCommand(args, io, ctx) {
  let stamp, written = null;
  try {
    if (args.verify) {
      const result = verifyStamp(args.verify, { objdump: args.objdump, timeout: args.timeout, env: ctx.env });
      if (args.json) io.print(dumps(result));
      else emitLines(io, verificationLines(result), { width: args.width, pager: args.pager });
      return result.pass ? 0 : 1;
    }
    if (!(args.stock && args.instrumented)) {
      throw new InstrumentGateError("pass --stock OBJ --instrumented OBJ (two objects built from one source by the stock and instrumented toolchains), or --verify STAMP to re-run a recorded gate");
    }
    stamp = buildStamp({ stock: args.stock, instrumented: args.instrumented, profile: args.profile, objdump: args.objdump,
      sections: args.section, timeout: args.timeout, note: args.note || "", env: ctx.env });
    written = args.stamp ? writeStamp(stamp, { path: args.stamp }) : null;
  } catch (e) {
    if (!reportable(e)) throw e;
    io.eprint(`error: ${errText(e)}`);
    return 2;
  }
  if (args.json) {
    const payload = { ...stamp };
    if (written !== null) payload.stamp_path = String(written);
    io.print(dumps(payload));
  } else emitLines(io, gateLines(stamp, { stamp_path: written }), { width: args.width, pager: args.pager });
  return stamp.pass ? 0 : 1;
}

const sectionOption = { flags: ["--section"], action: "append", default: [".text", ".rodata", ".data"], help: "content section to gate; repeatable" };
const timeoutOption = { flags: ["--timeout"], type: "float", default: 10.0, metavar: "SECONDS", help: "seconds to allow each objdump invocation (default: 10.0)" };
const objdumpOption = { flags: ["--objdump"], help: "GNU-compatible MIPS objdump; auto-detected when omitted" };

export const GATE_DESCRIPTION = "Prove an instrumented toolchain reproduces the stock object, and record "
  + "that it did. With tracing off, an instrumented pass must emit the same "
  + ".text, .rodata, .data, relocations and symbol table as the stock pass; "
  + "otherwise its traces describe a compiler nobody is trying to match. One "
  + "campaign honoured that requirement by hand, every time, and left no "
  + "record -- twelve instruments across four passes, and the only evidence "
  + "any of them was gated was a stage's own sentence. This runs the "
  + "section-scoped comparison and writes a stamp naming the profile, both "
  + "objects and their hashes, and exactly what the gate does and does not "
  + "claim. --verify re-runs it rather than trusting the record. The "
  + "workbench does not build compilers; both objects come from the project's "
  + "own build.";

export const COMMAND_SPECS = [
  {
    path: ["fidelity"], handler: fidelityCommand,
    help: "gate instrumentation on sections, relocations, and symbols",
    arguments: [{ dest: "stock" }, { dest: "instrumented" }, objdumpOption, sectionOption, timeoutOption, { flags: ["--json"], action: "store_true", help: "emit JSON" }],
  },
  {
    path: ["instrument-gate"], handler: instrumentGateCommand, defaults: { report_command: "instrument-gate" },
    help: "gate an instrumented toolchain against stock, and stamp it",
    description: GATE_DESCRIPTION,
    epilog: "example: decomp-workbench instrument gate --stock stock.o --instrumented cdx.o --profile uopt-cdx --stamp gates/uopt-cdx.json",
    arguments: [
      { flags: ["--stock"], metavar: "OBJ", help: "object from the stock toolchain" },
      { flags: ["--instrumented"], metavar: "OBJ", help: "object from the instrumented toolchain, tracing off" },
      { flags: ["--profile"], default: "", metavar: "NAME", help: "which instrumented pass this stamp is about, e.g. uopt-cdx" },
      { flags: ["--stamp"], metavar: "FILE", help: "write the gate record here (the directory must already exist)" },
      { flags: ["--verify"], metavar: "FILE", help: "re-run the gate a stamp records and report what changed" },
      { flags: ["--note"], help: "one line about how the objects were built" },
      objdumpOption, sectionOption, timeoutOption,
      { flags: ["--json"], action: "store_true", help: "emit JSON" },
      ...terminalArguments(),
    ],
  },
];
