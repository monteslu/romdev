// GL-direct present for wasmcart GL carts.
//
// A GL cart renders on the GPU, and by default every frame is dragged back to
// the CPU (glReadPixels + row flip + alpha pass) purely so SDL can blit it in
// software: ~5.4 ms of a 16.7 ms budget at 1080p, moving pixels the GPU
// already had. `presentWindow` gives the cart its own GL context, which a
// playtest window can bind so presenting is just a swap.
//
// The load-bearing invariant is that the PRIVATE context must be an exact
// substitute for the shared one in every non-present respect. It is not
// enough that attach/swap work; a cart that renders differently (or at a
// different size) on the fast path would make the window disagree with every
// screenshot.

import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { WasmcartHost } from "../src/host/WasmcartHost.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GLCART = path.join(HERE, "fixtures", "glcart.wasc");
const HELLO = path.join(HERE, "fixtures", "hello.wasc");

test("presentWindow gives a GL cart its own attachable context", async () => {
  const h = new WasmcartHost();
  await h.loadMedia({ platform: "wasmcart", path: GLCART, presentWindow: true });
  try {
    assert.equal(h.cart.usesGL, true, "fixture must actually be a GL cart");
    assert.ok(h._glCtx, "a private context was created");
    assert.equal(h.canAttachWindow(), true, "and it can be bound to a window");
  } finally { h.destroy(); }
});

test("WITHOUT presentWindow a cart stays on the shared context and refuses to attach", async () => {
  const h = new WasmcartHost();
  await h.loadMedia({ platform: "wasmcart", path: GLCART });
  try {
    // This is the safety property, not an incidental default. The offscreen
    // context is shared by every cart in every session, so attaching it to one
    // window would drag all of them into that window.
    assert.equal(h.canAttachWindow(), false, "the SHARED context must never be attachable");
    assert.equal(h.attachWindow(Buffer.alloc(8)), false, "and attach must refuse outright");
  } finally { h.destroy(); }
});

test("a 2D cart never claims it can attach", async () => {
  const h = new WasmcartHost();
  await h.loadMedia({ platform: "wasmcart", path: HELLO, presentWindow: true });
  try {
    assert.equal(h.canAttachWindow(), false, "no GL context, nothing to attach");
  } finally { h.destroy(); }
});

test("the private context renders IDENTICALLY to the shared one", async () => {
  // The regression this pins: sizing the private context from the cart's
  // pre-init info struct (which a cart that picks its size in wc_init reports
  // as 0) produced a 1x1 context. webgl-node cannot resize, so the cart was
  // cropped to a single pixel for the whole session — while every attach/swap
  // API still reported success.
  const shared = new WasmcartHost();
  const priv = new WasmcartHost();
  try {
    await shared.loadMedia({ platform: "wasmcart", path: GLCART });
    await priv.loadMedia({ platform: "wasmcart", path: GLCART, presentWindow: true });

    shared.stepFrames(2);
    priv.stepFrames(2);

    const a = shared.getFramebuffer();
    const b = priv.getFramebuffer();

    assert.equal(b.width, a.width, "same width as the shared context");
    assert.equal(b.height, a.height, "same height as the shared context");
    assert.ok(b.width > 1 && b.height > 1, "and not collapsed to a 1x1 context");
    assert.deepEqual(
      Array.from(b.pixels.subarray(0, 256)),
      Array.from(a.pixels.subarray(0, 256)),
      "and the same pixels — the fast path must not change what the cart draws");
  } finally { shared.destroy(); priv.destroy(); }
});

test("readback still works on a private context while it is NOT attached", async () => {
  // Screenshots must keep working on a presentWindow cart before a window
  // exists (agents shoot frames headlessly long before a human sees one).
  const h = new WasmcartHost();
  await h.loadMedia({ platform: "wasmcart", path: GLCART, presentWindow: true });
  try {
    h.stepFrames(2);
    const fb = h.getFramebuffer();
    assert.ok(fb.width > 1 && fb.height > 1, "a real frame");
    let nonBlack = 0;
    for (let i = 0; i < fb.pixels.length; i += 4) {
      if (fb.pixels[i] || fb.pixels[i + 1] || fb.pixels[i + 2]) nonBlack++;
    }
    assert.ok(nonBlack > 0, "the cart actually drew something (not a blank frame)");
  } finally { h.destroy(); }
});

test("attach refuses a junk handle and presentGl refuses when unattached", async () => {
  const h = new WasmcartHost();
  await h.loadMedia({ platform: "wasmcart", path: GLCART, presentWindow: true });
  try {
    assert.equal(h.attachWindow(Buffer.alloc(2)), false, "too-short handle refused");
    assert.equal(h.attachWindow(null), false, "no handle refused");
    // A refused attach must leave the host on the readback path rather than in
    // a half-attached state where presentGl silently does nothing forever.
    assert.equal(h._glAttached, false, "a refused attach leaves it detached");
    assert.equal(h.presentGl(), false, "presentGl reports it did not present");
    h.stepFrames(1);
    assert.ok(h.getFramebuffer().width > 1, "and readback still works after all that");
  } finally { h.destroy(); }
});

test("destroy releases the private context", async () => {
  // Each private context is a real GPU context; leaking one per load would
  // exhaust the driver over a long session.
  const h = new WasmcartHost();
  await h.loadMedia({ platform: "wasmcart", path: GLCART, presentWindow: true });
  assert.ok(h._glCtx, "context exists while loaded");
  h.destroy();
  assert.equal(h._glCtx, null, "and is released on destroy");
  assert.equal(h._glAttached, false);
});
