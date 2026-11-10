// Keyboard keys reaching a wasmcart cart: input({op:'set', keys}) and the
// steps of input({op:'sequence'}) hold SDL-named keys, delivered through
// wasmcart's keyboard ABI (the 256-bit held mask behind wc_info_t.keys_ptr,
// wc_kb_on_down/up with modifiers) the way a real host's SDL loop delivers a
// keyboard. Read back from wasmcart's test cart, which counts key events and
// the keys held and logs the last scancodes pressed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { z } from "zod";
import { WasmcartHost } from "../src/host/WasmcartHost.js";
import { keyScancode, keyScancodes, modifiersOf, MOD } from "../src/host/wasmcart-keys.js";
import { registerInputTools } from "../src/mcp/tools/input.js";
import { _setHostForTest, clearHost } from "../src/mcp/state.js";

const TESTCART = path.join(path.dirname(fileURLToPath(import.meta.resolve("wasmcart"))), "testcart", "testcart.wasc");

async function load() {
  const host = new WasmcartHost();
  await host.loadMedia({ platform: "wasmcart", path: TESTCART });
  return host;
}
const value = (host, name) => { const v = host.readDebugValue(name); return v.values ?? v.value; };

function inputTool(sessionKey) {
  let handler, schema;
  registerInputTools({ tool(name, _d, s, h) { if (name === "input") { handler = h; schema = s; } } }, z, sessionKey);
  const parse = (args) => z.object(schema).parse(args);
  return async (args) => {
    const r = await handler(parse(args));
    if (r.isError) throw new Error(r.content?.[0]?.text || "tool error");
    return JSON.parse(r.content.find((c) => c.type === "text").text);
  };
}

test("key names: SDL scancode names, aliases and numbers resolve to HID scancodes; unknown names throw", () => {
  assert.equal(keyScancode("space"), 44);
  assert.equal(keyScancode("Space"), 44);
  assert.equal(keyScancode("w"), 26);
  assert.equal(keyScancode("return"), 40);
  assert.equal(keyScancode("enter"), 40);
  assert.equal(keyScancode("left"), 80);
  assert.equal(keyScancode("Left Shift"), 225);
  assert.equal(keyScancode("lshift"), 225);
  assert.equal(keyScancode("f12"), 69);
  assert.equal(keyScancode("-"), 45);
  assert.equal(keyScancode(79), 79);
  assert.deepEqual(keyScancodes(["w", "space", "w"]), [26, 44]);
  assert.throws(() => keyScancode("jumpkey"), /unknown key 'jumpkey'/);
  assert.throws(() => keyScancode(300), /0-255/);
  assert.equal(modifiersOf([225, 44]), MOD.SHIFT);
  assert.equal(modifiersOf([228, 226, 227]), MOD.CTRL | MOD.ALT | MOD.META);
});

test("testcart: keys held by setInput reach the cart's mask and its key events, with modifiers; a set without keys releases them", async () => {
  const host = await load();
  assert.equal(host.keyboardWanted(), true, "the test cart asks for the keyboard");
  host.setInput({ ports: [{}], keys: ["space", "w", "lshift"] });
  host.stepFrames(2);
  assert.equal(value(host, "key.held"), 3, "three keys in the held mask");
  assert.equal(value(host, "key.downs"), 3, "one wc_kb_on_down per key, not per frame");
  assert.equal(value(host, "key.mods"), MOD.SHIFT, "the events carried the shift modifier");
  assert.deepEqual(value(host, "key.log").slice(0, 3), [225, 44, 26], "the scancodes the cart logged, most recent first");
  // the same keys again: held, no new events (a real keyboard does not repeat key down)
  host.setInput({ ports: [{}], keys: ["w", "space", "lshift"] });
  host.stepFrames(1);
  assert.equal(value(host, "key.downs"), 3);
  assert.equal(value(host, "key.held"), 3);
  // a pad set that names no keys releases them all
  host.setInput({ ports: [{ south: true }] });
  host.stepFrames(1);
  assert.equal(value(host, "key.held"), 0);
  assert.equal(value(host, "key.ups"), 3);
  assert.equal(value(host, "pad.buttons")[0] !== 0, true, "the pad set still landed");
  host.destroy();
});

test("testcart: a pointer-only or wheel-only call leaves the keys held", async () => {
  const host = await load();
  host.setInput({ ports: [{}], keys: ["d"] });
  host.stepFrames(1);
  host.setInput({ pointer: { id: 0, x: 10, y: 10 } });
  host.setInput({ wheel: { dx: 0, dy: 120 } });
  host.stepFrames(1);
  assert.equal(value(host, "key.held"), 1);
  assert.equal(value(host, "key.ups"), 0);
  host.destroy();
});

test("input({op:'set', keys}) and sequence steps with keys drive the cart; the result names the keys", async () => {
  const sk = "keys-tool";
  const host = await load();
  _setHostForTest(sk, host);
  try {
    const input = inputTool(sk);
    const set = await input({ op: "set", ports: [{}], keys: ["space", "Left Shift"] });
    assert.deepEqual(set.keys, ["space", "leftshift"]);
    assert.deepEqual(set.scancodes, [44, 225]);
    assert.equal(set.keyboard, true, "the cart wants the keyboard");
    assert.equal(set.note, undefined, "no warning");
    host.stepFrames(1);
    assert.equal(value(host, "key.held"), 2);
    const seq = await input({ op: "sequence", steps: [
      { input: { ports: [{ right: true }], keys: ["d"] }, frames: 3 },
      { input: { ports: [{}] }, keys: ["w", "a"], frames: 2 },
      { input: { ports: [{}] }, frames: 1 },
    ], fields: ["key.held", "key.downs", "key.ups"] });
    assert.equal(seq.framesRun, 6);
    assert.equal(seq.stepsRun, 3);
    // space+lshift released by step 1 (2 ups), d down then up (1 down, 1 up), w+a down then up (2 downs, 2 ups)
    assert.deepEqual(seq.fields, { "key.held": 0, "key.downs": 2 + 1 + 2, "key.ups": 2 + 1 + 2 });
    await assert.rejects(input({ op: "set", ports: [{}], keys: ["jump"] }), /unknown key 'jump'/);
  } finally {
    clearHost(sk);
    host.destroy();
  }
});

test("keys on a non-wasmcart host are refused; keys on a cart without WC_FLAG_KEYBOARD are reported", async () => {
  const sk = "keys-libretro";
  const calls = [];
  _setHostForTest(sk, { kind: "libretro", status: { platform: "nes", loaded: true }, setInput(a) { calls.push(a); }, stepFrames() { return 1; } });
  try {
    const input = inputTool(sk);
    await assert.rejects(input({ op: "set", ports: [{ a: true }], keys: ["space"] }), /wasmcart cart's keyboard/);
    assert.equal(calls.length, 0, "refused before the host was touched");
    const ok = await input({ op: "set", ports: [{ a: true }] });
    assert.equal(ok.inputSet, true);
    assert.equal(calls.length, 1);
    assert.equal("keys" in calls[0], false, "a libretro host never sees a keys field");
  } finally { clearHost(sk); }

  const sk2 = "keys-nokb";
  const host = await load();
  host.cart.info.wantsKeyboard = false; // a cart that did not opt in
  _setHostForTest(sk2, host);
  try {
    const input = inputTool(sk2);
    const r = await input({ op: "set", ports: [{}], keys: ["space"] });
    assert.equal(r.keyboard, false);
    assert.match(r.note, /WC_FLAG_KEYBOARD/);
    host.stepFrames(1);
    assert.equal(value(host, "key.downs"), 0, "CartHost delivers nothing to a cart that did not ask");
  } finally { clearHost(sk2); host.destroy(); }
});
