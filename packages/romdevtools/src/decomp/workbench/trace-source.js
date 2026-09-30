// trace-source.js - the one reader every trace command goes through. It
// decodes a captured compiler log as UTF-8 text, recovers diagnostic lines
// out of a log that merely contains binary, and refuses bytes that hold no
// diagnostic text at all with a message that names the file.
//
// Plain JS ESM + JSDoc.

import { readFileSync } from "node:fs";
import { splitlines, strip, percent } from "./py.js";

const UGEN_TAG_RE = /^(?:CODEX|DKWB)[-_]([A-Za-z0-9_-]+)/;
export const INSTRUMENTATION_DOC = "docs/compiler-instrumentation.md";
export const PHASE_CAPTURE_DOC = "docs/phase-capture.md";
export const BINARY_CONTROL_RATIO = 0.1;
const TEXT_CONTROL_BYTES = new Set([0x09, 0x0a, 0x0d, 0x0c, 0x0b, 0x1b]);

/** A trace command was handed bytes that hold no diagnostic text. */
export class BinaryTraceStreamError extends Error {
  constructor(message, { stream_format = null } = {}) { super(message); this.name = "ValueError"; this.stream_format = stream_format; }
}

function countTraceTags(text) {
  let n = 0;
  for (const line of splitlines(text)) if (UGEN_TAG_RE.test(strip(line))) n++;
  return n;
}

function binaryRatio(data) {
  if (!data.length) return 0;
  let control = 0;
  for (const b of data) if (b < 0x20 && !TEXT_CONTROL_BYTES.has(b)) control++;
  return control / data.length;
}

function looksBinary(data) { return data.includes(0) || binaryRatio(data) > BINARY_CONTROL_RATIO; }

function decodeStrict(data) {
  try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data); } catch { return null; }
}

/**
 * Read one trace. Returns {text, encoding, undecodable_bytes, notes}.
 * @param {Buffer|Uint8Array|string} source bytes, or a path
 * @param {{name?: string}} [opts]
 */
export function readTraceSource(source, { name = null } = {}) {
  let data, label;
  if (typeof source !== "string") { data = Buffer.from(source); label = name ?? "<bytes>"; }
  else { data = readFileSync(source); label = name ?? source; }
  const text = decodeStrict(data);
  if (text !== null && !(looksBinary(data) && countTraceTags(text) === 0)) {
    return { text, encoding: "utf-8", undecodable_bytes: 0, notes: [] };
  }
  // Pass-boundary streams (Ucode/Binasm) are not classified here; any bytes
  // that decode are parsed as text with a note, and bytes that neither decode
  // nor carry a diagnostic tag are refused by name.
  const lossy = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true }).decode(data);
  const tags = countTraceTags(lossy);
  if (text !== null) {
    return { text, encoding: "utf-8", undecodable_bytes: 0,
      notes: [`${label} decodes as text but reads as binary (${percent(binaryRatio(data), 0)} control bytes) and holds no `
        + "CODEX/DKWB diagnostic line; it frames as neither Ucode nor "
        + `Binasm. Parsed as text anyway (${PHASE_CAPTURE_DOC}).`] };
  }
  const undecodable = [...lossy].filter((c) => c === "�").length;
  if (tags === 0) {
    throw new BinaryTraceStreamError(
      `${label} is not UTF-8 text (${undecodable} undecodable byte(s) of `
      + `${data.length}) and holds no CODEX/DKWB diagnostic line, so it is not a `
      + "diagnostic trace. If this is a retained Ucode or Binasm pass boundary, "
      + `it carries records, not decisions (${PHASE_CAPTURE_DOC}); if it should be a trace, the `
      + `instrumented toolchain did not write one -- see ${INSTRUMENTATION_DOC}.`);
  }
  return { text: lossy, encoding: "utf-8/replace", undecodable_bytes: undecodable,
    notes: [`${label} is not valid UTF-8: ${undecodable} byte(s) were replaced `
      + `and ${tags} diagnostic line(s) were recovered from the rest. A `
      + "mixed file is a trace with binary written into the same stream; "
      + `records it may also hold are not decoded here (${PHASE_CAPTURE_DOC}).`] };
}

/** Return trace text, reporting recovery notes through `warn`. */
export function readTraceText(source, { name = null, warn = null } = {}) {
  const parsed = readTraceSource(source, { name });
  if (warn) for (const note of parsed.notes) warn(note);
  return parsed.text;
}
