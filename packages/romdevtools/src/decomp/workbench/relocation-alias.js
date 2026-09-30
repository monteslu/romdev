// relocation-alias.js - resolve differing relocation spellings through a
// caller-supplied linked symbol map, without claiming exactness.
//
// Plain JS ESM + JSDoc.

import fs from "node:fs";
import { ValueError, splitlines, strip, strRepr, pyInt } from "./py.js";

export const ALIAS_SCHEMA = "decomp-workbench-relocation-aliases-v1";
const EXPRESSION_RE = /^(?<symbol>[A-Za-z_.$][A-Za-z0-9_.$]*)(?<addend>[+-](?:0x[0-9a-fA-F]+|\d+))?$/;
const NM_RE = /^\s*(?<address>[0-9a-fA-F]+)\s+(?:[A-Za-z?]\s+)?(?<symbol>\S+)\s*$/;

/** Read either a JSON `symbol: address` object or conventional nm text. */
export function loadSymbolMap(p) {
  const source = fs.readFileSync(String(p), "utf8");
  let value = null;
  try { value = JSON.parse(source); } catch { value = null; }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const result = new Map();
    for (const [name, address] of Object.entries(value)) {
      try { result.set(name, pyInt(typeof address === "number" ? String(address) : String(address), 0)); }
      catch { throw new ValueError(`symbol-map address for ${strRepr(name)} is not an integer`); }
    }
    return result;
  }
  const result = new Map();
  splitlines(source).forEach((line, i) => {
    if (!strip(line)) return;
    const m = NM_RE.exec(line);
    if (!m) throw new ValueError(`symbol-map line ${i + 1} is not ADDRESS [TYPE] SYMBOL`);
    result.set(m.groups.symbol, parseInt(m.groups.address, 16));
  });
  return result;
}

export function resolveRelocationExpression(expression, symbols) {
  if (expression === null || expression === undefined) return null;
  const m = EXPRESSION_RE.exec(expression.split(" ").join(""));
  if (!m) return null;
  const base = symbols.get(m.groups.symbol);
  if (base === undefined) return null;
  return base + (m.groups.addend ? pyInt(m.groups.addend, 0) : 0);
}

/** Classify same-address relocation spelling pairs without claiming exactness. */
export function relocationAliasReport(target, candidate, { symbols }) {
  const aliases = [], unresolved = [];
  for (let index = 0; index < Math.max(target.length, candidate.length); index++) {
    const er = index < target.length ? target[index].relocations : [];
    const ar = index < candidate.length ? candidate[index].relocations : [];
    for (let ri = 0; ri < Math.max(er.length, ar.length); ri++) {
      const left = ri < er.length ? er[ri] : null, right = ri < ar.length ? ar[ri] : null;
      if (left !== null && right !== null && left.kind === right.kind && left.symbol === right.symbol) continue;
      const la = resolveRelocationExpression(left !== null ? left.symbol : null, symbols);
      const ra = resolveRelocationExpression(right !== null ? right.symbol : null, symbols);
      const record = { index, relocation_index: ri,
        target: left !== null ? { kind: left.kind, expression: left.symbol, address: la } : null,
        candidate: right !== null ? { kind: right.kind, expression: right.symbol, address: ra } : null };
      if (left !== null && right !== null && left.kind === right.kind && la !== null && ra !== null && la === ra) { record.resolved_address = la; aliases.push(record); }
      else unresolved.push(record);
    }
  }
  return { schema: ALIAS_SCHEMA, resolved_address_aliases: aliases, alias_count: aliases.length, unresolved_spelling_differences: unresolved,
    proof: "Caller-supplied symbol-map evidence only. Address-equivalent relocation spellings still require the project's link or ROM check." };
}
