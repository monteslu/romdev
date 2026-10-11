// binasm.js - read IDO's fixed-width Binasm stream (the ugen-to-as1 pass
// boundary) and late-peephole evidence.
//
// The stream is a sequence of 16-byte records consumed by as1. Only record
// families whose identities have been observed and calibrated are decoded;
// unknown records stay visible as four words instead of being guessed into
// assembly. Barrier-probe results are evidence about the downstream pass
// only: an inserted record producing an exact object proves sufficiency at
// that boundary, not that a C spelling survives cfe/uopt/ugen and emits it.
//
// Plain JS ESM + JSDoc.

import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ValueError, splitlines, strip, strRepr, hex, sorted, counter, mostCommon } from "./py.js";

export const BINASM_RECORD_SIZE = 16;
export const BINASM_REPORT_SCHEMA = "decomp-workbench-binasm-boundary-v1";

const SET_MODES = new Map([
  [1, "reorder"], [2, "noreorder"], [3, "macro"], [4, "nomacro"], [5, "at"], [6, "noat"], [7, "move"],
  [8, "nomove"], [9, "bopt"], [10, "nobopt"], [11, "volatile"], [12, "novolatile"], [13, "transform"], [14, "notransform"],
]);

// Binasm instruction opcodes established from as0 probes. Not an instruction
// decoder: operands have a separate Binasm encoding.
const INSTRUCTION_NAMES = new Map([
  [0x0004, "addu"], [0x0062, "move"], [0x007C, "nop-pseudo"], [0x0080, "or"], [0x009E, "sll"], [0x00A8, "srl"],
  [0x00AC, "subu"], [0x00B2, "xor"], [0x01A8, "addiu"], [0x01AE, "andi"],
  // Word 3 is a byte length; the following ceil(length/16) records are raw,
  // space-padded ASCII digits rather than words.
  [0x01F8, "float-literal"],
]);

const LITERAL_INSTRUCTION = 0x01F8;

/** Record families keyed by the high half of word 1: [kind, name, description, evidence]. */
const RECORD_FAMILIES = new Map([
  [0x0002, ["symbol-scope", "globl", "global symbol declaration", "calibrated"]],
  [0x0009, ["symbol-definition", "symbol-def", "symbol definition; as1 rejects a duplicate of it", "calibrated"]],
  [0x0015, ["section", "text", "switch to the text section", "calibrated"]],
  [0x0018, ["procedure", "end", "procedure end", "calibrated"]],
  [0x001A, ["section", "section-switch", "leave the text section for embedded data", "calibrated"]],
  [0x001B, ["procedure", "ent", "procedure entry", "calibrated"]],
  [0x0026, ["procedure", "mask", "register save mask and frame offset", "inferred"]],
  [0x002A, ["stream-header", "header", "Binasm stream header record", "calibrated"]],
  [0x002B, ["procedure", "frame", "frame description", "inferred"]],
  [0x0035, ["call-metadata", "call-live", "ugen's own call-site liveness metadata", "inferred"]],
]);

const PEEP_REPLACEMENT_RE = /^>>(?<family>Repl_reg(?:_tgt)?)\s+\(INST\s+(?<inst>\d+)\)\s+(?<register>\d+)\s+with\s+(?<with_register>\d+)\s*$/;
const PEEP_NOP_RE = /^>>(?<family>Repl_reg(?:_tgt)?)\s+\(INST\s+(?<inst>\d+)\)\s+changed\s+to\s+NOP\s*$/;
const PEEP_RS_RE = /^>>(?<family>Peepreg)\s+\(INST\s+(?<inst>\d+)\)\s+changed\s+rs\s+(?<register>\d+)\s*=>\s*(?<with_register>\d+)\s*$/;
const PEEP_MEMORY_RE = /^>>(?<family>Peepreg)\s+\(INST\s+(?<inst>\d+)\)\s+mem=>(?<operation>\S+)\s+r\s+(?<register>\d+)\s*$/;

const expandUser = (p) => (p === "~" || p.startsWith("~/") ? os.homedir() + p.slice(1) : p);

/** One phase stream's bytes from either a buffer or a path (a string is always a path). */
export function readStreamBytes(source) {
  if (source instanceof Uint8Array) return Buffer.from(source);
  if (source instanceof ArrayBuffer) return Buffer.from(new Uint8Array(source));
  return readFileSync(expandUser(String(source)));
}

const signedU32 = (v) => (v & 0x80000000 ? v - 0x100000000 : v);

/** One losslessly retained 16-byte Binasm record. */
export class BinasmRecord {
  constructor(index, offset, words, kind, name, detail, source_lever = null, evidence = "calibrated") {
    Object.assign(this, { index, offset, words, kind, name, detail, source_lever, evidence });
    Object.freeze(this);
  }
  get raw_hex() { return this.words.map((w) => hex(w, 8)).join(" "); }
  asDict() {
    return { index: this.index, offset: this.offset, offset_hex: `0x${hex(this.offset)}`, words: this.words.map((w) => `0x${hex(w, 8)}`),
      raw_hex: this.raw_hex, kind: this.kind, name: this.name, detail: this.detail, source_lever: this.source_lever, evidence: this.evidence };
  }
}

/** One recognized line from IDO 7.1's -peepdbg stream. */
export class PeepEvent {
  constructor({ line, family, action, inst, register = null, with_register = null, operation = null, text = "" }) {
    Object.assign(this, { line, family, action, inst, register, with_register, operation, text });
    Object.freeze(this);
  }
  asDict() {
    return { line: this.line, family: this.family, action: this.action, inst: this.inst, register: this.register,
      with_register: this.with_register, operation: this.operation, text: this.text };
  }
}

function instructionSourceLever(name, operands, immediate) {
  if (name === "move") return "copy assignment or carrier coalescing; a physical self-move may be removed before Binasm, so verify the retained stream";
  const zeroIdentity = new Set([0x04090000, 0x060CC000, 0x060D0000]);
  if (["addu", "addiu", "or", "subu", "xor"].includes(name) && zeroIdentity.has(operands) && immediate === 0) {
    return "zero-arithmetic identity on the live value; source-spellable, but normally optimized away upstream unless another constraint retains it";
  }
  if (name === "andi") {
    const mask = immediate & 0xFFFF;
    return `narrowing/width normalization with mask 0x${hex(mask)}; try a proven narrow type or edge-local conversion and verify that ugen retains it`;
  }
  if (name === "nop-pseudo") return "assembler no-op; useful as a boundary control, not direct C evidence";
  if ((name === "sll" || name === "srl") && immediate === 0) return "zero shift identity; source-spellable but normally removed upstream";
  return null;
}

/** Fold a family's unexplained low bits into its detail and its evidence. */
function variantEvidence(detail, low, observed = "calibrated") {
  if (!low) return [detail, observed];
  return [`${detail}; flags=0x${hex(low, 4)}`, "inferred"];
}

const CALL_METADATA = new Map([[0x00360000, "gjaldef"], [0x00370000, "gjallive"], [0x00380000, "gjrlive"]]);

function classifyRecord(index, offset, words) {
  const [first, opcode, operands, immediate] = words;
  const signedFirst = signedU32(first);
  const hi = opcode >>> 16, lo = opcode & 0xFFFF;
  if (opcode === 0 && operands === 0 && immediate === 0 && first) {
    if (signedFirst < 0) {
      return new BinasmRecord(index, offset, words, "control-flow", "local-label", `local label $${-signedFirst}`,
        "an explicit label/goto or a control-flow join can create this boundary");
    }
    return new BinasmRecord(index, offset, words, "control-flow", "symbol-label", `label definition for symbol index ${first}`,
      "a named label, a function entry, or an assembled local label");
  }
  if (hi === 0x0016) {
    const target = signedFirst < 0 ? `$${-signedFirst}` : String(first);
    let [detail, evidence] = variantEvidence(`case target ${target}`, lo);
    if (!(operands === 0 && immediate === 1)) {
      detail += ` (unusual payload ${hex(operands, 0, { prefix: true })}/${hex(immediate, 0, { prefix: true })})`;
      evidence = "inferred";
    }
    return new BinasmRecord(index, offset, words, "jump-table", "table-entry", detail,
      "a switch whose dense range ugen chose to lower as a jump table; the table's width follows the selector range, not the C spelling", evidence);
  }
  if (hi === 0x001C) {
    const [detail, evidence] = variantEvidence(`file=${operands} line=${immediate}`, lo);
    return new BinasmRecord(index, offset, words, "source-location", "loc", detail,
      "statement attribution or #line can change LOC records when the selected frontend/debug mode emits them", evidence);
  }
  if (hi === 0x0020) {
    const mode = SET_MODES.get(operands) ?? `unknown-${operands}`;
    let [detail, evidence] = variantEvidence(`.set ${mode}`, lo);
    if (!SET_MODES.has(operands)) evidence = "inferred";
    return new BinasmRecord(index, offset, words, "assembler-mode", `set-${mode}`, detail,
      "assembler directive only; use as a downstream boundary proof, then seek a source event that creates the same peephole break", evidence);
  }
  if (hi === 0x0017) {
    const named = INSTRUCTION_NAMES.has(lo);
    const name = INSTRUCTION_NAMES.get(lo) ?? `instruction-0x${hex(lo, 4)}`;
    let detail = `Binasm operands=0x${hex(operands, 8)} value=0x${hex(immediate, 8)}`;
    if (lo === LITERAL_INSTRUCTION) detail += `; ${immediate} ASCII byte(s) follow in ${literalPayloadRecords(immediate)} payload record(s)`;
    return new BinasmRecord(index, offset, words, "instruction", name, detail, instructionSourceLever(name, operands, immediate), named ? "calibrated" : "inferred");
  }
  if (hi === 0x0030 || hi === 0x0031) {
    const name = hi === 0x0031 ? "alias" : "noalias";
    const [detail, evidence] = variantEvidence(`${name} metadata opcode=0x${hex(opcode, 8)}`, lo);
    return new BinasmRecord(index, offset, words, "alias-metadata", name, detail,
      "pointer provenance, restrict-like separation, or volatile access may alter alias metadata; verify the exact frontend emits it", evidence);
  }
  if (CALL_METADATA.has(opcode)) {
    const name = CALL_METADATA.get(opcode);
    return new BinasmRecord(index, offset, words, "call-metadata", name, `${name} mask=0x${hex(operands, 8)}`,
      "call placement and values live across the call can alter this metadata");
  }
  const family = RECORD_FAMILIES.get(hi);
  if (family) {
    const [kind, name, description, observed] = family;
    let [detail, evidence] = variantEvidence(description, lo, observed);
    if (operands || immediate) detail += `; payload=0x${hex(operands, 8)}/0x${hex(immediate, 8)}`;
    return new BinasmRecord(index, offset, words, kind, name, detail, null, evidence);
  }
  if (words.every((w) => w === 0)) return new BinasmRecord(index, offset, words, "empty", "zero", "all-zero record");
  return new BinasmRecord(index, offset, words, "unknown", "unknown", "unclassified record; raw words retained", null, "none");
}

/** How many 16-byte records one ASCII float literal occupies. */
export function literalPayloadRecords(byteLength) { return Math.floor((byteLength + BINASM_RECORD_SIZE - 1) / BINASM_RECORD_SIZE); }

/** Parse a fixed 16-byte IDO Binasm stream without discarding unknowns. */
export function parseBinasm(source, { byteorder = "big" } = {}) {
  const data = readStreamBytes(source);
  if (byteorder !== "big" && byteorder !== "little") throw new ValueError("Binasm byte order must be 'big' or 'little'");
  if (data.length % BINASM_RECORD_SIZE) {
    throw new ValueError(`Binasm stream is ${data.length} bytes; expected a multiple of ${BINASM_RECORD_SIZE} (trailing ${data.length % BINASM_RECORD_SIZE} byte(s))`);
  }
  const read = byteorder === "big" ? (o) => data.readUInt32BE(o) : (o) => data.readUInt32LE(o);
  const records = [];
  let payloadRemaining = 0;
  for (let offset = 0; offset < data.length; offset += BINASM_RECORD_SIZE) {
    const words = [read(offset), read(offset + 4), read(offset + 8), read(offset + 12)];
    const index = offset / BINASM_RECORD_SIZE;
    if (payloadRemaining) {
      payloadRemaining -= 1;
      const chunk = data.subarray(offset, offset + BINASM_RECORD_SIZE);
      const text = rstripPy([...chunk].map((b) => (b < 0x80 ? String.fromCharCode(b) : "\ufffd")).join(""));
      records.push(new BinasmRecord(index, offset, words, "literal-payload", "ascii-payload", `ASCII literal digits ${strRepr(text)}`, null, "calibrated"));
      continue;
    }
    const record = classifyRecord(index, offset, words);
    records.push(record);
    if (record.name === "float-literal") {
      const remaining = Math.floor((data.length - offset) / BINASM_RECORD_SIZE) - 1;
      payloadRemaining = Math.min(literalPayloadRecords(words[3]), remaining);
    }
  }
  return records;
}

// The original's str.rstrip() (unicode whitespace, which U+FFFD is not).
function rstripPy(s) { return s.replace(/[\s\x1c-\x1f\x85]+$/u, ""); }

/** Parse known IDO 7.1 peephole debug lines and retain unknown debug lines. */
export function parsePeepdbg(text) {
  const events = [], unparsed = [];
  splitlines(text).forEach((raw, i) => {
    const lineNumber = i + 1;
    const stripped = strip(raw);
    if (!stripped) return;
    let m = PEEP_REPLACEMENT_RE.exec(stripped);
    if (m) {
      const v = m.groups;
      events.push(new PeepEvent({ line: lineNumber, family: v.family, action: "register-replacement", inst: Number(v.inst), register: Number(v.register), with_register: Number(v.with_register), text: stripped }));
      return;
    }
    m = PEEP_NOP_RE.exec(stripped);
    if (m) { events.push(new PeepEvent({ line: lineNumber, family: m.groups.family, action: "changed-to-nop", inst: Number(m.groups.inst), text: stripped })); return; }
    m = PEEP_RS_RE.exec(stripped);
    if (m) {
      const v = m.groups;
      events.push(new PeepEvent({ line: lineNumber, family: v.family, action: "source-register-rewrite", inst: Number(v.inst), register: Number(v.register), with_register: Number(v.with_register), text: stripped }));
      return;
    }
    m = PEEP_MEMORY_RE.exec(stripped);
    if (m) {
      const v = m.groups;
      events.push(new PeepEvent({ line: lineNumber, family: v.family, action: "memory-rewrite", inst: Number(v.inst), register: Number(v.register), operation: v.operation, text: stripped }));
      return;
    }
    if (stripped.startsWith(">>")) unparsed.push(raw);
  });
  return [events, unparsed];
}

const sortedCounts = (d) => Object.fromEntries(sorted([...d.entries()], (e) => e[0]));

function peepReport(text, { limit }) {
  const [events, unparsed] = parsePeepdbg(text);
  const actions = counter(events.map((e) => e.action));
  const families = counter(events.map((e) => e.family));
  const pairs = [];
  for (let i = 0; i + 1 < events.length; i++) {
    const before = events[i], after = events[i + 1];
    if (before.action === "register-replacement" && after.action === "changed-to-nop" && before.family === after.family) {
      pairs.push({ replacement: before.asDict(), removed_copy: after.asDict() });
    }
  }
  return {
    event_count: events.length,
    action_counts: sortedCounts(actions),
    family_counts: sortedCounts(families),
    replacement_nop_pair_count: pairs.length,
    replacement_nop_pairs: pairs.slice(0, limit),
    events: events.slice(0, limit).map((e) => e.asDict()),
    unparsed_debug_line_count: unparsed.length,
    unparsed_debug_lines: unparsed.slice(0, limit),
    correlation_scope: "INST is pass-local in this trace. Without block/address records it cannot be mapped reliably to a Binasm byte offset; use it to name the owning peephole and the observed register pair.",
  };
}

function probeFamily(name) {
  const lowered = name.toLowerCase();
  if (lowered.includes("identity")) return "identity-instruction";
  if (lowered.includes("loc")) return "source-location";
  if (lowered.includes("alias") || lowered.includes("live") || lowered.includes("metadata")) return "dependency-metadata";
  if (lowered.includes("label")) return "control-flow-label";
  if (["nomove", "volatile", "reorder", "macro", "transform", "bopt", "noat", "set-"].some((m) => lowered.includes(m))) return "assembler-mode";
  return "unclassified";
}

function probeSite(name) {
  const lowered = name.toLowerCase().replace(/_/g, "-");
  for (const marker of ["pre-move", "post-move", "pre-add", "post-add", "around-add", "add-only", "move-branch", "move-through-add", "dispatch-range"]) {
    if (lowered.includes(marker)) return marker;
  }
  return null;
}

const PROBE_GUIDANCE = {
  "identity-instruction": "Search edge-local width normalization, a copy carrier, or redundant arithmetic whose Binasm record survives ugen. Confirm the record first; the C optimizer erases most literal identities.",
  "source-location": "Search statement attribution or a controlled #line change only after confirming the active frontend/debug mode emits LOC records.",
  "dependency-metadata": "Search alias provenance, volatile access, or call-liveness shapes that make ugen emit dependency metadata at the boundary.",
  "control-flow-label": "Search a real control-flow join, edge split, or explicit goto/label. A source label optimized away before Binasm cannot be the lever.",
  "assembler-mode": "Treat this as boundary localization, not a direct C spelling. Seek a source-emitted record that interrupts the same peephole interval.",
  "unclassified": "Retain and classify the winning inserted record before translating it into a source hypothesis.",
};

const pyStrOf = (v) => (v === null || v === undefined ? "None" : typeof v === "string" ? v : typeof v === "boolean" ? (v ? "True" : "False") : typeof v === "object" ? JSON.stringify(v) : String(v));

function barrierProbeReport(value, { limit }) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !Array.isArray(value.results)) {
    throw new ValueError("barrier probe JSON must contain a top-level results list");
  }
  const results = value.results.filter((x) => x && typeof x === "object" && !Array.isArray(x));
  const exact = results.filter((x) => x.exact === true);
  const nameOf = (x, d) => ("name" in x ? pyStrOf(x.name) : d);
  const families = counter(exact.map((x) => probeFamily(nameOf(x, "unnamed"))));
  const sites = counter(exact.map((x) => probeSite(nameOf(x, ""))).filter((s) => s !== null));
  const names = exact.map((x) => nameOf(x, "unnamed"));
  return {
    probe_count: results.length,
    failure_count: (value.failures ?? []).length,
    exact_count: exact.length,
    exact_names: names.slice(0, limit),
    exact_names_truncated: names.length > limit,
    family_counts: sortedCounts(families),
    site_counts: sortedCounts(sites),
    source_search: mostCommon(families).map(([family, count]) => ({ family, exact_count: count, next: PROBE_GUIDANCE[family] })),
    strongest_claim: "These exact cells prove that their inserted Binasm record or mode boundary is sufficient downstream of ugen. They do not prove a C spelling emits or retains that record.",
  };
}

/** A read-only phase-boundary report around one record insertion site. */
export function buildBinasmBoundaryReport(file, { boundary, radius = 4, byteorder = "big", peep_text = null, probe_results = null, limit = 50 }) {
  if (radius < 0) throw new ValueError("window radius must be non-negative");
  if (limit <= 0) throw new ValueError("report limit must be positive");
  const source = realpathSync(path.resolve(expandUser(String(file))));
  const data = readFileSync(source);
  const records = parseBinasm(data, { byteorder });
  if (boundary < 0 || boundary > data.length) throw new ValueError(`boundary ${hex(boundary, 0, { prefix: true })} is outside stream range 0x0..${hex(data.length)}`);
  if (boundary % BINASM_RECORD_SIZE) {
    throw new ValueError(`boundary ${hex(boundary, 0, { prefix: true })} is not aligned to a ${BINASM_RECORD_SIZE}-byte record; pass the insertion offset before a record`);
  }
  const boundaryIndex = boundary / BINASM_RECORD_SIZE;
  const first = Math.max(0, boundaryIndex - radius);
  const last = Math.min(records.length, boundaryIndex + radius);
  const window = records.slice(first, last).map((r) => ({ ...r.asDict(), boundary_before: r.index === boundaryIndex }));
  const kinds = counter(records.map((r) => r.kind));
  const report = {
    schema: BINASM_REPORT_SCHEMA,
    format: {
      record_size: BINASM_RECORD_SIZE,
      byteorder,
      decoder_scope: "Known Binasm record families only; unknown records remain raw and lossless. Instruction operands are not guessed. Each record carries `evidence`: calibrated (this exact record form was established by a probe listing, an as1 diagnostic, or a structural pairing), inferred (only observed, or a variant of a calibrated family carrying unexplained bits, which are rendered as flags=0x....), or none (left raw).",
    },
    stream: {
      path: source, bytes: data.length, sha256: createHash("sha256").update(data).digest("hex"), record_count: records.length,
      kind_counts: sortedCounts(kinds),
      evidence_counts: sortedCounts(counter(records.map((r) => r.evidence))),
    },
    boundary: {
      offset: boundary, offset_hex: `0x${hex(boundary)}`, record_index: boundaryIndex,
      meaning: "insertion point before record_index",
      before: boundaryIndex ? records[boundaryIndex - 1].asDict() : null,
      after: boundaryIndex < records.length ? records[boundaryIndex].asDict() : null,
      window,
    },
    proof: "This report reads retained files only. It does not run as1, compile source, mutate the Binasm stream, or execute generated code.",
    warnings: [
      "Binasm opcode names are calibrated record-family labels, not a full assembly disassembly.",
      "A downstream exact barrier is a pass-local sufficiency proof, not source-correctness or upstream-survival evidence.",
    ],
  };
  if (peep_text !== null && peep_text !== undefined) report.peephole = peepReport(peep_text, { limit });
  if (probe_results !== null && probe_results !== undefined) report.barrier_probes = barrierProbeReport(probe_results, { limit });
  return report;
}
