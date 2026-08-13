// A cart loading on the SHARED offscreen context must claim it first.
//
// The private (presentWindow) path always claimed its context at load; the
// shared path did not. So a cart loading here built its FBOs against whatever
// context happened to be current -- after a presentWindow load, that is
// another host's PRIVATE context. The cart then ran on the shared context with
// attachments validated against a different one. Only a demanding target
// notices: an MRT/cubemap set fails with "the framebuffer is incomplete -- the
// targets must agree on size", while plain 2D canvases complete fine.
//
// This took four rounds between two agents to place, because THE DAMAGE LASTS
// EXACTLY ONE LOAD: the next load finds currency already corrected by the
// first load's own stepFrames, so whoever measured second always saw it clean.
// I compounded it by running exactly one trial per server restart -- which is
// the warm-up case that passes even when broken.
//
// WHAT THIS FILE PROVES, PRECISELY -- it is weaker than the harness that
// found the bug, and pretending otherwise would repeat the mistake this whole
// thread was about:
//   * Through the MCP (separate sessions, a fresh host per load), glstress
//     catches it cleanly: 9/10 fail with the fix removed, every failure
//     stages=51 (63 minus the MRT and cubemap bits -- it names the casualties),
//     0/10 with the fix. Reproduced independently on this box.
//   * IN-PROCESS, as written below, the control still PASSES with the fix
//     removed. One process reusing one shared context does not reproduce what
//     separate MCP sessions do. So these are GUARDS against regression in the
//     shape of the bug, and the MCP harness (in the feedback thread) remains
//     the oracle.
// glcart.wasc could not express this at all (64x64, no MRT) and passed 3/3
// with the fix removed. glstress.wasc is purpose-built to the shape:
// renders at 1920x1080 (above any test window), re-sets its scissor every
// frame, and builds an MRT set plus a cubemap. Built by the MCP client agent;
// source in test/fixtures/glstress-src/.
//
// TWO TRAPS, both of which cost real time before the fixture existed:
//
//  1. ASSERT ON debugState, NOT PIXELS. The cart paints its background in an
//     early stage, before the demanding work, so a "content is non-black"
//     check reads PASSING on a broken frame -- the same silent-wrong-picture
//     class as the capture-crop bug.
//  2. WARM UP FIRST. The first load in a fresh process has no stale private
//     context to inherit and passes even when broken. Without the warm-up this
//     flakes at exactly the rate that makes people stop trusting it.

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
const GLCART = path.join(HERE, "fixtures", "glcart.wasc");     // simple 64x64 GL cart
const STRESS = path.join(HERE, "fixtures", "glstress.wasc");   // 1080p, MRT + cubemap

/** All six stages completed = 63. A failure names which died via the bitfield. */
const ALL_STAGES = 63;

/** Load the stress fixture on the SHARED context and report its own verdict. */
async function runStress() {
  const h = new WasmcartHost();
  await h.loadMedia({ platform: "wasmcart", path: STRESS });
  try {
    h.stepFrames(20);
    // readDebugState() returns field DESCRIPTORS (name/type/valuePtr) with no
    // decoded value — the MCP tool decodes them separately. Read each value by
    // name instead; calling .value on the descriptor silently yields undefined
    // and every assertion then "fails" for the wrong reason.
    // readDebugValue returns {name,type,value} — the number is on .value.
    return { ok: h.readDebugValue("score")?.value, stages: h.readDebugValue("aux")?.value };
  } finally { h.destroy(); }
}

/** Create and tear down a PRIVATE context — the thing that leaves it current. */
async function poison() {
  const h = new WasmcartHost();
  await h.loadMedia({ platform: "wasmcart", path: GLCART, presentWindow: true });
  try { h.stepFrames(5); } finally { h.destroy(); }
}

test("the stress fixture completes every GL stage on a clean load", GUARD, async () => {
  // Baseline: with nothing else in play, all six stages must pass. If this
  // fails the fixture or the GL stack is broken, not the ordering.
  const r = await runStress();
  assert.equal(r.ok, 1, `expected ok=1, got ok=${r.ok} stages=${r.stages}`);
  assert.equal(r.stages, ALL_STAGES, "every stage should be set");
});

test("a shared-context load after a presentWindow load keeps its MRT+cubemap", GUARD, async () => {
  // THE REGRESSION. Without the claim, this reports stages=51 -- 63 minus the
  // MRT and cubemap bits -- because those are the attachments validated
  // against the wrong context.
  await runStress();          // warm-up: consume the fresh-process pass
  await poison();             // private context created and destroyed
  const r = await runStress();
  assert.equal(r.ok, 1,
    `MRT/cubemap stages died after a presentWindow load (ok=${r.ok} stages=${r.stages}; `
    + `51 means the MRT and cubemap passes are the casualties)`);
  assert.equal(r.stages, ALL_STAGES);
});

test("ten alternating cycles, none degrade", GUARD, async () => {
  // The damage lasts exactly one load, so a single cycle can pass by luck.
  // Ten matches the control run that measured 9/10 failures without the fix.
  await runStress();          // warm-up
  for (let i = 1; i <= 10; i++) {
    await poison();
    const r = await runStress();
    assert.equal(r.ok, 1, `cycle ${i}: ok=${r.ok} stages=${r.stages}`);
  }
});
