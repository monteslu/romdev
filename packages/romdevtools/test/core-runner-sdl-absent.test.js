// romdev-core-runner hard constraint §4.1: @kmamal/sdl is OPTIONAL. With SDL
// absent, importing the runner and calling runRom must throw a STRUCTURED
// SDL_UNAVAILABLE error (code + sdlKind + fixCmd where actionable) — never a
// hard module-load crash. CI green without SDL present is the proof; these
// tests simulate absence via the resolver/import hooks so they pass on a
// machine that HAS SDL installed too.

import { test } from "node:test";
import assert from "node:assert/strict";

import { runRom, initSdl } from "romdev-core-runner";
import { _resetSdlForTest } from "romdev-core-runner/sdl.js";

const notInstalled = () => {
  const e = new Error("Cannot find module '@kmamal/sdl'");
  e.code = "MODULE_NOT_FOUND";
  throw e;
};

test("initSdl with @kmamal/sdl unresolvable → structured SDL_UNAVAILABLE, no crash", async () => {
  _resetSdlForTest();
  await assert.rejects(
    initSdl({ resolve: notInstalled }),
    (e) => {
      assert.equal(e.code, "SDL_UNAVAILABLE");
      assert.equal(e.sdlKind, "missing-binary");
      assert.match(e.fixCmd ?? "", /npm install @kmamal\/sdl/);
      return true;
    },
  );
});

test("runRom with SDL absent → SDL_UNAVAILABLE before the core is ever touched", async () => {
  _resetSdlForTest();
  await assert.rejects(
    // A bogus core object would explode in loadCore — proving SDL fails FIRST
    // means the core is never touched when there's no window to show.
    runRom("/nonexistent.rom", {
      core: { jsPath: "/nope.js", wasmPath: "/nope.wasm" },
      _initSdlOpts: { resolve: notInstalled },
    }),
    (e) => {
      assert.equal(e.code, "SDL_UNAVAILABLE");
      assert.equal(e.sdlKind, "missing-binary");
      return true;
    },
  );
});

test("initSdl offscreen-driver detection → no-display (honest failure, not an invisible window)", async () => {
  _resetSdlForTest();
  await assert.rejects(
    initSdl({
      importSdl: async () => ({ default: { info: { drivers: { video: { current: "offscreen" } } } } }),
    }),
    (e) => {
      assert.equal(e.code, "SDL_UNAVAILABLE");
      assert.equal(e.sdlKind, "no-display");
      return true;
    },
  );
  _resetSdlForTest(); // don't leave the fake module memoized for other tests
});
