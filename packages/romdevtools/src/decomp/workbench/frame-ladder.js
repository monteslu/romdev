// frame-ladder.js - every stack slot one procedure owns, from a CDX log.
// `home(sp) = offset - frame`; declared locals sit at the top, cfe's pooled
// expression temps below them, uopt's own temps below those. `symtab`
// records are the whole itable; `webdetail` records name only the slots that
// reached the allocator, and each row says which source it came from.
//
// Plain JS ESM + JSDoc.

import { splitlines, strip, pyInt, strRepr, sorted } from "./py.js";
import { CascadeError, formatFrameOffset, parseFrameOffset, fieldOf } from "./cascade.js";
import { optionalInteger } from "./globalcolor.js";

export const LADDER_SCHEMA = "decomp-workbench-frame-ladder-v1";
export const OPS_SCHEMA = "decomp-workbench-frame-ops-v1";

export const ITABLE_KINDS = new Map([[0, "empty"], [1, "islda"], [2, "isconst"], [3, "isvar"], [4, "isop"], [5, "isilda"], [6, "issvar"], [7, "dumped"], [8, "isrconst"]]);
export const UOPT_OPCODES = new Map([[1, "uadd"], [4, "uand"], [10, "ucg1"], [11, "ucg1b"], [24, "ucvt"], [25, "ucvtl"], [35, "uequ"], [40, "ugeq"],
  [54, "uilod"], [63, "uistr"], [65, "uixa"], [78, "ules"], [91, "umpy"], [95, "uneq"], [116, "ushr"], [123, "ustr"], [125, "usub"]]);
export const STORAGE_CLASSES = new Map([[1, "M"], [2, "P"], [3, "R"]]);

const NAME_RE = /^\s*(?<key>[^\s=#]+)\s*[=\s]\s*(?<name>.+?)\s*$/;

function kindName(kind) { return kind === null ? "?" : ITABLE_KINDS.get(kind) ?? String(kind); }
function storageName(c) { return c === null ? null : STORAGE_CLASSES.get(c) ?? String(c); }

/** Parse a reader-supplied slot-name map into frame offsets. */
export function parseSlotNames(text, { frame = null } = {}) {
  const names = new Map();
  splitlines(text).forEach((raw, idx) => {
    const number = idx + 1;
    const line = strip(raw.split("#")[0]);
    if (!line) return;
    const m = NAME_RE.exec(line);
    if (!m) throw new CascadeError(`names line ${number}: ${strRepr(strip(raw))} is not \`OFFSET NAME\`; write \`-140 colour\` for a frame offset or \`sp:76 colour\` for an sp-relative slot`);
    const key = m.groups.key;
    let offset;
    if (key.toLowerCase().startsWith("sp:")) {
      if (frame === null) throw new CascadeError(`names line ${number}: an \`sp:\` slot needs --frame to become a frame offset (--frame -216)`);
      let slot;
      try { slot = pyInt(key.slice(3), 0); } catch { throw new CascadeError(`names line ${number}: ${strRepr(key)} is not an sp-relative slot`); }
      offset = slot + frame;
    } else offset = parseFrameOffset(key);
    names.set(offset, m.groups.name);
  });
  return names;
}

/** One `symtab` record: one entry of uopt's per-procedure itable. */
export class ItableEntry {
  constructor(f) {
    for (const k of ["index", "kind", "dtype", "symbol", "version", "offset", "tag", "storage_class", "size", "vreg", "opcode", "left", "right"]) this[k] = f[k] ?? null;
    Object.freeze(this);
  }
  get kind_name() { return kindName(this.kind); }
  get is_variable() { return this.kind === 3; }
  get is_operation() { return this.kind === 4; }
  get opcode_name() { return this.opcode === null ? "?" : UOPT_OPCODES.get(this.opcode) ?? String(this.opcode); }
  get storage_class_name() { return storageName(this.storage_class); }
  asDict() {
    return { index: this.index, kind: this.kind, kind_name: this.kind_name, dtype: this.dtype, symbol: this.symbol, version: this.version,
      offset: this.offset, tag: this.tag, storage_class: this.storage_class, storage_class_name: this.storage_class_name, size: this.size,
      vreg: this.vreg, opcode: this.opcode, opcode_name: this.is_operation ? this.opcode_name : null, left: this.left, right: this.right };
  }
}

/** One frame offset, with everything both record families say about it. */
export class Slot {
  constructor({ offset, home, name, indices, webs, size, vreg, dtype, storage_class, sources, tables }) {
    Object.assign(this, { offset, home, name, indices, webs, size, vreg, dtype, storage_class, sources, tables });
    Object.freeze(this);
  }
  get index() { return this.indices.length ? this.indices[0] : null; }
  get storage_class_name() { return storageName(this.storage_class); }
  asDict() {
    return { offset: this.offset, offset_text: formatFrameOffset(this.offset), home: this.home, name: this.name, index: this.index,
      indices: [...this.indices], webs: [...this.webs], size: this.size, vreg: this.vreg, dtype: this.dtype, storage_class: this.storage_class,
      storage_class_name: this.storage_class_name, sources: [...this.sources], ichain_tables: [...this.tables] };
  }
}

/** One procedure's stack slots, lowest offset first. */
export class Ladder {
  constructor({ log, proc, frame, slots, entries, sources, warnings }) {
    Object.assign(this, { log, proc, frame, slots, entries, sources, warnings });
    Object.freeze(this);
  }
  get named() { return this.slots.filter((s) => s.name); }
  get lowest_named_offset() { const n = this.named; return n.length ? Math.min(...n.map((s) => s.offset)) : null; }
  get below_named() {
    const floor = this.lowest_named_offset;
    if (floor === null) return [];
    return this.slots.filter((s) => s.name === null && s.offset < floor);
  }
  asDict() {
    return { schema: LADDER_SCHEMA, log: this.log, proc: this.proc, frame: this.frame, sources: [...this.sources], slot_count: this.slots.length,
      named_count: this.named.length, unnamed_count: this.slots.length - this.named.length,
      lowest_offset: this.slots.length ? this.slots[0].offset : null, lowest_named_offset: this.lowest_named_offset,
      temp_candidates: this.below_named.map((s) => s.offset), entry_count: this.entries.length,
      operation_count: this.entries.filter((e) => e.is_operation).length, slots: this.slots.map((s) => s.asDict()), warnings: [...this.warnings] };
  }
}

function matchesProc(record, proc) { return proc === null || optionalInteger(fieldOf(record, "proc")) === proc; }

/** The itable in log order, first record per index winning. */
export function itableEntries(log, { proc = null } = {}) {
  const seen = new Map();
  for (const r of log.of("symtab")) {
    if (!matchesProc(r, proc)) continue;
    const index = optionalInteger(fieldOf(r, "idx"));
    if (index === null || seen.has(index)) continue;
    if (fieldOf(r, "kind") === null) continue;
    const g = (k) => optionalInteger(fieldOf(r, k));
    seen.set(index, new ItableEntry({ index, kind: g("kind"), dtype: g("dtype"), symbol: g("selfidx"), version: g("ver"), offset: g("off"),
      tag: g("tag"), storage_class: g("class"), size: g("b24"), vreg: g("vreg"), opcode: g("op"), left: g("l"), right: g("r") }));
  }
  return sorted([...seen.keys()]).map((i) => seen.get(i));
}

function webdetailSlots(log, { proc }) {
  const found = new Map();
  for (const r of log.of("webdetail")) {
    if (!matchesProc(r, proc)) continue;
    const raw = fieldOf(r, "raw10");
    if (raw === null) continue;
    let offset;
    try { offset = parseFrameOffset(raw); } catch (e) { if (e instanceof CascadeError) continue; throw e; }
    if (offset >= 0) continue;
    if (!found.has(offset)) found.set(offset, { webs: [], tables: [], size: null, dtype: null, symbol: null });
    const entry = found.get(offset);
    const web = optionalInteger(fieldOf(r, "web"));
    if (web !== null && !entry.webs.includes(web)) entry.webs.push(web);
    const table = optionalInteger(fieldOf(r, "table"));
    if (table !== null && !entry.tables.includes(table)) entry.tables.push(table);
    if (entry.dtype === null) entry.dtype = optionalInteger(fieldOf(r, "dtype"));
    if (entry.symbol === null) entry.symbol = optionalInteger(fieldOf(r, "sym"));
    if (entry.size === null) {
      const raw18 = optionalInteger(fieldOf(r, "raw18"));
      if (raw18 !== null) entry.size = Number((BigInt(raw18) >> 24n) & 0xFFn);
    }
  }
  return found;
}

/** Build one procedure's frame ladder from whichever records exist. */
export function frameLadder(log, { frame = null, proc = null, names = null } = {}) {
  const entries = itableEntries(log, { proc });
  const webSlots = webdetailSlots(log, { proc });
  if (!entries.length && !webSlots.size) {
    throw new CascadeError(`${log.name} carries no symtab and no stack-resident webdetail record, so it names no frame slot. Present: `
      + `${sorted([...log.kinds.keys()]).join(", ") || "nothing"}. The whole itable needs CDX_SYMTAB=1 from patches/uopt-5.3-cdx-symtab.patch; the `
      + "allocator's subset of it needs CDX_LOG=1.");
  }
  names = names ?? new Map();
  const sources = [];
  if (entries.length) sources.push("symtab");
  if (webSlots.size) sources.push("webdetail");
  const collected = new Map();
  const blank = (src) => ({ indices: [], size: null, vreg: null, dtype: null, storage_class: null, sources: src });
  for (const e of entries) {
    if (!e.is_variable || e.offset === null) continue;
    if (!collected.has(e.offset)) collected.set(e.offset, blank(["symtab"]));
    const slot = collected.get(e.offset);
    slot.indices.push(e.index);
    if (slot.size === null) slot.size = e.size;
    if (slot.vreg === null) slot.vreg = e.vreg;
    if (slot.dtype === null) slot.dtype = e.dtype;
    if (slot.storage_class === null) slot.storage_class = e.storage_class;
  }
  for (const [offset, found] of webSlots) {
    if (!collected.has(offset)) collected.set(offset, blank([]));
    const slot = collected.get(offset);
    if (!slot.sources.includes("webdetail")) slot.sources.push("webdetail");
    if (slot.size === null) slot.size = found.size;
    if (slot.dtype === null) slot.dtype = found.dtype;
    if (!slot.indices.length && found.symbol !== null) slot.indices.push(found.symbol);
  }
  const slots = sorted([...collected.entries()], (x) => x[0]).map(([offset, v]) => new Slot({
    offset, home: frame === null ? null : offset - frame, name: names.get(offset) ?? null, indices: [...v.indices],
    webs: [...(webSlots.get(offset)?.webs ?? [])], size: v.size, vreg: v.vreg, dtype: v.dtype, storage_class: v.storage_class,
    sources: [...v.sources], tables: [...(webSlots.get(offset)?.tables ?? [])] }));
  const warnings = [];
  const placed = new Set(slots.map((s) => s.offset));
  const unplaced = sorted([...names.keys()].filter((o) => !placed.has(o)));
  if (unplaced.length) {
    warnings.push("named offset(s) absent from this log: " + unplaced.join(", ")
      + " -- a name map from another build names slots this one does not have, and an edit that removes a local moves every offset below it");
  }
  if (!entries.length && webSlots.size) {
    warnings.push("no symtab records: this ladder shows only the slots that reached the allocator, which is a subset of the frame. Rebuild with "
      + "CDX_SYMTAB=1 for the whole itable.");
  }
  return new Ladder({ log: log.name, proc, frame, slots, entries, sources, warnings });
}

export function ladderReport(ladder) { return ladder.asDict(); }

/** The two records `CDX_SYMTAB=1` adds, in the cascade grammar's shape. */
export const SYMTAB_RECORD_GRAMMAR = Object.freeze({
  symtabcount: "CAMPAIGN-LOCAL (patches/uopt-5.3-cdx-symtab.patch). The itable's size, once per procedure. proc n base.",
  symtab: "CAMPAIGN-LOCAL (patches/uopt-5.3-cdx-symtab.patch). One itable entry. proc idx kind name dtype selfidx bit ver off tag class b23 "
    + "b24 vreg op l r raw08..raw36 rec. `off` is the frame offset of an `isvar` and `b24` its access size in bytes; `op`/`l`/`r` belong to "
    + "an `isop` and nothing else. `name` is the itable KIND, not a symbol name: the input ucode has no names.",
});

function operandName(index, entries, names) {
  if (index === null || index === -1 || index === 0xFFFF) return ".";
  const entry = entries.get(index);
  if (!entry) return `#${index}`;
  if (entry.is_operation) return `op${index}`;
  if (entry.is_variable) {
    const label = entry.storage_class_name || "?";
    if (entry.offset !== null && names.has(entry.offset)) return `${names.get(entry.offset)}(${index})`;
    if (entry.offset !== null) return `${label}${entry.offset}(${index})`;
    return `${label}${index}`;
  }
  return `${entry.kind_name}${index}`;
}

/** The itable's operation stream, in creation (first-occurrence) order. */
export function opReport(ladder, { names = null, offsets = null } = {}) {
  if (!ladder.entries.length) {
    throw new CascadeError(`${ladder.log} carries no symtab records, so it has no operation stream. The itable dump needs CDX_SYMTAB=1 from `
      + "patches/uopt-5.3-cdx-symtab.patch.");
  }
  names = names ?? new Map();
  const byIndex = new Map(ladder.entries.map((e) => [e.index, e]));
  let wanted = null;
  if (offsets !== null) {
    const selected = new Set(offsets);
    wanted = new Set(ladder.entries.filter((e) => e.is_variable && selected.has(e.offset)).map((e) => e.index));
  }
  const rows = [];
  for (const e of ladder.entries) {
    if (!e.is_operation) continue;
    if (wanted !== null && !wanted.has(e.left) && !wanted.has(e.right)) continue;
    rows.push({ index: e.index, opcode: e.opcode, opcode_name: e.opcode_name, dtype: e.dtype, left: e.left, right: e.right,
      left_name: operandName(e.left, byIndex, names), right_name: operandName(e.right, byIndex, names) });
  }
  return { schema: OPS_SCHEMA, log: ladder.log, proc: ladder.proc, entry_count: ladder.entries.length,
    operation_count: ladder.entries.filter((e) => e.is_operation).length, selected_count: rows.length,
    selected_offsets: offsets === null ? null : sorted([...new Set(offsets)]), operations: rows };
}

/** Render the ladder the way a reader reads it: lowest slot first. */
export function* ladderLines(ladder) {
  const frame = ladder.frame === null ? "-" : String(ladder.frame);
  const temps = new Set(ladder.below_named.map((s) => s.offset));
  yield `frame ladder: ${ladder.log}  ${ladder.slots.length} slot(s)  frame=${frame}  source=${ladder.sources.join("+")}`;
  for (const slot of ladder.slots) {
    const home = slot.home === null ? "-" : `${slot.home}(sp)`;
    const index = slot.index === null ? "-" : String(slot.index);
    const size = slot.size === null ? "-" : String(slot.size);
    const vreg = slot.vreg === null ? "-" : String(slot.vreg);
    const webs = slot.webs.join(",") || "-";
    const name = slot.name || (temps.has(slot.offset) ? "temp?" : "-");
    yield `  ${String(slot.offset).padStart(6)} ${home.padStart(9)} idx=${index.padEnd(5)} size=${size.padEnd(3)} `
      + `vreg=${vreg.padEnd(3)} class=${(slot.storage_class_name || "-").padEnd(2)} webs=${webs.padEnd(12)} ${name}`;
  }
  const floor = ladder.lowest_named_offset;
  if (floor !== null) yield `  ${ladder.below_named.length} unnamed slot(s) below the lowest named offset ${floor}: compiler temps`;
  for (const w of ladder.warnings) yield `warning: ${w}`;
}
