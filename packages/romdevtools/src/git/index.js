// git/ - read a git repository in pure JS. romdev never launches the `git`
// program: a server that shells out to a host binary inherits whatever
// version, config and PATH the host has, and is one more native dependency
// the WASM-only toolchain promise does not allow.
//
// Each export below answers exactly what one git command answers, and is
// held to that by test/git-read.test.js (synthetic repositories) and by the
// oracle comparison recorded in the commit that introduced this module.
//
//   showToplevel(dir)            git -C dir rev-parse --show-toplevel
//   revParseHead(dir)            git -C dir rev-parse HEAD
//   revParseHead(dir, {short})   git -C dir rev-parse --short HEAD
//   statusPorcelain(dir)         git -C dir status --porcelain   (lines)
//   lsFiles(dir, opts)           git -C dir ls-files [-c] [-o] [--exclude-standard] -- <pathspec>
//   isTracked(dir, rel)          git -C dir ls-files --error-unmatch -- rel  (exit 0?)
//   remoteUrl(dir, name)         git -C dir remote get-url <name>
//   showFile(dir, rel, rev)      git -C dir show <rev>:<rel>     (Buffer)
//
// Every function returns null where git would exit non-zero (not a
// repository, unborn HEAD, missing path), and throws GitUnsupportedError
// for a repository layout it will not guess about.
//
// Plain JS ESM + JSDoc.

import fs from "node:fs";
import { Repo, withRepo, GitUnsupportedError } from "./repo.js";
import { statusPorcelain as porcelain, lsFiles as ls, allTracked } from "./worktree.js";

export { Repo, GitUnsupportedError };

/** Absolute worktree root containing `dir`, or null (not in a worktree). */
export function showToplevel(dir) {
  return withRepo(dir, (repo) => (repo && repo.worktree ? repo.worktree : null));
}

/** HEAD's commit id (full, or git's unique abbreviation with {short:true}); null when unborn / no repo. */
export function revParseHead(dir, { short = false } = {}) {
  return withRepo(dir, (repo) => {
    if (!repo) return null;
    const oid = repo.head();
    if (!oid) return null;
    if (!repo.objects.has(oid)) return null;
    return short ? repo.abbreviate(oid) : oid;
  });
}

/** `git status --porcelain` lines (v1, no trailing newline), or null when not a worktree. */
export function statusPorcelain(dir) {
  return withRepo(dir, (repo) => (repo && repo.worktree ? porcelain(repo) : null));
}

/**
 * `git ls-files` run at `dir` (which must be a worktree root, as callers use
 * it), paths relative to it. null when not a repository.
 * @param {string} dir
 * @param {{cached?: boolean, others?: boolean, excludeStandard?: boolean, pathspec?: string[]}} [opts]
 */
export function lsFiles(dir, opts = {}) {
  return withRepo(dir, (repo) => {
    if (!repo || !repo.worktree) return null;
    if (fs.realpathSync(dir) !== repo.worktree) throw new Error(`lsFiles: '${dir}' is not the worktree root '${repo.worktree}'`);
    return ls(repo, opts);
  });
}

/** `git -C dir ls-files --error-unmatch -- rel` succeeded? (rel relative to the worktree root `dir`). */
export function isTracked(dir, rel) {
  return withRepo(dir, (repo) => {
    if (!repo || !repo.worktree) return false;
    return allTracked(repo, [rel]);
  });
}

/** `git remote get-url <name>`, with url.<base>.insteadOf rewriting; null when unset. */
export function remoteUrl(dir, name = "origin") {
  return withRepo(dir, (repo) => {
    if (!repo) return null;
    const cfg = repo.config;
    const url = cfg.get(`remote.${name}.url`);
    if (url === undefined || url === null) return null;
    let best = null;
    for (const [k] of cfg.entries()) {
      const m = /^url\.(.*)\.insteadof$/.exec(k);
      if (!m) continue;
      for (const v of cfg.getAll(k)) {
        if (v !== null && url.startsWith(v) && (!best || v.length > best.prefix.length)) best = { prefix: v, base: m[1] };
      }
    }
    return best ? best.base + url.slice(best.prefix.length) : url;
  });
}

/** Contents of `<rev>:<rel>` (rev: "HEAD" or a full commit id); null when absent. */
export function showFile(dir, rel, rev = "HEAD") {
  return withRepo(dir, (repo) => {
    if (!repo) return null;
    const oid = rev === "HEAD" ? repo.head() : /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(rev) ? rev : repo.resolveRef(rev)?.oid;
    if (!oid) return null;
    const entry = repo.objects.lookupPath(repo.objects.commitTree(oid), rel);
    if (!entry || (entry.mode & 0o170000) === 0o040000) return null;
    return repo.objects.readTyped(entry.oid, "blob");
  });
}
