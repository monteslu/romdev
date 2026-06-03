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

const INDEX_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "index");

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
// (USA vs Japan have different addresses), so they must match.
function normalize(name) {
  return name.toLowerCase().replace(/\.[a-z0-9]+$/i, "").replace(/\s+/g, " ").trim();
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

  if (!hit) {
    return {
      matched: false, confidence: "none", platform,
      ...(crc ? { crc32: crc } : {}),
      note: `No cheat-DB entry matched this ROM in the bundled '${platform}' index ` +
        `(${names.length} games). It may be an unlisted dump, a homebrew/WIP ROM, ` +
        `or a name/revision the DB doesn't carry.`,
    };
  }

  return {
    matched: true,
    confidence,
    game: hit,
    platform,
    ...(crc ? { crc32: crc } : {}),
    entries: idx.games[hit],
    // CRITICAL honesty: a name/filename match is NOT a positive identification.
    note:
      "PROBABLE MATCH by " + (confidence === "name" ? "No-Intro name" : "filename") +
      " — NOT a verified (CRC) identification. The cheat labels are very likely " +
      "correct for this game, but a different ROM revision/region can use different " +
      "addresses. Verify a label (e.g. apply the cheat and observe, or check the " +
      "address in live memory) before relying on it for a patch. crc32 is provided " +
      "for your own cross-check.",
  };
}

export { crc32 };
