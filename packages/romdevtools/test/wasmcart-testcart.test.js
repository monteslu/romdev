// wasmcart's test cart (testcart/ in the wasmcart package) through romdev's
// wasmcart host: what input({op:'set'}) and the playtest window send must be
// what the cart receives, read back from the cart's own debug fields.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { BUTTON } from "wasmcart";
import { WasmcartHost } from "../src/host/WasmcartHost.js";

const TESTCART = path.join(path.dirname(fileURLToPath(import.meta.resolve("wasmcart"))), "testcart", "testcart.wasc");

async function load() {
  const host = new WasmcartHost();
  await host.loadMedia({ platform: "wasmcart", path: TESTCART });
  return host;
}
const value = (host, name) => { const v = host.readDebugValue(name); return v.values ?? v.value; };

test("testcart: buttons arrive by position, Guide/L3/paddles as their own bits", async () => {
  const host = await load();
  host.setInput({ ports: [{ south: true, l3: true, guide: true, paddle1: true }, { a: true }] });
  host.stepFrames(2);
  const [p0, p1] = value(host, "pad.buttons");
  assert.equal(p0, BUTTON.A | BUTTON.L3 | BUTTON.GUIDE | BUTTON.PADDLE1);
  assert.equal(p1, BUTTON.B, "libretro 'a' is the east button (WC_BTN_B)");
  assert.equal(p0 & BUTTON.SELECT, 0, "Guide is not Select");
  host.destroy();
});

test("testcart: triggers rest at 0 and reach 32767", async () => {
  const host = await load();
  host.setInput({ ports: [{ axes: { lt: 0, rt: 1, lx: -1 } }] });
  host.stepFrames(2);
  assert.equal(value(host, "pad.lt")[0], 0);
  assert.equal(value(host, "pad.rt")[0], 32767);
  assert.equal(value(host, "pad.lx")[0], -32767);
  host.destroy();
});

test("testcart: a face button sounds; with none held the cart is silent", async () => {
  const host = await load();
  host.stepFrames(5);
  assert.equal(value(host, "audio.tones"), 0);
  host.setInput({ ports: [{ south: true }] });
  host.stepFrames(5);
  assert.equal(value(host, "audio.tones"), 1, "P1 A");
  host.destroy();
});
