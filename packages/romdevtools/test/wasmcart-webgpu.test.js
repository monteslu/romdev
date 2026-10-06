// WebGPU wasmcart carts (wasmcart's `wgpu` tier) through romdev's run/see/drive
// surface. fixtures/wgpucart.wasc is a copy of wasmcart's test fixture: an
// orange triangle on a background whose red channel is a compute shader's
// result (21 * 2 = 42), read back by the cart with mapAsync.
//
// Needs wasmcart with the WebGPU tier and webgpu-node (its optional
// dependency) with a working adapter; it fails rather than skips without one.

import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { WasmcartHost } from "../src/host/WasmcartHost.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WGPUCART = path.join(HERE, "fixtures", "wgpucart.wasc");

function pixel(f, x, y) {
  const i = y * f.pitch + x * 4;
  return [f.pixels[i], f.pixels[i + 1], f.pixels[i + 2]];
}

test("wasmcart webgpu: loads, reports the renderer, and a screenshot is the cart's frame", async () => {
  const host = new WasmcartHost();
  const status = await host.loadMedia({ platform: "wasmcart", path: WGPUCART });
  try {
    assert.equal(status.gpu, "webgpu");
    assert.equal(status.fbWidth, 256);
    assert.equal(status.fbHeight, 192);
    // The compute result reaches the cart between bursts (the event loop runs
    // between tool calls), so step until it has, as an agent would.
    let f;
    for (let i = 0; i < 20; i++) {
      await host.stepFrames(2);
      await new Promise(resolve => setImmediate(resolve));
      f = host.getFramebuffer();
      if (pixel(f, 2, 2)[0] === 42) break;
    }
    assert.deepEqual(pixel(f, 128, 110), [255, 128, 64], "triangle");
    assert.deepEqual(pixel(f, 2, 2), [42, 0, 255], "background carries the compute result");
    const shot = host.screenshot();
    assert.equal(shot.width, 256);
    assert.ok(shot.pngBase64.length > 100, "screenshot produced");
  } finally {
    host.destroy();
  }
});

test("wasmcart webgpu: a read issued for a burst is that burst's frame, even if stepping continues", async () => {
  const host = new WasmcartHost();
  await host.loadMedia({ platform: "wasmcart", path: WGPUCART });
  try {
    const first = host.stepFrames(1);   // not awaited: frames keep running
    host.stepFrames(3);
    const n = await first;
    assert.equal(n, 1);
    await host.stepFrames(1);
    assert.equal(host.getFramebuffer().width, 256);
  } finally {
    host.destroy();
  }
});
