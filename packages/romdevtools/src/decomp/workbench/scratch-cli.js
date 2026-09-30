// scratch-cli.js - the scratch handoff commands: check-scratch (inspect or
// site-faithfully compile a decomp.me export), doctor (local readiness),
// install-skill (the bundled Agent Skill) and bundle-scratch (an
// upload-neutral bundle for manual scratch creation).
//
// Plain JS ESM + JSDoc.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dumps } from "./pyjson.js";
import { ValueError, isInputError, osErrorText, sorted, splitlines, strip, fixed } from "./py.js";
import { isReportedError, RuntimeError } from "./py-extra.js";
import { formatG } from "./globalcolor.js";
import { loadScratch, scratchFrontend, composeSiteSource, scratchContextHardening, scratchScore, siteSourceMarker } from "./scratch-check.js";
import { bundleScratch } from "./scratch-bundle.js";
import { installAgentSkill } from "./agent-skill.js";
import { errorReport } from "./reporting.js";
import { displayPath } from "./model.js";
import * as O from "./cli-options.js";

export const WORKBENCH_VERSION = "0.8.0";

/** A site-faithful compile failed after producing reproducibility evidence. */
export class ScratchCompileFailure extends RuntimeError {
  constructor(message, report) { super(message); this.name = "ScratchCompileFailure"; this.report = report; }
}

const reportable = (e) => isInputError(e) || isReportedError(e) || e?.name === "OSError" || e?.name === "RuntimeError";
const text = (e) => (e && typeof e.code === "string" && /^E[A-Z]+$/.test(e.code) ? osErrorText(e) : e.message);
const expand = (p) => (p === "~" || String(p).startsWith("~/") ? os.homedir() + String(p).slice(1) : String(p));
const resolveIn = (ctx, p) => { const a = path.resolve(ctx.cwd, expand(p)); try { return fs.realpathSync(a); } catch { return a; } };
const now = () => performance.now() / 1000;

export async function bundleScratchCommand(args, io, ctx) {
  let result;
  try {
    result = bundleScratch(ctx.resolve(args.output), {
      target_assembly: ctx.resolve(args.target_assembly), context: ctx.resolve(args.context), source: ctx.resolve(args.source),
      platform: args.platform, compiler: args.compiler, compiler_flags: args.compiler_flags, diff_label: args.diff_label,
      project: args.project, preset: args.preset, compiler_id: args.compiler_id, language: args.language });
  } catch (e) {
    if (!reportable(e)) throw e;
    io.eprint(`error: ${text(e)}`);
    return 2;
  }
  if (args.json) io.print(dumps(result.manifest));
  else io.print(`scratch bundle: ${result.output}`);
  return 0;
}

/** Object comparison entry points, replaceable by tests that have no real objects. */
export const seams = {
  compareObjects: async (...a) => (await import("./compare.js")).compareObjects(...a),
  diagnoseObjects: async (...a) => (await import("./diagnosis.js")).diagnoseObjects(...a),
};

/** Compile when requested, then select the strongest bundled evidence. */
async function scratchComparison(pkg, args, workspace, ctx) {
  const { compareInstructions } = await import("./compare.js");
  const { diagnoseInstructions } = await import("./diagnosis.js");
  const { parseDisassembly } = await import("./objdump.js");
  let symbol = args.symbol;
  if (symbol === null && typeof pkg.metadata.diff_label === "string") symbol = pkg.metadata.diff_label;
  const shown = (p) => displayPath(p, ctx.cwd);
  let compileReport = null;
  let candidateObject = null;
  if (args.compile_command) {
    const campaign = await import("./campaign.js");
    const { parseEnvironment } = await import("./environment.js");
    const { captureStreams } = await import("./artifacts.js");
    if (pkg.kind !== "decomp.me-export") throw new ValueError("site-faithful compilation requires a decomp.me export");
    if (!pkg.files.has("target.o")) throw new ValueError("site-faithful compilation needs target.o in the export");
    const frontend = scratchFrontend(pkg);
    const composed = path.join(workspace, frontend.source_name);
    fs.writeFileSync(composed, Buffer.from(composeSiteSource(pkg, args.source ? resolveIn(ctx, args.source) : null), "utf8"));
    const output = path.join(workspace, "compiled.o");
    const command = campaign.renderCompileCommand(args.compile_command, composed, output);
    const environment = parseEnvironment(args.env);
    const compileCwd = args.compile_cwd ? resolveIn(ctx, args.compile_cwd) : resolveIn(ctx, ".");
    let isDir = false;
    try { isDir = fs.statSync(compileCwd).isDirectory(); } catch { isDir = false; }
    if (!isDir) throw new ValueError(`compile working directory is not a directory: ${compileCwd}`);
    const started = now();
    const common = () => ({
      working_directory: compileCwd, explicit_environment: environment,
      compiler: campaign.executableIdentity(command, { cwd: compileCwd }), timeout_seconds: args.timeout,
      source: args.source ? "override" : "exported code.c", composed_source_sha256: campaign.fileSha256(composed),
      site_line_reset: frontend.line_reset, frontend,
    });
    let proc;
    try {
      proc = await campaign.runCompiler(command, { compile_cwd: compileCwd, environment, timeout: args.timeout });
    } catch (e) {
      if (!(e instanceof campaign.CompilerTimeoutError)) throw e;
      const streams = captureStreams(e.stdout, e.stderr, { limit: args.stream_limit, artifact_dir: args.artifact_dir, stem: "scratch-compile" });
      const timeoutReport = { command, returncode: 124, stdout: streams.stdout, stderr: streams.stderr, stdout_bytes: streams.stdout_bytes,
        stderr_bytes: streams.stderr_bytes, stdout_truncated: streams.stdout_truncated, stderr_truncated: streams.stderr_truncated,
        artifacts: streams.artifacts, duration_seconds: now() - started, ...common() };
      throw new ScratchCompileFailure(e.message, timeoutReport);
    }
    compileReport = { command, returncode: proc.returncode, duration_seconds: now() - started, ...common() };
    const streams = captureStreams(proc.stdout, proc.stderr, { limit: args.stream_limit, artifact_dir: args.artifact_dir, stem: "scratch-compile" });
    Object.assign(compileReport, { stdout: streams.stdout, stderr: streams.stderr, stdout_bytes: streams.stdout_bytes, stderr_bytes: streams.stderr_bytes,
      stdout_truncated: streams.stdout_truncated, stderr_truncated: streams.stderr_truncated, artifacts: streams.artifacts });
    if (proc.returncode) {
      const detail = strip(streams.stderr) || strip(streams.stdout);
      throw new ScratchCompileFailure(`compiler failed with exit ${proc.returncode}: ${detail || "no diagnostic"}`, compileReport);
    }
    if (!fs.existsSync(output)) throw new RuntimeError(`compiler succeeded but did not create ${output}`);
    candidateObject = output;
    if (args.keep_composed) {
      const destination = resolveIn(ctx, args.keep_composed);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(composed, destination);
      compileReport.retained_source = destination;
    }
    if (args.keep_object) {
      const destination = resolveIn(ctx, args.keep_object);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(output, destination);
      compileReport.retained_object = destination;
    }
  }
  const objectPair = async (target, candidate) => {
    if (args.view) {
      const d = await seams.diagnoseObjects(target, candidate, { objdump: args.objdump, symbol, section: args.section, register_profile: args.register_profile, cwd: ctx.cwd, env: ctx.env });
      return [d.comparison, d.view];
    }
    return [await seams.compareObjects(target, candidate, { objdump: args.objdump, symbol, section: args.section, cwd: ctx.cwd, env: ctx.env }), null];
  };
  if (candidateObject !== null) {
    const targetObject = pkg.materialize("target.o", workspace);
    const [comparison, view] = await objectPair(targetObject, candidateObject);
    comparison.target = `${shown(pkg.path)}:target.o`;
    comparison.candidate = args.source ? shown(args.source) : `${shown(pkg.path)}:code.c`;
    return [comparison, view, compileReport, "compiled-site-source-vs-target-object"];
  }
  if (pkg.files.has("target.o") && pkg.files.has("current.o")) {
    const targetObject = pkg.materialize("target.o", workspace);
    const currentObject = pkg.materialize("current.o", workspace);
    const [comparison, view] = await objectPair(targetObject, currentObject);
    comparison.target = `${shown(pkg.path)}:target.o`;
    comparison.candidate = `${shown(pkg.path)}:current.o`;
    return [comparison, view, compileReport, "exported-objects"];
  }
  const dumpPair = [["target.objdump", "current.objdump"], ["target.objdump", "candidate.objdump"]].find((pair) => pair.every((n) => pkg.files.has(n)));
  if (dumpPair) {
    const target = parseDisassembly(pkg.text(dumpPair[0]), { symbol });
    const candidate = parseDisassembly(pkg.text(dumpPair[1]), { symbol });
    if (!target.length || !candidate.length) {
      const detail = symbol ? ` for symbol '${symbol}'` : "";
      throw new ValueError(`both retained dumps must contain GNU-style objdump instruction lines${detail}`);
    }
    const targetName = `${shown(pkg.path)}:${dumpPair[0]}`, candidateName = `${shown(pkg.path)}:${dumpPair[1]}`;
    if (args.view) {
      const d = diagnoseInstructions(target, candidate, { target_name: targetName, candidate_name: candidateName, symbol, register_profile: args.register_profile });
      return [d.comparison, d.view, compileReport, "retained-objdump-text"];
    }
    return [compareInstructions(target, candidate, { target_name: targetName, candidate_name: candidateName, symbol }), null, compileReport, "retained-objdump-text"];
  }
  return [null, null, compileReport, "no-comparable-object-or-dump-pair"];
}

function scratchNextActions(pkg, comparison, evidence, render) {
  if (comparison !== null && comparison.exact) {
    const [scoreExact] = render.scratchScoreAcceptance(comparison);
    if (!scoreExact) {
      return ["The function is relocation-normalized exact, but the local decomp.me score proxy still fails. Match both raw instruction words and relocation symbol/addend targets before claiming 100%."];
    }
    return ["Run the project's normal link/ROM and collateral verification; function exactness is not whole-project proof."];
  }
  if (comparison !== null) return [...comparison.guidance];
  if (pkg.kind === "workbench-bundle") return ["Create the scratch manually from README.md; the checksums are valid.", "Download a decomp.me export afterward and run check-scratch on it."];
  if (evidence === "no-comparable-object-or-dump-pair") {
    return ["Export target.o/current.o from decomp.me, or add target.objdump/current.objdump for a compiler-free comparison.",
      "Pass --compile-command to verify code.c with decomp.me's line-reset semantics when target.o is present."];
  }
  return [];
}

/** Inspect an export and report decomp.me context beside workbench truth. */
export async function checkScratchCommand(args, io, ctx) {
  if (args.source && !args.compile_command) { io.eprint("error: --source requires --compile-command"); return 2; }
  if (args.project_source && !args.project_object) { io.eprint("error: --project-source requires --project-object"); return 2; }
  if (args.timeout <= 0) { io.eprint("error: --timeout must be positive"); return 2; }
  if (args.stream_limit < 0) { io.eprint("error: --stream-limit must be non-negative"); return 2; }
  const render = await import("./comparison-render.js");
  let pkg, projectComparison = null, hypotheses = [], comparison, view, compileReport, evidence;
  try {
    pkg = loadScratch(resolveIn(ctx, args.scratch));
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "decomp-workbench-scratch-"));
    try {
      [comparison, view, compileReport, evidence] = await scratchComparison(pkg, args, workspace, ctx);
      if (args.project_object) {
        if (!pkg.files.has("target.o")) throw new ValueError("--project-object requires target.o in the scratch export");
        const targetObject = pkg.materialize("target.o", workspace);
        const symbol = args.symbol || (typeof pkg.metadata.diff_label === "string" ? pkg.metadata.diff_label : null);
        const projectObject = resolveIn(ctx, args.project_object);
        if (args.view) {
          projectComparison = (await seams.diagnoseObjects(targetObject, projectObject, { objdump: args.objdump, symbol, section: args.section, register_profile: args.register_profile, cwd: ctx.cwd, env: ctx.env })).comparison;
        } else {
          projectComparison = await seams.compareObjects(targetObject, projectObject, { objdump: args.objdump, symbol, section: args.section, cwd: ctx.cwd, env: ctx.env });
        }
        projectComparison.target = `${displayPath(pkg.path, ctx.cwd)}:target.o`;
        projectComparison.candidate = displayPath(args.project_object, ctx.cwd);
      }
      const { callContractHypotheses } = await import("./context-truth.js");
      hypotheses = await callContractHypotheses({ package: pkg, scratch: comparison, view, project: projectComparison,
        project_source: args.project_source ? resolveIn(ctx, args.project_source) : null, frontend: scratchFrontend(pkg) });
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  } catch (e) {
    if (e instanceof ScratchCompileFailure) {
      if (args.json) {
        const report = errorReport("check-scratch", { status: 2, stage: "compile", message: e.message, details: { returncode: e.report.returncode ?? null } });
        report.compile = e.report;
        io.print(dumps(report));
      } else io.eprint(`error: ${e.message}`);
      return 2;
    }
    if (!reportable(e)) throw e;
    io.eprint(`error: ${text(e)}`);
    return 2;
  }
  const score = pkg.kind === "decomp.me-export" ? scratchScore(pkg.metadata) : null;
  const actions = scratchNextActions(pkg, comparison, evidence, render);
  if (hypotheses.length) actions.unshift(String(hypotheses[0].action));
  const hardening = await scratchContextHardening(pkg);
  const frontend = scratchFrontend(pkg);
  const { buildTruthStack, truthStackLines } = await import("./context-truth.js");
  const truth = buildTruthStack({ external_score: score, scratch: comparison, project: projectComparison, hypotheses });
  const payload = {
    schema: "decomp-workbench-scratch-check-v1",
    scratch: { path: displayPath(pkg.path, ctx.cwd), kind: pkg.kind, files: sorted([...pkg.files.keys()]), metadata: pkg.publicMetadata(), checksums_valid: pkg.checksums_valid },
    external_score: score,
    evidence,
    source_semantics: { site_faithful: !!args.compile_command, line_reset: args.compile_command ? frontend.line_reset : null, source_name: frontend.source_name, frontend },
    context_hardening: hardening,
    truth_layers: truth.layers,
    context_differential: truth.context_differential,
    context_hypotheses: truth.context_hypotheses,
    truth,
    comparison: comparison !== null ? render.scratchComparisonPayload(comparison) : null,
    view: view !== null ? view.asDict({ report_regs: args.report_regs }) : null,
    compile: compileReport,
    project_comparison: projectComparison !== null ? render.scratchComparisonPayload(projectComparison) : null,
    next_actions: actions,
  };
  if (args.json) io.print(dumps(payload));
  else {
    if (args.project_object || hypotheses.length) for (const line of truthStackLines(truth)) io.print(line);
    io.print(`scratch: ${pkg.kind} (${displayPath(pkg.path, ctx.cwd)})`);
    if (comparison !== null) {
      for (const line of render.warningLines(comparison.warnings)) io.print(line);
      io.print("acceptance: " + render.scratchAcceptanceLine(comparison));
    }
    const metadata = pkg.publicMetadata();
    const identity = metadata.name || metadata.project, slug = metadata.slug;
    if (identity || slug) io.print("identity: " + [identity, slug].filter(Boolean).map(String).join(" / "));
    io.print("files: " + sorted([...pkg.files.keys()]).join(", "));
    const frontendParts = [
      frontend.compiler_id ? `compiler_id=${frontend.compiler_id}` : frontend.compiler ? `compiler_selection=${frontend.compiler}` : null,
      frontend.language ? `language=${frontend.language}` : null,
      frontend.frontend ? `frontend=${frontend.frontend}` : null,
      frontend.expected_driver ? `driver=${frontend.expected_driver}` : null,
    ];
    if (frontendParts.some(Boolean)) io.print("frontend: " + frontendParts.filter(Boolean).join(", "));
    if (pkg.checksums_valid) io.print("integrity: PASS (all workbench bundle checksums)");
    if (hardening.applicable) {
      for (const d of hardening.duplicate_symbols) {
        io.print(`warning: ${d.symbol} is defined in both ctx.c (line ${d.ctx_line}) and code.c (line ${d.code_line}); keep the file-scope definition in exactly one of them`);
      }
      const splices = hardening.code_splices;
      for (const n of splices.broken) {
        io.print(`warning: code.c line ${n} ends in a backslash followed by whitespace -- that is not a line splice, the statements compile untied; delete the trailing whitespace or put both statements on one physical line`);
      }
      if (splices.load_bearing.length) {
        io.print(`note: code.c splices statements onto one logical line at line(s) ${splices.load_bearing.join(", ")}; if these ties are load-bearing (guide lever 25), re-check them after every paste -- whitespace-trimming editors and formatters strip them silently, and the one-physical-line form travels better`);
      }
      const findings = hardening.context_lint.findings;
      if (findings.length) {
        io.print(`context lint: ${findings.length} finding(s) in ctx.c/code.c`);
        for (const f of findings) {
          io.print(`  [${String(f.severity).toUpperCase()}] ${f.kind} ${f.source}:${f.line}  #${f.directive} ${f.expression}`);
          io.print(`    do: ${f.action}`);
        }
      } else io.print("context lint: no undefined-identifier collapse found in ctx.c/code.c");
    }
    if (score !== null) io.print(`decomp.me display: score=${formatG(score.score)}/${formatG(score.max_score)} (${fixed(score.percentage, 5)}%; context only)`);
    io.print(`evidence: ${evidence}`);
    if (args.compile_command) io.print(`source composition: site-faithful (inserted ${strip(siteSourceMarker(pkg))} between ctx.c and candidate source)`);
    if (comparison === null) io.print("comparison: unavailable");
    else {
      io.print(render.comparisonLine(comparison));
      const [scoreExact] = render.scratchScoreAcceptance(comparison);
      if (scoreExact) io.print("decomp.me score proxy: PASS (raw instruction words and relocation targets agree)");
      else if (comparison.exact) {
        const reasons = [];
        if (comparison.raw_word_mismatches) reasons.push(`${comparison.raw_word_mismatches} raw word(s) differ`);
        if (comparison.relocation_target_mismatches) reasons.push(`${comparison.relocation_target_mismatches} relocation target(s) differ`);
        io.print("decomp.me score proxy: FAIL (" + reasons.join("; ") + "; linked-function exact is not a 100% site score)");
      }
      if (view === null) for (const line of render.comparisonExplanationLines(comparison, { cross_rom: false })) io.print(line);
      else for (const line of render.relocationTargetDifferenceLines(comparison)) io.print(line);
      if (args.show_diff) for (const line of render.diffSiteLines(comparison)) io.print(line);
      if (view !== null) {
        const { renderView } = await import("./view-cli.js");
        const { Painter, resolveColor } = await import("./terminal.js");
        io.print("");
        for (const line of renderView(view, { context: args.context, max_hunks: args.show_all ? 0 : args.max_hunks,
          lane_window: args.show_all ? Math.max(view.target_instructions, view.candidate_instructions) : args.lane_window,
          report_regs: args.report_regs, painter: new Painter(resolveColor(args.color, { env: ctx.env, isatty: !!ctx.terminal?.isTTY })) })) io.print(line);
      }
    }
    if (projectComparison !== null) io.print("project comparison: " + render.comparisonLine(projectComparison));
    if (comparison === null || (comparison.exact && !render.scratchScoreAcceptance(comparison)[0])) for (const a of actions) io.print(`next: ${a}`);
  }
  const mismatch = comparison === null || !render.scratchScoreAcceptance(comparison)[0];
  return args.fail_on_mismatch && mismatch ? 1 : 0;
}

/** Explain local readiness and validate an optional scratch handoff. */
export async function doctorCommand(args, io, ctx) {
  const { discoverObjdump, probeObjdump, dumpObject } = await import("./objdump.js");
  let objdumpPath = null, objdumpError = null, objdumpVersion = null, objdumpChecks = {};
  try {
    objdumpPath = discoverObjdump(args.objdump, { cwd: ctx.cwd, env: ctx.env });
    const probe = probeObjdump(objdumpPath, { env: ctx.env });
    objdumpVersion = probe.version;
    objdumpChecks = probe.checks instanceof Map ? Object.fromEntries(probe.checks) : { ...probe.checks };
    if (!probe.compatible) { objdumpError = `objdump is not GNU/MIPS compatible: ${objdumpPath} (${probe.error})`; objdumpPath = null; }
  } catch (e) {
    if (e?.name === "FileNotFoundError" || e?.name === "RuntimeError") objdumpError = e.message;
    else if (reportable(e)) { objdumpError = `could not query objdump: ${text(e)}`; objdumpPath = null; }
    else throw e;
  }
  let pkg = null;
  if (args.scratch) {
    try { pkg = loadScratch(resolveIn(ctx, args.scratch)); } catch (e) {
      if (!reportable(e)) throw e;
      io.eprint(`error: ${text(e)}`);
      return 2;
    }
  }
  const objectRequired = !!(pkg && pkg.files.has("target.o"));
  let objectVerified = false;
  if (pkg && objdumpPath && pkg.files.has("target.o")) {
    const symbol = typeof pkg.metadata.diff_label === "string" ? pkg.metadata.diff_label : null;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "decomp-workbench-doctor-"));
    try {
      const target = pkg.materialize("target.o", tmp);
      dumpObject(target, { objdump: objdumpPath, symbol, cwd: ctx.cwd, env: ctx.env });
      objectVerified = true;
    } catch (e) {
      if (!reportable(e)) throw e;
      objdumpError = `object reader failed the supplied target.o: ${text(e)}`;
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  }
  const { cacheStatus, formatBytes } = await import("./cache.js");
  const cache = resolveIn(ctx, args.cache_dir);
  let cacheError = null, cacheFiles = 0, cacheBytes = 0;
  try {
    const report = cacheStatus(cache);
    cacheFiles = Number(report.files); cacheBytes = Number(report.bytes);
  } catch (e) {
    if (!reportable(e)) throw e;
    cacheFiles = 0; cacheBytes = 0; cacheError = text(e);
  }
  const cacheLarge = cacheBytes >= 1024 * 1024 * 1024;
  const objectStatus = objectVerified ? "verified" : objdumpPath && !objectRequired ? "ready" : "limited";
  let preflight = null, toolchain = null;
  if (args.toolchain) {
    const { toolchainStatus } = await import("./toolchain.js");
    try { toolchain = toolchainStatus(resolveIn(ctx, args.toolchain)); } catch (e) {
      if (!reportable(e)) throw e;
      io.eprint(`error: ${text(e)}`);
      return 2;
    }
  }
  if (args.compile_command) {
    try {
      const { parseEnvironment, mergeToolchainEnvironment } = await import("./environment.js");
      let environment = parseEnvironment(args.env);
      if (args.toolchain) environment = await mergeToolchainEnvironment(environment, resolveIn(ctx, args.toolchain));
      const compileCwd = args.compile_cwd ? resolveIn(ctx, args.compile_cwd) : resolveIn(ctx, ".");
      const { compilePreflight } = await import("./preflight.js");
      preflight = await compilePreflight(args.compile_command, { compile_cwd: compileCwd, environment, timeout: args.timeout, objdump: objdumpPath,
        stream_limit: args.stream_limit, artifact_dir: args.artifact_dir });
    } catch (e) {
      if (!reportable(e)) throw e;
      io.eprint(`error: ${text(e)}`);
      return 2;
    }
  }
  const nodeVersion = process.versions.node;
  const payload = {
    schema: "decomp-workbench-doctor-v1",
    workbench_version: WORKBENCH_VERSION,
    runtime: `node ${nodeVersion}`,
    runtime_supported: Number(nodeVersion.split(".")[0]) >= 20,
    working_directory: resolveIn(ctx, "."),
    cache: { path: displayPath(cache, ctx.cwd), exists: fs.existsSync(cache) && fs.statSync(cache).isDirectory(), files: cacheFiles, bytes: cacheBytes, large: cacheLarge, error: cacheError },
    dump_workflow: "ready",
    object_workflow: { status: objectStatus, objdump: objdumpPath, version: objdumpVersion, capabilities: objdumpChecks, error: objdumpError },
    scratch: pkg ? { path: displayPath(pkg.path, ctx.cwd), kind: pkg.kind, files: sorted([...pkg.files.keys()]), checksums_valid: pkg.checksums_valid } : null,
    compile_preflight: preflight,
    toolchain,
  };
  if (args.json) io.print(dumps(payload));
  else {
    io.print(`decomp-workbench ${WORKBENCH_VERSION}`);
    io.print(`${payload.runtime}: ${payload.runtime_supported ? "READY" : "UNSUPPORTED"}`);
    io.print("retained objdump workflow: READY (no compiler or object reader needed)");
    if (objectStatus === "verified") io.print(`object workflow: VERIFIED (${objdumpPath})`);
    else if (objectStatus === "ready") {
      io.print(`object workflow: READY (${objdumpPath})`);
      io.print("object format support: VERIFIED (GNU syntax, MIPS ELF + relocations)");
    } else { io.print("object workflow: LIMITED"); io.print(`  ${objdumpError}`); }
    const cacheLabel = cacheError ? "UNREADABLE" : cacheLarge ? "LARGE" : "OK";
    io.print(`campaign cache: ${cacheLabel} - ${cacheFiles} file(s), ${formatBytes(cacheBytes)} (${cacheBytes} bytes; ${displayPath(cache, ctx.cwd)})`);
    if (cacheError) io.print(`  error: ${cacheError}`);
    if (cacheLarge) {
      io.print(`  next: decomp-workbench cache prune --max-size 1GiB --cache-dir ${shQuote(cache)}`);
      io.print("  note: this is a dry run; add --apply only after inspection");
    }
    if (pkg) {
      io.print(`scratch: VALID (${pkg.kind}; ${pkg.files.size} file(s))`);
      const command = ["decomp-workbench", "check-scratch", pkg.path];
      if (args.objdump) command.push("--objdump", args.objdump);
      io.print(`next: ${command.map(shQuote).join(" ")}`);
    }
    if (preflight) {
      io.print(`compiler preflight: ${preflight.ready ? "READY" : "FAILED"} (${preflight.status}, ${fixed(preflight.duration_seconds, 2)}s)`);
      if (!preflight.ready) {
        const diagnostic = splitlines(strip(String(preflight.stderr ?? "")));
        if (diagnostic.length) io.print(`  ${diagnostic[diagnostic.length - 1]}`);
      }
    }
    if (toolchain) {
      io.print(`toolchain: ${String(toolchain.claim).toUpperCase()} (integrity=${toolchain.integrity ? "PASS" : "FAIL"})`);
      const missing = toolchain.next_missing_gates;
      if (Array.isArray(missing) && missing.length) io.print("  missing gates: " + missing.map(String).join(", "));
    }
  }
  return (objectRequired && !objectVerified) || (args.objdump !== null && objdumpPath === null) || cacheError
    || (preflight !== null && !preflight.ready) || (toolchain !== null && (!toolchain.integrity || toolchain.claim !== "ready")) ? 1 : 0;
}

/** shlex.quote */
export function shQuote(s) {
  s = String(s);
  if (!s) return "''";
  if (/^[A-Za-z0-9@%+=:,./_-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, "'\"'\"'")}'`;
}

/** Install the bundled Agent Skill for one supported client. */
export async function installSkillCommand(args, io, ctx) {
  let p, status;
  try {
    [p, status] = installAgentSkill(args.client, { destination: args.destination ? resolveIn(ctx, args.destination) : null });
  } catch (e) {
    if (!reportable(e)) throw e;
    io.eprint(`error: ${text(e)}`);
    return 2;
  }
  const invocation = args.client === "codex" ? "$n64-decomp-campaign" : "/n64-decomp-campaign";
  if (args.json) io.print(dumps({ client: args.client, invocation, path: p, status }));
  else {
    io.print(`skill ${status === "installed" ? "installed" : "already current"}: ${p}`);
    io.print(`invoke with: ${invocation}`);
  }
  return 0;
}

const processArgs = O.processOutputArguments;

export const COMMAND_SPECS = [
  {
    path: ["check-scratch"], handler: checkScratchCommand,
    help: "inspect or site-faithfully compile a decomp.me export",
    description: "Validate an exported ZIP/directory, distinguish the site's display score from aligned object truth, and optionally compile context plus source with decomp.me's #line reset.",
    arguments: [
      { dest: "scratch", help: "decomp.me export ZIP/directory or workbench scratch bundle" },
      ...O.symbolArgument({ help: "compare this symbol; defaults to metadata.json's diff_label; --function is the same option" }),
      ...O.explainKeysArgument(),
      { flags: ["--compile-command"], help: "command template containing {source} and {output}" },
      { flags: ["--source"], help: "candidate code to place after ctx.c; defaults to exported code.c" },
      { flags: ["--project-object"], help: "object produced by the normal project translation unit; compare it against the same target without replacing scratch truth" },
      { flags: ["--project-source"], help: "optional project translation-unit source used only to qualify context/prototype hypotheses; requires --project-object" },
      { flags: ["--compile-cwd"], help: "working directory for the compiler" },
      { flags: ["--env"], action: "append", default: [], metavar: "NAME=VALUE", help: "compiler environment entry; repeatable" },
      { flags: ["--timeout"], type: "float", default: 120.0, help: "compiler timeout in seconds (default: 120)" },
      ...processArgs(),
      { flags: ["--keep-composed"], metavar: "PATH", help: "retain the exact context + line reset + source input" },
      { flags: ["--keep-object"], metavar: "PATH", help: "retain the newly compiled object" },
      { flags: ["--section"], default: ".text", help: "object section (default: .text)" },
      { flags: ["--objdump"], help: "GNU-compatible MIPS objdump; auto-detected when omitted" },
      { flags: ["--show-diff"], action: "store_true", help: "print every differing site, grouped by class" },
      { flags: ["--view"], action: "store_true", help: "include the aligned mechanism view from the same loaded evidence" },
      ...O.viewRenderArguments({ defaultMaxHunks: 1, showAllHelp: "with --view, render every hunk and the complete register lanes (overrides --max-hunks/--lane-window)" }),
      { flags: ["--fail-on-mismatch"], action: "store_true", help: "return exit 1 unless an available comparison is exact" },
      { flags: ["--json"], action: "store_true", help: "emit JSON" },
    ],
  },
  {
    path: ["doctor"], handler: doctorCommand,
    help: "check local readiness and validate an optional scratch",
    description: "Report runtime, retained-dump, and object-reader readiness; when a scratch is supplied, validate it and print the exact next command.",
    arguments: [
      { dest: "scratch", nargs: "?", help: "optional decomp.me export ZIP/directory or workbench bundle" },
      { flags: ["--objdump"], help: "GNU-compatible MIPS objdump; auto-detected when omitted" },
      { flags: ["--cache-dir"], default: ".decomp-workbench/cache", help: "campaign cache to inspect (default: .decomp-workbench/cache)" },
      { flags: ["--compile-command"], help: "preflight a wrapper template containing {source} and {output}" },
      { flags: ["--toolchain"], help: "verify a real-copy workbench toolchain and use it for preflight" },
      { flags: ["--compile-cwd"], help: "working directory for the preflight" },
      { flags: ["--env"], action: "append", default: [], metavar: "NAME=VALUE", help: "compiler environment entry for the preflight; repeatable" },
      { flags: ["--timeout"], type: "float", default: 120.0, help: "compiler preflight timeout in seconds (default: 120)" },
      ...processArgs(),
      { flags: ["--json"], action: "store_true", help: "emit JSON" },
    ],
  },
  {
    path: ["install-skill"], handler: installSkillCommand,
    help: "install the bundled N64 decomp Agent Skill",
    description: "Install n64-decomp-campaign for Codex or Claude Code. Existing differing installations are never overwritten.",
    arguments: [
      { dest: "client", choices: ["codex", "claude"] },
      { flags: ["--destination"], help: "parent skills directory; defaults to the selected client's personal skills directory" },
      { flags: ["--json"], action: "store_true", help: "emit JSON" },
    ],
  },
  {
    path: ["bundle-scratch"], handler: bundleScratchCommand,
    help: "package local inputs for manual decomp.me scratch creation",
    description: "Copy target assembly, context, and source into a deterministic upload-neutral scratch bundle.",
    arguments: [
      { dest: "output", help: "new or empty output directory" },
      { flags: ["--target-assembly"], required: true, help: "single-function GAS target" },
      { flags: ["--context"], required: true, help: "context C file" },
      { flags: ["--source"], required: true, help: "candidate source C file" },
      { flags: ["--platform"], required: true, help: "decomp.me platform" },
      { flags: ["--compiler"], required: true, help: "compiler identity" },
      { flags: ["--compiler-id"], help: "canonical decomp.me compiler id, distinct from the display label" },
      { flags: ["--language"], help: "decomp.me language selection (for example C or C++)" },
      { flags: ["--compiler-flags"], default: "", help: "compiler flags copied to the manifest" },
      { flags: ["--diff-label"], required: true, help: "target function label" },
      { flags: ["--project"], help: "optional project identity" },
      { flags: ["--preset"], help: "optional decomp.me preset identity" },
      { flags: ["--json"], action: "store_true", help: "emit manifest JSON" },
    ],
  },
];
