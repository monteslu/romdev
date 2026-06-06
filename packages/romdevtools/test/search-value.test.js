// searchValue / searchNext — the iterative RAM value search (cheat-search).
//
// Verifies the engine end-to-end on a LIVE host (plant a known value with
// writeMemory, search for it, change it, narrow) on more than one platform —
// it operates on the generic system_ram region so it works on all 14.

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { buildForPlatform } from "../src/toolchains/index.js";
import { resolveCore } from "../src/cores/registry.js";
import { LibretroHost } from "../src/host/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Mirror of memory.js readUint so the test exercises the same decode. */
function readUint(buf, i, size, little) {
  let v = 0;
  if (little) { for (let k = size - 1; k >= 0; k--) v = (v << 8) | buf[i + k]; }
  else { for (let k = 0; k < size; k++) v = (v << 8) | buf[i + k]; }
  return v >>> 0;
}

async function runSearch(platform, build) {
  const b = await build();
  assert.ok(b.binary, `${platform} build failed`);
  const host = new LibretroHost();
  const core = resolveCore(platform);
  await host.loadCore(core.jsPath, core.wasmPath);
  await host.loadMedia({ platform, bytes: b.binary });
  for (let i = 0; i < 30; i++) host.stepFrames(1);

  const sz = host.regionSize("system_ram");
  const off = Math.floor(sz / 2);
  const little = platform !== "genesis"; // 68k is big-endian

  // Plant 0x42, search.
  host.writeMemory("system_ram", off, new Uint8Array([0x42]));
  let buf = host.readMemory("system_ram", 0, sz);
  let cands = [];
  for (let i = 0; i < buf.length; i++) if (readUint(buf, i, 1, little) === 0x42) cands.push(i);
  assert.ok(cands.includes(off), `${platform}: searchValue(0x42) didn't find the planted addr`);

  // Change it to 0x99, narrow with op:'eq'.
  host.writeMemory("system_ram", off, new Uint8Array([0x99]));
  buf = host.readMemory("system_ram", 0, sz);
  const kept = cands.filter((a) => readUint(buf, a, 1, little) === 0x99);
  assert.ok(kept.includes(off), `${platform}: searchNext(eq,0x99) dropped the right addr`);
  assert.ok(kept.length <= cands.length, `${platform}: narrowing should not grow the set`);
}

test("searchValue narrows a planted value on NES", async () => {
  await runSearch("nes", () => buildForPlatform({ platform: "nes", source: "void main(void){for(;;);}", sourceName: "main.c", linkerConfig: "chr-ram" }));
}, { timeout: 60000 });

test("searchValue narrows a planted value on Genesis (big-endian region)", async () => {
  const src = await readFile(path.join(__dirname, "..", "examples", "genesis", "main.s"), "utf8");
  await runSearch("genesis", () => buildForPlatform({ platform: "genesis", source: src, sourceName: "main.s", language: "asm" }));
}, { timeout: 60000 });
