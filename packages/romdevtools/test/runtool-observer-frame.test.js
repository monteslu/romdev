// REGRESSION: the HTTP/skill execution path (runTool) must surface the observer
// sidebands that the MCP observer middleware handles — otherwise frame({op:'verify'})
// (and screenshot({path:...}), and watch/breakpoint tools) emit NO frame to the
// /livestream when driven over REST, even though they do over MCP. This was a
// real, user-reported bug: "verify still not emitting images to livestream UI."
// runTool only fired the `call` event and dropped `_observerImages` /
// `_observerFrameProvider`. This test drives runTool directly with fake tools and
// asserts: (1) a deferred _observerFrameProvider becomes a `call_frame` image
// event, (2) an _observerImages sideband rides on the `call` event, (3) BOTH are
// stripped from the caller-visible result.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runTool } from "../src/http/tool-registry.js";
import { observer } from "../src/observer/bus.js";

// Collect bus events for a given session during a body of work.
function collect(sessionKey) {
  const events = [];
  const on = (ev) => { if (ev.sessionKey === sessionKey) events.push(ev); };
  observer.on("event", on);
  return { events, stop: () => observer.off("event", on) };
}
const tick = () => new Promise((r) => setImmediate(r));

// A minimal "tool" shaped like what the registry harvests: { name, handler, inputSchema }.
function fakeTool(name, handler) {
  return { name, handler, inputSchema: null };
}

test("runTool turns a deferred _observerFrameProvider into a call_frame image event (REST path)", async () => {
  const key = "runtool-frame-1";
  const { events, stop } = collect(key);
  try {
    const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQAY3Y2wAAAAAElFTkSuQmCC";
    const tool = fakeTool("frame", async () => ({
      content: [{ type: "text", text: JSON.stringify({ verified: true, frame: 60 }) }],
      _observerFrameProvider: () => ({ kind: "image", mimeType: "image/png", base64: PNG_B64 }),
    }));

    const out = await runTool(tool, { op: "verify" }, key);

    // caller-visible result is JSON-only; the provider must be stripped.
    assert.equal(out.ok, true);
    assert.equal(out.result.verified, true);
    assert.equal(out.result._observerFrameProvider, undefined, "provider not leaked to caller");

    // the deferred frame fires on setImmediate, after runTool returns.
    await tick(); await tick();
    const callEv = events.find((e) => e.type === "call" && e.tool === "frame");
    const frameEv = events.find((e) => e.type === "call_frame" && e.tool === "frame");
    assert.ok(callEv, "a `call` event was emitted");
    assert.ok(frameEv, "a deferred `call_frame` event was emitted");
    assert.equal(frameEv.images.length, 1);
    assert.equal(frameEv.images[0].mimeType, "image/png");
    assert.ok(frameEv.images[0].base64.startsWith("iVBOR"), "real PNG payload");
  } finally {
    stop();
  }
});

test("runTool rides an _observerImages sideband on the call event + strips it (REST path)", async () => {
  const key = "runtool-frame-2";
  const { events, stop } = collect(key);
  try {
    const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQAY3Y2wAAAAAElFTkSuQmCC";
    // screenshot({path}) shape: returns JSON {path,...} + a disk-written frame sideband.
    const tool = fakeTool("frame", async () => {
      const res = { content: [{ type: "text", text: JSON.stringify({ path: "/tmp/x.png", width: 256, height: 240 }) }] };
      res._observerImages = [{ kind: "image", mimeType: "image/png", base64: PNG_B64 }];
      return res;
    });

    const out = await runTool(tool, { op: "screenshot", path: "/tmp/x.png" }, key);
    assert.equal(out.ok, true);
    assert.equal(out.result.path, "/tmp/x.png");
    assert.equal(out.result._observerImages, undefined, "sideband not leaked to caller");

    await tick();
    const callEv = events.find((e) => e.type === "call" && e.tool === "frame");
    assert.ok(callEv, "a `call` event was emitted");
    assert.ok(Array.isArray(callEv.images) && callEv.images.length === 1, "sideband image rode the call event");
    assert.equal(callEv.images[0].mimeType, "image/png");
  } finally {
    stop();
  }
});
