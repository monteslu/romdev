// host({op:'shutdown'}) ends the SESSION, not just the emulator.
//
// The gap this pins: a suite that opened ~53 HTTP sessions per run and
// dutifully called shutdown on every one still left each session's ~20 MB
// tool registry (measured: 50 registries = 1 GB) and its livestream entry
// alive for the 30-minute idle reaper. The cleanup API existed at the
// emulator layer and not at the session layer, so a well-behaved agent
// COULD NOT clean up -- and the livestream showed dozens of ghosts after
// every green run.

import { test } from "node:test";
import assert from "node:assert/strict";

import { onSessionEnd, emitSessionEnd } from "../src/mcp/session-events.js";

test("emitSessionEnd reaches every listener with the key", () => {
  const seen = [];
  const off1 = onSessionEnd((k) => seen.push(["a", k]));
  const off2 = onSessionEnd((k) => seen.push(["b", k]));

  emitSessionEnd("sess-1");

  assert.deepEqual(seen, [["a", "sess-1"], ["b", "sess-1"]]);
  off1(); off2();
});

test("a throwing listener does not stop the rest -- teardown must never cascade", () => {
  const seen = [];
  const off1 = onSessionEnd(() => { throw new Error("bad listener"); });
  const off2 = onSessionEnd((k) => seen.push(k));

  emitSessionEnd("sess-2");

  assert.deepEqual(seen, ["sess-2"], "the second listener still ran");
  off1(); off2();
});

test("unsubscribe works", () => {
  const seen = [];
  const off = onSessionEnd((k) => seen.push(k));
  off();
  emitSessionEnd("sess-3");
  assert.deepEqual(seen, []);
});

test("the shutdown tool emits session-end for the primary slot and NOT for slot B", async () => {
  // Slot B shutdown releases the comparison core only -- the session is very
  // much still in use (it is mid-comparison). Ending it would tear down the
  // primary host under the caller.
  const { registerLifecycleTools } = await import("../src/mcp/tools/lifecycle.js");
  const { installHost, clearHost } = await import("../src/mcp/state.js");
  const { z } = await import("zod");

  const tools = {};
  const capture = {
    connect() {},
    tool(name, ...rest) { tools[name] = rest.find((x) => typeof x === "function"); },
  };
  const KEY = "session-end-shutdown-test";
  registerLifecycleTools(capture, z, KEY);

  const ended = [];
  const off = onSessionEnd((k) => ended.push(k));

  installHost(KEY, { status: { loaded: true }, dispose() {} });
  await tools.host({ op: "shutdown" });
  assert.deepEqual(ended, [KEY], "primary shutdown announces the session end");

  ended.length = 0;
  installHost(KEY, { status: { loaded: true }, dispose() {} });
  await tools.host({ op: "shutdown", slot: "b" });
  assert.deepEqual(ended, [], "slot B shutdown is not a session end");

  off();
  clearHost(KEY);
});
