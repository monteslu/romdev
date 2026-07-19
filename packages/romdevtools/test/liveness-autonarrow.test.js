// 0.102.0: state-load liveness probe + range-census autoNarrow. Pure JS.

import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { registerWatchMemoryTools } from "../src/mcp/tools/watch-memory.js";
import { registerStateTools } from "../src/mcp/tools/state.js";
import { _setHostForTest } from "../src/mcp/state.js";

function parseResult(res) {
  return JSON.parse(res.content.find((c) => c.type === "text").text);
}

// ── liveness ───────────────────────────────────────────────────────────────

function makeStateHost({ frozen }) {
  let fbHash = 100;
  const host = {
    status: { frameCount: 0, platform: "nes", paused: false },
    namedBlobs: {},
    saveState() {}, listStates: () => [],
    loadState(_name) { return 0; },
    unserializeState(_blob) { return 0; },
    framebufferHash: () => fbHash,
    renderOneFrame() {},
    stepFrames(n) {
      if (!frozen) fbHash += n;
      host.status.frameCount += n;
      return n;
    },
    readMemory: () => new Uint8Array(4),
    mod: {}, // getCPUState probes host.mod — give it something inert
  };
  // getCPUState(host) will throw on this fake (no real core) — the probe treats
  // that as pc:null and falls back to framebuffer change, which is what we test.
  return host;
}

function getStateHandler() {
  let handler;
  const fakeServer = { tool(name, _d, _s, h) { if (name === "state") handler = h; } };
  registerStateTools(fakeServer, z, "liveness-test");
  return (args) => handler(args);
}

test("live state: probe reports alive via framebuffer change and re-restores", async () => {
  const host = makeStateHost({ frozen: false });
  _setHostForTest("liveness-test", host);
  const res = parseResult(await getStateHandler()({ op: "load", name: "slot" }));
  assert.equal(res.loaded, true);
  assert.equal(res.liveness.alive, true);
  assert.equal(res.liveness.framebufferChanged, true);
  assert.equal(res.liveness.note, undefined);
});

test("frozen state: probe flags it with the re-save guidance", async () => {
  const host = makeStateHost({ frozen: true });
  _setHostForTest("liveness-test", host);
  const res = parseResult(await getStateHandler()({ op: "load", name: "slot" }));
  assert.equal(res.liveness.alive, false);
  assert.match(res.liveness.note, /FROZEN/);
  assert.match(res.liveness.note, /re-save/);
});

test("probeLiveness:false skips the probe entirely", async () => {
  const host = makeStateHost({ frozen: true });
  let stepped = 0;
  const origStep = host.stepFrames;
  host.stepFrames = (n) => { stepped += n; return origStep(n); };
  _setHostForTest("liveness-test", host);
  const res = parseResult(await getStateHandler()({ op: "load", name: "slot", probeLiveness: false }));
  assert.equal(res.liveness, undefined);
  assert.equal(stepped, 0); // render uses renderOneFrame, not stepFrames — no probe frames ran
});

// ── autoNarrow ─────────────────────────────────────────────────────────────

function makeNarrowHost({ fitsAt }) {
  const calls = [];
  return {
    calls,
    status: { frameCount: 0, platform: "nes" },
    rangeWatchSupported: () => true,
    watchRange(_s, _e, _k, frames) {
      calls.push(frames);
      const truncated = frames > fitsAt;
      return { events: [{ pc: 0xC100, address: 0x40, value: 1 }], total: 1, truncated };
    },
    loadState() { return 0; },
    getCartRom: () => ({ raw: null }),
    readMemory: () => new Uint8Array(4),
    stepFrames: () => 0,
    setInput: () => {},
  };
}

function getWatchHandler() {
  let handler;
  const fakeServer = { tool(name, _d, _s, h) { if (name === "watch") handler = h; } };
  registerWatchMemoryTools(fakeServer, z, "narrow-test");
  return (args) => handler(args);
}

test("autoNarrow halves frames from the state anchor until the run fits", async () => {
  const host = makeNarrowHost({ fitsAt: 30 });
  _setHostForTest("narrow-test", host);
  const res = parseResult(await getWatchHandler()({
    on: "range", start: 0x40, end: 0x40, kind: "write", frames: 240,
    distinctPCsOnly: true, autoNarrow: true, fromState: "anchor",
  }));
  assert.deepEqual(host.calls, [240, 120, 60, 30]);
  assert.equal(res.truncated, false);
  assert.deepEqual(res.autoNarrowed, { attempts: 3, framesRequested: 240, framesUsed: 30, complete: true });
  assert.equal(res.frames, 30);
});

test("autoNarrow without a state anchor refuses to pretend", async () => {
  const host = makeNarrowHost({ fitsAt: 30 });
  _setHostForTest("narrow-test", host);
  const res = parseResult(await getWatchHandler()({
    on: "range", start: 0x40, end: 0x40, kind: "write", frames: 240,
    distinctPCsOnly: true, autoNarrow: true,
  }));
  assert.deepEqual(host.calls, [240]);      // single attempt, no drifting re-runs
  assert.equal(res.truncated, true);
  assert.match(res.autoNarrowNote, /fromState/);
});

test("no autoNarrow: truncated result unchanged", async () => {
  const host = makeNarrowHost({ fitsAt: 30 });
  _setHostForTest("narrow-test", host);
  const res = parseResult(await getWatchHandler()({
    on: "range", start: 0x40, end: 0x40, kind: "write", frames: 240, distinctPCsOnly: true,
  }));
  assert.deepEqual(host.calls, [240]);
  assert.equal(res.truncated, true);
  assert.equal(res.autoNarrowed, undefined);
});
