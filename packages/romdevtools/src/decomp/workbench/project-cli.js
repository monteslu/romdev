// project-cli.js - `project init` (preview, or explicitly write, a portable
// project config), `project show`, and `project next/compare/diagnose/
// campaign`, which expand the configured inputs into the flat command and
// run it (or print it with --print-command).
//
// Plain JS ESM + JSDoc.

import path from "node:path";
import { dumps } from "./pyjson.js";
import { isInputError } from "./py.js";
import { osText, isOSError, resolvePath } from "./py-path.js";
import { splitCommand } from "./command-line.js";
import { groupListingSpec } from "./group-listing.js";
import { discoverProject, findProjectConfig, loadProjectConfig, renderProjectConfig, shlexJoin, withBuildOverrides,
  withObjectOverrides, writeProjectConfig } from "./project-config.js";

const reportable = (e) => isOSError(e) || isInputError(e);
const errText = (e) => (isOSError(e) && e.name !== "FileNotFoundError" ? osText(e) : e.message);
const configPath = (value, ctx) => (value ? resolvePath(value, ctx.cwd) : findProjectConfig(".", { cwd: ctx.cwd }));

export function projectInitCommand(args, io, ctx) {
  let discovery, rendered, output = null;
  try {
    discovery = withObjectOverrides(discoverProject(args.root, { cwd: ctx.cwd }), { target: args.target, candidate: args.candidate,
      symbol: args.symbol, objdump: args.objdump, input_mode: args.dumps ? "dumps" : "objects" });
    const command = args.compile_command ? splitCommand(args.compile_command) : null;
    discovery = withBuildOverrides(discovery, { command, cwd: args.compile_cwd, environment: args.env, inherit_env: args.inherit_env,
      compiler_id: args.compiler_id, frontend: args.frontend, language: args.language, driver: args.driver, backend: args.backend });
    rendered = renderProjectConfig(discovery);
    if (args.write) output = writeProjectConfig(discovery);
  } catch (e) { if (!reportable(e)) throw e; io.eprint(`error: ${errText(e)}`); return 2; }
  if (args.json) {
    const payload = discovery.asDict();
    payload.written = args.write ? output : null;
    payload.toml = rendered;
    io.print(dumps(payload));
  } else {
    io.print("Project discovery");
    for (const item of discovery.detected) io.print(`  ${item.kind}: ${item.path}`);
    if (!discovery.detected.length) io.print("  no objdiff, Splat, or supported build metadata detected");
    for (const w of discovery.warnings) io.print(`  caution: ${w}`);
    io.print("\nProposed configuration\n");
    io.write(rendered);
    if (args.write) io.print(`Written: ${output}`);
    else io.print("Preview only. Re-run with --write to create the file.");
  }
  return 0;
}

export function projectShowCommand(args, io, ctx) {
  let config;
  try { config = loadProjectConfig(configPath(args.config, ctx)); } catch (e) { if (!reportable(e)) throw e; io.eprint(`error: ${errText(e)}`); return 2; }
  if (args.json) io.print(dumps(config.asDict()));
  else {
    io.print(`Project: ${config.name || path.basename(config.root)}`);
    io.print(`Config: ${config.path}`);
    io.print(`Root: ${config.root}`);
    io.print(`Target: ${config.target || "not configured"}`);
    io.print(`Candidate: ${config.candidate || "not configured"}`);
    io.print(`Symbol: ${config.symbol || "whole section"}`);
    io.print(`Section: ${config.section}`);
    io.print(`Objdump: ${config.objdump || "auto-discover"}`);
    io.print("Compiler command: " + (config.build_command.length ? shlexJoin(config.build_command) : "not configured"));
    io.print(`Frontend: ${config.frontend || "not configured"}`);
    io.print(`Backend: ${config.backend || "not configured"}`);
  }
  return 0;
}

async function dispatch(argv, io, ctx) {
  const r = await ctx.runCommand(argv);
  if (r.stdout) io.write(r.stdout);
  if (r.stderr) io.ewrite(r.stderr);
  return r.code;
}

export function configuredObjectCommand(command) {
  return async (args, io, ctx) => {
    let argv;
    try {
      const config = loadProjectConfig(configPath(args.config, ctx));
      const extra = [...(args.arguments ?? [])];
      if (extra[0] === "--") extra.shift();
      argv = [...config.objectArgv(command), ...extra];
    } catch (e) { if (!reportable(e)) throw e; io.eprint(`error: ${errText(e)}`); return 2; }
    if (args.print_command) { io.print(shlexJoin(["decomp-workbench", ...argv])); return 0; }
    return dispatch(argv, io, ctx);
  };
}

export async function configuredCampaignCommand(args, io, ctx) {
  let argv;
  try {
    const config = loadProjectConfig(configPath(args.config, ctx));
    argv = config.campaignArgv(args.sources);
  } catch (e) { if (!reportable(e)) throw e; io.eprint(`error: ${errText(e)}`); return 2; }
  if (args.print_command) { io.print(shlexJoin(["decomp-workbench", ...argv])); return 0; }
  return dispatch(argv, io, ctx);
}

const CONFIG = { flags: ["--config"], help: "config path; otherwise search parents" };
const PRINT = { flags: ["--print-command"], action: "store_true", help: "print the exact expanded command without running it" };

const SUBS = [
  { path: ["project", "init"], help: "preview or write project configuration", handler: projectInitCommand, defaults: { report_command: "project-init" },
    arguments: [
      { dest: "root", nargs: "?", default: ".", help: "project root" },
      { flags: ["--target"], help: "target object, relative to the project root" },
      { flags: ["--candidate"], help: "candidate object, relative to the project root" },
      { flags: ["--symbol"], help: "function symbol for object commands" },
      { flags: ["--objdump"], help: "explicit compatible objdump executable" },
      { flags: ["--dumps"], action: "store_true", help: "target and candidate are retained GNU objdump text, not objects" },
      { flags: ["--compile-command"], help: "compile-one argv template containing {source} and {output}" },
      { flags: ["--compile-cwd"], help: "compiler working directory" },
      { flags: ["--env"], action: "append", default: [], metavar: "NAME=VALUE", help: "fixed compiler environment value; repeatable" },
      { flags: ["--inherit-env"], action: "append", default: [], metavar: "NAME", help: "host environment name to record and inherit; repeatable" },
      { flags: ["--compiler-id"], help: "canonical compiler identity" },
      { flags: ["--frontend"], help: "frontend lineage, such as IRIX 4.1 accom" },
      { flags: ["--language"], help: "source language/dialect identity" },
      { flags: ["--driver"], help: "compiler driver identity" },
      { flags: ["--backend"], help: "backend/pass lineage identity" },
      { flags: ["--write"], action: "store_true", help: "create .decomp-workbench.toml; never overwrite" },
      { flags: ["--json"], action: "store_true", help: "emit discovery and proposed TOML as JSON" },
    ] },
  { path: ["project", "show"], help: "show resolved, validated project defaults", handler: projectShowCommand, defaults: { report_command: "project-show" },
    arguments: [CONFIG, { flags: ["--json"], action: "store_true", help: "emit JSON" }] },
  { path: ["project", "campaign"], help: "run a campaign with configured target, build, environment, and lineage", handler: configuredCampaignCommand,
    defaults: { report_command: "project-campaign" },
    arguments: [{ dest: "sources", nargs: "+", help: "full-TU candidate sources" }, CONFIG, PRINT] },
  ...["next", "compare", "diagnose"].map((name) => ({
    path: ["project", name], help: `run ${name} with configured target, candidate, symbol, and objdump`, handler: configuredObjectCommand(name),
    defaults: { report_command: `project-${name}` },
    arguments: [CONFIG, PRINT, { dest: "arguments", nargs: "...", default: [], help: `additional ${name} options (place after --)` }],
  })),
];

export const COMMAND_SPECS = [
  groupListingSpec(["project"], { help: "discover and use durable project defaults",
    description: "Preview conservative metadata discovery, write a portable project config explicitly, or run common object commands from it.",
    subcommands: SUBS, required: false }),
  ...SUBS,
];
