// relocation-proof.js - compose fallback-static and promoted-linked
// relocation evidence into one receipt. Object-level relocation metadata and
// final linked bytes answer different questions; the receipt keeps both
// surfaces, binds every input by content hash, replays both computations from
// the bound inputs, and promotes only when ownership, site identities and
// the linked byte range all agree. It never upgrades fallback evidence into
// linked evidence.
//
// Plain JS ESM + JSDoc.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readElf } from "./elf.js";
import { EvidenceError, artifactRecord, loadJsonObject, verifyArtifactRecord } from "./evidence.js";
import { LINKED_COMPARE_SCHEMA, compareImages, parseRanges } from "./linked-compare.js";
import { SURFACE_SCHEMA, parseModuleMap, synthesize } from "./reloc-surface.js";
import { IDENTITY_REPORT_SCHEMA, identityReport, parseIdentityProvider } from "./relocation-identity.js";
import { pyInt, strip, strRepr } from "./py.js";
import { dumps } from "./pyjson.js";
import { pyRepr } from "./pyrepr.js";

export const PROOF_SCHEMA = "decomp-workbench-relocation-proof-v1";
export const EVIDENCE_SCHEMA = "decomp-workbench-hash-bound-artifacts-v1";

const isMapping = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const expandUser = (p) => (p === "~" || p.startsWith("~/") ? os.homedir() + p.slice(1) : p);
const resolvePath = (p) => { const abs = path.resolve(expandUser(String(p))); try { return fs.realpathSync(abs); } catch { return abs; } };

/** JSON document equality with the original's `==` (1 == 1.0, key order free). */
export function jsonEq(a, b) {
  if (a === b) return true;
  if (typeof a === "boolean" && typeof b === "number") return Number(a) === b;
  if (typeof b === "boolean" && typeof a === "number") return Number(b) === a;
  if (a === null || b === null || a === undefined || b === undefined) return (a ?? null) === (b ?? null);
  if (typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((v, i) => jsonEq(v, b[i]));
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && jsonEq(a[k], b[k]));
}
/** A record or report as the JSON document it becomes. */
const doc = (v) => JSON.parse(dumps(v));

function mapping(value, where) {
  if (!isMapping(value)) throw new EvidenceError(`${where} must be a JSON object`);
  return value;
}

function integer(value, where) {
  if (typeof value === "boolean") throw new EvidenceError(`${where} must be an integer, not a boolean`);
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string") { try { return pyInt(value, 0); } catch { /* fall through */ } }
  throw new EvidenceError(`${where} must be an integer`);
}

function reportEvidence(report, where) {
  const evidence = mapping(report.evidence, `${where}.evidence`);
  if (evidence.schema !== EVIDENCE_SCHEMA) throw new EvidenceError(`${where}.evidence schema must be ${EVIDENCE_SCHEMA}; regenerate the report`);
  return evidence;
}

function verifyEvidenceArtifacts(evidence, where) {
  const artifacts = evidence.artifacts;
  if (!Array.isArray(artifacts)) throw new EvidenceError(`${where}.artifacts must be a list`);
  if (!artifacts.length) throw new EvidenceError(`${where}.artifacts must not be empty`);
  return artifacts.map((item, index) => verifyArtifactRecord(item, { where: `${where}.artifacts[${index}]` }));
}

function artifactByRole(artifacts, role, where) {
  const selected = artifacts.filter((a) => a.role === role);
  if (selected.length !== 1) throw new EvidenceError(`${where} requires exactly one artifact with role=${strRepr(role)}; found ${selected.length}`);
  return selected[0];
}

function artifactsByRole(artifacts, role, where) {
  const selected = artifacts.filter((a) => a.role === role);
  if (!selected.length) throw new EvidenceError(`${where} requires at least one artifact with role=${strRepr(role)}`);
  return selected;
}

function requireRecomputedFields(actual, expected, fields, where) {
  const disagreements = fields.filter((f) => !jsonEq(actual[f], expected[f]));
  if (disagreements.length) throw new EvidenceError(`${where} disagrees with its bound inputs in field(s): ` + disagreements.join(", "));
}

function recomputeFallback(report, evidence, artifacts) {
  const moduleRecord = artifactByRole(artifacts, "module-map", "fallback-static evidence");
  const targetRecord = artifactByRole(artifacts, "target-image", "fallback-static evidence");
  const candidateRecords = artifactsByRole(artifacts, "candidate-object", "fallback-static evidence");
  const providerRecord = artifactByRole(artifacts, "identity-provider", "fallback-static evidence");
  const module = parseModuleMap(loadJsonObject(moduleRecord.path, { where: "module map" }), { origin: String(moduleRecord.path) });
  const objects = candidateRecords.map((item) => [String(item.path), readElf(String(item.path))]);
  const target = fs.readFileSync(String(targetRecord.path));
  const surface = synthesize(objects, module, target);
  const expectedSurface = doc(surface.asDict());
  requireRecomputedFields(report, expectedSurface, Object.keys(surface.asDict()), "fallback-static report");
  if (!jsonEq(evidence.module, doc(module.asDict()))) throw new EvidenceError("fallback-static evidence module disagrees with its bound module map");
  const expectedIdentities = doc(identityReport(surface.sites, parseIdentityProvider(loadJsonObject(providerRecord.path, { where: "identity provider" }))));
  if (!jsonEq(report.identities, expectedIdentities)) throw new EvidenceError("fallback-static identities disagree with the bound provider and sites");
  return expectedIdentities;
}

function recomputeLinked(report, artifacts) {
  const builtRecord = artifactByRole(artifacts, "built-image", "promoted-linked evidence");
  const targetRecord = artifactByRole(artifacts, "target-image", "promoted-linked evidence");
  const rangeRecord = artifactByRole(artifacts, "range-map", "promoted-linked evidence");
  const ranges = parseRanges(loadJsonObject(rangeRecord.path, { where: "range map" }), { origin: String(rangeRecord.path) });
  const reported = report.ranges;
  if (!Array.isArray(reported)) throw new EvidenceError("promoted-linked report ranges must be a list");
  const coordinates = reported.filter(isMapping).map((item) => ({ name: item.name ?? null, start: item.start ?? null, end: item.end ?? null }));
  const expected = ranges.map((r) => ({ name: r.name, start: r.start, end: r.end }));
  if (!jsonEq(coordinates, expected)) throw new EvidenceError("promoted-linked ranges disagree with the bound range map");
  const comparison = doc(compareImages(fs.readFileSync(String(builtRecord.path)), fs.readFileSync(String(targetRecord.path)), ranges, {
    built_name: String(report.built ?? builtRecord.path), target_name: String(report.target ?? targetRecord.path) }).asDict());
  requireRecomputedFields(report, comparison, Object.keys(comparison).filter((f) => f !== "built" && f !== "target"), "promoted-linked report");
}

/** Recompute one relocation surface and its project identity join. */
export function verifyFallbackSurface(report) {
  const fallback = mapping(report, "fallback-static report");
  if (fallback.schema !== SURFACE_SCHEMA) throw new EvidenceError(`fallback report schema must be ${SURFACE_SCHEMA}`);
  const evidence = reportEvidence(fallback, "fallback-static report");
  const artifacts = verifyEvidenceArtifacts(evidence, "fallback-static evidence");
  return { ...recomputeFallback(fallback, evidence, artifacts) };
}

function candidateArtifact(artifacts, candidate) {
  const expectedPath = resolvePath(String(candidate.path));
  const matches = artifacts.filter((a) => a.role === "candidate-object" && resolvePath(String(a.path ?? "")) === expectedPath);
  if (matches.length !== 1) throw new EvidenceError("fallback-static report does not bind exactly one copy of the selected candidate object");
  if (matches[0].sha256 !== candidate.sha256) throw new EvidenceError("fallback-static report and selected candidate object disagree on SHA-256");
  return matches[0];
}

function selectedRange(linked, symbol) {
  const raw = linked.ranges;
  if (!Array.isArray(raw)) throw new EvidenceError("promoted-linked report ranges must be a list");
  const matches = raw.filter((item) => isMapping(item) && item.name === symbol);
  if (matches.length !== 1) throw new EvidenceError(`promoted-linked report must contain exactly one range named ${strRepr(symbol)}`);
  const selected = matches[0];
  if (selected.class !== "exact" && selected.class !== "text-exact") {
    throw new EvidenceError(`promoted-linked range ${strRepr(symbol)} is ${pyRepr(selected.class ?? null)}, not exact`);
  }
  return selected;
}

function owner(fallbackEvidence, range) {
  const module = mapping(fallbackEvidence.module, "fallback module");
  const imageStart = integer(module.image_start ?? null, "module.image_start");
  const imageEnd = integer(module.image_end ?? null, "module.image_end");
  const start = integer(range.start ?? null, "linked range start");
  const end = integer(range.end ?? null, "linked range end");
  if (end <= start || start < imageStart || end > imageEnd) throw new EvidenceError("linked range does not lie inside the fallback module");
  const moduleOffset = start - imageStart, size = end - start;
  const sections = module.sections;
  if (!Array.isArray(sections)) throw new EvidenceError("fallback module sections must be a list");
  const owners = [];
  for (const raw of sections) {
    if (!isMapping(raw)) continue;
    const offset = integer(raw.offset ?? null, "module section offset");
    const extent = integer(raw.size ?? null, "module section size");
    if (offset <= moduleOffset && moduleOffset + size <= offset + extent) owners.push(raw);
  }
  if (owners.length !== 1) throw new EvidenceError(`linked range must have exactly one owning module section; found ${owners.length}`);
  return { namespace: "module-section-offset", module: module.name ?? null, section: owners[0].name ?? null, offset: moduleOffset, size,
    image_start: start, image_end: end };
}

/** Build one deterministic proof receipt from two independently named surfaces. */
export function buildRelocationProof({ fallback_report, linked_report, symbol, source, candidate_object }) {
  if (!strip(symbol)) throw new EvidenceError("symbol must be non-empty");
  const fallbackPath = resolvePath(fallback_report);
  const linkedPath = resolvePath(linked_report);
  const fallback = loadJsonObject(fallbackPath, { where: "fallback-static report" });
  const linked = loadJsonObject(linkedPath, { where: "promoted-linked report" });
  if (fallback.schema !== SURFACE_SCHEMA) throw new EvidenceError(`fallback report schema must be ${SURFACE_SCHEMA}`);
  if (linked.schema !== LINKED_COMPARE_SCHEMA) throw new EvidenceError(`linked report schema must be ${LINKED_COMPARE_SCHEMA}`);
  if (fallback.ok !== true) throw new EvidenceError("fallback-static relocation surface contains conflicts");
  if (fallback.corroborated !== true) throw new EvidenceError("fallback-static surface lacks a shipped relocation-table corroboration");
  const fallbackEvidence = reportEvidence(fallback, "fallback-static report");
  const linkedEvidence = reportEvidence(linked, "promoted-linked report");
  const fallbackArtifacts = verifyEvidenceArtifacts(fallbackEvidence, "fallback-static evidence");
  const linkedArtifacts = verifyEvidenceArtifacts(linkedEvidence, "promoted-linked evidence");
  const identities = mapping(recomputeFallback(fallback, fallbackEvidence, fallbackArtifacts), "fallback identities");
  if (identities.schema !== IDENTITY_REPORT_SCHEMA) throw new EvidenceError("fallback-static report lacks a versioned project identity-provider result");
  if (identities.complete !== true) {
    throw new EvidenceError("fallback-static identities are incomplete or contradicted; "
      + `resolved=${pyRepr(identities.resolved ?? null)} unknown=${pyRepr(identities.unknown ?? null)} contradicted=${pyRepr(identities.contradicted ?? null)}`);
  }
  const fallbackTarget = artifactByRole(fallbackArtifacts, "target-image", "fallback-static evidence");
  const linkedTarget = artifactByRole(linkedArtifacts, "target-image", "promoted-linked evidence");
  if (fallbackTarget.sha256 !== linkedTarget.sha256) throw new EvidenceError("fallback-static and promoted-linked surfaces use different target images");
  recomputeLinked(linked, linkedArtifacts);
  const sourceRecord = artifactRecord(source, { role: "candidate-source" });
  const candidateRecord = artifactRecord(candidate_object, { role: "candidate-object" });
  candidateArtifact(fallbackArtifacts, candidateRecord);
  artifactByRole(linkedArtifacts, "built-image", "promoted-linked evidence");
  const selected = selectedRange(linked, symbol);
  return {
    schema: PROOF_SCHEMA, status: "PASS", symbol, owner: owner(fallbackEvidence, selected),
    source_binding: { status: "host-declared", source: sourceRecord, candidate_object: candidateRecord,
      claim: "The host declares that this source produced this candidate object; the workbench binds both contents but does not run or infer the build." },
    surfaces: {
      fallback_static: { report: artifactRecord(fallbackPath, { role: "fallback-static-report" }), target_sha256: fallbackTarget.sha256,
        relocation_sites: identities.sites ?? null, exact_identities: identities.resolved ?? null, status: "complete",
        claim: "Offset/type/identity evidence only; this surface does not claim that final linked bytes are exact." },
      promoted_linked: { report: artifactRecord(linkedPath, { role: "promoted-linked-report" }), target_sha256: linkedTarget.sha256,
        range: { ...selected }, status: "exact", claim: "The selected final linked image range is byte-exact." },
    },
    claim: "PASS binds a corroborated fallback relocation surface and complete project-supplied site identities to an exact final linked byte range.",
  };
}

/** Rebuild a receipt from its recorded inputs and compare it structurally. */
export function verifyRelocationProof(p) {
  const receipt = loadJsonObject(p, { where: "relocation proof" });
  if (receipt.schema !== PROOF_SCHEMA) throw new EvidenceError(`relocation proof schema must be ${PROOF_SCHEMA}`);
  const surfaces = mapping(receipt.surfaces, "relocation proof surfaces");
  const fallback = mapping(surfaces.fallback_static, "fallback surface");
  const linked = mapping(surfaces.promoted_linked, "linked surface");
  const binding = mapping(receipt.source_binding, "source binding");
  const source = mapping(binding.source, "source binding source");
  const candidate = mapping(binding.candidate_object, "source binding candidate_object");
  for (const [where, record] of [["fallback report", fallback.report], ["linked report", linked.report], ["candidate source", source], ["candidate object", candidate]]) {
    verifyArtifactRecord(record, { where });
  }
  const rebuilt = doc(buildRelocationProof({ fallback_report: String(mapping(fallback.report, "fallback report").path),
    linked_report: String(mapping(linked.report, "linked report").path), symbol: String(receipt.symbol ?? ""), source: String(source.path),
    candidate_object: String(candidate.path) }));
  const agrees = jsonEq(rebuilt, receipt);
  return { schema: PROOF_SCHEMA, verification: agrees ? "AGREES" : "DISAGREES", pass: agrees, receipt, rebuilt };
}
