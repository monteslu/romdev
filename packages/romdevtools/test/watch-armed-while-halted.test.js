// watch({on:'mem'}) armed while the CPU sits at an un-cleared breakpoint hit.
//
// The failure mode is nasty because it is INDISTINGUISHABLE from a real finding.
// A reported session armed a watch after a pc-break had already hit, got 0
// events, and 0 events was exactly what the hypothesis predicted -- so it
// briefly looked like confirmation. It wasn't: the routine had already run
// inside the broken frame, before the watch existed. It cost a full wasted run
// and a wrong preliminary conclusion, and was only caught because the result was
// suspiciously clean.
//
// "Nothing writes X" is load-bearing evidence in RE, so an empty window has to
// carry its own caveat. on:'range' already flagged this; on:'mem' -- the power
// tool, and the one that was actually misread -- did not.

import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { registerWatchMemoryTools } from "../src/mcp/tools/watch-memory.js";
import { _setHostForTest } from "../src/mcp/state.js";

function getWatchHandler(sessionKey) {
  let handler;
  registerWatchMemoryTools({ tool(name, _d, _s, h) { if (name === "watch") handler = h; } }, z, sessionKey);
  return handler;
}

function parseResult(res) {
  assert.equal(res.isError, undefined, "unexpected isError: " + JSON.stringify(res));
  return JSON.parse(res.content.find((c) => c.type === "text").text);
}

/**
 * @param {object} opts
 * @param {boolean} opts.halted   a pc-break exists AND has hit (un-cleared)
 * @param {boolean} [opts.moves]  whether the watched byte changes each frame
 */
function fakeHost({ halted, moves = false }) {
  const ram = new Uint8Array(256);
  let frame = 0;
  return {
    status: { platform: "nes", loaded: true, paused: false, frameCount: 0 },
    pcBreakSupported() { return true; },
    getPCBreak() { return { enabled: halted, hit: halted, address: 0xD2E4 }; },
    stepFrames(n = 1) {
      for (let i = 0; i < n; i++) { frame++; if (moves) ram[0x30] = frame & 0xff; }
      this.status.frameCount = frame;
      return frame;
    },
    readMemory(_region, offset, length) { return ram.slice(offset, offset + length); },
    getCPUState() { return { pc: 0xC000 }; },
    setInput() {},
    renderOneFrame() {},
  };
}

test("an empty window armed while halted is flagged, not reported as a clean negative", async () => {
  const key = "watch-halted-empty";
  _setHostForTest(key, fakeHost({ halted: true, moves: false }));
  const handler = getWatchHandler(key);
  const r = parseResult(await handler({
    on: "mem", region: "system_ram", offset: 0x30, length: 1, frames: 8,
  }));

  assert.equal(r.eventCount, 0, "the quiet result that reads as a finding");
  assert.equal(r.armedWhileHalted, true, "the caveat is present");
  assert.match(r.armedWhileHaltedNote, /NOT a clean negative/i);
  assert.match(r.armedWhileHaltedNote, /D2E4/, "names the breakpoint it was halted at");
  // The note the caller actually reads first must not let a zero stand alone.
  assert.match(r.note, /does NOT establish that nothing writes/i);
});

test("a NON-empty window armed while halted is called a lower bound", async () => {
  const key = "watch-halted-partial";
  _setHostForTest(key, fakeHost({ halted: true, moves: true }));
  const handler = getWatchHandler(key);
  const r = parseResult(await handler({
    on: "mem", region: "system_ram", offset: 0x30, length: 1, frames: 8,
  }));

  assert.ok(r.eventCount > 0);
  assert.equal(r.armedWhileHalted, true);
  // A partial count from a ragged window is just as misleading as a zero.
  assert.match(r.note, /LOWER BOUND/i);
});

test("a watch armed with no breakpoint hit carries no caveat", async () => {
  const key = "watch-not-halted";
  _setHostForTest(key, fakeHost({ halted: false, moves: false }));
  const handler = getWatchHandler(key);
  const r = parseResult(await handler({
    on: "mem", region: "system_ram", offset: 0x30, length: 1, frames: 8,
  }));

  assert.equal(r.eventCount, 0);
  assert.equal(r.armedWhileHalted, undefined, "no false alarm on a genuine negative");
  assert.equal(r.armedWhileHaltedNote, undefined);
  // The standing empty-window guidance still applies.
  assert.match(r.note, /No matching changes/);
});

test("a core with no pc-break surface is not flagged", async () => {
  const key = "watch-no-bp-surface";
  const host = fakeHost({ halted: false });
  host.pcBreakSupported = () => false;
  _setHostForTest(key, host);
  const handler = getWatchHandler(key);
  const r = parseResult(await handler({
    on: "mem", region: "system_ram", offset: 0x30, length: 1, frames: 4,
  }));
  assert.equal(r.armedWhileHalted, undefined);
});
