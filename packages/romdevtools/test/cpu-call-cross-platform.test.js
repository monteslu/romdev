// The cpu-call stack repair, across every CPU family that can build a ROM here.
//
// callSubroutine's stack handling is written from a per-CPU profile covering
// 6502, 65816, Z80, SM83, m68k and ARM -- 15 platforms. But the SETUP has two
// distinct branches that push in OPPOSITE directions:
//
//   page stack (6502/65816)     bytes at $0100+SP, SP decremented per byte
//                               -> SP moves DOWN
//   predecrement (m68k/SM83/Z80) SP -= width, then the block is written
//                               -> the leak moves SP UP
//
// A repair verified on one branch is a repair verified on half the platforms, so
// this runs the same scenario on each family that can produce a ROM in-test:
// NES (6502), GB (SM83), SMS (Z80), Genesis (m68k). The 65816 and ARM profiles
// share the two code paths exercised here.
//
// Each case drives the UNSAFE shape -- a call cut short by stopAtPC, so the
// callee never reaches its return and nothing unwinds the sentinel -- and
// asserts the interrupted machine's stack pointer comes back.

import { test } from "node:test";
import assert from "node:assert/strict";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";

import { registerTools } from "../src/mcp/tools/index.js";

async function session(key) {
  const server = new McpServer({ name: key, version: "0.0.1" }, { capabilities: { tools: {} } });
  registerTools(server, z, key);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: key + "-c", version: "0.0.1" }, { capabilities: {} });
  await Promise.all([server.connect(st), client.connect(ct)]);
  return async (name, args, timeoutMs) => {
    const r = await client.callTool(
      { name, arguments: args },
      undefined,
      timeoutMs ? { timeout: timeoutMs } : undefined,
    );
    const text = r.content?.find?.((c) => c.type === "text")?.text;
    if (r.isError) return { _error: text };
    try { return JSON.parse(text); } catch { return text; }
  };
}

// A trivial busy loop that touches RAM, so every platform has a live machine
// with a real stack behind it.
const SRC = `
volatile unsigned char g_w;
void main(void) {
    unsigned char a = 0;
    for (;;) { a++; g_w = a; }
}`;

/**
 * The stack pointer is not reported under one consistent key across cores:
 * fceumm exposes S inside `registers`, gambatte exposes `sp` at the top level.
 * Reading the wrong one yields undefined -- and `undefined === undefined` would
 * make every assertion below pass while measuring nothing, so this refuses to
 * return a non-number.
 */
function readSP(st, platform) {
  const v = st?.sp ?? st?.registers?.S ?? st?.registers?.SP ?? st?.registers?.sp;
  assert.equal(typeof v, "number",
    `${platform}: no numeric stack pointer in cpu read: ${JSON.stringify(st).slice(0, 240)}`);
  return v;
}

const CASES = [
  { platform: "nes",     family: "6502 page stack",     entry: 0x8000, stop: 0x8004 },
  { platform: "gb",      family: "SM83 predecrement",   entry: 0x0150, stop: 0x0154 },
  { platform: "sms",     family: "Z80 predecrement",    entry: 0x0000, stop: 0x0004 },
  { platform: "genesis", family: "m68k predecrement",   entry: 0x0200, stop: 0x0208 },
];

for (const { platform, family, entry, stop } of CASES) {
  test(`${platform} (${family}): a cut-short call restores the stack`, { timeout: 300000 }, async () => {
    const call = await session(`xplat-${platform}`);

    const build = await call(
      "build",
      { output: "rom", platform, language: "c", source: SRC },
      240000,
    );
    assert.equal(build.ok, true,
      `${platform} build failed:\n` + String(build.log ?? build._error).slice(-600));

    const load = await call("loadMedia", { platform, path: build.binaryPath });
    assert.equal(load.loaded, true, `${platform} loadMedia failed: ` + JSON.stringify(load));
    await call("frame", { op: "step", frames: 60 });

    const before = readSP(await call("cpu", { op: "read", platform }), platform);

    const r = await call("cpu", {
      op: "call", pc: entry, stopAtPC: stop, maxFrames: 2, sandbox: false,
    });

    // A core without the register-write surface can't do cpu({op:'call'}) at
    // all; that's a capability gap, not a stack bug, and must not read as a pass.
    if (r._error || r.notSupported) {
      assert.fail(`${platform}: cpu call unavailable — ${r._error ?? "notSupported"}`);
    }

    const after = readSP(await call("cpu", { op: "read", platform }), platform);

    // Only a call that did NOT return leaves the sentinel stranded; if this core
    // happened to run to the sentinel, there is nothing to repair and the stack
    // balances on its own.
    if (r.returned === false) {
      assert.equal(r.cpuContextRestored, true,
        `${platform}: cut-short call did not restore the CPU context: ${JSON.stringify(r).slice(0, 300)}`);
    }
    assert.equal(after, before,
      `${platform}: stack pointer left unbalanced (${before} -> ${after}) — resuming would pop garbage`);
  });
}
