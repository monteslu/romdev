// fields and stopWhen on input({op:'sequence'}) and frame({op:'step'}): one
// request steps a range AND reads the debug fields a bot decides on, and a
// stop condition on a field ends the range the frame it is met. On a fake
// host (the exact frame the stop lands on, the shapes, the errors) and on
// wasmcart's test cart (values read through the cart's debug ABI, not the
// capped listing).
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { z } from "zod";
import { WasmcartHost } from "../src/host/WasmcartHost.js";
import { registerInputTools } from "../src/mcp/tools/input.js";
import { registerFrameTools } from "../src/mcp/tools/frame.js";
import { _setHostForTest, clearHost } from "../src/mcp/state.js";
import { parseStopWhen, stepUntil, readFields } from "../src/mcp/tools/step-fields.js";

const TESTCART = path.join(path.dirname(fileURLToPath(import.meta.resolve("wasmcart"))), "testcart", "testcart.wasc");

function tools(sessionKey) {
  const got = {};
  const server = { tool(name, _d, s, h) { got[name] = { handler: h, schema: z.object(s) }; } };
  registerInputTools(server, z, sessionKey);
  registerFrameTools(server, z, sessionKey);
  return async (name, args) => {
    const t = got[name];
    const parsed = t.schema.safeParse(args);
    if (!parsed.success) throw new Error(`${name} schema: ${parsed.error.message}`);
    const r = await t.handler(parsed.data);
    if (r.isError) throw new Error(r.content?.[0]?.text || "tool error");
    return JSON.parse(r.content.find((c) => c.type === "text").text);
  };
}

/** A host whose one field 'g.done' flips to 1 after `doneAt` frames, and 'g.pos' is an array counting frames. */
function fakeHost(doneAt) {
  const h = {
    kind: "fake", status: { platform: "wasmcart", loaded: true, frameCount: 0, fbWidth: 8, fbHeight: 8 },
    sets: [],
    setInput(a) { h.sets.push(a); },
    stepFrames(n) { h.status.frameCount += n; return n; },
    readDebugValue(name) {
      const f = h.status.frameCount;
      if (name === "g.done") return { name, type: "u8", value: f >= doneAt ? 1 : 0 };
      if (name === "g.pos") return { name, type: "i16", len: 2, values: [f, -f] };
      if (name === "g.name") return { name, type: "bytes", bytes: new Uint8Array([104, 105, 0, 0]) };
      throw new Error(`no debug field '${name}'`);
    },
  };
  return h;
}

test("parseStopWhen: the shape, and the errors that name it", () => {
  assert.deepEqual(parseStopWhen({ field: "g.done", equals: 1 }, "t"), { field: "g.done", test: "equals", target: 1, index: 0, every: 1 });
  assert.deepEqual(parseStopWhen({ field: "g.hp", atMost: 0, every: 4, index: 1 }, "t"), { field: "g.hp", test: "atMost", target: 0, index: 1, every: 4 });
  assert.equal(parseStopWhen(undefined, "t"), null);
  assert.throws(() => parseStopWhen({ field: "x" }, "t"), /needs equals, atLeast or atMost/);
  assert.throws(() => parseStopWhen({ field: "x", equals: 1, atLeast: 2 }, "t"), /one of equals/);
  assert.throws(() => parseStopWhen({ equals: 1 }, "t"), /needs a field name/);
  assert.throws(() => parseStopWhen({ field: "x", equals: 1, every: 0 }, "t"), /every/);
});

test("stepUntil stops on the exact frame the field meets the condition, and runs the whole range when it never does", async () => {
  const h = fakeHost(7);
  const r = await stepUntil(h, 20, parseStopWhen({ field: "g.done", equals: 1 }, "t"));
  assert.deepEqual(r, { framesRun: 7, stopped: { field: "g.done", value: 1 } });
  const h2 = fakeHost(100);
  const r2 = await stepUntil(h2, 20, parseStopWhen({ field: "g.done", equals: 1 }, "t"));
  assert.deepEqual(r2, { framesRun: 20, stopped: null });
  // checked every 4 frames: a flip at 7 is seen at 8
  const h3 = fakeHost(7);
  const r3 = await stepUntil(h3, 20, parseStopWhen({ field: "g.done", equals: 1, every: 4 }, "t"));
  assert.equal(r3.framesRun, 8);
  // array fields by index, and atLeast
  const h4 = fakeHost(99);
  const r4 = await stepUntil(h4, 20, parseStopWhen({ field: "g.pos", atLeast: 5 }, "t"));
  assert.equal(r4.framesRun, 5);
  const r5 = await stepUntil(fakeHost(99), 20, parseStopWhen({ field: "g.pos", index: 1, atMost: -3 }, "t"));
  assert.equal(r5.framesRun, 3);
  // without a clause: one stepFrames call for the whole range
  const h6 = fakeHost(1);
  assert.deepEqual(await stepUntil(h6, 20, null), { framesRun: 20, stopped: null });
});

test("readFields: scalars, arrays and a bytes field's text; an unknown field throws", () => {
  const h = fakeHost(0);
  h.stepFrames(3);
  assert.deepEqual(readFields(h, ["g.done", "g.pos", "g.name"]), { "g.done": 1, "g.pos": [3, -3], "g.name": "hi" });
  assert.throws(() => readFields(h, ["g.typo"]), /no debug field 'g.typo'/);
  assert.throws(() => readFields({ kind: "libretro" }, ["x"]), /no debug fields/);
});

test("input({op:'sequence', fields, stopWhen}) on a fake host: the fields after the last frame, the step it stopped in, the frames run", async () => {
  const sk = "stepfields-fake";
  const h = fakeHost(10);
  _setHostForTest(sk, h);
  try {
    const call = tools(sk);
    const r = await call("input", { op: "sequence", steps: [
      { input: { ports: [{ up: true }] }, frames: 4 },
      { input: { ports: [{ right: true }] }, frames: 4 },
      { input: { ports: [{ down: true }] }, frames: 4 },
      { input: { ports: [{}] }, frames: 4 },
    ], fields: ["g.done", "g.pos"], stopWhen: { field: "g.done", equals: 1 } });
    assert.equal(r.framesRun, 10, "stopped the frame g.done flipped");
    assert.equal(r.stepsRun, 3);
    assert.deepEqual(r.stopped, { field: "g.done", value: 1, step: 2, frameCount: 10 });
    assert.deepEqual(r.fields, { "g.done": 1, "g.pos": [10, -10] });
    assert.equal(h.sets.length, 3, "the fourth step never ran");
    // not met: stopped:false, every frame run, fields still returned
    const h2 = fakeHost(1000);
    _setHostForTest(sk, h2);
    const r2 = await call("input", { op: "sequence", steps: [{ input: { ports: [{}] }, frames: 6 }], fields: ["g.pos"], stopWhen: { field: "g.done", equals: 1 } });
    assert.equal(r2.stopped, false);
    assert.equal(r2.framesRun, 6);
    assert.deepEqual(r2.fields, { "g.pos": [6, -6] });
    // without fields or stopWhen the result has neither key (the old shape)
    const r3 = await call("input", { op: "sequence", steps: [{ input: { ports: [{}] }, frames: 2 }] });
    assert.equal("fields" in r3, false);
    assert.equal("stopped" in r3, false);
    assert.equal(r3.framesRun, 2);
    await assert.rejects(call("input", { op: "sequence", steps: [{ input: { ports: [{}] }, frames: 2 }], fields: ["g.typo"] }), /no debug field 'g.typo'/);
    await assert.rejects(call("input", { op: "sequence", steps: [{ input: { ports: [{}] }, frames: 2 }], stopWhen: { field: "g.done" } }), /needs equals/);
  } finally { clearHost(sk); }
});

test("frame({op:'step', fields, stopWhen}) on a fake host", async () => {
  const sk = "stepfields-frame";
  const h = fakeHost(5);
  _setHostForTest(sk, h);
  try {
    const call = tools(sk);
    const r = await call("frame", { op: "step", frames: 60, fields: ["g.done", "g.name"], stopWhen: { field: "g.done", equals: 1 } });
    assert.equal(r.framesRun, 5);
    assert.deepEqual(r.stopped, { field: "g.done", value: 1, frameCount: 5 });
    assert.deepEqual(r.fields, { "g.done": 1, "g.name": "hi" });
    const r2 = await call("frame", { op: "step", frames: 3, fields: ["g.pos"] });
    assert.equal(r2.framesRun, 3);
    assert.deepEqual(r2.fields, { "g.pos": [8, -8] });
    assert.equal("stopped" in r2, false);
    const r3 = await call("frame", { op: "step", frames: 2 });
    assert.equal("fields" in r3, false);
  } finally { clearHost(sk); }
});

test("on wasmcart's test cart: fields come from the cart's debug ABI and stopWhen ends a sequence on a cart value", async () => {
  const sk = "stepfields-cart";
  const host = new WasmcartHost();
  await host.loadMedia({ platform: "wasmcart", path: TESTCART });
  _setHostForTest(sk, host);
  try {
    const call = tools(sk);
    const f0 = host.status.frameCount;
    // frame counts up every frame in the test cart: stop when it reaches f0 + 7 inside a 30-frame step
    const target = f0 + 7;
    const r = await call("input", { op: "sequence", steps: [{ input: { ports: [{ south: true }], keys: ["space"] }, frames: 30 }],
      fields: ["frame", "pad.buttons", "key.held"], stopWhen: { field: "frame", atLeast: target } });
    assert.equal(r.framesRun, 7);
    assert.equal(r.stopped.field, "frame");
    assert.equal(r.fields.frame, target);
    assert.ok(Array.isArray(r.fields["pad.buttons"]) && r.fields["pad.buttons"][0] !== 0, "the pad held during the range");
    assert.equal(r.fields["key.held"], 1, "the key held during the range");
    // frame({op:'step'}) reads the same fields
    const s = await call("frame", { op: "step", frames: 3, fields: ["frame", "key.held"] });
    assert.equal(s.fields.frame, target + 3);
    assert.equal(s.fields["key.held"], 1, "a frame step changes no input: the key stays held");
    await assert.rejects(call("frame", { op: "step", frames: 1, fields: ["no.such.field"] }), /no.such.field/);
  } finally { clearHost(sk); host.destroy(); }
});
