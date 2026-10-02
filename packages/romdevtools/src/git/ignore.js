// ignore.js - .gitignore / info/exclude / core.excludesFile semantics, and
// the .gitattributes lookup the worktree hashing needs, both ported from
// git's dir.c and attr.c rules:
//
//   - blank lines and lines starting with '#' are skipped; unescaped trailing
//     spaces are trimmed; a leading '!' negates; a trailing '/' matches only
//     directories;
//   - a pattern with no other '/' matches the basename at any depth below its
//     file; otherwise it is matched (WM_PATHNAME) against the path relative to
//     the directory holding the file, a leading '/' only anchoring;
//   - precedence: deeper .gitignore beats shallower, those beat
//     info/exclude, which beats core.excludesFile; inside one file the LAST
//     matching line wins;
//   - nothing below an excluded directory can be re-included (the walk never
//     enters it).
//
// Plain JS ESM + JSDoc.

import fs from "node:fs";
import { wildmatch, WM_PATHNAME, simpleLength } from "./wildmatch.js";

/** Trim unescaped trailing spaces (git's trim_trailing_spaces). */
function trimTrailingSpaces(s) {
  let lastSpace = -1;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === " ") { if (lastSpace < 0) lastSpace = i; }
    else if (c === "\\") { i++; if (i >= s.length) return s; lastSpace = -1; }
    else lastSpace = -1;
  }
  return lastSpace >= 0 ? s.slice(0, lastSpace) : s;
}

/**
 * @typedef {object} Pattern
 * @property {string} pattern
 * @property {boolean} negative
 * @property {boolean} mustBeDir
 * @property {boolean} noDir basename-only
 * @property {string} base directory (relative to the worktree, "" = root) the pattern is relative to
 */

/** Parse one pattern line; null for a blank/comment line. */
export function parsePattern(line, base) {
  if (!line || line[0] === "#") return null;
  line = trimTrailingSpaces(line);
  if (!line) return null;
  let negative = false;
  if (line[0] === "!") { negative = true; line = line.slice(1); }
  let mustBeDir = false;
  if (line.endsWith("/")) { mustBeDir = true; line = line.slice(0, -1); }
  const noDir = !line.includes("/");
  return { pattern: line, negative, mustBeDir, noDir, base };
}

/** Parse a whole ignore/attributes-style file into lines (BOM dropped). */
function lines(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text.split("\n");
}

export function parseIgnoreText(text, base) {
  const out = [];
  for (const l of lines(text)) { const p = parsePattern(l, base); if (p) out.push(p); }
  return out;
}

export function readIgnoreFile(file, base) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch { return []; }
  return parseIgnoreText(text, base);
}

/**
 * Does one pattern match `relPath` (worktree-relative, no trailing slash)?
 * Mirrors git's match_basename / match_pathname.
 */
export function patternMatches(pat, relPath, isDir) {
  if (pat.mustBeDir && !isDir) return false;
  if (pat.noDir) {
    const slash = relPath.lastIndexOf("/");
    const basename = relPath.slice(slash + 1);
    const pl = simpleLength(pat.pattern);
    if (pl === pat.pattern.length) return basename === pat.pattern;
    return wildmatch(pat.pattern, basename, 0);
  }
  let pattern = pat.pattern;
  if (pattern[0] === "/") pattern = pattern.slice(1);
  const base = pat.base;
  let name;
  if (base) {
    if (relPath.length < base.length + 1 || relPath[base.length] !== "/" || !relPath.startsWith(base)) return false;
    name = relPath.slice(base.length + 1);
  } else name = relPath;
  return wildmatch(pattern, name, WM_PATHNAME);
}

/**
 * The exclude engine for one worktree. Patterns are grouped: global
 * (excludesFile), info/exclude, then one group per directory's .gitignore,
 * loaded lazily as the walk reaches each directory.
 */
export class Excluder {
  /**
   * @param {object} o
   * @param {string} o.worktree absolute worktree root
   * @param {string|null} o.excludesFile core.excludesFile (resolved) or null
   * @param {string|null} o.infoExclude <gitdir>/info/exclude
   * @param {(rel: string) => string|null} [o.readGitignore] text of <rel>/.gitignore, or null
   */
  constructor({ worktree, excludesFile, infoExclude, readGitignore }) {
    this.worktree = worktree;
    this.baseGroups = [];
    if (excludesFile) this.baseGroups.push(readIgnoreFile(excludesFile, ""));
    if (infoExclude) this.baseGroups.push(readIgnoreFile(infoExclude, ""));
    this.readGitignore = readGitignore ?? ((rel) => {
      try { return fs.readFileSync(this.worktree + "/" + (rel ? rel + "/" : "") + ".gitignore", "utf8"); } catch { return null; }
    });
    /** @type {Map<string, Pattern[]>} dir rel -> its .gitignore patterns */
    this.dirGroups = new Map();
  }

  groupFor(dirRel) {
    let g = this.dirGroups.get(dirRel);
    if (!g) {
      const text = this.readGitignore(dirRel);
      g = text === null ? [] : parseIgnoreText(text, dirRel);
      this.dirGroups.set(dirRel, g);
    }
    return g;
  }

  /**
   * Is `relPath` excluded by the patterns that apply to it (its own and
   * its ancestors' .gitignore files)? Parent-directory exclusion is the
   * caller's job (a walk never enters an excluded directory); use
   * isExcludedWithParents for an arbitrary path.
   */
  isExcluded(relPath, isDir) {
    const dirs = [];
    let d = relPath;
    for (;;) {
      const s = d.lastIndexOf("/");
      if (s < 0) { dirs.push(""); break; }
      d = d.slice(0, s);
      dirs.push(d);
    }
    // dirs: deepest first, ending with "" (root)
    for (const dir of dirs) {
      const g = this.groupFor(dir);
      for (let i = g.length - 1; i >= 0; i--) if (patternMatches(g[i], relPath, isDir)) return !g[i].negative;
    }
    for (let k = this.baseGroups.length - 1; k >= 0; k--) {
      const g = this.baseGroups[k];
      for (let i = g.length - 1; i >= 0; i--) if (patternMatches(g[i], relPath, isDir)) return !g[i].negative;
    }
    return false;
  }

  /** Excluded itself, or below an excluded directory. */
  isExcludedWithParents(relPath, isDir) {
    const parts = relPath.split("/");
    for (let i = 1; i < parts.length; i++) if (this.isExcluded(parts.slice(0, i).join("/"), true)) return true;
    return this.isExcluded(relPath, isDir);
  }
}

// ---------------------------------------------------------------- attributes

const MACROS = { binary: { diff: false, merge: false, text: false } };

function parseAttrLine(line, base) {
  line = line.replace(/^[ \t\r\n]+/, "");
  if (!line || line[0] === "#") return null;
  let pat, rest;
  if (line[0] === "\"") {
    // C-quoted pattern
    let i = 1, s = "";
    while (i < line.length && line[i] !== "\"") {
      if (line[i] === "\\" && i + 1 < line.length) { const c = line[++i]; s += { n: "\n", t: "\t", "\"": "\"", "\\": "\\" }[c] ?? c; i++; continue; }
      s += line[i++];
    }
    pat = s; rest = line.slice(i + 1);
  } else {
    const m = /^(\S+)(.*)$/s.exec(line);
    pat = m[1]; rest = m[2];
  }
  if (pat.startsWith("[attr]")) {
    const name = pat.slice(6);
    const attrs = parseAttrStates(rest);
    MACROS[name] = Object.fromEntries(attrs);
    return null;
  }
  if (pat[0] === "!") return null; // negative patterns are rejected by git
  const p = parsePattern(pat, base);
  if (!p) return null;
  return { pat: p, attrs: parseAttrStates(rest) };
}

function parseAttrStates(rest) {
  const out = [];
  for (const tok of rest.trim().split(/[ \t\r]+/).filter(Boolean)) {
    if (tok[0] === "-") out.push([tok.slice(1), false]);
    else if (tok[0] === "!") out.push([tok.slice(1), undefined]);
    else if (tok.includes("=")) { const k = tok.indexOf("="); out.push([tok.slice(0, k), tok.slice(k + 1)]); }
    else out.push([tok, true]);
  }
  return out;
}

/** .gitattributes lookup: deeper beats shallower; info/attributes beats all; core.attributesFile loses to all. */
export class Attributes {
  constructor({ worktree, globalFile, infoFile, readAttributes }) {
    this.worktree = worktree;
    this.readAttributes = readAttributes ?? ((rel) => {
      try { return fs.readFileSync(this.worktree + "/" + (rel ? rel + "/" : "") + ".gitattributes", "utf8"); } catch { return null; }
    });
    this.global = globalFile ? this.parseFile(globalFile, "") : [];
    this.info = infoFile ? this.parseFile(infoFile, "") : [];
    this.dirGroups = new Map();
  }

  parseFile(file, base) {
    let text;
    try { text = fs.readFileSync(file, "utf8"); } catch { return []; }
    return this.parseText(text, base);
  }

  parseText(text, base) {
    const out = [];
    for (const l of lines(text)) { const r = parseAttrLine(l, base); if (r) out.push(r); }
    return out;
  }

  groupFor(dirRel) {
    let g = this.dirGroups.get(dirRel);
    if (!g) {
      const text = this.readAttributes(dirRel);
      g = text === null ? [] : this.parseText(text, dirRel);
      this.dirGroups.set(dirRel, g);
    }
    return g;
  }

  /** Resolve the named attributes for a file path -> {name: true|false|string|undefined}. */
  get(relPath, names) {
    const want = new Set(names);
    const result = {};
    const groups = [this.info];
    const dirs = [];
    let d = relPath;
    for (;;) { const s = d.lastIndexOf("/"); if (s < 0) { dirs.push(""); break; } d = d.slice(0, s); dirs.push(d); }
    for (const dir of dirs) groups.push(this.groupFor(dir));
    groups.push(this.global);
    // Highest precedence first; within a group the last line wins.
    for (const g of groups) {
      for (let i = g.length - 1; i >= 0; i--) {
        const { pat, attrs } = g[i];
        if (pat.mustBeDir) continue; // directory patterns never apply to files
        if (!patternMatches(pat, relPath, false)) continue;
        for (let k = attrs.length - 1; k >= 0; k--) {
          const [name, val] = attrs[k];
          const expand = MACROS[name] && val === true ? Object.entries(MACROS[name]) : [[name, val]];
          for (const [n, v] of expand) {
            if (!want.has(n) || n in result) continue;
            result[n] = v;
          }
          if (MACROS[name] && val === true && want.has(name) && !(name in result)) result[name] = true;
        }
      }
    }
    for (const n of names) if (result[n] === undefined) delete result[n];
    return result;
  }
}
