// Tests for the response-shaping filters added for the play-screen-port user:
// inspectSprites slots[]/maxSlots, and inspectBackgroundMap tilesOnly/
// attributesOnly/region. Driven through the registered tool handlers with a
// fake host (no real emulator needed — this is pure response logic).

import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { registerPlatformTools } from "../src/mcp/tools/platform-tools.js";
import { registerMetaSpriteTools } from "../src/mcp/tools/metasprite-tools.js";
import { registerRenderingContextTools } from "../src/mcp/tools/rendering-context.js";
import { _setHostForTest } from "../src/mcp/state.js";

// Capture tool handlers. Both inspectSprites and inspectBackgroundMap moved into
// consolidated tools: sprites({op:'inspect'}) and background({view:'map'}). Their
// cores are live-binding exports from platform-tools.js, so register
// registerPlatformTools FIRST (assigns the cores), then the routers. Same
// sessionKey throughout. The two adapters keep these (frozen) assertions
// unchanged.
function handlers() {
  const map = {};
  const server = { tool(name, _desc, _schema, h) { map[name] = h; } };
  registerPlatformTools(server, z, "pt-test");        // assigns inspectSpritesCore + inspectBackgroundMapCore
  registerMetaSpriteTools(server, z, "pt-test");       // sprites router
  registerRenderingContextTools(server, z, "pt-test"); // background router
  map.inspectSprites = (args) => map.sprites({ op: "inspect", ...args });
  map.inspectBackgroundMap = (args) => map.background({ view: "map", ...args });
  return map;
}

function parse(res) {
  return JSON.parse(res.content.find((c) => c.type === "text").text);
}

// Fake NES host: 64 OAM sprites, and a CIRAM with a known attribute byte.
function makeNesHost() {
  const oam = new Uint8Array(256);
  for (let i = 0; i < 64; i++) {
    oam[i * 4 + 0] = i;          // y
    oam[i * 4 + 1] = 0x10 + i;   // tile
    oam[i * 4 + 2] = i & 0x3;    // attr (palette in low bits)
    oam[i * 4 + 3] = i * 2;      // x
  }
  const ciram = new Uint8Array(2048);
  for (let r = 0; r < 30; r++)
    for (let c = 0; c < 32; c++)
      ciram[r * 32 + c] = (c + r) & 0xFF;
  ciram[960] = 0x1B; // attr byte 0: TL=3,TR=2,BL=1,BR=0
  return {
    status: { platform: "nes" },
    readMemory(region, offset, length) {
      const src = region === "nes_oam" ? oam : ciram;
      return src.slice(offset, offset + length);
    },
  };
}

test("inspectSprites maxSlots returns the first N with honest slot indices", async () => {
  _setHostForTest("pt-test", makeNesHost());
  const h = handlers();
  const r = parse(await h.inspectSprites({ maxSlots: 8 }));
  assert.equal(r.slotsTotal, 64);
  assert.equal(r.slotsReturned, 8);
  assert.equal(r.sprites.length, 8);
  assert.equal(r.sprites[0].slot, 0);
  assert.equal(r.sprites[7].slot, 7);
});

test("inspectSprites slots[] selects non-contiguous indices, wins over maxSlots", async () => {
  _setHostForTest("pt-test", makeNesHost());
  const h = handlers();
  const r = parse(await h.inspectSprites({ slots: [0, 4, 9], maxSlots: 2 }));
  assert.equal(r.slotsReturned, 3);
  assert.deepEqual(r.sprites.map((s) => s.slot), [0, 4, 9]);
});

test("inspectBackgroundMap default returns tiles + subPaletteGrid", async () => {
  _setHostForTest("pt-test", makeNesHost());
  const h = handlers();
  const r = parse(await h.inspectBackgroundMap({ region: { x: 0, y: 0, w: 4, h: 4 } }));
  assert.ok(r.tiles, "has tiles");
  assert.ok(r.subPaletteGrid, "has subPaletteGrid");
  assert.equal(r.subPaletteGrid[0][0], 3); // TL quadrant of attr byte 0x1B
  assert.equal(r.subPaletteGrid[2][2], 0); // BR quadrant
  assert.ok("attrTableFullHex" in r);
});

test("inspectBackgroundMap attributesOnly omits the tiles grid", async () => {
  _setHostForTest("pt-test", makeNesHost());
  const h = handlers();
  const r = parse(await h.inspectBackgroundMap({ attributesOnly: true, region: { x: 0, y: 0, w: 4, h: 2 } }));
  assert.ok(r.subPaletteGrid);
  assert.equal(r.tiles, undefined);
  // subPaletteGrid IS region-clipped.
  assert.equal(r.subPaletteGrid.length, 2);
  assert.equal(r.subPaletteGrid[0].length, 4);
});

test("inspectBackgroundMap tilesOnly omits the subPaletteGrid", async () => {
  _setHostForTest("pt-test", makeNesHost());
  const h = handlers();
  const r = parse(await h.inspectBackgroundMap({ tilesOnly: true, region: { x: 5, y: 5, w: 3, h: 3 } }));
  assert.ok(r.tiles);
  assert.ok(r.distinctTiles);
  assert.equal(r.subPaletteGrid, undefined);
});

test("inspectBackgroundMap rejects attributesOnly + tilesOnly together", async () => {
  _setHostForTest("pt-test", makeNesHost());
  const h = handlers();
  const res = await h.inspectBackgroundMap({ attributesOnly: true, tilesOnly: true });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /mutually exclusive/);
});

// Regression: the *Core functions (inspectSpritesCore, getCPUStateCore, ...) are
// module-level `export let` bindings reassigned on every registerPlatformTools()
// run. They MUST resolve the host from the session of the CALLING router, not from
// whatever session registered last. The bug: a session A (genesis) would have its
// sprites({op:'inspect'}) silently read session B's host (gbc, registered later),
// producing a gbc-flavored "video_ram empty on platform 'gbc'" error while genesis
// was loaded + requested. See the metasprite-tools sprites router passing sessionKey.
function makeNesHostFor(platform) {
  const host = makeNesHost();
  host.status = { platform };
  return host;
}

test("sprites({op:'inspect'}) reads the CALLING session's host, not the last-registered one", async () => {
  // Register session A FIRST, then session B — B's registration reassigns the
  // module-level inspectSpritesCore closure (the old bug's trap). Each session
  // gets its own router via its own registration.
  function handlersFor(sessionKey) {
    const map = {};
    const server = { tool(name, _desc, _schema, hnd) { map[name] = hnd; } };
    registerPlatformTools(server, z, sessionKey);
    registerMetaSpriteTools(server, z, sessionKey);
    return map;
  }
  const hA = handlersFor("sess-A-genesis");
  // The RETURN value is unused — what matters is the SIDE EFFECT: registering
  // session B last is what would steal the module-global closure (the bug).
  handlersFor("sess-B-gbc");
  _setHostForTest("sess-A-genesis", makeNesHostFor("nes")); // stand-in host, platform tagged A
  _setHostForTest("sess-B-gbc", makeNesHostFor("gbc"));

  // Session A's sprites inspect must resolve session A's host (platform 'nes'),
  // NOT session B's ('gbc'). Pre-fix this returned B's platform.
  const rA = parse(await hA.sprites({ op: "inspect", maxSlots: 2 }));
  assert.equal(rA.platform, "nes", "session A must read its own (nes) host");

  // And session B still reads its own (gbc decodes via the gb branch; give it a
  // gb-shaped fake by reusing the nes host but tagging platform — the gb branch
  // needs a real ppu snapshot, so just assert A is correct + B doesn't leak A).
  // The key invariant under test is no cross-session host resolution.
  const rA2 = parse(await hA.sprites({ op: "inspect", maxSlots: 1 }));
  assert.equal(rA2.platform, "nes", "repeat call on A is still A");
});
