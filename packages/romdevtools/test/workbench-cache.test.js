// Cache cleanup is inspectable, opt-in, and recoverable. Ported from the
// workbench's cache tests, plus the commands through runCommand.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cacheStatus, formatBytes, parseDuration, parseSize, pruneCache, restorePrunedCache } from "../src/decomp/workbench/cache.js";
import { runCommand } from "../src/decomp/workbench/cli.js";

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "romdev-wb-cache-")));
const age = (p, seconds) => { const t = Date.now() / 1000 - seconds; fs.utimesSync(p, t, t); };
const withDir = (fn) => { const d = tmp(); try { return fn(d); } finally { fs.rmSync(d, { recursive: true, force: true }); } };

test("duration parser accepts combinations", () => {
  assert.equal(parseDuration("1w2d3h"), 788_400);
  assert.throws(() => parseDuration("30 days"), { name: "ValueError" });
});

test("size parser and formatter are human readable", () => {
  assert.equal(parseSize("1.5MiB"), 1_572_864);
  assert.equal(parseSize("2G"), 2 * 1024 ** 3);
  assert.equal(formatBytes(1536), "1.5 KiB");
  assert.throws(() => parseSize("lots"), { name: "ValueError" });
});

test("prune defaults to a non-mutating plan", () => withDir((root) => {
  const cache = path.join(root, "cache"); fs.mkdirSync(cache);
  const old = path.join(cache, "old.o"), recent = path.join(cache, "recent.o");
  fs.writeFileSync(old, "old"); fs.writeFileSync(recent, "recent");
  age(old, 10 * 86400);
  const report = pruneCache(cache, { older_than: 7 * 86400, apply: false, trash_root: path.join(root, "trash") });
  assert.equal(report.selected_files, 1);
  assert.ok(fs.existsSync(old) && fs.existsSync(recent));
  assert.equal(fs.existsSync(path.join(root, "trash")), false);
}));

test("applied prune moves to trash and restores", () => withDir((root) => {
  const cache = path.join(root, "cache"); fs.mkdirSync(cache);
  const entry = path.join(cache, "entry.o"); fs.writeFileSync(entry, "object"); age(entry, 100);
  const report = pruneCache(cache, { older_than: 10, apply: true, trash_root: path.join(root, "trash") });
  assert.equal(fs.existsSync(entry), false);
  const trash = report.trash_directory;
  assert.equal(fs.readFileSync(path.join(trash, "entry.o"), "utf8"), "object");
  assert.equal(restorePrunedCache(trash, cache), 1);
  assert.equal(fs.readFileSync(entry, "utf8"), "object");
  assert.equal(cacheStatus(cache).files, 1);
}));

test("size prune uses LRU and can protect recent entries", () => withDir((root) => {
  const cache = path.join(root, "cache"); fs.mkdirSync(cache);
  const entries = [];
  for (let i = 0; i < 4; i++) { const e = path.join(cache, `${i}.o`); fs.writeFileSync(e, "x".repeat(10)); age(e, 100 - i); entries.push(e); }
  const report = pruneCache(cache, { max_size: 15, keep_recent: 1, apply: false, trash_root: path.join(root, "trash") });
  assert.equal(report.selected_files, 3);
  assert.equal(report.cache_bytes_after, 10);
  assert.ok(!report.entries.map((e) => e.path).includes(entries.at(-1)));
}));

test("nested entries round-trip through recoverable trash", () => withDir((root) => {
  const cache = path.join(root, "cache");
  const nested = path.join(cache, "objects", "entry.o");
  fs.mkdirSync(path.dirname(nested), { recursive: true }); fs.writeFileSync(nested, "nested"); age(nested, 100);
  const report = pruneCache(cache, { older_than: 10, apply: true, trash_root: path.join(root, "trash") });
  assert.equal(fs.readFileSync(path.join(report.trash_directory, "objects", "entry.o"), "utf8"), "nested");
  assert.equal(restorePrunedCache(report.trash_directory, cache), 1);
  assert.equal(fs.readFileSync(nested, "utf8"), "nested");
}));

test("restore preflights every collision before moving", () => withDir((root) => {
  const trash = path.join(root, "trash"), cache = path.join(root, "cache");
  fs.mkdirSync(trash); fs.mkdirSync(cache);
  fs.writeFileSync(path.join(trash, "first.o"), "first");
  fs.writeFileSync(path.join(trash, "second.o"), "second");
  fs.writeFileSync(path.join(cache, "second.o"), "existing");
  assert.throws(() => restorePrunedCache(trash, cache), /partial restore/);
  assert.equal(fs.readFileSync(path.join(trash, "first.o"), "utf8"), "first");
  assert.equal(fs.readFileSync(path.join(trash, "second.o"), "utf8"), "second");
  assert.equal(fs.existsSync(path.join(cache, "first.o")), false);
  assert.equal(fs.readFileSync(path.join(cache, "second.o"), "utf8"), "existing");
}));

test("cache commands: status, dry-run prune, applied prune and restore, by grouped spelling", async () => {
  const root = tmp();
  try {
    const cache = path.join(root, ".decomp-workbench", "cache");
    fs.mkdirSync(cache, { recursive: true });
    const e = path.join(cache, "a.o"); fs.writeFileSync(e, "abc"); age(e, 3 * 86400);
    const status = await runCommand(["cache", "status", "--json"], { cwd: root });
    assert.equal(status.code, 0);
    const doc = JSON.parse(status.stdout);
    assert.equal(doc.schema, "decomp-workbench-cache-status-v1");
    assert.equal(doc.files, 1);
    const text = await runCommand(["cache", "status"], { cwd: root });
    assert.match(text.stdout, /^cache: 1 file\(s\), 3 B \(3 bytes; /);
    const plan = await runCommand(["cache", "prune", "--older-than", "1d"], { cwd: root });
    assert.equal(plan.stdout, "cache prune dry-run: 1 file(s), 3 B\nnext: repeat with --apply to move these files to recoverable trash\n");
    const applied = await runCommand(["cache", "prune", "--older-than", "1d", "--apply", "--json"], { cwd: root });
    const report = JSON.parse(applied.stdout);
    assert.equal(report.mode, "applied");
    assert.equal(fs.existsSync(e), false);
    const restored = await runCommand(["cache", "restore", report.trash_directory], { cwd: root });
    assert.equal(restored.code, 0);
    assert.match(restored.stdout, /^restored 1 cache file\(s\) into /);
    assert.equal(fs.readFileSync(e, "utf8"), "abc");
    const bad = await runCommand(["cache", "prune", "--json"], { cwd: root });
    assert.equal(bad.code, 2);
    assert.equal(JSON.parse(bad.stdout).error.message, "prune needs --older-than, --max-size, or both");
    assert.equal(JSON.parse(bad.stdout).command, "cache-prune");
    const missing = await runCommand(["cache", "restore", "nowhere", "--json"], { cwd: root });
    assert.equal(missing.code, 2);
    assert.match(JSON.parse(missing.stdout).error.message, /^trash directory does not exist: /);
    const listing = await runCommand(["cache", "--help"], { cwd: root });
    assert.equal(listing.code, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
