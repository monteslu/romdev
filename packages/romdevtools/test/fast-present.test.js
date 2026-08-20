// playtest({op:'open', fastPresent:true}) — reload a GL cart onto its own
// GL context so the window presents by GPU blit + swap.
//
// A wasmcart GL cart loaded the ordinary way shares the ONE process-wide
// offscreen GL context, which can never be bound to a window (attaching it
// would drag every other session's cart into that window). So it presents by
// dragging every frame back to the CPU: measured 27.9/45.1/54.9 ms per frame
// at 1080p versus 3.4/6.1/9.1 GL-direct — a human playing at 41 fps.
//
// `loadMedia({presentWindow:true})` is the fix and must be decided at LOAD
// time, so the only route for an already-loaded cart is a reload. Before this,
// op:'open' could detect that and only warn, leaving every caller to re-derive
// the save/reload/restore dance by hand. Field report:
// internal-romdev/feedback/2026-08-20_playtest-open-cannot-fix-the-readback-path-it-detects.md
//
// Verified live as well as here: a formix cart on an ordinary load opened
// `presenting:"readback"`, and with fastPresent:true opened
// `presenting:"gl-direct"` carrying 4096 bytes of save data across.

import { test } from "node:test";
import assert from "node:assert/strict";

import { reloadForFastPresent, registerMediaLoader } from "../src/mcp/tools/fast-present.js";
import { installHost, clearHost, getHostOrNull, setHostProtectedPredicate } from "../src/mcp/state.js";

/** A stand-in wasmcart host on the SHARED context (so it cannot attach). */
function sharedGlHost({ path = "/tmp/cart.wasc", save = null } = {}) {
  return {
    status: { mediaPath: path, platform: "wasmcart", gl: "rendered", loaded: true },
    dispose() {},
    canAttachWindow() { return false; },
    getSaveData() { return save; },
  };
}

/** A stand-in host on a PRIVATE context (what a presentWindow reload yields). */
function privateGlHost({ path = "/tmp/cart.wasc" } = {}) {
  const restored = [];
  return {
    restored,
    status: { mediaPath: path, platform: "wasmcart", gl: "rendered", loaded: true },
    dispose() {},
    canAttachWindow() { return true; },
    setSaveData(bytes) { restored.push(bytes); },
  };
}

test("the reload carries the cart's save data across", async () => {
  setHostProtectedPredicate(() => false);
  const key = "fp-save";
  const save = new Uint8Array([1, 2, 3, 4]);
  installHost(key, sharedGlHost({ save }));

  const fresh = privateGlHost();
  registerMediaLoader(key, async (opts) => {
    // The whole point of the reload: it must ask for a private context.
    assert.equal(opts.presentWindow, true, "the reload must set presentWindow");
    assert.equal(opts.path, "/tmp/cart.wasc", "and reload the SAME cart");
    installHost(key, fresh);
  });

  const out = await reloadForFastPresent(key);

  assert.equal(out.ok, true);
  assert.equal(out.savedBytes, 4);
  assert.deepEqual([...fresh.restored[0]], [1, 2, 3, 4],
    "a reload restarts the cart, so losing the save would be worse than the slow present it fixes");
  clearHost(key);
});

test("a cart with no save data reloads cleanly rather than erroring", async () => {
  const key = "fp-nosave";
  installHost(key, sharedGlHost({ save: null }));
  registerMediaLoader(key, async () => installHost(key, privateGlHost()));

  const out = await reloadForFastPresent(key);

  assert.equal(out.ok, true);
  assert.equal(out.savedBytes, 0);
  clearHost(key);
});

test("a base64/in-memory cart cannot be reloaded, and says so", async () => {
  // There is no path to reload FROM and the bytes are not retained anywhere
  // reachable. A real limitation, so it must be reported rather than guessed at.
  const key = "fp-nopath";
  installHost(key, sharedGlHost({ path: "<base64>" }));
  registerMediaLoader(key, async () => { throw new Error("must not be called"); });

  const out = await reloadForFastPresent(key);

  assert.equal(out.ok, false);
  assert.match(out.reason, /base64|in-memory/);
  clearHost(key);
});

test("a failed reload is reported, never thrown", async () => {
  // This runs inside op:'open'. Failing to make a window FASTER must never
  // fail to open the window at all.
  const key = "fp-throws";
  installHost(key, sharedGlHost());
  registerMediaLoader(key, async () => { throw new Error("disk on fire"); });

  const out = await reloadForFastPresent(key);

  assert.equal(out.ok, false);
  assert.match(out.reason, /disk on fire/);
  clearHost(key);
});

test("a reload that does not yield an attachable context is not claimed as a win", async () => {
  // Reporting ok:true here would promise a speed-up the window will not get.
  const key = "fp-still-shared";
  installHost(key, sharedGlHost());
  registerMediaLoader(key, async () => installHost(key, sharedGlHost()));

  const out = await reloadForFastPresent(key);

  assert.equal(out.ok, false);
  assert.match(out.reason, /cannot bind a window/);
  clearHost(key);
});

test("a save that cannot be restored is surfaced loudly, not swallowed", async () => {
  // The cart is loaded and fast but the player's progress did not survive.
  // Silently losing it is the one outcome worse than a slow window.
  const key = "fp-restore-fails";
  installHost(key, sharedGlHost({ save: new Uint8Array([9]) }));
  registerMediaLoader(key, async () => installHost(key, {
    status: { mediaPath: "/tmp/cart.wasc", platform: "wasmcart", loaded: true },
    dispose() {},
    canAttachWindow() { return true; },
    setSaveData() { throw new Error("cart rejected the save"); },
  }));

  const out = await reloadForFastPresent(key);

  assert.equal(out.ok, true, "the cart IS loaded and fast");
  assert.equal(out.savedBytes, 0);
  assert.match(out.reason, /could NOT be restored/);
  clearHost(key);
});

test("with no host there is nothing to reload", async () => {
  const out = await reloadForFastPresent("fp-nonexistent-session");
  assert.equal(out.ok, false);
  assert.match(out.reason, /no host/);
});

test("the reload REPLACES the session host -- a caller holding the old one is holding a disposed host", async () => {
  // THE BUG THIS PINS. ptOpen captured `const host = getHost(...)` before the
  // reload and then opened the window against it. The reload disposes the old
  // host and installs a new one, so the window opened against a disposed host
  // and failed with "no cart loaded" -- which reads like the reload wiped the
  // session rather than like a dangling reference. ptOpen rebinds now; this
  // asserts the property that makes rebinding necessary.
  const key = "fp-rebind";
  const before = sharedGlHost();
  installHost(key, before);

  const after = privateGlHost();
  registerMediaLoader(key, async () => installHost(key, after));

  const out = await reloadForFastPresent(key);

  assert.equal(out.ok, true);
  assert.notEqual(getHostOrNull(key), before, "the pre-reload host is no longer the session's host");
  assert.equal(getHostOrNull(key), after, "callers must re-read the host after a reload");
  clearHost(key);
});
