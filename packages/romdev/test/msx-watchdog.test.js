// MSX (blueMSX / Z80) callSubroutine instruction WATCHDOG — end to end.
//
// Exercises the romdev_watchdog_set core hook (blueMSX R800/Z80) through the MCP
// tool surface. callSubroutine arms the watchdog before driving a routine; a
// routine that loops FOREVER (a `spin` function that is `for(;;){}`) must NOT
// hang the WASM — it must force-stop at the instruction budget and return
// { returned:false, watchdog:true, finalPC } instead. This is the fix for the
// black-box callSubroutine hang.
//
// The spin routine is a real ROM symbol (`_spin`) whose address we pull from the
// SDCC .map, so callSubroutine jumps straight into a known forever-loop in ROM —
// no RAM-mapping / presetMemory guesswork.

import { test } from "node:test";
import assert from "node:assert/strict";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";

import { registerTools } from "../src/mcp/tools/index.js";

async function startClient() {
  const server = new McpServer({ name: "msx-watchdog", version: "0.0.1" }, { capabilities: { tools: {} } });
  registerTools(server, z);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "msx-watchdog-client", version: "0.0.1" }, { capabilities: {} });
  await Promise.all([server.connect(st), client.connect(ct)]);
  await client.callTool({ name: "loadCategory", arguments: { category: "all" } });
  return client;
}

const toJSON = (res) => {
  assert.equal(res.isError, undefined, "tool returned isError: " + JSON.stringify(res));
  return JSON.parse(res.content[0].text);
};

// MSX cartridge INIT (must not return). The cart keeps a live counter loop; a
// separate `spin()` function is a forever-loop in ROM that callSubroutine targets
// (referenced from main so it links).
const MAIN = `
void spin(void) { for (;;) { } }   // a forever loop in ROM — callSubroutine target
volatile unsigned char keep;
void main(void) {
    if (keep == 0xFF) spin();      // referenced so spin() links (never taken)
    __asm
        xor a
loop$:
        ld   (#0xE000), a
        inc  a
        ld   c, #0
delay$:
        dec  c
        jr   nz, delay$
        jr   loop$
    __endasm;
    for (;;) { }
}
`;

const CRT0 = await (await import("node:fs/promises")).readFile(
  new URL("../src/platforms/msx/lib/c/msx_crt0.s", import.meta.url), "utf8",
);

// Pull a symbol's address out of the SDCC .map text (sdld: "<addr>  _name").
function symAddr(mapText, name) {
  for (const raw of mapText.split(/\r?\n/)) {
    const m = /^([0-9A-Fa-f]{4,8})\s+(_?[A-Za-z_.][A-Za-z0-9_.]*)/.exec(raw.trim());
    if (m && (m[2] === name || m[2] === "_" + name)) return parseInt(m[1], 16);
  }
  return null;
}

test("MSX callSubroutine watchdog: infinite loop returns watchdog:true, no hang (blueMSX Z80)", { timeout: 240000 }, async () => {
  const client = await startClient();

  const build = toJSON(await client.callTool({
    name: "buildSource",
    arguments: {
      platform: "msx",
      language: "c",
      sources: { "main.c": MAIN, "msx_crt0.s": CRT0 },
      crt0: ".module empty\n",
      includeSymbols: true,
    },
  }, undefined, { timeout: 240000 }));
  assert.equal(build.ok, true, "msx build failed:\n" + build.log);
  const map = build.symbols || "";
  const spin = symAddr(map, "spin");
  assert.ok(spin, "couldn't find _spin in the SDCC .map");

  const load = toJSON(await client.callTool({
    name: "loadMedia", arguments: { platform: "msx", path: build.binaryPath },
  }));
  assert.equal(load.loaded, true, "loadMedia failed: " + JSON.stringify(load));

  // C-BIOS shows its logo ~150 frames before it CALLs the cart INIT; step well
  // past that so the cart (and its ROM) is live.
  toJSON(await client.callTool({ name: "stepFrames", arguments: { frames: 260 } }));

  // callSubroutine into the ROM spin loop. The watchdog MUST trip — no hang.
  // sandbox:false because blueMSX's _retro_serialize traps in this headless build
  // (a pre-existing core quirk, unrelated to the watchdog). maxFrames is sized so
  // the 200k-instruction budget is reached (blueMSX runs ~4.5k Z80 insns/frame).
  const wd = toJSON(await client.callTool({
    name: "callSubroutine",
    arguments: { pc: spin, maxFrames: 60, maxInstructions: 200000, sandbox: false },
  }));
  assert.equal(wd.notSupported, undefined, "callSubroutine notSupported — core patch missing?");
  assert.equal(wd.returned, false, "spin should not 'return': " + JSON.stringify(wd));
  assert.equal(wd.watchdog, true, "watchdog must trip on an infinite loop (no hang): " + JSON.stringify(wd));
  assert.ok(wd.finalPC, "watchdog must report finalPC (where it's stuck): " + JSON.stringify(wd));
});
