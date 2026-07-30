// Cross-tool parameter aliases.
//
// Same concept, different name per tool, which cost ~6 wasted round trips in one
// reported session:
//
//   memory location  breakpoint takes `address`; memory takes region+offset
//   file output      memory({op:'read'}) writes via `outputPath`;
//                    frame({op:'screenshot'}) wants `path` and rejects outputPath
//   payloads         memory({op:'write'}) rejected `dataHex` (wants `hex`)
//   capture entries  captureMemory needed a full {region,offset,length} record,
//                    with no bare-address shorthand
//
// Every individual error message was good — one even suggested "Did you mean
// 'offset'?" — which is exactly why this needed fixing at the schema instead:
// the COLLECTION of near-synonyms is the problem, and no single good message can
// fix that. The screenshot case was worse than a naming difference: its own
// result text told callers to "pass outputPath", a parameter the schema rejected.

import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { registerMemoryTools } from "../src/mcp/tools/memory.js";
import { registerFrameTools } from "../src/mcp/tools/frame.js";
import { registerWatchMemoryTools } from "../src/mcp/tools/watch-memory.js";
import { _setHostForTest } from "../src/mcp/state.js";

function getHandler(register, toolName, sessionKey) {
  let handler;
  register({ tool(name, _d, _s, h) { if (name === toolName) handler = h; } }, z, sessionKey);
  return handler;
}

function parseResult(res) {
  assert.equal(res.isError, undefined, "unexpected isError: " + JSON.stringify(res));
  const text = res.content.find((c) => c.type === "text").text;
  try { return JSON.parse(text); } catch { return text; }
}

function fakeHost() {
  const ram = new Uint8Array(0x800);
  ram[0x74] = 0xAB;
  ram[0x75] = 0xCD;
  return {
    status: { platform: "nes", loaded: true, paused: false, frameCount: 0 },
    readMemory(_region, offset, length) { return ram.slice(offset, offset + length); },
    writeMemory(_region, offset, bytes) { ram.set(bytes, offset); },
    getCPUState() { return { pc: 0xC000 }; },
    pcBreakSupported() { return false; },
    stepFrames(n = 1) { this.status.frameCount += n; return this.status.frameCount; },
    setInput() {},
    renderOneFrame() {},
    screenshot() {
      // 1x1 transparent PNG.
      return {
        width: 1, height: 1,
        pngBase64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      };
    },
    _ram: ram,
  };
}

test("memory accepts `address` where it means `offset`", async () => {
  const key = "alias-mem-address";
  _setHostForTest(key, fakeHost());
  const handler = getHandler(registerMemoryTools, "memory", key);
  // `address` is what breakpoint/disasm call this. Region defaults so the
  // common single-argument case works.
  const r = parseResult(await handler({ op: "read", address: 0x74, length: 2 }));
  assert.match(JSON.stringify(r), /abcd/i);
});

test("memory accepts a hex-string address", async () => {
  const key = "alias-mem-address-str";
  _setHostForTest(key, fakeHost());
  const handler = getHandler(registerMemoryTools, "memory", key);
  const r = parseResult(await handler({ op: "read", address: "$74", length: 1 }));
  assert.match(JSON.stringify(r), /ab/i);
});

test("an explicit offset still wins over the alias", async () => {
  const key = "alias-mem-precedence";
  _setHostForTest(key, fakeHost());
  const handler = getHandler(registerMemoryTools, "memory", key);
  const r = parseResult(await handler({ op: "read", region: "system_ram", offset: 0x75, address: 0x74, length: 1 }));
  assert.match(JSON.stringify(r), /cd/i, "offset:0x75 read, not address:0x74");
});

test("memory({op:'write'}) accepts dataHex as well as hex", async () => {
  const key = "alias-mem-datahex";
  const host = fakeHost();
  _setHostForTest(key, host);
  const handler = getHandler(registerMemoryTools, "memory", key);
  parseResult(await handler({ op: "write", region: "system_ram", offset: 0x10, dataHex: "beef" }));
  assert.equal(host._ram[0x10], 0xBE);
  assert.equal(host._ram[0x11], 0xEF);
});

test("frame({op:'screenshot'}) accepts outputPath, which its own text advertises", async () => {
  const key = "alias-frame-outputpath";
  _setHostForTest(key, fakeHost());
  const handler = getHandler(registerFrameTools, "frame", key);
  const out = path.join(mkdtempSync(path.join(tmpdir(), "alias-shot-")), "shot.png");
  await handler({ op: "screenshot", outputPath: out });
  assert.ok(existsSync(out), "wrote to the aliased path");
});

test("frame({op:'screenshot'}) still honours path, and path wins if both are given", async () => {
  const key = "alias-frame-path";
  _setHostForTest(key, fakeHost());
  const handler = getHandler(registerFrameTools, "frame", key);
  const dir = mkdtempSync(path.join(tmpdir(), "alias-shot2-"));
  const wanted = path.join(dir, "wanted.png");
  const other = path.join(dir, "other.png");
  await handler({ op: "screenshot", path: wanted, outputPath: other });
  assert.ok(existsSync(wanted), "the explicit `path` was used");
  assert.equal(existsSync(other), false, "the alias did not override it");
});

test("captureMemory accepts a bare address as well as a full record", async () => {
  const key = "alias-capture";
  const host = fakeHost();
  // A breakpoint that reports an immediate hit, so captureMemory runs.
  host.pcBreakSupported = () => true;
  host.setPCBreak = () => {};
  host.getPCBreak = () => ({ enabled: true, hit: true, hits: 1, lastPC: 0xD2E4, address: 0xD2E4 });
  host.getRegSnapshot = () => null;
  _setHostForTest(key, host);
  const handler = getHandler(registerWatchMemoryTools, "breakpoint", key);

  const r = parseResult(await handler({
    on: "pc", address: 0xD2E4, maxFrames: 1,
    // number, hex string, and the long form -- all three must work.
    captureMemory: [0x74, "$75", { region: "system_ram", offset: 0x74, length: 2, label: "pair" }],
  }));

  assert.ok(r.capturedMemory, "captured something");
  const flat = JSON.stringify(r.capturedMemory).toLowerCase();
  assert.match(flat, /ab/, "bare number address read");
  assert.match(flat, /cd/, "hex-string address read");
  assert.match(flat, /abcd/, "long-form record still works");
});
