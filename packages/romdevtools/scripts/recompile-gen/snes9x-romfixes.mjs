#!/usr/bin/env node
// Generate the SNES per-title table the WAT backend applies, from snes9x's
// own memmap.cpp: the titles LoadROMInt forces to LoROM, the header names
// InitROM picks a board-specific LoROM map for, and every rule in
// CMemory::ApplyROMFixes (APU speedup, DMA/CPU sync, SRAM size and fill
// value, OAM and render-position hacks). snes9x applies these by header
// name; a recompiled cart only matches it when it applies the same ones.
// Run once; the output is committed as data (it names titles, which the
// backend's code and docs never do) so a recompile needs no snes9x source.
//
// The parser reads the C it needs (if / else-if chains of match_*()
// conditions with assignment bodies) and FAILS on anything else, and on a
// match_* call it did not turn into a rule, so a snes9x change cannot drop
// a hack silently.
//
// usage: snes9x-romfixes.mjs [<snes9x src dir>] [<out.json>] [--check]
//   default src: ${ROMDEV_BUILD_DIR:-<pkg>/build}/snes9x/src (build-snes9x.sh's clone)
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = path.resolve(here, "..", "..");
const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const check = process.argv.includes("--check");
const srcDir = args[0] || path.join(process.env.ROMDEV_BUILD_DIR || path.join(pkg, "build"), "snes9x", "src");
const out = args[1] || path.join(pkg, "src", "analysis", "recompile", "wat", "snes", "snes9x-romfixes.json");
const versions = JSON.parse(readFileSync(path.join(pkg, "scripts", "versions.json"), "utf8"));
const pin = versions.cores?.snes9x ?? versions.snes9x;

const file = path.join(srcDir, "memmap.cpp");
const raw = readFileSync(file);
const src = raw.toString("latin1").replace(/\r/g, "");

/** C string literal body -> latin1 string (\xNN, \\ and \" escapes). */
function cstr(body) {
  return body.replace(/\\x([0-9A-Fa-f]{1,2})|\\(["\\])/g, (_, h, c) => (h ? String.fromCharCode(parseInt(h, 16)) : c));
}
/** The body of `name (...) {` ... matching `}` (brace counting, strings skipped). */
function funcBody(sig) {
  const at = src.indexOf(sig);
  if (at < 0) throw new Error(`romfixes gen: ${sig} not found`);
  const open = src.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '"') { i++; while (src[i] !== '"') { if (src[i] === "\\") i++; i++; } continue; }
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return src.slice(open + 1, i);
  }
  throw new Error(`romfixes gen: unbalanced ${sig}`);
}

// ---- LoadROMInt: "this two games fail to be detected" -> forced LoROM
const loadInt = funcBody("bool8 CMemory::LoadROMInt (int32 ROMfillSize)");
const forceLoRom = [];
for (const m of loadInt.matchAll(/strncmp\s*\(\s*\(char \*\)\s*&ROM\[(0x[0-9a-fA-F]+)\]\s*,\s*"((?:[^"\\]|\\.)*)"\s*,\s*(\d+)\s*\)\s*==\s*0/g)) {
  forceLoRom.push({ offset: Number(m[1]), name: cstr(m[2]), length: Number(m[3]) });
}
if (forceLoRom.length !== (loadInt.match(/strncmp\s*\(\s*\(char \*\)\s*&ROM\[/g) || []).length) throw new Error("romfixes gen: unparsed forced-LoROM strncmp");

// ---- InitROM: the LoROM board map picked by name
const initRom = funcBody("void CMemory::InitROM (void)");
const loRomMaps = [];
{
  // Two-tab-indented `if` / `else if` arms of the LoROM map chain whose
  // condition names ROMName; the arm's body runs to the next two-tab `else`.
  // (The three-tab ones sit under `Multi.cartType == 3`: BS-X carts.)
  const lines = initRom.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!/^\t\t(else )?if \(strncmp\(ROMName/.test(lines[i])) continue;
    let cond = lines[i];
    while (!/\)\s*$/.test(cond) || (cond.match(/\(/g) || []).length !== (cond.match(/\)/g) || []).length) cond += "\n" + lines[++i];
    let body = "";
    for (i++; i < lines.length && !/^\t\telse/.test(lines[i]); i++) body += lines[i] + "\n";
    i--;
    const names = [...cond.matchAll(/strncmp\s*\(\s*ROMName\s*,\s*"((?:[^"\\]|\\.)*)"\s*,\s*(\d+)\s*\)\s*==\s*0/g)].map((x) => ({ name: cstr(x[1]), length: Number(x[2]) }));
    // The plain-cartridge map is the arm's last Map_ call (the Sufami Turbo
    // arm maps a multi-cart first, then the single cart in its else).
    const map = [...body.matchAll(/Map_(\w+?)Map\s*\(/g)].map((x) => x[1]).at(-1);
    if (!names.length || !map) throw new Error(`romfixes gen: unparsed LoROM map arm: ${cond}`);
    for (const n of names) loRomMaps.push({ ...n, map });
  }
  const all = (initRom.match(/strncmp\s*\(\s*ROMName/g) || []).length;
  const bs = (initRom.match(/\t\t\t(if \(|\t)strncmp\s*\(\s*ROMName/g) || []).length;
  if (loRomMaps.length !== all - bs) throw new Error(`romfixes gen: ${all - bs} plain-cart ROMName strncmp, parsed ${loRomMaps.length}`);
}

// ---- ApplyROMFixes: if / else-if chains of match_*() conditions
const fixesSrc = funcBody("void CMemory::ApplyROMFixes (void)").replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
function lex(s) {
  const toks = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '"') {
      let j = i + 1, body = "";
      while (s[j] !== '"') { if (s[j] === "\\") { body += s[j] + s[j + 1]; j += 2; } else body += s[j++]; }
      toks.push({ t: "str", v: cstr(body) }); i = j + 1; continue;
    }
    let m;
    if ((m = /^(0x[0-9a-fA-F]+|[0-9]+)/.exec(s.slice(i, i + 12)))) { toks.push({ t: "num", v: Number(m[1]) }); i += m[1].length; continue; }
    if ((m = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(s.slice(i, i + 80)))) { toks.push({ t: "id", v: m[0] }); i += m[0].length; continue; }
    const p = ["&&", "||", "!=", "==", "<<", ">>"].find((q) => s.startsWith(q, i)) ?? c;
    toks.push({ t: "p", v: p }); i += p.length;
  }
  return toks;
}
const T = lex(fixesSrc);
let k = 0;
const peek = (o = 0) => T[k + o];
const eat = (v) => { const t = T[k++]; if (!t || (v !== undefined && t.v !== v)) throw new Error(`romfixes gen: expected ${v} at token ${k - 1}: ${JSON.stringify(t)}`); return t; };
/** cond := and ('||' and)* ; and := atom ('&&' atom)* ; atom := match_xx("s") | Settings.X | '(' cond ')' */
function parseCond() {
  const or = [parseAnd()];
  while (peek()?.v === "||") { k++; or.push(parseAnd()); }
  return or;
}
function parseAnd() {
  const and = [parseAtom()];
  while (peek()?.v === "&&") { k++; and.push(parseAtom()); }
  return and;
}
function parseAtom() {
  const t = eat();
  if (t.v === "(") { const c = parseCond(); eat(")"); return { any: c }; }
  if (t.t === "id" && /^match_(na|nn|nc|id)$/.test(t.v)) {
    eat("("); const s = eat(); if (s.t !== "str") throw new Error("romfixes gen: match_ without a string"); eat(")");
    return { match: t.v.slice(6), str: s.v };
  }
  if (t.t === "id" && (peek()?.v === "!=" || peek()?.v === "==")) { const op = eat().v; const n = eat(); return { compare: t.v, op, value: n.v }; }
  if (t.t === "id" && /^Settings\.\w+$/.test(t.v)) return { setting: t.v.slice(9) };
  throw new Error(`romfixes gen: unexpected condition token ${JSON.stringify(t)}`);
}
/** a statement's effects: assignments `Lhs = value;` (value numeric / TRUE / FALSE / an expression kept as text) */
function parseStmt() {
  if (peek()?.v === "{") {
    k++;
    const sets = [];
    while (peek()?.v !== "}") sets.push(...parseStmt());
    k++;
    return sets;
  }
  if (peek()?.v === "if") throw new Error("romfixes gen: nested if inside a rule body");
  const lhs = eat();
  if (lhs.t !== "id") throw new Error(`romfixes gen: unexpected statement ${JSON.stringify(lhs)}`);
  if (lhs.v === "printf") { while (eat().v !== ";"); return []; }
  if (lhs.v === "return") { eat(";"); return [{ return: true }]; }
  eat("=");
  const rhs = [];
  while (peek()?.v !== ";") rhs.push(eat());
  eat(";");
  let value;
  if (rhs.length === 1 && rhs[0].t === "num") value = rhs[0].v;
  else if (rhs.length === 1 && (rhs[0].v === "TRUE" || rhs[0].v === "FALSE")) value = rhs[0].v === "TRUE";
  else value = { expr: rhs.map((t) => (t.t === "str" ? JSON.stringify(t.v) : String(t.v))).join(" ") };
  return [{ set: lhs.v, value }];
}
const chains = [];
let matchSeen = 0;
while (k < T.length) {
  const t = peek();
  if (t.v === "if") {
    const chain = [];
    for (;;) {
      eat("if"); eat("(");
      const start = k;
      const cond = parseCond();
      matchSeen += T.slice(start, k).filter((x) => /^match_/.test(x.v)).length;
      eat(")");
      chain.push({ when: cond, sets: parseStmt() });
      if (peek()?.v === "else" && T[k + 1]?.v === "if") { k++; continue; }
      if (peek()?.v === "else") throw new Error("romfixes gen: bare else in a rule chain");
      break;
    }
    // the `if (Settings.DisableGameSpecificHacks) return;` guard and the DMACPUSync printf are not rules
    const isGuard = chain.length === 1 && chain[0].when.length === 1 && chain[0].when[0].length === 1 && chain[0].when[0][0].setting;
    if (!isGuard && !(chain.length === 1 && chain[0].sets.length === 0)) chains.push(chain);
    continue;
  }
  // top-level statements: the guard's `return;`, and calls / assignments outside rules
  if (t.v === "return") { eat("return"); eat(";"); continue; }
  if (t.t === "id" && peek(1)?.v === "(") {
    // a call such as S9xAPUTimingSetSpeedup(Timings.APUSpeedup);
    const name = eat().v; const argsT = [];
    eat("("); while (peek()?.v !== ")") argsT.push(eat().v); eat(")"); eat(";");
    chains.push([{ when: null, call: name, args: argsT }]);
    continue;
  }
  if (t.t === "id") { chains.push([{ when: null, sets: parseStmt() }]); continue; }
  throw new Error(`romfixes gen: unexpected token ${JSON.stringify(t)}`);
}
const totalMatch = (fixesSrc.match(/match_(na|nn|nc|id)\s*\(/g) || []).length;
if (totalMatch !== matchSeen) throw new Error(`romfixes gen: ${totalMatch} match_ calls, ${matchSeen} turned into rules`);
// The effects the backend knows how to apply; anything else fails the generator.
const KNOWN = new Set(["Timings.APUSpeedup", "Timings.DMACPUSync", "Timings.RenderPos", "SNESGameFixes.SRAMInitialValue",
  "SNESGameFixes.Uniracers", "SRAMSize", "SRAMMask", "Settings.BlockInvalidVRAMAccess"]);
for (const ch of chains) for (const r of ch) for (const s of r.sets ?? []) {
  if (s.return) throw new Error("romfixes gen: a return inside a rule");
  if (!KNOWN.has(s.set)) throw new Error(`romfixes gen: new effect ${s.set} (teach the backend, then add it here)`);
}

const outData = {
  source: "snes9x memmap.cpp: LoadROMInt (forced LoROM titles), InitROM (LoROM board maps by name), CMemory::ApplyROMFixes",
  provenance: { repo: pin?.url ?? null, commit: pin?.commit ?? null, file: "memmap.cpp", sha256: createHash("sha256").update(raw).digest("hex") },
  license: "snes9x (non-commercial): data derived from its source",
  matching: {
    na: "ROMName == str (the header name, NUL at 22, cut after 21 when char 21 is a space, trailing spaces stripped)",
    nn: "ROMName starts with str",
    nc: "ROMName starts with str, ignoring case",
    id: "ROMId (header $FFB2-$FFB5 of the cart's header block) starts with str",
    loRomMaps: "strncmp(untruncated ROMName, name, length) == 0",
    forceLoRom: "strncmp(ROM + offset, name, length) == 0, before the LoROM/HiROM choice",
  },
  forceLoRom,
  loRomMaps,
  applyRomFixes: chains,
};
const text = JSON.stringify(outData, null, 1) + "\n";
if (check) {
  const cur = readFileSync(out, "utf8");
  if (cur !== text) { console.error(`${out} is stale: re-run scripts/recompile-gen/snes9x-romfixes.mjs`); process.exit(1); }
  console.log(`${out} up to date`);
} else {
  writeFileSync(out, text);
  console.log(`wrote ${out}: ${forceLoRom.length} forced LoROM, ${loRomMaps.length} board maps, ${chains.length} fix chains`);
}
