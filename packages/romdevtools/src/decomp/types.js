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
    if (h.pointer) f.pointer = true;
    const ev = { source, note: h.evidence, m2cType: h.type ?? null, pointer: h.pointer || undefined, asmAccesses: acc.slice(0, 4).map((a) => `${a.mnemonic}@${a.va}`), at: new Date().toISOString() };
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
  const hypotheses = recs.map((r) => ({ symbol: r.symbol, tu: r.tu, bases: Object.fromEntries(Object.entries(r.bases).map(([b, v]) => [b, Object.values(v.fields).sort((x, y) => x.offset - y.offset).map((f) => ({ offset: f.offset, offsetHex: "0x" + f.offset.toString(16).toUpperCase(), widths: f.widths, types: f.types, pointer: f.pointer || undefined, evidenceCount: f.evidence.length, firstEvidence: f.evidence[0] }))])) }));
  return { kind: "hypotheses", note: "offsets + access widths with evidence; NOT confirmed types. A declared struct in the project's headers is confirmed; these are what the asm and m2c observed.", functions: hypotheses.length, hypotheses };
}

/**
 * Propose C declarations from the accumulated evidence: one struct per base
 * (fields typed by the access width the asm used, gaps filled with unk
 * bytes) and a prototype that replaces placeholder pointer parameters with
 * the proposed struct pointers. A PROPOSAL: feed it to generate as
 * `extraContext` and to compare as `declarations`; the compare decides.
 */
export async function proposeTypes(project, { symbol }) {
  const rep = await typeReport(project, { symbol });
  const argReg = { arg0: "a0", arg1: "a1", arg2: "a2", arg3: "a3" };
  const out = [];
  const fn = symbol ? await project.resolveFunction({ symbol }).catch(() => null) : null;
  const structs = [];
  for (const h of rep.hypotheses) {
    for (const [base, fields] of Object.entries(h.bases)) {
      if (!fields.length) continue;
      const name = `Unk_${h.symbol.replace(/^func_/, "")}_${base}`;
      const lines = [`typedef struct ${name} {`];
      let cursor = 0;
      const sorted = [...fields].sort((a, b) => a.offset - b.offset);
      for (const f of sorted) {
        if (f.offset < cursor) continue; // overlapping guess: keep the first
        if (f.offset > cursor) lines.push(`    /* 0x${cursor.toString(16).toUpperCase().padStart(2, "0")} */ u8 unk_${cursor.toString(16).toUpperCase()}[0x${(f.offset - cursor).toString(16).toUpperCase()}];`);
        const w = f.widths[0] ?? 4;
        // A field the draft dereferences/indexes is a pointer: element type from the loads THROUGH it is
        // unknown here, so `s32*` (4-byte elements) is proposed; the compare decides.
        const t = f.pointer ? "s32*" : f.types.includes("f32") ? "f32" : f.types.includes("f64") ? "f64" : w === 1 ? "u8" : w === 2 ? "s16" : w === 8 ? "s64" : "s32";
        lines.push(`    /* 0x${f.offset.toString(16).toUpperCase().padStart(2, "0")} */ ${t} unk${f.offset.toString(16).toUpperCase()};  /* ${f.evidenceCount} evidence: ${f.firstEvidence?.asmAccesses?.join(" ") || f.firstEvidence?.note || ""} */`);
        cursor = f.offset + (t === "f64" || t === "s64" ? 8 : f.pointer ? 4 : w);
      }
      lines.push(`} ${name};`);
      structs.push({ symbol: h.symbol, base, name, register: argReg[base] ?? null, text: lines.join("\n"), fields: sorted.length });
    }
  }
  let prototype = null;
  if (fn) {
    const { buildContext } = await import("./context.js");
    const { contextPrototype } = await import("./m2c.js");
    try {
      const ctx = await buildContext(project, fn.source.tu);
      const cp = contextPrototype(await (await import("node:fs/promises")).readFile(ctx.path, "utf8"), fn.symbol);
      if (cp.declared) {
        // Replace the k-th placeholder pointer parameter with the k-th proposed struct pointer (by argument position).
        let k = 0;
        const params = cp.prototype.replace(/^.*?\(/, "").replace(/\)\s*;$/, "").split(",").map((p) => p.trim());
        const newParams = params.map((p, i) => {
          const st = structs.find((s) => s.symbol === fn.symbol && s.base === `arg${i}`);
          if (st && /\b(u8|s8|void)\s*\*/.test(p)) { k++; return `${st.name}* arg${i}`; }
          return p;
        });
        prototype = { current: cp.prototype, proposed: cp.prototype.replace(/\(.*\)\s*;$/, `(${newParams.join(", ")});`), replacedParameters: k };
      }
    } catch (e) { prototype = { error: String(e?.message ?? e).slice(0, 120) }; }
  }
  const text = [...structs.map((s) => s.text), prototype?.proposed && prototype.replacedParameters ? prototype.proposed : ""].filter(Boolean).join("\n\n") + "\n";
  return { kind: "proposal", structs, prototype, text, next: fn ? `decomp({op:'generate', project:'${project.id}', symbol:'${fn.symbol}', extraContext:<text>}) then decomp({op:'compare', ..., declarations:<text>})` : undefined,
    note: "typed by access width only (s32 vs u32 vs pointer is undecidable from a lw); f32/f64 from lwc1/ldc1; gaps are unk byte arrays. Nothing here is confirmed until compare says exact." };
}
