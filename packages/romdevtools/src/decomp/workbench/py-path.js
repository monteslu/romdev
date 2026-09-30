// py-path.js - the filesystem path semantics the ported commands rely on:
// `~` expansion, resolve() that follows symlinks without requiring the path
// to exist, recursive globbing, and stat times as float seconds computed the
// way the original computes them (seconds + nanoseconds * 1e-9).
//
// Plain JS ESM + JSDoc.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Path.expanduser() */
export function expanduser(p) {
  p = String(p);
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** Path(p).expanduser().resolve(): absolute, symlinks followed where they exist. */
export function resolvePath(p, cwd = process.cwd()) {
  const abs = path.resolve(cwd, expanduser(p));
  const parts = abs.split(path.sep).filter(Boolean);
  let existing = "/";
  let i = 0;
  for (; i < parts.length; i++) {
    const next = path.join(existing, parts[i]);
    if (!fs.existsSync(next)) break;
    existing = next;
  }
  let real;
  try { real = fs.realpathSync(existing); } catch { real = existing; }
  return path.join(real, ...parts.slice(i));
}

/** st_mtime as the original's float. */
export function mtimeSeconds(st) {
  if (typeof st.mtimeNs === "bigint") return Number(st.mtimeNs / 1_000_000_000n) + Number(st.mtimeNs % 1_000_000_000n) * 1e-9;
  return st.mtimeMs / 1000;
}

export function statFloat(p) { return fs.statSync(p, { bigint: true }); }

/** Every path below `root` (files and directories), like rglob("*"). */
export function rglob(root) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      out.push(full);
      if (e.isDirectory() && !e.isSymbolicLink()) walk(full);
    }
  };
  walk(root);
  return out;
}

export function isSymlink(p) { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } }
export function isFile(p) { try { return fs.statSync(p).isFile(); } catch { return false; } }
export function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }
export function exists(p) { return fs.existsSync(p); }

/** Path.relative_to: throws ValueError-like when not below. */
export function relativeTo(p, base) {
  const rel = path.relative(base, p);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    const e = new Error(`'${p}' is not in the subpath of '${base}'`); e.name = "ValueError"; throw e;
  }
  return rel;
}

/** An OSError whose text is the original message (NotADirectoryError(msg) etc.). */
export function osError(message, code = "EOSERR") {
  const e = new Error(message);
  e.name = "OSError";
  e.pyMessage = message;
  e.osCode = code;
  return e;
}

/** Text of an OSError the way `str(error)` prints it. */
export function osText(e) {
  if (e?.pyMessage) return e.pyMessage;
  const shown = e?.path;
  const dest = e?.dest;
  const names = { ENOENT: [2, "No such file or directory"], EISDIR: [21, "Is a directory"], EACCES: [13, "Permission denied"], EEXIST: [17, "File exists"], ENOTDIR: [20, "Not a directory"], ENOTEMPTY: [39, "Directory not empty"], EXDEV: [18, "Invalid cross-device link"], EPERM: [1, "Operation not permitted"] };
  const n = names[e?.code];
  if (n) {
    const cwd = process.cwd().replace(/\/?$/, "/");
    const rel = (x) => (typeof x === "string" && x.startsWith(cwd) ? x.slice(cwd.length) : x);
    return `[Errno ${n[0]}] ${n[1]}: '${rel(shown)}'` + (dest ? ` -> '${rel(dest)}'` : "");
  }
  return e?.message ?? String(e);
}

/** True for failures the original handled as OSError. */
export function isOSError(e) {
  return !!e && (e.name === "OSError" || e.name === "FileNotFoundError" || e.pyMessage !== undefined || (typeof e.code === "string" && /^E[A-Z]+$/.test(e.code)));
}
