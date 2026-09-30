// The append-safe findings log. Ported from the workbench's notes tests; the
// concurrency cases run real concurrent processes (the command runner forks
// one per command), which is the situation the sidecar exists for.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NoteError, addNote, mergeNotes, mergedView, notesDirectory, parseLogEntries, readNotes, readReservations,
  reservationsDirectory, reserveIdentifiers, takenIdentifiers } from "../src/decomp/workbench/notes.js";
import { runCommand, runCommandIsolated } from "../src/decomp/workbench/cli.js";

const D = "\u2014";
const LOG = `# Findings\n\n## WB-01 ${D} the first finding\n**Status:** LOGGED.\n\n## WB-02 ${D} the second finding\nSome prose about the finding.\n**Status:** SHIPPED.\n\n# Recovery notice\n\nProse that is not an entry.\n`;

function setup() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "romdev-wb-notes-")));
  const log = path.join(dir, "IMPROVEMENTS.md");
  fs.writeFileSync(log, LOG);
  return { dir, log, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
const withLog = (fn) => async () => { const s = setup(); try { await fn(s); } finally { s.done(); } };

// durability

test("a whole-file rewrite cannot lose a note", withLog(({ log }) => {
  addNote(log, { identifier: "WB-54", title: "survives", body: "evidence" });
  fs.writeFileSync(log, LOG);
  const pending = readNotes(log);
  assert.deepEqual(pending.map((n) => n.identifier), ["WB-54"]);
  assert.equal(pending[0].body, "evidence");
}));

test("the log is never opened for writing by add", withLog(({ log }) => {
  const before = fs.readFileSync(log, "utf8");
  addNote(log, { identifier: "WB-54", title: "untouched" });
  assert.equal(fs.readFileSync(log, "utf8"), before);
}));

test("concurrent writers all survive", withLog(async ({ dir, log }) => {
  const ids = Array.from({ length: 16 }, (_, i) => `WB-${60 + i}`);
  const results = await Promise.all(ids.map((id) => runCommandIsolated(["note-add", "--log", log, "--id", id, "--title", `note ${id}`], { cwd: dir })));
  assert.ok(results.every((r) => r.code === 0), JSON.stringify(results.filter((r) => r.code)));
  assert.deepEqual(new Set(readNotes(log).map((n) => n.identifier)), new Set(ids));
}));

test("same identifier twice in one second keeps both", withLog(({ log }) => {
  addNote(log, { identifier: "WB-54", title: "first" });
  addNote(log, { identifier: "WB-54", title: "second" });
  assert.deepEqual(readNotes(log).map((n) => n.title).sort(), ["first", "second"]);
}));

test("add rejects an empty identifier", withLog(({ log }) => {
  assert.throws(() => addNote(log, { identifier: "   " }), NoteError);
}));

// log parsing

test("entries and statuses are read from the document", () => {
  assert.deepEqual(parseLogEntries(LOG).map((e) => [e.identifier, e.title, e.status]),
    [["WB-01", "the first finding", "LOGGED"], ["WB-02", "the second finding", "SHIPPED"]]);
});

test("prose headings are not mistaken for entries", () => {
  assert.deepEqual(parseLogEntries("## Recovery notice\n## Next steps\n"), []);
});

test("an absent log is an empty merged view, not an error", withLog(({ dir }) => {
  const view = mergedView(path.join(dir, "absent.md"));
  assert.deepEqual(view.entries, []);
  assert.deepEqual(view.pending, []);
}));

// merge

test("merge appends and keeps the original entries", withLog(({ log }) => {
  addNote(log, { identifier: "WB-54", title: "a new one", body: "the body" });
  assert.deepEqual(mergeNotes(log).map((n) => n.identifier), ["WB-54"]);
  const text = fs.readFileSync(log, "utf8");
  assert.ok(text.includes(`## WB-01 ${D} the first finding`));
  assert.ok(text.includes(`## WB-54 ${D} a new one`));
  assert.ok(text.includes("the body"));
  assert.deepEqual(readNotes(log), []);
}));

test("merged notes are archived, not deleted", withLog(({ log }) => {
  addNote(log, { identifier: "WB-54", title: "kept" });
  mergeNotes(log);
  assert.deepEqual(readNotes(log, { merged: true }).map((n) => n.identifier), ["WB-54"]);
  fs.writeFileSync(log, LOG);
  assert.equal(readNotes(log, { merged: true }).length, 1);
}));

test("dry run reports without writing", withLog(({ log }) => {
  addNote(log, { identifier: "WB-54", title: "staged" });
  const before = fs.readFileSync(log, "utf8");
  assert.deepEqual(mergeNotes(log, { dry_run: true }).map((n) => n.identifier), ["WB-54"]);
  assert.equal(fs.readFileSync(log, "utf8"), before);
  assert.equal(readNotes(log).length, 1);
}));

test("merge of nothing is a no-op", withLog(({ log }) => {
  const before = fs.readFileSync(log, "utf8");
  assert.deepEqual(mergeNotes(log), []);
  assert.equal(fs.readFileSync(log, "utf8"), before);
}));

test("concurrent merges append each note once", withLog(async ({ dir, log }) => {
  for (let n = 54; n < 62; n++) addNote(log, { identifier: `WB-${n}`, title: "once" });
  const results = await Promise.all(Array.from({ length: 8 }, () => runCommandIsolated(["note-merge", "--log", log, "--json"], { cwd: dir })));
  assert.ok(results.every((r) => r.code === 0));
  const text = fs.readFileSync(log, "utf8");
  for (let n = 54; n < 62; n++) assert.equal(text.split(`## WB-${n} ${D} once`).length - 1, 1);
  assert.equal(results.reduce((s, r) => s + JSON.parse(r.stdout).merged.length, 0), 8);
}));

test("a duplicate identifier is reported, not resolved", withLog(({ log }) => {
  addNote(log, { identifier: "WB-01", title: "a second WB-01" });
  assert.deepEqual(mergedView(log).duplicate_ids, ["WB-01"]);
}));

// commands

test("add reports the file it wrote", withLog(async ({ log }) => {
  const r = await runCommand(["note", "add", "--log", log, "--id", "WB-54", "--title", "x"]);
  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes("note: WB-54 recorded"));
  assert.ok(r.stdout.includes(path.basename(notesDirectory(log))));
}));

test("list shows log entries and pending notes", withLog(async ({ log }) => {
  await runCommand(["note", "add", "--log", log, "--id", "WB-54", "--title", "new"]);
  const r = await runCommand(["note", "list", "--log", log]);
  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes("2 in the log, 1 pending"));
  assert.ok(r.stdout.includes("WB-01") && r.stdout.includes("WB-54"));
}));

test("list JSON carries its schema", withLog(async ({ log }) => {
  const r = await runCommand(["note", "list", "--log", log, "--json"]);
  const payload = JSON.parse(r.stdout);
  assert.equal(r.code, 0);
  assert.equal(payload.schema, "decomp-workbench-note-list-v1");
  assert.equal(payload.entries.length, 2);
}));

test("body can be read from a file", withLog(async ({ dir, log }) => {
  const body = path.join(dir, "body.txt");
  fs.writeFileSync(body, "measured evidence\n");
  await runCommand(["note", "add", "--log", log, "--id", "WB-54", "--body-file", body]);
  assert.equal(readNotes(log)[0].body, "measured evidence\n");
}));

test("merge command folds pending notes in", withLog(async ({ log }) => {
  await runCommand(["note", "add", "--log", log, "--id", "WB-54", "--title", "new"]);
  const r = await runCommand(["note", "merge", "--log", log]);
  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes("appended 1 note(s)"));
  assert.ok(fs.readFileSync(log, "utf8").includes(`## WB-54 ${D} new`));
}));

test("a notes directory is named after its log", withLog(({ log }) => {
  assert.equal(path.basename(notesDirectory(log)), `${path.basename(log)}.notes.d`);
}));

test("unwritable notes directory is a clear error", { skip: process.getuid?.() === 0 }, withLog(({ log }) => {
  const d = notesDirectory(log);
  fs.mkdirSync(d);
  fs.chmodSync(d, 0o500);
  try { assert.throws(() => addNote(log, { identifier: "WB-54" }), NoteError); } finally { fs.chmodSync(d, 0o700); }
}));

// reservations

test("a reservation starts after the highest number in use", withLog(({ log }) => {
  assert.deepEqual(reserveIdentifiers(log, { prefix: "WB", count: 2, author: "W4" }).map((r) => r.identifier), ["WB-3", "WB-4"]);
}));

test("the scan counts the log, the pending and the merged", withLog(({ log }) => {
  addNote(log, { identifier: "WB-9", title: "pending" });
  assert.deepEqual(takenIdentifiers(log, { prefix: "WB" }), new Set([1, 2, 9]));
  assert.equal(reserveIdentifiers(log, { prefix: "WB", count: 1 })[0].identifier, "WB-10");
}));

test("a second reserver starting at the same number takes the next", withLog(({ log }) => {
  assert.equal(reserveIdentifiers(log, { prefix: "WB", count: 1, start: 20 })[0].identifier, "WB-20");
  assert.equal(reserveIdentifiers(log, { prefix: "WB", count: 1, start: 20 })[0].identifier, "WB-21");
}));

test("concurrent reservers never receive the same identifier", withLog(async ({ dir, log }) => {
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) => runCommandIsolated(["note-reserve", "--log", log, "--count", "2", "--author", `agent-${i}`, "--json"], { cwd: dir })));
  const claimed = results.flatMap((r) => JSON.parse(r.stdout).reserved.map((x) => x.id));
  assert.equal(claimed.length, 16);
  assert.equal(new Set(claimed).size, 16);
  assert.equal(readReservations(log).length, 16);
}));

test("filing under somebody else's reservation is refused", withLog(({ log }) => {
  reserveIdentifiers(log, { prefix: "WB", count: 1, author: "W4", purpose: "sweep defects" });
  assert.throws(() => addNote(log, { identifier: "WB-3", title: "mine", author: "W5" }), (e) => {
    assert.ok(e instanceof NoteError);
    assert.ok(e.message.includes("reserved by W4") && e.message.includes("sweep defects") && e.message.includes("note reserve --prefix WB"));
    return true;
  });
}));

test("filing under your own reservation is the normal path; force overrides", withLog(({ log }) => {
  reserveIdentifiers(log, { prefix: "WB", count: 1, author: "W4" });
  assert.equal(addNote(log, { identifier: "WB-3", title: "mine", author: "W4" }).identifier, "WB-3");
  assert.equal(addNote(log, { identifier: "WB-3", title: "deliberate", author: "W5", force: true }).identifier, "WB-3");
}));

test("an unreserved identifier is never refused", withLog(({ log }) => {
  assert.equal(addNote(log, { identifier: "WB-99", title: "ordinary" }).identifier, "WB-99");
}));

test("the listing shows only reservations nothing was filed under", withLog(({ log }) => {
  reserveIdentifiers(log, { prefix: "WB", count: 2, author: "W4" });
  addNote(log, { identifier: "WB-3", title: "filed", author: "W4" });
  assert.deepEqual(mergedView(log).unfiled_reservations.map((r) => r.identifier), ["WB-4"]);
}));

test("a second document that minted numbers is read too", withLog(({ dir, log }) => {
  const backlog = path.join(dir, "WB-BACKLOG.md");
  fs.writeFileSync(backlog, "| WB-113 | ring-phase profiler |\n| WB-121 | document the grammar |\n");
  assert.equal(reserveIdentifiers(log, { prefix: "WB", count: 1 })[0].identifier, "WB-3");
  assert.equal(reserveIdentifiers(log, { prefix: "WB", count: 1, also: [backlog] })[0].identifier, "WB-122");
}));

test("an unreadable additional document is an error, not a shrug", withLog(({ dir, log }) => {
  assert.throws(() => reserveIdentifiers(log, { prefix: "WB", also: [path.join(dir, "nowhere.md")] }), /additional identifier source/);
}));

test("a prefix that is not a prefix says what one looks like", withLog(({ log }) => {
  assert.throws(() => reserveIdentifiers(log, { prefix: "WB-1" }), /--prefix WB/);
}));

test("the reservation directory sits beside the notes", withLog(({ log }) => {
  reserveIdentifiers(log, { prefix: "WB", count: 1 });
  assert.equal(reservationsDirectory(log), path.join(notesDirectory(log), "reserved"));
}));

test("reserve prints every file it created", withLog(async ({ log }) => {
  const r = await runCommand(["note", "reserve", "--log", log, "--prefix", "WB", "--count", "2", "--author", "W4"]);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.stdout.includes("reserved: WB-3, WB-4"));
  assert.ok(r.stdout.includes("created exclusively"));
  assert.ok(r.stdout.includes("note add --log"));
}));

test("the JSON form lists the claims", withLog(async ({ log }) => {
  const r = await runCommand(["note", "reserve", "--log", log, "--json"]);
  const payload = JSON.parse(r.stdout);
  assert.equal(r.code, 0);
  assert.equal(payload.schema, "decomp-workbench-note-reserve-v1");
  assert.equal(payload.reserved[0].id, "WB-3");
}));

test("a colliding add exits two and names the owner", withLog(async ({ log }) => {
  await runCommand(["note", "reserve", "--log", log, "--author", "W4"]);
  const r = await runCommand(["note", "add", "--log", log, "--id", "WB-3", "--title", "mine", "--author", "W5"]);
  assert.equal(r.code, 2);
  assert.ok(r.stderr.includes("reserved by W4"));
}));

test("the listing names the outstanding claims", withLog(async ({ log }) => {
  await runCommand(["note", "reserve", "--log", log, "--author", "W4", "--purpose", "sweep defects"]);
  const r = await runCommand(["note", "list", "--log", log]);
  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes("reserved (claimed, nothing filed under it yet)"));
  assert.ok(r.stdout.includes("sweep defects"));
}));

test("the --log option is required", async () => {
  const r = await runCommand(["note", "list", "--json"]);
  assert.equal(r.code, 2);
  assert.match(JSON.parse(r.stdout).error.message, /required: --log/);
});
