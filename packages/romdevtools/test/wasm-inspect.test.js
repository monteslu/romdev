// wasm-inspect — the `wasm` tool surface + WasmcartHost conformance/audio wiring
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
// not a rejection — assert on that shape.
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
