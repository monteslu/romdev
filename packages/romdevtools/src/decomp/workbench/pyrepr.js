// pyrepr.js - repr() of plain values (None, bools, ints, floats, strings,
// lists, tuples, dicts) for the text reports that print a value the way the
// original printed it inside an f-string.
//
// Plain JS ESM + JSDoc.

import { PyDict, PyFloat, floatRepr, strRepr } from "./py.js";

/**
 * repr(value). Arrays print as lists; pass {tuple: true} for a tuple.
 * Plain objects, Maps and PyDicts print as dicts in insertion order.
 */
export function pyRepr(value, { tuple = false } = {}) {
  if (value === null || value === undefined) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  if (value instanceof PyFloat) return floatRepr(value.value);
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : floatRepr(value);
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") return strRepr(value);
  if (Array.isArray(value)) {
    const inner = value.map((v) => pyRepr(v)).join(", ");
    if (tuple) return value.length === 1 ? `(${inner},)` : `(${inner})`;
    return `[${inner}]`;
  }
  if (value instanceof Set) return value.size ? `{${[...value].map((v) => pyRepr(v)).join(", ")}}` : "set()";
  const entries = value instanceof PyDict || value instanceof Map ? [...value.entries()] : Object.entries(value);
  return `{${entries.map(([k, v]) => `${pyRepr(k)}: ${pyRepr(v)}`).join(", ")}}`;
}
