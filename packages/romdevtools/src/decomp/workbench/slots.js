// slots.js - which stack slot holds what, and how many rows touch it: the
// census that prices a fusion donor (rows touching its slot) and exposes a
// pun (two access widths at one offset). It never claims which C local lives
// at a slot; the volatile probe (a build, not a read) is what answers that.
//
// Plain JS ESM + JSDoc.

import fs from "node:fs";
import path from "node:path";
import { CSourceError, declarationLine, scanStatements, stripNoncode } from "./csource.js";
import { frameSize } from "./compare.js";
import { sorted, strip, lstrip } from "./py.js";

export const SLOTS_SCHEMA = "decomp-workbench-stack-slots-v1";

const ACCESS_RE = /^(?<op>l[bhwd]u?|lwc1|ldc1|s[bhwd]|swc1|sdc1)\s+(?<reg>\$?[\w$]+)\s*,\s*(?<offset>-?\d+)\((?:\$)?sp\)/;
const ADDRESS_RE = /^addiu\s+(?<reg>\$?[\w$]+)\s*,\s*(?:\$)?sp\s*,\s*(-?\d+)/;
const WIDTHS = { lb: 1, lbu: 1, sb: 1, lh: 2, lhu: 2, sh: 2, lw: 4, sw: 4, lwc1: 4, swc1: 4, ld: 8, sd: 8, ldc1: 8, sdc1: 8 };

export class SlotTraffic {
  constructor(f) { Object.assign(this, f); Object.freeze(this); }
  get total() { return this.loads + this.stores; }
  get punned() { return this.widths.length > 1; }
  asDict() {
    return { offset: this.offset, loads: this.loads, stores: this.stores, total: this.total, address_taken: this.address_taken,
      widths: [...this.widths], punned: this.punned, registers: [...this.registers], rows: [...this.rows] };
  }
}

const noDollar = (s) => (s.startsWith("$") ? s.slice(1) : s);

/** The frame's slot traffic, one entry per offset touched. */
export function slotReport(instructions, { label, rows = null, minimum = 1 }) {
  const frame = frameSize(instructions.map((i) => i.assembly).join("\n"));
  const [low, high] = rows !== null ? rows : [1, instructions.length];
  const loads = new Map(), stores = new Map(), addresses = new Map(), widths = new Map(), registers = new Map(), touched = new Map();
  const inc = (m, k) => m.set(k, (m.get(k) ?? 0) + 1);
  instructions.forEach((item, i) => {
    const index = i + 1;
    if (!(low <= index && index <= high)) return;
    const text = strip(item.assembly);
    const access = ACCESS_RE.exec(text);
    if (access) {
      const offset = parseInt(access.groups.offset, 10);
      const op = access.groups.op;
      inc(op.startsWith("s") ? stores : loads, offset);
      if (!widths.has(offset)) widths.set(offset, new Set());
      widths.get(offset).add(WIDTHS[op] ?? 0);
      if (!registers.has(offset)) registers.set(offset, new Set());
      registers.get(offset).add(noDollar(access.groups.reg));
      if (!touched.has(offset)) touched.set(offset, []);
      touched.get(offset).push(index);
      return;
    }
    const address = ADDRESS_RE.exec(text);
    if (address && noDollar(address.groups.reg) !== "sp") {
      const offset = parseInt(address[2], 10);
      inc(addresses, offset);
      if (!touched.has(offset)) touched.set(offset, []);
      touched.get(offset).push(index);
    }
  });
  const offsets = sorted([...new Set([...loads.keys(), ...stores.keys(), ...addresses.keys()])]);
  const entries = offsets.map((offset) => new SlotTraffic({ offset, loads: loads.get(offset) ?? 0, stores: stores.get(offset) ?? 0,
    address_taken: addresses.get(offset) ?? 0, widths: sorted([...(widths.get(offset) ?? [])]), registers: sorted([...(registers.get(offset) ?? [])]),
    rows: [...(touched.get(offset) ?? [])] }));
  const kept = entries.filter((e) => e.total + e.address_taken >= minimum);
  const entry = (item) => ({ ...item.asDict(), frame_offset: frame === null ? null : item.offset + frame });
  return {
    schema: SLOTS_SCHEMA, object: label, rows: [low, Math.min(high, instructions.length)], frame, slot_count: kept.length,
    row_count: instructions.length, touched_rows: kept.reduce((a, e) => a + e.total, 0), slots: kept.map(entry),
    cheapest: sorted(kept.filter((e) => e.total), (e) => e.total).slice(0, 5).map(entry),
    reading: "counts of what this object's rows do to each sp-relative stack slot -- the 1184 in `lwc1 $f10,1184(sp)`. It does not say which "
      + "C local lives at a slot: nothing in an object says so, and the measurement that does is a build (see `--volatile-probe`).",
  };
}

const DECLARATION_RE = /^\s+(?:const\s+|volatile\s+|unsigned\s+|signed\s+|struct\s+|union\s+)*(?<type>[A-Za-z_]\w*)\s+(?<stars>\**)\s*(?<name>[A-Za-z_]\w*)\s*;\s*$/;

function localDeclarations(code) {
  const statements = new Set(scanStatements(code).map((s) => s.line));
  const found = new Map();
  code.forEach((line, i) => {
    const number = i + 1;
    if (!statements.has(number)) return;
    const m = DECLARATION_RE.exec(line);
    if (!m) return;
    const name = m.groups.name;
    if (["return", "else", "case", "goto"].includes(m.groups.type)) return;
    if (found.has(name)) return;
    if (declarationLine(code, name) !== number) return;
    found.set(name, number);
  });
  return found;
}

/** str.splitlines(keepends=True). */
function splitKeepends(text) {
  const out = [];
  const re = new RegExp("\\r\\n|[\\n\\r\\v\\f\\x1c\\x1d\\x1e\\x85" + String.fromCharCode(0x2028, 0x2029) + "]", "g");
  let last = 0, m;
  while ((m = re.exec(text)) !== null) { out.push(text.slice(last, m.index + m[0].length)); last = m.index + m[0].length; }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Write one source per local, that local made `volatile`. */
export function volatileProbeSources(source, { directory, variables = [], cwd = process.cwd() }) {
  const p = path.resolve(cwd, String(source));
  let text;
  try { text = fs.readFileSync(p, "utf8"); } catch (e) { throw new CSourceError(`cannot read ${source}: ${e.code === "ENOENT" ? `[Errno 2] No such file or directory: '${source}'` : e.message}`); }
  const code = stripNoncode(text);
  let declarations = localDeclarations(code);
  const base = path.basename(String(source));
  if (variables.length) {
    const missing = variables.filter((n) => !declarations.has(n));
    if (missing.length) throw new CSourceError(`these names are not declared as locals in ${base}: ${missing.join(", ")}`);
    declarations = new Map(variables.map((n) => [n, declarations.get(n)]));
  }
  if (!declarations.size) throw new CSourceError(`${base} declares no locals this probe can make volatile. It looks for a declaration line of the form \`TYPE name;\` inside a function body.`);
  const target = path.resolve(cwd, String(directory));
  fs.mkdirSync(target, { recursive: true });
  const lines = splitKeepends(text);
  const stem = base.includes(".") ? base.slice(0, base.lastIndexOf(".")) : base;
  const written = [];
  for (const [name, number] of sorted([...declarations], (e) => e[1])) {
    const body = [...lines];
    const original = body[number - 1];
    const indent = original.slice(0, original.length - lstrip(original).length);
    body[number - 1] = `${indent}volatile ${lstrip(original)}`;
    const out = path.join(String(directory), `${stem}.vol.${name}.c`);
    fs.writeFileSync(path.resolve(cwd, out), body.join(""), "utf8");
    written.push({ variable: name, line: number, path: out });
  }
  return { source: String(source), directory: String(directory), count: written.length, variants: written,
    next: "build each variant, run `slots` on it, and compare against the base object's slots: the offset that appears or grows is that local's stack home" };
}
