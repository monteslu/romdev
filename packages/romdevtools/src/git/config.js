// config.js - read git's config files the way git reads them, without git.
//
// Only reading. Sources, in git's order (a later source wins): system
// (/etc/gitconfig, skipped under GIT_CONFIG_NOSYSTEM), global
// ($XDG_CONFIG_HOME/git/config then ~/.gitconfig, or GIT_CONFIG_GLOBAL), the
// repository's own config (in the common dir), config.worktree when
// extensions.worktreeConfig is on, then GIT_CONFIG_COUNT/KEY_n/VALUE_n.
// include.path and includeIf "gitdir:" / "gitdir/i:" / "onbranch:" are
// followed; other includeIf conditions are skipped.
//
// Keys are stored as git prints them in `git config --list`: section and key
// lowercased, a subsection kept verbatim (`remote.origin.url`).
//
// Plain JS ESM + JSDoc.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { wildmatch, WM_PATHNAME, WM_CASEFOLD } from "./wildmatch.js";

/** A parsed config: key -> list of values (null = the bare-key "true" form). */
export class GitConfig {
  constructor() { /** @type {Map<string, (string|null)[]>} */ this.values = new Map(); }

  add(key, value) {
    const k = normalizeKey(key);
    if (!this.values.has(k)) this.values.set(k, []);
    this.values.get(k).push(value);
  }

  /** Last value for a key (git's "last one wins"), or undefined. */
  get(key) {
    const v = this.values.get(normalizeKey(key));
    return v && v.length ? v[v.length - 1] : undefined;
  }

  getAll(key) { return this.values.get(normalizeKey(key)) ?? []; }

  /** git's boolean parse; `def` when unset. Throws on a value git would reject. */
  getBool(key, def) {
    const v = this.get(key);
    if (v === undefined) return def;
    return parseBool(v, key);
  }

  /** Every key under a section prefix, e.g. ("submodule") -> Map key->last value. */
  entries() { return [...this.values.entries()].map(([k, v]) => [k, v[v.length - 1]]); }
}

/** `section.Sub.Section.key`: lowercase the section and the key, keep the subsection. */
export function normalizeKey(key) {
  const first = key.indexOf(".");
  const last = key.lastIndexOf(".");
  if (first < 0) return key.toLowerCase();
  if (first === last) return key.toLowerCase();
  return key.slice(0, first).toLowerCase() + key.slice(first, last + 1) + key.slice(last + 1).toLowerCase();
}

export function parseBool(v, key = "") {
  if (v === null) return true;
  const s = String(v).toLowerCase();
  if (s === "true" || s === "yes" || s === "on") return true;
  if (s === "false" || s === "no" || s === "off" || s === "") return false;
  if (/^-?\d+$/.test(s)) return Number(s) !== 0;
  throw new Error(`bad boolean config value '${v}' for '${key}'`);
}

const expandHome = (p) => (p === "~" || p.startsWith("~/") ? os.homedir() + p.slice(1) : p);

/**
 * Parse one config file's text into `cfg`. `ctx` carries what includeIf
 * conditions are evaluated against ({gitDir, branch}).
 */
export function parseConfigText(text, cfg, { file = null, ctx = {}, depth = 0 } = {}) {
  let i = 0;
  const n = text.length;
  let section = null; // "core" or "remote.origin"
  if (text.charCodeAt(0) === 0xfeff) i = 1;
  const isSpace = (c) => c === " " || c === "\t" || c === "\r" || c === "\v" || c === "\f";
  while (i < n) {
    const c = text[i];
    if (c === "\n" || isSpace(c)) { i++; continue; }
    if (c === "#" || c === ";") { while (i < n && text[i] !== "\n") i++; continue; }
    if (c === "[") {
      // [section] / [section "sub"] / [section.sub] (legacy, lowercased)
      i++;
      let name = "";
      while (i < n && /[A-Za-z0-9.-]/.test(text[i])) name += text[i++];
      let sub = null;
      if (text[i] === " " || text[i] === "\t") {
        while (text[i] === " " || text[i] === "\t") i++;
        if (text[i] !== "\"") throw new Error(`bad config section header in ${file}`);
        i++;
        sub = "";
        while (i < n && text[i] !== "\"") {
          if (text[i] === "\n") throw new Error(`bad config section header in ${file}`);
          if (text[i] === "\\") { i++; if (i < n && text[i] !== "\n") sub += text[i++]; continue; }
          sub += text[i++];
        }
        i++; // closing quote
      }
      if (text[i] !== "]") throw new Error(`bad config section header in ${file}`);
      i++;
      if (sub === null) {
        const dot = name.indexOf(".");
        section = dot < 0 ? name.toLowerCase() : name.slice(0, dot).toLowerCase() + "." + name.slice(dot + 1).toLowerCase();
      } else section = name.toLowerCase() + "." + sub;
      continue;
    }
    if (!/[A-Za-z]/.test(c)) throw new Error(`bad config line in ${file}`);
    let key = "";
    while (i < n && /[A-Za-z0-9-]/.test(text[i])) key += text[i++];
    while (i < n && (text[i] === " " || text[i] === "\t")) i++;
    let value = null;
    if (text[i] === "=") {
      i++;
      // value: whitespace-trimmed, quotes toggle, escapes, comments, continuations
      let out = "", quoted = false, pendingSpace = "";
      let started = false;
      for (;;) {
        if (i >= n) break;
        const ch = text[i];
        if (ch === "\n") { if (quoted) throw new Error(`unterminated quote in ${file}`); break; }
        if (!quoted && (ch === "#" || ch === ";")) { while (i < n && text[i] !== "\n") i++; break; }
        if (!quoted && isSpace(ch)) { if (started) pendingSpace += ch; i++; continue; }
        if (ch === "\\") {
          const nx = text[i + 1];
          i += 2;
          if (nx === "\n") continue;
          if (nx === "\r" && text[i] === "\n") { i++; continue; }
          out += pendingSpace; pendingSpace = ""; started = true;
          if (nx === "n") out += "\n"; else if (nx === "t") out += "\t"; else if (nx === "b") out += "\b";
          else if (nx === "\\" || nx === "\"") out += nx;
          else throw new Error(`bad config escape in ${file}`);
          continue;
        }
        if (ch === "\"") { quoted = !quoted; out += pendingSpace; pendingSpace = ""; started = true; i++; continue; }
        out += pendingSpace; pendingSpace = ""; started = true;
        out += ch; i++;
      }
      value = out;
    } else {
      while (i < n && text[i] !== "\n") { if (text[i] === "#" || text[i] === ";") { while (i < n && text[i] !== "\n") i++; break; } i++; }
    }
    if (section === null) throw new Error(`config key outside a section in ${file}`);
    const full = section + "." + key.toLowerCase();
    cfg.add(full, value);
    if (depth < 10 && value !== null && file) {
      if (full === "include.path") includeFile(cfg, value, file, ctx, depth);
      else if (section.startsWith("includeif.") && key.toLowerCase() === "path" && includeIfMatches(section.slice("includeif.".length), file, ctx)) includeFile(cfg, value, file, ctx, depth);
    }
  }
  return cfg;
}

function includeFile(cfg, value, from, ctx, depth) {
  let p = expandHome(value);
  if (!path.isAbsolute(p)) p = path.join(path.dirname(from), p);
  let text;
  try { text = fs.readFileSync(p, "utf8"); } catch { return; }
  parseConfigText(text, cfg, { file: p, ctx, depth: depth + 1 });
}

function includeIfMatches(cond, from, ctx) {
  let m;
  if ((m = /^gitdir(\/i)?:(.*)$/s.exec(cond))) {
    if (!ctx.gitDir) return false;
    let pat = m[2];
    if (pat.startsWith("~/")) pat = expandHome(pat);
    else if (pat.startsWith("./")) pat = path.join(path.dirname(from), pat.slice(2));
    else if (!path.isAbsolute(pat)) pat = "**/" + pat;
    if (pat.endsWith("/")) pat += "**";
    const flags = WM_PATHNAME | (m[1] ? WM_CASEFOLD : 0);
    const candidates = new Set([ctx.gitDir]);
    try { candidates.add(fs.realpathSync(ctx.gitDir)); } catch {}
    for (const g of candidates) if (wildmatch(pat, g, flags)) return true;
    return false;
  }
  if ((m = /^onbranch:(.*)$/s.exec(cond))) {
    if (!ctx.branch) return false;
    let pat = m[1];
    if (pat.endsWith("/")) pat += "**";
    return wildmatch(pat, ctx.branch, WM_PATHNAME);
  }
  return false;
}

function readInto(cfg, file, ctx) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch { return false; }
  parseConfigText(text, cfg, { file, ctx });
  return true;
}

/** The global config files git reads, in order. */
export function globalConfigFiles(env = process.env) {
  if (env.GIT_CONFIG_GLOBAL !== undefined) return env.GIT_CONFIG_GLOBAL ? [env.GIT_CONFIG_GLOBAL] : [];
  const home = env.HOME || os.homedir();
  const xdg = env.XDG_CONFIG_HOME ? path.join(env.XDG_CONFIG_HOME, "git", "config") : path.join(home, ".config", "git", "config");
  return [xdg, path.join(home, ".gitconfig")];
}

export function systemConfigFile(env = process.env) {
  if (env.GIT_CONFIG_NOSYSTEM && parseBool(env.GIT_CONFIG_NOSYSTEM)) return null;
  return env.GIT_CONFIG_SYSTEM || "/etc/gitconfig";
}

/**
 * Load the full layered config for a repository.
 * @param {{commonDir: string, gitDir: string, branch?: string|null}} repo
 */
export function loadConfig({ commonDir, gitDir, branch = null }, env = process.env) {
  const cfg = new GitConfig();
  const ctx = { gitDir, branch };
  const sys = systemConfigFile(env);
  if (sys) readInto(cfg, sys, ctx);
  for (const f of globalConfigFiles(env)) readInto(cfg, f, ctx);
  if (commonDir) readInto(cfg, path.join(commonDir, "config"), ctx);
  if (gitDir && cfg.getBool("extensions.worktreeConfig", false)) readInto(cfg, path.join(gitDir, "config.worktree"), ctx);
  const count = Number(env.GIT_CONFIG_COUNT || 0);
  for (let k = 0; k < count; k++) {
    const key = env[`GIT_CONFIG_KEY_${k}`];
    if (key) cfg.add(key, env[`GIT_CONFIG_VALUE_${k}`] ?? "");
  }
  return cfg;
}

/** Read only one repository config file (no layering), e.g. for core.bare during discovery. */
export function readRepoConfigFile(file) {
  const cfg = new GitConfig();
  readInto(cfg, file, {});
  return cfg;
}
