// notes-cli.js - `note add`, `note reserve`, `note list`, `note merge`: add
// to and read a shared findings log safely. `note add` reports where the note
// went, and `note list` shows the pending count next to the log's entries, so
// a staged note is visible rather than merely safe.
//
// Plain JS ESM + JSDoc.

import fs from "node:fs";
import path from "node:path";
import { dumps } from "./pyjson.js";
import { splitlines } from "./py.js";
import { osText, isOSError } from "./py-path.js";
import { MergedNotes, NoteError, addNote, mergeNotes, mergedView, notesDirectory, reserveIdentifiers } from "./notes.js";

const readStdin = () => { try { return fs.readFileSync(0, "utf8"); } catch { return ""; } };

function readBody(args) {
  if (args.body_file) {
    if (args.body_file === "-") return readStdin();
    try { return fs.readFileSync(args.body_file, "utf8"); } catch (e) { throw new NoteError(`could not read --body-file: ${osText(e)}`); }
  }
  if (args.body === "-") return readStdin();
  return args.body || "";
}

const reportable = (e) => e instanceof NoteError || isOSError(e);
const errText = (e) => (e instanceof NoteError ? e.message : osText(e));

/** Build and write the note described by parsed `note add` arguments. */
export function addNoteFromArgs(args) {
  return addNote(args.log, { identifier: args.id, title: args.title || "", status: args.status, body: readBody(args), author: args.author, force: !!args.force });
}

export function noteAddCommand(args, io) {
  let note;
  try { note = addNoteFromArgs(args); } catch (e) { if (!reportable(e)) throw e; io.eprint(`error: ${errText(e)}`); return 2; }
  if (args.json) { io.print(dumps({ schema: "decomp-workbench-note-add-v1", ...note.asDict() })); return 0; }
  io.print(`note: ${note.identifier} recorded (${note.status})`);
  io.print(`file: ${note.path}`);
  io.print(`safe: the note is its own file; a whole-file rewrite of ${args.log} cannot remove it`);
  io.print(`next: decomp-workbench note list --log ${args.log}`);
  return 0;
}

export function noteReserveCommand(args, io) {
  let claimed;
  try {
    claimed = reserveIdentifiers(args.log, { prefix: args.prefix, count: args.count, author: args.author, purpose: args.purpose, start: args.start, also: args.also_log });
  } catch (e) { if (!reportable(e)) throw e; io.eprint(`error: ${errText(e)}`); return 2; }
  if (args.json) { io.print(dumps({ schema: "decomp-workbench-note-reserve-v1", log: String(args.log), reserved: claimed.map((c) => c.asDict()) })); return 0; }
  io.print(`reserved: ${claimed.map((c) => c.identifier).join(", ")}`);
  for (const c of claimed) io.print(`file: ${c.path}`);
  io.print("safe: each identifier's file was created exclusively; a concurrent reserver cannot have taken the same one");
  io.print(`next: decomp-workbench note add --log ${args.log} --id ${claimed[0].identifier} --title "..."`);
  return 0;
}

/** The merged view: the log's entries, then what is still pending. */
export function renderNoteList(view, { verbose }) {
  const lines = [`log: ${view.log}`, `entries: ${view.entries.length} in the log, ${view.pending.length} pending, ${view.merged.length} merged`];
  for (const d of view.duplicate_ids) lines.push(`warning: ${d} is pending and already in the log; merging will record it twice`);
  if (view.entries.length) {
    lines.push("", "in the log:");
    const width = Math.max(...view.entries.map((e) => e.identifier.length));
    for (const e of view.entries) {
      const title = verbose ? e.title : [...e.title].slice(0, 56).join("");
      lines.push(`  ${e.identifier.padEnd(width)}  [${e.status || "-"}]  ${title}`.trimEnd());
    }
  }
  const outstanding = view.unfiled_reservations;
  if (outstanding.length) {
    lines.push("", "reserved (claimed, nothing filed under it yet):");
    const width = Math.max(...outstanding.map((r) => r.identifier.length));
    for (const r of outstanding) {
      lines.push(`  ${r.identifier.padEnd(width)}  ${r.recorded}${r.author ? ` by ${r.author}` : ""}${r.purpose ? `  ${r.purpose}` : ""}`);
    }
  }
  if (view.pending.length) {
    lines.push("", "pending (in the sidecar, not yet in the log):");
    const width = Math.max(...view.pending.map((n) => n.identifier.length));
    for (const n of view.pending) {
      lines.push(`  ${n.identifier.padEnd(width)}  [${n.status}]  ${n.title}`.trimEnd());
      lines.push(`  ${" ".repeat(width)}  ${n.recorded}${n.author ? ` by ${n.author}` : ""}`);
      if (verbose && n.body.trim()) for (const l of splitlines(n.body.trim())) lines.push(`  ${" ".repeat(width)}  ${l}`);
    }
    lines.push("", `next: decomp-workbench note merge --log ${view.log}`);
  } else if (!view.entries.length) {
    lines.push("", `notes directory: ${notesDirectory(view.log)}`);
    lines.push(`next: decomp-workbench note add --log ${view.log} --id WB-NN --title "..."`);
  }
  return lines;
}

export function noteListCommand(args, io) {
  let view;
  try { view = mergedView(args.log); } catch (e) { if (!reportable(e)) throw e; io.eprint(`error: ${errText(e)}`); return 2; }
  if (args.id) {
    const keep = (x) => x.identifier === args.id;
    view = new MergedNotes({ log: view.log, entries: view.entries.filter(keep), pending: view.pending.filter(keep), merged: view.merged.filter(keep) });
  }
  if (args.json) io.print(dumps(view.asDict()));
  else io.print(renderNoteList(view, { verbose: args.verbose }).join("\n"));
  return 0;
}

export function noteMergeCommand(args, io) {
  let pending;
  try { pending = mergeNotes(args.log, { dry_run: args.dry_run }); } catch (e) { if (!reportable(e)) throw e; io.eprint(`error: ${errText(e)}`); return 2; }
  if (args.json) {
    io.print(dumps({ schema: "decomp-workbench-note-merge-v1", log: String(args.log), dry_run: args.dry_run, merged: pending.map((n) => n.asDict()) }));
    return 0;
  }
  if (!pending.length) { io.print(`merge: nothing pending for ${args.log}`); return 0; }
  io.print(`merge: ${args.dry_run ? "would append" : "appended"} ${pending.length} note(s) to ${args.log}`);
  for (const n of pending) io.print(`  ${n.identifier}  [${n.status}]  ${n.title}`.trimEnd());
  if (!args.dry_run) io.print(`kept: the merged note files remain under ${path.join(notesDirectory(args.log), "merged")}`);
  return 0;
}

const LOG = { flags: ["--log"], required: true, metavar: "FILE", help: "the shared findings log. It is read, never rewritten; notes are stored beside it in FILE.notes.d/" };
const JSON_FLAG = { flags: ["--json"], action: "store_true", help: "emit JSON" };

export const COMMAND_SPECS = [
  { path: ["note-add"], handler: noteAddCommand,
    description: "Record one note for a shared findings log without opening the log for writing. The note is written to its own file under FILE.notes.d/, so a concurrent writer that rewrites the whole log cannot destroy it. Use `note merge` to fold pending notes into the log itself.",
    arguments: [LOG,
      { flags: ["--id"], required: true, metavar: "WB-NN", help: "note identifier" },
      { flags: ["--title"], help: "one-line summary" },
      { flags: ["--status"], default: "LOGGED", help: "status token (default: LOGGED)" },
      { flags: ["--body"], default: "", help: "note body; pass - to read the body from standard input" },
      { flags: ["--body-file"], metavar: "FILE", help: "read the body from FILE, or - for stdin" },
      { flags: ["--author"], help: "who recorded it" },
      { flags: ["--force"], action: "store_true", help: "file under an identifier somebody else reserved" },
      JSON_FLAG] },
  { path: ["note-reserve"], handler: noteReserveCommand,
    description: "Claim the next unused identifiers before writing anything under them. Three findings collided on one number in a single night of one campaign, each filed by an agent that had read the log first -- because reading is not claiming. The claim here is the file: each identifier gets its own file created with O_EXCL, so two agents reserving in the same instant cannot both take WB-122. The loser takes WB-123 and neither has to be told.",
    epilog: "example: decomp-workbench note reserve --log FINDINGS.md --prefix WB --count 3 --author W4",
    arguments: [LOG,
      { flags: ["--prefix"], default: "WB", metavar: "WB", help: "the part before the number (default: WB)" },
      { flags: ["--count"], type: "int", default: 1, metavar: "N", help: "how many to claim" },
      { flags: ["--author"], help: "who is claiming them" },
      { flags: ["--also-log"], action: "append", default: [], metavar: "FILE", help: "another document that mints identifiers in this series -- a backlog, a handoff -- read for mentions so a number published there is not handed out again; repeatable" },
      { flags: ["--purpose"], default: "", help: "one line about what they are for" },
      { flags: ["--start"], type: "int", metavar: "N", help: "begin counting here instead of after the highest number in use" },
      JSON_FLAG] },
  { path: ["note-list"], handler: noteListCommand,
    description: "Render the merged view of a findings log: the entries the log itself carries, followed by the sidecar notes not yet folded in.",
    arguments: [LOG,
      { flags: ["--id"], metavar: "WB-NN", help: "show only this identifier" },
      { flags: ["--verbose"], action: "store_true", help: "show full titles and pending bodies" },
      JSON_FLAG] },
  { path: ["note-merge"], handler: noteMergeCommand,
    description: "Append every pending sidecar note to the log under an exclusive lock, then move the merged note files aside. This is the only command that writes the log, and it appends rather than rewriting it.",
    arguments: [LOG, { flags: ["--dry-run"], action: "store_true", help: "report what would be appended" }, JSON_FLAG] },
];
