// wasmcart host kind — romdev drives a native WASM game cart (CartHost) through the
// same run/see/drive surface it uses for emulator cores, plus WASM introspection an
// emulator can't offer. Uses a tiny vendored hello.wasc (2D, no-GL) so it runs headless.

import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { WasmcartHost } from "../src/host/WasmcartHost.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HELLO = path.join(HERE, "fixtures", "hello.wasc");

test("wasmcart: loads a .wasc + reports a wasmcart capability profile", async () => {
  const host = new WasmcartHost();
  const status = await host.loadMedia({ platform: "wasmcart", path: HELLO });
  assert.equal(status.loaded, true);
  assert.equal(status.platform, "wasmcart");
  assert.ok(status.fbWidth > 0 && status.fbHeight > 0, "reports a framebuffer size");

  const caps = host.getCapabilities();
  assert.equal(caps.kind, "wasmcart");
  assert.equal(caps.canStepFrames, true);
  assert.equal(caps.canScreenshot, true);
  assert.equal(caps.canSetInput, true);
  // Native runtime — NO emulated memory regions / CPU state / disasm / cheats.
  assert.equal(caps.hasMemoryRegions, false);
  assert.equal(caps.hasCpuState, false);
  assert.equal(caps.hasDisasm, false);
  assert.equal(caps.hasCheats, false);
  // ...but the V8 bonus: WASM linear-memory + exports introspection.
  assert.equal(caps.hasWasmIntrospection, true);
  host.destroy();
});

test("wasmcart: steps frames + produces a non-blank screenshot", async () => {
  const host = new WasmcartHost();
  await host.loadMedia({ platform: "wasmcart", path: HELLO });

  const stepped = host.stepFrames(10);
  assert.equal(stepped, 10);
  assert.equal(host.status.frameCount, 11); // +1 from the settle frame in loadMedia

  const shot = host.screenshot();
  assert.ok(shot.pngBase64 && shot.pngBase64.length > 0, "produces a PNG");
  assert.ok(shot.width > 0 && shot.height > 0);

  // The framebuffer should not be entirely one value (a rendered frame, not blank).
  const fb = host.getFramebuffer();
  let distinct = new Set();
  for (let i = 0; i < fb.pixels.length; i += 397) distinct.add(fb.pixels[i]);
  assert.ok(distinct.size > 1, "framebuffer has rendered content (not a single flat value)");
  host.destroy();
});

test("wasmcart: setInput accepts romdev's {ports} shape + drives frames", async () => {
  const host = new WasmcartHost();
  await host.loadMedia({ platform: "wasmcart", path: HELLO });
  // The multi-port shape romdev's input tool sends.
  host.setInput({ ports: [{ a: true, right: true }, {}] });
  assert.doesNotThrow(() => host.stepFrames(5));
  // A flat button object must also work.
  host.setInput({ b: true });
  assert.doesNotThrow(() => host.stepFrames(5));
  host.destroy();
});

test("wasmcart: WASM introspection — memory + exports (the V8 bonus)", async () => {
  const host = new WasmcartHost();
  await host.loadMedia({ platform: "wasmcart", path: HELLO });
  host.stepFrames(2);

  assert.ok(host.wasmMemorySize() > 0, "reports the WASM linear-memory size");

  const exports = host.wasmExports();
  assert.ok(Array.isArray(exports) && exports.length > 0, "enumerates WASM exports");
  const names = exports.map((e) => e.name);
  assert.ok(names.includes("wc_render"), "exposes the cart's wc_render export");
  assert.ok(exports.some((e) => e.kind === "memory"), "reports the memory export kind");

  const bytes = host.readMemory(0, 16);
  assert.equal(bytes.length, 16, "reads 16 bytes from the cart heap");

  const info = host.getInfo();
  assert.ok(info && typeof info.width === "number", "returns the parsed WCInfo");
  host.destroy();
});

test("wasmcart: emulator-only ops are absent (cheats unsupported)", async () => {
  const host = new WasmcartHost();
  await host.loadMedia({ platform: "wasmcart", path: HELLO });
  assert.equal(host.cheatsSupported(), false);
  host.destroy();
});
