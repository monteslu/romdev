// host({op:'play'}): a session runs in real time on the server from one call,
// and stops on time, on host({op:'stop'}), on any other call on the session, or
// when its host goes away. Driven with a fake host so no core or GPU is needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { installHost, clearHost } from "../src/mcp/state.js";
import { startPlay, stopPlay, playStatus, noteToolCall } from "../src/mcp/autoplay.js";
import { runTool } from "../src/http/tool-registry.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fakeHost() {
  return {
    stepped: 0,
    status: { loaded: true, coreFps: 60, frameCount: 0, fbWidth: 0, fbHeight: 0 },
    stepFrames(n) { this.stepped += n; this.status.frameCount += n; return n; },
  };
}

test("play steps at about the core's frame rate and ends on time", async () => {
  const key = "autoplay-time";
  const host = fakeHost();
  installHost(key, host);
  try {
    startPlay(key, host, { seconds: 0.5 });
    assert.equal(playStatus(key).playing, true);
    await sleep(700);
    assert.equal(playStatus(key), null, "the run ended by itself");
    // 0.5 s at 60 fps = 30 frames; allow timer slop either way.
    assert.ok(host.stepped >= 20 && host.stepped <= 36, `stepped ${host.stepped} frames`);
  } finally {
    stopPlay(key); clearHost(key);
  }
});

test("any other call on the session stops play; host play/stop and catalog do not", async () => {
  const key = "autoplay-call";
  const host = fakeHost();
  installHost(key, host);
  try {
    startPlay(key, host, { seconds: 30 });
    noteToolCall(key, "catalog", { op: "status" });
    noteToolCall(key, "host", { op: "play" });
    noteToolCall("some-other-session", "frame", { op: "step" });
    assert.ok(playStatus(key), "still playing");
    noteToolCall(key, "frame", { op: "step" });
    assert.equal(playStatus(key), null, "a step on the same session ended it");
  } finally {
    stopPlay(key); clearHost(key);
  }
});

test("stopPlay reports frames; a cleared host ends the run", async () => {
  const key = "autoplay-stop";
  const host = fakeHost();
  installHost(key, host);
  try {
    startPlay(key, host, { seconds: 30 });
    await sleep(120);
    const r = stopPlay(key, "stop");
    assert.equal(r.endedBy, "stop");
    assert.ok(r.framesRun > 0);
    assert.equal(stopPlay(key), null, "nothing left to stop");

    startPlay(key, host, { seconds: 30 });
    clearHost(key);
    await sleep(120);
    assert.equal(playStatus(key), null, "the run noticed its host was gone");
  } finally {
    stopPlay(key); clearHost(key);
  }
});

test("the REST path stops play when the session calls another tool", async () => {
  const key = "autoplay-rest";
  const host = fakeHost();
  installHost(key, host);
  try {
    startPlay(key, host, { seconds: 30 });
    await runTool({ name: "frame", handler: async () => ({ content: [{ type: "text", text: "{}" }] }), inputSchema: null }, { op: "step" }, key);
    assert.equal(playStatus(key), null);
  } finally {
    stopPlay(key); clearHost(key);
  }
});
