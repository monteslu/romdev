// census.js - `--census`: ask a question about a report and get it back as
// an exit code. 0 every predicate held; 3 at least one failed; 2 the census
// could not be evaluated (malformed, unknown key, or a non-scalar value).
//
// Plain JS ESM + JSDoc.

import { ValueError, pyInt, sorted, strRepr, pyStr, strip } from "./py.js";

export const CENSUS_FAILURE_EXIT = 3;
const ENTRY_SEPARATOR_RE = /,(?=[A-Za-z_][A-Za-z0-9_]*=)/;
const TRUE_WORDS = new Set(["true", "yes", "1"]);
const FALSE_WORDS = new Set(["false", "no", "0"]);
const EMPTY_WORDS = new Set(["none", "null", ""]);

/** One parsed KEY=VALUE question, with the key it will read. */
export class Predicate {
  constructor({ key, metric, expected }) { Object.assign(this, { key, metric, expected }); Object.freeze(this); }
}

/** One evaluated predicate. */
export class CensusResult {
  constructor({ key, expected, actual, passed }) { Object.assign(this, { key, expected, actual, passed }); Object.freeze(this); }
  get line() {
    const verdict = this.passed ? "PASS" : "FAIL";
    const detail = this.passed ? "" : ` (actual ${pyStr(this.actual)})`;
    return `census: ${verdict} ${this.key}=${this.expected}${detail}`;
  }
  asDict() { return { key: this.key, expected: this.expected, actual: this.actual, pass: this.passed }; }
}

function editDistance(left, right) {
  if (left === right) return 0;
  const l = [...left], r = [...right];
  let previous = Array.from({ length: r.length + 1 }, (_, i) => i);
  l.forEach((lc, row) => {
    const current = [row + 1, ...new Array(r.length).fill(0)];
    r.forEach((rc, col) => {
      const cost = lc === rc ? 0 : 1;
      current[col + 1] = Math.min(previous[col + 1] + 1, current[col] + 1, previous[col] + cost);
    });
    previous = current;
  });
  return previous[previous.length - 1];
}

function keysOf(allowed) { return allowed instanceof Map ? [...allowed.keys()] : Object.keys(allowed); }
function lookup(allowed, key) {
  if (allowed instanceof Map) return allowed.has(key) ? allowed.get(key) : null;
  return Object.prototype.hasOwnProperty.call(allowed, key) ? allowed[key] : null;
}

function suggest(key, allowed) {
  const names = keysOf(allowed);
  const prefixed = names.filter((n) => n !== key && n.startsWith(key));
  if (prefixed.length === 1) return prefixed[0];
  const scored = sorted(names.map((n) => [editDistance(key, n), n]));
  if (!scored.length || scored[0][0] > 2) return null;
  const closest = scored.filter(([d]) => d === scored[0][0]).map(([, n]) => n);
  return closest.length === 1 ? closest[0] : null;
}

/** Parse `--census` values against the keys one command reports. */
export function parseCensus(expressions, { allowed }) {
  const predicates = [];
  for (const expression of expressions ?? []) {
    for (const entry of expression.split(ENTRY_SEPARATOR_RE)) {
      const at = entry.indexOf("=");
      const key = at < 0 ? entry : entry.slice(0, at);
      const expected = at < 0 ? "" : entry.slice(at + 1);
      if (at < 0 || !key) {
        throw new ValueError(`census entry ${strRepr(entry)} is not KEY=VALUE; write --census aligned_register=0,frame=-128`);
      }
      const metric = lookup(allowed, key);
      if (metric === null || metric === undefined) {
        const suggestion = suggest(key, allowed);
        const hint = suggestion ? ` -- did you mean ${strRepr(suggestion)}?` : "";
        throw new ValueError(`unknown census key ${strRepr(key)}; this command reports ${keysOf(allowed).length} keys and --explain-keys prints them with their meanings${hint}`);
      }
      predicates.push(new Predicate({ key, metric, expected }));
    }
  }
  return predicates;
}

/** Compare one reported value with one written value, by the value's type. */
export function matches(actual, expected) {
  if (typeof actual === "boolean") {
    const word = strip(expected).toLowerCase();
    if (TRUE_WORDS.has(word)) return actual;
    if (FALSE_WORDS.has(word)) return !actual;
    throw new ValueError(`census value ${strRepr(expected)} is not true or false; this key reports a boolean`);
  }
  if (typeof actual === "number" && Number.isInteger(actual)) {
    try { return pyInt(expected, 0) === actual; } catch {
      throw new ValueError(`census value ${strRepr(expected)} is not an integer; this key reports a number`);
    }
  }
  if (actual === null || actual === undefined) return EMPTY_WORDS.has(strip(expected).toLowerCase());
  return expected === pyStr(actual);
}

/** Answer every predicate against one report payload. */
export function evaluateCensus(predicates, payload) {
  const results = [];
  for (const p of predicates) {
    if (!(p.metric in payload)) {
      throw new ValueError(`census key ${strRepr(p.key)} is not in this report; the option that produces it may not have been passed`);
    }
    const actual = payload[p.metric];
    if (actual !== null && typeof actual === "object") {
      throw new ValueError(`census key ${strRepr(p.key)} reports a ${Array.isArray(actual) ? "list" : "dict"}, not a single value; census predicates compare scalars`);
    }
    let passed;
    try { passed = matches(actual, p.expected); } catch (e) { throw new ValueError(`${e.message} (${p.key})`); }
    results.push(new CensusResult({ key: p.key, expected: p.expected, actual, passed }));
  }
  return results;
}

/** Return the census exit status, or the command's own status. */
export function censusStatus(results, { otherwise }) {
  return results.some((r) => !r.passed) ? CENSUS_FAILURE_EXIT : otherwise;
}
