// candidate-lifecycle.js - immutable campaign current/best artifacts and
// guarded materialization. An artifact is addressed by the hashes of its
// source and object; checkpoint, restore and accept all run under the
// manifest's one transaction lock, and restore refuses to clobber a
// destination that drifted since it was checkpointed.
//
// Plain JS ESM + JSDoc.

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { ValueError } from "./py.js";
import { artifactRecord, exclusiveFileLock, fileSha256, verifyArtifactRecord, writeJsonAtomic } from "./evidence.js";
import { canonicalJson, resolvePath } from "./campaign.js";
import { FileNotFoundError, OSError } from "./py-extra.js";

export const ARTIFACT_SCHEMA = "decomp-workbench-candidate-artifact-v1";
export const POINTER_SCHEMA = "decomp-workbench-candidate-pointer-v1";
export const CHECKPOINT_SCHEMA = "decomp-workbench-campaign-checkpoint-v1";
export const RESTORE_SCHEMA = "decomp-workbench-campaign-restore-v1";
export const ACCEPT_SCHEMA = "decomp-workbench-campaign-accept-v1";

const isMap = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const same = (a, b) => canonicalJson(a) === canonicalJson(b);
const suffixOf = (p) => { const b = path.basename(String(p)); const i = b.lastIndexOf("."); return i > 0 ? b.slice(i) : ""; };

function artifactId(sourceSha, objectSha) {
  return createHash("sha256").update(Buffer.from(`${sourceSha}\0${objectSha || "-"}`, "utf8")).digest("hex").slice(0, 24);
}

function copyExclusive(source, destination, expected) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  if (fs.existsSync(destination)) {
    if (!isFile(destination) || fileSha256(destination) !== expected) throw new ValueError(`immutable campaign artifact changed: ${destination}`);
    return;
  }
  try {
    const fd = fs.openSync(destination, "wx", 0o644);
    try { fs.writeSync(fd, fs.readFileSync(source)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  } catch (e) { if (e.code !== "EEXIST") fs.rmSync(destination, { force: true }); throw e; }
  if (fileSha256(destination) !== expected) { fs.rmSync(destination, { force: true }); throw new ValueError(`campaign artifact copy failed verification: ${destination}`); }
}

/** Archive one source/object pair by content identity; never overwrite it. */
export function archiveCandidate(campaignDirectory, { source, object_path }) {
  const sourcePath = resolvePath(source);
  const sourceRecord = artifactRecord(sourcePath, { role: "candidate-source" });
  const objectRecord = object_path !== null && object_path !== undefined ? artifactRecord(object_path, { role: "candidate-object" }) : null;
  const identifier = artifactId(sourceRecord.sha256, objectRecord ? objectRecord.sha256 : null);
  const directory = path.join(String(campaignDirectory), "artifacts", identifier);
  return exclusiveFileLock(path.join(path.dirname(directory), `.${identifier}.lock`), () => {
    const sourceCopy = path.join(directory, "source");
    copyExclusive(sourcePath, sourceCopy, sourceRecord.sha256);
    let objectCopy = null;
    if (objectRecord !== null) { objectCopy = path.join(directory, "object"); copyExclusive(objectRecord.path, objectCopy, objectRecord.sha256); }
    const record = { schema: ARTIFACT_SCHEMA, id: identifier, source: artifactRecord(sourceCopy, { role: "archived-source" }),
      object: objectCopy !== null ? artifactRecord(objectCopy, { role: "archived-object" }) : null };
    const metadata = path.join(directory, "artifact.json");
    if (fs.existsSync(metadata)) {
      const existing = JSON.parse(fs.readFileSync(metadata, "utf8"));
      if (!same(existing, record)) throw new ValueError(`immutable candidate metadata disagrees: ${metadata}`);
    } else writeJsonAtomic(metadata, record);
    return record;
  });
}

function candidatePointer(artifact, { role, source, object_path, comparison }) {
  return { schema: POINTER_SCHEMA, role, id: artifact.id, artifact: { ...artifact },
    origin: { source: artifactRecord(source, { role: "candidate-source" }),
      object: object_path !== null && object_path !== undefined ? artifactRecord(object_path, { role: "candidate-object" }) : null },
    comparison: comparison ? { ...comparison } : null };
}

function pointerArtifact(pointer, { role }) {
  if (pointer.schema !== POINTER_SCHEMA) throw new ValueError(`${role} checkpoint schema must be ${POINTER_SCHEMA}`);
  const artifact = pointer.artifact;
  if (!isMap(artifact) || artifact.schema !== ARTIFACT_SCHEMA) throw new ValueError(`${role} checkpoint has no immutable candidate artifact`);
  if (pointer.id !== artifact.id) throw new ValueError(`${role} checkpoint and candidate artifact IDs disagree`);
  return artifact;
}

function verifyArchivedArtifact(artifact, { campaign_directory, role }) {
  const identifier = artifact.id;
  if (typeof identifier !== "string" || identifier.length !== 24) throw new ValueError(`${role} candidate has an invalid artifact id`);
  const source = verifyArtifactRecord(artifact.source, { where: `archived ${role} source` });
  const objectRecord = artifact.object !== null && artifact.object !== undefined ? verifyArtifactRecord(artifact.object, { where: `archived ${role} object` }) : null;
  if (identifier !== artifactId(source.sha256, objectRecord ? objectRecord.sha256 : null)) throw new ValueError(`${role} candidate id disagrees with archived contents`);
  const directory = resolvePath(path.join(String(campaign_directory), "artifacts", identifier));
  if (String(source.path) !== path.join(directory, "source")) throw new ValueError(`${role} candidate source is outside its immutable archive`);
  if (objectRecord !== null && String(objectRecord.path) !== path.join(directory, "object")) throw new ValueError(`${role} candidate object is outside its immutable archive`);
  const metadata = path.join(directory, "artifact.json");
  let recorded;
  try { recorded = JSON.parse(fs.readFileSync(metadata, "utf8")); } catch (e) { throw new ValueError(`cannot validate immutable candidate metadata: ${e.message}`); }
  if (!same(recorded, artifact)) throw new ValueError(`${role} candidate disagrees with immutable metadata`);
  return [source, objectRecord];
}

function sourceRecordForBest(manifest, best) {
  const matches = (manifest.sources ?? []).filter((i) => isMap(i) && i.cache_key === best.cache_key);
  if (matches.length !== 1) throw new ValueError("best campaign candidate has no unique source record");
  return matches[0];
}

async function state() { return import("./campaign-state.js"); }

/** Archive current/best under one manifest transaction lock. */
export async function checkpointCampaign(manifestPath, { current_source = null, current_object = null } = {}) {
  const S = await state();
  const p = S.resolveManifest(manifestPath);
  return exclusiveFileLock(S.manifestLockPath(p), async () => {
    const manifest = S.loadManifest(p);
    const status = await S.buildStatus(p);
    const best = status.best;
    if (!isMap(best)) throw new ValueError("campaign has no successful candidate to checkpoint");
    const sourceRecord = sourceRecordForBest(manifest, best);
    const bestSource = S.durableSourcePath(sourceRecord);
    if (best.source_sha256 !== sourceRecord.sha256) throw new ValueError("best campaign source hash disagrees with its manifest record");
    const bestObject = path.join(String(manifest.cache_directory), `${String(best.cache_key ?? "")}.o`);
    if (!isFile(bestObject)) throw new FileNotFoundError(`best candidate object is absent: ${bestObject}`);
    if (best.object_sha256 !== fileSha256(bestObject)) throw new ValueError("best campaign object hash disagrees with its ledger record");
    const bestArchive = archiveCandidate(path.dirname(p), { source: bestSource, object_path: bestObject });
    const bestArtifact = candidatePointer(bestArchive, { role: "best", source: bestSource, object_path: bestObject, comparison: isMap(best.comparison) ? best.comparison : null });
    let currentArtifact = null;
    if (current_source !== null && current_source !== undefined) {
      const currentArchive = archiveCandidate(path.dirname(p), { source: current_source, object_path: current_object });
      currentArtifact = candidatePointer(currentArchive, { role: "current", source: current_source, object_path: current_object, comparison: null });
    }
    const artifacts = { ...(manifest.artifacts || {}) };
    artifacts.best = bestArtifact;
    if (currentArtifact !== null) artifacts.current = currentArtifact;
    manifest.artifacts = artifacts;
    writeJsonAtomic(p, manifest);
    return { schema: CHECKPOINT_SCHEMA, manifest: p, current: currentArtifact, best: bestArtifact,
      same: currentArtifact !== null && currentArtifact.id === bestArtifact.id };
  });
}

function utcStamp() {
  const d = new Date();
  const z = (n, w = 2) => String(n).padStart(w, "0");
  return `${d.getUTCFullYear()}${z(d.getUTCMonth() + 1)}${z(d.getUTCDate())}T${z(d.getUTCHours())}${z(d.getUTCMinutes())}${z(d.getUTCSeconds())}Z`;
}

/** Restore best under the same lock used by checkpoint and acceptance. */
export async function restoreBest(manifestPath, { destination, allow_drift = false }) {
  const S = await state();
  const p = S.resolveManifest(manifestPath);
  return exclusiveFileLock(S.manifestLockPath(p), () => {
    const manifest = S.loadManifest(p);
    const artifacts = manifest.artifacts;
    if (!isMap(artifacts) || !isMap(artifacts.best)) throw new ValueError("campaign has no best checkpoint; run campaign checkpoint");
    const best = artifacts.best;
    const archived = pointerArtifact(best, { role: "best" });
    const [sourceRecord] = verifyArchivedArtifact(archived, { campaign_directory: path.dirname(p), role: "best" });
    const archivedSource = String(sourceRecord.path), expected = String(sourceRecord.sha256);
    const target = resolvePath(destination);
    let backup = null, before = null;
    if (fs.existsSync(target)) {
      before = artifactRecord(target, { role: "destination-before" });
      const current = artifacts.current;
      if (!allow_drift && isMap(current) && isMap(current.origin) && isMap(current.origin.source)
        && resolvePath(String(current.origin.source.path ?? "")) === target && current.origin.source.sha256 !== before.sha256) {
        throw new ValueError("destination changed since the current checkpoint; checkpoint it again or pass --allow-drift explicitly");
      }
      const backupDir = path.join(path.dirname(p), "backups");
      fs.mkdirSync(backupDir, { recursive: true });
      backup = path.join(backupDir, `${utcStamp()}-${String(before.sha256).slice(0, 12)}${suffixOf(target)}`);
      copyExclusive(target, backup, before.sha256);
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const temporary = path.join(path.dirname(target), `.${path.basename(target)}.restore-${best.id}`);
    if (fs.existsSync(temporary)) throw Object.assign(new OSError(`stale restore temporary exists: ${temporary}`), { kind: "FileExistsError" });
    copyExclusive(archivedSource, temporary, expected);
    try {
      if (before === null) { if (fs.existsSync(target)) throw new ValueError("destination appeared during restore; refusing overwrite"); }
      else if (artifactRecord(target, { role: "destination-before-install" }).sha256 !== before.sha256) throw new ValueError("destination changed during restore; refusing overwrite");
      fs.renameSync(temporary, target);
    } finally { fs.rmSync(temporary, { force: true }); }
    const after = artifactRecord(target, { role: "destination-after" });
    if (after.sha256 !== expected) throw new ValueError("restored source failed its final hash check");
    return { schema: RESTORE_SCHEMA, manifest: p, best_id: best.id, destination: target, before, after,
      backup: backup ? artifactRecord(backup, { role: "backup" }) : null };
  });
}

/** Accept best under the same lock used by checkpoint and restoration. */
export async function acceptBest(manifestPath, { allow_mismatch = false } = {}) {
  const S = await state();
  const p = S.resolveManifest(manifestPath);
  return exclusiveFileLock(S.manifestLockPath(p), () => {
    const manifest = S.loadManifest(p);
    const artifacts = manifest.artifacts;
    const best = isMap(artifacts) ? artifacts.best : null;
    if (!isMap(best)) throw new ValueError("campaign has no best checkpoint; run campaign checkpoint");
    const artifact = pointerArtifact(best, { role: "best" });
    const [source, objectRecord] = verifyArchivedArtifact(artifact, { campaign_directory: path.dirname(p), role: "best" });
    const exact = isMap(best.comparison) && best.comparison.exact === true;
    if (!exact && !allow_mismatch) throw new ValueError("best checkpoint is not exact; pass --allow-mismatch only for an intentional non-terminal acceptance");
    const accepted = { artifact_id: best.id, source_sha256: source.sha256, object_sha256: objectRecord ? objectRecord.sha256 : null, exact };
    manifest.accepted = accepted;
    writeJsonAtomic(p, manifest);
    return { schema: ACCEPT_SCHEMA, manifest: p, accepted };
  });
}
