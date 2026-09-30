// campaign-state.js - durable campaign manifests, status, resume validation,
// and exports. A manifest names the campaign's identity-bearing inputs; the
// append-only ledger is the record of what ran; status is recomputed from
// both on every read, never trusted from a stored summary.
//
// Plain JS ESM + JSDoc.

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { ValueError, sorted, minBy, pyCmp, pyInt, strRepr, splitlines } from "./py.js";
import { dumps } from "./pyjson.js";
import { executableIdentity, fileSha256, renderCompileCommand, resolvePath, canonicalJson } from "./campaign.js";
import { exclusiveFileLock, writeJsonAtomic } from "./evidence.js";
import { GEOMETRY_RANKING, geometryVector, paretoLayers } from "./geometry.js";
import { displayPath } from "./model.js";
import { FileNotFoundError } from "./py-extra.js";
import { loadsJson } from "./json-error.js";

export const MANIFEST_SCHEMA = "decomp-workbench-campaign-manifest-v1";
export const STATUS_SCHEMA = "decomp-workbench-campaign-status-v1";
export const EXPORT_SCHEMA = "decomp-workbench-campaign-export-v1";
export const DEFAULT_STATE_ROOT = ".decomp-workbench";
export const SOURCE_RETENTION_POLICIES = Object.freeze(new Set(["leaders", "exact", "all", "none"]));
export const EXPORT_TRAJECTORY_LIMIT = 2000;
export const EXPORT_TRANSITION_LIMIT = 2000;
export const EXPORT_FAILURE_LIMIT = 256;
export const EXPORT_BASIN_SOURCE_LIMIT = 256;
const BIG = 1 << 30;

const isDict = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const exists = (p) => fs.existsSync(p);
const toInt = (v) => pyInt(v);
const sha256Hex = (s) => createHash("sha256").update(Buffer.from(s, "utf8")).digest("hex");
const sortedObj = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
const suffixOf = (p) => { const b = path.basename(String(p)); const i = b.lastIndexOf("."); return i > 0 ? b.slice(i) : ""; };
const stemOf = (p) => { const b = path.basename(String(p)); const i = b.lastIndexOf("."); return i > 0 ? b.slice(0, i) : b; };

function writeStateJson(p, value) {
  if (!isDict(value)) throw new ValueError("campaign state must be a JSON object");
  writeJsonAtomic(p, value);
}

/** The one lock shared by every campaign manifest writer. */
export function manifestLockPath(p) { const m = String(p); return path.join(path.dirname(m), `.${path.basename(m)}.lifecycle.lock`); }

function writeBytesAtomic(p, payload) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const temporary = path.join(path.dirname(p), `.${path.basename(p)}.${process.pid}.tmp`);
  fs.writeFileSync(temporary, payload);
  fs.renameSync(temporary, p);
}

export function slug(value) {
  const normalized = String(value).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-._]+|[-._]+$/g, "");
  return normalized.slice(0, 48) || "campaign";
}

/** A stable run identity and its human-auditable inputs. */
export async function campaignIdentity({ target, symbol, section, template, compile_cwd, environment, objdump, toolchain = null, experiment = null, compilation_envelope = null }) {
  const command = renderCompileCommand(template, "__SOURCE__", "__OUTPUT__");
  const payload = {
    target: { path: String(target), sha256: fileSha256(target) },
    symbol, section,
    compile: { template, working_directory: String(compile_cwd), environment: sortedObj(environment), environment_mode: "sealed",
      compiler: executableIdentity(command, { cwd: compile_cwd }) },
    objdump: executableIdentity([objdump], { cwd: compile_cwd }),
  };
  if (compilation_envelope && Object.keys(compilation_envelope).length) payload.compile.envelope = sortedObj(compilation_envelope);
  if (toolchain !== null && toolchain !== undefined) {
    const { toolchainStatus, MANIFEST_NAME } = await import("./toolchain.js");
    const report = await toolchainStatus(toolchain);
    const manifestPath = path.join(report.directory, MANIFEST_NAME);
    payload.toolchain = { directory: report.directory, claim: report.claim, integrity: report.integrity, manifest: manifestPath, manifest_sha256: fileSha256(manifestPath) };
  }
  if (experiment !== null && experiment !== undefined) payload.experiment = { ...experiment };
  return [sha256Hex(canonicalJson(payload)), payload];
}

function campaignDirFor(identity, identityInputs, stateRoot) {
  const targetName = stemOf(identityInputs.target.path);
  const label = identityInputs.symbol || targetName;
  return path.join(resolvePath(stateRoot), "campaigns", `${slug(String(label))}-${identity.slice(0, 12)}`);
}

function initializeManifestLocked(candidates, { identity, identity_inputs, state_root = DEFAULT_STATE_ROOT, ledger = null, cache_dir, artifact_dir,
  jobs, timeout, stop_on_exact, experiment = null, rank_by = "auto", retain_sources = "leaders" }) {
  if (!SOURCE_RETENTION_POLICIES.has(retain_sources)) throw new ValueError("source retention must be leaders, exact, all, or none");
  const campaignDir = campaignDirFor(identity, identity_inputs, state_root);
  const manifestPath = path.join(campaignDir, "manifest.json");
  const ledgerPath = ledger ? resolvePath(ledger) : path.join(campaignDir, "ledger.jsonl");
  const now = Date.now() / 1000;
  let sourceRecords = [];
  let durableState = {};
  for (const candidate of candidates) {
    const digest = String(candidate.provenance.source_sha256);
    const suffix = suffixOf(candidate.source) || ".c";
    const staged = path.join(campaignDir, "source-staging", `${digest}${suffix}`);
    if (!isFile(staged)) writeBytesAtomic(staged, fs.readFileSync(candidate.source));
    if (fileSha256(staged) !== digest) throw new ValueError(`retained source hash mismatch: ${staged}`);
    sourceRecords.push({ path: String(candidate.source), sha256: digest, cache_key: candidate.cache_key, staged_path: staged, retained_path: null, retention: "staged" });
  }
  let created;
  if (isFile(manifestPath)) {
    const manifest = loadManifest(manifestPath);
    if (manifest.identity !== identity) throw new ValueError(`campaign manifest identity changed unexpectedly: ${manifestPath}`);
    const existing = new Map();
    for (const item of manifest.sources ?? []) if (isDict(item) && "cache_key" in item) existing.set(String(item.cache_key), item);
    const previousPolicy = manifest.execution?.retain_sources ?? "leaders";
    if (previousPolicy !== retain_sources) throw new ValueError(`campaign source retention policy changed; resume with ${strRepr(previousPolicy)} or start a new campaign`);
    for (const item of sourceRecords) {
      const key = String(item.cache_key);
      if (existing.has(key)) { const prior = existing.get(key); item.retained_path = prior.retained_path ?? null; item.retention = prior.retention ?? "staged"; }
      existing.set(key, item);
    }
    sourceRecords = [...existing.values()];
    created = manifest.created_at_unix ?? now;
    for (const k of ["hypothesis", "artifacts", "accepted"]) if (k in manifest) durableState[k] = manifest[k];
  } else created = now;
  const manifest = {
    schema: MANIFEST_SCHEMA, identity, created_at_unix: created, updated_at_unix: now, status: "running",
    identity_inputs, state_directory: campaignDir, ledger: ledgerPath, cache_directory: resolvePath(cache_dir),
    artifact_directory: artifact_dir ? resolvePath(artifact_dir) : null,
    execution: { jobs, timeout_seconds: timeout, stop_on_exact, rank_by, retain_sources },
    sources: sorted(sourceRecords, (i) => String(i.path)),
    experiment,
    ...durableState,
  };
  writeStateJson(manifestPath, manifest);
  return [manifestPath, ledgerPath, manifest];
}

/** Create or extend one campaign while serializing manifest state. */
export function initializeManifest(candidates, opts) {
  const manifest = path.join(campaignDirFor(opts.identity, opts.identity_inputs, opts.state_root ?? DEFAULT_STATE_ROOT), "manifest.json");
  return exclusiveFileLock(manifestLockPath(manifest), () => initializeManifestLocked(candidates, opts));
}

function finishManifestLocked(p, { results, prepared, exact, interrupted = false, control_invalid = false }) {
  const manifest = loadManifest(p);
  manifest.updated_at_unix = Date.now() / 1000;
  manifest.status = control_invalid ? "control-invalid" : interrupted ? "interrupted" : exact ? "exact" : "complete";
  manifest.last_run = { results, prepared, exact, interrupted, control_invalid };
  writeStateJson(p, manifest);
  return manifest;
}

export function finishManifest(p, opts) {
  const manifest = resolveManifest(p);
  return exclusiveFileLock(manifestLockPath(manifest), () => finishManifestLocked(manifest, opts));
}

export function recordControlPreflight(p, report) {
  const manifestPath = resolveManifest(p);
  return exclusiveFileLock(manifestLockPath(manifestPath), () => {
    const manifest = loadManifest(manifestPath);
    manifest.control_preflight = { ...report };
    manifest.updated_at_unix = Date.now() / 1000;
    writeStateJson(manifestPath, manifest);
    return manifest;
  });
}

export function updateHypothesis(p, note) {
  const manifestPath = resolveManifest(p);
  return exclusiveFileLock(manifestLockPath(manifestPath), () => {
    const normalized = note.trim();
    if (!normalized) throw new ValueError("campaign hypothesis must not be empty");
    if (normalized.length > 4096) throw new ValueError("campaign hypothesis exceeds 4096 characters");
    const manifest = loadManifest(manifestPath);
    manifest.hypothesis = normalized;
    manifest.updated_at_unix = Date.now() / 1000;
    writeStateJson(manifestPath, manifest);
    return manifest;
  });
}

/** Load and validate the durable campaign manifest envelope. */
export function loadManifest(p) {
  const manifestPath = resolveManifest(p);
  const value = loadsJson(fs.readFileSync(manifestPath, "utf8"));
  if (!isDict(value) || value.schema !== MANIFEST_SCHEMA) throw new ValueError(`not a ${MANIFEST_SCHEMA} document: ${manifestPath}`);
  return value;
}

/** Resolve either a manifest path or its containing campaign directory. */
export function resolveManifest(p) {
  let candidate = resolvePath(p);
  if (isDir(candidate)) candidate = path.join(candidate, "manifest.json");
  if (!isFile(candidate)) throw new FileNotFoundError(`campaign manifest does not exist: ${candidate}`);
  return candidate;
}

/** Resolve an explicit campaign or select the most recently updated one. */
export function findManifest(selector = null, { state_root = DEFAULT_STATE_ROOT, require_explicit_when_ambiguous = false } = {}) {
  if (selector !== null && selector !== undefined) {
    const candidate = String(selector).startsWith("~") ? resolvePath(selector) : String(selector);
    if (exists(candidate)) return resolveManifest(candidate);
  }
  const root = path.join(resolvePath(state_root), "campaigns");
  let manifests = isDir(root) ? fs.readdirSync(root).map((d) => path.join(root, d, "manifest.json")).filter(isFile) : [];
  if (selector !== null && selector !== undefined) {
    const text = String(selector);
    manifests = manifests.filter((item) => { const name = path.basename(path.dirname(item)); return name === text || name.startsWith(text) || loadManifest(item).identity.startsWith(text); });
  }
  if (!manifests.length) {
    const detail = selector !== null && selector !== undefined ? ` matching ${strRepr(String(selector))}` : "";
    throw new FileNotFoundError(`no campaign manifest found${detail} under ${root}`);
  }
  const names = () => sorted(manifests.map((m) => path.basename(path.dirname(m)))).join(", ");
  if ((selector === null || selector === undefined) && manifests.length > 1 && require_explicit_when_ambiguous) {
    throw new ValueError(`more than one campaign exists; select one explicitly before a mutating action: ${names()}`);
  }
  if (manifests.length > 1 && selector !== null && selector !== undefined) throw new ValueError(`campaign selector ${strRepr(String(selector))} is ambiguous: ${names()}`);
  let best = manifests[0], bestTime = fs.statSync(best).mtimeMs;
  for (const m of manifests.slice(1)) { const t = fs.statSync(m).mtimeMs; if (t > bestTime) { best = m; bestTime = t; } }
  return best;
}

/** Read append-only records, tolerating only an interrupted final write. */
export function readLedger(p) {
  const ledger = String(p);
  if (!isFile(ledger)) return [[], []];
  const lines = splitlines(fs.readFileSync(ledger, "utf8"));
  const records = [], warnings = [];
  lines.forEach((line, i) => {
    const index = i + 1;
    if (!line.trim()) return;
    let value;
    try { value = loadsJson(line); } catch (e) {
      if (e.name !== "JSONDecodeError") throw e;
      if (index === lines.length) { warnings.push(`ignored interrupted final ledger record at line ${index}: ${e.message}`); return; }
      throw new ValueError(`invalid campaign ledger JSON at line ${index}: ${e.message}`);
    }
    if (!isDict(value)) throw new ValueError(`campaign ledger line ${index} is not an object`);
    records.push(value);
  });
  return [records, warnings];
}

function alignmentComparable(c) {
  if ("alignment_comparable" in c) return !!c.alignment_comparable;
  return toInt(c.aligned_gaps || 0) === 0;
}

/** Resolve `auto` and refresh cohort-relative layers in loaded records. */
export function effectiveRankBy(records, { requested }) {
  const comparisons = records.map((r) => r.comparison).filter(isDict);
  const unsafe = comparisons.some((c) => !alignmentComparable(c));
  for (const c of comparisons) c.geometry_front = null;
  if (requested === "auto") {
    const vectors = comparisons.map(geometryVector);
    if (unsafe && vectors.every((v) => v !== null)) {
      const fronts = paretoLayers(vectors);
      comparisons.forEach((c, i) => { c.geometry_front = fronts[i]; });
      return [GEOMETRY_RANKING, unsafe];
    }
    return [unsafe ? "words" : "aligned_total", unsafe];
  }
  return [requested, unsafe];
}

const get = (o, k, d) => (Object.prototype.hasOwnProperty.call(o, k) ? o[k] : d);

export function comparisonKey(c, { ranked_by = "aligned_total" } = {}) {
  const words = toInt(get(c, "words", get(c, "word_mismatches", BIG)));
  const aligned = toInt(get(c, "aligned_total", BIG));
  const unknown = get(c, "unknown_relocations", []);
  const unknownCount = Array.isArray(unknown) ? unknown.length : 0;
  const relocMeta = toInt(get(c, "reloc_meta", get(c, "relocation_metadata_mismatches", 0)));
  const candidate = String(get(c, "candidate", ""));
  if (ranked_by === "temp-prefix") return tempPrefixKey(c);
  if (ranked_by === GEOMETRY_RANKING) return [!c.exact, toInt(c.geometry_front || 0), comparisonKey(c, { ranked_by: "words" })];
  if (ranked_by === "words") {
    return [words, toInt(get(c, "raw_word_mismatches", words)), unknownCount, relocMeta, toInt(get(c, "opcodes", get(c, "opcode_mismatches", 0))),
      aligned, Math.abs(toInt(get(c, "instruction_delta", 0))), candidate];
  }
  return [aligned, words, unknownCount, relocMeta, toInt(get(c, "norm", get(c, "normalized_distance", BIG))),
    toInt(get(c, "registers", get(c, "register_mismatches", 0))), Math.abs(toInt(get(c, "instruction_delta", 0))), candidate];
}

async function requiredPass() {
  try { const m = await import("./experiment-signals.js"); return m.requiredSignalsPass; }
  catch { return (receipts) => receipts.every((i) => !i.required || i.status === "PASS"); }
}
let REQUIRED = (receipts) => receipts.every((i) => !i.required || i.status === "PASS");
/** Load the experiment signal gate once (called by the async entry points). */
export async function loadSignalGate() { REQUIRED = await requiredPass(); return REQUIRED; }

/** Mirror the live campaign's signal, region, and metric ordering. */
export function recordKey(record, { ranked_by = "aligned_total" } = {}) {
  const c = record.comparison;
  const signals = record.signals ?? [];
  const signalKey = [!REQUIRED(Array.isArray(signals) ? signals : [])];
  const region = record.region;
  const regionKey = isDict(region) ? [!region.exact, toInt(get(region, "selected_mismatches", BIG)), toInt(get(region, "outside_mismatches", BIG))] : [];
  const metric = isDict(c) ? comparisonKey(c, { ranked_by }) : [];
  return [!isDict(c), ...signalKey, ...regionKey, metric, String(record.source ?? "")];
}

function retentionLeaders(records, { ranked_by }) {
  const leaders = new Set();
  let best = null;
  const signalState = new Map();
  for (const record of records) {
    const key = String(record.cache_key ?? "");
    const c = record.comparison;
    if (key && isDict(c)) {
      if (ranked_by === GEOMETRY_RANKING && c.geometry_front === 0) leaders.add(key);
      const rank = recordKey(record, { ranked_by });
      if (best === null || pyCmp(rank, best) < 0) { leaders.add(key); best = rank; }
      if (c.exact) leaders.add(key);
    }
    let changed = false;
    for (const s of record.signals ?? []) {
      if (!isDict(s) || typeof s.id !== "string") continue;
      const status = String(s.status ?? "UNKNOWN");
      if (signalState.get(s.id) !== status) changed = true;
      signalState.set(s.id, status);
    }
    if (key && changed) leaders.add(key);
  }
  return leaders;
}

function finalizeSourceRetentionLocked(manifestPath) {
  const p = resolveManifest(manifestPath);
  const manifest = loadManifest(p);
  const [records] = readLedger(manifest.ledger);
  const policy = String(manifest.execution?.retain_sources ?? "leaders");
  const represented = new Set(records.filter((r) => r.cache_key).map((r) => String(r.cache_key)));
  let keep;
  if (policy === "all") keep = new Set((manifest.sources ?? []).filter(isDict).map((i) => String(i.cache_key)));
  else if (policy === "exact") keep = new Set(records.filter((r) => isDict(r.comparison) && r.comparison.exact).map((r) => String(r.cache_key)));
  else if (policy === "leaders") {
    const requested = String(manifest.execution?.rank_by ?? "auto");
    const [rankedBy] = effectiveRankBy(records, { requested });
    keep = retentionLeaders(records, { ranked_by: rankedBy });
  } else keep = new Set();
  for (const item of manifest.sources ?? []) if (isDict(item) && !represented.has(String(item.cache_key))) keep.add(String(item.cache_key));
  const retainedDirectory = path.join(path.dirname(p), "sources");
  const keptStage = new Set();
  for (const item of manifest.sources ?? []) {
    if (!isDict(item)) continue;
    const staged = item.staged_path ? String(item.staged_path) : null;
    const key = String(item.cache_key ?? "");
    if (!keep.has(key)) continue;
    const suffix = suffixOf(String(item.path ?? "source.c")) || ".c";
    const retained = path.join(retainedDirectory, `${item.sha256}${suffix}`);
    fs.mkdirSync(path.dirname(retained), { recursive: true });
    if (!isFile(retained) && staged !== null && isFile(staged)) fs.renameSync(staged, retained);
    if (!isFile(retained) || fileSha256(retained) !== item.sha256) throw new ValueError(`durable source retention failed: ${retained}`);
    item.retained_path = retained;
    item.retention = !represented.has(key) ? "pending" : "retained";
    if (staged !== null) keptStage.add(staged);
  }
  const retainedPaths = new Set((manifest.sources ?? []).filter((i) => isDict(i) && i.retained_path).map((i) => String(i.retained_path)));
  for (const item of manifest.sources ?? []) {
    if (!isDict(item)) continue;
    const staged = item.staged_path ? String(item.staged_path) : null;
    if (staged !== null && isFile(staged) && !keptStage.has(staged) && !retainedPaths.has(staged)) {
      fs.unlinkSync(staged);
      item.retention = "not-retained";
      item.staged_path = null;
    }
  }
  manifest.updated_at_unix = Date.now() / 1000;
  writeStateJson(p, manifest);
  return manifest;
}

/** Finalize retained sources under the shared manifest transaction lock. */
export async function finalizeSourceRetention(manifestPath) {
  await loadSignalGate();
  const p = resolveManifest(manifestPath);
  return exclusiveFileLock(manifestLockPath(p), () => finalizeSourceRetentionLocked(p));
}

/** A source copy whose content still matches the manifest. */
export function durableSourcePath(record) {
  const expected = String(record.sha256 ?? "");
  for (const field of ["retained_path", "staged_path", "path"]) {
    const value = record[field];
    if (!value) continue;
    const candidate = String(value);
    if (isFile(candidate) && fileSha256(candidate) === expected) return candidate;
  }
  throw new FileNotFoundError(`campaign source and its retained copy are unavailable or changed: ${record.path === undefined ? "None" : record.path}`);
}

export function tempPrefixKey(c) {
  const temp = c.temp_prefix_exact ?? null;
  const instructions = toInt(get(c, "target_instructions", 0));
  const effective = temp === null ? instructions + 1 : toInt(temp);
  return [c.alignment_method !== "positional-opcode", !get(c, "pool_exact", false), -effective, toInt(get(c, "words", get(c, "word_mismatches", BIG))), String(get(c, "candidate", ""))];
}

const COMPACT_KEYS = ["candidate", "exact", "structural_exact", "verdict", "aligned_total", "aligned_structural", "aligned_schedule", "aligned_register",
  "aligned_constant", "aligned_commutative", "pool_exact", "pool_prefix_exact", "temp_prefix_exact", "first_temp_divergence", "first_divergent_row",
  "alignment_method", "words", "word_mismatches", "raw", "raw_word_mismatches", "relocation_target_mismatches", "relocation_metadata_mismatches",
  "candidate_sha1", "candidate_sha256"];

export function compactRecord(record) {
  const c = record.comparison;
  const compact = isDict(c) ? Object.fromEntries(COMPACT_KEYS.map((k) => [k, c[k] ?? null])) : null;
  return {
    recorded_at_unix: record.recorded_at_unix ?? null, source: record.source ?? null, returncode: record.returncode ?? null,
    cached: record.cached ?? null, duration_seconds: record.duration_seconds ?? null, cache_key: record.cache_key ?? null,
    object_sha256: record.object_sha256 ?? null,
    source_sha256: isDict(record.provenance) ? (record.provenance.source_sha256 ?? null) : null,
    comparison: compact, experiment: record.experiment ?? null, region: record.region ?? null, signals: get(record, "signals", []),
  };
}

function recoverExperimentMetadata(manifest, records) {
  const experiment = manifest.experiment, sources = manifest.sources;
  if (!isDict(experiment) || !Array.isArray(sources)) return [records, 0];
  const candidates = experiment.candidates;
  if (!Array.isArray(candidates)) return [records, 0];
  const parametersBySource = new Map(candidates.filter((c) => isDict(c) && "source" in c).map((c) => [String(c.source), get(c, "parameters", {})]));
  const sourceByKey = new Map(sources.filter((s) => isDict(s) && s.cache_key && s.path).map((s) => [String(s.cache_key), String(s.path)]));
  let recovered = 0;
  const enriched = [];
  for (const record of records) {
    if (isDict(record.experiment)) { enriched.push(record); continue; }
    let source = sourceByKey.get(String(record.cache_key ?? "")) ?? null;
    if (source === null && isDict(record.provenance) && typeof record.provenance.source === "string") source = record.provenance.source;
    if (!parametersBySource.has(source)) { enriched.push(record); continue; }
    enriched.push({ ...record, experiment: { schema: experiment.schema ?? null, family: experiment.family ?? null, parameters: parametersBySource.get(source),
      parameter_space: get(experiment, "parameters", {}), baseline: experiment.baseline ?? null, manifest: experiment.path ?? null } });
    recovered += 1;
  }
  return [enriched, recovered];
}

const pyStrValue = (v) => (v === null || v === undefined ? "None" : v === true ? "True" : v === false ? "False" : String(v));

export function homologousGuidance(manifest, successful) {
  const experiment = manifest.experiment;
  if (!isDict(experiment)) return [];
  const groups = get(experiment, "homologous_parameters", []);
  if (!Array.isArray(groups)) return [];
  const observations = [];
  const tested = new Set();
  for (const record of successful) {
    const metadata = record.experiment, comparison = record.comparison;
    if (!isDict(metadata) || !isDict(comparison)) continue;
    const parameters = metadata.parameters;
    if (!isDict(parameters)) continue;
    tested.add(canonicalJson(parameters));
    observations.push([record, parameters, comparison]);
  }
  const prefixValue = (c) => (c.temp_prefix_exact === null || c.temp_prefix_exact === undefined ? BIG : toInt(c.temp_prefix_exact));
  const guidance = [], seen = new Set();
  const eq = (a, b) => canonicalJson(a ?? null) === canonicalJson(b ?? null);
  for (const rawGroup of groups) {
    if (!Array.isArray(rawGroup) || rawGroup.length < 2) continue;
    const group = rawGroup.map(String);
    for (const [poorerRecord, poorer, poorerC] of observations) {
      for (const [betterRecord, better, betterC] of observations) {
        const names = new Set([...Object.keys(poorer), ...Object.keys(better)]);
        const changed = [...names].filter((n) => !eq(poorer[n], better[n]));
        if (changed.length !== 1) continue;
        const changedName = changed[0];
        if (!group.includes(changedName)) continue;
        const before = prefixValue(poorerC), after = prefixValue(betterC);
        if (after <= before) continue;
        const winning = better[changedName] ?? null;
        for (const sibling of group) {
          if (sibling === changedName || eq(poorer[sibling], winning)) continue;
          const suggested = { ...poorer, [sibling]: winning };
          const serialized = canonicalJson(suggested);
          if (tested.has(serialized) || seen.has(serialized)) continue;
          seen.add(serialized);
          const label = (v) => (v === BIG ? "exact" : String(v));
          guidance.push({ group, evidence_parameter: changedName, sibling_parameter: sibling, winning_value: winning,
            prefix_before: before === BIG ? null : before, prefix_after: after === BIG ? null : after,
            words_before: get(poorerC, "words", poorerC.word_mismatches ?? null), words_after: get(betterC, "words", betterC.word_mismatches ?? null),
            evidence_sources: [poorerRecord.source ?? null, betterRecord.source ?? null], suggested_parameters: suggested,
            reason: `changing ${changedName} alone moved the first temp divergence from ${label(before)} to ${label(after)}; test the same value at homologous ${sibling}` });
        }
      }
    }
  }
  return guidance;
}

/** Build the compact cockpit report from a manifest and its ledger. */
export async function buildStatus(manifestPath) {
  await loadSignalGate();
  const p = resolveManifest(manifestPath);
  const manifest = loadManifest(p);
  let [records, warnings] = readLedger(manifest.ledger);
  let recovered;
  [records, recovered] = recoverExperimentMetadata(manifest, records);
  if (recovered) warnings.push(`recovered experiment metadata for ${recovered} ledger record(s) from the campaign manifest`);
  const successful = records.filter((r) => isDict(r.comparison));
  const requestedRankBy = String(manifest.execution?.rank_by ?? "auto");
  const [rankedBy, unsafe] = effectiveRankBy(successful, { requested: requestedRankBy });
  const bestRecord = successful.length ? minBy(successful, (r) => recordKey(r, { ranked_by: rankedBy })) : null;
  const bestTemp = successful.length ? minBy(successful, (r) => tempPrefixKey(r.comparison)) : null;
  const trajectory = [], mechanism = [], basinTransitions = [], failures = [];
  const signalState = new Map();
  let bestSoFar = null, bestAligned = null, bestWords = null, previousBasin = null;
  const basins = new Map(), basinSignals = new Map(), families = new Map();
  records.forEach((record, i) => {
    const index = i + 1;
    const c = record.comparison;
    if (isDict(c)) {
      if (bestSoFar === null || pyCmp(recordKey(record, { ranked_by: rankedBy }), recordKey(bestSoFar, { ranked_by: rankedBy })) < 0) bestSoFar = record;
      const aligned = toInt(get(c, "aligned_total", BIG));
      const wordsValue = get(c, "words", get(c, "word_mismatches", BIG));
      const words = wordsValue !== null ? toInt(wordsValue) : BIG;
      bestAligned = bestAligned === null ? aligned : Math.min(bestAligned, aligned);
      bestWords = bestWords === null ? words : Math.min(bestWords, words);
      const sha = String(get(c, "candidate_sha256", "unknown"));
      if (!basins.has(sha)) basins.set(sha, []);
      basins.get(sha).push(String(get(record, "source", "unknown")));
      for (const s of get(record, "signals", [])) {
        if (isDict(s) && typeof s.id === "string") {
          if (!basinSignals.has(sha)) basinSignals.set(sha, new Map());
          const m = basinSignals.get(sha);
          if (!m.has(s.id)) m.set(s.id, new Set());
          m.get(s.id).add(String(get(s, "status", "UNKNOWN")));
        }
      }
      const experiment = record.experiment;
      if (isDict(experiment)) {
        const family = String(get(experiment, "family", "unclassified"));
        if (!families.has(family)) families.set(family, []);
        families.get(family).push(record);
      }
      if (previousBasin !== null && sha !== previousBasin) {
        basinTransitions.push({ record: index, source: record.source ?? null, from: previousBasin, to: sha, family: isDict(experiment) ? (experiment.family ?? null) : null });
      }
      previousBasin = sha;
      trajectory.push({ record: index, source: record.source ?? null, aligned_total: c.aligned_total ?? null, words: get(c, "words", c.word_mismatches ?? null),
        verdict: c.verdict ?? null, pool_exact: c.pool_exact ?? null, pool_prefix_exact: c.pool_prefix_exact ?? null, temp_prefix_exact: c.temp_prefix_exact ?? null,
        first_temp_divergence: c.first_temp_divergence ?? null, first_divergent_row: c.first_divergent_row ?? null, alignment_method: c.alignment_method ?? null,
        best_aligned_total: bestAligned, best_words: bestWords, region: record.region ?? null });
      const signals = get(record, "signals", []);
      if (Array.isArray(signals)) {
        for (const s of signals) {
          if (!isDict(s) || typeof s.id !== "string") continue;
          const status = String(get(s, "status", "UNKNOWN"));
          const previous = signalState.has(s.id) ? signalState.get(s.id) : null;
          if (previous !== status) mechanism.push({ record: index, source: record.source ?? null, signal: s.id, required: !!s.required, from: previous, to: status });
          signalState.set(s.id, status);
        }
      }
    } else {
      failures.push({ source: record.source ?? null, returncode: record.returncode ?? null, stderr: String(get(record, "stderr", "")).slice(-2048) });
    }
  });
  const represented = new Set(records.filter((r) => r.cache_key).map((r) => String(r.cache_key)));
  const prepared = get(manifest, "sources", []);
  const remaining = prepared.filter((i) => isDict(i) && !represented.has(String(i.cache_key)));
  let basinRows = [...basins].map(([sha, sources]) => ({
    candidate_sha256: sha, variant_count: sources.length, sources,
    signals: Object.fromEntries(sorted([...(basinSignals.get(sha) ?? new Map())], (e) => e[0]).map(([sig, st]) => [sig, sorted([...st])])),
  }));
  basinRows = sorted(basinRows, (b) => [-b.variant_count, String(b.candidate_sha256)]);
  const familyRows = [];
  for (const [family, famRecords] of sorted([...families], (e) => e[0])) {
    const famBest = minBy(famRecords, (r) => recordKey(r, { ranked_by: rankedBy }));
    const famBasins = new Set(famRecords.map((r) => String(r.comparison.candidate_sha256 ?? "None")));
    const parameterSets = new Set(famRecords.map((r) => canonicalJson(isDict(r.experiment) ? get(r.experiment, "parameters", {}) : {})));
    const decoded = sorted([...parameterSets]).slice(0, 64).map((v) => JSON.parse(v));
    const metadata = famRecords[0].experiment;
    const space = isDict(metadata) ? get(metadata, "parameter_space", {}) : {};
    familyRows.push({ family, tested_candidates: famRecords.length, tested_parameter_sets: parameterSets.size, tested_parameters: decoded,
      tested_parameters_truncated: parameterSets.size > 64, declared_parameter_space: space, object_basins: famBasins.size, best: compactRecord(famBest),
      conclusion: `${parameterSets.size} tested assignment(s) from ${dumps(space, { indent: null })} produced ${famBasins.size} object basin(s)` });
  }
  const guidance = homologousGuidance(manifest, successful);
  const definition = manifest.experiment;
  const control = get(manifest, "control_preflight", { status: "NOT DECLARED", passed: true, receipts: [] });
  let coverage, conclusion;
  if (isDict(definition)) {
    const space = get(definition, "parameters", {});
    let declared = 1;
    if (isDict(space)) { for (const choices of Object.values(space)) { if (Array.isArray(choices)) declared *= choices.length; else { declared = 0; break; } } }
    else declared = 0;
    const visitedSet = new Set(records.filter((r) => isDict(r.experiment)).map((r) => canonicalJson(get(r.experiment, "parameters", {}))));
    const declaration = get(definition, "coverage", {});
    const excluded = isDict(declaration) ? toInt(get(declaration, "excluded", 0)) : 0;
    const visited = visitedSet.size;
    const unvisited = declared ? Math.max(0, declared - visited - excluded) : null;
    if (manifest.status === "control-invalid" || !(isDict(control) ? !!get(control, "passed", true) : true)) conclusion = "control-invalid";
    else if (manifest.status === "interrupted") conclusion = "partial-interrupted";
    else if (!declared) conclusion = "coverage-unknown";
    else if (visited + excluded >= declared) conclusion = "exhaustive-over-declared-space";
    else conclusion = "sampled-over-declared-space";
    coverage = { declared_assignments: declared || null, visited_assignments: visited, excluded_assignments: excluded, unvisited_assignments: unvisited,
      method: isDict(declaration) ? get(declaration, "method", "explicit-candidates") : "explicit-candidates",
      sampling: isDict(declaration) ? (declaration.sampling ?? null) : null,
      exclusion_reason: isDict(declaration) ? (declaration.exclusion_reason ?? null) : null, conclusion };
  } else {
    conclusion = "coverage-unknown";
    coverage = { declared_assignments: null, visited_assignments: records.length, excluded_assignments: 0, unvisited_assignments: null,
      method: "unmeasured", sampling: null, exclusion_reason: null, conclusion };
  }
  for (const row of familyRows) { row.coverage = coverage; row.conclusion_label = conclusion; }
  const sourceRecords = prepared.filter(isDict);
  return {
    schema: STATUS_SCHEMA, manifest: displayPath(p), identity: manifest.identity, status: manifest.status,
    rank_by: requestedRankBy, ranked_by: rankedBy, alignment_ranking_unsafe: unsafe,
    target: manifest.identity_inputs.target, symbol: manifest.identity_inputs.symbol ?? null,
    prepared_candidates: prepared.length, recorded_candidates: records.length, remaining_candidates: remaining.length,
    successful_candidates: successful.length, failed_candidates: failures.length, object_basins: basinRows,
    best: bestRecord ? compactRecord(bestRecord) : null, best_temp_prefix: bestTemp ? compactRecord(bestTemp) : null,
    trajectory, acceptance_trajectory: trajectory, mechanism_trajectory: mechanism, basin_transitions: basinTransitions,
    families: familyRows, homologous_guidance: guidance, failures, warnings, experiment: manifest.experiment ?? null,
    controls: control, coverage, conclusion_label: conclusion, hypothesis: manifest.hypothesis ?? null,
    artifacts: Object.fromEntries(Object.entries(manifest.artifacts || {}).filter(([, v]) => isDict(v) && typeof v.id === "string").map(([r, v]) => [r, v.id])),
    accepted: manifest.accepted ?? null,
    source_retention: { policy: manifest.execution?.retain_sources ?? "leaders",
      retained: sourceRecords.filter((i) => i.retention === "retained").length,
      pending: sourceRecords.filter((i) => i.retention === "pending").length,
      not_retained: sourceRecords.filter((i) => i.retention === "not-retained").length },
  };
}

/** Refuse use when an identity-bearing external input is unavailable. */
export async function validateResume(manifestPath, { allow_retained_sources = false } = {}) {
  const manifest = loadManifest(manifestPath);
  const inputs = manifest.identity_inputs;
  const target = String(inputs.target.path);
  if (!isFile(target)) throw new FileNotFoundError(`campaign target no longer exists: ${target}`);
  if (fileSha256(target) !== inputs.target.sha256) throw new ValueError("campaign target hash changed; start a new campaign");
  const info = inputs.compile;
  const cwd = String(info.working_directory);
  if (!isDir(cwd)) throw new FileNotFoundError(`compiler working directory no longer exists: ${cwd}`);
  const same = (a, b) => canonicalJson(a) === canonicalJson(b);
  if (!same(executableIdentity([info.compiler.requested], { cwd }), info.compiler)) throw new ValueError("compiler identity changed; start a new campaign");
  if (!same(executableIdentity([inputs.objdump.requested], { cwd }), inputs.objdump)) throw new ValueError("objdump identity changed; start a new campaign");
  const toolchain = inputs.toolchain;
  if (isDict(toolchain)) {
    const { toolchainStatus } = await import("./toolchain.js");
    const report = await toolchainStatus(toolchain.directory);
    const mp = String(toolchain.manifest);
    if (!report.integrity || !isFile(mp) || fileSha256(mp) !== toolchain.manifest_sha256) throw new ValueError("toolchain identity changed; start a new campaign");
  }
  const experiment = inputs.experiment;
  if (isDict(experiment)) {
    const { loadExperiment } = await import("./experiments.js");
    if (typeof experiment.path !== "string") throw new ValueError("campaign experiment identity is incomplete");
    const current = (await loadExperiment(experiment.path)).identityReceipt();
    if (!same(current, experiment)) throw new ValueError("experiment controls/signals/coverage changed; start a new campaign");
  }
  for (const source of manifest.sources ?? []) {
    const p = String(source.path);
    if (isFile(p) && fileSha256(p) === source.sha256) continue;
    if (allow_retained_sources) { durableSourcePath(source); continue; }
    if (!isFile(p)) throw new FileNotFoundError(`campaign source no longer exists at its identity-bearing path: ${p}; the retained copy remains available for finish and package, but resume could change path-sensitive output`);
    throw new ValueError(`campaign source hash changed: ${p}; start a new campaign`);
  }
  return manifest;
}

/** Only source paths not represented in the append-only ledger. */
export function remainingSources(manifest) {
  const [records] = readLedger(String(manifest.ledger));
  const represented = new Set(records.filter((r) => r.cache_key).map((r) => String(r.cache_key)));
  return (manifest.sources ?? []).filter((i) => !represented.has(String(i.cache_key ?? "None"))).map((i) => String(i.path));
}

function bookends(items, limit) {
  if (items.length <= limit) return [[...items], false];
  const first = Math.floor(limit / 2);
  return [[...items.slice(0, first), ...items.slice(items.length - (limit - first))], true];
}

/** Bound shareable campaign collections and state every omitted count. */
export function boundedExportStatus(status) {
  const result = { ...status };
  const bounds = {};
  for (const [name, limit] of [["trajectory", EXPORT_TRAJECTORY_LIMIT], ["mechanism_trajectory", EXPORT_TRANSITION_LIMIT], ["basin_transitions", EXPORT_TRANSITION_LIMIT], ["failures", EXPORT_FAILURE_LIMIT]]) {
    const original = [...(status[name] ?? [])];
    const [selected, truncated] = bookends(original, limit);
    result[name] = selected;
    bounds[name] = { total: original.length, included: selected.length, truncated };
  }
  result.acceptance_trajectory = result.trajectory;
  const basins = [];
  let omitted = 0;
  for (const original of status.object_basins ?? []) {
    const basin = { ...original };
    const sources = [...(original.sources ?? [])];
    const [selected, truncated] = bookends(sources, EXPORT_BASIN_SOURCE_LIMIT);
    basin.sources = selected; basin.sources_total = sources.length; basin.sources_truncated = truncated;
    omitted += sources.length - selected.length;
    basins.push(basin);
  }
  result.object_basins = basins;
  bounds.object_basin_sources = { total: (status.object_basins ?? []).reduce((s, b) => s + (b.sources ?? []).length, 0),
    included: basins.reduce((s, b) => s + b.sources.length, 0), truncated: omitted > 0 };
  result.export_bounds = bounds;
  return result;
}

/** A bounded, shareable campaign report. */
export async function exportStatus(manifestPath) {
  return { schema: EXPORT_SCHEMA, generated_at_unix: Date.now() / 1000, campaign: boundedExportStatus(await buildStatus(manifestPath)),
    proof: "Function-level object evidence only; run the project's link, ROM, and collateral checks before integration." };
}

export { pyStrValue };
