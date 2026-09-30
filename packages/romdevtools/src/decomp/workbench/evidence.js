// evidence.js - small, hash-bound evidence primitives shared by durable
// receipts: file identities, re-verified artifact records, one-object JSON
// reads, atomic JSON writes and a cross-process exclusive lock.
//
// Plain JS ESM + JSDoc.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash, randomBytes } from "node:crypto";
import { ValueError } from "./py.js";
import { dumps } from "./pyjson.js";

/** An evidence document is malformed, stale, or internally inconsistent. */
export class EvidenceError extends ValueError { constructor(message) { super(message); this.name = "ValueError"; this.kind = "EvidenceError"; } }

const expandUser = (p) => (p === "~" || p.startsWith("~/") ? os.homedir() + p.slice(1) : p);
const resolvePath = (p) => { const abs = path.resolve(expandUser(String(p))); try { return fs.realpathSync(abs); } catch { return abs; } };

/** Hash one file in blocks. */
export function fileSha256(p) {
  const digest = createHash("sha256");
  const fd = fs.openSync(String(p), "r");
  try {
    const buf = Buffer.allocUnsafe(1024 * 1024);
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) digest.update(buf.subarray(0, n));
  } finally { fs.closeSync(fd); }
  return digest.digest("hex");
}

/** Python's OSError text for a node fs error. */
export function oserr(e) {
  const map = { ENOENT: [2, "No such file or directory"], EACCES: [13, "Permission denied"], EISDIR: [21, "Is a directory"], ENOTDIR: [20, "Not a directory"], EEXIST: [17, "File exists"] };
  const m = map[e?.code];
  return m ? `[Errno ${m[0]}] ${m[1]}: '${e.path}'` : String(e?.message ?? e);
}

/** Describe one stable regular file by resolved path and content identity. */
export function artifactRecord(p, { role }) {
  if (!role) throw new EvidenceError("artifact role must be a non-empty string");
  const location = resolvePath(p);
  const digest = createHash("sha256");
  let before, after, current;
  try {
    const fd = fs.openSync(location, "r");
    try {
      before = fs.fstatSync(fd, { bigint: true });
      if (!before.isFile()) throw new EvidenceError(`${role} is not a regular file: ${location}`);
      const buf = Buffer.allocUnsafe(1024 * 1024);
      let n;
      while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) digest.update(buf.subarray(0, n));
      after = fs.fstatSync(fd, { bigint: true });
    } finally { fs.closeSync(fd); }
    current = fs.statSync(location, { bigint: true });
  } catch (e) {
    if (e instanceof EvidenceError) throw e;
    throw new EvidenceError(`cannot capture ${role} ${location}: ${oserr(e)}`);
  }
  const identity = (s) => [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].join(":");
  if (identity(before) !== identity(after) || identity(after) !== identity(current)) {
    throw new EvidenceError(`${role} changed while it was being captured: ${location}`);
  }
  return { role, path: location, sha256: digest.digest("hex"), size: Number(after.size) };
}

const isMapping = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** Validate and re-hash an artifact record, refusing moved or stale inputs. */
export function verifyArtifactRecord(value, { where }) {
  if (!isMapping(value)) throw new EvidenceError(`${where} must be an artifact object`);
  const { path: p, role, sha256: digest, size } = value;
  if (typeof role !== "string" || !role) throw new EvidenceError(`${where}.role must be a non-empty string`);
  if (typeof p !== "string" || !p) throw new EvidenceError(`${where}.path must be a non-empty string`);
  if (typeof digest !== "string" || digest.length !== 64 || /[^0-9a-f]/.test(digest)) throw new EvidenceError(`${where}.sha256 must be a lowercase SHA-256 digest`);
  if (!Number.isInteger(size) || typeof size !== "number" || size < 0) throw new EvidenceError(`${where}.size must be a non-negative integer`);
  const current = artifactRecord(p, { role });
  if (current.size !== size || current.sha256 !== digest) throw new EvidenceError(`${where} is stale: ${p} no longer has the recorded content`);
  return current;
}

/** Read exactly one JSON object with a concise domain error. */
export function loadJsonObject(p, { where }) {
  const location = expandUser(String(p));
  let text, value;
  try { text = fs.readFileSync(location, "utf8"); } catch (e) { throw new EvidenceError(`cannot read ${where} ${location}: ${oserr(e)}`); }
  try { value = JSON.parse(text); } catch (e) { throw new EvidenceError(`${where} ${location} is not valid JSON: ${e.message}`); }
  if (!isMapping(value)) throw new EvidenceError(`${where} ${location} must contain a JSON object`);
  return value;
}

/** Atomically replace an owned JSON state file after syncing its contents. */
export function writeJsonAtomic(p, value) {
  const destination = String(p);
  fs.mkdirSync(path.dirname(path.resolve(destination)), { recursive: true });
  const temporary = path.join(path.dirname(path.resolve(destination)), `.${path.basename(destination)}.${randomBytes(6).toString("hex")}`);
  try {
    const fd = fs.openSync(temporary, "wx", 0o600);
    try { fs.writeSync(fd, dumps(value) + "\n"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, destination);
    try { const dfd = fs.openSync(path.dirname(path.resolve(destination)), "r"); try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); } } catch { /* directory sync is best effort */ }
  } finally { fs.rmSync(temporary, { force: true }); }
  return destination;
}

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } }

/**
 * Serialize one short state transaction across processes. The lock file is
 * created (holding one byte) like the original; mutual exclusion is an
 * atomically created sibling directory naming its holder, reclaimed when that
 * holder has exited.
 */
export function exclusiveFileLock(p, fn) {
  const location = String(p);
  fs.mkdirSync(path.dirname(path.resolve(location)), { recursive: true });
  const fd = fs.openSync(location, fs.constants.O_RDWR | fs.constants.O_CREAT, 0o644);
  try { if (fs.fstatSync(fd).size === 0) { fs.writeSync(fd, Buffer.from([0])); fs.fsyncSync(fd); } } finally { fs.closeSync(fd); }
  const held = `${location}.held`;
  for (;;) {
    try { fs.mkdirSync(held); fs.writeFileSync(path.join(held, "pid"), String(process.pid)); break; }
    catch (e) {
      if (e.code !== "EEXIST") throw e;
      let owner = null;
      try { owner = parseInt(fs.readFileSync(path.join(held, "pid"), "utf8"), 10); } catch { /* being written */ }
      if (owner && !pidAlive(owner)) { fs.rmSync(held, { recursive: true, force: true }); continue; }
      sleep(10);
    }
  }
  const release = () => fs.rmSync(held, { recursive: true, force: true });
  let result;
  try { result = fn(); } catch (e) { release(); throw e; }
  if (result && typeof result.then === "function") return result.finally(release);
  release();
  return result;
}
