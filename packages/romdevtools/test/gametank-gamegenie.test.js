// GameTank Game Genie — a NEW cheat-code format for Clyde Shaffer's open GameTank
// console (no prior art). Codec round-trips + the in-core value-override device
// (romdev_cheat_set/read) substituting a byte on the CPU bus read, exactly like a
// hardware Game Genie you could build for the console's open cart bus.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  encodeGameTankGameGenie, decodeGameTankGameGenie,
  encodeForDevice, decodeCode, detectDevice, nativeDevicesFor,
} from "romdev-core-host/gamegenie.js";
import { resolveCore } from "../src/cores/registry.js";
import { LibretroHost } from "romdev-core-host/LibretroHost.js";

test("gametank GG codec: encode/decode round-trips (plain + compare)", () => {
  let n = 0;
  for (const a of [0x0000, 0x1234, 0x8100, 0xC000, 0xFFFF, 0x00FF, 0xABCD]) {
    for (const v of [0, 1, 0x42, 0x80, 0xFF]) {
      // plain
      const p = encodeGameTankGameGenie({ address: a, value: v });
      const dp = decodeGameTankGameGenie(p);
      assert.deepEqual(dp, { address: a, value: v }, `plain ${a.toString(16)}:${v.toString(16)} → ${p}`);
      // compare
      for (const cmp of [0x00, 0x05, 0xAA, 0xFF]) {
        const c = encodeGameTankGameGenie({ address: a, value: v, compare: cmp });
        const dc = decodeGameTankGameGenie(c);
        assert.deepEqual(dc, { address: a, value: v, compare: cmp });
        n++;
      }
    }
  }
  assert.ok(n > 100, "exercised many codes");
});

test("gametank GG codec: checksum rejects a corrupted code", () => {
  const good = encodeGameTankGameGenie({ address: 0x8100, value: 0x42 });
  // flip the first letter to a different valid glyph → checksum must fail
  const other = good[0] === "K" ? "L" : "K";
  const bad = other + good.slice(1);
  assert.equal(decodeGameTankGameGenie(bad), null, "corrupted code rejected");
  // total garbage
  assert.equal(decodeGameTankGameGenie("AEIOU"), null);
});

test("gametank is wired into the cheat device dispatchers", () => {
  assert.deepEqual(nativeDevicesFor("gametank"), ["game-genie"]);
  const enc = encodeForDevice({ address: 0x8100, value: 0x42 }, "gametank", "game-genie");
  assert.ok(enc && enc.code && enc.device === "game-genie");
  // decodeCode routes to the gametank codec
  const dec = decodeCode(enc.code, "gametank");
  assert.deepEqual(dec, { address: 0x8100, value: 0x42 });
  // detectDevice recognizes the wheel-code shape
  assert.equal(detectDevice(enc.code, "gametank"), "game-genie");
  // raw ADDR:VAL also decodes for gametank
  assert.deepEqual(decodeCode("8100:42", "gametank"), { address: 0x8100, value: 0x42 });
});

test("gametank core: romdev_cheat value-override substitutes a bus read", async () => {
  const c = resolveCore("gametank");
  const h = new LibretroHost();
  await h.loadCore(c.jsPath, c.wasmPath, {});
  const mod = h.mod;
  assert.equal(typeof mod._romdev_cheat_set, "function", "core exposes romdev_cheat_set");
  assert.equal(typeof mod._romdev_cheat_read, "function", "core exposes romdev_cheat_read");

  // idle: no substitution
  assert.equal(mod._romdev_cheat_read(0x8100, 0x11), 0x11);

  // plain code: always substitute
  mod._romdev_cheat_set(0, 0x8100, 0x42, 0, 0, 1);
  assert.equal(mod._romdev_cheat_read(0x8100, 0x11), 0x42, "substitutes");
  assert.equal(mod._romdev_cheat_read(0x8200, 0x11), 0x11, "other address unaffected");

  // compare code (slot 1): only when the real byte matches
  mod._romdev_cheat_set(1, 0x9000, 0x99, 0x05, 1, 1);
  assert.equal(mod._romdev_cheat_read(0x9000, 0x05), 0x99, "compare hit substitutes");
  assert.equal(mod._romdev_cheat_read(0x9000, 0x06), 0x06, "compare miss leaves it alone");

  // disable
  mod._romdev_cheat_set(0, 0x8100, 0x42, 0, 0, 0);
  assert.equal(mod._romdev_cheat_read(0x8100, 0x11), 0x11, "disabled → passthrough");
});

test("gametank host.setCheat applies a GG code through the romdev device", async () => {
  const c = resolveCore("gametank");
  const h = new LibretroHost();
  await h.loadCore(c.jsPath, c.wasmPath, {});
  h.status.platform = "gametank";
  assert.equal(h.cheatsSupported(), true);
  assert.equal(h._usesRomdevCheatDevice(), true);

  const code = encodeGameTankGameGenie({ address: 0x8100, value: 0x42 });
  h.setCheat(0, code, true);
  assert.equal(h.mod._romdev_cheat_read(0x8100, 0x00), 0x42, "GG code applied → substitutes");
  h.setCheat(0, code, false);
  assert.equal(h.mod._romdev_cheat_read(0x8100, 0x00), 0x00, "disabled");
});
