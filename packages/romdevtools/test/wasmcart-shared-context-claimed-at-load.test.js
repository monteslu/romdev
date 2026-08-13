// A cart loading on the SHARED offscreen context must claim it first.
//
// The private (presentWindow) path always claimed its context at load; the
// shared path did not. So a cart loading here built its FBOs against whatever
// context happened to be current -- after a presentWindow load, that is
// another host's PRIVATE context. The cart then ran on the shared context with
// attachments validated against a different one. Only a demanding target
// notices: 3DreamEngine's sky job (cubemap/MRT) fails with "the framebuffer is
// incomplete -- the targets must agree on size", while plain 2D canvases
// complete fine.
//
// This one took four rounds between two agents to place, for a specific
// reason worth recording: THE DAMAGE LASTS EXACTLY ONE LOAD. The next load
// finds currency already corrected by the first load's own stepFrames, so
// whoever measured second always saw it clean. Two people on the same box with
// the same cart binary produced opposite results and two confident, wrong
// isolations before the MCP client agent spotted the decay.
//
// Measured control, matched 10-trial runs on this box:
//     fix present : 0/10 fail
//     fix removed : 9/10 fail   (trial 1 passes -- see the warm-up note below)
//
// !! FIXTURE LIMITATION -- THESE ARE GUARDS, NOT PROOF !!
// Verified: with the fix line removed, all three still PASS here. glcart.wasc
// is 64x64 and builds no cubemap/MRT target, so it never exercises the
// attachment validation that actually breaks. The failing case needs a real
// 3DreamEngine cart -- reproduced on this box with
// ~/code/cliemu/games-for-dad/{jewels,eightball}: 9/10 fail without the fix,
// 0/10 with it, asserting on wasm({op:'debugState'}) lua_ok/gpu2d.
// That harness lives in the feedback thread, not here, because it needs carts
// that are build artifacts and not committed. This is the FIFTH bug in this
// area the fixture cannot express; a corpus cart that renders above the window
// size AND builds an MRT target is what would make these real.
//
// TWO TRAPS this test is built around, both of which cost real time:
//
//  1. ASSERT ON debugState, NOT PIXELS. The cart paints its background fine
//     while the sky FBO fails, so a "content is non-black" check reads
//     PASSING on a broken frame. lua_ok/gpu2d are the honest signal.
//  2. WARM UP FIRST. The first load after a fresh process passes even when
//     broken -- there is no stale private context to inherit yet. A test
//     without the warm-up flakes at exactly the rate that makes people stop
//     trusting it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { WasmcartHost } from "../src/host/WasmcartHost.js";

// SKIP-GUARDED like wasmcart-gl.test.js: needs a real GL context, and CI
// runners have no GPU (ROMDEV_NO_GL=1 is set there deliberately).
import { glStackAvailable } from "romdev-core-host/glOptionalDep.js";
let _glReady = true;
try { await import("webgl-node"); } catch { _glReady = false; }
if (_glReady) _glReady = await glStackAvailable();
const GUARD = _glReady ? {} : { skip: "no usable GL stack here (headless CI) — GL carts cannot load" };

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GLCART = path.join(HERE, "fixtures", "glcart.wasc");

/**
 * Load a cart, step it, and report whether its GL work actually ran.
 * Returns the framebuffer dimensions plus a "drew something real" flag taken
 * from pixels — the fixture has no debugState, so this is the closest local
 * equivalent to the lua_ok/gpu2d signal the real carts expose.
 */
async function loadStep({ presentWindow }) {
  const h = new WasmcartHost();
  await h.loadMedia({ platform: "wasmcart", path: GLCART, ...(presentWindow ? { presentWindow: true } : {}) });
  try {
    h.stepFrames(5);
    const fb = h.getFramebuffer();
    let nonBlack = 0;
    for (let i = 0; i < fb.pixels.length; i += 4) {
      if (fb.pixels[i] || fb.pixels[i + 1] || fb.pixels[i + 2]) nonBlack++;
    }
    return { width: fb.width, height: fb.height, nonBlack };
  } finally { h.destroy(); }
}

test("a plain load right after a presentWindow load still renders", GUARD, async () => {
  // Warm up: the first load in a process has no stale private context to
  // inherit, so it passes even when the bug is present. Without this the test
  // is a coin flip.
  await loadStep({ presentWindow: false });

  // The failing sequence: private context created, then a shared-context load.
  await loadStep({ presentWindow: true });
  const after = await loadStep({ presentWindow: false });

  assert.ok(after.nonBlack > 0,
    "the shared-context cart must render after a presentWindow load");
});

test("ten alternating cycles, none degrade", GUARD, async () => {
  // The real signal is repetition: the damage lasts exactly one load, so a
  // single cycle can pass by luck. Ten matches the control run that measured
  // 9/10 failures without the fix.
  await loadStep({ presentWindow: false }); // warm-up
  for (let i = 1; i <= 10; i++) {
    await loadStep({ presentWindow: true });
    const plain = await loadStep({ presentWindow: false });
    assert.ok(plain.nonBlack > 0, `plain load rendered nothing on cycle ${i}`);
  }
});

test("the shared context is claimed even when no private context exists", GUARD, async () => {
  // The plain path must not depend on anything else having run first.
  for (let i = 1; i <= 3; i++) {
    const r = await loadStep({ presentWindow: false });
    assert.ok(r.nonBlack > 0, `consecutive plain load #${i} rendered nothing`);
  }
});
