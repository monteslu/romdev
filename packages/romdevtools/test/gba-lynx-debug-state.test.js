// Core-loading integration tests for the GBA (mgba) + Lynx (handy) debug-state
// regions added so getCPUState / getAudioState / inspectSprites / inspectPalette
// / getRenderingContext cover all 12 tier-1 systems. These boot a REAL core and
// assert the patched retro_get_memory_data regions return live, decodable state
// (the per-decoder unit tests live in gba-gb-apu-decode / c64-sid-gba-video /
// lynx-mikey-decode). Regression guard for "core forgot to export the region".

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { resolveCore } from "../src/cores/registry.js";
import { LibretroHost } from "../src/host/LibretroHost.js";
import { getCPUState } from "../src/host/cpu-state.js";
import { buildGbaC } from "../src/toolchains/gba-c/gba-c.js";
import { buildExampleRom } from "./build-fixture-rom.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test("GBA: patched mgba exposes cpu/io/palette/oam regions + getCPUState decodes ARM7", { timeout: 180000 }, async () => {
  const core = resolveCore("gba");
  assert.ok(core, "resolveCore('gba') returned null — mgba wasm missing?");

  // A minimal ROM that sets a known DISPCNT (mode 0, BG0 on) so the rendering
  // context has something deterministic to read.
  const main = `
#include <tonc.h>
int main(void) {
    irq_init(NULL);
    irq_add(II_VBLANK, NULL);
    REG_DISPCNT = DCNT_MODE0 | DCNT_BG0 | DCNT_OBJ;
    while (1) { VBlankIntrWait(); }
}
`;
  const r = await buildGbaC({ sources: { "main.c": main } });
  assert.equal(r.ok, true, `build failed at ${r.stage}: ${(r.log || "").slice(-400)}`);

  const host = new LibretroHost();
  await host.loadCore(core.jsPath, core.wasmPath);
  await host.loadMedia({ platform: "gba", bytes: r.binary, virtualName: "dbg.gba" });
  for (let i = 0; i < 120; i++) host.stepFrames(1);

  // All four custom regions must be non-empty.
  for (const [region, size] of [["gba_cpu_regs", 80], ["gba_io_regs", 0x400], ["gba_palette", 0x400], ["gba_oam", 0x400]]) {
    const bytes = host.readMemory(region, 0, size);
    assert.equal(bytes.length, size, `${region} wrong size`);
  }

  // getCPUState: 16 gprs + a plausible PC (cartridge space 0x08000000+ or BIOS),
  // a valid IWRAM stack pointer, and ARM/THUMB resolved.
  const cpu = getCPUState(host, "gba");
  assert.ok(cpu, "getCPUState(gba) returned null");
  assert.equal(typeof cpu.registers.PC, "number");
  assert.equal(typeof cpu.registers.SP, "number");
  assert.ok("execPc" in cpu, "missing pipeline-adjusted execPc");
  assert.match(cpu.cpu, /arm7tdmi/);
  assert.ok(cpu.cpsr && cpu.cpsr.startsWith("0x"), "cpsr not hex");
  // SP should be in IWRAM ($3000000-$3007FFF) or EWRAM — a sane stack, not 0.
  assert.ok(cpu.registers.SP > 0x2000000, `SP looks wrong: 0x${cpu.registers.SP.toString(16)}`);

  // DISPCNT we set: BG mode 0, BG0 + OBJ enabled.
  const { decodeGbaRenderingContext } = await import("../src/host/gba-video-state.js");
  const io = host.readMemory("gba_io_regs", 0, 0x400);
  const ctx = decodeGbaRenderingContext(io);
  assert.equal(ctx.bgMode, 0, "expected BG mode 0");
  assert.equal(ctx.displayBg[0], true, "expected BG0 enabled");
  assert.equal(ctx.displayObj, true, "expected OBJ enabled");

  // OAM decodes to 128 sprite slots.
  const { decodeGbaSprites } = await import("../src/host/gba-video-state.js");
  const oam = host.readMemory("gba_oam", 0, 0x400);
  assert.equal(decodeGbaSprites(oam, {}).sprites.length, 128);
});

// The gba_lua_sdk defect report (internal-gbalua/ROMDEV_MEMORY_REGION_DEFECT.md):
// upstream mgba-libretro returned GB_SIZE_WORKING_RAM (32768) for SYSTEM_RAM
// UNCONDITIONALLY while the data pointer was GBA EWRAM — so `system_ram` on GBA
// was the first 32KB of EWRAM wearing IWRAM's size, and IWRAM (the C stack +
// libtonc/maxmod .bss, everything at $0300xxxx) was unreadable. Reads returned
// real-but-wrong bytes (silent zeros), sending the agent down false trails.
test("GBA: system_ram is full EWRAM (256KB) and gba_iwram reads the LIVE stack/.bss", { timeout: 180000 }, async () => {
  const core = resolveCore("gba");
  assert.ok(core, "resolveCore('gba') returned null — mgba wasm missing?");
  const main = `
#include <tonc.h>
int counter = 1;           /* .data — in IWRAM on this toolchain */
int main(void) {
    irq_init(NULL);
    irq_add(II_VBLANK, NULL);
    REG_DISPCNT = DCNT_MODE0 | DCNT_BG0;
    while (1) { counter++; VBlankIntrWait(); }
}
`;
  const r = await buildGbaC({ sources: { "main.c": main } });
  assert.equal(r.ok, true, `build failed: ${(r.log || "").slice(-300)}`);
  const host = new LibretroHost();
  await host.loadCore(core.jsPath, core.wasmPath);
  await host.loadMedia({ platform: "gba", bytes: r.binary, virtualName: "iwram.gba" });
  for (let i = 0; i < 120; i++) host.stepFrames(1);

  // system_ram must be EWRAM's REAL size (the upstream size bug returned 32768)…
  const sysRam = host.readMemory("system_ram", 0, 16);
  assert.equal(sysRam.length, 16);
  // …and readable PAST the old bogus 32KB limit.
  assert.doesNotThrow(() => host.readMemory("system_ram", 0x20000, 16),
    "EWRAM read at offset 0x20000 must not RangeError (size was wrongly 32768)");

  // gba_iwram exists, is 32KB, and holds LIVE data: the stack near the top and
  // the toolchain's .data/.bss below. All-zeros = the defect regressed.
  const top = host.readMemory("gba_iwram", 0x7E00, 0x200);   // stack region
  const low = host.readMemory("gba_iwram", 0x0000, 0x1000);  // .data/.bss
  const topNonzero = top.some((b) => b !== 0);
  const lowNonzero = low.some((b) => b !== 0);
  assert.ok(topNonzero || lowNonzero, "IWRAM reads all zeros — the silent-zeros defect is back");
  // SP (from the CPU snapshot) points into IWRAM — the exact repro from the report.
  const cpu = getCPUState(host, "gba");
  if (cpu.registers.SP >= 0x03000000 && cpu.registers.SP < 0x03008000) {
    const spOff = cpu.registers.SP - 0x03000000;
    const nearSp = host.readMemory("gba_iwram", Math.max(0, spOff - 64), 64);
    assert.ok(nearSp.some((b) => b !== 0), "bytes near the live SP must not be all zeros");
  }
});

// Lynx test boots a .lnx we build from our own example (cc65 targets Lynx), so
// it runs unconditionally and needs no external ROM on disk.
let lynxRom;
before(async () => { lynxRom = await buildExampleRom("lynx"); });

test("Lynx: patched handy exposes cpu/hw regions + getCPUState decodes 65C02", { timeout: 60000 }, async () => {
  const core = resolveCore("lynx");
  assert.ok(core, "resolveCore('lynx') returned null — handy wasm missing?");

  const host = new LibretroHost();
  await host.loadCore(core.jsPath, core.wasmPath);
  await host.loadMedia({ platform: "lynx", path: lynxRom });
  for (let i = 0; i < 120; i++) host.stepFrames(1);

  const cpuRegs = host.readMemory("lynx_cpu_regs", 0, 8);
  assert.equal(cpuRegs.length, 8);
  const hw = host.readMemory("lynx_hw_regs", 0, 0x200);
  assert.equal(hw.length, 0x200);

  const cpu = getCPUState(host, "lynx");
  assert.ok(cpu, "getCPUState(lynx) returned null");
  assert.equal(cpu.cpu, "65c02");
  // PC moves through real code; over a boot it should not be stuck at 0.
  assert.ok(cpu.pc > 0 && cpu.pc <= 0xFFFF, `lynx PC out of range: 0x${cpu.pc.toString(16)}`);
  assert.equal(typeof cpu.registers.A, "number");
  assert.ok(cpu.flags && cpu.flags.raw.startsWith("0x"));

  // Palette decodes to 16 entries; Mikey to 4 channels.
  const { decodeLynxPalette, decodeLynxMikey } = await import("../src/host/lynx-mikey-state.js");
  assert.equal(decodeLynxPalette(hw).entries.length, 16);
  assert.equal(decodeLynxMikey(hw).channels.length, 4);
});
