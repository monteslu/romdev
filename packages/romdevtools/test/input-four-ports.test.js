// input({op:'set'}) takes four ports: a wasmcart cart reads four pads, and a
// 3- or 4-player cart's gates drive pads 2 and 3 through it. The schema capped
// `ports` at two, so any request naming a third pad was refused before it
// reached the host ("Too big: expected array to have <=2 items").

import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { registerInputTools } from "../src/mcp/tools/input.js";
import { _setHostForTest } from "../src/mcp/state.js";

function register(sessionKey) {
  let handler, schema;
  const fakeServer = {
    tool(name, _desc, s, h) { if (name === "input") { handler = h; schema = s; } },
  };
  registerInputTools(fakeServer, z, sessionKey);
  return { handler, schema: z.object(schema) };
}

test("op:'set' accepts four ports and hands every one to the host", async () => {
  const key = "input-four-ports";
  const calls = [];
  _setHostForTest(key, { status: { platform: "wasmcart", loaded: true }, setInput(a) { calls.push(a); }, stepFrames() { return 1; } });
  const { handler, schema } = register(key);
  const args = { op: "set", ports: [{ south: true }, { east: true }, { west: true }, { north: true, axes: { lx: 0.5 } }] };
  assert.equal(schema.safeParse(args).success, true, "four ports pass the schema");
  const res = await handler(schema.parse(args));
  assert.equal(res.isError, undefined, JSON.stringify(res));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].ports.length, 4);
  assert.deepEqual(calls[0].ports[3], { north: true, axes: { lx: 0.5 } });
});

test("op:'set' refuses a fifth port", () => {
  const { schema } = register("input-five-ports");
  assert.equal(schema.safeParse({ op: "set", ports: [{}, {}, {}, {}, { a: true }] }).success, false);
});
