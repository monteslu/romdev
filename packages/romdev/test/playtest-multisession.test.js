// The MCP server is multi-session: one server serves several agents, and a user
// can have 2-3 games open at once. Playtest windows must be keyed per session —
// one agent's window must never clobber another's, closing one session closes
// only its own window, and a full shutdown closes them all. These exercise the
// per-session registry via fake session handles (no real SDL window).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  stopPlaytestForSession,
  stopAllPlaytest,
  isPlaytestRunning,
  __setSessionForTest,
} from "../src/mcp/tools/playtest.js";

// Fake session handle: alive + records whether stop() was called.
function fakeSession() {
  return { running: true, stopped: false, windowAlive() { return !this.stopped; }, stop() { this.stopped = true; } };
}

test("stopPlaytestForSession on an unknown session is a no-op (returns false)", () => {
  assert.equal(stopPlaytestForSession("nobody"), false);
});

test("isPlaytestRunning is false for a session with no window", () => {
  assert.equal(isPlaytestRunning("nobody"), false);
});

test("stopAllPlaytest with no windows returns 0", () => {
  assert.equal(stopAllPlaytest(), 0);
});

test("closing one session's window does NOT touch another session's", () => {
  const a = fakeSession(), b = fakeSession();
  __setSessionForTest("agentA", a);
  __setSessionForTest("agentB", b);
  assert.equal(isPlaytestRunning("agentA"), true);
  assert.equal(isPlaytestRunning("agentB"), true);

  assert.equal(stopPlaytestForSession("agentA"), true);
  assert.equal(a.stopped, true, "A's window closed");
  assert.equal(b.stopped, false, "B's window UNTOUCHED");
  assert.equal(isPlaytestRunning("agentA"), false);
  assert.equal(isPlaytestRunning("agentB"), true, "B still running");

  __setSessionForTest("agentB", null); // cleanup
});

test("stopAllPlaytest closes every session's window and reports the count", () => {
  const a = fakeSession(), b = fakeSession(), c = fakeSession();
  __setSessionForTest("a", a);
  __setSessionForTest("b", b);
  __setSessionForTest("c", c);
  const n = stopAllPlaytest();
  assert.equal(n, 3);
  assert.ok(a.stopped && b.stopped && c.stopped, "all three closed");
  assert.equal(isPlaytestRunning("a"), false);
});

test("a dead window (probe false) auto-reaps and reports not-running", () => {
  const dead = { running: true, stop() {}, windowAlive() { return false; } };
  __setSessionForTest("zombie", dead);
  assert.equal(isPlaytestRunning("zombie"), false, "reconcile drops a dead window");
  assert.equal(isPlaytestRunning("zombie"), false);
});
