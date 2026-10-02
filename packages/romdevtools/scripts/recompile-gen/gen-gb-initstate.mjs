#!/usr/bin/env node
// Generate the Game Boy WAT backend's power-on state from gambatte's OWN
// initstate.cpp - the core romdev verifies GB/GBC recompiles against.
//
//   node scripts/recompile-gen/gen-gb-initstate.mjs <gambatte>/libgambatte/src/initstate.cpp \
//        src/analysis/recompile/wat/gb/initstate.json
//
// gambatte does not run a boot ROM: initstate.cpp writes a fixed WRAM
// pattern, OAM dump, FF00-FFFF dump (HRAM included), a VRAM logo and the CGB
// OBJ palette RAM. A game that reads uninitialised RAM (an RNG seed, a "was I
// reset" check) sees those bytes, so the recompiled cart must start from the
// same image. They are PARSED from the file the reference is built from, never
// transcribed from memory, and the output is committed so a recompile never
// needs emulator C source on disk.
//
// The fill LOGIC around the tables is checked line by line against the text
// this generator implements; if gambatte's code changes, the generator refuses
// rather than silently emitting a stale model. (A first extractor checked only
// fragments, missed two fill loops, and produced zeros where gambatte has $FF:
// 1,582 of 4,096 bytes of WRAM bank 0 wrong, caught only by diffing WRAM
// against the running reference.)
//
// Ported from sms-wat work/gbc/extract_initstate.py; the output bytes are
// identical to its gbc_initstate.json, plus `cgb_objp` and provenance.
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { revParseHead, remoteUrl } from "../../src/git/index.js";
import path from "node:path";

const [src, out] = process.argv.slice(2);
if (!src || !out) {
  console.error("usage: gen-gb-initstate.mjs <initstate.cpp> <out.json>");
  process.exit(2);
}
const t = readFileSync(src, "utf8");

function fail(msg) {
  console.error(`gen-gb-initstate: ${msg}`);
  process.exit(1);
}

function funcBody(name) {
  const i = t.indexOf(`static void ${name}(`);
  if (i < 0) fail(`function ${name} not found`);
  const j = t.indexOf("\n}\n", i);
  return t.slice(i, j);
}

/** `static unsigned char const NAME[N] = { 0x.., ... };` -> Buffer, length-checked. */
function arrays(body) {
  const outA = {};
  for (const m of body.matchAll(/static unsigned char const (\w+)\[(0x[0-9A-Fa-f]+|\d+|)\] = \{([\s\S]*?)\};/g)) {
    const vals = [...m[3].matchAll(/0x[0-9A-Fa-f]+/g)].map((x) => parseInt(x[0], 16));
    if (m[2]) {
      const n = Number(m[2]);
      if (vals.length !== n) fail(`${m[1]}: ${vals.length} values, declared ${n}`);
    }
    outA[m[1]] = Buffer.from(vals);
  }
  return outA;
}

const norm = (x) => x.trim().split("\n").map((l) => l.trim()).filter(Boolean);
function expectTail(body, expected, what) {
  const tail = body.slice(body.indexOf("};") + 2);
  const a = norm(tail), b = norm(expected);
  if (a.length !== b.length || a.some((l, i) => l !== b[i])) {
    fail(`initstate.cpp ${what} logic changed - re-read it:\n${tail}`);
  }
}
function expectFrag(body, frag) {
  if (!body.includes(frag)) fail(`expected fragment missing: ${frag}`);
}
const pairsOf = (body) => [...body.matchAll(/\{\s*(0x[0-9A-Fa-f]+),\s*(0x[0-9A-Fa-f]+)\s*\}/g)]
  .map((m) => [parseInt(m[1], 16), parseInt(m[2], 16)]);

// ---- CGB WRAM ----
const wb = funcBody("setInitialCgbWram");
const pairs = pairsOf(wb);
expectTail(wb, `
for (unsigned addr = 0x0000; addr < 0x0800; addr += 0x10) {
std::memset(wram + addr + 0x00, 0xFF, 0x08);
std::memset(wram + addr + 0x08, 0x00, 0x08);
}
for (unsigned addr = 0x0800; addr < 0x1000; addr += 0x10) {
std::memset(wram + addr + 0x00, 0x00, 0x08);
std::memset(wram + addr + 0x08, 0xFF, 0x08);
}
for (unsigned addr = 0x0E00; addr < 0x1000; addr += 0x10) {
wram[addr + 0x02] = 0xFF;
wram[addr + 0x0A] = 0x00;
}
for (unsigned addr = 0x1000; addr < 0x8000; addr += 0x1000) {
if (0x2000 != addr)
std::memcpy(wram + addr, wram, 0x1000);
}
std::memset(wram + 0x2000, 0, 0x1000);
for (std::size_t i = 0; i < sizeof cgbWramDumpDiff / sizeof cgbWramDumpDiff[0]; ++i)
wram[cgbWramDumpDiff[i].addr] = cgbWramDumpDiff[i].val;
`, "setInitialCgbWram");
const w = Buffer.alloc(0x8000);
for (let a = 0; a < 0x800; a += 0x10) { w.fill(0xFF, a, a + 8); w.fill(0, a + 8, a + 16); }
for (let a = 0x800; a < 0x1000; a += 0x10) { w.fill(0, a, a + 8); w.fill(0xFF, a + 8, a + 16); }
for (let a = 0xE00; a < 0x1000; a += 0x10) { w[a + 2] = 0xFF; w[a + 0x0A] = 0x00; }
for (let a = 0x1000; a < 0x8000; a += 0x1000) if (a !== 0x2000) w.copy(w, a, 0, 0x1000);
w.fill(0, 0x2000, 0x3000);
for (const [a, v] of pairs) w[a] = v;

// ---- CGB OAM / FFxx ----
const ib = funcBody("setInitialCgbIoamhram");
const arr = arrays(ib);
for (const frag of ["std::memset(ioamhram, 0x00, 0x0A0);",
  "std::memcpy(ioamhram + 0x0A0, feaxDump, sizeof feaxDump);",
  "std::memcpy(ioamhram + 0x100, ffxxDump, sizeof ffxxDump);"]) expectFrag(ib, frag);
const io = Buffer.alloc(0x200);
arr.feaxDump.copy(io, 0xA0);
arr.ffxxDump.copy(io, 0x100);
// setInitState overrides after the dump: DIV, LCDC, LY
for (const frag of ["state.mem.ioamhram.ptr[0x104] = 0x1C;", "state.mem.ioamhram.ptr[0x140] = 0x91;",
  "state.mem.ioamhram.ptr[0x144] = 0x00;"]) expectFrag(t, frag);
io[0x104] = 0x1C; io[0x140] = 0x91; io[0x144] = 0x00;

// ---- DMG WRAM / OAM / FFxx ----
const db = funcBody("setInitialDmgWram");
const dpairs = pairsOf(db);
expectTail(db, `
for (unsigned addr = 0x0000; addr < 0x0800; addr += 0x200) {
std::memset(wram + addr        , 0x00, 0x100);
std::memset(wram + addr + 0x100, 0xFF, 0x100);
}
for (unsigned addr = 0x0800; addr < 0x1000; addr += 0x200) {
std::memset(wram + addr        , 0xFF, 0x100);
std::memset(wram + addr + 0x100, 0x00, 0x100);
}
std::memcpy(wram + 0x1000, wram, 0x1000);
for (std::size_t i = 0; i < sizeof dmgWramDumpDiff / sizeof dmgWramDumpDiff[0]; ++i)
wram[dmgWramDumpDiff[i].addr] = dmgWramDumpDiff[i].val;
`, "setInitialDmgWram");
const dw = Buffer.alloc(0x2000);
for (let a = 0; a < 0x800; a += 0x200) { dw.fill(0, a, a + 0x100); dw.fill(0xFF, a + 0x100, a + 0x200); }
for (let a = 0x800; a < 0x1000; a += 0x200) { dw.fill(0xFF, a, a + 0x100); dw.fill(0, a + 0x100, a + 0x200); }
dw.copy(dw, 0x1000, 0, 0x1000);
for (const [a, v] of dpairs) dw[a] = v;
const dib = funcBody("setInitialDmgIoamhram");
const darr = arrays(dib);
for (const frag of ["std::memcpy(ioamhram        ,  oamDump, sizeof oamDump);",
  "std::memset(ioamhram + 0x0A0, 0x00, 0x060);",
  "std::memcpy(ioamhram + 0x100, ffxxDump, sizeof ffxxDump);"]) expectFrag(dib, frag);
const dio = Buffer.alloc(0x200);
darr.oamDump.copy(dio, 0);
darr.ffxxDump.copy(dio, 0x100);
dio[0x104] = 0x1C; dio[0x140] = 0x91; dio[0x144] = 0x00;

// ---- VRAM (setInitialVram) ----
const vb = funcBody("setInitialVram");
const logo = arrays(vb).even_numbered_8010_to_81a0_dump;
for (const frag of ["std::memset(vram, 0, 0x4000);",
  "vram[0x0010 + i * 2] = even_numbered_8010_to_81a0_dump[i];",
  "for (unsigned addr = 0x1904; addr < 0x1910; ++addr)", "vram[0x1910] = 0x19;",
  "for (unsigned addr = 0x1924; addr < 0x1930; ++addr)"]) expectFrag(vb, frag);
const vc = Buffer.alloc(0x4000);
logo.forEach((v, i) => { vc[0x10 + i * 2] = v; });
const vd = Buffer.from(vc);
let k = 1;
for (let a = 0x1904; a < 0x1910; a++) vd[a] = k++;
vd[0x1910] = 0x19;
for (let a = 0x1924; a < 0x1930; a++) vd[a] = k++;

// ---- CGB OBJ palette RAM (setInitState: objpData <- cgbObjpDump) ----
const objpM = /static unsigned char const cgbObjpDump\[0x40\] = \{([\s\S]*?)\};/.exec(t);
if (!objpM) fail("cgbObjpDump not found");
const objp = Buffer.from([...objpM[1].matchAll(/0x[0-9A-Fa-f]+/g)].map((x) => parseInt(x[0], 16)));
if (objp.length !== 0x40) fail(`cgbObjpDump has ${objp.length} bytes`);
expectFrag(t, "std::memcpy(state.ppu.objpData.ptr, cgbObjpDump, sizeof cgbObjpDump);");

// ---- provenance ----
let commit = null, remote = null;
try {
  const dir = path.dirname(path.resolve(src));
  commit = revParseHead(dir);
  remote = commit === null ? null : remoteUrl(dir, "origin");
} catch { /* not a checkout: the sha256 below still pins the input */ }

const doc = {
  provenance: {
    source: "gambatte libgambatte/src/initstate.cpp (setInitialCgbWram, setInitialCgbIoamhram, setInitialDmgWram, setInitialDmgIoamhram, setInitialVram, cgbObjpDump)",
    repository: remote, commit,
    sourceSha256: createHash("sha256").update(t).digest("hex"),
    generator: "scripts/recompile-gen/gen-gb-initstate.mjs",
    generatedAt: new Date().toISOString(),
    overrides: "ioamhram[0x104]=0x1C (DIV), [0x140]=0x91 (LCDC), [0x144]=0x00 (LY), as setInitState applies after the dumps",
  },
  wram: w.toString("hex"), ioamhram: io.toString("hex"),
  dmg_wram: dw.toString("hex"), dmg_ioamhram: dio.toString("hex"),
  vram_cgb: vc.toString("hex"), vram_dmg: vd.toString("hex"),
  cgb_objp: objp.toString("hex"),
};
writeFileSync(out, JSON.stringify(doc, null, 1) + "\n");
console.log(`CGB WRAM ${pairs.length} table entries; DMG WRAM ${dpairs.length}; VRAM logo ${logo.length} B; feax ${arr.feaxDump.length} B; ffxx ${arr.ffxxDump.length} B; objp ${objp.length} B -> ${out}`);
