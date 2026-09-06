// types.js — persistent type evidence. Every generate/compare adds what it
// learned about a base's field layout: the offset, the access WIDTH taken
// from the asm (lb/lh/lw/ld/lwc1/ldc1 and their stores), the sign when the
// load says so, and where the evidence came from. Confirmed types (the
// project's headers) are kept apart from hypotheses (m2c's unk fields).
import fs from "node:fs";
import path from "node:path";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { parseSplatAsm } from "./splat-map.js";

const WIDTH = { lb: [1, "s8"], lbu: [1, "u8"], lh: [2, "s16"], lhu: [2, "u16"], lw: [4, "s32/u32/ptr"], lwu: [4, "u32"], ld: [8, "s64"], lwc1: [4, "f32"], ldc1: [8, "f64"],
  sb: [1, "8-bit"], sh: [2, "16-bit"], sw: [4, "32-bit"], sd: [8, "64-bit"], swc1: [4, "f32"], sdc1: [8, "f64"] };

/** Access evidence from the function's asm: base register → [{offset, width, kind, mnemonic, va}]. */
export function accessEvidence(asmText) {
  const p = parseSplatAsm(asmText);
  const out = [];
  for (const ins of p.instructions) {
    const m = /^(\w+)\s+\$?(\w+),\s*(-?0x[0-9A-Fa-f]+|-?\d+)\(\$?(\w+)\)/.exec(ins.text);
    if (!m || !WIDTH[m[1]]) continue;
    const [w, type] = WIDTH[m[1]];
    out.push({ base: m[4], offset: Number(m[3]), width: w, type, kind: m[1].startsWith("s") ? "store" : "load", mnemonic: m[1], va: "0x" + ins.va.toString(16).toUpperCase() });
  }
  return out;
}

/** Merge m2c hypotheses (base name, offset) with asm widths and persist. */
export async function recordTypeEvidence(project, fn, { hypotheses = [], asmText, source = "m2c" }) {
  const dir = path.join(project.ws, "types");
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${fn.symbol}.json`);
  let rec = { symbol: fn.symbol, tu: fn.source?.tu ?? null, updatedAt: null, bases: {} };
  if (fs.existsSync(file)) { try { rec = JSON.parse(await readFile(file, "utf8")); } catch {} }
  const asmEv = asmText ? accessEvidence(asmText) : [];
  // Map m2c argument names to registers by position (arg0=a0 …) so widths can be attached.
  const argReg = { arg0: "a0", arg1: "a1", arg2: "a2", arg3: "a3" };
  for (const h of hypotheses) {
    const base = h.base;
    if (!rec.bases[base]) rec.bases[base] = { fields: {} };
    const key = String(h.offset);
    const f = rec.bases[base].fields[key] ?? { offset: h.offset, widths: [], types: [], evidence: [] };
    const reg = argReg[base];
    const acc = asmEv.filter((a) => a.offset === h.offset && (!reg || a.base === reg));
    for (const a of acc) { if (!f.widths.includes(a.width)) f.widths.push(a.width); if (!f.types.includes(a.type)) f.types.push(a.type); }
    const ev = { source, note: h.evidence, m2cType: h.type ?? null, asmAccesses: acc.slice(0, 4).map((a) => `${a.mnemonic}@${a.va}`), at: new Date().toISOString() };
    if (!f.evidence.some((e) => e.source === ev.source && e.m2cType === ev.m2cType && e.asmAccesses.join() === ev.asmAccesses.join())) f.evidence.push(ev);
    rec.bases[base].fields[key] = f;
  }
  rec.updatedAt = new Date().toISOString();
  await writeFile(file, JSON.stringify(rec, null, 2));
  return rec;
}

/** Everything known about a function's (or all) bases, plus the headers' confirmed structs for contrast. */
export async function typeReport(project, { symbol } = {}) {
  const dir = path.join(project.ws, "types");
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".json")) : [];
  const recs = [];
  for (const f of files) { try { const r = JSON.parse(await readFile(path.join(dir, f), "utf8")); if (!symbol || r.symbol === symbol) recs.push(r); } catch {} }
  const hypotheses = recs.map((r) => ({ symbol: r.symbol, tu: r.tu, bases: Object.fromEntries(Object.entries(r.bases).map(([b, v]) => [b, Object.values(v.fields).sort((x, y) => x.offset - y.offset).map((f) => ({ offset: f.offset, offsetHex: "0x" + f.offset.toString(16).toUpperCase(), widths: f.widths, types: f.types, evidenceCount: f.evidence.length, firstEvidence: f.evidence[0] }))])) }));
  return { kind: "hypotheses", note: "offsets + access widths with evidence; NOT confirmed types. A declared struct in the project's headers is confirmed; these are what the asm and m2c observed.", functions: hypotheses.length, hypotheses };
}
