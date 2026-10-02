// A closeness ranking is a measurement of one tree, and says which one.
// Ported from the workbench's ranking tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { RANKING_STAMP_SCHEMA, checkRankingFresh, freshnessNote, freshnessWarning, gitHead, readStamp, renderFreshness, stampRanking } from "../src/decomp/workbench/ranking.js";
import { runCommand } from "../src/decomp/workbench/cli.js";
import { GitWriter } from "./helpers/git-writer.js";

const ROWS = [
  { name: "func_80012574", differing_words: 18, size_bytes: 240 },
  { name: "func_8001A154", differing_words: 214, size_bytes: 1200 },
];
const HEAD = "0123456789abcdef0123456789abcdef01234567";
const OTHER = "fedcba9876543210fedcba9876543210fedcba98";
const moment = () => new Date(Date.UTC(2026, 7, 28, 12, 0));
const later = () => new Date(Date.UTC(2026, 8, 1));

function withDir(fn) {
  const d = mkdtempSync(path.join(os.tmpdir(), "romdev-wb-ranking-"));
  try { return fn(d); } finally { rmSync(d, { recursive: true, force: true }); }
}
async function withDirAsync(fn) {
  const d = mkdtempSync(path.join(os.tmpdir(), "romdev-wb-ranking-"));
  try { return await fn(d); } finally { rmSync(d, { recursive: true, force: true }); }
}
function writeRanking(root, payload) {
  const p = path.join(root, "ranking.json");
  writeFileSync(p, JSON.stringify(payload));
  return p;
}
const read = (p) => JSON.parse(readFileSync(p, "utf8"));

test("the head is read from the project root", () => {
  const seen = [];
  const readHead = (root) => { seen.push(root); return `${HEAD}\n`; };
  assert.equal(gitHead("/project", { readHead }), HEAD);
  assert.deepEqual(seen, ["/project"]);
});

test("the default reader is romdev's own git reader, not a git process", () => withDir((d) => {
  const oid = writeSyntheticRepo(d);
  assert.equal(gitHead(d), oid);
  assert.equal(gitHead(path.join(d, "sub")), oid, "found from a subdirectory, as git rev-parse does");
}));

test("a tree that is not a checkout is unknown, not an error", () => withDir((d) => {
  assert.equal(gitHead(".", { readHead: () => null }), null);
  assert.equal(gitHead(".", { readHead: () => { throw new Error("unreadable"); } }), null);
  assert.equal(gitHead("/nonexistent-project-dir"), null);
  assert.equal(gitHead(d), null);
}));

/** A one-commit repository written by the test's own git writer; returns HEAD. */
function writeSyntheticRepo(d) {
  const repo = new GitWriter(d);
  repo.file("sub/a.c", "int a;\n");
  return repo.commit("one");
}

test("a stamped ranking still reads as a ranking", () => withDir((d) => {
  const p = writeRanking(d, ROWS);
  stampRanking(p, HEAD, { now: moment });
  const doc = read(p);
  assert.deepEqual(doc.functions[0], ROWS[0]);
  assert.equal(doc.stamp.tree_hash, HEAD);
  assert.equal(doc.stamp.generated_at, "2026-08-28T12:00:00Z");
  assert.equal(doc.stamp.schema, RANKING_STAMP_SCHEMA);
}));

test("a bare list is wrapped because a list cannot hold a key", () => withDir((d) => {
  const p = writeRanking(d, ROWS);
  stampRanking(p, HEAD, { now: moment });
  assert.deepEqual(read(p).functions, ROWS);
}));

test("a failed write leaves the ranking it had", () => withDir((d) => {
  const p = writeRanking(d, { functions: ROWS, producer: "objdiff" });
  const before = readFileSync(p, "utf8");
  assert.throws(() => stampRanking(p, HEAD, { now: moment, rename: () => { throw new Error("full"); } }), /full/);
  assert.equal(readFileSync(p, "utf8"), before);
  assert.deepEqual(readdirSync(d), ["ranking.json"]);
}));

test("the object spelling keeps its other keys", () => withDir((d) => {
  const p = writeRanking(d, { functions: ROWS, producer: "objdiff" });
  stampRanking(p, HEAD, { now: moment });
  const doc = read(p);
  assert.equal(doc.producer, "objdiff");
  assert.equal(doc.functions.length, 2);
  assert.deepEqual(Object.keys(doc), ["functions", "producer", "stamp"]);
}));

test("re-stamping the same tree keeps the original timestamp", () => withDir((d) => {
  const p = writeRanking(d, ROWS);
  const first = stampRanking(p, HEAD, { now: moment });
  const again = stampRanking(p, HEAD, { now: later });
  assert.equal(first.changed, true);
  assert.equal(again.changed, false);
  assert.equal(again.stamp.generated_at, "2026-08-28T12:00:00Z");
}));

test("a new tree replaces the stamp", () => withDir((d) => {
  const p = writeRanking(d, ROWS);
  stampRanking(p, HEAD, { now: moment });
  const second = stampRanking(p, OTHER, { now: later });
  assert.equal(second.changed, true);
  assert.equal(second.stamp.tree_hash, OTHER);
  assert.equal(second.stamp.generated_at, "2026-09-01T00:00:00Z");
}));

test("an empty hash is refused; a ranking that is neither list nor object is refused", () => withDir((d) => {
  const p = writeRanking(d, ROWS);
  assert.throws(() => stampRanking(p, "  "), { name: "ValueError" });
  const q = writeRanking(d, 12);
  assert.throws(() => stampRanking(q, HEAD), { name: "ValueError" });
}));

test("a malformed stamp reads as no stamp", () => withDir((d) => {
  const p = writeRanking(d, { functions: ROWS, stamp: { tree_hash: "" } });
  assert.equal(readStamp(p), null);
  assert.equal(readStamp(path.join(d, "absent.json")), null);
}));

test("the four states a consumer has to tell apart", () => withDir((d) => {
  const stamped = writeRanking(d, ROWS);
  stampRanking(stamped, HEAD, { now: moment });
  const bare = path.join(d, "bare.json");
  writeFileSync(bare, JSON.stringify(ROWS));
  const fresh = checkRankingFresh(stamped, HEAD);
  const stale = checkRankingFresh(stamped, OTHER);
  const unknown = checkRankingFresh(stamped, null);
  const unstamped = checkRankingFresh(bare, HEAD);
  const missing = checkRankingFresh(path.join(d, "absent.json"), HEAD);
  assert.equal(fresh.status, "fresh");
  assert.equal(fresh.fresh, true);
  assert.equal(stale.status, "stale");
  assert.equal(unknown.status, "unknown");
  assert.equal(unstamped.status, "unstamped");
  assert.equal(missing.status, "missing");
  assert.ok(![stale, unknown, unstamped].some((x) => x.fresh));
}));

test("a stale ranking names both trees", () => withDir((d) => {
  const p = writeRanking(d, ROWS);
  stampRanking(p, HEAD, { now: moment });
  const stale = checkRankingFresh(p, OTHER);
  assert.ok(stale.message.includes(HEAD.slice(0, 12)));
  assert.ok(stale.message.includes(OTHER.slice(0, 12)));
  assert.ok(String(freshnessWarning(stale)).includes("WARNING:"));
  assert.ok(renderFreshness(stale).join("\n").includes("warning"));
  assert.equal(stale.asDict().status, "stale");
}));

test("only a contradiction is loud", () => withDir((d) => {
  const bare = writeRanking(d, ROWS);
  const unstamped = checkRankingFresh(bare, HEAD);
  stampRanking(bare, HEAD, { now: moment });
  const fresh = checkRankingFresh(bare, HEAD);
  assert.equal(freshnessWarning(unstamped), null);
  assert.ok(String(freshnessNote(unstamped)).includes("note:"));
  assert.equal(freshnessWarning(fresh), null);
  assert.equal(freshnessNote(fresh), null);
}));

test("stamp then check is fresh and a moved tree is not", () => withDirAsync(async (d) => {
  const p = writeRanking(d, ROWS);
  const stamped = await runCommand(["ranking", "stamp", p, "--tree-hash", HEAD]);
  const again = await runCommand(["ranking", "stamp", p, "--tree-hash", HEAD]);
  const fresh = await runCommand(["ranking", "check", p, "--tree-hash", HEAD]);
  const stale = await runCommand(["ranking", "check", p, "--tree-hash", OTHER]);
  assert.deepEqual([stamped.code, again.code, fresh.code, stale.code], [0, 0, 0, 1]);
  assert.ok(stamped.stdout.includes(HEAD));
  assert.ok(again.stdout.includes("already stamped"));
  assert.ok(stale.stdout.includes("stale"));
}));

test("check reports JSON with its schema", () => withDirAsync(async (d) => {
  const p = writeRanking(d, ROWS);
  await runCommand(["ranking", "stamp", p, "--tree-hash", HEAD]);
  const r = await runCommand(["ranking", "check", p, "--tree-hash", OTHER, "--json"]);
  const payload = JSON.parse(r.stdout);
  assert.equal(r.code, 1);
  assert.equal(payload.schema, RANKING_STAMP_SCHEMA);
  assert.equal(payload.tree_hash, HEAD);
  assert.equal(payload.current_hash, OTHER);
  assert.equal(payload.fresh, false);
}));

test("an unreadable head asks for an explicit hash", () => withDirAsync(async (d) => {
  const p = writeRanking(d, ROWS);
  const r = await runCommand(["ranking", "stamp", p, "--project", "/nonexistent-project"]);
  assert.equal(r.code, 2);
  assert.ok(r.stderr.includes("--tree-hash"));
}));

test("a ranking that is not JSON is a usage error", () => withDirAsync(async (d) => {
  const p = path.join(d, "ranking.json");
  writeFileSync(p, "not json");
  const r = await runCommand(["ranking", "stamp", p, "--tree-hash", HEAD]);
  assert.equal(r.code, 2);
  assert.ok(r.stderr.startsWith("error: "));
  const j = await runCommand(["ranking", "stamp", p, "--tree-hash", HEAD, "--json"]);
  assert.equal(JSON.parse(j.stdout).schema, "decomp-workbench-error-v1");
}));

test("a relative ranking path resolves in the command's working directory", () => withDirAsync(async (d) => {
  writeRanking(d, ROWS);
  const r = await runCommand(["ranking", "check", "ranking.json", "--tree-hash", HEAD, "--json"], { cwd: d });
  const payload = JSON.parse(r.stdout);
  assert.equal(payload.status, "unstamped");
  assert.equal(payload.path, "ranking.json");
  assert.ok(existsSync(path.join(d, "ranking.json")));
}));
