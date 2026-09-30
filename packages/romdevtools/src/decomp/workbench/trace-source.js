// trace-source.js - the one reader every trace command goes through. It
// decodes a captured compiler log as UTF-8 text, recovers diagnostic lines
// out of a log that merely contains binary, and refuses a pass-boundary
// stream (Ucode or Binasm) by name, pointing at the decoder that reads it.
//
// Plain JS ESM + JSDoc.

import { readFileSync } from "node:fs";
import { splitlines, strip, percent } from "./py.js";
import { detectFormat, decodeStream } from "./streams.js";

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


/** What each pass-boundary stream is, and which command reads it. */
export const STREAM_DESCRIPTIONS = Object.freeze({
  ucode: ["variable-width binary Ucode (uopt's output, ugen's positional input)", "ucode window"],
  binasm: ["fixed 16-byte binary Binasm (ugen's -o and -temp output)", "binasm window"],
});

/** The pass-boundary stream these bytes frame as, or null (delegates to the stream decoders). */
export function classifyTraceBytes(data) {
  try { return detectFormat(data); } catch { return null; }
}

function streamRecordCount(data, streamFormat) {
  try { return decodeStream(data, { stream_format: streamFormat })[2].length; } catch { return null; }
}

function binaryStreamMessage(data, streamFormat, { name, tags }) {
  const [description, reader] = STREAM_DESCRIPTIONS[streamFormat];
  const records = streamRecordCount(data, streamFormat);
  const measured = records !== null ? `${records} record(s)` : `${data.length} bytes`;
  const recovered = tags === 0 ? "" : ` ${tags} line(s) in it look like diagnostic tags, which framed records can spell by accident; they are not read as a trace.`;
  return `${name} is a ${description} pass-boundary stream, ${measured}, not a diagnostic trace.${recovered} A stream carries records, not the `
    + "decisions that produced them, so no trace command can decode it: "
    + `read the records with \`decomp-workbench ${reader} ${name} --at 0\` (${PHASE_CAPTURE_DOC}), and for a textual per-decision trace build `
    + `the Tier-2 instrumented toolchain (${INSTRUMENTATION_DOC}).`;
}

function unframedBinaryMessage(data, { name, undecodable }) {
  return `${name} is not UTF-8 text (${undecodable} undecodable byte(s) of ${data.length}) and frames as neither Ucode nor Binasm, so there is `
    + "nothing to decode either way. No CODEX/DKWB diagnostic line survived "
    + "a lossy decode. If this is a retained pass boundary, name the "
    + `framing yourself -- \`decomp-workbench binasm window ${name} --at 0 --format binasm\`, or \`--format ucode\` -- and read what the decoder `
    + `makes of it (${PHASE_CAPTURE_DOC}); if it should be a trace, the instrumented toolchain did not write one -- see `
    + `${INSTRUMENTATION_DOC}.`;
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
    return { text, encoding: "utf-8", undecodable_bytes: 0, recovered: false, notes: [] };
  }
  const streamFormat = classifyTraceBytes(data);
  const lossy = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true }).decode(data);
  const tags = countTraceTags(lossy);
  if (text !== null && streamFormat === null) {
    // Decodable, binary-looking, and framed as neither stream: say so and
    // let the caller read it; refusing here would be a guess.
    return { text, encoding: "utf-8", undecodable_bytes: 0, recovered: false,
      notes: [`${label} decodes as text but reads as binary (${percent(binaryRatio(data), 0)} control bytes) and holds no `
        + "CODEX/DKWB diagnostic line; it frames as neither Ucode nor "
        + `Binasm. Parsed as text anyway (${PHASE_CAPTURE_DOC}).`] };
  }
  if (streamFormat !== null) {
    throw new BinaryTraceStreamError(binaryStreamMessage(data, streamFormat, { name: label, tags }), { stream_format: streamFormat });
  }
  const undecodable = [...lossy].filter((c) => c === "\ufffd").length;
  if (tags === 0) throw new BinaryTraceStreamError(unframedBinaryMessage(data, { name: label, undecodable }));
  return { text: lossy, encoding: "utf-8/replace", undecodable_bytes: undecodable, recovered: undecodable > 0,
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
