// C64 (vice x64 / 6510) callSubroutine instruction WATCHDOG — end to end.
//
// callSubroutine can be pointed at a routine that loops FOREVER. Each emulator
// frame spins inside the 6510 execute loop, so the host's per-frame cap can't
// catch it and the WASM would hang. The watchdog (romdev_watchdog_set, hooked
// into the 6510 dispatch, force-stops via romdev_pc_hit + romdev_pc_watchdog and
// the existing retro_run frame-loop drain) must force-stop at the host-set
// instruction budget and report watchdog:true — NOT hang.
//
// Mirrors test/lynx-watchdog.test.js for the 6510 core. We build a tiny C64 .prg
// whose main() is `while(1){}` (a guaranteed runaway), load it into a bare
// LibretroHost, step past the BASIC auto-RUN (C64 .prg only starts after BASIC
// RUNs it — ~150 frames), then arm setWatchdog + a PC break at an unreachable
// address so ONLY the watchdog can stop it. The KEY assertion: arming a TINY
// limit force-stops within a frame and the watchdog flag comes back set, without
// the core hanging.

import { test } from "node:test";
import assert from "node:assert/strict";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";

import { registerTools } from "../src/mcp/tools/index.js";
import { resolveCore } from "../src/cores/registry.js";

async function startClient() {
  const server = new McpServer({ name: "c64-watchdog", version: "0.0.1" }, { capabilities: { tools: {} } });
  registerTools(server, z);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "c64-watchdog-client", version: "0.0.1" }, { capabilities: {} });
  await Promise.all([server.connect(st), client.connect(ct)]);
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

test("C64 watchdog force-stops an infinite loop (vice 6510)", { timeout: 180000 }, async () => {
  const client = await startClient();

  const build = toJSON(await client.callTool({
    name: "build", arguments: { output: "rom",  platform: "c64", language: "c", source: SRC },
  }, undefined, { timeout: 180000 }));
  assert.equal(build.ok, true, "c64 build failed:\n" + (build.log || JSON.stringify(build)).slice(-600));

  const { LibretroHost } = await import("../src/host/LibretroHost.js");
  const core = resolveCore("c64");
  assert.ok(core, "resolveCore('c64') returned null — vice_x64_libretro.{js,wasm} missing?");
  const host = new LibretroHost();
  await host.loadCore(core.jsPath, core.wasmPath);
  await host.loadMedia({ platform: "c64", path: build.binaryPath });

  // Feature detection: the whole point of this change.
  assert.equal(host.watchdogSupported(), true, "watchdogSupported() false — romdev_watchdog_set missing on vice");
  assert.equal(host.pcBreakSupported(), true, "pcBreakSupported() false");

  // C64 BASIC auto-RUN takes many frames before our program reaches its loop.
  host._runFramesExclusive(() => false, 150);

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
  console.log("c64 watchdog: tripped=" + tripped + " finalPC=$" + (finalPC >>> 0).toString(16));

  // Sanity: a fresh arm clears the flag (re-armable).
  host.setWatchdog(0);
  const cleared = host.getPCBreak(true);
  assert.equal(cleared.watchdog, false, "watchdog flag did not clear after disarm+clearHit");

  // REGRESSION (v0.6.0 cross-system gap): the DEFAULT budget must trip on a
  // slow ~1MHz CPU before the per-frame cap. A flat 4M NEVER tripped here — the
  // 6510 runs only ~3.18M instructions in 600 frames, so 4M needed ~755 frames.
  // The per-CPU default (≈0.8*600*6000 ≈ 2.88M for the 6502 family) trips around
  // frame ~480. Drive callSubroutine at the live spin PC with NO maxInstructions.
  const spinPC = (finalPC >>> 0);
  const wd = host.callSubroutine({ pc: spinPC, maxFrames: 600, sandbox: true });
  assert.equal(wd.watchdog, true,
    "DEFAULT C64 budget must trip the watchdog, not fall to maxFrames (the slow-CPU fix): " + JSON.stringify(wd));
  assert.ok(wd.framesRun < 600,
    "watchdog should trip before maxFrames=600 on the default 6510 budget: " + JSON.stringify(wd));
  console.log("c64 DEFAULT-budget watchdog: framesRun=" + wd.framesRun + " (< 600)");
});
