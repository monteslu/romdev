// WebGPU wasmcart carts (wasmcart's `wgpu` tier) through romdev's run/see/drive
// surface. fixtures/wgpucart.wasc is a copy of wasmcart's test fixture: an
// orange triangle on a background whose red channel is a compute shader's
// result (21 * 2 = 42), read back by the cart with mapAsync.
//
// Needs wasmcart with the WebGPU tier and a working adapter for webgpu-node (a
// dependency of wasmcart); it fails rather than skips without one.
// fixtures/dualgpu.wasc (also wasmcart's) imports GL and WebGPU: green on
// WebGPU, red on GL.

import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { WasmcartHost } from "../src/host/WasmcartHost.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WGPUCART = path.join(HERE, "fixtures", "wgpucart.wasc");
const DUALGPU = path.join(HERE, "fixtures", "dualgpu.wasc");
const FXSTATS = path.join(HERE, "fixtures", "fxstats.wasc");

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

test("wasmcart webgpu: gpuPower picks the GPU and the status names it; wgpu:false runs a dual cart on GL", async () => {
  const host = new WasmcartHost();
  const status = await host.loadMedia({ platform: "wasmcart", path: DUALGPU, gpuPower: "low-power" });
  try {
    assert.equal(status.gpu, "webgpu");
    assert.equal(status.gpuAdapter.powerPreference, "low-power");
    assert.ok(status.gpuAdapter.device || status.gpuAdapter.description, "the adapter names itself");
    await host.stepFrames(2);
    await new Promise(resolve => setImmediate(resolve));
    await host.stepFrames(1);
    assert.deepEqual(pixel(host.getFramebuffer(), 64, 48), [0, 255, 0], "green on WebGPU");
  } finally {
    host.destroy();
  }

  const gl = new WasmcartHost();
  const glStatus = await gl.loadMedia({ platform: "wasmcart", path: DUALGPU, wgpu: false });
  try {
    assert.equal(glStatus.gpu, "gl");
    assert.equal(glStatus.gpuAdapter, null);
    await gl.stepFrames(2);
    assert.deepEqual(pixel(gl.getFramebuffer(), 64, 48), [255, 0, 0], "red on GL");
  } finally {
    gl.destroy();
  }

  await assert.rejects(new WasmcartHost().loadMedia({ platform: "wasmcart", path: WGPUCART, wgpu: false }),
    /this cart is a WebGPU cart, but this host cannot provide WebGPU: the embedder disabled it/);
});

test("wasmcart webgpu: a long burst yields to the event loop, and overlapping bursts run in order", async () => {
  const host = new WasmcartHost();
  await host.loadMedia({ platform: "wasmcart", path: WGPUCART });
  try {
    // Released GPU objects are only freed after an event-loop turn, so a burst
    // longer than 16 frames must give the loop one.
    let turns = 0;
    const tick = setInterval(() => { turns++; }, 0);
    const before = host.status.frameCount;
    assert.equal(await host.stepFrames(64), 64);
    clearInterval(tick);
    assert.equal(host.status.frameCount - before, 64);
    assert.ok(turns >= 1, "the event loop ran during the burst");

    // Two bursts issued back to back finish in the order they were issued.
    const order = [];
    const a = host.stepFrames(40).then(() => order.push("a"));
    const b = host.stepFrames(1).then(() => order.push("b"));
    await Promise.all([a, b]);
    assert.deepEqual(order, ["a", "b"]);
  } finally {
    host.destroy();
  }
});

test("wasmcart webgpu: a buffer map a frame asks for is answered before the next frame of the same burst", async () => {
  // A browser or a native player answers a cart's mapAsync between frames: a
  // result requested in frame N is there at frame N + 1. A bare event-loop
  // turn between stepped frames does not wait for the GPU work the map waits
  // on, so a burst handed results over a varying number of frames late.
  // fixtures/fxstats.wasc (cartwheel-engine's fx_pipeline sample) reads five
  // GPU particle systems' alive counts back every frame and publishes them:
  // one 90-frame burst must see what 90 one-frame steps with the GPU idle
  // between them see.
  const run = async (burst) => {
    const host = new WasmcartHost();
    await host.loadMedia({ platform: "wasmcart", path: FXSTATS, deterministicSeed: 1, deterministicStepMs: 1000 / 60 });
    try {
      if (burst) assert.equal(await host.stepFrames(90), 90);
      else for (let i = 0; i < 90; i++) {
        await host.stepFrames(1);
        await host.cart.getGpuDevice().queue.onSubmittedWorkDone();
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      const v = (name) => { const r = host.readDebugValue(name); return r.value ?? r.values?.[0]; };
      const o = { tick: v("fxp.tick") };
      for (const sys of ["Rain", "Fountain", "Smoke", "Debris", "Swirl"]) o[sys] = [v(`fxp.${sys}.alive`), v(`fxp.${sys}.gpu_alive`)];
      return o;
    } finally {
      await host.destroy();
    }
  };
  const stepped = await run(false), burst = await run(true);
  assert.ok(stepped.Rain[1] > 0, "the GPU counts arrived");
  assert.deepEqual(burst, stepped, "one burst reads the GPU counts the frames it ran asked for, not stale ones");
});

// The MCP tool layer, not the cores: input press / timeline / navigate step a
// WebGPU cart asynchronously (an event-loop turn between frames), so they must
// await each step. They used to call stepFrames without awaiting, which wrote
// the release before the pressed frames ran: the cart never saw the button.
test("wasmcart webgpu: input press/timeline/navigate hold the button for the frames they claim", async () => {
  const { z } = await import("zod");
  const { registerInputTools } = await import("../src/mcp/tools/input.js");
  const { _setHostForTest } = await import("../src/mcp/state.js");
  const parse = res => JSON.parse(res.content.find(c => c.type === "text").text);
  const handler = (register, name, key) => {
    const map = {};
    register({ tool: (n, _d, _s, h) => { map[n] = h; } }, z, key);
    return map[name];
  };

  const host = new WasmcartHost();
  await host.loadMedia({ platform: "wasmcart", path: WGPUCART });
  const key = "wgpu-input-await";
  _setHostForTest(key, host);
  // What the cart saw each frame: the pad state in force when it ran.
  const seen = [];
  const run = host.cart.runFrame.bind(host.cart);
  host.cart.runFrame = (ports) => {
    seen.push(!!(ports?.[0]?.buttons));
    return run(ports);
  };
  try {
    const input = handler(registerInputTools, "input", key);
    const f0 = host.status.frameCount;
    seen.length = 0;
    const r = parse(await input({ op: "press", button: "south", frames: 4 }));
    // pre-release frame, 4 pressed frames, 1 release frame; all run by the
    // time the call returns, with the button held on exactly the pressed ones
    assert.equal(host.status.frameCount - f0, 6);
    assert.equal(r.framesStepped, 6);
    assert.deepEqual(seen, [false, true, true, true, true, false]);

    seen.length = 0;
    const f1 = host.status.frameCount;
    await input({ op: "timeline", timeline: [{ frame: f1 + 2, buttons: ["south"], holdFrames: 3 }] });
    assert.equal(seen.length, 5, "the timeline ran its frames before returning");
    assert.deepEqual(seen, [false, false, true, true, true]);

    seen.length = 0;
    await input({ op: "navigate", steps: [{ button: "south", holdFrames: 2, maxWaitFrames: 3, settleFrames: 0 }] });
    assert.deepEqual(seen.slice(0, 3), [true, true, false], "held for holdFrames, then released");
  } finally {
    host.destroy();
  }
});

test("wasmcart webgpu: host({op:'unload'}) unloads a WebGPU cart session", async () => {
  const { z } = await import("zod");
  const { registerLifecycleTools } = await import("../src/mcp/tools/lifecycle.js");
  const { _setHostForTest } = await import("../src/mcp/state.js");
  const map = {};
  registerLifecycleTools({ tool: (n, _d, _s, h) => { map[n] = h; } }, z, "wgpu-unload");

  const host = new WasmcartHost();
  await host.loadMedia({ platform: "wasmcart", path: WGPUCART });
  _setHostForTest("wgpu-unload", host);
  const res = await map.host({ op: "unload" });
  const text = res.content.find(c => c.type === "text").text;
  assert.match(text, /^unloaded/);
  assert.equal(host.status.loaded, false);
});
