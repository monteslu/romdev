// streams.js - record-level surgery, windows, and diffs for IDO's two phase
// streams: the binary Ucode uopt hands ugen and the fixed 16-byte Binasm ugen
// hands as1. One unified record view, fresh-label allocation, and
// record-framed insertion/replacement/deletion that refuses to write a stream
// the decoder cannot read back.
//
// Every edit here is a sufficiency experiment: proving an inserted record
// produces the target object establishes what the downstream pass does with
// that record, never that a C spelling survives earlier passes and emits it.
//
// Plain JS ESM + JSDoc.

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import os from "node:os";
import { ValueError, strRepr, hex, pyInt, pyRound, pyEq, sum } from "./py.js";
import { BINASM_RECORD_SIZE, parseBinasm, readStreamBytes } from "./binasm.js";
import { parseUcode } from "./ucode.js";
import { SequenceMatcher } from "./difflib.js";

export const STREAM_WINDOW_SCHEMA = "decomp-workbench-stream-window-v1";
export const STREAM_DIFF_SCHEMA = "decomp-workbench-stream-diff-v1";
export const STREAM_PATCH_SCHEMA = "decomp-workbench-stream-patch-v1";
export const FORMATS = Object.freeze(["ucode", "binasm"]);

/** Which operand words of a Ucode record name a label. */
export const UCODE_LABEL_OPERANDS = Object.freeze({ lab: [1], ldef: [1], ujp: [1], fjp: [1], tjp: [1], clab: [1], xjp: [1, 2] });

const FRESH_RE = /\{fresh(?:\+(\d+))?\}/g;
const COMMENT_RE = /#.*$/gm;

const expandUser = (p) => (p === "~" || p.startsWith("~/") ? os.homedir() + p.slice(1) : p);
const isBytes = (v) => v instanceof Uint8Array || v instanceof ArrayBuffer;

/** Whether a spec argument is a readable path rather than inline text. */
function namesAFile(value) {
  try { return statSync(expandUser(value)).isFile(); } catch { return false; }
}

/** One decoded record of either phase stream, in one shape. */
export class StreamRecord {
  constructor({ index, byte_offset, byte_length, name, detail, words }) {
    Object.assign(this, { index, byte_offset, byte_length, name, detail, words });
    Object.freeze(this);
  }
  get raw_hex() { return this.words.map((w) => hex(w, 8)).join(" "); }
  get end_offset() { return this.byte_offset + this.byte_length; }
  asDict() {
    return { index: this.index, byte_offset: this.byte_offset, offset_hex: `0x${hex(this.byte_offset)}`, byte_length: this.byte_length,
      name: this.name, detail: this.detail, words: this.words.map((w) => `0x${hex(w, 8)}`), raw_hex: this.raw_hex };
  }
}

/** Record kinds that say nothing about which format a stream is. */
const CONTENTLESS_KINDS = new Set(["unknown", "empty"]);

/** Name the stream format from record framing alone. */
export function detectFormat(data) {
  if (!data.length) throw new ValueError("stream is empty; nothing to decode");
  if (data.length % 4) throw new ValueError(`stream is ${data.length} bytes; both IDO phase streams are whole 32-bit words`);
  const binasmFramed = data.length % BINASM_RECORD_SIZE === 0;
  if (binasmFramed) {
    const records = parseBinasm(data);
    const recognized = sum(records.map((r) => !CONTENTLESS_KINDS.has(r.kind)));
    if (recognized * 4 >= records.length * 3) return "binasm";
  }
  try { parseUcode(data); } catch (e) {
    if (!(e instanceof ValueError)) throw e;
    if (binasmFramed) return "binasm";
    throw e;
  }
  return "ucode";
}

/** Read one stream and decode it into the unified record view: [format, data, records]. */
export function decodeStream(source, { stream_format = null } = {}) {
  const data = readStreamBytes(source);
  const resolved = stream_format || detectFormat(data);
  if (!FORMATS.includes(resolved)) throw new ValueError(`unsupported stream format: ${strRepr(resolved)}`);
  const records = resolved === "binasm"
    ? parseBinasm(data).map((r) => new StreamRecord({ index: r.index, byte_offset: r.offset, byte_length: BINASM_RECORD_SIZE, name: r.name, detail: r.detail, words: [...r.words] }))
    : parseUcode(data).map((r) => new StreamRecord({ index: r.index, byte_offset: r.byte_offset, byte_length: r.words.length * 4, name: `U${r.name}`, detail: r.detail, words: r.words }));
  return [resolved, data, records];
}

/** The highest label number any record in the stream names. */
export function maxLabel(records, { stream_format }) {
  if (stream_format !== "ucode") throw new ValueError("label allocation is defined for Ucode streams only");
  let highest = 0;
  for (const r of records) {
    const positions = UCODE_LABEL_OPERANDS[r.name.replace(/^U/, "")];
    if (!positions) continue;
    for (const p of positions) if (p < r.words.length) highest = Math.max(highest, r.words[p]);
  }
  return highest;
}

/** Allocate `count` label numbers above every label the stream uses. */
export function allocateFreshLabels(records, count, { stream_format = "ucode" } = {}) {
  if (count < 0) throw new ValueError("fresh label count must not be negative");
  const base = maxLabel(records, { stream_format });
  return Array.from({ length: count }, (_, i) => base + 1 + i);
}

/**
 * Assemble insertion bytes from a hex spec: [bytes, framing|null, slots].
 * Words separated by whitespace or commas, `#` comments, `|` or a blank line
 * between records, `{fresh}`/`{fresh+N}` replaced by allocated labels.
 */
export function parseRecordSpec(spec, { fresh_labels = [] } = {}) {
  if (isBytes(spec)) return [Buffer.from(spec), null, 0];
  let text;
  if (namesAFile(String(spec))) {
    const raw = readFileSync(expandUser(String(spec)));
    try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw); } catch { return [raw, null, 0]; }
  } else text = String(spec);
  let highestSlot = -1;
  text = text.replace(COMMENT_RE, "");
  text = text.replace(FRESH_RE, (_m, g) => {
    const slot = Number(g ?? 0);
    highestSlot = Math.max(highestSlot, slot);
    if (slot >= fresh_labels.length) {
      throw new ValueError(`record spec uses {fresh+${slot}} but only ${fresh_labels.length} fresh label(s) were allocated; pass --fresh-label (repeat it for more)`);
    }
    return String(fresh_labels[slot]);
  });
  const groups = text.split(/\||\n\s*\n/).filter((g) => g.trim());
  const blob = [];
  const lengths = [];
  for (const group of groups) {
    const start = blob.length;
    for (const token of group.trim().split(/[\s,]+/)) {
      if (!token) continue;
      let value;
      try { value = pyInt(token, 0); } catch { throw new ValueError(`record spec token is not an integer: ${strRepr(token)}`); }
      if (!(value >= 0 && value <= 0xFFFFFFFF)) throw new ValueError(`record spec word out of range: ${strRepr(token)}`);
      blob.push((value >>> 24) & 0xFF, (value >>> 16) & 0xFF, (value >>> 8) & 0xFF, value & 0xFF);
    }
    lengths.push(blob.length - start);
  }
  if (!blob.length) throw new ValueError("record spec assembled to zero words");
  return [Buffer.from(blob), lengths.length > 1 ? lengths : null, highestSlot + 1];
}

/** How many distinct {fresh...} slots a spec names. */
export function countFreshSlots(spec) {
  if (isBytes(spec)) return 0;
  let text;
  if (namesAFile(String(spec))) {
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(expandUser(String(spec)))); } catch { return 0; }
  } else text = String(spec);
  const slots = [...text.replace(COMMENT_RE, "").matchAll(FRESH_RE)].map((m) => Number(m[1] ?? 0));
  return slots.length ? Math.max(...slots) + 1 : 0;
}

/** Record names that continue the record before them. */
export const CONTINUATION_NAMES = Object.freeze(new Set(["ascii-payload"]));

function groupStart(records, index) {
  let start = index;
  while (start > 0 && CONTINUATION_NAMES.has(records[start].name)) start -= 1;
  return start;
}

function refuseInsideAGroup(records, index, offset) {
  if (index >= records.length || !CONTINUATION_NAMES.has(records[index].name)) return;
  const owner = records[groupStart(records, index)];
  let end = index;
  while (end < records.length && CONTINUATION_NAMES.has(records[end].name)) end += 1;
  const tail = end < records.length ? `0x${hex(records[end].byte_offset)} (#${end})` : "the end of the stream";
  throw new ValueError(`offset 0x${hex(offset)} (#${index}) is inside the ${owner.name} record group that starts at 0x${hex(owner.byte_offset)} (#${owner.index}); `
    + "its payload records are that record's own bytes, not records an edit may "
    + `be placed between. Use 0x${hex(owner.byte_offset)} (#${owner.index}) or ${tail}`);
}

/** Resolve `#index` or a byte offset to [record index, byte offset]. */
export function resolvePosition(records, position, { data_length }) {
  if (typeof position === "string" && position.startsWith("#")) {
    let index;
    try { index = pyInt(position.slice(1), 0); } catch { throw new ValueError(`malformed record index: ${strRepr(position)}`); }
    if (index < 0) index += records.length;
    if (!(index >= 0 && index <= records.length)) throw new ValueError(`record index ${index} is outside 0..${records.length}`);
    const offset = index < records.length ? records[index].byte_offset : data_length;
    refuseInsideAGroup(records, index, offset);
    return [index, offset];
  }
  let offset;
  try { offset = typeof position === "string" ? pyInt(position, 0) : Math.trunc(position); } catch {
    throw new ValueError(`expected a byte offset or #record-index, got ${strRepr(position)}`);
  }
  if (offset < 0 || offset > data_length) throw new ValueError(`offset 0x${hex(offset)} is outside stream range 0x0..0x${hex(data_length)}`);
  if (offset === data_length) return [records.length, offset];
  for (const r of records) {
    if (r.byte_offset === offset) { refuseInsideAGroup(records, r.index, offset); return [r.index, offset]; }
  }
  throw new ValueError(`offset 0x${hex(offset)} is not a record boundary; the nearest boundaries are ${nearestBoundaries(records, offset)}`);
}

function nearestBoundaries(records, offset) {
  const before = records.filter((r) => r.byte_offset < offset);
  const after = records.filter((r) => r.byte_offset > offset);
  const parts = [];
  if (before.length) { const b = before[before.length - 1]; parts.push(`0x${hex(b.byte_offset)} (#${b.index})`); }
  if (after.length) parts.push(`0x${hex(after[0].byte_offset)} (#${after[0].index})`);
  return parts.join(" and ") || "none";
}

function streamIdentity(source, data, records) {
  const identity = { bytes: data.length, record_count: records.length, sha256: createHash("sha256").update(data).digest("hex"), byteorder: "big" };
  if (!isBytes(source)) identity.path = String(source);
  return identity;
}

/** Decode the records around one position in either phase stream. */
export function streamWindow(source, { at, radius = 6, stream_format = null }) {
  if (radius < 0) throw new ValueError("window radius must be non-negative");
  const [resolved, data, records] = decodeStream(source, { stream_format });
  const [index, offset] = resolvePosition(records, at, { data_length: data.length });
  const first = Math.max(0, index - radius), last = Math.min(records.length, index + radius + 1);
  return {
    schema: STREAM_WINDOW_SCHEMA, format: resolved, stream: streamIdentity(source, data, records),
    position: { record_index: index, byte_offset: offset, offset_hex: `0x${hex(offset)}` },
    radius,
    records: records.slice(first, last).map((r) => ({ ...r.asDict(), at_position: r.index === index })),
    proof: "This reads a retained file and decodes record framing only. It runs no compiler and mutates nothing.",
  };
}

const frames = (records) => records.map((r) => [r.byte_offset, r.byte_length, r.name]);

/** Whether an edit re-framed records outside its own extent. */
function framingError(records, patched, { offset, end_offset, payload_length }) {
  const delta = payload_length - (end_offset - offset);
  if (!pyEq(frames(patched.filter((r) => r.end_offset <= offset)), frames(records.filter((r) => r.end_offset <= offset)))) {
    return "the records before it no longer frame the same way";
  }
  const expectedAfter = records.filter((r) => r.byte_offset >= end_offset).map((r) => [r.byte_offset + delta, r.byte_length, r.name]);
  const actualAfter = frames(patched.filter((r) => r.byte_offset >= offset + payload_length));
  if (!pyEq(actualAfter, expectedAfter)) return "the records after it no longer frame the same way";
  return null;
}

/** Parse `N` or `N:M` (half-open) into record indices. */
function parseSpan(span, count) {
  const text = span.replace(/^#/, "");
  const sep = text.indexOf(":");
  const startText = sep >= 0 ? text.slice(0, sep) : text;
  const endText = sep >= 0 ? text.slice(sep + 1) : "";
  let start, end;
  try {
    start = pyInt(startText, 0);
    end = sep >= 0 && endText ? pyInt(endText.replace(/^#/, ""), 0) : start + 1;
  } catch { throw new ValueError(`malformed record span: ${strRepr(span)}`); }
  if (start < 0) start += count;
  if (end < 0) end += count;
  if (!(start >= 0 && start < count)) throw new ValueError(`record index ${start} is outside 0..${count - 1}`);
  if (!(start < end && end <= count)) throw new ValueError(`record span ${strRepr(span)} must select at least one record inside 0..${count}`);
  return [start, end];
}

/** Insert, replace, or delete whole records and verify the result decodes: [bytes, report]. */
export function patchStream(source, { stream_format = null, insert_at = null, replace = null, delete: del = null, records_spec = null, fresh_label_count = 0, allow_undecodable = false } = {}) {
  const operations = [["insert", insert_at], ["replace", replace], ["delete", del]].filter(([, v]) => v !== null && v !== undefined).map(([n]) => n);
  if (operations.length !== 1) throw new ValueError(`give exactly one of --insert-at, --replace, or --delete (got ${operations.join(", ") || "none"})`);
  const [resolved, data, records] = decodeStream(source, { stream_format });
  let fresh = [];
  if (fresh_label_count) fresh = allocateFreshLabels(records, fresh_label_count, { stream_format: resolved });
  let payload = Buffer.alloc(0), framing = null;
  if (records_spec !== null && records_spec !== undefined) [payload, framing] = parseRecordSpec(records_spec, { fresh_labels: fresh });
  let index, endIndex, offset, endOffset, patched, operation;
  if (insert_at !== null && insert_at !== undefined) {
    if (!payload.length) throw new ValueError("--insert-at requires --records");
    [index, offset] = resolvePosition(records, insert_at, { data_length: data.length });
    endIndex = index; endOffset = offset;
    patched = Buffer.concat([data.subarray(0, offset), payload, data.subarray(offset)]);
    operation = "insert";
  } else {
    const span = replace !== null && replace !== undefined ? replace : String(del);
    [index, endIndex] = parseSpan(span, records.length);
    if (del !== null && del !== undefined && payload.length) throw new ValueError("--delete does not take --records");
    if (replace !== null && replace !== undefined && !payload.length) throw new ValueError("--replace requires --records");
    refuseInsideAGroup(records, index, records[index].byte_offset);
    if (endIndex < records.length) refuseInsideAGroup(records, endIndex, records[endIndex].byte_offset);
    offset = records[index].byte_offset;
    endOffset = endIndex < records.length ? records[endIndex].byte_offset : data.length;
    patched = Buffer.concat([data.subarray(0, offset), payload, data.subarray(endOffset)]);
    operation = replace !== null && replace !== undefined ? "replace" : "delete";
  }
  let decodedError = null, frameErr = null, patchedRecords = [];
  try {
    [, , patchedRecords] = decodeStream(patched, { stream_format: resolved });
  } catch (e) {
    if (!(e instanceof ValueError)) throw e;
    decodedError = e.message;
    if (!allow_undecodable) throw new ValueError(`patched stream does not decode as ${resolved}: ${e.message}; fix the record spec or pass --allow-undecodable to keep it`);
  }
  if (decodedError === null) {
    frameErr = framingError(records, patchedRecords, { offset, end_offset: endOffset, payload_length: payload.length });
    if (frameErr !== null && !allow_undecodable) {
      throw new ValueError(`the patched stream still parses, but ${frameErr}; the edit changed how bytes outside it are read, so an object `
        + "built from it would be evidence about the damage. Fix the record spec or pass --allow-undecodable to keep it");
    }
  }
  let inserted = [];
  if (payload.length) {
    try {
      const [, , view] = decodeStream(payload, { stream_format: resolved });
      inserted = view.map((r) => r.asDict());
      if (framing !== null) {
        const actual = view.map((r) => r.byte_length);
        if (!pyEq(framing, actual)) {
          throw new ValueError(`record spec groups do not match decoded record framing: spec says (${framing.join(", ")}${framing.length === 1 ? "," : ""}), the decoder frames (${actual.join(", ")}${actual.length === 1 ? "," : ""})`);
        }
      }
    } catch (e) {
      if (!(e instanceof ValueError)) throw e;
      if (!allow_undecodable) throw new ValueError(`inserted records do not decode as ${resolved}: ${e.message}`);
    }
  }
  const report = {
    schema: STREAM_PATCH_SCHEMA, format: resolved, operation,
    source: streamIdentity(source, data, records),
    position: { record_index: index, end_record_index: endIndex, byte_offset: offset, offset_hex: `0x${hex(offset)}`,
      end_byte_offset: endOffset, removed_bytes: endOffset - offset, removed_records: endIndex - index },
    fresh_labels: [...fresh],
    max_existing_label: resolved === "ucode" ? maxLabel(records, { stream_format: resolved }) : null,
    inserted: { bytes: payload.length, hex: payload.toString("hex"), records: inserted },
    result: {
      bytes: patched.length, sha256: createHash("sha256").update(patched).digest("hex"),
      record_count: patchedRecords.length ? patchedRecords.length : null,
      record_delta: patchedRecords.length ? patchedRecords.length - records.length : null,
      decodes: decodedError === null, decode_error: decodedError,
      framing_preserved: decodedError === null && frameErr === null, framing_error: frameErr,
    },
    proof: "A patched stream that produces the target object proves the inserted record is sufficient downstream of the patched boundary. It does not prove any C spelling emits that record.",
  };
  return [patched, report];
}

function diffRow(tag, left, right, li, ri) {
  return { tag, left: li !== null ? left[li].asDict() : null, right: ri !== null ? right[ri].asDict() : null };
}

/** Align two phase streams by record and report the first divergence. */
export function diffStreams(left, right, { stream_format = null, limit = 40, context = 2 } = {}) {
  if (limit <= 0) throw new ValueError("diff limit must be positive");
  if (context < 0) throw new ValueError("diff context must be non-negative");
  const [leftFormat, leftData, L] = decodeStream(left, { stream_format });
  const [rightFormat, rightData, R] = decodeStream(right, { stream_format });
  if (leftFormat !== rightFormat) throw new ValueError(`streams have different formats (${leftFormat} and ${rightFormat}); pass --format to decode both the same way`);
  const key = (r) => r.words.join(",");
  const matcher = new SequenceMatcher(L.map(key), R.map(key));
  const counts = { equal: 0, replace: 0, insert: 0, delete: 0 };
  const rows = [];
  let pending = [], first = null, truncated = false;
  for (const [tag, i1, i2, j1, j2] of matcher.getOpcodes()) {
    counts[tag] += Math.max(i2 - i1, j2 - j1);
    if (tag === "equal") {
      const size = i2 - i1;
      const trailing = rows.length ? Math.min(context, size) : 0;
      for (let k = 0; k < trailing; k++) {
        if (rows.length >= limit) { truncated = true; break; }
        rows.push(diffRow("equal", L, R, i1 + k, j1 + k));
      }
      const leading = Math.min(context, size - trailing);
      pending = [];
      for (let taken = leading; taken > 0; taken--) pending.push(diffRow("equal", L, R, i2 - taken, j2 - taken));
      continue;
    }
    for (const row of pending) if (rows.length < limit) rows.push(row);
    pending = [];
    if (first === null) {
      first = {
        tag,
        left_index: i1 < L.length ? i1 : null,
        right_index: j1 < R.length ? j1 : null,
        left_offset_hex: i1 < L.length ? `0x${hex(L[i1].byte_offset)}` : null,
        right_offset_hex: j1 < R.length ? `0x${hex(R[j1].byte_offset)}` : null,
        left: i1 < L.length ? L[i1].asDict() : null,
        right: j1 < R.length ? R[j1].asDict() : null,
      };
    }
    for (let k = 0; k < Math.max(i2 - i1, j2 - j1); k++) {
      if (rows.length >= limit) { truncated = true; break; }
      rows.push(diffRow(tag, L, R, i1 + k < i2 ? i1 + k : null, j1 + k < j2 ? j1 + k : null));
    }
  }
  const matches = matcher.getMatchingBlocks().reduce((s, b) => s + b[2], 0);
  const total = L.length + R.length;
  const ratio = total ? (2.0 * matches) / total : 1.0;
  return {
    schema: STREAM_DIFF_SCHEMA, format: leftFormat, identical: leftData.equals(rightData),
    left: streamIdentity(left, leftData, L), right: streamIdentity(right, rightData, R),
    record_counts: { left: L.length, right: R.length },
    opcode_counts: counts,
    similarity: pyRound(ratio, 6),
    first_divergence: first,
    rows,
    rows_truncated: truncated,
    proof: "This compares two retained files by decoded record framing. A record-level difference names what changed at the boundary, not why the earlier pass emitted it.",
  };
}
