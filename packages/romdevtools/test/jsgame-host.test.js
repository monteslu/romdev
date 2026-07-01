// jsgame host kind — romdev drives a JS web game (rungame's headless host session)
// through the same run/see/drive surface it uses for emulator cores, plus JS-heap
// introspection.
//
// TWO constraints shape this test:
//  1. Needs --experimental-vm-modules (rungame's realm uses vm.SourceTextModule). We
//     SKIP cleanly (not fail) when the flag is absent so the suite stays green; CI runs
//     it with the flag. The romdev SERVER self-re-execs with the flag.
//  2. rungame keeps MODULE-GLOBAL state (one canvas, one rAF slot, SDL/audio handles) —
//     it's one-session-per-process by design. So this is a SINGLE session exercising the
//     whole surface, rather than many tests each spinning a session (which would leak
//     handles + collide on the shared globals).

import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";

import { JsGameHost } from "../src/host/JsGameHost.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GAME = path.join(HERE, "fixtures", "simple.jsgame");
const VM_MODULES = typeof vm.SourceTextModule === "function";

test("jsgame: load + capabilities + step + screenshot + input + JS introspection", {
  skip: !VM_MODULES && "needs --experimental-vm-modules",
}, async () => {
  const host = new JsGameHost();

  // ── load ──
  const status = await host.loadMedia({ platform: "jsgame", path: GAME });
  assert.equal(status.loaded, true);
  assert.equal(status.platform, "jsgame");
  assert.ok(status.fbWidth > 0 && status.fbHeight > 0, "reports a framebuffer size");

  // ── capabilities (native runtime: no emulator surface; JS introspection instead) ──
  const caps = host.getCapabilities();
  assert.equal(caps.kind, "jsgame");
  assert.equal(caps.canStepFrames, true);
  assert.equal(caps.canScreenshot, true);
  assert.equal(caps.canSetInput, true);
  assert.equal(caps.hasMemoryRegions, false);
  assert.equal(caps.hasCpuState, false);
  assert.equal(caps.hasCheats, false);
  assert.equal(caps.hasJsIntrospection, true);

  // ── input drives the game ──
  host.setInput({ ports: [{ right: true, a: true }] });

  // ── step + non-blank screenshot (asset loads settled in loadMedia) ──
  const stepped = await host.stepFrames(10);
  assert.equal(stepped, 10);
  assert.ok(host.status.frameCount >= 11);

  const shot = host.screenshot();
  assert.ok(shot.pngBase64 && shot.pngBase64.length > 0, "produces a PNG");
  assert.ok(shot.width > 0 && shot.height > 0);

  const fb = host.getFramebuffer();
  let maxV = 0;
  for (let i = 0; i < fb.pixels.length; i += 397) if (fb.pixels[i] > maxV) maxV = fb.pixels[i];
  assert.ok(maxV > 0, "framebuffer has rendered content");

  // ── JS introspection (the V8 bonus) ──
  const globals = host.jsGlobals();
  assert.ok(Array.isArray(globals) && globals.length > 0, "exposes the game's _jsg globals bag");

  host.destroy();
});
