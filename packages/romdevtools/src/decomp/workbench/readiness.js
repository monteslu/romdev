// readiness.js - freshness- and proof-aware classification for a matching
// target queue: every artifact is re-hashed, stale measurements go back to
// remeasurement, and identity maintenance is kept out of source-work lanes.
//
// Plain JS ESM + JSDoc.

import { strRepr, sorted } from "./py.js";
import { EvidenceError, loadJsonObject, verifyArtifactRecord } from "./evidence.js";

export const QUEUE_SCHEMA = "decomp-workbench-target-queue-v1";
export const READINESS_SCHEMA = "decomp-workbench-target-readiness-v1";
export const CLASSES = Object.freeze(["promotion-ready", "codegen-ready", "identity-maintenance", "remeasure"]);
export const TARGET_ROLES = Object.freeze(new Set(["target-object", "target-image"]));
export const CANDIDATE_ROLES = Object.freeze(new Set(["candidate-object", "built-image"]));

const isMap = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function entryArtifacts(value, { where }) {
  const artifacts = value.artifacts;
  if (!Array.isArray(artifacts) || !artifacts.length) throw new EvidenceError(`${where}.artifacts must be a non-empty list`);
  return [...artifacts];
}

async function relocationState(record) {
  const { SURFACE_SCHEMA } = await import("./reloc-surface.js");
  const { IDENTITY_REPORT_SCHEMA } = await import("./relocation-identity.js");
  const { EVIDENCE_SCHEMA, verifyFallbackSurface } = await import("./relocation-proof.js");
  const current = verifyArtifactRecord(record, { where: "relocation report" });
  const report = loadJsonObject(current.path, { where: "relocation report" });
  if (report.schema !== SURFACE_SCHEMA) throw new EvidenceError(`relocation report schema must be ${SURFACE_SCHEMA}`);
  const evidence = report.evidence;
  if (!isMap(evidence) || evidence.schema !== EVIDENCE_SCHEMA) throw new EvidenceError("relocation report has no versioned hash-bound evidence; regenerate it");
  const artifacts = evidence.artifacts;
  if (!Array.isArray(artifacts)) throw new EvidenceError("relocation report evidence artifacts must be a list");
  if (!artifacts.length) throw new EvidenceError("relocation report evidence artifacts must not be empty");
  artifacts.forEach((a, i) => verifyArtifactRecord(a, { where: `relocation report evidence artifacts[${i}]` }));
  const identities = await verifyFallbackSurface(report);
  if (identities.schema !== IDENTITY_REPORT_SCHEMA) return [false, "relocation report has no project identity-provider result"];
  if (identities.complete === true) return [true, "every relocation site has one exact project identity"];
  const s = (v) => (v === null || v === undefined ? "None" : String(v));
  return [false, `relocation identities incomplete: resolved=${s(identities.resolved)} unknown=${s(identities.unknown)} contradicted=${s(identities.contradicted)}`];
}

function measurementBindingReasons(measurement, artifacts) {
  const binding = measurement.artifact_sha256;
  if (!isMap(binding) || !Object.keys(binding).length) return ["measurement has no artifact_sha256 binding"];
  const byRole = new Map();
  for (const a of artifacts) {
    const role = a.role;
    if (typeof role !== "string" || !role) return ["queue artifact has no non-empty role"];
    if (!byRole.has(role)) byRole.set(role, []);
    byRole.get(role).push(a);
  }
  const reasons = [], bound = new Set();
  for (const [role, digest] of Object.entries(binding)) {
    if (!role) { reasons.push("measurement artifact role must be a non-empty string"); continue; }
    bound.add(role);
    if (typeof digest !== "string" || digest.length !== 64 || /[^0-9a-f]/.test(digest)) { reasons.push(`measurement artifact ${strRepr(role)} has an invalid SHA-256`); continue; }
    const matches = byRole.get(role) ?? [];
    if (matches.length !== 1) reasons.push(`measurement artifact ${strRepr(role)} resolves to ${matches.length} queue artifacts`);
    else if (matches[0].sha256 !== digest) reasons.push(`measurement artifact ${strRepr(role)} does not match its queue hash`);
  }
  if (![...bound].some((r) => TARGET_ROLES.has(r))) reasons.push("measurement binds no target-object or target-image");
  if (![...bound].some((r) => CANDIDATE_ROLES.has(r))) reasons.push("measurement binds no candidate-object or built-image");
  const measured = [...byRole.keys()].filter((r) => TARGET_ROLES.has(r) || CANDIDATE_ROLES.has(r));
  const unbound = sorted(measured.filter((r) => !bound.has(r)));
  if (unbound.length) reasons.push("measurement leaves comparison artifact(s) unbound: " + unbound.join(", "));
  return reasons;
}

/** Classify one target without allowing stale measurements into a work queue. */
export async function classifyTarget(raw, { index }) {
  const where = `target queue entry ${index}`;
  if (!isMap(raw)) throw new EvidenceError(`${where} must be an object`);
  const symbol = raw.symbol;
  if (typeof symbol !== "string" || !symbol.trim()) throw new EvidenceError(`${where}.symbol must be a non-empty string`);
  const stale = [], current = [];
  entryArtifacts(raw, { where }).forEach((a, i) => {
    try { current.push(verifyArtifactRecord(a, { where: `${where}.artifacts[${i}]` })); }
    catch (e) { if (e.kind !== "EvidenceError") throw e; stale.push(e.message); }
  });
  let measurement = raw.measurement;
  if (!isMap(measurement)) { stale.push("no measured comparison is recorded"); measurement = {}; }
  else {
    stale.push(...measurementBindingReasons(measurement, current));
    if (typeof measurement.exact !== "boolean") stale.push("measurement.exact must be a boolean");
  }
  for (const field of ["relocation_required", "plateau"]) if (field in raw && typeof raw[field] !== "boolean") stale.push(`${where}.${field} must be a boolean`);
  if (stale.length) return { symbol, class: "remeasure", reasons: stale, next: "rebuild and regenerate the comparison before source or proof work", artifacts: current };
  const exact = measurement.exact === true;
  const relocationRequired = raw.relocation_required ?? false;
  const record = raw.relocation_report ?? null;
  let complete = !relocationRequired;
  let reason = "target declares no project relocation identity requirement";
  if (record !== null) {
    try { [complete, reason] = await relocationState(record); }
    catch (e) {
      if (!(e?.name === "ValueError" || (e && typeof e.code === "string") || e?.name === "OSError")) throw e;
      return { symbol, class: "remeasure", reasons: [`relocation report cannot be trusted: ${e.message}`], next: "regenerate the relocation report from current artifacts", artifacts: current };
    }
  } else if (relocationRequired) reason = "target requires relocation identities but has no report";
  const plateau = raw.plateau ?? false;
  let klass, next;
  if (relocationRequired && !complete) { klass = "identity-maintenance"; next = "complete canonical site identities before assigning source variants"; }
  else if (exact) { klass = "promotion-ready"; next = "run the final linked proof and project verification gates"; }
  else { klass = "codegen-ready"; next = plateau ? "route only to a new evidence-producing mechanism; prior source space plateaued" : "assign source/codegen work using the recorded mismatch class"; }
  return { symbol, class: klass, reasons: [reason], next, plateau, measurement: { ...measurement }, artifacts: current };
}

/** Classify every queue entry and keep maintenance out of source-work lanes. */
export async function readinessReport(value) {
  if (!isMap(value) || value.schema !== QUEUE_SCHEMA) throw new EvidenceError(`target queue schema must be ${QUEUE_SCHEMA}`);
  const entries = value.entries;
  if (!Array.isArray(entries)) throw new EvidenceError("target queue entries must be a list");
  const rows = [];
  for (let i = 0; i < entries.length; i++) rows.push(await classifyTarget(entries[i], { index: i }));
  const counts = {};
  for (const k of CLASSES) counts[k] = rows.filter((r) => String(r.class) === k).length;
  return { schema: READINESS_SCHEMA, targets: rows, counts,
    source_queue: rows.filter((r) => r.class === "codegen-ready").map((r) => r.symbol),
    maintenance_queue: rows.filter((r) => r.class === "identity-maintenance" || r.class === "remeasure").map((r) => r.symbol),
    promotion_queue: rows.filter((r) => r.class === "promotion-ready").map((r) => r.symbol) };
}
