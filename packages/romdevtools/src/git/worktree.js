// worktree.js - the worktree side of git, read-only and without git:
// `status --porcelain` (v1) and `ls-files` (--cached / --others /
// --exclude-standard / --error-unmatch, with pathspecs).
//
// status --porcelain is three comparisons, as in wt-status.c:
//   HEAD tree vs index      -> the X column (A/M/D/T, R with rename pairing)
//   index vs worktree       -> the Y column (M/D/T, A for intent-to-add);
//                              a stat match that is not racy means clean,
//                              anything else hashes the converted content
//                              (CRLF/eol/text attributes, ident) as a blob
//   untracked enumeration   -> "?? path" (a wholly untracked directory is one
//                              "dir/" entry when it holds any untracked,
//                              non-ignored file; nested repositories too)
// Submodules (gitlinks) compare the submodule's HEAD and recurse into its own
// status for modified/untracked content, honoring submodule.<name>.ignore.
// Unmerged entries print git's two-letter codes (UU, AA, DU, ...).
//
// A clean filter (e.g. LFS) or working-tree-encoding cannot be reproduced
// without running the configured program; those throw GitUnsupportedError
// rather than return an answer that might be wrong.
//
// Plain JS ESM + JSDoc.

import fs from "node:fs";
import path from "node:path";
import { Repo, GitUnsupportedError, excludesFileOf, attributesFileOf, isGitDirectory } from "./repo.js";
import { hashObject } from "./objects.js";
import { cmpPath } from "./index-file.js";
import { Excluder, Attributes } from "./ignore.js";
import { detectRenames } from "./rename.js";
import { wildmatch, hasWildcard } from "./wildmatch.js";
import { parseBool } from "./config.js";

const S_IFMT = 0o170000, S_IFREG = 0o100000, S_IFLNK = 0o120000, S_IFDIR = 0o040000, S_IFGITLINK = 0o160000;
const typeOf = (mode) => mode & S_IFMT;

// ------------------------------------------------------------------ quoting

const CQ = { 7: "a", 8: "b", 9: "t", 10: "n", 11: "v", 12: "f", 13: "r", 34: "\"", 92: "\\" };

/** git's quote_c_style (core.quotePath semantics); returns the raw path when no quoting is needed. */
export function quotePath(p, { quoteFully = true, quoteSpace = false } = {}) {
  const bytes = Buffer.from(p, "utf8");
  let needs = false;
  for (const b of bytes) if (b < 0x20 || b === 0x22 || b === 0x5c || b === 0x7f || (b >= 0x80 && quoteFully)) { needs = true; break; }
  if (!needs) return quoteSpace && p.includes(" ") ? `"${p}"` : p;
  let out = "\"";
  let raw = [];
  const flush = () => { if (raw.length) { out += Buffer.from(raw).toString("utf8"); raw = []; } };
  for (const b of bytes) {
    if (CQ[b] && (b < 0x20 || b === 0x22 || b === 0x5c)) { flush(); out += "\\" + CQ[b]; }
    else if (b < 0x20 || b === 0x7f || (b >= 0x80 && quoteFully)) { flush(); out += "\\" + b.toString(8).padStart(3, "0"); }
    else raw.push(b);
  }
  flush();
  return out + "\"";
}

// ------------------------------------------------------------------ helpers

function lstatBig(p) {
  try { return fs.lstatSync(p, { bigint: true }); } catch (e) {
    if (e.code === "ENOENT" || e.code === "ENOTDIR") return null;
    throw e;
  }
}

/** Index entries for the worktree view: sparse directory entries expanded via their trees. */
function indexEntries(repo) {
  const idx = repo.index;
  if (!idx.sparse) return idx.entries;
  const out = [];
  for (const e of idx.entries) {
    if (typeOf(e.mode) === S_IFDIR) {
      const flat = repo.objects.flattenTree(e.oid, e.path.endsWith("/") ? e.path : e.path + "/");
      for (const [p, v] of flat) out.push({ ...e, path: p, mode: v.mode, oid: v.oid, skipWorktree: true, size: 0 });
    } else out.push(e);
  }
  out.sort((a, b) => cmpPath(a.path, b.path) || a.stage - b.stage);
  return out;
}

/** The set of every directory prefix that holds an index entry ("a", "a/b", ...). */
function indexDirs(entries) {
  const dirs = new Set();
  for (const e of entries) {
    let p = e.path;
    for (let s = p.lastIndexOf("/"); s > 0; s = p.lastIndexOf("/")) {
      p = p.slice(0, s);
      if (dirs.has(p)) break;
      dirs.add(p);
    }
  }
  return dirs;
}

/** Is `abs` the top of a non-bare repository (a .git dir or gitfile)? */
function isNestedRepo(abs) {
  const dotgit = path.join(abs, ".git");
  let st;
  try { st = fs.statSync(dotgit); } catch { return false; }
  if (st.isDirectory()) return isGitDirectory(dotgit);
  if (st.isFile()) {
    try {
      const t = fs.readFileSync(dotgit, "utf8");
      const m = /^gitdir: (.*)$/m.exec(t);
      return !!m && isGitDirectory(path.resolve(abs, m[1].trim()));
    } catch { return false; }
  }
  return false;
}

function makeExcluder(repo) {
  return new Excluder({
    worktree: repo.worktree,
    excludesFile: excludesFileOf(repo.config, repo.env),
    infoExclude: path.join(repo.commonDir, "info", "exclude"),
  });
}

// ------------------------------------------------------------- pathspecs

/**
 * A minimal pathspec matcher with git's default (non-literal) magic: a
 * literal item matches itself and everything below it; an item with glob
 * characters is matched with wildmatch (no WM_PATHNAME: `*` crosses `/`),
 * after its literal prefix. "" and "." match everything.
 */
export function makePathspec(items) {
  if (!items || !items.length) return null;
  const norm = items.map((s) => {
    let p = s.replace(/\/+$/, "");
    if (p === "." || p === "./") p = "";
    p = p.replace(/^\.\//, "");
    return { raw: p, glob: hasWildcard(p) };
  });
  const matchOne = (it, rel) => {
    if (it.raw === "") return true;
    if (rel === it.raw || rel.startsWith(it.raw + "/")) return true;
    if (it.glob && wildmatch(it.raw, rel, 0)) return true;
    return false;
  };
  return {
    items: norm,
    /** Does the path match any item? Returns the index of the first matching item or -1. */
    match(rel) { for (let i = 0; i < norm.length; i++) if (matchOne(norm[i], rel)) return i; return -1; },
    /** Could anything below directory `dir` match? (pruning) */
    mayContain(dir) {
      return norm.some((it) => it.raw === "" || it.glob || it.raw === dir || it.raw.startsWith(dir + "/") || dir.startsWith(it.raw + "/"));
    },
  };
}

// --------------------------------------------------------- untracked walk

/**
 * Enumerate untracked paths.
 * @param {Repo} repo
 * @param {object} o
 * @param {Set<string>} o.tracked every index path (all stages)
 * @param {Set<string>} o.dirs index directory prefixes
 * @param {boolean} o.collapseDirs status "normal": a wholly untracked dir is one "dir/" entry
 * @param {boolean} o.useExcludes apply .gitignore & co
 * @param {ReturnType<makePathspec>} [o.pathspec]
 * @returns {string[]} worktree-relative paths, dirs with a trailing "/"
 */
function untracked(repo, { tracked, dirs, collapseDirs, useExcludes, pathspec = null }) {
  const ex = useExcludes ? makeExcluder(repo) : null;
  const root = repo.worktree;
  const out = [];
  const excluded = (rel, isDir) => (ex ? ex.isExcluded(rel, isDir) : false);

  const entriesOf = (relDir) => {
    try { return fs.readdirSync(relDir ? path.join(root, relDir) : root, { withFileTypes: true }); } catch { return []; }
  };
  const dtype = (relPath, d) => {
    if (d.isDirectory()) return "dir";
    if (d.isFile() || d.isSymbolicLink()) return "file";
    if (d.isFIFO() || d.isSocket() || d.isBlockDevice() || d.isCharacterDevice()) return "none";
    try {
      const st = fs.lstatSync(path.join(root, relPath));
      return st.isDirectory() ? "dir" : (st.isFile() || st.isSymbolicLink()) ? "file" : "none";
    } catch { return "none"; }
  };

  /** Does an untracked directory hold anything untracked and not ignored? */
  const hasUntracked = (relDir) => {
    for (const d of entriesOf(relDir)) {
      if (d.name === ".git") continue;
      const rel = relDir + "/" + d.name;
      const t = dtype(rel, d);
      if (t === "none") continue;
      if (excluded(rel, t === "dir")) continue;
      if (t === "file") return true;
      if (isNestedRepo(path.join(root, rel))) return true;
      if (hasUntracked(rel)) return true;
    }
    return false;
  };

  const walk = (relDir) => {
    const ents = entriesOf(relDir).map((d) => d).sort((a, b) => cmpPath(a.name, b.name));
    for (const d of ents) {
      if (d.name === ".git") continue;
      const rel = relDir ? relDir + "/" + d.name : d.name;
      const t = dtype(rel, d);
      if (t === "none") continue;
      if (t !== "dir" && tracked.has(rel)) continue;
      if (t === "dir" && pathspec && !pathspec.mayContain(rel)) continue;
      if (excluded(rel, t === "dir")) continue;
      if (t === "file") {
        if (!pathspec || pathspec.match(rel) >= 0) out.push(rel);
        continue;
      }
      // directory
      if (dirs.has(rel)) { walk(rel); continue; }
      if (tracked.has(rel)) {
        // a gitlink at this path (or a tracked file replaced by a directory)
        const e = repoEntryMode.get(rel);
        if (e === S_IFGITLINK) continue;
      }
      if (isNestedRepo(path.join(root, rel))) {
        if (!pathspec || pathspec.match(rel) >= 0) out.push(rel + "/");
        continue;
      }
      if (collapseDirs) {
        if ((!pathspec || pathspec.match(rel) >= 0) && hasUntracked(rel)) out.push(rel + "/");
        else if (pathspec && pathspec.match(rel) < 0) walk(rel);
        continue;
      }
      walk(rel);
    }
  };
  const repoEntryMode = new Map();
  for (const e of indexEntries(repo)) repoEntryMode.set(e.path, typeOf(e.mode));
  walk("");
  return out.sort(cmpPath);
}

// ---------------------------------------------------------------- ls-files

/**
 * `git ls-files` from the worktree root.
 * @param {Repo} repo
 * @param {{cached?: boolean, others?: boolean, excludeStandard?: boolean, pathspec?: string[]}} [o]
 * @returns {string[]} paths in git's order: others first, then cached
 */
export function lsFiles(repo, { cached, others = false, excludeStandard = false, pathspec = [] } = {}) {
  if (cached === undefined) cached = !others;
  const entries = indexEntries(repo);
  const ps = makePathspec(pathspec);
  const out = [];
  if (others) {
    const tracked = new Set(entries.map((e) => e.path));
    out.push(...untracked(repo, { tracked, dirs: indexDirs(entries), collapseDirs: false, useExcludes: excludeStandard, pathspec: ps }));
  }
  if (cached) for (const e of entries) if (!ps || ps.match(e.path) >= 0) out.push(e.path);
  return out;
}

/**
 * `git ls-files --error-unmatch -- <paths>`: true when every pathspec item
 * matches at least one index entry.
 */
export function allTracked(repo, pathspec) {
  const entries = indexEntries(repo);
  const ps = makePathspec(pathspec);
  if (!ps) return true;
  const seen = new Array(ps.items.length).fill(false);
  for (const e of entries) {
    for (let i = 0; i < ps.items.length; i++) {
      if (seen[i]) continue;
      const it = ps.items[i];
      if (it.raw === "" || e.path === it.raw || e.path.startsWith(it.raw + "/") || (it.glob && wildmatch(it.raw, e.path, 0))) seen[i] = true;
    }
  }
  return seen.every(Boolean);
}

// ------------------------------------------------------------ conversion

function gatherStats(buf) {
  const s = { crlf: 0, lonecr: 0, lonelf: 0, nul: 0, printable: 0, nonprintable: 0 };
  const n = buf.length;
  for (let i = 0; i < n; i++) {
    const c = buf[i];
    if (c === 13) {
      if (i + 1 < n && buf[i + 1] === 10) { s.crlf++; i++; } else s.lonecr++;
      continue;
    }
    if (c === 10) { s.lonelf++; continue; }
    if (c === 127) s.nonprintable++;
    else if (c < 32) {
      if (c === 8 || c === 9 || c === 27 || c === 12) s.printable++;
      else { if (c === 0) s.nul++; s.nonprintable++; }
    } else s.printable++;
  }
  if (n >= 1 && buf[n - 1] === 26) s.nonprintable--;
  return s;
}
const isBinaryStats = (s) => s.lonecr > 0 || s.nul > 0 || (s.printable >> 7) < s.nonprintable;

const CRLF_BINARY = "binary", CRLF_TEXT = "text", CRLF_TEXT_INPUT = "text-input", CRLF_TEXT_CRLF = "text-crlf",
  CRLF_AUTO = "auto", CRLF_AUTO_INPUT = "auto-input", CRLF_AUTO_CRLF = "auto-crlf", CRLF_UNDEFINED = "undefined";

function crlfAttr(v) {
  if (v === true) return CRLF_TEXT;
  if (v === false) return CRLF_BINARY;
  if (v === "input") return CRLF_TEXT_INPUT;
  if (v === "auto") return CRLF_AUTO;
  return CRLF_UNDEFINED;
}

/** The worktree file's blob id as git would store it (convert_to_git, then hash). */
function worktreeBlobOid(ctx, rel, abs) {
  const data = fs.readFileSync(abs);
  const a = ctx.attrs.get(rel, ["text", "crlf", "eol", "filter", "ident", "working-tree-encoding"]);
  if (typeof a.filter === "string") {
    const drv = a.filter;
    const cfg = ctx.repo.config;
    if (cfg.get(`filter.${drv}.clean`) !== undefined || cfg.get(`filter.${drv}.process`) !== undefined) {
      throw new GitUnsupportedError(`'${rel}' uses the '${drv}' clean filter, which only git can run`);
    }
  }
  if (typeof a["working-tree-encoding"] === "string") throw new GitUnsupportedError(`'${rel}' has a working-tree-encoding`);
  let action = crlfAttr(a.text);
  if (action === CRLF_UNDEFINED) action = crlfAttr(a.crlf);
  if (action !== CRLF_BINARY) {
    if (action === CRLF_AUTO && a.eol === "lf") action = CRLF_AUTO_INPUT;
    else if (action === CRLF_AUTO && a.eol === "crlf") action = CRLF_AUTO_CRLF;
    else if (a.eol === "lf") action = CRLF_TEXT_INPUT;
    else if (a.eol === "crlf") action = CRLF_TEXT_CRLF;
  }
  if (action === CRLF_TEXT) action = CRLF_TEXT_INPUT; // direction to git: same either way
  if (action === CRLF_UNDEFINED) {
    if (ctx.autocrlf === "true") action = CRLF_AUTO_CRLF;
    else if (ctx.autocrlf === "input") action = CRLF_AUTO_INPUT;
    else action = CRLF_BINARY;
  }
  let out = data;
  if (action !== CRLF_BINARY && data.length) {
    const st = gatherStats(data);
    let convert = st.crlf > 0;
    const auto = action === CRLF_AUTO || action === CRLF_AUTO_INPUT || action === CRLF_AUTO_CRLF;
    if (convert && auto) {
      if (isBinaryStats(st)) convert = false;
      else if (ctx.indexBlobHasCrlf(rel)) convert = false;
    }
    if (convert) {
      const buf = Buffer.allocUnsafe(data.length);
      let o = 0;
      if (action === CRLF_AUTO_INPUT || action === CRLF_AUTO_CRLF) {
        for (let i = 0; i < data.length; i++) if (data[i] !== 13) buf[o++] = data[i];
      } else {
        for (let i = 0; i < data.length; i++) {
          if (data[i] === 13 && i + 1 < data.length && data[i + 1] === 10) continue;
          buf[o++] = data[i];
        }
      }
      out = buf.subarray(0, o);
    }
  }
  if (a.ident === true) out = identToGit(out);
  return hashObject("blob", out, ctx.repo.algo);
}

/** "$Id: anything$" -> "$Id$" (git's ident_to_git). */
function identToGit(buf) {
  const s = buf.toString("latin1");
  if (!s.includes("$Id:")) return buf;
  let out = "", i = 0;
  for (;;) {
    const d = s.indexOf("$", i);
    if (d < 0) { out += s.slice(i); break; }
    out += s.slice(i, d + 1);
    i = d + 1;
    if (s.startsWith("Id:", i)) {
      const d2 = s.indexOf("$", i + 3);
      if (d2 < 0) { out += s.slice(i); break; }
      if (s.slice(i + 3, d2).includes("\n")) continue;
      out += "Id$";
      i = d2 + 1;
    }
  }
  return Buffer.from(out, "latin1");
}

// ------------------------------------------------------------------ status

/** Submodule name for a path, from the worktree's .gitmodules. */
function submoduleNames(repo) {
  const map = new Map();
  let text;
  try { text = fs.readFileSync(path.join(repo.worktree, ".gitmodules"), "utf8"); } catch { return map; }
  const re = /^\s*\[submodule\s+"((?:[^"\\]|\\.)*)"\]\s*$|^\s*(path|ignore)\s*=\s*(.*?)\s*$/gim;
  let cur = null;
  const ignore = new Map();
  for (const line of text.split("\n")) {
    re.lastIndex = 0;
    const m = re.exec(line);
    if (!m) continue;
    if (m[1] !== undefined) { cur = m[1].replace(/\\(.)/g, "$1"); continue; }
    if (!cur) continue;
    let v = m[3].replace(/^"(.*)"$/, "$1");
    if (m[2].toLowerCase() === "path") map.set(v.replace(/\/+$/, ""), cur);
    else ignore.set(cur, v);
  }
  return { byPath: map, ignore };
}

function stagemaskCode(mask) {
  return { 1: "DD", 2: "AU", 3: "UD", 4: "UA", 5: "DU", 6: "AA", 7: "UU" }[mask];
}

/**
 * Collect status changes for a repository.
 * @returns {{changes: Map<string, {x: string, y: string, from?: string, sub?: {newCommits: boolean, modified: boolean, untracked: boolean}, unmerged?: string}>, untracked: string[]}}
 */
export function collectStatus(repo, { showUntracked: showUntrackedOverride = null, ignoreUntrackedInSubmodules = false } = {}) {
  if (!repo.worktree) throw new Error("status needs a worktree");
  const cfg = repo.config;
  const entries = indexEntries(repo);
  const root = repo.worktree;

  // status.showUntrackedFiles
  let showUntracked = showUntrackedOverride;
  if (showUntracked === null) {
    const v = cfg.get("status.showUntrackedFiles");
    if (v === undefined) showUntracked = "normal";
    else {
      const s = v === null ? "true" : String(v).toLowerCase();
      if (s === "no" || s === "false" || s === "off" || s === "0") showUntracked = "no";
      else if (s === "all") showUntracked = "all";
      else if (s === "normal" || s === "true" || s === "yes" || s === "on" || s === "1") showUntracked = "normal";
      else throw new Error(`invalid status.showUntrackedFiles '${v}'`);
    }
  }
  const renamesCfg = cfg.get("status.renames") ?? cfg.get("diff.renames");
  const renames = renamesCfg === undefined ? true : (String(renamesCfg).toLowerCase() === "copies" || String(renamesCfg).toLowerCase() === "copy" ? true : parseBool(renamesCfg));
  const renameLimitCfg = cfg.get("status.renameLimit") ?? cfg.get("diff.renameLimit");
  const renameLimit = renameLimitCfg !== undefined ? Number(renameLimitCfg) : 1000;
  const fileMode = cfg.getBool("core.fileMode", true);
  const trustCtime = cfg.getBool("core.trustctime", true);
  const checkStat = String(cfg.get("core.checkStat") ?? "default").toLowerCase();
  const autocrlfRaw = cfg.get("core.autocrlf");
  const autocrlf = autocrlfRaw === undefined ? "false" : String(autocrlfRaw).toLowerCase() === "input" ? "input" : (parseBool(autocrlfRaw) ? "true" : "false");
  const diffIgnoreSub = cfg.get("diff.ignoreSubmodules");

  const changes = new Map();
  const get = (p) => { let c = changes.get(p); if (!c) { c = { x: " ", y: " " }; changes.set(p, c); } return c; };

  // ---- unmerged
  const unmerged = new Map();
  for (const e of entries) if (e.stage > 0) unmerged.set(e.path, (unmerged.get(e.path) ?? 0) | (1 << (e.stage - 1)));
  for (const [p, mask] of unmerged) get(p).unmerged = stagemaskCode(mask);

  // ---- HEAD vs index
  const headOid = repo.head();
  const headTree = headOid ? repo.objects.flattenTree(repo.objects.commitTree(headOid)) : new Map();
  const stage0 = new Map();
  for (const e of entries) if (e.stage === 0) stage0.set(e.path, e);
  const added = [], deleted = [];
  for (const [p, e] of stage0) {
    if (unmerged.has(p)) continue;
    if (e.intentToAdd) continue;
    const h = headTree.get(p);
    if (!h) { added.push({ path: p, mode: e.mode, oid: e.oid }); continue; }
    if (h.oid !== e.oid || h.mode !== e.mode) get(p).x = typeOf(h.mode) !== typeOf(e.mode) ? "T" : "M";
  }
  for (const [p, h] of headTree) {
    if (unmerged.has(p)) continue;
    const e = stage0.get(p);
    if (!e || e.intentToAdd) deleted.push({ path: p, mode: h.mode, oid: h.oid });
  }
  const pairs = renames ? detectRenames(deleted, added, (oid) => repo.objects.readTyped(oid, "blob"), { renameLimit }) : [];
  const pairedSrc = new Set(pairs.map((x) => x.src.path)), pairedDst = new Set(pairs.map((x) => x.dst.path));
  for (const a of added) if (!pairedDst.has(a.path)) get(a.path).x = "A";
  for (const d of deleted) if (!pairedSrc.has(d.path)) get(d.path).x = "D";
  for (const { src, dst } of pairs) { const c = get(dst.path); c.x = "R"; c.from = src.path; }

  // ---- index vs worktree
  const idxMtime = repo.index.mtime;
  const subs = submoduleNames(repo);
  const attrs = new Attributes({
    worktree: root,
    globalFile: attributesFileOf(cfg, repo.env),
    infoFile: path.join(repo.commonDir, "info", "attributes"),
  });
  const ctx = {
    repo, attrs, autocrlf,
    indexBlobHasCrlf: (rel) => {
      const e = stage0.get(rel);
      if (!e) return false;
      const o = repo.objects.read(e.oid);
      if (!o || !o.data.includes(13)) return false;
      const st = gatherStats(o.data);
      return !isBinaryStats(st) && st.crlf > 0;
    },
  };
  const leadingSymlink = new Map();
  const hasSymlinkLeadingPath = (rel) => {
    let p = "";
    const parts = rel.split("/");
    for (let i = 0; i < parts.length - 1; i++) {
      p = p ? p + "/" + parts[i] : parts[i];
      let v = leadingSymlink.get(p);
      if (v === undefined) {
        let st = null;
        try { st = fs.lstatSync(path.join(root, p)); } catch {}
        v = !st ? "missing" : st.isSymbolicLink() ? "link" : st.isDirectory() ? "dir" : "file";
        leadingSymlink.set(p, v);
      }
      if (v === "link") return true;
      if (v !== "dir") return false;
    }
    return false;
  };

  for (const e of entries) {
    if (e.stage !== 0) continue;
    if (e.skipWorktree) continue;
    const rel = e.path;
    const abs = path.join(root, rel);
    const t = typeOf(e.mode);
    if (e.assumeValid) continue;
    if (hasSymlinkLeadingPath(rel)) { get(rel).y = "D"; continue; }
    const st = lstatBig(abs);
    if (!st) { get(rel).y = "D"; continue; }
    const isDir = st.isDirectory();
    if (isDir && t !== S_IFGITLINK && !isNestedRepo(abs)) { get(rel).y = "D"; continue; }
    if (e.intentToAdd) { get(rel).y = "A"; continue; }

    if (t === S_IFGITLINK) {
      if (!isDir) { get(rel).y = "T"; continue; }
      const name = subs.byPath?.get(rel);
      let ignore = diffIgnoreSub ?? "none";
      if (name !== undefined) {
        const c = cfg.get(`submodule.${name}.ignore`);
        if (c !== undefined && c !== null) ignore = c;
        else if (subs.ignore.has(name)) ignore = subs.ignore.get(name);
      }
      ignore = String(ignore).toLowerCase();
      if (ignore === "all") continue;
      const sub = submoduleState(abs, e.oid, {
        ignoreDirty: ignore === "dirty",
        ignoreUntracked: ignore === "untracked" || showUntracked === "no" || ignoreUntrackedInSubmodules,
      });
      if (sub && (sub.newCommits || sub.modified || sub.untracked)) { const c = get(rel); c.y = "M"; c.sub = sub; }
      continue;
    }

    // regular file or symlink entry
    const wtType = st.isSymbolicLink() ? S_IFLNK : st.isFile() ? S_IFREG : isDir ? S_IFGITLINK : 0;
    if (t === S_IFREG && wtType !== S_IFREG) { get(rel).y = "T"; continue; }
    if (t === S_IFLNK && wtType !== S_IFLNK) { get(rel).y = "T"; continue; }
    let modeChanged = false;
    if (t === S_IFREG && fileMode && ((Number(st.mode) ^ e.mode) & 0o100)) modeChanged = true;
    const statClean = Number(st.mtimeNs / 1000000000n) === e.mtimeS && Number(st.mtimeNs % 1000000000n) === e.mtimeNs &&
      (!trustCtime || (Number(st.ctimeNs / 1000000000n) === e.ctimeS && Number(st.ctimeNs % 1000000000n) === e.ctimeNs)) &&
      (checkStat === "minimal" || (Number(st.ino & 0xffffffffn) === e.ino && Number(st.uid) === e.uid && Number(st.gid) === e.gid)) &&
      Number(st.size & 0xffffffffn) === e.size;
    const racy = idxMtime && (idxMtime.s < e.mtimeS || (idxMtime.s === e.mtimeS && idxMtime.ns <= e.mtimeNs));
    let contentChanged = false;
    // git (read-cache.c ie_match_stat): a size mismatch against a recorded,
    // non-zero size is "changed" WITHOUT reading the file, even when a
    // CRLF/eol conversion would make the content hash equal. Size 0 means
    // "never recorded" (or smudged as racy) and forces the content check.
    const sizeChanged = Number(st.size & 0xffffffffn) !== e.size;
    if (sizeChanged && e.size !== 0) contentChanged = true;
    else if (!statClean || racy) {
      let oid;
      if (t === S_IFLNK) oid = hashObject("blob", fs.readlinkSync(abs, { encoding: "buffer" }), repo.algo);
      else oid = worktreeBlobOid(ctx, rel, abs);
      contentChanged = oid !== e.oid;
    }
    if (contentChanged || modeChanged) get(rel).y = "M";
  }

  // ---- untracked
  let untrackedList = [];
  if (showUntracked !== "no") {
    const tracked = new Set(entries.map((e) => e.path));
    untrackedList = untracked(repo, { tracked, dirs: indexDirs(entries), collapseDirs: showUntracked === "normal", useExcludes: true });
  }
  for (const [p, c] of changes) if (!c.unmerged && c.x === " " && c.y === " ") changes.delete(p);
  return { changes, untracked: untrackedList };
}

/** A populated submodule's state against the gitlink id; null when not populated. */
function submoduleState(abs, gitlinkOid, { ignoreDirty, ignoreUntracked }) {
  const dotgit = path.join(abs, ".git");
  if (!fs.existsSync(dotgit)) return null;
  let repo;
  try { repo = Repo.open(abs); } catch { return null; }
  if (!repo) return null;
  try {
    if (repo.worktree !== fs.realpathSync(abs)) return null;
    const head = repo.head();
    if (!head) return null;
    const state = { newCommits: head !== gitlinkOid, modified: false, untracked: false };
    if (ignoreDirty) return state;
    const { changes, untracked } = collectStatus(repo, { showUntracked: ignoreUntracked ? "no" : null, ignoreUntrackedInSubmodules: ignoreUntracked });
    for (const c of changes.values()) {
      // A nested submodule whose only change is untracked content counts as untracked.
      if (c.sub && c.x === " " && !c.sub.newCommits && !c.sub.modified && c.sub.untracked) state.untracked = true;
      else state.modified = true;
    }
    if (untracked.length) state.untracked = true;
    return state;
  } finally { repo.close(); }
}

/**
 * `git status --porcelain` (v1) lines, in git's order: tracked changes by
 * path, then untracked.
 */
export function statusPorcelain(repo) {
  const quoteFully = repo.config.getBool("core.quotePath", true);
  const q = (p) => quotePath(p, { quoteFully, quoteSpace: true });
  const { changes, untracked: u } = collectStatus(repo);
  const lines = [];
  for (const p of [...changes.keys()].sort(cmpPath)) {
    const c = changes.get(p);
    if (c.unmerged) { lines.push(`${c.unmerged} ${q(p)}`); continue; }
    if (c.from !== undefined) lines.push(`${c.x}${c.y} ${q(c.from)} -> ${q(p)}`);
    else lines.push(`${c.x}${c.y} ${q(p)}`);
  }
  for (const p of u) lines.push(`?? ${q(p)}`);
  return lines;
}
