// jsgame host kind — romdev drives a JS web game (rungame's headless host session)
// through the same run/see/drive surface it uses for emulator cores, plus JS-heap
// introspection.
//
// THREE constraints, all handled here so this runs under a plain `npm test` (no skip, no
// global --test-force-exit):
//  1. rungame's realm needs --experimental-vm-modules → the forked child's execArgv carries
//     the flag (the main test process doesn't need it).
//  2. rungame loads @kmamal/sdl, which is main-thread-only → a forked CHILD PROCESS (not a
//     worker thread) has its own main thread, so SDL is happy.
//  3. rungame keeps module-global state + leaks handles (SDL/audio/timers) that would hold
//     the process open → the child owns all of it; we call it over rawr JSON-RPC (the fork
//     IPC channel) and kill the child when done, disposing those handles cleanly.

import { test } from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import rawr from "rawr";
import { parentTransport } from "./helpers/rawr-fork-transport.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GAME = path.join(HERE, "fixtures", "simple.jsgame");
const CHILD = path.join(HERE, "helpers", "jsgame-worker.js");

test("jsgame: load + capabilities + step + screenshot + input + JS introspection (in a child process)", async () => {
  // Fork the child WITH the vm-modules flag; talk to it over rawr JSON-RPC (fork IPC).
  const child = fork(CHILD, [], { execArgv: ["--experimental-vm-modules"], stdio: "inherit" });
  const peer = rawr({ transport: parentTransport(child) });

  let r;
  try {
    r = await peer.methods.runJsgame(GAME);
  } finally {
    child.kill("SIGKILL"); // dispose rungame's SDL/audio/timer handles
  }

  assert.equal(r.loaded, true);
  assert.equal(r.platform, "jsgame");
  assert.ok(r.fbWidth > 0 && r.fbHeight > 0, "reports a framebuffer size");
  // Regression (0.105.1): displayAspect must be a real ratio once frames run —
  // a 0 here zero-sized the playtest window ("invalid width").
  assert.ok(r.displayAspect > 0, "reports a real displayAspect, not the 0 init");
  assert.equal(r.displayAspect, r.fbWidth / r.fbHeight, "canvas pixels are square");

  // capabilities (native runtime: no emulator surface; JS introspection instead)
  assert.equal(r.caps.kind, "jsgame");
  assert.equal(r.caps.canStepFrames, true);
  assert.equal(r.caps.canScreenshot, true);
  assert.equal(r.caps.canSetInput, true);
  assert.equal(r.caps.hasMemoryRegions, false);
  assert.equal(r.caps.hasCpuState, false);
  assert.equal(r.caps.hasCheats, false);
  assert.equal(r.caps.hasJsIntrospection, true);

  // step + non-blank screenshot (asset loads settled in loadMedia)
  assert.equal(r.stepped, 10);
  assert.ok(r.frameCount >= 11);
  assert.ok(r.pngLen > 0, "produces a PNG");
  assert.ok(r.shotW > 0 && r.shotH > 0);
  assert.ok(r.maxPixel > 0, "framebuffer has rendered content");

  // JS introspection (the V8 bonus): rungame exposes _jsg = {controllers, …}
  assert.ok(Array.isArray(r.globals) && r.globals.length > 0, "exposes the game's _jsg globals bag");
});
