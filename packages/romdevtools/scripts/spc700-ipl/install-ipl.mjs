#!/usr/bin/env node
// Put romdev's SPC700 boot ROM (romdev_iplrom.h, built from ipl.asm) into an
// emulator source tree before it is built. The upstream bytes are never
// stored in romdev: the fetched tree is rewritten.
//
//   install-ipl.mjs --snes9x <snes9x>/apu/bapu/smp/iplrom.cpp
//     replaces the whole file (upstream's holds only the array and comments)
//     with romdev's definition of SMP::iplrom.
//   install-ipl.mjs <file>
//     replaces the initializer of the one `iplrom[64] = { ... };` array in
//     <file> (bsnes: bsnes/target-libretro/resources.hpp).
// Idempotent; exits non-zero unless exactly one such array is found.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const whole = process.argv[2] === "--snes9x";
const file = process.argv[whole ? 3 : 2];
if (!file) { console.error("usage: install-ipl.mjs [--snes9x] <source file>"); process.exit(2); }

const header = readFileSync(path.join(here, "romdev_iplrom.h"), "utf8");
const bytes = [...header.replace(/\/\/[^\n]*/g, "").matchAll(/0x([0-9a-f]{2})/gi)].map((m) => m[1].toLowerCase());
if (bytes.length !== 64) throw new Error(`romdev_iplrom.h has ${bytes.length} bytes, expected 64`);

const src = whole
  ? "#ifdef SMP_CPP\n\n// The SPC700 boot ROM, mapped at $FFC0-$FFFF while $F1 bit 7 is set.\nconst uint8 SMP::iplrom[64] = {};\n\n#endif\n"
  : readFileSync(file, "utf8");
const re = /\biplrom\s*\[\s*64\s*\]\s*=\s*\{/g;
const found = [...src.matchAll(re)];
if (found.length !== 1) throw new Error(`${file}: expected one iplrom[64] initializer, found ${found.length}`);
const open = found[0].index + found[0][0].length;
const close = src.indexOf("};", open);
if (close < 0) throw new Error(`${file}: unterminated iplrom[64] initializer`);
const rows = [];
for (let i = 0; i < 64; i += 8) rows.push("  " + bytes.slice(i, i + 8).map((b) => "0x" + b).join(", ") + ",");
const body = "\n  // romdev's SPC700 boot ROM (MIT, clean-room; romdevtools scripts/spc700-ipl)\n" + rows.join("\n") + "\n";
const out = src.slice(0, open) + body + src.slice(close);
const before = whole ? (() => { try { return readFileSync(file, "utf8"); } catch { return ""; } })() : src;
if (out !== before) writeFileSync(file, out);
console.log(`${file}: romdev boot ROM ${out === before ? "already in place" : "installed"}`);
