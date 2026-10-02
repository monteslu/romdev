// repo.js - find and open a git repository from any directory inside its
// worktree, without git: discovery (a .git directory, or a .git FILE whose
// "gitdir:" points elsewhere, as submodules and linked worktrees use; the
// common dir of a linked worktree; core.worktree), refs (loose, packed-refs,
// symbolic chains, detached HEAD) and git's own abbreviation rule.
//
// Unsupported layouts throw GitUnsupportedError instead of guessing: a
// reftable ref store, an unknown repositoryformatversion-1 extension.
//
// Plain JS ESM + JSDoc.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { loadConfig, readRepoConfigFile, parseBool } from "./config.js";
import { ObjectStore } from "./objects.js";
import { readIndex } from "./index-file.js";

export class GitUnsupportedError extends Error {
  constructor(message) { super(message); this.name = "GitUnsupportedError"; }
}

export class NotAGitRepositoryError extends Error {
  constructor(message) { super(message); this.name = "NotAGitRepositoryError"; }
}

const KNOWN_EXTENSIONS = new Set(["noop", "noop-v1", "objectformat", "worktreeconfig", "partialclone", "preciousobjects", "compatobjectformat", "refstorage"]);

/** Read a ".git" file's gitdir pointer, resolved against the file's directory. */
function readGitFile(file) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch { return null; }
  const m = /^gitdir: (.*?)\r?\n?$/.exec(text.split("\n")[0] + "\n");
  if (!m) return null;
  const p = m[1].trim();
  return path.resolve(path.dirname(file), p);
}

/** The common dir of a git dir (linked worktrees store it in `commondir`). */
function commonDirOf(gitDir) {
  try {
    const c = fs.readFileSync(path.join(gitDir, "commondir"), "utf8").trim();
    return path.resolve(gitDir, c);
  } catch { return gitDir; }
}

/** git's is_git_directory(): HEAD, objects/ and refs/ present (via the common dir). */
export function isGitDirectory(dir) {
  try {
    const common = commonDirOf(dir);
    if (!fs.statSync(path.join(common, "objects")).isDirectory()) return false;
    if (!fs.statSync(path.join(common, "refs")).isDirectory()) return false;
    const head = fs.lstatSync(path.join(dir, "HEAD"));
    if (head.isSymbolicLink()) return true;
    const t = fs.readFileSync(path.join(dir, "HEAD"), "utf8");
    return t.startsWith("ref: refs/") || /^[0-9a-f]{40}/.test(t) || /^[0-9a-f]{64}/.test(t) || (t.startsWith("ref: ") && t.length > 5);
  } catch { return false; }
}

/**
 * Discover the repository containing `start` (git's setup_git_directory).
 * Returns {gitDir, worktree|null, bare} or null when `start` is not inside a
 * repository. Honors GIT_CEILING_DIRECTORIES and the filesystem boundary
 * (GIT_DISCOVERY_ACROSS_FILESYSTEM), as git does.
 */
export function discover(start, env = process.env) {
  let dir;
  try { dir = fs.realpathSync(path.resolve(start)); } catch { return null; }
  try { if (!fs.statSync(dir).isDirectory()) dir = path.dirname(dir); } catch { return null; }
  const ceilings = (env.GIT_CEILING_DIRECTORIES || "").split(":").filter(Boolean).map((c) => { try { return fs.realpathSync(c); } catch { return path.resolve(c); } });
  const acrossFs = env.GIT_DISCOVERY_ACROSS_FILESYSTEM ? parseBool(env.GIT_DISCOVERY_ACROSS_FILESYSTEM) : false;
  // Longest ceiling that is a proper ancestor of the start: never searched.
  let ceilingLen = -1;
  for (const c of ceilings) if (c !== dir && (dir.startsWith(c.endsWith("/") ? c : c + "/"))) ceilingLen = Math.max(ceilingLen, c === "/" ? 0 : c.length);
  let dev0 = null;
  try { dev0 = fs.statSync(dir).dev; } catch {}
  let cur = dir;
  for (;;) {
    const dotgit = path.join(cur, ".git");
    let st = null;
    try { st = fs.statSync(dotgit); } catch {}
    if (st) {
      let gitDir = null;
      if (st.isFile()) gitDir = readGitFile(dotgit);
      else if (st.isDirectory()) gitDir = dotgit;
      if (gitDir && isGitDirectory(gitDir)) {
        const cfg = readRepoConfigFile(path.join(commonDirOf(gitDir), "config"));
        let worktree = cur;
        const wt = cfg.get("core.worktree");
        if (wt && commonDirOf(gitDir) === gitDir) { try { worktree = fs.realpathSync(path.resolve(gitDir, wt)); } catch { worktree = cur; } }
        return { gitDir: fs.realpathSync(gitDir), worktree: fs.realpathSync(worktree), bare: false, inGitDir: false };
      }
    }
    // Inside a git dir itself (bare repository or .git/...)?
    if (isGitDirectory(cur)) {
      const cfg = readRepoConfigFile(path.join(commonDirOf(cur), "config"));
      const bare = path.basename(cur) === ".git" ? (cfg.getBool("core.bare", false)) : true;
      return { gitDir: cur, worktree: null, bare, inGitDir: true };
    }
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    if (parent.length <= ceilingLen) return null;
    if (!acrossFs) {
      try { if (fs.statSync(parent).dev !== dev0) return null; } catch { return null; }
    }
    cur = parent;
  }
}

/**
 * An opened repository. Cheap to construct; reads lazily. Call close() (or
 * use withRepo) so pack file descriptors are released.
 */
export class Repo {
  /** @param {{gitDir: string, worktree: string|null}} found */
  constructor(found, env = process.env) {
    this.env = env;
    this.gitDir = found.gitDir;
    this.worktree = found.worktree;
    this.commonDir = commonDirOf(this.gitDir);
    const local = readRepoConfigFile(path.join(this.commonDir, "config"));
    const fmt = Number(local.get("core.repositoryformatversion") ?? 0);
    if (fmt > 1) throw new GitUnsupportedError(`repositoryformatversion ${fmt}`);
    if (fmt === 1) {
      for (const [k] of local.entries()) {
        if (!k.startsWith("extensions.")) continue;
        const ext = k.slice("extensions.".length).toLowerCase();
        if (!KNOWN_EXTENSIONS.has(ext)) throw new GitUnsupportedError(`repository extension '${ext}'`);
      }
    }
    const refStorage = (local.get("extensions.refStorage") ?? "files").toLowerCase();
    if (refStorage !== "files") throw new GitUnsupportedError(`ref storage '${refStorage}' (only the files backend is read)`);
    this.algo = (local.get("extensions.objectFormat") ?? "sha1").toLowerCase();
    if (this.algo !== "sha1" && this.algo !== "sha256") throw new GitUnsupportedError(`object format '${this.algo}'`);
    this.hashLen = this.algo === "sha256" ? 32 : 20;
    this._config = null;
    this._objects = null;
    this._index = null;
  }

  /** Open the repository containing `dir`; null when there is none. */
  static open(dir, env = process.env) {
    const found = discover(dir, env);
    if (!found) return null;
    return new Repo(found, env);
  }

  get config() {
    if (!this._config) {
      let branch = null;
      try {
        const t = fs.readFileSync(path.join(this.gitDir, "HEAD"), "utf8");
        const m = /^ref: refs\/heads\/(.*)$/m.exec(t);
        if (m) branch = m[1].trim();
      } catch {}
      this._config = loadConfig({ commonDir: this.commonDir, gitDir: this.gitDir, branch }, this.env);
    }
    return this._config;
  }

  get objects() {
    if (!this._objects) this._objects = new ObjectStore(path.join(this.commonDir, "objects"), this.algo);
    return this._objects;
  }

  get index() {
    if (!this._index) this._index = readIndex(this.gitDir, { hashLen: this.hashLen, indexFile: this.env.GIT_INDEX_FILE || null });
    return this._index;
  }

  close() { if (this._objects) this._objects.close(); }

  /** Per-worktree refs live in the git dir; everything else in the common dir. */
  refDir(name) {
    if (name === "HEAD" || name.startsWith("refs/bisect/") || name.startsWith("refs/worktree/") || name.startsWith("refs/rewritten/") || !name.startsWith("refs/")) return this.gitDir;
    return this.commonDir;
  }

  packedRefs() {
    if (this._packed) return this._packed;
    const map = new Map();
    let text = "";
    try { text = fs.readFileSync(path.join(this.commonDir, "packed-refs"), "utf8"); } catch {}
    for (const line of text.split("\n")) {
      if (!line || line[0] === "#" || line[0] === "^") continue;
      const sp = line.indexOf(" ");
      if (sp < 0) continue;
      map.set(line.slice(sp + 1).trim(), line.slice(0, sp));
    }
    this._packed = map;
    return map;
  }

  /** Raw ref content: {symref: name} | {oid: hex} | null when it does not exist. */
  readRefRaw(name) {
    let text = null;
    try {
      const p = path.join(this.refDir(name), name);
      const st = fs.lstatSync(p);
      if (st.isSymbolicLink()) {
        // An old-style symlinked HEAD: "refs/heads/x" relative to the git dir.
        const target = fs.readlinkSync(p);
        if (target.startsWith("refs/")) return { symref: target };
      }
      if (st.isFile()) text = fs.readFileSync(p, "utf8");
    } catch {}
    if (text !== null) {
      const t = text.trim();
      if (t.startsWith("ref:")) return { symref: t.slice(4).trim() };
      if (/^[0-9a-f]+$/.test(t) && (t.length === 40 || t.length === 64)) return { oid: t };
      return null;
    }
    const packed = this.packedRefs().get(name);
    return packed ? { oid: packed } : null;
  }

  /**
   * Resolve a ref to {oid, name (final ref), symbolic} or null (unborn or
   * missing).
   */
  resolveRef(name) {
    let cur = name;
    for (let depth = 0; depth < 6; depth++) {
      const r = this.readRefRaw(cur);
      if (!r) return null;
      if (r.oid) return { oid: r.oid, name: cur, symbolic: cur !== name };
      cur = r.symref;
    }
    return null;
  }

  /** HEAD's commit id (full hex) or null when HEAD is unborn. */
  head() {
    const r = this.resolveRef("HEAD");
    return r ? r.oid : null;
  }

  /** What HEAD points to: {detached, branch (refs/heads/x) | null, oid | null}. */
  headInfo() {
    const raw = this.readRefRaw("HEAD");
    const r = this.resolveRef("HEAD");
    return { detached: !!(raw && raw.oid), ref: raw?.symref ?? null, oid: r ? r.oid : null };
  }

  /** Configured core.abbrev: a number, "auto" (-1) or the full length ("no"). */
  abbrevSetting() {
    const v = this.config.get("core.abbrev");
    if (v === undefined || v === null) return -1;
    const s = String(v).toLowerCase();
    if (s === "auto") return -1;
    if (["false", "no", "off"].includes(s)) return this.hashLen * 2;
    const n = Number(s);
    if (!Number.isInteger(n)) throw new Error(`bad core.abbrev '${v}'`);
    if (n < 4) return 4;
    return Math.min(n, this.hashLen * 2);
  }

  /**
   * git's find_unique_abbrev(): the default length is derived from the
   * approximate object count (ceil(bits/2), at least 7), then extended until
   * no other object shares the prefix.
   */
  abbreviate(oidHex, len = this.abbrevSetting()) {
    if (len < 0) {
      const count = this.objects.approximateObjectCount();
      let bits = 0;
      for (let c = count; c > 0; c = Math.floor(c / 2)) bits++;
      len = Math.ceil(bits / 2);
      if (len < 7) len = 7;
    }
    if (len >= oidHex.length) return oidHex;
    const shared = this.objects.longestSharedPrefix(oidHex);
    if (shared + 1 > len) len = shared + 1;
    return oidHex.slice(0, Math.min(len, oidHex.length));
  }
}

/** Open, run, close. */
export function withRepo(dir, fn, env = process.env) {
  const repo = Repo.open(dir, env);
  if (!repo) return fn(null);
  try { return fn(repo); } finally { repo.close(); }
}

/** core.excludesFile (resolved, with its XDG default) for a config. */
export function excludesFileOf(cfg, env = process.env) {
  const v = cfg.get("core.excludesFile");
  const home = env.HOME || os.homedir();
  if (v) return v === "~" || v.startsWith("~/") ? home + v.slice(1) : v;
  return env.XDG_CONFIG_HOME ? path.join(env.XDG_CONFIG_HOME, "git", "ignore") : path.join(home, ".config", "git", "ignore");
}

/** core.attributesFile (resolved, with its XDG default). */
export function attributesFileOf(cfg, env = process.env) {
  const v = cfg.get("core.attributesFile");
  const home = env.HOME || os.homedir();
  if (v) return v === "~" || v.startsWith("~/") ? home + v.slice(1) : v;
  return env.XDG_CONFIG_HOME ? path.join(env.XDG_CONFIG_HOME, "git", "attributes") : path.join(home, ".config", "git", "attributes");
}
