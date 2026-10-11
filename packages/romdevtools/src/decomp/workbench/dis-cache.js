// dis-cache.js - a disassembly cache that cannot answer "perfect" because
// it was truncated. An entry is trusted only when it proves it is a complete
// disassembly of THIS object: its header names the object's SHA-256, the
// section, the symbol filter and its own row count; the body must parse to
// that count; and a whole-section entry must hold as many rows as the ELF
// section holds words. Anything else is discarded, rebuilt, and reported.
//
// Plain JS ESM + JSDoc.

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { ValueError, reEscape } from "./py.js";
import { readSection } from "./elf-instructions.js";
import { displayPath } from "./model.js";
import { dumpObject, parseDisassembly } from "./objdump.js";
import { fileSha256 } from "./evidence.js";

export const CACHE_HEADER_PREFIX = "#decomp-workbench-disassembly-cache-v1";
const HEADER_RE = new RegExp("^" + reEscape(CACHE_HEADER_PREFIX) + String.raw`\s+(?<fields>.*)$`);

/** A disassembly could not be trusted, and no fallback would be valid. */
export class DisassemblyCacheError extends ValueError { constructor(message) { super(message); this.kind = "DisassemblyCacheError"; } }

/** What happened to one cache entry, and why. */
export class CacheEvent {
  constructor({ object_path, status, reason = null }) { Object.assign(this, { object_path, status, reason }); Object.freeze(this); }
  asDict() { return { object: this.object_path, status: this.status, reason: this.reason }; }
  toString() { return this.reason === null ? `${this.status}: ${this.object_path}` : `${this.status}: ${this.object_path} (${this.reason})`; }
}

function sectionWords(p, section) {
  try {
    const raw = readSection(p, section);
    if (raw === null || raw === undefined) return null;
    return Math.floor(raw.length / 4);
  } catch { return null; }
}

function rowCountProblem(rows, { expected_words, symbol }) {
  if (rows === 0) return "it parsed to no instructions at all";
  if (expected_words !== null && rows !== expected_words) return `it parsed to ${rows} row(s) for a section holding ${expected_words} instruction word(s)`;
  return null;
}

const realResolve = (p) => { const abs = path.resolve(String(p)); try { return fs.realpathSync(abs); } catch { return abs; } };

/** A validated, content-addressed store of objdump text (no default directory). */
export class DisassemblyCache {
  constructor({ directory, objdump = null, events = [] }) { this.directory = String(directory); this.objdump = objdump; this.events = events; }
  get rejections() { return this.events.filter((e) => e.status === "rejected"); }

  entryPath(objectPath, { symbol, section }) {
    const key = [realResolve(objectPath), symbol || "", section].join("\0");
    return path.join(this.directory, `${createHash("sha256").update(Buffer.from(key, "utf8")).digest("hex")}.objdump`);
  }

  load(objectPath, { symbol = null, section = ".text" } = {}) {
    const p = String(objectPath);
    const display = displayPath(p);
    const digest = fileSha256(p);
    const expected = symbol === null ? sectionWords(p, section) : null;
    const entry = this.entryPath(p, { symbol, section });
    const cached = this.readEntry(entry, { display, digest, expected_words: expected });
    if (cached !== null) { this.events.push(new CacheEvent({ object_path: display, status: "hit" })); return cached; }
    const [text, instructions] = dumpObject(p, { objdump: this.objdump, symbol, section });
    const reason = rowCountProblem(instructions.length, { expected_words: expected, symbol });
    if (reason !== null) {
      throw new DisassemblyCacheError(`the disassembly of ${display} does not describe the whole object: ${reason}. `
        + "This is not a cache problem -- the object and its disassembly disagree. Check that --section names the "
        + "section the code is in, and that objdump is a MIPS-capable build.");
    }
    this.writeEntry(entry, { text, digest, rows: instructions.length, symbol, section });
    return [text, instructions];
  }

  readEntry(entry, { display, digest, expected_words }) {
    let raw;
    try { raw = fs.readFileSync(entry, "utf8"); } catch (e) {
      if (e.code === "ENOENT") { this.events.push(new CacheEvent({ object_path: display, status: "miss" })); return null; }
      this.reject(display, `unreadable (${e.message})`); return null;
    }
    if (!raw.trim()) { this.reject(display, "empty cache entry (an interrupted write)"); return null; }
    const nl = raw.indexOf("\n");
    const header = nl < 0 ? raw : raw.slice(0, nl), body = nl < 0 ? "" : raw.slice(nl + 1);
    const m = HEADER_RE.exec(header.trim());
    if (!m) { this.reject(display, "missing or unrecognized cache header"); return null; }
    const fields = {};
    for (const item of m.groups.fields.split(/\s+/).filter(Boolean)) { const i = item.indexOf("="); if (i >= 0) fields[item.slice(0, i)] = item.slice(i + 1); }
    if (fields.sha256 !== digest) { this.reject(display, "the object changed since the entry was written"); return null; }
    if (!/^\s*[-+]?\d+\s*$/.test(fields.rows ?? "")) { this.reject(display, "cache header does not declare a row count"); return null; }
    const declared = parseInt(fields.rows, 10);
    const instructions = parseDisassembly(body);
    if (instructions.length !== declared) { this.reject(display, `truncated: header declares ${declared} row(s), the body parses to ${instructions.length}`); return null; }
    if (expected_words !== null && declared !== expected_words) { this.reject(display, `short: ${declared} row(s) cached for a section holding ${expected_words} instruction word(s)`); return null; }
    return [body, instructions];
  }

  reject(display, reason) { this.events.push(new CacheEvent({ object_path: display, status: "rejected", reason })); }

  writeEntry(entry, { text, digest, rows, symbol, section }) {
    fs.mkdirSync(this.directory, { recursive: true });
    const header = `${CACHE_HEADER_PREFIX} sha256=${digest} rows=${rows} section=${section} symbol=${symbol || "-"}`;
    const temporary = entry + ".partial";
    fs.writeFileSync(temporary, `${header}\n${text}`, "utf8");
    fs.renameSync(temporary, entry);
  }
}
