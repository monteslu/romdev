// deriveTitle picks the playtest window title from host status. Pure
// function; importing playtest.js is safe (SDL is loaded lazily, not at
// module top-level).

import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveTitle } from "../src/playtest/playtest.js";

const h = (mediaPath, platform) => ({ status: { mediaPath, platform } });

test("in-memory build (no project name) falls back to platform", () => {
  assert.equal(deriveTitle(h("<memory.sfc>", "snes")), "romdev — snes");
  assert.equal(deriveTitle(h("/rom.sfc", "gba")), "romdev — gba");
});

test("projectName-derived virtualName becomes the title", () => {
  assert.equal(deriveTitle(h("asteroids.sfc", "snes")), "asteroids (snes)");
});

test("a real ROM file path titles by basename", () => {
  assert.equal(deriveTitle(h("/home/u/games/Zelda.sfc", "snes")), "Zelda (snes)");
});

test("no media and no platform → generic label", () => {
  assert.equal(deriveTitle(h("", null)), "romdev playtest");
  assert.equal(deriveTitle(undefined), "romdev playtest");
});
