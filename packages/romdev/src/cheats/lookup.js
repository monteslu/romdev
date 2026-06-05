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

// The cheat index lives in the romdev-cheats package (kept separate so the main
// package stays small and the DB versions on its own cadence). Resolve its
// index/ directory once via the package's module URL — same pattern the core
// registry uses (import.meta.resolve). Fall back to a sibling ./index dir for
// dev checkouts where the package isn't linked yet.
function resolveIndexDir() {
  try {
    const pkgUrl = import.meta.resolve("romdev-cheats");
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

// Normalize a name for fuzzy comparison: lowercase, drop extension, collapse
// whitespace. We do NOT strip region/revision tags — those distinguish dumps
// (USA vs Japan have different addresses), so an EXACT match must keep them.
function normalize(name) {
  return name.toLowerCase().replace(/\.[a-z0-9]+$/i, "").replace(/\s+/g, " ").trim();
}

// A "base name" with region/revision/dump tags stripped — for FUZZY matching
// only. "(World)", "(USA, Europe)", "(Rev A)", "[!]", "(Action Replay)" etc. are
// dropped and separators normalized, so "NBA Jam - Tournament Edition (World)",
// "NBA Jam Tournament Edition", and "NBA Jam - Tournament Edition (USA) (Rev 1)"
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

/** Token set of a base name, for overlap scoring. */
function tokenSet(name) {
  return new Set(baseName(name).split(" ").filter(Boolean));
}

/** Jaccard overlap (0..1) between two token sets. */
function tokenScore(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

/**
 * Fuzzy-search a platform's cheat index by game name. Returns the best-matching
 * game names + cheat counts WITHOUT dumping the whole DB — so an agent can find
 * "NBA Jam Tournament" → the real entry without a huge context load.
 * @param {object} a
 * @param {string} a.platform
 * @param {string} a.query
 * @param {number} [a.limit]
 * @param {number} [a.minScore]
 * @returns {Promise<{platform:string, query:string, matches:Array<{game:string, score:number, cheats:number}>, gameCount:number, note:string}>}
 */
export async function searchCheatGames({ platform, query, limit = 12, minScore = 0.25 }) {
  const idx = await loadIndex(platform);
  if (!idx || !idx.games) {
    return { platform, query, matches: [], gameCount: 0, note: `No bundled cheat index for platform '${platform}'.` };
  }
  const qTok = tokenSet(query);
  const qBase = baseName(query);
  const names = Object.keys(idx.games);
  const scored = [];
  for (const n of names) {
    const nBase = baseName(n);
    let score = tokenScore(qTok, tokenSet(n));
    // Boost substring containment either way (handles partial queries + abbrevs).
    if (qBase && (nBase.includes(qBase) || qBase.includes(nBase))) score = Math.max(score, 0.6);
    if (score >= minScore) scored.push({ game: n, score: Math.round(score * 100) / 100, cheats: (idx.games[n] || []).length });
  }
  scored.sort((a, b) => b.score - a.score || a.game.length - b.game.length);
  const matches = scored.slice(0, limit);
  return {
    platform, query, matches,
    gameCount: idx.gameCount ?? names.length,
    note: matches.length === 0
      ? `No game in the ${platform} cheat DB (${names.length} games) is close to "${query}". Try fewer/looser words.`
      : `${matches.length} candidate(s) by name-overlap. Pass an exact \`game\` to gameCheats (it also fuzzy-matches now). Score is name similarity, not a content guarantee — verify a label before patching.`,
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

  // 3. FUZZY fallback: tag-stripped token-overlap. Catches the common failure
  //    where identifyRom's name differs from the DB key by a region/revision tag
  //    or punctuation ("NBA Jam - Tournament Edition (World)" vs a (USA) dump or
  //    a missing hyphen) — the entry IS in the DB, just under a sibling name.
  let fuzzyAlternatives = [];
  if (!hit) {
    const q = romName || fileName;
    if (q) {
      const qTok = tokenSet(q), qBase = baseName(q);
      const ranked = [];
      for (const n of names) {
        const nBase = baseName(n);
        let score = tokenScore(qTok, tokenSet(n));
        if (qBase && (nBase.includes(qBase) || qBase.includes(nBase))) score = Math.max(score, 0.6);
        if (score >= 0.5) ranked.push({ n, score });
      }
      ranked.sort((a, b) => b.score - a.score || a.n.length - b.n.length);
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
