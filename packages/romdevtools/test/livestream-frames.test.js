// Livestream frame coverage (0.29.0): more tools emit frames to /livestream,
// throttled to one per 2s PER (session, tool) with a trailing-edge emit.
//   - pushObserverFrame: rate limit + trailing frame + per-tool/per-session
//     independence (multiple agents on one server never throttle each other).
//   - Tier-1 tools attach a deferred frame provider (+ caption) at zero agent
//     cost: frame step, input set/press/navigate, state load, loadMedia,
//     host reset, runUntil, cheats apply, cpu call.
//   - Sideband images on to-disk renders are LIFTED to the MCP result object,
//     never serialized into the agent-visible JSON text.

import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";

import { observer, pushObserverFrame, _setFrameThrottleForTest } from "../src/observer/bus.js";
import { registerFrameTools } from "../src/mcp/tools/frame.js";
import { registerInputTools } from "../src/mcp/tools/input.js";
import { _setHostForTest } from "../src/mcp/state.js";

function toolHandler(registerFn, toolName, sessionKey) {
  const map = {};
  registerFn({ tool: (n, _d, _s, h) => { map[n] = h; } }, z, sessionKey);
  return map[toolName];
}

function fakeHost() {
  return {
    status: { platform: "nes", loaded: true, frameCount: 0, fbWidth: 256, fbHeight: 240 },
    stepFrames(n) { this.status.frameCount += n; return n; },
    setInput() {},
    screenshot() { return { pngBase64: "iVBORw0KGgo=", width: 256, height: 240 }; },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("pushObserverFrame throttles per (session, tool) with a trailing emit", async () => {
  _setFrameThrottleForTest(120);
  const got = [];
  const onEvent = (e) => { if (e.type === "call_frame") got.push(e); };
  observer.on("event", onEvent);
  try {
    const provider = () => ({ kind: "image", mimeType: "image/png", base64: "QUJD" });
    // 5 rapid calls, same session+tool → 1 immediate + 1 trailing.
    for (let i = 0; i < 5; i++) pushObserverFrame({ sessionKey: "s1", tool: "frame" }, provider);
    // A DIFFERENT tool in the same session emits immediately (no cross-tool throttle).
    pushObserverFrame({ sessionKey: "s1", tool: "input" }, provider);
    // A DIFFERENT session using the same tool emits immediately (multi-agent server).
    pushObserverFrame({ sessionKey: "s2", tool: "frame" }, provider);
    await sleep(40);
    assert.equal(got.filter((e) => e.sessionKey === "s1" && e.tool === "frame").length, 1, "burst start emits once");
    assert.equal(got.filter((e) => e.sessionKey === "s1" && e.tool === "input").length, 1, "different tool not throttled");
    assert.equal(got.filter((e) => e.sessionKey === "s2").length, 1, "different session not throttled");
    await sleep(150);
    assert.equal(got.filter((e) => e.sessionKey === "s1" && e.tool === "frame").length, 2, "the burst's TRAILING frame lands after the window");
  } finally {
    observer.off("event", onEvent);
    _setFrameThrottleForTest(2000);
  }
});

test("frame step + input ops attach a deferred frame provider with a caption", async () => {
  const key = "ls-frames";
  _setHostForTest(key, fakeHost());
  const frame = toolHandler(registerFrameTools, "frame", key);
  const input = toolHandler(registerInputTools, "input", key);

  const stepRes = await frame({ op: "step", frames: 3 });
  assert.equal(typeof stepRes._observerFrameProvider, "function", "frame step must attach a frame provider");
  assert.match(stepRes._observerFrameCaption, /step ×3/);
  const img = stepRes._observerFrameProvider();
  assert.equal(img.mimeType, "image/png");
  // The provider/caption are TOP-LEVEL sidebands — never inside the JSON text.
  assert.doesNotMatch(stepRes.content[0].text, /_observerFrame/);

  const pressRes = await input({ op: "press", button: "start", frames: 2 });
  assert.equal(typeof pressRes._observerFrameProvider, "function", "input press must attach a frame provider");
  assert.match(pressRes._observerFrameCaption, /press start/);
  assert.doesNotMatch(pressRes.content[0].text, /_observerFrame/);

  const setRes = await input({ op: "set", ports: [{ right: true }] });
  assert.equal(typeof setRes._observerFrameProvider, "function", "input set must attach a frame provider");
});

test("to-disk art renders lift the sideband image OUT of the agent-visible JSON", async () => {
  const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const { PNG } = await import("pngjs");
  const { registerSpritePipelineTools } = await import("../src/mcp/tools/sprite-pipeline.js");

  const dir = await mkdtemp(path.join(os.tmpdir(), "romdev-ls-art-"));
  try {
    // A tiny 8x8 truecolor PNG.
    const png = new PNG({ width: 8, height: 8 });
    for (let i = 0; i < 8 * 8 * 4; i += 4) { png.data[i] = 200; png.data[i + 3] = 255; }
    const src = path.join(dir, "in.png");
    await writeFile(src, PNG.sync.write(png));

    const encodeArt = toolHandler(registerSpritePipelineTools, "encodeArt", "ls-art");
    const res = await encodeArt({ stage: "quantize", path: src, outputPath: path.join(dir, "out.png"), platform: "nes", intent: "homebrew" });
    assert.ok(Array.isArray(res._observerImages) && res._observerImages.length === 1,
      "to-disk quantize must carry the rendered PNG as a livestream sideband");
    assert.doesNotMatch(res.content[0].text, /_observerImages|base64/,
      "the sideband must NOT leak into the agent-visible JSON");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
