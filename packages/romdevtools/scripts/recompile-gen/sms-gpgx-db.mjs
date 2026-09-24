#!/usr/bin/env node
// Generate the SMS / Game Gear cartridge database the WAT backend consults,
// from genesis_plus_gx's own game_list (core/cart_hw/sms_cart.c): per ROM
// CRC32 the mapper, the console model, the region (which also picks PAL
// timing), YM2413 and 3-D glasses flags and the controller. gpgx applies
// these by CRC before anything else, so a cart only matches it when the
// backend applies the same entry. Run once; the output is committed as data
// so a recompile never needs emulator source on disk.
//
// usage: node sms-gpgx-db.mjs <path to genesis_plus_gx src> [out.json]
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const [srcDir, outArg] = process.argv.slice(2);
if (!srcDir) {
  console.error("usage: node sms-gpgx-db.mjs <genesis_plus_gx src dir (with core/)> [out.json]");
  process.exit(2);
}
const file = path.join(srcDir, "core/cart_hw/sms_cart.c");
const raw = readFileSync(file);
const src = raw.toString("latin1").replace(/\r/g, "");
const start = src.indexOf("static const rominfo_t game_list[] =");
if (start < 0) throw new Error("game_list not found");
const body = src.slice(src.indexOf("{", start) + 1, src.indexOf("\n};", start));
const ENTRY = /\{\s*(0x[0-9A-Fa-f]{8})\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\w+)\s*,\s*(\w+)\s*,\s*(\w+)\s*,\s*(\w+)\s*\}\s*,?\s*(?:\/\*([^*]*)\*\/)?/g;
const games = [];
for (const m of body.matchAll(ENTRY)) {
  const [, crc, g3d, fm, peripheral, mapper, system, region] = m;
  games.push({ crc: crc.toUpperCase().replace("0X", ""), g3d: Number(g3d), fm: Number(fm),
    peripheral: peripheral === "0" ? null : peripheral, mapper, system, region });
}
// structural checks: every row parsed, CRCs unique, constants from the known sets
const rows = (body.match(/\{\s*0x[0-9A-Fa-f]{8}/g) || []).length;
if (rows !== games.length) throw new Error(`parsed ${games.length} of ${rows} rows`);
if (new Set(games.map((g) => g.crc)).size !== games.length) throw new Error("duplicate CRC");
for (const g of games) {
  if (!/^MAPPER_/.test(g.mapper) || !/^SYSTEM_/.test(g.system) || !/^REGION_/.test(g.region)) throw new Error(`odd row ${JSON.stringify(g)}`);
}
let commit = null;
try {
  const v = JSON.parse(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../versions.json"), "utf8"));
  commit = v.cores?.genesis_plus_gx?.commit ?? Object.values(v).flatMap((x) => (x && typeof x === "object" ? Object.entries(x) : [])).find(([k]) => k === "genesis_plus_gx")?.[1]?.commit ?? null;
} catch { /* provenance without a commit */ }
const out = outArg || path.join(path.dirname(fileURLToPath(import.meta.url)), "../../src/analysis/recompile/wat/sms/gpgx-sms-db.json");
writeFileSync(out, JSON.stringify({
  source: "genesis_plus_gx core/cart_hw/sms_cart.c game_list",
  provenance: { gpgxCommit: commit, sha256: createHash("sha256").update(raw).digest("hex") },
  license: "non-commercial (Genesis Plus GX license): data derived from its source",
  entries: games.length,
  games,
}) + "\n");
console.log(`wrote ${out}: ${games.length} entries`);
