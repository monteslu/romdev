// cache.js - safe inspection and recoverable pruning for the
// content-addressed object cache. Applying a prune never unlinks an object:
// files move into a dated trash directory, and `cache restore` moves them
// back without overwriting anything.
//
// Plain JS ESM + JSDoc.

import fs from "node:fs";
import path from "node:path";
import { ValueError, strRepr, sum, fixed, sorted } from "./py.js";
import { resolvePath, rglob, isSymlink, isFile, isDir, mtimeSeconds, osError, relativeTo } from "./py-path.js";

export const CACHE_STATUS_SCHEMA = "decomp-workbench-cache-status-v1";
export const CACHE_PRUNE_SCHEMA = "decomp-workbench-cache-prune-v1";
const DURATION_RE = /(\d+(?:\.\d+)?)([smhdw])/g;
export const DURATION_UNITS = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 };
const SIZE_RE = /^(\d+(?:\.\d+)?)\s*([kmgt]?i?b?)?$/i;
export const SIZE_UNITS = { "": 1, b: 1, k: 1024, kb: 1024, kib: 1024, m: 1024 ** 2, mb: 1024 ** 2, mib: 1024 ** 2,
  g: 1024 ** 3, gb: 1024 ** 3, gib: 1024 ** 3, t: 1024 ** 4, tb: 1024 ** 4, tib: 1024 ** 4 };

export class CacheEntry {
  constructor({ path: p, bytes, modified_at_unix }) { Object.assign(this, { path: p, bytes, modified_at_unix }); Object.freeze(this); }
  asDict({ now }) {
    return { path: this.path, bytes: this.bytes, modified_at_unix: this.modified_at_unix, age_seconds: Math.max(0.0, now - this.modified_at_unix) };
  }
}

/** Parse a compact duration such as 30d, 12h, or 1w2d. */
export function parseDuration(value) {
  const text = value.trim().toLowerCase();
  if (!text) throw new ValueError("duration must not be empty");
  let position = 0, seconds = 0;
  for (const m of text.matchAll(DURATION_RE)) {
    if (m.index !== position) throw new ValueError(`invalid duration ${strRepr(value)}; use combinations such as 30d or 1w2d`);
    seconds += parseFloat(m[1]) * DURATION_UNITS[m[2]];
    position = m.index + m[0].length;
  }
  if (position !== text.length || seconds <= 0) throw new ValueError(`invalid duration ${strRepr(value)}; use combinations such as 30d or 1w2d`);
  return seconds;
}

/** Parse a byte limit such as 500MiB or 2G. */
export function parseSize(value) {
  const m = SIZE_RE.exec(value.trim());
  if (!m) throw new ValueError(`invalid size ${strRepr(value)}; use values such as 500MiB or 2G`);
  const unit = (m[2] ?? "").toLowerCase();
  if (!(unit in SIZE_UNITS)) throw new ValueError(`invalid size unit in ${strRepr(value)}`);
  const size = Math.trunc(parseFloat(m[1]) * SIZE_UNITS[unit]);
  if (size <= 0) throw new ValueError("size must be positive");
  return size;
}

/** A compact IEC byte count (exact bytes stay in JSON). */
export function formatBytes(size) {
  let value = size;
  for (const unit of ["B", "KiB", "MiB", "GiB"]) {
    if (value < 1024 || unit === "GiB") return unit === "B" ? `${Math.trunc(value)} ${unit}` : `${fixed(value, 1)} ${unit}`;
    value /= 1024;
  }
  return `${fixed(value, 1)} TiB`;
}

/** Regular cache files, never following directory symlinks, oldest first. */
export function cacheEntries(p) {
  const root = resolvePath(p);
  if (!fs.existsSync(root)) return [];
  if (!isDir(root)) throw osError(`cache path is not a directory: ${root}`, "ENOTDIR");
  const entries = [];
  for (const item of rglob(root)) {
    if (isSymlink(item) || !isFile(item)) continue;
    const st = fs.statSync(item, { bigint: true });
    entries.push(new CacheEntry({ path: item, bytes: Number(st.size), modified_at_unix: mtimeSeconds(st) }));
  }
  return sorted(entries, (e) => [e.modified_at_unix, path.basename(e.path)]);
}

/** A bounded cache inventory. */
export function cacheStatus(p) {
  const root = resolvePath(p);
  const now = Date.now() / 1000;
  const entries = cacheEntries(root);
  const total = sum(entries.map((e) => e.bytes));
  return {
    schema: CACHE_STATUS_SCHEMA, path: root, exists: isDir(root), files: entries.length, bytes: total,
    human_bytes: formatBytes(total),
    oldest_modified_at_unix: entries.length ? entries[0].modified_at_unix : null,
    newest_modified_at_unix: entries.length ? entries.at(-1).modified_at_unix : null,
    entries: entries.map((e) => e.asDict({ now })),
  };
}

const pad2 = (n) => String(n).padStart(2, "0");
function gmStamp(now) {
  const d = new Date(Math.floor(now) * 1000);
  return `cache-${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}-${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}${pad2(d.getUTCSeconds())}`;
}

function moveFile(from, to) {
  try { fs.renameSync(from, to); } catch (e) {
    if (e.code !== "EXDEV") throw e;
    // Trash on another volume stays recoverable, though not atomic.
    fs.copyFileSync(from, to);
    const st = fs.statSync(from);
    fs.utimesSync(to, st.atime, st.mtime);
    fs.unlinkSync(from);
  }
}

/** Plan or recoverably apply a cache prune. */
export function pruneCache(p, { older_than = null, max_size = null, keep_recent = 0, apply, trash_root }) {
  const root = resolvePath(p);
  if (older_than === null && max_size === null) throw new ValueError("prune needs --older-than, --max-size, or both");
  if (older_than !== null && older_than <= 0) throw new ValueError("older_than must be positive");
  if (max_size !== null && max_size <= 0) throw new ValueError("max_size must be positive");
  if (keep_recent < 0) throw new ValueError("keep_recent must be non-negative");
  const now = Date.now() / 1000;
  const entries = cacheEntries(root);
  const protectedPaths = new Set(keep_recent ? entries.slice(-keep_recent).map((e) => e.path) : []);
  const selectedPaths = new Set(entries.filter((e) => older_than !== null && now - e.modified_at_unix >= older_than && !protectedPaths.has(e.path)).map((e) => e.path));
  if (max_size !== null) {
    let remaining = sum(entries.filter((e) => !selectedPaths.has(e.path)).map((e) => e.bytes));
    for (const e of entries) {
      if (remaining <= max_size) break;
      if (selectedPaths.has(e.path) || protectedPaths.has(e.path)) continue;
      selectedPaths.add(e.path);
      remaining -= e.bytes;
    }
  }
  const selected = entries.filter((e) => selectedPaths.has(e.path));
  let destination = null;
  const moved = [];
  if (apply && selected.length) {
    const trash = resolvePath(trash_root);
    destination = path.join(trash, gmStamp(now));
    let suffix = 1;
    while (fs.existsSync(destination)) { destination = path.join(trash, `${gmStamp(now)}-${suffix}`); suffix += 1; }
    fs.mkdirSync(destination, { recursive: true });
    for (const e of selected) {
      const target = path.join(destination, relativeTo(e.path, root));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      moveFile(e.path, target);
      moved.push({ from: e.path, to: target });
    }
  }
  const before = sum(entries.map((e) => e.bytes));
  return {
    schema: CACHE_PRUNE_SCHEMA, path: root, mode: apply ? "applied" : "dry-run",
    older_than_seconds: older_than, max_size_bytes: max_size, keep_recent,
    cache_bytes_before: before, cache_bytes_after: before - sum(selected.map((e) => e.bytes)),
    selected_files: selected.length, selected_bytes: sum(selected.map((e) => e.bytes)),
    trash_directory: destination, recoverable: !!(apply && selected.length),
    entries: selected.map((e) => e.asDict({ now })), moves: moved,
  };
}

/** Restore non-conflicting objects from one prune trash directory. */
export function restorePrunedCache(trashDirectory, cacheDir) {
  const source = resolvePath(trashDirectory);
  const destination = resolvePath(cacheDir);
  if (!isDir(source)) throw osError(`trash directory does not exist: ${source}`, "ENOTDIR");
  fs.mkdirSync(destination, { recursive: true });
  const items = rglob(source).filter((i) => !isSymlink(i) && isFile(i));
  const conflicts = items.map((i) => path.join(destination, relativeTo(i, source))).filter((t) => fs.existsSync(t));
  if (conflicts.length) throw osError(`refusing partial restore; cache entry exists: ${sorted(conflicts).join(", ")}`, "EEXIST");
  let restored = 0;
  for (const item of items) {
    const target = path.join(destination, relativeTo(item, source));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    try {
      fs.linkSync(item, target);
    } catch (e) {
      if (e.code === "EEXIST") throw osError(`refusing to overwrite cache entry: ${target}`, "EEXIST");
      try {
        fs.copyFileSync(item, target, fs.constants.COPYFILE_EXCL);
        const st = fs.statSync(item);
        fs.utimesSync(target, st.atime, st.mtime);
        fs.chmodSync(target, st.mode & 0o7777);
      } catch (err) {
        try { fs.unlinkSync(target); } catch {}
        throw err;
      }
    }
    fs.unlinkSync(item);
    restored += 1;
  }
  return restored;
}
