// Window-aspect guards in romdev-core-runner's present.js. Regression for the
// zero-width playtest window: hosts that don't know their display aspect
// report 0, `status.displayAspect ?? fbW/fbH` keeps the 0 (nullish doesn't
// catch it), tvAspectFor's default returned it verbatim, and the window opened
// with width = round(height * 0) = 0 — SDL "invalid width", which the tool
// then mislabeled as a no-display/desktop-session problem.

import { test } from "node:test";
import assert from "node:assert/strict";
import { tvAspectFor, effectiveAspect } from "romdev-core-runner";

test("tvAspectFor: unknown platform with a real reported aspect passes it through", () => {
  assert.equal(tvAspectFor("wasmcart", 16 / 9), 16 / 9);
  assert.equal(tvAspectFor(null, 1.6), 1.6);
});

test("tvAspectFor: unknown platform with a bogus aspect (0/NaN/undefined) never returns it", () => {
  for (const bogus of [0, NaN, undefined, null, -1, Infinity]) {
    const a = tvAspectFor("wasmcart", bogus);
    assert.ok(Number.isFinite(a) && a > 0, `aspect for ${bogus} is a real ratio, got ${a}`);
  }
});

test("tvAspectFor: known platforms still return their hardware shape", () => {
  assert.equal(tvAspectFor("nes", 0), 4 / 3);
  assert.equal(tvAspectFor("gba", 0), 3 / 2);
});

test("effectiveAspect: real status aspect wins", () => {
  assert.equal(effectiveAspect(4 / 3, 1280, 720), 4 / 3);
});

test("effectiveAspect: 0/NaN/undefined status aspect falls back to the fb shape", () => {
  for (const bogus of [0, NaN, undefined, null, -2]) {
    assert.equal(effectiveAspect(bogus, 1280, 720), 1280 / 720, `fb fallback for ${bogus}`);
  }
});

test("effectiveAspect: unsettled fb (0x0) still yields a usable ratio", () => {
  const a = effectiveAspect(0, 0, 0);
  assert.ok(Number.isFinite(a) && a > 0, `got ${a}`);
});
