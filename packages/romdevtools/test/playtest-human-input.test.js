// Human co-drive detection — the "they get confused when I try to play while
// they're coding" fix.
//
// A human playing in the playtest window shares the session's ONE LibretroHost
// with the agent: while they press, the window's tick overwrites the agent's
// setInput, and its real-time stepping races the agent's frame-stepping. The
// agent previously had NO signal a human was co-driving. Now:
//   1. the window tracks "last tick the human actually pressed something"
//      (createHumanInputTracker — pure, tested here),
//   2. catalog({op:'status'}) / playtest({op:'status'}) expose
//      playtestWindowOpen + humanInputActive,
//   3. frame({op:'step'}) and input(set/press/...) responses carry
//      humanCoDriveWarning while the human pressed within the active window.
// Also: the window now writes setInput ONLY while the human is pressing (plus
// one release write) instead of clobbering with all-zeros every tick — that
// contract lives in the tick loop; the tracker + surfacing are covered here.

import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";

import {
  anyButtonHeld,
  createHumanInputTracker,
  HUMAN_INPUT_ACTIVE_FRAMES,
} from "../src/playtest/playtest.js";
import {
  __setSessionForTest,
  getPlaytestHumanStatus,
  humanCoDriveWarning,
} from "../src/mcp/tools/playtest.js";
import { registerFrameTools } from "../src/mcp/tools/frame.js";
import { registerInputTools } from "../src/mcp/tools/input.js";
import { _setHostForTest } from "../src/mcp/state.js";

// ---- pure helpers ----

test("anyButtonHeld: empty/false-only ports are not held; any truthy key is", () => {
  assert.equal(anyButtonHeld({}), false);
  assert.equal(anyButtonHeld({ a: false, up: false }), false);
  assert.equal(anyButtonHeld({ a: true }), true);
  assert.equal(anyButtonHeld({ c64_f1: true }), true, "C64 virtual keys count as presses");
});

test("tracker: never-pressed → framesSince null, inactive", () => {
  const t = createHumanInputTracker();
  assert.equal(t.framesSince(1000), null);
  assert.equal(t.active(1000), false);
});

test("tracker: a press is active until the window elapses, then expires", () => {
  const t = createHumanInputTracker();
  t.note(true, 100);
  assert.equal(t.framesSince(100), 0);
  assert.equal(t.active(100 + HUMAN_INPUT_ACTIVE_FRAMES), true, "edge of the window is still active");
  assert.equal(t.active(101 + HUMAN_INPUT_ACTIVE_FRAMES), false, "one past the window is idle");
  assert.equal(t.framesSince(150), 50);
});

test("tracker: note(false) does not refresh activity", () => {
  const t = createHumanInputTracker(10);
  t.note(true, 5);
  t.note(false, 14);
  assert.equal(t.active(14), true);
  t.note(false, 16);
  assert.equal(t.active(16), false, "idle ticks must not extend the active window");
});

// ---- session-status surfacing ----

function fakeWindowSession({ active, framesSince }) {
  return {
    running: true,
    windowAlive: () => true,
    humanInputActive: () => active,
    framesSinceHumanInput: () => framesSince,
    stop() {},
  };
}

test("getPlaytestHumanStatus: no window → all inactive", () => {
  const st = getPlaytestHumanStatus("human-status-none");
  assert.deepEqual(st, { windowOpen: false, humanInputActive: false, framesSinceHumanInput: null });
});

test("getPlaytestHumanStatus: open window reports the handle's activity", () => {
  const key = "human-status-active";
  __setSessionForTest(key, fakeWindowSession({ active: true, framesSince: 30 }));
  try {
    const st = getPlaytestHumanStatus(key);
    assert.deepEqual(st, { windowOpen: true, humanInputActive: true, framesSinceHumanInput: 30 });
  } finally {
    __setSessionForTest(key, null);
  }
});

test("getPlaytestHumanStatus: legacy handle without the probes → open but inactive", () => {
  const key = "human-status-legacy";
  __setSessionForTest(key, { running: true, windowAlive: () => true, stop() {} });
  try {
    const st = getPlaytestHumanStatus(key);
    assert.equal(st.windowOpen, true);
    assert.equal(st.humanInputActive, false);
    assert.equal(st.framesSinceHumanInput, null);
  } finally {
    __setSessionForTest(key, null);
  }
});

test("humanCoDriveWarning: null without conflict, actionable text with one", () => {
  assert.equal(humanCoDriveWarning("human-warn-none"), null);
  const key = "human-warn-active";
  __setSessionForTest(key, fakeWindowSession({ active: true, framesSince: 12 }));
  try {
    const w = humanCoDriveWarning(key);
    assert.match(w, /HUMAN/i);
    assert.match(w, /pause/i, "must point at host pause as an escape hatch");
    assert.match(w, /x-romdev-session/i, "must point at the second-session escape hatch");
  } finally {
    __setSessionForTest(key, null);
  }
  // Window open but human idle → no warning (don't cry wolf on a watched-only window).
  const idleKey = "human-warn-idle";
  __setSessionForTest(idleKey, fakeWindowSession({ active: false, framesSince: 900 }));
  try {
    assert.equal(humanCoDriveWarning(idleKey), null);
  } finally {
    __setSessionForTest(idleKey, null);
  }
});

// ---- tool responses ----

function captureHandler(registerFn, toolName, sessionKey) {
  let handler;
  const fakeServer = {
    tool(name, _desc, _schema, h) { if (name === toolName) handler = h; },
  };
  registerFn(fakeServer, z, sessionKey);
  return handler;
}

function parseResult(res) {
  return JSON.parse(res.content.find((c) => c.type === "text").text);
}

function fakeHost() {
  return {
    status: { platform: "nes", loaded: true, frameCount: 0, fbWidth: 256, fbHeight: 240 },
    setInput() {},
    stepFrames(n = 1) { this.status.frameCount += n; return n; },
    framebufferHash() { return String(this.status.frameCount); },
  };
}

test("frame step carries humanCoDriveWarning only while the human is active", async () => {
  const key = "human-frame-step";
  _setHostForTest(key, fakeHost());
  const handler = captureHandler(registerFrameTools, "frame", key);

  // No window → no warning field.
  let res = parseResult(await handler({ op: "step", frames: 5 }));
  assert.equal(res.framesRun, 5);
  assert.equal(res.humanCoDriveWarning, undefined);

  // Human actively playing → warning attached.
  __setSessionForTest(key, fakeWindowSession({ active: true, framesSince: 8 }));
  try {
    res = parseResult(await handler({ op: "step", frames: 5 }));
    assert.match(res.humanCoDriveWarning, /co-driving/i);
  } finally {
    __setSessionForTest(key, null);
  }
});

test("input set/press carry humanCoDriveWarning while the human is active", async () => {
  const key = "human-input-set";
  _setHostForTest(key, fakeHost());
  const handler = captureHandler(registerInputTools, "input", key);

  let res = parseResult(await handler({ op: "set", ports: [{ right: true }] }));
  assert.equal(res.humanCoDriveWarning, undefined, "no window → no warning");

  __setSessionForTest(key, fakeWindowSession({ active: true, framesSince: 3 }));
  try {
    res = parseResult(await handler({ op: "set", ports: [{ right: true }] }));
    assert.equal(res.inputSet, true);
    assert.match(res.humanCoDriveWarning, /overwrites yours/i);

    res = parseResult(await handler({ op: "press", button: "a" }));
    assert.match(res.humanCoDriveWarning, /co-driving/i);
  } finally {
    __setSessionForTest(key, null);
  }
});
