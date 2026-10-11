#!/usr/bin/env node
// Assemble romdev's SPC700 boot ROM (ipl.asm, romdev's own MIT code) with asar
// and write its 64 bytes to romdev_iplrom.h, a C initializer list that the
// snes9x and bsnes builds (install-ipl.mjs) and the recompiler's APU data
// generator (scripts/recompile-gen/snes9x-apu.mjs) read.
//
// usage: build-ipl.mjs [--check]
//   --check: assemble in memory and fail if romdev_iplrom.h differs.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runAsar } from "../../src/toolchains/asar/asar.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, "romdev_iplrom.h");
const check = process.argv.includes("--check");

const source = readFileSync(path.join(here, "ipl.asm"), "utf8");
// a filled base image, so every byte the source does not write would show
const baseRom = new Uint8Array(0x40).fill(0xff);
const { binary, log, exitCode } = await runAsar({ source, baseRom, symbols: false });
if (exitCode !== 0 || !binary) throw new Error(`asar failed (${exitCode}):\n${log}`);
const ipl = [...binary.subarray(0, 0x40)];
if (binary.length !== 0x40) throw new Error(`ipl.asm produced ${binary.length} bytes, expected 64`);
const entry = ipl[0x3e] | (ipl[0x3f] << 8);
if (entry < 0xffc0) throw new Error(`reset vector $${entry.toString(16)} is outside the boot ROM`);

const hex = (b) => "0x" + b.toString(16).padStart(2, "0");
const rows = [];
for (let i = 0; i < 64; i += 8) rows.push("  " + ipl.slice(i, i + 8).map(hex).join(", ") + ",");
const text = `// romdev SPC700 boot ROM, $FFC0-$FFFF: generated from ipl.asm by build-ipl.mjs.
// Copyright (c) 2026 Luis Montes. MIT License. A clean-room reimplementation
// of the boot upload protocol; see ipl.asm for the source and the protocol.
// Do not edit: change ipl.asm and run build-ipl.mjs.
${rows.join("\n")}
`;
if (check) {
  if (readFileSync(out, "utf8") !== text) { console.error(`${out} is stale: run build-ipl.mjs`); process.exit(1); }
  console.log("romdev_iplrom.h is current");
} else {
  writeFileSync(out, text);
  console.log(`wrote ${out} (64 bytes, entry $${entry.toString(16).toUpperCase()})`);
}
