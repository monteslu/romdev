#!/usr/bin/env node
// Extract the fceumm tables the NES WAT backend needs, from fceumm's own
// source, into src/analysis/recompile/wat/nes/fceumm-tables.json.
//
//   NTSCDMCTable[16]   src/sound.c            DMC period per $4010 rate index
//   lengthtable[32]    src/sound.c            length counter load values
//   palette[0..63]     src/palettes/palettes.h the default NTSC palette (RGB)
//   rtmul/gtmul/btmul  src/palette.c          ApplyDeemphasisClassic's float
//                                             multipliers (colour emphasis)
//
// The CPU cycle table (x6502.c CycTable) is already extracted by
// scripts/generate-6502-cycle-tables.mjs into recompile/m6502-cycles.json and
// is reused from there. The PPU LUTs are computed (makeppulut) in ppu.js.
//
// Also writes fceumm-ines-correct.json next to <out.json>: ines-correct.h,
// the CRC32-keyed header correction table ines.c CheckHInfo() applies to
// every iNES 1.0 image (mapper, mirroring, region, PRG/CHR RAM), truncated
// exactly where CheckHInfo's do/while stops reading it.
//
// usage: generate-nes-wat-tables.mjs <fceumm src/ dir> <out.json>
//   e.g. build/fceumm/src/src (after scripts/build-fceumm.sh)
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

const dir = process.argv[2], out = process.argv[3];
if (!dir || !out) {
  console.error("usage: generate-nes-wat-tables.mjs <fceumm src dir> <out.json>");
  process.exit(2);
}

function arrayBody(text, marker) {
  const i = text.indexOf(marker);
  if (i < 0) throw new Error(`${marker} not found`);
  const open = text.indexOf("{", i), close = text.indexOf("};", open);
  return text.slice(open + 1, close).replace(/\/\*[\s\S]*?\*\//g, "");
}

const sound = readFileSync(path.join(dir, "sound.c"), "utf8");
const dmc = arrayBody(sound, "NTSCDMCTable[0x10]").split(",").map((t) => t.trim()).filter(Boolean).map(Number);
if (dmc.length !== 16 || dmc.some((v) => !Number.isInteger(v) || v <= 0)) throw new Error("bad NTSCDMCTable");

const lengthTable = arrayBody(sound, "lengthtable[0x20]").split(",").map((t) => t.trim()).filter(Boolean).map(Number);
if (lengthTable.length !== 32 || lengthTable.some((v) => !Number.isInteger(v) || v <= 0 || v > 0xFE)) throw new Error("bad lengthtable");
// structural check: odd indices are 2*(i>>1)... NESdev pattern: entry 1 is 254,
// odd entries 3..31 are 2,4,...,30
for (let i = 3; i < 32; i += 2) if (lengthTable[i] !== i - 1) throw new Error(`lengthtable[${i}] = ${lengthTable[i]}`);

const pals = readFileSync(path.join(dir, "palettes", "palettes.h"), "utf8");
const body = arrayBody(pals, "pal palette[512]");
const triples = [...body.matchAll(/\{\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\}/g)].slice(0, 64)
  .map((m) => (Number(m[1]) << 16) | (Number(m[2]) << 8) | Number(m[3]));
if (triples.length !== 64) throw new Error(`palette: parsed ${triples.length} of 64`);

// ApplyDeemphasisClassic(): three `static const float xtmul[] = { ... };`
// arrays inside that function (7 entries: emphasis bits 1..7).
const palc = readFileSync(path.join(dir, "palette.c"), "utf8");
const fn = palc.slice(palc.indexOf("static void ApplyDeemphasisClassic"));
const mul = (name) => {
  const m = fn.match(new RegExp(`static const float ${name}\\[\\]\\s*=\\s*\\{([^}]*)\\}`));
  if (!m) throw new Error(`${name} not found in ApplyDeemphasisClassic`);
  const v = m[1].split(",").map((t) => t.trim().replace(/f$/, "")).filter(Boolean).map(Number);
  if (v.length !== 7 || v.some((x) => !(x > 0 && x < 2))) throw new Error(`bad ${name}`);
  return v;
};
const deemphasis = { rtmul: mul("rtmul"), gtmul: mul("gtmul"), btmul: mul("btmul") };
// structural check: the 7th entry (all three bits) darkens every channel equally
if (!(deemphasis.rtmul[6] === deemphasis.gtmul[6] && deemphasis.gtmul[6] === deemphasis.btmul[6])) throw new Error("deemphasis[6] not uniform");

// ines-correct.h: `{ crc32, mapper, submapper, mirror, battery, prgram,
// chrram, region, extra }, /* comment */` rows. Symbols are the macros
// CheckHInfo defines around the #include (DEFAULT/NOEXTRA -1, MI_4 2,
// DFAULT8 8, PAL 1, MULTI 2, DENDY 3) plus cart.h's MI_H 0 / MI_V 1.
const SYM = { DEFAULT: -1, NOEXTRA: -1, MI_4: 2, DFAULT8: 8, PAL: 1, MULTI: 2, DENDY: 3, MI_H: 0, MI_V: 1, MI_0: 2, MI_1: 3 };
const evalTok = (t) => t.split("|").map((x) => x.trim()).reduce((acc, x) => {
  const v = x in SYM ? SYM[x] : /^-?(0x[0-9a-f]+|\d+)$/i.test(x) ? Number(x) : NaN;
  if (Number.isNaN(v)) throw new Error(`ines-correct.h: cannot evaluate '${t}'`);
  return acc === null ? v : (acc | v);
}, null);
const correctSrc = readFileSync(path.join(dir, "ines-correct.h"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const rows = [...correctSrc.matchAll(/\{([^{}]*)\}/g)].map((m) => m[1].split(",").map((t) => t.trim()).filter(Boolean))
  .filter((f) => f.length === 9).map((f) => [Number(f[0]) >>> 0, ...f.slice(1).map(evalTok)]);
if (rows.length < 800) throw new Error(`ines-correct.h: parsed only ${rows.length} rows`);
// CheckHInfo: x = 0; do { ... x++; } while (moo[x].mirror >= 0 || moo[x].mapper >= 0);
let effective = 1;
while (effective < rows.length && (rows[effective][3] >= 0 || rows[effective][1] >= 0)) effective++;
const inesCorrect = rows.slice(0, effective);
if (new Set(inesCorrect.map((r) => r[0])).size < inesCorrect.length * 0.95) throw new Error("ines-correct: CRCs not unique enough");

let commit = null;
try {
  const root = path.resolve(dir, "..");
  if (existsSync(path.join(root, ".git"))) {
    commit = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  }
} catch { /* provenance without a commit is still the table */ }

writeFileSync(out, JSON.stringify({
  provenance: {
    source: "fceumm (libretro-fceumm) src/sound.c NTSCDMCTable[0x10], lengthtable[0x20]; src/palettes/palettes.h palette[0..63]; src/palette.c ApplyDeemphasisClassic rtmul/gtmul/btmul",
    fceummCommit: commit,
    method: "verbatim table extraction by scripts/recompile-gen/generate-nes-wat-tables.mjs",
    note: "palette is 0xRRGGBB, the default NTSC palette fceumm renders with (default_palette[0]). deemphasis multipliers are C floats: entry = (int)(channel * mul[bits-1]) in float32, clamped to 255 (ApplyDeemphasisComplete fills palette[64..511]).",
    extractedAt: new Date().toISOString(),
  },
  ntscDmcPeriod: dmc,
  lengthTable,
  paletteRgb: triples,
  deemphasis,
}, null, 1) + "\n");
const correctOut = path.join(path.dirname(out), "fceumm-ines-correct.json");
writeFileSync(correctOut, JSON.stringify({
  provenance: {
    source: "fceumm (libretro-fceumm) src/ines-correct.h, consumed by src/ines.c CheckHInfo() (iNES 1.0 images only)",
    fceummCommit: commit,
    method: "parsed by scripts/recompile-gen/generate-nes-wat-tables.mjs; rows after CheckHInfo's do/while terminator are dropped",
    fields: ["crc32 (PRG+CHR, no header/trainer)", "mapper", "submapper", "mirror", "battery", "prgram", "chrram", "region", "extra"],
    note: "-1 = DEFAULT/NOEXTRA. mirror: 0 H, 1 V, 2 four-screen, 8 'anything but four-screen', >=0x10 one-screen, bit 2 hard-wired. region: 1 PAL, 2 multi, 3 Dendy.",
    rowsInHeader: rows.length,
  },
  rows: inesCorrect,
}) + "\n");
console.log(`wrote ${out}: dmc ${dmc.length}, palette ${triples.length}; ${correctOut}: ${inesCorrect.length} of ${rows.length} rows`);
