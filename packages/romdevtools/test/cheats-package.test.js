// The cheat DB lives in its own package (romdev_game_codes). These guards verify
// romdev resolves it, lazy-loads ONE platform at a time, carries exactly the
// supported platforms the community cheats tree covers (incl. the two newest,
// PCE + MSX), and correctly OMITS C64 (no source cheats).

import { test } from "node:test";
import assert from "node:assert/strict";
import { loadPlatformIndex, hasPlatform, listPlatforms } from "romdev_game_codes";
import { lookupCheats, searchCheatGames } from "../src/cheats/lookup.js";

test("romdev_game_codes resolves and lists the bundled platforms", () => {
  const plats = listPlatforms();
  // 13 = the 14 romdev platforms minus C64 (no community cheat folder).
  for (const p of ["nes", "gb", "gbc", "gba", "snes", "genesis", "sms", "gg", "atari2600", "atari7800", "lynx", "pce", "msx"]) {
    assert.ok(plats.includes(p), `expected cheat index for ${p}`);
  }
  assert.ok(!plats.includes("c64"), "C64 must NOT have an index (no source cheats)");
});

test("loadPlatformIndex lazy-loads a single platform (PCE), null for absent (C64)", async () => {
  const pce = await loadPlatformIndex("pce");
  assert.ok(pce && pce.games, "PCE index should load");
  assert.ok(pce.gameCount > 100, `PCE should have many games (got ${pce.gameCount})`);
  assert.equal(await loadPlatformIndex("c64"), null, "C64 has no index → null");
  assert.equal(hasPlatform("c64"), false);
  assert.equal(hasPlatform("msx"), true);
});

test("romdev lookupCheats resolves PCE cheats through the package", async () => {
  const r = await lookupCheats({ platform: "pce", romName: "1943 Kai (Japan)" });
  assert.equal(r.matched, true);
  assert.ok(r.entries.length >= 1, "PCE 1943 Kai should have cheats");
  // PCE codes are raw hex ADDR:VAL — the first part's address must decode.
  assert.equal(typeof r.entries[0].parts[0].address, "number");
});

test("MSX cheats are stored as hex ADDR:VAL (decimal source converted)", async () => {
  // The MSX struct form uses DECIMAL addresses; the index must store hex so the
  // raw-code decoder reads them correctly. 1942 'stage' = decimal 11552 = 0x2D20.
  const res = await searchCheatGames({ platform: "msx", query: "1942" });
  assert.ok(res.matches.length >= 1, "MSX 1942 should be findable");
  const idx = await loadPlatformIndex("msx");
  const game = idx.games[res.matches[0].game];
  const stage = game.find((e) => /stage/i.test(e.desc));
  assert.ok(stage, "expected a 'stage' cheat");
  // code is hex; its decoded address round-trips back to the decimal source.
  assert.match(stage.code, /^[0-9a-f]+:[0-9a-f]+$/i, "hex ADDR:VAL");
  assert.equal(stage.parts[0].address, parseInt(stage.code.split(":")[0], 16));
});
