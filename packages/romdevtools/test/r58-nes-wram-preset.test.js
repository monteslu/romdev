// R58: NES preset chr-ram-wram. Same cart and runtime as chr-ram-runtime, but the C program's BSS/DATA live in the
// battery PRG-RAM at $6100-$7FFF (7.75 KB) instead of 512 bytes of internal RAM; $6000-$60FF is a save area that no
// segment uses and the crt0 never clears.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readSrc = (rel) => readFile(path.join(ROOT, rel), "utf8");

const MAIN = `#include "nes_runtime.h"
static uint8_t big[6000];          /* BSS: far past internal RAM's 512 bytes */
static uint16_t seed = 0x1234;     /* DATA: copied to PRG-RAM by the crt0 */
#define OUT ((volatile uint8_t *)0x0500)
void main(void) {
  uint16_t i;
  uint8_t sum = 0;
  for (i = 0; i < sizeof big; ++i) big[i] = (uint8_t)(i * 7);
  for (i = 0; i < sizeof big; ++i) sum += big[i];
  OUT[0] = sum;
  OUT[1] = (uint8_t)seed;
  OUT[2] = (uint8_t)(seed >> 8);
  OUT[3] = big[5999];
  OUT[4] = 0xAA;
  for (;;) {}
}
`;

async function build(linkerConfig) {
  const { buildForPlatform } = await import("../src/toolchains/index.js");
  return buildForPlatform({
    platform: "nes", language: "c", linkerConfig,
    sources: { "main.c": MAIN, "nes_runtime.c": await readSrc("src/platforms/nes/lib/c/nes_runtime.c") },
    includes: { "nes_runtime.h": await readSrc("src/platforms/nes/lib/c/nes_runtime.h") },
  });
}

test("R58: chr-ram-runtime cannot hold 6 KB of BSS; chr-ram-wram can", { timeout: 120000 }, async () => {
  const small = await build("chr-ram-runtime");
  assert.equal(small.ok, false, "512 bytes of internal RAM overflow");
  assert.match(small.log ?? "", /overflow/i);
  const r = await build("chr-ram-wram");
  assert.equal(r.ok, true, `build failed: ${(r.log || "").slice(-800)}`);
});

test("R58: chr-ram-wram runs BSS/DATA from PRG-RAM and leaves the save area alone", { timeout: 120000 }, async () => {
  const r = await build("chr-ram-wram");
  assert.equal(r.ok, true, `build failed: ${(r.log || "").slice(-800)}`);
  const rom = new Uint8Array(r.binary);
  assert.equal(rom[6] & 0x02, 0x02, "iNES battery bit: PRG-RAM mapped at $6000");

  const { LibretroHost } = await import("romdev-core-host/LibretroHost.js");
  const { resolveCore } = await import("../src/cores/registry.js");
  const host = new LibretroHost();
  const core = resolveCore("nes");
  await host.loadCore(core.jsPath, core.wasmPath);
  await host.loadMedia({ platform: "nes", bytes: rom, virtualName: "/rom.nes" });
  assert.equal(host.regionSize("save_ram"), 0x2000);
  host.writeMemory("save_ram", 0x10, new Uint8Array([0x5a, 0xa5]));   // a save written in an earlier session
  host.reset();
  host.stepFrames(240);   // two 6000-step loops of unoptimised cc65 code take ~80 frames

  let sum = 0;
  for (let i = 0; i < 6000; i++) sum = (sum + ((i * 7) & 0xff)) & 0xff;
  const out = host.readMemory("system_ram", 0x500, 5);
  assert.equal(out[4], 0xaa, "main ran to the end");
  assert.equal(out[0], sum, "6000-byte BSS array reads back what was written");
  assert.deepEqual([out[1], out[2]], [0x34, 0x12], "initialised DATA came through");
  assert.equal(out[3], (5999 * 7) & 0xff);
  assert.deepEqual([...host.readMemory("save_ram", 0x10, 2)], [0x5a, 0xa5], "the save area survives boot");
  const wram = host.readMemory("save_ram", 0x100, 0x1f00);
  let found = false;
  for (let i = 0; i + 4 < wram.length && !found; i++) found = wram[i] === 0 && wram[i + 1] === 7 && wram[i + 2] === 14 && wram[i + 3] === 21;
  assert.ok(found, "the BSS array lives in $6100-$7FFF");
});
