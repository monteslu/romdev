// streams-cli.js - record-level windows, diffs, and surgery on IDO phase
// streams: ucode-window / binasm-window, stream-diff, ucode-patch.
//
// Plain JS ESM + JSDoc.

import { mkdirSync, writeFileSync, realpathSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { FORMATS, countFreshSlots, diffStreams, patchStream, streamWindow } from "./streams.js";
import { dumps } from "./pyjson.js";
import { isInputError, osErrorText } from "./py.js";

const expandUser = (p) => (p === "~" || p.startsWith("~/") ? os.homedir() + p.slice(1) : p);
const errText = (e) => (e?.code && typeof e.code === "string" ? osErrorText(e) : e.message);
/** Path.resolve(): absolute, symlinks followed where the path exists. */
export function resolvePath(p) {
  const abs = path.resolve(p);
  try { return realpathSync(abs); } catch {
    const parent = path.dirname(abs);
    if (parent === abs) return abs;
    return path.join(resolvePath(parent), path.basename(abs));
  }
}

function renderRecord(record, width) {
  if (!record) return " ".repeat(width);
  const text = `#${String(record.index).padEnd(5)} ${record.offset_hex.padStart(7)} ${record.name}`;
  return text.slice(0, width).padEnd(width);
}

function printWindow(report, io) {
  const s = report.stream;
  io.print(`${report.format}: ${s.record_count} record(s), ${s.bytes} bytes, sha256=${s.sha256.slice(0, 12)}`);
  io.print(`position: ${report.position.offset_hex} = record #${report.position.record_index}`);
  for (const r of report.records) {
    io.print(`${r.at_position ? ">" : " "} #${String(r.index).padEnd(5)} ${r.offset_hex.padStart(8)} ${r.name.padEnd(16)} ${r.raw_hex}`);
    io.print(`      ${r.detail}`);
  }
}

export function streamWindowCommand(args, io) {
  let report;
  try { report = streamWindow(args.stream, { at: args.at, radius: args.radius, stream_format: args.format }); } catch (e) {
    if (!isInputError(e)) throw e;
    io.eprint(`error: ${errText(e)}`);
    return 2;
  }
  if (args.json) { io.print(dumps(report)); return 0; }
  printWindow(report, io);
  io.print(`proof: ${report.proof}`);
  return 0;
}

export function streamDiffCommand(args, io) {
  let report;
  try { report = diffStreams(args.left, args.right, { stream_format: args.format, limit: args.limit, context: args.context }); } catch (e) {
    if (!isInputError(e)) throw e;
    io.eprint(`error: ${errText(e)}`);
    return 2;
  }
  if (args.json) { io.print(dumps(report)); return 0; }
  const c = report.record_counts;
  io.print(`${report.format}: ${c.left} vs ${c.right} record(s); ${report.identical ? "IDENTICAL" : "DIFFERENT"}; similarity=${report.similarity.toFixed(4)}`);
  io.print("records: " + Object.entries(report.opcode_counts).sort(([a], [b]) => (a < b ? -1 : 1)).map(([t, n]) => `${t}=${n}`).join(", "));
  const d = report.first_divergence;
  if (d === null) io.print("first divergence: none");
  else io.print(`first divergence: ${d.tag} at left #${d.left_index === null ? "None" : d.left_index} ${d.left_offset_hex ?? "None"} / right #${d.right_index === null ? "None" : d.right_index} ${d.right_offset_hex ?? "None"}`);
  const width = 46;
  const marks = { equal: " ", replace: "~", insert: "+", delete: "-" };
  for (const row of report.rows) {
    io.print(`${marks[row.tag]} ${renderRecord(row.left, width)} | ${renderRecord(row.right, width)}`);
    if (row.tag !== "equal") for (const side of ["left", "right"]) if (row[side] !== null) io.print(`    ${side.padEnd(5)} ${row[side].raw_hex}`);
  }
  if (report.rows_truncated) io.print(`(rows truncated at --limit ${args.limit})`);
  io.print(`proof: ${report.proof}`);
  return 0;
}

export function ucodePatchCommand(args, io) {
  const output = args.output ? expandUser(args.output) : null;
  if (output !== null && resolvePath(output) === resolvePath(expandUser(args.stream))) {
    io.eprint("error: refusing to patch a retained stream in place; give a new -o");
    return 2;
  }
  let freshCount = 0;
  if (args.fresh_label) freshCount = Math.max(args.fresh_label, countFreshSlots(args.records || ""));
  let data, report;
  try {
    [data, report] = patchStream(args.stream, { stream_format: args.format, insert_at: args.insert_at, replace: args.replace, delete: args.delete,
      records_spec: args.records, fresh_label_count: freshCount, allow_undecodable: args.allow_undecodable });
  } catch (e) {
    if (!isInputError(e)) throw e;
    io.eprint(`error: ${errText(e)}`);
    return 2;
  }
  if (output !== null) {
    mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
    writeFileSync(output, data);
    report.output = resolvePath(output);
  }
  if (args.json) { io.print(dumps(report)); return 0; }
  const p = report.position, r = report.result;
  io.print(`${report.format} ${report.operation}: at record #${p.record_index} (${p.offset_hex}), removed ${p.removed_records} record(s), inserted ${report.inserted.bytes} byte(s)`);
  if (report.fresh_labels.length) io.print(`fresh labels: ${report.fresh_labels.join(", ")} (highest existing label ${report.max_existing_label === null ? "None" : report.max_existing_label})`);
  for (const rec of report.inserted.records) io.print(`  + ${rec.name.padEnd(10)} ${rec.raw_hex}  ${rec.detail}`);
  const delta = r.record_delta === null ? "None" : (r.record_delta >= 0 ? "+" : "") + r.record_delta;
  const b = (v) => (v ? "True" : "False");
  io.print(`result: ${r.bytes} bytes, ${r.record_count === null ? "None" : r.record_count} record(s) (${delta}), sha256=${r.sha256.slice(0, 12)}, decodes=${b(r.decodes)} framing_preserved=${b(r.framing_preserved)}`);
  if (r.framing_error) io.print(`framing: ${r.framing_error}`);
  if (report.output) io.print(`wrote: ${report.output}`);
  else io.print("no -o given; nothing was written");
  io.print(`proof: ${report.proof}`);
  return 0;
}

const formatOption = { flags: ["--format"], choices: [...FORMATS], help: "decode as this stream format instead of detecting it" };

export const COMMAND_SPECS = [
  ...[["ucode-window", "Ucode"], ["binasm-window", "Binasm"]].map(([name, subject]) => ({
    path: [name], handler: streamWindowCommand,
    help: `print the decoded ${subject} records around one position`,
    description: "Decode the records around a byte offset or a record index in a retained phase stream. The format is detected from record framing unless --format says otherwise, so both spellings of this command read either stream.",
    arguments: [
      { dest: "stream", help: "retained phase stream" },
      { flags: ["--at"], required: true, help: "byte offset (decimal or 0x) or #record-index" },
      { flags: ["--radius"], type: "int", default: 6, help: "records shown on each side of the position (default: 6)" },
      formatOption,
      { flags: ["--json"], action: "store_true", help: "emit JSON" },
    ],
  })),
  {
    path: ["stream-diff"], handler: streamDiffCommand,
    help: "compare two phase streams record by record",
    description: "Align two retained Ucode or Binasm streams by decoded record and report the first divergence plus a side-by-side edit script. The alignment is shift-tolerant, so one inserted record does not render every later record as changed.",
    arguments: [
      { dest: "left", help: "first retained phase stream" },
      { dest: "right", help: "second retained phase stream" },
      formatOption,
      { flags: ["--limit"], type: "int", default: 40, help: "maximum rows printed (default: 40)" },
      { flags: ["--context"], type: "int", default: 2, help: "equal records shown around each change (default: 2)" },
      { flags: ["--json"], action: "store_true", help: "emit JSON" },
    ],
  },
  {
    path: ["ucode-patch"], handler: ucodePatchCommand,
    help: "insert, replace, or delete whole records in a phase stream",
    description: "Record-level surgery on a retained Ucode (or Binasm) stream. The patched stream is decoded before it is written *and* checked against the original's record framing, so a spec that breaks framing -- or that silently changes how the bytes around it are read, which a fixed-width format lets a decode-back check miss -- is refused instead of being replayed as damage. --fresh-label allocates label numbers above every label the stream already uses, which is what makes an inserted branch/label barrier safe.",
    arguments: [
      { dest: "stream", help: "retained phase stream to read" },
      { flags: ["--insert-at"], help: "insert --records before this byte offset or #record-index" },
      { flags: ["--replace"], metavar: "N[:M]", help: "replace records N..M (half-open, default one record) with --records" },
      { flags: ["--delete"], metavar: "N[:M]", help: "delete records N..M (half-open, default one record)" },
      { flags: ["--records"], help: "a hex-word spec or a path to one: words separated by whitespace or commas, records by | or a blank line, # comments, and {fresh}/{fresh+N} for allocated labels" },
      { flags: ["--fresh-label"], nargs: "?", type: "int", const: 1, default: 0, metavar: "COUNT", help: "allocate COUNT (default 1) label numbers above the stream's highest" },
      { flags: ["--allow-undecodable"], action: "store_true", help: "write the patched stream even if it no longer decodes" },
      { flags: ["-o", "--output"], help: "write the patched stream here" },
      formatOption,
      { flags: ["--json"], action: "store_true", help: "emit JSON" },
    ],
  },
];
