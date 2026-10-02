// handoff-audit.js - pre-publication checks for redistributable proof and
// handoff repositories: untracked files, absolute user paths, and markdown
// or inline-code path references that will not resolve for someone else.
//
// Plain JS ESM + JSDoc.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { showToplevel, isTracked, lsFiles, GitUnsupportedError } from "../../git/index.js";
import { sorted, strip, strRepr } from "./py.js";
import { OSError } from "./py-extra.js";

export const HANDOFF_SCHEMA = "decomp-workbench-handoff-audit-v1";

const MARKDOWN_LINK = /\[[^\]]*\]\((?<target>[^)]+)\)/g;
const INLINE_CODE = /(?<!`)`(?<value>[^`\n]+)`(?!`)/g;
const ABSOLUTE_USER_PATH = /(?<![\p{L}\p{N}_.])(?<path>\/(?:Users|home)\/[^\s`'"<>]+|[A-Za-z]:\\Users\\[^\s`'"<>]+)/gu;
export const SKIPPED_DIRECTORY_NAMES = Object.freeze(new Set([".git", ".mypy_cache", ".pytest_cache", ".ruff_cache", "__pycache__", "build", "dist"]));

/** The directory argument is not a directory (an OSError, as the original raised). */
export class NotADirectoryError extends OSError {
  constructor(message) { super(message); this.name = "NotADirectoryError"; }
}

const lineNumber = (text, offset) => { let n = 1; for (let i = 0; i < offset; i++) if (text.charCodeAt(i) === 10) n++; return n; };
const exists = (p) => { try { fs.statSync(p); return true; } catch { return false; } };
const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const isSymlink = (p) => { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } };
const expandUser = (p) => (p === "~" || p.startsWith("~/") ? os.homedir() + p.slice(1) : p);

/** Path.resolve(): absolute, normalized, symlinks resolved as far as the path exists. */
export function resolvePath(p) {
  let abs = path.resolve(p);
  const tail = [];
  for (;;) {
    try { const real = fs.realpathSync(abs); return tail.length ? path.join(real, ...tail.reverse()) : real; } catch {}
    const parent = path.dirname(abs);
    if (parent === abs) return path.join(abs, ...tail.reverse());
    tail.push(path.basename(abs));
    abs = parent;
  }
}

export function isRelativeTo(p, root) { return p === root || p.startsWith(root.endsWith("/") ? root : root + "/"); }
const relPosix = (p, root) => (p === root ? "." : p.slice(root.length + (root.endsWith("/") ? 0 : 1)));
/** Path ordering: component by component, like the original's paths. */
const pathKey = (p) => p.split("/");

/** fnmatch.fnmatch on a posix system (case-sensitive; `*` crosses `/`). */
export function fnmatch(name, pattern) {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") re += ".*";
    else if (c === "?") re += ".";
    else if (c === "[") {
      let j = i + 1;
      if (j < pattern.length && pattern[j] === "!") j++;
      if (j < pattern.length && pattern[j] === "]") j++;
      while (j < pattern.length && pattern[j] !== "]") j++;
      if (j >= pattern.length) re += "\\[";
      else {
        let stuff = pattern.slice(i + 1, j).replace(/\\/g, "\\\\");
        if (stuff.startsWith("!")) stuff = "^" + stuff.slice(1);
        else if (stuff.startsWith("^")) stuff = "\\" + stuff;
        re += `[${stuff}]`;
        i = j;
      }
    } else re += c.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  }
  return new RegExp(`^(?:${re})$`, "s").test(name);
}

// Repository questions are answered by romdev's pure-JS git reader
// (src/git/), never by launching git. A layout the reader will not guess
// about counts as "no answer", exactly as a failing git command did.
const gitQuery = (fn, fallback) => {
  try { return fn(); } catch (e) { if (e instanceof GitUnsupportedError) return fallback; throw e; }
};

/** `git rev-parse --show-toplevel`, resolved; null outside a worktree. */
function gitRoot(p) {
  const top = gitQuery(() => showToplevel(p), null);
  return top === null ? null : resolvePath(top);
}

/** `git ls-files --error-unmatch`: is this path (or anything below it) in its repository's index? */
function gitTracked(p, cache) {
  const resolved = resolvePath(p);
  if (cache.has(resolved)) return cache.get(resolved)[1];
  const root = gitRoot(isDir(resolved) ? resolved : path.dirname(resolved));
  if (root === null || !isRelativeTo(resolved, root)) { cache.set(resolved, [root, false]); return false; }
  const tracked = gitQuery(() => isTracked(root, relPosix(resolved, root)), false);
  cache.set(resolved, [root, tracked]);
  return tracked;
}

/** `git ls-files [--cached] [--others] [--exclude-standard] -- <root, relative to the repository>`. */
function gitFiles(root, gitRootDir, ...modes) {
  const opts = {
    cached: modes.includes("--cached"), others: modes.includes("--others"), excludeStandard: modes.includes("--exclude-standard"),
    pathspec: [relPosix(root, gitRootDir)],
  };
  const listed = gitQuery(() => lsFiles(gitRootDir, opts), null);
  if (listed === null) return [];
  return listed.map((raw) => resolvePath(path.join(gitRootDir, raw)));
}

const excluded = (p, root, patterns) => { const rel = relPosix(p, root); return patterns.some((pat) => fnmatch(rel, pat)); };

function walk(dir, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    out.push(full);
    if (e.isDirectory()) walk(full, out);
  }
}

function textFiles(root, gitRootDir, exclude) {
  if (gitRootDir !== null && isRelativeTo(root, gitRootDir)) {
    const candidates = new Set(gitFiles(root, gitRootDir, "--cached", "--others", "--exclude-standard"));
    return sorted([...candidates].filter((p) => isFile(p) && !isSymlink(p) && !excluded(p, root, exclude)), pathKey);
  }
  const all = [];
  walk(root, all);
  const files = [];
  for (const item of all) {
    const parts = relPosix(item, root).split("/");
    if (parts.some((part) => SKIPPED_DIRECTORY_NAMES.has(part) || part.startsWith(".venv"))) continue;
    if (isFile(item) && !isSymlink(item) && !excluded(item, root, exclude)) files.push(item);
  }
  return sorted(files, pathKey);
}

function decodeText(p) {
  if (fs.statSync(p).size > 4 * 1024 * 1024) return null;
  const content = fs.readFileSync(p);
  if (content.includes(0)) return null;
  try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(content); } catch { return null; }
}

function linkTarget(raw) {
  let target = strip(raw);
  if (target.startsWith("<") && target.includes(">")) return target.slice(1, target.indexOf(">"));
  if (target.includes(" ")) target = target.split(" ")[0];
  return target;
}

function suffix(p) {
  const name = p.split("/").filter((x) => x && x !== ".").at(-1) ?? "";
  const i = name.lastIndexOf(".");
  return i > 0 && i < name.length - 1 ? name.slice(i) : "";
}

function inlinePath(raw, root, document) {
  const value = strip(strip(raw), ".,;:()[]");
  if (!value || /\s/u.test(value) || ["http://", "https://", "mailto:", "#"].some((p) => value.startsWith(p))
    || ["$", "{", "}", "*"].some((m) => value.includes(m)) || !value.includes("/")) return null;
  const pathText = value.split("#")[0];
  if (!pathText || pathText.startsWith("/")) return null;
  if (suffix(pathText).toLowerCase() === ".md") return pathText;
  if (exists(path.join(root, pathText)) || exists(path.join(path.dirname(document), pathText))) return pathText;
  return null;
}

/** urllib.parse.unquote: %XX sequences decoded as UTF-8 (replacing invalid bytes), others left as is. */
export function unquote(s) {
  if (!s.includes("%")) return s;
  return s.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => new TextDecoder("utf-8").decode(Buffer.from(run.replace(/%/g, ""), "hex")));
}

/** Path.rglob(pattern) under root: every file or directory whose trailing components match. */
function rglob(root, pattern) {
  const parts = pattern.split("/").filter((p) => p && p !== ".");
  if (!parts.length || parts.includes("..")) return [];
  const all = [];
  walk(root, all);
  return all.filter((item) => {
    const rel = relPosix(item, root).split("/");
    if (rel.length < parts.length) return false;
    const tailParts = rel.slice(rel.length - parts.length);
    return parts.every((pat, i) => fnmatch(tailParts[i], pat));
  });
}

function resolveReference(reference, { document, root, dependencyRoots }) {
  const decoded = unquote(reference.split("#")[0]);
  if (!decoded) return [document, "handoff"];
  const p = expandUser(decoded);
  if (path.isAbsolute(p)) return exists(p) ? [resolvePath(p), "absolute"] : [null, null];
  const candidates = [[path.join(path.dirname(document), p), "handoff"], [path.join(root, p), "handoff"], ...dependencyRoots.map((d) => [path.join(d, p), "dependency"])];
  const seen = new Set();
  for (const [candidate, origin] of candidates) {
    const resolved = resolvePath(candidate);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    if (exists(resolved)) return [resolved, origin];
  }
  const matches = [];
  for (const [searchRoot, origin] of [[root, "handoff"], ...dependencyRoots.map((d) => [d, "dependency"])]) {
    for (const candidate of rglob(searchRoot, p.split(path.sep).join("/"))) if (exists(candidate)) matches.push([candidate, origin]);
  }
  if (matches.length === 1) return [resolvePath(matches[0][0]), matches[0][1]];
  return [null, null];
}

function resolveRoot(value, label, cwd) {
  const given = String(value);
  const expanded = expandUser(given);
  const root = resolvePath(path.resolve(cwd, expanded));
  if (!isDir(root)) {
    let detail = `${label} is not a directory: ${root}`;
    if (!path.isAbsolute(expanded)) detail += ` (from ${strRepr(given)} relative to ${cwd})`;
    throw new NotADirectoryError(detail);
  }
  return root;
}

function finding(severity, code, { source, root, line, reference, message, action }) {
  return { severity, code, source: relPosix(source, root), line, reference, message, action };
}

/** Audit one public handoff tree for references that will not travel. */
export function auditHandoff(p, { dependency_roots = [], exclude = [], cwd = process.cwd() } = {}) {
  const root = resolveRoot(p, "handoff root", cwd);
  const dependencies = (dependency_roots ?? []).map((d) => resolveRoot(d, "dependency root", cwd));
  const exclusions = [...(exclude ?? [])];
  const findings = [];
  const gitCache = new Map();
  const gitRootDir = gitRoot(root);
  const files = textFiles(root, gitRootDir, exclusions);
  if (gitRootDir === null) {
    findings.push(finding("warning", "not-git-backed", { source: root, root, line: null, reference: null,
      message: "the handoff root is not inside a Git worktree", action: "audit the exact tracked tree or review the publication archive manually" }));
  } else {
    const untracked = new Set(gitFiles(root, gitRootDir, "--others", "--exclude-standard"));
    for (const filePath of sorted([...untracked].filter((f) => !excluded(f, root, exclusions)), pathKey)) {
      findings.push(finding("error", "untracked-file", { source: filePath, root, line: null, reference: relPosix(filePath, root),
        message: "this local file is not tracked and will not be published",
        action: "track it, remove it from the handoff, or replace it with a reproducible recipe" }));
    }
  }
  const examined = new Set();
  for (const document of files.filter((f) => suffix(f).toLowerCase() === ".md")) {
    const text = decodeText(document);
    if (text === null) continue;
    for (const m of text.matchAll(ABSOLUTE_USER_PATH)) {
      const reference = m.groups.path.replace(/[.,;:]+$/, "");
      findings.push(finding("error", "absolute-user-path", { source: document, root, line: lineNumber(text, m.index), reference,
        message: "an absolute user path is not portable", action: "replace it with a repository-relative path or a documented placeholder" }));
    }
    const references = [];
    for (const m of text.matchAll(MARKDOWN_LINK)) {
      const target = linkTarget(m.groups.target);
      if (["http://", "https://", "mailto:", "#"].some((pre) => target.startsWith(pre))) continue;
      references.push([m.index, target, "markdown-link"]);
    }
    for (const m of text.matchAll(INLINE_CODE)) {
      const t = inlinePath(m.groups.value, root, document);
      if (t !== null) references.push([m.index, t, "inline-path"]);
    }
    for (const [offset, reference, kind] of references) {
      const line = lineNumber(text, offset);
      const key = JSON.stringify([document, line, reference]);
      if (examined.has(key)) continue;
      examined.add(key);
      const [resolved, origin] = resolveReference(reference, { document, root, dependencyRoots: dependencies });
      if (resolved === null) {
        findings.push(finding("error", "missing-path-reference", { source: document, root, line, reference,
          message: `${kind} does not resolve in the handoff or declared dependency roots`,
          action: "include the dependency, link its public location, or pass --dependency-root to audit it explicitly" }));
        continue;
      }
      if (origin === "absolute") continue;
      if (origin === "handoff" && isRelativeTo(resolved, root)) continue;
      if (origin === "dependency" && isFile(resolved)) {
        const depGit = gitRoot(path.dirname(resolved));
        if (depGit === null || !gitTracked(resolved, gitCache)) {
          findings.push(finding("error", "untracked-dependency", { source: document, root, line, reference,
            message: "the dependency exists locally but is not tracked in its project",
            action: "publish/provision the dependency or replace the claim with a self-contained explanation" }));
        }
      }
    }
  }
  const ordered = sorted(findings, (f) => [f.source, f.line !== null ? f.line : 0, f.code]);
  const errors = ordered.filter((f) => f.severity === "error").length;
  const warnings = ordered.filter((f) => f.severity === "warning").length;
  return {
    schema: HANDOFF_SCHEMA, root, git_root: gitRootDir ? gitRootDir : null, dependency_roots: dependencies, excluded: exclusions,
    files_examined: files.length, errors, warnings, ready: errors === 0, findings: ordered,
    proof: "Publication readiness only: this audit does not establish compiler provenance, function exactness, or project/ROM identity.",
  };
}
