// romdev reads git repositories in pure JS (src/git/) and never launches the
// git program. These tests build real on-disk repositories with the JS writer
// in helpers/git-writer.js (loose objects, packs with both delta kinds,
// packed-refs, index v2/v3/v4, gitfiles) and pin each answer to what the
// corresponding git command prints. The same reader was also compared with
// real git on real decomp checkouts when it was introduced; these tests keep
// it honest without a git binary anywhere.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { GitWriter, makeDelta } from "./helpers/git-writer.js";
import { showToplevel, revParseHead, statusPorcelain, lsFiles, isTracked, remoteUrl, showFile, Repo } from "../src/git/index.js";
import { applyDelta } from "../src/git/objects.js";
import { parseIndex } from "../src/git/index-file.js";
import { wildmatch, WM_PATHNAME } from "../src/git/wildmatch.js";
import { parseConfigText, GitConfig } from "../src/git/config.js";
import { quotePath } from "../src/git/worktree.js";

function tmp() { return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "romdev-git-read-"))); }
function withTmp(fn) { const d = tmp(); try { return fn(d); } finally { fs.rmSync(d, { recursive: true, force: true }); } }
// Every repository under test reads only its own config: no host ~/.gitconfig or excludes file leaks in.
const ENV_KEYS = ["HOME", "XDG_CONFIG_HOME", "GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_GLOBAL"];
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const fakeHome = tmp();
process.env.HOME = fakeHome;
process.env.XDG_CONFIG_HOME = path.join(fakeHome, ".config");
process.env.GIT_CONFIG_NOSYSTEM = "1";
delete process.env.GIT_CONFIG_GLOBAL;
test.after(() => { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } fs.rmSync(fakeHome, { recursive: true, force: true }); });

/**
 * Age every staged file and re-record its stat data so no entry is racy:
 * the state of a checkout some time after the last git command touched it.
 */
function settle(w) {
  const old = new Date(Date.now() - 3600_000);
  for (const p of w.staged.keys()) { try { fs.lutimesSync(path.join(w.worktree, p), old, old); } catch {} }
  w.refreshStat();
  w.writeIndex();
}

test("discovery: toplevel from any depth, and null outside a repository", () => withTmp((d) => {
  const w = new GitWriter(path.join(d, "repo"));
  w.file("a/b/c.txt", "x\n");
  w.commit("one");
  assert.equal(showToplevel(path.join(d, "repo")), path.join(d, "repo"));
  assert.equal(showToplevel(path.join(d, "repo", "a", "b")), path.join(d, "repo"));
  assert.equal(showToplevel(path.join(d, "repo", "a", "b", "c.txt")), path.join(d, "repo"), "a file argument resolves from its directory");
  fs.mkdirSync(path.join(d, "plain"));
  assert.equal(showToplevel(path.join(d, "plain")), null);
  assert.equal(revParseHead(path.join(d, "plain")), null);
  assert.equal(statusPorcelain(path.join(d, "plain")), null);
  assert.equal(showToplevel(path.join(d, "repo", ".git")), null, "inside the git dir there is no worktree");
  assert.equal(showToplevel(path.join(d, "missing")), null);
}));

test("rev-parse HEAD: loose branch, packed-refs only, detached, unborn", () => withTmp((d) => {
  const w = new GitWriter(d);
  assert.equal(revParseHead(d), null, "unborn HEAD fails like git rev-parse HEAD");
  w.file("f.txt", "1\n");
  const c1 = w.commit("one");
  w.file("f.txt", "2\n");
  const c2 = w.commit("two");
  assert.equal(revParseHead(d), c2);
  w.packRefs();
  assert.equal(fs.existsSync(path.join(d, ".git/refs/heads/main")), false);
  assert.equal(revParseHead(d), c2, "resolved through packed-refs");
  w.detach(c1);
  assert.equal(revParseHead(d), c1, "detached HEAD holds the id itself");
  assert.deepEqual(Repo.open(d).headInfo(), { detached: true, ref: null, oid: c1 });
  // a symbolic chain: HEAD -> refs/heads/alias -> refs/heads/main
  fs.writeFileSync(path.join(d, ".git/refs/heads/alias"), "ref: refs/heads/main\n");
  fs.writeFileSync(path.join(d, ".git/HEAD"), "ref: refs/heads/alias\n");
  assert.equal(revParseHead(d), c2);
}));

test("--short HEAD: 7 digits below 2^13 packed objects, longer as the pack grows, unique always", () => withTmp((d) => {
  const w = new GitWriter(d);
  w.file("x", "x\n");
  const c = w.commit("x");
  assert.equal(revParseHead(d, { short: true }), c.slice(0, 7));
  // 17000 blobs: loose objects are NOT counted by git's approximate count...
  const oids = [];
  for (let i = 0; i < 17000; i++) oids.push(w.writeObject("blob", `${i}\n`));
  assert.equal(revParseHead(d, { short: true }), c.slice(0, 7), "loose objects do not lengthen the default");
  // ...packed ones are: 17003 objects -> 15 bits -> ceil(15/2) = 8 digits.
  w.pack({ deltas: false });
  assert.equal(revParseHead(d, { short: true }), c.slice(0, 8));
  // core.abbrev sets the floor; a prefix shared with another object extends it.
  w.config("[core]\n\tabbrev = 4\n");
  const all = [...oids, c];
  const repo = Repo.open(d);
  try {
    for (const target of all.slice(0, 200)) {
      let shared = 0;
      for (const o of all) {
        if (o === target) continue;
        let i = 0;
        while (i < 40 && o[i] === target[i]) i++;
        shared = Math.max(shared, i);
      }
      const want = target.slice(0, Math.max(4, shared + 1));
      assert.equal(repo.abbreviate(target), want, `abbrev of ${target}`);
    }
  } finally { repo.close(); }
}));

test("packs: OFS_DELTA and REF_DELTA chains resolve to the original bytes", () => withTmp((d) => {
  const w = new GitWriter(d);
  const versions = [];
  for (let i = 0; i < 6; i++) {
    const text = Array.from({ length: 300 + i * 7 }, (_, k) => `line ${k} rev ${k % 13 === 0 ? i : 0}\n`).join("");
    versions.push(text);
    w.file("big.c", text);
    w.commit(`r${i}`);
  }
  const before = showFile(d, "big.c");
  w.pack();
  assert.equal(fs.readdirSync(path.join(d, ".git/objects")).filter((n) => /^[0-9a-f]{2}$/.test(n)).length, 0, "no loose objects remain");
  assert.equal(showFile(d, "big.c").toString(), versions[5]);
  assert.deepEqual(showFile(d, "big.c"), before);
  assert.equal(showFile(d, "nope.c"), null);
  // delta encode/decode agree on edge shapes
  for (const [a, b] of [["", "abc"], ["abc", ""], ["same", "same"], ["prefix-tail", "prefix-middle-tail"], ["x".repeat(70000), "x".repeat(70000) + "y"]]) {
    assert.equal(applyDelta(Buffer.from(a), makeDelta(Buffer.from(a), Buffer.from(b))).toString(), b);
  }
}));

test("index v2, v3 and v4 parse to the same entries (flags kept)", () => withTmp((d) => {
  const w = new GitWriter(d);
  for (const p of ["a.txt", "dir/a.txt", "dir/ab.txt", "dir/sub/deep.txt", "z"]) w.file(p, p + "\n");
  w.commit("c");
  w.staged.get("dir/ab.txt").skipWorktree = true;
  const read = (v) => { w.writeIndex({ version: v }); return parseIndex(fs.readFileSync(path.join(d, ".git/index"))); };
  const v3 = read(3), v4 = read(4);
  assert.equal(v3.version, 3);
  assert.equal(v4.version, 4);
  const strip = (x) => x.entries.map((e) => [e.path, e.oid, e.mode, e.skipWorktree, e.size]);
  assert.deepEqual(strip(v4), strip(v3));
  assert.equal(v3.entries.find((e) => e.path === "dir/ab.txt").skipWorktree, true);
  delete w.staged.get("dir/ab.txt").skipWorktree;
  const v2 = read(2);
  assert.deepEqual(v2.entries.map((e) => e.path), ["a.txt", "dir/a.txt", "dir/ab.txt", "dir/sub/deep.txt", "z"]);
}));

test("status --porcelain: a busy dirty tree", () => withTmp((d) => {
  const w = new GitWriter(d);
  w.file(".gitignore", "*.log\nbuild/\n!keep.log\n");
  w.file("mod.txt", "orig\n");
  w.file("del.txt", "gone soon\n");
  w.file("exec.sh", "#!/bin/sh\n");
  w.file("type.txt", "becomes a link\n");
  w.file("staged-mod.txt", "v1\n");
  w.file("staged-del.txt", "x\n");
  w.file("ren.c", Array.from({ length: 50 }, (_, i) => `int v${i};\n`).join(""));
  w.file("dir/keep.c", "k\n");
  w.commit("base");
  settle(w);
  // worktree-only changes
  fs.writeFileSync(path.join(d, "mod.txt"), "changed\n");
  fs.rmSync(path.join(d, "del.txt"));
  fs.chmodSync(path.join(d, "exec.sh"), 0o755);
  fs.rmSync(path.join(d, "type.txt")); fs.symlinkSync("mod.txt", path.join(d, "type.txt"));
  // staged changes
  w.file("staged-mod.txt", "v2\n");
  w.unstage("staged-del.txt"); fs.rmSync(path.join(d, "staged-del.txt"));
  w.file("new.txt", "new\n");
  const ren = w.staged.get("ren.c"); w.unstage("ren.c");
  fs.renameSync(path.join(d, "ren.c"), path.join(d, "dir/renamed.c")); w.staged.set("dir/renamed.c", ren);
  w.file("ita.txt", "intent\n", { stage: false }); w.add("ita.txt", { intentToAdd: true });
  w.writeIndex();
  // untracked and ignored
  w.file("untracked.txt", "u\n", { stage: false });
  w.file("udir/a.txt", "a\n", { stage: false });
  w.file("udir/b/c.txt", "c\n", { stage: false });
  w.file("only-ignored/x.log", "l\n", { stage: false });
  w.file("debug.log", "l\n", { stage: false });
  w.file("keep.log", "kept\n", { stage: false });
  w.file("build/out", "o\n", { stage: false });
  w.file("dir/new.c", "n\n", { stage: false });
  w.file("with space.txt", "s\n", { stage: false });
  w.file("ünï.txt", "u\n", { stage: false });
  fs.mkdirSync(path.join(d, "empty-dir"));
  new GitWriter(path.join(d, "nested"));
  assert.deepEqual(statusPorcelain(d), [
    " D del.txt",
    "R  ren.c -> dir/renamed.c",
    " M exec.sh",
    " A ita.txt",
    " M mod.txt",
    "A  new.txt",
    "D  staged-del.txt",
    "M  staged-mod.txt",
    " T type.txt",
    "?? dir/new.c",
    "?? keep.log",
    "?? nested/",
    "?? udir/",
    "?? untracked.txt",
    "?? \"with space.txt\"",
    "?? \"\\303\\274n\\303\\257.txt\"",
  ]);
  // what handoff-audit asks
  assert.deepEqual(lsFiles(d, { others: true, excludeStandard: true, pathspec: ["."] }),
    ["dir/new.c", "keep.log", "nested/", "udir/a.txt", "udir/b/c.txt", "untracked.txt", "with space.txt", "ünï.txt"]);
  assert.deepEqual(lsFiles(d, { others: true, excludeStandard: true, pathspec: ["udir"] }), ["udir/a.txt", "udir/b/c.txt"]);
  assert.deepEqual(lsFiles(d, { cached: true, pathspec: ["dir"] }), ["dir/keep.c", "dir/renamed.c"]);
  assert.ok(lsFiles(d, { others: true, pathspec: ["."] }).includes("debug.log"), "without --exclude-standard ignored files are listed");
  assert.equal(isTracked(d, "dir"), true);
  assert.equal(isTracked(d, "dir/keep.c"), true);
  assert.equal(isTracked(d, "ita.txt"), true);
  assert.equal(isTracked(d, "untracked.txt"), false);
  assert.equal(isTracked(d, "staged-del.txt"), false);
}));

test("status: a stat-clean tree is clean; content, not mtime, decides a touched file", () => withTmp((d) => {
  const w = new GitWriter(d);
  w.file("a.txt", "a\n");
  w.file("b.txt", "b\n");
  w.commit("c");
  settle(w);
  assert.deepEqual(statusPorcelain(d), []);
  const later = new Date();
  fs.utimesSync(path.join(d, "a.txt"), later, later);
  assert.deepEqual(statusPorcelain(d), [], "same bytes, new mtime: still clean");
  fs.writeFileSync(path.join(d, "b.txt"), "B\n");
  assert.deepEqual(statusPorcelain(d), [" M b.txt"], "same size, new bytes: modified");
}));

test("status: CRLF conversion and git's size rule", () => withTmp((d) => {
  const w = new GitWriter(d);
  w.file(".gitattributes", "*.t text\n");
  w.file("n.t", "a\nb\n");
  w.file("plain.txt", "a\nb\n");
  w.commit("c");
  settle(w);
  fs.writeFileSync(path.join(d, "n.t"), "a\r\nb\r\n");
  fs.writeFileSync(path.join(d, "plain.txt"), "a\r\nb\r\n");
  // A recorded size that differs is "modified" without reading the file, even
  // though n.t would normalize to its blob - exactly as git reports it.
  assert.deepEqual(statusPorcelain(d), [" M n.t", " M plain.txt"]);
  // With no stat data recorded (read-tree), the converted content decides.
  w.writeIndex({ statFrom: "zero" });
  assert.deepEqual(statusPorcelain(d), [" M plain.txt"]);
  w.config("[core]\n\tautocrlf = true\n");
  assert.deepEqual(statusPorcelain(d), []);
}));

test("status: unmerged entries print git's two-letter codes", () => withTmp((d) => {
  const w = new GitWriter(d);
  w.file("both.txt", "base\n");
  w.file("theirs-del.txt", "base\n");
  w.commit("base");
  const blob = (s) => w.writeObject("blob", s);
  for (const p of ["both.txt", "theirs-del.txt"]) w.unstage(p);
  w.extraIndex.push(
    { path: "both.txt", stage: 1, mode: 0o100644, oid: blob("base\n") },
    { path: "both.txt", stage: 2, mode: 0o100644, oid: blob("ours\n") },
    { path: "both.txt", stage: 3, mode: 0o100644, oid: blob("theirs\n") },
    { path: "theirs-del.txt", stage: 1, mode: 0o100644, oid: blob("base\n") },
    { path: "theirs-del.txt", stage: 2, mode: 0o100644, oid: blob("ours\n") },
    { path: "added-both.txt", stage: 2, mode: 0o100644, oid: blob("a\n") },
    { path: "added-both.txt", stage: 3, mode: 0o100644, oid: blob("b\n") },
  );
  w.writeIndex();
  fs.writeFileSync(path.join(d, "added-both.txt"), "conflict\n");
  assert.deepEqual(statusPorcelain(d), ["AA added-both.txt", "UU both.txt", "UD theirs-del.txt"]);
  assert.deepEqual(lsFiles(d, { cached: true }), ["added-both.txt", "added-both.txt", "both.txt", "both.txt", "both.txt", "theirs-del.txt", "theirs-del.txt"]);
}));

test("submodules: a .git FILE, new commits, dirty and untracked content", () => withTmp((d) => {
  const sup = new GitWriter(path.join(d, "super"));
  sup.file("main.c", "m\n");
  const mk = (name) => {
    const sub = new GitWriter(path.join(d, "super", name), { gitDir: path.join(d, "super", ".git", "modules", name) });
    sub.file("lib.c", "lib\n");
    const c = sub.commit("lib");
    settle(sub);
    sup.gitlink(name, c);
    return { sub, c };
  };
  const clean = mk("clean"), moved = mk("moved"), dirty = mk("dirty"), untracked = mk("untracked");
  sup.file(".gitmodules", ["clean", "moved", "dirty", "untracked"].map((n) => `[submodule "${n}"]\n\tpath = ${n}\n\turl = ./x\n`).join(""));
  sup.commit("subs");
  settle(sup);
  assert.equal(showToplevel(path.join(d, "super", "clean")), path.join(d, "super", "clean"), "a submodule is its own toplevel");
  assert.equal(revParseHead(path.join(d, "super", "clean")), clean.c);
  moved.sub.file("lib.c", "lib2\n"); moved.sub.commit("lib2"); settle(moved.sub);
  fs.writeFileSync(path.join(d, "super", "dirty", "lib.c"), "edited\n");
  fs.writeFileSync(path.join(d, "super", "untracked", "new.c"), "n\n");
  assert.deepEqual(statusPorcelain(path.join(d, "super")), [" M dirty", " M moved", " M untracked"]);
  assert.equal(isTracked(path.join(d, "super"), "clean"), true);
  // submodule.<name>.ignore
  sup.config("[submodule \"untracked\"]\n\tignore = untracked\n[submodule \"dirty\"]\n\tignore = dirty\n[submodule \"moved\"]\n\tignore = all\n");
  assert.deepEqual(statusPorcelain(path.join(d, "super")), []);
  void dirty; void untracked;
}));

test("a linked worktree reads HEAD and index from its own git dir, objects and refs from the common dir", () => withTmp((d) => {
  const main = new GitWriter(path.join(d, "main"));
  main.file("f.txt", "1\n");
  const c1 = main.commit("one");
  main.file("f.txt", "2\n");
  main.commit("two");
  const wt = main.linkedWorktree(path.join(d, "wt"), "wt", c1);
  wt.staged.set("f.txt", { mode: 0o100644, oid: main.writeObject("blob", "1\n") });
  fs.writeFileSync(path.join(d, "wt", "f.txt"), "1\n");
  settle(wt);
  assert.equal(showToplevel(path.join(d, "wt")), path.join(d, "wt"));
  assert.equal(revParseHead(path.join(d, "wt")), c1);
  assert.deepEqual(statusPorcelain(path.join(d, "wt")), []);
  fs.writeFileSync(path.join(d, "wt", "extra"), "e\n");
  assert.deepEqual(statusPorcelain(path.join(d, "wt")), ["?? extra"]);
}));

test("remote get-url follows url.<base>.insteadOf (longest prefix wins)", () => withTmp((d) => {
  const w = new GitWriter(d);
  assert.equal(remoteUrl(d, "origin"), null);
  w.config("[remote \"origin\"]\n\turl = https://example.invalid/team/repo.git\n");
  assert.equal(remoteUrl(d, "origin"), "https://example.invalid/team/repo.git");
  w.config("[url \"git@example.invalid:\"]\n\tinsteadOf = https://example.invalid/\n[url \"ssh://host/\"]\n\tinsteadOf = https://example.invalid/team/\n");
  assert.equal(remoteUrl(d, "origin"), "ssh://host/repo.git");
}));

test("showFile reads through an annotated tag and a detached HEAD", () => withTmp((d) => {
  const w = new GitWriter(d);
  w.file("v.txt", "one\n");
  const c1 = w.commit("one");
  w.file("v.txt", "two\n");
  w.commit("two");
  w.annotatedTag("v1", c1);
  assert.equal(showFile(d, "v.txt", "refs/tags/v1").toString(), "one\n");
  assert.equal(showFile(d, "v.txt").toString(), "two\n");
  w.detach(c1);
  assert.equal(showFile(d, "v.txt").toString(), "one\n");
}));

test("wildmatch agrees with git's t3070 cases", () => {
  const cases = [
    // [pattern, text, pathname-mode result, plain result]
    ["foo", "foo", true, true], ["foo", "bar", false, false], ["???", "foo", true, true], ["*f", "foo", false, false],
    ["*", "foo/bar", false, true], ["foo/*", "foo/bar", true, true], ["foo/*", "foo/bar/baz", false, true],
    ["**/foo", "foo", true, true], ["**/foo", "a/b/foo", true, true], ["**/foo", "XXX/foo", true, true],
    ["foo/**", "foo/a/b", true, true], ["a/**/b", "a/b", true, true], ["a/**/b", "a/x/y/b", true, true],
    ["*/foo", "a/b/foo", false, true], ["[a-c]x", "bx", true, true], ["[!a-c]x", "bx", false, false], ["[^a-c]x", "dx", true, true],
    ["[[:digit:]]", "5", true, true], ["[[:alpha:]]", "5", false, false], ["\\*", "*", true, true], ["\\*", "a", false, false],
    ["a[/]b", "a/b", false, true], ["*.c", "dir/x.c", false, true], ["**", "a/b/c", true, true], ["foo?", "foo/", false, true],
    ["[]]", "]", true, true], ["[a-]", "-", true, true], ["-*-*-*-*-*-*-12-*-*-*-m-*-*-*", "-adobe-courier-bold-o-normal--12-120-75-75-m-70-iso8859-1", true, true],
  ];
  for (const [p, t, withPath, plain] of cases) {
    assert.equal(wildmatch(p, t, WM_PATHNAME), withPath, `${p} vs ${t} (WM_PATHNAME)`);
    assert.equal(wildmatch(p, t, 0), plain, `${p} vs ${t}`);
  }
});

test("config parsing: sections, subsections, quoting, escapes, comments, bare keys", () => {
  const cfg = parseConfigText([
    "[core]",
    "\tAbbrev = 9 ; trailing comment",
    "\tbare",
    "[remote \"Origin\"]",
    "\turl = \"https://x/y z\" # quoted value keeps its space",
    "[Section.Sub]",
    "\tkey = a \\",
    "continued",
    "\tesc = \"tab\\there\"",
  ].join("\n"), new GitConfig());
  assert.equal(cfg.get("core.abbrev"), "9");
  assert.equal(cfg.getBool("core.bare", false), true);
  assert.equal(cfg.get("remote.Origin.url"), "https://x/y z");
  assert.equal(cfg.get("remote.origin.url"), undefined, "subsections are case-sensitive");
  assert.equal(cfg.get("section.sub.key"), "a continued");
  assert.equal(cfg.get("section.sub.esc"), "tab\there");
});

test("paths are quoted the way git status quotes them", () => {
  assert.equal(quotePath("plain.txt"), "plain.txt");
  assert.equal(quotePath("a b.txt", { quoteSpace: true }), "\"a b.txt\"");
  assert.equal(quotePath("a b.txt"), "a b.txt");
  assert.equal(quotePath("tab\there"), "\"tab\\there\"");
  assert.equal(quotePath("q\"uote"), "\"q\\\"uote\"");
  assert.equal(quotePath("ü"), "\"\\303\\274\"");
  assert.equal(quotePath("ü", { quoteFully: false }), "ü");
});

test("no romdev source launches git", () => {
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
  const offenders = [];
  const launch = /\b(?:spawn|spawnSync|execFile|execFileSync|exec|execSync|fork)\s*\(\s*["'`]git["'`]|\[\s*["'`]git["'`]\s*,/;
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name === "build" || e.name.startsWith(".")) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(m|c)?js$/.test(e.name) && p !== new URL(import.meta.url).pathname) {
        const text = fs.readFileSync(p, "utf8");
        text.split("\n").forEach((line, i) => { if (launch.test(line)) offenders.push(`${path.relative(root, p)}:${i + 1}: ${line.trim()}`); });
      }
    }
  };
  for (const sub of ["src", "scripts", "test"]) walk(path.join(root, sub));
  assert.deepEqual(offenders, []);
});
