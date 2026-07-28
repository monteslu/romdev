// Match a ROM to the bundled cheat index and return its decoded entries.
//
// CONFIDENCE — the trust model (same discipline as byte-exact disasm: never
// overclaim). Three tiers, always reported so the agent knows how much to trust
// the labels:
//   "name"     — matched by No-Intro game name derived from the file. We do NOT
//                have a CRC database to confirm the exact dump, so this is a
//                PROBABLE match: the labels are very likely right but the tool
//                MUST tell the agent it cannot positively identify the ROM.
//   "filename" — matched by the file's basename alone (weaker than a parsed
//                No-Intro name). Probable, lower confidence.
//   "none"     — no match; return nothing rather than guess.
// (A future "crc" tier would confirm via a No-Intro DAT; not bundled yet.)

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import Fuse from "fuse.js";

// The cheat index lives in the romdev_game_codes package (kept separate so the
// main package stays small and the DB versions on its own cadence). Resolve its
// index/ directory once via the package's module URL — same pattern the core
// registry uses (import.meta.resolve). Fall back to a sibling ./index dir for
// dev checkouts where the package isn't linked yet.
function resolveIndexDir() {
  try {
    const pkgUrl = import.meta.resolve("romdev_game_codes");
    return path.join(path.dirname(fileURLToPath(pkgUrl)), "index");
  } catch {
    return path.join(path.dirname(fileURLToPath(import.meta.url)), "index");
  }
}
const INDEX_DIR = resolveIndexDir();

// CRC32 (IEEE) — computed but currently informational (no DAT to verify
// against). Returned in the result so callers/users can cross-check externally.
let _crcTable = null;
function crc32(bytes) {
  if (!_crcTable) {
    _crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      _crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = _crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return ((crc ^ 0xffffffff) >>> 0);
}

const _indexCache = new Map(); // platform → parsed index (or null)
async function loadIndex(platform) {
  if (_indexCache.has(platform)) return _indexCache.get(platform);
  const p = path.join(INDEX_DIR, `${platform}.json`);
  let idx = null;
  if (existsSync(p)) {
    try { idx = JSON.parse(await readFile(p, "utf8")); } catch { idx = null; }
  }
  _indexCache.set(platform, idx);
  return idx;
}

// Per-platform Fuse index, built lazily and cached. We do NOT let Fuse search
// the raw No-Intro names directly — those are dominated by region/revision tags
// (`(World)`, `(USA, Europe)`, `(Rev A)`) that swamp the fuzzy distance. Instead
// we index the TAG-STRIPPED baseName as the search key (Fuse handles typos +
// word-order/substring fuzz; baseName handles the tag noise), and keep the raw
// `game` name + `cheats` count on each record for display. Same library +
// ignoreLocation:true config loukai uses for media search.
const _fuseCache = new Map(); // platform → Fuse | null
async function getFuse(platform) {
  if (_fuseCache.has(platform)) return _fuseCache.get(platform);
  const idx = await loadIndex(platform);
  if (!idx || !idx.games) { _fuseCache.set(platform, null); return null; }
  const records = Object.keys(idx.games).map((game) => ({
    game,                       // raw No-Intro name (for display/return)
    base: baseName(game),       // tag-stripped key Fuse searches
    cheats: (idx.games[game] || []).length,
  }));
  const fuse = new Fuse(records, {
    keys: ["base"],
    threshold: 0.3,        // 0 = exact, 1 = match anything (loukai's media-search default)
    ignoreLocation: true,  // match anywhere in the name, not just the start
    includeScore: true,    // Fuse score is a DISTANCE: 0 = perfect, 1 = worst
    findAllMatches: true,
    minMatchCharLength: 2,
  });
  _fuseCache.set(platform, fuse);
  return fuse;
}

// Fuse returns a distance (0 best). Convert to a 0..1 SIMILARITY for our API
// (1 best) so the returned `score` keeps its old meaning for callers.
function simFromFuse(distance) {
  return Math.round((1 - (distance ?? 1)) * 100) / 100;
}

// Normalize a name for fuzzy comparison: lowercase, drop extension, collapse
// whitespace. We do NOT strip region/revision tags — those distinguish dumps
// (USA vs Japan have different addresses), so an EXACT match must keep them.
function normalize(name) {
  return name.toLowerCase().replace(/\.[a-z0-9]+$/i, "").replace(/\s+/g, " ").trim();
}

// A "base name" with region/revision/dump tags stripped — for FUZZY matching
// only. "(World)", "(USA, Europe)", "(Rev A)", "[!]", "(Action Replay)" etc. are
// dropped and separators normalized, so "Some Game - Special Edition (World)",
// "Some Game Special Edition", and "Some Game - Special Edition (USA) (Rev 1)"
// collapse to the same key. Used as a fallback when exact match fails.
function baseName(name) {
  return name
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/i, "")          // extension
    .replace(/\([^)]*\)/g, " ")            // (World), (Rev A), (USA, Europe), ...
    .replace(/\[[^\]]*\]/g, " ")           // [!], [b1], ...
    .replace(/[-_:]/g, " ")                // separators
    .replace(/[^a-z0-9 ]/g, " ")           // punctuation
    .replace(/\s+/g, " ")
    .trim();
}

// The platforms that ship a bundled cheat index — the set searchCheatGames sweeps
// when no `platform` is given. (Kept in step with cheats.js SUPPORTED; C64 has no
// source cheats so it has no index.)
const INDEXED_PLATFORMS = [
  "nes", "gb", "gbc", "snes", "genesis", "sms", "gg",
  "atari2600", "atari7800", "lynx", "gba", "pce", "msx",
];

/**
 * Fuzzy-search the cheat DB by game NAME. Each match carries the `platform` it
 * was found on, so the caller never has to know the console up front. By default
 * this searches EVERY indexed platform (the natural ask: "find a game's cheats"
 * — you shouldn't have to name the device); pass `platform` only to scope the
 * search to one console. Returns best-matching game names + cheat counts WITHOUT
 * dumping the whole DB.
 * @param {object} a
 * @param {string} a.query
 * @param {string} [a.platform]  optional — restrict to one platform; omit to search all
 * @param {number} [a.limit]
 * @param {number} [a.minScore]
 * @returns {Promise<{platform:string|null, query:string, matches:Array<{game:string, platform:string, score:number, cheats:number}>, gameCount:number, note:string}>}
 */
export async function searchCheatGames({ platform, query, limit = 12, minScore = 0.25 }) {
  const platforms = platform ? [platform] : INDEXED_PLATFORMS;
  let scored = [];
  let gameCount = 0;
  let missing = [];
  for (const plat of platforms) {
    const idx = await loadIndex(plat);
    if (!idx || !idx.games) { missing.push(plat); continue; }
    gameCount += idx.gameCount ?? Object.keys(idx.games).length;
    const fuse = await getFuse(plat);
    if (!fuse) continue;
    for (const r of fuse.search(baseName(query))) {
      const score = simFromFuse(r.score);
      if (score >= minScore) scored.push({ game: r.item.game, platform: plat, score, cheats: r.item.cheats });
    }
  }
  // When scoped to one platform and that platform has no index at all, say so.
  if (platform && missing.length) {
    return { platform, query, matches: [], gameCount: 0, note: `No bundled cheat index for platform '${platform}'.` };
  }
  const matches = scored
    .sort((a, b) => b.score - a.score || a.game.length - b.game.length)
    .slice(0, limit);
  const scope = platform ? `the ${platform} cheat DB` : `the cheat DB (all ${platforms.length - missing.length} platforms)`;
  return {
    platform: platform ?? null,
    query, matches, gameCount,
    note: matches.length === 0
      ? `No game in ${scope} (${gameCount} games) is close to "${query}". Try fewer/looser words.`
      : `${matches.length} candidate(s) by fuzzy name match across ${platform ? "1 platform" : "all platforms"} (each match shows its \`platform\`; region/revision tags ignored, typo-tolerant). To read a game's cheats, call cheats({op:'lookup', platform, game}) with the match's own platform. Score is name similarity, not a content guarantee — verify a label before patching.`,
  };
}

/**
 * Look up cheats for a ROM.
 * @param {object} a
 * @param {string} a.platform   our platform id (nes/gb/genesis/...)
 * @param {string} [a.romName]  No-Intro-style name (from identifyRom), preferred
 * @param {string} [a.fileName] the ROM file's basename, fallback match
 * @param {Uint8Array} [a.bytes] ROM bytes, for the informational CRC32
 * @returns {Promise<{matched:boolean, confidence:string, game?:string,
 *   platform:string, crc32?:string, entries?:Array, note:string}>}
 */
export async function lookupCheats({ platform, romName, fileName, bytes }) {
  const idx = await loadIndex(platform);
  const crc = bytes ? crc32(bytes).toString(16).padStart(8, "0").toUpperCase() : undefined;
  if (!idx || !idx.games) {
    return {
      matched: false, confidence: "none", platform,
      ...(crc ? { crc32: crc } : {}),
      note: `No bundled cheat index for platform '${platform}'.`,
    };
  }

  const names = Object.keys(idx.games);
  const want = romName ? normalize(romName) : null;
  const wantFile = fileName ? normalize(fileName) : null;

  // 1. Exact No-Intro name match (strongest available).
  let hit = null, confidence = "none";
  if (want) {
    hit = names.find((n) => normalize(n) === want);
    if (hit) confidence = "name";
  }
  // 2. Fall back to filename match.
  if (!hit && wantFile) {
    hit = names.find((n) => normalize(n) === wantFile);
    if (hit) confidence = "filename";
    // 2b. lenient: filename is a prefix of a DB name (drops "(USA)" etc.)
    if (!hit) {
      hit = names.find((n) => normalize(n).startsWith(wantFile + " ("));
      if (hit) confidence = "filename";
    }
  }

  // 3. FUZZY fallback (Fuse over the tag-stripped baseName). Catches the common
  //    failure where identifyRom's name differs from the DB key by a region/
  //    revision tag or punctuation ("Some Game - Special Edition (World)" vs a
  //    (USA) dump or a missing hyphen), AND now typos — the entry IS in the DB,
  //    just under a sibling name. Stricter threshold than searchCheats: this
  //    auto-PICKS an entry, so require a strong (≤0.4 distance → ≥0.6 sim) match.
  let fuzzyAlternatives = [];
  if (!hit) {
    const q = romName || fileName;
    if (q) {
      const fuse = await getFuse(platform);
      const ranked = fuse.search(baseName(q))
        .map((r) => ({ n: r.item.game, score: simFromFuse(r.score) }))
        .filter((r) => r.score >= 0.6)
        .sort((a, b) => b.score - a.score || a.n.length - b.n.length);
      if (ranked.length) {
        hit = ranked[0].n;
        confidence = "fuzzy";
        // Surface a few sibling matches (other regions/revisions) so the agent
        // can pick the right dump — addresses can differ across regions.
        fuzzyAlternatives = ranked.slice(0, 6).map((r) => r.n);
      }
    }
  }

  if (!hit) {
    return {
      matched: false, confidence: "none", platform,
      ...(crc ? { crc32: crc } : {}),
      note: `No cheat-DB entry matched this ROM in the bundled '${platform}' index ` +
        `(${names.length} games). It may be an unlisted dump, a homebrew/WIP ROM, ` +
        `or a name/revision the DB doesn't carry. Try searchCheats({platform, query}) ` +
        `with a looser name if you think it should be there.`,
    };
  }

  const howMatched = confidence === "name" ? "No-Intro name"
    : confidence === "filename" ? "filename"
    : "fuzzy name similarity (tags stripped)";
  return {
    matched: true,
    confidence,
    game: hit,
    platform,
    ...(crc ? { crc32: crc } : {}),
    ...(fuzzyAlternatives.length > 1 ? { alternatives: fuzzyAlternatives } : {}),
    entries: idx.games[hit],
    // CRITICAL honesty: a name/filename/fuzzy match is NOT a positive identification.
    note:
      "PROBABLE MATCH by " + howMatched +
      " — NOT a verified (CRC) identification. The cheat labels are very likely " +
      "correct for this game, but a different ROM revision/region can use different " +
      "addresses. Verify a label (e.g. apply the cheat and observe, or check the " +
      "address in live memory) before relying on it for a patch. crc32 is provided " +
      "for your own cross-check." +
      (confidence === "fuzzy"
        ? " NOTE: this was a FUZZY match — the exact dump name didn't match the DB, so I picked the closest title" +
          (fuzzyAlternatives.length > 1 ? `; \`alternatives\` lists sibling region/revision entries — pick the one matching your ROM's region, addresses can differ.` : ".")
        : ""),
  };
}

export { crc32 };
