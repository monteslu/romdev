#!/usr/bin/env node
// Empty the firmware and chip data bsnes embeds, before bsnes is built
// (scripts/build-bsnes.sh). They are the DSP-1 data ROM (and the sine table
// copied from it) its DSP-1 high-level emulation reads, the ST010 data ROM
// tables its ST010 emulation reads, the Cx4 data ROM, and the Super Game Boy
// boot ROMs: mask-ROM contents romdev ships none of. The tables become empty
// initializers; bsnes-romdev.patch makes the code that used them take the
// user's file from the system directory instead, or refuse the cart (the
// SPC700 boot ROM bsnes embeds is replaced by romdev's own, see
// scripts/spc700-ipl/install-ipl.mjs).
//
// usage: strip-firmware.mjs <bsnes src dir>     rewrite the files in place (idempotent)
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/** file (under bsnes/sfc/coprocessor) -> the tables in it. */
const TABLES = {
  "dsp1/dsp1emu.cpp": ["Dsp1::DataRom", "Dsp1::SinTable"],
  "st0010/data.hpp": ["ST0010::sin_table", "ST0010::mode7_scale"],
  "hitachidsp/data-rom.cpp": ["HitachiDSP::staticDataROM"],
  "icd/boot-roms.cpp": ["ICD::SGB1BootROM", "ICD::SGB2BootROM"],
};
const NOTE = "//romdev: emptied (scripts/patches/bsnes/strip-firmware.mjs)";

const dir = process.argv[2];
if (!dir) { console.error("usage: strip-firmware.mjs <bsnes src dir>"); process.exit(2); }
for (const [rel, names] of Object.entries(TABLES)) {
  const p = path.join(dir, "bsnes", "sfc", "coprocessor", rel);
  const text = readFileSync(p, "utf8");
  let out = text;
  for (const name of names) {
    const q = name.replace(/:/g, "\\:");
    const full = new RegExp(`(const\\s+[\\w:]+\\s+${q}\\s*\\[\\s*\\d+\\s*\\])\\s*=\\s*\\{[^}]+\\};`, "g");
    const done = new RegExp(`const\\s+[\\w:]+\\s+${q}\\s*\\[\\s*\\d+\\s*\\] = \\{\\}; ${NOTE.replace(/[().]/g, "\\$&")}`, "g");
    const a = [...out.matchAll(full)].length, b = [...out.matchAll(done)].length;
    if (a + b !== 1) throw new Error(`strip-firmware: ${rel}: ${name} found ${a} times as a table and ${b} times emptied, expected once`);
    out = out.replace(full, `$1 = {}; ${NOTE}`);
  }
  if (out !== text) writeFileSync(p, out);
  console.log(`${p}: ${out === text ? "already emptied" : "emptied"}`);
}
