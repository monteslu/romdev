// memory({op:'search'}) fixes from the locate-value skill review:
//   #1 relative compares ('inc'/'dec'/'changed'/'unchanged') work as the FIRST
//      searchNext — baselines are recorded at seed time. (Previously the first
//      relative narrow silently returned 0 candidates; a real session burned
//      rounds on it and the workaround shipped as skill documentation.)
//   #2 as:'bcd' — packed-BCD value search (NES-style scores).
//   #3 as:'digits' — one byte per on-screen digit at ANY constant tile base
//      (HUD digit/tile-index buffers), base auto-detected per candidate.
//   #4 the response notes name real ops (memory({op:'search'}), op:'write'
//      with hex) — not the dead searchValue/writeMemory({bytes}) forms.

import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";

import { registerMemoryTools } from "../src/mcp/tools/memory.js";
import { _setHostForTest } from "../src/mcp/state.js";

const parse = (res) => JSON.parse(res.content.find((c) => c.type === "text").text);

function toolHandler(registerFn, toolName, sessionKey) {
  const map = {};
  registerFn({ tool: (n, _d, _s, h) => { map[n] = h; } }, z, sessionKey);
  return map[toolName];
}

function fakeMemHost(initial, platform = "nes") {
  const mem = Uint8Array.from(initial);
  return {
    status: { platform, loaded: true, frameCount: 0 },
    readMemory(_region, offset = 0, length) {
      const end = length != null ? offset + length : mem.length;
      return mem.slice(offset, end);
    },
    regionSize() { return mem.length; },
    writeMemory(_region, offset, bytes) { mem.set(bytes, offset); },
  };
}

test("relative compare works as the FIRST narrow (baseline recorded at seed)", async () => {
  const key = "search-baseline";
  const host = fakeMemHost(new Uint8Array(256));
  // Jay's live repro shape: a byte at 128 that moves to 146.
  host.writeMemory("system_ram", 40, Uint8Array.from([128]));
  host.writeMemory("system_ram", 90, Uint8Array.from([128]));   // decoy that stays put
  _setHostForTest(key, host);
  const memory = toolHandler(registerMemoryTools, "memory", key);

  parse(await memory({ op: "search", value: 128, size: 1 }));
  host.writeMemory("system_ram", 40, Uint8Array.from([146]));
  const r = parse(await memory({ op: "searchNext", compare: "inc" }));
  assert.equal(r.count, 1, "first-narrow 'inc' must keep exactly the byte that grew (was: silent 0)");
  assert.match(r.candidates[0], /^0x28=/);

  // 'unchanged' as first narrow on a fresh search keeps the decoy.
  parse(await memory({ op: "search", value: 128, size: 1, name: "second" }));
  const r2 = parse(await memory({ op: "searchNext", compare: "unchanged", name: "second" }));
  assert.equal(r2.count, 1, "'unchanged' as first narrow must work too");
  assert.match(r2.candidates[0], /^0x5a=/);
});

test("as:'bcd' finds and narrows a packed-BCD score (little-endian)", async () => {
  const key = "search-bcd";
  const host = fakeMemHost(new Uint8Array(256));
  // Score 12500 stored as 3 packed-BCD bytes, LE: 00 25 01.
  host.writeMemory("system_ram", 0x60, Uint8Array.from([0x00, 0x25, 0x01]));
  _setHostForTest(key, host);
  const memory = toolHandler(registerMemoryTools, "memory", key);

  const seed = parse(await memory({ op: "search", value: 12500, size: 3, as: "bcd" }));
  assert.equal(seed.count, 1, "BCD seed must find the packed score");
  assert.equal(seed.candidates[0], "0x60");

  // Score to 12750 → narrow with eq; then 'inc' on a further bump.
  host.writeMemory("system_ram", 0x60, Uint8Array.from([0x50, 0x27, 0x01]));
  const r = parse(await memory({ op: "searchNext", compare: "eq", value: 12750 }));
  assert.equal(r.count, 1, "BCD eq narrow must decode the new packed value");
  host.writeMemory("system_ram", 0x60, Uint8Array.from([0x00, 0x28, 0x01]));
  const r2 = parse(await memory({ op: "searchNext", compare: "inc" }));
  assert.equal(r2.count, 1, "BCD 'inc' must compare DECODED values (12800 > 12750)");
});

test("as:'digits' finds digit-per-byte buffers at any constant tile base", async () => {
  const key = "search-digits";
  const host = fakeMemHost(new Uint8Array(256));
  // HUD score 12500 as one TILE INDEX per digit, font base 0xD0: D1 D2 D5 D0 D0.
  host.writeMemory("system_ram", 0x30, Uint8Array.from([0xD1, 0xD2, 0xD5, 0xD0, 0xD0]));
  _setHostForTest(key, host);
  const memory = toolHandler(registerMemoryTools, "memory", key);

  const seed = parse(await memory({ op: "search", value: 12500, as: "digits" }));
  assert.equal(seed.count, 1, "digits seed must find the tile-index buffer");
  assert.match(seed.candidates[0], /^0x30 \(digitBase 0xd0\)/);

  // Score ticks to 12510 → the buffer redraws; eq narrows in the same base.
  host.writeMemory("system_ram", 0x30, Uint8Array.from([0xD1, 0xD2, 0xD5, 0xD1, 0xD0]));
  const r = parse(await memory({ op: "searchNext", compare: "eq", value: 12510 }));
  assert.equal(r.count, 1);
  assert.match(r.candidates[0], /^0x30=12510$/);
});

test("single-digit as:'digits' only accepts the common bases (0 / 0x30)", async () => {
  const key = "search-digit1";
  const host = fakeMemHost(new Uint8Array(64).fill(0x77)); // every byte would match with a free base
  host.writeMemory("system_ram", 10, Uint8Array.from([0x03]));        // raw digit
  host.writeMemory("system_ram", 20, Uint8Array.from([0x33]));        // ASCII '3'
  _setHostForTest(key, host);
  const memory = toolHandler(registerMemoryTools, "memory", key);
  const seed = parse(await memory({ op: "search", value: 3, as: "digits" }));
  assert.equal(seed.count, 2, "free-base matching on single digits would match everything");
});

test("search/searchNext notes name live ops, not dead tool forms", async () => {
  const key = "search-notes";
  _setHostForTest(key, fakeMemHost(new Uint8Array(64)));
  const memory = toolHandler(registerMemoryTools, "memory", key);
  parse(await memory({ op: "search", value: 7, size: 1 }));   // no matches
  const empty = parse(await memory({ op: "searchNext", compare: "eq", value: 9 }));
  assert.doesNotMatch(empty.note, /searchValue/, "stale tool name");
  assert.match(empty.note, /memory\(\{op:'search'\}\)/);
});
