// Tests for the .cht parser and the cheat-index lookup (incl. the honesty of
// the confidence tiers). The decoder vectors live in gamegenie.test.js.

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCht, splitCombo } from "./parse-cht.js";
import { lookupCheats, crc32 } from "./lookup.js";

test("parseCht reads cheats=N + cheatK_desc/code/enable", () => {
  const txt = [
    "cheats = 2",
    "",
    'cheat0_desc = "Infinite Lives"',
    'cheat0_code = "00C7:FF"',
    "cheat0_enable = false",
    "",
    'cheat1_desc = "Invincible"',
    'cheat1_code = "SXIOPO"',
    "cheat1_enable = true",
  ].join("\n");
  const r = parseCht(txt);
  assert.equal(r.count, 2);
  assert.equal(r.entries.length, 2);
  assert.deepEqual(r.entries[0], { index: 0, desc: "Infinite Lives", code: "00C7:FF", enable: false });
  assert.equal(r.entries[1].enable, true);
});

test("parseCht synthesizes ADDR:VAL from legacy _address/_value", () => {
  const txt = ['cheat0_desc = "x"', "cheat0_address = 1234", "cheat0_value = 0A"].join("\n");
  const r = parseCht(txt);
  assert.equal(r.entries[0].code, "1234:0A");
});

test("parseCht drops entries with no usable code", () => {
  const txt = ['cheat0_desc = "label only, no code"'].join("\n");
  assert.equal(parseCht(txt).entries.length, 0);
});

test("splitCombo splits +-joined multi-codes", () => {
  assert.deepEqual(splitCombo("AAAA+BBBB+CCCC"), ["AAAA", "BBBB", "CCCC"]);
  assert.deepEqual(splitCombo("00C7:FF"), ["00C7:FF"]);
});

test("crc32 matches the IEEE reference for a known input", () => {
  // CRC32 of ASCII "123456789" is the canonical 0xCBF43926.
  assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926);
});

test("lookupCheats: matched name → entries + PROBABLE-match honesty", async () => {
  // Rygar is in the bundled NES index; match by the No-Intro filename.
  const r = await lookupCheats({ platform: "nes", fileName: "Rygar (USA).nes" });
  assert.equal(r.matched, true);
  assert.equal(r.game, "Rygar (USA)");
  assert.ok(r.entries.length > 0);
  // The trust discipline: a name/filename match must NOT claim positive ID.
  assert.notEqual(r.confidence, "crc");
  assert.match(r.note, /PROBABLE MATCH/);
  assert.match(r.note, /NOT a verified/i);
  // A known RAM label decoded correctly.
  const magic = r.entries.find((e) => /magic attack/i.test(e.desc));
  assert.ok(magic && magic.parts[0].address === 0x00cd, "Infinite Magic Attack → $00CD");
});

test("lookupCheats: no match returns nothing (never guesses) + a clear note", async () => {
  const r = await lookupCheats({ platform: "nes", fileName: "Totally Not A Real Game 9999.nes" });
  assert.equal(r.matched, false);
  assert.equal(r.confidence, "none");
  assert.ok(!r.entries);
  assert.match(r.note, /No cheat-DB entry matched/);
});

test("lookupCheats: unsupported/absent platform index → graceful none", async () => {
  const r = await lookupCheats({ platform: "n64", fileName: "whatever.z64" });
  assert.equal(r.matched, false);
  assert.equal(r.confidence, "none");
});

// ── Fuzzy game-name matching (the NBA Jam TE regression) ──────────────────
// A client's ROM "NBA Jam - Tournament Edition (World) (Rev A)" / a (USA) dump /
// the abbreviation failed to match even though the entry IS in the DB under
// "NBA Jam - Tournament Edition (World)". Exact match was too brittle; the fuzzy
// fallback (tag-stripped token overlap) must catch these.
import { searchCheatGames } from "./lookup.js";

test("lookupCheats: fuzzy-matches NBA Jam TE name variants to the real DB entry", async () => {
  for (const name of [
    "NBA Jam Tournament Edition",                    // missing hyphen + region
    "NBA Jam - Tournament Edition (USA, Europe)",     // different region tag
    "NBA Jam - Tournament Edition (World) (Rev A)",   // extra revision tag
  ]) {
    const r = await lookupCheats({ platform: "genesis", romName: name });
    assert.equal(r.matched, true, `should fuzzy-match "${name}"`);
    assert.match(r.game, /NBA Jam - Tournament Edition/);
    assert.ok(r.entries && r.entries.length > 0, "should return the cheat entries");
    assert.equal(r.confidence, "fuzzy");
  }
});

test("lookupCheats: an exact name still matches as 'name' (not downgraded to fuzzy)", async () => {
  const r = await lookupCheats({ platform: "genesis", romName: "NBA Jam - Tournament Edition (World)" });
  assert.equal(r.matched, true);
  assert.equal(r.confidence, "name");
});

test("searchCheatGames: fuzzy query ranks the right game first, no full-DB dump", async () => {
  const r = await searchCheatGames({ platform: "genesis", query: "nba jam tournament" });
  assert.ok(r.matches.length > 0, "should return candidates");
  assert.match(r.matches[0].game, /NBA Jam - Tournament Edition/);
  assert.ok(r.matches[0].cheats > 0, "candidate should report its cheat count");
  assert.ok(r.matches.length <= 12, "must not dump the whole DB");
});

test("searchCheatGames: a nonsense query returns no matches, not garbage", async () => {
  const r = await searchCheatGames({ platform: "genesis", query: "zzqxqzznotagame" });
  assert.equal(r.matches.length, 0);
});
