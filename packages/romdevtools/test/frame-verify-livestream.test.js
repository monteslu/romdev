// frame({op:'verify'}) must push the frame it judged to the human's /livestream
// — verify's entire job is "look at the screen," so the watcher should SEE that
// screen, not just the JSON verdict. The mechanism: doVerify attaches a deferred
// `_observerFrameProvider`; the observer middleware strips it from the agent
// result and, after the response goes out, rasterizes it into a `call_frame`
// image event on the bus. This drives the REAL registered `frame` handler through
// the REAL observer middleware (the shipped path) and asserts both halves:
//   1. the agent-visible result carries NO image and NO leaked provider sideband
//   2. a `call_frame` event with a PNG image lands on the observer bus
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { buildProjectCore } from "../src/mcp/tools/toolchain.js";
import { createProjectImpl } from "../src/mcp/tools/project.js";
import { resolveCore } from "../src/cores/registry.js";
import { resetHost, clearHost } from "../src/mcp/state.js";
import { registerFrameTools } from "../src/mcp/tools/frame.js";
import { installObserverMiddleware } from "../src/observer/tool-wrap.js";
import { observer } from "../src/observer/bus.js";
import { z } from "zod";

const parse = (r) => JSON.parse(r.content[0].text);

// Wait for the next bus event matching a predicate (the call_frame is emitted on
// setImmediate AFTER the handler resolves, so we listen rather than poll).
function waitForEvent(pred, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { observer.off("event", on); reject(new Error("timed out waiting for observer event")); }, timeoutMs);
    function on(ev) { if (pred(ev)) { clearTimeout(t); observer.off("event", on); resolve(ev); } }
    observer.on("event", on);
  });
}

test("frame({op:'verify'}) emits the judged frame to the livestream as a call_frame image", { timeout: 180000 }, async () => {
  const key = "verify-livestream-nes";
  const dir = await mkdtemp(path.join(tmpdir(), "verify-ls-"));
  try {
    // Scaffold + build the NES default, then load it.
    const proj = path.join(dir, "nes-default");
    await createProjectImpl({ platform: "nes", name: "nes-default", path: proj, template: "default", overwrite: true });
    const romPath = path.join(dir, "rom.nes");
    const build = parse(await buildProjectCore({ path: proj, platform: "nes", outputPath: romPath }));
    assert.equal(build.ok, true, `nes build failed: ${(build.logTail || "").slice(-300)}`);
    const core = resolveCore("nes");
    const host = resetHost(key);
    await host.loadCore(core.jsPath, core.wasmPath);
    const bin = new Uint8Array(await readFile(romPath));
    await host.loadMedia({ platform: "nes", bytes: bin, virtualName: "/rom.nes" });

    // Register the frame tool on a fake server WITH the observer middleware,
    // exactly as production wires it.
    const tools = {};
    const fakeServer = { tool: (name, _desc, _schema, handler) => { tools[name] = handler; } };
    installObserverMiddleware(fakeServer, key);
    registerFrameTools(fakeServer, z, key);
    assert.ok(typeof tools.frame === "function", "frame tool registered");

    // Start listening for the deferred call_frame BEFORE invoking.
    const framePromise = waitForEvent((ev) => ev.type === "call_frame" && ev.tool === "frame" && ev.sessionKey === key);

    // Call verify (steps frames + judges). The agent-visible result is JSON only.
    const res = await tools.frame({ op: "verify", frames: 120 });
    const verdict = parse(res);
    assert.ok("verified" in verdict, "verify returned a verdict");

    // 1. Agent result must NOT leak the provider or carry an inline image.
    assert.equal(res._observerFrameProvider, undefined, "provider stripped from agent result");
    assert.ok(!Array.isArray(res.content?.filter?.((c) => c.type === "image"))?.length,
      "verify result is JSON-only for the agent (no inline image)");

    // 2. The deferred frame must reach the bus as a PNG image.
    const frameEv = await framePromise;
    assert.ok(Array.isArray(frameEv.images) && frameEv.images.length === 1, "one image on the call_frame event");
    const img = frameEv.images[0];
    assert.equal(img.mimeType, "image/png");
    assert.ok(typeof img.base64 === "string" && img.base64.length > 100, "non-trivial PNG payload");
    // PNG magic bytes (\x89PNG) base64-encode to a prefix of "iVBOR".
    assert.ok(img.base64.startsWith("iVBOR"), "payload is a real PNG");
  } finally {
    clearHost(key);
    await rm(dir, { recursive: true, force: true });
  }
});
