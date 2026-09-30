// linked-compare.js - classify a build against the target image, by function
// image range. For code in a module that ships unrelocated no object-level
// oracle can reach zero; the linked image is what remains, and it is sound:
// if the built image equals the target over a function's bytes, the function
// is right. Per range: exact, text-exact (residue outside the range is
// collateral), text-differs (N words), size-differs. No build orchestration
// lives here; see docs/linked-oracle.md for the host-side loop.
//
// Plain JS ESM + JSDoc.

import { ValueError, pyInt, strip, strRepr, hex } from "./py.js";

export const LINKED_COMPARE_SCHEMA = "decomp-workbench-linked-compare-v1";
export const RANGES_SCHEMA = "decomp-workbench-image-ranges-v1";
export const CLASS_ORDER = Object.freeze(["exact", "text-exact", "text-differs", "size-differs"]);
const BLOCK = 4096;

const signed = (n) => (n >= 0 ? `+${n}` : String(n));

/** An image range is malformed, or names bytes outside the image. */
export class RangeError_ extends ValueError {}
export { RangeError_ as RangeError };

/** One function's byte range in the image, half-open. */
export class ImageRange {
  constructor({ name, start, end }) { Object.assign(this, { name, start, end }); Object.freeze(this); }
  get size() { return this.end - this.start; }
  contains(offset) { return this.start <= offset && offset < this.end; }
  asDict() { return { name: this.name, start: this.start, end: this.end, size: this.size }; }
}

/** What the built image says about one range. */
export class RangeVerdict {
  constructor({ name, start, end, klass, in_range_words = 0, in_range_bytes = 0, out_of_range_bytes = 0, first_in_range = null,
    first_out_of_range = null, size_delta = 0, past_image = false }) {
    Object.assign(this, { name, start, end, klass, in_range_words, in_range_bytes, out_of_range_bytes, first_in_range, first_out_of_range, size_delta, past_image });
    Object.freeze(this);
  }
  get summary() {
    if (this.klass === "text-differs") return `text-differs ${this.in_range_words} words`;
    if (this.klass === "size-differs") {
      if (!this.size_delta) return "size-differs (range past the image)";
      return `size-differs (${signed(this.size_delta)}${this.past_image ? ", range past the image" : ""})`;
    }
    if (this.klass === "text-exact") return `text-exact (collateral ${this.out_of_range_bytes} bytes)`;
    return "exact";
  }
  asDict() {
    return { name: this.name, start: this.start, end: this.end, class: this.klass, summary: this.summary, in_range_words: this.in_range_words,
      in_range_bytes: this.in_range_bytes, out_of_range_bytes: this.out_of_range_bytes, first_in_range: this.first_in_range,
      first_out_of_range: this.first_out_of_range, size_delta: this.size_delta, past_image: this.past_image };
  }
}

/** One build, one target, and a verdict per range. */
export class LinkedComparison {
  constructor({ built, target, built_size, target_size, differing_bytes, verdicts = [], first_difference = null }) {
    Object.assign(this, { built, target, built_size, target_size, differing_bytes, verdicts, first_difference });
    Object.freeze(this);
  }
  get size_delta() { return this.built_size - this.target_size; }
  get klass() {
    if (!this.verdicts.length) return this.size_delta ? "size-differs" : !this.differing_bytes ? "exact" : "text-exact";
    let worst = this.verdicts[0].klass;
    for (const v of this.verdicts) if (CLASS_ORDER.indexOf(v.klass) > CLASS_ORDER.indexOf(worst)) worst = v.klass;
    return worst;
  }
  get ok() { return this.klass === "exact" || this.klass === "text-exact"; }
  asDict() {
    return { schema: LINKED_COMPARE_SCHEMA, built: this.built, target: this.target, built_size: this.built_size, target_size: this.target_size,
      size_delta: this.size_delta, differing_bytes: this.differing_bytes, first_difference: this.first_difference, class: this.klass, ok: this.ok,
      ranges: this.verdicts.map((v) => v.asDict()) };
  }
}

/** Every offset at which the two images differ, in order (common prefix only). */
export function* differingOffsets(built, target) {
  const limit = Math.min(built.length, target.length);
  for (let base = 0; base < limit; base += BLOCK) {
    const stop = Math.min(base + BLOCK, limit);
    if (Buffer.compare(built.subarray(base, stop), target.subarray(base, stop)) === 0) continue;
    for (let o = base; o < stop; o++) if (built[o] !== target[o]) yield o;
  }
}

const typeNameOf = (v) => (typeof v === "number" ? (Number.isInteger(v) ? "int" : "float") : Array.isArray(v) ? "list" : typeof v === "object" ? "dict" : typeof v);

function integer(value, where) {
  if (typeof value === "boolean" || value === null || value === undefined) throw new RangeError_(`${where}: expected an integer`);
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string") {
    try { return pyInt(strip(value), 0); } catch { throw new RangeError_(`${where}: ${strRepr(value)} is not an integer`); }
  }
  throw new RangeError_(`${where}: expected an integer, got ${typeNameOf(value)}`);
}

function makeRange(name, start, end) {
  if (start < 0) throw new RangeError_(`${name}: a negative start (0x${hex(start)}) names no bytes`);
  if (end <= start) throw new RangeError_(`${name}: end 0x${hex(end)} is not past start 0x${hex(start)}; an empty range would report \`text-exact\` for a function nobody compared`);
  return new ImageRange({ name, start, end });
}

/** Read image ranges from the host's JSON document ({ranges:[...]} or a list). */
export function parseRanges(payload, { origin = "ranges" } = {}) {
  let entries;
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const schema = payload.schema;
    if (schema !== undefined && schema !== null && schema !== RANGES_SCHEMA) throw new RangeError_(`${origin}: unknown schema ${strRepr(schema)}; expected ${strRepr(RANGES_SCHEMA)}`);
    entries = payload.ranges ?? [];
  } else entries = payload;
  if (!Array.isArray(entries)) throw new RangeError_(`${origin}: expected a list of ranges`);
  const out = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new RangeError_(`${origin}: each range must be a JSON object`);
    const name = entry.name;
    if (typeof name !== "string" || !strip(name)) throw new RangeError_(`${origin}: each range needs a non-empty 'name'`);
    const start = integer(entry.start, `${origin}: ${name} start`);
    let end;
    if (entry.end !== undefined && entry.end !== null) end = integer(entry.end, `${origin}: ${name} end`);
    else if (entry.size !== undefined && entry.size !== null) end = start + integer(entry.size, `${origin}: ${name} size`);
    else throw new RangeError_(`${origin}: ${name} needs an 'end' or a 'size'`);
    out.push(makeRange(name, start, end));
  }
  return out;
}

const partition = (s, sep) => { const i = s.indexOf(sep); return i < 0 ? [s, "", ""] : [s.slice(0, i), sep, s.slice(i + sep.length)]; };

/** Read one NAME:START:END or NAME:START+SIZE command-line range. */
export function parseRangeArgument(text) {
  const [name, sep, rest] = partition(text, ":");
  if (!sep || !strip(name)) throw new RangeError_(`${strRepr(text)}: expected NAME:START:END or NAME:START+SIZE`);
  if (rest.includes("+")) {
    const [startText, , sizeText] = partition(rest, "+");
    const start = integer(startText, `${name} start`);
    return makeRange(name, start, start + integer(sizeText, `${name} size`));
  }
  const [startText, sep2, endText] = partition(rest, ":");
  if (!sep2) throw new RangeError_(`${strRepr(text)}: expected NAME:START:END or NAME:START+SIZE`);
  return makeRange(name, integer(startText, `${name} start`), integer(endText, `${name} end`));
}

function bisectLeft(a, x) { let lo = 0, hi = a.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (a[mid] < x) lo = mid + 1; else hi = mid; } return lo; }

/** Compare two images and classify each range the host named. */
export function compareImages(built, target, ranges = [], { built_name = "built", target_name = "target" } = {}) {
  const offsets = [...differingOffsets(built, target)];
  const sizeDelta = built.length - target.length;
  const comparable = Math.min(built.length, target.length);
  const verdicts = [];
  for (const item of ranges) {
    const low = bisectLeft(offsets, item.start), high = bisectLeft(offsets, item.end);
    const inside = offsets.slice(low, high);
    const outsideCount = offsets.length - inside.length;
    let firstOutside = null;
    if (low > 0) firstOutside = offsets[0];
    else if (high < offsets.length) firstOutside = offsets[high];
    const pastImage = item.end > comparable;
    const klass = sizeDelta || pastImage ? "size-differs" : inside.length ? "text-differs" : outsideCount ? "text-exact" : "exact";
    verdicts.push(new RangeVerdict({ name: item.name, start: item.start, end: item.end, klass,
      in_range_words: new Set(inside.map((o) => o & ~3)).size, in_range_bytes: inside.length, out_of_range_bytes: outsideCount,
      first_in_range: inside.length ? inside[0] : null, first_out_of_range: firstOutside, size_delta: sizeDelta, past_image: pastImage }));
  }
  return new LinkedComparison({ built: built_name, target: target_name, built_size: built.length, target_size: target.length,
    differing_bytes: offsets.length, verdicts, first_difference: offsets.length ? offsets[0] : null });
}

/** The comparison as the table a reader reads first. */
export function render(c) {
  const lines = [
    `linked-compare ${c.built} against ${c.target}`,
    `  image           ${c.built_size} bytes vs ${c.target_size} bytes (${signed(c.size_delta)}), ${c.differing_bytes} differing byte(s)`,
  ];
  if (c.first_difference !== null) lines.push(`  first difference 0x${hex(c.first_difference)}`);
  if (!c.verdicts.length) lines.push("  ranges          none supplied; image-level verdict only");
  else {
    lines.push(`  ${"range".padEnd(34)} ${"class".padEnd(16)} ${"words".padStart(6)} ${"collateral".padStart(11)}  first`);
    for (const v of c.verdicts) {
      const first = v.first_in_range !== null ? `0x${hex(v.first_in_range)}` : v.first_out_of_range !== null ? `outside 0x${hex(v.first_out_of_range)}` : "-";
      lines.push(`  ${v.name.padEnd(34)} ${v.klass.padEnd(16)} ${String(v.in_range_words).padStart(6)} ${String(v.out_of_range_bytes).padStart(11)}  ${first}`);
    }
  }
  lines.push(`  verdict         ${c.klass}`);
  return lines;
}
