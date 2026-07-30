// input({op:'set'}) must never silently not-press.
//
// History, because this got fixed twice. Originally zod STRIPPED unknown keys,
// so {jump:true} resolved to nothing and the agent believed it pressed
// something it didn't. That was fixed by reporting unknown names in
// `ignoredButtons` — but the check only fired on keys whose value was literally
// `true`, so a wrong SHAPE ({port:0, buttons:['a','b']}) still slipped through
// and came back {inputSet:true, requested:[[]]}: accepted, nothing pressed.
//
// Now a malformed port object is REJECTED rather than partially applied. The
// reason to be strict here rather than lenient: a press that silently doesn't
// happen poisons NEGATIVE results downstream — a button-gated branch that
// "never fires" when the button was never held reads as a finding about the
// game, and that is the most expensive wrong answer this tool can produce.

import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { registerInputTools } from "../src/mcp/tools/input.js";
import { _setHostForTest } from "../src/mcp/state.js";

function getInputHandler(sessionKey) {
  let handler;
  const fakeServer = {
    tool(name, _desc, _schema, h) { if (name === "input") handler = h; },
  };
  registerInputTools(fakeServer, z, sessionKey);
  return handler;
}

function parseResult(res) {
  assert.equal(res.isError, undefined, "unexpected isError: " + JSON.stringify(res));
  return JSON.parse(res.content.find((c) => c.type === "text").text);
}

// The `input` router wraps a throwing core in safeTool, so a rejection surfaces
// as {isError:true} with the message as text -- not as a rejected promise.
function expectRejected(res) {
  assert.equal(res.isError, true, "expected isError, got: " + JSON.stringify(res));
  return res.content.find((c) => c.type === "text").text;
}

// Records what actually reached the host, so "rejected" can be distinguished
// from "accepted but pressed nothing" — the whole point of the fix.
function fakeHost() {
  const calls = [];
  return {
    status: { platform: "nes", loaded: true },
    setInput(arg) { calls.push(arg); },
    stepFrames() { return 1; },
    _calls: calls,
  };
}

test("a typo'd button name is rejected, not silently dropped", async () => {
  const key = "input-reject-typo";
  const host = fakeHost();
  _setHostForTest(key, host);
  const handler = getInputHandler(key);
  const msg = expectRejected(await handler({ op: "set", ports: [{ right: true, jump: true }] }));
  assert.match(msg, /unknown button 'jump'/i);
  assert.equal(host._calls.length, 0, "nothing reached the host");
});

test("the reported {port, buttons:[...]} shape is rejected with shape-specific help", async () => {
  const key = "input-reject-shape";
  const host = fakeHost();
  _setHostForTest(key, host);
  const handler = getInputHandler(key);
  // The exact payload from the field report. Before the fix this returned
  // {inputSet:true, requested:[[],[]]} and pressed nothing.
  const msg = expectRejected(await handler({ op: "set", ports: [{ port: 0, buttons: ["a", "b"] }] }));
  // Both mistakes named, each with the fix, rather than a generic "unknown key"
  // that leaves the caller guessing which part was wrong.
  assert.match(msg, /'buttons' is not a valid key/i);
  assert.match(msg, /\{a:true, b:true\}/);
  assert.match(msg, /'port' is not a button/i);
  assert.match(msg, /positional/i);
  assert.equal(host._calls.length, 0, "nothing reached the host");
});

test("a known button with a non-boolean value is rejected", async () => {
  const key = "input-reject-nonbool";
  const host = fakeHost();
  _setHostForTest(key, host);
  const handler = getInputHandler(key);
  const msg = expectRejected(await handler({ op: "set", ports: [{ a: ["x"] }] }));
  assert.match(msg, /button 'a' must be true or false, got an array/i);
  assert.equal(host._calls.length, 0, "nothing reached the host");
});

test("valid buttons still pass through and are echoed in requested", async () => {
  const key = "input-accept-clean";
  const host = fakeHost();
  _setHostForTest(key, host);
  const handler = getInputHandler(key);
  const res = parseResult(await handler({ op: "set", ports: [{ a: true, right: true }] }));
  assert.equal(res.inputSet, true);
  assert.deepEqual(res.requested[0].sort(), ["a", "right"]);
  assert.equal(host._calls.length, 1, "reached the host exactly once");
});

// Ports are positional, so holding a button on port 1 means an empty object at
// index 0 -- the shape the rejected {port:1, ...} was reaching for.
test("port 1 is addressed by position, and false is a legal value", async () => {
  const key = "input-accept-port1";
  const host = fakeHost();
  _setHostForTest(key, host);
  const handler = getInputHandler(key);
  const res = parseResult(await handler({ op: "set", ports: [{}, { a: true, b: false }] }));
  assert.deepEqual(res.requested[0], []);
  assert.deepEqual(res.requested[1], ["a"], "b:false is accepted but not counted as pressed");
  assert.equal(host._calls.length, 1);
});
