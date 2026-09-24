#!/usr/bin/env node
// Generate the SMS/GG H-counter table for the WAT backend from
// genesis_plus_gx's own cycle2hc32 table (core/hvc.h).
//
// gpgx indexes cycle2hc32 by MASTER cycles within a 3420-cycle line; the Z80
// only ever sits on multiples of 15 master cycles, so the backend needs the
// 228 entries at T*15. Run once; the output is committed as data so a
// recompile never needs emulator source on disk.
//
// usage: node sms-hcounter.mjs <path to genesis_plus_gx core/hvc.h> [out.json]
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const [hvcPath, outArg] = process.argv.slice(2);
if (!hvcPath) {
  console.error("usage: node sms-hcounter.mjs <genesis_plus_gx/core/hvc.h> [out.json]");
  process.exit(2);
}
const src = readFileSync(hvcPath, "latin1");
const start = src.indexOf("cycle2hc32[3420]");
if (start < 0) throw new Error("cycle2hc32[3420] not found");
const body = src.slice(src.indexOf("{", start) + 1, src.indexOf("};", start));
const vals = body.replace(/\/\*[\s\S]*?\*\//g, "").split(",").map((t) => t.trim()).filter(Boolean).map((t) => parseInt(t, 16));
if (vals.length !== 3420 || vals.some((v) => !(v >= 0 && v <= 255))) throw new Error(`expected 3420 byte entries, got ${vals.length}`);
const hc = Array.from({ length: 228 }, (_, t) => vals[t * 15]);
// The sprite-collision check in gpgx's status read samples the table at
// (cycles + SMS_CYCLE_OFFSET + 15) % 3420, SMS_CYCLE_OFFSET = 530.
const hcol = Array.from({ length: 228 }, (_, t) => vals[(t * 15 + 530 + 15) % 3420]);
// A TH low-to-high write to port $3F latches the H counter at
// hctab[(cycles + SMS_CYCLE_OFFSET) % 3420] (io_z80_write, no extra +15).
const hlat = Array.from({ length: 228 }, (_, t) => vals[(t * 15 + 530) % 3420]);
const out = outArg || path.join(path.dirname(fileURLToPath(import.meta.url)), "../../src/analysis/recompile/wat/sms/gpgx-hcounter.json");
writeFileSync(out, JSON.stringify({ source: "genesis_plus_gx core/hvc.h cycle2hc32, every 15 master cycles", entries: 228, hc, hcol, hlat }) + "\n");
console.log(`wrote ${out}`);
