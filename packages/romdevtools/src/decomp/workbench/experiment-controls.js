// experiment-controls.js - serial control preflight for experiment-v2
// campaigns: every declared absolute or differential canary compiles before
// ordinary candidates, and a required control that does not reproduce its
// expected receipt stops the campaign before it spends any work.
//
// Plain JS ESM + JSDoc.

import { prepareCandidates, runCampaign, resolvePath } from "./campaign.js";
import { METRICS_BY_KEY } from "./schema.js";
import { pyEq, pyInt } from "./py.js";

function metrics(result) {
  if (result.comparison === null || result.comparison === undefined) return {};
  const payload = result.comparison.asDict();
  const out = {};
  for (const key of Object.keys(METRICS_BY_KEY)) {
    const v = payload[key];
    if (v === undefined || v === null || ["string", "number", "boolean"].includes(typeof v)) out[key] = v ?? null;
  }
  return out;
}

function candidateReceipt(result, provenance) {
  return {
    source: provenance.source, source_sha256: provenance.source_sha256, cache_key: result.cache_key, command: result.command,
    compile_cwd: provenance.compile_cwd, environment: provenance.environment, compiler: provenance.compiler, objdump: provenance.objdump,
    target_sha256: provenance.target_sha256, compilation_envelope: provenance.compilation_envelope ?? {},
    returncode: result.returncode, object_sha256: result.object_sha256, metrics: metrics(result), signals: result.signals,
  };
}

const signalStatus = (receipt, id) => receipt.signals.find((s) => s.id === id)?.status ?? null;

function absolute(control, candidate) {
  const failures = [], unknown = [];
  const expect = control.expect;
  const wantedMetrics = { ...(expect.metrics ?? {}) };
  for (const [k, v] of Object.entries(expect)) if (Object.prototype.hasOwnProperty.call(METRICS_BY_KEY, k)) wantedMetrics[k] = v;
  const rc = expect.returncode ?? 0;
  if (candidate.returncode !== (typeof rc === "boolean" ? Number(rc) : typeof rc === "number" ? Math.trunc(rc) : pyInt(rc))) failures.push("returncode");
  for (const [key, wanted] of Object.entries(wantedMetrics)) {
    if (!(key in candidate.metrics) || candidate.metrics[key] === null) unknown.push(`metrics.${key}`);
    else if (!pyEq(candidate.metrics[key], wanted)) failures.push(`metrics.${key}`);
  }
  for (const [id, wanted] of Object.entries(expect.signals ?? {})) {
    const observed = signalStatus(candidate, id);
    if (observed === null) unknown.push(`signals.${id}`);
    else if (!pyEq(observed, wanted)) failures.push(`signals.${id}`);
  }
  if ("object_sha256" in expect) {
    if (candidate.object_sha256 === null || candidate.object_sha256 === undefined) unknown.push("object_sha256");
    else if (candidate.object_sha256 !== expect.object_sha256) failures.push("object_sha256");
  }
  if (unknown.length) return ["UNKNOWN", "expected control evidence was unavailable", unknown];
  if (failures.length) return ["FAIL", "absolute control did not reproduce its expected receipt", failures];
  return ["PASS", "absolute control reproduced every expected value", []];
}

function evidencePath(receipt, name) {
  if (name === "object_sha256") return receipt.object_sha256 ?? null;
  const i = name.indexOf(".");
  if (i < 0) return null;
  const prefix = name.slice(0, i), key = name.slice(i + 1);
  if (prefix === "metrics") return receipt.metrics[key] ?? null;
  if (prefix === "signals") return signalStatus(receipt, key);
  return null;
}

function differential(control, left, right) {
  const names = control.expect.different;
  if (!Array.isArray(names) || !names.length) return ["UNKNOWN", "differential control has no requested evidence paths", []];
  const unchanged = [], unavailable = [];
  for (const name of names) {
    const l = evidencePath(left, String(name)), r = evidencePath(right, String(name));
    if (l === null || r === null) unavailable.push(String(name));
    else if (pyEq(l, r)) unchanged.push(String(name));
  }
  if (unavailable.length) return ["UNKNOWN", "differential evidence was unavailable", unavailable];
  if (unchanged.length) return ["FAIL", "requested force/environment differential did not fire", unchanged];
  return ["PASS", "every requested differential changed", []];
}

/** Compile all declared controls serially before ordinary candidates. */
export async function runControlPreflight(manifest, { target, template, cache_dir, objdump, symbol, section, environment, compile_cwd,
  timeout, stream_limit, artifact_dir, compilation_envelope = null }) {
  if (!manifest.controls.length) return { status: "NOT DECLARED", passed: true, receipts: [] };
  const ordered = [];
  for (const control of manifest.controls) for (const s of control.candidates) if (!ordered.includes(s)) ordered.push(s);
  const [results] = await runCampaign(ordered, { target, template, cache_dir, jobs: 1, objdump, symbol, section, environment, compile_cwd,
    stop_on_exact: false, timeout, stream_limit, artifact_dir, signal_specs: manifest.signals, compilation_envelope });
  const [prepared] = prepareCandidates(ordered, { template, target: resolvePath(target), symbol, environment, compile_cwd: resolvePath(compile_cwd),
    section, objdump, compilation_envelope });
  const provenance = new Map(prepared.map((c) => [c.cache_key, c.provenance]));
  const bySource = new Map();
  for (const item of results) {
    const source = prepared.find((c) => c.cache_key === item.cache_key).source;
    bySource.set(resolvePath(source), candidateReceipt(item, provenance.get(item.cache_key)));
  }
  const receipts = manifest.controls.map((control) => {
    const candidates = control.candidates.map((s) => bySource.get(String(s)));
    const [status, reason, failed] = control.kind === "absolute" ? absolute(control, candidates[0]) : differential(control, candidates[0], candidates[1]);
    return { id: control.id, kind: control.kind, required: control.required, status, reason, failed_evidence: failed, candidates };
  });
  const passed = receipts.filter((r) => r.required).every((r) => r.status === "PASS");
  return {
    status: passed ? "PASS" : "FAIL", passed,
    required: manifest.controls.filter((c) => c.required).length,
    passed_required: receipts.filter((r) => r.required && r.status === "PASS").length,
    receipts,
  };
}
