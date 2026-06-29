// v0.71.0 feedback (pokeruby/GBA discovery friction):
//  - platform({op:'list'}) ignored the `platform` filter → full 16-platform dump
//    was the biggest token sink. Now `platform` returns one row, `slim` drops notes.
//  - platform({op:'resolve'}) reported only the core, not the toolchain → had to
//    spelunk node_modules. Now it surfaces toolchains[] + a harness-only note.

import { test } from "node:test";
import assert from "node:assert/strict";
import { listPlatformsCore, resolvePlatformCore } from "../src/mcp/tools/platforms.js";

test("platform list: `platform` filter returns ONE row (not the whole matrix)", () => {
  const full = listPlatformsCore();
  assert.ok(Array.isArray(full.platforms) && full.platforms.length > 14, "full list is the matrix");

  const one = listPlatformsCore({ platform: "gba" });
  assert.equal(one.platform, "gba", "single-platform query returns just that row");
  assert.ok(!one.platforms, "not wrapped in platforms[]");
  assert.ok(one.toolchains && one.languages, "still has toolchains + languages");
  // big token win: one platform is a small fraction of the full matrix
  assert.ok(JSON.stringify(one).length < JSON.stringify(full).length / 5,
    `gba-only is much smaller than the matrix (${JSON.stringify(one).length} vs ${JSON.stringify(full).length})`);

  assert.throws(() => listPlatformsCore({ platform: "bogus" }), /unknown platform 'bogus'/);
});

test("platform list: `slim` drops the verbose per-language notes + quirks", () => {
  const fat = listPlatformsCore({ platform: "gba" });
  const slim = listPlatformsCore({ platform: "gba", slim: true });
  assert.ok(!/"note"/.test(JSON.stringify(slim)), "slim has no per-language note prose");
  assert.ok(!slim.quirks, "slim drops quirks");
  assert.ok(JSON.stringify(slim).length < JSON.stringify(fat).length, "slim is smaller");
  assert.equal(slim.languages.defaultLanguage, "c", "slim keeps defaultLanguage");
});

test("platform resolve: surfaces toolchains[] + the harness-only note", () => {
  const r = resolvePlatformCore({ platform: "gba" });
  assert.ok(r.jsPath && r.wasmPath, "still has the core paths");
  assert.ok(Array.isArray(r.toolchains) && r.toolchains.length >= 1, "now lists toolchains");
  assert.match(r.toolchainNote, /NOT host-callable|build worker/, "states the toolchain is harness-only");
});
