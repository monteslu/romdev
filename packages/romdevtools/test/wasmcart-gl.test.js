// Headless GL rendering for wasmcart GL carts. WasmcartHost hands CartHost a
// lazy glBackend factory (wasmcart 0.6.0+): invoked only when the cart's wasm
// imports from the "gl" module, backed by ONE process-lifetime offscreen
// webgl-node context, read back (Y-flipped, alpha-forced) into
// state.lastFrame so screenshots/frame hashes show REAL GL draws instead of
// stub no-ops.
//
// SKIP-GUARDED: on a clean clone the wasmcart pin may predate 0.6.0 (the
// factory contract) and webgl-node may be absent — both degrade to the old
// stub behavior by design, so these tests skip rather than fail there.
// Fixture: glcart.wasc (from the wasmcart repo, rebuild recipe in its
// test/fixtures/glcart.c) — clears the GL context to (0.0, 0.5, 1.0) and
// also writes one red pixel into its 2D framebuffer (hybrid).

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { WasmcartHost } from "../src/host/WasmcartHost.js";
import { computeVerify } from "../src/mcp/tools/frame.js";
import { glStackAvailable } from "romdev-core-host/glOptionalDep.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GLCART = path.join(HERE, "fixtures", "glcart.wasc");
const DBG = path.join(HERE, "fixtures", "dbghello.wasc");

// package.json isn't in wasmcart's exports map — read it next to the entry.
const _require = createRequire(import.meta.url);
const { readFileSync } = await import("node:fs");
const wcVersion = JSON.parse(readFileSync(
  path.join(path.dirname(_require.resolve("wasmcart")), "package.json"), "utf8"));
const [maj, min] = String(wcVersion.version ?? "0.0.0").split(".").map(Number);
let glReady = maj > 0 || min >= 6;
if (glReady) {
  try { await import("webgl-node"); } catch { glReady = false; }
}
const GUARD = glReady ? {} : { skip: `wasmcart ${wcVersion.version} < 0.6.0 or webgl-node absent — GL carts run stubbed here (by design)` };

test("GL cart renders REAL pixels headless: screenshot shows the GL clear color", GUARD, async () => {
  if (!(await glStackAvailable())) { console.log("GL stack unusable here; skipping"); return; }
  const host = new WasmcartHost();
  await host.loadMedia({ platform: "wasmcart", path: GLCART });
  const s = host.getStatus();
  assert.equal(s.gl, "rendered", "status reports real GL rendering");
  assert.equal(host.getCapabilities().hasGlRendering, true);

  host.stepFrames(3);
  const f = host.getFramebuffer();
  // glClearColor(0.0, 0.5, 1.0) → RGBA bytes [0, 128, 255, 255] everywhere.
  assert.equal(f.pixels[0], 0, "R");
  assert.equal(f.pixels[1], 128, "G");
  assert.equal(f.pixels[2], 255, "B");
  assert.equal(f.pixels[3], 255, "alpha forced opaque");
  // Not the 2D framebuffer: the hybrid cart writes RED at fb[0]; the GL
  // readback must have replaced it with the clear color.
  const shot = host.screenshot();
  assert.ok(shot.pngBase64.length > 0, "PNG screenshot of the GL frame");
  host.destroy();
});

test("2D cart is untouched: no GL context, no readback, status.gl null", GUARD, async () => {
  if (!(await glStackAvailable())) { console.log("GL stack unusable here; skipping"); return; }
  const host = new WasmcartHost();
  await host.loadMedia({ platform: "wasmcart", path: DBG });
  assert.equal(host.getStatus().gl, null);
  assert.equal(host.getCapabilities().hasGlRendering, false);
  host.stepFrames(2);
  const f = host.getFramebuffer();
  assert.ok(f.width > 0 && f.pitch === f.width * 4, "2D framebuffer path intact");
  host.destroy();
});

test("GL frame participates in framebufferHash (regression goldens see GL draws)", GUARD, async () => {
  if (!(await glStackAvailable())) { console.log("GL stack unusable here; skipping"); return; }
  const host = new WasmcartHost();
  await host.loadMedia({ platform: "wasmcart", path: GLCART });
  host.stepFrames(2);
  const hash = host.framebufferHash();
  assert.ok(hash !== 0, "hash of the GL readback frame");
  host.destroy();
});

test("screenshotRgba returns `rgba` (the LibretroHost contract) and frame verify runs", async () => {
  if (!(await glStackAvailable())) { console.log("GL stack unusable here; skipping"); return; }
  // Regression (found by the openarena MCP smoke): both native hosts returned
  // {pixels} where every LibretroHost caller — computeVerify, sideBySide, the
  // livestream — destructures {rgba}, so frame({op:'verify'}) threw a raw
  // TypeError on EVERY wasmcart/jsgame session since the hosts were born.
  const host = new WasmcartHost();
  await host.loadMedia({ platform: "wasmcart", path: DBG });
  const s = host.screenshotRgba();
  assert.ok(s.rgba && s.rgba.length === s.width * s.height * 4, "rgba key, full-frame length");
  const v = await computeVerify(host, 2, "wasmcart-gl-test");
  assert.ok(typeof v.verified === "boolean" || v.verified === null, "verify produced a verdict, not a throw");
  assert.ok(v.pixels && v.pixels.width > 0, "pixel scan ran");
  host.destroy();
});
