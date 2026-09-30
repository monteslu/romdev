// cascade.js - one parsed CDX log, indexed the way a site query needs it,
// and the frame-offset spelling every CDX reader shares. This is the part of
// the allocator-cascade reader the lever and the frame ladder use; the
// per-round cascade construction is not part of romdev's diagnose path.
//
// Plain JS ESM + JSDoc.

import { readFileSync } from "node:fs";
import path from "node:path";
import { ValueError, pyInt, strRepr, sorted, strip, hex } from "./py.js";
import { parseGlobalcolorTrace, optionalInteger } from "./globalcolor.js";

/** A site could not be located, or a log did not carry what was asked. */
export class CascadeError extends ValueError {
  constructor(message) { super(message); this.name = "ValueError"; }
}

export const REQUIRED_RECORDS = Object.freeze(["p1dec", "webdetail"]);

/** One signed frame offset from any spelling a trace or reader uses. */
export function parseFrameOffset(value) {
  const text = strip(String(value)).toLowerCase();
  let number;
  try { number = pyInt(text, 0); } catch {
    throw new CascadeError(`${strRepr(value)} is not a frame offset; write it as the trace prints it `
      + "(0xfffffdf8), as a signed number (-520), or give --slot with --frame");
  }
  if (number >= 0x80000000 && number <= 0xFFFFFFFF) number -= 0x100000000;
  return number;
}

/** Render an offset the way the trace does, with the signed value beside it. */
export function formatFrameOffset(offset) {
  const word = offset >>> 0;
  return `0x${hex(word, 8)} (${offset >= 0 ? "+" : ""}${offset})`;
}

/** One parsed CDX log, indexed the way a site query needs it. */
export class CdxLog {
  constructor(text, { name }) {
    this.name = name;
    this.trace = parseGlobalcolorTrace(text);
    this.records = [...this.trace.decisions];
    this.kinds = new Map();
    for (const r of this.records) this.kinds.set(r.phase, (this.kinds.get(r.phase) ?? 0) + 1);
  }

  static read(p) {
    let text;
    try { text = new TextDecoder("utf-8", { fatal: false }).decode(readFileSync(p)); } catch (e) {
      throw new CascadeError(`cannot read ${p}: ${e.message}`);
    }
    if (!text.includes("[CDX]")) {
      throw new CascadeError(`${p} holds no [CDX] records. A cascade needs an instrumented build: compile with CDX_LOG=1 and keep the `
        + "compiler's stderr. `decomp-workbench trace-cascade --grammar` prints the records this reads.");
    }
    return new CdxLog(text, { name: path.basename(p) });
  }

  *of(kind) { for (const r of this.records) if (r.phase === kind) yield r; }

  missing(kinds) { return [...kinds].filter((k) => !this.kinds.get(k)); }

  require(kinds, { purpose }) {
    const absent = this.missing(kinds);
    if (!absent.length) return;
    throw new CascadeError(`${this.name} carries no ${absent.join("/")} record(s), which ${purpose} needs. Present: `
      + `${sorted([...this.kinds.keys()]).join(", ") || "nothing"}. The ${absent.join("/")} grammar is a campaign-local uopt patch, not `
      + "part of the shipped `instrument-uopt` profile -- see `trace-cascade --grammar`.");
  }

  /** Every frame offset a `webdetail` names, to its symbols. */
  frameOffsets() {
    const found = new Map();
    for (const r of this.of("webdetail")) {
      const raw = fieldOf(r, "raw10");
      const symbol = optionalInteger(fieldOf(r, "sym"));
      if (raw === null || symbol === null) continue;
      let offset;
      try { offset = parseFrameOffset(raw); } catch (e) { if (e instanceof CascadeError) continue; throw e; }
      if (!found.has(offset)) found.set(offset, new Set());
      found.get(offset).add(symbol);
    }
    return found;
  }

  websOfSymbol(symbol) {
    const seen = [];
    for (const r of this.records) {
      if (optionalInteger(fieldOf(r, "sym")) !== symbol) continue;
      const web = optionalInteger(fieldOf(r, "web"));
      if (web !== null && !seen.includes(web)) seen.push(web);
    }
    return seen;
  }

  symbolOfWeb(web) {
    for (const r of this.records) {
      if (optionalInteger(fieldOf(r, "web")) === web) {
        const symbol = optionalInteger(fieldOf(r, "sym"));
        if (symbol !== null) return symbol;
      }
    }
    return null;
  }

  webDetail(web) {
    for (const r of this.of("webdetail")) if (optionalInteger(fieldOf(r, "web")) === web) return { ...fieldsObject(r) };
    return {};
  }
}

/** A record's fields, whether the record keeps them in a Map or an object. */
export function fieldsObject(record) {
  const f = record.fields;
  if (f instanceof Map) return Object.fromEntries(f);
  if (f && typeof f.entries === "function" && !Array.isArray(f) && typeof f.get === "function") return Object.fromEntries(f.entries());
  return f ?? {};
}

/** `record.fields.get(key)` for either field container; null when absent. */
export function fieldOf(record, key) {
  const f = record.fields;
  if (f && typeof f.get === "function") { const v = f.get(key); return v === undefined ? null : v; }
  return f && Object.prototype.hasOwnProperty.call(f, key) ? f[key] : null;
}
