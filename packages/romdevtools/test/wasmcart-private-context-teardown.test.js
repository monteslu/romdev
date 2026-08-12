// Destroying a presentWindow host must not poison the SHARED GL context.
//
// native-gles leaves NOTHING current when a context is destroyed -- it unbinds
// and does not fall back to another. So a private (presentWindow) context torn
// down without handing currency back left the next cart to load on the shared
// offscreen context making GL calls against a null current context, dying with
// "Cannot read properties of null (reading '_id')".
//
// ONE presentWindow load therefore poisoned every later plain load in the
// process. The MCP client agent hit it screenshotting five shipped carts:
// 4 of 5 came back black or errored, and the discriminator was not anything
// about the carts -- it was a presentWindow load earlier in the same run.
//
// !! FIXTURE LIMITATION -- these are GUARDS, NOT PROOF !!
// I expected the 64x64 fixture to express this one (it is about context
// lifetime, not sizes) and it does NOT: with the makeCurrent restore removed,
// all three still pass. Whatever the real carts do on load -- bigger contexts,
// more GL objects, atlas uploads -- is what actually leaves the shared context
// unusable. Verified by hand on the five shipped carts in
// ~/code/cliemu/games-for-dad: before the fix, 4 of 5 plain loads failed with
// "Cannot read properties of null (reading '_id')" once a presentWindow load
// had happened; after it, all ten plain/direct combinations render 100%.
// A fixture that reproduces this without those carts is still owed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { WasmcartHost } from "../src/host/WasmcartHost.js";

// SKIP-GUARDED like wasmcart-gl.test.js: these need a real GL context, and CI
// runners have no GPU (ROMDEV_NO_GL=1 is set there deliberately).
import { glStackAvailable } from "romdev-core-host/glOptionalDep.js";
let _glReady = true;
try { await import("webgl-node"); } catch { _glReady = false; }
if (_glReady) _glReady = await glStackAvailable();
const GUARD = _glReady ? {} : { skip: "no usable GL stack here (headless CI) — GL carts cannot load" };

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GLCART = path.join(HERE, "fixtures", "glcart.wasc");

/** Load, step, capture, tear down. Throws if the GL context is unusable. */
async function loadStepCapture({ presentWindow }) {
  const h = new WasmcartHost();
  await h.loadMedia({ platform: "wasmcart", path: GLCART, ...(presentWindow ? { presentWindow: true } : {}) });
  try {
    h.stepFrames(3);
    const fb = h.getFramebuffer();
    let nonBlack = 0;
    for (let i = 0; i < fb.pixels.length; i += 4) {
      if (fb.pixels[i] || fb.pixels[i + 1] || fb.pixels[i + 2]) nonBlack++;
    }
    return { width: fb.width, height: fb.height, nonBlack };
  } finally { h.destroy(); }
}

test("a plain load still works AFTER a presentWindow host is destroyed", GUARD, async () => {
  // The exact poisoning sequence: direct first, then plain.
  await loadStepCapture({ presentWindow: true });
  const after = await loadStepCapture({ presentWindow: false });
  assert.ok(after.nonBlack > 0,
    "the shared context must still render after a private context was destroyed");
});

test("alternating direct and plain loads never degrade", GUARD, async () => {
  // Five rounds of the client agent's actual pattern. The original bug killed
  // every plain load from the first direct one onward, so a single round is
  // enough to catch it -- five proves it does not creep back either.
  for (let round = 1; round <= 5; round++) {
    const direct = await loadStepCapture({ presentWindow: true });
    assert.ok(direct.nonBlack > 0, `direct load rendered nothing on round ${round}`);
    const plain = await loadStepCapture({ presentWindow: false });
    assert.ok(plain.nonBlack > 0, `plain load rendered nothing on round ${round}`);
  }
});

test("many presentWindow loads in a row do not exhaust the GL stack", GUARD, async () => {
  // Each presentWindow load creates a REAL GPU context. destroy() must release
  // it; leaking one per load would exhaust the driver over a long session.
  for (let i = 1; i <= 6; i++) {
    const r = await loadStepCapture({ presentWindow: true });
    assert.ok(r.nonBlack > 0, `presentWindow load #${i} rendered nothing`);
  }
});
