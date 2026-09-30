// campaign-finish.js - fresh, auditable completion receipts for a measured
// campaign winner: the selected source is rebuilt with no cache and every
// completion gate (function exactness, required signals, scratch context,
// translation-unit collateral, handoff, project verification) is evaluated
// independently. NOT RUN never means PASS.
//
// Plain JS ESM + JSDoc.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ValueError } from "./py.js";
import { dumps } from "./pyjson.js";
import { DEFAULT_STREAM_LIMIT, captureStreams } from "./artifacts.js";
import { fileSha256, runCampaign, runCompiler, resolvePath } from "./campaign.js";
import { buildStatus, durableSourcePath, resolveManifest, validateResume } from "./campaign-state.js";
import { splitCommand } from "./command-line.js";
import { FileNotFoundError, OSError, RuntimeError } from "./py-extra.js";

export const FINISH_SCHEMA = "decomp-workbench-campaign-finish-v1";

const gate = (status, reason, evidence = null) => ({ status, reason, evidence });
const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const isDict = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const fnExact = (c) => !!(c && c.exact);
const scratchAccepted = (c) => !!(c && c.exact && c.raw_word_mismatches === 0 && c.relocation_target_mismatches === 0);
const reportable = (e) => e instanceof OSError || e instanceof RuntimeError || e?.name === "ValueError" || e?.name === "RuntimeError" || e?.name === "OSError" || e?.name === "FileNotFoundError" || (e && typeof e.code === "string");
const stemOf = (p) => { const b = path.basename(String(p)); const i = b.lastIndexOf("."); return i > 0 ? b.slice(0, i) : b; };

function selectedRecord(manifest, status, selection) {
  const selected = status[selection === "temp-prefix" ? "best_temp_prefix" : "best"];
  if (!isDict(selected)) throw new ValueError("campaign has no successful candidate to finish");
  const cacheKey = selected.cache_key;
  const sourceRecord = (manifest.sources ?? []).find((i) => isDict(i) && i.cache_key === cacheKey);
  if (!isDict(sourceRecord)) throw new ValueError("selected ledger record is absent from the campaign manifest");
  const source = durableSourcePath(sourceRecord);
  const cacheObject = path.join(String(manifest.cache_directory), `${cacheKey}.o`);
  if (!isFile(cacheObject)) throw new FileNotFoundError(`selected campaign object is absent: ${cacheObject}`);
  const actualSource = fileSha256(source);
  if (actualSource !== sourceRecord.sha256) throw new ValueError("selected source hash changed; refusing finish");
  if (![null, undefined, actualSource].includes(selected.source_sha256)) throw new ValueError("selected ledger source hash disagrees with the manifest");
  const actualObject = fileSha256(cacheObject);
  if (![null, undefined, actualObject].includes(selected.object_sha256)) throw new ValueError("selected cached object hash changed; refusing finish");
  return [selected, sourceRecord, source, cacheObject];
}

const escapeHtml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
const pyStr = (v) => (v === null || v === undefined ? "None" : v === true ? "True" : v === false ? "False" : String(v));

async function writeReport(p, report, { format }) {
  if (fs.existsSync(p)) throw Object.assign(new OSError(`refusing to overwrite campaign finish receipt: ${p}`), { kind: "FileExistsError" });
  fs.mkdirSync(path.dirname(p), { recursive: true });
  let content;
  if (format === "json") content = dumps(report) + "\n";
  else {
    const { documentShell } = await import("./html-report.js");
    const gates = Object.entries(report.gates).map(([name, g]) => `<tr><th>${escapeHtml(name.replace(/_/g, " "))}</th><td>${escapeHtml(pyStr(g.status))}</td><td>${escapeHtml(pyStr(g.reason))}</td></tr>`).join("\n");
    const body = `
<h1>Campaign finish: ${escapeHtml(pyStr(report.status))}</h1>
<p>Source <code>${escapeHtml(pyStr(report.winner.source))}</code></p>
<div class="table-scroll"><table><caption>Independent completion gates</caption>
<thead><tr><th>Gate</th><th>Status</th><th>Reason</th></tr></thead>
<tbody>${gates}</tbody></table></div>
`;
    content = documentShell("decomp-workbench campaign finish", body, report, { evidence_label: "Machine-readable receipt" });
  }
  fs.writeFileSync(p, content, { encoding: "utf8", flag: "wx" });
}

/** Freshly rebuild one immutable winner and evaluate independent gates. */
export async function finishCampaign(campaign, { selection = "score", output = null, format = "json", scratch_context = null, scratch_compile_command = null,
  collateral_reference = null, handoff = null, project_command = null, project_timeout = 120.0, stream_limit = DEFAULT_STREAM_LIMIT, warn = undefined } = {}) {
  if (!["score", "temp-prefix"].includes(selection)) throw new ValueError("finish selection must be score or temp-prefix");
  if (!["json", "html"].includes(format)) throw new ValueError("finish format must be json or html");
  const manifestPath = resolveManifest(campaign);
  const manifest = await validateResume(manifestPath, { allow_retained_sources: true });
  const status = await buildStatus(manifestPath);
  const [selected, sourceRecord, source, cacheObject] = selectedRecord(manifest, status, selection);
  const reportPath = output !== null && output !== undefined ? resolvePath(output) : path.join(path.dirname(manifestPath), `finish.${format}`);
  if (fs.existsSync(reportPath)) throw Object.assign(new OSError(`refusing to overwrite campaign finish receipt: ${reportPath}`), { kind: "FileExistsError" });
  const inputs = manifest.identity_inputs, info = inputs.compile;
  const definition = manifest.experiment;
  let experiment = null;
  if (isDict(definition) && typeof definition.path === "string") experiment = await (await import("./experiments.js")).loadExperiment(definition.path);
  let requiredPass = (receipts) => receipts.every((i) => !i.required || i.status === "PASS");
  try { requiredPass = (await import("./experiment-signals.js")).requiredSignalsPass; } catch { /* default gate above */ }
  const gates = {
    fresh_function: gate("UNKNOWN", "fresh rebuild did not run"),
    required_signals: gate("UNKNOWN", "fresh rebuild did not run"),
    scratch_context: gate("NOT RUN", "no scratch context supplied"),
    translation_unit_collateral: gate("NOT RUN", "no collateral reference supplied"),
    handoff: gate("NOT RUN", "no handoff directory supplied"),
    project_verification: gate("NOT RUN", "no project command supplied"),
  };
  const artifactDir = path.join(path.dirname(reportPath), `${stemOf(reportPath)}-artifacts`);
  let freshResult = null;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "decomp-workbench-finish-"));
  try {
    const [freshResults] = await runCampaign([source], { target: inputs.target.path, template: info.template, cache_dir: path.join(root, "fresh-cache"), jobs: 1,
      objdump: inputs.objdump.requested, symbol: inputs.symbol ?? null, section: inputs.section, environment: info.environment, compile_cwd: info.working_directory,
      keep_objects: path.join(root, "fresh-object"), stop_on_exact: false, timeout: manifest.execution.timeout_seconds, stream_limit, artifact_dir: artifactDir,
      signal_specs: experiment ? experiment.signals : [], compilation_envelope: info.envelope ?? {}, warn });
    freshResult = freshResults[0];
    const fc = freshResult.comparison;
    gates.fresh_function = fc !== null && fnExact(fc)
      ? gate("PASS", "fresh no-cache rebuild passes built-in function exactness", fc.asDict())
      : gate("FAIL", "fresh no-cache rebuild is not function exact", freshResult.asDict());
    const signalsPass = requiredPass(freshResult.signals);
    gates.required_signals = gate(signalsPass ? "PASS" : "FAIL", signalsPass ? "all required signals passed on the fresh object" : "one or more required signals failed or were unknown", freshResult.signals);
    const freshObject = freshResult.object_path ? String(freshResult.object_path) : null;

    if (scratch_context !== null && scratch_context !== undefined) {
      try {
        const contextPath = resolvePath(scratch_context);
        if (!isFile(contextPath)) throw new FileNotFoundError(`scratch context does not exist: ${contextPath}`);
        const composed = path.join(root, path.basename(source));
        const context = fs.readFileSync(contextPath);
        fs.writeFileSync(composed, Buffer.concat([context, context.length && context[context.length - 1] === 0x0a ? Buffer.alloc(0) : Buffer.from("\n"),
          Buffer.from(`#line 1 "${path.basename(source)}"\n`), fs.readFileSync(source)]));
        const [scratchResults] = await runCampaign([composed], { target: inputs.target.path, template: scratch_compile_command || info.template,
          cache_dir: path.join(root, "scratch-cache"), jobs: 1, objdump: inputs.objdump.requested, symbol: inputs.symbol ?? null, section: inputs.section,
          environment: info.environment, compile_cwd: info.working_directory, stop_on_exact: false, timeout: manifest.execution.timeout_seconds, stream_limit,
          compilation_envelope: info.envelope ?? {}, warn });
        const sr = scratchResults[0];
        gates.scratch_context = gate(scratchAccepted(sr.comparison) ? "PASS" : "FAIL",
          scratchAccepted(sr.comparison) ? "scratch-context rebuild is accepted" : "scratch-context rebuild differs; project truth remains separate", sr.asDict());
      } catch (e) { if (!reportable(e)) throw e; gates.scratch_context = gate("FAIL", e.message); }
    }

    if (collateral_reference !== null && collateral_reference !== undefined) {
      try {
        if (freshObject === null) throw new ValueError("fresh object is unavailable for collateral check");
        const { compareObjectCollateral } = await import("./collateral.js");
        const collateral = await compareObjectCollateral(collateral_reference, freshObject, { symbol: inputs.symbol ?? null, section: inputs.section, objdump: inputs.objdump.requested });
        gates.translation_unit_collateral = gate(collateral.collateral_detected ? "FAIL" : "PASS",
          collateral.collateral_detected ? "translation-unit collateral was detected" : "no scoped translation-unit collateral was detected", collateral);
      } catch (e) { if (!reportable(e)) throw e; gates.translation_unit_collateral = gate("FAIL", e.message); }
    }

    if (handoff !== null && handoff !== undefined) {
      try {
        const { auditHandoff } = await import("./handoff-audit.js");
        const audit = await auditHandoff(handoff);
        gates.handoff = gate(audit.ready ? "PASS" : "FAIL", audit.ready ? "handoff is ready" : "handoff needs attention", audit);
      } catch (e) { if (!(e instanceof OSError || e?.name === "ValueError" || e?.name === "OSError" || (e && typeof e.code === "string"))) throw e; gates.handoff = gate("FAIL", e.message); }
    }

    if (project_command !== null && project_command !== undefined) {
      const command = splitCommand(project_command);
      if (!command.length) gates.project_verification = gate("FAIL", "project command is empty");
      else {
        const started = performance.now();
        const streamsOf = (stdout, stderr, stem) => captureStreams(stdout, stderr, { limit: stream_limit, artifact_dir: artifactDir, stem });
        const evidenceOf = (returncode, s) => ({ command, returncode, duration_seconds: (performance.now() - started) / 1000, stdout: s.stdout, stderr: s.stderr,
          stdout_bytes: s.stdout_bytes, stderr_bytes: s.stderr_bytes, stdout_truncated: s.stdout_truncated, stderr_truncated: s.stderr_truncated, artifacts: s.artifacts });
        try {
          const proc = await runCompiler(command, { environment: info.environment, compile_cwd: String(info.working_directory), timeout: project_timeout });
          const s = streamsOf(proc.stdout, proc.stderr, "project-verification");
          gates.project_verification = gate(proc.returncode === 0 ? "PASS" : "FAIL", proc.returncode === 0 ? "project command passed" : `project command exited ${proc.returncode}`, evidenceOf(proc.returncode, s));
        } catch (e) {
          if (e.kind === "CompilerTimeoutError") gates.project_verification = gate("FAIL", e.message, evidenceOf(124, streamsOf(e.stdout, e.stderr, "project-verification-timeout")));
          else if (e instanceof OSError) gates.project_verification = gate("FAIL", e.message);
          else throw e;
        }
      }
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
  const evaluated = Object.values(gates).filter((g) => g.status !== "NOT RUN");
  const ready = evaluated.length > 0 && evaluated.every((g) => g.status === "PASS");
  const report = {
    schema: FINISH_SCHEMA, generated_at_unix: Date.now() / 1000, status: ready ? "PASS" : "FAIL", ready,
    campaign_identity: manifest.identity, campaign_manifest: manifestPath, selection,
    winner: { source: String(source), source_sha256: sourceRecord.sha256, cache_key: selected.cache_key, recorded_object: cacheObject,
      recorded_object_sha256: fileSha256(cacheObject), recorded_at_unix: selected.recorded_at_unix ?? null,
      fresh_object_sha256: freshResult !== null ? freshResult.object_sha256 : null, target_sha256: inputs.target.sha256 },
    gates,
    proof: "Each gate is independent. NOT RUN never means PASS; function exactness does not imply scratch, collateral, handoff, or project truth.",
  };
  await writeReport(reportPath, report, { format });
  return [report, reportPath];
}
