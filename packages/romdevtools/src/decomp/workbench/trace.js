// trace.js - parsers and models for IDO static-recomp diagnostic traces:
// the CODEX/DKWB ugen free-list records, their normalized actions, and the
// strict FIFO replay of one traced register class. Reading the bytes of a
// trace (and refusing a binary pass-boundary stream) lives in
// ./trace-source.js.
//
// Plain JS ESM + JSDoc.

import { ValueError, splitlines, strip, strRepr, pyInt, sorted, counter } from "./py.js";

export const FIELD_RE = /([A-Za-z_][A-Za-z0-9_-]*)=([^\s]+)/g;
export const UGEN_TAG_RE = /^(?:CODEX|DKWB)[-_]([A-Za-z0-9_-]+)/;

export const MIPS_REGISTERS = Object.freeze({
  zero: 0, at: 1, v0: 2, v1: 3, a0: 4, a1: 5, a2: 6, a3: 7, t0: 8, t1: 9, t2: 10, t3: 11, t4: 12, t5: 13, t6: 14, t7: 15,
  s0: 16, s1: 17, s2: 18, s3: 19, s4: 20, s5: 21, s6: 22, s7: 23, t8: 24, t9: 25, k0: 26, k1: 27, gp: 28, sp: 29, fp: 30, s8: 30, ra: 31,
});
export const REGISTER_NAMES = new Map(Object.entries(MIPS_REGISTERS).filter(([n]) => n !== "s8").map(([n, v]) => [v, n]));

export const FP_REGISTER_BASE = 32;
export const FP_REGISTER_LIMIT = 64;

function findall(re, text) {
  const out = [];
  const g = new RegExp(re.source, "g");
  let m;
  while ((m = g.exec(text)) !== null) { out.push([m[1], m[2]]); if (m[0] === "") g.lastIndex++; }
  return out;
}

/** Parse decimal, `0x` hexadecimal, or bare hexadecimal values; null if none. */
export function parseInteger(value) {
  const cleaned = String(value).replace(/[,;]+$/, "");
  try { return pyInt(cleaned, 0); } catch {
    if (/^[0-9a-fA-F]+$/.test(cleaned) && /[a-fA-F]/.test(cleaned)) return parseInt(cleaned, 16);
  }
  return null;
}

/** Parse a numeric or conventional MIPS register name. */
export function parseRegister(value) {
  let cleaned = strip(String(value)).toLowerCase();
  if (cleaned.startsWith("$")) cleaned = cleaned.slice(1);
  if (Object.prototype.hasOwnProperty.call(MIPS_REGISTERS, cleaned)) return MIPS_REGISTERS[cleaned];
  const parsed = parseInteger(cleaned);
  if (parsed === null || !(parsed >= 0 && parsed <= 255)) throw new ValueError(`invalid register: ${strRepr(value)}`);
  return parsed;
}

/** Return a conventional name, retaining unknown numeric registers. */
export function registerName(number) {
  if (REGISTER_NAMES.has(number)) return REGISTER_NAMES.get(number);
  if (number >= FP_REGISTER_BASE && number < FP_REGISTER_LIMIT) return `$f${number - FP_REGISTER_BASE}`;
  return String(number);
}

/** One normalized diagnostic line. */
export class TraceEvent {
  constructor({ index, tag, action, register, source_line, serial, list_address, emitted_index = null, object_row = null,
    source_file = null, procedure = null, fields = {}, raw = "" }) {
    Object.assign(this, { index, tag, action, register, source_line, serial, list_address, emitted_index, object_row, source_file, procedure, fields, raw });
    Object.freeze(this);
  }
  asDict() {
    const result = { index: this.index, tag: this.tag, action: this.action, register: this.register, source_line: this.source_line,
      serial: this.serial, list_address: this.list_address, emitted_index: this.emitted_index, object_row: this.object_row,
      source_file: this.source_file, procedure: this.procedure, fields: { ...this.fields }, raw: this.raw };
    if (this.register !== null) result.register_name = this.action === "allocation-request" ? String(this.register) : registerName(this.register);
    return result;
  }
}

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const get = (o, k) => (has(o, k) ? o[k] : undefined);

/** Map historical trace spellings to stable actions. */
export function normalizeAction(tag, fields) {
  const upper = tag.toUpperCase().replace(/_/g, "-");
  if (upper.includes("ALIAS-QUERY")) return "alias-query";
  if (upper.endsWith("-BASE")) return "base";
  if (upper.endsWith("FREELIST")) {
    const event = get(fields, "_event");
    if (event === "ALLOC_GP" || event === "ALLOC_FP") return "allocation-request";
    if (event === "ALLOC" || event === "ALLOC_GP_RESULT" || event === "ALLOC_FP_RESULT") return "allocate";
    if (event !== undefined && event.startsWith("ALLOC")) return "unsupported-allocation";
    if (event === "ADD") return "append";
    if (event === "FREE" || event === "FORCE_FREE") return "free-request";
    if (event === "REMOVE") return "remove";
    if (event === "MOVE_END") return upper === "DKWB-FREELIST" ? "used-list-request" : "move-end";
  }
  if (upper.includes("ALLOC")) return "allocate";
  if (upper.includes("APPEND")) return "append";
  if (upper.includes("REMOVE") || upper.includes("POP")) return "remove";
  if (upper.includes("FREE")) return "free";
  if (upper.includes("QUEUE")) return "queue";
  if (upper.includes("GETDEST")) return "get-destination";
  if (upper.includes("HINT")) return "hint";
  if (upper.includes("EVAL")) return "evaluate";
  return upper.toLowerCase();
}

function partition(s, sep) {
  const i = s.indexOf(sep);
  return i < 0 ? [s, "", ""] : [s.slice(0, i), sep, s.slice(i + sep.length)];
}

/** Parse known CODEX/DKWB ugen trace formats; unknown tags are retained. */
export function parseTrace(text) {
  const events = [];
  splitlines(text).forEach((raw, idx) => {
    const lineNumber = idx + 1;
    const stripped = strip(raw);
    if (!UGEN_TAG_RE.test(stripped)) return;
    const [firstToken, , remainder] = partition(stripped, " ");
    const fields = Object.create(null);
    for (const [k, v] of findall(FIELD_RE, remainder)) fields[k] = v;
    if (firstToken === "DKWB-FREELIST") {
      const [eventName, , rest] = partition(remainder, " ");
      fields._event = eventName.toUpperCase();
      for (const [k, v] of findall(FIELD_RE, rest)) fields[k] = v;
    }
    const pick = (...keys) => { for (const k of keys) { const v = get(fields, k); if (v) return v; } return null; };
    const registerValue = pick("reg", "register");
    const sourceValue = pick("line", "source_line");
    const emittedValue = pick("emitted", "emit_index", "insn_index", "ord");
    const rowValue = pick("row", "object_row");
    const procedureValue = pick("proc", "procedure");
    const serialValue = get(fields, "serial") ?? null;
    const listValue = pick("list", "list_address");
    const register = registerValue !== null ? parseRegister(registerValue) : null;
    let parsedProcedure = procedureValue !== null ? parseInteger(procedureValue) : null;
    if (parsedProcedure !== null && parsedProcedure < 0) parsedProcedure = null;
    events.push(new TraceEvent({
      index: lineNumber, tag: firstToken, action: normalizeAction(firstToken, fields), register,
      source_line: sourceValue !== null ? parseInteger(sourceValue) : null,
      serial: serialValue !== null ? parseInteger(serialValue) : null,
      list_address: listValue !== null ? parseInteger(listValue) : null,
      emitted_index: emittedValue !== null ? parseInteger(emittedValue) : null,
      object_row: rowValue !== null ? parseInteger(rowValue) : null,
      source_file: get(fields, "file") || get(fields, "source_file") || null,
      procedure: parsedProcedure, fields, raw,
    }));
  });
  return events;
}

/** An allocation/free event expressed in logical value identities. */
export class LogicalEvent {
  constructor({ action, value, register, source_line, trace_line, emitted_index = null, object_row = null, source_file = null, instruction = null, procedure = null }) {
    Object.assign(this, { action, value, register, source_line, trace_line, emitted_index, object_row, source_file, instruction, procedure });
    Object.freeze(this);
  }
  asDict() {
    return { action: this.action, value: this.value, register: this.register, source_line: this.source_line, trace_line: this.trace_line,
      emitted_index: this.emitted_index, object_row: this.object_row, source_file: this.source_file, instruction: this.instruction,
      procedure: this.procedure, register_name: registerName(this.register) };
  }
}

/** Result of replaying one traced FIFO register class. */
export class FifoReplay {
  constructor({ initial_queue, final_queue, allocations, logical_events, violations, max_live, ignored_events, procedure = null,
    allocation_event_counts = {}, initialization_basis = "unknown", unresolved_free_requests = 0 }) {
    Object.assign(this, { initial_queue, final_queue, allocations, logical_events, violations, max_live, ignored_events, procedure,
      allocation_event_counts, initialization_basis, unresolved_free_requests });
  }
  get valid() { return this.violations.length === 0; }
  asDict() {
    const L = this.logical_events;
    const emitted = L.filter((e) => e.emitted_index !== null).length;
    const rows = L.filter((e) => e.object_row !== null).length;
    const sources = L.filter((e) => e.source_line !== null).length;
    const instructions = L.filter((e) => e.instruction !== null).length;
    return {
      valid: this.valid, initial_queue: this.initial_queue, initial_queue_names: this.initial_queue.map(registerName),
      initialization_basis: this.initialization_basis, unresolved_free_requests: this.unresolved_free_requests,
      final_queue: this.final_queue, final_queue_names: this.final_queue.map(registerName), allocations: this.allocations,
      allocation_names: this.allocations.map(registerName), allocation_event_counts: this.allocation_event_counts,
      logical_events: L.map((e) => e.asDict()), violations: this.violations, max_live: this.max_live,
      ignored_events: this.ignored_events, procedure: this.procedure,
      emission_join: { logical_events: L.length, with_emitted_index: emitted, with_object_row: rows, with_source_line: sources,
        with_instruction: instructions, complete: L.length > 0 && rows === L.length && sources === L.length, calibration_required: emitted > rows },
    };
  }
}

/** One exact instrumented-ordinal to object/source calibration point. */
export class EmissionLocation {
  constructor({ emitted_index, object_row, source_line = null, source_file = null, instruction = null }) {
    Object.assign(this, { emitted_index, object_row, source_line, source_file, instruction });
    Object.freeze(this);
  }
}

/** Replay leading ADD/REMOVE membership before the first allocation. */
export function inferInitialQueue(events) {
  const queue = [];
  for (const e of events) {
    if (e.action === "allocate") break;
    if (e.action === "append" && e.register !== null && !queue.includes(e.register)) queue.push(e.register);
    else if (e.action === "remove" && queue.includes(e.register)) queue.splice(queue.indexOf(e.register), 1);
  }
  return queue;
}

/** Decode actual allocations, preserving explicit legacy register events. */
export function allocationBank(event) {
  if (event.action !== "allocate" || event.register === null) return null;
  const r = event.register;
  const bank = r >= 0 && r < 32 ? "gp" : r >= 32 && r < 64 ? "fp" : null;
  const kind = get(event.fields, "_event");
  if (kind === "ALLOC_GP_RESULT" && bank !== "gp") return null;
  if (kind === "ALLOC_FP_RESULT" && bank !== "fp") return null;
  return bank;
}

/** Identify unsupported or incomplete allocation records, not queue state. */
export function allocationIssues(events) {
  const requests = new Map(), results = new Map();
  const issues = [];
  for (const e of events) {
    const kind = get(e.fields, "_event") ?? "";
    if (e.action === "unsupported-allocation") issues.push(`trace line ${e.index}: unsupported allocation event ${kind}`);
    if (e.action === "allocate" && allocationBank(e) === null) issues.push(`trace line ${e.index}: invalid allocated register`);
    if (["ALLOC_GP", "ALLOC_FP", "ALLOC_GP_RESULT", "ALLOC_FP_RESULT"].includes(kind)) {
      const bank = kind.startsWith("ALLOC_GP") ? "gp" : "fp";
      const key = JSON.stringify([e.procedure, bank, e.emitted_index, e.source_line]);
      const target = kind.endsWith("_RESULT") ? results : requests;
      target.set(key, (target.get(key) ?? 0) + 1);
    }
  }
  if ([...requests].some(([k, n]) => n > (results.get(k) ?? 0))) issues.push("allocation requests lack corresponding result evidence");
  return issues;
}

/** Replay allocation and append events as a strict FIFO. */
export function replayFifo(events, { initial_queue = null, registers = null, list_address = null, emission_map = null, procedure = null } = {}) {
  const regHas = (r) => (registers instanceof Set ? registers.has(r) : registers.includes(r));
  const allEvents = [...events];
  const fifoEvents = allEvents.filter((e) => ["allocate", "append", "remove", "move-end"].includes(e.action) && e.register !== null);
  const procedures = new Set(fifoEvents.filter((e) => e.procedure !== null).map((e) => e.procedure));
  const unscoped = fifoEvents.filter((e) => e.procedure === null).length;
  if (procedure !== null && !procedures.has(procedure)) throw new ValueError(`trace contains no FIFO events for procedure ${procedure}`);
  if (procedure === null && procedures.size > 1) {
    throw new ValueError("trace contains multiple procedures; pass --proc to prevent FIFO events from different functions being combined");
  }
  const unscopedRequests = allEvents.some((e) => e.action === "free-request" && e.procedure === null);
  if (procedures.size && (unscoped || unscopedRequests)) {
    throw new ValueError("trace mixes procedure-scoped and unscoped events; recapture with one procedure-aware instrument rather than guessing ownership");
  }
  const selectedProcedure = procedure !== null ? procedure : procedures.size ? [...procedures][0] : null;
  const relevant = fifoEvents.filter((e) => (registers === null || regHas(e.register))
    && (list_address === null || e.action === "allocate" || e.list_address === list_address)
    && (selectedProcedure === null || e.procedure === selectedProcedure));
  const unresolvedRequests = allEvents.filter((e) => e.action === "free-request"
    && (selectedProcedure === null || e.procedure === selectedProcedure) && (registers === null || regHas(e.register)));
  const inferred = initial_queue === null;
  const seed = inferred ? inferInitialQueue(relevant) : [...(initial_queue ?? [])];
  const queue = [...seed];
  const live = new Map();
  const logical = [], allocations = [];
  const violations = allocationIssues(allEvents.filter((e) => selectedProcedure === null || e.procedure === selectedProcedure));
  if (allEvents.some((e) => ["append", "remove", "free-request", "move-end"].includes(e.action) && e.register === null
    && (selectedProcedure === null || e.procedure === selectedProcedure))) violations.push("queue control lacks a physical register");
  if (inferred) {
    const prefix = new Set();
    for (const e of relevant) {
      if (e.action === "allocate") break;
      if (e.action === "append" && e.register !== null) {
        if (prefix.has(e.register)) violations.push("initialization contains a duplicate ADD");
        prefix.add(e.register);
      } else if (e.action === "remove" && e.register !== null) prefix.delete(e.register);
    }
  }
  if (relevant.some((e) => e.action === "move-end")) violations.push("MOVE_END queue controls are not supported by this replay");
  if (unresolvedRequests.length) {
    violations.push("FREE/FORCE_FREE entry requests do not witness successful appends; complete FIFO replay requires transition evidence");
  }
  let nextValue = 1, maxLive = 0, seenAllocation = false;
  const mapGet = (k) => (emission_map instanceof Map ? emission_map.get(k) : emission_map?.[k]) ?? null;
  const joined = (e) => {
    const location = emission_map !== null && e.emitted_index !== null ? mapGet(e.emitted_index) : null;
    const objectRow = e.object_row !== null ? e.object_row : location !== null ? location.object_row : null;
    const sourceLine = e.source_line !== null ? e.source_line : location !== null ? location.source_line : null;
    const sourceFile = e.source_file !== null ? e.source_file : location !== null ? location.source_file : null;
    const instruction = location !== null ? location.instruction : null;
    return [objectRow, sourceLine, sourceFile, instruction];
  };
  const logicalOf = (action, value, e) => {
    const [object_row, source_line, source_file, instruction] = joined(e);
    return new LogicalEvent({ action, value, register: e.register, source_line, trace_line: e.index, emitted_index: e.emitted_index,
      object_row, source_file, instruction, procedure: e.procedure });
  };
  for (const e of relevant) {
    const register = e.register;
    if (register === null) continue;
    if ((e.action === "append" || e.action === "remove") && inferred && !seenAllocation) continue;
    if (e.action === "move-end") continue;
    if (e.action === "remove") {
      if (queue.includes(register)) queue.splice(queue.indexOf(register), 1);
      logical.push(logicalOf("remove", 0, e));
      continue;
    }
    if (e.action === "allocate") {
      seenAllocation = true;
      allocations.push(register);
      if (!queue.length) violations.push(`trace line ${e.index}: allocated ${registerName(register)} from an empty queue`);
      else {
        const expected = queue.shift();
        if (register !== expected) violations.push(`trace line ${e.index}: allocated ${registerName(register)}, FIFO head was ${registerName(expected)}`);
      }
      if (live.has(register)) violations.push(`trace line ${e.index}: ${registerName(register)} allocated while already live`);
      live.set(register, nextValue);
      logical.push(logicalOf("allocate", nextValue, e));
      nextValue += 1;
      maxLive = Math.max(maxLive, live.size);
    } else {
      let value = live.has(register) ? live.get(register) : null;
      live.delete(register);
      if (value === null && get(e.fields, "_event") !== "ADD") violations.push(`trace line ${e.index}: appended ${registerName(register)} without a live allocation`);
      if (value === null) value = 0;
      if (queue.includes(register)) violations.push(`trace line ${e.index}: appended duplicate ${registerName(register)}`);
      queue.push(register);
      logical.push(logicalOf("free", value, e));
    }
  }
  const firstAlloc = relevant.find((x) => x.action === "allocate");
  const firstAllocIndex = firstAlloc ? firstAlloc.index : Infinity;
  const countsDict = counter(allEvents.filter((e) => (selectedProcedure === null || e.procedure === selectedProcedure)
    && ["allocate", "allocation-request", "unsupported-allocation"].includes(e.action)).map((e) => get(e.fields, "_event") ?? e.action));
  return new FifoReplay({
    initialization_basis: !inferred ? "supplied-initial-state"
      : unresolvedRequests.some((e) => e.index < firstAllocIndex) ? "unresolved-prefix"
      : "replayed-add-remove-prefix; trace completeness not inferred",
    unresolved_free_requests: unresolvedRequests.length,
    initial_queue: seed, final_queue: queue, allocations, logical_events: logical, violations, max_live: maxLive,
    ignored_events: allEvents.length - relevant.length, procedure: selectedProcedure,
    allocation_event_counts: Object.fromEntries(countsDict.entries()),
  });
}

/** Return stable event, register, and source-line histograms. */
export function traceSummary(events) {
  const m = [...events];
  const tally = (items) => { const d = counter(items); return Object.fromEntries(sorted([...d.entries()], (e) => e[0])); };
  const byInt = (items) => { const d = counter(items); return Object.fromEntries(sorted([...d.entries()], (e) => parseInt(e[0], 10))); };
  return {
    events: m.length,
    actions: tally(m.map((e) => e.action)),
    registers: tally(m.filter((e) => e.register !== null && !["allocation-request", "unsupported-allocation"].includes(e.action)).map((e) => registerName(e.register))),
    allocation_descriptors: tally(m.filter((e) => e.register !== null && ["allocation-request", "unsupported-allocation"].includes(e.action))
      .map((e) => `${get(e.fields, "_event") ?? e.action}:${e.register}`)),
    source_lines: byInt(m.filter((e) => e.source_line !== null).map((e) => String(e.source_line))),
    procedures: byInt(m.filter((e) => e.procedure !== null).map((e) => String(e.procedure))),
  };
}

export const EMISSION_MAP_SCHEMA = "decomp-workbench-ugen-emission-map-v1";

/** Validate a durable emitted-index/object-row/source join document: Map emitted_index -> EmissionLocation. */
export function parseEmissionMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.schema !== EMISSION_MAP_SCHEMA) {
    throw new ValueError(`emission map schema must be ${EMISSION_MAP_SCHEMA}`);
  }
  const entries = value.entries;
  if (!Array.isArray(entries)) throw new ValueError("emission map entries must be a list");
  const result = new Map();
  const toInt = (v) => {
    if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
    if (typeof v === "boolean") return v ? 1 : 0;
    if (typeof v === "string" && /^\s*[-+]?\d+\s*$/.test(v)) return parseInt(v, 10);
    throw new TypeError("not an integer");
  };
  entries.forEach((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ValueError(`emission map entry ${index} must be an object`);
    let emittedIndex, objectRow;
    try { emittedIndex = toInt(raw.emitted_index); objectRow = toInt(raw.object_row); } catch {
      throw new ValueError(`emission map entry ${index} requires integer emitted_index and object_row`);
    }
    if (emittedIndex < 0 || objectRow < 0) throw new ValueError(`emission map entry ${index} indices must be non-negative`);
    if (result.has(emittedIndex)) throw new ValueError(`emission map emitted_index ${emittedIndex} is duplicated`);
    const sl = raw.source_line;
    const sourceLine = sl !== null && sl !== undefined ? toInt(sl) : null;
    if (sourceLine !== null && sourceLine < 1) throw new ValueError(`emission map entry ${index} source_line must be positive`);
    const sf = raw.source_file ?? null;
    if (sf !== null && typeof sf !== "string") throw new ValueError(`emission map entry ${index} source_file must be a string`);
    const ins = raw.instruction ?? null;
    if (ins !== null && typeof ins !== "string") throw new ValueError(`emission map entry ${index} instruction must be a string`);
    result.set(emittedIndex, new EmissionLocation({ emitted_index: emittedIndex, object_row: objectRow, source_line: sourceLine, source_file: sf, instruction: ins }));
  });
  return result;
}

/** Summarize the profiled uopt base-provenance and alias decisions. */
export function aliasTraceSummary(events) {
  const m = [...events].filter((e) => e.action === "base" || e.action === "alias-query");
  const bases = m.filter((e) => e.action === "base"), queries = m.filter((e) => e.action === "alias-query");
  const tally = (items) => Object.fromEntries(sorted([...counter(items).entries()], (e) => e[0]));
  const countField = (sel, name) => tally(sel.filter((e) => has(e.fields, name)).map((e) => e.fields[name]));
  return {
    events: m.length, base_events: bases.length, alias_queries: queries.length,
    base_paths: countField(bases, "path"), base_types: countField(bases, "type"), query_results: countField(queries, "result"),
    left_types: countField(queries, "left_type"), right_types: countField(queries, "right_type"),
    registers: tally(m.filter((e) => e.register !== null).map((e) => registerName(e.register))),
    queries: queries.map((e) => e.asDict()),
  };
}
