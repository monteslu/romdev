// notes.js - append-safe notes for a shared findings log.
//
// The durable record is never the shared file. `note add` writes each note
// to its own new file under a sidecar directory (notesDirectory), created
// exclusively, and never opens the log for writing: a whole-file rewrite of
// the log cannot destroy a file it does not touch, and two concurrent adds
// cannot collide because neither reuses a name. `note list` renders the log's
// entries plus every pending note; `note merge` folds pending notes into the
// log under an exclusive lock with O_APPEND and moves the merged files aside
// rather than deleting them. Contract: a note, once written, cannot be lost
// by a concurrent writer.
//
// Plain JS ESM + JSDoc.

import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { ValueError, sorted, strRepr, splitlines, reEscape } from "./py.js";
import { dumps } from "./pyjson.js";
import { osText, isOSError } from "./py-path.js";

export const NOTE_SCHEMA = "decomp-workbench-note-v1";
export const NOTES_SUFFIX = ".notes.d";
export const MERGED_DIRECTORY = "merged";
export const RESERVED_DIRECTORY = "reserved";
export const RESERVATION_SCHEMA = "decomp-workbench-note-reservation-v1";
const NUMBERED_ID_RE = /^(?<prefix>[A-Za-z][A-Za-z0-9_.]*)-(?<number>\d+)$/;
const HEADING_RE = /^#{2,}\s+(?<id>[A-Za-z][A-Za-z0-9_.]*[-_]?\d[A-Za-z0-9_.-]*)\s*(?:[-\u2014:]+\s*)?(?<title>.*)$/;
const STATUS_RE = /^\s*\*{0,2}Status\*{0,2}\s*:\s*\*{0,2}\s*(?<status>.+?)\s*$/;
const DASH = "\u2014";

/** A note could not be written or read; every message names the file and the fix. */
export class NoteError extends ValueError {
  constructor(message) { super(message); this.name = "ValueError"; this.noteError = true; }
}

/** str(Path(p)) */
export function pathStr(p) {
  let s = path.normalize(String(p));
  if (s.length > 1 && s.endsWith("/")) s = s.slice(0, -1);
  return s;
}

function writeAll(fd, payload) {
  let offset = 0;
  while (offset < payload.length) {
    const written = fs.writeSync(fd, payload, offset);
    if (written <= 0) throw new Error("write returned no progress");
    offset += written;
  }
  fs.fsyncSync(fd);
}

function sleepMs(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } }

/**
 * Serialize one complete merge transaction across processes. The lock is an
 * exclusively created directory holding the owner's pid; a lock whose owner
 * is gone is taken over, which is what an advisory file lock does when its
 * holder dies.
 */
function withMergeLock(log, fn) {
  const directory = notesDirectory(log);
  fs.mkdirSync(directory, { recursive: true });
  const lock = path.join(directory, ".merge.lock.d");
  for (;;) {
    try { fs.mkdirSync(lock); fs.writeFileSync(path.join(lock, "pid"), String(process.pid)); break; } catch (e) {
      if (e.code !== "EEXIST") throw e;
      let owner = 0;
      try { owner = parseInt(fs.readFileSync(path.join(lock, "pid"), "utf8"), 10) || 0; } catch {}
      if (owner && !pidAlive(owner)) { try { fs.rmSync(lock, { recursive: true, force: true }); } catch {} continue; }
      sleepMs(20);
    }
  }
  try { return fn(); } finally { fs.rmSync(lock, { recursive: true, force: true }); }
}

export class Note {
  constructor({ identifier, title, status, body, author, recorded, path: p }) {
    Object.assign(this, { identifier, title, status, body, author, recorded, path: p }); Object.freeze(this);
  }
  asDict() { return { id: this.identifier, title: this.title, status: this.status, body: this.body, author: this.author, recorded: this.recorded, path: pathStr(this.path) }; }
  /** The log section `note merge` appends. */
  asMarkdown() {
    let attribution = `${this.recorded}`;
    if (this.author) attribution += ` by ${this.author}`;
    const lines = [this.title ? `## ${this.identifier} ${DASH} ${this.title}` : `## ${this.identifier}`];
    lines.push(`**Recorded:** ${attribution}`);
    if (this.body.trim()) lines.push("", this.body.trim());
    lines.push("", `**Status:** ${this.status}`);
    return lines.join("\n");
  }
}

export class LogEntry {
  constructor(identifier, title, status, line) { Object.assign(this, { identifier, title, status, line }); Object.freeze(this); }
  asDict() { return { id: this.identifier, title: this.title, status: this.status, line: this.line, source: "log" }; }
}

export class Reservation {
  constructor({ identifier, author, purpose, recorded, path: p }) { Object.assign(this, { identifier, author, purpose, recorded, path: p }); Object.freeze(this); }
  asDict() { return { id: this.identifier, author: this.author, purpose: this.purpose, recorded: this.recorded, path: pathStr(this.path) }; }
}

export class MergedNotes {
  constructor({ log, entries, pending, merged, reserved = [] }) { Object.assign(this, { log, entries, pending, merged, reserved }); Object.freeze(this); }
  /** Identifiers claimed but not yet written under. */
  get unfiled_reservations() {
    const filed = new Set([...this.entries, ...this.pending, ...this.merged].map((x) => x.identifier));
    return this.reserved.filter((r) => !filed.has(r.identifier));
  }
  /** Identifiers both in the log and pending in the sidecar. */
  get duplicate_ids() {
    const known = new Set(this.entries.map((e) => e.identifier));
    return sorted([...new Set(this.pending.filter((n) => known.has(n.identifier)).map((n) => n.identifier))]);
  }
  asDict() {
    return {
      schema: "decomp-workbench-note-list-v1", log: pathStr(this.log),
      entries: this.entries.map((e) => e.asDict()), pending: this.pending.map((n) => n.asDict()),
      merged: this.merged.map((n) => n.asDict()), reserved: this.reserved.map((r) => r.asDict()),
      unfiled_reservations: this.unfiled_reservations.map((r) => r.asDict()),
      pending_count: this.pending.length, duplicate_ids: [...this.duplicate_ids],
    };
  }
}

/** The sidecar directory for `log`, derived from the path, never configured. */
export function notesDirectory(log) {
  const p = pathStr(log);
  return path.join(path.dirname(p), `${path.basename(p)}${NOTES_SUFFIX}`);
}

const pad = (n) => String(n).padStart(2, "0");
function utcNow() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}Z`;
}

function noteFilename(identifier) {
  const d = new Date();
  const stamp = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
  const safe = identifier.replace(/[^A-Za-z0-9_.-]/g, "-") || "note";
  return `${stamp}-${safe}-${randomBytes(4).toString("hex")}.json`;
}

export function reservationsDirectory(log) { return path.join(notesDirectory(log), RESERVED_DIRECTORY); }

const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const jsonFiles = (dir) => sorted(fs.readdirSync(dir).filter((f) => f.endsWith(".json") && !f.startsWith(".")).map((f) => path.join(dir, f)));

function sortKey(identifier) {
  const m = NUMBERED_ID_RE.exec(identifier);
  if (!m) return [identifier, 0, identifier];
  return [m.groups.prefix, parseInt(m.groups.number, 10), identifier];
}

/** Every identifier reservation for `log`. */
export function readReservations(log) {
  const directory = reservationsDirectory(log);
  if (!isDir(directory)) return [];
  const found = [];
  for (const p of jsonFiles(directory)) {
    let payload;
    try { payload = JSON.parse(fs.readFileSync(p, "utf8")); } catch { continue; }
    if (!payload || typeof payload !== "object" || Array.isArray(payload) || payload.schema !== RESERVATION_SCHEMA) continue;
    found.push(new Reservation({ identifier: String(payload.id ?? ""), author: payload.author ? String(payload.author) : null,
      purpose: String(payload.purpose ?? ""), recorded: String(payload.recorded ?? ""), path: p }));
  }
  return sorted(found, (r) => sortKey(r.identifier));
}

function mentionedIdentifiers(text, prefix) {
  const re = new RegExp(`(?<![\\w-])${reEscape(prefix)}-(\\d+)(?![\\w-])`, "g");
  return [...text.matchAll(re)].map((m) => `${prefix}-${m[1]}`);
}

/** Every number already used under `prefix`, wherever it is recorded. */
export function takenIdentifiers(log, { prefix, also = [] }) {
  const view = mergedView(log);
  const identifiers = [...view.entries, ...view.pending, ...view.merged, ...readReservations(log)].map((x) => x.identifier);
  for (const other of also) {
    let text;
    try { text = fs.readFileSync(other, "utf8"); } catch (e) {
      throw new NoteError(`could not read the additional identifier source ${pathStr(other)}: ${osText(e)}`);
    }
    identifiers.push(...mentionedIdentifiers(text, prefix));
  }
  const numbers = new Set();
  for (const id of identifiers) {
    const m = NUMBERED_ID_RE.exec(id.trim());
    if (m && m.groups.prefix === prefix) numbers.add(parseInt(m.groups.number, 10));
  }
  return numbers;
}

function exclusiveWrite(target, text) {
  const fd = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o644);
  try { writeAll(fd, Buffer.from(text, "utf8")); } finally { fs.closeSync(fd); }
}

/** Claim `count` unused identifiers under `prefix`, atomically (the claim is the file). */
export function reserveIdentifiers(log, { prefix = "WB", count = 1, author = null, purpose = "", start = null, also = [] } = {}) {
  prefix = prefix.trim();
  if (!prefix || !NUMBERED_ID_RE.test(`${prefix}-1`)) {
    throw new NoteError(`${strRepr(prefix)} is not an identifier prefix. Write the part before the number, e.g. --prefix WB for WB-122.`);
  }
  if (count < 1) throw new NoteError("--count must be at least 1");
  const directory = reservationsDirectory(log);
  try { fs.mkdirSync(directory, { recursive: true }); } catch (e) {
    throw new NoteError(`could not create the reservation directory ${directory}: ${osText(e)}`);
  }
  const taken = takenIdentifiers(log, { prefix, also });
  let candidate = start === null || start === undefined ? (taken.size ? Math.max(...taken) : 0) : start - 1;
  const claimed = [];
  let attempts = 0;
  while (claimed.length < count) {
    candidate += 1;
    attempts += 1;
    if (attempts > count + taken.size + 1000) throw new NoteError(`could not claim ${count} identifier(s) under ${prefix}: stopped after ${attempts} attempts`);
    if (taken.has(candidate)) continue;
    const identifier = `${prefix}-${candidate}`;
    const recorded = utcNow();
    const payload = { schema: RESERVATION_SCHEMA, id: identifier, author, purpose, recorded };
    const target = path.join(directory, `${identifier}.json`);
    try { exclusiveWrite(target, dumps(payload) + "\n"); } catch (e) {
      if (e.code === "EEXIST") { taken.add(candidate); continue; }
      throw new NoteError(`could not write the reservation ${target}: ${osText(e)}`);
    }
    claimed.push(new Reservation({ identifier, author, purpose, recorded, path: target }));
  }
  return claimed;
}

/** Write one note to the log's sidecar directory and return it; the log is never opened. */
export function addNote(log, { identifier, title = "", status = "LOGGED", body = "", author = null, force = false }) {
  identifier = identifier.trim();
  if (!identifier) throw new NoteError("a note needs a non-empty --id, e.g. --id WB-54");
  if (!force) {
    const reserved = readReservations(log).find((r) => r.identifier === identifier) ?? null;
    if (reserved && (reserved.author || null) !== (author || null)) {
      const owner = reserved.author || "an unnamed filer";
      const m = NUMBERED_ID_RE.exec(identifier);
      const prefix = m ? m.groups.prefix : "WB";
      const purposeText = reserved.purpose ? `: ${reserved.purpose}` : "";
      throw new NoteError(`${identifier} is reserved by ${owner} (${reserved.recorded})${purposeText}.\n`
        + `Claim your own with \`note reserve --prefix ${prefix}\`, pass --author to file under your own reservation, or --force if you really mean to write under this one.`);
    }
  }
  const directory = notesDirectory(log);
  try { fs.mkdirSync(directory, { recursive: true }); } catch (e) {
    throw new NoteError(`could not create the notes directory ${directory}: ${osText(e)}`);
  }
  const recorded = utcNow();
  const st = status.trim() || "LOGGED";
  const payload = { schema: NOTE_SCHEMA, id: identifier, title: title.trim(), status: st, body, author, recorded };
  const target = path.join(directory, noteFilename(identifier));
  try { exclusiveWrite(target, dumps(payload) + "\n"); } catch (e) {
    throw new NoteError(`could not write the note ${target}: ${osText(e)}`);
  }
  return new Note({ identifier, title: title.trim(), status: st, body, author, recorded, path: target });
}

function loadNote(p) {
  let payload;
  try { payload = JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || payload.schema !== NOTE_SCHEMA) return null;
  return new Note({ identifier: String(payload.id ?? ""), title: String(payload.title ?? ""), status: String(payload.status ?? "LOGGED"),
    body: String(payload.body ?? ""), author: payload.author ? String(payload.author) : null, recorded: String(payload.recorded ?? ""), path: p });
}

/** The sidecar notes for `log`, pending by default. */
export function readNotes(log, { merged = false } = {}) {
  let directory = notesDirectory(log);
  if (merged) directory = path.join(directory, MERGED_DIRECTORY);
  if (!isDir(directory)) return [];
  const found = jsonFiles(directory).map(loadNote).filter(Boolean);
  return sorted(found, (n) => [n.recorded, path.basename(n.path)]);
}

/** The identified entries a Markdown findings log already carries. */
export function parseLogEntries(text) {
  const entries = [];
  let id = null, title = "", lineNo = 0, status = null;
  splitlines(text).forEach((line, idx) => {
    const h = HEADING_RE.exec(line);
    if (h) {
      if (id !== null) entries.push(new LogEntry(id, title, status, lineNo));
      id = h.groups.id; title = h.groups.title.trim(); lineNo = idx + 1; status = null;
      return;
    }
    if (id !== null && status === null) {
      const s = STATUS_RE.exec(line);
      if (s) status = s.groups.status.replace(/\.+$/, "");
    }
  });
  if (id !== null) entries.push(new LogEntry(id, title, status, lineNo));
  return entries;
}

/** The log's own entries together with the sidecar notes. */
export function mergedView(log) {
  const p = pathStr(log);
  let text = "";
  try {
    const st = fs.statSync(p, { throwIfNoEntry: false });
    if (st && st.isFile()) text = fs.readFileSync(p, "utf8");
  } catch (e) { throw new NoteError(`could not read the log ${p}: ${osText(e)}`); }
  return new MergedNotes({ log: p, entries: parseLogEntries(text), pending: readNotes(p), merged: readNotes(p, { merged: true }), reserved: readReservations(p) });
}

/** Fold every pending sidecar note into the log and return what moved. */
export function mergeNotes(log, { dry_run = false } = {}) {
  const p = pathStr(log);
  if (dry_run) return readNotes(p);
  try {
    return withMergeLock(p, () => {
      const pending = readNotes(p);
      if (!pending.length) return [];
      const sections = pending.map((n) => n.asMarkdown()).join("\n\n");
      const fd = fs.openSync(p, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND, 0o644);
      try { writeAll(fd, Buffer.from("\n" + sections + "\n", "utf8")); } finally { fs.closeSync(fd); }
      const archive = path.join(notesDirectory(p), MERGED_DIRECTORY);
      fs.mkdirSync(archive, { recursive: true });
      for (const n of pending) fs.renameSync(n.path, path.join(archive, path.basename(n.path)));
      return pending;
    });
  } catch (e) {
    if (e instanceof NoteError) throw e;
    if (isOSError(e)) throw new NoteError(`could not merge notes into ${p}: ${osText(e)}`);
    throw e;
  }
}
