// Lynx (handy / 65C02) callSubroutine instruction WATCHDOG — end to end.
//
// callSubroutine can be pointed at a routine that loops FOREVER. Each emulator
// frame spins inside C65C02::Update, so the host's per-frame cap can't catch it
// and the WASM would hang. The watchdog (romdev_watchdog_set, hooked into
// C65C02::Update, force-stops via romdev_pc_hit + romdev_pc_watchdog and the
// existing retro_run frame-loop drain) must force-stop at the host-set
// instruction budget and report watchdog:true — NOT hang.
//
// Mirrors test/a2600-watchdog.test.js for the 65C02 core. We build a tiny Lynx
// ROM whose main() is `while(1){}` (a guaranteed runaway) via the proven
// buildSource path, load it into a bare LibretroHost, then drive the SAME host
// primitives callSubroutine uses (setWatchdog + the exclusive frame loop
// watching getPCBreak().watchdog). The KEY assertion: arming a TINY limit
// force-stops within a single frame and the watchdog flag comes back set,
// without the core hanging.

import { test } from "node:test";
import assert from "node:assert/strict";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";

import { registerTools } from "../src/mcp/tools/index.js";
import { resolveCore } from "../src/cores/registry.js";

async function startClient() {
  const server = new McpServer({ name: "lynx-watchdog", version: "0.0.1" }, { capabilities: { tools: {} } });
  registerTools(server, z);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "lynx-watchdog-client", version: "0.0.1" }, { capabilities: {} });
  await Promise.all([server.connect(st), client.connect(ct)]);
  await client.callTool({ name: "loadCategory", arguments: { category: "all" } });
  return client;
}

const toJSON = (res) => {
  assert.equal(res.isError, undefined, "tool returned isError: " + JSON.stringify(res));
  return JSON.parse(res.content[0].text);
};

// main() never returns — a guaranteed runaway the watchdog must catch.
const SRC = `
void main(void) {
  volatile unsigned char c = 0;
  while (1) { c++; }
}`;

test("Lynx watchdog force-stops an infinite loop (handy 65C02)", { timeout: 180000 }, async () => {
  const client = await startClient();

  const build = toJSON(await client.callTool({
    name: "buildSource", arguments: { platform: "lynx", language: "c", source: SRC },
  }, undefined, { timeout: 180000 }));
  assert.equal(build.ok, true, "lynx build failed:\n" + (build.log || JSON.stringify(build)).slice(-600));

  const { LibretroHost } = await import("../src/host/LibretroHost.js");
  const core = resolveCore("lynx");
  assert.ok(core, "resolveCore('lynx') returned null — handy_libretro.{js,wasm} missing?");
  const host = new LibretroHost();
  await host.loadCore(core.jsPath, core.wasmPath);
  await host.loadMedia({ platform: "lynx", path: build.binaryPath });

  // Feature detection: the whole point of this change.
  assert.equal(host.watchdogSupported(), true, "watchdogSupported() false — romdev_watchdog_set missing on handy");
  assert.equal(host.pcBreakSupported(), true, "pcBreakSupported() false");

  // Boot a few frames into the spin loop.
  host._runFramesExclusive(() => false, 30);

  // KEY assertion: arm a TINY instruction budget. The ROM is spinning forever in
  // main(), so the watchdog MUST force-stop within a single frame and report the
  // flag — and the core must NOT hang (the timeout guards that). We arm a PC
  // breakpoint at an address the spin never reaches so ONLY the watchdog can
  // stop it (exactly the callSubroutine pattern).
  host.setWatchdog(50000);
  host.setPCBreak(0xFFFF, true, false);
  let tripped = false, finalPC = null;
  try {
    host._runFramesExclusive(() => {
      const st = host.getPCBreak(false);
      if (st.hit) { tripped = !!st.watchdog; finalPC = st.lastPC; return true; }
      return false;
    }, 600);
  } finally {
    host.setPCBreak(0, false, false);
    host.setWatchdog(0);
    host.getPCBreak(true);
  }

  assert.equal(tripped, true, "watchdog did not trip on the infinite loop (finalPC=" + finalPC + ")");
  assert.ok(finalPC !== null && (finalPC >>> 0) <= 0xFFFF,
    "watchdog reported no/invalid finalPC: " + finalPC);
  console.log("lynx watchdog: tripped=" + tripped + " finalPC=$" + (finalPC >>> 0).toString(16));

  // Sanity: a fresh arm clears the flag (re-armable).
  host.setWatchdog(0);
  const cleared = host.getPCBreak(true);
  assert.equal(cleared.watchdog, false, "watchdog flag did not clear after disarm+clearHit");
});
