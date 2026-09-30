// shift-util.js - number formats and the column-aligned table the shift
// family of reports prints.
//
// Plain JS ESM + JSDoc.

/** `{n:,}`: thousands separators. */
export function comma(n) {
  const neg = n < 0;
  const s = String(Math.abs(Math.trunc(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return (neg ? "-" : "") + s;
}

/** `{n:+#x}`: sign always, then 0x-prefixed lowercase hex. */
export function signedHex(n) {
  return (n < 0 ? "-" : "+") + "0x" + Math.abs(n).toString(16);
}

/** `{n:#x}` */
export function prefixedHex(n) {
  return (n < 0 ? "-" : "") + "0x" + Math.abs(n).toString(16);
}

/** `{n:0Wx}` / `{n:x}` */
export function hexw(n, width = 0) {
  const neg = n < 0;
  return (neg ? "-" : "") + Math.abs(n).toString(16).padStart(Math.max(0, width - (neg ? 1 : 0)), "0");
}

/** `{n:+d}` */
export function signedInt(n) {
  return n < 0 ? String(n) : `+${n}`;
}

/** repr() of a list of ints: "[0, 16]". */
export function intList(values) {
  return `[${values.join(", ")}]`;
}

/** repr() of a tuple of strings/ints. */
export function reprList(values) {
  return `[${values.map((v) => (typeof v === "string" ? `'${v}'` : String(v))).join(", ")}]`;
}

/** Render one column-aligned table, the shape the shift family prints. */
export function table(header, rows) {
  if (!rows.length) return [header.join(" ")];
  const widths = header.map((h, c) => Math.max(h.length, ...rows.map((r) => r[c].length)));
  const lines = [header.map((h, c) => h.padEnd(widths[c])).join("  ").replace(/\s+$/, "")];
  for (const row of rows) lines.push(row.map((cell, c) => cell.padEnd(widths[c])).join("  ").replace(/\s+$/, ""));
  return lines;
}

/** int(value or 0) for a value read out of a JSON report. */
export function toInt(v) {
  if (!v) return 0;
  if (v === true) return 1;
  if (typeof v === "number") return Math.trunc(v);
  const s = String(v).trim();
  if (!/^[-+]?\d+$/.test(s.replace(/_/g, ""))) throw Object.assign(new Error(`invalid literal for int() with base 10: '${v}'`), { name: "ValueError" });
  return parseInt(s.replace(/_/g, ""), 10);
}

/** isinstance(value, int) for a value read out of a JSON report. */
export function isInt(v) { return (typeof v === "number" && Number.isInteger(v)) || typeof v === "boolean"; }
