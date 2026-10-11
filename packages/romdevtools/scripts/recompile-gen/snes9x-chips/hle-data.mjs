#!/usr/bin/env node
// Empty the chip data ROM tables snes9x embeds, before snes9x code is built
// (the snes9x core, scripts/build-snes9x.sh, and the recompiler's chip units,
// scripts/recompile-gen/snes9x-chips.mjs). The tables are the DSP-1, DSP-3
// and ST010 mask-ROM data (and the DSP-1 sine table copied from it); romdev
// ships none of them. Each `static const` table becomes a zero-filled
// global that glue/romdev_hledata.h fills from the user's data ROM file
// (src/analysis/recompile/wat/snes/hle-data.js names the files).
//
// usage: hle-data.mjs <snes9x src dir>     rewrite the files in place (idempotent)
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** file -> the tables in it (name, element type, length). */
export const HLE_TABLES = {
  "dsp1.cpp": [["DSP1ROM", "uint16", 1024], ["DSP1_SinTable", "int16", 256]],
  "dsp3.cpp": [["DSP3_DataROM", "uint16", 1024]],
  "seta010.cpp": [["ST010_SinTable", "int16", 256], ["ST010_M7Scale", "int16", 176]],
};

const NOTE = "// romdev: filled from the user's data ROM (romdev_hledata.h); the upstream table is not built";

/**
 * The file's text with its tables emptied. Throws unless each table is
 * found exactly once, as upstream's initialized table or already emptied.
 * @param {string} file  base name (a key of HLE_TABLES)
 * @param {string} text
 */
export function stripHleData(file, text) {
  for (const [name, type, len] of HLE_TABLES[file] ?? []) {
    const full = new RegExp(`static\\s+const\\s+${type}\\s+${name}\\s*\\[\\s*${len}\\s*\\]\\s*=\\s*\\{[^}]*\\};`, "g");
    const done = new RegExp(`^${type} ${name}\\[${len}\\]; ${NOTE.replace(/[().;]/g, "\\$&")}$`, "gm");
    const a = [...text.matchAll(full)].length, b = [...text.matchAll(done)].length;
    if (a + b !== 1) throw new Error(`hle-data: ${file}: ${name}[${len}] found ${a} times as a table and ${b} times emptied, expected once`);
    text = text.replace(full, `${type} ${name}[${len}]; ${NOTE}`);
  }
  return text;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2];
  if (!dir) { console.error("usage: hle-data.mjs <snes9x src dir>"); process.exit(2); }
  for (const f of Object.keys(HLE_TABLES)) {
    const p = path.join(dir, f);
    const text = readFileSync(p, "utf8");
    const out = stripHleData(f, text);
    if (out !== text) writeFileSync(p, out);
    console.log(`${p}: chip data ROM tables ${out === text ? "already emptied" : "emptied"}`);
  }
}
