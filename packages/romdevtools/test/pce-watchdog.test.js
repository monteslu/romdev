// PCE (geargrafx / HuC6280) callSubroutine instruction WATCHDOG — end to end.
//
// callSubroutine can be pointed at a routine that loops FOREVER. Each emulator
// frame spins inside HuC6280::RunInstruction, so the host's per-frame cap can't
// catch it and the WASM would hang. The watchdog (romdev_watchdog_set, hooked
// into RunInstruction, force-stops via romdev_pc_hit + romdev_pc_watchdog and the
// existing retro_run frame-loop drain) must force-stop at the host-set
// instruction budget and report watchdog:true — NOT hang.
//
// Mirrors test/lynx-watchdog.test.js for the HuC6280 core. We build a tiny PCE
// ROM whose main() is `while(1){}` (a guaranteed runaway), load it into a bare
// LibretroHost, boot a few frames, then arm setWatchdog + a PC break at an
// unreachable address so ONLY the watchdog can stop it. The KEY assertion: arming
// a TINY limit force-stops within a frame and the watchdog flag comes back set,
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
  const server = new McpServer({ name: "pce-watchdog", version: "0.0.1" }, { capabilities: { tools: {} } });
  registerTools(server, z);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "pce-watchdog-client", version: "0.0.1" }, { capabilities: {} });
  await Promise.all([server.connect(st), client.connect(ct)]);
  return client;
}

const toJSON = (res) => {
  assert.equal(res.isError, undefined, "tool returned isError: " + JSON.stringify(res));
  return JSON.parse(res.content[0].text);
};

// main() never returns — a guaranteed runaway the watchdog must catch. PCE needs
// a real GLOBAL so .bss isn't empty (the empty-BSS crt0 trap → ld65 range error);
// a local won't do it, so g_c lives at module scope.
const SRC = `
volatile unsigned char g_c;
void main(void) {
  while (1) { g_c++; }
}`;

test("PCE watchdog force-stops an infinite loop (geargrafx HuC6280)", { timeout: 180000 }, async () => {
  const client = await startClient();

  const build = toJSON(await client.callTool({
    name: "build", arguments: { output: "rom",  platform: "pce", language: "c", source: SRC },
  }, undefined, { timeout: 180000 }));
  assert.equal(build.ok, true, "pce build failed:\n" + (build.log || JSON.stringify(build)).slice(-600));

  const { LibretroHost } = await import("romdev-core-host/LibretroHost.js");
  const core = resolveCore("pce");
  assert.ok(core, "resolveCore('pce') returned null — geargrafx_libretro.{js,wasm} missing?");
  const host = new LibretroHost();
  await host.loadCore(core.jsPath, core.wasmPath);
  await host.loadMedia({ platform: "pce", path: build.binaryPath });

  // Feature detection: the whole point of this change.
  assert.equal(host.watchdogSupported(), true, "watchdogSupported() false — romdev_watchdog_set missing on geargrafx");
  assert.equal(host.pcBreakSupported(), true, "pcBreakSupported() false");

  // Boot a few frames into the spin loop.
  host._runFramesExclusive(() => false, 30);

  // KEY assertion: arm a TINY instruction budget. The ROM is spinning forever in
  // main(), so the watchdog MUST force-stop within a single frame and report the
  // flag — and the core must NOT hang. A PC breakpoint at an address the spin
  // never reaches ensures ONLY the watchdog can stop it.
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
  console.log("pce watchdog: tripped=" + tripped + " finalPC=$" + (finalPC >>> 0).toString(16));

  // Sanity: a fresh arm clears the flag (re-armable).
  host.setWatchdog(0);
  const cleared = host.getPCBreak(true);
  assert.equal(cleared.watchdog, false, "watchdog flag did not clear after disarm+clearHit");
});
