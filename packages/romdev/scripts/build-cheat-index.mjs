#!/usr/bin/env node
// Build the bundled cheat index from a RetroArch-format `.cht` tree.
//
//   node scripts/build-cheat-index.mjs <source-cht-dir> [--out <dir>]
//
// <source-cht-dir> is a directory of `<platform>/<game>.cht` files (e.g. a
// RetroDECK/Batocera/RetroArch cheats folder). We map each supported platform's
// DB folder name → our platform id, parse every .cht, decode each code, and
// emit ONE compressed-shape JSON per platform into src/cheats/index/<plat>.json.
//
// The emitted index is what ships: a name→entries map. At runtime gameCheats
// loads only the matched game's entry list, never the whole file into context.
//
// Source attribution: the cheat codes are aggregated community data (RetroArch /
// libretro-database lineage, originally from Game Genie code books and
// GameHacking.org). We pre-parse rather than redistribute the raw tree.

import { readdir, readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseCht, splitCombo } from "../src/cheats/parse-cht.js";
import { decodeCode } from "../src/cheats/gamegenie.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DEFAULT = path.join(__dirname, "..", "src", "cheats", "index");

// DB folder name (No-Intro/RetroArch convention) → our platform id.
const PLATFORM_DIRS = {
  "Nintendo - Nintendo Entertainment System": "nes",
  "Nintendo - Game Boy": "gb",
  "Nintendo - Game Boy Color": "gbc",
  "Nintendo - Super Nintendo Entertainment System": "snes",
  "Sega - Mega Drive - Genesis": "genesis",
  "Sega - Master System - Mark III": "sms",
  "Sega - Game Gear": "gg",
  "Atari - 2600": "atari2600",
  "Atari - 7800": "atari7800",
};

// Classify a decoded code: a compare byte means it targets ROM/code (the
// "patch the instruction" form); no compare on a low address is a RAM variable.
function classify(decoded) {
  if (!decoded) return "unknown";
  if (decoded.compare != null) return "code";
  return "ram";
}

async function buildPlatform(srcDir, dbDirName, platform) {
  const dir = path.join(srcDir, dbDirName);
  let files;
  try {
    files = (await readdir(dir)).filter((f) => f.toLowerCase().endsWith(".cht"));
  } catch {
    return null; // platform folder absent in this source tree
  }
  const games = {};
  let totalEntries = 0;
  for (const file of files) {
    const gameName = file.replace(/\.cht$/i, "");
    let txt;
    try { txt = await readFile(path.join(dir, file), "utf8"); } catch { continue; }
    const { entries } = parseCht(txt);
    const out = [];
    for (const e of entries) {
      const codes = splitCombo(e.code);
      // Decode each sub-code; keep raw codes regardless so apply can pass them
      // to the core verbatim even when we can't decode (unknown formats).
      const decoded = codes.map((c) => {
        const d = decodeCode(c, platform);
        return d ? { ...d, kind: classify(d) } : null;
      });
      out.push({
        desc: e.desc,
        code: e.code,            // raw, for apply (core decodes it)
        parts: decoded,          // decoded address/value per sub-code (null if undecodable)
      });
    }
    if (out.length) { games[gameName] = out; totalEntries += out.length; }
  }
  return { platform, gameCount: Object.keys(games).length, entryCount: totalEntries, games };
}

async function main() {
  const args = process.argv.slice(2);
  if (!args.length || args[0].startsWith("--")) {
    console.error("usage: build-cheat-index.mjs <source-cht-dir> [--out <dir>]");
    process.exit(1);
  }
  const srcDir = args[0];
  const outIdx = args.indexOf("--out");
  const outDir = outIdx >= 0 ? args[outIdx + 1] : OUT_DEFAULT;
  await mkdir(outDir, { recursive: true });

  const summary = [];
  for (const [dbDir, platform] of Object.entries(PLATFORM_DIRS)) {
    const res = await buildPlatform(srcDir, dbDir, platform);
    if (!res) { summary.push(`${platform}: (source folder absent)`); continue; }
    const outPath = path.join(outDir, `${platform}.json`);
    // Compact: no pretty-printing — this ships, size matters.
    await writeFile(outPath, JSON.stringify({
      platform: res.platform,
      source: "RetroArch / libretro-database cheats (community-aggregated)",
      gameCount: res.gameCount,
      games: res.games,
    }));
    summary.push(`${platform}: ${res.gameCount} games, ${res.entryCount} cheats → ${path.basename(outPath)}`);
  }
  console.log("Cheat index built:");
  for (const s of summary) console.log("  " + s);
}

main().catch((e) => { console.error(e); process.exit(1); });
