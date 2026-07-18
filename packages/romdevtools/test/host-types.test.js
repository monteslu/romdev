// Unit test for types.js helpers.

import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultMediaKind, portInputToMask } from "romdev-core-host/types.js";

test("defaultMediaKind: consoles return cartridge", () => {
  assert.equal(defaultMediaKind("nes"), "cartridge");
  assert.equal(defaultMediaKind("snes"), "cartridge");
  assert.equal(defaultMediaKind("gb"), "cartridge");
});

test("defaultMediaKind: c64 returns program", () => {
  assert.equal(defaultMediaKind("c64"), "program");
});

test("portInputToMask: empty input is 0", () => {
  assert.equal(portInputToMask({}), 0);
  assert.equal(portInputToMask(undefined), 0);
});

test("portInputToMask: NES A button is bit 8", () => {
  assert.equal(portInputToMask({ a: true }), 1 << 8);
});

test("portInputToMask: Start+Select", () => {
  assert.equal(portInputToMask({ start: true, select: true }), (1 << 3) | (1 << 2));
});

test("portInputToMask: combined dpad+buttons", () => {
  const m = portInputToMask({ up: true, right: true, a: true, b: true });
  // up=4, right=7, a=8, b=0
  assert.equal(m, (1 << 4) | (1 << 7) | (1 << 8) | (1 << 0));
});
