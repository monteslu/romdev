// splat-map.js — the ONE address resolver for a splat-based decompilation
// project. Reads the splat yaml's segment table (ROM offset ↔ virtual address,
// per segment, overlays included), the symbol_addrs files and the linker map,
// and answers "where is VA X" with explicit segment identity.
//
// Why a resolver and not a formula: an N64 ROM's header entry point maps ONLY
// the boot segment. A relocated code segment (Wave Race: codeseg at ROM
// 0xA95D0 / VRAM 0x801DAFA0) and overlays (nineteen of them sharing VRAM
// 0x802C5800) are invisible to `fileOff = va - entry + 0x1000`, and the wrong
// offset still lands inside the 8 MiB image, so a bounds check cannot catch it.
// Every decomp op — resolve, decompile, xrefs, runtime symbolization — goes
// through here so they cannot disagree.
import { readFile } from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

const hx = (n) => "0x" + (n >>> 0).toString(16).toUpperCase().padStart(8, "0");

/** @typedef {{name:string,type:string,romStart:number,romEnd:number,vram:number|null,bssSize:number,overlay:boolean,subsegments:Array<{romStart:number,romEnd:number,type:string,name:string,vram:number|null}>}} Segment */

/**
 * Parse a splat yaml into a segment table.
 * @param {string} yamlPath
 */
export async function loadSplatMap(yamlPath) {
  const text = await readFile(yamlPath, "utf8");
  const doc = YAML.parse(text);
  if (!doc || !Array.isArray(doc.segments)) throw new Error(`splat yaml '${yamlPath}': no 'segments' list`);
  const opts = doc.options ?? {};
  const raw = doc.segments;
  const segStart = (s) => (Array.isArray(s) ? s[0] : s.start);
  /** @type {Segment[]} */
  const segments = [];
  for (let i = 0; i < raw.length; i++) {
    const s = raw[i];
    if (Array.isArray(s)) continue; // the trailing [end] marker
    const romStart = Number(s.start);
    const next = raw[i + 1];
    const romEnd = next != null ? Number(segStart(next)) : romStart;
    const vram = typeof s.vram === "number" ? s.vram >>> 0 : null;
    const bssSize = Number(s.bss_size ?? 0);
    const subs = [];
    const subList = Array.isArray(s.subsegments) ? s.subsegments : [];
    for (let j = 0; j < subList.length; j++) {
      const sub = subList[j];
      const start = Array.isArray(sub) ? Number(sub[0]) : Number(sub.start);
      const type = Array.isArray(sub) ? String(sub[1] ?? "") : String(sub.type ?? "");
      const name = Array.isArray(sub) ? String(sub[2] ?? "") : String(sub.name ?? "");
      const svram = !Array.isArray(sub) && typeof sub.vram === "number" ? sub.vram >>> 0 : null;
      const nextSub = subList[j + 1];
      const end = nextSub != null ? Number(Array.isArray(nextSub) ? nextSub[0] : nextSub.start) : romEnd;
      subs.push({ romStart: start, romEnd: end, type, name, vram: svram });
    }
    segments.push({
      name: String(s.name ?? `seg_${romStart.toString(16)}`), type: String(s.type ?? ""),
      romStart, romEnd, vram, bssSize, overlay: false, subsegments: subs,
    });
  }
  // Overlay detection: two code segments whose VRAM ranges intersect.
  for (const a of segments) {
    if (a.vram == null) continue;
    const aEnd = a.vram + (a.romEnd - a.romStart);
    for (const b of segments) {
      if (a === b || b.vram == null) continue;
      const bEnd = b.vram + (b.romEnd - b.romStart);
      if (a.vram < bEnd && b.vram < aEnd && (a.romEnd > a.romStart) && (b.romEnd > b.romStart)) { a.overlay = true; b.overlay = true; }
    }
  }
  return new SplatMap({ yamlPath, options: opts, segments, sha1: doc.sha1 ?? null, name: doc.name ?? null });
}

export class SplatMap {
  constructor({ yamlPath, options, segments, sha1, name }) {
    this.yamlPath = yamlPath;
    this.options = options;
    this.segments = segments;
    this.sha1 = sha1;
    this.name = name;
  }

  /** Segment by name. */
  segment(name) { return this.segments.find((s) => s.name === name) ?? null; }

  /**
   * Resolve a virtual address. Returns every segment that maps it; the caller
   * (or a `segment` hint) disambiguates overlays — never silently picks one.
   * @param {number} va
   * @param {{segment?:string}} [opts]
   */
  resolveVa(va, opts = {}) {
    va = va >>> 0;
    const candidates = [];
    for (const s of this.segments) {
      if (s.vram == null) continue;
      const romSize = s.romEnd - s.romStart;
      const inRom = va >= s.vram && va < s.vram + romSize;
      const inBss = !inRom && s.bssSize > 0 && va >= s.vram + romSize && va < s.vram + romSize + s.bssSize;
      if (!inRom && !inBss) continue;
      const romOffset = inRom ? s.romStart + (va - s.vram) : null;
      const sub = inRom ? s.subsegments.find((x) => romOffset >= x.romStart && romOffset < x.romEnd) ?? null : null;
      candidates.push({
        segment: s.name, overlay: s.overlay, kind: inRom ? (sub?.type === "bss" ? "bss" : "rom") : "bss",
        va, vaHex: hx(va), romOffset, romOffsetHex: romOffset == null ? null : hx(romOffset),
        segmentVram: s.vram, segmentVramHex: hx(s.vram), segmentRomStart: s.romStart, segmentRomStartHex: hx(s.romStart),
        subsegment: sub ? { name: sub.name, type: sub.type, romStart: sub.romStart, romStartHex: hx(sub.romStart) } : null,
      });
    }
    if (opts.segment) {
      const pick = candidates.find((c) => c.segment === opts.segment);
      if (!pick) {
        return { ok: false, code: "SEGMENT_MISMATCH", va, vaHex: hx(va), candidates,
          error: `VA ${hx(va)} is not inside segment '${opts.segment}'${candidates.length ? ` (it is inside: ${candidates.map((c) => c.segment).join(", ")})` : " (no segment maps it)"}` };
      }
      return { ok: true, resolved: pick, candidates, ambiguous: false };
    }
    if (candidates.length === 0) {
      return { ok: false, code: "UNMAPPED_VA", va, vaHex: hx(va), candidates: [],
        error: `VA ${hx(va)} is not inside any segment of ${path.basename(this.yamlPath)} (ROM-backed or BSS).` };
    }
    if (candidates.length > 1) {
      return { ok: false, code: "AMBIGUOUS_OVERLAY", va, vaHex: hx(va), candidates, ambiguous: true,
        error: `VA ${hx(va)} is mapped by ${candidates.length} overlapping segments (${candidates.map((c) => c.segment).join(", ")}). Pass segment:'<one of them>' — the resolver never guesses which overlay is loaded.` };
    }
    return { ok: true, resolved: candidates[0], candidates, ambiguous: false };
  }

  /** ROM offset → the (unique) segment + VA. */
  resolveRomOffset(off) {
    off = off >>> 0;
    const s = this.segments.find((x) => off >= x.romStart && off < x.romEnd);
    if (!s) return { ok: false, code: "UNMAPPED_ROM_OFFSET", romOffset: off, romOffsetHex: hx(off), error: `ROM offset ${hx(off)} is past every segment.` };
    const va = s.vram == null ? null : (s.vram + (off - s.romStart)) >>> 0;
    const sub = s.subsegments.find((x) => off >= x.romStart && off < x.romEnd) ?? null;
    return { ok: true, resolved: { segment: s.name, overlay: s.overlay, romOffset: off, romOffsetHex: hx(off), va, vaHex: va == null ? null : hx(va),
      subsegment: sub ? { name: sub.name, type: sub.type } : null, hasVram: s.vram != null } };
  }

  /** Compact table for status output. */
  table() {
    return this.segments.filter((s) => s.vram != null || s.type === "bin").map((s) => ({
      name: s.name, type: s.type, romStart: hx(s.romStart), romEnd: hx(s.romEnd), vram: s.vram == null ? null : hx(s.vram),
      bssSize: s.bssSize || undefined, overlay: s.overlay || undefined, subsegments: s.subsegments.length || undefined,
    }));
  }
}

/**
 * Parse splat symbol_addrs files: `name = 0xADDR; // type:func size:0x40 ...`
 * @param {string[]} files
 * @returns {Promise<Map<string,{va:number,type?:string,size?:number,file:string}>>}
 */
export async function loadSymbolAddrs(files) {
  const out = new Map();
  for (const f of files) {
    let text;
    try { text = await readFile(f, "utf8"); } catch { continue; }
    for (const line of text.split("\n")) {
      const m = /^\s*([A-Za-z_$.][\w$.]*)\s*=\s*(0x[0-9A-Fa-f]+|\d+)\s*;(.*)$/.exec(line);
      if (!m) continue;
      const attrs = {};
      for (const a of m[3].matchAll(/(\w+):(\S+)/g)) attrs[a[1]] = a[2];
      out.set(m[1], { va: Number(m[2]) >>> 0, type: attrs.type, size: attrs.size != null ? Number(attrs.size) : undefined, file: f });
    }
  }
  return out;
}

/**
 * Parse a GNU ld map file into {symbols, objects}. Symbols carry the section +
 * object they came from and a size derived from the next symbol in the same
 * object section (the linker does not print per-symbol sizes).
 * @param {string} mapPath
 */
export async function loadLinkerMap(mapPath) {
  const text = await readFile(mapPath, "utf8");
  const symbols = new Map();
  const objects = new Map(); // object path → [{section, va, size}]
  let curSection = null, curObject = null, curSectionVa = 0, curSectionSize = 0;
  const sectionRe = /^ (\.[\w.]+)\s+(0x[0-9a-f]+)\s+(0x[0-9a-f]+)\s+(\S+)\s*$/;
  const sectionRe2 = /^ (\.[\w.]+)\s*$/; // section name alone, va/size on the next line
  const contRe = /^\s+(0x[0-9a-f]+)\s+(0x[0-9a-f]+)\s+(\S+)\s*$/;
  const symRe = /^\s+(0x[0-9a-f]+)\s+([A-Za-z_$.][\w$.]*)\s*$/;
  let pendingSection = null;
  const lines = text.split("\n");
  const order = [];
  for (const line of lines) {
    let m;
    if ((m = sectionRe.exec(line))) {
      curSection = m[1]; curSectionVa = Number(m[2]) >>> 0; curSectionSize = Number(m[3]); curObject = m[4];
      pushObj(); continue;
    }
    if ((m = sectionRe2.exec(line))) { pendingSection = m[1]; continue; }
    if (pendingSection && (m = contRe.exec(line))) {
      curSection = pendingSection; curSectionVa = Number(m[1]) >>> 0; curSectionSize = Number(m[2]); curObject = m[3]; pendingSection = null;
      pushObj(); continue;
    }
    pendingSection = null;
    if (curObject && (m = symRe.exec(line))) {
      const va = Number(m[1]) >>> 0;
      const name = m[2];
      const rec = { name, va, section: curSection, object: curObject, sectionVa: curSectionVa, sectionEnd: curSectionVa + curSectionSize };
      symbols.set(name, rec);
      order.push(rec);
    }
  }
  function pushObj() {
    if (!curObject || !curSection || !/^\.(text|rodata|data|bss|sdata|sbss|late_rodata)$/.test(curSection)) return;
    if (!objects.has(curObject)) objects.set(curObject, []);
    objects.get(curObject).push({ section: curSection, va: curSectionVa, size: curSectionSize });
  }
  // Sizes: next symbol in the same object+section (skipping aliases at the same VA), else the section end.
  for (let i = 0; i < order.length; i++) {
    const s = order[i];
    let end = s.sectionEnd;
    for (let j = i + 1; j < order.length; j++) {
      const t = order[j];
      if (t.object !== s.object || t.section !== s.section) break;
      if (t.va > s.va) { end = t.va; break; }
    }
    s.size = Math.max(0, end - s.va);
  }
  return { symbols, objects, path: mapPath };
}

/**
 * Locate the translation unit + GLOBAL_ASM pragma (or C definition) for a
 * function name under a project's src tree. Returns the first hit; a name that
 * appears in two TUs is reported (that is a project bug, not a guess to make).
 */
export function findFunctionSource(root, srcDir, name) {
  const hits = [];
  const pragmaRe = new RegExp(`^[ \\t]*#pragma\\s+GLOBAL_ASM\\("([^"]*\\/${escapeRe(name)}\\.s)"\\)`, "m");
  const defRe = new RegExp(`^[A-Za-z_][\\w\\s*]*\\b${escapeRe(name)}\\s*\\([^;]*\\)\\s*\\{`, "m");
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (ent.isFile() && ent.name.endsWith(".c") && !ent.name.endsWith(".inc.c")) {
        const text = fs.readFileSync(full, "utf8");
        const pm = pragmaRe.exec(text);
        if (pm) { hits.push({ tu: path.relative(root, full), state: "asm", asmPath: pm[1], line: text.slice(0, pm.index).split("\n").length }); continue; }
        const dm = defRe.exec(text);
        if (dm) hits.push({ tu: path.relative(root, full), state: "c", asmPath: null, line: text.slice(0, dm.index).split("\n").length });
      }
    }
  };
  walk(path.join(root, srcDir));
  return hits;
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

/**
 * Parse a splat-emitted nonmatching .s: instructions with their ROM offset,
 * VA and encoded word from the leading comment, plus any .rodata/.late_rodata
 * data the function carries.
 */
export function parseSplatAsm(text) {
  const instrs = [];
  const data = [];
  let section = ".text";
  let name = null;
  const rodataSyms = [];
  for (const line of text.split("\n")) {
    let m;
    if ((m = /^\s*\.section\s+(\S+)/.exec(line))) { section = m[1]; continue; }
    if ((m = /^\s*glabel\s+(\S+)/.exec(line))) { if (!name) name = m[1]; continue; }
    if ((m = /^\s*dlabel\s+(\S+)/.exec(line))) { rodataSyms.push({ name: m[1], section }); continue; }
    if ((m = /^\s*\/\*\s*([0-9A-Fa-f]+)\s+([0-9A-Fa-f]{8})\s+([0-9A-Fa-f]{8})\s*\*\/\s*(.*)$/.exec(line))) {
      const rec = { romOffset: parseInt(m[1], 16), va: parseInt(m[2], 16) >>> 0, word: parseInt(m[3], 16) >>> 0, text: m[4].trim(), section };
      if (section === ".text") instrs.push(rec); else data.push(rec);
      continue;
    }
    if ((m = /^\s*\/\*\s*([0-9A-Fa-f]+)\s+([0-9A-Fa-f]{8})\s+([0-9A-Fa-f]+)\s*\*\/\s*(\.\w+.*)$/.exec(line))) {
      data.push({ romOffset: parseInt(m[1], 16), va: parseInt(m[2], 16) >>> 0, word: null, text: m[4].trim(), section });
    }
  }
  return { name, instructions: instrs, data, rodataSymbols: rodataSyms, sizeBytes: instrs.length * 4,
    va: instrs[0]?.va ?? null, romOffset: instrs[0]?.romOffset ?? null };
}

export { hx };
