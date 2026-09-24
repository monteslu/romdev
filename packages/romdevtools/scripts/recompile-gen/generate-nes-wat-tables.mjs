#!/usr/bin/env node
// Extract the fceumm tables the NES WAT backend needs, from fceumm's own
// source, into src/analysis/recompile/wat/nes/fceumm-tables.json.
//
//   NTSCDMCTable[16]   src/sound.c            DMC period per $4010 rate index
//   palette[0..63]     src/palettes/palettes.h the default NTSC palette (RGB)
//
// The CPU cycle table (x6502.c CycTable) is already extracted by
// scripts/generate-6502-cycle-tables.mjs into recompile/m6502-cycles.json and
// is reused from there. The PPU LUTs are computed (makeppulut) in ppu.js.
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

const pals = readFileSync(path.join(dir, "palettes", "palettes.h"), "utf8");
const body = arrayBody(pals, "pal palette[512]");
const triples = [...body.matchAll(/\{\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\}/g)].slice(0, 64)
  .map((m) => (Number(m[1]) << 16) | (Number(m[2]) << 8) | Number(m[3]));
if (triples.length !== 64) throw new Error(`palette: parsed ${triples.length} of 64`);

let commit = null;
try {
  const root = path.resolve(dir, "..");
  if (existsSync(path.join(root, ".git"))) {
    commit = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  }
} catch { /* provenance without a commit is still the table */ }

writeFileSync(out, JSON.stringify({
  provenance: {
    source: "fceumm (libretro-fceumm) src/sound.c NTSCDMCTable[0x10]; src/palettes/palettes.h palette[0..63]",
    fceummCommit: commit,
    method: "verbatim table extraction by scripts/recompile-gen/generate-nes-wat-tables.mjs",
    note: "palette is 0xRRGGBB, the default NTSC palette fceumm renders with (default_palette[0]).",
    extractedAt: new Date().toISOString(),
  },
  ntscDmcPeriod: dmc,
  paletteRgb: triples,
}, null, 1) + "\n");
console.log(`wrote ${out}: dmc ${dmc.length}, palette ${triples.length}`);
