// Genesis feel/perf diagnostic — watch({on:'dma', perFrame:true}) end to end.
//
// Proves the per-frame VDP-DMA WORK timeline (the cheap "why is horizontal
// movement choppy?" answer) against the two_plane_parallax scaffold:
//   - it's reachable through `watch` with on:'dma', perFrame:true
//   - it returns a per-frame {frame,dmas,bytes,romBytes,ramBytes} timeline +
//     peak/avg/spikes
//   - a HARDWARE-SCROLL-ONLY loop settles to a LOW, FLAT steady-state curve
//     (the whole point: no per-frame tilemap rewrites → tiny per-frame DMA)
//
// Lives under test/ (not src/) because it cold-loads the genesis-c toolchain +
// gpgx wasm — same family as r21-template-parity / genesis-re-primitives.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";

import { registerTools } from "../src/mcp/tools/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

async function startClient() {
  const server = new McpServer({ name: "gen-dma", version: "0.0.1" }, { capabilities: { tools: {} } });
  registerTools(server, z);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "gen-dma-client", version: "0.0.1" }, { capabilities: {} });
  await Promise.all([server.connect(st), client.connect(ct)]);
  return client;
}
const toJSON = (res) => { assert.equal(res.isError, undefined, "isError: " + JSON.stringify(res)); return JSON.parse(res.content[0].text); };

test("Genesis perFrame DMA: two_plane_parallax scaffold settles to a low flat curve", { timeout: 240000 }, async () => {
  const client = await startClient();

  const src = await readFile(join(REPO_ROOT, "examples/genesis/templates/two_plane_parallax.c"), "utf-8");
  const build = toJSON(await client.callTool({
    name: "build", arguments: { output: "rom", platform: "genesis", language: "c", source: src, runtime: "sgdk", inline: true },
  }, undefined, { timeout: 240000 }));
  assert.equal(build.ok, true, "scaffold build failed:\n" + (build.log || "").slice(-400));

  const load = toJSON(await client.callTool({
    name: "loadMedia", arguments: { platform: "genesis", base64: build.binaryBase64 },
  }));
  assert.equal(load.loaded, true, "loadMedia failed: " + JSON.stringify(load));

  // Let the SGDK boot DMAs settle first (font/tile/SAT init blits all fire in
  // the first frames). Then measure the steady-state hardware-scroll loop.
  toJSON(await client.callTool({ name: "frame", arguments: { op: "step", frames: 60 } }));

  // ── perFrame timeline while holding RIGHT (drives the scroll). ──
  const pf = toJSON(await client.callTool({
    name: "watch",
    arguments: { on: "dma", perFrame: true, frames: 90, pressDuring: [{ frame: 0, button: "right", holdFrames: 90 }] },
  }));
  assert.equal(pf.notSupported, undefined, "perFrame DMA notSupported on Genesis");
  assert.equal(pf.perFrame, true, "expected perFrame:true marker");
  assert.equal(pf.framesRun, 90, "framesRun mismatch: " + JSON.stringify(pf).slice(0, 200));
  assert.equal(pf.pressesApplied, 1, "RIGHT press was not applied");
  assert.ok(Array.isArray(pf.timeline), "timeline must be an array");

  // Shape: every timeline row carries the per-frame work fields.
  for (const row of pf.timeline) {
    for (const f of ["frame", "dmas", "bytes", "romBytes", "ramBytes"]) {
      assert.ok(typeof row[f] === "number", `timeline row missing numeric ${f}: ` + JSON.stringify(row));
    }
    assert.equal(row.romBytes + row.ramBytes, row.bytes, "romBytes+ramBytes must equal bytes: " + JSON.stringify(row));
  }

  // The WHOLE POINT: a hardware-scroll-only loop (no per-frame tilemap rewrites)
  // does only the tiny SAT/scroll refresh each settled frame. After boot the
  // average per-frame DMA must be small — orders of magnitude below a tilemap
  // rewrite (which would be hundreds-to-thousands of bytes EVERY frame). Guard
  // generously (one-time post-boot resource blits can still appear) but tight
  // enough that a regression to per-frame plane redraws would trip it.
  assert.ok(pf.avgBytesPerFrame < 600,
    "hardware-scroll loop should have a LOW avg per-frame DMA; got " + pf.avgBytesPerFrame +
    " — a per-frame tilemap rewrite would push this into the thousands. " + JSON.stringify(pf).slice(0, 300));

  // And it must actually be doing SOME DMA (the SAT refresh) — not silently zero.
  assert.ok(pf.totalDmas > 0, "expected the per-frame SAT/scroll refresh DMAs, got none");
});
