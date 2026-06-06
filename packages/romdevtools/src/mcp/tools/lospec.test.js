// lospec.test.js — R17 getLospecPalette tests.
//
// We mock fetch to avoid hitting the network in unit tests. The "snap
// to NES master" path is the only platform-specific behavior and is
// the only thing we need to verify in detail.

import { test } from "node:test";
import assert from "node:assert/strict";

import { getLospecPaletteImpl } from "./lospec.js";

function mockFetch(jsonBody, status = 200) {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    async json() { return jsonBody; },
  });
}

test("getLospecPalette rejects malformed ids", async () => {
  await assert.rejects(
    getLospecPaletteImpl({ id: "Has Capitals" }),
    /looks malformed/
  );
  await assert.rejects(
    getLospecPaletteImpl({ id: "../etc/passwd" }),
    /looks malformed/
  );
});

test("getLospecPalette fetches + parses a palette JSON", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = mockFetch({
    name: "Tiny Palette",
    author: "Test",
    colors: ["ff0000", "00ff00", "0000ff", "ffffff"],
  });
  try {
    const r = await getLospecPaletteImpl({ id: "tiny-palette" });
    assert.equal(r.id, "tiny-palette");
    assert.equal(r.name, "Tiny Palette");
    assert.equal(r.colors.length, 4);
    assert.deepEqual(r.colors[0], [0xFF, 0x00, 0x00]);
    assert.deepEqual(r.colors[3], [0xFF, 0xFF, 0xFF]);
    assert.equal(r.snappedToMaster, false);
  } finally {
    globalThis.fetch = orig;
  }
});

test("getLospecPalette with asPlatform:'nes' snaps to the NES master palette", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = mockFetch({
    name: "Bright Test",
    colors: ["ff0000", "00ff00", "0000ff", "ffffff"],
  });
  try {
    const r = await getLospecPaletteImpl({ id: "bright-test", asPlatform: "nes" });
    assert.equal(r.snappedToMaster, true);
    assert.equal(r.asPlatform, "nes");
    assert.equal(r.colors.length, 4);
    // Sanity: the snapped colors should differ from raw — the master
    // doesn't contain pure 0xFF reds/greens/blues at full saturation.
    assert.notDeepEqual(r.colors[0], [0xFF, 0x00, 0x00]);
    // The source colors are preserved so the caller can compare.
    assert.deepEqual(r.sourceColors[0], [0xFF, 0x00, 0x00]);
  } finally {
    globalThis.fetch = orig;
  }
});

test("getLospecPalette with asPlatform on a platform without a master returns verbatim + note", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = mockFetch({
    name: "Generic",
    colors: ["112233", "445566"],
  });
  try {
    const r = await getLospecPaletteImpl({ id: "generic", asPlatform: "gbc" });
    assert.equal(r.snappedToMaster, false);
    assert.equal(r.asPlatform, "gbc");
    assert.match(r.note, /no hardware master palette to snap to/);
    assert.deepEqual(r.colors[0], [0x11, 0x22, 0x33]);
  } finally {
    globalThis.fetch = orig;
  }
});

test("getLospecPalette surfaces a 404 with a clear error pointing at the lospec URL", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = mockFetch({}, 404);
  try {
    await assert.rejects(
      getLospecPaletteImpl({ id: "does-not-exist" }),
      /no palette named 'does-not-exist'.*lospec\.com/s
    );
  } finally {
    globalThis.fetch = orig;
  }
});
