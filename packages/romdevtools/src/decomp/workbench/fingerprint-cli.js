// fingerprint-cli.js - `fingerprint-toolchain` (compiler/frontend behavior
// from redistributable microcases, or a comparison of two such reports) and
// `lineage` (one symbol across object revisions, without reading ROMs).
//
// Plain JS ESM + JSDoc.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { compareFingerprintReports, crossRomLineage, runToolchainFingerprint } from "./fingerprint.js";
import { dumps } from "./pyjson.js";
import { ValueError, strRepr, isInputError, osErrorText } from "./py.js";
import { loadsJson } from "./json-error.js";

const expandUser = (p) => (p === "~" || p.startsWith("~/") ? os.homedir() + p.slice(1) : p);
const resolvePath = (p) => { const abs = path.resolve(expandUser(String(p))); try { return fs.realpathSync(abs); } catch { return abs; } };
const errorText = (e) => (e && typeof e.code === "string" && /^E[A-Z]+$/.test(e.code) ? osErrorText(e) : e.message);
const reportable = (e) => isInputError(e) || e instanceof SyntaxError || e?.name === "RuntimeError" || e?.name === "OSError" || e?.name === "FileNotFoundError" || e?.reported;

/** NAME=VALUE pairs, in order, refusing repeats. */
function pairs(values, label) {
  const result = new Map();
  for (const value of values) {
    const i = value.indexOf("=");
    const name = i < 0 ? value : value.slice(0, i), content = i < 0 ? "" : value.slice(i + 1);
    if (i < 0 || !name || !content) throw new ValueError(`${label} expects NAME=VALUE: ${strRepr(value)}`);
    if (result.has(name)) throw new ValueError(`${label} repeats name ${strRepr(name)}`);
    result.set(name, content);
  }
  return result;
}

export async function fingerprintToolchainCommand(args, io) {
  let report;
  try {
    if (args.compare) {
      const target = loadsJson(fs.readFileSync(args.compare[0], "utf8"));
      const candidate = loadsJson(fs.readFileSync(args.compare[1], "utf8"));
      report = compareFingerprintReports(target, candidate);
    } else {
      const environment = Object.fromEntries(pairs(args.env, "--env"));
      if (args.compile_command === null) throw new ValueError("--compile-command is required");
      report = await runToolchainFingerprint(args.compile_command, { compile_cwd: args.compile_cwd, environment, objdump: args.objdump,
        timeout: args.timeout, stream_limit: args.stream_limit, artifact_dir: args.artifact_dir });
    }
    if (args.output) {
      const output = resolvePath(args.output);
      if (fs.existsSync(output)) throw Object.assign(new Error(`refusing to overwrite report: ${output}`), { reported: true });
      fs.mkdirSync(path.dirname(output), { recursive: true });
      fs.writeFileSync(output, dumps(report) + "\n", { encoding: "utf8", flag: "wx" });
    }
  } catch (e) {
    if (!reportable(e)) throw e;
    io.eprint(`error: ${errorText(e)}`);
    return 2;
  }
  if (args.json) io.print(dumps(report));
  else {
    if (args.compare) {
      const state = !report.compatible ? "INCOMPATIBLE SUITES" : report.identical ? "IDENTICAL" : "DIFFERENT";
      io.print(`toolchain fingerprints: ${state}`);
      if (!report.compatible) io.print("rebuild both reports with the same workbench microcase suite");
      for (const item of report.differences) io.print(`${item.case}: ` + item.changed_features.join(", "));
    } else {
      io.print(`toolchain fingerprint: ${report.fingerprint}`);
      io.print(`microcase suite: ${report.suite}`);
      io.print(`cases: ${report.cases.length}`);
      const dispatch = report.cases.filter((c) => c.name.startsWith("dense-switch-")).map((c) => [c.name, c.features.computed_jump]);
      if (dispatch.length) io.print("dense switch dispatch: " + dispatch.map(([n, computed]) => `${n.slice("dense-switch-".length)}=${computed ? "table" : "chain"}`).join(", "));
      io.print(`proof: ${report.proof}`);
    }
    if (args.output) io.print(`report: ${resolvePath(args.output)}`);
  }
  return 0;
}

export function lineageCommand(args, io) {
  let report;
  try {
    const revisions = new Map([...pairs(args.revisions, "revision")].map(([label, p]) => [label, resolvePath(p)]));
    const romHashes = Object.fromEntries(pairs(args.rom_hash, "--rom-hash"));
    report = crossRomLineage(revisions, { objdump: args.objdump, symbol: args.symbol, section: args.section, rom_hashes: romHashes });
  } catch (e) {
    if (!reportable(e)) throw e;
    io.eprint(`error: ${errorText(e)}`);
    return 2;
  }
  if (args.json) io.print(dumps(report));
  else {
    io.print(`lineage: ${Object.keys(report.revisions).length} revision(s), ${report.normalized_lineage_groups.length} normalized group(s)`);
    for (const g of report.normalized_lineage_groups) io.print(`${g.normalized_sha256.slice(0, 12)}: ` + g.revisions.join(", "));
    if (report.anomalies.length) io.print("one-revision anomalies: " + report.anomalies.join(", "));
    io.print(`proof: ${report.proof}`);
  }
  return 0;
}

export const COMMAND_SPECS = [
  {
    path: ["fingerprint-toolchain"], handler: fingerprintToolchainCommand,
    help: "identify compiler/frontend behavior with redistributable microcases",
    mutex: [{ required: true, dests: ["compile_command", "compare"] }],
    arguments: [
      { flags: ["--compile-command"], help: "wrapper template containing {source} and {output}" },
      { flags: ["--compare"], nargs: 2, metavar: ["TARGET_JSON", "CANDIDATE_JSON"] },
      { flags: ["--compile-cwd"], default: "." },
      { flags: ["--env"], action: "append", default: [] },
      { flags: ["--objdump"] },
      { flags: ["--timeout"], type: "float", default: 120.0 },
      { flags: ["--stream-limit"], type: "int", default: 64 * 1024 },
      { flags: ["--artifact-dir"] },
      { flags: ["--output"] },
      { flags: ["--json"], action: "store_true", help: "emit JSON" },
    ],
  },
  {
    path: ["lineage"], handler: lineageCommand,
    help: "compare one symbol across object revisions without reading ROMs",
    arguments: [
      { dest: "revisions", nargs: "+", metavar: "LABEL=OBJECT" },
      { flags: ["--symbol"], required: true },
      { flags: ["--section"], default: ".text" },
      { flags: ["--objdump"] },
      { flags: ["--rom-hash"], action: "append", default: [], metavar: "LABEL=SHA256", help: "record a caller-supplied ROM identity without reading ROM data" },
      { flags: ["--json"], action: "store_true", help: "emit JSON" },
    ],
  },
];
