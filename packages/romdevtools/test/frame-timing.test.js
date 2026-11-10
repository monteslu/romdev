// frame({op:'timing'}): per-frame wall, CPU and GPU time, driven through the
// same validate-then-run path the HTTP route uses (runTool), on real GPU carts.
//
// The controls are the point: a timer that reads the same number whatever the
// GPU does proves nothing. Each GPU test adds KNOWN extra GPU work to the same
// cart's frames (big clears, inside the frame) and the GPU time must rise by a
// clear margin; adds CPU work instead (a busy wait in the frame) and the wall
// time must rise while the GPU time does not, so GPU time is not wall time.
//
// Needs a working GPU for webgpu-node and native-gles, like the other wasmcart
// GPU tests; it fails rather than skips without one.

import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { buildToolRegistry, runTool } from "../src/http/tool-registry.js";
import { getHostOrNull, clearHost } from "../src/mcp/state.js";
import { summarize } from "../src/host/gpu-timing/wgpu-timer.js";
import { summary } from "../src/host/gpu-timing/stats.js";
import { enterCall, acquireExclusive, exclusiveStatus } from "../src/mcp/exclusive-gate.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WGPUCART = path.join(HERE, "fixtures", "wgpucart.wasc");
const DUALGPU = path.join(HERE, "fixtures", "dualgpu.wasc");
const HELLO = path.join(HERE, "fixtures", "hello.wasc");

async function call(reg, sk, tool, args) {
  const r = await runTool(reg.get(tool), args, sk);
  assert.ok(r.ok, `${tool} ${JSON.stringify(args)} failed: ${r.error}`);
  return r.result;
}

/** Make every frame of the session's cart also do `extra(host)` inside the frame. */
function addToFrame(sk, extra) {
  const host = getHostOrNull(sk);
  const cart = host.cart;
  const run = cart.runFrame.bind(cart);
  cart.runFrame = (pads) => { const r = run(pads); extra(host); return r; };
  return () => { cart.runFrame = run; };
}

function spin(ms) { const t = performance.now(); while (performance.now() - t < ms) { /* busy */ } }

/** WebGPU: n full clears of a 2048x2048 RGBA16F target, one render pass each. */
function wgpuClears(n) {
  let tex = null;
  return (host) => {
    const dev = host.cart.getGpuDevice();
    tex ??= dev.createTexture({ size: [2048, 2048], format: "rgba16float", usage: 0x10 /* RENDER_ATTACHMENT */ });
    const view = tex.createView();
    const enc = dev.createCommandEncoder();
    for (let i = 0; i < n; i++) {
      const p = enc.beginRenderPass({ colorAttachments: [{ view, loadOp: "clear", storeOp: "store", clearValue: [i / n, 0, 0, 1] }] });
      p.end();
    }
    dev.queue.submit([enc.finish()]);
  };
}

/** GL: n full-screen triangles of a fragment shader that loops `iters` times
 *  (clears would not do: the driver fast-clears them nearly for free). */
function glHeavy(n, iters) {
  let prog = null;
  return (host) => {
    const gl = host._gl;
    if (!prog) {
      const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); assert.ok(gl.getShaderParameter(s, gl.COMPILE_STATUS), gl.getShaderInfoLog(s)); return s; };
      prog = gl.createProgram();
      gl.attachShader(prog, sh(gl.VERTEX_SHADER, "#version 300 es\nvoid main(){vec2 p=vec2(float((gl_VertexID<<1)&2),float(gl_VertexID&2));gl_Position=vec4(p*2.0-1.0,0.0,1.0);}"));
      gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, `#version 300 es\nprecision highp float;out vec4 o;void main(){vec2 v=gl_FragCoord.xy;float a=0.0;for(int i=0;i<${iters};i++){a=fract(sin(a+v.x*0.01+float(i))*43758.5);}o=vec4(a,0.0,0.0,1.0);}`));
      gl.linkProgram(prog);
      assert.ok(gl.getProgramParameter(prog, gl.LINK_STATUS), gl.getProgramInfoLog(prog));
    }
    const was = gl.getParameter(gl.CURRENT_PROGRAM), vp = gl.getParameter(gl.VIEWPORT), fb = gl.getParameter(gl.FRAMEBUFFER_BINDING);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); // the context's own 1280x720 surface, not the cart's small target
    gl.useProgram(prog);
    gl.disable(gl.DEPTH_TEST);
    gl.viewport(0, 0, 1280, 720); // the context's floor size, whatever the cart's own viewport
    for (let i = 0; i < n; i++) gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.viewport(vp[0], vp[1], vp[2], vp[3]);
    gl.useProgram(was);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  };
}

test("timing stats: percentiles and the union of pass intervals", () => {
  const s = summary([5, 1, 3, null, 2, 4]);
  assert.deepEqual([s.n, s.min, s.max, s.mean, s.p50], [5, 1, 5, 3, 3]);
  // two overlapping passes and one apart: busy = union, span = first..last
  const u = summarize([[1_000_000n, 3_000_000n], [2_000_000n, 4_000_000n], [10_000_000n, 11_000_000n], [0n, 5n]]);
  assert.equal(u.busyMs, 4);
  assert.equal(u.spanMs, 10);
  assert.equal(u.dropped, 1, "an unwritten (zero) stamp is dropped");
});

test("timing on WebGPU: GPU time is measured, rises with extra GPU work, and is not wall time", async (t) => {
  const sk = "timing-wgpu";
  const reg = buildToolRegistry(sk);
  try {
    const load = await call(reg, sk, "loadMedia", { platform: "wasmcart", path: WGPUCART, gpuTiming: true });
    assert.equal(load.gpu, "webgpu");
    assert.equal(load.gpuAdapter.timestampQuery, true, "gpuTiming gives the device timestamp-query");
    const base = await call(reg, sk, "frame", { op: "timing", frames: 60, warmup: 10, window: 30 });
    assert.equal(base.api, "webgpu");
    assert.equal(base.measuredFrames, 60);
    assert.ok(base.gpuMs.mean > 0, "GPU time read");
    assert.equal(base.gpuMs.measure, "busy");
    assert.ok(base.gpuMs.passesPerFrame.mean >= 1, "the cart's passes were seen");
    assert.equal(base.windows.length, 2);
    assert.equal(base.contention.exclusive, true);
    assert.equal(base.gpu.onPinnedGpu ?? true, true, "no GPU work off the pinned GPU");

    // control 1: known extra GPU work in every frame must read higher
    let undo = addToFrame(sk, wgpuClears(24));
    const heavy = await call(reg, sk, "frame", { op: "timing", frames: 60, warmup: 10, window: 30 });
    undo();
    assert.ok(heavy.gpuMs.mean > base.gpuMs.mean + 0.5 && heavy.gpuMs.mean > 2 * base.gpuMs.mean,
      `24 extra 2048x2048 clears a frame: GPU ${base.gpuMs.mean} -> ${heavy.gpuMs.mean} ms`);
    assert.ok(heavy.gpuMs.passesPerFrame.mean >= base.gpuMs.passesPerFrame.mean + 24, "the extra passes were timed");

    // control 2: CPU work raises wall, not GPU: GPU time is not wall time
    undo = addToFrame(sk, () => spin(8));
    const cpu = await call(reg, sk, "frame", { op: "timing", frames: 40, window: 40 });
    undo();
    assert.ok(cpu.wallMs.mean >= base.wallMs.mean + 7, `an 8 ms busy wait: wall ${base.wallMs.mean} -> ${cpu.wallMs.mean}`);
    assert.ok(cpu.cpuMs.mean >= 7.5, "CPU time sees the busy wait");
    assert.ok(cpu.gpuMs.mean < base.gpuMs.mean + 1, `GPU time unchanged by CPU work (${base.gpuMs.mean} -> ${cpu.gpuMs.mean})`);
    assert.ok(cpu.gpuMs.gpuToWallRatio < 0.5, "GPU time is far below wall time when the frame is CPU bound");
    t.diagnostic(`WebGPU gpu ms: base ${base.gpuMs.mean}, +24 clears ${heavy.gpuMs.mean}; 8 ms CPU spin: wall ${base.wallMs.mean} -> ${cpu.wallMs.mean}, gpu ${cpu.gpuMs.mean}, gpu/wall ${cpu.gpuMs.gpuToWallRatio}`);
  } finally {
    clearHost(sk);
  }
});

test("timing on WebGPU without gpuTiming: GPU time is unavailable, and says how to get it", async () => {
  const sk = "timing-wgpu-off";
  const reg = buildToolRegistry(sk);
  try {
    const load = await call(reg, sk, "loadMedia", { platform: "wasmcart", path: WGPUCART });
    assert.equal(load.gpuAdapter.timestampQuery, false);
    const r = await call(reg, sk, "frame", { op: "timing", frames: 20 });
    assert.equal(r.gpuMs.available, false);
    assert.match(r.gpuMs.reason, /gpuTiming:true/);
    assert.ok(r.wallMs.mean > 0 && r.cpuMs.mean > 0, "wall and CPU are still measured");
  } finally {
    clearHost(sk);
  }
});

test("timing on GL: a TIME_ELAPSED query per frame, rising with extra GPU work", async (t) => {
  const sk = "timing-gl";
  const reg = buildToolRegistry(sk);
  try {
    const load = await call(reg, sk, "loadMedia", { platform: "wasmcart", path: DUALGPU, wgpu: false });
    assert.equal(load.gpu, "gl");
    assert.ok(load.glRenderer, "the GL renderer is reported");
    const base = await call(reg, sk, "frame", { op: "timing", frames: 60, warmup: 10, window: 60 });
    assert.equal(base.api, "gl");
    assert.equal(base.gpuMs.measure, "span");
    assert.ok(base.gpuMs.mean > 0);
    assert.equal(base.gpu.glRenderer, load.glRenderer);
    const undo = addToFrame(sk, glHeavy(4, 64));
    const heavy = await call(reg, sk, "frame", { op: "timing", frames: 60, warmup: 10, window: 60 });
    undo();
    assert.ok(heavy.gpuMs.mean > base.gpuMs.mean + 0.5 && heavy.gpuMs.mean > 2 * base.gpuMs.mean,
      `4 extra full-screen 64-iteration shader passes a frame: GPU ${base.gpuMs.mean} -> ${heavy.gpuMs.mean} ms`);
    t.diagnostic(`GL gpu ms: base ${base.gpuMs.mean}, +4 heavy passes ${heavy.gpuMs.mean}`);
  } finally {
    clearHost(sk);
  }
});

test("timing on a 2D cart: wall and CPU, GPU unavailable because nothing runs on it", async () => {
  const sk = "timing-2d";
  const reg = buildToolRegistry(sk);
  try {
    await call(reg, sk, "loadMedia", { platform: "wasmcart", path: HELLO });
    const r = await call(reg, sk, "frame", { op: "timing", frames: 30, series: true });
    assert.equal(r.api, "2d");
    assert.equal(r.gpuMs.available, false);
    assert.match(r.gpuMs.reason, /CPU/);
    assert.equal(r.series.wallMs.length, 30);
  } finally {
    clearHost(sk);
  }
});

test("the exclusive gate: other sessions wait, the holder and catalog do not, and a drain waits for in-flight calls", async () => {
  const leaveOther = await enterCall("gate-other", "frame"); // a call already running in another session
  let acquired = false;
  const gp = acquireExclusive("gate-holder", { drainMs: 2000 }).then((g) => { acquired = true; return g; });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(acquired, false, "the gate waits for the other session's running call");
  leaveOther();
  const gate = await gp;
  assert.equal(gate.stillInflight, 0);
  assert.equal(exclusiveStatus().session, "gate-holder");
  let otherRan = false;
  const blocked = enterCall("gate-other", "frame").then((leave) => { otherRan = true; leave(); });
  const own = await enterCall("gate-holder", "frame"); own();       // the holder's own calls run
  const cat = await enterCall("gate-other", "catalog"); cat();      // status checks always answer
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(otherRan, false, "another session's call waits while the gate is held");
  assert.ok(gate.heldCalls() >= 1);
  gate.release();
  await blocked;
  assert.equal(otherRan, true, "and runs once it is released");
  assert.equal(exclusiveStatus(), null);
});

/**
 * A fake host with the timing contract and a debug channel, so the runner's
 * logic (windows, pass timers riding on a frame, variants, debug fields, an
 * error reply stopping the run) is tested without a GPU. Its GPU time is 1 ms,
 * or 3 ms after the command "heavy".
 */
function fakeTimingHost() {
  const mem = new Uint8Array(4096);
  const fields = { "dbg.cmd": { name: "dbg.cmd", valuePtr: 0, len: 256 }, "dbg.reply": { name: "dbg.reply", valuePtr: 256, len: 1024 } };
  const vals = { "dbg.cmd_seq": 0, "dbg.reply_seq": 0, "dbg.reply_len": 0, "game.count": 0 };
  let heavy = false, frame = 0;
  const host = {
    status: { loaded: true, frameCount: 0, fbWidth: 64, fbHeight: 32 },
    readDebugState: () => [...Object.values(fields), ...Object.keys(vals).map((name) => ({ name }))],
    readDebugValue: (n) => ({ value: vals[n] }),
    writeDebugValue: (n, v) => { vals[n] = v; },
    readMemory: (o, l) => mem.slice(o, o + l),
    writeMemory: (o, b) => mem.set(b, o),
    setInput: () => {},
    runFrame() { // the cart answers a pending request at the start of its frame
      if (vals["dbg.cmd_seq"] !== vals["dbg.reply_seq"]) {
        const text = Buffer.from(mem.slice(0, 256)).toString("utf8").split("\0")[0];
        let reply;
        if (text === "heavy") { heavy = true; reply = { ok: true }; }
        else if (text === "light") { heavy = false; reply = { ok: true }; }
        else if (text === "pipeline") reply = { timer_query: true, gpu_ms: 1, passes: [{ name: "scene", ran: true, fused: false, gpu_ms: heavy ? 2.5 : 0.8, cpu_ms: 0.1 }, { name: "ui", ran: true, fused: true, gpu_ms: 0.2, cpu_ms: 0 }] };
        else reply = { error: `unknown command '${text}'` };
        const b = Buffer.from(JSON.stringify(reply));
        mem.set(b, 256);
        vals["dbg.reply_len"] = b.length;
        vals["dbg.reply_seq"] = vals["dbg.cmd_seq"];
      }
      frame++; vals["game.count"] = frame; host.status.frameCount++;
    },
    stepFrames(n) { for (let i = 0; i < n; i++) host.runFrame(); return n; },
    timingInfo: () => ({ host: "fake", api: "webgpu", cpu: "c", wall: "w", gpu: { available: true, measure: "busy", method: "m" } }),
    timingBegin: async () => {},
    timedFrame: async () => { host.runFrame(); return { wallMs: 5, cpuMs: 2, gpuMs: heavy ? 3 : 1, gpuSpanMs: heavy ? 3 : 1 }; },
    timingEnd: async () => {},
  };
  return host;
}

test("timing runner: windows, debug fields, pass timers on the window's last frame, variants, and an error reply stops the run", async () => {
  const { measureFrameTiming } = await import("../src/host/gpu-timing/measure.js");
  const host = fakeTimingHost();
  const r = await measureFrameTiming({ host, sessionKey: "fake", args: { frames: 60, warmup: 5, window: 20, fields: ["game.count"], passTimers: true, commands: ["light"] } });
  assert.equal(r.measuredFrames, 60);
  assert.equal(r.windows.length, 3);
  assert.equal(r.gpuMs.mean, 1);
  assert.equal(r.gpuMs.gpuToWallRatio, 0.2);
  assert.equal(r.passTimers.length, 3, "one pass-timer reply per window");
  assert.equal(r.windows[0].passTimers.totalGpuMs, 0.8, "a fused pass is not summed");
  assert.equal(r.windows[0].passTimers.passes.ui.fused, true);
  // the setup command took one frame, the warmup five: the first measured frame is the 7th
  assert.equal(r.windows[0].fields["game.count"].min, 7);
  assert.equal(host.status.frameCount, 1 + 5 + 60, "pass timers rode on measured frames: no extra frame");

  const ab = await measureFrameTiming({ host, sessionKey: "fake", args: { frames: 10, window: 10, rounds: 2, variants: [{ name: "a", commands: ["light"] }, { name: "b", commands: ["heavy"] }] } });
  assert.deepEqual(ab.variants.map((v) => [v.name, v.measuredFrames, v.gpuMs.mean]), [["a", 20, 1], ["b", 20, 3]]);
  assert.deepEqual(ab.variants[1].rounds.map((x) => x.gpuMs), [3, 3]);

  await assert.rejects(measureFrameTiming({ host, sessionKey: "fake", args: { frames: 10, commands: ["quality verylow"] } }), /answered an error: unknown command/);
});
