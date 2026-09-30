// oracle-cli.js - the `oracle` group: plan a phase-complete force grid from
// one allocator trace, diff two traces by stable web provenance, compile the
// grid (sweep) or one force set (force) through the campaign engine with
// durable state, and render or export the persisted sweep. Oracle evidence
// bounds a compiler decision; it never proves source originality.
//
// Plain JS ESM + JSDoc.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { DEFAULT_STREAM_LIMIT } from "./artifacts.js";
import { executableIdentity, fileSha256, renderCompileCommand, resolvePath } from "./campaign.js";
import { mergeToolchainEnvironment, parseEnvironment } from "./environment.js";
import { parseGlobalcolorTrace } from "./globalcolor.js";
import { documentShell, escapeHtml } from "./html-report.js";
import { parseForceSpecification } from "./instrument-uopt.js";
import { discoverObjdump } from "./objdump.js";
import { oracleDiff, oraclePlan, runOracleCampaign } from "./oracle.js";
import { toolchainStatus } from "./toolchain.js";
import { readTraceText } from "./trace-source.js";
import { ArgumentTypeError } from "./argparse.js";
import { listingSpec } from "./cli.js";
import * as O from "./cli-options.js";
import { dumps } from "./pyjson.js";
import { isReportedError, OSError } from "./py-extra.js";
import { ValueError, pyInt, strRepr, sorted, isInputError, osErrorText } from "./py.js";

const DASH = "\u2014";

/** `--colors-p1 c1,c2` (or 1,2), each in c0..c63. */
export function parseColors(value) {
  const result = [];
  for (const entry of value.split(",")) {
    let text = entry.trim().toLowerCase();
    if (text.startsWith("c")) text = text.slice(1);
    let color;
    try { color = pyInt(text, 0); } catch { throw new ArgumentTypeError(`invalid color ${strRepr(entry)}; use c1,c2 or 1,2`); }
    if (color < 0 || color > 63) throw new ArgumentTypeError("colors must be in c0..c63");
    result.push(color);
  }
  if (!result.length) throw new ArgumentTypeError("color list must not be empty");
  return result;
}
parseColors.displayName = "_colors";

const errorText = (e) => (e && typeof e.code === "string" && /^E[A-Z]+$/.test(e.code) ? osErrorText(e) : String(e?.message ?? e));
const reportable = (e) => isReportedError(e) || isInputError(e) || e instanceof SyntaxError;

function load(p, io, ctx) {
  return parseGlobalcolorTrace(readTraceText(ctx.resolve(p), { warn: (n) => io.eprint(`warning: ${n}`) }));
}

const overridesOf = (args) => Object.fromEntries([["p1", args.colors_p1], ["p2", args.colors_p2]].filter(([, v]) => v !== null && v !== undefined));

export function oraclePlanCommand(args, io, ctx) {
  let report;
  try {
    report = oraclePlan(load(args.trace, io, ctx), { proc: args.proc, colors: overridesOf(args), include_split: !args.no_split });
  } catch (e) {
    if (!reportable(e)) throw e;
    io.eprint(`error: ${errorText(e)}`);
    return 2;
  }
  if (args.json) io.print(dumps(report));
  else {
    const { p1, p2 } = report.coverage;
    io.print(`oracle plan: p1 ${p1.webs} web(s), ${p1.forces} force(s); p2 ${p2.webs} web(s), ${p2.forces} force(s)`);
    io.print(`total: ${report.force_count} diagnostic force build(s)`);
    const a = report.source_attribution;
    io.print(`source attribution: ${a.classification} (${a.source_attributed_webs} source-attributed, ${a.run_local_unattributed_webs} run-local web(s))`);
    if (a.next_gate) io.print(`next gate: ${a.next_gate}`);
    for (const w of report.warnings) io.print(`warning: ${w}`);
    io.print(`proof: ${report.proof}`);
  }
  return report.force_count ? 0 : 1;
}

export function oracleDiffCommand(args, io, ctx) {
  let report;
  try {
    report = oracleDiff(load(args.target_trace, io, ctx), load(args.candidate_trace, io, ctx), { proc: args.proc });
  } catch (e) {
    if (!reportable(e)) throw e;
    io.eprint(`error: ${errorText(e)}`);
    return 2;
  }
  if (args.json) io.print(dumps(report));
  else {
    const s = report.semantic;
    io.print(`oracle semantic diff: ${report.difference_count} difference(s), ${s.ambiguous_fingerprints.length} ambiguous`);
    for (const row of s.differences.slice(0, args.limit)) io.print(`${row.fingerprint} changed=${row.changed.join(",")}`);
    io.print(`proof: ${report.proof}`);
  }
  return report.difference_count ? 0 : 1;
}

/** sort_keys + compact separators, as the identity digest needs. */
function compactSortedJson(value) {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return "[" + value.map(compactSortedJson).join(",") + "]";
  if (typeof value === "object") return "{" + sorted(Object.keys(value)).map((k) => dumps(k) + ":" + compactSortedJson(value[k])).join(",") + "}";
  return dumps(value);
}

const isAlnum = (c) => /^[\p{L}\p{N}]$/u.test(c);

/** Resolved durable state and the inputs that give it identity. */
function statePaths(args, plan, { environment, cwd }) {
  const source = resolvePath(args.source, cwd);
  const target = resolvePath(args.target, cwd);
  const toolchain = toolchainStatus(resolvePath(args.toolchain, cwd));
  const compileCwd = args.compile_cwd ? resolvePath(args.compile_cwd, cwd) : resolvePath(".", cwd);
  const compilerCommand = renderCompileCommand(args.compile_command, source, "__ORACLE_OUTPUT__");
  const objdump = discoverObjdump(args.objdump, { cwd });
  const env = Object.fromEntries(sorted(Object.entries(environment), (e) => e[0]));
  const identity = {
    source: { path: source, sha256: fileSha256(source) },
    target: { path: target, sha256: fileSha256(target) },
    toolchain: { directory: toolchain.directory, manifest_sha256: toolchain.manifest_sha256 },
    compile_command: args.compile_command,
    compiler: executableIdentity(compilerCommand, { cwd: compileCwd }),
    compile_cwd: compileCwd,
    environment: env,
    objdump: executableIdentity([objdump], { cwd: compileCwd }),
    symbol: args.symbol,
    section: args.section,
    plan,
  };
  const digest = createHash("sha256").update(Buffer.from(compactSortedJson(identity), "utf8")).digest("hex");
  const stem = (p) => { const b = path.basename(p); const i = b.lastIndexOf("."); return i > 0 ? b.slice(0, i) : b; };
  const label = args.symbol || stem(target);
  let safe = [...label].map((c) => (isAlnum(c) ? c : "-")).join("").replace(/^-+|-+$/g, "").slice(0, 48) || "oracle";
  const root = path.join(resolvePath(args.state_dir, cwd), "oracle", `${safe}-${digest.slice(0, 12)}`);
  return {
    root,
    ledger: args.ledger ? resolvePath(args.ledger, cwd) : path.join(root, "ledger.jsonl"),
    objects: args.objects_dir ? resolvePath(args.objects_dir, cwd) : path.join(root, "objects"),
    report: path.join(root, "report.json"),
    identity,
  };
}

function writeStateReport(p, report) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const temporary = path.join(path.dirname(p), `.${path.basename(p)}.${process.pid}.tmp`);
  fs.writeFileSync(temporary, dumps(report) + "\n", "utf8");
  fs.renameSync(temporary, p);
}

function notFound(message) { return new OSError(message); }

function findStateReport(selector, { state_dir, cwd }) {
  if (selector !== null && selector !== undefined) {
    const selected = resolvePath(selector, cwd);
    let isDir = false;
    try { isDir = fs.statSync(selected).isDirectory(); } catch { isDir = false; }
    const report = isDir ? path.join(selected, "report.json") : selected;
    let isFile = false;
    try { isFile = fs.statSync(report).isFile(); } catch { isFile = false; }
    if (!isFile) throw notFound(`oracle report does not exist: ${report}`);
    return report;
  }
  const root = path.join(resolvePath(state_dir, cwd), "oracle");
  let reports = [];
  try {
    reports = fs.readdirSync(root).map((d) => path.join(root, d, "report.json")).filter((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } });
  } catch { reports = []; }
  if (!reports.length) throw notFound(`no oracle report found under ${root}`);
  return reports.reduce((best, p) => (fs.statSync(p).mtimeMs > fs.statSync(best).mtimeMs ? p : best));
}

function loadStateReport(selector, { state_dir, cwd }) {
  const p = findStateReport(selector, { state_dir, cwd });
  const value = JSON.parse(fs.readFileSync(p, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value) || value.schema !== "decomp-workbench-oracle-sweep-v1") {
    throw new ValueError(`not a decomp-workbench oracle sweep report: ${p}`);
  }
  return value;
}

export function planForCompile(args, io, ctx, { loader = load } = {}) {
  let plan = oraclePlan(loader(args.trace, io, ctx), { proc: args.proc, colors: overridesOf(args), include_split: !args.no_split });
  if (args.force) {
    const entries = parseForceSpecification(args.force);
    const seen = new Set();
    const selected = [];
    for (const entry of entries) {
      const key = `${entry.phase}:${entry.web}`;
      if (seen.has(key)) throw new ValueError(`oracle force cannot assign the same phase/web more than once: ${entry.phase}:w${entry.web}`);
      seen.add(key);
      const atom = String(entry);
      const match = plan.forces.find((row) => row.force === atom);
      if (!match) throw new ValueError(`${atom} is absent from the measured plan; it may be forbidden or outside the selected color set`);
      selected.push(match);
    }
    const single = selected.length === 1;
    const combined = {
      force: entries.map(String).join(","),
      phase: single ? selected[0].phase : "combined",
      web: single ? selected[0].web : null,
      color: single ? selected[0].color : null,
      register: single ? selected[0].register : selected.map((r) => String(r.register || "split")).join(","),
      components: selected,
    };
    plan = { ...plan, forces: [combined], force_count: 1, restriction: args.force };
  }
  return plan;
}

function renderSweep(report, { limit }, io) {
  const baseline = report.baseline;
  const bc = baseline && typeof baseline === "object" ? baseline.comparison : null;
  const baselineWords = bc && typeof bc === "object" ? bc.words : "failed";
  io.print(`oracle: ${report.completed_forces}/${report.planned_forces} force(s), baseline words=${baselineWords === null || baselineWords === undefined ? "None" : baselineWords}`);
  const causal = new Set(report.exact_forces ?? []);
  for (const row of report.results.slice(0, limit)) {
    const c = row.comparison;
    if (c && typeof c === "object") {
      const register = row.register ? `(${row.register})` : "";
      const note = causal.has(row.force) ? " EXACT UNDER FORCE" : c.exact ? " EXACT; NOT CAUSAL WITHOUT A NON-EXACT CONTROL" : "";
      io.print(`${row.force}${register} words=${c.words} aligned=${c.aligned_total} register=${c.aligned_register}${note}`);
      const effect = row.emitted_effect;
      if (effect && typeof effect === "object" && effect.available) {
        io.print(`  emitted effect: ${effect.classification} (${effect.changed_site_count ?? 0} site(s))`);
        const sites = effect.changed_sites ?? [];
        if (Array.isArray(sites)) {
          for (const site of sites.slice(0, 6)) {
            if (!site || typeof site !== "object") continue;
            io.print(`    [${site.index}] ${site.baseline} -> ${site.forced}`);
          }
          if (sites.length > 6) io.print(`    ... ${sites.length - 6} more changed site(s)`);
        }
      }
    } else {
      io.print(`${row.force} FAILED returncode=${row.returncode}`);
    }
  }
  if (report.results.length > limit) io.print(`... ${report.results.length - limit} more result(s); use --json`);
  if (report.signature) io.print(`verdict-signature: ${report.signature}`);
  for (const w of report.warnings ?? []) io.print(`warning: ${w}`);
  io.print(`proof: ${report.proof}`);
  io.print("next: translate the winning force into a source-level lifetime or priority hypothesis; never ship the forced compiler");
  io.print("      the source forms that move a coloring decision, in order:");
  io.print("      decomp-workbench guide pool-position");
  io.print("      decomp-workbench guide forced-color-oracle");
}

export async function oracleSweepCommand(args, io, ctx) {
  let report, state;
  try {
    const plan = planForCompile(args, io, ctx);
    const environment = await mergeToolchainEnvironment(parseEnvironment(args.env), resolvePath(args.toolchain, ctx.cwd), { require_ready: true });
    state = statePaths(args, plan, { environment, cwd: ctx.cwd });
    report = await runOracleCampaign(plan, {
      source: args.source, target: args.target, template: args.compile_command, environment, cache_dir: args.cache_dir, ledger: state.ledger,
      jobs: args.jobs, objdump: args.objdump, symbol: args.symbol, section: args.section, compile_cwd: args.compile_cwd,
      keep_objects: args.no_keep_objects ? null : state.objects, timeout: args.timeout, stream_limit: args.stream_limit, artifact_dir: args.artifact_dir,
    });
    report = { ...report, inputs: state.identity,
      state: { directory: state.root, report: state.report, ledger: state.ledger, objects: args.no_keep_objects ? null : state.objects, updated_at_unix: Date.now() / 1000 } };
    writeStateReport(state.report, report);
  } catch (e) {
    if (!reportable(e)) throw e;
    io.eprint(`error: ${errorText(e)}`);
    return 2;
  }
  if (args.json) io.print(dumps(report));
  else {
    renderSweep(report, { limit: args.limit }, io);
    io.print(`state: ${state.root}`);
    io.print(`ledger: ${state.ledger}`);
    if (!args.no_keep_objects) io.print(`objects: ${state.objects}`);
  }
  return report.control_valid && report.results.some((r) => r.comparison) ? 0 : 1;
}

export function oracleStatusCommand(args, io, ctx) {
  let report;
  try { report = loadStateReport(args.oracle_state, { state_dir: args.state_dir, cwd: ctx.cwd }); } catch (e) {
    if (!reportable(e)) throw e;
    io.eprint(`error: ${errorText(e)}`);
    return 2;
  }
  if (args.json) io.print(dumps(report));
  else {
    renderSweep(report, { limit: args.limit }, io);
    const s = report.state ?? {};
    if (s && typeof s === "object") {
      io.print(`state: ${s.directory ?? "None"}`);
      io.print(`ledger: ${s.ledger ?? "None"}`);
    }
  }
  return 0;
}

/** The self-contained HTML export of one persisted sweep. */
export function renderOracleHtml(report) {
  const rows = [];
  const causal = new Set(report.exact_forces ?? []);
  for (const result of report.results) {
    const c = result.comparison;
    let status = "failed", words = DASH, aligned = DASH;
    if (c && typeof c === "object") {
      status = causal.has(result.force) ? "exact under force" : c.exact ? "exact; control unavailable or already exact" : "measured";
      words = String(c.words);
      aligned = String(c.aligned_total);
    }
    rows.push("<tr>"
      + `<td><code>${escapeHtml(String(result.force))}</code></td>`
      + `<td>${escapeHtml(String(result.register || DASH))}</td>`
      + `<td>${escapeHtml(words)}</td>`
      + `<td>${escapeHtml(aligned)}</td>`
      + `<td>${escapeHtml(status)}</td>`
      + "</tr>");
  }
  const body = `
<h1>Allocator oracle evidence</h1>
<p>${Math.trunc(Number(report.completed_forces))}/${Math.trunc(Number(report.planned_forces))} force(s);
signature: <strong>${escapeHtml(String(report.signature || "none"))}</strong>.</p>
<p class="proof">${escapeHtml(String(report.proof))}</p>
<div class="table-scroll"><table><caption>Measured force endpoints</caption>
<thead><tr><th>Force</th><th>Register</th><th>Words</th><th>Aligned</th><th>Evidence</th></tr></thead>
<tbody>${rows.join("") || '<tr><td colspan="5">No force results.</td></tr>'}</tbody>
</table></div>
`;
  return documentShell("decomp-workbench oracle report", body, report);
}

export function oracleExportCommand(args, io, ctx) {
  let output;
  try {
    const report = loadStateReport(args.oracle_state, { state_dir: args.state_dir, cwd: ctx.cwd });
    output = resolvePath(args.output, ctx.cwd);
    if (fs.existsSync(output)) throw new OSError(`refusing to overwrite oracle export: ${output}`);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    const content = args.format === "html" ? renderOracleHtml(report) : dumps(report) + "\n";
    fs.writeFileSync(output, content, { encoding: "utf8", flag: "wx" });
  } catch (e) {
    if (!reportable(e)) throw e;
    io.eprint(`error: ${errorText(e)}`);
    return 2;
  }
  const result = { schema: "decomp-workbench-oracle-export-v1", format: args.format, output };
  if (args.json) io.print(dumps(result));
  else io.print(`oracle ${args.format} export: ${output}`);
  return 0;
}

function compileArguments() {
  return [
    { dest: "source" },
    { flags: ["--trace"], required: true },
    { flags: ["--target"], required: true },
    { flags: ["--toolchain"], required: true },
    { flags: ["--compile-command"], required: true },
    ...O.symbolArgument(),
    { flags: ["--section"], default: ".text" },
    { flags: ["--objdump"] },
    { flags: ["--proc"], type: "int" },
    { flags: ["--colors-p1"], type: parseColors },
    { flags: ["--colors-p2"], type: parseColors },
    { flags: ["--no-split"], action: "store_true" },
    { flags: ["--env"], action: "append", default: [], metavar: "NAME=VALUE" },
    { flags: ["--compile-cwd"] },
    { flags: ["--jobs"], type: "int", default: Math.max(1, Math.min(8, os.availableParallelism?.() ?? os.cpus().length ?? 1)) },
    { flags: ["--timeout"], type: "float", default: 120.0 },
    { flags: ["--cache-dir"], default: ".decomp-workbench/cache" },
    { flags: ["--state-dir"], default: ".decomp-workbench" },
    { flags: ["--ledger"] },
    { flags: ["--objects-dir"] },
    { flags: ["--no-keep-objects"], action: "store_true", help: "do not retain forced objects (retained by default)" },
    { flags: ["--stream-limit"], type: "int", default: DEFAULT_STREAM_LIMIT },
    { flags: ["--artifact-dir"] },
    { flags: ["--limit"], type: "int", default: 20 },
    { flags: ["--json"], action: "store_true", help: "emit JSON" },
  ];
}

export const COMMAND_SPECS = [
  listingSpec(["oracle"], {
    help: "plan and compare calibrated allocator decision probes",
    description: "Oracle evidence bounds a compiler decision; it never proves source originality or an acceptable final match.",
    required: true,
  }),
  { path: ["oracle", "plan"], handler: oraclePlanCommand, help: "build a phase-complete force grid from one allocator trace", defaults: { report_command: "oracle-plan" },
    arguments: [
      { dest: "trace" },
      { flags: ["--proc"], type: "int" },
      { flags: ["--colors-p1"], type: parseColors },
      { flags: ["--colors-p2"], type: parseColors },
      { flags: ["--no-split"], action: "store_true", help: "omit the diagnostic split/no-color endpoint" },
      { flags: ["--json"], action: "store_true", help: "emit JSON" },
    ] },
  { path: ["oracle", "diff"], handler: oracleDiffCommand, help: "compare two traces by stable web provenance", defaults: { report_command: "oracle-diff" },
    arguments: [
      { dest: "target_trace" }, { dest: "candidate_trace" },
      { flags: ["--proc"], type: "int" },
      { flags: ["--limit"], type: "int", default: 50 },
      { flags: ["--json"], action: "store_true", help: "emit JSON" },
    ] },
  { path: ["oracle", "sweep"], handler: oracleSweepCommand, help: "compile the complete measured force grid through the campaign engine",
    defaults: { report_command: "oracle-sweep" }, arguments: compileArguments() },
  { path: ["oracle", "force"], handler: oracleSweepCommand, help: "run one measured force set plus its unforced baseline",
    defaults: { report_command: "oracle-sweep" },
    arguments: [...compileArguments(), { flags: ["--force"], required: true,
      help: "one or more comma-separated controls, such as p1:w9=c4,p2:w55=c2; each phase/web may appear once" }] },
  { path: ["oracle", "status"], handler: oracleStatusCommand, help: "render the latest persisted sweep without recompiling", defaults: { report_command: "oracle-status" },
    arguments: [
      { dest: "oracle_state", nargs: "?", help: "state directory or report" },
      { flags: ["--state-dir"], default: ".decomp-workbench" },
      { flags: ["--limit"], type: "int", default: 20 },
      { flags: ["--json"], action: "store_true", help: "emit JSON" },
    ] },
  { path: ["oracle", "export"], handler: oracleExportCommand, help: "write a self-contained persisted oracle report", defaults: { report_command: "oracle-export" },
    arguments: [
      { dest: "oracle_state", nargs: "?", help: "state directory or report" },
      { flags: ["--state-dir"], default: ".decomp-workbench" },
      { flags: ["--output"], required: true },
      { flags: ["--format"], choices: ["html", "json"], default: "html" },
      { flags: ["--json"], action: "store_true", help: "emit result JSON" },
    ] },
];
