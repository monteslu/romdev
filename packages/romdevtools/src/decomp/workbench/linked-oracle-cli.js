// linked-oracle-cli.js - the linked-image oracle: `reloc-surface` (generate
// the placeholder symbol values an unrelocated module's link needs),
// `linked-compare` (classify the resulting image per function range) and
// `reloc-proof` (bind both surfaces into one hash-verified receipt). Nothing
// here builds; the host drives its own make (docs/linked-oracle.md).
//
// Plain JS ESM + JSDoc.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readElf } from "./elf.js";
import { EvidenceError, artifactRecord, loadJsonObject, writeJsonAtomic } from "./evidence.js";
import { compareImages, parseRangeArgument, parseRanges, render } from "./linked-compare.js";
import { audit, parseModuleMap, renderLinkerBlock, synthesize, trackedValues } from "./reloc-surface.js";
import { identityReport, parseIdentityProvider } from "./relocation-identity.js";
import { EVIDENCE_SCHEMA, buildRelocationProof, verifyRelocationProof } from "./relocation-proof.js";
import { dumps } from "./pyjson.js";
import { hex, isInputError, osErrorText } from "./py.js";
import { loadsJson } from "./json-error.js";

const SURFACE_DESCRIPTION = "Synthesize the linker values a module's placeholder symbols must carry, "
  + "by reading the stored addend at each relocation site from the target "
  + "image. A module that ships unrelocated stores addends, not addresses, so "
  + "for a candidate whose schedule already agrees at the site every value is "
  + "readable rather than derived by hand. Sites that disagree are refused by "
  + "name, with both values and every conflicting site: that is a schedule "
  + "divergence at the site, and no consistent addend exists there.";
const SURFACE_EPILOG = "example: decomp-workbench reloc-surface build/tu.c.o --module-map module.json --image target.z64";
const COMPARE_DESCRIPTION = "Compare a built image against the target image and classify each "
  + "function's byte range: exact, text-exact (the range agrees, something "
  + "outside it does not), text-differs N words, or size-differs. This is the "
  + "only sound oracle for code in a module that ships unrelocated, whose "
  + "calls no object-level score can reproduce. Exit status is 0 when every "
  + "range's own bytes agree and 1 otherwise.";
const COMPARE_EPILOG = "example: decomp-workbench linked-compare build/game.z64 target.z64 --range drawActive:0x1878b84:0x1878c40";

const expandUser = (p) => (p === "~" || p.startsWith("~/") ? os.homedir() + p.slice(1) : p);
const resolvePath = (p) => { const abs = path.resolve(expandUser(String(p))); try { return fs.realpathSync(abs); } catch { return abs; } };
const errorText = (e) => (e && typeof e.code === "string" && /^E[A-Z]+$/.test(e.code) ? osErrorText(e) : e.message);
const reportable = (e) => isInputError(e) || e instanceof SyntaxError;

function loadModuleMap(p) {
  const document = loadsJson(fs.readFileSync(expandUser(p), "utf8"));
  return parseModuleMap(document, { origin: p });
}

function auditLines(surface, report) {
  const lines = [
    `reloc-surface audit ${surface.module}`,
    `  objects         ${surface.objects.length}`,
    `  agree           ${report.agree}/${report.compared}`,
    `  disagree        ${report.disagree}`,
    `  untracked       ${report.count("untracked")} (the link defines these by other means)`,
    `  unreproduced    ${report.count("unreproduced")} (the synthesis did not reach these)`,
    `  conflicts       ${report.conflicts.length}`,
  ];
  for (const row of report.rows) {
    if (row.status === "disagree") lines.push(`  MISMATCH        ${row.name} tracked=0x${hex(row.tracked, 8)} synthesized=0x${hex(row.synthesized, 8)}`);
  }
  for (const c of report.conflicts) lines.push(`  UNRESOLVED      ${c.symbol}: ${c.detail}`);
  lines.push("  verdict         " + (report.ok ? "agrees" : "DISAGREES"));
  return lines;
}

export function relocSurfaceCommand(args, io) {
  let module, surface, identities, report;
  try {
    module = loadModuleMap(args.module_map);
    const image = fs.readFileSync(expandUser(args.image));
    surface = synthesize(args.object.map((p) => [resolvePath(p), readElf(p)]), module, image);
    identities = args.identity_provider
      ? identityReport(surface.sites, parseIdentityProvider(loadJsonObject(args.identity_provider, { where: "identity provider" }))) : null;
    report = args.audit ? audit(surface, trackedValues(fs.readFileSync(expandUser(args.audit), "utf8"))) : null;
  } catch (e) {
    if (!reportable(e)) throw e;
    io.eprint(`error: ${errorText(e)}`);
    return 2;
  }
  if (args.json) {
    const payload = surface.asDict();
    payload.evidence = {
      schema: EVIDENCE_SCHEMA, module: module.asDict(),
      artifacts: [artifactRecord(args.module_map, { role: "module-map" }), artifactRecord(args.image, { role: "target-image" }),
        ...args.object.map((p) => artifactRecord(p, { role: "candidate-object" })),
        ...(args.identity_provider ? [artifactRecord(args.identity_provider, { role: "identity-provider" })] : [])],
    };
    if (identities !== null) payload.identities = identities;
    if (!args.sites && identities === null) delete payload.sites;
    if (report !== null) payload.audit = report.asDict();
    io.print(dumps(payload));
  } else if (report !== null) io.print(auditLines(surface, report).join("\n"));
  else {
    io.print(renderLinkerBlock(surface).join("\n"));
    if (args.sites) {
      for (const s of surface.sites) {
        io.print(`/* site ${s.object} +0x${hex(s.object_offset, 4)} -> module 0x${hex(s.module_offset || 0)} ${s.kind} ${s.symbol}${s.note ? " " + s.note : ""} */`);
      }
    }
  }
  for (const warning of surface.warnings) io.eprint(`warning: ${warning}`);
  if (args.out) fs.writeFileSync(expandUser(args.out), renderLinkerBlock(surface).join("\n") + "\n", "utf8");
  if (report !== null) return report.ok ? 0 : 1;
  return surface.ok ? 0 : 1;
}

export function linkedCompareCommand(args, io) {
  let ranges = [], built, target;
  try {
    if (args.ranges) ranges.push(...parseRanges(loadsJson(fs.readFileSync(expandUser(args.ranges), "utf8")), { origin: args.ranges }));
    for (const text of args.range ?? []) ranges.push(parseRangeArgument(text));
    built = fs.readFileSync(expandUser(args.built));
    target = fs.readFileSync(expandUser(args.target));
  } catch (e) {
    if (!reportable(e)) throw e;
    io.eprint(`error: ${errorText(e)}`);
    return 2;
  }
  const comparison = compareImages(built, target, ranges, { built_name: String(args.built), target_name: String(args.target) });
  if (args.json) {
    const payload = comparison.asDict();
    payload.evidence = { schema: EVIDENCE_SCHEMA, artifacts: [artifactRecord(args.built, { role: "built-image" }), artifactRecord(args.target, { role: "target-image" }),
      ...(args.ranges ? [artifactRecord(args.ranges, { role: "range-map" })] : [])] };
    io.print(dumps(payload));
  } else io.print(render(comparison).join("\n"));
  return comparison.ok ? 0 : 1;
}

export function relocationProofCommand(args, io) {
  let report;
  try {
    if (args.verify) report = verifyRelocationProof(args.verify);
    else {
      const missing = [["--linked", args.linked], ["--symbol", args.symbol], ["--source", args.source], ["--candidate-object", args.candidate_object]]
        .filter(([, v]) => !v).map(([n]) => n);
      if (missing.length) throw new EvidenceError("building a relocation proof requires " + missing.join(", "));
      report = buildRelocationProof({ fallback_report: args.fallback, linked_report: args.linked, symbol: args.symbol, source: args.source, candidate_object: args.candidate_object });
      if (args.out) {
        const output = expandUser(args.out);
        if (fs.existsSync(output)) throw Object.assign(new Error(`refusing to overwrite receipt: ${output}`), { name: "FileExistsError", reported: true });
        writeJsonAtomic(output, report);
      }
    }
  } catch (e) {
    if (!(reportable(e) || e?.reported)) throw e;
    io.eprint(`error: ${errorText(e)}`);
    return 2;
  }
  if (args.json || !args.out) io.print(dumps(report));
  else io.print(`relocation proof: PASS -> ${expandUser(args.out)}`);
  const pass = "pass" in report ? report.pass : report.status === "PASS";
  return pass ? 0 : 1;
}

export const COMMAND_SPECS = [
  {
    path: ["reloc-surface"], handler: relocSurfaceCommand, defaults: { report_command: "reloc-surface" },
    help: "synthesize a module's placeholder symbol values from the image", description: SURFACE_DESCRIPTION, epilog: SURFACE_EPILOG,
    arguments: [
      { dest: "object", nargs: "+", help: "the module's compiled objects. Pass every object of the module the link consumes: a symbol another of them defines needs no value at all" },
      { flags: ["--module-map"], required: true, metavar: "FILE", help: "the module's section map and per-object text placement (JSON)" },
      { flags: ["--image"], required: true, metavar: "FILE", help: "the target image the module ships inside" },
      { flags: ["--audit"], metavar: "FILE", help: "replay an existing hand-written linker block against the result" },
      { flags: ["--out"], metavar: "FILE", help: "also write the generated block to this file" },
      { flags: ["--sites"], action: "store_true", help: "report every mapped relocation site" },
      { flags: ["--identity-provider"], metavar: "FILE", help: "project-generated relocation identity document; joins exact overlay/section/offset identities without teaching the workbench a game's atlas format" },
      { flags: ["--json"], action: "store_true", help: "emit JSON" },
    ],
  },
  {
    path: ["linked-compare"], handler: linkedCompareCommand, defaults: { report_command: "linked-compare" },
    help: "classify a built image against the target, per function range", description: COMPARE_DESCRIPTION, epilog: COMPARE_EPILOG,
    arguments: [
      { dest: "built", help: "the image the host just built" },
      { dest: "target", help: "the target image" },
      { flags: ["--range"], action: "append", metavar: "NAME:START:END", help: "one function's image range; repeatable. NAME:START+SIZE also works" },
      { flags: ["--ranges"], metavar: "FILE", help: "a JSON file of ranges, for a whole trial's worth of functions" },
      { flags: ["--json"], action: "store_true", help: "emit JSON" },
    ],
  },
  {
    path: ["reloc-proof"], handler: relocationProofCommand, defaults: { report_command: "reloc-proof" },
    help: "bind fallback relocation evidence to exact final linked bytes",
    description: "Compose two deliberately separate surfaces: a corroborated static relocation report with complete project-supplied identities, and an exact range in a promoted linked image. Every report and artifact is re-hashed; stale, ambiguous, or incomplete evidence is refused.",
    mutex: [{ required: true, dests: ["fallback", "verify"] }],
    arguments: [
      { flags: ["--fallback"], metavar: "REPORT", help: "JSON reloc-surface report" },
      { flags: ["--verify"], metavar: "RECEIPT", help: "rebuild and verify an existing receipt" },
      { flags: ["--linked"], metavar: "REPORT", help: "JSON linked-compare report" },
      { flags: ["--symbol"], help: "the exact linked range name" },
      { flags: ["--source"], help: "candidate source file to bind" },
      { flags: ["--candidate-object"], help: "candidate object to bind" },
      { flags: ["--out"], metavar: "FILE", help: "write a new receipt atomically" },
      { flags: ["--json"], action: "store_true", help: "emit JSON" },
    ],
  },
];
