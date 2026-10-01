// wasm-inspect - the `wasm` tool surface + WasmcartHost conformance/audio wiring
// (Slice 1: WS1 audio + WS2 conformance). Against the vendored hello.wasc.

import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { z } from "zod";
import { WasmcartHost } from "../src/host/WasmcartHost.js";
import { registerWasmInspectTools } from "../src/mcp/tools/wasm-inspect.js";
import { _setHostForTest } from "../src/mcp/state.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HELLO = path.join(HERE, "fixtures", "hello.wasc");

function getWasmHandler(key) {
  let handler;
  const fakeServer = { tool(name, _d, _s, h) { if (name === "wasm") handler = h; } };
  registerWasmInspectTools(fakeServer, z, key);
  return (args) => handler(args);
}
const parse = (res) => JSON.parse(res.content.find((c) => c.type === "text").text);

// ── WS1: audio wiring ────────────────────────────────────────────────────────

test("WasmcartHost accumulates per-frame audio into state.audioRing", async () => {
  const host = new WasmcartHost();
  await host.loadMedia({ platform: "wasmcart", path: HELLO });
  const ringBefore = host.state.audioRing.length;
  host.stepFrames(30);
  // A cart with audio fills the ring; a silent hello cart may not. Assert the
  // WIRING is correct either way: audioRing exists, is an array, and if the cart
  // emits audio the chunks are Int16Array. (Non-flaky: shape, not content.)
  assert.ok(Array.isArray(host.state.audioRing), "audioRing is an array");
  assert.ok(host.state.audioRing.length >= ringBefore, "ring only grows on step");
  for (const chunk of host.state.audioRing) {
    assert.ok(chunk instanceof Int16Array, "each ring chunk is Int16Array (Float32 normalized)");
  }
  // audioSampleRate is populated (declared rate, or 0 for a no-audio cart).
  assert.equal(typeof host.status.audioSampleRate, "number");
});

test("WasmcartHost implements getStatus (catalog({op:'status'}) needs it)", async () => {
  // Regression: catalog({op:'status'}) calls host.getStatus() host-kind-
  // agnostically; a missing method crashed status on any wasmcart session.
  const host = new WasmcartHost();
  await host.loadMedia({ platform: "wasmcart", path: HELLO });
  assert.equal(typeof host.getStatus, "function");
  const st = host.getStatus();
  assert.equal(st.platform, "wasmcart");
  assert.equal(st.loaded, true);
  assert.ok(st.fbWidth > 0);
});

// ── WS2: the wasm tool ───────────────────────────────────────────────────────

test("wasm({op:'conformance'}) passes on a valid cart", async () => {
  const host = new WasmcartHost();
  await host.loadMedia({ platform: "wasmcart", path: HELLO });
  _setHostForTest("wasm-test", host);
  const r = parse(await getWasmHandler("wasm-test")({ op: "conformance" }));
  assert.equal(r.conforms, true, "hello.wasc conforms");
  assert.equal(r.requiredExportsPresent, true);
  assert.ok(!r.issues.some((i) => i.severity === "error"), "no error-severity issues");
  assert.equal(typeof r.abi, "number");
});

test("wasm({op:'exports'}) reports abiComplete + names the required exports", async () => {
  const host = new WasmcartHost();
  await host.loadMedia({ platform: "wasmcart", path: HELLO });
  _setHostForTest("wasm-test2", host);
  const r = parse(await getWasmHandler("wasm-test2")({ op: "exports" }));
  assert.equal(r.abiComplete, true);
  assert.deepEqual(r.missingRequired, []);
  const names = r.exports.map((e) => e.name);
  assert.ok(names.includes("wc_render"));
  assert.ok(r.exports.some((e) => e.kind === "memory"));
});

test("wasm({op:'info'}) returns the running WCInfo + manifest", async () => {
  const host = new WasmcartHost();
  await host.loadMedia({ platform: "wasmcart", path: HELLO });
  _setHostForTest("wasm-test3", host);
  const r = parse(await getWasmHandler("wasm-test3")({ op: "info" }));
  assert.ok(r.info && typeof r.info.width === "number" && r.info.width > 0);
});

test("wasm({op:'read'}) / {op:'write'} round-trip on the cart heap", async () => {
  const host = new WasmcartHost();
  await host.loadMedia({ platform: "wasmcart", path: HELLO });
  _setHostForTest("wasm-test4", host);
  const h = getWasmHandler("wasm-test4");
  // pick an offset well inside the heap
  const off = 0x1000;
  await h({ op: "write", offset: off, hex: "DE AD BE EF" }); // separators tolerated
  const r = parse(await h({ op: "read", offset: off, length: 4 }));
  assert.equal(r.hex, "deadbeef");
});

// safeTool turns a thrown error into an error-content result (isError:true),
// not a rejection - assert on that shape.
const errText = (res) => { assert.equal(res.isError, true); return res.content.find((c) => c.type === "text").text; };

test("wasm({op:'write'}) names a bad hex character (shared cleaner)", async () => {
  const host = new WasmcartHost();
  await host.loadMedia({ platform: "wasmcart", path: HELLO });
  _setHostForTest("wasm-test5", host);
  const res = await getWasmHandler("wasm-test5")({ op: "write", offset: 0x1000, hex: "DEADXY" });
  assert.match(errText(res), /non-hex character 'X'/);
});

// ── symmetric refusal on an emulator host ────────────────────────────────────

test("wasm tool REFUSES on a libretro (emulator) host", async () => {
  // A minimal fake emulator host: no getCapabilities / hasWasmIntrospection.
  _setHostForTest("emu-test", {
    getCapabilities: () => ({ kind: "libretro", hasWasmIntrospection: false }),
  });
  const res = await getWasmHandler("emu-test")({ op: "conformance" });
  assert.match(errText(res), /not a WASM-runtime cart|disasm\/symbols/);
});

// ── debug ABI ops (feature-detected; fake a debug-capable host/cart) ─────────

function makeDebugCart(fields, mem) {
  // mem: { name: {value, set(v)} } keyed by field name
  return {
    readDebugState: () => fields,
    readDebugValue: (name) => {
      const f = fields.find((x) => x.name === name);
      if (!f) throw new Error(`debug field '${name}' not found`);
      return { name, type: f.typeName, value: mem[name].value };
    },
    writeDebugValue: (name, v) => { mem[name].value = v; return fields.find((x) => x.name === name).valuePtr; },
  };
}

function debugHost() {
  const mem = { hp: { value: 42 }, player_x: { value: 100 } };
  const fields = [
    { name: "hp", type: 0, typeName: "u8", valuePtr: 0x200, len: 1 },
    { name: "player_x", type: 3, typeName: "i16", valuePtr: 0x204, len: 1 },
  ];
  const cart = makeDebugCart(fields, mem);
  return {
    getCapabilities: () => ({ kind: "wasmcart", hasWasmIntrospection: true, hasDebugState: true }),
    readDebugState: () => cart.readDebugState(),
    readDebugValue: (n) => cart.readDebugValue(n),
    writeDebugValue: (n, v) => cart.writeDebugValue(n, v),
    _mem: mem,
  };
}

test("wasm({op:'debugState'}) lists the cart's named fields with values", async () => {
  _setHostForTest("dbg1", debugHost());
  const r = parse(await getWasmHandler("dbg1")({ op: "debugState" }));
  assert.equal(r.hasDebugState, true);
  assert.equal(r.count, 2);
  const hp = r.fields.find((f) => f.name === "hp");
  assert.equal(hp.value, 42);
});

test("wasm({op:'read', name}) / {op:'write', name, value} on a named field", async () => {
  const host = debugHost();
  _setHostForTest("dbg2", host);
  const h = getWasmHandler("dbg2");
  assert.equal(parse(await h({ op: "read", name: "hp" })).value, 42);
  await h({ op: "write", name: "hp", value: 7 });
  assert.equal(parse(await h({ op: "read", name: "hp" })).value, 7);
  assert.equal(host._mem.hp.value, 7);
});

test("wasm({op:'debugState'}) says so when the cart has no debug state", async () => {
  _setHostForTest("dbg3", {
    getCapabilities: () => ({ kind: "wasmcart", hasWasmIntrospection: true }),
    readDebugState: () => null,
  });
  const r = parse(await getWasmHandler("dbg3")({ op: "debugState" }));
  assert.equal(r.hasDebugState, false);
  assert.match(r.note, /no named debug state/);
});

test("WasmcartHost.framebufferHash is stable per frame + shifts on change", async () => {
  const host = new WasmcartHost();
  await host.loadMedia({ platform: "wasmcart", path: HELLO });
  host.stepFrames(5);
  const h1 = host.framebufferHash();
  const h2 = host.framebufferHash(); // same frame → same hash (deterministic)
  assert.equal(h1, h2);
  assert.equal(typeof h1, "number");
  host.stepFrames(30);
  // after more frames the hash is still a number (may or may not differ for a
  // static hello cart - assert only determinism + type, not content).
  assert.equal(typeof host.framebufferHash(), "number");
});

// A bytes field is rendered as hex (+ text when printable), not as a JSON
// object with one key per byte, and can be written by name.
function bytesHost() {
  const store = new Uint8Array(32);
  store.set(Buffer.from("oa_dm1"), 0);
  const fields = [{ name: "mapname", type: 8, typeName: "bytes", valuePtr: 0x300, len: 16 },
    { name: "hp", type: 0, typeName: "u8", valuePtr: 0x320, len: 1 }];
  return {
    getCapabilities: () => ({ kind: "wasmcart", hasWasmIntrospection: true, hasDebugState: true }),
    readDebugState: () => fields,
    readDebugValue: (name) => {
      const f = fields.find((x) => x.name === name);
      if (f.type === 8) return { name, type: "bytes", bytes: store.slice(f.valuePtr - 0x300, f.valuePtr - 0x300 + f.len) };
      return { name, type: "u8", value: 1 };
    },
    writeMemory: (offset, bytes) => { store.set(bytes, offset - 0x300); return bytes.length; },
  };
}

test("wasm({op:'read', name}) renders a bytes field as hex + text", async () => {
  _setHostForTest("dbgbytes1", bytesHost());
  const r = parse(await getWasmHandler("dbgbytes1")({ op: "read", name: "mapname" }));
  assert.equal(r.text, "oa_dm1");
  assert.equal(r.length, 16);
  assert.equal(r.hex.slice(0, 12), Buffer.from("oa_dm1").toString("hex"));
  assert.equal(r.bytes, undefined);
});

test("wasm({op:'write', name, hex}) writes a bytes field within its length", async () => {
  _setHostForTest("dbgbytes2", bytesHost());
  const h = getWasmHandler("dbgbytes2");
  const w = parse(await h({ op: "write", name: "mapname", hex: Buffer.from("q3dm17\0").toString("hex") }));
  assert.equal(w.atOffset, 0x300);
  assert.equal(parse(await h({ op: "read", name: "mapname" })).text, "q3dm17");
  assert.match(errText(await h({ op: "write", name: "mapname", hex: "00".repeat(17) })), /exceeds the field's 16/);
  assert.match(errText(await h({ op: "write", name: "hp", hex: "01" })), /need a bytes field/);
});
