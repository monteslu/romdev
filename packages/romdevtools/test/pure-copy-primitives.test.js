// The remaining two RE primitives from the all-platforms proposal:
//   #2 pure CPU calls everywhere — interrupt DELIVERY is suppressed during a
//      callSubroutine (romdev_irqblock_set), so the game's own NMI/IRQ
//      handlers cannot run and stomp the routine's output. gpgx keeps the
//      stronger cpu-only run; the 2600 has no interrupts (inherently pure).
//   #3 the generic copy trace — watch({on:'copy'}): every write landing in a
//      VRAM window logged with the EXECUTING instruction's PC (core hooks on
//      port-based video memory; the CPU-address range log on mapped VRAM).

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { buildForPlatform } from "../src/toolchains/index.js";
import { resolveCore } from "../src/cores/registry.js";
import { LibretroHost } from "romdev-core-host/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXAMPLES = path.join(__dirname, "..", "examples");

async function liveHost(platform, buildArgs, bootFrames = 30) {
  const b = await buildForPlatform({ platform, ...buildArgs });
  assert.ok(b.ok && b.binary, `${platform} build failed: ` + (b.log || "").slice(-300));
  const host = new LibretroHost();
  const core = resolveCore(platform);
  await host.loadCore(core.jsPath, core.wasmPath);
  await host.loadMedia({ platform, bytes: b.binary });
  host.stepFrames(bootFrames);
  return host;
}

test("irq block: every non-gpgx core exposes it (gpgx has the stronger cpu-only run)", { timeout: 240000 }, async () => {
  // Feature matrix — the wasm itself is the contract.
  const expectIrqBlock = ["nes", "snes", "gb", "gba", "lynx", "c64", "atari7800", "pce", "msx"];
  for (const platform of expectIrqBlock) {
    const core = resolveCore(platform);
    const host = new LibretroHost();
    await host.loadCore(core.jsPath, core.wasmPath);
    assert.ok(host.irqBlockSupported(), `${platform}: core must export romdev_irqblock_set`);
  }
  // gpgx: pure via run_pure; 2600: no interrupt lines on the 6507 at all.
  for (const platform of ["genesis", "sms", "gg"]) {
    const core = resolveCore(platform);
    const host = new LibretroHost();
    await host.loadCore(core.jsPath, core.wasmPath);
    assert.ok(host.runPureSupported(), `${platform}: gpgx must export romdev_run_pure`);
  }
});

test("NES irq block + pure call: NMI delivery stops, the called routine still lands", { timeout: 240000 }, async () => {
  // A ROM that ENABLES NMI (PPUCTRL bit 7) and idles. The chr-ram preset's
  // crt0 has an rti NMI stub — the NMI VECTOR address read from the built
  // binary is the delivery probe: a pc-break there fires every frame
  // normally, and must go silent under the interrupt block.
  const SRC = `
void main(void) {
  *(volatile unsigned char*)0x2000 = 0x80;  /* NMI on */
  for (;;);
}`;
  const b = await buildForPlatform({ platform: "nes", source: SRC, sourceName: "main.c", linkerConfig: "chr-ram" });
  assert.ok(b.ok && b.binary, "nes build failed");
  const prgSize = b.binary[4] * 16384;
  const vecOff = 16 + prgSize - 6;
  const nmiVector = b.binary[vecOff] | (b.binary[vecOff + 1] << 8);
  const host = new LibretroHost();
  const core = resolveCore("nes");
  await host.loadCore(core.jsPath, core.wasmPath);
  await host.loadMedia({ platform: "nes", bytes: b.binary });
  host.stepFrames(10);

  // Unblocked: NMI lands at the vector every frame.
  host.setPCBreak(nmiVector, true, false);
  let hit = false;
  for (let i = 0; i < 6; i++) { host.stepFrames(1); if (host.getPCBreak(false).hit) { hit = true; break; } }
  assert.ok(hit, `NMI must fire normally (bp at $${nmiVector.toString(16)})`);
  host.setPCBreak(0, false, false); host.getPCBreak(true); host.getRegSnapshot(true);
  host.stepFrames(3);

  // Blocked: it must NOT.
  host.setIrqBlock(true);
  host.setPCBreak(nmiVector, true, false);
  let hitBlocked = false;
  for (let i = 0; i < 10; i++) { host.stepFrames(1); if (host.getPCBreak(false).hit) { hitBlocked = true; break; } }
  host.setPCBreak(0, false, false); host.getPCBreak(true); host.getRegSnapshot(true);
  host.setIrqBlock(false);
  assert.equal(hitBlocked, false, "no NMI may be DELIVERED while blocked");

  // End-to-end pure call: plant INC $0312 / RTS at $0300 — it must run to the
  // sentinel and land its write, with pureMode reported.
  host.writeMemory("system_ram", 0x0300, Uint8Array.from([0xEE, 0x12, 0x03, 0x60]));
  host.writeMemory("system_ram", 0x0312, Uint8Array.from([0x00]));
  const r = host.callSubroutine({ pc: 0x0300, regs: {}, sandbox: false, pure: true, maxFrames: 120 });
  assert.equal(r.returned, true, "pure call must return: " + JSON.stringify(r));
  assert.equal(r.pureMode, "irq-blocked");
  assert.equal(host.readMemory("system_ram", 0x0312, 1)[0], 1, "the routine's INC must land");
});

test("MSX irq block: blocking is safe across frames (no hang, resumes clean)", { timeout: 240000 }, async () => {
  // The acceptance-gate mechanism is core-identical (NES proves the delivery
  // behavior); on MSX the minimal test ROM never enables the VDP interrupt,
  // so the honest check here is operational: blocking must not wedge the
  // frame loop, and the emulator must keep running after unblocking.
  const host = await liveHost("msx", { source: "void main(void){volatile unsigned char x=0;for(;;)x++;}", sourceName: "main.c" }, 280);
  const f0 = host.status.frameCount;
  host.setIrqBlock(true);
  host.stepFrames(10);
  host.setIrqBlock(false);
  host.stepFrames(5);
  assert.equal(host.status.frameCount, f0 + 15, "frames must keep stepping under and after the block");
});

test("NES copy trace: watch({on:'copy'}) catches $2007 uploads with the writer's PC", { timeout: 240000 }, async () => {
  // A loop pushing bytes at PPU $2000 (nametable) through the data port.
  const SRC = `
#define PPUADDR (*(volatile unsigned char*)0x2006)
#define PPUDATA (*(volatile unsigned char*)0x2007)
void main(void) {
  unsigned char v = 0;
  for (;;) {
    PPUADDR = 0x20; PPUADDR = 0x00;
    PPUDATA = ++v;
  }
}`;
  const host = await liveHost("nes", { source: SRC, sourceName: "main.c", linkerConfig: "chr-ram" });
  const r = host.watchVram(0x2000, 0x23FF, 5);
  assert.ok(r.total > 0, "uploads through $2007 must be logged");
  assert.ok(r.events.length > 0);
  const e = r.events[0];
  assert.ok(e.vramAddr >= 0x2000 && e.vramAddr <= 0x23FF, "vramAddr is PPU-space");
  assert.ok(e.pc >= 0x8000 && e.pc <= 0xFFFF, `writer pc must be a ROM address, got $${e.pc.toString(16)}`);
});

test("GB copy trace: the CPU-mapped fallback logs VRAM writes with the writer's PC", { timeout: 240000 }, async () => {
  const SRC = `
void main(void) {
  volatile unsigned char *vram = (volatile unsigned char*)0x8000;
  unsigned char v = 0;
  for (;;) vram[0] = ++v;
}`;
  const host = await liveHost("gb", { source: SRC, sourceName: "main.c" });
  assert.equal(host.vramWatchSupported(), false, "GB VRAM is CPU-mapped — no port hook needed");
  const r = host.watchRange(0x8000, 0x80FF, "write", 5);
  assert.ok(r.total > 0, "VRAM writes must be logged via the range path");
  const e = r.events[0];
  assert.ok(e.address >= 0x8000 && e.address <= 0x80FF);
  assert.ok(e.pc < 0x8000, `writer pc must be a ROM address, got $${e.pc.toString(16)}`);
});

test("SNES copy trace: port hook sees CPU/DMA uploads to VRAM", { timeout: 240000 }, async () => {
  const src = await readFile(path.join(EXAMPLES, "snes", "main.asm"), "utf8");
  // The example uploads tiles/tilemap at boot — trace from reset.
  const b = await buildForPlatform({ platform: "snes", language: "asm", source: src });
  assert.ok(b.ok && b.binary, "snes build failed");
  const host = new LibretroHost();
  const core = resolveCore("snes");
  await host.loadCore(core.jsPath, core.wasmPath);
  await host.loadMedia({ platform: "snes", bytes: b.binary });
  assert.ok(host.vramWatchSupported(), "snes9x must export the VRAM copy trace");
  // The example uploads during loadMedia's settling frames — reset the machine
  // so the boot upload re-runs WHILE the watch is armed.
  host.mod._romdev_vramwatch_set(0x0000, 0xFFFF, 1);
  host.mod._retro_reset();
  const r = host.watchVram(0x0000, 0xFFFF, 10);
  assert.ok(r.total > 0, "the boot upload must be visible to the copy trace");
  assert.ok(r.events[0].pc > 0, "events must carry the uploader's PC");
});
