// pyjson.js - the workbench's JSON document renderer: two-space indent,
// sorted keys, ASCII-only output, floats in shortest round-trip form with a
// decimal point. Reports are rendered through this and parsed back, so a
// consumer sees exactly the key order and values the documents always had.
//
// Plain JS ESM + JSDoc.

import { PyDict, PySet, PyFloat, floatRepr, pyCmp } from "./py.js";

function escapeString(s) {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const ch = s[i];
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (ch === "\b") out += "\\b";
    else if (ch === "\f") out += "\\f";
    else if (c < 0x20 || c > 0x7e) out += `\\u${c.toString(16).padStart(4, "0")}`;
    else out += ch;
  }
  return out + '"';
}

function number(v) {
  if (Number.isNaN(v)) return "NaN";
  if (v === Infinity) return "Infinity";
  if (v === -Infinity) return "-Infinity";
  return Number.isInteger(v) && !Object.is(v, -0) ? String(v) : floatRepr(v);
}

function keyText(k) {
  if (typeof k === "string") return k;
  if (k === true) return "true";
  if (k === false) return "false";
  if (k === null || k === undefined) return "null";
  if (k instanceof PyFloat) return floatRepr(k.value);
  if (typeof k === "number") return number(k);
  throw new TypeError(`keys must be str, int, float, bool or None, not ${typeof k}`);
}

function entriesOf(v) {
  if (v instanceof PyDict || v instanceof Map) return [...v.entries()];
  return Object.entries(v).filter(([, x]) => x !== undefined);
}

/**
 * Render like `json.dumps(value, indent=2, sort_keys=True)`.
 * @param {any} value
 * @param {{indent?: number|null, sortKeys?: boolean}} [opts]
 */
export function dumps(value, { indent = 2, sortKeys = true } = {}) {
  const nl = indent === null ? "" : "\n";
  const itemSep = indent === null ? ", " : ",";
  const enc = (v, depth) => {
    if (v === null || v === undefined) return "null";
    if (v === true) return "true";
    if (v === false) return "false";
    if (v instanceof PyFloat) return Number.isFinite(v.value) ? floatRepr(v.value) : number(v.value);
    if (typeof v === "number") return number(v);
    if (typeof v === "bigint") return v.toString();
    if (typeof v === "string") return escapeString(v);
    const pad = indent === null ? "" : " ".repeat(indent * (depth + 1));
    const close = indent === null ? "" : " ".repeat(indent * depth);
    if (Array.isArray(v) || v instanceof PySet || v instanceof Set) {
      const items = [...v];
      if (!items.length) return "[]";
      return "[" + nl + items.map((x) => pad + enc(x, depth + 1)).join(itemSep + nl) + nl + close + "]";
    }
    if (typeof v === "object") {
      if (typeof v.toJSON === "function" && !(v instanceof PyDict) && !(v instanceof Map)) return enc(v.toJSON(), depth);
      let items = entriesOf(v);
      if (sortKeys) items = items.slice().sort((a, b) => pyCmp(a[0], b[0]));
      if (!items.length) return "{}";
      return "{" + nl + items.map(([k, x]) => pad + escapeString(keyText(k)) + ": " + enc(x, depth + 1)).join(itemSep + nl) + nl + close + "}";
    }
    throw new TypeError(`Object of type ${typeof v} is not JSON serializable`);
  };
  return enc(value, 0);
}

/** The workbench's `render_json`: dumps plus a trailing newline. */
export function renderJson(value) { return dumps(value) + "\n"; }
