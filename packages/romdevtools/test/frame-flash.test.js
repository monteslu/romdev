// frame({op:'flash'}) and frame({op:'record'}): a range of frames captured in
// one call, box-filtered in linear light, and checked against the
// photosensitive flash rules (host/flash/analysis.js) with its strobe control.
//
// The controls are the point. A check that passes everything proves nothing,
// so: a known 8 Hz strobe drawn INTO the cart's frames on the GPU (GL and
// WebGPU) must fail through the real capture path; the same cart with a slow
// swell must pass; the built-in control (the strobe laid over the captured
// frames) must fail on every run; a still picture is called out as proving
// nothing. Unit tests pin each measure on synthetic frames.
//
// Needs a working GPU for webgpu-node and native-gles, like the other wasmcart
// GPU tests; it fails rather than skips without one.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildToolRegistry, runTool } from "../src/http/tool-registry.js";
import { getHostOrNull, clearHost } from "../src/mcp/state.js";
import { createFlashAnalyser, judgeFlash, strobeFrame, LIN } from "../src/host/flash/analysis.js";
import { makeBoxFilter, outputSize } from "../src/host/flash/capture.js";
import { requireTestRom } from "./helpers/test-rom.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DUALGPU = path.join(HERE, "fixtures", "dualgpu.wasc");

async function call(reg, sk, tool, args) {
  const r = await runTool(reg.get(tool), args, sk);
  assert.ok(r.ok, `${tool} ${JSON.stringify(args)} failed: ${r.error}`);
  return r.result;
}

// ── synthetic frames ──
const W = 96, H = 54;
function solid(rgb) { const f = new Uint8Array(W * H * 3); for (let i = 0; i < W * H; i++) f.set(rgb, i * 3); return f; }
/** a slowly drifting gradient: motion, no flashes */
function drift(i) {
  const f = new Uint8Array(W * H * 3);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const v = 90 + 60 * Math.sin((x + i * 0.7) / 9) * Math.sin((y + i * 0.3) / 7); const o = (y * W + x) * 3; f[o] = v; f[o + 1] = v; f[o + 2] = v + 20; }
  return f;
}
function analyse(frames, opts) { const a = createFlashAnalyser(W, H, opts); frames.forEach((f) => a.push(f)); const m = a.result(); return { m, why: judgeFlash(m) }; }
const range = (n, fn) => Array.from({ length: n }, (_, i) => fn(i));

test("flash analysis: a drifting picture passes; the 8 Hz strobe laid over it fails (the control)", () => {
  const frames = range(180, drift);
  const run = analyse(frames);
  assert.deepEqual(run.why, [], run.why.join("; "));
  const scratch = new Uint8Array(W * H * 3);
  const ctl = analyse(frames.map((f, i) => Uint8Array.from(strobeFrame(f, i, scratch))));
  assert.ok(ctl.m.regions.flashes >= 7, `8 Hz strobe: ${ctl.m.regions.flashes} flashes a second`);
  assert.ok(ctl.why.some((w) => /sixth of the screen/.test(w)));
  assert.equal(ctl.m.worstSecond.measure, "regions");
});

test("flash analysis: a 2 Hz swell passes, 5 Hz full-screen flashing fails, saturated red at 5 Hz fails the red measure", () => {
  const swell = analyse(range(240, (i) => solid(Array(3).fill(Math.round(40 + 180 * (0.5 - 0.5 * Math.cos(2 * Math.PI * 2 * i / 60)))))));
  // 2 Hz is 2 flashes a second: within the bound of 3
  assert.ok(swell.m.regions.flashes <= 3, `2 Hz swell: ${swell.m.regions.flashes}`);
  assert.equal(swell.why.filter((w) => /flashes in one second/.test(w)).length, 0);
  const five = analyse(range(240, (i) => solid(Math.floor(i / 6) % 2 ? [230, 230, 230] : [20, 20, 20])));
  assert.ok(five.m.regions.flashes >= 4, `5 Hz: ${five.m.regions.flashes}`);
  assert.ok(five.why.length > 0);
  const red = analyse(range(240, (i) => solid(Math.floor(i / 6) % 2 ? [255, 0, 0] : [60, 0, 0])));
  assert.ok(red.m.regionsRed.flashes >= 4, `red 5 Hz: ${red.m.regionsRed.flashes}`);
  assert.ok(red.why.some((w) => /red/.test(w)));
});

test("flash analysis: small lights switching together over a field fail; the same lights out of step do not", () => {
  // single-pixel lights on a 3-pixel lattice (each far smaller than a region block, so blocks barely move)
  const lights = (i, together) => {
    const f = solid([20, 20, 20]);
    for (let y = 0; y < H; y += 3) for (let x = 0; x < W; x += 3) {
      const phase = together ? 0 : ((x * 7 + y * 13) % 12);
      if (Math.floor((i + phase) / 6) % 2) f.set([255, 255, 255], (y * W + x) * 3);
    }
    return f;
  };
  const sync = analyse(range(240, (i) => lights(i, true)), { fieldShare: 0.05 });
  const apart = analyse(range(240, (i) => lights(i, false)), { fieldShare: 0.05 });
  assert.ok(sync.m.fields.flashes > 3, `lights together: fields ${sync.m.fields.flashes}`);
  assert.ok(apart.m.fields.flashes <= 3, `lights out of step: fields ${apart.m.fields.flashes}`);
});

test("flash analysis: a still picture proves nothing; maxRise bounds a hard onset", () => {
  const still = analyse(range(120, () => solid([100, 100, 100])));
  assert.ok(still.why.some((w) => /proves nothing/.test(w)));
  const step = range(120, (i) => (i < 60 ? solid([20, 20, 20]) : solid([200, 200, 200])));
  assert.deepEqual(analyse(step).why.filter((w) => /onset/.test(w)), []);
  assert.ok(analyse(step, { maxRise: 0.2 }).why.some((w) => /onset/.test(w)));
});

test("box filter: an integer factor is the linear-light block mean (the native dump's filter), any size maps every pixel", () => {
  const w = 40, h = 24, f = 8;
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < rgba.length; i++) rgba[i] = (i * 2654435761) >>> 24;
  const { ow, oh, factor } = outputSize(w, h, { downscale: f });
  assert.deepEqual([ow, oh, factor], [5, 3, 8]);
  const out = makeBoxFilter(w, h, ow, oh, factor)(rgba, w * 4, 0, 1, 2);
  // reference: cartwheel tools/lib/flash.mjs boxDown, written out
  const enc = (v) => Math.max(0, Math.min(255, Math.round(255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055))));
  for (let oy = 0; oy < oh; oy++) for (let ox = 0; ox < ow; ox++) for (let c = 0; c < 3; c++) {
    let s = 0;
    for (let y = oy * f; y < oy * f + f; y++) for (let x = ox * f; x < ox * f + f; x++) s += LIN[rgba[(y * w + x) * 4 + c]];
    assert.equal(out[(oy * ow + ox) * 3 + c], enc(s / 64));
  }
  // half black, half white columns averaged in LINEAR light read ~188, not 128
  const bw = new Uint8Array(16 * 16 * 4);
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) bw.fill(x % 2 ? 255 : 0, (y * 16 + x) * 4, (y * 16 + x) * 4 + 3);
  assert.equal(makeBoxFilter(16, 16, 2, 2, 8)(bw, 64, 0, 1, 2)[0], 188);
  assert.deepEqual(outputSize(1920, 1080, {}), { ow: 240, oh: 135, factor: 8 });
  assert.deepEqual(outputSize(256, 240, {}), { ow: 256, oh: 240, factor: 1 });
  assert.deepEqual(outputSize(1920, 1080, { size: { width: 240, height: 135 } }), { ow: 240, oh: 135, factor: 8 });
  const odd = outputSize(300, 200, { size: { width: 64, height: 48 } });
  assert.equal(odd.factor, null);
  const oddOut = makeBoxFilter(300, 200, 64, 48, null)(new Uint8Array(300 * 200 * 4).fill(255), 1200, 0, 1, 2);
  assert.ok(oddOut.every((v) => v === 255), "every output pixel is covered");
});

// ── through the tool, on the GPU ──

/** GL: after each of the cart's frames, clear its frame (the redirect FBO, bound at rest) to color(i). */
function glPaint(sk, color) {
  const host = getHostOrNull(sk);
  const cart = host.cart, gl = host._gl, run = cart.runFrame.bind(cart);
  let i = 0;
  cart.runFrame = (pads) => {
    const r = run(pads);
    const c = color(i++);
    const sc = gl.isEnabled(gl.SCISSOR_TEST);
    gl.disable(gl.SCISSOR_TEST);
    gl.clearColor(c[0], c[1], c[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (sc) gl.enable(gl.SCISSOR_TEST);
    return r;
  };
  return () => { cart.runFrame = run; };
}

/** WebGPU: every render pass the cart begins clears to color(frame) instead of its own clear color. */
function wgpuPaint(sk, color) {
  const host = getHostOrNull(sk);
  const cart = host.cart, run = cart.runFrame.bind(cart);
  const dev = cart.getGpuDevice();
  const mk = dev.createCommandEncoder.bind(dev);
  let i = 0, c = color(0), passes = 0;
  dev.createCommandEncoder = (d) => {
    const enc = mk(d), begin = enc.beginRenderPass.bind(enc);
    enc.beginRenderPass = (pd) => {
      passes++;
      return begin({ ...pd, colorAttachments: pd.colorAttachments.map((a) => (a ? { ...a, loadOp: "clear", clearValue: [c[0], c[1], c[2], 1] } : a)) });
    };
    return enc;
  };
  cart.runFrame = (pads) => { c = color(i++); return run(pads); };
  return { undo: () => { cart.runFrame = run; dev.createCommandEncoder = mk; }, passes: () => passes };
}

const swell = (i) => { const v = 0.35 + 0.25 * Math.sin((2 * Math.PI * i) / 150); return [v, v * 0.9, v * 0.8]; }; // 0.4 Hz
const strobe8 = (i) => (Math.floor((i * 16) / 60) % 2 ? [0.95, 0.95, 0.95] : [0.05, 0.05, 0.05]); // 8 Hz

for (const api of ["gl", "webgpu"]) {
  test(`flash through the tool on ${api}: a swell passes with its control failing; an 8 Hz strobe drawn on the GPU fails; record writes the same frames`, async (t) => {
    const sk = `flash-${api}`;
    const reg = buildToolRegistry(sk);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "romdev-flash-"));
    try {
      const load = await call(reg, sk, "loadMedia", { platform: "wasmcart", path: DUALGPU, wgpu: api === "webgpu" });
      assert.equal(load.gpu, api);
      await call(reg, sk, "frame", { op: "step", frames: 3 });

      // a still cart: the check says it proves nothing (and the control still fails)
      const still = await call(reg, sk, "frame", { op: "flash", frames: 90 });
      assert.equal(still.pass, false);
      assert.ok(still.problems.some((p) => /proves nothing/.test(p)), JSON.stringify(still.problems));
      assert.equal(still.control.failsAsItMust, true);

      const paint = api === "gl" ? glPaint : (s, c) => wgpuPaint(s, c).undo;
      let undo = paint(sk, swell);
      const before = getHostOrNull(sk).status.frameCount;
      const ok = await call(reg, sk, "frame", { op: "flash", frames: 240, warmup: 2, path: path.join(dir, "swell.cwfd") });
      undo();
      assert.equal(getHostOrNull(sk).status.frameCount, before + 242, "warmup + frames stepped in the one call");
      assert.equal(ok.frames.captured, 240);
      assert.equal(ok.frames.firstFrame, before + 3);
      assert.deepEqual(ok.problems, [], JSON.stringify(ok.result));
      assert.equal(ok.verdict, "ok");
      assert.equal(ok.control.failsAsItMust, true, "the strobe control fails");
      assert.equal(ok.checkOk, true);
      assert.ok(ok.result.motion > 0.0005);

      undo = paint(sk, strobe8);
      const bad = await call(reg, sk, "frame", { op: "flash", frames: 180 });
      undo();
      assert.equal(bad.verdict, "FAIL");
      assert.ok(bad.result.regions.flashes >= 7, `8 Hz on the GPU: ${bad.result.regions.flashes} flashes a second`);
      assert.ok(bad.result.worstSecond && bad.result.worstSecond.regions >= 7);
      assert.ok(bad.problems.some((p) => /sixth of the screen/.test(p)));

      // record: the same capture in one CW_FRAME_DUMP file, matching what flash kept
      await call(reg, sk, "loadMedia", { platform: "wasmcart", path: DUALGPU, wgpu: api === "webgpu" });
      undo = paint(sk, swell);
      const rec = await call(reg, sk, "frame", { op: "record", frames: 60, path: path.join(dir, "rec.cwfd") });
      undo();
      const buf = fs.readFileSync(rec.path);
      assert.equal(buf.readUInt32LE(0), 0x44465743);
      assert.equal(buf.readUInt32LE(4), rec.width);
      assert.equal(buf.readUInt32LE(8), rec.height);
      assert.equal(buf.length, 16 + 60 * rec.width * rec.height * 3);
      assert.equal(rec.bytes, buf.length);
      const kept = fs.readFileSync(path.join(dir, "swell.cwfd"));
      assert.equal(kept.length, ok.dump.bytes);
      // each frame is the painted colour: one pixel of frame k
      const px = (k) => [...buf.subarray(16 + k * rec.width * rec.height * 3, 16 + k * rec.width * rec.height * 3 + 3)];
      const a = px(0), b = px(37);
      assert.notDeepEqual(a, b, "frames differ over the range (each frame captured, not one repeated)");
      t.diagnostic(`${api}: swell ${ok.summary}; strobe ${bad.summary}; control ${ok.control.summary}; timing ${JSON.stringify(ok.timing)}`);
    } finally {
      clearHost(sk);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("record and flash refuse what they cannot do: nothing loaded, record without a path", async () => {
  const sk = "flash-errors";
  const reg = buildToolRegistry(sk);
  try {
    const r = await runTool(reg.get("frame"), { op: "flash", frames: 30 }, sk);
    assert.equal(r.ok, false);
    await call(reg, sk, "loadMedia", { platform: "wasmcart", path: DUALGPU, wgpu: false });
    const r2 = await runTool(reg.get("frame"), { op: "record", frames: 30 }, sk);
    assert.equal(r2.ok, false);
    assert.match(String(r2.error), /path/);
  } finally {
    clearHost(sk);
  }
});

test("ranged capture on any host: steps hold each pad for its frames, the last to the end; an XRGB8888 (libretro) frame is read in its own byte order", async () => {
  const { captureRange } = await import("../src/host/flash/capture.js");
  const seen = [];
  let pads = null, n = 0;
  // a libretro-shaped host: XRGB8888 (bytes B, G, R, X), 64x48, its colour set by the pad
  const host = {
    status: { loaded: true, frameCount: 0 },
    setInput(i) { pads = i; },
    stepFrames(k) { n += k; this.status.frameCount += k; seen.push(JSON.stringify(pads?.ports?.[0] ?? null)); return k; },
    getFramebuffer() {
      const px = new Uint8Array(64 * 48 * 4);
      const red = pads?.ports?.[0]?.a ? 200 : 10;
      for (let i = 0; i < 64 * 48; i++) { px[i * 4] = 30; px[i * 4 + 1] = 20; px[i * 4 + 2] = red; }
      return { width: 64, height: 48, pixels: px, pitch: 256, format: 1 };
    },
  };
  const reds = [];
  const r = await captureRange({ host, op: "record", frames: 6, warmup: 1, steps: [{ input: { ports: [{}] }, frames: 3 }, { input: { ports: [{ a: true, axes: { lx: 1 } }] }, frames: 2 }],
    onFrame: (rgb) => reds.push(rgb[0]) });
  assert.equal(r.captured, 6);
  assert.equal(n, 7);
  assert.deepEqual(seen, ["{}", "{}", "{}", '{"a":true,"axes":{"lx":1}}', '{"a":true,"axes":{"lx":1}}', '{"a":true,"axes":{"lx":1}}', '{"a":true,"axes":{"lx":1}}'], "the last step held to the end");
  assert.deepEqual(reds, [10, 10, 200, 200, 200, 200], "R read from byte 2 of XRGB8888");
  assert.equal(r.dims.factor, 1, "64 wide is under 240: no downscale");
  // neither input nor steps: the held pad is left alone
  pads = { ports: [{ b: true }] };
  seen.length = 0;
  await captureRange({ host, op: "record", frames: 2, onFrame: () => {} });
  assert.deepEqual(seen, ['{"b":true}', '{"b":true}']);
  await assert.rejects(captureRange({ host, op: "flash", frames: 2, input: "0:a:1", steps: [], onFrame: () => {} }), /not both/);
});

const NES = requireTestRom(import.meta.url);
test("flash on a libretro core (NES): every frame captured at the core's own size, the control fails", { skip: NES.skip }, async () => {
  const sk = "flash-nes";
  const reg = buildToolRegistry(sk);
  try {
    await call(reg, sk, "loadMedia", { platform: "nes", path: NES.path });
    const r = await call(reg, sk, "frame", { op: "flash", frames: 120, warmup: 30 });
    assert.equal(r.frames.captured, 120);
    assert.deepEqual(r.size.analysed, r.size.source, "a 256-wide picture is checked at its own size");
    assert.equal(r.control.failsAsItMust, true);
  } finally {
    clearHost(sk);
  }
});

test("commandsAt: a debug command posted before a frame of the range is answered in that frame, with no extra frame; an error reply stops the call", async () => {
  const { captureRange } = await import("../src/host/flash/capture.js");
  const mem = new Uint8Array(4096);
  const fields = { "dbg.cmd": { name: "dbg.cmd", valuePtr: 0, len: 256 }, "dbg.reply": { name: "dbg.reply", valuePtr: 256, len: 1024 } };
  const vals = { "dbg.cmd_seq": 0, "dbg.reply_seq": 0, "dbg.reply_len": 0 };
  let level = 20;
  const host = {
    status: { loaded: true, frameCount: 0 },
    readDebugState: () => [...Object.values(fields), ...Object.keys(vals).map((name) => ({ name }))],
    readDebugValue: (n) => ({ value: vals[n] }),
    writeDebugValue: (n, v) => { vals[n] = v; },
    readMemory: (o, l) => mem.slice(o, o + l),
    writeMemory: (o, b) => mem.set(b, o),
    setInput: () => {},
    stepFrames(n) {
      for (let i = 0; i < n; i++) {
        if (vals["dbg.cmd_seq"] !== vals["dbg.reply_seq"]) { // answered at the start of the frame
          const text = Buffer.from(mem.slice(0, 256)).toString("utf8").split("\0")[0];
          const m = /^level (\d+)$/.exec(text);
          if (m) level = +m[1];
          const b = Buffer.from(JSON.stringify(m ? { ok: true } : { error: `unknown '${text}'` }));
          mem.set(b, 256); vals["dbg.reply_len"] = b.length; vals["dbg.reply_seq"] = vals["dbg.cmd_seq"];
        }
        this.status.frameCount++;
      }
      return n;
    },
    getFramebuffer() { return { width: 32, height: 24, pixels: new Uint8Array(32 * 24 * 4).fill(level), pitch: 128, format: 0x52474241 }; },
  };
  const seen = [];
  const r = await captureRange({ host, op: "flash", frames: 10, warmup: 2, commandsAt: [{ frame: 5, command: "level 200" }, { frame: 8, command: "level 90" }], onFrame: (rgb) => seen.push(rgb[0]) });
  assert.equal(host.status.frameCount, 12, "no frame added for the commands");
  // call frames 0-1 are warmup: captured frame k is call frame k + 2
  assert.deepEqual(seen, [20, 20, 20, 200, 200, 200, 90, 90, 90, 90]);
  assert.deepEqual(r.timedReplies.map((x) => [x.frame, x.answeredAt]), [[5, 5], [8, 8]]);
  await assert.rejects(captureRange({ host, op: "flash", frames: 4, commandsAt: [{ frame: 1, command: "nope" }], onFrame: () => {} }), /answered an error/);
});
