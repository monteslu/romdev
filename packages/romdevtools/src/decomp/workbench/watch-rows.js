// watch-rows.js - a fixed watchlist of positional rows, rendered as
// healed/broken columns: `.` healed, `X` broken, `?` out of range (neither
// stream has the row; never silently counted as healed).
//
// Plain JS ESM + JSDoc.

import fs from "node:fs";
import os from "node:os";
import { ValueError, strip, strRepr, sorted } from "./py.js";

export const WATCH_ROWS_SCHEMA = "decomp-workbench-watch-rows-v1";
export const HEALED = ".";
export const BROKEN = "X";
export const OUT_OF_RANGE = "?";

export class WatchRowError extends ValueError {}

export class WatchRow {
  constructor({ row, label }) { this.row = row; this.label = label; Object.freeze(this); }
  asDict() { return { row: this.row, label: this.label }; }
}

export class WatchRowResult {
  constructor({ row, label, healed, difference = null, target = null, candidate = null }) {
    Object.assign(this, { row, label, healed, difference, target, candidate });
    Object.freeze(this);
  }
  get column() { return this.healed === null ? OUT_OF_RANGE : this.healed ? HEALED : BROKEN; }
  asDict() {
    return { row: this.row, label: this.label, healed: this.healed, column: this.column, class: this.difference, target: this.target, candidate: this.candidate };
  }
}

const LABEL_RE = /^(?<label>[A-Za-z_][A-Za-z0-9_.-]*)=(?<row>\d+)$/;

/** repr() of a JSON-derived value, for messages that quote it. */
export function pyRepr(v) {
  if (v === null || v === undefined) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  if (typeof v === "string") return strRepr(v);
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : String(v);
  if (Array.isArray(v)) return `[${v.map(pyRepr).join(", ")}]`;
  if (typeof v === "object") return `{${Object.entries(v).map(([k, x]) => `${strRepr(k)}: ${pyRepr(x)}`).join(", ")}}`;
  return String(v);
}

const isInt = (v) => typeof v === "number" && Number.isInteger(v);

function rowEntry(item, { origin }) {
  if (typeof item === "boolean") throw new WatchRowError(`${origin}: ${pyRepr(item)} is not a row number`);
  if (isInt(item)) return new WatchRow({ row: item, label: String(item) });
  if (item && typeof item === "object" && !Array.isArray(item)) {
    if (!("row" in item)) throw new WatchRowError(`${origin}: an object entry needs a "row" key; got ${pyRepr(sorted(Object.keys(item)))}`);
    const row = item.row;
    if (typeof row === "boolean" || !isInt(row)) throw new WatchRowError(`${origin}: "row" must be an integer, got ${pyRepr(row)}`);
    const label = item.label || item.name || String(row);
    return new WatchRow({ row, label: String(label) });
  }
  throw new WatchRowError(`${origin}: ${pyRepr(item)} is neither a row number nor an object with a "row" key`);
}

function fromJson(payload, { origin }) {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    if ("rows" in payload) {
      if (!Array.isArray(payload.rows)) throw new WatchRowError(`${origin}: "rows" must be a list`);
      return payload.rows.map((i) => rowEntry(i, { origin }));
    }
    return Object.entries(payload).map(([label, row]) => {
      if (typeof row === "boolean" || !isInt(row)) throw new WatchRowError(`${origin}: ${strRepr(label)} maps to ${pyRepr(row)}, not a row number`);
      return new WatchRow({ row, label: String(label) });
    });
  }
  if (Array.isArray(payload)) return payload.map((i) => rowEntry(i, { origin }));
  throw new WatchRowError(`${origin}: expected a list of rows, a {label: row} object, or an object with a "rows" list`);
}

/** Read `49,1620` / `r49=49,cx2=1620` / `@probes.json`. */
export function parseWatchRows(spec, { cwd = process.cwd() } = {}) {
  if (spec === null || spec === undefined) return [];
  const text = strip(spec);
  if (!text) throw new WatchRowError("--watch-rows was given an empty specification");
  let rows;
  if (text.startsWith("@")) {
    const raw = text.slice(1);
    const location = raw === "~" || raw.startsWith("~/") ? os.homedir() + raw.slice(1) : raw;
    let body;
    try { body = fs.readFileSync(location.startsWith("/") ? location : `${cwd}/${location}`, "utf8"); }
    catch (e) { throw new WatchRowError(`cannot read the watch-row file: [Errno 2] No such file or directory: '${location}'`); }
    let payload;
    try { payload = JSON.parse(body); } catch (e) { throw new WatchRowError(`${location} is not valid JSON: ${e.message}`); }
    rows = fromJson(payload, { origin: location });
  } else {
    rows = [];
    for (const token of text.split(",").map((t) => strip(t))) {
      if (!token) continue;
      const m = LABEL_RE.exec(token);
      if (m) { rows.push(new WatchRow({ row: parseInt(m.groups.row, 10), label: m.groups.label })); continue; }
      if (!/^\d+$/.test(token)) {
        throw new WatchRowError(`${strRepr(token)} is not a row number or a LABEL=ROW pair. --watch-rows takes 49,1620,1677 or r49=49,cx2=1620, or @probes.json for a named set`);
      }
      rows.push(new WatchRow({ row: parseInt(token, 10), label: token }));
    }
  }
  if (!rows.length) throw new WatchRowError("--watch-rows selected no rows");
  const seen = new Map();
  for (const entry of rows) {
    if (entry.row < 0) throw new WatchRowError(`row ${entry.row} is negative; rows are 0-based`);
    if (seen.has(entry.row)) throw new WatchRowError(`row ${entry.row} is watched twice (${strRepr(seen.get(entry.row))} and ${strRepr(entry.label)}); one row is one column`);
    seen.set(entry.row, entry.label);
  }
  return rows;
}

const siteGet = (s, k) => (s && typeof s.get === "function" ? s.get(k) : s?.[k]);

/** Score each watched row against one comparison's differing sites. */
export function evaluateWatchRows(rows, { diff_sites, compared_rows }) {
  const sites = new Map();
  for (const site of diff_sites) sites.set(Math.trunc(Number(siteGet(site, "index"))), site);
  return rows.map((entry) => {
    if (entry.row >= compared_rows) return new WatchRowResult({ row: entry.row, label: entry.label, healed: null });
    const site = sites.get(entry.row);
    if (site === undefined) return new WatchRowResult({ row: entry.row, label: entry.label, healed: true });
    const cls = siteGet(site, "class"), t = siteGet(site, "target"), c = siteGet(site, "candidate");
    return new WatchRowResult({ row: entry.row, label: entry.label, healed: false, difference: cls ? String(cls) : null,
      target: t === null || t === undefined ? null : String(t), candidate: c === null || c === undefined ? null : String(c) });
  });
}

export function watchSignature(results) { return results.map((r) => r.column).join(""); }

export function watchRowPayload(results) {
  return {
    watch_schema: WATCH_ROWS_SCHEMA,
    watch_rows: results.map((r) => r.asDict()),
    watch_signature: watchSignature(results),
    watch_healed: results.filter((r) => r.healed === true).length,
    watch_broken: results.filter((r) => r.healed === false).length,
    watch_out_of_range: results.filter((r) => r.healed === null).length,
  };
}

export function watchRowLines(results) {
  if (!results.length) return [];
  const widths = results.map((r) => Math.max(r.label.length, 1));
  const header = results.map((r, i) => r.label.padEnd(widths[i])).join(" ");
  const columns = results.map((r, i) => r.column.padEnd(widths[i])).join(" ");
  const healed = results.filter((r) => r.healed === true).length;
  const broken = results.filter((r) => r.healed === false).length;
  const missing = results.filter((r) => r.healed === null).length;
  let tally = `${healed} healed, ${broken} broken`;
  if (missing) tally += `, ${missing} out of range`;
  const lines = [`watch rows (${HEALED}=healed ${BROKEN}=broken` + (missing ? ` ${OUT_OF_RANGE}=out of range` : "") + `): ${tally}`,
    `  ${header}`, `  ${columns}`, `  signature=${watchSignature(results)}`];
  for (const item of results) {
    if (item.healed === null) { lines.push(`  [${String(item.row).padStart(5)}] ${item.label}: past the end of the comparison; neither object has this row`); continue; }
    if (item.healed) continue;
    lines.push(`  [${String(item.row).padStart(5)}] ${item.label}: ${item.difference || "differs"}`);
    if (item.target !== null) lines.push(`          target    ${item.target}`);
    if (item.candidate !== null) lines.push(`          candidate ${item.candidate}`);
  }
  return lines;
}
