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
import { revParseHead } from "../../src/git/index.js";
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

// audio (the low-quality renderer, sound.c SetSoundVariables / RDo*LQ)
const noiseFreq = arrayBody(sound, "NTSCNoiseFreqTable[0x10]").split(",").map((t) => t.trim()).filter(Boolean).map(Number);
if (noiseFreq.length !== 16 || noiseFreq[0] !== 4 || noiseFreq.some((v, i) => i && v <= noiseFreq[i - 1])) throw new Error("bad NTSCNoiseFreqTable");
const rectDuties = arrayBody(sound, "RectDuties[4]").split(",").map((t) => t.trim()).filter(Boolean).map(Number);
if (rectDuties.join() !== "1,2,4,6") throw new Error(`RectDuties ${rectDuties}`);
const wlk = (name) => {
  const m = sound.match(new RegExp(`${name}\\[x\\] = \\(double\\)16 \\* 16 \\* 16 \\* 4 \\* ([0-9.]+) / \\(\\(double\\)(\\d+) / \\(double\\)x \\+ (\\d+)\\);\\s*if \\(!FSettings.soundq\\) ${name}\\[x\\] >>= (\\d+);`));
  if (!m) throw new Error(`${name} formula not found`);
  return m.slice(1, 5).map(Number);
};
const x6502h = readFileSync(path.join(dir, "x6502.h"), "utf8");
const cpu = x6502h.match(/#define NTSC_CPU \(dendy \? [0-9.]+ : ([0-9.]+)\)/);
if (!cpu) throw new Error("NTSC_CPU not found");
const audio = { ntscCpu: Number(cpu[1]), noiseFreq, rectDuties, wl1: wlk("wlookup1"), wl2: wlk("wlookup2") };

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

// ines.c SetInput(): the CRC32-keyed input-device table (Zapper, Arkanoid
// paddle, Power Pad, Famicom expansion devices...) and the NES 2.0
// default-expansion-device switch (head.ExpDevice, byte 15), with
// driver.h's SI_* / SIFC_* values.
const inesC = readFileSync(path.join(dir, "ines.c"), "utf8");
const driverH = readFileSync(path.join(dir, "driver.h"), "utf8");
const DEV = {};
for (const m of driverH.matchAll(/#define\s+(SIS?F?C?_\w+)\s+(-?\d+)/g)) DEV[m[1]] = Number(m[2]);
if (DEV.SI_GAMEPAD !== 1 || DEV.SI_UNSET !== -1 || DEV.SIFC_NONE !== 0) throw new Error("driver.h SI_* values");
const setInput = inesC.slice(inesC.indexOf("static void SetInput(void)"), inesC.indexOf("#define INESB_INCOMPLETE"));
const devOf = (t) => { if (!(t in DEV)) throw new Error(`SetInput: unknown device ${t}`); return DEV[t]; };
const inputRows = [];
for (const m of setInput.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/\{\s*(0x[0-9a-f]+)\s*,\s*(\w+)\s*,\s*(\w+)\s*,\s*(\w+)\s*\}/gi)) {
  const r = [Number(m[1]) >>> 0, devOf(m[2]), devOf(m[3]), devOf(m[4])];
  if (r[1] < 0 && r[2] < 0 && r[3] < 0) break; // while (input1 >= 0 || input2 >= 0 || inputfc >= 0)
  inputRows.push(r);
}
const expDevice = {};
for (const m of setInput.matchAll(/case (0x[0-9a-f]+): GameInfo->input\[0\] =(\w+); GameInfo->input\[1\] =(\w+);\s*GameInfo->inputfc =(\w+);/gi)) {
  expDevice[Number(m[1])] = [devOf(m[2]), devOf(m[3]), devOf(m[4])];
}
if (inputRows.length < 50 || Object.keys(expDevice).length < 20) throw new Error(`SetInput: ${inputRows.length} rows, ${Object.keys(expDevice).length} cases`);

let commit = null;
try {
  const root = path.resolve(dir, "..");
  if (existsSync(path.join(root, ".git"))) {
    commit = revParseHead(root);
  }
} catch { /* provenance without a commit is still the table */ }

writeFileSync(out, JSON.stringify({
  provenance: {
    source: "fceumm (libretro-fceumm) src/sound.c NTSCDMCTable[0x10], lengthtable[0x20]; src/palettes/palettes.h palette[0..63]; src/palette.c ApplyDeemphasisClassic rtmul/gtmul/btmul; audio: sound.c NTSCNoiseFreqTable, RectDuties, SetSoundVariables' wlookup1/wlookup2 formula constants, x6502.h NTSC_CPU",
    fceummCommit: commit,
    method: "verbatim table extraction by scripts/recompile-gen/generate-nes-wat-tables.mjs",
    note: "palette is 0xRRGGBB, the default NTSC palette fceumm renders with (default_palette[0]). deemphasis multipliers are C floats: entry = (int)(channel * mul[bits-1]) in float32, clamped to 255 (ApplyDeemphasisComplete fills palette[64..511]).",
    extractedAt: new Date().toISOString(),
  },
  ntscDmcPeriod: dmc,
  lengthTable,
  paletteRgb: triples,
  deemphasis,
  audio,
}, null, 1) + "\n");
const correctOut = path.join(path.dirname(out), "fceumm-ines-correct.json");
writeFileSync(correctOut, JSON.stringify({
  provenance: {
    source: "fceumm (libretro-fceumm) src/ines-correct.h, consumed by src/ines.c CheckHInfo() (iNES 1.0 images only); src/ines.c SetInput() + src/driver.h (input devices)",
    fceummCommit: commit,
    method: "parsed by scripts/recompile-gen/generate-nes-wat-tables.mjs; rows after CheckHInfo's do/while terminator are dropped",
    fields: ["crc32 (PRG+CHR, no header/trainer)", "mapper", "submapper", "mirror", "battery", "prgram", "chrram", "region", "extra"],
    note: "-1 = DEFAULT/NOEXTRA. mirror: 0 H, 1 V, 2 four-screen, 8 'anything but four-screen', >=0x10 one-screen, bit 2 hard-wired. region: 1 PAL, 2 multi, 3 Dendy.",
    rowsInHeader: rows.length,
  },
  rows: inesCorrect,
  // SetInput(): [crc32, input[0], input[1], inputfc]; expDevice: byte 15 -> the same triple
  inputDevices: { values: Object.fromEntries(Object.entries(DEV).filter(([k]) => /^SI(FC)?_/.test(k))), rows: inputRows, expDevice },
}) + "\n");
console.log(`wrote ${out}: dmc ${dmc.length}, palette ${triples.length}; ${correctOut}: ${inesCorrect.length} of ${rows.length} rows`);
