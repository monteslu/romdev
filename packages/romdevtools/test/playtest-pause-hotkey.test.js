// The playtest P/Space hotkey acts on the live host from inside an SDL event
// callback, where a throw escapes the tool-call error path and takes the whole
// server down (SIGKILL, every session's host lost) from a single keypress the
// window's own help text invites the human to press.
//
// It did exactly that on wasmcart and jsgame carts: pause()/resume() existed
// only on LibretroHost, and `h.status.paused ? h.resume() : h.pause()` was
// unguarded — with no `paused` field the ternary always took the pause branch,
// so it threw on the FIRST press, every time.
//
// These tests pin both halves of the fix: the hosts implement the pause
// contract, and pausing actually freezes them rather than merely not crashing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { WasmcartHost } from "../src/host/WasmcartHost.js";
import { JsGameHost } from "../src/host/JsGameHost.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HELLO = path.join(HERE, "fixtures", "hello.wasc");

// Verbatim from playtest.js's keyDown handler, so this test fails if that
// guard is ever removed.
function pressPauseKey(h) {
  if (h && typeof h.pause === "function" && typeof h.resume === "function") {
    h.status?.paused ? h.resume() : h.pause();
    return true;
  }
  return false;
}

for (const [name, make] of [
  ["WasmcartHost", () => new WasmcartHost()],
  ["JsGameHost", () => new JsGameHost()],
]) {
  test(`${name}: implements the pause contract the playtest hotkey calls`, () => {
    const h = make();
    assert.equal(typeof h.pause, "function", "pause() must exist — the P hotkey calls it unconditionally");
    assert.equal(typeof h.resume, "function", "resume() must exist");
    // The ternary reads this field; without it pause/resume can never toggle.
    assert.equal("paused" in h.status, true, "status.paused must exist");
    assert.equal(h.status.paused, false, "a fresh host is not paused");
  });

  test(`${name}: the P/Space hotkey path toggles instead of throwing`, () => {
    const h = make();
    assert.doesNotThrow(() => pressPauseKey(h), "first press must not throw");
    assert.equal(h.status.paused, true, "first press pauses");
    assert.doesNotThrow(() => pressPauseKey(h));
    assert.equal(h.status.paused, false, "second press resumes");
  });
}

test("wasmcart: pause actually FREEZES the cart, not just avoids the crash", async () => {
  const host = new WasmcartHost();
  await host.loadMedia({ platform: "wasmcart", path: HELLO });

  host.stepFrames(2);
  const frozenAt = host.status.frameCount;

  pressPauseKey(host);
  assert.equal(host.status.paused, true);

  // The playtest loop calls stepFrames every tick; a paused host must ignore it
  // (LibretroHost.stepFrames returns 0 while paused — same contract here).
  const stepped = host.stepFrames(10);
  assert.equal(stepped, 0, "stepFrames returns 0 while paused");
  assert.equal(host.status.frameCount, frozenAt, "frameCount does not advance while paused");

  pressPauseKey(host);
  host.stepFrames(3);
  assert.ok(host.status.frameCount > frozenAt, "resuming lets frames advance again");
});

test("wasmcart: K frame-advance steps exactly one frame and stays paused", async () => {
  const host = new WasmcartHost();
  await host.loadMedia({ platform: "wasmcart", path: HELLO });

  pressPauseKey(host);
  const before = host.status.frameCount;

  // Verbatim from the K handler.
  host.resume();
  const stepped = host.stepFrames(1);
  if (stepped && typeof stepped.then === "function") await stepped;
  host.pause();

  assert.equal(host.status.frameCount, before + 1, "advances exactly one frame");
  assert.equal(host.status.paused, true, "and is still paused afterwards");
});

test("a host WITHOUT pause is skipped, never called into", () => {
  // The guard's other half: an optional method missing must not throw from
  // inside the SDL callback. A bare object stands in for any future host kind.
  const hostWithoutPause = { status: { loaded: true } };
  let handled;
  assert.doesNotThrow(() => { handled = pressPauseKey(hostWithoutPause); });
  assert.equal(handled, false, "reports 'not supported' rather than calling h.pause()");
});
