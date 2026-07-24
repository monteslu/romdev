// Window sizing for the playtest/runRom SDL windows — regression for the
// 2026-07-23 macOS failure: opening the playtest window on a wasmcart cart
// (mruby wyvern, playtest {scale:2, aspect:'tv'}) died with SDL "invalid
// width". The sizing math lived duplicated + inline in playtest.js and
// runRom.js, so nothing unit-tested it; both now call
// initialWindowSize() in romdev-core-runner, which these tests pin down.
//
// The failure chain being locked out:
//   WasmcartHost.status.displayAspect stayed 0 (its init value) →
//   `displayAspect ?? fbW/fbH` kept the 0 (nullish doesn't catch 0) →
//   tvAspectFor('wasmcart', 0) returned the 0 →
//   width = Math.round(height * 0) = 0 → SDL rejected the window.

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initialWindowSize } from "romdev-core-runner";
import { WasmcartHost } from "../src/host/WasmcartHost.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DBG = path.join(HERE, "fixtures", "dbghello.wasc");

test("the exact wyvern repro: wasmcart cart, tv aspect, host that reports aspect 0", () => {
  // These are the literal inputs the Mac hit: a 1280x720 wasmcart cart,
  // playtest {scale:2, aspect:'tv'}, and the pre-fix host status
  // (displayAspect left at its 0 init). Pre-fix this produced width 0.
  const { width, height } = initialWindowSize({
    fbWidth: 1280, fbHeight: 720, scale: 2, aspectMode: "tv",
    platform: "wasmcart", displayAspect: 0,
  });
  assert.equal(height, 1440);
  assert.equal(width, 2560, "falls back to the framebuffer's own 16:9, not 0");
});

test("no aspect-mode/bogus-aspect combination can size a zero-width window", () => {
  for (const aspectMode of ["tv", "core", "fb"]) {
    for (const displayAspect of [0, NaN, undefined, null, -1]) {
      for (const platform of ["wasmcart", "jsgame", null]) {
        const { width, height } = initialWindowSize({
          fbWidth: 320, fbHeight: 240, scale: 2, aspectMode, platform, displayAspect,
        });
        assert.ok(width > 0 && height > 0,
          `${aspectMode}/${platform}/aspect=${displayAspect} → ${width}x${height}`);
      }
    }
  }
});

test("emulator platforms keep their hardware shape", () => {
  // NES 256x240 at scale 3, tv mode: height stays honest (720), width is 4:3.
  const nes = initialWindowSize({
    fbWidth: 256, fbHeight: 240, scale: 3, aspectMode: "tv",
    platform: "nes", displayAspect: 4 / 3,
  });
  assert.deepEqual(nes, { width: 960, height: 720 });
  // fb mode is raw pixels regardless of platform.
  const fb = initialWindowSize({
    fbWidth: 256, fbHeight: 240, scale: 3, aspectMode: "fb",
    platform: "nes", displayAspect: 4 / 3,
  });
  assert.deepEqual(fb, { width: 768, height: 720 });
});

test("an unsettled 0x0 framebuffer throws a plain-language error, not a 0-size window", () => {
  assert.throws(
    () => initialWindowSize({
      fbWidth: 0, fbHeight: 0, scale: 2, aspectMode: "fb",
      platform: "wasmcart", displayAspect: 0,
    }),
    /window sizing failed/,
  );
});

test("REAL cart end-to-end: a loaded WasmcartHost's status sizes a real window at monteslu's exact call", async () => {
  // The full fixed path, no mocks: real .wasc load → host reports a real
  // displayAspect → the same initialWindowSize call playtest() makes.
  const host = new WasmcartHost();
  await host.loadMedia({ platform: "wasmcart", path: DBG });
  const s = host.getStatus();
  assert.ok(s.displayAspect > 0, "host reports a real aspect after load");
  const { width, height } = initialWindowSize({
    fbWidth: s.fbWidth, fbHeight: s.fbHeight, scale: 2, aspectMode: "tv",
    platform: s.platform, displayAspect: s.displayAspect,
  });
  assert.ok(width > 0 && height > 0, `real cart sizes ${width}x${height}`);
  assert.equal(width, Math.round(s.fbHeight * 2 * (s.fbWidth / s.fbHeight)),
    "cart pixels are square: window width tracks the fb ratio");
});
