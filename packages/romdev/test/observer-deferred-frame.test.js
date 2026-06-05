// The breakpoint/watch tools push the post-run framebuffer to /livestream for
// the HUMAN to watch — but the PNG encode must NOT slow the agent down. This
// pins that contract: a tool result carrying `_observerFrameProvider` has the
// provider (a) stripped from the agent-visible result, (b) NOT invoked on the
// tool's critical path, (c) invoked ASYNC afterward, and (d) emitted as a
// `call_frame` observer event carrying the image.

import { test } from "node:test";
import assert from "node:assert/strict";

import { observer } from "../src/observer/bus.js";
import { installObserverMiddleware } from "../src/observer/tool-wrap.js";

test("deferred observer frame: stripped, async, off the agent's critical path", async () => {
  const got = [];
  const onEvent = (e) => { if (e.type === "call" || e.type === "call_frame") got.push(e); };
  observer.on("event", onEvent);
  try {
    let providerCalled = false;
    let captured;
    const fakeServer = { tool(name, ...rest) { captured = rest[rest.length - 1]; } };
    installObserverMiddleware(fakeServer, "test-deferred-frame");
    fakeServer.tool("runUntilPC", "desc", {}, async () => ({
      content: [{ type: "text", text: "{}" }],
      _observerFrameProvider: () => { providerCalled = true; return { kind: "image", mimeType: "image/png", base64: "AAAA" }; },
    }));

    const res = await captured({}, {});
    // (a) stripped from the agent-visible result
    assert.equal(res._observerFrameProvider, undefined, "provider must be stripped from the agent result");
    // (b) NOT called synchronously — the expensive encode is off the agent's path
    assert.equal(providerCalled, false, "provider must not run on the tool's critical path");

    // (c) called asynchronously after the response went out
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.equal(providerCalled, true, "provider must run asynchronously after the response");

    // (d) a call_frame event carrying the image reached the observer bus
    const frameEv = got.find((e) => e.type === "call_frame");
    assert.ok(frameEv, "a call_frame observer event must be emitted");
    assert.equal(frameEv.images?.[0]?.base64, "AAAA", "the call_frame event must carry the image");
    assert.equal(frameEv.tool, "runUntilPC", "the call_frame event must name the source tool");
  } finally {
    observer.off("event", onEvent);
  }
});
