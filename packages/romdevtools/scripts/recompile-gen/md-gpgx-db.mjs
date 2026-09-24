#!/usr/bin/env node
// Generate the Mega Drive cartridge hardware database the Genesis WAT backend
// consults, from genesis_plus_gx's own rom_database (core/cart_hw/md_cart.c):
// per (header checksum, real checksum) the $400000-$7FFFFF register banks,
// the register values / masks / addresses, the Realtec flag and the handler
// each hook runs (by name). md_cart_init applies it before anything else, so
// a cart only matches gpgx when the backend applies the same entry. Run once;
// the output is committed as data so a recompile never needs emulator source.
//
// usage: node md-gpgx-db.mjs <path to genesis_plus_gx src> [out.json]
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const [srcDir, outArg] = process.argv.slice(2);
if (!srcDir) {
  console.error("usage: node md-gpgx-db.mjs <genesis_plus_gx src dir (with core/)> [out.json]");
  process.exit(2);
}
const file = path.join(srcDir, "core/cart_hw/md_cart.c");
const raw = readFileSync(file);
const src = raw.toString("latin1").replace(/\r/g, "");
const start = src.indexOf("static const md_entry_t rom_database[] =");
if (start < 0) throw new Error("rom_database not found");
const body = src.slice(src.indexOf("{", start) + 1, src.indexOf("\n};", start));
const H = "(0x[0-9A-Fa-f]+)";
const LIST = "\\{([^}]*)\\}";
const ENTRY = new RegExp(`\\{${H},${H},${H},${H},\\{${LIST},${LIST},${LIST},(\\d+),(\\d+),(\\w+),(\\w+),(\\w+),(\\w+)\\}\\}`, "g");
const nums = (s) => s.split(",").map((x) => Number(x.trim()));
const fn = (s) => (s === "NULL" ? null : s);
const games = [];
for (const m of body.matchAll(ENTRY)) {
  const [, chk1, chk2, bankStart, bankEnd, regs, mask, addr, realtec, bankshift, timeR, timeW, regsR, regsW] = m;
  games.push({ chk: Number(chk1), realChk: Number(chk2), bankStart: Number(bankStart), bankEnd: Number(bankEnd),
    regs: nums(regs), mask: nums(mask), addr: nums(addr), realtec: Number(realtec), bankshift: Number(bankshift),
    timeR: fn(timeR), timeW: fn(timeW), regsR: fn(regsR), regsW: fn(regsW) });
}
// structural checks: every row parsed, 4 registers each, handler names known
const rows = (body.match(/^\s*\{0x/gm) || []).length;
if (rows !== games.length) throw new Error(`parsed ${games.length} of ${rows} rows`);
for (const g of games) {
  if (g.regs.length !== 4 || g.mask.length !== 4 || g.addr.length !== 4) throw new Error(`odd row ${JSON.stringify(g)}`);
  for (const h of [g.timeR, g.timeW, g.regsR, g.regsW]) if (h !== null && !src.includes(` ${h}(`)) throw new Error(`unknown handler ${h}`);
}
let commit = null;
try {
  const v = JSON.parse(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../versions.json"), "utf8"));
  commit = v.cores?.genesis_plus_gx?.commit ?? Object.values(v).flatMap((x) => (x && typeof x === "object" ? Object.entries(x) : [])).find(([k]) => k === "genesis_plus_gx")?.[1]?.commit ?? null;
} catch { /* provenance without a commit */ }
const out = outArg || path.join(path.dirname(fileURLToPath(import.meta.url)), "../../src/analysis/recompile/wat/genesis/gpgx-md-db.json");
writeFileSync(out, JSON.stringify({
  source: "genesis_plus_gx core/cart_hw/md_cart.c rom_database",
  provenance: { gpgxCommit: commit, sha256: createHash("sha256").update(raw).digest("hex") },
  license: "non-commercial (Genesis Plus GX license): data derived from its source",
  entries: games.length,
  games,
}) + "\n");
console.log(`wrote ${out}: ${games.length} entries`);
