// Transparency fix: input({op:'set'}) used to SILENTLY DROP a typo'd button
// name (zod strips unknown keys), so {jump:true} resolved to nothing and the
// agent believed it pressed something it didn't. Now the handler reports any
// unknown button in `ignoredButtons` and never counts it in `requested`.

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
  return JSON.parse(res.content.find((c) => c.type === "text").text);
}

function fakeHost() {
  return { status: { platform: "nes", loaded: true }, setInput() {}, stepFrames() { return 1; } };
}

test("input set reports a typo'd button in ignoredButtons and omits it from requested", async () => {
  const key = "input-ignored-test";
  _setHostForTest(key, fakeHost());
  const handler = getInputHandler(key);
  const res = parseResult(await handler({ op: "set", ports: [{ right: true, jump: true }] }));
  assert.equal(res.inputSet, true);
  // 'right' is real and counted; 'jump' is a typo and NOT counted.
  assert.deepEqual(res.requested[0], ["right"]);
  assert.ok(res.ignoredButtons, "ignoredButtons present");
  assert.deepEqual(res.ignoredButtons, [{ port: 0, name: "jump" }]);
  assert.match(res.ignoredNote, /unknown button/i);
});

test("input set with only valid buttons has no ignoredButtons field", async () => {
  const key = "input-ignored-test-clean";
  _setHostForTest(key, fakeHost());
  const handler = getInputHandler(key);
  const res = parseResult(await handler({ op: "set", ports: [{ a: true, right: true }] }));
  assert.equal(res.inputSet, true);
  assert.equal(res.ignoredButtons, undefined, "no ignoredButtons when all keys are valid");
  assert.deepEqual(res.requested[0].sort(), ["a", "right"]);
});
