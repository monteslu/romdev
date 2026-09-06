// pc-bitmap-granularity.test.js — the exact PC coverage bitmap must give every
// instruction of a byte-addressed CPU its own bit. The first bitmap build was one
// bit per 4-byte word (right for MIPS, wrong for the 6502/Z80/SM83 cores: adjacent
// instructions collapsed into one PC). Proven on fceumm (6502) at the host level,
// with a CONTROL at word granularity that must show the collapse, and through the
// `watch({on:'pc'})` tool, which now reports the method and the granularity.
import { test } from "node:test";
import assert from "node:assert/strict";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { readFile } from "node:fs/promises";

import { registerTools } from "../src/mcp/tools/index.js";
import { resolveCore } from "../src/cores/registry.js";

const SRC = `
volatile unsigned char counter;
void main(void) { while (1) { counter++; *(volatile unsigned char*)0x20 = counter; } }`;

async function startClient() {
  const server = new McpServer({ name: "covbits", version: "0.0.1" }, { capabilities: { tools: {} } });
  registerTools(server, z);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "covbits-client", version: "0.0.1" }, { capabilities: {} });
  await Promise.all([server.connect(st), client.connect(ct)]);
  return client;
}
const toJSON = (res) => { assert.equal(res.isError, undefined, "isError: " + JSON.stringify(res)); return JSON.parse(res.content[0].text); };

test("6502 coverage bitmap is byte-exact; word granularity (the control) collapses adjacent instructions", { timeout: 240000 }, async () => {
  const client = await startClient();
  const build = toJSON(await client.callTool({ name: "build", arguments: { output: "rom", platform: "nes", source: SRC } }, undefined, { timeout: 180000 }));
  assert.equal(build.ok, true, "nes build failed:\n" + build.log);

  const { LibretroHost } = await import("romdev-core-host/LibretroHost.js");
  const core = resolveCore("nes");
  const host = new LibretroHost();
  await host.loadCore(core.jsPath, core.wasmPath);
  await host.loadMedia({ platform: "nes", bytes: await readFile(build.binaryPath), virtualName: "cov.nes" });
  host.stepFrames(30);
  assert.equal(host.pcBitmapSupported(), true, "fceumm build has no coverage bitmap");
  assert.equal(host.pcAlignShift(), 0, "a 6502 platform wants byte granularity");

  // Byte granularity: the same frames, every executed PC its own bit.
  const fine = host.logPCBitmap(0x8000, 0x10000, 10);
  assert.equal(fine.shift, 0, "the core did not honour shift 0 (stale debug lib?): " + JSON.stringify({ shift: fine.shift, granularityBytes: fine.granularityBytes }));
  assert.equal(fine.granularityBytes, 1); assert.equal(fine.exact, true);
  assert.ok(fine.distinct > 0 && fine.pcs.length === fine.distinct, "decoded PCs must equal the distinct count: " + JSON.stringify({ distinct: fine.distinct, decoded: fine.pcs.length }));
  assert.ok(fine.pcs.some((pc) => pc % 4 !== 0), "no unaligned 6502 PC recorded — the bitmap is still word-granular");
  const wordsTouched = new Set(fine.pcs.map((pc) => pc >>> 2)).size;
  assert.ok(fine.distinct > wordsTouched, `byte-exact coverage must see more PCs than 4-byte groups: ${fine.distinct} PCs in ${wordsTouched} groups`);

  // CONTROL: force word granularity on the same core; adjacent instructions now share a bit,
  // every decoded PC is 4-aligned, and the result says it is not exact.
  const coarse = host.logPCBitmap(0x8000, 0x10000, 10, { shift: 2 });
  assert.equal(coarse.shift, 2); assert.equal(coarse.granularityBytes, 4); assert.equal(coarse.exact, false);
  assert.ok(coarse.pcs.every((pc) => pc % 4 === 0), "word-granular decode produced an unaligned PC");
  assert.ok(coarse.distinct < fine.distinct, `the control must collapse PCs: coarse ${coarse.distinct} vs fine ${fine.distinct}`);
  assert.ok(coarse.distinct <= wordsTouched + 4, `coarse distinct (${coarse.distinct}) should be about the number of 4-byte groups the fine run touched (${wordsTouched})`);

  // The tool path reports the same thing and is uncapped.
  const load = toJSON(await client.callTool({ name: "loadMedia", arguments: { platform: "nes", path: build.binaryPath } }));
  assert.equal(load.loaded, true);
  toJSON(await client.callTool({ name: "frame", arguments: { op: "step", frames: 30 } }));
  const cov = toJSON(await client.callTool({ name: "watch", arguments: { on: "pc", start: 0x8000, end: 0xFFFF, frames: 10, limit: 4000 } }));
  assert.equal(cov.method, "bitmap"); assert.equal(cov.granularityBytes, 1); assert.equal(cov.exact, true); assert.equal(cov.truncated, false);
  assert.ok(cov.distinct > 0 && cov.returned === cov.distinct, "tool returned fewer PCs than distinct under a large limit: " + JSON.stringify({ distinct: cov.distinct, returned: cov.returned }));
  assert.ok(cov.pcs.some((p) => parseInt(p.slice(1), 16) % 4 !== 0), "tool path shows no unaligned PC");
  host.dispose?.();
});
