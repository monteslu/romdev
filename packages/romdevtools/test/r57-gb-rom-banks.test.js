// R57: Game Boy ROMs past 32 KB. Code and data in switchable MBC5 banks:
//   - sdasgb links with 32-bit addresses (scripts/patches/sdcc-sdasgb-32bit-addresses.patch), so bank n >= 256 no
//     longer wraps onto n - 256;
//   - buildZ80C links area _CODE_<n> at n << 16 | $4000 and lays bank n out at n x 16 KB; the header declares MBC5;
//   - gb_crt0.s carries SDCC's banked-call trampoline (___sdcc_bcall_ehl) and current_rom_bank.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readSrc = (rel) => readFile(path.join(ROOT, rel), "utf8");

for (const platform of ["gb", "gbc"]) {
  test(`R57: ${platform} code in bank 3 (__banked) and data in banks 3 and 300 run from an 8 MB MBC5 ROM`, { timeout: 180000 }, async () => {
    const { buildForPlatform } = await import("../src/toolchains/index.js");
    const { LibretroHost } = await import("romdev-core-host/LibretroHost.js");
    const { resolveCore } = await import("../src/cores/registry.js");
    const lib = `src/platforms/${platform}/lib/c`;
    const far = `#include "gb_runtime.h"
#pragma codeseg CODE_3
#pragma constseg CODE_3
static const uint8_t magic[] = { 40, 2 };
uint8_t far_sum(uint8_t a, uint8_t b) __banked { return (uint8_t)(a + b + magic[0] + magic[1]); }
`;
    const high = `#pragma constseg CODE_300
const unsigned char far_data[] = { 0x5A, 0xA5, 0x3C };
`;
    const main = `#include "gb_hardware.h"
#include "gb_runtime.h"
uint8_t far_sum(uint8_t a, uint8_t b) __banked;
extern const unsigned char far_data[];
__at (0xD000) uint8_t result;
__at (0xD001) uint8_t read_hi;
__at (0xD002) uint8_t bank_after;
void main(void) {
  uint16_t back;
  result = far_sum(3, 4);
  back = current_rom_bank;
  SWITCH_ROM(300);
  read_hi = (uint8_t)(far_data[0] + far_data[2]);
  SWITCH_ROM(back);
  bank_after = (uint8_t)current_rom_bank;
  for (;;) wait_vblank();
}
`;
    const r = await buildForPlatform({
      platform, language: "c",
      sources: { "main.c": main, "gb_runtime.c": await readSrc(`${lib}/gb_runtime.c`), "far.c": far, "high.c": high },
      includes: { "gb_runtime.h": await readSrc(`${lib}/gb_runtime.h`), "gb_hardware.h": await readSrc(`${lib}/gb_hardware.h`) },
      crt0: await readSrc(`${lib}/gb_crt0.s`), codeLoc: 0x150,
    });
    assert.equal(r.ok, true, `build failed: ${(r.log || "").slice(-800)}`);
    const rom = new Uint8Array(r.binary);
    assert.equal(rom.length, 8 * 1024 * 1024, "bank 300 needs an 8 MB image");
    assert.deepEqual(Object.keys(r.banks).map(Number), [3, 300]);
    assert.equal(rom[0x147], 0x1B, "MBC5 + RAM + BATTERY (the crt0 declares a battery cart)");
    assert.equal(rom[0x148], 0x08, "ROM size code 8 = 8 MB");
    assert.deepEqual([...rom.subarray(300 * 0x4000, 300 * 0x4000 + 3)], [0x5A, 0xA5, 0x3C], "bank 300 at 300 x 16 KB");

    const host = new LibretroHost();
    const core = resolveCore(platform);
    await host.loadCore(core.jsPath, core.wasmPath);
    await host.loadMedia({ platform, bytes: rom, virtualName: `/rom.${platform}` });
    host.stepFrames(20);
    const wram = host.readMemory("system_ram", 0x1000, 3);
    assert.equal(wram[0], 3 + 4 + 40 + 2, "the banked call ran in bank 3 and read bank 3's constants");
    assert.equal(wram[1], (0x5A + 0x3C) & 0xFF, "SWITCH_ROM(300) mapped bank 300");
    assert.equal(wram[2], 1, "current_rom_bank came back to 1");
  });
}
